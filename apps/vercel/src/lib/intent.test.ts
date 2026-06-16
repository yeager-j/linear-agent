import { describe, expect, it } from "vitest";
import { classifyIntent } from "./intent";

describe("classifyIntent", () => {
  it("uses the select-button value as the primary path", () => {
    expect(classifyIntent({ text: "whatever", selectValue: "approve" })).toBe("approve");
    expect(classifyIntent({ text: "approve", selectValue: "request_changes" })).toBe("revise");
  });

  it("treats an unknown select value as a revision (safe default)", () => {
    expect(classifyIntent({ text: "", selectValue: "something_else" })).toBe("revise");
  });

  it("classifies clear free-text approvals", () => {
    // "go for it" exercises the SECOND approve pattern, which the other phrases don't reach.
    for (const text of ["approve", "LGTM", "looks good", "yes", "ship it", "go ahead", "go for it", "👍"]) {
      expect(classifyIntent({ text })).toBe("approve");
    }
  });

  it("classifies free-text feedback as revision", () => {
    for (const text of [
      "can you also add tests",
      "looks good but change the title",
      "use a different library",
      "no, do it the other way",
    ]) {
      expect(classifyIntent({ text })).toBe("revise");
    }
  });

  it("treats empty free text as revision (waits for real intent)", () => {
    expect(classifyIntent({ text: "" })).toBe("revise");
    expect(classifyIntent({ text: "   " })).toBe("revise");
  });
});
