#!/usr/bin/env bash
# Launch the app in development mode, on this machine, safely.
#
#   ./scripts/run-dev.sh
#
# Two things this handles that are easy to get wrong by hand:
#
# 1. WHICH CARGO. This machine has two: /usr/bin/cargo is 1.65 (2023) and
#    ~/.cargo/bin/cargo is 1.98 via rustup. The login shell picks the old one,
#    and 1.65 does not understand `dep:` weak features, so it blames `js-sys`
#    for a conflict that does not exist:
#
#      "the package `reqwest` depends on `js-sys`, with features: `futures-util`
#       but `js-sys` does not have these features"
#
#    That message means "your cargo is too old", not "your dependencies conflict".
#    So the correct toolchain is forced onto PATH before anything else runs.
#
# 2. HOW MANY JOBS. The dependency tree is 556 crates. A parallel rustc build
#    on a 2.7 GB machine gets OOM-killed -- that has already happened once, and
#    it takes the desktop with it. Jobs are pinned to 1 and debug info is off.
#
# The first build is long: this compiles every crate for real (not just
# `cargo check`), single-threaded, on one core. Expect 20-40 minutes. It is safe
# to interrupt with Ctrl-C; cargo resumes where it stopped.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 1. The correct toolchain, always.
if [ -x "$HOME/.cargo/bin/cargo" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

CARGO_BIN="$(command -v cargo || true)"
if [ -z "$CARGO_BIN" ]; then
  echo "error: cargo not found. Install it with:  rustup install stable" >&2
  exit 1
fi

# Refuse to continue on a toolchain that will fail confusingly.
CARGO_VER="$("$CARGO_BIN" --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
CARGO_MAJOR="${CARGO_VER%%.*}"
CARGO_MINOR="$(echo "$CARGO_VER" | cut -d. -f2)"
if [ "$CARGO_MAJOR" -lt 1 ] || { [ "$CARGO_MAJOR" -eq 1 ] && [ "$CARGO_MINOR" -lt 77 ]; }; then
  cat >&2 <<EOF
error: cargo $CARGO_VER at $CARGO_BIN is too old.

It will not understand this project's dependencies and will report a
misleading error about 'js-sys' / 'futures-util' that looks like a dependency
conflict but is not.

Fix it with:

  rustup install stable

then re-run this script.
EOF
  exit 1
fi

# 2. How many rustc processes at once.
#
# This used to be hard-pinned to 1, because a fully parallel build OOM-killed
# this machine. But 1 on an 8-core box throws away most of the machine, and the
# build is the long pole: 556 crates, several of them enormous generated C
# bindings. Pinning to 1 was a blunt instrument for a real constraint.
#
# So the count is derived from memory actually available right now. A single
# rustc peaks around 500 MB on the heavy crates, and holding ~600 MB back keeps
# the desktop responsive, which matters more here than a fast build.
#
# Override with DUCKY_JOBS=4 ./scripts/run-dev.sh if you want it faster, or
# DUCKY_JOBS=1 if something else is using the memory.
CORES="$(nproc 2>/dev/null || echo 1)"
AVAIL_MB="$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 1024)"
[ -n "$AVAIL_MB" ] && [ "$AVAIL_MB" -gt 0 ] 2>/dev/null || AVAIL_MB=1024

if [ -n "${DUCKY_JOBS:-}" ]; then
  JOBS="$DUCKY_JOBS"
  JOB_WHY="set by DUCKY_JOBS"
else
  JOBS=$(( (AVAIL_MB - 600) / 600 ))
  [ "$JOBS" -lt 1 ] && JOBS=1
  [ "$JOBS" -gt "$CORES" ] && JOBS="$CORES"
  JOB_WHY="derived from ${AVAIL_MB} MB free across ${CORES} cores"
fi

export CARGO_BUILD_JOBS="$JOBS"
export CARGO_PROFILE_DEV_DEBUG=0
# Keep the linker from ballooning on a small machine.
export RUSTFLAGS="${RUSTFLAGS:-} -C debuginfo=0"

echo "cargo    $CARGO_VER  ($CARGO_BIN)"
echo "node     $(node --version)"
echo "jobs     $CARGO_BUILD_JOBS of $CORES cores  ($JOB_WHY)"
echo
echo "First build compiles all 556 crates; on this machine expect 15-30 min."
echo "Ctrl-C is safe at any point -- cargo keeps what it finished and resumes."
echo

exec npm run tauri dev "$@"
