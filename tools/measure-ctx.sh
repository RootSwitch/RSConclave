#!/bin/sh
# measure-ctx.sh - find the largest num_ctx a model can hold without spilling.
#
# The app does this too, without a terminal: Settings > an Ollama endpoint >
# Context sizing. Same method and same arithmetic (server/measure.ts), for
# the person whose whole setup is Ollama and RSConclave on one Windows box.
# This script stays for scripting it, and for boxes with no app on them.
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
#   --apply         bake the recommended num_ctx into the model, via the daemon's
#                   own /api/create - HTTP only, no ollama CLI needed anywhere
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
        # Bounded by where the header actually ends rather than a line number:
        # the fixed "2,41p" silently truncated mid-options the moment four
        # lines were added at the top, hiding the description of --apply.
        -h|--help) sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "unknown option: $1" >&2; exit 2 ;;
        *)  MODEL=$1; shift ;;
    esac
done

[ -n "$MODEL" ] || { echo "usage: $0 MODEL [--host URL] [--vram GB]" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

# /api/ps and /api/tags always report a fully qualified name, so a model asked
# for as "gemma3" comes back as "gemma3:latest" and an exact match on what was
# typed finds nothing - the run then dies at the end with "could not read
# /api/ps", after both slow probe loads have already happened. Requests still
# send MODEL, which the daemon resolves either way; only matching uses PS_NAME.
case "$MODEL" in
    *:*) PS_NAME=$MODEL ;;
    *)   PS_NAME=$MODEL:latest ;;
esac

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
        sed -n 's/.*{"name":"\([^"]*\)".*/\1/p' | grep -Fxv "$PS_NAME" || true
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
        echo "Free VRAM, read on that box:" >&2
        echo "  nvidia-smi --query-gpu=memory.free --format=csv   (NVIDIA)" >&2
        echo "  rocm-smi --showmeminfo vram                       (AMD, Linux)" >&2
        echo "  Task Manager > Performance > GPU                  (Windows, either vendor)" >&2
        echo "" >&2
        echo "On Windows the desktop is holding some of the card, so the free figure" >&2
        echo "is the one to use and it moves while you use the machine." >&2
        exit 2
    fi
    unload
    # Freeing VRAM is not instant; wait for the model to actually leave /api/ps
    # rather than sleeping a guessed interval.
    i=0
    while [ $i -lt 20 ]; do
        curl -sf -m 10 "$HOST/api/ps" 2>/dev/null | grep -qF "\"$PS_NAME\"" || break
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
    curl -sf -m 30 "$HOST/api/ps" | sed 's/{"name":/\n&/g' | grep -F "\"$PS_NAME\"" | head -1 |
        sed -n 's/.*"size":\([0-9]*\).*"size_vram":\([0-9]*\).*/\1 \2/p'
}

# The trained maximum, so the recommendation can be capped by it. A model
# with sliding-window or hybrid attention costs almost nothing per token, and
# extrapolating that slope recommended (and with --apply, BAKED) a num_ctx of
# 1.2 million into a model trained for far less. The warning that printed
# alongside was not a substitute for just not doing it.
TRAINED=$(curl -sf -m 30 -X POST "$HOST/api/show" -H 'content-type: application/json'     -d "{\"model\":\"$MODEL\"}" | grep -o '"[^"]*\.context_length":[0-9]*' | head -1 | grep -o '[0-9]*$')
[ -n "$TRAINED" ] || TRAINED=0

# Refuse to load something that provably cannot fit. Weights occupy at least
# what they occupy on disk, so /api/tags settles the hopeless cases for the
# price of one GET - before anything is read into memory. Loading them anyway
# is not a slow measurement: it is the box paging itself into the ground for
# several minutes to discover what the file listing already said.
#
# Only clear-cut cases are refused. The disk size is a LOWER bound, so a model
# that merely looks tight is still measured - those are the interesting ones.
DISK=$(curl -sf -m 20 "$HOST/api/tags" 2>/dev/null | sed 's/{"name":/\n&/g' |
    grep -F "\"$PS_NAME\"" | head -1 | sed -n 's/.*"size":\([0-9]*\).*/\1/p')
# Compared against the WHOLE card, not the safety-reduced budget. The
# pre-flight exists to catch the hopeless, not the tight: a model just over
# the margin still has something worth measuring, and refusing it would
# answer a question it was never asked. An MoE slightly over the line is
# the case that matters - it runs fine with a few layers in RAM.
CAPACITY=$(awk -v v="$VRAM_GB" 'BEGIN{ printf "%d", v * 1073741824 }')
if [ -n "${DISK:-}" ] && [ "$DISK" -ge "$CAPACITY" ] 2>/dev/null; then
    awk -v d="$DISK" -v b="$CAPACITY" -v m="$MODEL" 'BEGIN{
        printf "\n%s\n", m;
        printf "  %.1f GB on disk, against a %.1f GB card.\n", d/1073741824, b/1073741824;
        printf "  The weights alone exceed the budget, so it would run partly in system\n";
        printf "  RAM whatever num_ctx says. Not loaded - that would only page.\n" }'
    exit 0
