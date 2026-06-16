// SQLite (bun:sqlite) — the mini's only persistent state: jobs, workspaces, undelivered
// callbacks. Synchronous API, fast. Plan §3 defines the jobs table; we add workspaces and a
// callbacks outbox.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import type { JobKind, TerminalStatus } from "./contract.ts";

// Mini-internal job status. queued|running are NEVER sent to Vercel; done maps to
// "succeeded" at the callback boundary (contract D1).
export type JobStatus = "queued" | "running" | "done" | "failed" | "aborted";

export interface JobRow {
  job_id: string;
  linear_session_id: string;
  issue_identifier: string;
  kind: JobKind;
  idempotency_key: string;
  prompt_context: string | null;
  feedback: string | null;
  claude_session_id: string | null;
  worktree_path: string | null;
  status: JobStatus;
  pr_url: string | null;
  branch: string | null;
  plan_summary: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface CallbackRow {
  job_id: string;
  payload: string; // JSON of MiniCallback
  attempts: number;
  next_attempt_at: number;
  created_at: number;
}

export interface WorkspaceRow {
  linear_session_id: string;
  repo_url: string;
  bare_path: string;
  worktree_path: string;
  branch: string | null;
  created_at: number;
  updated_at: number;
}

let _db: Database | undefined;

export function db(): Database {
  if (!_db) {
    _db = openDb(config().dbPath);
  }
  return _db;
}

export function openDb(path: string): Database {
  // bun:sqlite's create:true makes the file but NOT its parent dirs — ensure WORK_ROOT exists
  // so the mini self-bootstraps on a fresh machine (skip for the in-memory test DB).
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const d = new Database(path, { create: true, strict: true });
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec("PRAGMA busy_timeout = 5000;");
  d.exec("PRAGMA foreign_keys = ON;");
  migrate(d);
  return d;
}

function migrate(d: Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id            TEXT PRIMARY KEY,
      linear_session_id TEXT NOT NULL,
      issue_identifier  TEXT NOT NULL,
      kind              TEXT NOT NULL,
      idempotency_key   TEXT NOT NULL UNIQUE,
      prompt_context    TEXT,
      feedback          TEXT,
      claude_session_id TEXT,
      worktree_path     TEXT,
      status            TEXT NOT NULL,
      pr_url            TEXT,
      branch            TEXT,
      plan_summary      TEXT,
      reason            TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs (linear_session_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs (status);

    CREATE TABLE IF NOT EXISTS callbacks (
      job_id          TEXT PRIMARY KEY,
      payload         TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      linear_session_id TEXT PRIMARY KEY,
      repo_url          TEXT NOT NULL,
      bare_path         TEXT NOT NULL,
      worktree_path     TEXT NOT NULL,
      branch            TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
  `);
}

const now = () => Date.now();

/* ───────────────────────── jobs ───────────────────────── */

export interface InsertJobInput {
  job_id: string;
  linear_session_id: string;
  issue_identifier: string;
  kind: JobKind;
  idempotency_key: string;
  prompt_context?: string | null;
  feedback?: string | null;
  claude_session_id?: string | null;
  status: JobStatus;
}

export function insertJob(d: Database, j: InsertJobInput): JobRow {
  const ts = now();
  d.query(
    `INSERT INTO jobs (job_id, linear_session_id, issue_identifier, kind, idempotency_key,
       prompt_context, feedback, claude_session_id, worktree_path, status, pr_url, branch,
       plan_summary, reason, created_at, updated_at)
     VALUES ($job_id, $linear_session_id, $issue_identifier, $kind, $idempotency_key,
       $prompt_context, $feedback, $claude_session_id, NULL, $status, NULL, NULL,
       NULL, NULL, $created_at, $updated_at)`,
  ).run({
    job_id: j.job_id,
    linear_session_id: j.linear_session_id,
    issue_identifier: j.issue_identifier,
    kind: j.kind,
    idempotency_key: j.idempotency_key,
    prompt_context: j.prompt_context ?? null,
    feedback: j.feedback ?? null,
    claude_session_id: j.claude_session_id ?? null,
    status: j.status,
    created_at: ts,
    updated_at: ts,
  });
  return getJob(d, j.job_id)!;
}

export function getJob(d: Database, jobId: string): JobRow | null {
  return d.query(`SELECT * FROM jobs WHERE job_id = $id`).get({ id: jobId }) as JobRow | null;
}

export function getJobByIdempotencyKey(d: Database, key: string): JobRow | null {
  return d.query(`SELECT * FROM jobs WHERE idempotency_key = $k`).get({ k: key }) as JobRow | null;
}

export function updateJob(d: Database, jobId: string, patch: Partial<Omit<JobRow, "job_id">>): void {
  // JobRow fields are string | number | null; Partial adds undefined, which we drop (a
  // type-guard filter, so the remaining values are valid SQLite bindings without any cast).
  const entries = Object.entries(patch).filter(
    (e): e is [string, string | number | null] => e[1] !== undefined,
  );
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = $${k}`).join(", ");
  const params: Record<string, string | number | null> = { id: jobId, updated_at: now() };
  for (const [k, v] of entries) params[k] = v;
  d.query(`UPDATE jobs SET ${sets}, updated_at = $updated_at WHERE job_id = $id`).run(params);
}

// Jobs still marked running at boot — the process died mid-job. Reconciliation marks these
// failed/"interrupted" and the caller fires the terminal callback (contract §5 failure path).
export function findRunningJobs(d: Database): JobRow[] {
  return d.query(`SELECT * FROM jobs WHERE status = 'running'`).all() as JobRow[];
}

export function latestClaudeSessionId(d: Database, linearSessionId: string): string | null {
  const row = d
    .query(
      `SELECT claude_session_id FROM jobs
       WHERE linear_session_id = $sid AND claude_session_id IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get({ sid: linearSessionId }) as { claude_session_id: string } | null;
  return row?.claude_session_id ?? null;
}

/* ───────────────────────── callbacks outbox ───────────────────────── */

export function upsertCallback(d: Database, jobId: string, payloadJson: string, nextAttemptAt: number): void {
  d.query(
    `INSERT INTO callbacks (job_id, payload, attempts, next_attempt_at, created_at)
     VALUES ($job_id, $payload, 0, $next, $created)
     ON CONFLICT(job_id) DO UPDATE SET payload = excluded.payload`,
  ).run({ job_id: jobId, payload: payloadJson, next: nextAttemptAt, created: now() });
}

export function bumpCallbackAttempt(d: Database, jobId: string, nextAttemptAt: number): void {
  d.query(
    `UPDATE callbacks SET attempts = attempts + 1, next_attempt_at = $next WHERE job_id = $id`,
  ).run({ id: jobId, next: nextAttemptAt });
}

export function deleteCallback(d: Database, jobId: string): void {
  d.query(`DELETE FROM callbacks WHERE job_id = $id`).run({ id: jobId });
}

export function getCallback(d: Database, jobId: string): CallbackRow | null {
  return d.query(`SELECT * FROM callbacks WHERE job_id = $id`).get({ id: jobId }) as CallbackRow | null;
}

export function dueCallbacks(d: Database, atOrBefore: number): CallbackRow[] {
  return d
    .query(`SELECT * FROM callbacks WHERE next_attempt_at <= $t ORDER BY created_at ASC`)
    .all({ t: atOrBefore }) as CallbackRow[];
}

/* ───────────────────────── workspaces ───────────────────────── */

export function upsertWorkspace(
  d: Database,
  w: Omit<WorkspaceRow, "created_at" | "updated_at">,
): void {
  const ts = now();
  d.query(
    `INSERT INTO workspaces (linear_session_id, repo_url, bare_path, worktree_path, branch, created_at, updated_at)
     VALUES ($sid, $repo, $bare, $wt, $branch, $created, $updated)
     ON CONFLICT(linear_session_id) DO UPDATE SET
       repo_url = excluded.repo_url, bare_path = excluded.bare_path,
       worktree_path = excluded.worktree_path, branch = excluded.branch,
       updated_at = excluded.updated_at`,
  ).run({
    sid: w.linear_session_id,
    repo: w.repo_url,
    bare: w.bare_path,
    wt: w.worktree_path,
    branch: w.branch ?? null,
    created: ts,
    updated: ts,
  });
}

export function getWorkspace(d: Database, linearSessionId: string): WorkspaceRow | null {
  return d.query(`SELECT * FROM workspaces WHERE linear_session_id = $sid`).get({ sid: linearSessionId }) as
    | WorkspaceRow
    | null;
}

export function deleteWorkspace(d: Database, linearSessionId: string): void {
  d.query(`DELETE FROM workspaces WHERE linear_session_id = $sid`).run({ sid: linearSessionId });
}

export function allWorkspaces(d: Database): WorkspaceRow[] {
  return d.query(`SELECT * FROM workspaces`).all() as WorkspaceRow[];
}

// Map mini-internal status -> wire TerminalStatus (contract D1). Returns null for
// non-terminal states, which must never be sent.
export function toTerminalStatus(status: JobStatus): TerminalStatus | null {
  switch (status) {
    case "done":
      return "succeeded";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    default:
      return null;
  }
}
