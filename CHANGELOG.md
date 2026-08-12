# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] — 2026-08-12

macOS-validation hardening: everything from the first external QA round
(issues #3–#10, PRs #2/#11 by @sjh9714 — thank you).

### Added
- **Voice-activity detection** (#7): the bootstrap now also fetches the small
  (~1 MB) silero VAD model and whisper runs with `--vad`, which stops the
  quiet tail after speech from hallucinating a sentence nobody spoke. If the
  installed whisper binary predates `--vad`, transcription retries without it.
  `STP_VAD=0` opts out; `STP_VAD_MODEL` points at your own copy.
- **Transcription language selector** (#3): a footer picker (auto · 한국어 ·
  English) pins whisper's per-recording language when auto-detect drops a
  passage of a mixed-language recording; `STP_LANG` sets the launch default.
- `STP_KEEP_AUDIO=1` keeps each capture in the run directory for diagnosis
  (PR #2); a `qa-macos/` reproduction set (fixtures + bench) is checked in
  (PR #11).

### Fixed
- **Unanswered grill questions can no longer leak into the injected prompt**
  (#6): confirm always proceeds, and question-slot phrasing that survived into
  the confirmed XML is stripped mechanically at finalize time — an unanswered
  question is discarded, never injected as instructions. Hand-edited slots are
  kept (user edits are law).
- **The popup's sample content can no longer be confirmed as a real prompt**
  (#8): samples are cleared at boot and Confirm stays disabled until the agent
  publishes a real round.
- **The prewarmed mic is released after ~30 s without a Record press** (#9):
  the popup no longer holds the microphone (and the OS recording indicator)
  for as long as it sits open; the next press just reacquires.
- **A machine with no speech engine now says so before you record** (#4): the
  popup disables Record and shows the actionable fix (macOS:
  `brew install whisper-cpp`) instead of failing after Stop with everything
  already said. macOS launcher port-takeover fixed for BSD tools (PR #2).
- **Docs match reality on macOS** (#5): README requires brew there, the
  Gatekeeper note is gone, BYOK is described as planned (README · skill ·
  SessionStart hook), and architecture.md's dependency count is corrected.
- Small cleanups (#10): thread recommendation no longer assumes SMT on arm64
  (Apple Silicon), model-download progress events are throttled to whole
  percents, and a malformed draft.json now reports which section/segment is
  broken instead of a bare TypeError.

## [0.2.10] — 2026-08-11

### Added
- Live drafts in the XML pane now render with syntax colors — tags, attributes,
  strings, and comments use the same editor palette as the static sample, in
  every path that repaints the pane (rounds, tab switches, agent edits, the
  post-record placeholder). The pane stays plain editable text underneath;
  hand edits simply grow uncolored until the next round repaints.

## [0.2.9] — 2026-08-11

### Changed
- Answering questions is now purely local: selecting a chip or typing an
  answer triggers nothing on its own (0.2.8's auto-send with debounce is
  gone). Everything happens at Confirm — the answers travel with the
  confirmed XML, the agent folds them into the final document (an answered
  implement-vs-advise sets the objective mode), and only then injects.

## [0.2.8] — 2026-08-11

### Fixed
- With Enhance and Grill both in flight, the round from the enhance redraft
  no longer kills the still-running "grilling…" spinner: every round now
  carries the settings it was drafted under, and the questions pane clears
  only when a round drafted with the current grill setting arrives.
- Grill never depends on enhance: flipping Grill on in default mode runs the
  question pass on the default draft alone.

### Added
- Confirm feedback above the buttons, like Cancel's: "Confirm sent —
  validating…" on press, then "Confirmed ✓ — injected into the session" when
  the agent reports the injection went through (a new success notice), or the
  rejection reason if it didn't.

### Changed
- Answer sending debounce widened (250ms → 800ms) so a quick chip-then-Confirm
  is less likely to trigger an extra fold round first.

## [0.2.7] — 2026-08-11

### Fixed
- Spinners now match the work actually happening: the questions-pane spinner
  runs only when grill is in play, and a mid-round settings flip spins only
  the pane that setting regenerates (Enhance → XML pane, Grill → questions
  pane) instead of both unconditionally.

### Changed
- Drafting model tiers: a plain default+grill-off pass drafts on Sonnet;
  enhance mode or an active grill drafts on Opus.
- The Default/Enhanced tabs are now a segmented control — the open tab fills
  with the accent color instead of a subtle outline.
- Cancelling shows its feedback right above the Cancel button rather than in
  the far-away header.

## [0.2.6] — 2026-08-11

### Removed
- The provenance legend ("STP proposal / what you said / needs you") above the
  XML pane. Its colors only ever existed in the static sample — live drafts
  render as plain editable XML — and the said-vs-added distinction now lives
  in the Default/Enhanced tab comparison. In-pane provenance highlighting for
  the Enhanced tab stays on the roadmap.

## [0.2.5] — 2026-08-11

### Changed
- The Enhance and Grill pill toggles now share one fixed width.
- The drafting wait covers the questions pane too: a second spinner
  ("grilling…") runs there alongside the XML one until the round arrives.

## [0.2.4] — 2026-08-11

### Added
- Enhance and Grill are now live controls: flipping a switch while a draft is
  on screen redrafts the current document with the new settings — the enhanced
  tab and the question panel appear or disappear accordingly, with the
  drafting spinner covering the wait. Before recording they still simply set
  the recipe for the next draft.

## [0.2.3] — 2026-08-11

### Added
- A circular drafting indicator over the XML pane between the transcript
  landing and the drafted round arriving, so the LLM-thinking wait no longer
  looks dead.

## [0.2.2] — 2026-08-11

### Fixed
- Phantom cancels, part two: popups from versions before 0.2.1 still carry the
  pagehide cancel beacon, and those stale tabs keep firing it when closed or
  discarded. The helper now ignores any `/cancel` that is not a JSON request
  (the Cancel button's shape), which immunizes the session against every
  older tab. A popup that reconnects to a helper that superseded its own also
  marks itself stale and goes inert instead of acting on the new session.

## [0.2.1] — 2026-08-11

### Fixed
- Phantom cancels: closing (or the browser discarding, or reloading) a stale
  popup tab from a superseded run fired a pagehide `/cancel` beacon with the
  new session's origin-wide cookie, silently ending a session the user never
  cancelled. The beacon is gone — Cancel is now the button only; popup closure
  is still detected via SSE disconnect + grace.

### Changed
- The Enhance/Grill switches are now pill toggles with the label inside the
  button and a knob that slides between the off and on sides.

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
