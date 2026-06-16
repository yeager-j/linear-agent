# Shared Store — Linear × Claude Code Agent (Plan B, Vercel Hybrid)

This directory is the **single source of truth** that both builder agents rely on. It is
research output: distilled, concrete API shapes plus the integration seam contract. Neither
the `linear-agent-vercel/` nor the `linear-agent-mini/` code is modified by the research
agent — only these docs are.

**Last updated:** 2026-06-15

## Files

| File | Purpose | Who reads it |
|---|---|---|
| `linear-agents-api.md` | Distilled Linear Agents API: AgentSession webhooks, signature verification, AgentActivity types + GraphQL mutations, plan array, externalUrls, signals, deadlines. | Both (Vercel emits lifecycle activities; mini streams activities directly) |
| `vercel-workflows.md` | Distilled Workflow DevKit: `use workflow` / `use step`, `defineHook`/`resume`, tokens, `sleep`, `start`, replay/idempotency rules, `withWorkflow()`, local dev, timeout-race pattern. | Vercel builder |
| `integration-contract.md` | **THE SEAM.** Exact HTTP APIs both directions, auth headers, hook payloads + token derivation, idempotency keys, env vars, `CONTRACT_VERSION`. Copy-pasteable zod schemas. | **Both — implement against this file only** |
| `open-questions.md` | Ambiguities, `⚠️ VERIFY` items, and concrete decisions made to keep the contract unambiguous. | Human reviewer + both builders |

## How builders should use this

1. **Read `integration-contract.md` first and treat it as binding.** Both projects implement
   independently against it. Any gap there becomes a runtime bug, so if something is unclear,
   flag it in `open-questions.md` rather than guessing a different shape.
2. Copy the zod schemas from `integration-contract.md` verbatim into each project (the plan
   accepts duplicated schemas over a shared package — see plan §7 risk row 1). Keep
   `CONTRACT_VERSION` identical on both sides.
3. Use `linear-agents-api.md` for the exact Linear GraphQL mutations and webhook fields.
   Vercel uses it for ack `thought`, elicitations, final `response`/`error`, `externalUrls`,
   and the `plan` array on the session. The mini uses it for streaming `thought`/`action`
   activities and the `plan` array during runs.
4. Use `vercel-workflows.md` for the workflow/hook/sleep mechanics. The mini side is
   framework-free and does not need it.

## Source provenance

All API shapes were fetched 2026-06-15 from the official docs listed in the plan:
- Linear: `/developers/agents`, `/agent-interaction`, `/agent-best-practices`, `/agent-signals`, `/webhooks`
- Vercel: `/docs/workflows`, `/docs/workflows/concepts`, the "Build a Claude Managed Agent" KB guide, and `workflow-sdk.dev` (next guide + hooks foundations).

Items that could not be confirmed verbatim from a fetched page are marked `⚠️ VERIFY` in the
relevant doc and collected in `open-questions.md`.
