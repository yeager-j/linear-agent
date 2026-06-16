import { test, expect, describe } from "bun:test";
import { bearerTokenMatches, timingSafeEqualStr } from "./auth.ts";

describe("timingSafeEqualStr", () => {
  test("true only for equal non-empty strings", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false); // length mismatch must not throw
  });

  test("false when either side is missing", () => {
    expect(timingSafeEqualStr(null, "x")).toBe(false);
    expect(timingSafeEqualStr("x", undefined)).toBe(false);
    expect(timingSafeEqualStr("", "")).toBe(false);
  });
});

describe("bearerTokenMatches", () => {
  const secret = "s3cr3t-value";

  test("accepts a correct Bearer token", () => {
    expect(bearerTokenMatches(`Bearer ${secret}`, secret)).toBe(true);
  });

  test("rejects wrong token, wrong scheme, and missing header", () => {
    expect(bearerTokenMatches(`Bearer nope`, secret)).toBe(false);
    expect(bearerTokenMatches(secret, secret)).toBe(false); // no "Bearer " prefix
    expect(bearerTokenMatches(null, secret)).toBe(false);
    expect(bearerTokenMatches(`Bearer ${secret}x`, secret)).toBe(false);
  });

  test("fails CLOSED when the expected secret is unset", () => {
    expect(bearerTokenMatches(`Bearer anything`, undefined)).toBe(false);
    expect(bearerTokenMatches(`Bearer `, "")).toBe(false);
  });
});
