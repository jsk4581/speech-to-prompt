# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.4] — 2026-08-11

### Changed
- The microphone is pre-warmed when the popup opens: the permission prompt and
  device spin-up happen up front, so the first Record press captures from the
  very first word instead of clipping it.
- Silenced the popup's favicon 404 console error.

## [0.1.3] — 2026-08-11

### Changed
- Cancel moved to the right of Confirm.
- New opt-in `STP_ALLOWED_HOSTS` (comma-separated hostnames): lets an HTTPS
  front on a private overlay network (e.g. `tailscale serve`) serve the popup
  without an SSH tunnel on headless machines. Default unchanged: loopback
  only, per-run token always required; only https origins are accepted for
  trusted fronts.

## [0.1.2] — 2026-08-11

### Added
- Draft modes: **Max** (default — STP proposes reasonable defaults alongside
  what you said) and **Simple** (a faithful structuring of your own words
  only), switchable in the popup's XML column header.
- A **Cancel** button next to Confirm.

### Changed
- The transcription wait is now visibly alive: an indeterminate sweep runs
  from the moment you press Stop until real progress percentages arrive.
- The popup's sample/mock content clears the moment you first press Record.

### Removed
- The `<role>` section — dropped from the prompt skeleton (the parser still
  tolerates it in edited XML).

## [0.1.1] — 2026-08-11

### Changed
- `/stp:voice` now launches the helper and opens the popup the instant the
  skill is invoked (inline preprocessed launch script), instead of after the
  agent works through the runbook — the popup is up before the model produces
  its first token. First-run helper build happens inside the same launch step.

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
