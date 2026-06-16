// Builds the canUseTool handler for a job. On an AskUserQuestion tool call it pauses the run,
// asks Vercel to elicit the answer(s) in Linear, awaits them, and returns them to the SDK as
// updatedInput.answers. Every other tool is allowed through unchanged (the permissionMode +
// allowedTools allowlist already governs what the agent may do).
//
// Blocking semantics: the SDK's canUseTool is async with no timeout, so awaiting the answer here
// is exactly how the run "pauses". If the job is aborted, rejectQuestionsForJob() (called from
// the abort path) rejects the pending promise, so the await throws and we propagate — aborting
// the run cleanly rather than hanging.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JobRow } from "../db.ts";
import type { CanUseToolFn } from "../sdk.ts";
import { AgentQuestion } from "../contract.ts";
import { registerQuestion, resolveQuestion } from "../questions.ts";
import { sendQuestion } from "../question-client.ts";
import { log } from "../log.ts";

const ASK_USER_QUESTION = "AskUserQuestion";

// Injectable so tests can stub the network. Mirrors sendQuestion's signature.
export type SendQuestionFn = typeof sendQuestion;

const QuestionsInput = z.object({ questions: z.array(AgentQuestion).min(1) });

export interface QuestionHandlerDeps {
  sendQuestion?: SendQuestionFn;
}

export function makeCanUseTool(job: JobRow, signal: AbortSignal, deps: QuestionHandlerDeps = {}): CanUseToolFn {
  const send = deps.sendQuestion ?? sendQuestion;

  return async (toolName, input) => {
    if (toolName !== ASK_USER_QUESTION) {
      return { behavior: "allow", updatedInput: input };
    }

    // Parse the SDK's questions[] defensively; a malformed payload denies the tool rather than
    // crashing the run.
    const parsed = QuestionsInput.safeParse(input);
    if (!parsed.success) {
      log.warn("AskUserQuestion with unparseable input; denying", { jobId: job.job_id });
      return { behavior: "deny", message: "Could not parse the questions for AskUserQuestion." };
    }

    const questionId = randomUUID();
    const answersPromise = registerQuestion(questionId, job.job_id);
    // The promise rejects if the job is aborted (rejectQuestionsForJob); without a catch that
    // would surface as an unhandled rejection if send() fails first and we return early.
    answersPromise.catch(() => {});

    try {
      await send(
        {
          jobId: job.job_id,
          linearSessionId: job.linear_session_id,
          questionId,
          questions: parsed.data.questions,
        },
        { signal },
      );
    } catch (err) {
      // Delivery failed (or aborted): we can't get an answer, so deny the tool and drop the now-
      // orphaned pending entry. The run continues and the agent sees the denial.
      resolveQuestion(questionId, {}); // remove from the registry (resolves the caught promise)
      log.warn("sendQuestion failed; denying AskUserQuestion", { jobId: job.job_id, err: String(err) });
      return { behavior: "deny", message: `Could not ask the user: ${String(err)}` };
    }

    // Block until the answer arrives (resolveQuestion) or the job is aborted
    // (rejectQuestionsForJob → throws here → propagates → run aborts).
    const answers = await answersPromise;
    return { behavior: "allow", updatedInput: { ...input, answers } };
  };
}
