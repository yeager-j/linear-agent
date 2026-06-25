import { test, expect, describe, afterEach } from "bun:test";
import { setJobToken, getJobToken, deleteJobToken } from "./job-tokens.ts";

describe("job-tokens", () => {
  afterEach(() => {
    deleteJobToken("j1");
    deleteJobToken("j2");
  });

  test("set then get returns the token", () => {
    setJobToken("j1", "tok-abc");
    expect(getJobToken("j1")).toBe("tok-abc");
  });

  test("unknown job id => undefined", () => {
    expect(getJobToken("nope")).toBeUndefined();
  });

  test("delete removes the token", () => {
    setJobToken("j2", "tok-xyz");
    deleteJobToken("j2");
    expect(getJobToken("j2")).toBeUndefined();
  });

  test("set overwrites", () => {
    setJobToken("j1", "first");
    setJobToken("j1", "second");
    expect(getJobToken("j1")).toBe("second");
  });
});
