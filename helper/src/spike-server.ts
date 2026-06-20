// STP audio spike — full browser→whisper round-trip server.
//
// Brings up the helper server, registers a POST /transcribe route that runs the
// uploaded WAV through whisper.cpp, and opens the spike page. This exercises the
// real path: getUserMedia (browser) → 16 kHz mono WAV (record.js) → upload →
// whisper.cpp → text. Each transcript is also appended to a JSONL file so it can
// be consumed out of band.
//
// Env:
//   STP_WHISPER_BIN, STP_WHISPER_MODEL  (required) — whisper binary + model
//   STP_LANG            (default "auto") — whisper language
//   STP_SAMPLE_WAV      (optional) — served at /sample.wav for the browser self-test
//   STP_TRANSCRIPT_DIR  (default <tmp>/stp-spike) — where transcript.jsonl is written
//   STP_PORT            (default 0 = ephemeral)
//   STP_OPEN            ("0" to NOT auto-open the browser)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, appendFile, readFile, unlink } from "node:fs/promises";
import { startServer, readBody, sendJson, type RouteHandler } from "./server.js";
import { resolveWhisperPaths, assertWhisperReady, transcribe } from "./audio.js";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const language = process.env.STP_LANG ?? "auto";
const samplePath = process.env.STP_SAMPLE_WAV;
const transcriptDir = process.env.STP_TRANSCRIPT_DIR ?? join(tmpdir(), "stp-spike");

const paths = resolveWhisperPaths();
await assertWhisperReady(paths);
await mkdir(transcriptDir, { recursive: true });
const transcriptFile = join(transcriptDir, "transcript.jsonl");

const transcribeRoute: RouteHandler = async (req, res) => {
  const wav = await readBody(req);
  const tmp = join(tmpdir(), `stp-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  await writeFile(tmp, wav);
  try {
    const result = await transcribe({ ...paths, wavPath: tmp, language });
    await appendFile(
      transcriptFile,
      JSON.stringify({ at: new Date().toISOString(), bytes: wav.length, ...result }) + "\n",
    );
    console.log(
      `[spike] ${wav.length}B → ${result.elapsedMs.toFixed(0)}ms` +
        (result.language ? ` (${result.language})` : "") +
        `: ${result.text}`,
    );
    sendJson(res, 200, { ...result, bytes: wav.length, transcriptFile });
  } finally {
    await unlink(tmp).catch(() => {});
  }
};

const handlers: Record<string, RouteHandler> = { "POST /transcribe": transcribeRoute };
if (samplePath) {
  handlers["GET /sample.wav"] = async (_req, res) => {
    const data = await readFile(samplePath);
    res.writeHead(200, { "content-type": "audio/wav", "content-length": data.length });
    res.end(data);
  };
}

const server = await startServer({
  webDir,
  handlers,
  port: Number(process.env.STP_PORT) || 0,
});
const pageUrl = `http://127.0.0.1:${server.port}/spike.html?t=${server.token}`;

// Machine-readable ready signal first (port + session token), then a human banner.
console.log(`STP_READY port=${server.port} token=${server.token}`);
console.log("\n  STP audio spike ready");
console.log(`  page:        ${pageUrl}`);
console.log(`  transcripts: ${transcriptFile}`);
if (samplePath) console.log(`  self-test:   sample wav served at /sample.wav`);
console.log("");

if (process.env.STP_OPEN !== "0") openBrowser(pageUrl);

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    /* best-effort; the URL is printed above */
  }
}

const shutdown = () => void server.close().finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
