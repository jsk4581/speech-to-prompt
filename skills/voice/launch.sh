#!/usr/bin/env bash
# STP instant launch — meant to run at /stp:voice prompt-expansion time, before
# the model sees the conversation. Builds the helper if needed, starts it
# detached, waits for readiness, and prints the connection facts the runbook
# needs (run_dir / STP_READY / popup URL). Always exits 0: a failure is
# reported as an STP_LAUNCH_ERROR line for the agent to act on, never as a
# blocked prompt.
set -u

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
HELPER="$ROOT/helper"

if [ ! -f "$HELPER/dist/index.js" ]; then
  echo "STP: first run — building the helper (a few seconds)…"
  if ! (cd "$HELPER" && npm ci --no-fund --no-audit && npm run build) >/dev/null 2>&1; then
    echo "STP_LAUNCH_ERROR build failed — run manually: cd \"$HELPER\" && npm ci && npm run build"
    exit 0
  fi
fi

RUN=$(mktemp -d "${TMPDIR:-/tmp}/stp-voice.XXXXXX") || { echo "STP_LAUNCH_ERROR mktemp failed"; exit 0; }

STP_TRANSCRIPT_DIR="$RUN" nohup node "$HELPER/dist/index.js" >"$RUN/helper.log" 2>&1 &

ready=""
for _ in $(seq 1 75); do # up to ~15s (cold Node start is ~1s; margin for slow disks)
  ready=$(head -1 "$RUN/helper.log" 2>/dev/null)
  case "$ready" in STP_READY*) break;; *) ready="";; esac
  sleep 0.2
done
if [ -z "$ready" ]; then
  echo "STP_LAUNCH_ERROR helper did not become ready — see $RUN/helper.log"
  exit 0
fi

url=$(grep -m1 -o 'http://127\.0\.0\.1:[0-9]*/?t=[A-Za-z0-9._~-]*' "$RUN/helper.log")

echo "run_dir=$RUN"
echo "$ready"
echo "popup=$url"

# Best-effort browser open; on headless machines the user opens the URL.
if command -v xdg-open >/dev/null 2>&1; then (xdg-open "$url" >/dev/null 2>&1 &); fi
if command -v open >/dev/null 2>&1; then (open "$url" >/dev/null 2>&1 &); fi
exit 0
