# Mac mini setup runbook (STUB)

The mini is the execution appliance. Vercel owns the state machine; this box just runs jobs,
streams activities to Linear, and reports terminal status back. See the top-level plan §4
Phase 0 and the integration contract for the seam.

> STATUS: STUB. The steps below are the intended Phase 0 plumbing; fill in the TODOs against
> your actual machine, domain, and tokens. None of this is required to run the test suite
> (`bun test`) — everything external is gated behind dry-run flags.

## 1. Dedicated macOS user
- Create a `linearagent` user (keeps the agent's Claude session + git identity separate).
- Log into the Claude Code CLI as that user (`claude` → `/login`, or `claude setup-token`).
  The Agent SDK falls back to this subscription login automatically when `ANTHROPIC_API_KEY`
  is UNSET (do NOT set an API key). Credentials live at `~/.claude/.credentials.json`.

## 2. Toolchain
- Install Bun (`curl -fsSL https://bun.sh/install | bash`), git, and (later) OrbStack for
  containerized execution.
- `bun install` in this repo.

## 3. Power / availability
- `sudo pmset -a sleep 0 disablesleep 1` (or Energy Saver) so the box stays reachable.

## 4. Secrets (.env, mode 0600)
Create `.env` next to `index.ts` (Bun auto-loads it). See README "Environment" for the full
list. Minimum to actually run jobs:
```
LINEAR_ACCESS_TOKEN=...
GITHUB_TOKEN=...
VERCEL_CALLBACK_URL=https://your-app.vercel.app/api/mini/callback
CALLBACK_SECRET=...                 # must match Vercel
MAX_CONCURRENT_EXECUTIONS=2
WORK_ROOT=/Users/linearagent/work
DEFAULT_REPO_URL=git@github.com:org/repo.git
```
`chmod 600 .env`.

## 5. Cloudflare Tunnel + Access service token
Follow `ops/cloudflared-config.yml`. Exit criteria (plan §4 Phase 0): a curl from a Vercel
route reaches the mini through the tunnel WITH the service token; WITHOUT it, 403 at the edge.

## 6. launchd
Install `ops/com.linearagent.mini.plist` (edit paths first), then `launchctl load -w`. KeepAlive
restarts the runner; boot reconciliation reports any interrupted jobs to Vercel.

## 7. Healthcheck
Point an external monitor (e.g. healthchecks.io) at `GET /healthz` via the tunnel.

## Smoke test (no real infra)
```
DRY_RUN=1 bun index.ts          # starts the server; fake jobs flow start -> callback
curl localhost:3001/healthz
```
