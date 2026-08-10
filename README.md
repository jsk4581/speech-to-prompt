# Speech-To-Prompt (STP)

> Compile rough spoken developer intent into **one structured XML coding-agent prompt**.
> **Speech → Prompt**, not just Speech → Text.

**Status: 🚧 Pre-release.** Direct install works today (see below); Linux is
verified end-to-end, macOS/Windows validation and a marketplace listing are in
progress.

STP is a [Claude Code](https://claude.com/claude-code) plugin that captures your
voice, transcribes it locally (Whisper), and runs a repo-grounded "grill" loop
to produce a single, confirmed, structured XML prompt for your coding agent —
instead of pasting raw, rambling dictation.

## Why

- **Thinking out loud** is faster and more intuitive than typing.
- **Raw transcription isn't usable** — speech carries filler and unstructured phrasing.
- **Refining inside your agent session wastes context** — so STP refines outside it
  and injects only the final, confirmed prompt.
- **Claude prefers structured (XML) input** — so STP turns voice straight into XML.

## Principles

- **Local-first & zero-infra** — local Whisper STT; your existing Claude Code
  session is the brain. No accounts, no servers, **zero telemetry**. Optional BYOK
  (Anthropic / OpenAI / ElevenLabs) for those who want it.
- **Voice-first, always editable** — a local web popup captures speech and lets
  you review/edit/confirm before anything is injected.
- **Cross-platform & vendor-neutral.**
- **MIT, free forever** — a hobby project.

## Install

Inside Claude Code:

```
/plugin marketplace add kio-vibe/speech-to-prompt
/plugin install stp@kio-vibe
```

(or from a terminal: `claude plugin marketplace add kio-vibe/speech-to-prompt`
then `claude plugin install stp@kio-vibe`.)

**Requirements:** [Claude Code](https://claude.com/claude-code) and Node.js ≥ 18
(with npm).

Then run `/stp:voice` in any session. The first run builds the small local
helper and downloads a Whisper model (~75 MB–0.9 GB depending on the recommended
tier for your machine) — after that, everything is local and offline-capable.

## Use

1. `/stp:voice` — a local popup opens (127.0.0.1 only, per-run token).
2. Hit record and talk through what you want built (any length; stop when done).
3. STP transcribes locally, drafts a structured XML task grounded in your repo,
   and asks the few questions that are expensive to get wrong. Answer or edit
   inline; proposed guesses are visually marked.
4. Confirm — exactly one validated XML prompt is injected into your session.

## License

MIT.
