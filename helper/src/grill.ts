// STP — grill bridge: the CLI the main agent drives to run the question loop.
//
// The main agent is not a resident socket client; it works in tool-call units.
// So the live grill loop is a few Bash invocations of THIS small CLI, which talks
// to the already-running helper (server.ts startVoiceSession) over loopback HTTP:
//
//   grill transcript --out f.txt --wait   wait for the user's recording, write the
//                                          raw transcript to a file (out of session)
//   grill round --draft d.json --final-out final.xml
//                                          publish a grill round (draft → popup) and
//                                          long-poll until the next popup outcome
//   grill poll  --final-out final.xml      resume polling (after a Bash timeout)
//
// Why a CLI and not raw curl in the runbook: the draft JSON and the generated XML
// never pass through the main session. The subagent writes the GrillDraft to a
// file; this bridge reads it, renders the XML (generateXml in xml.ts), posts the
// round, and returns only a compact outcome. The session sees compressed Q&A —
// no raw STT, no draft, no verbose reasoning, keeping the session uncluttered.
//
// Connection: STP_PORT / STP_TOKEN (from the helper's `STP_READY port=… token=…`
// line) or --port/--token. Auth = Authorization: Bearer <token>; a non-browser
// client sends no Origin, which the server allows. No third-party deps.

import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";
import {
  generateXml,
  parseXml,
  type GrillDraft,
} from "./xml.js";

// ─────────────────────────── round / outcome shapes ────────────────────────

/** The round payload the popup renders (app.js renderRound). */
export interface RoundPayload {
  stage: string;
  draftXml: string;
  /** Note: the popup reads `chips`, while the schema's Question uses `choices`. */
  questions: { id: string; tag: string; text: string; chips: string[] }[];
  /** What the user said — so a popup that (re)connects mid-loop shows the real
   *  words instead of the static sample text. */
  transcript?: string;
}

/** What the long-poll yields straight from the server (raw popup events). */
type RawOutcome =
  | { status: "answered"; answers?: unknown[]; [k: string]: unknown }
  | { status: "confirmed"; xml?: string; [k: string]: unknown }
  | { status: "cancelled" }
  | { status: "popup_closed" }
  | { status: "timeout" };

/** The finalized outcome emitted to the agent (confirmed XML validated to a file). */
export type Outcome =
  | { status: "answered"; answers?: unknown[]; [k: string]: unknown }
  | { status: "confirmed"; ok: true; finalOut: string }
  | { status: "confirmed"; ok: false; problem: string }
  | { status: "cancelled" }
  | { status: "popup_closed" }
  | { status: "timeout" };

// ───────────────────────────── pure transforms ─────────────────────────────

/**
 * Render a GrillDraft into the popup round payload. The schema calls a question's
 * quick replies `choices`; the View renders `chips` — bridge that here so neither
 * the XML schema nor the popup has to know about the other.
 */
export function roundPayload(draft: GrillDraft, stage?: string): RoundPayload {
  const questions = Array.isArray(draft.questions) ? draft.questions : [];
  return {
    stage: stage ?? `grill · ${questions.length} question${questions.length === 1 ? "" : "s"}`,
    draftXml: generateXml(draft, { indent: "  " }),
    questions: questions.map((q) => ({
      id: q.id,
      tag: q.tag,
      text: q.text,
      chips: q.choices ?? [],
    })),
  };
}

/**
 * Validate + normalize the XML the user confirmed in the popup. The text may have
 * been hand-edited, so it is re-parsed, checked against the injection invariants,
 * and re-emitted in canonical form (section order, escaping). Returns the clean
 * XML or the specific reason it is not ready — the caller never injects on failure.
 */
export function finalizeConfirmed(
  xml: string,
  opts: { lenient?: boolean } = {},
): { ok: true; xml: string } | { ok: false; problem: string } {
  let draft: GrillDraft;
  try {
    draft = parseXml(xml);
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : String(e) };
  }
  try {
    return { ok: true, xml: generateXml(draft, { injectionReady: true, lenient: opts.lenient }) };
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : String(e) };
  }
}

