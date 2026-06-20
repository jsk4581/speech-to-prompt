# Speech-To-Prompt (STP)

> Compile rough spoken developer intent into **one structured XML coding-agent prompt**.
> **Speech → Prompt**, not just Speech → Text.

**Status: P0 scaffold/spike — pre-release rewrite. Not yet installable.**

STP is planned as a [Claude Code](https://claude.com/claude-code) plugin that
captures your voice, transcribes it locally (Whisper), and runs a repo-grounded
"grill" loop to produce a single, confirmed, structured XML prompt for your
coding agent — instead of pasting raw, rambling dictation.

The current repository is only the public scaffold: plugin manifests, a WIP
skill, an inert startup hook, documentation placeholders, and a TypeScript helper
skeleton. It does not yet capture audio, run Whisper, open the popup, perform the
grill loop, or hand off confirmed XML.

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

## P0 Validation

Install is not available yet. The next milestone is proving the scaffold with
small P0 checks: plugin validation/install, helper launch, popup open, manual
transcript editing, and confirmed XML handoff. See `docs/P0_SPIKES.md`.

## License

MIT.
