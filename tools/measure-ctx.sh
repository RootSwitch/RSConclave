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
# The budget is what is FREE on the card, not what is printed on the box.
# Those are the same number only when nothing else is loaded, and in a council
# they routinely are not: a model stays resident for its keep_alive after its
# turn, so the next one to load finds less room than an idle-box measurement
# promised. A num_ctx that is genuinely safe standalone can then spill to
# system RAM when it runs third in line. --assume-empty restores the old
# behaviour of sizing against the whole card.
#
# The model being measured is unloaded first, so its own footprint never
# counts against its own budget.
#
# Usage:
#   ./measure-ctx.sh MODEL [--host URL] [--vram GB] [--low N] [--high N]
#                          [--assume-empty] [--apply]
#
#   --host          Ollama base URL   (default: http://127.0.0.1:11434)
#                   A remote host is fine - every step here is HTTP, --apply
#                   included - but --vram becomes required, because VRAM
#                   detection can only see the card in this machine.
#   --vram          usable VRAM budget in GB - skips detection entirely
#   --low           small probe context      (default: 2048)
#   --high          large probe context      (default: 8192)
#   --assume-empty  budget against total VRAM rather than what is free now
#   --apply         bake the recommended num_ctx into the model via ollama create
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
ASSUME_EMPTY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --host) HOST=$2; shift 2 ;;
        --vram) VRAM_GB=$2; shift 2 ;;
        --low)  LOW=$2; shift 2 ;;
        --high) HIGH=$2; shift 2 ;;
        --assume-empty) ASSUME_EMPTY=1; shift ;;
        --apply) APPLY=1; shift ;;
        -h|--help) sed -n '2,41p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "unknown option: $1" >&2; exit 2 ;;
        *)  MODEL=$1; shift ;;
    esac
done

[ -n "$MODEL" ] || { echo "usage: $0 MODEL [--host URL] [--vram GB]" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

# Both vendors report total and free; print "total_mb free_mb". The ROCm
# columns are found by header name rather than position, because the order
# has moved between rocm-smi versions and a positional guess that lands on
# "used" instead of "total" is wrong by the whole card.
gpu_mem() {
    if command -v nvidia-smi >/dev/null 2>&1; then
        nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits 2>/dev/null |
            head -1 | awk -F, '{gsub(/ /,""); print $1, $2}'
    elif command -v rocm-smi >/dev/null 2>&1; then
        rocm-smi --showmeminfo vram --csv 2>/dev/null | awk -F, '
            NR==1 { for (i=1;i<=NF;i++) { if ($i ~ /Total Memory/) t=i; if ($i ~ /Used Memory/) u=i } next }
            NR==2 && t { printf "%d %d\n", int($t/1048576), u ? int(($t-$u)/1048576) : 0 }'
    fi
}

# Everything else in this script talks to --host over HTTP, so it works fine
# against a remote daemon - including --apply, since a Modelfile whose FROM is
# a model NAME is resolved by the daemon out of its own blobs, with nothing
# uploaded. gpu_mem is the single exception: nvidia-smi and rocm-smi describe
# the card in THIS machine. Point --host at another box and detection would
# quietly budget a remote model against the local card and print a confident
# number for a machine it never looked at. A wrong answer that looks right is
# worse than no answer, so a remote host has to state its budget.
# Stripping the port with a trailing-":digits" regex cannot be done after the
# IPv6 brackets come off: it then eats the ":1" of "::1". The forms are
# distinguished up front instead.
host_of() {
    h=$(printf '%s' "$1" | sed -e 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' -e 's|/.*$||')
    case "$h" in
        \[*\]*) h=${h#\[}; h=${h%%\]*} ;; # [::1]:11434
        *:*:*)  ;;                        # bare IPv6, which cannot carry a port
        *)      h=${h%:*} ;;              # host:port, or a bare host untouched
    esac
    printf '%s' "$h"
}

is_local_host() {
    case "$1" in
        ''|localhost|localhost.localdomain|127.*|::1|0.0.0.0) return 0 ;;
    esac
    [ "$1" = "$(hostname 2>/dev/null)" ]
}

# Unload the model being measured BEFORE reading free VRAM. Left resident from
# an earlier run it would count against its own budget, and the script would
# recommend a window sized for the space left over beside itself.
unload() {
    curl -sf -m 60 -X POST "$HOST/api/generate" -H 'content-type: application/json' \
        -d "{\"model\":\"$MODEL\",\"keep_alive\":0}" >/dev/null 2>&1 || true
}

# What else is holding the card, so a small budget explains itself instead of
# just looking like a disappointing number.
others() {
    curl -sf -m 30 "$HOST/api/ps" 2>/dev/null | sed 's/{"name":/\n&/g' |
        sed -n 's/.*{"name":"\([^"]*\)".*/\1/p' | grep -Fxv "$MODEL" || true
}

