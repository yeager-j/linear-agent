// Linear OAuth token authority (Vercel is the sole authority). Linear access tokens expire every
// 24h and Linear ROTATES the refresh_token on each use (the old one keeps working for a ~30-min
// grace window). This module reads {access_token, refresh_token, expires_at} from Neon and refreshes
// before expiry, race-safe via a claim-fenced CAS — the Neon HTTP driver can't hold a DB lock across
// the external refresh call, so we serialize with an atomic claim + a fenced store instead.
//
// SECURITY: nothing here logs the token-endpoint response (it carries live credentials).

import { randomUUID } from "node:crypto";
import { env } from "./env";
import { claimLinearRefresh, markRefreshError, readLinearToken, storeRefreshedToken } from "./db";

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const REFRESH_MARGIN_MS = 60 * 60_000; // refresh when <60min of validity remains (well inside 24h)
const STALE_CLAIM_SECONDS = 120; // a refresh claim self-expires after 2min so a crashed refresher releases it
const SKEW_MS = 60_000;

// Thrown when the token is unusable and cannot be auto-recovered (store not bootstrapped, or the
// refresh was permanently rejected). Callers surface it — a Linear error activity where a token is
// still usable, otherwise the GET /api/health/linear-token probe + Vercel logs.
export class LinearTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearTokenError";
  }
}

// Per-invocation cache: N Linear calls in one step do at most one DB read. Tagged with expiry so we
// never serve a token past its life even if a concurrent refresh happened elsewhere.
let cache: { token: string; expiresAt: number } | null = null;
export function invalidateTokenCache(): void {
  cache = null;
}

interface RefreshedPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

async function refreshFromLinear(refreshToken: string): Promise<RefreshedPair> {
  const res = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.linearClientId(),
      client_secret: env.linearClientSecret(),
    }),
  });
  if (res.status >= 400 && res.status < 500) {
    // PERMANENT: the refresh token was rejected (invalid_grant / revoked / aged out). Read only the
    // error CODE — never log the full body, which can echo credentials.
    const code = await res
      .json()
      .then((j) => (j as { error?: string }).error)
      .catch(() => undefined);
    throw new LinearTokenError(
      `Linear refused the refresh token (${res.status}${code ? ` ${code}` : ""}) — re-run scripts/linear-oauth.ts`,
    );
  }
  if (!res.ok) throw new Error(`Linear token refresh HTTP ${res.status}`); // TRANSIENT (5xx)
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token || !json.expires_in) {
    throw new Error("Linear token refresh returned a malformed response");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Re-read and return the stored token ONLY if it is actually still valid. Used by losers of the
// refresh claim. Bounded retry so a reactive-401 (token already expired) can't serve a dead token in
// a loop — if no valid token materializes, throw.
async function readFreshOrThrow(): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await readLinearToken();
    if (row && row.expiresAt.getTime() > Date.now() + SKEW_MS) {
      cache = { token: row.accessToken, expiresAt: row.expiresAt.getTime() };
      return row.accessToken;
    }
    if (attempt < 2) await sleep(500);
  }
  throw new LinearTokenError("Linear access token unavailable (refresh in progress or expired)");
}

// Return a valid Linear access token, refreshing under a claim-fenced CAS if it's within the margin.
export async function getValidAccessToken(): Promise<string> {
  if (cache && cache.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cache.token;

  const row = await readLinearToken();
  if (!row) {
    throw new LinearTokenError("Linear token store not bootstrapped — run scripts/linear-oauth.ts");
  }
  if (row.expiresAt.getTime() - REFRESH_MARGIN_MS > Date.now()) {
    cache = { token: row.accessToken, expiresAt: row.expiresAt.getTime() };
    return row.accessToken;
  }

  // Stale → try to become the single refresher.
  const claimId = randomUUID();
  const claim = await claimLinearRefresh(claimId, STALE_CLAIM_SECONDS);
  if (!claim) {
    // Another invocation owns the refresh; use the current token if it's still valid.
    return readFreshOrThrow();
  }

  let pair: RefreshedPair;
  try {
    pair = await refreshFromLinear(claim.refreshToken);
  } catch (err) {
    await markRefreshError(claimId, err instanceof Error ? err.message : String(err)).catch(() => {});
    throw err;
  }

  const stored = await storeRefreshedToken(claimId, pair);
  if (!stored) {
    // Lost the claim mid-flight (it self-expired and another refresher took over). Discard our pair
    // — the winner's is authoritative — and use whatever is now stored.
    return readFreshOrThrow();
  }
  cache = { token: pair.accessToken, expiresAt: pair.expiresAt.getTime() };
  return pair.accessToken;
}
