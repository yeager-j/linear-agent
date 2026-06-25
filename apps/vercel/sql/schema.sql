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

-- Linear OAuth token authority. SINGLE row (id='linear'). Vercel is the ONLY reader/writer; the
-- mini never touches this table (it receives a fresh access token per job). access/refresh tokens
-- rotate ~daily — refreshed under a claim-fenced CAS (lib/linear-token.ts). Seed once via
-- scripts/linear-oauth.ts.
CREATE TABLE IF NOT EXISTS linear_tokens (
  id                 TEXT PRIMARY KEY DEFAULT 'linear',
  access_token       TEXT NOT NULL,
  refresh_token      TEXT NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,   -- absolute = mint_time + expires_in
  refreshing_at      TIMESTAMPTZ,            -- claim marker; self-expires (crash recovery)
  refresh_claim      TEXT,                   -- opaque fence id of the current refresher
  last_refresh_at    TIMESTAMPTZ,
  last_refresh_error TEXT,                   -- set on a permanent refresh failure (health probe reads it)
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT linear_tokens_single_row CHECK (id = 'linear')
);
