#!/bin/sh
# Produce dist/rsconclave.bundle: the entire repo (all branches and tags) as
# one file, for carrying to a box that has no route to this machine's git.
#
# A git bundle beats a tar of the working tree for this job: it can only
# contain committed history, so data/ (prompts, transcripts, certs, accounts)
# is structurally unable to leak into a transfer; and the receiving side does
# ordinary git operations against the file, so updates are incremental.
#
# First time on the box:
#   git clone /path/to/rsconclave.bundle rsconclave
# Updates: overwrite the same bundle file on the box, then inside the clone:
#   git pull
# (cloning from a bundle sets it as origin, so pull just works as long as the
# file stays at the path you cloned from)
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/rsconclave.bundle"

mkdir -p "$ROOT/dist"
git -C "$ROOT" bundle create "$OUT" --all --quiet
# verify catches a truncated or corrupt bundle now, not on the far end
git -C "$ROOT" bundle verify "$OUT" >/dev/null 2>&1

SIZE=$(du -h "$OUT" | cut -f1)
HEAD_LINE=$(git -C "$ROOT" log -1 --format='%h %s')
if [ "$1" = "--quiet" ]; then
    echo "[bundle] dist/rsconclave.bundle refreshed ($SIZE, at $HEAD_LINE)"
else
    echo "Wrote $OUT ($SIZE)"
    echo "Contains every branch and tag up to: $HEAD_LINE"
    echo ""
    echo "On the box, first time:   git clone /path/to/rsconclave.bundle rsconclave"
    echo "Updates: overwrite the bundle at that same path, then: git pull"
fi
