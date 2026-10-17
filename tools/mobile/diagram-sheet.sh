#!/usr/bin/env bash
# Render every inline SVG of a built page onto one 2-column sheet image (white background), numbered #1, #2, …
#   bash tools/mobile/diagram-sheet.sh tools/out/overviews/<id>.html <out.png>
# Read the PNG to check diagrams: labels on lines, text outside boxes, clipped edges, overlaps.
set -euo pipefail
SRC="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; PNG="$2"; HTML="${PNG%.png}.sheet.html"
N=$(node -e '
const fs=require("fs"); const h=fs.readFileSync(process.argv[1],"utf8");
const svgs=[...h.matchAll(/<svg[\s\S]*?<\/svg>/g)].map(m=>m[0]);
fs.writeFileSync(process.argv[2], `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff;color:#1b1f24;font-family:system-ui;--panel:#fff;--text:#1b1f24;--muted:#667">`+
 `<div style="display:grid;grid-template-columns:680px 680px;gap:12px;padding:8px">`+svgs.map((s,i)=>`<div style="border:1px solid #ddd;padding:4px"><div style="font:700 11px system-ui">#${i+1}</div>${s}</div>`).join("")+`</div>`);
console.log(svgs.length)' "$SRC" "$HTML")
H=$(( (N + 1) / 2 * 520 + 100 ))
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1400,$H --screenshot="$(cd "$(dirname "$PNG")" && pwd)/$(basename "$PNG")" "file://$HTML" >/dev/null 2>&1
echo "$N diagrams → $PNG"
