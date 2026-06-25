// The ONE Linear module (per project) — all GraphQL goes through here so the preview API is
// isolated and pinnable (linear-agents-api.md §intro, plan §7).
//
// The mini emits, DIRECTLY to Linear during runs: streaming thought/action activities, a
// heartbeat thought, and the plan checklist array. Lifecycle activities (ack, elicitation,
// final response/error, externalUrls) are Vercel's job — but helpers exist here for
// completeness/defensiveness.
//
// Several payload shapes are `⚠️ VERIFY` (open-questions §A). We code defensively:
//   - tolerate either mutation arg name where unknown
//   - never let a Linear failure crash the job (callers wrap in try/catch via safe* helpers)
//   - plan item statuses constrained to the documented set
//
// Behind LINEAR_DRY_RUN every call logs instead of hitting the network, so runners are
// testable and dev-runnable without a token.

import { config } from "./config.ts";
import { log } from "./log.ts";

// Plan-array item shape — CONFIRMED by Linear research (linear-agents-api.md): the field is
// `content` (markdown), and statuses are camelCase. The whole array is replaced wholesale on
// each update (individual items can't be patched).
export type PlanItemStatus = "pending" | "inProgress" | "completed" | "canceled";
export interface PlanItem {
  content: string;
  status: PlanItemStatus;
}

export interface LinearClient {
  thought(sessionId: string, body: string, ephemeral?: boolean): Promise<void>;
  action(sessionId: string, action: string, parameter?: string, result?: string, ephemeral?: boolean): Promise<void>;
  setPlan(sessionId: string, plan: PlanItem[]): Promise<void>;
  // AgentSessionExternalUrlInput items are { url, label }. Mostly Vercel's job (it sets the PR
  // link); kept here for completeness.
  setExternalUrls(sessionId: string, urls: { url: string; label: string }[]): Promise<void>;
  response(sessionId: string, body: string): Promise<void>;
  error(sessionId: string, body: string): Promise<void>;
}

interface GraphQLResult<T> {
  data?: T;
  errors?: { message: string }[];
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
  tokenOverride?: string,
): Promise<T | null> {
  const cfg = config();
  // Prefer the per-job token Vercel minted (config().linearAccessToken is the legacy/dev fallback,
  // removed at cutover). When neither is set the caller has already decided to skip (dry-run) or
  // failed the job loudly, so a missing token here is just a defensive no-op.
  const token = tokenOverride ?? cfg.linearAccessToken;
  if (!token) {
    log.warn("Linear token unset (no per-job token, no env fallback); skipping Linear call");
    return null;
  }
  try {
    const res = await fetchImpl(cfg.linearApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      log.warn("Linear HTTP error", { status: res.status });
      return null;
    }
    const json = (await res.json()) as GraphQLResult<T>;
    if (json.errors?.length) {
      log.warn("Linear GraphQL errors", { errors: json.errors.map((e) => e.message) });
      return null;
    }
    return json.data ?? null;
  } catch (err) {
    log.warn("Linear call threw", { err: String(err) });
    return null;
  }
}

const AGENT_ACTIVITY_CREATE = /* GraphQL */ `
  mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) { success agentActivity { id } }
  }
`;

const AGENT_SESSION_UPDATE = /* GraphQL */ `
  mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
    agentSessionUpdate(id: $id, input: $input) { success }
  }
`;

// Real client. Every method is best-effort and never throws (the run must not fail because of
// a Linear hiccup) — failures are logged and swallowed.
// `tokenOverride` is the per-job Linear access token (job-tokens.ts) that Vercel minted for this
// job; runners pass it so the client authenticates with a freshly-rotated token rather than a
// static env credential. Omitted in dry-run / tests, where gql falls back to config or no-ops.
export function makeLinearClient(fetchImpl: typeof fetch = fetch, tokenOverride?: string): LinearClient {
  const dryRun = config().linearDryRun;

  async function activity(input: Record<string, unknown>): Promise<void> {
    if (dryRun) {
      log.info("[linear:dry-run] activity", { input });
      return;
    }
    await gql(AGENT_ACTIVITY_CREATE, { input }, fetchImpl, tokenOverride);
  }

  async function sessionUpdate(sessionId: string, input: Record<string, unknown>): Promise<void> {
    if (dryRun) {
      log.info("[linear:dry-run] sessionUpdate", { sessionId, input });
      return;
    }
    await gql(AGENT_SESSION_UPDATE, { id: sessionId, input }, fetchImpl, tokenOverride);
  }

  return {
    async thought(sessionId, body, ephemeral = true) {
      await activity({ agentSessionId: sessionId, content: { type: "thought", body }, ephemeral });
    },
    async action(sessionId, action, parameter, result, ephemeral = true) {
      const content: Record<string, unknown> = { type: "action", action };
      if (parameter !== undefined) content.parameter = parameter;
      if (result !== undefined) content.result = result;
      await activity({ agentSessionId: sessionId, content, ephemeral });
    },
    async setPlan(sessionId, plan) {
      // plan must be replaced wholesale (linear-agents-api §5). Statuses constrained to the
      // documented enum; unknown values would be rejected by the API.
      await sessionUpdate(sessionId, { plan });
    },
    async setExternalUrls(sessionId, urls) {
      await sessionUpdate(sessionId, { externalUrls: urls });
    },
    async response(sessionId, body) {
      await activity({ agentSessionId: sessionId, content: { type: "response", body } });
    },
    async error(sessionId, body) {
      await activity({ agentSessionId: sessionId, content: { type: "error", body } });
    },
  };
}

// A no-op client for tests/runners that don't care about Linear output.
export function nullLinearClient(): LinearClient {
  return {
    async thought() {},
    async action() {},
    async setPlan() {},
    async setExternalUrls() {},
    async response() {},
    async error() {},
  };
}
