import { afterEach, describe, expect, it, vi } from "vitest";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { __setSqlForTests, claimDelivery, getSession, insertSession } from "./db";

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
