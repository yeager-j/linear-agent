// Plan / revise runner (plan §4 Phase 4).
//
// kind="plan":   first plan-mode run; prompt = the Linear promptContext.
// kind="revise": re-plan with feedback, RESUMING the stored Claude session (so it keeps the
//                prior plan's context). The mini owns the authoritative claudeSessionId in
//                SQLite (contract D6); we resume the latest one we recorded for this session.
//
// permissionMode "plan" keeps it read-only (linear-agents-api / SDK). Streams thought/action
// + a live plan checklist directly to Linear via the activity bridge; on terminal completion
// returns the plan summary (final result text) + the Claude session id for the controller to
// persist and to carry into execute.

import type { RunnerContext, RunnerResult } from "../jobctl.ts";
import { config } from "../config.ts";
import { db, latestClaudeSessionId } from "../db.ts";
import { bridgeStream } from "../activity-bridge.ts";
import { runnerDeps } from "./deps.ts";
import { log } from "../log.ts";

const PLAN_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];

function buildPlanPrompt(promptContext: string | null): string {
  return [
    "You are operating in PLAN MODE for a Linear-delegated issue. Do not make any changes.",
    "Investigate the codebase and produce a concrete, reviewable implementation plan.",
    "End with a clear, numbered plan the user can approve.",
    "",
    "Issue context:",
    promptContext ?? "(no context provided)",
  ].join("\n");
}

function buildRevisePrompt(feedback: string): string {
  return [
    "The user reviewed your plan and requested changes. Revise the plan accordingly.",
    "Stay in PLAN MODE — do not make changes. Re-output the full updated plan.",
    "",
    "Requested changes:",
    feedback,
  ].join("\n");
}

export async function runPlan(ctx: RunnerContext): Promise<RunnerResult> {
  const { job, signal } = ctx;
  const deps = runnerDeps();
  const d = db();
  const linear = deps.makeLinear();
  const cfg = config();

  const repoUrl = cfg.defaultRepoUrl;
  if (!repoUrl) {
    return { status: "failed", reason: "no repo configured (DEFAULT_REPO_URL unset)" };
  }

  // Prepare (or reuse) the worktree for this session.
  const ws = await deps.prepareWorkspace({
    linearSessionId: job.linear_session_id,
    issueIdentifier: job.issue_identifier,
    repoUrl,
    database: d,
  });

  const isRevise = job.kind === "revise";
  const resume = isRevise
    ? job.claude_session_id ?? latestClaudeSessionId(d, job.linear_session_id) ?? undefined
    : undefined;
  const prompt = isRevise ? buildRevisePrompt(job.feedback ?? "") : buildPlanPrompt(job.prompt_context);

  await linear.thought(job.linear_session_id, isRevise ? "Revising the plan…" : "Investigating the issue…", true);

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  signal.addEventListener("abort", onAbort);

  try {
    const stream = deps.query({
      prompt,
      cwd: ws.worktreePath,
      permissionMode: "plan",
      allowedTools: PLAN_ALLOWED_TOOLS,
      resume,
      abortController,
    });

    const outcome = await bridgeStream(stream, {
      linear,
      linearSessionId: job.linear_session_id,
      publishPlan: true,
    });

    if (signal.aborted) {
      return { status: "aborted", reason: "aborted", claudeSessionId: outcome.claudeSessionId };
    }
    if (outcome.isError) {
      return {
        status: "failed",
        reason: outcome.resultText ?? "plan run failed",
        claudeSessionId: outcome.claudeSessionId,
      };
    }
    return {
      status: "succeeded",
      claudeSessionId: outcome.claudeSessionId,
      planSummary: outcome.resultText ?? "",
    };
  } catch (err) {
    if (signal.aborted) return { status: "aborted", reason: "aborted" };
    log.error("plan runner error", { jobId: job.job_id, err: String(err) });
    return { status: "failed", reason: `plan run error: ${String(err)}` };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