if [ -z "$VRAM_GB" ]; then
    TARGET=$(host_of "$HOST")
    if ! is_local_host "$TARGET"; then
        echo "$TARGET is a different machine, and VRAM detection only sees this one." >&2
        echo "Everything else here works remotely - probing, the trained maximum, and" >&2
        echo "--apply - so state the budget and the rest of the run is unchanged:" >&2
        echo "" >&2
        echo "  $0 $MODEL --host $HOST --vram GB" >&2
        echo "" >&2
        echo "Its free VRAM, from that box:  nvidia-smi --query-gpu=memory.free --format=csv" >&2
        echo "Or run this script on that box, where detection works." >&2
        exit 2
    fi
    unload
    # Freeing VRAM is not instant; wait for the model to actually leave /api/ps
    # rather than sleeping a guessed interval.
    i=0
    while [ $i -lt 20 ]; do
        curl -sf -m 10 "$HOST/api/ps" 2>/dev/null | grep -qF "\"$MODEL\"" || break
        i=$((i + 1))
        sleep 1
    done

    MEM=$(gpu_mem || true)
    TOTAL_MB=$(printf '%s' "${MEM:-}" | awk '{print $1+0}')
    FREE_MB=$(printf '%s' "${MEM:-}" | awk '{print $2+0}')

    if [ "${TOTAL_MB:-0}" -gt 0 ] 2>/dev/null; then
        if [ "$ASSUME_EMPTY" -eq 1 ]; then
            VRAM_GB=$((TOTAL_MB / 1024))
            BASIS=empty
            echo "detected $((TOTAL_MB / 1024)) GB of VRAM; sizing for an empty card (--assume-empty)"
        else
            VRAM_GB=$((FREE_MB / 1024))
            BASIS=free
            echo "detected $((TOTAL_MB / 1024)) GB of VRAM, $((FREE_MB / 1024)) GB free"
            RESIDENT=$(others)
            if [ -n "$RESIDENT" ]; then
                echo "  still loaded, and holding the rest:"
                printf '    %s\n' $RESIDENT
                echo "  budgeting against free VRAM. Unload them, or pass --assume-empty"
                echo "  to size for an idle card."
            fi
            if [ "$VRAM_GB" -lt 1 ]; then
                echo "less than 1 GB free - unload something, or pass --vram GB" >&2
                exit 1
            fi
        fi
    else
        VRAM_GB=24
        BASIS=guessed
        echo "could not detect VRAM; assuming ${VRAM_GB} GB (override with --vram)"
    fi
else
    BASIS=stated
    echo "using the stated budget of ${VRAM_GB} GB (--vram)"
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

# The trained maximum, so the recommendation can be capped by it. A model
# with sliding-window or hybrid attention costs almost nothing per token, and
# extrapolating that slope recommended (and with --apply, BAKED) a num_ctx of
# 1.2 million into a model trained for far less. The warning that printed
# alongside was not a substitute for just not doing it.
TRAINED=$(curl -sf -m 30 -X POST "$HOST/api/show" -H 'content-type: application/json'     -d "{\"model\":\"$MODEL\"}" | grep -o '"[^"]*\.context_length":[0-9]*' | head -1 | grep -o '[0-9]*$')
[ -n "$TRAINED" ] || TRAINED=0

echo "probing $MODEL at num_ctx=$LOW ..."
LOW_OUT=$(probe "$LOW")
echo "probing $MODEL at num_ctx=$HIGH ..."
HIGH_OUT=$(probe "$HIGH")

# release the card again; leaving a model pinned is rude on a shared box
unload

[ -n "$LOW_OUT" ] && [ -n "$HIGH_OUT" ] || { echo "could not read /api/ps for $MODEL" >&2; exit 1; }

REPORT=$(awk -v lo="$LOW" -v hi="$HIGH" -v lo_out="$LOW_OUT" -v hi_out="$HIGH_OUT" -v vram="$VRAM_GB" -v model="$MODEL" -v trained="$TRAINED" -v basis="$BASIS" '
# 262144 reads as noise next to 1216512 - a missing digit hides in plain
# sight, which is how a 1.2M recommendation got waved through as "about
# 100k-ish". Numbers keep their raw form (the --apply grep depends on the
# integer coming first) with the human name alongside.
function fmt(n) {
    if (n >= 1048576) return sprintf("%.1fM", n / 1048576);
    if (n >= 1024)    return sprintf("%dk", int(n / 1024 + 0.5));
    return sprintf("%d", n);
}
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

    # VRAM is only one ceiling; the training window is the other. Past it the
    # model does not work at that length no matter how much memory is free,
    # so the smaller of the two is the honest answer - and the one --apply
    # bakes in.
    if (trained > 0 && p > trained) {
        p = int(trained / 4096) * 4096;
        if (p < 2048) p = trained;
        printf "\n  Recommended num_ctx     : %d  (%s - capped at the trained maximum)\n", p, fmt(p);
        printf "  (VRAM alone would allow roughly %s tokens - the model would not)\n", int(max_ctx) >= 0 ? fmt(int(max_ctx)) : "?";
    } else {
        printf "\n  Recommended num_ctx     : %d  (%s)\n", p, fmt(p);
        printf "  (fully resident up to roughly %s tokens)\n", fmt(int(max_ctx));
    }
    if (trained == 0 && p >= 131072) printf "  Could not read the trained maximum - check ollama show %s before trusting this.\n", model;
    # Say which card the number describes, and do not claim to have measured
    # a budget that was stated or guessed. Sized against free VRAM it holds
    # only while the card stays this free - load something else beside it and
    # the model spills, which is the failure this flag exists to describe.
    if (basis == "empty")
        printf "  Sized for an EMPTY %d GB card - it will spill if anything else is loaded.\n", vram;
    else if (basis == "stated")
        printf "  Sized against the stated budget of %d GB (--vram).\n", vram;
    else if (basis == "guessed")
        printf "  Sized against an ASSUMED %d GB - VRAM could not be detected.\n", vram;
    else
        printf "  Sized against the %d GB free at measurement time.\n", vram;
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
