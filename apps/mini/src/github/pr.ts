// Push a branch and open a GitHub PR with a repo-scoped PAT (plan §4 Phase 6).
//
// Real path: `git push` to an authenticated remote, then POST the GitHub REST PR endpoint.
// PR_DRY_RUN short-circuits to a synthetic {prUrl, branch} without touching the network so the
// execute flow is testable end-to-end.

import { $ } from "bun";
import { config } from "../config.ts";
import { log } from "../log.ts";

export interface OpenPrInput {
  worktreePath: string;
  branch: string;
  baseBranch?: string;
  title: string;
  body: string;
  // owner/repo, parsed from the repo URL.
  owner: string;
  repo: string;
  fetchImpl?: typeof fetch;
}

export interface OpenPrResult {
  prUrl: string;
  branch: string;
}

// Parse owner/repo from a git URL (ssh or https).
export function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  const m = repoUrl
    .replace(/\.git$/, "")
    .match(/[:/]([^/:]+)\/([^/]+)$/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

// Push + open PR. Returns the PR url + branch on success; throws on hard failure (caller maps
// to a failed terminal status).
export async function pushAndOpenPr(input: OpenPrInput): Promise<OpenPrResult> {
  const cfg = config();
  const baseBranch = input.baseBranch ?? cfg.prBaseBranch;
  const fetchImpl = input.fetchImpl ?? fetch;

  if (cfg.prDryRun) {
    const prUrl = `https://github.com/${input.owner}/${input.repo}/pull/0`;
    log.info("[pr:dry-run] synthesized PR", { prUrl, branch: input.branch });
    return { prUrl, branch: input.branch };
  }

  if (!cfg.githubToken) {
    throw new Error("GITHUB_TOKEN unset; cannot push/open PR");
  }

  // Push the branch using a token-authenticated https remote (avoids persisting creds).
  const authRemote = `https://x-access-token:${cfg.githubToken}@github.com/${input.owner}/${input.repo}.git`;
  log.info("pushing branch", { branch: input.branch });
  await $`git -C ${input.worktreePath} push ${authRemote} ${`HEAD:refs/heads/${input.branch}`} --force-with-lease`.quiet();

  // Open the PR via REST.
  const res = await fetchImpl(`${cfg.githubApiUrl}/repos/${input.owner}/${input.repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      title: input.title,
      head: input.branch,
      base: baseBranch,
      body: input.body,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub PR create failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { html_url?: string };
  if (!json.html_url) throw new Error("GitHub PR response missing html_url");
  log.info("opened PR", { prUrl: json.html_url, branch: input.branch });
  return { prUrl: json.html_url, branch: input.branch };
}
