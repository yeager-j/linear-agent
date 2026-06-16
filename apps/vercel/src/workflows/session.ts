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
  type JobKind,
  type JobDoneHookPayload as JobDoneHookPayloadT,
} from "@/lib/contract";
import { promptToken, jobDoneToken } from "@/lib/tokens";
import {
  emitElicitationSelect,
  emitError,
  emitResponse,
  emitThought,
  setExternalUrls,
  syncIssueToStarted,
} from "@/lib/linear";
import { abortJob, createJob, reapWorktree as reapMiniWorktree } from "@/lib/mini";
import { classifyIntent } from "@/lib/intent";
import {
  ABORT_GRACE,
  JOB_TIMEOUT,
  MAX_REVISION_ROUNDS,
  SWEEP_NUDGE_AFTER,
  SWEEP_REAP_AFTER,
} from "@/lib/env";

/* ───────────────────────── Hooks (exported so routes can resume) ───────────────────────── */

// promptHook — resumed by the Linear webhook route on a `prompted` event (token: prompt:<sid>).
export const promptHook = defineHook({ schema: PromptHookPayload });

// jobDoneHook — resumed by /api/mini/callback when a job reaches terminal status (token: job:<id>).
export const jobDoneHook = defineHook({ schema: JobDoneHookPayload });

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

async function sendElicitation(linearSessionId: string): Promise<void> {
  "use step";
  await emitElicitationSelect(
    linearSessionId,
    "I've finished planning. Approve this plan, or describe the changes you'd like.",
    [
      { label: "Approve", value: "approve" },
      { label: "Request changes", value: "request_changes" },
    ],
  );
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

type WaitJobResult =
  | { kind: "done"; value: JobDoneHookPayloadT }
  | { kind: "timeout" };

// Wait for a job's terminal callback, bounded by JOB_TIMEOUT so a silently dead mini surfaces as
// a Linear error instead of a run paused forever.
async function waitForJob(jobId: string): Promise<WaitJobResult> {
  using done = jobDoneHook.create({ token: jobDoneToken(jobId) });
  // MUST `return await` (not `return`): a bare `return Promise.race(...)` exits this scope
  // synchronously, so `using` disposes the hook the instant the race is built — before the
  // callback can resume it. Awaiting keeps the hook alive until the race settles.
  return await Promise.race([
    (async (): Promise<WaitJobResult> => ({ kind: "done", value: await done }))(),
    sleep(JOB_TIMEOUT).then((): WaitJobResult => ({ kind: "timeout" })),
  ]);
}

type WaitJobOrStopResult =
  | { kind: "done"; value: JobDoneHookPayloadT }
  | { kind: "stop" }
  | { kind: "timeout" };

// Execute phase: race the job's completion against a stop signal and the timeout backstop, so a
// stop request works mid-run, not just between phases (plan §5/§7, contract §5 stop path).
async function waitForJobOrStop(jobId: string, linearSessionId: string): Promise<WaitJobOrStopResult> {
  using done = jobDoneHook.create({ token: jobDoneToken(jobId) });
  using stop = promptHook.create({ token: promptToken(linearSessionId) });
  // `return await` (not bare `return`) so `using` keeps both hooks alive until the race settles
  // — see waitForJob for why a bare return disposes them before they can be resumed.
  return await Promise.race([
    (async (): Promise<WaitJobOrStopResult> => ({ kind: "done", value: await done }))(),
    (async (): Promise<WaitJobOrStopResult> => {
      // Only a stop signal short-circuits the execute; non-stop prompts during execute are ignored.
      for await (const msg of stop) {
        if (msg.signal === "stop") return { kind: "stop" };
      }
      return { kind: "timeout" }; // iterator exhausted (won't normally happen)
    })(),
    sleep(JOB_TIMEOUT).then((): WaitJobOrStopResult => ({ kind: "timeout" })),
  ]);
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
  let done = await waitForJob(job.jobId);
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
    await sendElicitation(input.linearSessionId);
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
    done = await waitForJob(job.jobId);
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
  const result = await waitForJobOrStop(execJob.jobId, input.linearSessionId);
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
