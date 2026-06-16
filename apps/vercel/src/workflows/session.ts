// sessionWorkflow — the durable state machine (plan §3). ONE RUN PER AgentSession.
//
// Determinism rule (vercel-workflows.md §3): the workflow body is replayed from the top on every
// resume; only `"use step"` results, `sleep`, and hook events are memoized. So ALL IO (Linear
// GraphQL, mini HTTP, DB) lives inside steps; the body is pure control flow over recorded values.
// Hooks are created in the BODY (not in a step) with deterministic tokens so the webhook/callback
// routes can resume them.
//
// Phase 1: the mini-calling steps are log-only stubs (clearly marked). Phase 5 fills in the real
// mini HTTP calls; the control flow, hooks, elicitation loop, and finalize are already real.

import { defineHook, sleep } from "workflow";
import {
  JobDoneHookPayload,
  PromptHookPayload,
  QuestionHookPayload,
  type AgentQuestion,
  type JobKind,
  type JobDoneHookPayload as JobDoneHookPayloadT,
} from "@/lib/contract";
import { promptToken, jobDoneToken, questionToken } from "@/lib/tokens";
import {
  emitElicitation,
  emitElicitationSelect,
  emitError,
  emitResponse,
  emitThought,
  setExternalUrls,
  syncIssueToStarted,
} from "@/lib/linear";
import {
  abortJob,
  createJob,
  deliverAnswer,
  reapWorktree as reapMiniWorktree,
} from "@/lib/mini";
import { classifyIntent } from "@/lib/intent";
import { answerFromReply, renderQuestion } from "@/lib/questions";
import {
  ABORT_GRACE,
  JOB_TIMEOUT,
  MAX_QUESTION_ROUNDS,
  MAX_REVISION_ROUNDS,
  SWEEP_NUDGE_AFTER,
  SWEEP_REAP_AFTER,
} from "@/lib/env";

/* ───────────────────────── Hooks (exported so routes can resume) ───────────────────────── */

// promptHook — resumed by the Linear webhook route on a `prompted` event (token: prompt:<sid>).
export const promptHook = defineHook({ schema: PromptHookPayload });

// jobDoneHook — resumed by /api/mini/callback when a job reaches terminal status (token: job:<id>).
export const jobDoneHook = defineHook({ schema: JobDoneHookPayload });

// questionHook — resumed by /api/mini/question when the agent asks a mid-run AskUserQuestion
// (token: question:<jobId>). Carries one or more questions answered together.
export const questionHook = defineHook({ schema: QuestionHookPayload });

/* ───────────────────────── Workflow input ───────────────────────── */

export interface SessionInput {
  linearSessionId: string;
  issueId?: string; // Linear issue.id, for status sync (best-effort)
  issueIdentifier: string; // e.g. "ENG-123", for logging / branch naming
  promptContext: string; // formatted Linear promptContext, passed as INPUT not via a hook
}

/* ───────────────────────── Steps (all IO here) ───────────────────────── */

interface StartedJob {
  jobId: string;
}

// Start a mini job and return its jobId. Phase 1 stub: log only.
// Phase 5 replaces the body with a real `POST /jobs` via lib/mini.ts.
async function startMiniJob(args: {
  kind: JobKind;
  round: number;
  input: SessionInput;
  feedback?: string;
  claudeSessionId?: string;
}): Promise<StartedJob> {
  "use step";
  const res = await createJob({
    kind: args.kind,
    linearSessionId: args.input.linearSessionId,
    issueIdentifier: args.input.issueIdentifier,
    round: args.round,
    promptContext: args.kind === "plan" ? args.input.promptContext : undefined,
    feedback: args.feedback,
    claudeSessionId: args.claudeSessionId,
  });
  return { jobId: res.jobId };
}

async function abortMiniJob(jobId: string): Promise<void> {
  "use step";
  await abortJob(jobId);
}

async function syncStatusStep(issueId: string | undefined): Promise<void> {
  "use step";
  if (!issueId) return;
  // Best-effort: a status-sync failure must never break the session.
  try {
    await syncIssueToStarted(issueId);
  } catch {
    // swallow — status sync is advisory
  }
}

