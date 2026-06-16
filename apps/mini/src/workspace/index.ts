// Workspace management (plan §4 Phase 3): one bare clone per repo, one git worktree per Linear
// session. Worktrees give each job an isolated checkout that shares object storage with the
// bare clone, so plan/revise/execute for a session reuse the same tree.
//
// Layout under WORK_ROOT:
//   repos/<slug>.git           bare clone (fetched, shared)
//   worktrees/<linearSessionId>  per-session worktree
//
// Concurrency: fetches into a shared bare repo are serialized by a per-bare-path mutex so two
// jobs don't race `git fetch` on the same object store.

import { $ } from "bun";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { db, upsertWorkspace, getWorkspace, deleteWorkspace, allWorkspaces, type WorkspaceRow } from "../db.ts";
import type { Database } from "bun:sqlite";
import { log } from "../log.ts";

export interface Workspace {
  linearSessionId: string;
  repoUrl: string;
  barePath: string;
  worktreePath: string;
  branch: string;
}

export interface PrepareOptions {
  linearSessionId: string;
  issueIdentifier: string;
  repoUrl: string;
  baseBranch?: string; // branch to base the worktree on (default config.prBaseBranch)
  database?: Database;
}

// Per-bare-path fetch mutex: serialize all git operations that touch a shared bare repo so two
// jobs don't race `git fetch`/`worktree add` on the same object store. Each call chains onto
// the previous tail; the tail always resolves (errors are swallowed for the *waiter*, not the
// caller — the caller's own fn result/error is returned as-is).
const fetchTails = new Map<string, Promise<void>>();

async function withFetchLock<T>(barePath: string, fn: () => Promise<T>): Promise<T> {
  const prevTail = fetchTails.get(barePath) ?? Promise.resolve();
  let releaseTail!: () => void;
  const myTail = new Promise<void>((res) => (releaseTail = res));
  fetchTails.set(barePath, myTail);

  await prevTail; // wait my turn (predecessor tail always resolves)
  try {
    return await fn();
  } finally {
    releaseTail();
    if (fetchTails.get(barePath) === myTail) fetchTails.delete(barePath);
  }
}

// Derive a filesystem-safe slug from a repo URL (e.g. git@github.com:o/r.git -> o__r).
export function repoSlug(repoUrl: string): string {
  const stripped = repoUrl
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/:/g, "/")
    .replace(/\.git$/, "");
  const parts = stripped.split("/").filter(Boolean);
  const tail = parts.slice(-2).join("__");
  return (tail || "repo").replace(/[^a-zA-Z0-9_.-]/g, "-");
}

// Sanitize a Linear session id for use as a directory name. Replacing `/` already blocks nested
// traversal, but `.` and `..` survive the char filter and would resolve the worktree to the
// worktrees root (or its parent), which then reaches a recursive rm — so reject them outright.
function sessionDir(linearSessionId: string): string {
  const safe = linearSessionId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  if (safe === "" || safe === "." || safe === "..") {
    throw new Error(`unsafe linearSessionId for a directory name: ${JSON.stringify(linearSessionId)}`);
  }
  return safe;
}

function paths(repoUrl: string, linearSessionId: string) {
  const root = config().workRoot;
  const barePath = join(root, "repos", `${repoSlug(repoUrl)}.git`);
  const worktreesRoot = join(root, "worktrees");
  const worktreePath = join(worktreesRoot, sessionDir(linearSessionId));
  // Belt-and-suspenders: the worktree must stay strictly inside the worktrees root before any
  // mkdir/rm touches it. sessionDir already rejects `.`/`..`/empty; this catches any future regression.
  if (!`${worktreePath}/`.startsWith(`${worktreesRoot}/`)) {
    throw new Error(`worktree path escapes the worktrees root: ${worktreePath}`);
  }
  return { root, barePath, worktreePath };
}

// Ensure a bare clone exists and the base branch is up to date. Serialized per bare path.
async function ensureBareClone(repoUrl: string, barePath: string, baseBranch: string): Promise<void> {
  await mkdir(join(barePath, ".."), { recursive: true });
  await withFetchLock(barePath, async () => {
    if (!existsSync(barePath)) {
      log.info("bare clone", { repoUrl, barePath });
      // `--` ends option parsing: even though Bun's $ escapes shell metacharacters, git itself
      // would still treat a leading-dash repoUrl as an option (e.g. --upload-pack=…). Harmless
      // today (repoUrl is env-sourced) but free insurance if repo selection becomes per-issue.
      await $`git clone --bare -- ${repoUrl} ${barePath}`.quiet();
    } else {
      log.debug("bare fetch", { barePath, baseBranch });
      // Update ONLY the base branch into its plain ref (refs/heads/<base>). Do NOT mirror all
      // heads with --prune: the bare repo also holds our per-session worktree branches
      // (agent/<issue>-<session>), which don't exist on origin — a mirror+prune fetch would
      // DELETE them, leaving the worktree's HEAD unborn so the next commit becomes a root commit
      // (orphan branch -> GitHub PR 422 "no history in common"). Only origin's base branch here.
      await $`git --git-dir=${barePath} fetch origin ${`+refs/heads/${baseBranch}:refs/heads/${baseBranch}`}`.quiet();
    }
  });
}

