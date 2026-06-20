// STP local helper — whisper.cpp subprocess wrapper + binary/model resolution.
//
// The browser captures audio and the recorder (helper/web/record.js) hands us a
// 16 kHz mono 16-bit PCM WAV — exactly what whisper.cpp wants — so we never shell
// out to ffmpeg. This module just runs the `whisper-cli` binary on a WAV file and
// returns the transcribed text.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

/** WAV format whisper.cpp expects (and what record.js produces). */
export const WHISPER_SAMPLE_RATE = 16000;
export const WHISPER_CHANNELS = 1;

export interface WhisperPaths {
  /** Path to the `whisper-cli` executable. */
  bin: string;
  /** Path to a GGML model (.bin). */
  model: string;
}

export interface TranscribeOptions extends WhisperPaths {
  /** Path to a 16 kHz mono WAV file. */
  wavPath: string;
  /** BCP-47-ish whisper language code, or "auto" (default) to detect. */
  language?: string;
  /** Worker threads; defaults to whisper.cpp's own default. */
  threads?: number;
}

export interface TranscribeResult {
  text: string;
  /** Wall-clock transcription time in milliseconds. */
  elapsedMs: number;
  /** Language whisper reported (best-effort; empty when not parsed). */
  language: string;
}

/**
 * Resolve the whisper binary + model from explicit args or environment.
 * Precedence: explicit arg → env (STP_WHISPER_BIN / STP_WHISPER_MODEL).
 * The first-run model bootstrap is what populates these under CLAUDE_PLUGIN_DATA;
 * during local verification they're set by hand / env.
 */
export function resolveWhisperPaths(overrides: Partial<WhisperPaths> = {}): WhisperPaths {
  const bin = overrides.bin ?? process.env.STP_WHISPER_BIN;
  const model = overrides.model ?? process.env.STP_WHISPER_MODEL;
  if (!bin) throw new Error("whisper binary not set (pass bin or STP_WHISPER_BIN)");
  if (!model) throw new Error("whisper model not set (pass model or STP_WHISPER_MODEL)");
  return { bin, model };
}

/** Throw a clear error if the binary or model file is missing/unreadable. */
export async function assertWhisperReady(paths: WhisperPaths): Promise<void> {
  await access(paths.bin, constants.X_OK).catch(() => {
    throw new Error(`whisper binary not executable: ${paths.bin}`);
  });
  await access(paths.model, constants.R_OK).catch(() => {
    throw new Error(`whisper model not readable: ${paths.model}`);
  });
}

/**
 * Transcribe a 16 kHz mono WAV via whisper.cpp.
 *
 * Uses `-nt` (no timestamps) so plain transcript text lands on stdout; whisper's
 * own progress/log noise goes to stderr and is captured for diagnostics.
 */
export function transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
  const args = [
    "-m", opts.model,
    "-f", opts.wavPath,
    "-l", opts.language ?? "auto",
    "-nt", // no timestamps → clean text on stdout
  ];
  if (opts.threads) args.push("-t", String(opts.threads));

  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(opts.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      reject(new Error(`failed to spawn whisper (${opts.bin}): ${e.message}`)),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`whisper exited ${code}: ${err.trim().slice(-500)}`));
        return;
      }
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      const langMatch = err.match(/auto-detected language:\s*([a-z]{2,3})/i);
      resolve({
        text: out.trim(),
        elapsedMs,
        language: langMatch?.[1] ?? "",
      });
    });
  });
}
