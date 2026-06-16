// Pending-question registry for mid-run AskUserQuestion HITL.
//
// When the agent calls AskUserQuestion mid-run, the canUseTool handler registers the question
// here and awaits the returned promise; the run blocks (the SDK's canUseTool is async with no
// timeout). The answer arrives later via POST /jobs/:id/answer → resolveQuestion(), which
// resolves the promise and unblocks the run. An abort/stop calls rejectQuestionsForJob() so the
// handler throws and the run aborts cleanly instead of hanging forever.

import { log } from "./log.ts";

interface Pending {
  jobId: string;
  resolve: (answers: Record<string, string>) => void;
  reject: (err: Error) => void;
}

const pending = new Map<string, Pending>();

// Register a question and return a promise that resolves with the answers map (question text →
// chosen label(s)) once the answer arrives, or rejects if the job is aborted.
export function registerQuestion(questionId: string, jobId: string): Promise<Record<string, string>> {
  return new Promise<Record<string, string>>((resolve, reject) => {
    pending.set(questionId, { jobId, resolve, reject });
    log.info("question registered", { questionId, jobId });
  });
}

// Deliver answers for a pending question. Returns true if a pending question matched (and was
// resolved + removed); false if unknown/stale (no-op). When `expectedJobId` is provided, the
// pending question must belong to that job — a wrong-job answer is a no-op (returns false), so an
// answer routed to the wrong job can never resolve another job's question.
export function resolveQuestion(
  questionId: string,
  answers: Record<string, string>,
  expectedJobId?: string,
): boolean {
  const p = pending.get(questionId);
  if (!p) return false;
  if (expectedJobId !== undefined && p.jobId !== expectedJobId) {
    log.warn("answer jobId does not match the pending question's job; ignoring", {
      questionId,
      expectedJobId,
      pendingJobId: p.jobId,
    });
    return false;
  }
  pending.delete(questionId);
  p.resolve(answers);
  log.info("question resolved", { questionId, jobId: p.jobId });
  return true;
}

// Reject (and remove) every pending question belonging to a job — used by the abort path so a
// stop during a pending question unblocks the canUseTool handler, which then throws → run aborts.
export function rejectQuestionsForJob(jobId: string, reason = "aborted"): void {
  for (const [questionId, p] of pending) {
    if (p.jobId === jobId) {
      pending.delete(questionId);
      p.reject(new Error(reason));
      log.info("question rejected (job abort)", { questionId, jobId, reason });
    }
  }
}

// Test/inspection helper.
export function pendingCount(): number {
  return pending.size;
}
