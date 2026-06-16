import { test, expect, describe, beforeEach } from "bun:test";
import { createApp } from "./server.ts";
import { freshDb, testConfig, mockFetch, createJobBody, postJson } from "./test-helpers.ts";
import type { Database } from "bun:sqlite";
import { getJob } from "./db.ts";
import type { Runner } from "./jobctl.ts";

// A controllable runner: resolves when we tell it to, observes the abort signal.
function manualRunner() {
  let resolveFn: ((r: { status: "succeeded" | "failed" | "aborted"; planSummary?: string }) => void) | null = null;
  const started: string[] = [];
  const runner: Runner = (ctx) => {
    started.push(ctx.job.job_id);
    return new Promise((resolve) => {
      resolveFn = resolve;
      ctx.signal.addEventListener("abort", () => resolve({ status: "aborted", reason: "aborted" }));
    });
  };
  return {
    runner,
    started,
    finish: (r: { status: "succeeded" | "failed" | "aborted"; planSummary?: string } = { status: "succeeded" }) =>
      resolveFn?.(r),
  };
}

let d: Database;
beforeEach(() => {
  d = freshDb();
  testConfig();
});

describe("POST /jobs", () => {
  test("creates a job and returns jobId (200)", async () => {
    const mf = mockFetch();
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleCreateJob(postJson("/jobs", createJobBody()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string; queued: boolean };
    expect(body.jobId).toBeTruthy();
    expect(body.queued).toBe(false);
    expect(getJob(d, body.jobId)?.status).toBe("running");
    void mf;
  });

  test("idempotent: same key returns same jobId, no second job", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const r1 = await app.handleCreateJob(postJson("/jobs", createJobBody()));
    const r2 = await app.handleCreateJob(postJson("/jobs", createJobBody()));
    const b1 = (await r1.json()) as { jobId: string };
    const b2 = (await r2.json()) as { jobId: string };
    expect(b2.jobId).toBe(b1.jobId);
    const count = d.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("409 on contract version mismatch (with contractVersion in body)", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleCreateJob(postJson("/jobs", createJobBody({ contractVersion: "2.0.0" })));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; contractVersion: string };
    expect(body.error).toBe("contract-version-mismatch");
    expect(body.contractVersion).toBe("1.0.0");
  });

  test("400 on validation failure (revise without feedback)", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleCreateJob(
      postJson("/jobs", createJobBody({ kind: "revise", idempotencyKey: "s1:revise:1" })),
    );
    expect(res.status).toBe(400);
  });

  test("403 when CF Access enforced and headers missing", async () => {
    testConfig({ enforceCfAccess: true, cfAccessClientId: "id", cfAccessClientSecret: "sec" });
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleCreateJob(postJson("/jobs", createJobBody()));
    expect(res.status).toBe(403);
  });

  test("passes CF Access when headers present", async () => {
    testConfig({ enforceCfAccess: true, cfAccessClientId: "id", cfAccessClientSecret: "sec" });
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleCreateJob(
      postJson("/jobs", createJobBody(), { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "sec" }),
    );
    expect(res.status).toBe(200);
  });

  test("over-cap execute job is queued (202)", async () => {
    testConfig({ maxConcurrentExecutions: 1 });
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const r1 = await app.handleCreateJob(
      postJson("/jobs", createJobBody({ kind: "execute", idempotencyKey: "s1:execute:0", feedback: undefined })),
    );
    expect(r1.status).toBe(200);
    const r2 = await app.handleCreateJob(
      postJson("/jobs", createJobBody({ kind: "execute", linearSessionId: "s2", idempotencyKey: "s2:execute:0" })),
    );
    expect(r2.status).toBe(202);
    expect(((await r2.json()) as { queued: boolean }).queued).toBe(true);
  });
});

describe("POST /jobs/:id/abort", () => {
  test("aborts a running job", async () => {
    const m = manualRunner();
    const app = createApp({ database: d, runner: m.runner });
    const created = await app.handleCreateJob(postJson("/jobs", createJobBody()));
    const { jobId } = (await created.json()) as { jobId: string };
    const res = await app.handleAbort(jobId, postJson(`/jobs/${jobId}/abort`, {}));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { aborted: boolean }).aborted).toBe(true);
  });

  test("unknown job => aborted:false (idempotent no-op)", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleAbort("nope", postJson(`/jobs/nope/abort`, {}));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { aborted: boolean }).aborted).toBe(false);
  });
});

