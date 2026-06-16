// SDK message stream -> Linear activities (plan §4 Phase 4, linear-agents-api §4/§5/§7).
//
// Maps the Claude Agent SDK's async message stream onto Linear activity calls:
//   assistant text/thinking -> ephemeral `thought`
//   assistant tool_use       -> ephemeral `action` (name + summarized input)
//   result (success)         -> captured as the plan summary / final result text
// Plus: throttle activity creates so we don't hammer the API, and emit a heartbeat thought
// before the ~30-min stale window if the run goes quiet.
//
// The bridge is decoupled from the concrete SDK types via a structural SDKLike message so it's
// unit-testable with hand-built fixture streams.

import type { LinearClient, PlanItem } from "./linear.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";

// Structural subset of the SDK messages we consume. The real @anthropic-ai/claude-agent-sdk
// SDKMessage is a superset; we read only these fields and ignore the rest.
export interface SDKLikeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string; // tool_use
  input?: unknown; // tool_use
}
export interface SDKLikeMessage {
  type: string; // "system" | "assistant" | "user" | "result" | ...
  subtype?: string; // "init" | "success" | "error" ...
  session_id?: string;
  result?: string; // on result success
  message?: { content?: SDKLikeContentBlock[] }; // assistant/user payload (BetaMessage-shaped)
}

export interface BridgeOutcome {
  claudeSessionId?: string;
  resultText?: string; // final plan/summary text
  isError: boolean;
}

export interface BridgeOptions {
  linear: LinearClient;
  linearSessionId: string;
  // Emit progress as a live plan checklist too (planning phase). Default true.
  publishPlan?: boolean;
  // Overridable for tests.
  now?: () => number;
}

// Summarize a tool input object into a short parameter string for the Linear action activity.
function summarizeInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === "string") return input.slice(0, 200);
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    // Prefer the most human-meaningful field.
    for (const k of ["file_path", "path", "command", "pattern", "query", "url", "description"]) {
      const v = o[k];
      if (typeof v === "string") return v.slice(0, 200);
    }
    try {
      return JSON.stringify(o).slice(0, 200);
    } catch {
      return undefined;
    }
  }
  return String(input).slice(0, 200);
}

// Consume the stream, streaming activities to Linear, and return the terminal outcome. Never
// throws on Linear errors (the client swallows them); SDK iteration errors propagate to the
// caller (the runner) which converts them to a failed/aborted result.
export async function bridgeStream(
  stream: AsyncIterable<SDKLikeMessage>,
  opts: BridgeOptions,
): Promise<BridgeOutcome> {
  const cfg = config();
  const now = opts.now ?? Date.now;
  const { linear, linearSessionId } = opts;
  const publishPlan = opts.publishPlan ?? true;

  let claudeSessionId: string | undefined;
  let resultText: string | undefined;
  let planText: string | undefined; // authoritative plan captured from ExitPlanMode's input
  let isError = false;

  let lastActivityAt = now();
  let lastEmitAt = -Infinity; // first thought always passes the throttle
  const actionsSeen: string[] = []; // for a lightweight plan checklist

  // Heartbeat: if no activity for ~heartbeatInterval, emit a keep-alive thought.
  const heartbeat = setInterval(() => {
    if (now() - lastActivityAt >= cfg.heartbeatIntervalMs) {
      void linear.thought(linearSessionId, "Still working…", true);
      lastActivityAt = now();
    }
  }, Math.max(1000, Math.floor(cfg.heartbeatIntervalMs / 2)));
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  // Throttle: collapse rapid thoughts; always let actions and the first message through.
  const throttled = (): boolean => {
    const t = now();
    if (t - lastEmitAt < cfg.activityThrottleMs) return true;
    lastEmitAt = t;
    return false;
  };

  try {
    for await (const msg of stream) {
      if (msg.session_id) claudeSessionId = msg.session_id;
      lastActivityAt = now();

      if (msg.type === "system" && msg.subtype === "init") {
        // session id already captured above
        continue;
      }

      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          const blockType = block.type ?? (block.thinking ? "thinking" : block.text ? "text" : undefined);
          if (blockType === "text") {
            // The agent's actual messages — persist them DURABLY so the conversation survives the
            // terminal response (for later discussion). Not throttled: never drop a real message.
            const body = (block.text ?? "").trim();
            if (body) await linear.thought(linearSessionId, body, false);
          } else if (blockType === "thinking") {
            // Internal reasoning — ephemeral live progress, throttled to avoid hammering the API.
            const body = (block.thinking ?? "").trim();
            if (body && !throttled()) await linear.thought(linearSessionId, body, true);
          } else if (blockType === "tool_use" && block.name) {
            // ExitPlanMode carries the real plan in its `plan` input — capture it verbatim as the
            // authoritative plan text (the streamed thoughts are ephemeral and vanish on terminal).
            if (block.name === "ExitPlanMode" || block.name === "exit_plan_mode") {
              const p = (block.input as { plan?: unknown } | undefined)?.plan;
              if (typeof p === "string" && p.trim()) planText = p.trim();
            }
            const param = summarizeInput(block.input);
            await linear.action(linearSessionId, block.name, param, undefined, true);
            actionsSeen.push(param ? `${block.name}: ${param}` : block.name);
            if (publishPlan) {
              // Lightweight live checklist: last few actions, newest in progress, rest completed.
              // Item shape is { content, status } with camelCase statuses (linear-agents-api.md).
              const items: PlanItem[] = actionsSeen.slice(-6).map((a, i, arr) => ({
                content: a,
                status: i === arr.length - 1 ? "inProgress" : "completed",
              }));
              await linear.setPlan(linearSessionId, items);
            }
          }
        }
        continue;
      }

      if (msg.type === "result") {
        if (msg.subtype === "success") {
          resultText = msg.result;
        } else {
          isError = true;
          resultText = msg.result;
          log.warn("SDK result non-success", { subtype: msg.subtype });
        }
        continue;
      }
    }
  } finally {
    clearInterval(heartbeat);
  }

  // Prefer the verbatim ExitPlanMode plan over the SDK's free-form result text for plan runs.
  return { claudeSessionId, resultText: planText ?? resultText, isError };
}
