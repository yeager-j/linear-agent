// Boot reconciliation (plan §4 Phase 2, contract §5 failure path).
// Any job still marked `running` at startup means the process died mid-job. Mark it failed
// with reason "interrupted" and fire the terminal callback so the Vercel workflow's
// jobDoneHook resumes instead of hanging until its 45-min backstop.

import type { Database } from "bun:sqlite";
import { db, findRunningJobs, updateJob } from "./db.ts";
import { sendCallback, flushDueCallbacks } from "./callback.ts";
import { log } from "./log.ts";

export async function reconcileOnBoot(deps: { database?: Database; fetchImpl?: typeof fetch } = {}): Promise<void> {
  const d = deps.database ?? db();

  const stuck = findRunningJobs(d);
  for (const job of stuck) {
    log.warn("reconciling interrupted job", { jobId: job.job_id, kind: job.kind });
    updateJob(d, job.job_id, { status: "failed", reason: "interrupted" });
    await sendCallback(
      {
        jobId: job.job_id,
        linearSessionId: job.linear_session_id,
        kind: job.kind,
        status: "failed",
        reason: "interrupted",
        claudeSessionId: job.claude_session_id ?? undefined,
      },
      { database: d, fetchImpl: deps.fetchImpl },
    );
  }

  // Also try to deliver any callbacks that were queued but never sent before the crash.
  await flushDueCallbacks({ database: d, fetchImpl: deps.fetchImpl });
}
