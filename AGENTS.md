# AGENTS.md - speech-to-prompt

## Project Goal

STP turns rough spoken developer intent into one confirmed, structured XML coding
prompt for coding agents. Do not treat this as a generic dictation app.

## Current State

This repository is in P0 scaffold/spike state. The Claude Code plugin manifests,
skill notes, hook stub, and TypeScript helper skeleton exist, but the helper,
popup, Whisper transcription, grill loop, and confirmed XML handoff are not yet
implemented.

## Product Surface

The primary beachhead is a Claude Code plugin. Keep the compiler core
surface-independent, but do not implement Cursor, Codex, or other agent
integrations yet.

## Hard Constraints

- Keep it simple: Node/TypeScript for the helper and popup.
- Local-first, zero telemetry.
- Do not commit model weights, API keys, private harness files, or `CLAUDE.md`.
- Do not port v1 code. Reimplement cleanly.
- Preserve the no-pollution intent: raw transcript and draft XML should not enter
  the main coding-agent session.
- In default in-session mode, compressed Q&A plus the final XML may remain in the
  session. Strict final-XML-only mode is a later BYOK feature.

## Before Coding

- Read `README.md`, `docs/README.md`, `.claude-plugin/plugin.json`,
  `hooks/hooks.json`, and `helper/package.json`.
- Prefer small, reviewable changes.
- When architecture is unclear, write a short plan before editing.

## Validation

Run the relevant checks after edits:

- JSON validation for `.claude-plugin/*.json`, `hooks/hooks.json`, and helper
  config JSON.
- `npm --prefix helper run build -- --noEmit`
- `claude plugin validate .` when Claude Code is available.
- Add tests when behavior changes.

## Do Not Implement Yet Unless Explicitly Requested

- Full Whisper model download flow.
- BYOK provider storage.
- Full grill loop.
- Cursor/Codex product integration.
- Cross-platform packaging.
