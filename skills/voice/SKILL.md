---
name: voice
description: Capture spoken intent and compile it into one structured XML coding-agent prompt. Launches a local voice popup, transcribes locally with Whisper, runs a repo-grounded grill loop, then injects the single confirmed XML.
allowed-tools: Bash(bash "${CLAUDE_SKILL_DIR}/launch.sh")
---

# /stp:voice — Speech → Prompt

Turn rough spoken developer intent into **one confirmed, structured XML prompt**
for the coding agent — without polluting the session with raw transcription or
intermediate drafts.

The popup is the surface the user works in; this session is the brain that drafts
(in an isolated subagent), relays questions, and injects the final prompt. Keep
raw speech-to-text and draft XML **in files**, never pasted into this
conversation — only the compact question/answer exchange and the one confirmed
XML belong here.

## Helper launch (already done)

The helper was started the instant this skill was invoked — before you read
this — by the preprocessed command below. Its output follows it:

!`bash "${CLAUDE_SKILL_DIR}/launch.sh"`

Those lines give you the run directory (`run_dir=<RUN>`), the `STP_READY
port=<P> token=<T>` line, and the popup URL — when a `popup_public=` line is
present, that HTTPS URL is the one remote browsers can reach; prefer it.
**Skip runbook step 1** and use these values everywhere `<RUN>`, `<P>`, `<T>`
appear.

Get the popup in front of the user with zero clicks: if a browser-automation
tool attached to the user's own browser is connected (e.g. Claude in Chrome),
**open the popup URL in a new tab yourself, immediately — before saying
anything else**. Only when no such tool is available, share the URL and ask
them to open it. Either way tell the user: press **Record**, speak, press
**Stop** — then go wait for the transcript.

Fall back to runbook step 1 only if the block above shows `STP_LAUNCH_ERROR`
or shows the raw command text instead of its output (preprocessing didn't
run).

## What gets run

The helper is a local Node process under `${CLAUDE_PLUGIN_ROOT}/helper/dist/`.
Build it once if `dist/` is missing: `cd "${CLAUDE_PLUGIN_ROOT}/helper" && npm install && npm run build`.

Three small entry points drive the loop:

- `index.js` — the helper server (popup + transport). Prints `STP_READY port=<P> token=<T>` on its first stdout line.
- `grill.js` — the bridge this session calls to wait for a recording, publish a grill round to the popup, and long-poll for the user's response.
- `inject.js` — the final gate that prints the validated XML to inject.

`grill.js` and `inject.js` reach the helper over loopback using `STP_PORT` /
`STP_TOKEN` (from the `STP_READY` line) and read/write scratch files under the
run directory (`STP_TRANSCRIPT_DIR`). Pass those three values on every call —
shell state does not persist between commands.

## Runbook

### 1. Launch the helper (fallback — normally already done above)

Pick a fresh run directory, then start the helper **in the background** and read
its first stdout line for the port and token:

```bash
mktemp -d "${TMPDIR:-/tmp}/stp-voice.XXXXXX"     # → note this path as RUN
```
```bash
# background; STP_TRANSCRIPT_DIR pins the run dir so grill.js agrees with it
STP_TRANSCRIPT_DIR=<RUN> node "${CLAUDE_PLUGIN_ROOT}/helper/dist/index.js"
```

Read the background output until the `STP_READY port=<P> token=<T>` line appears;
note `<P>` and `<T>`. The popup opens in the default browser. If it does not
open, share the URL the helper logged.

Tell the user: the popup is open — press **Record**, speak the intent, press
**Stop**.

### 2. Wait for the transcript

```bash
STP_TRANSCRIPT_DIR=<RUN> node "${CLAUDE_PLUGIN_ROOT}/helper/dist/grill.js" \
  transcript --out <RUN>/transcript.txt --wait
```

Use a generous Bash timeout (≈120s). On `{"ready":false}` the user is still
recording — run it again. On `{"ready":true}` the transcript is in
`<RUN>/transcript.txt`, and the JSON carries `mode` (`"default"` or
`"enhance"`) and `grill` (`"on"` or `"off"`) — the draft settings the user
picked in the popup; note both for step 3. Do **not** read the transcript file into this
conversation; the drafting subagent reads it directly.

### 3. Draft, in an isolated subagent

Spawn a subagent (Task tool, general-purpose) so the heavy drafting and
repo-grounding stay out of this session. **Pick the subagent's model by the
draft settings** — this applies to every drafting spawn (initial, answered,
and settings redrafts):

- mode `default` **and** grill `off` → the Sonnet model (a faithful
  structuring pass; fast and cheap is right).
- mode `enhance` **or** grill `on` → the Opus model (repo-grounded
  refinement and question judgment warrant the heavier model).

Give it this task:

