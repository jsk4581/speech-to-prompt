// STP local helper — first-run bootstrap: whisper binary + model + tier select.
//
// On a clean machine the helper has no speech engine yet. This module makes one
// ready, with no build tools and no surprise account prompts:
//
//   1. Resolve where persistent files live (${CLAUDE_PLUGIN_DATA}).
//   2. Ensure a `whisper-cli` binary exists — download the OS/arch official
//      prebuilt (D6); on macOS (no prebuilt CLI) fall back to a PATH probe.
//   3. Ensure a GGML model exists — download from Hugging Face (D7), with
//      progress / resume / disk-space / redirect handling (D4).
//   4. Recommend a model tier from cheap machine signals (Mac=turbo,
//      laptop=small, weak=base). The pick stays with the user: STP_STT_TIER
//      overrides now, the popup settings will later. No auto-benching.
//   5. If no local binary is available (e.g. macOS without brew), surface BYOK
//      cloud STT as the recommended path — E only defines that branch + its
//      contract; the key storage and provider UI land later.
//
// The result feeds audio.ts via STP_WHISPER_BIN / STP_WHISPER_MODEL (the env
// contract resolveWhisperPaths() already reads), so nothing downstream changes.
//
// No third-party runtime dependencies: Node std lib only.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { argv, stderr } from "node:process";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";
import { homedir, cpus, totalmem } from "node:os";
import { join, dirname, delimiter } from "node:path";

// ───────────────────────────── contract types ──────────────────────────────

/** Local whisper model tiers, smallest → largest / best quality. */
export type Tier = "base" | "small" | "turbo";

/** STT source: a local whisper.cpp model, or a BYOK cloud provider. */
export type SttMode = "local" | "byok";

/**
 * BYOK cloud STT providers we recognize. E only *names the branch*; key storage
 * and the actual API calls are M6. Listed so the first-run UX can offer a real
 * choice instead of an opaque "configure later".
 */
export type SttProvider = "openai" | "elevenlabs";
export const BYOK_STT_PROVIDERS: SttProvider[] = ["openai", "elevenlabs"];

/**
 * The resolved speech plan. When mode==="local" the bin/model/tier/threads are
 * ready for audio.ts. When mode==="byok" the local path was skipped or judged
 * unrealistic; M6 wires the chosen provider's key + calls.
 */
export interface SttPlan {
  mode: SttMode;
  /** whisper-cli path (mode==="local"). */
  bin?: string;
  /** GGML model path (mode==="local"). */
  model?: string;
  /** Selected tier (mode==="local"). */
  tier?: Tier;
  /** Silero VAD model path when available (mode==="local"); trims non-speech. */
  vad?: string;
  /** Suggested `-t` worker count = physical-ish core count. */
  threads: number;
  /** True when local is too slow/unsupported and cloud STT is the better path. */
  byokRecommended: boolean;
  /** Providers the first-run UX may offer if the user goes BYOK. */
  byokProviders: SttProvider[];
  /** Human-readable explanation of the selection (user's language at the View). */
  reason: string;
}

/** Progress events for the download UX (D4). Rendered by the caller. */
export type BootstrapProgress =
  | { kind: "check"; message: string }
  | { kind: "download"; target: "binary" | "model"; name: string; received: number; total: number }
  | { kind: "extract"; target: "binary"; name: string }
  | { kind: "select"; mode: SttMode; tier?: Tier; reason: string }
  | { kind: "error"; message: string };

export interface EnsureOptions {
  /** Progress sink; the helper logs to stdout now, the popup via SSE later. */
  onProgress?: (p: BootstrapProgress) => void;
}

// ─────────────────────────────── catalogs ──────────────────────────────────

interface ModelSpec {
  /** GGML file name under <data>/models/. */
  file: string;
  /** Hugging Face download URL (anonymous, MIT). Follows 302 → CDN. */
  url: string;
  /** Rough size for the disk-space pre-check (bytes). */
  approxBytes: number;
}

