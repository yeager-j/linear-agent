# Linear-Agent Remediation Report

This report consolidates all verified audit findings, deduplicated and re-ranked by the verifiers' adjusted severity. Source dimensions are cited per finding. Final severities reflect verifier adjustments, not finder originals.

A systemic theme threads through SEC-1 and several others: **the entire security model leans on Cloudflare Access at the tunnel edge**, with no fail-closed app-layer auth by default. Two issues compound this (the 0.0.0.0 bind and the absent container isolation), and four lower-severity findings (SEC-5/6/7/8) are explicitly *downstream* of that one assumption — they only become exploitable once the edge gate is bypassed.

---

## SECURITY

### SEC-1 — Mini binds to all interfaces with no fail-closed app-layer auth (Tailscale/LAN bypass of Cloudflare Access → RCE)
**Severity: CRITICAL** · `apps/mini/src/server.ts:73-81, 233-263` · sources: sec-authn
**Problem.** `Bun.serve` sets no `hostname`, so it binds `0.0.0.0` — the same `:3001` the cloudflared tunnel forwards to is simultaneously reachable on Tailscale/LAN. `cfAccessOk()` returns `true` unconditionally when `ENFORCE_CF_ACCESS` is unset (the default; `.env.example` ships `ENFORCE_CF_ACCESS=0`). So in the default config any in-network peer can `POST /jobs {kind:"execute"}`, driving the Agent SDK with `permissionMode:"dontAsk"` + Bash/Write, then committing and opening PRs with `GITHUB_TOKEN`. `/abort` and `/reap` are likewise unauthenticated. The design doc puts the mini on Tailscale, so this is the intended-but-bypassable topology.
**Fix.** Two independent changes, both warranted:
1. **Bind loopback** — `Bun.serve({ hostname: "127.0.0.1", port })`. One line, no downside, mandatory before any deploy. The only path in becomes the co-located cloudflared daemon.
2. **Fail-closed app auth** — see SEC-2 (the fail-open branch is a distinct defect); strongly consider defaulting `ENFORCE_CF_ACCESS=true` or requiring a shared bearer secret on every endpoint independent of the CF flag.
Document the loopback requirement in `setup.md` so the runbook doesn't lead operators into the 0.0.0.0 state.

### SEC-2 — Execute runner has no container isolation; mandated OrbStack sandbox is an unwired no-op
**Severity: CRITICAL** · `apps/mini/src/runners/execute.ts:9-11, 24, 71-93` · sources: sec-injection
**Problem.** When `USE_CONTAINER` is set, `execute.ts` only logs a warning and runs the SDK **in-process on the host** (cwd = worktree) with `permissionMode:"dontAsk"`, allowedTools including Bash/Write/WebFetch, and no `disallowedTools`. The design doc mandates an OrbStack container with an egress allowlist (plan §53, §213). No `docker`/OrbStack invocation exists anywhere in the repo, and the file header comment ("the real `docker run` invocation is written but off by default") is **false**. The execute prompt is built from `prompt_context` — Linear issue text forwarded verbatim and unsanitized (`webhook.ts:68`). A prompt-injected issue can drive arbitrary host commands as the `linearagent` user: read `~/.claude/.credentials.json`, `GITHUB_TOKEN`/`CALLBACK_SECRET`/`LINEAR` token, the SQLite DB, every repo's bare clone, and reach the network freely.
**Fix.** Fail closed:
1. When `useContainer` is true, actually launch inside the OrbStack container with the egress allowlist; if it can't start, **fail the job** — never fall back to local.
2. Until wired, gate the in-process path behind an explicit `DANGEROUS_LOCAL_EXECUTE` flag defaulting off; refuse to start an execute job on the host otherwise.
3. Fix the false header comment at lines 9-11.
4. For the dev-only local fallback, set explicit `disallowedTools` and consider dropping Bash (`dontAsk` + Bash = unrestricted shell).

### SEC-3 — `cfAccessOk` fails OPEN when `ENFORCE_CF_ACCESS=1` but client id/secret are unconfigured
**Severity: MEDIUM** · `apps/mini/src/server.ts:73-81` · sources: sec-authn
**Problem.** A security control explicitly enabled silently degrades to allow-all on a missing-secret misconfiguration (`if (!cfg.cfAccessClientId || !cfg.cfAccessClientSecret) return true`). The comparison also uses plain `===`, not constant-time, unlike the Vercel-side bearer compare. (Primary edge control is CF Access, hence medium not high.)
**Fix.** When `enforceCfAccess` is true but either secret is missing, return `false` and `log.error` (fail closed). Replace the two `===` comparisons with the existing length-check + `crypto.timingSafeEqual` idiom from `apps/vercel/src/lib/auth.ts:11-14` (reuse, no new abstraction). Add a regression test asserting 403 on missing secret.

