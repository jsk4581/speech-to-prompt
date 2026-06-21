#!/usr/bin/env bash
# STP SessionStart hook — first-run readiness probe (fast, non-blocking).
#
# This does NOT download anything. A speech model is hundreds of MB to ~0.5 GB,
# which cannot fit in a SessionStart hook's short timeout, and pulling that much
# data without an explicit action would be a surprise. So the hook only *probes*
# and, on a fresh machine, prints a one-line heads-up. The actual binary/model
# download + tier selection runs in the helper when you invoke /stp:voice, where
# the popup can show progress and offer BYOK cloud STT as an alternative.
#
# Always exits 0 so installing the plugin never blocks or fails a session.

set -u

data_dir="${CLAUDE_PLUGIN_DATA:-$HOME/.stp}"
models_dir="$data_dir/models"

# Already have a model (or an explicit one via env)? Stay silent.
if [ -n "${STP_WHISPER_MODEL:-}" ] && [ -f "${STP_WHISPER_MODEL:-}" ]; then
  exit 0
fi
if ls "$models_dir"/ggml-*.bin >/dev/null 2>&1; then
  exit 0
fi

echo "STP: speech model not installed yet — it downloads automatically the first time you run /stp:voice (or pick BYOK cloud STT in the popup to skip the download)."
exit 0
