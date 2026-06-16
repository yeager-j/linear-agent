// Constant-time credential checks for the mini's HTTP endpoints. Mirrors the Vercel side's
// crypto.timingSafeEqual approach so a wrong secret can't be discovered by timing. Pure functions
// (no config/env access) so they're trivially testable and reusable for both the shared bearer
// secret and the Cloudflare Access header pair. This module does NO IO.

import crypto from "node:crypto";

// Constant-time string equality. Returns false if either side is missing or lengths differ
// (the length check is required because timingSafeEqual throws on unequal-length buffers).
export function timingSafeEqualStr(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Validate an `Authorization: Bearer <token>` header against the expected secret in constant time.
// Fails CLOSED: an unconfigured expected secret rejects every request (a security gate must never
// silently degrade to allow-all on a missing-secret misconfiguration).
export function bearerTokenMatches(header: string | null, expected: string | undefined): boolean {
  if (!expected) return false;
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return false;
  return timingSafeEqualStr(header.slice(prefix.length), expected);
}