### SEC-4 — `prompted` webhook resumes a session's promptHook with no ownership check
**Severity: LOW** · `apps/vercel/src/app/api/linear/webhook/route.ts:91-108` · sources: sec-authn
**Problem.** `prompted`/`stop` events take `linearSessionId` straight from the body and resume `promptHook(prompt:<sid>)` with no check the session belongs to this app. HMAC is over a per-integration secret and Linear scopes delivery to this integration, so this is intra-workspace hardening, **not** cross-tenant attack (the finder's "ANY session" framing overstated it). The hook only resumes if this app already created the session, further bounding it. `LINEAR_APP_USER_ID` exists for self/delegate checks but is never read (see ORG-7).
**Fix.** Gate resume on `getSession(linearSessionId)` returning a row this app created; treat unknown sessions as a no-op. Optionally wire `LINEAR_APP_USER_ID` into the parse layer to drop events whose acting app-user isn't this agent.

### SEC-5 — Idempotency key is fully attacker-derivable
**Severity: LOW** · `apps/vercel/src/lib/mini.ts:89-100` · sources: sec-authn
**Problem.** Key is `${linearSessionId}:${kind}:${round}` — all predictable. Combined with unauthenticated `/jobs` (SEC-1), an attacker could pre-insert a job under the key Vercel will use so the legitimate `createJob` returns the attacker's jobId, then control the callback. Correctness-sound for honest retries; gated entirely on SEC-1.
**Fix.** Primary mitigation is SEC-1. Defense-in-depth: in `handleCreateJob`, after a `getJobByIdempotencyKey` hit, verify the stored row's `linear_session_id`/`kind`/`round` match the incoming body before echoing back `existing.job_id`; on mismatch return 409.

### SEC-6 — `/jobs/:id/answer` ignores jobId, resolves purely on global questionId
**Severity: LOW** · `apps/mini/src/server.ts:176-195` · sources: sec-authn
**Problem.** `handleAnswer` names the path param `_jobId` and never uses it; `resolveQuestion` resolves whatever pending entry matches the questionId, ignoring which job/session it belongs to. The path jobId is decorative. Practical exploitability is near-zero (questionId is an unguessable `randomUUID` never exposed to clients), but a wrong-job answer is silently honored.
**Fix.** Pass the path param through and have `resolveQuestion` reject if `p.jobId !== expectedJobId` (return the existing false/no-match signal). The jobId is already stored in `Pending` — no new abstraction. Defense-in-depth, not the primary control.

### SEC-7 — `git clone` interpolates env-only `repoUrl` in an option position
**Severity: INFO** · `apps/mini/src/workspace/index.ts:88` · sources: sec-injection
**Problem.** Bun's `$` escapes shell metacharacters but does **not** prevent a leading-dash value being parsed by git as an option (e.g. `--upload-pack=`). Not exploitable today — `repoUrl` is sourced solely from `DEFAULT_REPO_URL` env. Latent sink if repo selection ever becomes per-issue (`prepareWorkspace` already takes `repoUrl` as a parameter).
**Fix.** Add `--` end-of-options as zero-cost defense: `git clone --bare -- ${repoUrl} ${barePath}`. If repo selection becomes data-driven, also validate against a scheme/allowlist regex.

### SEC-8 — Health-route comment asserts a CF-Access guarantee that doesn't hold
**Severity: INFO** · `apps/vercel/src/app/api/health/route.ts:1-20` · sources: sec-authn
**Problem.** The comment claims the mini `/healthz` call "is gated by the CF-Access service token," but the mini binds `0.0.0.0` (SEC-1) and CF enforcement is off by default, so `/healthz` (exposing `runningJobs`, `maxConcurrentExecutions`, `uptime`) is reachable unauthenticated on Tailscale/LAN.
**Fix.** Correct the comment to state `/healthz` output is effectively public; keep it low-sensitivity. The real remediation is SEC-1's loopback bind, after which the assumption holds and the comment can be restored.

---

## CORRECTNESS BUGS

### BUG-1 — Webhook marked deduped *before* the workflow starts; a transient `start()` failure permanently drops the session
**Severity: HIGH** · `apps/vercel/src/app/api/linear/webhook/route.ts:59-116` · sources: sec-authn
**Problem.** `claimDelivery` durably commits the dedupe row on first receipt, *before* `start(sessionWorkflow)` + `insertSession` run. If `start()` throws, the catch returns 500 so Linear retries — but the retry now sees the claimed row and returns `{deduped:true}` without ever starting the workflow. The session acks a thought then never acts. There is no workflow-side idempotency backstop because `start()` itself is what failed, and no reconcile/recovery path exists on the Vercel side. (The `start()`-fails case is the severe one; an `insertSession`-only failure is currently benign since the `sessions` row is unread — see ORG-3.)
**Fix.** In the catch block, before returning 500, `DELETE FROM webhook_deliveries WHERE delivery_id = $1` for the row this request claimed (track the `fresh` boolean), so Linear's retry re-processes. Add a `releaseDelivery(deliveryId)` helper. Alternatively add run-level idempotency via a deterministic session-scoped hook token + `getConflict()`, but the catch-block rollback fully closes the data-loss hole and is smaller.

### BUG-2 — Early terminal callback (before `jobDoneHook` is registered) is silently dropped → 45-min wedge + spurious timeout
**Severity: HIGH** · `apps/vercel/src/app/api/mini/callback/route.ts:55-64` · sources: bugs
**Problem.** The callback route treats *every* `HookNotFoundError` as a 200 no-op. But not-found has two causes: a true duplicate (correctly a no-op) and the **first** callback arriving before the workflow registered `jobDoneHook` (`start()` returns before hooks register; the hook is created inside `waitForJob`, after the `startMiniJob` step returns). A fast job — DRY_RUN, or synchronous early-returns like "no repo configured (DEFAULT_REPO_URL unset)" / "cannot parse owner/repo" — fires the callback within milliseconds, beating registration. The 200 makes the mini delete its outbox entry and stop retrying; the workflow waits until `JOB_TIMEOUT` (45m) then reports a *wrong* timeout error. The `/api/mini/question` route already handles this exact race with a retryable 503 — the asymmetry is the bug.
**Fix.** Mirror the question route: return a **503** on `HookNotFoundError` so the mini's bounded backoff replays until the hook registers. The mini's retries are bounded (MAX_ATTEMPTS=12), so even a permanent not-found self-resolves; worst case is wasted retries vs. today's 45-min wedge. The more surgical alternative is to register `jobDoneHook` with its deterministic token *before* the `startMiniJob` step returns.

### BUG-3 — Non-stop `prompted` reply arriving mid-run is silently consumed and discarded
**Severity: MEDIUM** · `apps/vercel/src/workflows/session.ts:266-275` · sources: bugs
**Problem.** `waitForJob`'s stop branch (active on every plan/revise/execute phase) drains the `promptHook` iterator, returning only on `signal==="stop"` and dropping non-stop values. A user reply sent while a job runs (added context, course-correction, or even an early "approve") resumes the hook, is found non-stop, and is thrown away with no log or emit. The webhook returns `resumed:true`, so the user sees success but their text is lost; when the approval loop later creates a fresh hook, the earlier message is gone.
**Fix.** Keep the drain (it correctly wins the stop race), but make the drop observable: in the drain branch, `console.warn` the dropped text and emit a Linear thought ("I'm still working on the current step — I saw your message but can't act on it until this finishes; please re-send once I post the plan"). A fuller buffer-and-replay is a reasonable optional follow-up. Do **not** feed the value to the running job or treat it as stop.

### BUG-4 — Two distinct `created` deliveries for the same session spawn duplicate runs + HookConflictError
**Severity: MEDIUM** · `apps/vercel/src/app/api/linear/webhook/route.ts:82-88` · sources: bugs
**Problem.** The `created` handler calls `start()` with no idempotency key. Delivery-id dedupe stops the *same* delivery twice, not two *different* deliveries naming the same `linearSessionId` (Linear re-delivery with a new id, or re-delegation). Each calls `start()`, producing two concurrent runs. Both create hooks on `prompt:<sid>` (and, because the jobId is deterministic, also `job:<jobId>`/`question:<jobId>`); the second run hits `HookConflictError` at the first `waitForJob` race. `insertSession` is `ON CONFLICT DO NOTHING`, so the row points at the first runId while a second orphan run exists. (Only manifests while both runs are concurrently active.) The SDK docs prescribe a `getHookByToken` pre-check plus an in-body `getConflict()` guard — neither exists.
**Fix.** (1) In the `created` handler, advisory pre-check: `getSession(linearSessionId)`; if present, return a no-op/resume. (2) Because pre-check and `start()` aren't atomic, also guard inside `sessionWorkflow`: create the per-session `promptHook` near the top and `if (await promptHook.getConflict()) return;` so the losing run of a genuine race exits cleanly instead of crashing.

### BUG-5 — Webhook dedupe skipped when no delivery id is derivable
**Severity: LOW** · `apps/vercel/src/app/api/linear/webhook/route.ts:57-63` · sources: sec-dos
**Problem.** When `getDeliveryId` returns null (no `Linear-Delivery` header *and* no `webhookId`), the route skips `claimDelivery` and processes unconditionally. For `created` that means two undedupable deliveries each `start()` a fresh run → duplicate workflows/mini-jobs/PRs + an orphan (the second `insertSession` is a no-op). HMAC blocks crafted replays, so the only realistic trigger is genuine envelope-shape drift — low probability. The comment "workflow-side idempotency is the backstop" is not actually backed by anything on `created`.
**Fix.** In the `created` branch only, add a session-level guard before `start()`: `getSession(linearSessionId)`; if a row with a `workflowRunId` exists, short-circuit `{deduped:true}`. Do **not** reject events with no delivery id (would drop legitimate deliveries during the drift the code is deliberately tolerant of). Also fix the misleading comment. *(Note: BUG-5's fix and BUG-4's pre-check are the same `getSession`-before-`start()` guard — implement once.)*

### BUG-6 — Idempotent `/jobs` hit for a finished job never re-fires the callback → workflow hangs
**Severity: LOW** · `apps/mini/src/server.ts:112-118` · sources: bugs
**Problem.** On an idempotency-key hit for an already-terminal job, `handleCreateJob` returns `{jobId, queued:false}` but does not re-fire the terminal callback. If the create step is retried (first response lost) *and* the original callback was lost/early-dropped, the workflow waits on `jobDoneHook` for a callback that never comes again — 45-min hang. Fails closed after the backstop with a (wrong) timeout error; recoverable by re-delegating.
**Fix.** On an idempotent hit where `existing.status` is terminal, reconstruct the terminal `MiniCallback` from the persisted job row and re-deliver (re-upsert to outbox + `attemptDelivery`, the same primitives `reconcile.ts` uses). Makes create+callback idempotent end-to-end. Low priority given the backstop.

### BUG-7 — `linearSessionId` path sanitizer permits `.`/`..` → worktree can resolve to `WORK_ROOT` and `rm -rf` it
**Severity: LOW** · `apps/mini/src/workspace/index.ts:71-80, 142-147, 178-189` · sources: sec-injection
**Problem.** `sessionDir` replaces only chars outside `[a-zA-Z0-9_.-]`, so a `linearSessionId` of exactly `.` or `..` survives; `join(WORK_ROOT, "worktrees", "..") === WORK_ROOT`, which then reaches destructive `rm(...,{recursive:true,force:true})`. (Only `.`/`..` are dangerous — `/` is replaced, so `../../etc` → harmless `..-..-etc`.) Not exploitable today: id is an HMAC-gated, CF-Access-gated, Linear-issued UUID. Latent catastrophic data-loss hazard.
**Fix.** Per CLAUDE.md rule 8 (don't rely on safety-by-accident): after char replacement, throw if the result is `.`, `..`, or empty. Belt-and-suspenders: in `paths()`, assert `path.resolve(worktreePath).startsWith(path.resolve(join(root,"worktrees")) + sep)` before any mkdir/rm/worktree op. Optionally tighten the contract regex.

### BUG-8 — PR opened but terminal callback dropped → orphan PR with workflow reporting timeout
**Severity: LOW** · `apps/mini/src/callback.ts:83-90` · sources: bugs
**Problem.** After MAX_ATTEMPTS (12), `attemptDelivery` permanently deletes the callback. For a succeeded execute the PR is already pushed/opened, but Vercel never learns; the workflow hits `JOB_TIMEOUT` and tells the user it timed out while a live PR sits open. The drop log carries only `{jobId, attempts}` — no `prUrl`, so the orphan is undiscoverable. The result *is* durably retained in the jobs table (status `done`, `pr_url`), so this is an observability/signal gap, not corruption. Requires ~25+ min of sustained callback outage.
**Fix.** Minimal (do this): in the MAX_ATTEMPTS branch, parse the dropped payload and include `prUrl`/`branch`/`status` in the error log. Optional: mark the outbox row dead-lettered (status column instead of DELETE) for manual/boot re-delivery. Avoid building a workflow-queries-mini-on-timeout path — premature for a rare backstop.

---

## CODE ORGANIZATION

### ORG-1 — `db_getCallback` duplicates the exported `getCallback` with a false justifying comment
**Severity: MEDIUM** · `apps/mini/src/callback.ts:93-100` · sources: org-mini, **style** (dup)
**Problem.** `db.ts:211` already exports `getCallback(d, jobId)` taking the db explicitly; `callback.ts` reimplements the byte-identical SQL as privately-named `db_getCallback` with the comment "Local import shim so tests can pass a db without the singleton" — which is false (the real fn already takes a db arg). Duplicated SQL string + re-declared `CallbackRow` via inline `import()` + a misleading `db_` name. `getCallback` is already used by the test files, making the reimplementation gratuitous. Violates CLAUDE.md #2/#3/#4. (Two reporters; verifiers split medium/low — both note zero behavioral divergence. Final: medium given it's a clean delete with a false comment.)
**Fix.** Delete `db_getCallback` and its comment; add `getCallback` to the existing `./db.ts` import on line 11; call `getCallback(d, jobId)` at line 44.

### ORG-2 — Three near-identical terminal-handling blocks in `sessionWorkflow`
**Severity: LOW** · `apps/vercel/src/workflows/session.ts:400-417, 452-469, 478-494` · sources: org-vercel
**Problem.** Plan/revise/execute each repeat the same stop→abort→ABORT_GRACE→finalizeStop / timeout→finalizeError / non-succeeded→finalizeError / capture-claudeSessionId sequence (~48 lines). No active defect, but the abort-grace ordering is flagged as previously buggy, so three hand-synced copies invite silent drift. (Extraction is determinism-safe and matches existing body-helper style; medium overstated since code is correct today.)
**Fix.** Extract a single body-level `settleJob(outcome, { jobId, linearSessionId, statusPhase, timeoutMessage })` returning `{kind:"continue"; done} | {kind:"returned"}`, kept in `session.ts`. **Pass `timeoutMessage` explicitly** — the execute phase's timeout message genuinely differs ("Check the mini's logs" vs "Please try again"), so it must not be derived from the phase noun. Abort is uniform across all three, so it's not a parameter. Low priority.

### ORG-3 — `getSession` (and the stored `workflow_run_id`) is dead read-side surface
**Severity: LOW** · `apps/vercel/src/lib/db.ts:38-64` · sources: org-vercel
**Problem.** `getSession` is referenced only in `db.test.ts`; no production caller. All resume paths are token-based. The `sessions` table is write-only in production. (Note: SEC-4/BUG-4/BUG-5 fixes propose *introducing* `getSession` callers — coordinate; if those land, `getSession` becomes live and this finding is moot.)
**Fix.** If the SEC-4/BUG-4/BUG-5 ownership/dedupe guards are adopted, `getSession` gains real callers — keep it. Otherwise delete `getSession` and its two tests. Leave `insertSession` and the columns: the `linearSessionId → workflowRunId` map is documented design intent and cheap for ops/debugging. Dropping the *write* path is a separate author decision (rule 8).

### ORG-4 — `issueId` plumbed through three signatures only to hit `void issueId`
**Severity: LOW** · `apps/vercel/src/workflows/session.ts:249, 313, 334, 339, 354, 373` · sources: org-vercel, **style** (dup)
**Problem.** `issueId` threads `waitForJob.opts → askQuestionsViaLinear → waitForPromptWithSweeper`, where its only use is `void issueId; // reserved for richer reap behavior`. Dead plumbing for a non-existent feature (CLAUDE.md #4). The top-level `syncStatusStep`/workflow-body uses of `issueId` are legitimate and untouched.
**Fix.** Drop `issueId` from `waitForPromptWithSweeper` (and the `void` line), `askQuestionsViaLinear`, and `waitForJob.opts`; update call sites. Re-add in the ticket that implements richer reap behavior.

### ORG-5 — Route table declared twice in `server.ts` (regex dispatcher vs Bun.serve routes)
**Severity: LOW** · `apps/mini/src/server.ts:209-253` · sources: org-mini
**Problem.** The five endpoints are expressed both in `fetchHandler()` (hand-written method+regex matching, used by tests via `app.fetch`) and in `Bun.serve({ routes })` (production). Adding/changing an endpoint in one but not the other compiles and may pass tests yet 404 in prod. The `decodeURIComponent` vs `req.params.id` divergence is behaviorally inert today. Small surface (5 routes), co-located, with an explanatory comment — medium overstated.
**Fix.** Collapse to one routes table consumed by both `Bun.serve` and the test entrypoint, so an endpoint is declared once. **Do not** simply delete `fetchHandler` — `server.test.ts` deliberately asserts the regex routing ("not matched by abort regex", "distinct from /abort"); re-point those at the shared router. Acceptable to defer as tech-debt given the small surface.

### ORG-6 — `env.ts` mixes env accessors with workflow business constants
**Severity: LOW** · `apps/vercel/src/lib/env.ts:18-59` · sources: org-vercel
**Problem.** The file's stated job is env-var access, but lines 38-59 bolt on non-env constants (`MAX_REVISION_ROUNDS`, `MAX_QUESTION_ROUNDS`, `JOB_TIMEOUT`, sweeper schedule, `ABORT_GRACE`, `WEBHOOK_MAX_AGE_MS`). `session.ts` imports these from `@/lib/env`, which reads oddly. Single-responsibility smell (#2).
**Fix.** Move the timing/loop constants (including `WEBHOOK_MAX_AGE_MS` — it's replay-protection policy) into a flat `apps/vercel/src/lib/limits.ts`. `LINEAR_GRAPHQL_URL` may stay (pinned endpoint). Keep it a plain exported-const file — **no** config class/loader (#4). Low priority, non-blocking.

### ORG-7 — `linearAppUserId` accessor defined but never read
**Severity: INFO** · `apps/vercel/src/lib/env.ts:22-23` · sources: org-vercel
**Problem.** Documented-but-unimplemented self/delegate seam. The accessor has an explanatory comment signaling intent, so the "reader can't tell" framing is partly overstated. The actionable gap is the *absence of the self/delegate guard itself* (related to SEC-4).
**Fix.** Leave the accessor (matches the contract). Confirm with the author whether self/delegate filtering is intentionally deferred; if required before GA, file a distinct functional ticket against the webhook route.

### ORG-8 — Dead `export { readdir }` re-export
**Severity: LOW** · `apps/mini/src/workspace/index.ts:222-223` · sources: org-mini
**Problem.** `readdir` is imported on line 13 only to be re-exported ("so callers don't reach into node:fs"); no caller imports it and it's unused inside the file. Dead cruft (#8).
**Fix.** Delete line 223 and drop `readdir` from the line 13 import. Keep `mkdir`/`rm` (still used).

### ORG-9 — Duplicated ack-thought string literal across webhook route and workflow body
**Severity: INFO** · `apps/vercel/src/app/api/linear/webhook/route.ts:72-74` · sources: org-vercel
**Problem.** `Looking into ${identifier}…` is copy-pasted at `route.ts:72` and `session.ts:389`. Deliberate double-emit (fast ack + durable re-ack), not a bug.
**Fix.** Leave as-is by default. The two literals live in genuinely different layers and a shared `lib/linear.ts` helper would add cross-file coupling for negligible benefit (#4). Only act if the copy is expected to change, and then prefer a local constant.

---

## TEST COVERAGE

### TEST-1 — `sessionWorkflow` / `waitForJob` race state machine has zero test coverage
**Severity: MEDIUM** · `apps/vercel/src/workflows/session.ts:246-320` · sources: tests, **style** (dup — same finding reported twice)
**Problem.** The repo's most intricate code — a four-branch `Promise.race` over durable hooks with hand-rolled iterator hoisting and disposal-timing semantics whose comments document **two distinct bugs already hit and fixed** (the `using`-disposal bug, the B1 rapid-second-question buffering bug) — has no `session.test.ts`. The only test touching the module mocks it out entirely. This is exactly the regression-prone code CLAUDE.md #7 says tests exist to protect. (High overstated: the leaf primitives — intent, questions, mini transport, callback/question routes — *are* unit-tested; what's uncovered is the orchestration control flow. Not a live bug. → medium.)
**Fix.** Prioritize the cheap half: extract the runtime-independent decision logic (round-cap predicates, status→finalize mapping, `toPromptResult`, the answers-map assembly) into pure exported functions and unit-test the boundaries. Treat the full workflow-level harness (fake hooks/sleep asserting stop→abort→ABORT_GRACE, JOB_TIMEOUT, multi-question budget) as a separate optional follow-up — the workflow devkit ships no test harness, so it needs a bespoke scaffold; don't let its cost block the pure-function tests. Don't extract into awkward shapes purely for testability (#4).

### TEST-2 — JobController plan-class cap and self-starting `drainQueue` are untested
**Severity: MEDIUM** · `apps/mini/src/jobctl.ts:61-79, 139-146` · sources: tests
**Problem.** Two independent caps exist (`maxConcurrentExecutions`, `maxConcurrentPlans`) plus a self-starting queue. Tests cover only the execute cap. Untested: plan/revise queueing over `maxConcurrentPlans`, the `drainQueue→start→callback` self-start chain, and independent caps (an over-cap execute not blocking a plan). A regression in slot accounting (e.g. decrementing the wrong counter in the `finally`) would let a cap be violated or wedge the queue while the suite stays green. The `manualRunner` helper already provides the needed seam.
**Fix.** Add three tests using `manualRunner`: (1) two plan jobs with `maxConcurrentPlans:1` → second `queued:true`; (2) finish the first, await the finally chain, assert the queued job flips to running and fires its callback (drives `drainQueue`); (3) saturate execute slot with `maxConcurrentExecutions:1` + `maxConcurrentPlans:1`, submit a plan, assert it starts (independent caps + correct counter decrement).

### TEST-3 — Callback route: parse-before-version ordering and non-HookNotFound→500 untested
**Severity: LOW** · `apps/vercel/src/app/api/mini/callback/route.test.ts:47-83` · sources: tests
**Problem.** Two branches uncovered: (1) non-JSON body → `request.json()` catch → 400 "invalid json" (the existing "malformed body" test sends valid JSON failing zod, a different branch); (2) **the 500 path** — a generic `resumeHook` rejection that is *not* `HookNotFoundError`. The 500 branch is the material one: a regression misclassifying a real failure as the idempotent no-op would silently ack a stuck workflow (the session never resumes — effective data loss).
**Fix.** Add `resumeHook.mockRejectedValue(new Error("db down"))` → assert 500 (priority); and a Request with a non-JSON string body (bypassing the `JSON.stringify`-based helper) → assert 400. Both reuse existing patterns.

### TEST-4 — `bearerOk` has no direct adversarial test
**Severity: LOW** · `apps/vercel/src/lib/auth.ts:7-15` · sources: tests
**Problem.** The only auth gate on the callback/question routes has no `auth.test.ts`. **Correction to the finding:** the load-bearing length guard is *already* effectively regression-covered — the existing `Bearer wrong` test sends a 5-byte token vs the 19-byte secret through an auth check outside any try/catch, so removing the guard would throw and flip those 401 assertions. The only genuinely uncovered branch is the no-`Bearer `-prefix early return.
**Fix.** Optional, low priority. If adding `auth.test.ts`: `bearerOk(null)===false`, `bearerOk('rawtoken')===false` (the one truly untested branch), `bearerOk('Bearer '+secret)===true`, `bearerOk('Bearer '+secret.slice(0,-1))===false`. Frame as branch-coverage completion, **not** closing a security hole.

### TEST-5 — Webhook route: missing-signature header and no-deliveryId paths untested
**Severity: LOW** · `apps/vercel/src/app/api/linear/webhook/route.test.ts:82-86` · sources: tests
**Problem.** (1) The only 401 test sends a present-but-wrong sig (`deadbeef`); the `!header` early-return branch of `verifyLinearSignature` is never hit (and `makeRequest` can't even build a header-less request). (2) The undedupable path — created event with no `Linear-Delivery` header and no `webhookId` — is never tested, so a regression flipping `if (deliveryId)` to drop such events would silently lose authentic webhooks. The deliveryId-skip branch (2) is the substantive gap; (1) is marginal (the 401 contract is already covered).
**Fix.** Extend `makeRequest` to allow omitting the signature header. Add: (a) no-signature → 401, `start` not called; (b) created event with no delivery header + no `webhookId` → `claimDelivery` NOT called, `start()` called once (proves the workflow-side-idempotency backstop). Low priority.

### TEST-6 — Boot reconciliation: claudeSessionId pass-through (and multi-job loop) untested
**Severity: LOW** · `apps/mini/src/reconcile.test.ts:13-49` · sources: tests
**Problem.** **Correction to the finding:** its headline claim that `flushDueCallbacks` is untested is *false* — it's thoroughly covered in `callback.test.ts`. The genuine gap is narrow: `reconcile.test.ts` inserts jobs without `claude_session_id`, so the `claudeSessionId` pass-through on the interrupt callback (crash-continuity) is never asserted; the multi-job loop runs only once.
**Fix.** Add one test: insert a running job *with* a `claude_session_id`, assert the fired interrupt callback carries that exact value. Optionally a thin `reconcileOnBoot → flushDueCallbacks` wiring test. **Do not** re-test flush delivery mechanics (already covered in `callback.test.ts` — would be redundant).

### TEST-7 — Intent classifier: orphaned second APPROVE_PATTERN untested
**Severity: LOW** · `apps/vercel/src/lib/intent.ts:19-37` · sources: tests
**Problem.** The second approve regex (`(go|proceed)…(ahead|for it)`) is never exercised — "go ahead" matches the first pattern and `.some()` short-circuits, and "go for it"/"for it" appears nowhere in tests. Verified by mutation: deleting the pattern leaves all tests green. The `selectValue:''` and minimal-pair sub-claims are already effectively covered (low value).
**Fix.** Add `classifyIntent({text:"go for it"}) === "approve"` (the only assertion that closes a real branch). Treat the empty-string and precedence-pair additions as optional clarity assertions.

### TEST-8 — Contract tests re-test zod locally but never prove cross-app wire compatibility
**Severity: LOW** · `apps/mini/src/contract.test.ts:1-145` · sources: tests
**Problem.** Both apps unit-test the same shared schema in isolation; no producer-output→consumer-schema round-trip. **Corrections:** the "vendored copy divergence" worry is structurally prevented (both apps `workspace:*`-link the same module, so they share object identity), making a `CONTRACT_VERSION ===` assertion **tautological** — don't add it. The producer side is already partially covered by `mini.test.ts`.
**Fix.** Low-priority nice-to-have, fine to defer. If anything: one producer→consumer round-trip (the body the mini client serializes parsed against the mini's `CreateJobRequest`, and a mini callback parsed against `MiniCallback`). Skip the version-identity assertion (#4 redundancy).

### TEST-9 — Misleading comment in `question-handler.test.ts`
**Severity: INFO** · `apps/mini/src/runners/question-handler.test.ts:94-96` · sources: tests
**Problem.** Comment says "never resolved; left registered" but the catch path explicitly calls `resolveQuestion(questionId, {})`, which *removes* the entry — the count is 0 because it was deleted, not left. A reader could "fix" a non-bug (#3).
**Fix.** Correct or drop the parenthetical: the count is 0 because the catch path calls `resolveQuestion` to drop the orphaned entry. Don't change the assertion.

---

## STYLE (CLAUDE.md)

*(STY findings that duplicated correctness/org/test findings — ORG-1, ORG-4, TEST-1 — are merged above with cross-cited sources and not repeated here.)*

### STY-1 — TODO on container isolation silently degrades instead of failing loud
**Severity: LOW** · `apps/mini/src/runners/execute.ts:71-77` · sources: style
**Problem.** This is the style/rule-8 facet of SEC-2. Setting `USE_CONTAINER=1` (which implies sandboxed/egress-restricted execution) yields full in-process host execution with only a `log.warn` — a TODO masking a security gap (#8), worsened by the false "docker run is written" header comment.
**Fix.** Covered by SEC-2 (fail closed / gate out the flag / fix the header comment). Track the real isolation work as a tech-debt ticket, not a code comment.

### STY-2 — `params as never` cast in `updateJob`
**Severity: LOW** · `apps/mini/src/db.ts:165-172` · sources: style
**Problem.** `updateJob` builds a dynamic param map and casts `.run(params as never)` — the most aggressive escape hatch, silencing all type checking (a future non-binding field type would compile). Every other `.run()` in the file type-checks without a cast. Rule 8 names this pattern explicitly. (Harmless at runtime today — all JobRow fields are valid bindings.)
**Fix.** Type the statement against the real binding type: declare `params` as `Record<string, SQLQueryBindings>` (import `SQLQueryBindings` from `bun:sqlite`) and/or `d.query<void, Record<string, SQLQueryBindings>>(...)`. The values already satisfy the union, so no cast is needed. Never cast to `never`.

### STY-3 — `as unknown as SDKLikeMessage` double-cast in `sdk.ts`
**Severity: LOW** · `apps/mini/src/sdk.ts:56-57` · sources: style
**Problem.** `yield msg as unknown as SDKLikeMessage` — the `as unknown as X` form rule 8 names specifically. The `unknown` middle step erases the structural-overlap check this seam exists to guarantee.
**Fix.** Drop the `unknown`: `yield msg as SDKLikeMessage`. Verified to compile against the current SDK and to still emit TS2352 if the SDK shape drifts out of overlap. **Do not** yield `msg` directly (the finder's primary suggestion) — that fails TS2322 because `SDKUserMessage.message.content` is `string | ContentBlockParam[]`. For zero casts, a small typed adapter projecting the known fields is the alternative.

---

## RECOMMENDED FIX ORDER

Highest-leverage first. ⚠ = confirm with the user before changing (behavior change / touches intended security model / broad refactor).

1. **SEC-1 loopback bind** (`hostname:"127.0.0.1"`) — one line, no downside, closes the critical RCE path. Mandatory before any deploy.
2. **SEC-2 ⚠ fail-closed execute** — refuse host execution when `USE_CONTAINER` is set; gate the local path behind `DANGEROUS_LOCAL_EXECUTE`; fix the false header comment. *Confirm the intended deployment model and whether a dev-only local mode is acceptable.*
3. **BUG-2 callback 503-on-HookNotFound** — mirrors the existing question route; eliminates the 45-min wedge + spurious timeout. Small, precedented.
4. **BUG-1 release dedupe row on `start()` failure** — closes silent permanent session loss. Small catch-block change.
5. **SEC-3 fail-closed `cfAccessOk` + constant-time compare** — a security toggle must not silently disable itself.
6. **BUG-4 + BUG-5 ⚠ `getSession`-before-`start()` guard** (one change) + in-workflow `getConflict()` — stops duplicate runs / HookConflictError. *The `getConflict()` strategy is reject-the-duplicate; confirm that's the desired semantics vs. converge-on-active-run.* This also revives `getSession` (resolves ORG-3).
7. **ORG-1 delete `db_getCallback`** — trivial, removes duplicated SQL + false comment.
8. **STY-2 / STY-3 remove `as never` / `as unknown as`** — small type-hygiene fixes, rule-8 escape hatches.
9. **ORG-8 delete dead `readdir` re-export; TEST-9 / ORG-9 comment fixes** — trivial cleanups.
10. **BUG-3 ⚠ surface dropped mid-run replies** — log + emit a Linear thought. *The user-facing thought is a behavior change; confirm wording/UX.*
11. **TEST-2 JobController cap/drain tests; TEST-3 callback 500 test** — guard the concurrency model and the auth/idempotency classification (TEST-3 pairs naturally with BUG-2).
12. **SEC-4 / SEC-5 / SEC-6 defense-in-depth** — ownership gate on resume (SEC-4 overlaps the BUG-4 `getSession` work), idempotency-field match (SEC-5), jobId binding on `/answer` (SEC-6). All gated on SEC-1; bundle as one DiD pass.
13. **BUG-7 path sanitizer hardening; SEC-7 `git clone --`** — cheap latent-hazard fixes.
14. **BUG-6 / BUG-8 callback robustness** — re-fire on idempotent terminal hit; log `prUrl` on drop.
15. **TEST-1 ⚠ extract + unit-test workflow decision logic** — high value but requires extraction; *confirm the extraction shape so it doesn't become premature abstraction.* The full workflow harness is a separate follow-up.
16. **ORG-2 ⚠ / ORG-5 ⚠ / ORG-6 refactors** — `settleJob` extraction, single route table, `limits.ts` split. *Each is a judgment-call refactor (rule 4 tension); confirm before doing, or defer as tech-debt.*
17. **Remaining low/info polish** — TEST-4/5/6/7/8, SEC-8, ORG-3 (delete path only), ORG-7, STY-1 (covered by SEC-2). Batch opportunistically.

---

## COMPLETENESS CHECK

- **Systemic theme — auth model leans entirely on Cloudflare Access.** SEC-1, SEC-3, SEC-5, SEC-6, SEC-8 all trace to the single decision that the tunnel edge is the only gate, with the mini fail-open by default and bound to all interfaces. Fixing SEC-1 (loopback) + SEC-3 (fail-closed) collapses most of the SEC tail. This is worth an explicit author decision: is CF Access *intended* to be the sole control, or should the mini always require its own bearer secret? The whole SEC cluster pivots on that answer.
- **Systemic theme — `start()`-returns-before-hooks-register race.** BUG-1, BUG-2, BUG-4, BUG-6 are four faces of the same Workflow-SDK timing property. The codebase already handles it correctly in two places (the question route's 503, `resumePromptWithRetry`) but not the others. A single coherent pass on "hook registration vs. external events" would close all four.
- **Under-examined / clean areas.** The `packages/contract` schemas were examined for caps/strictness (the SEC-DOS cluster) and found mostly fine — the only genuine gap was uncapped AskUserQuestion arrays (folded into the broader DoS discussion; the `.strict()` and branch/refspec concerns were correctly rejected as inert). The `github/pr.ts` push path was checked for injection and is safe (branch always `agent/`-prefixed). The signature-verification test coverage was challenged and found *adequate* (the tampered-body test already exercises the `timingSafeEqual` false branch — a raised finding was rejected). The Bun `$` shell-escaping was verified safe everywhere except the one option-position case (SEC-7).
- **Not independently audited here (flag for the user).** Live deployment posture: the ops files (`cloudflared-config.yml`, plist, `setup.md`) are STUB/TEMPLATE, so SEC-1/SEC-2 are pre-ship criticals rather than confirmed-live exploits — but the runbook leads operators straight into the vulnerable state. Resource-exhaustion findings (unbounded queue, no SDK/git timeouts, table growth) were surfaced by the DoS dimension but several were rejected or downgraded as single-tenant-appliance operational concerns; if the deployment model ever becomes multi-tenant, those need re-rating. The unbounded `/jobs` queue and missing SDK/git timeouts (raised at medium in the DoS dimension) are real operational gaps not enumerated above because they sit at the appliance-robustness tier rather than correctness/security — worth a follow-up tech-debt ticket.
