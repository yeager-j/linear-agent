#!/usr/bin/env bun
/**
 * One-shot Linear agent OAuth helper.
 *
 * Runs the `actor=app` authorization-code flow to obtain the AGENT access token (a personal
 * API key cannot act as an agent), then queries viewer.id. Prints the two values you still
 * need: LINEAR_ACCESS_TOKEN and LINEAR_APP_USER_ID.
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

async function exchange(code: string): Promise<string> {
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
  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`token exchange failed (${res.status}): ${json.error_description ?? json.error ?? JSON.stringify(json)}`);
  }
  return json.access_token;
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
const token = await exchange(code);
const viewer = await viewerId(token);

console.log("\n────────────────────────────────────────────────────────");
console.log("✅ Done. Paste these in:");
console.log("   apps/vercel/.env.local  (LINEAR_ACCESS_TOKEN, LINEAR_APP_USER_ID)");
console.log("   apps/mini/.env          (LINEAR_ACCESS_TOKEN)");
console.log("────────────────────────────────────────────────────────\n");
console.log(`LINEAR_ACCESS_TOKEN=${token}`);
console.log(`LINEAR_APP_USER_ID=${viewer.id}`);
console.log(`\n(agent identity: ${viewer.name ?? "?"} / ${viewer.id})`);
process.exit(0);
