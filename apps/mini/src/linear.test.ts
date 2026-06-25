import { test, expect, describe, beforeEach } from "bun:test";
import { makeLinearClient } from "./linear.ts";
import { testConfig } from "./test-helpers.ts";

interface CapturedReq {
  url: string;
  authorization: string | undefined;
  body: unknown;
}

// A fetch double that records the request and returns a successful GraphQL response.
function recordingFetch(): { fn: typeof fetch; calls: CapturedReq[] } {
  const calls: CapturedReq[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({
      url: String(url),
      authorization: h.get("authorization") ?? undefined,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify({ data: { agentActivityCreate: { success: true } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("makeLinearClient token handling", () => {
  beforeEach(() => {
    testConfig({ linearAccessToken: "env-fallback-token", linearDryRun: false });
  });

  test("uses the per-job tokenOverride in the Authorization header (raw, no Bearer)", async () => {
    const { fn, calls } = recordingFetch();
    const client = makeLinearClient(fn, "per-job-token");
    await client.thought("s1", "hi", false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBe("per-job-token");
  });

  test("falls back to the config token when no override is given", async () => {
    const { fn, calls } = recordingFetch();
    const client = makeLinearClient(fn);
    await client.thought("s1", "hi", false);
    expect(calls[0]!.authorization).toBe("env-fallback-token");
  });

  test("skips the call (no fetch) when neither override nor config token is set", async () => {
    testConfig({ linearAccessToken: undefined, linearDryRun: false });
    const { fn, calls } = recordingFetch();
    const client = makeLinearClient(fn);
    await client.thought("s1", "hi", false);
    expect(calls).toHaveLength(0);
  });
});
