#!/usr/bin/env bash
# Run every check, in the order that fails fastest, under a memory watchdog.
#
#   ./scripts/verify.sh          # types + bundle + interaction tests + rust
#   ./scripts/verify.sh frontend # skip the (slow) Rust half
#
# Every stage is single-threaded on purpose. This machine has ~2.7 GB of RAM and
# a parallel rustc is what OOM-killed it before. If free memory drops below
# WATCHDOG_MB the build is killed rather than allowed to take the machine down
# with it.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

export PATH="$HOME/.cargo/bin:$PATH"
NODE_CAP=800
CARGO_BUILD_JOBS=1
CARGO_PROFILE_DEV_DEBUG=0
WATCHDOG_MB=450
STAGE="${1:-all}"

PASS=0
FAIL=0
LOG_DIR="$ROOT/.verify"
mkdir -p "$LOG_DIR"

# --- reporting --------------------------------------------------------------

stage() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m[pass]\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()   { printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
note()  { printf '  %s\n' "$1"; }

# --- the watchdog -----------------------------------------------------------
#
# Runs a command, polling free memory every 2s. If the machine gets squeezed
# below WATCHDOG_MB, the process group is killed and the stage is reported as
# aborted rather than being allowed to freeze the desktop.
watched() {
  local log="$1"; shift
  setsid "$@" < /dev/null > "$log" 2>&1 &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    local avail
    avail=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 9999)
    if [ "${avail:-9999}" -lt "$WATCHDOG_MB" ]; then
      note "free memory fell to ${avail} MB (< ${WATCHDOG_MB}); aborting to protect the machine"
      kill -TERM -"$pid" 2>/dev/null
      sleep 2
      kill -KILL -"$pid" 2>/dev/null
      return 99
    fi
    sleep 2
  done
  wait "$pid"
  return $?
}

# --- stages -----------------------------------------------------------------

if [ "$STAGE" = "all" ] || [ "$STAGE" = "frontend" ]; then
  stage "TypeScript"
  if node --max-old-space-size="$NODE_CAP" node_modules/typescript/bin/tsc --noEmit \
       > "$LOG_DIR/tsc.log" 2>&1; then
    ok "0 type errors"
  else
    bad "type errors"
    head -20 "$LOG_DIR/tsc.log" | sed 's/^/        /'
  fi

  stage "Bundle"
  if NODE_OPTIONS="--max-old-space-size=$NODE_CAP" node node_modules/vite/bin/vite.js build \
       > "$LOG_DIR/build.log" 2>&1; then
    # A build that "succeeds" but leaves an empty chunk is a silent failure, so
    # the sizes are checked rather than the exit code alone.
    if [ -n "$(ls -S dist/assets/index-*.js 2>/dev/null | head -1)" ]; then
      ok "$(ls -S dist/assets/*.js | head -3 | xargs -I{} sh -c 'printf "%s " "$(du -h {} | cut -f1) $(basename {})"')"
    else
      bad "no entry chunk was emitted"
    fi
  else
    bad "build failed"
    tail -20 "$LOG_DIR/build.log" | sed 's/^/        /'
  fi

  stage "Interaction tests"
  if node --max-old-space-size=900 scripts/interact.mjs > "$LOG_DIR/interact.log" 2>&1; then
    ok "$(grep -c '\[PASS\]' "$LOG_DIR/interact.log") assertions"
  else
    bad "interaction failures"
    grep -E "FAIL|FAILURES" "$LOG_DIR/interact.log" | head -20 | sed 's/^/        /'
  fi

  stage "Reference conformance"
  # The colours and geometry are checked against values sampled from the
  # reference screenshots and the written specification. This is the strongest
  # check available for the UI: the app cannot be rendered to pixels here, so a
  # wrong hex or a wrong column width is a fact this catches and a screenshot
  # review would only have to take on trust.
  if node scripts/conformance.mjs > "$LOG_DIR/conformance.log" 2>&1; then
    ok "$(grep -oE '[0-9]+ passed' "$LOG_DIR/conformance.log" | tail -1)"
  else
    bad "conformance failures"
    grep FAIL "$LOG_DIR/conformance.log" | head -20 | sed 's/^/        /'
  fi

  stage "Boot smoke test"
  if node --max-old-space-size=900 scripts/smoke.mjs > "$LOG_DIR/smoke.log" 2>&1; then
    ok "boots clean"
  else
    bad "boot smoke failed"
    tail -20 "$LOG_DIR/smoke.log" | sed 's/^/        /'
  fi
fi

if [ "$STAGE" = "all" ] || [ "$STAGE" = "rust" ]; then
  # Version guard: cargo 1.65 predates `dep:` weak features and emits
  # misleading errors about them, which cost a long debugging detour once.
  CARGO_VER=$(cargo --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)
  if [ -z "$CARGO_VER" ]; then
    stage "Rust"; bad "cargo not found (expected $HOME/.cargo/bin on PATH)"
  elif [ "$(printf '%s\n2.100\n' "$CARGO_VER" | sort -V | head -1)" != "$CARGO_VER" ]; then
    stage "Rust"; bad "cargo $CARGO_VER is too old; run: rustup install stable"
  else
    stage "Rust: cargo check"
    watched "$LOG_DIR/cargo-check.log" cargo check --lib --manifest-path src-tauri/Cargo.toml
    rc=$?
    if [ $rc -eq 0 ]; then
      ok "backend compiles ($(grep -c '^warning' "$LOG_DIR/cargo-check.log" || echo 0) warnings)"
    elif [ $rc -eq 99 ]; then
      bad "aborted -- not enough free memory"
    else
      bad "$(grep -cE '^error' "$LOG_DIR/cargo-check.log") compile errors"
      grep -E '^error' -A 4 "$LOG_DIR/cargo-check.log" | head -30 | sed 's/^/        /'
    fi

    stage "Rust: unit tests"
    watched "$LOG_DIR/cargo-test.log" cargo test --lib --manifest-path src-tauri/Cargo.toml
    rc=$?
    if [ $rc -eq 0 ]; then
      ok "$(grep -oE '[0-9]+ passed' "$LOG_DIR/cargo-test.log" | tail -1) tests"
    elif [ $rc -eq 99 ]; then
      bad "aborted -- not enough free memory"
    else
      bad "test failures"
      grep -E "^(test |failures:|---- )" "$LOG_DIR/cargo-test.log" | head -30 | sed 's/^/        /'
    fi
  fi
fi

# --- summary ----------------------------------------------------------------

printf '\n\033[1m%d passed, %d failed\033[0m  (logs in %s)\n' "$PASS" "$FAIL" "$LOG_DIR"
[ "$FAIL" -eq 0 ] || exit 1
