#!/usr/bin/env bash
# Screenshot the running app and report whether it actually rendered.
#
#   ./scripts/shot.sh [out.png] [url] [width] [height]
#
# A blank page still produces a valid PNG, so "the file exists" proves nothing.
# This checks the pixel content: a real render of this UI produces thousands of
# distinct colour values, a blank one produces a handful. That check has caught
# two silent failures (a blank file:// render, and a bundle that failed to load)
# that would otherwise have been reported as "looked fine".
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-/tmp/ducky.png}"
URL="${2:-http://127.0.0.1:5199/demo.html?still=1}"
W="${3:-1440}"
H="${4:-900}"

# A virtual-time budget above ~8000ms can hang headless Chromium outright.
VTB=6000

rm -f "$OUT"

# `timeout` is not optional. An infinite CSS animation keeps the page's virtual
# clock permanently busy, so a screenshot request can wait forever. The app's
# reduced-motion rule is what breaks that loop, and forcing it is also the
# honest thing to capture: it is a state the app really supports.
timeout 90 chromium \
  --headless=old \
  --no-sandbox \
  --no-zygote \
  --disable-gpu \
  --disable-dev-shm-usage \
  --hide-scrollbars \
  --force-prefers-reduced-motion \
  --force-device-scale-factor=1 \
  --window-size="$W,$H" \
  --virtual-time-budget="$VTB" \
  --screenshot="$OUT" \
  "$URL" >/dev/null 2>&1

if [ ! -f "$OUT" ]; then
  echo "FAIL  no screenshot produced"
  exit 1
fi

node -e '
const fs = require("fs"), zlib = require("zlib");
const d = fs.readFileSync(process.argv[1]);
const w = d.readUInt32BE(16), h = d.readUInt32BE(20);
let i = 8, idat = [];
while (i < d.length) {
  const len = d.readUInt32BE(i), type = d.toString("ascii", i + 4, i + 8);
  if (type === "IDAT") idat.push(d.subarray(i + 8, i + 8 + len));
  i += 12 + len;
}
const raw = zlib.inflateSync(Buffer.concat(idat));
const distinct = new Set(raw).size;
const ok = distinct > 60;
console.log(`${ok ? "ok  " : "FAIL"}  ${w}x${h}  ${(d.length / 1024).toFixed(0)} KB  ${distinct} distinct values`);
if (!ok) console.log(`      looks blank -- only ${distinct} distinct pixel bytes`);
process.exit(ok ? 0 : 1);
' "$OUT"