// D7: HF repo is still `ggerganov/whisper.cpp` despite the GitHub org rename to
// `ggml-org` — hardcoding ggml-org here would 404. All multilingual (en+ko);
// `.en` variants are intentionally absent (they mangle Korean).
const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const MODELS: Record<Tier, ModelSpec> = {
  base: {
    file: "ggml-base.bin",
    url: `${HF_BASE}/ggml-base.bin`,
    approxBytes: 148 * 1024 * 1024,
  },
  small: {
    // q5_1 quant — the latency sweet spot from the laptop bench (~182 MB).
    file: "ggml-small-q5_1.bin",
    url: `${HF_BASE}/ggml-small-q5_1.bin`,
    approxBytes: 200 * 1024 * 1024,
  },
  turbo: {
    // q8_0 over q5_0: ~21% faster on CPU (int8 kernels beat q5 unpacking) with
    // identical transcripts on the Korean/English bench, for +300MB download —
    // the right trade for the machines that get the turbo tier at all.
    file: "ggml-large-v3-turbo-q8_0.bin",
    url: `${HF_BASE}/ggml-large-v3-turbo-q8_0.bin`,
    approxBytes: 875 * 1024 * 1024,
  },
};

// Silero VAD model for whisper's `--vad`: trims non-speech before decoding,
// which kills the quiet-tail hallucination (a near-empty final 30s window grows
// a sentence nobody spoke — issue #7, reproduced + benched in qa-macos/).
// Official ggml conversion; ~0.9MB, so it rides along with any tier.
const VAD_MODEL: ModelSpec = {
  file: "ggml-silero-v5.1.2.bin",
  url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
  approxBytes: 1024 * 1024,
};

// D6: OS/arch official prebuilt whisper.cpp CLI. Pinned to a verified release;
// override the tag with STP_WHISPER_RELEASE or the whole URL with
// STP_WHISPER_BIN_URL. macOS ships no prebuilt CLI → handled separately.
const DEFAULT_RELEASE = "v1.9.1";
const GH_BASE = "https://github.com/ggml-org/whisper.cpp/releases/download";

function binaryAssetName(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "win32") return arch === "ia32" ? "whisper-bin-Win32.zip" : "whisper-bin-x64.zip";
  if (platform === "linux") {
    if (arch === "x64") return "whisper-bin-ubuntu-x64.tar.gz";
    if (arch === "arm64") return "whisper-bin-ubuntu-arm64.tar.gz";
  }
  return null; // macOS, or an arch with no prebuilt — use the PATH/brew fallback.
}

function binaryUrl(asset: string): string {
  if (process.env.STP_WHISPER_BIN_URL) return process.env.STP_WHISPER_BIN_URL;
  const tag = process.env.STP_WHISPER_RELEASE ?? DEFAULT_RELEASE;
  return `${GH_BASE}/${tag}/${asset}`;
}

const WHISPER_EXE = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";

// ──────────────────────────── paths & config ───────────────────────────────

/** Persistent data root. Prefers ${CLAUDE_PLUGIN_DATA}; falls back to ~/.stp. */
export function dataDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA?.trim() || join(homedir(), ".stp");
}

const binDir = () => join(dataDir(), "bin");
const modelsDir = () => join(dataDir(), "models");
const configPath = () => join(dataDir(), "config.json");

interface StpConfig {
  version: 1;
  stt: {
    mode: SttMode;
    tier?: Tier;
    threads?: number;
  };
}

async function loadConfig(): Promise<StpConfig | null> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as StpConfig;
  } catch {
    return null;
  }
}

async function saveConfig(cfg: StpConfig): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

const exists = (p: string) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

// ──────────────────────────── machine grading ──────────────────────────────

/**
 * Physical-ish core count for whisper's `-t`. os.cpus() reports logical cores;
 * whisper scales up to about the physical core count and goes flat into SMT
 * (i9-14900KF bench: t16 7.8s → t24 6.8s → t32 6.6s on a 26s clip).
 */
