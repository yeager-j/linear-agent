import { test, expect, describe, beforeEach } from "bun:test";
import { createApp } from "./server.ts";
import { freshDb, testConfig, createJobBody, postJson, mockFetch } from "./test-helpers.ts";
import { registerQuestion, pendingCount } from "./questions.ts";
import type { Database } from "bun:sqlite";
import type { Runner, RunnerResult } from "./jobctl.ts";

let d: Database;
beforeEach(() => {
  d = freshDb();
  testConfig();
});

// A runner whose jobs block until explicitly finished, so we can observe queueing + self-start.
function controllableRunner() {
  const resolvers = new Map<string, (r: RunnerResult) => void>();
  const started: string[] = [];
  const runner: Runner = (ctx) => {
    started.push(ctx.job.job_id);
    return new Promise<RunnerResult>((resolve) => resolvers.set(ctx.job.job_id, resolve));
  };
  return {
    runner,
    started,
    finish: (jobId: string, r: RunnerResult = { status: "succeeded" }) => resolvers.get(jobId)?.(r),
  };
}

describe("JobController concurrency caps (TEST-2)", () => {
  test("queues a plan over maxConcurrentPlans and self-starts it when a slot frees", async () => {
    testConfig({ maxConcurrentPlans: 1, maxConcurrentExecutions: 1 });
    const mf = mockFetch();
    const r = controllableRunner();
    const app = createApp({ database: d, runner: r.runner, fetchImpl: mf.fn });

    const a = await app.handleCreateJob(postJson("/jobs", createJobBody({ idempotencyKey: "s1:plan:0" })));
    expect(a.status).toBe(200);
    const b = await app.handleCreateJob(
      postJson("/jobs", createJobBody({ linearSessionId: "s2", idempotencyKey: "s2:plan:0" })),
    );
    expect(b.status).toBe(202); // over the plan cap → queued

    const { jobId: idA } = (await a.json()) as { jobId: string };
    const { jobId: idB } = (await b.json()) as { jobId: string };
    expect(r.started).toContain(idA);
    expect(r.started).not.toContain(idB);

    r.finish(idA, { status: "succeeded" }); // frees the plan slot → drainQueue starts B
    await Bun.sleep(20);
    expect(r.started).toContain(idB);

    r.finish(idB, { status: "succeeded" });
    await Bun.sleep(20);
    expect(
      mf.calls.some(
        (c) => (c.body as { jobId?: string; status?: string })?.jobId === idB &&
          (c.body as { status?: string })?.status === "succeeded",
      ),
    ).toBe(true);
  });

  test("a saturated execute slot does not block a plan (independent caps)", async () => {
    testConfig({ maxConcurrentExecutions: 1, maxConcurrentPlans: 1 });
    const mf = mockFetch();
    const r = controllableRunner();
    const app = createApp({ database: d, runner: r.runner, fetchImpl: mf.fn });

    const e = await app.handleCreateJob(
      postJson("/jobs", createJobBody({ kind: "execute", idempotencyKey: "s1:execute:0" })),
    );
    expect(e.status).toBe(200); // execute slot taken

    const p = await app.handleCreateJob(
      postJson("/jobs", createJobBody({ kind: "plan", linearSessionId: "s2", idempotencyKey: "s2:plan:0" })),
    );
    expect(p.status).toBe(200); // plan starts on its own cap, unaffected by the execute slot
    const { jobId: idP } = (await p.json()) as { jobId: string };
    expect(r.started).toContain(idP);
  });
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
