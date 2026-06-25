// POST /api/linear/webhook — Linear AgentSessionEvent receiver.
//
// TEMPORARILY DISABLED for the bun→npm Workflow-dispatch experiment: the original
// handler start()ed sessionWorkflow and resumed promptHook. sessionWorkflow has been
// removed so the deployed app matches the working `workflow-demo` (hello-only).
// Recover the full implementation from git history when the experiment concludes.

export const runtime = "nodejs";

export async function POST(_request: Request): Promise<Response> {
  return Response.json({ ok: true, disabled: "session dispatch removed for experiment" });
}
