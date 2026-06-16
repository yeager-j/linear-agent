import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION } from "@/lib/contract";

const CALLBACK_SECRET = "callback-secret-xyz";

// Mock the workflow runtime so the route can be tested without a running workflow world.
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
  return new Request("https://app.example.com/api/mini/callback", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const validBody = {
  contractVersion: CONTRACT_VERSION,
  jobId: "job_1",
  linearSessionId: "sess_1",
  kind: "plan" as const,
  status: "succeeded" as const,
  planSummary: "do X",
  claudeSessionId: "claude_1",
};

describe("POST /api/mini/callback", () => {
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

  it("resumes jobDoneHook and acks on a valid callback", async () => {
    resumeHook.mockResolvedValue({ runId: "r1" });
    const res = await POST(makeRequest(validBody, { auth: `Bearer ${CALLBACK_SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ack: true });
    expect(resumeHook).toHaveBeenCalledWith("job:job_1", expect.objectContaining({ jobId: "job_1" }));
  });

  it("returns a retryable 503 when the hook is not registered yet (or already consumed)", async () => {
    // HookNotFound conflates an early callback (hook not created yet) with a duplicate. We ask the
    // mini to retry rather than 200-acking — a 200 would silently drop a fast job's first callback
    // and wedge the workflow until its 45-min timeout.
    resumeHook.mockRejectedValue(new FakeHookNotFoundError("gone"));
    const res = await POST(makeRequest(validBody, { auth: `Bearer ${CALLBACK_SECRET}` }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "no-active-job-hook" });
  });

  it("returns 500 when resume fails for a non-HookNotFound reason", async () => {
    resumeHook.mockRejectedValue(new Error("workflow store unavailable"));
    const res = await POST(makeRequest(validBody, { auth: `Bearer ${CALLBACK_SECRET}` }));
    expect(res.status).toBe(500);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await POST(
      makeRequest({ contractVersion: CONTRACT_VERSION, jobId: "" }, { auth: `Bearer ${CALLBACK_SECRET}` }),
    );
    expect(res.status).toBe(400);
  });
});
