// HTTP layer (Bun.serve). Implements the mini endpoints from the contract:
//   POST /jobs            create a plan/revise/execute job (validate, auth, dedupe, async run)
//   POST /jobs/reap       sweeper worktree reclamation (idempotent; keeps the claude session)
//   POST /jobs/:id/abort  signal abort (idempotent)
//   POST /jobs/:id/answer deliver answers to a pending mid-run AskUserQuestion (idempotent)
//   GET  /healthz         liveness + load
//
// Route handlers are factored as pure-ish functions over a Deps bundle so they're testable
// without binding a socket. createApp() builds the handlers; startServer() binds Bun.serve.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db.ts";
import type { Database } from "bun:sqlite";
import { config } from "./config.ts";
import { bearerTokenMatches, timingSafeEqualStr } from "./auth.ts";
import { log } from "./log.ts";
import {
  CONTRACT_VERSION,
  CreateJobRequest,
  ReapWorktreeRequest,
  AnswerRequest,
  type CreateJobResponse,
  type AbortJobResponse,
  type HealthzResponse,
  type ReapWorktreeResponse,
  type AnswerResponse,
} from "./contract.ts";
import { getJob, getJobByIdempotencyKey, insertJob, toTerminalStatus } from "./db.ts";
import { sendCallback } from "./callback.ts";
import { setJobToken } from "./job-tokens.ts";
import { JobController, type Runner } from "./jobctl.ts";
import { makeRunner } from "./runners/index.ts";
import { reapWorktree } from "./workspace/index.ts";
import { resolveQuestion } from "./questions.ts";

const START_TIME = Date.now();

export interface App {
  controller: JobController;
  handleCreateJob(req: Request): Promise<Response>;
  handleAbort(jobId: string, req: Request): Promise<Response>;
  handleReap(req: Request): Promise<Response>;
  handleAnswer(jobId: string, req: Request): Promise<Response>;
  handleHealthz(req: Request): Response;
  fetch(req: Request): Promise<Response>;
}

export interface AppDeps {
  database?: Database;
  runner?: Runner;
  fetchImpl?: typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Contract §7: a version mismatch responds 409 with this EXACT body on both /jobs and /jobs/reap.
// `error` is the stable discriminator; `contractVersion` (the version THIS side speaks) is for
// diagnostics. A received 409 is fatal — the caller must not retry.
const versionMismatch = () =>
  json({ error: "contract-version-mismatch", contractVersion: CONTRACT_VERSION }, 409);

// True when the parsed body declares a contractVersion that doesn't match what we speak.
function hasVersionMismatch(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "contractVersion" in raw &&
    (raw as { contractVersion?: unknown }).contractVersion !== CONTRACT_VERSION
  );
}

// Primary app-layer auth: every endpoint requires `Authorization: Bearer <MINI_AUTH_SECRET>`,
// compared in constant time. Fails CLOSED — when MINI_AUTH_SECRET is unset every request is
// rejected, so a misconfigured mini never serves unauthenticated jobs (the endpoints drive the
// Agent SDK + git/PR with real tokens). This is independent of Cloudflare Access.
function bearerOk(req: Request): boolean {
  return bearerTokenMatches(req.headers.get("authorization"), config().miniAuthSecret);
}

// Defense-in-depth: Cloudflare Access already enforces the service token at the edge, but if
// ENFORCE_CF_ACCESS is set we additionally require matching headers (read both casings).
// Fails CLOSED — if enforcement is requested but the tokens aren't configured, reject rather than
// silently allow-all. Constant-time comparison, like bearerOk.
function cfAccessOk(req: Request): boolean {
  const cfg = config();
  if (!cfg.enforceCfAccess) return true;
  if (!cfg.cfAccessClientId || !cfg.cfAccessClientSecret) return false;
  const h = req.headers;
  const id = h.get("CF-Access-Client-Id") ?? h.get("cf-access-client-id");
  const secret = h.get("CF-Access-Client-Secret") ?? h.get("cf-access-client-secret");
  return timingSafeEqualStr(id, cfg.cfAccessClientId) && timingSafeEqualStr(secret, cfg.cfAccessClientSecret);
}

