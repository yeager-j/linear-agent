# Linear Agents API — Distilled Reference

Source: linear.app/developers/{agents, agent-interaction, agent-best-practices, agent-signals, webhooks}, fetched 2026-06-15. **Type/enum/input/mutation shapes in §1, §4, §5, §6 were confirmed by live GraphQL introspection against `https://api.linear.app/graphql` on 2026-06-15** (no auth needed for type introspection). Webhook *envelope* JSON (§2) is NOT in the GraphQL schema — it is delivered as REST JSON and could not be introspected; those fields remain `⚠️ VERIFY`.

This is a **preview API**. Pin versions, isolate Linear calls behind one module per project, and watch the Linear `#api` Slack channel for drift (plan §7).

---

## 1. Mental model

- Delegating/mentioning an agent creates an **AgentSession**. State updates are driven
  automatically by the activities the agent emits — you do **not** call a "set state" mutation
  for normal progress.
- You drive the conversation by creating **AgentActivity** records (`agentActivityCreate`).
- The session's history of record is the **immutable AgentActivity log**, NOT comments.
  Reconstruct conversation context from activities (best-practices).

### Session status enum (CONFIRMED — `AgentSessionStatus` introspected)
`pending | active | complete | awaitingInput | error | stale`
(awaitingInput is what an `elicitation` puts the session into; `stale` is reached after ~30 min of no activity and is recoverable by emitting another activity.)

