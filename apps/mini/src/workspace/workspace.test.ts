import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freshDb, testConfig } from "../test-helpers.ts";
import {
  prepareWorkspace,
  reapWorktree,
  pruneAndGc,
  repoSlug,
  branchName,
  computePaths,
} from "./index.ts";
import { getWorkspace } from "../db.ts";
import type { Database } from "bun:sqlite";

let tmp: string;
let originUrl: string;
let workRoot: string;
let d: Database;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mini-ws-"));
  // Build a throwaway origin repo with a `main` branch and one commit.
  originUrl = join(tmp, "origin");
  await $`git init -q -b main ${originUrl}`.quiet();
  await $`git -C ${originUrl} config user.email t@t.test`.quiet();
  await $`git -C ${originUrl} config user.name tester`.quiet();
  await Bun.write(join(originUrl, "README.md"), "hello\n");
  await $`git -C ${originUrl} add -A`.quiet();
  await $`git -C ${originUrl} commit -q -m init`.quiet();

  workRoot = join(tmp, "work");
  d = freshDb();
  testConfig({ workRoot, prBaseBranch: "main", dbPath: ":memory:" });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("repoSlug + branchName", () => {
  test("slug from ssh + https forms", () => {
    expect(repoSlug("git@github.com:acme/widgets.git")).toBe("acme__widgets");
    expect(repoSlug("https://github.com/acme/widgets")).toBe("acme__widgets");
  });
  test("computePaths rejects a traversal-y session id (BUG-7)", () => {
    // `.` / `..` survive the char filter and would resolve the worktree to (or above) the
    // worktrees root, which then reaches a recursive rm. They must throw, not compute a path.
    expect(() => computePaths(originUrl, ".")).toThrow();
    expect(() => computePaths(originUrl, "..")).toThrow();
    // A normal id still computes a path inside the worktrees root.
    const p = computePaths(originUrl, "sess_1");
    expect(p.worktreePath.startsWith(join(workRoot, "worktrees"))).toBe(true);
  });

  test("branch name is stable + sanitized", () => {
    const b = branchName("ENG-123", "sess_ABC-xyz/1");
    expect(b.startsWith("agent/eng-123-")).toBe(true);
    expect(b).not.toContain("/sess");
  });
});

describe("prepareWorkspace", () => {
  test("creates a bare clone + worktree on the branch", async () => {
    const ws = await prepareWorkspace({
      linearSessionId: "s1",
      issueIdentifier: "ENG-1",
      repoUrl: originUrl,
      database: d,
    });
    expect(existsSync(ws.barePath)).toBe(true);
    expect(existsSync(ws.worktreePath)).toBe(true);
    expect(existsSync(join(ws.worktreePath, "README.md"))).toBe(true);

    // Checked-out branch matches.
    const branch = (await $`git -C ${ws.worktreePath} rev-parse --abbrev-ref HEAD`.text()).trim();
    expect(branch).toBe(ws.branch);

    // Recorded in SQLite.
    expect(getWorkspace(d, "s1")?.worktree_path).toBe(ws.worktreePath);
  });

  test("reuses an existing worktree for the same session", async () => {
    const a = await prepareWorkspace({
      linearSessionId: "s1",
      issueIdentifier: "ENG-1",
      repoUrl: originUrl,
      database: d,
    });
    // Write a local change; reuse must not blow it away.
    await Bun.write(join(a.worktreePath, "scratch.txt"), "wip");
    const b = await prepareWorkspace({
      linearSessionId: "s1",
      issueIdentifier: "ENG-1",
      repoUrl: originUrl,
      database: d,
    });
    expect(b.worktreePath).toBe(a.worktreePath);
    expect(existsSync(join(b.worktreePath, "scratch.txt"))).toBe(true);
  });

  test("a second prepare (execute after plan) keeps the session branch rooted on main", async () => {
    // Regression: a mirror+prune fetch on the second prepare would DELETE the session's branch
    // (it doesn't exist on origin), unbornning the worktree HEAD so the next commit is a root
    // commit -> orphan branch -> GitHub PR 422 "no history in common with main".
    const ws = await prepareWorkspace({
      linearSessionId: "s1",
      issueIdentifier: "ENG-1",
      repoUrl: originUrl,
      database: d,
    });
    const mainSha = (await $`git -C ${ws.worktreePath} rev-parse main`.text()).trim();

    // Second prepare = the "execute" job: re-runs ensureBareClone's fetch, then reuses the tree.
    const ws2 = await prepareWorkspace({
      linearSessionId: "s1",
      issueIdentifier: "ENG-1",
      repoUrl: originUrl,
      database: d,
    });
    expect(ws2.worktreePath).toBe(ws.worktreePath);

    // The branch must still resolve to main's commit (not pruned/unborn).
    const head = (await $`git -C ${ws2.worktreePath} rev-parse HEAD`.text()).trim();
    expect(head).toBe(mainSha);

    // A commit now must have main as its PARENT (not a root commit) -> shares history with main.
    await Bun.write(join(ws2.worktreePath, "change.txt"), "x");
    await $`git -C ${ws2.worktreePath} add -A`.quiet();
    await $`git -C ${ws2.worktreePath} -c user.email=a@a.test -c user.name=a commit -q -m change`.quiet();
    const parent = (await $`git -C ${ws2.worktreePath} rev-parse HEAD^`.text()).trim();
    expect(parent).toBe(mainSha);
  });

  test("concurrent prepares for two sessions share one bare clone (mutex serializes)", async () => {
    const [w1, w2] = await Promise.all([
      prepareWorkspace({ linearSessionId: "s1", issueIdentifier: "ENG-1", repoUrl: originUrl, database: d }),
      prepareWorkspace({ linearSessionId: "s2", issueIdentifier: "ENG-2", repoUrl: originUrl, database: d }),
    ]);
    expect(w1.barePath).toBe(w2.barePath);
    expect(w1.worktreePath).not.toBe(w2.worktreePath);
    expect(existsSync(w1.worktreePath)).toBe(true);
    expect(existsSync(w2.worktreePath)).toBe(true);
  });
});

describe("reap + prune", () => {
  test("reapWorktree removes the worktree and DB row, keeps the bare clone", async () => {
    const ws = await prepareWorkspace({
      linearSessionId: "s1",
      issueIdentifier: "ENG-1",
      repoUrl: originUrl,
      database: d,
    });
    const reaped = await reapWorktree("s1", d);
    expect(reaped).toBe(true);
    expect(existsSync(ws.worktreePath)).toBe(false);
    expect(existsSync(ws.barePath)).toBe(true);
    expect(getWorkspace(d, "s1")).toBeNull();

    // Idempotent: reaping again is a no-op returning false.
    expect(await reapWorktree("s1", d)).toBe(false);
    // Unknown session => false.
    expect(await reapWorktree("never", d)).toBe(false);
  });

  test("pruneAndGc drops rows whose worktree dir vanished", async () => {
    const ws = await prepareWorkspace({
      linearSessionId: "s1",
      issueIdentifier: "ENG-1",
      repoUrl: originUrl,
      database: d,
    });
    await rm(ws.worktreePath, { recursive: true, force: true });
    await pruneAndGc(d);
    expect(getWorkspace(d, "s1")).toBeNull();
  });
});

describe("computePaths", () => {
  test("derives bare + worktree paths under WORK_ROOT", () => {
    const p = computePaths(originUrl, "s1");
    expect(p.barePath.startsWith(join(workRoot, "repos"))).toBe(true);
    expect(p.worktreePath).toBe(join(workRoot, "worktrees", "s1"));
  });
});
