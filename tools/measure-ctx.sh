#!/bin/sh
# measure-ctx.sh - find the largest num_ctx a model can hold without spilling.
#
# Context sizing is the one number no table can give you: it depends on the
# model's attention geometry (sliding-window and hybrid-Mamba models cost
# almost nothing per token, dense GQA models cost a lot), the quantisation,
# and how much VRAM you actually have free. So measure instead of guessing.
#
# Method: load the model twice at two known context sizes, read the real
# footprint from Ollama's /api/ps, and take the slope. That gives bytes per
# token for THIS model on THIS card, which extrapolates to the largest window
# that still fits.
#
# Usage:
#   ./measure-ctx.sh MODEL [--host URL] [--vram GB] [--low N] [--high N] [--apply]
#
#   --host   Ollama base URL          (default: http://127.0.0.1:11434)
#   --vram   usable VRAM budget in GB (default: auto-detect, else 24)
#   --low    small probe context      (default: 2048)
#   --high   large probe context      (default: 8192)
#   --apply  bake the recommended num_ctx into the model via ollama create
#
# Example:
#   ./measure-ctx.sh qwen3-coder:30b --vram 24 --apply
#
# Loading a big model twice takes a few minutes. Without --apply nothing is
# written or changed - the model is unloaded again at the end. With --apply
# the recommendation is written into the model itself: same name, a rebuild
# over the same blobs (no re-download), and every client of the daemon gets
# the new default, not just RSConclave.
set -eu

HOST=http://127.0.0.1:11434
VRAM_GB=""
LOW=2048
HIGH=8192
MODEL=""
APPLY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --host) HOST=$2; shift 2 ;;
        --vram) VRAM_GB=$2; shift 2 ;;
        --low)  LOW=$2; shift 2 ;;
        --high) HIGH=$2; shift 2 ;;
        --apply) APPLY=1; shift ;;
        -h|--help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "unknown option: $1" >&2; exit 2 ;;
        *)  MODEL=$1; shift ;;
    esac
done

[ -n "$MODEL" ] || { echo "usage: $0 MODEL [--host URL] [--vram GB]" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

# Auto-detect the card's total VRAM. Both vendors, and a stated default if
# neither tool is present - being explicit beats silently assuming.
if [ -z "$VRAM_GB" ]; then
    if command -v nvidia-smi >/dev/null 2>&1; then
        MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || true)
    elif command -v rocm-smi >/dev/null 2>&1; then
        MB=$(rocm-smi --showmeminfo vram --csv 2>/dev/null | awk -F, 'NR==2 {print int($3/1048576)}' || true)
    fi
    if [ -n "${MB:-}" ] && [ "${MB:-0}" -gt 0 ] 2>/dev/null; then
        VRAM_GB=$((MB / 1024))
        echo "detected ${VRAM_GB} GB of VRAM"
    else
        VRAM_GB=24
        echo "could not detect VRAM; assuming ${VRAM_GB} GB (override with --vram)"
    fi
fi

probe() { # $1 = num_ctx -> prints "total_bytes vram_bytes"
    curl -sf -m 900 -X POST "$HOST/api/generate" \
        -H 'content-type: application/json' \
        -d "{\"model\":\"$MODEL\",\"prompt\":\"hi\",\"stream\":false,\"keep_alive\":\"2m\",\"options\":{\"num_ctx\":$1,\"num_predict\":1}}" \
        >/dev/null || { echo "load failed at num_ctx=$1 - the model may not fit even here" >&2; exit 1; }
    # One line per model entry. Splitting on every "{" instead would put
    # "size" and "size_vram" on different lines, because details:{...} sits
    # between them.
    curl -sf -m 30 "$HOST/api/ps" | sed 's/{"name":/\n&/g' | grep -F "\"$MODEL\"" | head -1 |
        sed -n 's/.*"size":\([0-9]*\).*"size_vram":\([0-9]*\).*/\1 \2/p'
}

echo "probing $MODEL at num_ctx=$LOW ..."
LOW_OUT=$(probe "$LOW")
echo "probing $MODEL at num_ctx=$HIGH ..."
HIGH_OUT=$(probe "$HIGH")