/** Find the most recent usable transcript line in a transcript.jsonl body. */
export function latestTranscript(
  jsonl: string,
): { text: string; language?: string; mode?: string; grill?: string } | null {
  const lines = jsonl.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]) as {
        text?: unknown;
        language?: unknown;
        mode?: unknown;
        grill?: unknown;
      };
      if (typeof obj.text === "string" && obj.text.trim()) {
        return {
          text: obj.text,
          language: typeof obj.language === "string" ? obj.language : undefined,
          mode: obj.mode === "simple" || obj.mode === "max" ? obj.mode : undefined,
          grill: obj.grill === "on" || obj.grill === "off" ? obj.grill : undefined,
        };
      }
    } catch {
      /* skip a malformed line */
    }
  }
  return null;
}

// ───────────────────────────── connection / http ───────────────────────────

interface Conn {
  port: number;
  token: string;
}

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return argv.includes(`--${name}`);
}

function conn(): Conn {
  const port = Number(flag("port") ?? process.env.STP_PORT);
  const token = flag("token") ?? process.env.STP_TOKEN ?? "";
  if (!port || !token) {
    throw new Error(
      "missing helper connection — set STP_PORT and STP_TOKEN (from the helper's STP_READY line) or pass --port/--token",
    );
  }
  return { port, token };
}

function transcriptFile(): string {
  const dir = process.env.STP_TRANSCRIPT_DIR ?? join(tmpdir(), "stp");
  return join(dir, "transcript.jsonl");
}

/** One loopback HTTP request with a Bearer token and an optional client timeout. */
function request(
  c: Conn,
  method: string,
  path: string,
  opts: { body?: string; timeoutMs?: number } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body != null ? Buffer.from(opts.body, "utf8") : undefined;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: c.port,
        path,
        method,
        headers: {
          authorization: `Bearer ${c.token}`,
          ...(data
            ? { "content-type": "application/json", "content-length": data.length }
            : {}),
        },
      },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (out += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: out }));
      },
    );
    req.on("error", reject);
    if (opts.timeoutMs) {
      req.setTimeout(opts.timeoutMs, () => req.destroy(new Error("client-timeout")));
    }
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────── poll loop ─────────────────────────────────

const PER_POLL_MS = 90_000; // single long-poll window (server holds until an event)
const DEFAULT_CAP_S = 540; // overall cap for one Bash call (fits the 600s tool limit)

/**
 * Long-poll /agent/poll until the popup produces a terminal outcome. Each request
 * is bounded (PER_POLL_MS); a client-timeout or a `superseded` reply just re-polls
 * — every return is also a chance to notice the popup is gone. After `capS`
 * without a terminal event, returns {status:"timeout"} so the caller can resume.
 */
async function pollLoop(c: Conn, capS: number): Promise<RawOutcome> {
  const deadline = Date.now() + capS * 1000;
  while (Date.now() < deadline) {
    let res: { status: number; text: string };
    try {
      res = await request(c, "GET", "/agent/poll", { timeoutMs: PER_POLL_MS });
    } catch (e) {
      if (e instanceof Error && e.message === "client-timeout") continue; // re-poll
      // Connection refused etc. = the helper died → graceful stop, not a hang.
      return { status: "popup_closed" };
    }
    if (res.status !== 200) {
      await sleep(500);
      continue;
    }
    let out: { status?: string; [k: string]: unknown };
    try {
      out = JSON.parse(res.text) as { status?: string };
    } catch {
      continue;
    }
    if (out.status === "superseded") continue; // a stale holder was replaced — re-poll
    if (
      out.status === "answered" ||
      out.status === "confirmed" ||
      out.status === "cancelled" ||
      out.status === "popup_closed"
    ) {
      return out as RawOutcome;
    }
    // Unknown status — re-poll defensively.
  }
  return { status: "timeout" };
}

/**
 * Pure-dictation runs (simple mode + grill off, read from the transcript
 * record) get the lenient gate: the two normally-required fields may be
 * absent because nothing the user didn't say is ever added.
 */
async function isLenientRun(): Promise<boolean> {
  try {
    const latest = latestTranscript(await readFile(transcriptFile(), "utf8"));
    return latest?.mode === "simple" && latest?.grill === "off";
  } catch {
    return false;
  }
}

