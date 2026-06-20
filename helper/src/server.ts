// STP local helper — localhost HTTP server.
//
// Responsibilities:
//   - Bind to 127.0.0.1 ONLY (never 0.0.0.0) so no remote process can reach it.
//   - Mint a per-launch session token; sensitive routes require it, so another
//     local process can't drive the helper.
//   - Serve the popup (helper/web) static files (the View).
//   - Expose a small extension point (`handlers`) so other features can register
//     routes (audio capture, prompt drafting, handoff) without rewriting this file.
//
// No third-party runtime dependencies: Node's http/fs/crypto only.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { randomBytes } from "node:crypto";

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

/** JSON response helper. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function serveStatic(res: ServerResponse, webDir: string, pathname: string): Promise<void> {
  // Map "/" -> the popup page; default to spike.html when present, else index.html.
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

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const routeKey = `${req.method} ${url.pathname}`;
        const handler = handlers[routeKey];

        if (handler) {
          // Sensitive routes require the session token (query ?t= or header).
          const presented = url.searchParams.get("t") ?? req.headers["x-stp-token"];
          if (presented !== token) {
            sendJson(res, 403, { error: "bad or missing session token" });
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
