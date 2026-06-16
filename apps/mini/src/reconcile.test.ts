import { test, expect, describe, beforeEach } from "bun:test";
import { freshDb, testConfig, mockFetch } from "./test-helpers.ts";
import { insertJob, getJob } from "./db.ts";
import { reconcileOnBoot } from "./reconcile.ts";
import type { Database } from "bun:sqlite";

let d: Database;
beforeEach(() => {
  d = freshDb();
  testConfig();
});

describe("reconcileOnBoot", () => {
  test("marks a stuck running job failed/interrupted and fires a callback", async () => {
    insertJob(d, {
      job_id: "j1",
      linear_session_id: "s1",
      issue_identifier: "ENG-1",
      kind: "execute",
      idempotency_key: "s1:execute:0",
      status: "running",
    });
    const mf = mockFetch();
    await reconcileOnBoot({ database: d, fetchImpl: mf.fn });

    expect(getJob(d, "j1")?.status).toBe("failed");
    expect(getJob(d, "j1")?.reason).toBe("interrupted");

    const cb = mf.calls.find((c) => (c.body as { jobId?: string })?.jobId === "j1")!;
    expect(cb).toBeTruthy();
    expect((cb.body as { status: string }).status).toBe("failed");
    expect((cb.body as { reason: string }).reason).toBe("interrupted");
  });

  test("the interrupt callback carries the job's claudeSessionId for continuity (TEST-6)", async () => {
    insertJob(d, {
      job_id: "j3",
      linear_session_id: "s3",
      issue_identifier: "ENG-3",
      kind: "execute",
      idempotency_key: "s3:execute:0",
      claude_session_id: "claude-abc",
      status: "running",
    });
    const mf = mockFetch();
    await reconcileOnBoot({ database: d, fetchImpl: mf.fn });
    const cb = mf.calls.find((c) => (c.body as { jobId?: string })?.jobId === "j3")!;
    expect(cb).toBeTruthy();
    expect((cb.body as { claudeSessionId?: string }).claudeSessionId).toBe("claude-abc");
  });

  test("leaves non-running jobs alone", async () => {
    insertJob(d, {
      job_id: "j2",
      linear_session_id: "s2",
      issue_identifier: "ENG-2",
      kind: "plan",
      idempotency_key: "s2:plan:0",
      status: "done",
    });
    const mf = mockFetch();
    await reconcileOnBoot({ database: d, fetchImpl: mf.fn });
    expect(getJob(d, "j2")?.status).toBe("done");
    expect(mf.calls.length).toBe(0);
  });
});
