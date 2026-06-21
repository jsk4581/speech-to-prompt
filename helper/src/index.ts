// STP local helper — entry point.
//
// Brings up the voice session: a 127.0.0.1 server (session token) that serves the
// popup View and mounts the popup/agent transport (SSE push + transcribe + the
// grill round/poll/answer/confirm/cancel routes). The skill launches this, reads
// the STP_READY line for the port + token, and drives the grill loop through the
// grill bridge (grill.ts) against these routes.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startVoiceSession } from "./server.js";
import { ensureSttReady, type BootstrapProgress } from "./bootstrap.js";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

// Map the bootstrap's progress events to the popup's `bootstrap` SSE shape
// ({ phase, pct? }) and mirror them to stdout for the launcher's logs.
function emitBootstrap(p: BootstrapProgress): void {
  console.log(`STP_BOOTSTRAP ${JSON.stringify(p)}`);
  const pct =
    p.kind === "download" && p.total ? Math.round((p.received / p.total) * 100) : undefined;
  session?.hub.broadcast("bootstrap", { phase: p.kind, pct });
}

// The STT plan is resolved lazily on the first /transcribe (ensureSttReady is
// memoized), so startup never blocks behind a multi-hundred-MB model download —
// the popup opens immediately and STP_READY is emitted right away.
const session = await startVoiceSession({
  webDir,
  // Bridge the bootstrap's SttPlan (bin/model optional — absent in BYOK mode) to
  // the server's transcribe contract (bin/model present). In BYOK mode the server
  // short-circuits before touching them, so empty strings are never used.
  resolveStt: async () => {
    const plan = await ensureSttReady({ onProgress: emitBootstrap });
    return { ...plan, bin: plan.bin ?? "", model: plan.model ?? "" };
  },
});

// First stdout line = the machine-readable ready signal the launcher parses
// (non-guessable port + session token, never world-readable).
console.log(`STP_READY port=${session.port} token=${session.token}`);
console.log(`STP helper listening at ${session.url}`);

// Pre-warm the speech engine now (non-blocking) so the model is downloading while
// the user reads the popup. Memoized, so the first /transcribe awaits this same
// result; progress streams to the popup over SSE. A failure is reported, not
// fatal — the server stays up so BYOK / retry remain reachable.
void ensureSttReady({ onProgress: emitBootstrap }).catch((err) => {
  console.error(`STP bootstrap failed: ${err instanceof Error ? err.message : err}`);
});

const shutdown = () => {
  void session.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
