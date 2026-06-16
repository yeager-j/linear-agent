# Vercel Workflow DevKit — Distilled Reference

Source: vercel.com/docs/workflows, /docs/workflows/concepts, the "Build a Claude Managed Agent" KB guide, and workflow-sdk.dev (Next.js getting-started + hooks foundations), fetched 2026-06-15. Items not confirmable verbatim are marked `⚠️ VERIFY`. Only the Vercel builder needs this file.

> The mini side is framework-free and does NOT use any of this.

---

## 1. Package & imports

```bash
npm i workflow     # the open-source Workflow SDK; Vercel runs it as a managed platform
```
```ts
import { start }                 from "workflow/api";   // trigger a run from a route
import { sleep, FatalError }     from "workflow";       // inside workflows/steps
import { defineHook }            from "workflow";       // hook definitions
import { withWorkflow }          from "workflow/next";  // next.config wrapper
```
`⚠️ VERIFY` exact import path for `defineHook` (docs show it imported from `"workflow"`; the
concepts page example uses `import { defineHook } from "workflow"`).

---

## 2. next.config

```ts
// next.config.ts
import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = { /* … */ };
export default withWorkflow(nextConfig);
```

> Project note: this repo's Next.js is 16.2.9 — read `node_modules/next/dist/docs/` before
> writing Next code (per the project AGENTS.md); APIs may differ from older Next.

---

## 3. Directives — the core model

Two directives turn ordinary async functions into durable ones:

- **`"use workflow"`** — a *stateful orchestrator*. Remembers progress; **replayed
  deterministically** after deploys/crashes. Compiles into a route that enqueues steps.
- **`"use step"`** — a *stateless unit of durable work*. Gets automatic retries; survives
  network errors / process crashes. Compiles into its own isolated API route. While a step
  runs, the workflow **suspends without consuming resources** and resumes when the step returns.

```ts
export async function sessionWorkflow(input: SessionInput) {
  "use workflow";
  const job = await startMiniJob("plan", input);   // a step
  // …
}

async function startMiniJob(kind: string, input: SessionInput) {
  "use step";
  // network call to the mini lives HERE
}
```

### THE determinism rule (most important gotcha)
The workflow body is **re-executed (replayed)** from the start on every resume; only `"use
step"` results, `sleep`, and hook awaits are recorded in the event log and **not** re-run. So:

- **Anything non-deterministic or side-effecting MUST be inside a `"use step"`** (or `sleep` /
  hook). That includes: `fetch`/HTTP, DB reads/writes, `Date.now()`, `Math.random()`, `crypto`
  randomness, reading env that may change, file/network IO, and **all Linear GraphQL calls and
  all mini HTTP calls**.
- The workflow body itself should be pure control flow over recorded values. If you compute a
  value in the body (e.g. a token) it must be derivable purely from the workflow **input**, so
  it's identical on every replay.
- Throw `FatalError` inside a step to stop retries on a non-retryable error.

---

## 4. start() — trigger a run

```ts
// in app/api/linear/webhook/route.ts (on `created`)
const run = await start(sessionWorkflow, [input]);   // args passed as an array
// run.runId : string   — store it in Neon keyed by linearSessionId
```
- `start()` returns **before** the workflow has executed far enough to register its hooks.
  → **Pass the first prompt as workflow input, not via a hook** (avoids the race). This is
  plan §3 pattern 1.
- **CONFIRMED (workflow-sdk.dev/docs/foundations/starting-workflows):** `start(workflow, [args])`
  returns a **`Run` object**, not a bare id. Access `run.runId` for the id (run ids are formatted
  `wrun_{ulid}`). Most other `Run` properties are **async getters** you must await:
  `await run.status`, `await run.returnValue` (blocks until the workflow completes),
  `await run.exists`. `start()` itself returns immediately after enqueuing.
  Store `run.runId` in Neon keyed by `linearSessionId`.
