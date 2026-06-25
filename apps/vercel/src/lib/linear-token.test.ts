import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Neon-backed token store so we drive the state machine deterministically.
const db = vi.hoisted(() => ({
  readLinearToken: vi.fn(),
  claimLinearRefresh: vi.fn(),
  storeRefreshedToken: vi.fn(),
  markRefreshError: vi.fn(),
}));
vi.mock("./db", () => db);

let tok: typeof import("./linear-token");

beforeAll(async () => {
  process.env.LINEAR_CLIENT_ID = "cid";
  process.env.LINEAR_CLIENT_SECRET = "csecret";
  tok = await import("./linear-token");
});

beforeEach(() => {
  tok.invalidateTokenCache();
  vi.clearAllMocks();
  // markRefreshError is awaited-with-.catch() on the failure path; give it a resolved default so the
  // real error (not a "cannot read .catch of undefined" TypeError) surfaces.
  db.markRefreshError.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const future = (ms: number) => new Date(Date.now() + ms);
const HOUR = 60 * 60_000;

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("getValidAccessToken", () => {
  it("returns the stored token without refreshing when it's fresh", async () => {
    db.readLinearToken.mockResolvedValue({ accessToken: "A", refreshToken: "R", expiresAt: future(5 * HOUR) });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await tok.getValidAccessToken()).toBe("A");
    expect(db.claimLinearRefresh).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes when stale + claim won, stores the rotated pair, returns the new token", async () => {
    db.readLinearToken.mockResolvedValue({ accessToken: "old", refreshToken: "R", expiresAt: future(10 * 60_000) });
    db.claimLinearRefresh.mockResolvedValue({ refreshToken: "R" });
    db.storeRefreshedToken.mockResolvedValue(true);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(tokenResponse({ access_token: "NEW", refresh_token: "R2", expires_in: 86400 }));
    expect(await tok.getValidAccessToken()).toBe("NEW");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(db.storeRefreshedToken).toHaveBeenCalledOnce();
  });

  it("does NOT refresh when the claim is lost; uses the current still-valid token", async () => {
    db.readLinearToken
      .mockResolvedValueOnce({ accessToken: "cur", refreshToken: "R", expiresAt: future(10 * 60_000) })
      .mockResolvedValueOnce({ accessToken: "cur", refreshToken: "R", expiresAt: future(10 * 60_000) });
    db.claimLinearRefresh.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await tok.getValidAccessToken()).toBe("cur");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("discards its own pair and re-reads when the fenced store loses the claim", async () => {
    db.readLinearToken
      .mockResolvedValueOnce({ accessToken: "old", refreshToken: "R", expiresAt: future(10 * 60_000) })
      .mockResolvedValueOnce({ accessToken: "winner", refreshToken: "R3", expiresAt: future(20 * HOUR) });
    db.claimLinearRefresh.mockResolvedValue({ refreshToken: "R" });
    db.storeRefreshedToken.mockResolvedValue(false); // lost the claim mid-flight
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      tokenResponse({ access_token: "mine", refresh_token: "R2", expires_in: 86400 }),
    );
    expect(await tok.getValidAccessToken()).toBe("winner"); // NOT "mine"
  });

  it("throws LinearTokenError + records the error on a permanent invalid_grant", async () => {
    db.readLinearToken.mockResolvedValue({ accessToken: "old", refreshToken: "R", expiresAt: future(10 * 60_000) });
    db.claimLinearRefresh.mockResolvedValue({ refreshToken: "R" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse({ error: "invalid_grant" }, 400));
    await expect(tok.getValidAccessToken()).rejects.toBeInstanceOf(tok.LinearTokenError);
    expect(db.markRefreshError).toHaveBeenCalledOnce();
    expect(db.storeRefreshedToken).not.toHaveBeenCalled();
  });

  it("throws LinearTokenError when the store is not bootstrapped (no row)", async () => {
    db.readLinearToken.mockResolvedValue(null);
    await expect(tok.getValidAccessToken()).rejects.toBeInstanceOf(tok.LinearTokenError);
  });

  it("caches within the invocation: two calls do a single DB read", async () => {
    db.readLinearToken.mockResolvedValue({ accessToken: "A", refreshToken: "R", expiresAt: future(5 * HOUR) });
    await tok.getValidAccessToken();
    await tok.getValidAccessToken();
    expect(db.readLinearToken).toHaveBeenCalledTimes(1);
  });
});
