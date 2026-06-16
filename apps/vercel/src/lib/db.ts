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