- **Re-acquiring a run later:** `getRun(runId)` (import from `"workflow/api"`) returns a `Run`
  for an id you already have — it does NOT look up by business key. To route a *retried* inbound
  request to the right paused hook, the SDK provides **`getHookByToken()`** (CONFIRMED) — i.e.
  resolve by the deterministic token, not by `getRun`.

---

## 5. defineHook / resume — wait for external events

```ts
// in app/workflows/session.ts
export const promptHook = defineHook<{ text: string; signal?: "stop"; selectValue?: string }>();
export const jobDoneHook = defineHook<{
  jobId: string; status: string; prUrl?: string; branch?: string; planSummary?: string; reason?: string;
}>();
```
`defineHook` also accepts a Standard-Schema (zod) form for runtime validation:
```ts
export const promptHook = defineHook({ schema: PromptHookPayload });  // PromptHookPayload is a zod schema
```

### Inside the workflow — create with a deterministic token
```ts
using hook = promptHook.create({ token: `prompt:${input.linearSessionId}` });

// single event:
const msg = await hook;                      // resolves on next resume

// or loop for multiple events over time:
for await (const msg of hook) {
  if (msg.signal === "stop") { /* … */ break; }
}
```
- `create({ token })` returns an **AsyncIterable** — `await` it for one event, or `for
  await … of` it for many.
- **Token must be deterministic and reconstructable by the resumer.** Derive it from
  `linearSessionId` (which the webhook route also has) so resumes always find the right run.
  Namespace it: `prompt:${linearSessionId}`, `job:${jobId}`. Custom tokens are supported for
  the create-with-token + server-side resume path (the path we use).

### From a route — resume the run
```ts
// app/api/linear/webhook/route.ts (on `prompted`)
await promptHook.resume(`prompt:${linearSessionId}`, { text, signal });

// app/api/mini/callback/route.ts
await jobDoneHook.resume(`job:${jobId}`, payload);
```
- **No active listener for the token → resume throws (404 "Invalid token or validation
  failed").** Handle gracefully (e.g. webhook arrived before the workflow registered the hook,
  or after it completed). See timeout-race + idempotency below.
- **Token conflict** (two runs claim the same token) is observable via `hook.getConflict()`.
  With one run per `linearSessionId` this should not happen; assert it doesn't.
- To check whether a hook for a token is currently registered before resuming (e.g. webhook
  arrived before the hook registered), use **`getHookByToken()`** (CONFIRMED) rather than
  catching a `getRun` miss.
- `⚠️ VERIFY` exact resume error type/shape and whether `resume` is idempotent for a token
  already consumed (treat as: may throw → catch and ignore duplicates).
- Alternative to `defineHook`: the SDK also has **`createWebhook<T>()`** (CONFIRMED) which mints
  a `webhook.url` you hand to an external service; the external POST to that url resolves the
  `await webhook`. Either works; we use `defineHook`+token because our resumers are our own
  routes and we want deterministic tokens derived from `linearSessionId`/`jobId`.

---

## 6. sleep — pause without compute

```ts
await sleep("45m");      // also "3s", "7 days", etc. (duration string)
```
Consumes no resources; the run resumes when the time expires (survives restarts/deploys).

---

## 7. Timeout-race pattern (hook vs sleep) — CONFIRMED supported

**CONFIRMED** (workflow-sdk.dev cookbook → "Timeout on a Webhook"; corroborated by the Vercel
MCP docs which expose `sleep`, `defineHook`+`create({token})`+`for await`, and `resume` as the
building blocks): racing a hook/webhook against `sleep` via `Promise.race` is the **officially
documented** timeout idiom. The canonical example, quoted verbatim from the docs:

```ts
import { sleep, createWebhook } from "workflow";

export async function waitForApproval(requestId: string) {
  "use workflow";
  const webhook = createWebhook<{ approved: boolean }>();
  await sendApprovalRequest(requestId, webhook.url);

  const result = await Promise.race([
    webhook.then((req) => req.json()),
    sleep("7 days").then(() => ({ timedOut: true }) as const),
  ]);

  if ("timedOut" in result) throw new Error("Approval request expired after 7 days");
  return result.approved;
}
```
**Confirmed mechanics:**
- The winner is whichever settles first; **the loser keeps running in the background but its
  result is ignored** (you do not need to manually cancel it).
