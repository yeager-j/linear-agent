import { describe, expect, it } from "vitest";
import { AgentQuestion } from "./contract";
import { answerFromReply, renderQuestion } from "./questions";

// Parse through the schema so defaults (header:"", multiSelect:false, options:[]) apply.
function q(input: unknown): AgentQuestion {
  return AgentQuestion.parse(input);
}

describe("renderQuestion", () => {
  it("single-select (options, !multiSelect) → select buttons keyed on labels", () => {
    const r = renderQuestion(
      q({
        question: "Which database?",
        header: "DB",
        options: [
          { label: "Postgres", description: "relational" },
          { label: "Mongo", description: "document" },
        ],
      }),
    );
    expect(r.mode).toBe("select");
    expect(r.options).toEqual([
      { label: "Postgres", value: "Postgres" },
      { label: "Mongo", value: "Mongo" },
    ]);
    expect(r.body).toContain("Which database?");
    expect(r.body).toContain("Postgres");
  });

  it("multiSelect → free-text elicitation (no select buttons), comma-separated instruction", () => {
    const r = renderQuestion(
      q({
        question: "Pick frameworks",
        multiSelect: true,
        options: [{ label: "React" }, { label: "Vue" }],
      }),
    );
    expect(r.mode).toBe("text");
    expect(r.options).toEqual([]);
    expect(r.body).toContain("comma-separated");
    expect(r.body).toContain("React");
  });

  it("no options → free-text elicitation", () => {
    const r = renderQuestion(q({ question: "Describe the desired behavior" }));
    expect(r.mode).toBe("text");
    expect(r.body).toContain("Describe the desired behavior");
    expect(r.body).toContain("Reply with your answer.");
  });
});

describe("answerFromReply", () => {
  const single = q({
    question: "Which database?",
    options: [{ label: "Postgres" }, { label: "Mongo" }],
  });
  const multi = q({
    question: "Pick frameworks",
    multiSelect: true,
    options: [{ label: "React" }, { label: "Vue" }, { label: "Svelte" }],
  });
  const open = q({ question: "Describe" });

  it("single-select: prefers the select value over free text", () => {
    expect(answerFromReply(single, { selectValue: "Postgres", text: "ignored" })).toBe("Postgres");
  });

  it("single-select: normalizes free text that names one option to its label", () => {
    expect(answerFromReply(single, { text: "postgres" })).toBe("Postgres");
  });

  it("multiSelect: re-joins matched option labels with ', ' in option order", () => {
    // reply lists them out of order / different case → normalized to declared order + casing.
    expect(answerFromReply(multi, { text: "svelte, react" })).toBe("React, Svelte");
    expect(answerFromReply(multi, { text: "React and Vue" })).toBe("React, Vue");
  });

  it("multiSelect: falls back to raw trimmed text when nothing matches", () => {
    expect(answerFromReply(multi, { text: "  none of these  " })).toBe("none of these");
  });

  it("open question: passes free text through trimmed", () => {
    expect(answerFromReply(open, { text: "  a long answer  " })).toBe("a long answer");
  });

  it("returns empty string when neither present", () => {
    expect(answerFromReply(open, {})).toBe("");
  });
});
