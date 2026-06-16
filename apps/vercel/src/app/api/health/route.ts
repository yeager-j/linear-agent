// GET /api/health — liveness probe that an external monitor (e.g. healthchecks.io) can ping.
// Proxies the mini's GET /healthz over the tunnel (plan §7). Returns 200 only when the mini is
// reachable and reports ok; 503 otherwise. This Vercel route is unauthenticated and exposes only
// aggregate mini health. The mini call it makes is authenticated — the mini requires the bearer
// secret (and, behind the tunnel, the CF-Access service token) on /healthz like every endpoint.

import { healthz } from "@/lib/mini";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const h = await healthz();
    return Response.json({ ok: true, mini: h });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "mini unreachable" },
      { status: 503 },
    );
  }
}
