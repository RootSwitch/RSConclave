#!/bin/sh
# One-time per clone: point git at the tracked hooks directory.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
git -C "$ROOT" config core.hooksPath tools/hooks
echo "core.hooksPath -> tools/hooks (post-commit refreshes dist/rsconclave.bundle)"
