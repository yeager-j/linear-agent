// POST /api/mini/callback — terminal job status from the mini.
//
// Contract: require `Authorization: Bearer <CALLBACK_SECRET>` with a constant-time compare
// (contract §2); reject unknown contractVersion with 409 (D8); resume jobDoneHook(`job:${jobId}`)
// idempotently — a duplicate jobId resumes an already-consumed token, which throws
// HookNotFoundError and is treated as a 200 no-op (contract §4/§7).

import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { CONTRACT_VERSION, MiniCallback, type JobDoneHookPayload } from "@/lib/contract";
import { bearerOk } from "@/lib/auth";
import { jobDoneToken } from "@/lib/tokens";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  // 1) Auth.
  if (!bearerOk(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  // 2) Parse + contract-version check (fail loudly on a half-deployed pair).
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const version = (body as { contractVersion?: unknown })?.contractVersion;
  if (version !== CONTRACT_VERSION) {
    return Response.json(
      { error: "contract-version-mismatch", contractVersion: CONTRACT_VERSION },
      { status: 409 },
    );
  }

  const result = MiniCallback.safeParse(body);
  if (!result.success) {
    return Response.json({ error: "invalid-callback", issues: result.error.issues }, { status: 400 });
  }
  const cb = result.data;

  // 3) Resume the jobDoneHook. Mirror the terminal fields of MiniCallback into the hook payload.
  const payload: JobDoneHookPayload = {
    jobId: cb.jobId,
    kind: cb.kind,
    status: cb.status,
    prUrl: cb.prUrl,
    branch: cb.branch,
    planSummary: cb.planSummary,
    claudeSessionId: cb.claudeSessionId,
    reason: cb.reason,
  };

  try {
    await resumeHook(jobDoneToken(cb.jobId), payload);
  } catch (err) {
    // Duplicate callback or job already finished -> token consumed -> no-op. Any 2xx tells the
    // mini to stop retrying (contract §7).
    if (!HookNotFoundError.is(err)) {
      console.error("[callback] resume failed", err);
      return new Response("internal error", { status: 500 });
    }
  }

  return Response.json({ ack: true });
}
