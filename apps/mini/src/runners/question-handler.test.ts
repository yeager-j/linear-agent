import { test, expect, describe, afterEach } from "bun:test";
import { makeCanUseTool } from "./question-handler.ts";
import { resolveQuestion, rejectQuestionsForJob, pendingCount } from "../questions.ts";
import type { JobRow } from "../db.ts";
import type { AskQuestionRequest } from "../contract.ts";

function fakeJob(): JobRow {
  return {
    job_id: "jq1",
    linear_session_id: "s1",
    issue_identifier: "ENG-1",
    kind: "plan",
    idempotency_key: "s1:plan:0",
    prompt_context: null,
    feedback: null,
    claude_session_id: null,
    worktree_path: null,
    status: "running",
    pr_url: null,
    branch: null,
    plan_summary: null,
    reason: null,
    created_at: 0,
    updated_at: 0,
  };
}

afterEach(() => {
  // Drain any pending question created during a test.
  rejectQuestionsForJob("jq1", "cleanup");
});

const askInput = {
  questions: [
    { question: "Which DB?", header: "DB", multiSelect: false, options: [{ label: "Postgres", description: "" }] },
  ],
};

describe("makeCanUseTool", () => {
  test("non-AskUserQuestion tool is allowed through unchanged", async () => {
    const handler = makeCanUseTool(fakeJob(), new AbortController().signal, {
      sendQuestion: async () => {},
    });
    const res = await handler("Read", { file_path: "x.ts" });
    expect(res).toEqual({ behavior: "allow", updatedInput: { file_path: "x.ts" } });
  });

  test("AskUserQuestion round-trip: sends, blocks, resumes with answers", async () => {
    let sent: Omit<AskQuestionRequest, "contractVersion"> | undefined;
    const handler = makeCanUseTool(fakeJob(), new AbortController().signal, {
      sendQuestion: async (req) => {
        sent = req;
      },
    });

    const resultPromise = handler(ASK(), askInput);
    // Let the handler register + send.
    await Bun.sleep(5);
    expect(sent?.jobId).toBe("jq1");
    expect(sent?.linearSessionId).toBe("s1");
    expect(sent?.questions[0]!.question).toBe("Which DB?");
    expect(pendingCount()).toBe(1);

    // Deliver the answer (keyed by question text → chosen label).
    const delivered = resolveQuestion(sent!.questionId, { "Which DB?": "Postgres" });
    expect(delivered).toBe(true);

    const res = await resultPromise;
    expect(res).toEqual({
      behavior: "allow",
      updatedInput: { ...askInput, answers: { "Which DB?": "Postgres" } },
    });
  });

  test("abort while blocked: rejected pending question makes the handler throw", async () => {
    const ac = new AbortController();
    const handler = makeCanUseTool(fakeJob(), ac.signal, { sendQuestion: async () => {} });
    const resultPromise = handler(ASK(), askInput);
    await Bun.sleep(5);
    expect(pendingCount()).toBe(1);

    // Simulate the abort path unblocking the question.
    rejectQuestionsForJob("jq1", "aborted");
    await expect(resultPromise).rejects.toThrow("aborted");
  });

  test("sendQuestion failure denies the tool", async () => {
    const handler = makeCanUseTool(fakeJob(), new AbortController().signal, {
      sendQuestion: async () => {
        throw new Error("vercel down");
      },
    });
    const res = await handler(ASK(), askInput);
    expect(res.behavior).toBe("deny");
    expect(pendingCount()).toBe(0); // the catch path calls resolveQuestion to drop the orphaned entry
  });

  test("unparseable AskUserQuestion input denies", async () => {
    const handler = makeCanUseTool(fakeJob(), new AbortController().signal, { sendQuestion: async () => {} });
    const res = await handler(ASK(), { questions: "not-an-array" });
    expect(res.behavior).toBe("deny");
  });
});

// Helper so the literal tool name appears once.
function ASK() {
  return "AskUserQuestion";
}
