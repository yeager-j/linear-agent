// THE SEAM — re-exported from the shared @linear-agent/contract package.
// The schemas and CONTRACT_VERSION now live ONCE in packages/contract/src/index.ts and are
// imported by both apps. This shim keeps the local "@/lib/contract" import path stable; there
// is nothing to keep byte-for-byte aligned by hand anymore.
export * from "@linear-agent/contract";