/** A confirmed outcome carries the user's (possibly edited) XML — finalize it. */
async function handleOutcome(out: RawOutcome, finalOut: string | undefined): Promise<Outcome> {
  if (out.status !== "confirmed") return out;
  const raw = typeof out.xml === "string" ? out.xml : "";
  const fin = finalizeConfirmed(raw, { lenient: await isLenientRun() });
  if (!fin.ok) return { status: "confirmed", ok: false, problem: fin.problem };
  const dest = finalOut ?? join(process.env.STP_TRANSCRIPT_DIR ?? tmpdir(), "final.xml");
  await writeFile(dest, fin.xml, "utf8");
  return { status: "confirmed", ok: true, finalOut: dest };
}

/**
 * Finalize the raw outcome and emit it — and when a confirm was rejected, push
 * the reason back to the popup (notice-only round: no draftXml, so the server
 * won't replay it) so the user sees why instead of a silently re-opened loop.
 */
async function finishRound(c: Conn, raw: RawOutcome, finalOut: string | undefined): Promise<void> {
  const out = await handleOutcome(raw, finalOut);
  if (out.status === "confirmed" && !out.ok) {
    await request(c, "POST", "/agent/round", {
      body: JSON.stringify({ stage: "confirm rejected", problem: out.problem }),
    }).catch(() => {
      /* best-effort notice — the agent still reports the problem */
    });
  }
  emit(out);
}

// ─────────────────────────────── subcommands ───────────────────────────────

/** Print exactly one compact JSON line — the only thing on stdout the agent reads. */
function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function cmdTranscript(): Promise<void> {
  const out = flag("out");
  const wait = hasFlag("wait");
  const timeoutS = Number(flag("timeout") ?? 110);
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    let body = "";
    try {
      body = await readFile(transcriptFile(), "utf8");
    } catch {
      /* file not created yet */
    }
    const latest = body ? latestTranscript(body) : null;
    if (latest) {
      if (out) await writeFile(out, latest.text, "utf8");
      emit({ ready: true, out: out ?? null, chars: latest.text.length, language: latest.language ?? null, mode: latest.mode ?? "max", grill: latest.grill ?? "on" });
      return;
    }
    if (!wait || Date.now() >= deadline) {
      emit({ ready: false });
      return;
    }
    await sleep(1000);
  }
}

async function cmdRound(): Promise<void> {
  const c = conn();
  const draftPath = flag("draft");
  if (!draftPath) throw new Error("round: --draft <GrillDraft json> is required");
  const draft = JSON.parse(await readFile(draftPath, "utf8")) as GrillDraft;
  const payload = roundPayload(draft, flag("stage"));
  try {
    const latest = latestTranscript(await readFile(transcriptFile(), "utf8"));
    if (latest) payload.transcript = latest.text;
  } catch {
    /* no transcript yet — the popup keeps whatever it shows */
  }
  const posted = await request(c, "POST", "/agent/round", { body: JSON.stringify(payload) });
  if (posted.status !== 200) throw new Error(`round: POST /agent/round → ${posted.status} ${posted.text}`);
  const capS = Number(flag("poll-cap") ?? DEFAULT_CAP_S);
  await finishRound(c, await pollLoop(c, capS), flag("final-out"));
}

async function cmdPoll(): Promise<void> {
  const c = conn();
  const capS = Number(flag("poll-cap") ?? DEFAULT_CAP_S);
  await finishRound(c, await pollLoop(c, capS), flag("final-out"));
}

async function main(): Promise<void> {
  const cmd = argv[2];
  switch (cmd) {
    case "transcript":
      await cmdTranscript();
      break;
    case "round":
      await cmdRound();
      break;
    case "poll":
      await cmdPoll();
      break;
    default:
      process.stderr.write(
        "usage: grill <transcript|round|poll> [--out f] [--draft f] [--final-out f] [--stage s] [--wait] [--timeout s] [--poll-cap s]\n",
      );
      process.exit(2);
  }
}

// Run only when invoked directly (so tests can import the pure transforms).
if (fileURLToPath(import.meta.url) === argv[1]) {
  main().catch((e) => {
    process.stderr.write(`grill: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
