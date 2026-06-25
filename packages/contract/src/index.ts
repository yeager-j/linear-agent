// @linear-agent/contract — THE SEAM, single source of truth.
//
// These schemas, the CONTRACT_VERSION, and the token helpers are the binding interface
// between linear-agent-vercel (state machine) and linear-agent-mini (execution appliance).
// This package is the ONE place they live; both apps import from here, so there is nothing
// to keep in sync by hand. The human-readable spec is shared/integration-contract.md —
// keep this file and that doc consistent (§1 schemas, §3 tokens).

import { z } from "zod";

export const CONTRACT_VERSION = "1.0.0";

/* ───────────────────────── Enums ───────────────────────── */

// Job kind. plan = first plan-mode run; revise = re-plan with feedback (resumes Claude
// session); execute = containerized run that produces a PR.
export const JobKind = z.enum(["plan", "revise", "execute"]);
export type JobKind = z.infer<typeof JobKind>;

// Terminal status reported by the mini in the callback. (Non-terminal states like
// "running"/"queued" live only in the mini's SQLite and are NEVER sent to Vercel.)
export const TerminalStatus = z.enum(["succeeded", "failed", "aborted"]);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

/* ─────────────────── Mini HTTP API: POST /jobs ─────────────────── */

export const CreateJobRequest = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  kind: JobKind,
  linearSessionId: z.string().min(1),     // Linear AgentSession.id — the master correlation key
  issueIdentifier: z.string().min(1),     // e.g. "ENG-123" (for logging / branch naming)
  // Initial context for kind="plan": Linear's formatted prompt string ("issue details, comments,
  // and guidance"). CORRECTION: this is the webhook ENVELOPE's promptContext, NOT the GraphQL
  // AgentSession.context field (that field is related entities, not prompt text — see
  // linear-agents-api.md §2 correction). Vercel reads it off the `created` webhook and forwards
  // it here as a string (stringify if delivered as JSON). ⚠️ exact envelope path is still VERIFY.
  promptContext: z.string().optional(),
  // Revision feedback for kind="revise". Required when kind="revise".
  feedback: z.string().optional(),
  // Claude session continuity: when present, the mini resumes this Claude SDK session
  // (set on revise/execute so they continue the plan's session). The MINI owns the
  // authoritative claudeSessionId in its SQLite; this field lets Vercel pass back what the
  // mini reported, but the mini may ignore it and use its own stored value.
  claudeSessionId: z.string().optional(),
  // Fresh Linear access token minted by Vercel's token authority (lib/linear-token.ts), captured
  // at job-start and used by the mini ONLY for this job's activity stream. The mini never refreshes
  // it (jobs run << the 24h token life). Kept permissive (no .min/format) on purpose: a bad value
  // must never surface in a zod treeifyError 400 body. Optional so a token-less call (dev/tests)
  // still parses; the mini decides whether to fail-loud when it's absent.
  linearAccessToken: z.string().optional(),
  // Idempotency: if the same key is retried, the mini returns the SAME jobId (no new job).
  idempotencyKey: z.string().min(1),      // Vercel sets this = `${linearSessionId}:${kind}:${round}`
}).superRefine((v, ctx) => {
  if (v.kind === "revise" && !v.feedback)
    ctx.addIssue({ code: "custom", path: ["feedback"], message: "feedback required when kind=revise" });
});
export type CreateJobRequest = z.infer<typeof CreateJobRequest>;

// 200/202. jobId is mini-generated (uuid). queued=true means accepted but over the local
// concurrency cap — it will start later and call back normally. Either way Vercel just waits
// on jobDoneHook(token=`job:${jobId}`).
export const CreateJobResponse = z.object({
  jobId: z.string().min(1),
  queued: z.boolean().default(false),
});
export type CreateJobResponse = z.infer<typeof CreateJobResponse>;

/* ─────────────────── Mini HTTP API: POST /jobs/:id/abort ─────────────────── */

// No body required. Idempotent: aborting an unknown/finished job returns 200 with aborted:false.
// The mini flips its AbortController; the eventual terminal callback carries status:"aborted".
export const AbortJobResponse = z.object({
  jobId: z.string().min(1),
  aborted: z.boolean(),   // true if a running job was signalled; false if no-op
});
export type AbortJobResponse = z.infer<typeof AbortJobResponse>;

/* ─────────────────── Mini HTTP API: POST /jobs/reap ─────────────────── */

// Sweeper-driven worktree reclamation (plan §7). After the workflow's idle sweep
// (nudge → wait), it tells the mini to delete the session's worktree to reclaim disk.
// The mini KEEPS the claude_session_id row so a late reply can recreate the worktree and
// resume. Idempotent: reaping an unknown/already-reaped session returns 200 reaped:false.
// Additive endpoint — does NOT bump CONTRACT_VERSION (old callers simply never call it).
export const ReapWorktreeRequest = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  linearSessionId: z.string().min(1),
});
export type ReapWorktreeRequest = z.infer<typeof ReapWorktreeRequest>;

export const ReapWorktreeResponse = z.object({
  linearSessionId: z.string().min(1),
  reaped: z.boolean(),   // true if a worktree was removed; false if nothing to reap (no-op)
});
export type ReapWorktreeResponse = z.infer<typeof ReapWorktreeResponse>;

/* ─────────────────── Mini HTTP API: GET /healthz ─────────────────── */

export const HealthzResponse = z.object({
  ok: z.literal(true),
  runningJobs: z.number().int().nonnegative(),
  maxConcurrentExecutions: z.number().int().positive(),
  uptimeSeconds: z.number().nonnegative(),
});
export type HealthzResponse = z.infer<typeof HealthzResponse>;

