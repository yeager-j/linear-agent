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
import { z } from "zod";
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
} from "@/lib/limits";

/* ───────────────────────── Hooks (exported so routes can resume) ───────────────────────── */

// promptHook — resumed by the Linear webhook route on a `prompted` event (token: prompt:<sid>).
export const promptHook = defineHook({ schema: PromptHookPayload });

// jobDoneHook — resumed by /api/mini/callback when a job reaches terminal status (token: job:<id>).
export const jobDoneHook = defineHook({ schema: JobDoneHookPayload });

// questionHook — resumed by /api/mini/question when the agent asks a mid-run AskUserQuestion
// (token: question:<jobId>). Carries one or more questions answered together.
export const questionHook = defineHook({ schema: QuestionHookPayload });

// sessionLockHook — per-session ownership lock. Two `created` deliveries for the same session
// (re-delivery with a new id, or re-delegation) would otherwise each start() a run; both then
// create prompt:<sid> hooks and the loser crashes with HookConflictError. The run claims this
// deterministic lock token at the top and, if another active run already owns it, exits cleanly.
// It is NEVER resumed — it exists only for getConflict()'s deterministic-token dedupe.
export const sessionLockHook = defineHook({ schema: z.unknown() });
const sessionLockToken = (linearSessionId: string) => `lock:${linearSessionId}`;

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

