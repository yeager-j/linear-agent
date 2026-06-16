import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  CreateJobRequest,
  CreateJobResponse,
  MiniCallback,
  ReapWorktreeRequest,
  ReapWorktreeResponse,
} from "./contract";

describe("CreateJobRequest", () => {
  const base = {
    contractVersion: CONTRACT_VERSION,
    kind: "plan" as const,
    linearSessionId: "sess_1",
    issueIdentifier: "ENG-1",
    idempotencyKey: "sess_1:plan:0",
  };

  it("accepts a valid plan job", () => {
    expect(CreateJobRequest.safeParse(base).success).toBe(true);
  });

  it("requires feedback when kind=revise", () => {
    const r = CreateJobRequest.safeParse({ ...base, kind: "revise" });
    expect(r.success).toBe(false);
  });

  it("accepts a revise job with feedback", () => {
    const r = CreateJobRequest.safeParse({ ...base, kind: "revise", feedback: "change X" });
    expect(r.success).toBe(true);
  });

  it("rejects a wrong contract version", () => {
    const r = CreateJobRequest.safeParse({ ...base, contractVersion: "9.9.9" });
    expect(r.success).toBe(false);
  });
});

describe("CreateJobResponse", () => {
  it("defaults queued to false", () => {
    const r = CreateJobResponse.parse({ jobId: "j1" });
    expect(r.queued).toBe(false);
  });
});

describe("MiniCallback", () => {
  const base = {
    contractVersion: CONTRACT_VERSION,
    jobId: "j1",
    linearSessionId: "sess_1",
    kind: "execute" as const,
    status: "succeeded" as const,
  };

  it("requires prUrl on a successful execute", () => {
    expect(MiniCallback.safeParse(base).success).toBe(false);
    expect(
      MiniCallback.safeParse({ ...base, prUrl: "https://github.com/o/r/pull/1" }).success,
    ).toBe(true);
  });

  it("does not require prUrl on a failed execute", () => {
    expect(
      MiniCallback.safeParse({ ...base, status: "failed", reason: "boom" }).success,
    ).toBe(true);
  });

  it("accepts a succeeded plan with a planSummary", () => {
    expect(
      MiniCallback.safeParse({
        contractVersion: CONTRACT_VERSION,
        jobId: "j2",
        linearSessionId: "sess_1",
        kind: "plan",
        status: "succeeded",
        planSummary: "1. do X\n2. do Y",
        claudeSessionId: "claude_1",
      }).success,
    ).toBe(true);
  });
});

describe("ReapWorktree", () => {
  it("requires contractVersion + linearSessionId on the request", () => {
    expect(
      ReapWorktreeRequest.safeParse({ contractVersion: CONTRACT_VERSION, linearSessionId: "s" })
        .success,
    ).toBe(true);
    expect(ReapWorktreeRequest.safeParse({ linearSessionId: "s" }).success).toBe(false);
    expect(
      ReapWorktreeRequest.safeParse({ contractVersion: "9.9.9", linearSessionId: "s" }).success,
    ).toBe(false);
  });

  it("validates the response shape", () => {
    expect(ReapWorktreeResponse.safeParse({ linearSessionId: "s", reaped: false }).success).toBe(
      true,
    );
    expect(ReapWorktreeResponse.safeParse({ linearSessionId: "s" }).success).toBe(false);
  });
});
