import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the token authority so we control what gql() authenticates with and observe cache busting.
const tokenMod = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(async () => "tok"),
  invalidateTokenCache: vi.fn(),
  LinearTokenError: class LinearTokenError extends Error {},
}));
vi.mock("./linear-token", () => tokenMod);

let linear: typeof import("./linear");

beforeAll(async () => {
  process.env.LINEAR_WEBHOOK_SECRET = "whsec";
  linear = await import("./linear");
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

const okActivity = () =>
  new Response(JSON.stringify({ data: { agentActivityCreate: { success: true } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("gql reactive 401 handling", () => {
  it("invalidates the cache, refreshes, and retries once on a 401", async () => {
    tokenMod.getValidAccessToken.mockResolvedValueOnce("stale").mockResolvedValueOnce("fresh");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(okActivity());

    await linear.emitThought("s1", "hi");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(tokenMod.invalidateTokenCache).toHaveBeenCalledOnce();
    const secondInit = fetchSpy.mock.calls[1]![1] as RequestInit;
    expect((secondInit.headers as Record<string, string>).Authorization).toBe("fresh");
  });

  it("throws LinearTokenError after a second consecutive 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(linear.emitThought("s1", "hi")).rejects.toBeInstanceOf(tokenMod.LinearTokenError);
  });
});
