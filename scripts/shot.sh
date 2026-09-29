#!/usr/bin/env bash
# Screenshot the app, and prove the render is the app and not an error page.
#
#   ./scripts/shot.sh [out.png] [url] [width] [height]
#
# Four things this gets right that a naive capture does not.
#
# 1. IT CALLS THE BROWSER, NOT A LAUNCHER. `/usr/bin/chromium` on this machine is
#    a shell script; passing a long flag list through it is what made every
#    capture fail with a confusing "syntax error" from inside the wrapper. The
#    real ELF is `/usr/lib/chromium/chromium` and is invoked directly. Override
#    with DUCKY_CHROME=/path/to/binary.
#
# 2. IT CHECKS THE DOM FIRST. A 404 or a bundle that never loaded still produces a
#    valid PNG, and "not found" rendered in a serif face has enough antialiasing
#    to pass a colour-variety threshold. Colour variety is therefore a *second*
#    check, not the first: the page must actually contain the app shell.
#
# 3. IT CHECKS THE PIXELS. A blank page is a valid PNG, so "the file exists"
#    proves nothing. A real render of this UI yields hundreds of distinct colour
#    values; a blank one yields a handful.
#
# 4. IT REBUILDS THE DEMO. `vite build` empties dist/, and the demo page lives
#    there, so any capture after a build is a capture of a 404.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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

# The demo page is a build artefact, so it does not survive `vite build`.
if [ ! -f dist/demo.html ]; then
  echo "  rebuilding the demo page"
  node scripts/make-demo.mjs >/dev/null || {
    echo "FAIL  could not rebuild the demo page"
    exit 1
  }
fi

# --- 1. does the page contain the app? ---------------------------------------
DOM="$(timeout 60 "$CHROME" \
  --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --virtual-time-budget=6000 --dump-dom "$URL" 2>/dev/null)"

if ! printf '%s' "$DOM" | grep -q 'class="shell"'; then
  echo "FAIL  the app shell never mounted; this is not a screenshot of the app"
  printf '%s' "$DOM" | head -c 300
  echo
  exit 1
fi
LANDMARKS="$(printf '%s' "$DOM" | grep -oE 'class="(title-bar|activity-bar|sidebar|editor-area|ai-panel|status-bar)"' | sort -u | wc -l)"
echo "  dom ok  shell mounted, $LANDMARKS of 6 landmarks present"

# --- 2. capture ---------------------------------------------------------------
rm -f "$OUT"
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

# --- 3. are the pixels real? --------------------------------------------------
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
// A real dark-UI render is well above 200; an error page in a serif face lands
// under 150, which is why the threshold is here at all and not at 60.
const ok = distinct > 200;
console.log(`${ok ? "ok  " : "FAIL"}  ${w}x${h}  ${(d.length / 1024).toFixed(0)} KB  ${distinct} distinct values  -> ${process.argv[2]}`);
if (!ok) console.log(`      too few: only ${distinct} distinct pixel bytes, expected >200`);
process.exit(ok ? 0 : 1);
' "$OUT" "$OUT"
