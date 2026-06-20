# P0 Spikes

STP is not installable yet. These spikes prove the scaffold and the risky
handoff assumptions before adding Whisper, BYOK, or the full grill loop.

## P0-1 Repo Honesty And Validation

- README/docs state scaffold status and do not imply the helper, popup, Whisper,
  grill loop, or handoff already works.
- `AGENTS.md` gives public Codex instructions while `CLAUDE.md` remains private.
- Marketplace validation passes without warnings.
- Plugin manifest validation is compatible with older local Claude Code CLI
  versions. On Claude Code 2.1.31, `displayName` is rejected by plugin manifest
  validation, so the field is intentionally omitted for now.
- Hook commands quote paths so plugin roots with spaces are safe.

Validation commands:

```sh
jq empty .claude-plugin/*.json hooks/hooks.json helper/package.json helper/tsconfig.json
npm --prefix helper run build -- --noEmit
claude plugin validate .
```

## P0-2 Confirmed XML Handoff PoC

Goal: prove the caller can receive exactly one confirmed XML payload without
microphone, Whisper, LLM, BYOK, or complex UI.

Required checks:

- Helper starts a local session.
- Local page exposes manual transcript and editable XML textareas.
- Confirm writes the exact XML to a session result file or endpoint.
- Caller reads and prints that exact XML.
- Session token is required for the confirm path.
- Request body size is limited.
- Session files are cleaned up when possible.

## P0-3 Helper Launch PoC

Goal: prove the plugin/dev scripts can launch the helper reliably.

Required checks:

- Helper serves only on `127.0.0.1`.
- Browser opens to the local page.
- Paths with spaces work.
- Shutdown or timeout behavior is documented.

## P0-4 Popup Manual Transcript

Goal: validate the basic UX skeleton before audio capture.

Required checks:

- Text transcript can be edited manually.
- XML draft can be edited manually.
- Confirm and cancel states are visible.
- No microphone or Whisper dependency is required.

## P0-5 XML Contract

Goal: lock the smallest output contract before generating prompts.

Required checks:

- Minimal XML shape is documented.
- Parser/serializer tests cover English and Korean fixtures.
- Invalid or partial XML has a predictable failure path.

## Later Work

- P1 starts only after handoff is proven: MediaRecorder capture, Whisper
  subprocess integration, and localhost security hardening.
- P2 adds the grill loop.
- P3 adds BYOK strict no-pollution mode.
