// Deterministic hook tokens — re-exported from the shared @linear-agent/contract package.
// They live ONCE in packages/contract/src/index.ts (contract §3). This shim keeps the local
// "@/lib/tokens" import path stable. MUST stay pure functions of their inputs (no Date.now /
// randomness) — they are recomputed on every workflow replay and must be identical each time.
export { promptToken, jobDoneToken } from "@linear-agent/contract";