export function recommendedThreads(): number {
  const logical = Math.max(1, cpus().length);
  // No SMT on arm64 (Apple Silicon and most ARM parts): logical == physical, so
  // halving would undercount (an M4 is 10/10, not 20/10). x86: hybrid Intel
  // parts have logical = physical + P-cores (only P-cores SMT), so plain
  // logical/2 undercounts them — `logical - 8` tracks physical better on big
  // parts and still leaves headroom. Cap 24: flat beyond.
  const physical =
    process.arch === "arm64"
      ? logical
      : logical >= 16 ? logical - 8 : logical >= 8 ? Math.floor(logical / 2) : logical;
  return Math.min(24, Math.max(1, physical));
}

/**
 * First-guess tier from cheap signals (no download). Apple Silicon gets turbo
 * for free (Metal); otherwise core count decides. Defaults to `small` when
 * uncertain — the benched sweet spot; the Korean-quality A/B may nudge this.
 */
export function heuristicTier(): Tier {
  if (isTier(process.env.STP_STT_TIER)) return process.env.STP_STT_TIER;
  const logical = cpus().length;
  const gibTotal = totalmem() / 1024 ** 3;
  // Apple Silicon: Metal makes turbo viable. (darwin x64 = old Intel Mac → no.)
  if (process.platform === "darwin" && process.arch === "arm64") return "turbo";
  // Desktop-class CPU → turbo; mid laptop → small; weak/low-RAM → base.
  if (logical >= 16 && gibTotal >= 16) return "turbo";
  if (logical >= 6 && gibTotal >= 8) return "small";
  return "base";
}

const isTier = (t: string | undefined): t is Tier =>
  t === "base" || t === "small" || t === "turbo";

// ───────────────────────────── downloading ─────────────────────────────────

/** Free bytes on the filesystem holding `dir` (best-effort; 0 if unknown). */
async function freeBytes(dir: string): Promise<number> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return 0;
  }
}

/**
 * Download `url` to `dest` with redirect-following, resume, and progress.
 * Streams to `dest + ".partial"` and atomically renames on completion; a
 * leftover .partial is resumed via an HTTP Range request.
 */
export async function download(
  url: string,
  dest: string,
  opts: {
    expectedBytes?: number;
    onProgress?: (received: number, total: number) => void;
    redirectsLeft?: number;
  } = {},
): Promise<void> {
  const redirectsLeft = opts.redirectsLeft ?? 6;
  const partial = dest + ".partial";

  // Disk-space pre-check (need the file + ~10% slack).
  if (opts.expectedBytes) {
    const free = await freeBytes(dirname(dest));
    if (free > 0 && free < opts.expectedBytes * 1.1) {
      throw new Error(
        `not enough disk space: need ~${mib(opts.expectedBytes)}MB, ${mib(free)}MB free`,
      );
    }
  }

  let resumeFrom = 0;
  try {
    resumeFrom = (await stat(partial)).size;
  } catch {
    /* no partial → fresh download */
  }

  await mkdir(dirname(dest), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const isHttps = url.startsWith("https:");
    const getFn = isHttps ? httpsGet : httpGet;
    const headers: Record<string, string> = { "user-agent": "stp-helper" };
    if (resumeFrom > 0) headers["range"] = `bytes=${resumeFrom}-`;

    const req = getFn(url, { headers }, (res) => {
      const status = res.statusCode ?? 0;

      // Redirect (HF → CDN) — follow it.
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error("too many redirects"));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        download(next, dest, { ...opts, redirectsLeft: redirectsLeft - 1 }).then(resolve, reject);
        return;
      }

      // 416 = our .partial is already complete (or stale) → restart clean.
      if (status === 416) {
        res.resume();
        rm(partial, { force: true })
          .then(() => download(url, dest, { ...opts, redirectsLeft }))
          .then(resolve, reject);
        return;
      }

      const resuming = status === 206;
      if (status !== 200 && !resuming) {
        res.resume();
        reject(new Error(`download failed: HTTP ${status} for ${url}`));
        return;
      }
      if (status === 200) resumeFrom = 0; // server ignored Range → overwrite.

      const len = Number(res.headers["content-length"] ?? 0);
      const total = (len || opts.expectedBytes || 0) + (resuming ? resumeFrom : 0);
      let received = resumeFrom;

      const out = createWriteStream(partial, resuming ? { flags: "a" } : { flags: "w" });
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        opts.onProgress?.(received, total);
      });
      res.pipe(out);
      out.on("error", reject);
      res.on("error", reject);
      out.on("finish", () => {
        rename(partial, dest).then(resolve, reject);
      });
    });
    req.on("error", reject);
  });
}

