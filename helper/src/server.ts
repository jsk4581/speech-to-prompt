// STP local helper — localhost HTTP server + voice-session transport.
//
// Two layers live here:
//
//   1. startServer() — a small, generic 127.0.0.1 HTTP server with a session
//      token gate and a `handlers` extension point. The audio spike reuses it.
//      Bind to 127.0.0.1 ONLY (never 0.0.0.0) so no remote process can reach it;
//      sensitive routes require the per-launch token; Host/Origin are checked to
//      block DNS-rebinding and cross-origin CSRF.
//
//   2. startVoiceSession() — the popup transport: an SSE push channel to the
//      popup, POST routes for the popup (transcribe / answer / edit / confirm /
//      cancel), an agent long-poll, the fragment-token → SameSite cookie
//      exchange, and idle self-shutdown. The grill question content is supplied
//      by the agent at runtime; this module is just the wiring.
//
// No third-party runtime dependencies: Node's http/fs/crypto only.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, mkdir, writeFile, appendFile, unlink } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  resolveWhisperPaths,
  assertWhisperReady,
  transcribe,
  type WhisperPaths,
} from "./audio.js";

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { url: URL; token: string },
) => void | Promise<void>;

export interface ServerOptions {
  /** Directory served as static files (the popup View). */
  webDir: string;
  /** Listen port; 0 (default) picks a free ephemeral port. */
  port?: number;
  /** Session token; a fresh 32-hex token is minted when omitted. */
  token?: string;
  /** Extra routes keyed by "METHOD /path", e.g. "POST /transcribe". */
  handlers?: Record<string, RouteHandler>;
}

