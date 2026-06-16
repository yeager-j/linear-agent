import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION } from "@/lib/contract";

const CALLBACK_SECRET = "callback-secret-xyz";

const resumeHook = vi.fn();
class FakeHookNotFoundError extends Error {
  static is(err: unknown): boolean {
    return err instanceof FakeHookNotFoundError;
  }
}
vi.mock("workflow/api", () => ({ resumeHook: (...a: unknown[]) => resumeHook(...a) }));
vi.mock("workflow/errors", () => ({ HookNotFoundError: FakeHookNotFoundError }));

let POST: typeof import("./route").POST;

beforeAll(async () => {
  process.env.CALLBACK_SECRET = CALLBACK_SECRET;
  POST = (await import("./route")).POST;
});

afterEach(() => {
  resumeHook.mockReset();
});

function makeRequest(body: unknown, opts: { auth?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth !== undefined) headers["Authorization"] = opts.auth;
  return new Request("https://app.example.com/api/mini/question", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const validBody = {
  contractVersion: CONTRACT_VERSION,
  jobId: "job_1",
  linearSessionId: "sess_1",
  questionId: "q_1",
  questions: [
    {
      question: "Which database?",
      header: "DB",
      multiSelect: false,
      options: [{ label: "Postgres", description: "relational" }],
    },
  ],
};

describe("POST /api/mini/question", () => {
  it("rejects a missing/incorrect bearer token with 401", async () => {
    expect((await POST(makeRequest(validBody))).status).toBe(401);
    expect((await POST(makeRequest(validBody, { auth: "Bearer wrong" }))).status).toBe(401);
    expect(resumeHook).not.toHaveBeenCalled();
  });

  it("rejects a contract-version mismatch with 409", async () => {
    const res = await POST(
      makeRequest({ ...validBody, contractVersion: "9.9.9" }, { auth: `Bearer ${CALLBACK_SECRET}` }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "contract-version-mismatch" });
  });

  it("resumes questionHook(question:<jobId>) and acks on a valid request", async () => {
    resumeHook.mockResolvedValue({ runId: "r1" });
    const res = await POST(makeRequest(validBody, { auth: `Bearer ${CALLBACK_SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ack: true });
    expect(resumeHook).toHaveBeenCalledWith(
      "question:job_1",
      expect.objectContaining({ jobId: "job_1", questionId: "q_1" }),
    );
  });

  // B1 regression: a question arriving while NO questionHook is registered (e.g. a rapid second
  // question while the workflow is still handling the first) must NOT be acked as delivered —
  // that would drop it and hang the agent's canUseTool. It must return a retryable non-2xx so the
  // mini keeps retrying until the workflow re-registers the hook and sees the question.
  it("returns a retryable 503 (not 200) when no questionHook is registered", async () => {
    resumeHook.mockRejectedValue(new FakeHookNotFoundError("no listener"));
    const res = await POST(makeRequest(validBody, { auth: `Bearer ${CALLBACK_SECRET}` }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "no-active-question-hook" });
  });

  it("rejects a malformed body with 400", async () => {
    const res = await POST(
      makeRequest(
        { contractVersion: CONTRACT_VERSION, jobId: "job_1" },
        { auth: `Bearer ${CALLBACK_SECRET}` },
      ),
    );
    expect(res.status).toBe(400);
  });
});
