# Integration Contract — Vercel ⇄ Mini (THE SEAM)

**This file is binding.** The two builders implement independently against only this file. Any
gap here becomes a runtime bug. If something is unclear, flag it in `open-questions.md` rather
than inventing a divergent shape.

`CONTRACT_VERSION = "1.0.0"` — embedded in every mini→Vercel callback. Bump on any breaking
change to a schema below; both sides must move together.

Last updated: 2026-06-15. The Vercel⇄mini seam below is independent of Linear's internal API
shapes; for the now-confirmed Linear field/enum/mutation shapes (via live GraphQL introspection)
see `linear-agents-api.md`, and for the confirmed Workflow timeout-race + `start()` return shape
see `vercel-workflows.md`.

---

## 0. Topology recap

```
Vercel  ──(MINI_AUTH_SECRET bearer + CF Access token)──►  Mini   POST /jobs, /jobs/:id/abort, /jobs/:id/answer, /jobs/reap, GET /healthz
Mini    ──(CALLBACK_SECRET bearer)─────────────────────►  Vercel POST /api/mini/callback, /api/mini/question
```
- Vercel is the state machine (workflow + hooks). Mini is a dumb execution appliance.
- Mini streams `thought`/`action`/`plan` activities **directly to Linear** during runs (not
  through Vercel). Only **terminal** status flows back to Vercel via the callback.

---

## 1. Shared zod schemas — implemented in `packages/contract`

> These schemas now live ONCE in `packages/contract/src/index.ts` (the `@linear-agent/contract`
> workspace package); both apps import them, so there is nothing to copy by hand. The block below
> is the human-readable spec — keep it and the package consistent.

```ts
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
  prUrl: z.string().url().optional(),
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
  prUrl: z.string().url().optional(),
  branch: z.string().optional(),
  planSummary: z.string().optional(),
  claudeSessionId: z.string().optional(),
  reason: z.string().optional(),
});
export type JobDoneHookPayload = z.infer<typeof JobDoneHookPayload>;
```

---

## 2. Auth — exact headers, both directions

### Vercel → Mini (shared bearer + Cloudflare Access service token)
The mini binds loopback only, so the sole network path in is the co-located cloudflared daemon.
On top of that, Vercel MUST authenticate at the app layer on EVERY mini endpoint (`/jobs`,
`/jobs/:id/abort`, `/jobs/:id/answer`, `/jobs/reap`, `/healthz`):

```
Authorization:           Bearer <MINI_AUTH_SECRET>
CF-Access-Client-Id:     <CF_ACCESS_CLIENT_ID>
CF-Access-Client-Secret: <CF_ACCESS_CLIENT_SECRET>
```
The mini enforces the bearer itself with a constant-time compare and **fails closed**: a missing
or wrong bearer → **401**, and an unset `MINI_AUTH_SECRET` rejects every request. This is
independent of Cloudflare Access, so the mini is never unauthenticated even if the tunnel/edge is
bypassed (e.g. on Tailscale/LAN) or misconfigured. The CF Access service token is additionally
enforced at Cloudflare's edge (→ **403** before the mini) and, when `ENFORCE_CF_ACCESS=1`, by the
mini too (also fail-closed: missing tokens → 403). `⚠️ VERIFY` exact Cloudflare header casing —
`CF-Access-Client-Id` / `CF-Access-Client-Secret` is the documented pair.

### Mini → Vercel (shared secret)
The mini MUST send on `POST /api/mini/callback`:

```
Authorization: Bearer <CALLBACK_SECRET>
```
Vercel MUST reject (401) any callback without a matching bearer token, comparing with a
constant-time compare. (Decision: `Authorization: Bearer` scheme over a custom header, for
convention. See open-questions if a custom header is preferred.)

---

## 3. Hook tokens — deterministic derivation (Vercel-internal, but contract-fixed so routes agree)

Both the workflow (which `create`s the hook) and the route (which `resume`s it) compute the
same token from data each already has:

```ts
export const promptToken  = (linearSessionId: string) => `prompt:${linearSessionId}`;
export const jobDoneToken = (jobId: string)           => `job:${jobId}`;
```
- `promptHook` token: keyed on `linearSessionId` (the webhook route has it from
  `agentSession.id`).
- `jobDoneHook` token: keyed on `jobId` (the callback route has it from the body, AND it was
  returned by `POST /jobs` and recorded in the workflow event log).

---

## 4. Idempotency / dedup — what each side dedupes on

| Boundary | Dedup key | Who dedupes | Mechanism |
|---|---|---|---|
| Linear webhook | `Linear-Delivery` (UUID) — fallback `webhookId`+`webhookTimestamp` | Vercel | Neon insert-or-ignore BEFORE `start`/`resume` |
| `POST /jobs` retry | `idempotencyKey` = `${linearSessionId}:${kind}:${round}` | Mini | return existing `jobId`, do not start a second job |
| Mini→Vercel callback | `jobId` | Vercel | resume `jobDoneHook`; success → 200 `{ack:true}`. Hook not found (not registered yet, or already consumed) → retryable **503** so an early callback isn't dropped; the mini's bounded retries absorb a true duplicate |
| `POST /jobs/:id/abort` | `jobId` | Mini | idempotent; unknown/finished → `aborted:false` |

`round` is the revision-loop counter the workflow already tracks (0 for the first plan). It
makes the idempotency key unique per logical job while staying deterministic across replays.

---

## 5. End-to-end sequence (happy path)

1. Linear `created` → Vercel verifies sig, dedupes on `Linear-Delivery`, emits ack `thought`,
   `start(sessionWorkflow, [{linearSessionId, issueIdentifier, promptContext}])`, inserts Neon
   session row, returns 200 (< 5 s).
