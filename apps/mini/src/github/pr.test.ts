import { test, expect, describe, beforeEach } from "bun:test";
import { parseOwnerRepo, pushAndOpenPr } from "./pr.ts";
import { testConfig } from "../test-helpers.ts";

beforeEach(() => {
  testConfig();
});

describe("parseOwnerRepo", () => {
  test("ssh form", () => {
    expect(parseOwnerRepo("git@github.com:acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
  });
  test("https form", () => {
    expect(parseOwnerRepo("https://github.com/acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
  });
  test("unparseable returns null", () => {
    expect(parseOwnerRepo("not-a-url")).toBeNull();
  });
});

describe("pushAndOpenPr (dry run)", () => {
  test("synthesizes a PR url without network", async () => {
    testConfig({ prDryRun: true });
    const res = await pushAndOpenPr({
      worktreePath: "/tmp/wt",
      branch: "agent/eng-1-abcd",
      title: "t",
      body: "b",
      owner: "acme",
      repo: "widgets",
    });
    expect(res.branch).toBe("agent/eng-1-abcd");
    expect(res.prUrl).toContain("github.com/acme/widgets/pull/");
  });
});

describe("pushAndOpenPr (real path)", () => {
  test("throws when GITHUB_TOKEN is unset", async () => {
    testConfig({ prDryRun: false, githubToken: undefined });
    await expect(
      pushAndOpenPr({ worktreePath: "/tmp/wt", branch: "b", title: "t", body: "b", owner: "a", repo: "r" }),
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });
});
