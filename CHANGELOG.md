# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-08-10

Initial pre-release.

### Added
- `/stp:voice` — voice capture via a local web popup (127.0.0.1 only,
  per-run token auth), local whisper.cpp transcription, a repo-grounded
  clarifying-question ("grill") loop, and injection of exactly one confirmed,
  validated XML task prompt into the session.
- First-run bootstrap: downloads a prebuilt whisper.cpp binary and a
  recommended Whisper model tier for the machine (override with
  `STP_STT_TIER=base|small|turbo`); progress is streamed to the popup.
- Popup UX: live transcription progress, answered-question dimming,
  confirm-rejection notices, session recovery on reload.
- Cross-platform CI (Linux/macOS/Windows × Node 18/22).
