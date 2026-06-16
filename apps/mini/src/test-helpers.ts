// Shared test scaffolding: an isolated in-memory DB + a fresh config, plus a mock fetch that
// records callback deliveries and can be scripted to fail N times.

import { openDb } from "./db.ts";
import { resetConfig, type Config } from "./config.ts";
import type { Database } from "bun:sqlite";

export function freshDb(): Database {
  return openDb(":memory:");
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return resetConfig({
    vercelCallbackUrl: "https://vercel.test/api/mini/callback",
    callbackSecret: "test-secret",
    maxConcurrentExecutions: 2,
    maxConcurrentPlans: 3,
    dbPath: ":memory:",
    ...overrides,
  });
}

export interface RecordedRequest {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

// A fetch double. `failTimes` makes the first N calls return 500; after that, 200 {ack:true}.
export function mockFetch(opts: { failTimes?: number } = {}) {
  let fails = opts.failTimes ?? 0;
  const calls: RecordedRequest[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = new Headers(init?.headers);
    h.forEach((v, k) => (headers[k] = v));
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: String(url), body, headers });
    if (fails > 0) {
      fails--;
      return new Response("err", { status: 500 });
    }
    return new Response(JSON.stringify({ ack: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// Build a CreateJobRequest body with sane defaults.
export function createJobBody(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "1.0.0",
    kind: "plan",
    linearSessionId: "sess-1",
    issueIdentifier: "ENG-1",
    promptContext: "<issue>do a thing</issue>",
    idempotencyKey: "sess-1:plan:0",
    ...overrides,
  };
}

export function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://mini.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
