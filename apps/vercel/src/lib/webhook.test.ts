import { describe, expect, it } from "vitest";
import { getDeliveryId, parseWebhook } from "./webhook";

const createdBody = {
  action: "created",
  agentSession: {
    id: "sess_123",
    promptContext: "<issue>ENG-1</issue>",
    issue: { id: "issue_abc", identifier: "ENG-1", title: "T" },
  },
  webhookId: "wh_1",
  webhookTimestamp: 1718452800000,
};

describe("getDeliveryId", () => {
  it("prefers the Linear-Delivery header", () => {
    const headers = new Headers({ "Linear-Delivery": "uuid-1" });
    expect(getDeliveryId(headers, createdBody)).toBe("uuid-1");
  });

  it("falls back to webhookId:webhookTimestamp", () => {
    expect(getDeliveryId(new Headers(), createdBody)).toBe("wh_1:1718452800000");
  });

  it("returns null when nothing identifies the delivery", () => {
    expect(getDeliveryId(new Headers(), { action: "created" })).toBeNull();
  });
});

describe("parseWebhook — created", () => {
  it("extracts session, issue, and promptContext", () => {
    const parsed = parseWebhook(createdBody);
    expect(parsed).toMatchObject({
      action: "created",
      linearSessionId: "sess_123",
      issueId: "issue_abc",
      issueIdentifier: "ENG-1",
      promptContext: "<issue>ENG-1</issue>",
    });
  });

  it("falls back to the session id when issue identifier is absent", () => {
    const parsed = parseWebhook({
      action: "created",
      agentSession: { id: "sess_x", issue: {} },
    });
    expect(parsed).toMatchObject({ issueIdentifier: "sess_x" });
  });

  it("treats an empty-string field as absent (str rejects empty, not just null)", () => {
    const parsed = parseWebhook({
      action: "created",
      agentSession: { id: "sess_e", issue: { identifier: "" } },
    });
    // "" must be treated as missing → fall back to the session id, not surface "".
    expect(parsed).toMatchObject({ issueIdentifier: "sess_e" });
  });

  it("prefers a top-level envelope promptContext over agentSession.promptContext", () => {
    const parsed = parseWebhook({
      action: "created",
      promptContext: "TOP LEVEL",
      agentSession: { id: "s", promptContext: "NESTED", issue: { identifier: "ENG-9" } },
    });
    expect(parsed).toMatchObject({ promptContext: "TOP LEVEL" });
  });

  it("falls back to agentSession.promptContext when no top-level field", () => {
    const parsed = parseWebhook({
      action: "created",
      agentSession: { id: "s", promptContext: "NESTED", issue: { identifier: "ENG-9" } },
    });
    expect(parsed).toMatchObject({ promptContext: "NESTED" });
  });
});

describe("parseWebhook — prompted", () => {
  it("reads text from content.body", () => {
    const parsed = parseWebhook({
      action: "prompted",
      agentSession: { id: "s" },
      agentActivity: { content: { type: "prompt", body: "please change X" } },
    });
    expect(parsed).toMatchObject({ action: "prompted", text: "please change X" });
  });

  it("falls back to activity.body for text", () => {
    const parsed = parseWebhook({
      action: "prompted",
      agentSession: { id: "s" },
      agentActivity: { body: "top-level text" },
    });
    expect(parsed).toMatchObject({ text: "top-level text" });
  });

  it("reads the select value defensively from content.value or signalMetadata.value", () => {
    expect(
      parseWebhook({
        action: "prompted",
        agentSession: { id: "s" },
        agentActivity: { content: { value: "approve" } },
      }),
    ).toMatchObject({ selectValue: "approve" });

    expect(
      parseWebhook({
        action: "prompted",
        agentSession: { id: "s" },
        agentActivity: { signalMetadata: { value: "request_changes" } },
      }),
    ).toMatchObject({ selectValue: "request_changes" });
  });

  it("detects a stop signal delivered inside a prompted event", () => {
    const parsed = parseWebhook({
      action: "prompted",
      agentSession: { id: "s" },
      agentActivity: { signal: "stop", body: "stop please" },
    });
    expect(parsed).toMatchObject({ action: "prompted", signal: "stop" });
  });
});

describe("parseWebhook — standalone stop / unknown", () => {
  it("handles a top-level stop action defensively", () => {
    const parsed = parseWebhook({ action: "stop", agentSession: { id: "s" } });
    // signal-on-prompted is primary, but a bare stop is routed as a stop too.
    expect(["stop", "prompted"]).toContain(parsed.action);
  });

  it("returns unknown for unrecognized actions", () => {
    const parsed = parseWebhook({ action: "somethingElse", agentSession: { id: "s" } });
    expect(parsed.action).toBe("unknown");
  });
});
