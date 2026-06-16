// Thin seam over the Claude Agent SDK so runners are testable with a fixture stream and the
// real SDK isn't imported in unit tests (it spawns a subprocess + needs subscription auth).
//
// Auth (open-questions §E, memory claude-agent-sdk-facts): the SDK resolves credentials in
// precedence order and falls back to the CLI subscription login (~/.claude/.credentials.json /
// CLAUDE_CODE_OAUTH_TOKEN) when no ANTHROPIC_API_KEY is set. The mini deliberately does NOT
// set an API key so it runs on the dedicated macOS user's subscription.

import type { SDKLikeMessage } from "./activity-bridge.ts";

export interface QueryParams {
  prompt: string;
  cwd: string;
  permissionMode: "plan" | "dontAsk" | "default" | "acceptEdits" | "bypassPermissions" | "auto";
  allowedTools?: string[];
  disallowedTools?: string[];
  resume?: string; // claude session id to resume
  abortController?: AbortController;
  maxTurns?: number;
}

// A query runner returns an async iterable of SDK-like messages.
export type QueryFn = (params: QueryParams) => AsyncIterable<SDKLikeMessage>;

// Default implementation backed by the real SDK. Lazily imported so tests that inject their own
// QueryFn never load the SDK.
export const realQuery: QueryFn = (params) => {
  async function* run(): AsyncGenerator<SDKLikeMessage> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const iter = query({
      prompt: params.prompt,
      options: {
        cwd: params.cwd,
        permissionMode: params.permissionMode,
        allowedTools: params.allowedTools,
        disallowedTools: params.disallowedTools,
        resume: params.resume,
        abortController: params.abortController,
        maxTurns: params.maxTurns,
      },
    });
    for await (const msg of iter) {
      yield msg as unknown as SDKLikeMessage;
    }
  }
  return run();
};