// Prepare (create or reuse) the worktree for a session. Returns paths + the branch name.
export async function prepareWorkspace(opts: PrepareOptions): Promise<Workspace> {
  const d = opts.database ?? db();
  const baseBranch = opts.baseBranch ?? config().prBaseBranch;
  const { barePath, worktreePath } = paths(opts.repoUrl, opts.linearSessionId);
  const branch = branchName(opts.issueIdentifier, opts.linearSessionId);

  await ensureBareClone(opts.repoUrl, barePath, baseBranch);

  // Guard: the base branch MUST resolve in the bare clone. If it doesn't (empty repo, or a
  // default branch that isn't `baseBranch`), `git worktree add -B <branch> <path> <base>` would
  // silently create an UNBORN branch — the agent's first commit becomes a root commit with no
  // ancestry to the base, and the PR fails with "no history in common with main". Fail loudly.
  const baseCheck = await $`git --git-dir=${barePath} rev-parse --verify --quiet ${`refs/heads/${baseBranch}`}`
    .nothrow()
    .quiet();
  if (baseCheck.exitCode !== 0) {
    throw new Error(
      `base branch '${baseBranch}' not found in ${opts.repoUrl} — the repo may be empty or its ` +
        `default branch is not '${baseBranch}'. Push an initial commit (or set PR_BASE_BRANCH) and retry.`,
    );
  }

  await mkdir(join(worktreePath, ".."), { recursive: true });

  const existing = getWorkspace(d, opts.linearSessionId);
  if (existing && existsSync(existing.worktree_path)) {
    log.info("reusing worktree", { worktreePath: existing.worktree_path });
    return {
      linearSessionId: opts.linearSessionId,
      repoUrl: existing.repo_url,
      barePath: existing.bare_path,
      worktreePath: existing.worktree_path,
      branch: existing.branch ?? branch,
    };
  }

  // Fresh worktree on a new branch off the base branch (serialized: worktree add touches the
  // bare repo's refs/worktrees).
  await withFetchLock(barePath, async () => {
    if (existsSync(worktreePath)) {
      await $`git --git-dir=${barePath} worktree remove --force ${worktreePath}`.quiet().nothrow();
      await rm(worktreePath, { recursive: true, force: true });
    }
    // Base ref is a plain branch name in the bare repo's refs/heads/* (see fetch refspec).
    await $`git --git-dir=${barePath} worktree add -B ${branch} ${worktreePath} ${baseBranch}`.quiet();
  });

  upsertWorkspace(d, {
    linear_session_id: opts.linearSessionId,
    repo_url: opts.repoUrl,
    bare_path: barePath,
    worktree_path: worktreePath,
    branch,
  });

  return {
    linearSessionId: opts.linearSessionId,
    repoUrl: opts.repoUrl,
    barePath,
    worktreePath,
    branch,
  };
}

// Branch naming: agent/<issue>-<short-session>. Stable per session.
export function branchName(issueIdentifier: string, linearSessionId: string): string {
  const issue = issueIdentifier.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const short = linearSessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return `agent/${issue}-${short}`;
}

// Reap a session's worktree (Phase 7 sweeper / post-execute cleanup). Keeps the bare clone
// and the job row's claude_session_id intact (only the `workspaces` registry row is removed),
// so a late reply can recreate the worktree and resume the Claude session. This only frees disk.
// Returns true if a worktree was actually removed; false if there was nothing to reap (no-op),
// which the /jobs/reap endpoint surfaces as reaped:false.
export async function reapWorktree(linearSessionId: string, database?: Database): Promise<boolean> {
  const d = database ?? db();
  const ws = getWorkspace(d, linearSessionId);
  if (!ws) return false;
  await withFetchLock(ws.bare_path, async () => {
    await $`git --git-dir=${ws.bare_path} worktree remove --force ${ws.worktree_path}`.quiet().nothrow();
  });
  await rm(ws.worktree_path, { recursive: true, force: true });
  deleteWorkspace(d, linearSessionId);
  log.info("reaped worktree", { linearSessionId, worktreePath: ws.worktree_path });
  return true;
}

// Prune stale worktree admin entries and (optionally) GC bare repos. Best-effort.
export async function pruneAndGc(database?: Database): Promise<void> {
  const d = database ?? db();
  const seenBare = new Set<string>();
  for (const ws of allWorkspaces(d)) {
    if (seenBare.has(ws.bare_path)) continue;
    seenBare.add(ws.bare_path);
    await withFetchLock(ws.bare_path, async () => {
      await $`git --git-dir=${ws.bare_path} worktree prune`.quiet().nothrow();
      await $`git --git-dir=${ws.bare_path} gc --auto`.quiet().nothrow();
    });
  }
  // Drop DB rows whose worktree dir no longer exists.
  for (const ws of allWorkspaces(d)) {
    if (!existsSync(ws.worktree_path)) deleteWorkspace(d, ws.linear_session_id);
  }
}

// Test/inspection helper.
export async function listWorktreeDirs(database?: Database): Promise<string[]> {
  const d = database ?? db();
  return allWorkspaces(d)
    .map((w: WorkspaceRow) => w.worktree_path)
    .filter((p) => existsSync(p));
}

// Exposed for tests that need the computed paths.
export function computePaths(repoUrl: string, linearSessionId: string) {
  return paths(repoUrl, linearSessionId);
}
