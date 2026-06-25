import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION } from "./contract";

// createJob now mints a fresh Linear token via the token authority; mock it so the test doesn't
// touch Neon.
vi.mock("./linear-token", () => ({
  getValidAccessToken: vi.fn(async () => "fresh-linear-token"),
}));

let mini: typeof import("./mini");

beforeAll(async () => {
  process.env.MINI_BASE_URL = "https://mini.example.com";
  process.env.CF_ACCESS_CLIENT_ID = "cf-id";
  process.env.CF_ACCESS_CLIENT_SECRET = "cf-secret";
  process.env.MINI_AUTH_SECRET = "mini-bearer";
  mini = await import("./mini");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createJob", () => {
  it("sends CF-Access headers, contract version, and a deterministic idempotencyKey", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ jobId: "j1" }));

    const res = await mini.createJob({
      kind: "plan",
      linearSessionId: "sess_1",
      issueIdentifier: "ENG-1",
      round: 0,
      promptContext: "ctx",
    });

    expect(res.jobId).toBe("j1");
    expect(res.queued).toBe(false);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://mini.example.com/jobs");
    const headers = init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer mini-bearer");
    expect(headers["CF-Access-Client-Id"]).toBe("cf-id");
    expect(headers["CF-Access-Client-Secret"]).toBe("cf-secret");
    const sent = JSON.parse(init!.body as string);
    expect(sent.contractVersion).toBe(CONTRACT_VERSION);
    expect(sent.idempotencyKey).toBe("sess_1:plan:0");
    expect(sent.linearAccessToken).toBe("fresh-linear-token");
  });

  it("throws a ContractVersionMismatchError on a 409 and does not retry", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ error: "contract-version-mismatch", contractVersion: "9.9.9" }, 409));

    await expect(
      mini.createJob({ kind: "plan", linearSessionId: "s", issueIdentifier: "E", round: 0 }),
    ).rejects.toBeInstanceOf(mini.ContractVersionMismatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient 503s then succeeds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ jobId: "j2", queued: true }));

    const res = await mini.createJob({
      kind: "execute",
      linearSessionId: "s",
      issueIdentifier: "E",
      round: 0,
    });
    expect(res.jobId).toBe("j2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("abortJob", () => {
  it("posts to the abort path and validates the response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ jobId: "j1", aborted: true }));
    await mini.abortJob("j1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://mini.example.com/jobs/j1/abort");
  });
});

describe("reapWorktree", () => {
  it("posts contractVersion + linearSessionId with CF-Access headers and parses the response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ linearSessionId: "sess_1", reaped: true }));

    const res = await mini.reapWorktree("sess_1");
    expect(res).toEqual({ linearSessionId: "sess_1", reaped: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://mini.example.com/jobs/reap");
    const headers = init!.headers as Record<string, string>;
    expect(headers["CF-Access-Client-Id"]).toBe("cf-id");
    const sent = JSON.parse(init!.body as string);
    expect(sent).toMatchObject({ contractVersion: CONTRACT_VERSION, linearSessionId: "sess_1" });
  });

  it("surfaces a 409 as a ContractVersionMismatchError (caller treats as non-fatal)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "contract-version-mismatch", contractVersion: "9.9.9" }, 409),
    );
    await expect(mini.reapWorktree("sess_1")).rejects.toBeInstanceOf(
      mini.ContractVersionMismatchError,
    );
  });
});

describe("deliverAnswer", () => {
  it("posts to /jobs/:id/answer with CF-Access headers + {contractVersion, questionId, answers}", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ questionId: "q1", delivered: true }));

    const answers = { "Which database?": "Postgres" };
    const res = await mini.deliverAnswer("job_1", "q1", answers);
    expect(res).toEqual({ questionId: "q1", delivered: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://mini.example.com/jobs/job_1/answer");
    const headers = init!.headers as Record<string, string>;
    expect(headers["CF-Access-Client-Id"]).toBe("cf-id");
    expect(headers["CF-Access-Client-Secret"]).toBe("cf-secret");
    const sent = JSON.parse(init!.body as string);
    expect(sent).toEqual({ contractVersion: CONTRACT_VERSION, questionId: "q1", answers });
  });

  it("treats a 409 as fatal-no-retry (ContractVersionMismatchError, single fetch)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ error: "contract-version-mismatch", contractVersion: "9.9.9" }, 409));
    await expect(mini.deliverAnswer("job_1", "q1", {})).rejects.toBeInstanceOf(
      mini.ContractVersionMismatchError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
