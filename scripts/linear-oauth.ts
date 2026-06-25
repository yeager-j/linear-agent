#!/usr/bin/env bun
/**
 * One-shot Linear agent OAuth helper.
 *
 * Runs the `actor=app` authorization-code flow to obtain the AGENT token pair (a personal API key
 * cannot act as an agent), then queries viewer.id. Prints LINEAR_APP_USER_ID and a ready-to-paste
 * SQL INSERT that seeds the Neon `linear_tokens` row (access_token + refresh_token + expires_at) —
 * Vercel auto-refreshes from there, so there is no static LINEAR_ACCESS_TOKEN env var anymore.
 * Pass --verify-refresh to exchange the refresh token once (confirms the refresh path; seeds the
 * rotated pair).
 *
 * Usage (secrets stay on your machine — nothing is sent anywhere but Linear):
 *
 *   LINEAR_CLIENT_ID=xxx LINEAR_CLIENT_SECRET=yyy bun scripts/linear-oauth.ts
 *
 * The redirect URI defaults to http://localhost:9876/callback — make sure that exact URI is
 * registered on your Linear OAuth app (Settings → API → Applications → your app → Redirect URIs;
 * you can list more than one). Override with LINEAR_REDIRECT_URI if you registered a different one.
 */

const clientId = process.env.LINEAR_CLIENT_ID;
const clientSecret = process.env.LINEAR_CLIENT_SECRET;
const redirectUri = process.env.LINEAR_REDIRECT_URI ?? "http://localhost:9876/callback";

if (!clientId || !clientSecret) {
  console.error("Set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET in the environment, e.g.:\n");
  console.error("  LINEAR_CLIENT_ID=xxx LINEAR_CLIENT_SECRET=yyy bun scripts/linear-oauth.ts\n");
  process.exit(1);
}

const url = new URL(redirectUri);
const port = Number(url.port || 80);

// Agent scopes: read/write plus the two that let the agent be assigned + mentioned.
const scope = ["read", "write", "app:assignable", "app:mentionable"].join(",");
const state = crypto.randomUUID();

const authorizeUrl = new URL("https://linear.app/oauth/authorize");
authorizeUrl.searchParams.set("client_id", clientId);
authorizeUrl.searchParams.set("redirect_uri", redirectUri);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("scope", scope);
authorizeUrl.searchParams.set("state", state);
authorizeUrl.searchParams.set("actor", "app"); // <- installs as an AGENT, not a normal user
authorizeUrl.searchParams.set("prompt", "consent");

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function exchange(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId!,
    client_secret: clientSecret!,
  });
  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`token exchange failed (${res.status}): ${json.error_description ?? json.error ?? JSON.stringify(json)}`);
  }
  // The auto-refresh architecture REQUIRES a refresh_token + expires_in. If Linear ever stops
  // returning them for actor=app, fail loud here rather than seed an un-refreshable token.
  if (!json.refresh_token) {
    throw new Error(`Linear returned no refresh_token (keys: ${Object.keys(json).join(", ")}). The refresh design needs it.`);
  }
  if (!json.expires_in) {
    throw new Error(`Linear returned no expires_in (keys: ${Object.keys(json).join(", ")}).`);
  }
  return { access_token: json.access_token, refresh_token: json.refresh_token, expires_in: json.expires_in };
}

// Optional --verify-refresh probe: exchange the refresh_token ONCE to confirm the refresh path works
// and observe rotation. This rotates the token, so the caller seeds the REFRESHED pair.
async function refreshOnce(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId!,
      client_secret: clientSecret!,
    }),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!res.ok || !json.access_token || !json.refresh_token || !json.expires_in) {
    throw new Error(`refresh probe failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return { access_token: json.access_token, refresh_token: json.refresh_token, expires_in: json.expires_in };
}

const sqlEscape = (s: string) => s.replace(/'/g, "''");
function seedSql(t: TokenResponse, expiresAt: Date): string {
  return [
    "INSERT INTO linear_tokens (id, access_token, refresh_token, expires_at)",
    `VALUES ('linear', '${sqlEscape(t.access_token)}', '${sqlEscape(t.refresh_token)}', '${expiresAt.toISOString()}')`,
    "ON CONFLICT (id) DO UPDATE SET",
    "  access_token = EXCLUDED.access_token,",
    "  refresh_token = EXCLUDED.refresh_token,",
    "  expires_at = EXCLUDED.expires_at,",
    "  refreshing_at = NULL,",
    "  refresh_claim = NULL,",
    "  last_refresh_error = NULL,",
    "  updated_at = now();",
  ].join("\n");
}

async function viewerId(token: string): Promise<{ id: string; name?: string }> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: "{ viewer { id name } }" }),
  });
  const json = (await res.json()) as { data?: { viewer?: { id: string; name?: string } }; errors?: unknown };
  if (!json.data?.viewer?.id) throw new Error(`viewer query failed: ${JSON.stringify(json)}`);
  return json.data.viewer;
}

const codePromise = new Promise<string>((resolve, reject) => {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== url.pathname) return new Response("not found", { status: 404 });
      const code = u.searchParams.get("code");
      const returnedState = u.searchParams.get("state");
      const err = u.searchParams.get("error");
      if (err) { reject(new Error(`authorization denied: ${err}`)); server.stop(); return new Response("Authorization failed. You can close this tab."); }
      if (returnedState !== state) { reject(new Error("state mismatch (possible CSRF)")); server.stop(); return new Response("State mismatch. Close this tab."); }
      if (!code) return new Response("waiting…");
      resolve(code);
      setTimeout(() => server.stop(), 100);
      return new Response("✅ Linear authorization received. You can close this tab and return to the terminal.");
    },
  });
  console.log(`Listening for the OAuth redirect on ${redirectUri}\n`);
});

console.log("Opening your browser to authorize the agent (approve in your workspace)…\n");
console.log(`If it doesn't open, visit:\n${authorizeUrl.toString()}\n`);
try { await Bun.$`open ${authorizeUrl.toString()}`.quiet(); } catch { /* non-macOS: copy the URL above */ }

const code = await codePromise;
let token = await exchange(code);
const viewer = await viewerId(token.access_token);
console.log(`\n✅ Authorized as ${viewer.name ?? "?"} (${viewer.id}). expires_in=${token.expires_in}s (≈${Math.round(token.expires_in / 3600)}h).`);

if (process.argv.includes("--verify-refresh")) {
  console.log("\n[verify-refresh] exchanging the refresh token once to confirm the refresh path…");
  const refreshed = await refreshOnce(token.refresh_token);
  console.log(`[verify-refresh] OK. refresh_token rotated: ${refreshed.refresh_token !== token.refresh_token}. expires_in=${refreshed.expires_in}s`);
  token = refreshed; // seed the freshest valid pair (the original is now rotating out)
}

const expiresAt = new Date(Date.now() + token.expires_in * 1000);

console.log("\n────────────────────────────────────────────────────────");
console.log("1) Set in Vercel env (NOT a static token anymore):");
console.log(`   LINEAR_APP_USER_ID=${viewer.id}`);
console.log("   (LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET must also be set so Vercel can refresh.)");
console.log("\n2) Seed the token row — paste this into the Neon SQL console for the Vercel");
console.log("   project's `linear-agent` database (keeps DATABASE_URL off this box):\n");
console.log(seedSql(token, expiresAt));
console.log("\n────────────────────────────────────────────────────────");
console.log("The access token now self-refreshes from Neon; no LINEAR_ACCESS_TOKEN env var needed.");
process.exit(0);