const mib = (b: number) => Math.round(b / (1024 * 1024));

// ───────────────────────────── extraction ──────────────────────────────────

/** Extract a .tar.gz / .zip via the system `tar` (bsdtar on win/mac, GNU on linux). */
function extract(archive: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", archive, "-C", destDir], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`tar not available: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`extract failed (${code}): ${err.trim().slice(-300)}`)),
    );
  });
}

/** Recursively find `name` under `dir`; returns the first match or null. */
async function findFile(dir: string, name: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const found = await findFile(full, name);
      if (found) return found;
    } else if (e.name === name) {
      return full;
    }
  }
  return null;
}

/** Prepend a directory to PATH (and LD_LIBRARY_PATH on Linux) so the spawned
 *  whisper-cli finds its co-bundled shared libraries without touching audio.ts. */
function exposeBinDir(dir: string): void {
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
  if (process.platform === "linux") {
    process.env.LD_LIBRARY_PATH = `${dir}${delimiter}${process.env.LD_LIBRARY_PATH ?? ""}`;
  }
}

// ──────────────────────────── ensure: binary ───────────────────────────────

/** Probe PATH for an existing whisper-cli (the macOS / brew / dev path). */
function whichWhisper(): Promise<string | null> {
  return new Promise((resolve) => {
    const finder = process.platform === "win32" ? "where" : "which";
    const child = spawn(finder, [WHISPER_EXE], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim().split(/\r?\n/)[0] : null));
  });
}

/**
 * Ensure a whisper-cli binary is available; return its path or null when the
 * platform has no prebuilt CLI and none is installed (→ caller suggests BYOK).
 */
async function ensureBinary(onProgress?: EnsureOptions["onProgress"]): Promise<string | null> {
  // 1. Explicit override (local dev / A's spike path).
  if (process.env.STP_WHISPER_BIN && (await exists(process.env.STP_WHISPER_BIN))) {
    return process.env.STP_WHISPER_BIN;
  }

  // 2. Already downloaded under data dir (archives nest under their own folder,
  //    so search recursively — checking only the top level would re-download).
  const installed = await findFile(binDir(), WHISPER_EXE);
  if (installed) {
    exposeBinDir(dirname(installed));
    return installed;
  }

  // 3. Anything on PATH (brew on macOS, system install).
  const onPath = await whichWhisper();
  if (onPath) return onPath;

  // 4. Download the OS/arch prebuilt (D6).
  const asset = binaryAssetName(process.platform, process.arch);
  if (!asset) {
    // macOS / unsupported arch: no official prebuilt CLI. Caller falls back.
    return null;
  }

  const url = binaryUrl(asset);
  await mkdir(binDir(), { recursive: true });
  const archive = join(binDir(), asset);
  onProgress?.({ kind: "download", target: "binary", name: asset, received: 0, total: 0 });
  await download(url, archive, {
    onProgress: (received, total) =>
      onProgress?.({ kind: "download", target: "binary", name: asset, received, total }),
  });

  onProgress?.({ kind: "extract", target: "binary", name: asset });
  await extract(archive, binDir());
  await rm(archive, { force: true });

  // Locate the executable inside whatever folder layout the archive used.
  const found = (await findFile(binDir(), WHISPER_EXE)) ?? (await findFile(binDir(), "main"));
  if (!found) throw new Error(`whisper-cli not found in extracted ${asset}`);
  if (process.platform !== "win32") await chmod(found, 0o755).catch(() => {});
  exposeBinDir(found.substring(0, found.lastIndexOf("/")));
  return found;
}