fi

echo "probing $MODEL at num_ctx=$LOW ..."
LOW_OUT=$(probe "$LOW")
echo "probing $MODEL at num_ctx=$HIGH ..."
HIGH_OUT=$(probe "$HIGH")

# release the card again; leaving a model pinned is rude on a shared box
unload

[ -n "$LOW_OUT" ] && [ -n "$HIGH_OUT" ] || { echo "could not read /api/ps for $PS_NAME" >&2; exit 1; }

REPORT=$(awk -v lo="$LOW" -v hi="$HIGH" -v lo_out="$LOW_OUT" -v hi_out="$HIGH_OUT" -v vram="$VRAM_GB" -v model="$MODEL" -v trained="$TRAINED" -v basis="$BASIS" -v host="$HOST" '
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
    #
    # GiB, not 1e9. nvidia-smi and rocm-smi report MiB, and the detection above
    # divides by 1024 - so VRAM_GB has always been GiB, and multiplying it by
    # 1e9 under-counted a 24 GB card by 1.8 GB. That turned this 0.90 into a
    # real margin of about 0.84, which is why 0.85 is the factor now: the
    # effective headroom is unchanged, the arithmetic just stopped lying about
    # where it came from. A "24 GB" card is 24 GiB, and Task Manager agrees.
    budget = vram * 1073741824 * 0.85;

    printf "\n%s\n", model;
    printf "  weights + fixed buffers : %.1f GB\n", base / 1073741824;
    printf "  context cost            : %.1f MB per 1k tokens\n", slope * 1024 / 1048576;
    printf "  at num_ctx %-13d: %.1f GB total, %.1f GB in VRAM\n", lo, lo_total/1073741824, lo_vram/1073741824;
    printf "  at num_ctx %-13d: %.1f GB total, %.1f GB in VRAM\n", hi, hi_total/1073741824, hi_vram/1073741824;

    if (base >= budget) {
        # Two different situations reach here, and calling both "runs in system
        # RAM" contradicts the probe lines printed directly above. If the card
        # actually held all of it (size_vram == size), it fits - it just leaves
        # no safety margin. Saying otherwise sends someone off to buy a bigger
        # card for a model already running entirely on the one they have.
        if (lo_vram >= lo_total * 0.999) {
            printf "\n  Fits the card, but not with a margin. The weights are %.1f GB against a\n", base / 1073741824;
            printf "  budget of %.1f GB, yet the probe above shows all of it resident. Usable\n", budget / 1073741824;
            printf "  at a small window with nothing spare - one more model, or a desktop\n";
            printf "  that gets busy, and it starts spilling. Bake a window only if you\n";
            printf "  accept that. --assume-empty sizes for the whole card if this box is\n";
            printf "  headless.\n";
        } else {
            printf "\n  This model does not fit in %d GB at any context - its weights alone\n", vram;
            printf "  exceed the budget, and the probe confirms only %.1f of %.1f GB reached\n", lo_vram/1073741824, lo_total/1073741824;
            printf "  the card. It runs with layers in system RAM: slower, but fine for an\n";
            printf "  MoE, painful for a dense model. Context is nearly free in that mode,\n";
            printf "  so pick a window you actually want.\n";
        }
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
    # The manual form is curl rather than `ollama create` because it works
    # from anywhere the measurement itself worked: a box that can reach 11434
    # and has no CLI installed can still bake the number in.
    printf "\nSet it per seat in RSConclave, or bake it in for every client of this daemon\n";
    printf "by re-running with --apply, which is exactly:\n";
    # This whole awk program is inside shell single quotes, so every literal
    # single quote in the output has to leave and re-enter them: '"'"'.
    printf "  curl -X POST %s/api/create -H '"'"'content-type: application/json'"'"' \\\n", host;
    printf "    -d '"'"'{\"model\":\"%s\",\"from\":\"%s\",\"parameters\":{\"num_ctx\":%d},\"stream\":false}'"'"'\n", model, model, p;
}')
printf '%s\n' "$REPORT"

# Verify the recommendation by loading at it, and walk it down until the card
# takes the whole model.
#
# The slope from two small probes is a MODEL, and it over-promises badly. On a
# 24 GB 7900XTX this recommended num_ctx 176128 for qwen3.6:27b; loading at it
# put 58% on the card and 15 t/s on the clock, against 60 t/s at a window that
# fits. Ollama decides its layer split at load time from its own estimate, and
# /api/ps "size" understates what that reserves once the context is large -
# neither is visible from the low end of the curve. So the answer stops being
# extrapolated and starts being confirmed.
REC=$(printf '%s\n' "$REPORT" | sed -n 's/.*Recommended num_ctx *: *\([0-9][0-9]*\).*/\1/p')
if [ -n "$REC" ] && [ "$REC" -gt "$HIGH" ] 2>/dev/null; then
    # Three answers, not two. An empty /api/ps read - a transient miss, or a
    # model still settling after a long load - printed NOTHING, which is not
    # equal to "0", so the caller's `= "0"` test fell through to the success
    # branch and announced "confirmed resident" having verified nothing. A
    # check that cannot fail closed is not a check.
    resident_at() { # num_ctx -> yes | no | unknown
        probe "$1" | awk 'NF >= 2 { print ($2 >= $1 * 0.999 && $1 > 0) ? "yes" : "no"; seen = 1 }
                          END { if (!seen) print "unknown" }'
    }
    echo ""
    echo "verifying at num_ctx=$REC ..."
    VERDICT=$(resident_at "$REC")
    if [ "$VERDICT" = "unknown" ]; then
        echo "  could not read /api/ps after loading at $REC - NOT verified."
        echo "  Leaving the arithmetic's answer in place; re-run to check it."
    elif [ "$VERDICT" = "no" ]; then
        LO=$HIGH; HI=$REC
        # Four steps narrows the usual gap below the 4k the answer is rounded
        # to; more would cost a model load each for precision nobody reports.
        i=0
        while [ $i -lt 4 ] && [ $((HI - LO)) -gt 4096 ]; do
            MID=$(( ((LO + HI) / 2 / 4096) * 4096 ))
            [ "$MID" -le "$LO" ] && break
            [ "$MID" -ge "$HI" ] && break
            printf "  trying num_ctx=%s ... " "$MID"
            # Reported after the probe, not before it: printing a fixed
            # "spilled" up front described the PREVIOUS step and called
            # every resident midpoint a failure.
            V=$(resident_at "$MID")
            # Only an explicit "yes" moves the floor up. An unreadable probe
            # must narrow from the cautious side, never widen the claim.
            if [ "$V" = "yes" ]; then LO=$MID; echo "resident"; else HI=$MID; echo "$V"; fi
            i=$((i + 1))
        done
        echo ""
        echo "  Verified num_ctx        : $LO"
        echo "  ($REC was the arithmetic's answer; the card only took part of it."
        echo "   It spills at $HI. Baking the verified figure instead.)"
        REC=$LO
    else
        echo "  confirmed resident at $REC."
    fi
    unload
fi

# --apply: do the bake ourselves. The number is parsed back out of the report
# rather than computed a second time, so what gets applied is BY CONSTRUCTION
# what was shown - two code paths deriving it independently is how they drift.
if [ "$APPLY" -eq 1 ]; then
    # REC is already set above: parsed from the report, then REPLACED by the
    # verified figure when loading at it showed the card spilling. Re-deriving
    # it here would discard that and bake the number just disproved.
    if [ -z "$REC" ]; then
        echo "apply: nothing to apply - the model does not fit this budget at any context" >&2
        exit 1
    fi
    # POST /api/create rather than shelling out to `ollama create`. The CLI was
    # this script's only local dependency and the only step that could not run
    # from a machine which reaches the daemon over the network and nothing
    # else - the normal arrangement for a headless GPU box driven from
    # somewhere, and the exact case a remote --host exists to serve.
    #
    # Same name on purpose: every client of this daemon gets the new default,
    # not just the app. FROM names a model rather than a file, so the daemon
    # resolves it out of its own blobs - a new manifest over the same weights,
    # with nothing uploaded and nothing re-quantised.
    echo ""
    echo "applying: num_ctx $REC to $MODEL on $HOST"

    create_post() {
        curl -s -m 300 -X POST "$HOST/api/create" \
            -H 'content-type: application/json' -d "$1" 2>/dev/null
    }

    # Ollama renamed these fields; older daemons take a flat Modelfile string
    # under "modelfile". Trying the current shape first and falling back keeps
    # one script working against a fleet that upgrades at different times.
    OUT=$(create_post "{\"model\":\"$MODEL\",\"from\":\"$MODEL\",\"parameters\":{\"num_ctx\":$REC},\"stream\":false}")
    case "$OUT" in
        *'"status":"success"'*) ;;
        *)
            OUT2=$(create_post "{\"name\":\"$MODEL\",\"modelfile\":\"FROM $MODEL\\nPARAMETER num_ctx $REC\",\"stream\":false}")
            case "$OUT2" in
                *'"status":"success"'*) ;;
                *)
                    echo "apply: create failed on $HOST" >&2
                    [ -n "$OUT" ]  && echo "  current shape: $OUT" >&2
                    [ -n "$OUT2" ] && echo "  legacy shape : $OUT2" >&2
                    exit 1 ;;
            esac ;;
    esac
    echo "done - $MODEL now defaults to num_ctx $REC for every client of $HOST"
fi
