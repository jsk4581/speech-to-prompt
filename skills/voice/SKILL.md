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
port=<P> token=<T>` line, and the popup URL. **Skip runbook step 1** and use
these values everywhere `<RUN>`, `<P>`, `<T>` appear. Immediately tell the
user the popup is up (share the URL in case their browser didn't open it):
press **Record**, speak, press **Stop** — then go wait for the transcript.

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
`<RUN>/transcript.txt`. Do **not** read that file into this conversation; the
drafting subagent reads it directly.

### 3. Draft, in an isolated subagent

Spawn a subagent (Task tool, general-purpose) so the heavy drafting and
repo-grounding stay out of this session. Give it this task:

> Read `${CLAUDE_PLUGIN_ROOT}/helper/prompts/grill.md` and follow it as your
> instructions. The transcript is at `<RUN>/transcript.txt`; the repository root
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

The popup now shows the draft XML and the questions. Read the one-line JSON
outcome and act on `status`:

- **`answered`** — it carries `answers`. Spawn the subagent again: have it read
  its previous `<RUN>/draft.json`, fold in these answers (resolve the questions
  they settle, set the objective mode once question one is answered), rewrite
  `<RUN>/draft.json`, and reply with the new question count. Then publish the
  next round the same way. Repeat.
- **`confirmed` + `"ok":true`** — the user confirmed and the prompt passed the
  invariants. Go to step 5 with `finalOut`.
- **`confirmed` + `"ok":false`** — the confirmed XML is not injection-ready
  (`problem` says why, e.g. an unresolved objective mode or a missing success
  criterion). Tell the user plainly, then resume waiting so they can fix it in
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

- The first run downloads the Whisper binary and model; the popup shows progress.
  On machines where local transcription is too slow, the helper recommends a
  cloud speech provider you supply a key for (configured in the popup).
- The helper binds `127.0.0.1` only and gates every request with a per-launch
  token, so no other local process can read the transcript or inject a prompt.
- If the popup is closed and this session stops polling, the helper shuts itself
  down and releases the port.
