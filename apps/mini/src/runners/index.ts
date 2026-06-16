// Runner dispatch: route a job to the plan/revise or execute runner. Behind DRY_RUN it runs a
// fast fake job (used for Phase A wiring + hermetic seam tests).

import type { Runner, RunnerResult, RunnerContext } from "../jobctl.ts";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { runPlan } from "./plan.ts";
import { runExecute } from "./execute.ts";

export function makeRunner(): Runner {
  return async (ctx): Promise<RunnerResult> => {
    if (config().dryRunJobs) return fakeJob(ctx);
    switch (ctx.job.kind) {
      case "plan":
      case "revise":
        return runPlan(ctx);
      case "execute":
        return runExecute(ctx);
    }
  };
}

// A short, abortable fake job so the seam (start -> callback) is exercisable without the SDK.
// Kind-aware: a successful execute MUST carry a prUrl/branch (contract MiniCallback superRefine),
// so synthesize one — otherwise the mini's own MiniCallback.parse rejects the callback.
async function fakeJob(ctx: RunnerContext): Promise<RunnerResult> {
  log.info("DRY_RUN fake job running");
  const ms = Number.parseInt(process.env.DRY_RUN_JOB_MS ?? "1000", 10);
  const success: RunnerResult =
    ctx.job.kind === "execute"
      ? {
          status: "succeeded",
          prUrl: `https://github.com/dry-run/repo/pull/${ctx.job.issue_identifier || "0"}`,
          branch: `agent/${(ctx.job.issue_identifier || "dry-run").toLowerCase()}-dryrun`,
        }
      : { status: "succeeded", planSummary: "dry-run plan" };
  return await new Promise<RunnerResult>((resolve) => {
    const timer = setTimeout(() => resolve(success), ms);
    ctx.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve({ status: "aborted", reason: "aborted" });
    });
  });
}
