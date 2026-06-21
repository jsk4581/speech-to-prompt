// STP local helper — entry point.
//
// Starts the localhost server (127.0.0.1 + session token) and serves the popup
// View. Audio capture, prompt drafting, and the prompt handoff are layered on as
// routes; this entry just brings the server up.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./server.js";
import { ensureSttReady } from "./bootstrap.js";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

const server = await startServer({ webDir });
// First stdout line = the machine-readable ready signal the launcher parses to
// reach the helper (non-guessable port + session token, never world-readable).
console.log(`STP_READY port=${server.port} token=${server.token}`);
console.log(`STP helper listening at ${server.url}`);

// Pre-warm the speech engine: download/select the whisper binary + model on
// first run. Non-blocking so the popup opens immediately; the result is
// memoized, so the transcribe route just awaits ensureSttReady(). Progress goes
// to stdout (the popup will mirror it over SSE once that route lands); a failure
// is reported, not fatal — the server stays up so BYOK / retry stay reachable.
void ensureSttReady({
  onProgress: (p) => console.log(`STP_BOOTSTRAP ${JSON.stringify(p)}`),
}).catch((err) => {
  console.error(`STP bootstrap failed: ${err instanceof Error ? err.message : err}`);
});

const shutdown = () => {
  void server.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
