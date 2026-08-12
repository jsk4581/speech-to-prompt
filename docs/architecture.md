# Architecture

STP compiles rough spoken intent into one structured XML task prompt. The
pipeline runs entirely on your machine; the only model calls are the ones your
existing Claude Code session already makes.

```
/stp:voice (skill)
   └─ local helper (Node) → 127.0.0.1 server + browser popup
        1) capture    : popup records mic audio via getUserMedia
        2) transcribe : whisper.cpp subprocess, local model
        3) grill      : an isolated subagent drafts a repo-grounded XML task;
                        the main agent asks you the few questions that are
                        expensive to get wrong (popup shows the whole loop)
        4) confirm    : you edit/answer/confirm in the popup
        5) inject     : exactly one validated XML prompt enters the session
```

## Components

- **`skills/voice/SKILL.md`** — the runbook the agent follows: start the
  helper, wait for the transcript, spawn the drafting subagent, drive the
  question loop, inject the confirmed XML.
- **`helper/`** (Node/TypeScript, zero runtime dependencies — Node std lib only):
  - `server.ts` — the 127.0.0.1 HTTP server: popup assets, SSE events to the
    popup, long-poll bridge to the agent, auth.
  - `audio.ts` / `spike-whisper.ts` — WebM → 16 kHz mono WAV, whisper.cpp
    subprocess invocation.
  - `bootstrap.ts` — first-run setup: downloads a prebuilt whisper.cpp binary
    and a recommended model tier for the machine (override with
    `STP_STT_TIER=base|small|turbo`), streams progress to the popup.
  - `xml.ts` — the XML task schema, generator, and tolerant parser.
  - `grill.ts` — CLI bridge the agent calls to post question rounds and poll
    outcomes.
  - `inject.ts` — the final gate: re-validates the confirmed XML and prints it
    to stdout only if it passes; otherwise exits non-zero and nothing is
    injected.
- **`helper/web/`** — the popup (vanilla HTML/CSS/JS). It is a *view*: state
  lives in the helper; the popup renders rounds and posts answers.
- **`hooks/ensure-model.sh`** — SessionStart probe. Prints a one-line heads-up
  if no model is installed yet; never downloads anything itself.

## Security & privacy model

- The helper binds **127.0.0.1 only** and every request must present a
  **per-run random token** (first delivered via URL fragment, then held in a
  `SameSite=Strict` cookie). `Host`/`Origin` headers are validated.
- The popup is the only client; the helper self-terminates after idling
  (`STP_IDLE_MS`, default 10 min).
- Captured audio does not outlive the transcription request. `STP_KEEP_AUDIO=1`
  opts into keeping each WAV in the run directory instead — the only way to
  investigate a transcript that came out wrong, and off by default.
- **Zero telemetry.** No accounts, no external services in the default mode.
  Audio, transcripts, and drafts stay in a per-run temp directory.
- Downloads (whisper.cpp binary, models) come from upstream release sources on
  first use only, into the plugin data directory (`~/.stp` fallback).

## Why a browser popup (not a native app or terminal UI)

- `getUserMedia` gives cross-platform mic capture with the browser's own
  permission prompt — avoiding per-terminal mic permission traps (e.g. macOS
  TCC inheriting the terminal's identity).
- Reviewing/editing a structured draft with highlighted proposals needs richer
  UI than a terminal; a local page needs no packaging, code signing, or
  auto-update infrastructure.
