// Job controller: in-memory registry of live jobs, concurrency caps with a self-starting
// queue, and AbortController wiring. The HTTP layer (server.ts) calls submit()/abort(); the
// actual work is performed by a Runner (plan/execute), injected so the seam stays testable.
//
// Concurrency (plan §4 Phase 2): a global cap per kind class — executes vs plans. Over-cap
// jobs sit `queued` in SQLite and self-start when a slot frees up. Vercel doesn't care: it
// waits on jobDoneHook either way (contract §1 CreateJobResponse).

import type { Database } from "bun:sqlite";
import { db, getJob, updateJob, type JobRow } from "./db.ts";
import { config } from "./config.ts";
import { sendCallback } from "./callback.ts";
import { rejectQuestionsForJob } from "./questions.ts";
import { deleteJobToken } from "./job-tokens.ts";
import { log } from "./log.ts";
import type { TerminalStatus } from "./contract.ts";

// What a runner returns on terminal completion. The controller persists it and fires the
// callback. The runner streams its own Linear activities directly (activity-bridge).
export interface RunnerResult {
  status: TerminalStatus;
  claudeSessionId?: string;
  planSummary?: string;
  prUrl?: string;
  branch?: string;
  reason?: string;
}

export interface RunnerContext {
  job: JobRow;
  signal: AbortSignal;
}

export type Runner = (ctx: RunnerContext) => Promise<RunnerResult>;

interface Live {
  controller: AbortController;
}

export class JobController {
  private readonly d: Database;
  private readonly runner: Runner;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly live = new Map<string, Live>();
  private runningExec = 0;
  private runningPlan = 0;

  constructor(opts: { database?: Database; runner: Runner; fetchImpl?: typeof fetch }) {
    this.d = opts.database ?? db();
    this.runner = opts.runner;
    this.fetchImpl = opts.fetchImpl;
  }

  runningJobs(): number {
    return this.live.size;
  }

  private isExecuteKind(kind: string): boolean {
    return kind === "execute";
  }

  private hasSlot(kind: string): boolean {
    const cfg = config();
    return this.isExecuteKind(kind)
      ? this.runningExec < cfg.maxConcurrentExecutions
      : this.runningPlan < cfg.maxConcurrentPlans;
  }

  // Called after a job is persisted (status queued). Starts it now if there's a slot, else
  // leaves it queued — it will be picked up when a slot frees (drainQueue).
  submit(jobId: string): { queued: boolean } {
    const job = getJob(this.d, jobId);
    if (!job) throw new Error(`submit: unknown job ${jobId}`);
    if (this.hasSlot(job.kind)) {
      this.start(job);
      return { queued: false };
    }
    log.info("job queued (over concurrency cap)", { jobId, kind: job.kind });
    return { queued: true };
  }

  private start(job: JobRow): void {
    const controller = new AbortController();
    this.live.set(job.job_id, { controller });
    if (this.isExecuteKind(job.kind)) this.runningExec++;
    else this.runningPlan++;
    updateJob(this.d, job.job_id, { status: "running" });
    log.info("job started", { jobId: job.job_id, kind: job.kind });

    // Run async; never throw into the caller.
    void this.run(job, controller.signal).finally(() => {
      this.live.delete(job.job_id);
      deleteJobToken(job.job_id); // token never outlives the job
      if (this.isExecuteKind(job.kind)) this.runningExec--;
      else this.runningPlan--;
      this.drainQueue();
    });
  }

  private async run(job: JobRow, signal: AbortSignal): Promise<void> {
    let result: RunnerResult;
    try {
      result = await this.runner({ job: getJob(this.d, job.job_id)!, signal });
    } catch (err) {
      const aborted = signal.aborted;
      result = {
        status: aborted ? "aborted" : "failed",
        reason: aborted ? "aborted" : `runner error: ${String(err)}`,
      };
      log.error("runner threw", { jobId: job.job_id, err: String(err), aborted });
    }

    const internalStatus =
      result.status === "succeeded" ? "done" : result.status === "aborted" ? "aborted" : "failed";
    updateJob(this.d, job.job_id, {
      status: internalStatus,
      claude_session_id: result.claudeSessionId ?? null,
      plan_summary: result.planSummary ?? null,
      pr_url: result.prUrl ?? null,
      branch: result.branch ?? null,
      reason: result.reason ?? null,
    });

    await sendCallback(
      {
        jobId: job.job_id,
        linearSessionId: job.linear_session_id,
        kind: job.kind,
        status: result.status,
        prUrl: result.prUrl,
        branch: result.branch,
        planSummary: result.planSummary,
        claudeSessionId: result.claudeSessionId,
        reason: result.reason,
      },
      { database: this.d, fetchImpl: this.fetchImpl },
    ).catch((err) => log.error("sendCallback failed", { jobId: job.job_id, err: String(err) }));
  }

  // Find the oldest queued job that now fits a free slot and start it.
  private drainQueue(): void {
    const queued = this.d
      .query(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC`)
      .all() as JobRow[];
    for (const job of queued) {
      if (this.hasSlot(job.kind)) this.start(job);
    }
  }

  // Signal abort to a running job. Idempotent: unknown/finished job => false. Also rejects any
  // pending mid-run question so a stop during AskUserQuestion unblocks the canUseTool handler and
  // the run aborts cleanly instead of hanging on the answer.
  abort(jobId: string): boolean {
    const live = this.live.get(jobId);
    if (!live) return false;
    live.controller.abort();
    rejectQuestionsForJob(jobId, "aborted");
    log.info("job abort signalled", { jobId });
    return true;
  }
}