export interface RunningServer {
  port: number;
  token: string;
  /** Loopback URL with the session token, ready to open in a browser. */
  url: string;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Read a request body fully into a Buffer (used for raw audio uploads). */
export function readBody(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error(`request body exceeds ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Parse a JSON request body, tolerating empties/garbage (returns {} on failure). */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req, 4 * 1024 * 1024);
  try {
    const v = JSON.parse(buf.toString("utf8") || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** JSON response helper. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ── auth / origin helpers ────────────────────────────────────────────────────

/** Cookies → map. Lenient; only `stp_token` matters. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Token presented on a request, in precedence order:
 *   Authorization: Bearer  (agent — from helper stdout)
 *   x-stp-token header      (legacy / spike)
 *   stp_token cookie        (popup, after the fragment→cookie exchange)
 *   ?t= query               (legacy / spike / static launch URL)
 */
function presentedToken(req: IncomingMessage, url: URL): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const h = req.headers["x-stp-token"];
  if (typeof h === "string") return h;
  const cookie = parseCookies(req.headers.cookie)["stp_token"];
  if (cookie) return cookie;
  return url.searchParams.get("t") ?? undefined;
}

/**
 * Extra hostnames the user explicitly trusts in front of the helper —
 * STP_ALLOWED_HOSTS, comma-separated. For headless setups where an
 * HTTPS reverse proxy on a private overlay network (e.g. `tailscale serve`)
 * fronts the loopback helper so the popup opens without an SSH tunnel.
 * Default: empty — loopback only. The per-run token still gates every request.
 */
function extraAllowedHosts(): string[] {
  return (process.env.STP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostName(host: string): string {
  let name = host;
  const close = host.indexOf("]"); // IPv6 "[::1]:port"
  const colon = host.lastIndexOf(":");
  if (colon > close) name = host.slice(0, colon);
  return name.replace(/^\[|\]$/g, "");
}

/** Reject any Host header that isn't loopback or explicitly trusted (blocks DNS-rebinding). */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = hostName(host);
  if (name === "127.0.0.1" || name === "localhost" || name === "::1") return true;
  return extraAllowedHosts().includes(name.toLowerCase());
}

/** State-changing requests must originate from the popup's own page (blocks CSRF). */
function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true; // non-browser client (agent curl) sends no Origin
  if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) return true;
  try {
    const u = new URL(origin);
    // Trusted fronts terminate TLS themselves, so require https there.
    return u.protocol === "https:" && extraAllowedHosts().includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function serveStatic(res: ServerResponse, webDir: string, pathname: string): Promise<void> {
  // Map "/" -> the popup page (index.html).
  const rel = pathname === "/" ? "/index.html" : pathname;
  // Resolve safely inside webDir (block path traversal).
  const full = normalize(join(webDir, rel));
  if (full !== webDir && !full.startsWith(webDir + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(full);
    res.writeHead(200, {
      "content-type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream",
      "content-length": data.length,
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(32).toString("hex");
  const webDir = normalize(opts.webDir);
  const handlers = opts.handlers ?? {};
  // Actual bound port — needed for the Origin check; set once we listen().
  let boundPort = opts.port ?? 0;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        // Host gate first: this server is loopback-only by construction.
        if (!isLoopbackHost(req.headers.host)) {
          sendJson(res, 403, { error: "bad host" });
          return;
        }

        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const routeKey = `${req.method} ${url.pathname}`;
        const handler = handlers[routeKey];

        if (handler) {
          // Sensitive routes require the session token (cookie/Bearer/header/query).
          if (presentedToken(req, url) !== token) {
            sendJson(res, 403, { error: "bad or missing session token" });
            return;
          }
          // CSRF: state-changing requests must come from the loopback page.
          if (
            STATE_CHANGING.has(req.method ?? "") &&
            !isAllowedOrigin(req.headers.origin, boundPort)
          ) {
            sendJson(res, 403, { error: "bad origin" });
            return;
          }
          await handler(req, res, { url, token });
          return;
        }

        if (req.method === "GET") {
          if (url.pathname === "/health") {
            sendJson(res, 200, { ok: true });
            return;
          }
          await serveStatic(res, webDir, url.pathname);
          return;
        }

        sendJson(res, 404, { error: "no such route" });
      } catch (err) {
        sendJson(res, 500, { error: String(err instanceof Error ? err.message : err) });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // 127.0.0.1 ONLY — the sandbox denies 0.0.0.0, and so do we by design.
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      boundPort = port;
      resolve({
        port,
        token,
        url: `http://127.0.0.1:${port}/?t=${token}`,
        close: () =>
          new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

// ── SSE push hub (server → popup) ────────────────────────────────────────────

/**
 * Tracks the popup's open EventSource connections. The set being non-empty IS
 * the popup-liveness signal: no extra heartbeat protocol — when the popup
 * closes, the browser drops the connection and `onChange` fires with size 0.
 */
export class SseHub {
  private clients = new Set<ServerResponse>();
  /** Called whenever a client attaches or drops. */
  onChange?: () => void;

  get size(): number {
    return this.clients.size;
  }

  /** Turn a GET /events response into a long-lived SSE stream. */
  attach(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": ok\n\n");
    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
      this.onChange?.();
    });
    this.onChange?.();
  }