// ──────────────────────────── ensure: model ────────────────────────────────

async function ensureModel(tier: Tier, onProgress?: EnsureOptions["onProgress"]): Promise<string> {
  // Explicit override wins.
  if (process.env.STP_WHISPER_MODEL && (await exists(process.env.STP_WHISPER_MODEL))) {
    return process.env.STP_WHISPER_MODEL;
  }
  const spec = MODELS[tier];
  const dest = join(modelsDir(), spec.file);
  if (await exists(dest)) return dest;

  onProgress?.({ kind: "download", target: "model", name: spec.file, received: 0, total: spec.approxBytes });
  await download(spec.url, dest, {
    expectedBytes: spec.approxBytes,
    onProgress: (received, total) =>
      onProgress?.({ kind: "download", target: "model", name: spec.file, received, total }),
  });
  return dest;
}

/**
 * Ensure the silero VAD model is present. Best-effort: transcription works
 * without it (just with the quiet-tail hallucination back), so a download
 * failure degrades instead of blocking the whole bootstrap.
 * STP_VAD=0 opts out; STP_VAD_MODEL points at an existing file.
 */
async function ensureVadModel(onProgress?: EnsureOptions["onProgress"]): Promise<string | undefined> {
  if (/^(0|false|no|off)$/i.test(process.env.STP_VAD ?? "")) return undefined;
  if (process.env.STP_VAD_MODEL && (await exists(process.env.STP_VAD_MODEL))) {
    return process.env.STP_VAD_MODEL;
  }
  const dest = join(modelsDir(), VAD_MODEL.file);
  if (await exists(dest)) return dest;
  try {
    await download(VAD_MODEL.url, dest, { expectedBytes: VAD_MODEL.approxBytes });
    return dest;
  } catch {
    onProgress?.({ kind: "check", message: "VAD model download failed — continuing without it" });
    return undefined;
  }
}

// ──────────────────────────── BYOK branch ──────────────────────────────────

/** A BYOK plan — local skipped or judged unrealistic. M6 wires keys + calls. */
function byokPlan(reason: string, byokRecommended: boolean): SttPlan {
  return {
    mode: "byok",
    threads: recommendedThreads(),
    byokRecommended,
    byokProviders: BYOK_STT_PROVIDERS,
    reason,
  };
}

// ─────────────────────────────── entry ─────────────────────────────────────

let cached: Promise<SttPlan> | null = null;

/**
 * Make speech-to-text ready and return the plan. Memoized: the first call does
 * the work (download), later callers await the same result. Sets
 * STP_WHISPER_BIN / STP_WHISPER_MODEL so audio.ts picks the selection up.
 */
export function ensureSttReady(opts: EnsureOptions = {}): Promise<SttPlan> {
  if (!cached) cached = run(opts).catch((e) => {
    cached = null; // let a later call retry (e.g. after the user frees disk).
    throw e;
  });
  return cached;
}

