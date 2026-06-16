// Pure helpers for rendering a mid-run AgentQuestion as a Linear elicitation. Kept out of the
// workflow module so they're unit-testable without loading the "use workflow" transform.

import type { AgentQuestion } from "./contract";

export interface RenderedQuestion {
  // "select" → emit select buttons (option labels as values). "text" → plain elicitation,
  // user replies with free text (multiSelect or no options).
  mode: "select" | "text";
  body: string;
  // present only when mode === "select"
  options: { label: string; value: string }[];
}

// Single-select (has options and !multiSelect) → select buttons. multiSelect or no options →
// free-text elicitation that lists the options + instructs how to reply.
export function renderQuestion(q: AgentQuestion): RenderedQuestion {
  const header = q.header ? `**${q.header}** — ` : "";

  if (q.options.length > 0 && !q.multiSelect) {
    const descriptions = q.options
      .filter((o) => o.description)
      .map((o) => `- **${o.label}**: ${o.description}`)
      .join("\n");
    return {
      mode: "select",
      body: `${header}${q.question}${descriptions ? `\n\n${descriptions}` : ""}`,
      options: q.options.map((o) => ({ label: o.label, value: o.label })),
    };
  }

  const optionLines = q.options.map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ""}`);
  const instruction = q.multiSelect
    ? "Reply with the option(s) you want, comma-separated."
    : "Reply with your answer.";
  return {
    mode: "text",
    body: `${header}${q.question}${optionLines.length ? `\n\n${optionLines.join("\n")}` : ""}\n\n${instruction}`,
    options: [],
  };
}

// Pick the answer string from a prompt reply, normalized to the contract's documented shape
// (multiSelect → matched option labels joined by ", "). Keyed by the question text in the
// answers map.
//
// - single-select: the select value IS the precise option label → use it; free text is the
//   fallback (and is matched to a label if it names exactly one).
// - multiSelect: there are no select buttons, so the user replies with free text (comma/etc
//   separated). Parse it against the question's options and re-join the MATCHED labels with
//   ", "; if nothing matches, fall back to the raw trimmed text.
export function answerFromReply(
  q: { multiSelect: boolean; options: { label: string }[] },
  reply: { selectValue?: string; text?: string },
): string {
  const raw = (reply.selectValue ?? reply.text ?? "").trim();

  if (q.multiSelect) {
    const matched = matchOptionLabels(raw, q.options);
    return matched.length > 0 ? matched.join(", ") : raw;
  }

  // single-select: if free text (no button) names exactly one option, normalize to that label.
  if (!reply.selectValue && raw) {
    const matched = matchOptionLabels(raw, q.options);
    if (matched.length === 1) return matched[0];
  }
  return raw;
}

// Find which option labels the free text mentions. Splits on commas / "and" / newlines and
// matches case-insensitively, preserving the options' declared order (not the reply's order).
function matchOptionLabels(text: string, options: { label: string }[]): string[] {
  if (options.length === 0) return [];
  const tokens = text
    .split(/[,\n]|\band\b/i)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return [];
  return options
    .map((o) => o.label)
    .filter((label) => tokens.includes(label.toLowerCase()));
}
