// Injectable dependencies for runners, so tests can swap the SDK query fn and Linear client
// without env/network. Production uses realQuery + makeLinearClient.

import { realQuery, type QueryFn } from "../sdk.ts";
import { makeLinearClient, type LinearClient } from "../linear.ts";
import { prepareWorkspace as realPrepareWorkspace, type Workspace, type PrepareOptions } from "../workspace/index.ts";
import { sendQuestion as realSendQuestion } from "../question-client.ts";
import type { SendQuestionFn } from "./question-handler.ts";

export interface RunnerDeps {
  query: QueryFn;
  // token = the per-job Linear access token (job-tokens.ts); the client authenticates with it.
  makeLinear: (token?: string) => LinearClient;
  prepareWorkspace: (opts: PrepareOptions) => Promise<Workspace>;
  sendQuestion: SendQuestionFn;
}

let _deps: RunnerDeps = {
  query: realQuery,
  makeLinear: (token) => makeLinearClient(undefined, token),
  prepareWorkspace: realPrepareWorkspace,
  sendQuestion: realSendQuestion,
};

export function runnerDeps(): RunnerDeps {
  return _deps;
}

// Test seam: override some/all deps. Returns a restore function.
export function setRunnerDeps(overrides: Partial<RunnerDeps>): () => void {
  const prev = _deps;
  _deps = { ..._deps, ...overrides };
  return () => {
    _deps = prev;
  };
}
