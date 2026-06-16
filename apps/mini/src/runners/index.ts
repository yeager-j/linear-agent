// Runner dispatch: route a job to the plan/revise or execute runner. Behind DRY_RUN it runs a
// fast fake job (used for Phase A wiring + hermetic seam tests).

import type { Runner, RunnerResult } from "../jobctl.ts";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { runPlan } from "./plan.ts";
import { runExecute } from "./execute.ts";

export function makeRunner(): Runner {
  return async (ctx): Promise<RunnerResult> => {
    if (config().dryRunJobs) return fakeJob(ctx.signal);
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
async function fakeJob(signal: AbortSignal): Promise<RunnerResult> {
  log.info("DRY_RUN fake job running");
  const ms = Number.parseInt(process.env.DRY_RUN_JOB_MS ?? "1000", 10);
  return await new Promise<RunnerResult>((resolve) => {
    const timer = setTimeout(() => resolve({ status: "succeeded", planSummary: "dry-run plan" }), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve({ status: "aborted", reason: "aborted" });
    });
  });
}