async function ackThought(linearSessionId: string, body: string): Promise<void> {
  "use step";
  await emitThought(linearSessionId, body);
}

async function sendElicitation(linearSessionId: string, planSummary?: string): Promise<void> {
  "use step";
  // Include the plan IN the (durable) elicitation: the streamed plan thoughts are ephemeral and
  // vanish when the plan run goes terminal, so without this the user sees only the buttons.
  const plan = planSummary?.trim();
  const body = plan
    ? `${plan}\n\n---\n\n**Approve** this plan to start work, or **Request changes** (or just reply) to tell me what to adjust.`
    : "I've finished planning. Approve this plan, or describe the changes you'd like.";
  await emitElicitationSelect(linearSessionId, body, [
    { label: "Approve", value: "approve" },
    { label: "Request changes", value: "request_changes" },
  ]);
}

async function nudge(linearSessionId: string): Promise<void> {
  "use step";
  await emitThought(
    linearSessionId,
    "Still here whenever you're ready — approve the plan or tell me what to change.",
  );
}

// Tell the mini to reap the worktree but keep the Claude session id (plan §7 sweeper).
// BEST-EFFORT: if the mini is unreachable, errors, or reports a contract-version mismatch (409),
// log and continue — we keep waiting on promptHook, so a late reply still resumes the session.
async function reapWorktree(linearSessionId: string): Promise<void> {
  "use step";
  try {
    const res = await reapMiniWorktree(linearSessionId);
    console.log(`[sweeper] reaped worktree for session ${linearSessionId}: reaped=${res.reaped}`);
  } catch (err) {
    // Non-fatal to the workflow (including a 409 ContractVersionMismatchError) — just log.
    console.warn(
      `[sweeper] reap failed for session ${linearSessionId} (continuing):`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function classifyIntentStep(payload: { text: string; selectValue?: string }): Promise<"approve" | "revise"> {
  "use step";
  return classifyIntent(payload);
}

// Emit one elicitation for an AgentQuestion (rendering logic lives in lib/questions.ts). IO step.
async function emitQuestionStep(linearSessionId: string, q: AgentQuestion): Promise<void> {
  "use step";
  const r = renderQuestion(q);
  if (r.mode === "select") {
    await emitElicitationSelect(linearSessionId, r.body, r.options);
  } else {
    await emitElicitation(linearSessionId, r.body);
  }
}

// Deliver collected answers back to the mini so the agent's run continues. BEST-EFFORT for
// transport: throws on hard failure so the caller (workflow body) can surface a Linear error;
// returns the parsed AnswerResponse otherwise.
async function deliverAnswerStep(
  jobId: string,
  questionId: string,
  answers: Record<string, string>,
): Promise<void> {
  "use step";
  const res = await deliverAnswer(jobId, questionId, answers);
  if (!res.delivered) {
    // The mini had no pending question matching this id (stale/expired) — the agent likely
    // already moved on. Surface it for debugging; the run continues either way.
    console.warn(
      `[question] answer for job ${jobId} (questionId=${questionId}) hit no pending question (delivered=false)`,
    );
  }
}

async function finalizeSuccess(linearSessionId: string, done: JobDoneHookPayloadT): Promise<void> {
  "use step";
  if (done.prUrl) {
    await setExternalUrls(linearSessionId, [{ label: "Pull Request", url: done.prUrl }]);
  }
  const branchNote = done.branch ? ` on branch \`${done.branch}\`` : "";
  const prNote = done.prUrl ? ` Opened a pull request${branchNote}: ${done.prUrl}` : "";
  await emitResponse(linearSessionId, `Done.${prNote}`.trim());
}

async function finalizeError(linearSessionId: string, message: string): Promise<void> {
  "use step";
  await emitError(linearSessionId, message);
}

async function finalizeStop(linearSessionId: string): Promise<void> {
  "use step";
  await emitResponse(linearSessionId, "Stopped, as requested.");
}

/* ───────────────────────── Wait helpers (races live in the workflow body) ─────────────────────────
 * Hooks + sleep races MUST be in the workflow body (workflow-level primitives), so these are plain
 * async helpers that the body calls inline — NOT steps. The `Promise.race([hook, sleep])` idiom is
 * the documented timeout pattern (vercel-workflows.md §7, workflow cookbook/timeouts).
 */

// Result of waiting on a running job. `question` is handled INSIDE the loop below and never
// surfaces to callers; callers see only done / stop / timeout.
type WaitJobResult =
  | { kind: "done"; value: JobDoneHookPayloadT }
  | { kind: "stop" }
  | { kind: "timeout" };

// One race iteration over a running job. Races the terminal callback (jobDoneHook) against a
// mid-run question (questionHook), the JOB_TIMEOUT backstop, and — when withStop — a stop signal
// (promptHook). All hooks live in this scope; the `Promise.race` is `await`ed inside it so `using`
// keeps them alive until it settles (the disposal-timing bug we hit before).
type RaceOutcome =
  | { kind: "done"; value: JobDoneHookPayloadT }
  | { kind: "question"; jobId: string; questionId: string; questions: AgentQuestion[] }
  | { kind: "stop" }
  | { kind: "timeout" };

// Wait for a running job to finish, handling any mid-run AskUserQuestion(s) along the way.
// withStop=true also lets a stop signal short-circuit the wait (execute phase). On a question:
// elicit + collect in Linear, deliver the answers to the mini, then loop and wait again.
//
// B1 FIX (structural): the questionHook is created ONCE and lives for the ENTIRE loop — including
// while we handle a question — so there is no unregistered window where a rapid second question
// would be dropped. We consume successive questions from a single long-lived async iterator
// (hooks are AsyncIterable, like the stop hook), racing its .next() against the other branches
// each round WITHOUT disposing it between questions. The JOB_TIMEOUT is a single budget for the
// whole wait (not reset per question), which is the desired backstop. All of this stays inside
// the `using` scope so the hooks remain registered; the `Promise.race` is awaited within it.
async function waitForJob(
  jobId: string,
  linearSessionId: string,
  opts: { withStop: boolean; issueId?: string },
): Promise<WaitJobResult> {
  using done = jobDoneHook.create({ token: jobDoneToken(jobId) });
  using question = questionHook.create({ token: questionToken(jobId) });
  using stop = promptHook.create({ token: promptToken(linearSessionId) });

  // Long-lived iterators: calling .next() again yields the NEXT resume on the same registered
  // hook, so the question hook is never unregistered between questions.
  const questionIter = question[Symbol.asyncIterator]();
  const stopIter = stop[Symbol.asyncIterator]();

  // Hoist each long-lived branch's pending promise OUTSIDE the loop. After a race, refresh ONLY
  // the branch that resolved (the question branch) — never re-pull an iterator whose previous
  // .next() is still pending, and never re-await a hook mid-flight. The losers stay pending and
  // are reused on the next round. The timeout is a single budget for the whole wait.
  const doneBranch: Promise<RaceOutcome> = (async () => ({ kind: "done", value: await done }))();
  const timeoutBranch: Promise<RaceOutcome> = sleep(JOB_TIMEOUT).then(() => ({ kind: "timeout" }));
  const stopBranch: Promise<RaceOutcome> = opts.withStop
    ? (async (): Promise<RaceOutcome> => {
        // Only a stop signal short-circuits; drain non-stop messages so a stale non-stop value
        // can't permanently win the race.
        while (true) {
          const { value, done: end } = await stopIter.next();
          if (end || !value) return { kind: "timeout" };
          if (value.signal === "stop") return { kind: "stop" };
        }
      })()
    : new Promise<RaceOutcome>(() => {}); // never resolves when stop isn't wanted

  const nextQuestion = (): Promise<RaceOutcome> =>
    (async (): Promise<RaceOutcome> => {
      const { value, done: end } = await questionIter.next();
      if (end || !value) return { kind: "timeout" }; // iterator exhausted (won't normally happen)
      return {
        kind: "question",
        jobId: value.jobId,
        questionId: value.questionId,
        questions: value.questions,
      };
    })();

  let questionBranch = nextQuestion();
  let questionRounds = 0;
  while (true) {
    // MUST `await` inside the `using` scope — a bare `return Promise.race(...)` would dispose the
    // hooks the instant the race is built, before any resume can land.
    const outcome = await Promise.race([doneBranch, questionBranch, stopBranch, timeoutBranch]);

    if (outcome.kind === "done") return { kind: "done", value: outcome.value };
    if (outcome.kind === "stop") return { kind: "stop" };
    if (outcome.kind === "timeout") return { kind: "timeout" };

    // outcome.kind === "question" — handle it WITHOUT disposing the question hook, so a second
    // question that arrives during handling is buffered by the still-registered hook and picked
    // up by the next questionIter.next() below.
    questionRounds += 1;
    if (questionRounds > MAX_QUESTION_ROUNDS) {
      await emitThought(
        linearSessionId,
        "Too many clarifying questions in a row — stopping to avoid a loop.",
      );
      return { kind: "timeout" };
    }

    const asked = await askQuestionsViaLinear(linearSessionId, outcome.questions, opts.issueId);
    if (asked.kind === "stop") return { kind: "stop" };
    await deliverAnswerStep(outcome.jobId, outcome.questionId, asked.answers);

    // Re-arm ONLY the question branch; done/stop/timeout keep their pending promises.
    questionBranch = nextQuestion();
  }
}

/* ───────────────────────── AskUserQuestion elicitation (workflow body helper) ─────────────────────────
 * Emits one elicitation per question, collects each answer (select value or free text), and builds
 * the answers map keyed by question text → chosen label(s). A stop reply propagates up so the
 * caller can abort the job. The per-question wait reuses the sweeper so an unanswered question
 * can't hang the run forever.
 */

type AskResult = { kind: "answers"; answers: Record<string, string> } | { kind: "stop" };

async function askQuestionsViaLinear(
  linearSessionId: string,
  questions: AgentQuestion[],
  issueId?: string,
): Promise<AskResult> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    await emitQuestionStep(linearSessionId, q);
    const reply = await waitForPromptWithSweeper(linearSessionId, issueId);
    if (reply.kind === "stop") return { kind: "stop" };
    // Normalized per the contract: single-select → option label; multiSelect → matched labels
    // joined by ", " (fallback to raw text). Keyed by the question text.
    answers[q.question] = answerFromReply(q, reply.value);
  }
  return { kind: "answers", answers };
}

type PromptResult =
  | { kind: "prompt"; value: { text: string; selectValue?: string } }
  | { kind: "stop" };

// Approval wait with the built-in sweeper (plan §7): race promptHook against sleep(3d) -> nudge ->
// sleep(4d) -> reap worktree, then KEEP waiting on the same hook so a late reply still resumes.
async function waitForPromptWithSweeper(linearSessionId: string, issueId?: string): Promise<PromptResult> {
  using prompt = promptHook.create({ token: promptToken(linearSessionId) });
  const next = (async (): Promise<{ text: string; signal?: "stop"; selectValue?: string }> => await prompt)();

  // Stage 1: wait up to 3 days, else nudge.
  const stage1 = await Promise.race([
    next.then((value) => ({ kind: "msg" as const, value })),
    sleep(SWEEP_NUDGE_AFTER).then(() => ({ kind: "nudge" as const })),
  ]);
  if (stage1.kind === "msg") return toPromptResult(stage1.value);
  await nudge(linearSessionId);

  // Stage 2: wait up to 4 more days, else reap the worktree.
  const stage2 = await Promise.race([
    next.then((value) => ({ kind: "msg" as const, value })),
    sleep(SWEEP_REAP_AFTER).then(() => ({ kind: "reap" as const })),
  ]);
  if (stage2.kind === "msg") return toPromptResult(stage2.value);
  await reapWorktree(linearSessionId);
  void issueId; // reserved for richer reap behavior

  // Stage 3: keep waiting indefinitely; a late reply re-creates the worktree and resumes.
  return toPromptResult(await next);
}

function toPromptResult(value: { text: string; signal?: "stop"; selectValue?: string }): PromptResult {
  if (value.signal === "stop") return { kind: "stop" };
  return { kind: "prompt", value: { text: value.text, selectValue: value.selectValue } };
}

/* ───────────────────────── The workflow ───────────────────────── */

export async function sessionWorkflow(input: SessionInput): Promise<void> {
  "use workflow";

  await ackThought(input.linearSessionId, `Looking into ${input.issueIdentifier}…`);
  await syncStatusStep(input.issueId);

  let claudeSessionId: string | undefined;

  // PLAN
  let job = await startMiniJob({ kind: "plan", round: 0, input });
  let done = await waitForJob(job.jobId, input.linearSessionId, {
    withStop: true,
    issueId: input.issueId,
  });
  if (done.kind === "stop") {
    await abortMiniJob(job.jobId);
    await sleep(ABORT_GRACE);
    await finalizeStop(input.linearSessionId);
    return;
  }
  if (done.kind === "timeout") {
    await finalizeError(input.linearSessionId, "The planning job timed out. Please try again.");
    return;
  }
  if (done.value.status !== "succeeded") {
    await finalizeError(
      input.linearSessionId,
      `Planning ${done.value.status}${done.value.reason ? `: ${done.value.reason}` : "."}`,
    );
    return;
  }
  claudeSessionId = done.value.claudeSessionId ?? claudeSessionId;

  // APPROVAL LOOP
  let round = 0;
  while (true) {
    await sendElicitation(input.linearSessionId, done.value.planSummary);
    const msg = await waitForPromptWithSweeper(input.linearSessionId, input.issueId);
    if (msg.kind === "stop") {
      await finalizeStop(input.linearSessionId);
      return;
    }

    const intent = await classifyIntentStep(msg.value);
    if (intent === "approve") break;

    round += 1;
    if (round > MAX_REVISION_ROUNDS) {
      await finalizeError(
        input.linearSessionId,
        `Reached the maximum of ${MAX_REVISION_ROUNDS} revision rounds. Closing this session — re-delegate to start fresh.`,
      );
      return;
    }

    job = await startMiniJob({
      kind: "revise",
      round,
      input,
      feedback: msg.value.text,
      claudeSessionId,
    });
    done = await waitForJob(job.jobId, input.linearSessionId, {
      withStop: true,
      issueId: input.issueId,
    });
    if (done.kind === "stop") {
      await abortMiniJob(job.jobId);
      await sleep(ABORT_GRACE);
      await finalizeStop(input.linearSessionId);
      return;
    }
    if (done.kind === "timeout") {
      await finalizeError(input.linearSessionId, "The revision job timed out. Please try again.");
      return;
    }
    if (done.value.status !== "succeeded") {
      await finalizeError(
        input.linearSessionId,
        `Revision ${done.value.status}${done.value.reason ? `: ${done.value.reason}` : "."}`,
      );
      return;
    }
    claudeSessionId = done.value.claudeSessionId ?? claudeSessionId;
  }

  // EXECUTE
  const execJob = await startMiniJob({ kind: "execute", round: 0, input, claudeSessionId });
  const result = await waitForJob(execJob.jobId, input.linearSessionId, {
    withStop: true,
    issueId: input.issueId,
  });
  if (result.kind === "stop") {
    await abortMiniJob(execJob.jobId);
    await sleep(ABORT_GRACE); // brief grace for the abort callback (best-effort)
    await finalizeStop(input.linearSessionId);
    return;
  }
  if (result.kind === "timeout") {
    await finalizeError(input.linearSessionId, "The execution job timed out. Check the mini's logs.");
    return;
  }
  if (result.value.status !== "succeeded") {
    await finalizeError(
      input.linearSessionId,
      `Execution ${result.value.status}${result.value.reason ? `: ${result.value.reason}` : "."}`,
    );
    return;
  }
  await finalizeSuccess(input.linearSessionId, result.value);
}
