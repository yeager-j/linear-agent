import crypto from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const WEBHOOK_SECRET = "wh-secret";

// --- Mocks for everything the route touches ---
const start = vi.fn();
const promptResume = vi.fn();
const claimDelivery = vi.fn();
const releaseDelivery = vi.fn();
const insertSession = vi.fn();
const getSession = vi.fn();
const emitThought = vi.fn();

class FakeHookNotFoundError extends Error {
  static is(err: unknown): boolean {
    return err instanceof FakeHookNotFoundError;
  }
}

vi.mock("workflow/api", () => ({ start: (...a: unknown[]) => start(...a) }));
vi.mock("workflow/errors", () => ({ HookNotFoundError: FakeHookNotFoundError }));
vi.mock("@/workflows/session", () => ({
  sessionWorkflow: { __isWorkflow: true },
  promptHook: { resume: (...a: unknown[]) => promptResume(...a) },
}));
vi.mock("@/lib/db", () => ({
  claimDelivery: (...a: unknown[]) => claimDelivery(...a),
  releaseDelivery: (...a: unknown[]) => releaseDelivery(...a),
  insertSession: (...a: unknown[]) => insertSession(...a),
  getSession: (...a: unknown[]) => getSession(...a),
}));
// Keep the real signature verification; stub only the network-touching helpers.
vi.mock("@/lib/linear", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/linear")>();
  return { ...actual, emitThought: (...a: unknown[]) => emitThought(...a) };
});

let POST: typeof import("./route").POST;

beforeAll(async () => {
  process.env.LINEAR_WEBHOOK_SECRET = WEBHOOK_SECRET;
  POST = (await import("./route")).POST;
});

afterEach(() => {
  start.mockReset();
  promptResume.mockReset();
  claimDelivery.mockReset();
  releaseDelivery.mockReset();
  insertSession.mockReset();
  getSession.mockReset();
  emitThought.mockReset();
});

function sign(body: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

function makeRequest(
  body: unknown,
  opts: { sig?: string; delivery?: string; noSig?: boolean } = {},
): Request {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!opts.noSig) headers["Linear-Signature"] = opts.sig ?? sign(raw);
  if (opts.delivery) headers["Linear-Delivery"] = opts.delivery;
  return new Request("https://app.example.com/api/linear/webhook", {
    method: "POST",
    headers,
    body: raw,
  });
}

const now = Date.now();

const createdBody = {
  action: "created",
  webhookTimestamp: now,
  agentSession: {
    id: "sess_1",
    promptContext: "<issue>ENG-1</issue>",
    issue: { id: "issue_1", identifier: "ENG-1" },
  },
};

