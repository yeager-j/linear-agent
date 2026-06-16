import { test, expect, describe, afterEach } from "bun:test";
import { registerQuestion, resolveQuestion, rejectQuestionsForJob, pendingCount } from "./questions.ts";

afterEach(() => {
  // Clear any leftover pending questions between tests.
  rejectQuestionsForJob("j1", "cleanup");
  rejectQuestionsForJob("j2", "cleanup");
});

describe("question registry", () => {
  test("resolveQuestion delivers answers to the awaiting promise", async () => {
    const p = registerQuestion("q1", "j1");
    expect(pendingCount()).toBe(1);
    const delivered = resolveQuestion("q1", { "Pick a color?": "blue" });
    expect(delivered).toBe(true);
    await expect(p).resolves.toEqual({ "Pick a color?": "blue" });
    expect(pendingCount()).toBe(0);
  });

  test("resolveQuestion for an unknown id returns false (no-op)", () => {
    expect(resolveQuestion("nope", { a: "b" })).toBe(false);
  });

  test("rejectQuestionsForJob rejects all of a job's pending questions", async () => {
    const p1 = registerQuestion("q1", "j1");
    const p2 = registerQuestion("q2", "j1");
    const pOther = registerQuestion("q3", "j2");
    rejectQuestionsForJob("j1", "aborted");
    await expect(p1).rejects.toThrow("aborted");
    await expect(p2).rejects.toThrow("aborted");
    // The other job's question is untouched.
    expect(pendingCount()).toBe(1);
    resolveQuestion("q3", { x: "y" });
    await expect(pOther).resolves.toEqual({ x: "y" });
  });
});
