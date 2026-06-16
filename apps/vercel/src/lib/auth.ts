// Shared bearer-token auth for mini → Vercel routes (contract §2). Constant-time compare so a
// wrong token can't be discovered by timing. Used by /api/mini/callback and /api/mini/question.

import crypto from "node:crypto";
import { env } from "./env";

export function bearerOk(header: string | null): boolean {
  if (!header) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(env.callbackSecret());
  // Length check first so timingSafeEqual doesn't throw on unequal-length buffers.
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}
