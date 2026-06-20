// STP local helper — entry point.
//
// Starts the localhost server (127.0.0.1 + session token) and serves the popup
// View. Audio capture, prompt drafting, and the prompt handoff are layered on as
// routes; this entry just brings the server up.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./server.js";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

const server = await startServer({ webDir });
// First stdout line = the machine-readable ready signal the launcher parses to
// reach the helper (non-guessable port + session token, never world-readable).
console.log(`STP_READY port=${server.port} token=${server.token}`);
console.log(`STP helper listening at ${server.url}`);

const shutdown = () => {
  void server.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
