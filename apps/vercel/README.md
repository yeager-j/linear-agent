# linear-agent-vercel

The always-reachable front door and durable state machine for the Linear × Claude Code agent
(Plan B — Vercel hybrid). This Next.js app receives Linear AgentSession webhooks, runs the
session state machine as a Vercel Workflow, and drives a thin "mini" execution appliance over a
Cloudflare tunnel. The mini does the actual Claude Agent SDK work and streams progress directly
to Linear; only terminal status flows back here.

See `../linear-claude-agent-plan-b-vercel-hybrid.md` (the plan) and `../shared/` (the binding
integration contract, Linear API notes, and Workflow DevKit reference).

## Architecture

```
Linear ──webhook──► /api/linear/webhook ──► start(sessionWorkflow) | promptHook.resume()
                                                     │
sessionWorkflow (workflow/* — durable):              │
  plan → waitForJob → elicitation → approval loop → execute → finalize
                                                     ▲
mini ──callback──► /api/mini/callback ──────► jobDoneHook.resume()
```

- `src/app/api/linear/webhook/route.ts` — verify `Linear-Signature` (raw body), dedupe on
  `Linear-Delivery`, ack thought, `start` / `promptHook.resume`.
- `src/app/api/mini/callback/route.ts` — bearer auth, contract-version check, `jobDoneHook.resume`.
- `src/app/api/health/route.ts` — proxies the mini's `/healthz` for an external monitor.
- `src/workflows/session.ts` — the state machine + `promptHook` / `jobDoneHook`.
- `src/lib/` — `contract.ts` (the seam, copied verbatim), `linear.ts`, `mini.ts`, `intent.ts`,
  `db.ts`, `webhook.ts`, `tokens.ts`, `env.ts`.

## Setup

> This project pins **Next.js 16.2.9** and the **Workflow DevKit** (`workflow`). The directives
> `"use workflow"` / `"use step"` are enabled by `withWorkflow()` in `next.config.ts`.

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill it in (see the table below).
3. Apply the Neon schema: run `sql/schema.sql` against your `DATABASE_URL`.

### Environment

| Var | Use |
|---|---|
| `LINEAR_ACCESS_TOKEN` | emit lifecycle activities, set externalUrls, status sync |
| `LINEAR_WEBHOOK_SECRET` | verify `Linear-Signature` |
| `LINEAR_APP_USER_ID` | app user id for delegate/self checks (optional) |
| `MINI_BASE_URL` | e.g. `https://agent-jobs.yourdomain.com` |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token → tunnel |
| `CALLBACK_SECRET` | bearer expected on `/api/mini/callback` |
| `DATABASE_URL` | Neon (session ↔ runId map, webhook dedupe) |

## Develop

```bash
npm run dev          # next dev — the Workflow DevKit runs locally
npm run typecheck    # tsc --noEmit
npm run test         # vitest (fixtures only, no live infra)
npm run build        # next build
```

Inspect workflow runs locally with `npx workflow web` (or `npx workflow inspect runs`).

### Local end-to-end loop

The DevKit runs under `next dev`, so the full webhook → workflow → hook loop is testable on a
laptop against the mini over Tailscale before deploying:

1. `npm run dev`, point `MINI_BASE_URL` at the mini (Tailscale) and set the CF-Access token.
2. Simulate a `created` webhook (sign the body with `LINEAR_WEBHOOK_SECRET`):

   ```bash
   BODY='{"action":"created","webhookTimestamp":'"$(($(date +%s)*1000))"',"agentSession":{"id":"sess_local","promptContext":"<issue>ENG-1</issue>","issue":{"id":"i1","identifier":"ENG-1"}}}'
   SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$LINEAR_WEBHOOK_SECRET" -hex | sed 's/^.* //')
   curl -sS -X POST localhost:3000/api/linear/webhook \
     -H "Content-Type: application/json" -H "Linear-Signature: $SIG" \
     -H "Linear-Delivery: $(uuidgen)" --data "$BODY"
   ```

3. Watch the run advance (`npx workflow web`). The mini calls back to
   `/api/mini/callback` with `Authorization: Bearer $CALLBACK_SECRET` to resume it.

## Deploy

Deploy to Vercel (the DevKit needs no special config). Set the env vars in the project, add Neon
via the marketplace, and **set a spend budget (~$25) with auto-pause** as runaway-loop insurance
(plan §7). Point the Linear webhook at `/api/linear/webhook` and the mini's `VERCEL_CALLBACK_URL`
at `/api/mini/callback`.
