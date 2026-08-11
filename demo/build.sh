#!/usr/bin/env bash
# Assemble the rendered frames into the README GIF.
#   1) node demo/shoot.mjs            → demo/_frames/frame_*.png (30fps, 1920x1080)
#   2) bash demo/build.sh             → docs/demo.gif (15fps, 1280w, palette-optimized)
set -euo pipefail
cd "$(dirname "$0")"

FRAMES=${1:-_frames}
OUT=${2:-../docs/demo.gif}
WIDTH=${WIDTH:-1120}
GIF_FPS=${GIF_FPS:-12}
COLORS=${COLORS:-96}

ffmpeg -y -framerate 30 -i "$FRAMES/frame_%05d.png" \
  -vf "fps=$GIF_FPS,scale=$WIDTH:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=$COLORS:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 "$OUT"
ls -lh "$OUT"
