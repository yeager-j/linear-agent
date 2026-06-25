import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { helloWorkflow } from "../../../workflows/hello";

export async function POST(request: Request) {
  const { name = "world" } = await request.json().catch(() => ({}));

  // start() returns immediately — the workflow runs durably in the background.
  const run = await start(helloWorkflow, [name]);

  return NextResponse.json({ runId: run.runId });
}

// Convenience handler so you can trigger the workflow from a browser.
export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name") ?? "world";

  const run = await start(helloWorkflow, [name]);

  return NextResponse.json({ runId: run.runId });
}
