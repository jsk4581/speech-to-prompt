---
name: voice
description: Capture spoken intent and compile it into one structured XML coding-agent prompt. Launches a local voice popup, transcribes locally with Whisper, runs a repo-grounded grill loop, then injects the single confirmed XML.
---

# /stp:voice — Speech → Prompt

> 🚧 **WIP scaffold — not yet implemented.** This documents the intended flow.

Turn rough spoken developer intent into **one confirmed, structured XML prompt**
for the coding agent — without polluting the session with raw transcription or
intermediate drafts.

## Flow

1. **Launch** the local Node helper → it starts a `127.0.0.1` server (session
   token) and opens the default browser to the popup.
2. **Capture** voice in the popup via `getUserMedia` (sidesteps the macOS
   terminal-TCC trap). Button push-to-talk; length effectively unlimited.
3. **Transcribe** locally via whisper.cpp. The raw transcript stays out of the
   session — written to a file, read only by an isolated subagent.
4. **Grill**: an isolated subagent drafts a repo-grounded XML + question
   candidates first; then the main agent (the brain) grills the user on that
   draft in the popup (proposals shown distinctly), looping back to the subagent
   to revise. The user confirms — the model never decides "done".
5. **Inject** exactly one confirmed XML into the session via `` !`bash` ``.

## Implementation status

Not yet implemented.
