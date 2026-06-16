// Typed, lazily-validated access to the Vercel-side environment variables (see
// shared/integration-contract.md §6 and plan §5). Access is lazy on purpose: importing this
// module must not throw during build or in tests where secrets are absent — only the code path
// that actually needs a var fails, and it fails loudly with a clear message.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const env = {
  // Linear
  linearAccessToken: () => required("LINEAR_ACCESS_TOKEN"),
  linearWebhookSecret: () => required("LINEAR_WEBHOOK_SECRET"),
  // app user id is used only for self/delegate checks; optional so its absence never hard-fails
  linearAppUserId: () => optional("LINEAR_APP_USER_ID"),

  // Mini (Vercel → Mini over the Cloudflare tunnel)
  miniBaseUrl: () => required("MINI_BASE_URL"),
  cfAccessClientId: () => required("CF_ACCESS_CLIENT_ID"),
  cfAccessClientSecret: () => required("CF_ACCESS_CLIENT_SECRET"),

  // Mini → Vercel callback auth
  callbackSecret: () => required("CALLBACK_SECRET"),

  // Neon
  databaseUrl: () => required("DATABASE_URL"),
} as const;

// Linear GraphQL endpoint (not configurable; pinned per linear-agents-api.md).
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// Reject webhooks whose `webhookTimestamp` is older than this (replay protection, API §3/§7).
export const WEBHOOK_MAX_AGE_MS = 60_000;

// Loop / lifecycle caps (plan §7 — a MAX_REVISION_ROUNDS-style cap on every workflow loop).
export const MAX_REVISION_ROUNDS = 8;

// Cap on mid-run AskUserQuestion rounds per job, so a misbehaving agent that asks endlessly
// can't loop the workflow forever.
export const MAX_QUESTION_ROUNDS = 20;

// waitForJob timeout backstop: a silently dead mini job surfaces as a Linear error instead of
// a workflow paused forever (plan §3, contract §5 failure/timeout path).
export const JOB_TIMEOUT = "45m";

// Sweeper schedule (plan §7): after an elicitation, race promptHook against these sleeps.
export const SWEEP_NUDGE_AFTER = "3 days";
export const SWEEP_REAP_AFTER = "4 days";

// Brief grace period to let the mini deliver the `aborted` callback after we POST /abort.
export const ABORT_GRACE = "30s";
