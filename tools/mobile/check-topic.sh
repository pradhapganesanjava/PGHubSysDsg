#!/usr/bin/env bash
# Render one topic page in a private copy of the layout harness and screenshot it.
#   bash tools/mobile/check-topic.sh <content.html> <port> <workdir>      (WIDTH_ONLY=1 for just the 390px report)
# Prints: overflow report at 390px, then paths of white-theme slices (desktop, ~2000px each) and a 390px shot.
# Needs tools/mobile/harness (run `node tools/mobile/build-harness.mjs` once). Safe to run in parallel with distinct ports/workdirs.
set -euo pipefail
HTML="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; PORT="$2"; WORK="$3"
DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
rm -rf "$WORK/harness" && mkdir -p "$WORK/shots" && cp -R "$DIR/harness" "$WORK/harness"
node -e '
const fs=require("fs"); const p=process.argv[1]+"/harness/app/drive.js"; let s=fs.readFileSync(p,"utf8");
const n="\"content\":\"<p>Body.</p>\""; if(!s.includes(n)) throw new Error("fixture not found");
fs.writeFileSync(p, s.replace(n, () => "\"content\":"+JSON.stringify(fs.readFileSync(process.argv[2],"utf8"))))' "$WORK" "$HTML"   # replacer fn: a "$" sequence in the page must not act as a replace pattern
cat > "$WORK/harness/check.html" <<'H'
<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="f" style="width:390px;height:900px;border:0" src="module.html?m=02-patterns#topic/t1"></iframe><pre id="out">waiting</pre>
<script>setTimeout(()=>{const d=document.getElementById('f').contentDocument,W=d.documentElement.clientWidth,bad=[];
d.querySelectorAll('.content *, #content *, main *').forEach(e=>{const r=e.getBoundingClientRect();
if(r.width&&r.right>W+1&&!e.closest('[style*="overflow-x:auto"]')&&!e.closest('.diagram')&&!e.closest('pre')&&!e.closest('aside'))bad.push(e.tagName+' right='+Math.round(r.right)+' '+(e.textContent||'').trim().slice(0,60))});
document.getElementById('out').textContent='docScrollWidth='+d.documentElement.scrollWidth+' (want 390) · svgs='+d.querySelectorAll('.diagram svg').length+'\n'+[...new Set(bad)].slice(0,20).join('\n')},6000)</script>
H
python3 -m http.server "$PORT" --directory "$WORK/harness" >/dev/null 2>&1 & SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT; sleep 1
B="http://localhost:$PORT"
echo "--- overflow at 390px"
"$CHROME" --headless --disable-gpu --virtual-time-budget=9000 --dump-dom "$B/check.html" 2>/dev/null | sed -n '/<pre id="out">/,/<\/pre>/p' | sed 's/<[^>]*>//g'
[ "${WIDTH_ONLY:-}" = "1" ] && exit 0   # WIDTH_ONLY=1: overflow report only, skip screenshots
H_PX=30000
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --virtual-time-budget=40000 --window-size=1100,$H_PX \
  --screenshot="$WORK/shots/tall.png" "$B/frame.html?t=module.html%3Fm%3D02-patterns%23topic%2Ft1&theme=white&w=1100&h=$H_PX" >/dev/null 2>&1 || true
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --virtual-time-budget=12000 --window-size=400,920 \
  --screenshot="$WORK/shots/phone.png" "$B/frame.html?t=module.html%3Fm%3D02-patterns%23topic%2Ft1&theme=white" >/dev/null 2>&1 || true
# slice the content column into ~2000px parts, stopping at the last non-blank region
TOTAL=$(sips -g pixelHeight "$WORK/shots/tall.png" | awk '/pixelHeight/{print $2}')
echo "--- slices (white theme, content column):"
for ((y=250, n=1; y<TOTAL && n<=15; y+=2000, n++)); do
  h=$(( TOTAL - y < 2000 ? TOTAL - y : 2000 )); cp "$WORK/shots/tall.png" "$WORK/shots/_t.png"
  sips --cropOffset $y 300 --cropToHeightWidth $h 800 "$WORK/shots/_t.png" --out "$WORK/shots/part$n.png" >/dev/null
  echo "$WORK/shots/part$n.png"
done
rm -f "$WORK/shots/_t.png"; echo "$WORK/shots/phone.png"