// Emit a plain (durable) thought to Linear. A step so it fires exactly once and is NOT re-run on
// every workflow replay (an un-stepped emitThought in the body would duplicate the activity).
async function emitThoughtStep(linearSessionId: string, body: string): Promise<void> {
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
export type WaitJobResult =
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
  | { kind: "dropped" } // a non-stop reply arrived mid-run; surfaced to the user, then ignored
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
  opts: { withStop: boolean },
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

  // Resolve on the NEXT promptHook event: a stop short-circuits the wait; any other (non-stop)
  // reply surfaces as "dropped" so the loop can acknowledge it to the user and re-arm — a stale
  // non-stop value can't permanently win the race, and it's no longer silently discarded.
  const nextStop = (): Promise<RaceOutcome> =>
    (async (): Promise<RaceOutcome> => {
      const { value, done: end } = await stopIter.next();
      if (end || !value) return { kind: "timeout" };
      return value.signal === "stop" ? { kind: "stop" } : { kind: "dropped" };
    })();

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

  let stopBranch: Promise<RaceOutcome> = opts.withStop
    ? nextStop()
    : new Promise<RaceOutcome>(() => {}); // never resolves when stop isn't wanted
  let questionBranch = nextQuestion();
  let questionRounds = 0;
  while (true) {
    // MUST `await` inside the `using` scope — a bare `return Promise.race(...)` would dispose the
    // hooks the instant the race is built, before any resume can land.
    const outcome = await Promise.race([doneBranch, questionBranch, stopBranch, timeoutBranch]);

    if (outcome.kind === "done") return { kind: "done", value: outcome.value };
    if (outcome.kind === "stop") return { kind: "stop" };
    if (outcome.kind === "timeout") return { kind: "timeout" };

    if (outcome.kind === "dropped") {
      // A reply landed mid-run. We can't act on it until the current step finishes; tell the user
      // so their message isn't silently lost, then re-arm the stop branch and keep waiting.
      console.warn(`[session] reply arrived during a running job; acknowledged and ignored`);
      await emitThoughtStep(
        linearSessionId,
        "I'm still working on the current step — I saw your message but can't act on it yet. " +
          "Please re-send it once I post the next update.",
      );
      stopBranch = nextStop();
      continue;
    }

    // outcome.kind === "question" — handle it WITHOUT disposing the question hook, so a second
    // question that arrives during handling is buffered by the still-registered hook and picked
    // up by the next questionIter.next() below.
    questionRounds += 1;
    if (questionRounds > MAX_QUESTION_ROUNDS) {
      await emitThoughtStep(
        linearSessionId,
        "Too many clarifying questions in a row — stopping to avoid a loop.",
      );
      return { kind: "timeout" };
    }

    const asked = await askQuestionsViaLinear(linearSessionId, outcome.questions);
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
): Promise<AskResult> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    await emitQuestionStep(linearSessionId, q);
    const reply = await waitForPromptWithSweeper(linearSessionId);
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
async function waitForPromptWithSweeper(linearSessionId: string): Promise<PromptResult> {
  using prompt = promptHook.create({ token: promptToken(linearSessionId) });
  const next = (async (): Promise<{ text: string; signal?: "stop"; selectValue?: string }> => await prompt)();

  // Stage 1: wait up to 3 days, else nudge.
  const stage1 = await Promise.race([
    next.then((value) => ({ kind: "msg" as const, value })),
    sleep(SWEEP_NUDGE_AFTER).then(() => ({ kind: "nudge" as const })),
  ]);
  if (stage1.kind === "msg") return toPromptResult(stage1.value);
  await emitThoughtStep(
    linearSessionId,
    "Still here whenever you're ready — approve the plan or tell me what to change.",
  );

  // Stage 2: wait up to 4 more days, else reap the worktree.
  const stage2 = await Promise.race([
    next.then((value) => ({ kind: "msg" as const, value })),
    sleep(SWEEP_REAP_AFTER).then(() => ({ kind: "reap" as const })),
  ]);
  if (stage2.kind === "msg") return toPromptResult(stage2.value);
  await reapWorktree(linearSessionId);

  // Stage 3: keep waiting indefinitely; a late reply re-creates the worktree and resumes.
  return toPromptResult(await next);
}

export function toPromptResult(value: { text: string; signal?: "stop"; selectValue?: string }): PromptResult {
  if (value.signal === "stop") return { kind: "stop" };
  return { kind: "prompt", value: { text: value.text, selectValue: value.selectValue } };
}

/* ───────────────────────── Job-outcome handling (shared across plan / revise / execute) ─────────────────────────
 * Plan, revise, and execute each react to a waitForJob result identically: a stop aborts + finalizes,
 * a timeout / non-succeeded status surfaces a Linear error, and success continues. decideJobOutcome
 * is the PURE decision (unit-testable); settleJobOutcome performs the IO the decision implies.
 */

export type JobDecision =
  | { action: "stop" }
  | { action: "error"; message: string }
  | { action: "continue"; done: JobDoneHookPayloadT };

// PURE: map a wait result + phase to the next action, with no IO. `timeoutMessage` is passed
// explicitly because the execute phase's wording genuinely differs from plan/revise.
export function decideJobOutcome(
  result: WaitJobResult,
  opts: { phase: string; timeoutMessage: string },
): JobDecision {
  if (result.kind === "stop") return { action: "stop" };
  if (result.kind === "timeout") return { action: "error", message: opts.timeoutMessage };
  if (result.value.status !== "succeeded") {
    const reason = result.value.reason ? `: ${result.value.reason}` : ".";
    return { action: "error", message: `${opts.phase} ${result.value.status}${reason}` };
  }
  return { action: "continue", done: result.value };
}

type Settled = { kind: "continue"; done: JobDoneHookPayloadT } | { kind: "returned" };

// Apply decideJobOutcome's verdict: on stop, abort the mini job, allow a brief grace for the
// abort callback, and finalize; on error, emit the Linear error; on success, hand the payload back.
// `{kind:"returned"}` means the workflow body should `return`.
async function settleJobOutcome(
  result: WaitJobResult,
  opts: { jobId: string; linearSessionId: string; phase: string; timeoutMessage: string },
): Promise<Settled> {
  const decision = decideJobOutcome(result, { phase: opts.phase, timeoutMessage: opts.timeoutMessage });
  if (decision.action === "stop") {
    await abortMiniJob(opts.jobId);
    await sleep(ABORT_GRACE); // brief grace for the abort callback (best-effort)
    await finalizeStop(opts.linearSessionId);
    return { kind: "returned" };
  }
  if (decision.action === "error") {
    await finalizeError(opts.linearSessionId, decision.message);
    return { kind: "returned" };
  }
  return { kind: "continue", done: decision.done };
}

/* ───────────────────────── The workflow ───────────────────────── */

export async function sessionWorkflow(input: SessionInput): Promise<void> {
  "use workflow";

  // Ownership lock: if another run already claimed this session (a duplicate `created`), this run
  // is the loser of the race — exit cleanly before doing any work or creating conflicting hooks.
  using lock = sessionLockHook.create({ token: sessionLockToken(input.linearSessionId) });
  if (await lock.getConflict()) return;

  await emitThoughtStep(input.linearSessionId, `Looking into ${input.issueIdentifier}…`);
  await syncStatusStep(input.issueId);

  let claudeSessionId: string | undefined;

  // PLAN
  let job = await startMiniJob({ kind: "plan", round: 0, input });
  let settled = await settleJobOutcome(await waitForJob(job.jobId, input.linearSessionId, { withStop: true }), {
    jobId: job.jobId,
    linearSessionId: input.linearSessionId,
    phase: "Planning",
    timeoutMessage: "The planning job timed out. Please try again.",
  });
  if (settled.kind === "returned") return;
  let done = settled.done;
  claudeSessionId = done.claudeSessionId ?? claudeSessionId;

  // APPROVAL LOOP
  let round = 0;
  while (true) {
    await sendElicitation(input.linearSessionId, done.planSummary);
    const msg = await waitForPromptWithSweeper(input.linearSessionId);
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

    job = await startMiniJob({ kind: "revise", round, input, feedback: msg.value.text, claudeSessionId });
    settled = await settleJobOutcome(await waitForJob(job.jobId, input.linearSessionId, { withStop: true }), {
      jobId: job.jobId,
      linearSessionId: input.linearSessionId,
      phase: "Revision",
      timeoutMessage: "The revision job timed out. Please try again.",
    });
    if (settled.kind === "returned") return;
    done = settled.done;
    claudeSessionId = done.claudeSessionId ?? claudeSessionId;
  }

  // EXECUTE
  const execJob = await startMiniJob({ kind: "execute", round: 0, input, claudeSessionId });
  const execSettled = await settleJobOutcome(
    await waitForJob(execJob.jobId, input.linearSessionId, { withStop: true }),
    {
      jobId: execJob.jobId,
      linearSessionId: input.linearSessionId,
      phase: "Execution",
      timeoutMessage: "The execution job timed out. Check the mini's logs.",
    },
  );
  if (execSettled.kind === "returned") return;
  await finalizeSuccess(input.linearSessionId, execSettled.done);
}
