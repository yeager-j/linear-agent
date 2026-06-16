# Linear × Claude Code Agent — Implementation Plan B (Vercel Workflows Hybrid)

The same agent as Plan A — plan in read-only mode, approve in Linear, iterate, execute to a PR, all on your Claude subscription — but with the durable orchestration layer moved to Vercel Workflows. Vercel is the always-reachable front door and state machine; the Mac mini is purely an execution appliance.

This plan is structured to mirror Plan A section-by-section so you can compare directly. A comparison table is at the end.

---

## 1. Architecture summary

```
Linear Cloud
   │  AgentSession webhooks (created / prompted / stop)
   ▼
Vercel (your Pro account)
├── /api/linear/webhook        verify sig, dedupe, ack thought (<10s),
│                              start(workflow) or hook.resume()
├── sessionWorkflow            "use workflow" — ONE RUN PER AgentSession
│     plan phase ──► step: POST mini /jobs {kind:"plan"}     (returns fast)
│     await jobDoneHook        ◄── mini callback on completion
│     emit elicitation (select: Approve / Request changes)
│     await promptHook         ◄── resumed by prompted webhooks
│     (revision → loop)  (approval → execute phase, same pattern)
│     finalize: response activity, mark done
├── /api/mini/callback         authenticated; resumes jobDoneHook
└── Neon (tiny): linearSessionId → workflowRunId map
        │
        │  HTTPS over Cloudflare Tunnel (service-token auth)
        ▼
Mac mini — Job Runner (thin)
├── POST /jobs      start plan/execute job (Agent SDK), return jobId
├── POST /jobs/:id/abort        stop signal passthrough
├── During runs: emits thought/action activities + plan array
│                DIRECTLY to Linear (low latency, no extra hop)
├── On terminal: POST Vercel /api/mini/callback {status, prUrl?, branch?}
└── Same internals as Plan A: worktrees, OrbStack containers,
    SQLite (jobs + workspaces only), launchd, Tailscale
```

**Division of responsibility (the seam):**

| Owns | Vercel | Mini |
|---|---|---|
| Webhook receipt, signature, dedupe, 5s/10s deadlines | ✅ | |
| Session state machine, approval/revision loop, sweeper timers | ✅ (workflow + hooks + `sleep`) | |
| Lifecycle activities: ack, elicitations, final response/error | ✅ | |
| Streaming activities during runs (thoughts, actions, plan array, heartbeats) | | ✅ (direct to Linear) |
| Claude Agent SDK, worktrees, containers, git, PR creation | | ✅ |
| Job-level crash detection | timeout race in workflow | boot-time reporter |

Both sides hold the Linear token; Vercel additionally holds a service token for calling the mini, and the mini holds a callback secret for calling Vercel.

**Decisions carried over unchanged from Plan A:** subscription auth via dedicated `linearagent` macOS user, bare clones + worktrees, OrbStack containers with `allowedTools` + `permissionMode: "dontAsk"` for execution, `permissionMode: "plan"` for planning, repo-scoped PAT, PR review as the final human gate.

**Decisions that change:**

- **No webhook receiver, orchestrator queue, or state machine on the mini.** The workflow run *is* the state machine; hooks replace the per-session FIFO (events resuming one run are inherently serialized).
- **No polling.** The workflow never spins waiting on the mini. "Start job" is a fast step; completion arrives as a hook resume. Idle cost ≈ zero; this is what keeps it inside your $20 credit.
- **Tunnel direction flips in purpose.** Linear no longer needs to reach the mini — only Vercel does. The tunnel hostname can be locked to Cloudflare Access with a service token so it accepts requests from your Vercel app only.
- **Concurrency cap lives on the mini** (it knows its own load): `/jobs` returns `202 {queued: true}` when at capacity and starts the job later, calling back normally. The workflow doesn't care — it's just waiting on a hook either way.

---

## 2. Repository layout (two deployables)

