// Report terminal job status to Vercel's /api/mini/callback.
//
// Reliability (contract §5 failure path, §6 conventions):
//   - present `Authorization: Bearer <CALLBACK_SECRET>`
//   - stamp CONTRACT_VERSION
//   - any 2xx => accepted, stop retrying (even a dedup no-op)
//   - non-2xx / network error => retry with exponential backoff; persist the payload in the
//     `callbacks` outbox so a boot replay can finish delivery if the process dies.

import { config } from "./config.ts";
import { db, upsertCallback, bumpCallbackAttempt, deleteCallback, dueCallbacks, getCallback } from "./db.ts";
import type { Database } from "bun:sqlite";
import { CONTRACT_VERSION, MiniCallback } from "./contract.ts";
import { log } from "./log.ts";

const MAX_ATTEMPTS = 12;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;

function backoff(attempts: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempts);
}

export interface DeliverDeps {
  database?: Database;
  fetchImpl?: typeof fetch;
}

// Build + validate the callback body, persist it to the outbox, then attempt delivery in the
// background. Returns immediately after the payload is durably queued.
export async function sendCallback(
  payload: Omit<import("./contract.ts").MiniCallback, "contractVersion">,
  deps: DeliverDeps = {},
): Promise<void> {
  const d = deps.database ?? db();
  const full = MiniCallback.parse({ ...payload, contractVersion: CONTRACT_VERSION });
  upsertCallback(d, full.jobId, JSON.stringify(full), Date.now());
  await attemptDelivery(d, full.jobId, deps.fetchImpl ?? fetch);
}

// Attempt one delivery of a queued callback. On success: remove from outbox. On failure:
// schedule the next attempt (the boot replayer / a periodic flush will pick it up).
async function attemptDelivery(d: Database, jobId: string, fetchImpl: typeof fetch): Promise<boolean> {
  const row = getCallback(d, jobId);
  if (!row) return true; // already delivered
  const cfg = config();

  if (!cfg.vercelCallbackUrl || !cfg.callbackSecret) {
    log.warn("callback target not configured; leaving in outbox", { jobId });
    return false;
  }

  try {
    const res = await fetchImpl(cfg.vercelCallbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.callbackSecret}`,
      },
      body: row.payload,
    });
    if (res.ok) {
      deleteCallback(d, jobId);
      log.info("callback delivered", { jobId, status: res.status });
      return true;
    }
    // Contract §7: a 409 contract-version-mismatch is FATAL — retrying never succeeds and only
    // delays the loud failure. Drop the outbox entry permanently and stop, rather than retrying
    // to MAX_ATTEMPTS.
    if (res.status === 409) {
      log.error("callback rejected with 409 contract-version-mismatch; FATAL, dropping (no retry)", {
        jobId,
        status: res.status,
      });
      deleteCallback(d, jobId);
      return false;
    }
    log.warn("callback non-2xx; will retry", { jobId, status: res.status });
  } catch (err) {
    log.warn("callback delivery error; will retry", { jobId, err: String(err) });
  }

  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    // Log the terminal details (esp. prUrl/branch) so a dropped success isn't undiscoverable: the
    // PR may already be open while Vercel never learned, and the workflow will report a timeout.
    let detail: Record<string, unknown> = {};
    try {
      const p = JSON.parse(row.payload) as Partial<MiniCallback>;
      detail = { status: p.status, kind: p.kind, prUrl: p.prUrl, branch: p.branch };
    } catch {
      // payload unparseable — log what we have
    }
    log.error("callback exceeded max attempts; dropping from outbox", { jobId, attempts, ...detail });
    deleteCallback(d, jobId);
    return false;
  }
  bumpCallbackAttempt(d, jobId, Date.now() + backoff(attempts));
  return false;
}

// Replay any undelivered callbacks whose next_attempt_at is due. Called on boot and can be
// called periodically. Best-effort; failures are rescheduled.
export async function flushDueCallbacks(deps: DeliverDeps = {}): Promise<void> {
  const d = deps.database ?? db();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const due = dueCallbacks(d, Date.now());
  for (const row of due) {
    await attemptDelivery(d, row.job_id, fetchImpl);
  }
}

// Background loop: periodically flush the outbox. Returns a stop() function.
export function startCallbackFlusher(intervalMs = 30_000, deps: DeliverDeps = {}): () => void {
  const timer = setInterval(() => {
    flushDueCallbacks(deps).catch((err) => log.warn("flusher error", { err: String(err) }));
  }, intervalMs);
  // Don't keep the process alive solely for the flusher.
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
