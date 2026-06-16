import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const SECRET = "test-webhook-secret";

let verifyLinearSignature: typeof import("./linear").verifyLinearSignature;
let isTimestampFresh: typeof import("./linear").isTimestampFresh;

beforeAll(async () => {
  process.env.LINEAR_WEBHOOK_SECRET = SECRET;
  // import after env is set (the module reads the secret lazily, but be explicit).
  const mod = await import("./linear");
  verifyLinearSignature = mod.verifyLinearSignature;
  isTimestampFresh = mod.isTimestampFresh;
});

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

describe("verifyLinearSignature", () => {
  it("accepts a correct HMAC over the raw body", () => {
    const body = JSON.stringify({ action: "created", agentSession: { id: "s" } });
    expect(verifyLinearSignature(body, sign(body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ action: "created" });
    const sig = sign(body);
    expect(verifyLinearSignature(body + " ", sig)).toBe(false);
  });

  it("rejects a missing or malformed signature header", () => {
    const body = "{}";
    expect(verifyLinearSignature(body, null)).toBe(false);
    expect(verifyLinearSignature(body, "not-hex-zz")).toBe(false);
  });

  it("rejects a signature of the wrong length", () => {
    const body = "{}";
    expect(verifyLinearSignature(body, "abcd")).toBe(false);
  });
});

describe("isTimestampFresh", () => {
  const now = 1_000_000_000_000;
  it("accepts a recent timestamp", () => {
    expect(isTimestampFresh(now - 5_000, now)).toBe(true);
  });
  it("rejects an old timestamp", () => {
    expect(isTimestampFresh(now - 120_000, now)).toBe(false);
  });
  it("tolerates a missing/non-numeric timestamp", () => {
    expect(isTimestampFresh(undefined, now)).toBe(true);
    expect(isTimestampFresh("nope", now)).toBe(true);
  });
});
