// POST /api/linear/webhook — Linear AgentSessionEvent receiver.
//
// Contract: verify Linear-Signature over the RAW body BEFORE parsing (linear-agents-api.md §3);
// dedupe on Linear-Delivery via Neon insert-or-ignore BEFORE start/resume (contract §4); ack with
// a thought within 10s; `created` -> start(sessionWorkflow) + insert session row; `prompted` ->
// resume promptHook (with selectValue/signal). Must return inside 5s — all work here is fast.

import { start } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { promptHook, sessionWorkflow, type SessionInput } from "@/workflows/session";
import { claimDelivery, insertSession } from "@/lib/db";
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

  // 3) Dedupe BEFORE start/resume. A missing delivery id can't be deduped — process it (the
  //    signature already proved authenticity); workflow-side idempotency is the backstop.
  const deliveryId = getDeliveryId(request.headers, body);
  if (deliveryId) {
    const fresh = await claimDelivery(deliveryId);
    if (!fresh) return Response.json({ ok: true, deduped: true });
  }

  const parsed = parseWebhook(body);

  try {
    if (parsed.action === "created") {
      if (!parsed.linearSessionId) return new Response("missing session id", { status: 400 });

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
      const run = await start(sessionWorkflow, [input]);
      await insertSession({
        linearSessionId: parsed.linearSessionId,
        workflowRunId: run.runId,
        issueIdentifier: parsed.issueIdentifier,
      });
      return Response.json({ ok: true, runId: run.runId });
    }

    if (parsed.action === "prompted") {
      if (!parsed.linearSessionId) return new Response("missing session id", { status: 400 });
      const resumed = await resumePromptWithRetry(parsed.linearSessionId, {
        text: parsed.text,
        selectValue: parsed.selectValue,
        signal: parsed.signal,
      });
      // No active hook (session already finished, or never started) -> accept and ignore.
      return Response.json({ ok: true, resumed });
    }

    if (parsed.action === "stop") {
      // Defensive standalone stop: deliver as a stop signal to the prompt hook.
      if (parsed.linearSessionId) {
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
