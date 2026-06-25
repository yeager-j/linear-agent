import { test, expect, describe, beforeEach } from "bun:test";
import { createApp } from "./server.ts";
import { freshDb, testConfig, mockFetch, createJobBody, postJson, getAuthed } from "./test-helpers.ts";
import type { Database } from "bun:sqlite";
import { getJob } from "./db.ts";
import { getJobToken, deleteJobToken } from "./job-tokens.ts";
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

  test("stores the per-job Linear token; idempotent hit does not overwrite", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const r1 = await app.handleCreateJob(postJson("/jobs", createJobBody({ linearAccessToken: "tok-1" })));
    const { jobId } = (await r1.json()) as { jobId: string };
    expect(getJobToken(jobId)).toBe("tok-1");
    // Same idempotency key, different token => same job, original token preserved (no overwrite).
    const r2 = await app.handleCreateJob(postJson("/jobs", createJobBody({ linearAccessToken: "tok-2" })));
    const b2 = (await r2.json()) as { jobId: string };
    expect(b2.jobId).toBe(jobId);
    expect(getJobToken(jobId)).toBe("tok-1");
    deleteJobToken(jobId);
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

describe("POST /jobs/:id/answer", () => {
  const answerBody = (overrides: Record<string, unknown> = {}) => ({
    contractVersion: "1.0.0",
    questionId: "q1",
    answers: { "Which DB?": "Postgres" },
    ...overrides,
  });

  test("delivers answers to a pending question (delivered:true)", async () => {
    const { registerQuestion, pendingCount } = await import("./questions.ts");
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const p = registerQuestion("q1", "job-x");
    const res = await app.handleAnswer("job-x", postJson("/jobs/job-x/answer", answerBody()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { questionId: string; delivered: boolean };
    expect(body.questionId).toBe("q1");
    expect(body.delivered).toBe(true);
    await expect(p).resolves.toEqual({ "Which DB?": "Postgres" });
    expect(pendingCount()).toBe(0);
  });

  test("unknown/stale question => delivered:false, still 200", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleAnswer("job-x", postJson("/jobs/job-x/answer", answerBody({ questionId: "ghost" })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { delivered: boolean }).delivered).toBe(false);
  });

  test("409 on contract version mismatch (with contractVersion in body)", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleAnswer("job-x", postJson("/jobs/job-x/answer", answerBody({ contractVersion: "9.9.9" })));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; contractVersion: string };
    expect(body.error).toBe("contract-version-mismatch");
    expect(body.contractVersion).toBe("1.0.0");
  });

  test("400 on missing questionId", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleAnswer("job-x", postJson("/jobs/job-x/answer", { contractVersion: "1.0.0", answers: {} }));
    expect(res.status).toBe(400);
  });

  test("403 when CF Access enforced and headers missing", async () => {
    testConfig({ enforceCfAccess: true, cfAccessClientId: "id", cfAccessClientSecret: "sec" });
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleAnswer("job-x", postJson("/jobs/job-x/answer", answerBody({ questionId: "x" })));
    expect(res.status).toBe(403);
  });

  test("routes via fetch dispatcher (distinct from /abort)", async () => {
    const { registerQuestion } = await import("./questions.ts");
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    registerQuestion("q-route", "job-y");
    const res = await app.fetch(postJson("/jobs/job-y/answer", answerBody({ questionId: "q-route" })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { delivered: boolean }).delivered).toBe(true);
  });
});

describe("GET /healthz", () => {
  test("reports shape", async () => {
    testConfig({ maxConcurrentExecutions: 2 });
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = app.handleHealthz(getAuthed("/healthz"));
    const body = (await res.json()) as { ok: boolean; runningJobs: number; maxConcurrentExecutions: number };
    expect(body.ok).toBe(true);
    expect(body.maxConcurrentExecutions).toBe(2);
    expect(typeof body.runningJobs).toBe("number");
  });
});

