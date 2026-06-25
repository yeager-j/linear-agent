import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runPlan } from "./plan.ts";
import { setRunnerDeps } from "./deps.ts";
import { freshDb, testConfig } from "../test-helpers.ts";
import { insertJob, getJob } from "../db.ts";
import { nullLinearClient } from "../linear.ts";
import { setJobToken, deleteJobToken } from "../job-tokens.ts";
import type { SDKLikeMessage } from "../activity-bridge.ts";
import type { QueryFn, QueryParams } from "../sdk.ts";
import type { Database } from "bun:sqlite";

let d: Database;
let restore: (() => void) | undefined;

function fakeQuery(msgs: SDKLikeMessage[], capture?: (p: QueryParams) => void): QueryFn {
  return (params) => {
    capture?.(params);
    return (async function* () {
      for (const m of msgs) yield m;
    })();
  };
}

const fakeWorkspace = async (opts: { linearSessionId: string }) => ({
  linearSessionId: opts.linearSessionId,
  repoUrl: "git@github.com:o/r.git",
  barePath: "/tmp/bare.git",
  worktreePath: "/tmp/wt",
  branch: "agent/eng-1-abcd",
});

beforeEach(() => {
  d = freshDb();
  // db() singleton is used by runPlan; point the test db in via the module singleton.
  // We achieve isolation by passing database into prepareWorkspace fake + using latestClaudeSessionId
  // on the same db. runPlan calls db() directly, so set DB_PATH to in-memory and rely on a fresh
  // singleton per process is not enough across tests — instead we inject a prepareWorkspace that
  // ignores db, and stub claude session lookups through the jobs we insert via the singleton db.
  testConfig({ defaultRepoUrl: "git@github.com:o/r.git", activityThrottleMs: 0, dbPath: ":memory:" });
});

afterEach(() => {
  restore?.();
  restore = undefined;
});

// runPlan uses db() (the singleton). For deterministic tests we override prepareWorkspace and
// query, and use the singleton db for job rows.
import { db as singletonDb } from "../db.ts";

describe("runPlan", () => {
  test("plan job: streams, captures session id + summary, succeeds", async () => {
    const sdb = singletonDb();
    insertJob(sdb, {
      job_id: "j1",
      linear_session_id: "s1",
      issue_identifier: "ENG-1",
      kind: "plan",
      idempotency_key: "s1:plan:0",
      prompt_context: "<issue>do X</issue>",
      status: "running",
    });
    let captured: QueryParams | undefined;
    restore = setRunnerDeps({
      makeLinear: () => nullLinearClient(),
      prepareWorkspace: fakeWorkspace as never,
      query: fakeQuery(
        [
          { type: "system", subtype: "init", session_id: "cs-1" },
          { type: "assistant", session_id: "cs-1", message: { content: [{ type: "text", text: "hi" }] } },
          { type: "result", subtype: "success", session_id: "cs-1", result: "Plan: 1. X" },
        ],
        (p) => (captured = p),
      ),
    });

    const job = getJob(sdb, "j1")!;
    const res = await runPlan({ job, signal: new AbortController().signal });

    expect(res.status).toBe("succeeded");
    expect(res.claudeSessionId).toBe("cs-1");
    expect(res.planSummary).toBe("Plan: 1. X");
    expect(captured?.permissionMode).toBe("plan");
    expect(captured?.cwd).toBe("/tmp/wt");
    expect(captured?.resume).toBeUndefined();
  });

  test("revise job: resumes the stored claude session id", async () => {
    const sdb = singletonDb();
    insertJob(sdb, {
      job_id: "j2",
      linear_session_id: "s2",
      issue_identifier: "ENG-2",
      kind: "revise",
      idempotency_key: "s2:revise:1",
      feedback: "tweak it",
      claude_session_id: "cs-prev",
      status: "running",
    });
    let captured: QueryParams | undefined;
    restore = setRunnerDeps({
      makeLinear: () => nullLinearClient(),
      prepareWorkspace: fakeWorkspace as never,
      query: fakeQuery(
        [{ type: "result", subtype: "success", session_id: "cs-prev", result: "Revised plan" }],
        (p) => (captured = p),
      ),
    });

    const job = getJob(sdb, "j2")!;
    const res = await runPlan({ job, signal: new AbortController().signal });

    expect(res.status).toBe("succeeded");
    expect(res.planSummary).toBe("Revised plan");
    expect(captured?.resume).toBe("cs-prev");
    expect(captured?.prompt).toContain("tweak it");
  });

  test("missing repo config => failed", async () => {
    testConfig({ defaultRepoUrl: undefined, dbPath: ":memory:" });
    const sdb = singletonDb();
    insertJob(sdb, {
      job_id: "j3",
      linear_session_id: "s3",
      issue_identifier: "ENG-3",
      kind: "plan",
      idempotency_key: "s3:plan:0",
      status: "running",
    });
    const res = await runPlan({ job: getJob(sdb, "j3")!, signal: new AbortController().signal });
    expect(res.status).toBe("failed");
    expect(res.reason).toContain("no repo configured");
  });

  test("abort during run => aborted", async () => {
    const sdb = singletonDb();
    insertJob(sdb, {
      job_id: "j4",
      linear_session_id: "s4",
      issue_identifier: "ENG-4",
      kind: "plan",
      idempotency_key: "s4:plan:0",
      prompt_context: "x",
      status: "running",
    });
    const ac = new AbortController();
    restore = setRunnerDeps({
      makeLinear: () => nullLinearClient(),
      prepareWorkspace: fakeWorkspace as never,
      query: () =>
        (async function* () {
          ac.abort(); // abort mid-stream
          yield { type: "result", subtype: "success", result: "won't matter" } as SDKLikeMessage;
        })(),
    });
    const res = await runPlan({ job: getJob(sdb, "j4")!, signal: ac.signal });
    expect(res.status).toBe("aborted");
  });

  test("passes the per-job token to makeLinear", async () => {
    const sdb = singletonDb();
    insertJob(sdb, {
      job_id: "j5",
      linear_session_id: "s5",
      issue_identifier: "ENG-5",
      kind: "plan",
      idempotency_key: "s5:plan:0",
      prompt_context: "x",
      status: "running",
    });
    setJobToken("j5", "per-job-tok");
    let seenToken: string | undefined;
    restore = setRunnerDeps({
      makeLinear: (token) => {
        seenToken = token;
        return nullLinearClient();
      },
      prepareWorkspace: fakeWorkspace as never,
      query: fakeQuery([{ type: "result", subtype: "success", session_id: "cs", result: "Plan" }]),
    });
    await runPlan({ job: getJob(sdb, "j5")!, signal: new AbortController().signal });
    expect(seenToken).toBe("per-job-tok");
    deleteJobToken("j5");
  });

  test("no per-job token and no env fallback => failed missing-linear-token", async () => {
    testConfig({ linearAccessToken: undefined, defaultRepoUrl: "git@github.com:o/r.git", dbPath: ":memory:" });
    const sdb = singletonDb();
    insertJob(sdb, {
      job_id: "j6",
      linear_session_id: "s6",
      issue_identifier: "ENG-6",
      kind: "plan",
      idempotency_key: "s6:plan:0",
      prompt_context: "x",
      status: "running",
    });
    const res = await runPlan({ job: getJob(sdb, "j6")!, signal: new AbortController().signal });
    expect(res.status).toBe("failed");
    expect(res.reason).toBe("missing-linear-token");
  });
});