  /** Push a named event to one just-attached client (state replay on connect). */
  send(res: ServerResponse, event: string, data: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client already gone — its close handler cleans up */
    }
  }

  /** Push a named event with a JSON payload to every connected popup. */
  broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const r of this.clients) {
      try {
        r.write(frame);
      } catch {
        /* a dropped client is cleaned up by its own close handler */
      }
    }
  }

  /** Keep-alive comment ping (prevents idle proxy cut, detects half-open). */
  ping(): void {
    for (const r of this.clients) {
      try {
        r.write(": ka\n\n");
      } catch {
        /* ignore */
      }
    }
  }

  closeAll(): void {
    for (const r of this.clients) {
      try {
        r.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}

// ── voice session transport ──────────────────────────────────────────────────

const KEEPALIVE_MS = 15_000; // SSE comment ping
const GRACE_MS = 25_000; // SSE reconnect grace before declaring popup_closed
const IDLE_CHECK_MS = 30_000; // how often idle self-shutdown is evaluated

/** Terminal outcomes the agent long-poll can resolve with (popup state machine). */
export type AgentOutcome =
  | { status: "answered"; [k: string]: unknown }
  | { status: "confirmed"; [k: string]: unknown }
  | { status: "cancelled" }
  | { status: "popup_closed" };

/**
 * What a transcribe needs, as produced by the STT bootstrap (ensureSttReady).
 * `threads` matters: passing it dodges whisper's `-t 4` default (barely real-time
 * even on a fast CPU). `mode: "byok"` defers to cloud STT (not handled here) and
 * carries no local bin/model.
 */
export interface SttPlan {
  bin: string;
  model: string;
  threads?: number;
  mode?: "local" | "byok";
  [k: string]: unknown;
}

export interface VoiceSessionOptions {
  /** Directory served as static files (the popup View). */
  webDir: string;
  port?: number;
  token?: string;
  /** Whisper bin/model; resolved eagerly from here or env when present. */
  whisper?: Partial<WhisperPaths>;
  /**
   * Async STT resolver awaited on the first /transcribe when no eager bin/model
   * was found — the bootstrap's memoized `ensureSttReady`. Keeps server.ts
   * decoupled from bootstrap.ts (passed in by the caller) and carries plan.threads.
   */
  resolveStt?: () => Promise<SttPlan>;
  /** Whisper language code, or "auto". Defaults to STP_LANG / "auto". */
  language?: string;
  /** Whisper worker threads. Defaults to STP_THREADS. */
  threads?: number;
  /** Where transcript.jsonl is appended (a log other tooling can read out of band). */
  transcriptDir?: string;
  /** Idle window before self-shutdown. Defaults to STP_IDLE_MS or 10 min. */
  idleMs?: number;
  /** Whether idle shutdown calls process.exit (true in prod, false in tests). */
  exitOnIdle?: boolean;
}

export interface VoiceSession extends RunningServer {
  hub: SseHub;
  /** Push a grill round (draft + questions) to the popup. */
  pushRound: (round: unknown) => void;
}

/**
 * Bring up the full popup transport: static View + SSE + the popup/agent routes.
 *
 * Routes (all token-gated, Host/Origin checked):
 *   POST /session       fragment-token (Bearer) → Set-Cookie stp_token (SameSite=Strict)
 *   GET  /events        SSE push channel (server → popup)
 *   POST /transcribe    audio (wav) → whisper text; appended to transcript.jsonl
 *   POST /agent/round   agent → popup: a new grill round (broadcast over SSE)
 *   GET  /agent/poll    agent long-poll, held until a terminal popup event
 *   POST /answer        popup → agent: answers      → resolves poll "answered"
 *   POST /confirm       popup → agent: final XML     → resolves poll "confirmed"
 *   POST /cancel        popup → agent: explicit stop → resolves poll "cancelled"
 *   POST /edit          popup edited the draft (non-terminal; echoed over SSE)
 */
export async function startVoiceSession(opts: VoiceSessionOptions): Promise<VoiceSession> {
  const hub = new SseHub();
  const language = opts.language ?? process.env.STP_LANG ?? "auto";
  const threads = opts.threads ?? (Number(process.env.STP_THREADS) || undefined);
  const transcriptDir =
    opts.transcriptDir ?? process.env.STP_TRANSCRIPT_DIR ?? join(tmpdir(), "stp");
  const idleMs = opts.idleMs ?? (Number(process.env.STP_IDLE_MS) || 10 * 60 * 1000);
  const exitOnIdle = opts.exitOnIdle ?? true;

  await mkdir(transcriptDir, { recursive: true });
  const transcriptFile = join(transcriptDir, "transcript.jsonl");

  // STT plan resolution. The popup + SSE come up immediately regardless; the
  // model is resolved without blocking startup (so STP_READY isn't held behind a
  // multi-hundred-MB download — the non-blocking startup order). Precedence:
  //   1. eager: explicit opts.whisper / env now (a provisioned machine + tests
  //      transcribe without waiting on a resolver),
  //   2. else opts.resolveStt() on the first /transcribe (the bootstrap's ensureSttReady,
  //      memoized; carries plan.threads to dodge whisper's `-t 4` trap).
  let plan: SttPlan | null = null;
  let planErr = "";
  let planInFlight: Promise<SttPlan | null> | null = null;
  try {
    const paths = resolveWhisperPaths(opts.whisper);
    await assertWhisperReady(paths);
    plan = { bin: paths.bin, model: paths.model, threads, mode: "local" };
  } catch (e) {
    planErr = e instanceof Error ? e.message : String(e);
  }

  /** Current STT plan, awaiting the resolver once if nothing was found eagerly. */
  const ensurePlan = (): Promise<SttPlan | null> => {
    if (plan) return Promise.resolve(plan);
    if (!opts.resolveStt) return Promise.resolve(null); // caller surfaces planErr
    if (!planInFlight) {
      planInFlight = opts
        .resolveStt()
        .then((p) => {
          plan = p;
          planErr = "";
          return p;
        })
        .catch((e) => {
          planErr = e instanceof Error ? e.message : String(e);
          planInFlight = null; // let a later /transcribe retry
          return null;
        });
    }
    return planInFlight;
  };

  // Agent ↔ popup bus. A single in-flight agent long-poll; popup events resolve
  // it with a terminal status. If the popup answers before the agent re-polls,
  // the outcome is queued and delivered on the next GET /agent/poll.
  let pending: ServerResponse | null = null;
  let queued: AgentOutcome | null = null;
  // Last full round (has draftXml) — replayed to a popup that (re)connects, so a
  // dropped SSE or a fresh tab doesn't lose the state published while it was away.
  // Notice-only rounds (e.g. a confirm rejection) are broadcast but not replayed.
  let currentRound: unknown = null;
  const publishRound = (round: unknown) => {
    if (round && typeof round === "object" && "draftXml" in round) currentRound = round;
    hub.broadcast("round", round);
  };
  let lastActivity = Date.now();
  const touch = () => {
    lastActivity = Date.now();
  };
  // Draft mode the popup selected: "max" = full proposal blend (default),
  // "simple" = faithful structuring of the user's own words only. Captured at
  // /transcribe time into the transcript record, where the agent reads it.
  let draftMode: "simple" | "max" = "max";

  const resolveAgent = (outcome: AgentOutcome) => {
    if (pending) {
      sendJson(pending, 200, outcome);
      pending = null;
    } else {
      queued = outcome;
    }
  };

  // Popup liveness = SSE connection. When clients drop to 0, wait out a
  // reconnect grace (tab discard / network blip) before declaring popup_closed.
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  hub.onChange = () => {
    if (hub.size > 0) {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      touch();
      return;
    }
    if (graceTimer) return;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (hub.size === 0 && pending) resolveAgent({ status: "popup_closed" });
    }, GRACE_MS);
    graceTimer.unref();
  };

  const handlers: Record<string, RouteHandler> = {
    // fragment token (sent here as Bearer) → SameSite=Strict cookie so the
    // EventSource (which can't set headers) and later POSTs authenticate by cookie.
    "POST /session": (_req, res, ctx) => {
      touch();
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": 2,
        "set-cookie": `stp_token=${ctx.token}; Path=/; SameSite=Strict; HttpOnly`,
      });
      res.end("{}");
    },

    // server → popup push channel.
    "GET /events": (_req, res) => {
      hub.attach(res);
      hub.broadcast("ready", { whisper: plan ? "ready" : "absent", stage: "capture" });
      if (currentRound) hub.send(res, "round", currentRound);
    },

    // popup → helper: audio in, transcript out. Also appended to transcript.jsonl
    // (a transcript log other tooling can read out of band).
    "POST /transcribe": async (req, res) => {
      touch();
      const p = await ensurePlan();
      if (!p) {
        sendJson(res, 503, { error: planErr || "whisper not configured" });
        return;
      }
      if (p.mode === "byok") {
        sendJson(res, 503, { error: "BYOK cloud STT is not wired yet" });
        return;
      }
      const wav = await readBody(req);
      const tmp = join(tmpdir(), `stp-${Date.now()}-${randomBytes(4).toString("hex")}.wav`);
      await writeFile(tmp, wav);
      try {
        // plan.threads beats the env default — avoids whisper's `-t 4` default
        // (barely real-time even on a fast CPU).
        const result = await transcribe({
          bin: p.bin,
          model: p.model,
          wavPath: tmp,
          language,
          threads: p.threads ?? threads,
          // Stream whisper's progress to the popup so it can show a bar while a
          // (possibly long) recording transcribes.
          onProgress: (pct) => hub.broadcast("transcribe-progress", { pct }),
        });
        await appendFile(
          transcriptFile,
          JSON.stringify({ at: new Date().toISOString(), bytes: wav.length, mode: draftMode, ...result }) + "\n",
        );
        hub.broadcast("transcript", { text: result.text, language: result.language });
        sendJson(res, 200, { ...result, bytes: wav.length, mode: draftMode });
      } finally {
        await unlink(tmp).catch(() => {});
      }
    },

    // agent → popup: publish a new grill round (the agent supplies the content).
    "POST /agent/round": async (req, res) => {
      touch();
      const round = await readJson(req);
      publishRound(round);
      sendJson(res, 200, { ok: true, clients: hub.size });
    },

    // agent ← helper: long-poll held until a terminal popup event. The agent's
    // own curl --max-time bounds a single call; it re-polls until answered.
    "GET /agent/poll": (req, res) => {
      touch();
      if (queued) {
        const out = queued;
        queued = null;
        sendJson(res, 200, out);
        return;
      }
      // One in-flight poll: replace any stale holder (the old curl already timed out).
      if (pending) {
        sendJson(pending, 200, { status: "superseded" });
        pending = null;
      }
      pending = res;
      req.on("close", () => {
        if (pending === res) pending = null;
      });
    },

    // popup → agent terminal events (resolve the held long-poll).
    // popup → helper: pick the draft mode (before Stop; read at /transcribe time).
    "POST /mode": async (req, res) => {
      touch();
      const body = (await readJson(req)) as { mode?: unknown };
      if (body.mode !== "simple" && body.mode !== "max") {
        sendJson(res, 400, { error: 'mode must be "simple" or "max"' });
        return;
      }
      draftMode = body.mode;
      sendJson(res, 200, { ok: true, mode: draftMode });
    },

    "POST /answer": async (req, res) => {
      touch();
      const body = await readJson(req);
      resolveAgent({ status: "answered", ...body });
      sendJson(res, 200, { ok: true });
    },
    "POST /confirm": async (req, res) => {
      touch();
      const body = await readJson(req);
      resolveAgent({ status: "confirmed", ...body });
      sendJson(res, 200, { ok: true });
    },
    "POST /cancel": (_req, res) => {
      touch();
      resolveAgent({ status: "cancelled" });
      sendJson(res, 200, { ok: true });
    },

    // popup edited the draft in place — non-terminal, just echoed for any observer.
    "POST /edit": async (req, res) => {
      touch();
      const body = await readJson(req);
      hub.broadcast("edit", body);
      sendJson(res, 200, { ok: true });
    },
  };

  const server = await startServer({
    webDir: opts.webDir,
    port: opts.port,
    token: opts.token,
    handlers,
  });

  // SSE keep-alive.
  const ka = setInterval(() => hub.ping(), KEEPALIVE_MS);
  ka.unref();

  // Idle self-shutdown: only when the popup is closed AND the agent isn't
  // polling — i.e. the session is genuinely abandoned. Reclaims port + token.
  let closing = false;
  const idle = setInterval(() => {
    if (closing) return;
    if (hub.size === 0 && !pending && Date.now() - lastActivity > idleMs) {
      void shutdown(true);
    }
  }, IDLE_CHECK_MS);
  idle.unref();

  const shutdown = async (fromIdle: boolean): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(ka);
    clearInterval(idle);
    if (graceTimer) clearTimeout(graceTimer);
    hub.closeAll();
    await server.close().catch(() => {});
    if (fromIdle && exitOnIdle) process.exit(0);
  };

  return {
    port: server.port,
    token: server.token,
    url: server.url,
    hub,
    pushRound: publishRound,
    close: () => shutdown(false),
  };
}
