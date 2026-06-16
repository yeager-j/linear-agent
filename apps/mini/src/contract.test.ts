import { test, expect, describe } from "bun:test";
import {
  CreateJobRequest,
  MiniCallback,
  ReapWorktreeRequest,
  ReapWorktreeResponse,
  CONTRACT_VERSION,
  promptToken,
  jobDoneToken,
} from "./contract.ts";

describe("CreateJobRequest", () => {
  test("accepts a valid plan job", () => {
    const r = CreateJobRequest.safeParse({
      contractVersion: CONTRACT_VERSION,
      kind: "plan",
      linearSessionId: "s1",
      issueIdentifier: "ENG-1",
      promptContext: "ctx",
      idempotencyKey: "s1:plan:0",
    });
    expect(r.success).toBe(true);
  });

  test("rejects revise without feedback", () => {
    const r = CreateJobRequest.safeParse({
      contractVersion: CONTRACT_VERSION,
      kind: "revise",
      linearSessionId: "s1",
      issueIdentifier: "ENG-1",
      idempotencyKey: "s1:revise:1",
    });
    expect(r.success).toBe(false);
  });

  test("accepts revise with feedback", () => {
    const r = CreateJobRequest.safeParse({
      contractVersion: CONTRACT_VERSION,
      kind: "revise",
      linearSessionId: "s1",
      issueIdentifier: "ENG-1",
      feedback: "change X",
      idempotencyKey: "s1:revise:1",
    });
    expect(r.success).toBe(true);
  });

  test("rejects wrong contract version", () => {
    const r = CreateJobRequest.safeParse({
      contractVersion: "9.9.9",
      kind: "plan",
      linearSessionId: "s1",
      issueIdentifier: "ENG-1",
      idempotencyKey: "k",
    });
    expect(r.success).toBe(false);
  });

  test("rejects missing idempotencyKey", () => {
    const r = CreateJobRequest.safeParse({
      contractVersion: CONTRACT_VERSION,
      kind: "plan",
      linearSessionId: "s1",
      issueIdentifier: "ENG-1",
    });
    expect(r.success).toBe(false);
  });
});

describe("MiniCallback", () => {
  test("execute success requires prUrl", () => {
    const r = MiniCallback.safeParse({
      contractVersion: CONTRACT_VERSION,
      jobId: "j1",
      linearSessionId: "s1",
      kind: "execute",
      status: "succeeded",
    });
    expect(r.success).toBe(false);
  });

  test("execute success with prUrl is valid", () => {
    const r = MiniCallback.safeParse({
      contractVersion: CONTRACT_VERSION,
      jobId: "j1",
      linearSessionId: "s1",
      kind: "execute",
      status: "succeeded",
      prUrl: "https://github.com/o/r/pull/1",
      branch: "agent/eng-1",
    });
    expect(r.success).toBe(true);
  });

  test("plan success with planSummary is valid", () => {
    const r = MiniCallback.safeParse({
      contractVersion: CONTRACT_VERSION,
      jobId: "j1",
      linearSessionId: "s1",
      kind: "plan",
      status: "succeeded",
      planSummary: "the plan",
      claudeSessionId: "cs-1",
    });
    expect(r.success).toBe(true);
  });

  test("never accepts a non-terminal status", () => {
    const r = MiniCallback.safeParse({
      contractVersion: CONTRACT_VERSION,
      jobId: "j1",
      linearSessionId: "s1",
      kind: "plan",
      status: "running",
    });
    expect(r.success).toBe(false);
  });
});

describe("ReapWorktreeRequest", () => {
  test("accepts valid body", () => {
    const r = ReapWorktreeRequest.safeParse({ contractVersion: CONTRACT_VERSION, linearSessionId: "s1" });
    expect(r.success).toBe(true);
  });
  test("rejects wrong version", () => {
    const r = ReapWorktreeRequest.safeParse({ contractVersion: "2.0.0", linearSessionId: "s1" });
    expect(r.success).toBe(false);
  });
  test("rejects missing linearSessionId", () => {
    const r = ReapWorktreeRequest.safeParse({ contractVersion: CONTRACT_VERSION });
    expect(r.success).toBe(false);
  });
  test("response shape parses", () => {
    const r = ReapWorktreeResponse.safeParse({ linearSessionId: "s1", reaped: true });
    expect(r.success).toBe(true);
  });
});

describe("hook tokens", () => {
  test("deterministic derivation", () => {
    expect(promptToken("s1")).toBe("prompt:s1");
    expect(jobDoneToken("j1")).toBe("job:j1");
  });
});
