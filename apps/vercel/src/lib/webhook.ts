// Defensive parsing of the Linear AgentSessionEvent webhook envelope. Every field that is a
// `⚠️ VERIFY` item in shared/open-questions.md / linear-agents-api.md is read tolerantly here, so
// payload-shape drift degrades gracefully instead of hard-failing. This module does NO IO.

export type WebhookAction = "created" | "prompted" | "stop" | "unknown";

export interface ParsedCreated {
  action: "created";
  linearSessionId: string;
  issueId?: string;
  issueIdentifier: string;
  promptContext: string;
}

export interface ParsedPrompted {
  action: "prompted";
  linearSessionId: string;
  text: string;
  selectValue?: string;
  signal?: "stop";
}

export type ParsedWebhook = ParsedCreated | ParsedPrompted | { action: "stop" | "unknown"; linearSessionId?: string };

// Narrow `unknown` JSON safely.
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function getDeliveryId(headers: Headers, body: Record<string, unknown>): string | null {
  // Prefer the `Linear-Delivery` header (UUIDv4 per delivery); fall back to
  // `${webhookId}:${webhookTimestamp}` (open-questions.md #3, contract §4).
  const delivery = headers.get("linear-delivery");
  if (delivery) return delivery;
  const webhookId = str(body.webhookId);
  const ts = body.webhookTimestamp;
  if (webhookId && (typeof ts === "number" || typeof ts === "string")) {
    return `${webhookId}:${ts}`;
  }
  return null;
}

export function parseWebhook(body: Record<string, unknown>): ParsedWebhook {
  const rawAction = str(body.action) ?? "unknown";
  const session = obj(body.agentSession);
  const activity = obj(body.agentActivity);
  const linearSessionId = str(session.id) ?? str(body.agentSessionId);

  // Stop signal: confirmed it arrives as agentActivity.signal === "stop" inside a `prompted`
  // event; also handle a standalone top-level action: "stop" defensively (open-questions.md #1).
  const activitySignal = str(activity.signal);
  const isStop = activitySignal === "stop" || rawAction === "stop";

  if (rawAction === "created") {
    const issue = obj(session.issue);
    return {
      action: "created",
      linearSessionId: linearSessionId ?? "",
      issueId: str(issue.id),
      // identifier may be absent in some payloads; fall back to the session id for logging/branch.
      issueIdentifier: str(issue.identifier) ?? linearSessionId ?? "unknown",
      // promptContext is a WEBHOOK-ENVELOPE field on `created`, NOT a GraphQL field. (agentSession.context
      // in the schema = related entities, not the prompt text, and isn't queryable.) Exact path is the
      // last open VERIFY item — read defensively: top-level promptContext, then agentSession.promptContext.
      promptContext: str(body.promptContext) ?? str(session.promptContext) ?? "",
    };
  }

  if (rawAction === "prompted" || activitySignal) {
    const content = obj(activity.content);
    // Prompt text: authoritative location unconfirmed -> read both (open-questions.md #5).
    const text = str(content.body) ?? str(activity.body) ?? "";
    // Select value: tolerate either content.value or signalMetadata.value.
    const selectValue =
      str(content.value) ?? str(obj(activity.signalMetadata).value) ?? str(activity.value);
    return {
      action: "prompted",
      linearSessionId: linearSessionId ?? "",
      text,
      selectValue,
      signal: isStop ? "stop" : undefined,
    };
  }

  if (isStop) {
    return { action: "stop", linearSessionId };
  }

  return { action: "unknown", linearSessionId };
}