> Read `${CLAUDE_PLUGIN_ROOT}/helper/prompts/grill.md` and follow it as your
> instructions. The draft mode is `<MODE>` and grill is `<GRILL>` (from step
> 2 — see grill.md "Draft mode" and "Grill"). The transcript is at
> `<RUN>/transcript.txt`; the repository root
> is the current working directory — ground the draft in real files and symbols
> (read-only). Produce the `GrillDraft` JSON exactly as `grill.md` specifies,
> **write it to `<RUN>/draft.json`**, and reply with only a one-line summary:
> the number of open questions.

The subagent returns just the summary; the draft JSON stays in the file.

### 4. Grill loop

Publish the draft as a round and wait for the user (Bash timeout 600000):

```bash
STP_PORT=<P> STP_TOKEN=<T> STP_TRANSCRIPT_DIR=<RUN> \
  node "${CLAUDE_PLUGIN_ROOT}/helper/dist/grill.js" \
  round --draft <RUN>/draft.json --final-out <RUN>/final.xml
```

The popup now shows the draft XML and the questions. In `enhance` mode the
XML pane gains two tabs — the faithful default draft and the refined variant
— and Confirm injects whichever tab the user has open. With grill off the
draft has no questions — the round is still published so the user reviews,
edits, and confirms; the flow below is unchanged. Read the one-line JSON
outcome and act on `status`:

- **`answered`** — rare: the popup normally sends answers only with Confirm
  (see the confirmed case below). If it does arrive, fold like the settings
  case: the subagent reads `<RUN>/draft.json`, folds the answers in, rewrites
  it, and you publish the next round.
- **`settings`** — the user flipped Enhance/Grill mid-round; it carries the
  new `mode` and `grill`. Treat these as the settings from now on (replacing
  step 2's) and redraft like the answered case: the subagent reads its
  previous `<RUN>/draft.json`, keeps all content and folded answers, and
  reshapes it to the new settings — add or drop the `enhanced` variant for
  `mode`, add questions or remove them (and any question slots) for `grill` —
  rewrites `<RUN>/draft.json`, and replies with the question count. Then
  publish the next round the same way. Grill never depends on enhance: with
  mode `default`, questions run on the default draft alone — do not add an
  enhanced variant just because grill turned on. Repeated flips coalesce
  server-side, so one redraft may cover several (e.g. enhance *and* grill in
  a single `settings` outcome).
- **`confirmed` + `"ok":true`** — the user confirmed and the prompt passed the
  invariants (question-slot phrasing from unanswered questions has already
  been stripped mechanically — an unanswered question is discarded, never
  injected as instructions). When the outcome's `answers` carry any non-null
  `choice` or `text`, the user answered questions and confirmed in one
  stroke — fold before injecting: spawn the drafting subagent once more (model per step 3's
  rule) with `<RUN>/final.xml` (the confirmed document — every user edit in
  it is law), `<RUN>/draft.json` (for the question texts), and the answers.
  It rewrites `<RUN>/final.xml` with the answers reflected (e.g. an answered
  implement-vs-advise sets the objective mode; an answered scope question
  lands in the fitting section) and changes nothing the user wrote. Then go
  to step 5 with `finalOut`. With no real answers, go straight to step 5.
- **`confirmed` + `"ok":false`** — the confirmed XML is not injection-ready
  (`problem` says why, e.g. an all-caps emphasis word or an invalid
  objective mode). Tell the user plainly, then resume waiting so they can fix it in
  the popup and confirm again:
  `… grill.js poll --final-out <RUN>/final.xml`.
- **`cancelled`** or **`popup_closed`** — the user stopped or closed the popup.
  Report that the session ended; inject nothing.
- **`timeout`** — a single wait window elapsed with no response. Resume waiting
  with `… grill.js poll --final-out <RUN>/final.xml` (same timeout).

The model never decides the loop is done — only the user's **Confirm** ends it.

### 5. Inject the one confirmed XML

```bash
node "${CLAUDE_PLUGIN_ROOT}/helper/dist/inject.js" --in <RUN>/final.xml
```

Its stdout is the single, validated `<task>` document — the confirmed work order.
That is the only prompt content from this flow that enters the session. Proceed
to carry it out (or hand it to the coding agent the user intends). If `inject.js`
exits non-zero, the prompt was not ready — surface the error and do not act on a
partial prompt.

## Notes

- The first run downloads the Whisper binary and model; the popup shows
  progress. On macOS there is no prebuilt binary — the user installs one with
  `brew install whisper-cpp` (the popup says so before recording). BYOK cloud
  speech providers are planned but not wired yet.
- The helper binds `127.0.0.1` only and gates every request with a per-launch
  token, so no other local process can read the transcript or inject a prompt.
- If the popup is closed and this session stops polling, the helper shuts itself
  down and releases the port.