// Single auth gate for every endpoint: bearer first (401), then CF Access (403). Returns the
// failing Response, or null when the request is authorized.
function authDenied(req: Request): Response | null {
  if (!bearerOk(req)) return json({ error: "unauthorized" }, 401);
  if (!cfAccessOk(req)) return json({ error: "forbidden" }, 403);
  return null;
}

export function createApp(deps: AppDeps = {}): App {
  const d = deps.database ?? db();
  const controller = new JobController({
    database: d,
    runner: deps.runner ?? makeRunner(),
    fetchImpl: deps.fetchImpl,
  });

  async function handleCreateJob(req: Request): Promise<Response> {
    const denied = authDenied(req);
    if (denied) return denied;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ error: "invalid-json" }, 400);
    }

    // Fail loudly on a half-deployed pair (contract §7 / D8). Check version before full parse
    // so a mismatch is a clean 409 rather than a generic validation error.
    if (hasVersionMismatch(raw)) return versionMismatch();

    const parsed = CreateJobRequest.safeParse(raw);
    if (!parsed.success) {
      return json({ error: "validation", issues: z.treeifyError(parsed.error) }, 400);
    }
    const body = parsed.data;

    // Idempotency (contract D4): same key => same jobId, no second job. Defense-in-depth: the key
    // is attacker-derivable (`${sid}:${kind}:${round}`), so verify the rest of the body matches the
    // stored job before echoing its id back — a mismatch means someone is reusing a key for a
    // different request, which we reject rather than silently bind them to the existing job.
    const existing = getJobByIdempotencyKey(d, body.idempotencyKey);
    if (existing) {
      if (existing.linear_session_id !== body.linearSessionId || existing.kind !== body.kind) {
        log.warn("idempotency key reused for a different request; rejecting", {
          idempotencyKey: body.idempotencyKey,
        });
        return json({ error: "idempotency-key-conflict" }, 409);
      }
      // If the job already reached a terminal state, re-fire its callback. A retried create means
      // the original CreateJobResponse may have been lost; if the original callback was also lost,
      // the workflow is waiting on a jobDoneHook that would otherwise never resume again. The
      // outbox + Vercel-side dedupe make a redundant re-delivery harmless.
      const terminal = toTerminalStatus(existing.status);
      if (terminal) {
        void sendCallback(
          {
            jobId: existing.job_id,
            linearSessionId: existing.linear_session_id,
            kind: existing.kind,
            status: terminal,
            prUrl: existing.pr_url ?? undefined,
            branch: existing.branch ?? undefined,
            planSummary: existing.plan_summary ?? undefined,
            claudeSessionId: existing.claude_session_id ?? undefined,
            reason: existing.reason ?? undefined,
          },
          { database: d, fetchImpl: deps.fetchImpl },
        ).catch((err) => log.error("re-fire callback failed", { jobId: existing.job_id, err: String(err) }));
      }
      log.info("idempotent /jobs hit", { idempotencyKey: body.idempotencyKey, jobId: existing.job_id });
      const queued = existing.status === "queued";
      const res: CreateJobResponse = { jobId: existing.job_id, queued };
      return json(res, queued ? 202 : 200);
    }

    const jobId = randomUUID();
    insertJob(d, {
      job_id: jobId,
      linear_session_id: body.linearSessionId,
      issue_identifier: body.issueIdentifier,
      kind: body.kind,
      idempotency_key: body.idempotencyKey,
      prompt_context: body.promptContext ?? null,
      feedback: body.feedback ?? null,
      claude_session_id: body.claudeSessionId ?? null,
      status: "queued",
    });

    // Stash the per-job Linear token in memory (NOT SQLite). New-job path only — the idempotent-hit
    // branch above keeps the original job's token. Evicted when the job ends (jobctl `finally`).
    if (body.linearAccessToken) setJobToken(jobId, body.linearAccessToken);

    const { queued } = controller.submit(jobId);
    const res: CreateJobResponse = { jobId, queued };
    return json(res, queued ? 202 : 200);
  }

  async function handleAbort(jobId: string, req: Request): Promise<Response> {
    const denied = authDenied(req);
    if (denied) return denied;
    const job = getJob(d, jobId);
    // Unknown or already-finished => no-op (contract: aborted:false). The eventual terminal
    // callback (for a live job) carries status:"aborted".
    const aborted = job ? controller.abort(jobId) : false;
    const res: AbortJobResponse = { jobId, aborted };
    return json(res, 200);
  }

  async function handleReap(req: Request): Promise<Response> {
    const denied = authDenied(req);
    if (denied) return denied;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ error: "invalid-json" }, 400);
    }
    if (hasVersionMismatch(raw)) return versionMismatch();

    const parsed = ReapWorktreeRequest.safeParse(raw);
    if (!parsed.success) {
      return json({ error: "validation", issues: z.treeifyError(parsed.error) }, 400);
    }

    // Remove the session's worktree to reclaim disk. The job rows (incl. claude_session_id) are
    // KEPT, so a late reply can recreate the worktree and resume. Idempotent: unknown/already-
    // reaped session => reaped:false, still 200.
    const reaped = await reapWorktree(parsed.data.linearSessionId, d);
    const res: ReapWorktreeResponse = { linearSessionId: parsed.data.linearSessionId, reaped };
    return json(res, 200);
  }

  // POST /jobs/:id/answer — Vercel delivers the user's answers to a pending mid-run question.
  // The questionId in the body is the primary correlation key (a job may have asked, the run moved
  // on, then a stale answer arrives), but the :id (jobId) is enforced too: an answer only resolves
  // a pending question that belongs to that job, so a wrong-job answer can't be honored.
  // delivered=false if no pending question matched (stale/unknown/wrong-job), still 200.
  async function handleAnswer(jobId: string, req: Request): Promise<Response> {
    const denied = authDenied(req);
    if (denied) return denied;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ error: "invalid-json" }, 400);
    }
    if (hasVersionMismatch(raw)) return versionMismatch();

    const parsed = AnswerRequest.safeParse(raw);
    if (!parsed.success) {
      return json({ error: "validation", issues: z.treeifyError(parsed.error) }, 400);
    }

    const delivered = resolveQuestion(parsed.data.questionId, parsed.data.answers, jobId);
    const res: AnswerResponse = { questionId: parsed.data.questionId, delivered };
    return json(res, 200);
  }

  function handleHealthz(req: Request): Response {
    const denied = authDenied(req);
    if (denied) return denied;
    const res: HealthzResponse = {
      ok: true,
      runningJobs: controller.runningJobs(),
      maxConcurrentExecutions: config().maxConcurrentExecutions,
      uptimeSeconds: (Date.now() - START_TIME) / 1000,
    };
    return json(res, 200);
  }

  // THE router: a single method+path dispatcher used by both the tests (via app.fetch) and the
  // real server (startServer forwards Bun.serve to it), so every endpoint is declared exactly once.
  async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    if (req.method === "POST" && pathname === "/jobs") return handleCreateJob(req);
    if (req.method === "POST" && pathname === "/jobs/reap") return handleReap(req);
    const abortMatch = pathname.match(/^\/jobs\/([^/]+)\/abort$/);
    if (req.method === "POST" && abortMatch) return handleAbort(decodeURIComponent(abortMatch[1]!), req);
    const answerMatch = pathname.match(/^\/jobs\/([^/]+)\/answer$/);
    if (req.method === "POST" && answerMatch) return handleAnswer(decodeURIComponent(answerMatch[1]!), req);
    if (req.method === "GET" && pathname === "/healthz") return handleHealthz(req);
    return json({ error: "not-found" }, 404);
  }

  return {
    controller,
    handleCreateJob,
    handleAbort,
    handleReap,
    handleAnswer,
    handleHealthz,
    fetch: fetchHandler,
  };
}

export function startServer(deps: AppDeps = {}) {
  const app = createApp(deps);
  const server = Bun.serve({
    // Bind loopback ONLY: the sole intended ingress is the co-located cloudflared daemon
    // forwarding the tunnel to localhost. Never expose :3001 on the LAN/Tailscale interface,
    // which would let an in-network peer bypass Cloudflare Access and hit /jobs directly.
    hostname: "127.0.0.1",
    port: config().port,
    // Forward every request to the single dispatcher (app.fetch) so routes live in one place.
    fetch: (req) => app.fetch(req),
  });
  log.info("mini server listening", { url: String(server.url), contractVersion: CONTRACT_VERSION });
  return { app, server };
}
