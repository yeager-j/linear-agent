-- Neon schema for the Vercel side (plan §3 + open-questions.md D9).
-- The workflow run's event log is the durable history; these tables only hold the
-- session <-> runId map and the webhook-delivery dedupe set.

-- One row per Linear AgentSession. phase lives implicitly in where the run is paused.
CREATE TABLE IF NOT EXISTS sessions (
  linear_session_id TEXT PRIMARY KEY,
  workflow_run_id   TEXT NOT NULL,
  issue_identifier  TEXT NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- Webhook idempotency: insert-or-ignore on the Linear delivery id BEFORE start/resume.
-- delivery_id = `Linear-Delivery` header, or the `${webhookId}:${webhookTimestamp}` fallback.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  seen_at     TIMESTAMPTZ DEFAULT now()
);
