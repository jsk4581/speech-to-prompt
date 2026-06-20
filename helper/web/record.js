// STP popup — microphone capture → 16 kHz mono 16-bit PCM WAV, no ffmpeg.
//
// Why this shape:
//   - Browser getUserMedia owns the OS mic prompt, sidestepping the macOS
//     terminal-TCC trap that silently fails for terminal-launched processes.
//   - whisper.cpp wants 16 kHz mono PCM. Rather than ship ffmpeg, we record with
//     MediaRecorder, then decode + resample + encode entirely via the Web Audio
//     API. The browser already knows how to decode its own codec (webm/opus,
//     ogg/opus, or mp4/aac), so no native audio tooling is required.
//
// ES module. The View (index.html / app.js) imports Recorder; the spike page
// (spike.html) uses it directly.

export const TARGET_SAMPLE_RATE = 16000;

/** Pick a MediaRecorder mime type the current browser actually supports. */
function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return ""; // let the browser choose its default
}

/**
 * Push-to-talk style recorder. `start()` opens the mic; `stop()` resolves to a
 * `{ blob, durationMs }` where blob is an `audio/wav` (16 kHz mono).
 */
export class Recorder {
  constructor() {
    this._stream = null;
    this._recorder = null;
    this._chunks = [];
    this._startedAt = 0;
  }

  get recording() {
    return this._recorder?.state === "recording";
  }

  async start() {
    if (this.recording) return;
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this._chunks = [];
    const mimeType = pickMimeType();
    this._recorder = new MediaRecorder(this._stream, mimeType ? { mimeType } : undefined);
    this._recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };
    this._startedAt = performance.now();
    this._recorder.start();
  }

  /** Stop recording and return the encoded 16 kHz mono WAV. */
  async stop() {
    if (!this._recorder) throw new Error("not recording");
    const recorder = this._recorder;
    const blob = await new Promise((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(this._chunks, { type: recorder.mimeType || "audio/webm" }));
      recorder.stop();
    });
    const durationMs = performance.now() - this._startedAt;
    for (const track of this._stream.getTracks()) track.stop();
    this._stream = null;
    this._recorder = null;

    const wav = await encodeBlobToWav16kMono(blob);
    return { blob: wav, durationMs };
  }
}

/** Decode any recorded audio Blob → 16 kHz mono → WAV Blob. */
export async function encodeBlobToWav16kMono(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const decodeCtx = new AudioCtx();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    decodeCtx.close();
  }
  const mono = downmixToMono(decoded);
  const resampled = await resampleTo(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
  return encodeWav(resampled, TARGET_SAMPLE_RATE);
}

/** Average all channels into a single Float32 track. */
function downmixToMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  if (channels === 1) return audioBuffer.getChannelData(0);
  const length = audioBuffer.length;
  const out = new Float32Array(length);
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] += data[i] / channels;
  }
  return out;
}

/** Resample a Float32 mono track using an OfflineAudioContext (no ffmpeg). */
async function resampleTo(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const frameCount = Math.max(1, Math.ceil((samples.length * toRate) / fromRate));
  const offline = new OfflineAudioContext(1, frameCount, toRate);
  const buffer = offline.createBuffer(1, samples.length, fromRate);
  buffer.copyToChannel(samples, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** Encode a Float32 mono signal as a 16-bit PCM WAV Blob. */
export function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
