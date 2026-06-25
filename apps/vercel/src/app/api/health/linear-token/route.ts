// GET /api/health/linear-token — out-of-band probe for the Linear OAuth token's health, for an
// external monitor (e.g. healthchecks.io). When refresh fails permanently (refresh token revoked /
// aged out) we cannot surface it INTO a Linear session — there's no valid token to post with — so
// this is the operator's signal to re-run scripts/linear-oauth.ts. Returns only non-secret fields
// (expiry + last error), never the token itself.

import { readLinearTokenHealth } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const h = await readLinearTokenHealth();
    if (!h) {
      return Response.json({ ok: false, error: "not-bootstrapped" }, { status: 503 });
    }
    const expired = h.expiresAt.getTime() <= Date.now();
    const ok = !expired && !h.lastRefreshError;
    return Response.json(
      { ok, expiresAt: h.expiresAt.toISOString(), expired, lastRefreshError: h.lastRefreshError },
      { status: ok ? 200 : 503 },
    );
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "error" },
      { status: 503 },
    );
  }
}
