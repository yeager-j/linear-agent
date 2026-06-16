import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runExecute } from "./execute.ts";
import { setRunnerDeps } from "./deps.ts";
import { testConfig } from "../test-helpers.ts";
import { db as singletonDb, insertJob, getJob } from "../db.ts";
import { nullLinearClient } from "../linear.ts";
import type { SDKLikeMessage } from "../activity-bridge.ts";
import type { QueryFn, QueryParams } from "../sdk.ts";
import { prepareWorkspace } from "../workspace/index.ts";

let tmp: string;
let originUrl: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mini-exec-"));
  originUrl = join(tmp, "origin");
  await $`git init -q -b main ${originUrl}`.quiet();
  await $`git -C ${originUrl} config user.email t@t.test`.quiet();
  await $`git -C ${originUrl} config user.name tester`.quiet();
  await Bun.write(join(originUrl, "README.md"), "hi\n");
  await $`git -C ${originUrl} add -A`.quiet();
  await $`git -C ${originUrl} commit -q -m init`.quiet();

  testConfig({
    workRoot: join(tmp, "work"),
    defaultRepoUrl: originUrl,
    prBaseBranch: "main",
    prDryRun: true,
    activityThrottleMs: 0,
    dbPath: ":memory:",
  });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// A query that "implements" the plan by writing a file into the worktree cwd, then succeeds.
function writingQuery(capture?: (p: QueryParams) => void): QueryFn {
  return (params) => {
    capture?.(params);
    return (async function* () {
      await Bun.write(join(params.cwd, "CHANGED.txt"), "the agent did work\n");
      yield { type: "system", subtype: "init", session_id: "cs-exec" } as SDKLikeMessage;
      yield {
        type: "assistant",
        session_id: "cs-exec",
        message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "CHANGED.txt" } }] },
      } as SDKLikeMessage;
      yield { type: "result", subtype: "success", session_id: "cs-exec", result: "Added CHANGED.txt" } as SDKLikeMessage;
    })();
  };
}

describe("runExecute", () => {
  test("resumes session, makes changes, commits, opens PR (dry-run)", async () => {
    const sdb = singletonDb();
    insertJob(sdb, {
      job_id: "e1",
      linear_session_id: "es1",
      issue_identifier: "ENG-9",
      kind: "execute",
      idempotency_key: "es1:execute:0",
      claude_session_id: "cs-plan",
      prompt_context: "<issue>add file</issue>",
      status: "running",
    });

    let captured: QueryParams | undefined;
    const restore = setRunnerDeps({
      makeLinear: () => nullLinearClient(),
      prepareWorkspace, // real workspace against the temp origin
      query: writingQuery((p) => (captured = p)),
    });

    try {
      const res = await runExecute({ job: getJob(sdb, "e1")!, signal: new AbortController().signal });
      expect(res.status).toBe("succeeded");
      expect(res.prUrl).toContain("/pull/");
      expect(res.branch?.startsWith("agent/eng-9-")).toBe(true);
      expect(res.claudeSessionId).toBe("cs-exec");
      // dontAsk + resumed the plan's session id
      expect(captured?.permissionMode).toBe("dontAsk");
      expect(captured?.resume).toBe("cs-plan");
      // The change was committed (clean tree after).
      const wtStatus = (await $`git -C ${captured!.cwd} status --porcelain`.text()).trim();
      expect(wtStatus).toBe("");
      expect(existsSync(join(captured!.cwd, "CHANGED.txt"))).toBe(true);
    } finally {
      restore();
    }
  });

  test("no changes => failed", async () => {
    const sdb = singletonDb();
    insertJob(sdb, {
      job_id: "e2",
      linear_session_id: "es2",
      issue_identifier: "ENG-10",
      kind: "execute",
      idempotency_key: "es2:execute:0",
      status: "running",
    });
    const restore = setRunnerDeps({
      makeLinear: () => nullLinearClient(),
      prepareWorkspace,
      query: () =>
        (async function* () {
          yield { type: "result", subtype: "success", session_id: "cs", result: "nothing to do" } as SDKLikeMessage;
        })(),
    });
    try {
      const res = await runExecute({ job: getJob(sdb, "e2")!, signal: new AbortController().signal });
      expect(res.status).toBe("failed");
      expect(res.reason).toContain("no changes");
    } finally {
      restore();
    }
  });

  test("abort mid-run => aborted, no PR", async () => {
    const sdb = singletonDb();
    insertJob(sdb, {
      job_id: "e3",
      linear_session_id: "es3",
      issue_identifier: "ENG-11",
      kind: "execute",
      idempotency_key: "es3:execute:0",
      status: "running",
    });
    const ac = new AbortController();
    const restore = setRunnerDeps({
      makeLinear: () => nullLinearClient(),
      prepareWorkspace,
      query: () =>
        (async function* () {
          ac.abort();
          yield { type: "result", subtype: "success", session_id: "cs", result: "x" } as SDKLikeMessage;
        })(),
    });
    try {
      const res = await runExecute({ job: getJob(sdb, "e3")!, signal: ac.signal });
      expect(res.status).toBe("aborted");
      expect(res.prUrl).toBeUndefined();
    } finally {
      restore();
    }
  });
});
