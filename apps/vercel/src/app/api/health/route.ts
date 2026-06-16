// GET /api/health — liveness probe that an external monitor (e.g. healthchecks.io) can ping.
// Proxies the mini's GET /healthz over the tunnel (plan §7). Returns 200 only when the mini is
// reachable and reports ok; 503 otherwise. No auth: it leaks only aggregate health, and the mini
// call itself is gated by the CF-Access service token.

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
