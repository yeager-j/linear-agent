// POST /api/mini/question — mid-run AskUserQuestion from the mini.
//
// The agent asked clarifying question(s) mid-job (the mini intercepted the SDK's AskUserQuestion
// tool and paused the run). We resume questionHook(`question:${jobId}`) so the workflow can elicit
// the answer(s) in Linear and POST them back via /jobs/:id/answer.
//
// Contract: bearer auth (CALLBACK_SECRET, constant-time); contractVersion mismatch → 409
// {error, contractVersion}. A question is a one-shot that resolves exactly once, so a resume that
// throws HookNotFoundError means "no hook registered yet" (not a duplicate) — we return a
// RETRYABLE 503 {error:"no-active-question-hook"} so the mini's bounded retry keeps trying until
// the workflow registers the hook. Returning 200 here would silently drop a live question.

import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { AskQuestionRequest, CONTRACT_VERSION, type QuestionHookPayload } from "@/lib/contract";
import { bearerOk } from "@/lib/auth";
import { questionToken } from "@/lib/tokens";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  // 1) Auth.
  if (!bearerOk(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  // 2) Parse + contract-version check.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const version = (body as { contractVersion?: unknown })?.contractVersion;
  if (version !== CONTRACT_VERSION) {
    return Response.json(
      { error: "contract-version-mismatch", contractVersion: CONTRACT_VERSION },
      { status: 409 },
    );
  }

  const result = AskQuestionRequest.safeParse(body);
  if (!result.success) {
    return Response.json({ error: "invalid-question", issues: result.error.issues }, { status: 400 });
  }
  const q = result.data;

  // 3) Resume questionHook with {jobId, questionId, questions}.
  const payload: QuestionHookPayload = {
    jobId: q.jobId,
    questionId: q.questionId,
    questions: q.questions,
  };

  try {
    await resumeHook(questionToken(q.jobId), payload);
  } catch (err) {
    // B1 defense-in-depth: NO active questionHook for this job right now. Unlike a duplicate
    // terminal callback, a question is a one-shot that only ever resolves once, so "not found"
    // means the workflow hasn't (re)registered the hook YET — e.g. it's mid-handling a previous
    // question, or the run raced ahead of registration. Return a RETRYABLE 503 so the mini's
    // bounded retry keeps trying until the hook is registered, rather than 200 (which the mini
    // would treat as delivered, dropping the question and hanging the agent's canUseTool).
    if (HookNotFoundError.is(err)) {
      return Response.json(
        { error: "no-active-question-hook", reason: "workflow not ready; retry" },
        { status: 503 },
      );
    }
    console.error("[question] resume failed", err);
    return new Response("internal error", { status: 500 });
  }

  return Response.json({ ack: true });
}
