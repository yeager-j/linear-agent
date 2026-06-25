// Neon access (plan §3, open-questions.md D9). Two tables: `sessions` (linearSessionId ->
// workflowRunId map) and `webhook_deliveries` (delivery-id dedupe set). The driver is created
// lazily so importing this module never requires DATABASE_URL (tests inject a fake client).

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { env } from "./env";

let _sql: NeonQueryFunction<false, false> | null = null;

function sql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    _sql = neon(env.databaseUrl());
  }
  return _sql;
}

// Test seam: inject a fake tagged-template query function.
export function __setSqlForTests(fn: NeonQueryFunction<false, false> | null): void {
  _sql = fn;
}

/* ───────────────────────── Webhook dedupe ───────────────────────── */

// Insert-or-ignore on the delivery id BEFORE start/resume (contract §4). Returns true when this
// is the FIRST time we've seen this delivery (caller should process it), false on a duplicate.
export async function claimDelivery(deliveryId: string): Promise<boolean> {
  const rows = await sql()`
    INSERT INTO webhook_deliveries (delivery_id)
    VALUES (${deliveryId})
    ON CONFLICT (delivery_id) DO NOTHING
    RETURNING delivery_id
  `;
  return Array.isArray(rows) && rows.length > 0;
}

// Undo a claim when processing failed before any durable side effect (e.g. start() threw), so
// Linear's retry of the SAME delivery re-processes it instead of seeing a phantom duplicate.
export async function releaseDelivery(deliveryId: string): Promise<void> {
  await sql()`DELETE FROM webhook_deliveries WHERE delivery_id = ${deliveryId}`;
}

/* ───────────────────────── Session map ───────────────────────── */

export async function insertSession(params: {
  linearSessionId: string;
  workflowRunId: string;
  issueIdentifier: string;
}): Promise<void> {
  await sql()`
    INSERT INTO sessions (linear_session_id, workflow_run_id, issue_identifier)
    VALUES (${params.linearSessionId}, ${params.workflowRunId}, ${params.issueIdentifier})
    ON CONFLICT (linear_session_id) DO NOTHING
  `;
}

export async function getSession(
  linearSessionId: string,
): Promise<{ workflowRunId: string; issueIdentifier: string } | null> {
  const rows = await sql()`
    SELECT workflow_run_id, issue_identifier
    FROM sessions
    WHERE linear_session_id = ${linearSessionId}
  `;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return null;
  return {
    workflowRunId: row.workflow_run_id as string,
    issueIdentifier: row.issue_identifier as string,
  };
}

/* ───────────────────────── Linear OAuth token store (single row id='linear') ─────────────────────────
 * Vercel is the sole token authority. The access token rotates ~daily; lib/linear-token.ts refreshes
 * it under a claim-fenced CAS — the Neon HTTP driver can't hold a lock across the external refresh
 * call, so concurrency control is an atomic claim UPDATE + a fenced store UPDATE, not a row lock.
 */

export interface LinearTokenRow {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export async function readLinearToken(): Promise<LinearTokenRow | null> {
  const rows = await sql()`
    SELECT access_token, refresh_token, expires_at FROM linear_tokens WHERE id = 'linear'
  `;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return null;
  return {
    accessToken: row.access_token as string,
    refreshToken: row.refresh_token as string,
    expiresAt: new Date(row.expires_at as string),
  };
}

// Atomic claim: exactly one caller wins (Postgres serializes the row UPDATE → only one gets a
// RETURNING row). `claimId` is an opaque fence written into the row; the winner presents it on
// storeRefreshedToken/markRefreshError, so a self-expired claim taken over by another refresher
// can't blind-write a stale pair. Returns the refresh_token to use, or null when a claim is already
// held (another refresh is in flight).
export async function claimLinearRefresh(
  claimId: string,
  staleSeconds: number,
): Promise<{ refreshToken: string } | null> {
  const rows = await sql()`
    UPDATE linear_tokens
       SET refreshing_at = now(), refresh_claim = ${claimId}
     WHERE id = 'linear'
       AND (refreshing_at IS NULL OR refreshing_at < now() - make_interval(secs => ${staleSeconds}))
     RETURNING refresh_token
  `;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return null;
  return { refreshToken: row.refresh_token as string };
}

// Fenced store: writes the rotated pair ONLY if we still own the claim. Returns false when the claim
// was lost mid-flight (self-expired, another refresher took over) — the caller must discard its
// freshly-minted pair (the winner's is authoritative) and re-read.
export async function storeRefreshedToken(
  claimId: string,
  pair: { accessToken: string; refreshToken: string; expiresAt: Date },
): Promise<boolean> {
  const rows = await sql()`
    UPDATE linear_tokens
       SET access_token = ${pair.accessToken},
           refresh_token = ${pair.refreshToken},
           expires_at = ${pair.expiresAt.toISOString()},
           refreshing_at = NULL,
           refresh_claim = NULL,
           last_refresh_at = now(),
           last_refresh_error = NULL,
           updated_at = now()
     WHERE id = 'linear' AND refresh_claim = ${claimId}
     RETURNING id
  `;
  return Array.isArray(rows) && rows.length > 0;
}

// Record a refresh failure and release our claim (fenced on claimId). Best-effort.
export async function markRefreshError(claimId: string, message: string): Promise<void> {
  await sql()`
    UPDATE linear_tokens
       SET refreshing_at = NULL, refresh_claim = NULL, last_refresh_error = ${message}, updated_at = now()
     WHERE id = 'linear' AND refresh_claim = ${claimId}
  `;
}

// Non-secret health view (for GET /api/health/linear-token): expiry + last error, never the token.
export async function readLinearTokenHealth(): Promise<{
  expiresAt: Date;
  lastRefreshError: string | null;
} | null> {
  const rows = await sql()`
    SELECT expires_at, last_refresh_error FROM linear_tokens WHERE id = 'linear'
  `;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return null;
  return {
    expiresAt: new Date(row.expires_at as string),
    lastRefreshError: (row.last_refresh_error as string | null) ?? null,
  };
}