describe("POST /jobs/reap", () => {
  const reapBody = (overrides: Record<string, unknown> = {}) => ({
    contractVersion: "1.0.0",
    linearSessionId: "s1",
    ...overrides,
  });

  test("unknown session => reaped:false (idempotent no-op), still 200", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleReap(postJson("/jobs/reap", reapBody({ linearSessionId: "never-existed" })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linearSessionId: string; reaped: boolean };
    expect(body.linearSessionId).toBe("never-existed");
    expect(body.reaped).toBe(false);
  });

  test("409 on contract version mismatch (with contractVersion in body)", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleReap(postJson("/jobs/reap", reapBody({ contractVersion: "9.9.9" })));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; contractVersion: string };
    expect(body.error).toBe("contract-version-mismatch");
    expect(body.contractVersion).toBe("1.0.0");
  });

  test("400 on missing linearSessionId", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleReap(postJson("/jobs/reap", { contractVersion: "1.0.0" }));
    expect(res.status).toBe(400);
  });

  test("403 when CF Access enforced and headers missing", async () => {
    testConfig({ enforceCfAccess: true, cfAccessClientId: "id", cfAccessClientSecret: "sec" });
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleReap(postJson("/jobs/reap", reapBody()));
    expect(res.status).toBe(403);
  });

  test("routes via fetch dispatcher (not matched by abort regex)", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.fetch(postJson("/jobs/reap", reapBody({ linearSessionId: "x" })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reaped: boolean }).reaped).toBe(false);
  });
});

describe("GET /healthz", () => {
  test("reports shape", async () => {
    testConfig({ maxConcurrentExecutions: 2 });
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = app.handleHealthz();
    const body = (await res.json()) as { ok: boolean; runningJobs: number; maxConcurrentExecutions: number };
    expect(body.ok).toBe(true);
    expect(body.maxConcurrentExecutions).toBe(2);
    expect(typeof body.runningJobs).toBe("number");
  });
});

describe("fetch dispatcher + end-to-end callback", () => {
  test("completed job fires a callback with bearer + succeeded", async () => {
    const mf = mockFetch();
    const m = manualRunner();
    const app = createApp({ database: d, runner: m.runner, fetchImpl: mf.fn });
    const created = await app.fetch(postJson("/jobs", createJobBody()));
    const { jobId } = (await created.json()) as { jobId: string };

    m.finish({ status: "succeeded", planSummary: "done" });
    // Allow the async run().finally chain (update + sendCallback) to settle.
    await Bun.sleep(20);

    const delivered = mf.calls.find((c) => (c.body as { jobId?: string })?.jobId === jobId);
    expect(delivered).toBeTruthy();
    expect(delivered!.headers["authorization"]).toBe("Bearer test-secret");
    expect((delivered!.body as { status: string }).status).toBe("succeeded");
    expect((delivered!.body as { contractVersion: string }).contractVersion).toBe("1.0.0");
    // Outbox cleared on 2xx.
    const { getCallback } = await import("./db.ts");
    expect(getCallback(d, jobId)).toBeNull();
  });

  test("DRY_RUN fake job flows start -> succeeded callback", async () => {
    testConfig({ dryRunJobs: true });
    process.env.DRY_RUN_JOB_MS = "5";
    const mf = mockFetch();
    const app = createApp({ database: d, fetchImpl: mf.fn });
    const created = await app.fetch(postJson("/jobs", createJobBody()));
    const { jobId } = (await created.json()) as { jobId: string };
    await Bun.sleep(40);
    const delivered = mf.calls.find((c) => (c.body as { jobId?: string })?.jobId === jobId);
    expect(delivered).toBeTruthy();
    expect((delivered!.body as { status: string }).status).toBe("succeeded");
    delete process.env.DRY_RUN_JOB_MS;
  });
});