/* ─────────────────── Vercel callback: POST /api/mini/callback ─────────────────── */

export const MiniCallback = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  jobId: z.string().min(1),               // dedupe key on the Vercel side
  linearSessionId: z.string().min(1),
  kind: JobKind,                          // which job kind finished (plan|revise|execute)
  status: TerminalStatus,                 // succeeded | failed | aborted
  // For execute jobs that succeeded:
  prUrl: z.url().optional(),
  branch: z.string().optional(),
  // For plan/revise jobs that succeeded: the parsed plan summary the workflow shows before
  // the approve/changes elicitation.
  planSummary: z.string().optional(),
  // The Claude SDK session id the mini used, so Vercel can echo it back on the next job
  // (continuity across plan→revise→execute).
  claudeSessionId: z.string().optional(),
  // For failed/aborted: machine-ish reason. "interrupted" = mini restarted mid-job (boot
  // reconciliation). Free-form text allowed for surfacing in the Linear error activity.
  reason: z.string().optional(),
}).superRefine((v, ctx) => {
  if (v.kind === "execute" && v.status === "succeeded" && !v.prUrl)
    ctx.addIssue({ code: "custom", path: ["prUrl"], message: "prUrl required on successful execute" });
});
export type MiniCallback = z.infer<typeof MiniCallback>;

// Callback response. ack=true means Vercel accepted (resumed or deduped). The mini stops
// retrying on any 2xx. On non-2xx the mini retries with backoff and persists undelivered ones.
export const MiniCallbackResponse = z.object({ ack: z.literal(true) });
export type MiniCallbackResponse = z.infer<typeof MiniCallbackResponse>;

/* ─────────────────── Workflow hook payloads (Vercel-internal, defined here for the seam) ─────────────────── */

// promptHook — resumed by the Linear webhook route on a `prompted` event.
export const PromptHookPayload = z.object({
  text: z.string(),                       // the user's message text (may be "")
  signal: z.literal("stop").optional(),   // present when the user asked to stop
  selectValue: z.string().optional(),     // the select option value, if they clicked a button
});
export type PromptHookPayload = z.infer<typeof PromptHookPayload>;

// jobDoneHook — resumed by /api/mini/callback. Mirror of the terminal fields of MiniCallback.
export const JobDoneHookPayload = z.object({
  jobId: z.string(),
  kind: JobKind,
  status: TerminalStatus,
  prUrl: z.url().optional(),
  branch: z.string().optional(),
  planSummary: z.string().optional(),
  claudeSessionId: z.string().optional(),
  reason: z.string().optional(),
});
export type JobDoneHookPayload = z.infer<typeof JobDoneHookPayload>;

/* ─────────────────── AskUserQuestion (mid-run HITL) ─────────────────── */

// The agent (via the SDK's built-in AskUserQuestion tool) can ask clarifying questions MID-RUN.
// The mini intercepts the tool call (canUseTool), pauses the run, and asks Vercel to elicit the
// answer(s) in Linear, then resumes the run with them. One AskUserQuestion call may carry several
// questions; they're answered together and returned as a map keyed by question text.

// One selectable option for a question. `label` is the answer VALUE returned to the SDK.
export const AgentQuestionOption = z.object({
  label: z.string(),
  description: z.string().default(""),
});
export type AgentQuestionOption = z.infer<typeof AgentQuestionOption>;

export const AgentQuestion = z.object({
  question: z.string(),              // the prompt text; also the KEY in the answers map
  header: z.string().default(""),    // short label (≤12 chars in the SDK)
  multiSelect: z.boolean().default(false),
  options: z.array(AgentQuestionOption).default([]),
});
export type AgentQuestion = z.infer<typeof AgentQuestion>;

// Mini → Vercel: POST /api/mini/question. The agent asked; pause and elicit in Linear.
export const AskQuestionRequest = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  jobId: z.string().min(1),
  linearSessionId: z.string().min(1),
  questionId: z.string().min(1),     // mini-generated; correlates the answer back
  questions: z.array(AgentQuestion).min(1),
});
export type AskQuestionRequest = z.infer<typeof AskQuestionRequest>;

export const AskQuestionResponse = z.object({ ack: z.literal(true) });
export type AskQuestionResponse = z.infer<typeof AskQuestionResponse>;

// Vercel → Mini: POST /jobs/:id/answer. The user's answers, keyed by question text → chosen
// label(s) (multiSelect joined by ", "), matching the SDK's expected updatedInput.answers.
export const AnswerRequest = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  questionId: z.string().min(1),
  answers: z.record(z.string(), z.string()),
});
export type AnswerRequest = z.infer<typeof AnswerRequest>;

export const AnswerResponse = z.object({
  questionId: z.string().min(1),
  delivered: z.boolean(),            // false if no pending question matched (stale/unknown)
});
export type AnswerResponse = z.infer<typeof AnswerResponse>;

// questionHook — resumed by /api/mini/question; mirrors the request's payload fields.
export const QuestionHookPayload = z.object({
  jobId: z.string(),
  questionId: z.string(),
  questions: z.array(AgentQuestion),
});
export type QuestionHookPayload = z.infer<typeof QuestionHookPayload>;

/* ─────────────────── Hook tokens (contract §3) ─────────────────── */

// Both the workflow (which `create`s the hook) and the route (which `resume`s it) compute the
// same token from data each already has. MUST stay pure functions of their inputs (no Date.now /
// randomness) — they are recomputed on every workflow replay and must be identical each time.
export const promptToken   = (linearSessionId: string) => `prompt:${linearSessionId}`;
export const jobDoneToken  = (jobId: string)           => `job:${jobId}`;
export const questionToken = (jobId: string)           => `question:${jobId}`;
