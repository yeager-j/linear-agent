import { beforeAll, describe, expect, it } from "vitest";

const SECRET = "callback-secret-value";
let bearerOk: typeof import("./auth").bearerOk;

beforeAll(async () => {
  process.env.CALLBACK_SECRET = SECRET;
  bearerOk = (await import("./auth")).bearerOk;
});

describe("bearerOk", () => {
  it("accepts the correct Bearer token", () => {
    expect(bearerOk(`Bearer ${SECRET}`)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(bearerOk(null)).toBe(false);
    expect(bearerOk("")).toBe(false);
  });

  it("rejects a wrong token", () => {
    expect(bearerOk("Bearer nope")).toBe(false);
  });

  it("requires the 'Bearer ' scheme — a non-Bearer header carrying the secret must NOT authenticate", () => {
    // Without the scheme prefix, slicing the first 7 chars would otherwise expose the raw secret.
    expect(bearerOk(SECRET)).toBe(false);
    expect(bearerOk(`XXXXXXX${SECRET}`)).toBe(false);
    expect(bearerOk(`Basic ${SECRET}`)).toBe(false);
  });

  it("is length-safe (no throw on unequal lengths)", () => {
    expect(bearerOk(`Bearer ${SECRET}x`)).toBe(false);
    expect(bearerOk(`Bearer ${SECRET.slice(0, -1)}`)).toBe(false);
  });
});
