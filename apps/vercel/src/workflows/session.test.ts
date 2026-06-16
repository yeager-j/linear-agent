import { describe, expect, it, vi } from "vitest";
import type { JobDoneHookPayload } from "@/lib/contract";

// session.ts creates hooks and uses sleep at module load / in the body. We only test the PURE
// decision helpers here, so stub the workflow runtime primitives to import the module cleanly.
vi.mock("workflow", () => ({
  defineHook: () => ({ create: () => ({}) }),
  sleep: async () => {},
}));

const { decideJobOutcome, toPromptResult } = await import("./session");

function done(overrides: Partial<JobDoneHookPayload> = {}): JobDoneHookPayload {
  return { jobId: "j1", kind: "plan", status: "succeeded", ...overrides };
}

describe("decideJobOutcome", () => {
  const opts = { phase: "Planning", timeoutMessage: "timed out, retry" };

  it("returns stop for a stop outcome", () => {
    expect(decideJobOutcome({ kind: "stop" }, opts)).toEqual({ action: "stop" });
  });

  it("returns the explicit timeout message on timeout (not derived from the phase)", () => {
    expect(decideJobOutcome({ kind: "timeout" }, opts)).toEqual({
      action: "error",
      message: "timed out, retry",
    });
  });

  it("surfaces a non-succeeded status with its reason", () => {
    expect(decideJobOutcome({ kind: "done", value: done({ status: "failed", reason: "boom" }) }, opts)).toEqual({
      action: "error",
      message: "Planning failed: boom",
    });
  });

  it("surfaces a non-succeeded status with a bare period when there's no reason", () => {
    expect(decideJobOutcome({ kind: "done", value: done({ status: "aborted" }) }, opts)).toEqual({
      action: "error",
      message: "Planning aborted.",
    });
  });

  it("continues with the payload on success", () => {
    const value = done({ status: "succeeded", planSummary: "the plan" });
    expect(decideJobOutcome({ kind: "done", value }, opts)).toEqual({ action: "continue", done: value });
  });

  it("uses the caller-supplied phase label", () => {
    const d = decideJobOutcome(
      { kind: "done", value: done({ status: "failed" }) },
      { phase: "Execution", timeoutMessage: "x" },
    );
    expect(d).toMatchObject({ action: "error", message: "Execution failed." });
  });
});

describe("toPromptResult", () => {
  it("maps a stop signal to stop", () => {
    expect(toPromptResult({ text: "", signal: "stop" })).toEqual({ kind: "stop" });
  });

  it("maps a normal reply to a prompt result carrying text + selectValue", () => {
    expect(toPromptResult({ text: "go", selectValue: "approve" })).toEqual({
      kind: "prompt",
      value: { text: "go", selectValue: "approve" },
    });
  });
});
