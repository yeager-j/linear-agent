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
  // Linear. The access token is no longer a static env var — it lives in Neon and is auto-refreshed
  // (lib/linear-token.ts). We only need the OAuth app credentials here to perform the refresh.
  linearClientId: () => required("LINEAR_CLIENT_ID"),
  linearClientSecret: () => required("LINEAR_CLIENT_SECRET"),
  linearWebhookSecret: () => required("LINEAR_WEBHOOK_SECRET"),
  // app user id is used only for self/delegate checks; optional so its absence never hard-fails
  linearAppUserId: () => optional("LINEAR_APP_USER_ID"),

  // Mini (Vercel → Mini over the Cloudflare tunnel)
  miniBaseUrl: () => required("MINI_BASE_URL"),
  cfAccessClientId: () => required("CF_ACCESS_CLIENT_ID"),
  cfAccessClientSecret: () => required("CF_ACCESS_CLIENT_SECRET"),
  // App-layer bearer the mini requires on every request (independent of CF Access).
  miniAuthSecret: () => required("MINI_AUTH_SECRET"),

  // Mini → Vercel callback auth
  callbackSecret: () => required("CALLBACK_SECRET"),

  // Neon
  databaseUrl: () => required("DATABASE_URL"),
} as const;

// Linear GraphQL endpoint (not configurable; pinned per linear-agents-api.md).
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
