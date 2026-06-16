import { test, expect, describe, beforeEach } from "bun:test";
import { bridgeStream, type SDKLikeMessage } from "./activity-bridge.ts";
import type { LinearClient, PlanItem } from "./linear.ts";
import { testConfig } from "./test-helpers.ts";

interface Recorded {
  thoughts: { body: string; ephemeral?: boolean }[];
  actions: { action: string; parameter?: string }[];
  plans: PlanItem[][];
  responses: string[];
  errors: string[];
}

function recordingLinear(): { client: LinearClient; rec: Recorded } {
  const rec: Recorded = { thoughts: [], actions: [], plans: [], responses: [], errors: [] };
  const client: LinearClient = {
    async thought(_s, body, ephemeral) {
      rec.thoughts.push({ body, ephemeral });
    },
    async action(_s, action, parameter) {
      rec.actions.push({ action, parameter });
    },
    async setPlan(_s, plan) {
      rec.plans.push(plan);
    },
    async setExternalUrls() {},
    async response(_s, body) {
      rec.responses.push(body);
    },
    async error(_s, body) {
      rec.errors.push(body);
    },
  };
  return { client, rec };
}

async function* fromArray(msgs: SDKLikeMessage[]): AsyncIterable<SDKLikeMessage> {
  for (const m of msgs) yield m;
}

beforeEach(() => {
  testConfig({ activityThrottleMs: 0, heartbeatIntervalMs: 60_000 });
});

describe("bridgeStream mapping", () => {
  test("maps init/assistant/tool_use/result to Linear calls + captures session + summary", async () => {
    const { client, rec } = recordingLinear();
    const stream = fromArray([
      { type: "system", subtype: "init", session_id: "cs-1" },
      { type: "assistant", session_id: "cs-1", message: { content: [{ type: "text", text: "Looking at auth" }] } },
      {
        type: "assistant",
        session_id: "cs-1",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } }] },
      },
      { type: "result", subtype: "success", session_id: "cs-1", result: "Plan:\n1. do X" },
    ]);

    const outcome = await bridgeStream(stream, { linear: client, linearSessionId: "s1" });

    expect(outcome.claudeSessionId).toBe("cs-1");
    expect(outcome.resultText).toBe("Plan:\n1. do X");
    expect(outcome.isError).toBe(false);
    expect(rec.thoughts.map((t) => t.body)).toContain("Looking at auth");
    expect(rec.thoughts.every((t) => t.ephemeral === true)).toBe(true);
    expect(rec.actions[0]).toEqual({ action: "Read", parameter: "src/auth.ts" });
    // A plan checklist was published when the tool_use happened, with the confirmed item shape:
    // { content, status } and camelCase statuses.
    expect(rec.plans.length).toBeGreaterThan(0);
    const lastItem = rec.plans.at(-1)!.at(-1)!;
    expect(lastItem.status).toBe("inProgress");
    expect(typeof lastItem.content).toBe("string");
    expect(lastItem.content).toContain("Read");
  });

  test("thinking blocks map to thoughts", async () => {
    const { client, rec } = recordingLinear();
    await bridgeStream(
      fromArray([
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
        { type: "result", subtype: "success", result: "ok" },
      ]),
      { linear: client, linearSessionId: "s1" },
    );
    expect(rec.thoughts.map((t) => t.body)).toContain("hmm");
  });

  test("non-success result marks isError", async () => {
    const { client } = recordingLinear();
    const outcome = await bridgeStream(
      fromArray([{ type: "result", subtype: "error_max_turns", result: "ran out" }]),
      { linear: client, linearSessionId: "s1" },
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.resultText).toBe("ran out");
  });

  test("throttle collapses rapid thoughts", async () => {
    testConfig({ activityThrottleMs: 100000, heartbeatIntervalMs: 60_000 });
    const { client, rec } = recordingLinear();
    let t = 1000;
    await bridgeStream(
      fromArray([
        { type: "assistant", message: { content: [{ type: "text", text: "a" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "b" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "c" }] } },
        { type: "result", subtype: "success", result: "done" },
      ]),
      { linear: client, linearSessionId: "s1", now: () => t },
    );
    // With a huge throttle window and a fixed clock, only the first thought passes.
    expect(rec.thoughts.length).toBe(1);
    void t;
  });

  test("does not publish plan when publishPlan=false", async () => {
    const { client, rec } = recordingLinear();
    await bridgeStream(
      fromArray([
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "x" } }] } },
        { type: "result", subtype: "success", result: "done" },
      ]),
      { linear: client, linearSessionId: "s1", publishPlan: false },
    );
    expect(rec.plans.length).toBe(0);
    expect(rec.actions.length).toBe(1);
  });
});