async function run(opts: EnsureOptions): Promise<SttPlan> {
  const { onProgress } = opts;
  const threads = recommendedThreads();

  // User forced BYOK → honor it, no local work.
  if (process.env.STP_STT_MODE === "byok") {
    const plan = byokPlan("BYOK cloud STT selected (STP_STT_MODE=byok).", false);
    onProgress?.({ kind: "select", mode: "byok", reason: plan.reason });
    return plan;
  }

  onProgress?.({ kind: "check", message: "checking speech engine…" });

  // 1. Binary.
  const bin = await ensureBinary(onProgress);
  if (!bin) {
    // No prebuilt CLI and none installed (typically macOS). Point at the brew
    // bottle — the one path that works today (BYOK cloud STT is not wired yet).
    const reason =
      process.platform === "darwin"
        ? "No speech engine yet — whisper.cpp ships no prebuilt CLI for macOS. Install it with `brew install whisper-cpp`, then reopen this popup."
        : "No speech engine yet — no prebuilt whisper-cli for this platform. Install whisper.cpp manually so it is on PATH, then reopen this popup.";
    const plan = byokPlan(reason, true);
    onProgress?.({ kind: "select", mode: "byok", reason });
    return plan;
  }

  // 2. Tier: explicit override > saved choice > recommended default. The pick
  //    is the user's — STP only recommends from cheap machine signals; there is
  //    no auto-benching or silent tier switching.
  const cfg = await loadConfig();
  const envTier = process.env.STP_STT_TIER;
  const tier: Tier = isTier(envTier) ? envTier : (cfg?.stt.tier ?? heuristicTier());

  // 3. Model for the chosen tier, plus the small VAD model (best-effort).
  const model = await ensureModel(tier, onProgress);
  const vad = await ensureVadModel(onProgress);

  await saveConfig({ version: 1, stt: { mode: "local", tier, threads } });

  // Publish to the env contract audio.ts reads.
  process.env.STP_WHISPER_BIN = bin;
  process.env.STP_WHISPER_MODEL = model;

  const via = isTier(envTier)
    ? "user-selected"
    : cfg?.stt.tier
      ? "saved choice"
      : "recommended for this machine";
  const reason = `Local whisper '${tier}' (${via}, -t ${threads}).`;
  onProgress?.({ kind: "select", mode: "local", tier, reason });

  return {
    mode: "local",
    bin,
    model,
    tier,
    ...(vad ? { vad } : {}),
    threads,
    byokRecommended: false,
    byokProviders: BYOK_STT_PROVIDERS,
    reason,
  };
}

// ─────────────────────────── fast status probe ─────────────────────────────

/**
 * Cheap, no-download status — for the SessionStart hook and a future
 * `bootstrap --check`. Reports whether a model is already present so the hook
 * can give a one-line first-run heads-up without blocking the session.
 */
export async function probe(): Promise<{
  dataDir: string;
  hasModel: boolean;
  hasBinary: boolean;
  tier: Tier;
}> {
  const models = await readdir(modelsDir()).catch(() => [] as string[]);
  const hasModel =
    models.some((f) => f.startsWith("ggml-") && f.endsWith(".bin")) ||
    !!process.env.STP_WHISPER_MODEL;
  const hasBinary =
    (await exists(join(binDir(), WHISPER_EXE))) ||
    (!!process.env.STP_WHISPER_BIN && (await exists(process.env.STP_WHISPER_BIN))) ||
    !!(await whichWhisper());
  return { dataDir: dataDir(), hasModel, hasBinary, tier: heuristicTier() };
}

// ───────────────────────────────── CLI ─────────────────────────────────────
// `node dist/bootstrap.js --check`  → fast status (no download), for testing.
// `node dist/bootstrap.js`          → full bootstrap, progress on stderr.

function renderProgress(p: BootstrapProgress): void {
  if (p.kind === "download") {
    const pct = p.total ? `${Math.floor((p.received / p.total) * 100)}%` : `${mib(p.received)}MB`;
    stderr.write(`\r[stp] ${p.target} ${p.name} ${pct}        `);
    if (p.total && p.received >= p.total) stderr.write("\n");
  } else if (p.kind === "select") {
    stderr.write(`\n[stp] ${p.reason}\n`);
  } else {
    stderr.write(`[stp] ${p.kind}${"message" in p ? `: ${p.message}` : ""}${"tier" in p && p.tier ? ` (${p.tier})` : ""}\n`);
  }
}

if (fileURLToPath(import.meta.url) === argv[1]) {
  if (argv.includes("--check")) {
    probe().then((s) => {
      console.log(JSON.stringify(s, null, 2));
    });
  } else {
    ensureSttReady({ onProgress: renderProgress }).then(
      (plan) => console.log(JSON.stringify(plan, null, 2)),
      (e) => {
        stderr.write(`\n[stp] bootstrap failed: ${e instanceof Error ? e.message : e}\n`);
        process.exit(1);
      },
    );
  }
}
