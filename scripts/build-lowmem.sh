#!/usr/bin/env bash
#
# Memory-safe build for low-RAM machines.
#
# `rustc` is the memory-hungry part of this project: compiling the Tauri
# dependency tree spawns one process per crate, and a parallel build can peak
# well above 2 GB. This script pins cargo to a single job and turns off debug
# info, which keeps peak resident memory to roughly one rustc process.
#
# It is safe to Ctrl-C at any point; cargo resumes from where it stopped.
#
#   ./scripts/build-lowmem.sh          # type-check + tests, then release build
#   ./scripts/build-lowmem.sh check    # only compile-check the backend
#   ./scripts/build-lowmem.sh test     # run the backend unit tests
#   ./scripts/build-lowmem.sh release  # full optimised bundle

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- Pick the right toolchain ----------------------------------------------
# This matters more than it looks. A distribution may ship a very old cargo
# (1.65 on Debian 12, for instance) which predates the `dep:` weak-feature
# syntax used throughout the modern wasm-bindgen ecosystem. Such a cargo emits
# deeply misleading dependency errors -- "js-sys does not have these features"
# and the like -- and cannot build a crate whose `rust-version` is 1.77 anyway.
#
# So: prefer the rustup toolchain, and refuse to continue on anything too old
# rather than failing confusingly minutes into a build.
if [ -d "$HOME/.cargo/bin" ]; then
  PATH="$HOME/.cargo/bin:$PATH"
  export PATH
fi

CARGO_BIN="$(command -v cargo || true)"
if [ -z "$CARGO_BIN" ]; then
  echo "error: cargo is not on PATH." >&2
  echo "install it from https://rustup.rs (recommended) or your package manager." >&2
  exit 127
fi

MIN_MINOR=77
CARGO_MINOR="$("$CARGO_BIN" --version 2>/dev/null |
  sed -nE 's/^cargo ([0-9]+)\.([0-9]+).*/\1 \2/p' | awk '{print $1 * 100 + $2}')"
if [ -z "$CARGO_MINOR" ] || [ "$CARGO_MINOR" -lt "$MIN_MINOR" ]; then
  echo "error: $("$CARGO_BIN" --version) is too old." >&2
  echo "       Ducky Coder Lite needs cargo 1.${MIN_MINOR} or newer (found at $CARGO_BIN)." >&2
  echo "       An old cargo cannot read modern dependency manifests and will" >&2
  echo "       report errors that look unrelated to the real cause." >&2
  echo "fix:   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2
  exit 1
fi

# One rustc at a time. This is the single most important line in the file.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
# Debug info is a large part of a rustc process's footprint and is not needed
# for a runnable build.
export CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-0}"
export CARGO_PROFILE_RELEASE_DEBUG="${CARGO_PROFILE_RELEASE_DEBUG:-0}"

TARGET="${1:-all}"

log() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

# Show what the machine looks like before and after, so a low-memory run is
# visible rather than mysterious.
memline() {
  if command -v free >/dev/null 2>&1; then
    free -m | awk 'NR==2 {printf "    mem: %s MB used, %s MB available\n", $3, $7}'
  fi
}

log "Environment"
echo "    jobs:    $CARGO_BUILD_JOBS"
memline

case "$TARGET" in
  check)
    log "Checking the Rust backend (no linking)"
    (cd src-tauri && cargo check --lib)
    ;;
  test)
    log "Running the backend unit tests"
    (cd src-tauri && cargo test --lib)
    ;;
  release)
    log "Full release bundle"
    npm run tauri build
    ;;
  all)
    log "Type-checking the frontend"
    npm run typecheck
    log "Building the frontend bundle"
    npm run build:fast
    log "Checking the Rust backend"
    (cd src-tauri && cargo check --lib)
    log "Running the backend unit tests"
    (cd src-tauri && cargo test --lib)
    log "Building the release bundle (this is the slow part)"
    npm run tauri build
    ;;
  *)
    echo "usage: $0 [check|test|release|all]" >&2
    exit 2
    ;;
esac

log "Done"
memline
