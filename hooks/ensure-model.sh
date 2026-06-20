#!/usr/bin/env bash
# STP SessionStart hook — first-run Whisper model bootstrap (WIP stub).
#
# Intended behavior (not yet implemented):
#   - Check ${CLAUDE_PLUGIN_DATA} for the default Whisper model (large-v3-turbo).
#   - If absent, download it once, with progress / disk-space / failure handling.
#   - Never commit weights; they live in ${CLAUDE_PLUGIN_DATA} (survives updates).
#
# For now this is a no-op so installing the plugin is always safe.
exit 0
