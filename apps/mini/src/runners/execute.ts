// Execute runner (plan §4 Phase 6).
//
// Resumes the Claude session (continuity from plan/revise), runs autonomously with
// permissionMode "dontAsk" + an explicit allowedTools allowlist, in the session's worktree.
// Streams thought/action + plan checklist to Linear via the bridge. On success: commit any
// changes, push the branch, open a PR. The terminal callback carries {prUrl, branch}; the
// Vercel workflow sets externalUrls + emits the final response.
//
// SECURITY (not yet hardened): the SDK currently runs IN-PROCESS on the host, in the session's
// worktree, with permissionMode "dontAsk" + a Bash/Write/WebFetch allowlist — so a prompt-injected
// issue can run arbitrary commands as this user. The design (plan §53/§213) calls for an OrbStack
// container with an egress allowlist; that is NOT wired yet. USE_CONTAINER is currently a no-op
// that logs a warning and still runs locally (see below). Only run this on a trusted machine until
// the container path lands. The local path is what the tests exercise (injected query stream).

import { $ } from "bun";
import type { RunnerContext, RunnerResult } from "../jobctl.ts";
import { config } from "../config.ts";
import { db, latestClaudeSessionId } from "../db.ts";
import { bridgeStream } from "../activity-bridge.ts";
import { runnerDeps } from "./deps.ts";
import { getJobToken } from "../job-tokens.ts";
import { makeCanUseTool } from "./question-handler.ts";
import { parseOwnerRepo, pushAndOpenPr } from "../github/pr.ts";
import { log } from "../log.ts";

// "AskUserQuestion" MUST be allowlisted for mid-run HITL to fire via canUseTool.
const EXECUTE_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "AskUserQuestion"];

function buildExecutePrompt(promptContext: string | null): string {
  return [
    "You are now EXECUTING the approved plan for a Linear-delegated issue.",
    "Make the changes in this working tree. Run any relevant checks/tests.",
    "Do NOT commit, push, or open a PR — the harness handles git.",
    "When done, briefly summarize what you changed.",
    "",
    "Issue context:",
    promptContext ?? "(continuing from the approved plan)",
  ].join("\n");
}

// Commit all changes in the worktree. Returns true if a commit was made, false if nothing to
// commit (clean tree -> no PR).
async function commitChanges(worktreePath: string, issueIdentifier: string): Promise<boolean> {
  await $`git -C ${worktreePath} add -A`.quiet();
  const status = (await $`git -C ${worktreePath} status --porcelain`.text()).trim();
  if (!status) return false;
  await $`git -C ${worktreePath} -c user.email=agent@linear.local -c user.name=${"Linear Agent"} commit -m ${`${issueIdentifier}: implement approved plan`}`.quiet();
  return true;
}

export async function runExecute(ctx: RunnerContext): Promise<RunnerResult> {
  const { job, signal } = ctx;
  const deps = runnerDeps();
  const d = db();
  const cfg = config();

  // Per-job Linear token (see runPlan). Fail loud when absent on a real run rather than execute
  // silently with no activity stream.
  const linearToken = getJobToken(job.job_id) ?? cfg.linearAccessToken;
  if (!linearToken && !cfg.linearDryRun) {
    log.error("missing-linear-token: no per-job token and no env fallback; failing job", { jobId: job.job_id });
    return { status: "failed", reason: "missing-linear-token" };
  }
  const linear = deps.makeLinear(linearToken);

  const repoUrl = cfg.defaultRepoUrl;
  if (!repoUrl) return { status: "failed", reason: "no repo configured (DEFAULT_REPO_URL unset)" };
  const ownerRepo = parseOwnerRepo(repoUrl);
  if (!ownerRepo) return { status: "failed", reason: `cannot parse owner/repo from ${repoUrl}` };

  const ws = await deps.prepareWorkspace({
    linearSessionId: job.linear_session_id,
    issueIdentifier: job.issue_identifier,
    repoUrl,
    database: d,
  });

  const resume = job.claude_session_id ?? latestClaudeSessionId(d, job.linear_session_id) ?? undefined;

  await linear.thought(job.linear_session_id, "Implementing the approved plan…", true);

  if (cfg.useContainer) {
    // TODO(Phase 6 hardening): run the SDK inside an OrbStack container for isolation +
    // egress allowlist. The current code runs the SDK in-process against the worktree.
    log.warn("USE_CONTAINER set but container execution is not yet wired; running locally", {
      jobId: job.job_id,
    });
  }

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  signal.addEventListener("abort", onAbort);

  let claudeSessionId: string | undefined = resume;
  try {
    const stream = deps.query({
      prompt: buildExecutePrompt(job.prompt_context),
      cwd: ws.worktreePath,
      permissionMode: "dontAsk",
      allowedTools: EXECUTE_ALLOWED_TOOLS,
      resume,
      abortController,
      canUseTool: makeCanUseTool(job, signal, { sendQuestion: deps.sendQuestion }),
    });

    const outcome = await bridgeStream(stream, {
      linear,
      linearSessionId: job.linear_session_id,
      publishPlan: true,
    });
    claudeSessionId = outcome.claudeSessionId ?? claudeSessionId;

    if (signal.aborted) return { status: "aborted", reason: "aborted", claudeSessionId };
    if (outcome.isError) {
      return { status: "failed", reason: outcome.resultText ?? "execute run failed", claudeSessionId };
    }

    // Commit + push + PR.
    const committed = await commitChanges(ws.worktreePath, job.issue_identifier);
    if (!committed) {
      return {
        status: "failed",
        reason: "no changes were produced by the execute run",
        claudeSessionId,
      };
    }

    const pr = await pushAndOpenPr({
      worktreePath: ws.worktreePath,
      branch: ws.branch,
      title: `${job.issue_identifier}: ${outcome.resultText?.split("\n")[0]?.slice(0, 72) ?? "automated changes"}`,
      body: outcome.resultText ?? "Automated implementation of the approved plan.",
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
    });

    return {
      status: "succeeded",
      claudeSessionId,
      prUrl: pr.prUrl,
      branch: pr.branch,
      planSummary: outcome.resultText ?? undefined,
    };
  } catch (err) {
    if (signal.aborted) return { status: "aborted", reason: "aborted", claudeSessionId };
    log.error("execute runner error", { jobId: job.job_id, err: String(err) });
    return { status: "failed", reason: `execute run error: ${String(err)}`, claudeSessionId };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
