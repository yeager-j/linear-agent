// Question client: Mini → Vercel POST /api/mini/question (mid-run HITL).
//
// The agent asked a clarifying question; we ask Vercel to elicit the answer(s) in Linear. The
// Vercel workflow's questionHook may be momentarily unregistered (replay/registration race), so
// we retry with backoff. A 409 contract-version-mismatch is FATAL (retrying never succeeds —
// contract §7). Unlike the terminal callback there is no persistent outbox: a question is only
// meaningful while the run is blocked on it, so if delivery ultimately fails we throw and the
// canUseTool handler aborts the run.

import { config } from "./config.ts";
import { CONTRACT_VERSION, AskQuestionRequest } from "./contract.ts";
import { log } from "./log.ts";

const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

// Thrown when the peer reports a contract-version mismatch — fatal, do not retry.
export class ContractVersionMismatchError extends Error {
  constructor() {
    super("contract-version-mismatch");
    this.name = "ContractVersionMismatchError";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Derive the question URL from VERCEL_CALLBACK_URL by swapping the path segment. Keeps a single
// configured base (contract §6) and avoids a second env var.
export function questionUrlFrom(callbackUrl: string): string {
  return callbackUrl.replace(/\/api\/mini\/callback$/, "/api/mini/question");
}

export interface SendQuestionDeps {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal; // abort the retry loop when the job is aborted
  sleepImpl?: (ms: number) => Promise<void>; // injectable backoff for fast, deterministic tests
}

// POST the question to Vercel. Resolves on a 2xx ack; throws on fatal 409 or after exhausting
// retries (or if aborted).
export async function sendQuestion(
  req: Omit<import("./contract.ts").AskQuestionRequest, "contractVersion">,
  deps: SendQuestionDeps = {},
): Promise<void> {
  const cfg = config();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const doSleep = deps.sleepImpl ?? sleep;

  if (!cfg.vercelCallbackUrl || !cfg.callbackSecret) {
    throw new Error("question target not configured (VERCEL_CALLBACK_URL / CALLBACK_SECRET)");
  }
  const url = questionUrlFrom(cfg.vercelCallbackUrl);
  const body = JSON.stringify(AskQuestionRequest.parse({ ...req, contractVersion: CONTRACT_VERSION }));

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (deps.signal?.aborted) throw new Error("aborted");
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.callbackSecret}`,
        },
        body,
        signal: deps.signal,
      });
      if (res.ok) {
        log.info("question delivered", { questionId: req.questionId, jobId: req.jobId });
        return;
      }
      if (res.status === 409) {
        log.error("question rejected with 409 contract-version-mismatch; FATAL (no retry)", {
          questionId: req.questionId,
        });
        throw new ContractVersionMismatchError();
      }
      lastErr = new Error(`question POST non-2xx: ${res.status}`);
      log.warn("question non-2xx; will retry", { questionId: req.questionId, status: res.status });
    } catch (err) {
      if (err instanceof ContractVersionMismatchError) throw err;
      if (deps.signal?.aborted) throw new Error("aborted");
      lastErr = err;
      log.warn("question delivery error; will retry", { questionId: req.questionId, err: String(err) });
    }
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
    await doSleep(delay);
  }
  throw new Error(`question delivery failed after ${MAX_ATTEMPTS} attempts: ${String(lastErr)}`);
}
