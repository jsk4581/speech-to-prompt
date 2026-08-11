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

# Fixed-port setups (STP_PORT): a helper from a previous run may still hold the
# port — e.g. its popup tab was left open, which keeps it alive by design. A new
# /stp:voice supersedes it, but only ever kill a process that is provably an
# STP helper.
if [ -n "${STP_PORT:-}" ] && [ "${STP_PORT}" != "0" ]; then
  for pid in $(fuser "${STP_PORT}/tcp" 2>/dev/null); do
    if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "helper/dist/index.js"; then
      kill "$pid" 2>/dev/null
    fi
  done
  # give the socket a moment to free up
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! fuser "${STP_PORT}/tcp" >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
fi

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

# Trusted HTTPS front (STP_ALLOWED_HOSTS, see server.ts): compose the public
# URL remote browsers reach the popup at. First listed host wins.
open_url="$url"
pub_host=$(printf '%s' "${STP_ALLOWED_HOSTS:-}" | cut -d, -f1 | tr -d ' ')
if [ -n "$pub_host" ]; then
  token=${url#*t=}
  open_url="https://$pub_host/?t=$token"
  echo "popup_public=$open_url"
fi

# Best-effort browser open; on headless machines the user opens the URL (or
# the agent does, via a connected browser tool).
if command -v xdg-open >/dev/null 2>&1; then (xdg-open "$open_url" >/dev/null 2>&1 &); fi
if command -v open >/dev/null 2>&1; then (open "$open_url" >/dev/null 2>&1 &); fi

# Opt-in custom opener (STP_OPEN_CMD): a user-supplied command that receives
# the popup URL — %URL% is substituted, otherwise the URL is appended. For
# setups where the browser lives on another machine (e.g. ssh <laptop> open).
if [ -n "${STP_OPEN_CMD:-}" ]; then
  case "$STP_OPEN_CMD" in
    *%URL%*) cmd=$(printf '%s' "$STP_OPEN_CMD" | sed "s|%URL%|$open_url|g") ;;
    *) cmd="$STP_OPEN_CMD $open_url" ;;
  esac
  (bash -c "$cmd" >/dev/null 2>&1 &)
fi
exit 0
