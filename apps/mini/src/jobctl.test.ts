import { test, expect, describe, beforeEach } from "bun:test";
import { createApp } from "./server.ts";
import { freshDb, testConfig, createJobBody, postJson } from "./test-helpers.ts";
import { registerQuestion, pendingCount } from "./questions.ts";
import type { Database } from "bun:sqlite";
import type { Runner } from "./jobctl.ts";

let d: Database;
beforeEach(() => {
  d = freshDb();
  testConfig();
});

describe("JobController.abort + pending questions", () => {
  test("aborting a running job rejects its pending mid-run question", async () => {
    // A runner that, once started, registers a question for its own job and blocks on it —
    // mirroring what the canUseTool handler does mid-run.
    let questionPromise: Promise<Record<string, string>> | undefined;
    const runner: Runner = async (ctx) => {
      questionPromise = registerQuestion("q-abort", ctx.job.job_id);
      try {
        await questionPromise; // blocks until answered or rejected by abort
        return { status: "succeeded" };
      } catch {
        return { status: "aborted", reason: "aborted" };
      }
    };

    const app = createApp({ database: d, runner, fetchImpl: (async () =>
      new Response(JSON.stringify({ ack: true }), { status: 200 })) as unknown as typeof fetch });
    const created = await app.handleCreateJob(postJson("/jobs", createJobBody()));
    const { jobId } = (await created.json()) as { jobId: string };

    await Bun.sleep(5);
    expect(pendingCount()).toBe(1);

    // Abort via the controller (the /abort route path) → rejectQuestionsForJob unblocks the run.
    const aborted = app.controller.abort(jobId);
    expect(aborted).toBe(true);
    await expect(questionPromise!).rejects.toThrow("aborted");
    expect(pendingCount()).toBe(0);
  });
});
