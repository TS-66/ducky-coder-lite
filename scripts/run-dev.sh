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

# 2. One rustc at a time, and no debug info.
export CARGO_BUILD_JOBS=1
export CARGO_PROFILE_DEV_DEBUG=0
# Keep the linker from ballooning on a small machine.
export RUSTFLAGS="${RUSTFLAGS:-} -C debuginfo=0"

echo "cargo    $CARGO_VER  ($CARGO_BIN)"
echo "node     $(node --version)"
echo "jobs     $CARGO_BUILD_JOBS (pinned: a parallel build gets OOM-killed here)"
echo
echo "The first build compiles all 556 crates single-threaded. That takes a"
echo "while. Ctrl-C is safe; re-running resumes."
echo

exec npm run tauri dev "$@"
