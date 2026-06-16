# Open Questions & Decisions

Two kinds of entries: **`⚠️ VERIFY`** = unconfirmed API facts a human should check against live
docs/schema before relying on them; **DECISION** = a concrete choice made to keep the contract
unambiguous, which a reviewer can override (both builders must then update together).

Last updated: 2026-06-15 (revised after live GraphQL introspection + Vercel SDK docs pass).

> **CONFIRMED this round (no longer open):** see §F at the bottom for the full list of items
> closed by live `api.linear.app/graphql` introspection and the workflow-sdk.dev docs. The two
> load-bearing questions the lead flagged (Linear payload shapes; Vercel timeout-race + start
> return) are now substantially resolved.

---

## A. Linear API — remaining `⚠️ VERIFY` (webhook-envelope only)

The GraphQL *types* are confirmed (§F). What remains unconfirmable by introspection is the
**REST webhook envelope JSON** — webhook payloads are not GraphQL types, so these need a live
captured payload (or the developer docs' payload reference) to close:

1. **Top-level app-identity field on the AgentSessionEvent envelope.** The old
   `AppUserNotification` model uses top-level `appUserId` (confirmed in `linear/linear-agent-demo`).
   On `AgentSessionEvent`, the app user is reachable via `agentSession.appUser.id` (CONFIRMED in
   schema); whether there is *also* a top-level `appUserId`/`oauthClientId` on the envelope is
   unconfirmed. Routing should prefer `agentSession.appUser.id`.
2. **Dedup key stability.** `Linear-Delivery` (UUIDv4 header) uniquely identifies a *delivery*.
   Verify it is reused across retries of the same logical event; if not, dedupe on
   `webhookId`+`webhookTimestamp`. Contract prefers `Linear-Delivery` with that fallback.
3. **Webhook serialization of nested objects.** The `AgentSession`/`AgentActivity` *field names*
   are confirmed (§F), but how the webhook inlines nested relations (`issue`, `comment`,
   `appUser`) — full object vs `{id}` — is unconfirmed. Read defensively.
4. **Where the formatted prompt-text string lives on the envelope.** CORRECTION: the GraphQL
   `AgentSession.context` field is **related entities (issues/projects), NOT the formatted prompt
   string** (confirmed via the field's schema description). The plan's "promptContext" formatted
   string is a webhook-envelope construct. Verify the exact envelope path that carries it (likely
   top-level `promptContext` or `agentSession.promptContext`, webhook-only) against a captured
   payload. — *This is the most important remaining envelope item; the Vercel builder reads this
   to seed the workflow input.*
5. **`continue` signal semantics.** Confirmed `AgentActivitySignal` includes `continue`; verify
   when Linear sends it and what the agent should do (we treat unknown signals as no-op).
6. **Top-level `body` shortcut on `prompted`.** Confirmed `agentActivity.content.body` (String!)
   is authoritative; whether a top-level `agentActivity.body` shortcut also exists is unconfirmed
   — prefer `content.body`.

> CLOSED since last revision (moved to §F): plan item schema (`{content, status}` with status
> `pending|inProgress|completed|canceled`), `bodyData` on create (don't send it — internal
> ProseMirror), `externalUrls` item type (`AgentSessionExternalUrlInput {url,label}`).

## B. Vercel Workflow DevKit — remaining `⚠️ VERIFY`

10. **Three-way race parity.** The docs confirm a **two-way** `Promise.race(webhook, sleep)`
    timeout (verbatim example in vercel-workflows.md §7). Our `waitForJob` uses a **three-way**
    race (jobDone hook vs stop hook vs sleep). Verify three-way behaves identically; if not, nest
    two-way races or use one hook carrying both done+stop. (This is the only material residual on
    the timeout pattern — the pattern itself is confirmed supported.)
11. **`resume` idempotency for an already-consumed token.** Docs: missing-listener → 404; use
    `getHookByToken()` to check first; conflicts via `hook.getConflict()`. Verify whether
    resuming an already-consumed token throws or no-ops (contract assumes "may throw → catch &
    ignore"; webhook dedupe prevents most duplicates).
12. **Next.js 16.2.9 specifics.** Project AGENTS.md says read `node_modules/next/dist/docs/`
    before writing Next code. Confirm `withWorkflow` + route-handler raw-body access (for
    signature verification) behave as assumed on this exact version.

## C. Cloudflare / transport — `⚠️ VERIFY`

16. **CF Access header casing.** `CF-Access-Client-Id` / `CF-Access-Client-Secret` is the
    documented service-token pair; verify exact casing your tunnel expects.

---

## D. DECISIONS locked into the contract (reviewer can override)

- **D1. Terminal status enum = `succeeded | failed | aborted`.** The plan's mini SQLite uses
  `queued|running|done|failed|aborted`; `done` is renamed `succeeded` in the *callback* to avoid
  ambiguity, and `queued|running` are mini-internal and never sent. (If you prefer `done` on the
  wire, change `TerminalStatus`.)
- **D2. `JobKind` includes `revise`** as a distinct kind (plan §3 workflow uses
  `startMiniJob("revise", …)`), even though the data-model table only lists `plan|execute`.
  `revise` = re-plan with feedback, resuming the Claude session. (Alternative: fold into `plan`
  with a `feedback` field and drop `revise`.)
- **D3. Mini→Vercel auth = `Authorization: Bearer <CALLBACK_SECRET>`.** Chosen over a custom
  header for convention. (Alternative: `X-Callback-Secret`.)
- **D4. `POST /jobs` is idempotent via an `idempotencyKey`** =
  `${linearSessionId}:${kind}:${round}`, deterministic across workflow replays. This is an
  addition beyond the plan (which only says "returns {jobId}") — it prevents replays/retries from
  spawning duplicate jobs. Drop it only if step-level retry dedupe is handled another way.
- **D5. `CreateJobResponse` always returns `jobId` (200 or 202).** The plan mentions
  `202 {queued:true}`; the contract returns `{jobId, queued}` for BOTH so the workflow uses one
  code path and always waits on `job:${jobId}`.
- **D6. `claudeSessionId` is mini-owned; Vercel only echoes it.** The mini's SQLite is the
  source of truth (plan §3). Vercel stores whatever the callback reports and passes it back on
  the next job; the mini may ignore the passed value.
- **D7. `kind` is included in the callback** so the workflow knows which phase finished without
  relying solely on where the run is paused (defensive against replay edge cases).
- **D8. `contractVersion` mismatch → 409.** Fail loudly on a half-deployed pair rather than
  silently misbehaving.
- **D9. Webhook dedupe table.** Add a `webhook_deliveries(delivery_id PRIMARY KEY, seen_at)`
  table in Neon alongside the `sessions` table from plan §3 (the plan implies "Neon insert-or-
  ignore on webhook id" but doesn't define the table).

---

## F. CONFIRMED this round (closed open questions)

**Method:** live GraphQL introspection against `https://api.linear.app/graphql` on 2026-06-15
(type introspection + field descriptions; needs no auth) + the Linear developer docs
(agent-interaction, for the opaque-JSON plan item shape) + workflow-sdk.dev docs
(cookbook/timeouts, foundations/starting-workflows, api-reference get-run, foundations/hooks).

Linear (introspected verbatim):
- `AgentSessionStatus` enum = **`pending | active | complete | awaitingInput | error | stale`**.
- `AgentActivitySignal` enum = **`stop | continue | auth | select`** (note `continue` is new vs
  prior docs).
- `AgentActivityType` enum = **`thought | action | response | elicitation | error | prompt`**.
- `AgentActivityContent` is a **UNION** of `AgentActivity{Thought,Action,Response,Elicitation,
  Error,Prompt}Content`. Field names per member: thought/response/elicitation/prompt =
  `{type, body, bodyData}`; action = `{type, action, parameter, result?, resultData?}`; error =
  `{type, body, reasonCode?, bodyData}`.
- `AgentActivityCreateInput` = `{ agentSessionId: String!, content: JSONObject!, signal?:
  AgentActivitySignal, signalMetadata?: JSONObject, contextualMetadata?: JSONObject, ephemeral?:
  Boolean, id?: String }`. → **`signal`/`signalMetadata` are top-level, NOT inside content**
  (closes old A8). `id` is available as an idempotency handle.
- `agentActivityCreate` returns `AgentActivityPayload { lastSyncId, agentActivity, success }`.
- `agentSessionUpdate(input, id)` returns `AgentSessionPayload`. `AgentSessionUpdateInput` has
  `plan: JSONObject`, `externalUrls`, `addedExternalUrls`, `removedExternalUrls`, `externalLink`,
  `userState`, `dismissedAt`. → `plan` IS on the session update; arg name is `id` (closes A7).
- `AgentSession` object fields confirmed (id, slugId, status, appUser, creator, issue, comment,
  sourceComment, context(JSON!), summary, plan, sourceMetadata, url, activities, pullRequests,
  externalLinks, …). → **no `project` field**; **app identity is `appUser` not `appUserId`**.
- **`AgentSession.context` is RELATED ENTITIES, not the prompt text** (confirmed via the field's
  schema description: *"The entity contexts this session is related to, such as issues or
  projects"*). The formatted "promptContext" string is therefore a **webhook-envelope** field, not
  this GraphQL field. (Corrected from the prior round, which wrongly equated them.)
- **`plan` item shape (developer docs):** `Array<{ content: string, status: "pending" |
  "inProgress" | "completed" | "canceled" }>`. Field is `content` (not title); status is
  camelCase. Replace the whole array each update. (`AgentSession.plan` description confirms it's a
  dynamically-updated execution plan.)
- **`bodyData` is internal** — *"[Internal] the content as a ProseMirror document"*; on **create
  send only `body` (markdown), never `bodyData`**.
- **`externalUrls` item type = `AgentSessionExternalUrlInput { url: String!, label: String! }`**;
  read-side `AgentSessionExternalLink { url, label }` (both confirmed by introspection).
- Other relevant mutations/types exist: `agentActivityCreatePrompt` (+
  `AgentActivityPromptCreateInputContent {type, body, bodyData}`), `agentSessionUpdateExternalUrl`,
  `agentSessionCreateOnComment/OnIssue`, `agentActivitySendQueued/DeleteQueued`.
- Signature verification (HMAC-SHA256 hex over raw body, compared to `linear-signature` header)
  confirmed verbatim by `linear/linear-agent-demo` source.

Vercel Workflow SDK (docs verbatim):
- `start(workflow, [args])` returns a **`Run` object** (not a bare id); `run.runId` (format
  `wrun_{ulid}`); other props are async getters (`await run.status`, `await run.returnValue`).
- `Promise.race([hook/webhook, sleep(...).then(...)])` is the **documented** timeout idiom; the
  losing branch keeps running but its result is ignored; detect winner via discriminated union.
- Hooks are disposable (`using` / `dispose()`) and **must be created in the workflow body, not in
  a step**.
- `getRun(runId)` re-acquires by id only; `getHookByToken()` is the documented way to route a
  retried request to a paused hook by token. `createWebhook<T>()` is an alternative to
  `defineHook` (mints a `webhook.url`).

---

## E. Subscription auth note (not a contract issue)

The mini runs the Claude Agent SDK under the user's personal Claude subscription (dedicated
`linearagent` macOS user), per the plan. The user has confirmed this is a personal,
non-product deployment, so the Anthropic guidance against offering claude.ai login in
third-party *products* does not apply here. Recorded only so a reviewer doesn't re-raise it;
it is outside the Vercel⇄mini seam.
