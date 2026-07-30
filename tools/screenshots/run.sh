#!/usr/bin/env bash
# run.sh - regenerate the README screenshots in docs/img/.
#
# Screenshots go stale every time the layout moves. This rebuilds all four from
# scratch in well under a minute, so refreshing them is never a reason to leave
# an out-of-date image in the README.
#
#   ./tools/screenshots/run.sh [--keep] [--out DIR]
#
#   --keep      leave the temp data directory in place for inspection
#   --out DIR   write PNGs somewhere else (default: docs/img)
#
# Environment overrides: APP_PORT (7788), MOCK_PORT (11435), CDP_PORT (9222),
# SHOT_WIDTH (1280), SHOT_HEIGHT (800), CHROME (path to a browser binary).
#
# What it does:
#   1. starts tools/screenshots/fake-ollama.mjs   - scripted models, no inference
#   2. starts the real server on a THROWAWAY data dir
#   3. builds four demo sessions through the real API
#   4. drives headless Chrome over CDP to theme, open and capture each one
#   5. tears all of it down
#
# YOUR DATA IS NOT TOUCHED. The server runs with RSCONCLAVE_DATA pointed at a
# fresh mktemp directory, so the demo account, sessions and endpoint config exist
# only for the duration of this script.
#
# Requires: node 24+, and Chrome / Chromium / Edge for the capture step.
set -euo pipefail

KEEP=0
OUT=docs/img
while [ $# -gt 0 ]; do
    case "$1" in
        --keep) KEEP=1; shift ;;
        --out)  OUT=$2; shift 2 ;;
        -h|--help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

cd "$(dirname "$0")/../.."
HERE=tools/screenshots

APP_PORT=${APP_PORT:-7788}
MOCK_PORT=${MOCK_PORT:-11435}
CDP_PORT=${CDP_PORT:-9222}
export MOCK_PORT CDP_PORT OUT
export BASE="http://127.0.0.1:${APP_PORT}"

G=$'\033[32m'; R=$'\033[31m'; N=$'\033[0m'
say() { printf '%s==>%s %s\n' "$G" "$N" "$*"; }
die() { printf '%serror%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

command -v node >/dev/null || die "node is required"

# Locate a browser. Chrome, Chromium and Edge all speak the same protocol.
find_browser() {
    if [ -n "${CHROME:-}" ]; then printf '%s' "$CHROME"; return 0; fi
    for c in google-chrome-stable google-chrome chromium chromium-browser microsoft-edge; do
        if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
    done
    for p in \
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        "/Applications/Chromium.app/Contents/MacOS/Chromium" \
        "/c/Program Files/Google/Chrome/Application/chrome.exe" \
        "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
        "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
        "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"; do
        if [ -x "$p" ]; then printf '%s' "$p"; return 0; fi
    done
    return 1
}
BROWSER=$(find_browser) || die "no Chrome/Chromium/Edge found - set CHROME=/path/to/binary"

DATA=$(mktemp -d 2>/dev/null || mktemp -d -t rsconclave-shots)
PROFILE="$DATA/chrome-profile"

# Track the pids we start and kill exactly those. Matching by name (pkill -f
# 'fake-ollama') is the obvious approach and it is wrong twice over: pkill is
# absent or ineffective on some platforms, and a name match can hit a process
# the user started themselves. A silent failure here leaves the old port owner
# running, the new one dies with EADDRINUSE, and the stale server answers every
# request - which looks exactly like the script ignoring your changes.
PIDS=()
cleanup() {
    for pid in ${PIDS+"${PIDS[@]}"}; do
        kill "$pid" 2>/dev/null || true
    done
    if [ "$KEEP" -eq 1 ]; then
        say "kept temp data at $DATA"
    else
        rm -rf "$DATA" 2>/dev/null || true
    fi
}
trap cleanup EXIT

wait_for() { # $1 = url, $2 = label
    for _ in $(seq 1 60); do
        if curl -sfk -m 2 "$1" >/dev/null 2>&1; then return 0; fi
        sleep 0.5
    done
    die "$2 never came up at $1"
}

say "fake inference server on :${MOCK_PORT}"
node "$HERE/fake-ollama.mjs" > "$DATA/fake.log" 2>&1 &
PIDS+=($!)
wait_for "http://127.0.0.1:${MOCK_PORT}/api/tags" "fake-ollama"

say "app on :${APP_PORT} with throwaway data at $DATA/app"
RSCONCLAVE_DATA="$DATA/app" PORT="$APP_PORT" \
    node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON server/main.ts > "$DATA/app.log" 2>&1 &
PIDS+=($!)
wait_for "${BASE}/api/health" "server"

say "building demo sessions"
node "$HERE/sessions.mjs" || die "session build failed - see $DATA/app.log"

say "headless browser via $BROWSER"
"$BROWSER" --headless=new --remote-debugging-port="$CDP_PORT" \
    --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
    --hide-scrollbars --window-size="${SHOT_WIDTH:-1280},${SHOT_HEIGHT:-800}" \
    "$BASE" > "$DATA/chrome.log" 2>&1 &
PIDS+=($!)
wait_for "http://127.0.0.1:${CDP_PORT}/json/version" "chrome devtools"

say "capturing"
node "$HERE/capture.mjs" || die "capture failed - see $DATA/chrome.log"

say "done - screenshots in $OUT"
