import { test, expect, describe, beforeEach } from "bun:test";
import { testConfig } from "./test-helpers.ts";
import { sendQuestion, questionUrlFrom, ContractVersionMismatchError } from "./question-client.ts";

beforeEach(() => {
  testConfig();
});

const noopSleep = async () => {};

const req = {
  jobId: "j1",
  linearSessionId: "s1",
  questionId: "q1",
  questions: [
    {
      question: "Pick one",
      header: "Pick",
      multiSelect: false,
      options: [
        { label: "A", description: "" },
        { label: "B", description: "" },
      ],
    },
  ],
};

interface Recorded {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

// A fetch double that returns a scripted sequence of HTTP statuses (last entry repeats).
function scriptedFetch(statuses: number[]) {
  const calls: Recorded[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), body, headers });
    const status = statuses[Math.min(i, statuses.length - 1)]!;
    i++;
    return new Response(status === 200 ? JSON.stringify({ ack: true }) : "err", { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("questionUrlFrom", () => {
  test("swaps the callback path segment for the question one", () => {
    expect(questionUrlFrom("https://app.vercel.app/api/mini/callback")).toBe(
      "https://app.vercel.app/api/mini/question",
    );
  });
});

describe("sendQuestion", () => {
  test("delivers on 2xx with bearer auth + contractVersion to the /question URL", async () => {
    const sf = scriptedFetch([200]);
    await sendQuestion(req, { fetchImpl: sf.fn, sleepImpl: noopSleep });
    expect(sf.calls.length).toBe(1);
    expect(sf.calls[0]!.url).toBe("https://vercel.test/api/mini/question");
    expect(sf.calls[0]!.headers["authorization"]).toBe("Bearer test-secret");
    expect(sf.calls[0]!.body.contractVersion).toBe("1.0.0");
    expect(sf.calls[0]!.body.questionId).toBe("q1");
  });

  test("retries on a retryable 503 (no active hook yet) then succeeds — the B1 fix", async () => {
    const sf = scriptedFetch([503, 503, 200]);
    await sendQuestion(req, { fetchImpl: sf.fn, sleepImpl: noopSleep });
    expect(sf.calls.length).toBe(3); // kept trying across the hook-registration window
  });

  test("throws after exhausting retries if the hook never registers", async () => {
    const sf = scriptedFetch([503]);
    await expect(sendQuestion(req, { fetchImpl: sf.fn, sleepImpl: noopSleep })).rejects.toThrow();
    expect(sf.calls.length).toBe(6); // MAX_ATTEMPTS
  });

  test("409 is fatal: throws ContractVersionMismatchError without retrying", async () => {
    const sf = scriptedFetch([409]);
    await expect(sendQuestion(req, { fetchImpl: sf.fn, sleepImpl: noopSleep })).rejects.toBeInstanceOf(
      ContractVersionMismatchError,
    );
    expect(sf.calls.length).toBe(1);
  });

  test("aborts the retry loop when the signal is already aborted", async () => {
    const sf = scriptedFetch([503]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      sendQuestion(req, { fetchImpl: sf.fn, sleepImpl: noopSleep, signal: ctrl.signal }),
    ).rejects.toThrow("aborted");
    expect(sf.calls.length).toBe(0);
  });
});
