// THE SEAM — re-exported from the shared @linear-agent/contract package.
// The schemas, CONTRACT_VERSION, and token helpers now live ONCE in
// packages/contract/src/index.ts and are imported by both apps. This shim keeps the local
// "./contract.ts" import path stable; there is nothing to keep in sync by hand anymore.
export * from "@linear-agent/contract";
