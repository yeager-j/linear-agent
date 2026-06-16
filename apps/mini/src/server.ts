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
import { getJob, getJobByIdempotencyKey, insertJob } from "./db.ts";
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
  handleHealthz(): Response;
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

// Defense-in-depth: Cloudflare Access already enforces the service token at the edge, but if
// ENFORCE_CF_ACCESS is set we additionally require matching headers (read both casings).
function cfAccessOk(req: Request): boolean {
  const cfg = config();
  if (!cfg.enforceCfAccess) return true;
  if (!cfg.cfAccessClientId || !cfg.cfAccessClientSecret) return true; // nothing to compare against
  const h = req.headers;
  const id = h.get("CF-Access-Client-Id") ?? h.get("cf-access-client-id");
  const secret = h.get("CF-Access-Client-Secret") ?? h.get("cf-access-client-secret");
  return id === cfg.cfAccessClientId && secret === cfg.cfAccessClientSecret;
}

export function createApp(deps: AppDeps = {}): App {
  const d = deps.database ?? db();
  const controller = new JobController({
    database: d,
    runner: deps.runner ?? makeRunner(),
    fetchImpl: deps.fetchImpl,
  });

  async function handleCreateJob(req: Request): Promise<Response> {
    if (!cfAccessOk(req)) return json({ error: "forbidden" }, 403);

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

    // Idempotency (contract D4): same key => same jobId, no second job.
    const existing = getJobByIdempotencyKey(d, body.idempotencyKey);
    if (existing) {
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

    const { queued } = controller.submit(jobId);
    const res: CreateJobResponse = { jobId, queued };
    return json(res, queued ? 202 : 200);
  }

  async function handleAbort(jobId: string, req: Request): Promise<Response> {
    if (!cfAccessOk(req)) return json({ error: "forbidden" }, 403);
    const job = getJob(d, jobId);
    // Unknown or already-finished => no-op (contract: aborted:false). The eventual terminal
    // callback (for a live job) carries status:"aborted".
    const aborted = job ? controller.abort(jobId) : false;
    const res: AbortJobResponse = { jobId, aborted };
    return json(res, 200);
  }

  async function handleReap(req: Request): Promise<Response> {
    if (!cfAccessOk(req)) return json({ error: "forbidden" }, 403);

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
  // The :id (jobId) is informational; the questionId in the body is the authoritative correlation
  // key (a job may have asked, the run moved on, then a stale answer arrives). delivered=false if
  // no pending question matched (stale/unknown), still 200.
  async function handleAnswer(_jobId: string, req: Request): Promise<Response> {
    if (!cfAccessOk(req)) return json({ error: "forbidden" }, 403);

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

    const delivered = resolveQuestion(parsed.data.questionId, parsed.data.answers);
    const res: AnswerResponse = { questionId: parsed.data.questionId, delivered };
    return json(res, 200);
  }

  function handleHealthz(): Response {
    const res: HealthzResponse = {
      ok: true,
      runningJobs: controller.runningJobs(),
      maxConcurrentExecutions: config().maxConcurrentExecutions,
      uptimeSeconds: (Date.now() - START_TIME) / 1000,
    };
    return json(res, 200);
  }

  // Fallback dispatcher for environments/tests that drive a single fetch(). The real server
  // uses Bun.serve routes (startServer), but this keeps everything addressable in one place.
  async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    if (req.method === "POST" && pathname === "/jobs") return handleCreateJob(req);
    if (req.method === "POST" && pathname === "/jobs/reap") return handleReap(req);
    const abortMatch = pathname.match(/^\/jobs\/([^/]+)\/abort$/);
    if (req.method === "POST" && abortMatch) return handleAbort(decodeURIComponent(abortMatch[1]!), req);
    const answerMatch = pathname.match(/^\/jobs\/([^/]+)\/answer$/);
    if (req.method === "POST" && answerMatch) return handleAnswer(decodeURIComponent(answerMatch[1]!), req);
    if (req.method === "GET" && pathname === "/healthz") return handleHealthz();
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
    port: config().port,
    routes: {
      "/jobs": {
        POST: (req) => app.handleCreateJob(req),
      },
      "/jobs/reap": {
        POST: (req) => app.handleReap(req),
      },
      "/jobs/:id/abort": {
        POST: (req) => app.handleAbort(req.params.id, req),
      },
      "/jobs/:id/answer": {
        POST: (req) => app.handleAnswer(req.params.id, req),
      },
      "/healthz": {
        GET: () => app.handleHealthz(),
      },
    },
    fetch() {
      return new Response(JSON.stringify({ error: "not-found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  log.info("mini server listening", { url: String(server.url), contractVersion: CONTRACT_VERSION });
  return { app, server };
}