# release the card again; leaving a model pinned is rude on a shared box
curl -sf -m 60 -X POST "$HOST/api/generate" -H 'content-type: application/json' \
    -d "{\"model\":\"$MODEL\",\"keep_alive\":0}" >/dev/null 2>&1 || true

[ -n "$LOW_OUT" ] && [ -n "$HIGH_OUT" ] || { echo "could not read /api/ps for $MODEL" >&2; exit 1; }

REPORT=$(awk -v lo="$LOW" -v hi="$HIGH" -v lo_out="$LOW_OUT" -v hi_out="$HIGH_OUT" -v vram="$VRAM_GB" -v model="$MODEL" '
BEGIN {
    split(lo_out, a, " "); split(hi_out, b, " ");
    lo_total = a[1]; lo_vram = a[2];
    hi_total = b[1]; hi_vram = b[2];

    slope = (hi_total - lo_total) / (hi - lo);          # bytes per token
    base  = lo_total - slope * lo;                      # weights + fixed buffers

    # Ollama refuses to place a model that would not comfortably fit, so aim
    # below the nameplate figure rather than at it.
    budget = vram * 1000000000 * 0.90;

    printf "\n%s\n", model;
    printf "  weights + fixed buffers : %.1f GB\n", base / 1e9;
    printf "  context cost            : %.1f MB per 1k tokens\n", slope * 1024 / 1e6;
    printf "  at num_ctx %-13d: %.1f GB total, %.1f GB in VRAM\n", lo, lo_total/1e9, lo_vram/1e9;
    printf "  at num_ctx %-13d: %.1f GB total, %.1f GB in VRAM\n", hi, hi_total/1e9, hi_vram/1e9;

    if (base >= budget) {
        printf "\n  This model does not fit in %d GB at any context - its weights alone\n", vram;
        printf "  exceed the budget. It will run with layers in system RAM: slower, but\n";
        printf "  fine for an MoE, painful for a dense model. Context is nearly free in\n";
        printf "  that mode, so pick a window you actually want.\n";
        exit;
    }

    max_ctx = (budget - base) / slope;
    # Round down to a 4k multiple rather than a power of two: any num_ctx is
    # legal, and powers of two throw away up to half the headroom when the
    # real ceiling lands just above one.
    p = int(max_ctx / 4096) * 4096;
    if (p < 2048) p = 2048;

    printf "\n  Recommended num_ctx     : %d\n", p;
    printf "  (fully resident up to roughly %d tokens)\n", int(max_ctx);
    if (p >= 131072) printf "  That is at or beyond most models trained maximum - check ollama show %s.\n", model;
    printf "\nSet it per seat in RSConclave, or bake it in for every client:\n";
    printf "  printf '"'"'FROM %s\\nPARAMETER num_ctx %d\\n'"'"' > mf && ollama create %s -f mf\n", model, p, model;
}')
printf '%s\n' "$REPORT"

# --apply: do the bake ourselves. The number is parsed back out of the report
# rather than computed a second time, so what gets applied is BY CONSTRUCTION
# what was shown - two code paths deriving it independently is how they drift.
if [ "$APPLY" -eq 1 ]; then
    REC=$(printf '%s\n' "$REPORT" | sed -n 's/.*Recommended num_ctx *: *\([0-9][0-9]*\).*/\1/p')
    if [ -z "$REC" ]; then
        echo "apply: nothing to apply - the model does not fit this budget at any context" >&2
        exit 1
    fi
    command -v ollama >/dev/null 2>&1 || { echo "apply: the ollama CLI is required for --apply" >&2; exit 1; }
    MF=$(mktemp)
    printf 'FROM %s\nPARAMETER num_ctx %s\n' "$MODEL" "$REC" > "$MF"
    # Same name on purpose: every client of this daemon gets the new default.
    # OLLAMA_HOST is set from --host so the CLI talks to the same box we measured.
    echo ""
    echo "applying: ollama create $MODEL (num_ctx $REC)"
    if ! OLLAMA_HOST="$HOST" ollama create "$MODEL" -f "$MF"; then
        rm -f "$MF"
        echo "apply: ollama create failed" >&2
        exit 1
    fi
    rm -f "$MF"
    echo "done - $MODEL now defaults to num_ctx $REC for every client"
fi