describe("POST /api/linear/webhook", () => {
  it("rejects an invalid signature with 401 and does no work", async () => {
    const res = await POST(makeRequest(createdBody, { sig: "deadbeef" }));
    expect(res.status).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects a missing signature header with 401 (TEST-5)", async () => {
    const res = await POST(makeRequest(createdBody, { noSig: true }));
    expect(res.status).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  it("processes a created event with no delivery id via the per-session guard (TEST-5/BUG-5)", async () => {
    // No Linear-Delivery header and no webhookId → undedupable by delivery id. claimDelivery must
    // be skipped and the per-session getSession guard is the backstop; a fresh session still starts.
    getSession.mockResolvedValue(null);
    start.mockResolvedValue({ runId: "run_x" });
    emitThought.mockResolvedValue(undefined);
    insertSession.mockResolvedValue(undefined);
    const res = await POST(makeRequest(createdBody)); // no delivery option
    expect(res.status).toBe(200);
    expect(claimDelivery).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("dedupes a second created for an already-started session (BUG-5)", async () => {
    claimDelivery.mockResolvedValue(true); // a *new* delivery id
    getSession.mockResolvedValue({ workflowRunId: "run_1", issueIdentifier: "ENG-1" });
    const res = await POST(makeRequest(createdBody, { delivery: "del_new" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deduped: true });
    expect(start).not.toHaveBeenCalled();
  });

  it("releases the delivery claim when start() throws so Linear's retry re-processes (BUG-1)", async () => {
    claimDelivery.mockResolvedValue(true);
    getSession.mockResolvedValue(null);
    emitThought.mockResolvedValue(undefined);
    start.mockRejectedValue(new Error("workflow start failed"));
    const res = await POST(makeRequest(createdBody, { delivery: "del_fail" }));
    expect(res.status).toBe(500);
    expect(releaseDelivery).toHaveBeenCalledWith("del_fail");
    expect(insertSession).not.toHaveBeenCalled();
  });

  it("ignores a prompted event for an unknown session (SEC-4 ownership gate)", async () => {
    claimDelivery.mockResolvedValue(true);
    getSession.mockResolvedValue(null); // not a session this app started
    const body = {
      action: "prompted",
      webhookTimestamp: now,
      agentSession: { id: "sess_unknown" },
      agentActivity: { content: { body: "hello?" } },
    };
    const res = await POST(makeRequest(body, { delivery: "del_unk" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "unknown-session" });
    expect(promptResume).not.toHaveBeenCalled();
  });

  it("on created: acks, starts the workflow, inserts the session row", async () => {
    claimDelivery.mockResolvedValue(true);
    getSession.mockResolvedValue(null); // no existing run for this session
    start.mockResolvedValue({ runId: "run_1" });
    emitThought.mockResolvedValue(undefined);
    insertSession.mockResolvedValue(undefined);

    const res = await POST(makeRequest(createdBody, { delivery: "del_1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, runId: "run_1" });
    expect(emitThought).toHaveBeenCalledWith("sess_1", expect.stringContaining("ENG-1"));
    expect(start).toHaveBeenCalledTimes(1);
    expect(insertSession).toHaveBeenCalledWith(
      expect.objectContaining({ linearSessionId: "sess_1", workflowRunId: "run_1" }),
    );
  });

  it("dedupes a duplicate delivery before starting", async () => {
    claimDelivery.mockResolvedValue(false);
    const res = await POST(makeRequest(createdBody, { delivery: "del_1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deduped: true });
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp", async () => {
    const res = await POST(makeRequest({ ...createdBody, webhookTimestamp: now - 5 * 60_000 }));
    expect(res.status).toBe(202);
  });

  it("on prompted: resumes the promptHook with text + selectValue", async () => {
    claimDelivery.mockResolvedValue(true);
    getSession.mockResolvedValue({ workflowRunId: "run_1", issueIdentifier: "ENG-1" });
    promptResume.mockResolvedValue({ runId: "run_1" });
    const body = {
      action: "prompted",
      webhookTimestamp: now,
      agentSession: { id: "sess_1" },
      agentActivity: { content: { body: "please change X", value: "request_changes" } },
    };
    const res = await POST(makeRequest(body, { delivery: "del_2" }));
    expect(res.status).toBe(200);
    expect(promptResume).toHaveBeenCalledWith(
      "prompt:sess_1",
      expect.objectContaining({ text: "please change X", selectValue: "request_changes" }),
    );
  });

  it("on prompted with no active hook: acks with resumed=false", async () => {
    claimDelivery.mockResolvedValue(true);
    getSession.mockResolvedValue({ workflowRunId: "run_1", issueIdentifier: "ENG-1" });
    promptResume.mockRejectedValue(new FakeHookNotFoundError("no listener"));
    const body = {
      action: "prompted",
      webhookTimestamp: now,
      agentSession: { id: "sess_1" },
      agentActivity: { content: { body: "hi" } },
    };
    const res = await POST(makeRequest(body, { delivery: "del_3" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resumed: false });
  });

  it("routes a stop signal on a prompted event to the hook", async () => {
    claimDelivery.mockResolvedValue(true);
    getSession.mockResolvedValue({ workflowRunId: "run_1", issueIdentifier: "ENG-1" });
    promptResume.mockResolvedValue({ runId: "run_1" });
    const body = {
      action: "prompted",
      webhookTimestamp: now,
      agentSession: { id: "sess_1" },
      agentActivity: { signal: "stop", body: "" },
    };
    const res = await POST(makeRequest(body, { delivery: "del_4" }));
    expect(res.status).toBe(200);
    expect(promptResume).toHaveBeenCalledWith(
      "prompt:sess_1",
      expect.objectContaining({ signal: "stop" }),
    );
  });
});
