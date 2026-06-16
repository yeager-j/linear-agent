import { test, expect, describe, beforeEach } from "bun:test";
import { freshDb, testConfig, mockFetch } from "./test-helpers.ts";
import { sendCallback, flushDueCallbacks } from "./callback.ts";
import { getCallback } from "./db.ts";
import type { Database } from "bun:sqlite";

let d: Database;
beforeEach(() => {
  d = freshDb();
  testConfig();
});

const base = {
  jobId: "j1",
  linearSessionId: "s1",
  kind: "plan" as const,
  status: "succeeded" as const,
  planSummary: "ok",
};

describe("sendCallback", () => {
  test("delivers and clears the outbox on 2xx", async () => {
    const mf = mockFetch();
    await sendCallback(base, { database: d, fetchImpl: mf.fn });
    expect(mf.calls.length).toBe(1);
    expect(mf.calls[0]!.headers["authorization"]).toBe("Bearer test-secret");
    expect((mf.calls[0]!.body as { contractVersion: string }).contractVersion).toBe("1.0.0");
    expect(getCallback(d, "j1")).toBeNull(); // cleared
  });

  test("persists and retries on failure, then succeeds via flush", async () => {
    const mf = mockFetch({ failTimes: 1 });
    await sendCallback(base, { database: d, fetchImpl: mf.fn });
    // First attempt failed -> still in outbox, attempts bumped, next_attempt scheduled.
    const row = getCallback(d, "j1");
    expect(row).not.toBeNull();
    expect(row!.attempts).toBe(1);

    // Make it due and flush; second attempt succeeds.
    d.query("UPDATE callbacks SET next_attempt_at = 0 WHERE job_id = 'j1'").run();
    await flushDueCallbacks({ database: d, fetchImpl: mf.fn });
    expect(getCallback(d, "j1")).toBeNull();
    expect(mf.calls.length).toBe(2);
  });

  test("backoff schedules a future next_attempt_at on failure", async () => {
    const mf = mockFetch({ failTimes: 1 });
    const before = Date.now();
    await sendCallback(base, { database: d, fetchImpl: mf.fn });
    const row = getCallback(d, "j1")!;
    expect(row.next_attempt_at).toBeGreaterThan(before);
  });

  test("409 contract-version-mismatch is FATAL: drops from outbox, no retry", async () => {
    let calls = 0;
    const fatal409: typeof fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "contract-version-mismatch", contractVersion: "1.0.0" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await sendCallback(base, { database: d, fetchImpl: fatal409 });
    // Dropped immediately — not retried to MAX_ATTEMPTS, not left in the outbox.
    expect(getCallback(d, "j1")).toBeNull();
    expect(calls).toBe(1);

    // A subsequent flush finds nothing to deliver (no further attempts).
    await flushDueCallbacks({ database: d, fetchImpl: fatal409 });
    expect(calls).toBe(1);
  });
});
