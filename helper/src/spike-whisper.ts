// STP audio spike — headless whisper.cpp check (no browser).
//
// Transcribes a WAV file straight through the audio.ts wrapper, so the
// transcription half of the pipeline can be verified without a microphone.
//
// Usage:
//   STP_WHISPER_BIN=/path/to/whisper-cli \
//   STP_WHISPER_MODEL=/path/to/ggml-large-v3-turbo-q5_0.bin \
//   node dist/spike-whisper.js <audio.wav> [language]

import { resolveWhisperPaths, assertWhisperReady, transcribe } from "./audio.js";

const wavPath = process.argv[2];
if (!wavPath) {
  console.error("usage: node spike-whisper.js <audio.wav> [language]");
  process.exit(1);
}
const language = process.argv[3] ?? "auto";

const paths = resolveWhisperPaths();
await assertWhisperReady(paths);
const threads = Number(process.env.STP_THREADS) || undefined;
const result = await transcribe({ ...paths, wavPath, language, threads });

console.error(
  `[spike] ${result.elapsedMs.toFixed(0)}ms` +
    (result.language ? ` lang=${result.language}` : ""),
);
console.log(result.text);
