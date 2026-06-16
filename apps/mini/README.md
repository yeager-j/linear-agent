# linear-agent-mini

The **execution appliance** in the Linear × Claude Code agent system (Plan B — Vercel hybrid).
A plain Bun service. Vercel owns the durable state machine (workflow + hooks); this box is a
dumb runner that:

- accepts plan / revise / execute jobs over a tiny HTTP API,
- runs the **Claude Agent SDK** in per-session git worktrees (plan mode → execute mode → PR),
- streams `thought` / `action` / plan-checklist activities **directly to Linear** during runs,
- reports only **terminal** status back to Vercel via an authenticated callback.

The seam between the two deployables is defined in `../shared/integration-contract.md` and
copied verbatim into [`src/contract.ts`](src/contract.ts). `CONTRACT_VERSION` ships in code.

## Architecture

```
Vercel ──(Cloudflare Access service token)──► Mini  POST /jobs, /jobs/:id/abort, GET /healthz
Mini   ──(Authorization: Bearer CALLBACK_SECRET)──► Vercel  POST /api/mini/callback
Mini   ──(LINEAR_ACCESS_TOKEN)──► Linear  agentActivityCreate / agentSessionUpdate (streaming)
```

### Source map
| File | Role |
|---|---|
| `src/contract.ts` | THE SEAM — verbatim zod schemas + `CONTRACT_VERSION` + hook tokens |
| `src/config.ts` | env-driven config (Bun auto-loads `.env`), dry-run/gating flags |
| `src/db.ts` | `bun:sqlite` — `jobs`, `workspaces`, `callbacks` (outbox) tables |
| `src/server.ts` | `Bun.serve` routes: `/jobs`, `/jobs/reap`, `/jobs/:id/abort`, `/jobs/:id/answer`, `/healthz` |
| `src/jobctl.ts` | in-memory registry: AbortControllers, concurrency cap + self-starting queue |
| `src/callback.ts` | terminal callback to Vercel with retry/backoff + persistent outbox |
| `src/reconcile.ts` | boot reconciliation: stuck `running` → `failed`/`"interrupted"` callback |
| `src/linear.ts` | the ONE Linear GraphQL module (defensive against preview-API drift) |
| `src/activity-bridge.ts` | SDK message stream → Linear thought/action/plan, throttle + heartbeat |
| `src/sdk.ts` | thin seam over `@anthropic-ai/claude-agent-sdk` `query()` (incl. `canUseTool`) |
| `src/questions.ts` | pending-question registry for mid-run AskUserQuestion HITL |
| `src/question-client.ts` | `sendQuestion` → Vercel `POST /api/mini/question` (bearer, retry, fatal 409) |
| `src/runners/question-handler.ts` | builds the `canUseTool` handler (AskUserQuestion → ask Vercel → resume) |
| `src/runners/plan.ts` | plan / revise runs (`permissionMode: "plan"`, revise resumes the session) |
| `src/runners/execute.ts` | execute run (`permissionMode: "dontAsk"` + allowlist) → commit → PR |
| `src/workspace/` | bare clones + per-session worktrees, fetch mutex, prune/gc |
| `src/github/pr.ts` | push branch + open PR with a repo-scoped PAT |
| `container/`, `ops/` | Dockerfile, launchd plist, cloudflared config, setup runbook (stubs) |

## Run

```bash
bun install

# Smoke test with no external infra — fake jobs flow start -> callback:
DRY_RUN=1 bun index.ts
curl localhost:3001/healthz

# Real run (needs .env, see below):
bun index.ts
```

## Test

```bash
bun test          # hermetic — all external calls (Linear, Vercel, SDK, git push) are mocked/dry-run
bunx tsc --noEmit # typecheck
```

## Environment

Bun auto-loads `.env` (mode `0600`). Do **not** set `ANTHROPIC_API_KEY` — the Agent SDK falls
back to the dedicated user's Claude subscription login (see `ops/setup.md`).

| Var | Use |
|---|---|
| `LINEAR_ACCESS_TOKEN` | stream activities + plan array directly to Linear |
| `GITHUB_TOKEN` | push + open PR (repo-scoped PAT) |
| `VERCEL_CALLBACK_URL` | `https://your-app.vercel.app/api/mini/callback` |
| `CALLBACK_SECRET` | bearer presented on the callback (must match Vercel) |
| `MAX_CONCURRENT_EXECUTIONS` | local execute concurrency cap (default 2) |
| `MAX_CONCURRENT_PLANS` | local plan/revise concurrency cap (default 3) |
| `WORK_ROOT` | base dir for bare clones + worktrees |
| `DEFAULT_REPO_URL` | repo to clone/worktree for a session (label-based routing is later) |
| `PR_BASE_BRANCH` | base branch for worktrees + PRs (default `main`) |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | optional defense-in-depth (`ENFORCE_CF_ACCESS=1`) |
| `PORT` | HTTP port (default 3001) |

### Gating / dry-run flags (default off)
| Flag | Effect |
|---|---|
| `DRY_RUN` | skip the SDK entirely; run a fast fake job (seam smoke test) |
| `LINEAR_DRY_RUN` | log Linear calls instead of POSTing |
| `PR_DRY_RUN` | synthesize a PR url/branch instead of pushing |
| `USE_CONTAINER` | (stub) intended OrbStack containerized execution |

## Contract invariants this service holds
- `POST /jobs` is idempotent on `idempotencyKey` — a retry returns the **same** `jobId`.
- `POST /jobs/reap` removes a session's worktree to reclaim disk but **keeps** the
  `claude_session_id` job row (a late reply can recreate the worktree + resume). Idempotent:
  unknown/already-reaped → `{reaped:false}`, still 200.
- Unknown `contractVersion` → **409** `{error:"contract-version-mismatch", contractVersion:"<this side's version>"}`
  on both `/jobs` and `/jobs/reap`.
- Mini-internal statuses `queued`/`running` are **never** sent to Vercel; `done` maps to
  `succeeded` on the wire. `prUrl` is required on a successful execute callback.
- Callbacks present `Authorization: Bearer <CALLBACK_SECRET>`, retry with backoff, and persist
  undelivered payloads (replayed on boot). A callback rejected with **409** is **fatal** —
  dropped from the outbox immediately, never retried.
- Jobs found `running` at boot are reported `failed`/`"interrupted"` so the workflow's hook
  resumes instead of hanging.
- Mid-run **AskUserQuestion** (plan AND execute): the SDK `canUseTool` callback intercepts the
  tool, the run pauses, the mini `POST`s the question to Vercel (`/api/mini/question`, bearer,
  bounded retry, fatal 409), and blocks until `POST /jobs/:id/answer` delivers the answers
  (keyed by question text). `AskUserQuestion` is in `allowedTools` for both runners. A stop
  during a pending question rejects it (`rejectQuestionsForJob` via the abort path) so the run
  aborts cleanly instead of hanging.
