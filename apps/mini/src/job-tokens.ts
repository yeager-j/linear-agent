// Per-job Linear access tokens, held in memory ONLY (never persisted to SQLite). Vercel is the
// Linear token authority; it mints a fresh access token per job (the token rotates ~daily) and
// sends it in the POST /jobs payload. The mini uses it for that one job's activity stream and drops
// it the instant the job ends. Keeping it out of mini.sqlite means there is no Linear credential at
// rest on the appliance, and jobs never resume across a restart — so an in-memory token is exactly
// as available as the job that needs it.

const tokens = new Map<string, string>();

export function setJobToken(jobId: string, token: string): void {
  tokens.set(jobId, token);
}

export function getJobToken(jobId: string): string | undefined {
  return tokens.get(jobId);
}

export function deleteJobToken(jobId: string): void {
  tokens.delete(jobId);
}
