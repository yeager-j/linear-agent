import { afterEach, describe, expect, it, vi } from "vitest";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import {
  __setSqlForTests,
  claimDelivery,
  getSession,
  insertSession,
  claimLinearRefresh,
  storeRefreshedToken,
  readLinearToken,
} from "./db";

afterEach(() => {
  __setSqlForTests(null);
  vi.restoreAllMocks();
});

// Build a fake tagged-template `sql` that returns a queued result per call.
function fakeSql(results: unknown[][]): NeonQueryFunction<false, false> {
  let i = 0;
  const fn = (..._args: unknown[]) => Promise.resolve(results[i++] ?? []);
  return fn as unknown as NeonQueryFunction<false, false>;
}

describe("linear token store", () => {
  it("claimLinearRefresh returns the refresh token when the claim is won", async () => {
    __setSqlForTests(fakeSql([[{ refresh_token: "rt" }]]));
    expect(await claimLinearRefresh("c1", 120)).toEqual({ refreshToken: "rt" });
  });

  it("claimLinearRefresh returns null when a claim is already held", async () => {
    __setSqlForTests(fakeSql([[]]));
    expect(await claimLinearRefresh("c1", 120)).toBeNull();
  });

  it("storeRefreshedToken returns true when the fence matches", async () => {
    __setSqlForTests(fakeSql([[{ id: "linear" }]]));
    expect(
      await storeRefreshedToken("c1", { accessToken: "a", refreshToken: "r", expiresAt: new Date() }),
    ).toBe(true);
  });

  it("storeRefreshedToken returns false when the fence does not match (claim lost)", async () => {
    __setSqlForTests(fakeSql([[]]));
    expect(
      await storeRefreshedToken("c1", { accessToken: "a", refreshToken: "r", expiresAt: new Date() }),
    ).toBe(false);
  });

  it("readLinearToken returns null when there is no row", async () => {
    __setSqlForTests(fakeSql([[]]));
    expect(await readLinearToken()).toBeNull();
  });
});

describe("claimDelivery", () => {
  it("returns true when the delivery is new (row returned)", async () => {
    __setSqlForTests(fakeSql([[{ delivery_id: "d1" }]]));
    expect(await claimDelivery("d1")).toBe(true);
  });

  it("returns false on a duplicate (no row returned)", async () => {
    __setSqlForTests(fakeSql([[]]));
    expect(await claimDelivery("d1")).toBe(false);
  });
});

describe("sessions", () => {
  it("inserts a session row without throwing", async () => {
    __setSqlForTests(fakeSql([[]]));
    await expect(
      insertSession({ linearSessionId: "s", workflowRunId: "r", issueIdentifier: "ENG-1" }),
    ).resolves.toBeUndefined();
  });

  it("reads a session row back", async () => {
    __setSqlForTests(fakeSql([[{ workflow_run_id: "r1", issue_identifier: "ENG-2" }]]));
    expect(await getSession("s")).toEqual({ workflowRunId: "r1", issueIdentifier: "ENG-2" });
  });

  it("returns null when no session row exists", async () => {
    __setSqlForTests(fakeSql([[]]));
    expect(await getSession("missing")).toBeNull();
  });
});
