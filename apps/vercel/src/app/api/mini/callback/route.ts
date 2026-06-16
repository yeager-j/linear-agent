// POST /api/mini/callback — terminal job status from the mini.
//
// Contract: require `Authorization: Bearer <CALLBACK_SECRET>` with a constant-time compare
// (contract §2); reject unknown contractVersion with 409 (D8); resume jobDoneHook(`job:${jobId}`).
// A HookNotFoundError has two causes that we can't distinguish here: the hook isn't registered YET
// (a fast job — DRY_RUN, or a synchronous early-return like "no repo configured" — can call back
// before waitForJob creates the hook, since start() returns before hooks register), or the token
// is already consumed (a duplicate callback). We return a RETRYABLE 503 so the mini's bounded
// backoff replays until the hook registers; a true duplicate simply exhausts those bounded retries
// harmlessly (the workflow already moved on). Returning 200 here would silently drop the first
// callback of a fast job and wedge the workflow until its 45-min timeout (contract §4/§7).

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
    if (HookNotFoundError.is(err)) {
      // Hook not registered yet (early callback) or already consumed (duplicate). Ask the mini to
      // retry: an early callback succeeds once waitForJob registers the hook; a duplicate just
      // exhausts the mini's bounded retries. Either beats wedging the workflow for 45 minutes.
      return Response.json(
        { error: "no-active-job-hook", reason: "workflow not ready; retry" },
        { status: 503 },
      );
    }
    console.error("[callback] resume failed", err);
    return new Response("internal error", { status: 500 });
  }

  return Response.json({ ack: true });
}