2. Workflow step → `POST /jobs {kind:"plan", idempotencyKey:`${sid}:plan:0`, …}` → `{jobId}`.
3. Mini runs plan, streams `thought`/`action`/`plan` **directly to Linear**, then
   `POST /api/mini/callback {kind:"plan", status:"succeeded", planSummary, claudeSessionId}`.
4. Vercel callback route resumes `jobDoneHook(`job:${jobId}`)` → workflow continues.
5. Workflow emits `elicitation` + `select` (Approve / Request changes).
6. Linear `prompted` (button or text) → Vercel resumes `promptHook(`prompt:${sid}`, {text,
   selectValue, signal})`.
7. classifyIntent: `approve` → break to execute; else `POST /jobs {kind:"revise",
   feedback, claudeSessionId, idempotencyKey:`${sid}:revise:${round}`}` and loop to 3.
8. Execute: `POST /jobs {kind:"execute", claudeSessionId, idempotencyKey:`${sid}:execute:0`}`;
   `waitForJob` races jobDoneHook vs promptHook(stop) vs sleep(45m).
9. Terminal callback `{kind:"execute", status:"succeeded", prUrl, branch}` → workflow sets
   `externalUrls`, emits final `response`. Done.

### Stop path
Linear `prompted` with `agentActivity.signal:"stop"` → resume `promptHook(…, {signal:"stop"})`.
Workflow → `POST /jobs/:id/abort`, waits briefly for the `status:"aborted"` callback (or a short
sleep), emits a final confirmation `response`. During a long execute the workflow is already
racing promptHook(stop) against jobDoneHook so stop works mid-run.

### Failure / timeout path
- Mini step `POST /jobs` unreachable → step auto-retries; if still down past the retry window,
  surface a Linear `error`.
- Callback lost (job done, POST failed) → mini retries with backoff + persists undelivered;
  `waitForJob` sleep(45m) is the backstop → Linear `error` with `reason`.
- Mini restarted mid-job → boot reconciliation sends `status:"failed", reason:"interrupted"`.

---

## 6. Environment variables (plan §5) — every var each side needs

### Vercel
| Var | Use |
|---|---|
| `LINEAR_ACCESS_TOKEN` | emit lifecycle activities, set plan/externalUrls, status sync |
| `LINEAR_WEBHOOK_SECRET` | verify `Linear-Signature` |
| `LINEAR_APP_USER_ID` | app user id (`viewer.id`) for delegate/self checks |
| `MINI_BASE_URL` | e.g. `https://agent-jobs.yourdomain.com` |
| `CF_ACCESS_CLIENT_ID` | service token → tunnel (sent as `CF-Access-Client-Id`) |
| `CF_ACCESS_CLIENT_SECRET` | service token → tunnel (sent as `CF-Access-Client-Secret`) |
| `MINI_AUTH_SECRET` | bearer it presents on every mini request (`Authorization: Bearer …`) |
| `CALLBACK_SECRET` | the bearer it expects on `/api/mini/callback` |
| `DATABASE_URL` | Neon (session ↔ runId map, webhook dedupe) |

### Mini (file mode 0600)
| Var | Use |
|---|---|
| `LINEAR_ACCESS_TOKEN` | stream activities + plan array directly to Linear |
| `GITHUB_TOKEN` | push + open PR (repo-scoped PAT) |
| `VERCEL_CALLBACK_URL` | e.g. `https://your-app.vercel.app/api/mini/callback` |
| `CALLBACK_SECRET` | the bearer it presents on the callback |
| `MINI_AUTH_SECRET` | bearer it requires on every inbound request (fails closed if unset) |
| `MAX_CONCURRENT_EXECUTIONS` | local concurrency cap (e.g. 2) |
| `WORK_ROOT` | e.g. `/Users/linearagent/work` |

Both sides additionally embed the literal `CONTRACT_VERSION` from §1 (not an env var — it ships
in code so a mismatch is a deploy-time signal, not a config drift).

> Note (subscription auth): the mini authenticates the Claude Agent SDK via the user's Claude
> subscription on the dedicated `linearagent` macOS user (per plan §1/§Decisions). This is a
> personal, non-product deployment; it is NOT part of the Vercel⇄mini seam and needs no env var
> here.

---

## 7. Conventions both sides MUST hold

- Content-Type `application/json` on every request/response with a body.
- All correlation keys are strings; `linearSessionId` is the master key, `jobId` is the
  per-run key.
- Timestamps, when present, are ISO-8601 UTC strings.
- The mini NEVER sends non-terminal statuses to Vercel. The workflow NEVER polls the mini.
- A 2xx from a callback means "accepted, stop retrying". A **503** means "not ready, retry" (the
  `jobDoneHook` isn't registered yet — fast jobs can call back before the workflow creates it); the
  mini's bounded backoff replays until it lands. Only a 409 is fatal (see below).
- Reject unknown `contractVersion`: respond 409 with
  `{error:"contract-version-mismatch", contractVersion:"<the version THIS side speaks>"}` so
  a half-deployed pair fails loudly rather than silently misbehaving. Both directions use this
  exact body (mini's `/jobs` and `/jobs/reap`; Vercel's `/api/mini/callback`). The `error`
  field is the stable discriminator; `contractVersion` is for diagnostics.
- A received 409 `contract-version-mismatch` is **fatal — do NOT retry**. The caller logs it
  loudly and surfaces it (the mini drops the callback to its outbox as permanently-failed rather
  than retrying to `MAX_ATTEMPTS`; Vercel surfaces a Linear `error`). Retrying a version mismatch
  never succeeds and only delays the loud failure.
