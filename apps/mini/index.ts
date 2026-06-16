// Entry point for the linear-agent-mini execution appliance.
// Boots SQLite, reconciles interrupted jobs from a previous run, starts the callback flusher,
// and binds the HTTP server.

import { db } from "./src/db.ts";
import { reconcileOnBoot } from "./src/reconcile.ts";
import { startCallbackFlusher } from "./src/callback.ts";
import { startServer } from "./src/server.ts";
import { log } from "./src/log.ts";

async function main() {
  db(); // open + migrate
  await reconcileOnBoot();
  startCallbackFlusher();
  startServer();
}

main().catch((err) => {
  log.error("fatal boot error", { err: String(err) });
  process.exit(1);
});
