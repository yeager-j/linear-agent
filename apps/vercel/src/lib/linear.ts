// Linear Agents API client — the ONLY module that talks to Linear. Isolated so preview-API
// drift has a small blast radius (linear-agents-api.md §intro, plan §7). Every network call
// here is meant to be invoked from inside a workflow `"use step"` (determinism rule) or from a
// route handler — never from the workflow body directly.

import crypto from "node:crypto";
import { env, LINEAR_GRAPHQL_URL } from "./env";
import { getValidAccessToken, invalidateTokenCache, LinearTokenError } from "./linear-token";
import { WEBHOOK_MAX_AGE_MS } from "./limits";

/* ───────────────────────── Signature verification ───────────────────────── */

// HMAC-SHA256 over the RAW request body bytes, hex-encoded, in the `Linear-Signature` header
// (linear-agents-api.md §3). Verify BEFORE JSON.parse. timingSafeEqual after a length check.
export function verifyLinearSignature(rawBody: string, header: string | null): boolean {
  if (!header) return false;
  const expected = crypto
    .createHmac("sha256", env.linearWebhookSecret())
    .update(rawBody)
    .digest();
  let got: Buffer;
  try {
    got = Buffer.from(header, "hex");
  } catch {
    return false;
  }
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// Replay guard: reject events whose webhookTimestamp (UNIX ms) is too old (API §3/§7).
// Tolerant: a missing/garbage timestamp is allowed through (signature already proved authenticity).
export function isTimestampFresh(webhookTimestamp: unknown, now = Date.now()): boolean {
  if (typeof webhookTimestamp !== "number") return true;
  return Math.abs(now - webhookTimestamp) <= WEBHOOK_MAX_AGE_MS;
}

/* ───────────────────────── GraphQL transport ───────────────────────── */

type GraphQLResult<T> = { data?: T; errors?: Array<{ message: string }> };

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const doFetch = (token: string) =>
    fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ query, variables }),
    });

  let res = await doFetch(await getValidAccessToken());
  if (res.status === 401) {
    // Token rejected despite passing our freshness check (early revocation, clock skew, a missed
    // race). Force ONE refresh and retry once; a second 401 is a real auth failure.
    invalidateTokenCache();
    res = await doFetch(await getValidAccessToken());
    if (res.status === 401) {
      throw new LinearTokenError("Linear rejected the access token even after a refresh");
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Linear GraphQL HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as GraphQLResult<T>;
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) {
    throw new Error("Linear GraphQL returned no data");
  }
  return json.data;
}

/* ───────────────────────── Agent activities ───────────────────────── */

const AGENT_ACTIVITY_CREATE = `
  mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) {
      success
      agentActivity { id }
    }
  }
`;

type ActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter?: string; result?: string }
  | { type: "elicitation"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

interface ActivityInput {
  agentSessionId: string;
  content: ActivityContent;
  ephemeral?: boolean;
  signal?: "select" | "auth";
  signalMetadata?: Record<string, unknown>;
}

async function createActivity(input: ActivityInput): Promise<void> {
  await gql(AGENT_ACTIVITY_CREATE, { input });
}

// Ack thought (on `created`) — must land within 10s of the webhook (API §7). Non-ephemeral so
// it stays in the history of record.
export async function emitThought(agentSessionId: string, body: string, ephemeral = false): Promise<void> {
  await createActivity({ agentSessionId, content: { type: "thought", body }, ephemeral });
}

// Terminal success — completes the session.
export async function emitResponse(agentSessionId: string, body: string): Promise<void> {
  await createActivity({ agentSessionId, content: { type: "response", body } });
}

// Terminal failure — completes the session.
export async function emitError(agentSessionId: string, body: string): Promise<void> {
  await createActivity({ agentSessionId, content: { type: "error", body } });
}

// Elicitation + select signal (Approve / Request changes). The user's button choice OR free
// text comes back as a `prompted` event (API §6).
export interface SelectOption {
  label: string;
  value: string;
}

export async function emitElicitationSelect(
  agentSessionId: string,
  body: string,
  options: SelectOption[],
): Promise<void> {
  await createActivity({
    agentSessionId,
    content: { type: "elicitation", body },
    signal: "select",
    signalMetadata: { options },
  });
}

// Plain elicitation (no select buttons) — used for free-text / multi-select questions where the
// user replies with text. The reply comes back as a `prompted` event.
export async function emitElicitation(agentSessionId: string, body: string): Promise<void> {
  await createActivity({ agentSessionId, content: { type: "elicitation", body } });
}

/* ───────────────────────── Session update: externalUrls ───────────────────────── */

const AGENT_SESSION_UPDATE = `
  mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
    agentSessionUpdate(id: $id, input: $input) { success }
  }
`;

export interface ExternalUrl {
  label: string;
  url: string;
}

// Set the PR link on the session (API §5). Setting externalUrls also counts as activity.
export async function setExternalUrls(agentSessionId: string, urls: ExternalUrl[]): Promise<void> {
  await gql(AGENT_SESSION_UPDATE, { id: agentSessionId, input: { externalUrls: urls } });
}

/* ───────────────────────── Issue status sync (plan §7, API §8) ───────────────────────── */

const ISSUE_WORKFLOW_STATES = `
  query IssueWorkflowStates($issueId: String!) {
    issue(id: $issueId) {
      id
      state { id type }
      team {
        states(filter: { type: { eq: "started" } }) {
          nodes { id position type }
        }
      }
    }
  }
`;

const ISSUE_UPDATE = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success }
  }
`;

// When delegated to an issue not already started/completed/canceled, move it to the lowest-
// position "started" state. Best-effort: failures here must never break the session, so the
// caller wraps this in a try/catch step. Defensive against schema drift (optional chaining).
export async function syncIssueToStarted(issueId: string): Promise<void> {
  type StatesResult = {
    issue?: {
      state?: { type?: string };
      team?: { states?: { nodes?: Array<{ id: string; position: number; type: string }> } };
    };
  };
  const data = await gql<StatesResult>(ISSUE_WORKFLOW_STATES, { issueId });
  const currentType = data.issue?.state?.type;
  // Don't move issues that are already underway or closed.
  if (currentType && ["started", "completed", "canceled"].includes(currentType)) return;

  const started = data.issue?.team?.states?.nodes ?? [];
  if (started.length === 0) return;
  const target = [...started].sort((a, b) => a.position - b.position)[0];
  if (!target) return;

  await gql(ISSUE_UPDATE, { id: issueId, input: { stateId: target.id } });
}