- Use a **discriminated union** (`"timedOut" in result`) to tell which branch won.
- On completion you may see a log line `Workflow run completed with N uncommitted operations` —
  the docs say this is **expected** when a race leaves a pending branch.

Our `waitForJob` translates directly (using `defineHook` tokens instead of an inline webhook,
which is equally valid — `defineHook`+`create({token})`+server-side `resume` is the documented
deterministic-token path):

```ts
async function waitForJob(jobId: string, linearSessionId: string) {
  "use workflow";   // create hooks in the workflow body (NOT in a step) — CONFIRMED requirement
  using done = jobDoneHook.create({ token: `job:${jobId}` });
  using stop = promptHook.create({ token: `prompt:${linearSessionId}` });

  return await Promise.race([
    (async () => ({ kind: "done"    as const, value: await done }))(),
    (async () => ({ kind: "stopped" as const, value: await stop }))(),
    sleep("45m").then(() => ({ kind: "timeout" as const })),
  ]);   // caller branches: done → finalize, stopped → abort, timeout → Linear error
}
```
Confirmed notes:
- Hooks are **disposable** (`using` / `hook.dispose()` — CONFIRMED), and **must be created in
  the workflow body**, not inside a `"use step"` (CONFIRMED).
- Because the body replays, both hooks are re-created each replay with the same deterministic
  tokens, so a resume that already happened is replayed from the event log rather than re-awaited.
- Remaining `⚠️ VERIFY` (minor): whether racing two `defineHook` awaits + a sleep (three-way)
  behaves identically to the docs' two-way webhook-vs-sleep example. The two-way race is
  documented; the three-way is an extrapolation. If three-way is problematic, nest two two-way
  races (done-vs-timeout, then stop handled via a separate concurrent hook) or use a single hook
  that carries both done and stop payloads.

---

## 8. Replay / idempotency rules (summary)

- Workflow body re-runs on every resume; **step results, sleeps, and hook events are
  memoized** in the event log and not re-executed.
- Therefore make resumes/callbacks **idempotent at the source of truth**, not by relying on the
  hook: dedupe webhooks on `Linear-Delivery`/`webhookId` (Neon insert-or-ignore) BEFORE
  `start`/`resume`; dedupe mini callbacks on `jobId`.
- A duplicate `resume` for an already-consumed token may 404 or be a no-op — catch and ignore.
- One run per AgentSession; the run's event log is the durable history (no separate state
  machine). Phase = where the run is paused.

---

## 9. Skew protection & local dev

- **Skew protection:** runs stay pinned to the deployment they started on, so deploying new
  code does not break in-flight runs. (Confine workflow logic to one file so a redeploy is the
  only moving part — plan §7 risk row 2.)
- **Local dev:** the DevKit runs under `next dev`, so the full webhook→workflow→hook loop is
  testable on the laptop against the mini over Tailscale before deploying (plan §6).
- **Observability:** every step/input/output/sleep/error is recorded; inspect runs in the
  Vercel dashboard → Observability → Workflows.
- **Pre-deploy lint:** `npx vercel-plugin doctor` (CONFIRMED via Vercel docs) validates manifest
  parity and specifically **checks hook timeout risk and dedup health** — run it before deploys
  given how central our hook-timeout race and dedup are.

---

## 10. Spend guard (operational)

Set a Vercel spend budget (~$25) with auto-pause as runaway-loop insurance, and put an
iteration cap on every workflow loop (`MAX_REVISION_ROUNDS`). No polling anywhere by design —
idle cost ≈ zero (steps are short, completion is hook-driven). Pricing is per Events / Data
Written / Data Retained.