```
linear-agent-vercel/                      # Next.js + Workflow DevKit
├── app/
│   ├── api/linear/webhook/route.ts       # verify, dedupe, ack, start/resume
│   ├── api/mini/callback/route.ts        # auth, jobDoneHook.resume()
│   └── workflows/session.ts              # sessionWorkflow + hook definitions
├── lib/
│   ├── linear.ts                         # activities, elicitations, plan API
│   ├── mini.ts                           # authed client for mini /jobs
│   ├── intent.ts                         # approval-vs-revision classification
│   └── db.ts                             # Neon: session ↔ runId map
└── next.config.ts                        # withWorkflow()

linear-agent-mini/                        # plain Bun service
├── src/
│   ├── server.ts                         # /jobs, /jobs/:id/abort (tunnel-only)
│   ├── runners/{plan,execute}.ts         # Agent SDK runs (as Plan A Phases 4/6)
│   ├── activity-bridge.ts                # SDK stream → Linear (as Plan A)
│   ├── workspace/                        # bare clones + worktrees (as Plan A)
│   ├── github/pr.ts                      # push + PR (as Plan A)
│   └── callback.ts                       # report terminal status to Vercel
├── container/Dockerfile
└── ops/{plist, cloudflared-config, setup.md}
```

Roughly 60% of Plan A's mini code carries over verbatim (runners, bridge, workspace, github); the receiver/orchestrator/sweeper ~40% is replaced by the Vercel app.

---

## 3. Data model

**Neon (Vercel side) — one table:**

```sql
CREATE TABLE sessions (
  linear_session_id TEXT PRIMARY KEY,
  workflow_run_id   TEXT NOT NULL,
  issue_identifier  TEXT NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT now()
);
-- The workflow run's event log is the durable history;
-- phase lives implicitly in where the run is paused.
```

**SQLite (mini side) — jobs and workspaces only:**

```sql
CREATE TABLE jobs (
  job_id            TEXT PRIMARY KEY,
  linear_session_id TEXT NOT NULL,
  kind              TEXT NOT NULL,      -- plan | execute
  claude_session_id TEXT,               -- for resume across plan→execute
  worktree_path     TEXT,
  status            TEXT NOT NULL,      -- queued|running|done|failed|aborted
  created_at        INTEGER, updated_at INTEGER
);
```

**Workflow shape (the real state machine):**

```ts
const promptHook  = defineHook<{ text: string; signal?: "stop" }>();
const jobDoneHook = defineHook<{ jobId: string; status: string;
                                 prUrl?: string; branch?: string }>();

export async function sessionWorkflow(input: {
  linearSessionId: string; promptContext: string;
}) {
  "use workflow";
  // PLAN
  let job = await startMiniJob("plan", input);          // "use step", fast
  let done = await waitForJob(job.id);                  // jobDoneHook

  // APPROVAL LOOP
  while (true) {
    await sendElicitation(input.linearSessionId);       // select signal
    const msg = await waitForPrompt(input.linearSessionId); // promptHook
    if (msg.signal === "stop") return await handleStop(job);
    const intent = await classifyIntent(msg.text);      // model-based
    if (intent === "approve") break;
    job  = await startMiniJob("revise", { ...input, feedback: msg.text });
    done = await waitForJob(job.id);
  }

  // EXECUTE
  job  = await startMiniJob("execute", input);
  done = await waitForJob(job.id);                      // race w/ stop + timeout
  await finalize(input.linearSessionId, done);          // response or error
}
```

Two patterns from the Vercel guide to adopt deliberately: (1) pass the initial `promptContext` as workflow **input**, not via a hook — `start()` returns before hooks exist, and this sidesteps the race; (2) deterministic hook tokens derived from `linearSessionId` so webhook routes can always find the right run.

One pattern to add beyond the guide: `waitForJob` should race the hook against a `sleep`-based timeout (e.g. 45 min) so a silently dead mini job surfaces as a Linear `error` instead of a workflow paused forever.

---

## 4. Build phases

### Phase 0 — Accounts & plumbing (one evening)