describe("bearer auth (SEC-1)", () => {
  test("401 when the bearer is missing or wrong, on every endpoint", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const wrong = { Authorization: "Bearer nope" };
    const missing = { Authorization: "" };
    for (const headers of [wrong, missing]) {
      expect((await app.handleCreateJob(postJson("/jobs", createJobBody(), headers))).status).toBe(401);
      expect((await app.handleAbort("j", postJson("/jobs/j/abort", {}, headers))).status).toBe(401);
      expect(
        (await app.handleReap(postJson("/jobs/reap", { contractVersion: "1.0.0", linearSessionId: "s" }, headers)))
          .status,
      ).toBe(401);
      expect((app.handleHealthz(getAuthed("/healthz", headers))).status).toBe(401);
    }
    // A request with no Authorization header at all is also rejected.
    const bare = new Request("http://mini.test/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createJobBody()),
    });
    expect((await app.handleCreateJob(bare)).status).toBe(401);
  });

  test("fails CLOSED: 401 even with a valid CF token when MINI_AUTH_SECRET is unset", async () => {
    testConfig({ miniAuthSecret: undefined });
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const res = await app.handleCreateJob(postJson("/jobs", createJobBody()));
    expect(res.status).toBe(401);
  });
});

describe("CF Access fail-closed (SEC-3)", () => {
  test("403 when ENFORCE_CF_ACCESS is on but the CF tokens are unconfigured", async () => {
    testConfig({ enforceCfAccess: true, cfAccessClientId: undefined, cfAccessClientSecret: undefined });
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    // Valid bearer (postJson default) so we reach the CF check; it must NOT silently allow-all.
    const res = await app.handleCreateJob(postJson("/jobs", createJobBody()));
    expect(res.status).toBe(403);
  });
});

describe("idempotency-key conflict (SEC-5)", () => {
  test("409 when the same key is reused for a different session/kind", async () => {
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    await app.handleCreateJob(postJson("/jobs", createJobBody({ idempotencyKey: "shared:key" })));
    const res = await app.handleCreateJob(
      postJson("/jobs", createJobBody({ linearSessionId: "different", idempotencyKey: "shared:key" })),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("idempotency-key-conflict");
  });
});

describe("answer is bound to its jobId (SEC-6)", () => {
  test("an answer for the wrong jobId does not resolve another job's question", async () => {
    const { registerQuestion, pendingCount, rejectQuestionsForJob } = await import("./questions.ts");
    const app = createApp({ database: d, runner: () => new Promise(() => {}) });
    const before = pendingCount();
    const p = registerQuestion("q-sec6", "job-A");
    p.catch(() => {}); // avoid an unhandled rejection when we clean up below
    const res = await app.handleAnswer(
      "job-B",
      postJson("/jobs/job-B/answer", { contractVersion: "1.0.0", questionId: "q-sec6", answers: { Q: "A" } }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { delivered: boolean }).delivered).toBe(false);
    expect(pendingCount()).toBe(before + 1); // still pending — not resolved by the wrong job
    rejectQuestionsForJob("job-A"); // cleanup so the global registry doesn't leak into other tests
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

  test("re-fires the terminal callback on an idempotent create for a finished job (BUG-6)", async () => {
    const mf = mockFetch();
    const m = manualRunner();
    const app = createApp({ database: d, runner: m.runner, fetchImpl: mf.fn });
    const created = await app.fetch(postJson("/jobs", createJobBody()));
    const { jobId } = (await created.json()) as { jobId: string };

    m.finish({ status: "succeeded", planSummary: "done" });
    await Bun.sleep(20);
    const firstCount = mf.calls.filter((c) => (c.body as { jobId?: string })?.jobId === jobId).length;
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // Re-create with the SAME idempotency key: the job is already terminal, so the callback is
    // re-delivered (covers the lost-create-response + lost-callback case).
    const again = await app.fetch(postJson("/jobs", createJobBody()));
    expect(again.status).toBe(200);
    await Bun.sleep(20);
    const secondCount = mf.calls.filter((c) => (c.body as { jobId?: string })?.jobId === jobId).length;
    expect(secondCount).toBeGreaterThan(firstCount);
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
