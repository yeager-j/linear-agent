// POST /api/linear/webhook — Linear AgentSessionEvent receiver.
//
// Contract: verify Linear-Signature over the RAW body BEFORE parsing (linear-agents-api.md §3);
// dedupe on Linear-Delivery via Neon insert-or-ignore BEFORE start/resume (contract §4); ack with
// a thought within 10s; `created` -> start(sessionWorkflow) + insert session row; `prompted` ->
// resume promptHook (with selectValue/signal). Must return inside 5s — all work here is fast.

import { start } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { promptHook, sessionWorkflow, type SessionInput } from "@/workflows/session";
import { claimDelivery, getSession, insertSession, releaseDelivery } from "@/lib/db";
import { isTimestampFresh, verifyLinearSignature, emitThought } from "@/lib/linear";
import { getDeliveryId, parseWebhook } from "@/lib/webhook";
import { promptToken } from "@/lib/tokens";

export const runtime = "nodejs";

// Resume the active run for a session's promptHook; if the workflow hasn't registered the hook
// yet (start() returns before hooks exist), retry briefly so the prompt isn't lost
// (vercel-workflows.md §5, workflow resume-or-start pattern).
async function resumePromptWithRetry(
  linearSessionId: string,
  payload: { text: string; selectValue?: string; signal?: "stop" },
): Promise<boolean> {
  const token = promptToken(linearSessionId);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await promptHook.resume(token, payload);
      return true;
    } catch (err) {
      if (!HookNotFoundError.is(err)) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return false;
}

export async function POST(request: Request): Promise<Response> {
  // 1) RAW body + signature (before any JSON.parse).
  const raw = await request.text();
  if (!verifyLinearSignature(raw, request.headers.get("linear-signature"))) {
    return new Response("invalid signature", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // 2) Replay guard.
  if (!isTimestampFresh(body.webhookTimestamp)) {
    return new Response("stale", { status: 202 });
  }

  // 3) Dedupe BEFORE start/resume. A missing delivery id can't be deduped here — the per-session
  //    guard below (getSession before start) is the backstop for that case (contract §4).
  const deliveryId = getDeliveryId(request.headers, body);
  let claimedDeliveryId: string | null = null;
  if (deliveryId) {
    const fresh = await claimDelivery(deliveryId);
    if (!fresh) return Response.json({ ok: true, deduped: true });
    claimedDeliveryId = deliveryId;
  }

  const parsed = parseWebhook(body);

  try {
    if (parsed.action === "created") {
      if (!parsed.linearSessionId) return new Response("missing session id", { status: 400 });

      // Per-session dedupe: a second `created` for the same session (re-delivery with a new id, or
      // re-delegation) must not spawn a second run. Covers the no-delivery-id case too.
      if (await getSession(parsed.linearSessionId)) {
        return Response.json({ ok: true, deduped: true });
      }

      // Ack thought within 10s (one GraphQL call) so the session isn't marked unresponsive.
      await emitThought(parsed.linearSessionId, `Looking into ${parsed.issueIdentifier}…`).catch(
        () => {},
      );

      const input: SessionInput = {
        linearSessionId: parsed.linearSessionId,
        issueId: parsed.issueId,
        issueIdentifier: parsed.issueIdentifier,
        promptContext: parsed.promptContext,
      };

      let run: { runId: string };
      try {
        run = await start(sessionWorkflow, [input]);
      } catch (err) {
        // No run was created — release the dedupe claim so Linear's retry re-processes instead of
        // seeing a phantom duplicate and dropping the session forever.
        if (claimedDeliveryId) await releaseDelivery(claimedDeliveryId).catch(() => {});
        throw err;
      }
      // The run is live; the session row is best-effort metadata + the per-session dedupe key. If
      // it fails to write, the same-delivery claim still prevents a duplicate run on retry.
      await insertSession({
        linearSessionId: parsed.linearSessionId,
        workflowRunId: run.runId,
        issueIdentifier: parsed.issueIdentifier,
      }).catch((err) => console.error("[webhook] insertSession failed (run already started)", err));
      return Response.json({ ok: true, runId: run.runId });
    }

    if (parsed.action === "prompted") {
      if (!parsed.linearSessionId) return new Response("missing session id", { status: 400 });
      // Only resume sessions this app actually started (ownership gate). An event for an unknown
      // session is accepted-and-ignored rather than blindly resuming a hook.
      if (!(await getSession(parsed.linearSessionId))) {
        return Response.json({ ok: true, ignored: "unknown-session" });
      }
      const resumed = await resumePromptWithRetry(parsed.linearSessionId, {
        text: parsed.text,
        selectValue: parsed.selectValue,
        signal: parsed.signal,
      });
      // No active hook (session already finished) -> accept and ignore.
      return Response.json({ ok: true, resumed });
    }

    if (parsed.action === "stop") {
      // Defensive standalone stop: deliver as a stop signal to the prompt hook (only for a session
      // we started).
      if (parsed.linearSessionId && (await getSession(parsed.linearSessionId))) {
        await resumePromptWithRetry(parsed.linearSessionId, { text: "", signal: "stop" });
      }
      return Response.json({ ok: true });
    }

    // Unknown action — accept so Linear doesn't retry forever.
    return Response.json({ ok: true, ignored: true });
  } catch (err) {
    // Surface a 500 so Linear retries (and our delivery dedupe makes the retry safe).
    console.error("[webhook] error handling event", err);
    return new Response("internal error", { status: 500 });
  }
}
