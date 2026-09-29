#!/usr/bin/env bash
# Screenshot the app, and report whether it actually rendered.
#
#   ./scripts/shot.sh [out.png] [url] [width] [height]
#
# Two things this gets right that a naive capture does not.
#
# 1. IT CALLS THE BROWSER, NOT A LAUNCHER. `/usr/bin/chromium` on this machine is
#    a shell script; passing a long flag list through it is what made every
#    capture fail with a confusing "syntax error" from inside the wrapper. The
#    real ELF is `/usr/lib/chromium/chromium` and is invoked directly. Override
#    with DUCKY_CHROME=/path/to/binary.
#
# 2. IT CHECKS THE PIXELS. A blank page still produces a valid PNG, so "the file
#    exists" proves nothing. A real render of this UI yields hundreds of distinct
#    colour values; a blank one yields a handful. That check has already caught
#    two silent failures -- a blank `file://` render, and a bundle that never
#    loaded -- that would otherwise have been reported as "looked fine".
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-/tmp/ducky.png}"
URL="${2:-http://127.0.0.1:5199/demo.html?still=1}"
W="${3:-1440}"
H="${4:-900}"

CHROME="${DUCKY_CHROME:-/usr/lib/chromium/chromium}"
if [ ! -x "$CHROME" ]; then
  CHROME="$(command -v chromium 2>/dev/null || true)"
fi
if [ -z "$CHROME" ] || [ ! -x "$CHROME" ]; then
  echo "FAIL  no chromium binary found; set DUCKY_CHROME=/path/to/chromium"
  exit 1
fi

rm -f "$OUT"

# `timeout` is not optional, but the virtual clock is not relied on either. The
# demo's `?still` flag stops the infinite CSS animations that would otherwise
# keep a virtual-time budget from ever expiring.
timeout 90 "$CHROME" \
  --headless \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --hide-scrollbars \
  --force-device-scale-factor=1 \
  --window-size="$W,$H" \
  --virtual-time-budget=6000 \
  --screenshot="$OUT" \
  "$URL" >/dev/null 2>&1

if [ ! -f "$OUT" ]; then
  echo "FAIL  no screenshot produced by $CHROME"
  exit 1
fi

node -e '
const fs = require("fs"), zlib = require("zlib");
const d = fs.readFileSync(process.argv[1]);
const w = d.readUInt32BE(16), h = d.readUInt32BE(20);
let i = 8; const idat = [];
while (i < d.length) {
  const len = d.readUInt32BE(i), type = d.toString("ascii", i + 4, i + 8);
  if (type === "IDAT") idat.push(d.subarray(i + 8, i + 8 + len));
  i += 12 + len;
}
const raw = zlib.inflateSync(Buffer.concat(idat));
const distinct = new Set(raw).size;
const ok = distinct > 60;
console.log(`${ok ? "ok  " : "FAIL"}  ${w}x${h}  ${(d.length / 1024).toFixed(0)} KB  ${distinct} distinct values  -> ${process.argv[2]}`);
if (!ok) console.log(`      looks blank: only ${distinct} distinct pixel bytes`);
process.exit(ok ? 0 : 1);
' "$OUT" "$OUT"
