#!/usr/bin/env bash
# Screenshot the harness through a fixed-width frame, plus the overflow report.
#   bash tools/mobile/shoot.sh <label>
set -euo pipefail
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="${1:-shot}"
PORT=5199
mkdir -p "$DIR/shots"
python3 -m http.server "$PORT" --directory "$DIR/harness" >/dev/null 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT; sleep 1
cap() { "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
        --virtual-time-budget="${4:-8000}" --window-size="$2,$3" \
        --screenshot="$DIR/shots/$LABEL-$1.png" "$5" >/dev/null 2>&1 || true; }
B="http://localhost:$PORT"
M="module.html%3Fm%3D01-foundations"
cap hub-390      400 920  8000  "$B/frame.html?t=index.html"
cap module-390   400 920  8000  "$B/frame.html?t=$M"
cap module-nav   400 920  8000  "$B/frame.html?t=$M&nav=open"
cap module-docs  400 920 10000  "$B/frame.html?t=module.html%3Fm%3D01-foundations%23doc/sd-bloom-filters.html"
cap hub-768      800 920  8000  "$B/frame.html?t=index.html&w=768"
cap module-768   800 920  8000  "$B/frame.html?t=$M&w=768"
cap module-1280 1320 900  8000  "$B/frame.html?t=$M&w=1280&h=880"
cap hub-search   400 920 12000 "$B/frame.html?t=index.html&q=bloom"
cap diag         900 700 20000 "$B/diag.html"
ls -la "$DIR/shots" | grep "$LABEL-" | awk '{printf "  %s\n", $NF}'