### AgentSession object fields (CONFIRMED — introspected)
Read fields on the `AgentSession` object: `id: ID!`, `slugId: String!`, `status:
AgentSessionStatus!`, `createdAt/updatedAt/startedAt/endedAt: DateTime`, `appUser: User!` (the
agent's app user — this is the app-identity, **not** a top-level `appUserId`/`oauthClientId` on
the object), `creator: User`, `issue: Issue`, `comment: Comment`, `sourceComment: Comment`,
`context: JSON!` (CONFIRMED description: *"The entity contexts this session is related to, such
as issues or projects referenced in direct chat sessions"* — i.e. **related-entity context, NOT
the formatted prompt-text string**; see the correction in §2 about where prompt text lives),
`summary: String` (*"human-readable summary of the work performed"*), `plan: JSON`
(*"dynamically updated plan describing the agent's execution strategy… Updated as the agent
progresses… Null if no plan has been set"* — item shape in §5), `sourceMetadata: JSON`
(*"Metadata about the external source that created this session"*), `url: String`, `activities:
AgentActivityConnection!`, `pullRequests: …Connection!`, `externalLinks:
[AgentSessionExternalLink!]!` (each `{ url: String!, label: String! }` — CONFIRMED),
`codingHarnessModelLabel: String`, `dismissedAt/dismissedBy`.
Note: read field is `externalLinks`; the **write** field on the update input is `externalUrls`
(items: `AgentSessionExternalUrlInput { url: String!, label: String! }` — CONFIRMED). See §5.

---

## 2. Webhooks — AgentSessionEvent

Header: `Linear-Event: AgentSessionEvent`. Three actions:

| `action` | When | What you do |
|---|---|---|
| `created` | user delegates/mentions the agent | ack with a `thought` within 10 s; `start()` the workflow |
| `prompted` | user sends a follow-up message in the session | resume the workflow's promptHook with the message text |
| `stop`* | user requests halt | abort the running job; emit final `response`/`error` |

\* **IMPORTANT NUANCE (confirmed):** the `stop` *signal* is delivered **inside a `prompted`
event** as `agentActivity.signal: "stop"` — i.e. you primarily branch on
`payload.agentActivity?.signal === "stop"`, not on a separate top-level action. `stop` is a
value of the confirmed `AgentActivitySignal` enum (`stop | continue | auth | select`). A
standalone `stop` action is referenced in the docs structure but the signal-on-prompted path is
the one to implement. Treat both as "stop" defensively. `⚠️ VERIFY` whether a top-level
`action: "stop"` is ever sent separately.

### Webhook envelope (common fields, from /developers/webhooks)
```jsonc
{
  "action": "created",                 // created | prompted | (stop)
  "type": "AgentSessionEvent",         // ⚠️ VERIFY exact value vs Linear-Event header
  "createdAt": "2026-06-15T12:00:00.000Z",
  "organizationId": "…",
  "appUserId": "…",                    // app-identity. The OLD AppUserNotification webhook model uses
                                       //   top-level "appUserId" (confirmed in linear/linear-agent-demo).
                                       //   On AgentSessionEvent the app user is also reachable via
                                       //   agentSession.appUser.id. ⚠️ VERIFY top-level field name on this event.
  "webhookId": "…",                    // identifies the webhook subscription
  "webhookTimestamp": 1718452800000,   // UNIX ms when sent — reject if too old (replay guard)
  "actor": { /* User | OauthClient | Integration */ },
  "agentSession": { /* see below */ },
  "agentActivity": { /* present on prompted; see below */ }
}
```
There is also a delivery-level header `Linear-Delivery` = a UUIDv4 uniquely identifying this
delivery. **Dedupe on `Linear-Delivery`** (or `webhookId`+`webhookTimestamp` if delivery id
absent — see open-questions). `⚠️ VERIFY` which of these is stable per logical event.

### `agentSession` object on the webhook
The webhook serializes the `AgentSession` object (fields confirmed by introspection — see §1).
Nested object field names are NOT confirmed for the webhook serialization (the GraphQL object
exposes them as resolvable relations, not inline scalars), so the nested shapes below stay
`⚠️ VERIFY`, but the top-level field NAMES are confirmed:
```jsonc
{
  "id": "…",                  // CONFIRMED: AgentSession.id — THE linearSessionId you key on
  "slugId": "…",              // CONFIRMED present
  "status": "pending",        // CONFIRMED enum value
  "context": [ … ],           // CONFIRMED field: AgentSession.context (JSON!) = RELATED ENTITIES
                              //   (issues/projects), NOT the formatted prompt-text string.
                              //   The "promptContext" formatted string the plan refers to is a
                              //   WEBHOOK-ENVELOPE construct (see correction below), not this field.
  "summary": "…",             // CONFIRMED present (nullable)
  "appUser": { "id": "…" },   // CONFIRMED field name: the agent's app user (NOT appUserId/oauthClientId)
  "issue":   { "id": "…", "identifier": "ENG-123", "title": "…" }, // ⚠️ VERIFY nested fields
  "comment": { "id": "…", "body": "…" }, // CONFIRMED field name `comment`; ⚠️ VERIFY nested fields
  "sourceComment": { "id": "…" },        // CONFIRMED field name (nullable)
  "plan": [ … ],              // CONFIRMED field name (JSON, nullable)
  "url": "…"                  // CONFIRMED present (nullable)
}
```
NOTE: there is **no `project` field** on AgentSession (it was inferred before; not in the
schema). Project context, if any, comes via the issue or `context`.

### `agentActivity` object (on `prompted`)
The webhook serializes an `AgentActivity` (fields confirmed by introspection — see §4):
```jsonc
{
  "id": "…",
  "content": { "type": "prompt", "body": "the user's follow-up text" }, // CONFIRMED: content is a
                              //   union; the prompt variant is AgentActivityPromptContent {type,body,bodyData}
  "signal": "stop",           // CONFIRMED field name; present when the user signalled. Enum:
                              //   stop | continue | auth | select
  "signalMetadata": { … },    // CONFIRMED field name (JSON, nullable)
  "ephemeral": false          // CONFIRMED present (Boolean!)
}
```
Read the follow-up text from `agentActivity.content.body`. (`content.type === "prompt"`,
`content.body` is `String!`.) The top-level `body` shortcut is `⚠️ VERIFY` — prefer
`content.body` which is confirmed in the schema.

### prompt context — CORRECTION
Earlier drafts (and the plan) call the formatted prompt string `promptContext`. Introspection
shows the GraphQL `AgentSession.context` field is **related entities (issues/projects), not a
formatted prompt string** — so the formatted prompt text is delivered **on the webhook envelope**
(the developer docs describe a `promptContext` "formatted string containing the session's
relevant context, such as issue details, comments, and guidance"), NOT readable as
`agentSession.context` over GraphQL. For our flow: read the formatted prompt off the **`created`
webhook payload** and pass it to the workflow as **input** (plan §3 pattern 1) — do not rely on
querying `AgentSession.context` for it. `⚠️ VERIFY` the exact envelope field name/path that
carries the formatted prompt string (likely top-level `promptContext` or
`agentSession.promptContext` on the webhook only) against a captured payload.

---

## 3. Signature verification (`Linear-Signature`)

HMAC-SHA256 over the **raw request body bytes** (not re-stringified JSON), hex-encoded, in the
`Linear-Signature` header. Use the webhook signing secret (`LINEAR_WEBHOOK_SECRET`).

```ts
import crypto from "node:crypto";

export function verifyLinearSignature(rawBody: Buffer | string, header: string): boolean {
  const expected = crypto
    .createHmac("sha256", process.env.LINEAR_WEBHOOK_SECRET!)
    .update(rawBody)                       // RAW body — read before JSON.parse
    .digest();
  const got = Buffer.from(header, "hex");
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}
```

In Next.js App Router, read the raw body with `await req.text()` and verify **before**
parsing. Also reject if `webhookTimestamp` is older than ~1 min (replay protection).

---

## 4. AgentActivity types + the create mutation (CONFIRMED via introspection)

```graphql
mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {        # returns AgentActivityPayload
    lastSyncId
    success                                    # Boolean!
    agentActivity { id }                       # AgentActivity!
  }
}
```

`AgentActivityCreateInput` (CONFIRMED field names + nullability):
```jsonc
{
  "agentSessionId": "…",      // String!  (required)
  "content": { … },           // JSONObject!  (required) — the discriminated {type, …} object below.
                              //   NOTE: content is a free-form JSONObject on the INPUT; on read it
                              //   resolves to the AgentActivityContent union.
  "signal": "select",         // AgentActivitySignal  (optional) — stop | continue | auth | select
  "signalMetadata": { … },    // JSONObject  (optional) — shape depends on signal (see §6)
  "contextualMetadata": { … },// JSONObject  (optional)
  "ephemeral": false,         // Boolean  (optional) — only meaningful for thought | action
  "id": "…"                   // String   (optional) — client-supplied id for idempotency
}
```
**CONFIRMED:** `signal` / `signalMetadata` are **top-level on the input**, NOT nested inside
`content` (resolves prior open question A8). There is also an optional `id` input field usable
as an idempotency handle for the activity itself.

### Content variants (CONFIRMED field names per union member)
Discriminator is `content.type`, an `AgentActivityType` enum:
**`thought | action | response | elicitation | error | prompt`** (CONFIRMED). `prompt` is the
inbound/user type (you read it on `prompted`; you don't create it via `agentActivityCreate` —
there's a separate `agentActivityCreatePrompt` mutation). The 5 you create:
```jsonc
// thought  (AgentActivityThoughtContent: type, body[, bodyData]) — can be ephemeral
{ "type": "thought", "body": "Looking into ENG-123…" }

// action  (AgentActivityActionContent: type, action, parameter, result?, resultData?) — can be ephemeral
{ "type": "action", "action": "Searching", "parameter": "San Francisco Weather" }
{ "type": "action", "action": "Searched",  "parameter": "San Francisco Weather", "result": "12°C, mostly clear" }

// elicitation  (AgentActivityElicitationContent: type, body[, bodyData]) — pairs with select/auth signal
{ "type": "elicitation", "body": "Approve this plan or request changes?" }

// response  (AgentActivityResponseContent: type, body[, bodyData]) — terminal success
{ "type": "response", "body": "Opened PR **#42**." }

// error  (AgentActivityErrorContent: type, body, reasonCode?[, bodyData]) — terminal failure
{ "type": "error", "body": "Job interrupted; the mini was restarted.", "reasonCode": "interrupted" }
```
CONFIRMED nuances:
- `action` requires both `action` AND `parameter` (both `String!`); `result`/`resultData` are
  optional.
- `error` has an optional `reasonCode: String`.
- All `body`-bearing types also expose a `bodyData` on read. CONFIRMED via the prompt input's
  description: `bodyData` is *"[Internal] the content as a ProseMirror document"* — so on
  **create you send only `body` (markdown); do NOT send `bodyData`** (it's an internal rendered
  form). `body` on the prompt content is described as markdown.

Rules:
- `ephemeral: true` is meaningful only on `thought` and `action`; ephemeral activities are
  replaced when the next activity arrives. Use for streaming progress.
- `response` and `error` are terminal — they complete the session.

### Who emits what (the seam)
- **Vercel** emits: ack `thought` (on `created`), `elicitation` (approve/changes select),
  final `response`/`error`, and sets `externalUrls` + the `plan` array status at lifecycle
  boundaries.
- **Mini** emits directly to Linear during runs: streaming `thought`/`action` (ephemeral),
  heartbeat thoughts, and the **plan checklist array** updates while planning/executing.

---

## 5. Plan / checklist array + externalUrls (AgentSessionUpdate) — CONFIRMED args/inputs

```graphql
# mutation arg order CONFIRMED: agentSessionUpdate(input, id) -> AgentSessionPayload
mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success }   # AgentSessionPayload
}
```

`AgentSessionUpdateInput` (CONFIRMED field names):
- `plan: JSONObject` — the checklist. **Replace wholesale; individual items cannot be patched.**
  Re-send the full structure on every update. (CONFIRMED field exists and is `JSONObject` — note
  it is a JSON object, the *item* schema inside is `⚠️ VERIFY`; see below.)
- `externalUrls: [..]` — the write field for external links (CONFIRMED; read side is
  `AgentSession.externalLinks`). `addedExternalUrls` / `removedExternalUrls` are CONFIRMED
  incremental variants. `externalLink: String` (singular) also exists.
- `userState: [..]`, `dismissedAt: DateTime` also exist (not needed for our flow).

There is also a dedicated `agentSessionUpdateExternalUrl(input, id)` mutation (CONFIRMED) if you
only need to set the URL.

```jsonc
// plan — CONFIRMED item shape (developer docs): Array<{ content: string, status: <enum> }>.
// Field is `content` (NOT title/label). Status enum CONFIRMED: "pending" | "inProgress" |
// "completed" | "canceled" (camelCase). Replace the whole array on every update.
{
  "plan": [
    { "content": "Read existing auth module", "status": "completed" },
    { "content": "Add token refresh",          "status": "inProgress" },
    { "content": "Write tests",                "status": "pending" }
  ]
}
// externalUrls — CONFIRMED item type AgentSessionExternalUrlInput { url: String!, label: String! }
{ "externalUrls": [ { "label": "Pull Request", "url": "https://github.com/org/repo/pull/42" } ] }
```
Setting `externalUrls` also counts as activity and prevents an "unresponsive" mark.
All shapes in this section are now CONFIRMED (introspection + developer docs).

---

## 6. Signals

Two directions:

`AgentActivitySignal` enum (CONFIRMED): `stop | continue | auth | select`.

**Human → Agent** (arrives in webhooks):
- `stop` — halt immediately; you must then emit a final `response` or `error`. Delivered as
  `agentActivity.signal: "stop"` on a `prompted` event (see §2).
- `continue` — CONFIRMED enum value (resume/keep-going). `⚠️ VERIFY` exact semantics + when sent.

**Agent → Human** (set on `agentActivityCreate`, only on `elicitation`):
- `select` — present options; user can also reply free-text (which dismisses the elicitation).
  ```jsonc
  { "signal": "select",
    "signalMetadata": { "options": [
      { "label": "Approve",         "value": "approve" },
      { "label": "Request changes", "value": "request_changes" }
    ] } }
  ```
- `auth` — request account linking.
  ```jsonc
  { "signal": "auth",
    "signalMetadata": { "url": "https://auth.example.com/oauth", "userId": "…", "providerName": "…" } }
  ```

**Approve/changes loop:** Vercel emits an `elicitation` + `select` (Approve / Request changes).
The user's button choice OR free-text comes back as a `prompted` event → resume promptHook.
The `select` value is the primary path; free text is the fallback classified by `intent.ts`.

---

## 7. Deadlines & lifecycle timing

| Deadline | Value | Consequence |
|---|---|---|
| Webhook HTTP response | **5 s** | return 200 fast; do all heavy work async (start workflow, then return) |
| First activity after `created` | **10 s** | else session marked unresponsive — emit the ack `thought` immediately |
| Time between activities | **~30 min** | else session goes `stale`; emit another activity to recover |

For long executes the **mini** must emit heartbeat thoughts (< 30 min apart) so the session
does not go stale mid-run. The Vercel `waitForJob` timeout (e.g. 45 min) is the backstop that
turns a silently dead job into a Linear `error`.

---

## 8. OAuth / app identity (setup, not per-request)

- App installed in `actor=app` mode (cannot request `admin` scope).
- Scopes needed: `app:assignable` (be a delegate), `app:mentionable` (be @-mentioned), plus
  read scopes as required.
- Get the app user id via `query { viewer { id } }` → store as `LINEAR_APP_USER_ID`.
- Best-practice: when delegated to an issue not already in a started/completed/canceled status,
  move it to the lowest-`position` workflow state with `type == "started"`; and set
  `Issue.delegate` to self if unset. Plan assigns this status-sync responsibility to **Vercel**.
