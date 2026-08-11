# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] — 2026-08-11

### Changed
- Drafting philosophy reform: XML sections are organizers for what you said,
  not required form fields. A section you gave no material for simply does not
  exist — no invented references, steps, guardrails, or success criteria.
  The confirm gate follows suit: it now rejects only real invariant
  violations (all-caps emphasis, open question slots, an invalid stated
  objective mode) and accepts any faithful document, however small.
- Draft modes renamed and redefined: **Default** (was Simple) is the faithful
  structuring pass and the new default; **Enhance** (was Max) additionally
  produces a restrained repo-refined variant instead of a free-authoring one.
  Grill now defaults to **off**.
- Footer toggles are now sliding on/off switches (Enhance · Grill) instead of
  chip buttons.

### Added
- Enhance mode shows two tabs over the XML pane — the default draft and the
  enhanced variant side by side; hand edits survive tab switches, and Confirm
  injects whichever tab is open.

## [0.1.9] — 2026-08-11

### Changed
- Simple mode + grill off is now a true pure-dictation contract: STP cleans
  and structures only what you said, inventing nothing — the confirm gate
  relaxes for exactly this combination, so an unstated objective mode or
  missing success criteria no longer gets filled in (or rejected).

## [0.1.8] — 2026-08-11

### Added
- Grill on/off toggle in the footer: off means STP asks no questions at all —
  it best-guesses everything (including objective mode and success criteria)
  and the popup goes straight to review-and-confirm.

## [0.1.7] — 2026-08-11

### Changed
- All controls now live in the footer: Record and the Simple/Max draft-mode
  toggle moved down next to Confirm/Cancel, so the whole action flow reads
  left to right in one row.

## [0.1.6] — 2026-08-11

### Fixed
- Fixed-port setups (`STP_PORT`): a new `/stp:voice` now supersedes a previous
  helper still holding the port (e.g. its popup tab was left open) instead of
  failing to launch. Only processes provably running the STP helper are ever
  killed.

## [0.1.5] — 2026-08-11

### Changed
- Zero-click popup on remote-browser setups: the launch step now emits a
  `popup_public` HTTPS URL when a trusted front is configured, the agent
  opens the popup itself through a connected browser tool when one exists,
  and an opt-in `STP_OPEN_CMD` can hand the URL to any custom opener.

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
