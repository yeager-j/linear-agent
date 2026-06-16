// Mini HTTP client — the ONLY module that calls the mini over the Cloudflare tunnel. Sends the
// CF-Access service-token headers on every request (contract §2), validates responses against the
// shared zod schemas, honors the contract version, and retries transient failures with backoff.
// Every function here is meant to be called from inside a workflow `"use step"`.

import {
  AbortJobResponse,
  AnswerRequest,
  AnswerResponse,
  CONTRACT_VERSION,
  CreateJobRequest,
  CreateJobResponse,
  HealthzResponse,
  ReapWorktreeRequest,
  ReapWorktreeResponse,
  type AnswerResponse as AnswerResponseT,
  type CreateJobResponse as CreateJobResponseT,
  type HealthzResponse as HealthzResponseT,
  type JobKind,
  type ReapWorktreeResponse as ReapWorktreeResponseT,
} from "./contract";
import { env } from "./env";

class ContractVersionMismatchError extends Error {
  constructor(public readonly got: string | undefined) {
    super(`mini contract-version mismatch: expected ${CONTRACT_VERSION}, got ${got ?? "none"}`);
    this.name = "ContractVersionMismatchError";
  }
}

function miniHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // Cloudflare Access service token (contract §2). Missing/invalid => 403 at the edge.
    "CF-Access-Client-Id": env.cfAccessClientId(),
    "CF-Access-Client-Secret": env.cfAccessClientSecret(),
  };
}

const RETRYABLE_STATUS = new Set([502, 503, 504, 429]);
const MAX_ATTEMPTS = 4;

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// fetch with bounded retry/backoff for transient transport failures. A 409 (contract-version
// mismatch) is NOT retried — it's a deploy-time signal. Non-retryable HTTP errors throw immediately.
async function miniFetch(path: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${env.miniBaseUrl()}${path}`, init);
      if (res.status === 409) {
        // 409 body is {error:"contract-version-mismatch", contractVersion:"<mini's version>"}
        // in both directions (contract §7). Use `error` as the discriminator; keep
        // contractVersion for diagnostics. Not retried — it's a deploy-time signal.
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          contractVersion?: string;
        };
        throw new ContractVersionMismatchError(body.contractVersion);
      }
      if (RETRYABLE_STATUS.has(res.status)) {
        lastErr = new Error(`mini ${path} HTTP ${res.status}`);
      } else {
        return res;
      }
    } catch (err) {
      if (err instanceof ContractVersionMismatchError) throw err;
      lastErr = err;
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleepMs(250 * 2 ** attempt);
  }
  throw lastErr instanceof Error ? lastErr : new Error(`mini ${path} failed`);
}

/* ───────────────────────── POST /jobs ───────────────────────── */

export async function createJob(args: {
  kind: JobKind;
  linearSessionId: string;
  issueIdentifier: string;
  round: number;
  promptContext?: string;
  feedback?: string;
  claudeSessionId?: string;
}): Promise<CreateJobResponseT> {
  // idempotencyKey = `${linearSessionId}:${kind}:${round}` (contract §4 D4) — deterministic across
  // workflow replays, so a retried POST returns the same jobId instead of spawning a new job.
  const body = CreateJobRequest.parse({
    contractVersion: CONTRACT_VERSION,
    kind: args.kind,
    linearSessionId: args.linearSessionId,
    issueIdentifier: args.issueIdentifier,
    promptContext: args.promptContext,
    feedback: args.feedback,
    claudeSessionId: args.claudeSessionId,
    idempotencyKey: `${args.linearSessionId}:${args.kind}:${args.round}`,
  });

  const res = await miniFetch("/jobs", {
    method: "POST",
    headers: miniHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`mini POST /jobs HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return CreateJobResponse.parse(await res.json());
}

/* ───────────────────────── POST /jobs/:id/abort ───────────────────────── */

export async function abortJob(jobId: string): Promise<void> {
  const res = await miniFetch(`/jobs/${encodeURIComponent(jobId)}/abort`, {
    method: "POST",
    headers: miniHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`mini POST /jobs/${jobId}/abort HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  // Validate but don't act on the result; the terminal `aborted` callback is authoritative.
  AbortJobResponse.parse(await res.json());
}

/* ───────────────────────── POST /jobs/:id/answer ───────────────────────── */

// Deliver the user's answers to a mid-run AskUserQuestion so the agent's run continues
// (contract: AnswerRequest/AnswerResponse). jobId is the path param; the body carries questionId
// + the answers map (question text → chosen label(s)). 409 is fatal-no-retry (handled by
// miniFetch); transient failures get bounded retry.
export async function deliverAnswer(
  jobId: string,
  questionId: string,
  answers: Record<string, string>,
): Promise<AnswerResponseT> {
  const body = AnswerRequest.parse({
    contractVersion: CONTRACT_VERSION,
    questionId,
    answers,
  });
  const res = await miniFetch(`/jobs/${encodeURIComponent(jobId)}/answer`, {
    method: "POST",
    headers: miniHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`mini POST /jobs/${jobId}/answer HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return AnswerResponse.parse(await res.json());
}

/* ───────────────────────── POST /jobs/reap ───────────────────────── */

// Sweeper-driven worktree reclamation (plan §7, contract §1). Best-effort — the CALLER
// decides what to do on failure; this throws on transport/HTTP/version errors so the workflow
// step can log-and-continue without failing the run.
export async function reapWorktree(linearSessionId: string): Promise<ReapWorktreeResponseT> {
  const body = ReapWorktreeRequest.parse({
    contractVersion: CONTRACT_VERSION,
    linearSessionId,
  });
  const res = await miniFetch("/jobs/reap", {
    method: "POST",
    headers: miniHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`mini POST /jobs/reap HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return ReapWorktreeResponse.parse(await res.json());
}

/* ───────────────────────── GET /healthz ───────────────────────── */

export async function healthz(): Promise<HealthzResponseT> {
  const res = await miniFetch("/healthz", { method: "GET", headers: miniHeaders() });
  if (!res.ok) {
    throw new Error(`mini GET /healthz HTTP ${res.status}`);
  }
  return HealthzResponse.parse(await res.json());
}

export { ContractVersionMismatchError };