1. Mini: same `linearagent` user, Node, OrbStack, Claude subscription login, pmset, launchd, Tailscale as Plan A Phase 0.
2. Cloudflare Tunnel → mini `:3001`, locked with **Cloudflare Access service token** (Vercel will send `CF-Access-Client-Id/Secret` headers; everything else gets a 403 at Cloudflare's edge — the mini is never publicly reachable in practice).
3. Vercel: new project, Workflow DevKit (`withWorkflow`), Neon via marketplace, env vars. **Set spend budget to ~$25 with auto-pause** — the runaway-loop insurance.

**Exit criteria:** a curl from a Vercel route reaches the mini through the tunnel with the service token; without the token it's rejected at the edge.

### Phase 1 — Webhook route + skeleton workflow (1–2 evenings)

1. `/api/linear/webhook`: verify `Linear-Signature`, dedupe (Neon insert-or-ignore on webhook id), emit ack `thought`, then `created` → `start(sessionWorkflow)` + insert session row; `prompted` → look up run, `promptHook.resume(token, {text, signal})`. Return inside 5 s (all of the above is fast; the ack is one GraphQL call).
2. Skeleton workflow: log-only steps in place of mini calls; elicitation + prompt loop working end-to-end against Linear.

**Exit criteria:** delegate a test issue → ack thought appears; reply in the session → workflow resumes and echoes a thought. Kill/redeploy mid-conversation → run survives (skew protection keeps it on its deployment).

### Phase 2 — Mini job runner (1–2 evenings)

1. Thin Bun app: `POST /jobs` validates auth header, creates job row, returns `{jobId}` immediately, runs async; `POST /jobs/:id/abort` flips a flag → AbortController.
2. Local concurrency: global cap 2 executes / 3 plans; over-cap jobs sit `queued` and self-start.
3. Boot reconciliation: jobs stuck `running` on startup → callback to Vercel with `status: "failed", reason: "interrupted"`.

**Exit criteria:** Vercel step starts a fake 30-second job; callback resumes the workflow; killing the mini mid-job produces a failure callback on reboot.

### Phase 3 — Workspaces (1 evening)

Identical to Plan A Phase 3 (bare clones, worktrees, fetch mutex, prune/gc). Port it unchanged.

### Phase 4 — Plan runner + activity bridge (2–3 evenings)

Identical internals to Plan A Phase 4 (`permissionMode: "plan"`, activity bridge with throttling, heartbeats, plan-array publication), with two seams changed:

- On completion, instead of touching a local state machine: `POST` the Vercel callback with the parsed plan summary; the **workflow** emits the elicitation.
- Store `claude_session_id` in the mini's jobs table keyed by `linear_session_id` so the later execute/revise job can resume the same Claude session.

**Exit criteria:** delegate a real ticket → streamed actions (from mini) → plan checklist → approval buttons (from Vercel), one coherent session in Linear.

### Phase 5 — Revision + approval loop (1 evening — cheaper than Plan A)

The loop already exists as workflow code from Phase 1; wire in real pieces:

1. `classifyIntent` step (model-based; the select buttons are the primary path, free text the fallback).
2. Revision → `startMiniJob("revise", …)`; the mini resumes the existing Claude session in plan mode with the feedback.
3. `stop` signal: webhook resumes `promptHook` with `signal: "stop"`; workflow calls mini `/abort`, waits briefly for the abort callback, emits the final confirmation activity. Also race `stop` against `jobDoneHook` during long executes so stop works mid-run, not just between phases.

**Exit criteria:** plan → free-text revision → revised plan → button approval → (stub) execute; and a stop request mid-plan halts cleanly with a confirmation in Linear.

### Phase 6 — Containerized execution → PR (2–3 evenings)

Identical to Plan A Phase 6 (OrbStack container, `allowedTools` + `"dontAsk"`, egress allowlist, plan-array status updates, push + PR). Terminal callback carries `{prUrl, branch}`; the **workflow** sets `externalUrls` and emits the final `response`.

**Exit criteria:** ticket → reviewable PR, linked from Linear, worktree and container cleaned up.

### Phase 7 — Lifecycle hardening (1 evening — much cheaper than Plan A)

Most of Plan A's Phase 7 dissolves: no boot reconciliation of a state machine (replay handles it), and the sweeper becomes workflow code — after sending the elicitation, race `promptHook` against `sleep("3 days")` → nudge → `sleep("4 days")` → tell the mini to reap the worktree (keep the Claude session id), keep waiting on the hook. A late reply re-creates the worktree and resumes.

Remaining work: issue-status sync to `started` (either side; pick Vercel for consistency), read history from Agent Activities not comments, healthchecks.io ping against a mini `/healthz` via the tunnel, and a `MAX_REVISION_ROUNDS`-style cap on every workflow loop.

### Phase 8 — Polish (optional)

Same menu as Plan A: `issueRepositorySuggestions` + select elicitation, Tailscale-only dashboard (mini), usage logging, label-based repo routing.

---

## 5. Configuration

```bash
# Vercel env
LINEAR_ACCESS_TOKEN=...
LINEAR_WEBHOOK_SECRET=...
LINEAR_APP_USER_ID=...
MINI_BASE_URL=https://agent-jobs.yourdomain.com
CF_ACCESS_CLIENT_ID=...           # service token → tunnel
CF_ACCESS_CLIENT_SECRET=...
CALLBACK_SECRET=...               # mini must present this
DATABASE_URL=...                  # Neon

# Mini env (0600)
LINEAR_ACCESS_TOKEN=...           # for streaming activities
GITHUB_TOKEN=...
VERCEL_CALLBACK_URL=https://your-app.vercel.app/api/mini/callback
CALLBACK_SECRET=...
MAX_CONCURRENT_EXECUTIONS=2
WORK_ROOT=/Users/linearagent/work
```

---

## 6. Testing strategy

As Plan A (fixture replay, dry-run PR mode, scratch Linear workspace + throwaway repo, chaos pass), plus hybrid-specific cases:

- **Mini unreachable** when a step calls `/jobs` → step retries; if still down, workflow emits a Linear `error` after a bounded retry window rather than spinning.
- **Callback lost** (mini finished but POST failed) → mini retries callbacks with backoff and persists undelivered ones; the workflow's `waitForJob` timeout is the backstop.
- **Duplicate callbacks / duplicate webhooks** → hook resumes must be idempotent (dedupe on jobId / webhookId).
- **Local dev:** Workflow DevKit runs locally (`next dev`), so the full loop is testable on your laptop against the mini over Tailscale before anything is deployed.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Two deployables + an internal API = more seams to version | Keep the seam tiny (2 routes each way); share a types package or duplicated zod schemas; version the callback payload |
| Workflows is a new product; semantics may shift | Confine workflow code to one file; the mini side is framework-free and portable back to Plan A in an afternoon |
| Vercel runaway (retry loop) burning credit overnight | $25 budget with auto-pause; iteration caps on every loop; no polling anywhere by design |
| Mini dies silently mid-job | `waitForJob` timeout race → Linear `error`; boot-time failure callbacks; external healthcheck |
| Stop signal during a long execute | Race `promptHook(stop)` vs `jobDoneHook` in the workflow; mini abort endpoint + WIP-branch push before teardown |
| Linear preview-API drift | Same as Plan A: isolate Linear calls, pin versions, watch #api |
| Subscription rate limits shared with your own use | Same as Plan A |

Costs (from earlier analysis): Vercel marginal ≈ pennies within your existing $20 Pro credit (short steps, hook-driven, kilobytes of retained data); mini ≈ $1–2/mo electricity; Neon free tier; tunnel free.

---

## 8. Plan A vs Plan B at a glance

| | **Plan A — all on the Mac** | **Plan B — Vercel hybrid** |
|---|---|---|
| Deployables | 1 | 2 + internal API |
| State machine | Hand-rolled (SQLite + queues + recovery + sweeper) | Workflow runs + hooks (durable for free) |
| Webhook deadlines (5s/10s) | Met by your code on your network | Met trivially at the edge |
| Survives mini downtime | ❌ missed webhooks, sessions look dead | ✅ webhooks land, sessions queue, error surfaced if mini stays down |
| Apartment-network exposure | Webhooks depend on it | Only Vercel→mini calls depend on it (retried) |
| New-product risk | Linear preview only | Linear preview + Workflows |
| Code you write | More infra code, zero integration code | Less infra code, some integration code |
| Marginal cost | ~$1–2/mo | ~$1–2/mo (Vercel inside existing credit) |
| Debugging a stuck session | Your logs + SQLite | Workflow event log in Vercel dashboard + mini logs (two places) |
| Migration story | → droplet/friend's place: rsync + service file | Mini is already a dumb appliance; relocating or replacing it touches nothing on Vercel |
| Best if | You want one boring system you fully own | You want durability/reachability handled, and don't mind a seam |

**Shared core either way:** runners, activity bridge, worktrees, containers, GitHub integration — the hard, interesting 60%. The plans differ in who babysits the state machine. If you build Plan B and later sour on Vercel, that core ports back to Plan A; the reverse is also true.

# Documentation
https://linear.app/developers/agents
https://linear.app/developers/agent-interaction
https://linear.app/developers/agent-best-practices
https://linear.app/developers/agent-signals
https://vercel.com/docs/workflows
https://vercel.com/docs/workflows/concepts
