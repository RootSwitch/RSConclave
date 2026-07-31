#!/usr/bin/env bash
# install-ollama.sh - stand up Ollama as a network inference service.
#
# The companion to tools/install.sh: that one deploys RSConclave, this one
# prepares the box it talks to. It verifies the GPU driver is actually working,
# installs Ollama via the official installer, writes a systemd drop-in for the
# settings that matter on a shared box (bind address, model directory,
# keep-alive), restarts the service, waits for the API to answer, and then
# checks the one thing that saves the most grief afterwards: whether inference
# landed on the GPU or silently fell back to CPU.
#
# SAFE TO RE-RUN. It skips the installer when ollama already exists (use
# --update to force it), regenerates only its own drop-in file, and never
# touches models already on disk.
#
# Usage:
#   ./tools/install-ollama.sh [options]
#
#   --gpu nvidia|amd|cpu  skip detection and assert the vendor
#   --models DIR          store model blobs here (OLLAMA_MODELS)
#   --keep-alive DUR      how long a model stays resident (default: 5m)
#   --allow-from ADDR     firewall: allow this host/CIDR to port 11434 (repeatable)
#   --local-only          bind 127.0.0.1 instead of 0.0.0.0
#   --hsa-override VER    AMD consumer cards: HSA_OVERRIDE_GFX_VERSION value
#   --pull MODEL          pull a model afterwards and run a one-line smoke test
#   --tune                after --pull: measure the model's real per-token VRAM
#                         cost and bake the largest fully-resident num_ctx into
#                         it (tools/measure-ctx.sh --apply). Ollama defaults to
#                         a 4096 window and silently truncates overflow from the
#                         front, so an untuned model quietly loses its system
#                         prompt in long conversations - this closes that trap
#                         at install time.
#   --update              re-run the official installer even if ollama exists
#
# Worked examples.
#
#   First run on any box - prove the whole path with a model that pulls in a
#   minute, before spending twenty on one that might not fit:
#     ./tools/install-ollama.sh --pull llama3.2:3b --allow-from 192.168.1.0/24
#
#   AMD, RX 7900 XTX (gfx1100, 24 GB). Officially ROCm-supported, so no
#   override; 24 GB comfortably holds a 32B at Q4:
#     ./tools/install-ollama.sh --gpu amd --pull llama3.2:3b
#     ./tools/install-ollama.sh --pull qwen2.5:32b --tune
#
#   AMD, RX 9060 XT (gfx1201, 16 GB). RDNA4, so the override may be needed -
#   run it without one FIRST and let the script tell you, rather than setting a
#   value pre-emptively that could break a card which was working:
#     ./tools/install-ollama.sh --gpu amd --pull llama3.2:3b
#     # only if that reports "no compatible GPUs":
#     ./tools/install-ollama.sh --gpu amd --hsa-override 12.0.0 --pull llama3.2:3b
#
# Driver installation is deliberately NOT attempted. A driver install wants a
# reboot in the middle, which is a terrible thing for a script to spring on
# someone - docs/inference-host.md walks through it for NVIDIA and AMD. This
# script's job is to refuse loudly when the driver is not ready, because the
# alternative is Ollama quietly running your 30B model on the CPU at one token
# a second and nothing anywhere saying why.
set -euo pipefail

GPU=""
MODELS_DIR=""
KEEP_ALIVE="5m"
ALLOW_FROM=()
BIND_ADDR="0.0.0.0"
HSA_OVERRIDE=""
PULL_MODEL=""
TUNE=0
UPDATE=0

# Test seam: prefixes the /etc and /dev paths so the stub harness can exercise
# every branch without root or a real systemd. Empty in real use.
INSTALL_ROOT="${INSTALL_ROOT:-}"

while [ $# -gt 0 ]; do
    case "$1" in
        --gpu)          GPU=$2; shift 2 ;;
        --models)       MODELS_DIR=$2; shift 2 ;;
        --keep-alive)   KEEP_ALIVE=$2; shift 2 ;;
        --allow-from)   ALLOW_FROM+=("$2"); shift 2 ;;
        --local-only)   BIND_ADDR="127.0.0.1"; shift ;;
        --hsa-override) HSA_OVERRIDE=$2; shift 2 ;;
        --pull)         PULL_MODEL=$2; shift 2 ;;
        --tune)         TUNE=1; shift ;;
        --update)       UPDATE=1; shift ;;
        -h|--help)      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%swarn%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%serror%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

case "$GPU" in ""|nvidia|amd|cpu) : ;; *) die "--gpu must be nvidia, amd or cpu" ;; esac
command -v curl >/dev/null || die "curl is required"
if [ "$TUNE" -eq 1 ] && [ -z "$PULL_MODEL" ]; then
    die "--tune needs --pull MODEL: there has to be a model to measure"
fi

# ----- GPU: detect, then verify the driver actually answers -----------------
if [ -z "$GPU" ]; then
    if ! command -v lspci >/dev/null 2>&1; then
        die "cannot detect the GPU (lspci is missing - package pciutils). Pass --gpu nvidia|amd|cpu instead."
    fi
    PCI=$(lspci 2>/dev/null | grep -Ei 'vga|3d|display' || true)
    if   printf '%s' "$PCI" | grep -qi nvidia; then GPU=nvidia
    elif printf '%s' "$PCI" | grep -qiE 'amd|advanced micro|\bati\b'; then GPU=amd
    else GPU=cpu
    fi
    say "detected GPU vendor: $GPU"
else
    say "GPU vendor asserted: $GPU"
fi

# The check is for a WORKING driver, not installed packages. A GPU the kernel
# cannot talk to gives you the worst failure mode this box has: everything
# starts, everything answers, and generation runs at CPU speed with no error
# anywhere. Refusing here, with the fix named, beats that every time.
case "$GPU" in
    nvidia)
        if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi >/dev/null 2>&1; then
            die "an NVIDIA GPU is present but nvidia-smi does not answer - the driver is not ready.
      Install it first (docs/inference-host.md section 2), reboot, confirm nvidia-smi
      lists the card, then run this again. Or pass --gpu cpu to accept CPU inference."
        fi
        say "nvidia-smi answers - driver is ready"
        ;;
    amd)
        # /dev/kfd is the ROCm compute node: it exists exactly when the amdgpu
        # kernel side is ready for compute. rocm-smi is nice but optional -
        # Ollama ships its own ROCm userspace.
        if [ ! -e "${INSTALL_ROOT}/dev/kfd" ]; then
            die "an AMD GPU is present but ${INSTALL_ROOT}/dev/kfd does not exist - the amdgpu compute
      driver is not ready. Install it first (docs/inference-host.md section 2, the
      amdgpu-install path), reboot, then run this again. Or pass --gpu cpu."
        fi
        say "/dev/kfd exists - amdgpu compute is ready"
        # Which card, in ROCm's own terms.
        #
        # HSA_OVERRIDE_GFX_VERSION exists to lie to ROCm about the gfx target,
        # so knowing the real target turns the override question from guesswork
        # into a lookup. rocminfo is optional - Ollama ships its own ROCm
        # userspace and does not need it - but when present it is the difference
        # between "try these three values" and "try this one".
        GFX=""
        if command -v rocminfo >/dev/null 2>&1; then
            # `|| true` is load-bearing. This runs under `set -euo pipefail`, and
            # grep exits 1 when it matches nothing - so on any box where rocminfo
            # is present but says nothing useful (or is a stub, or lists only CPU
            # agents) the bare assignment ENDED THE SCRIPT, silently, one line
            # after announcing the driver was ready.
            GFX=$(rocminfo 2>/dev/null | grep -oE 'gfx[0-9a-f]+' \
                  | grep -vx 'gfx000' | sort -u | tr '\n' ' ' | sed 's/ *$//' || true)
        fi
        if [ -n "$GFX" ]; then
            say "ROCm gfx target(s): $GFX"
        else
            warn "gfx target unknown (rocminfo is not installed - 'apt install rocminfo' to see it)."
        fi

        # Newest first: gfx1100 would also match a bare gfx11* pattern, so the
        # order matters more than the patterns look like it does.
        case "$GFX" in
            *gfx12*)          GFX_FAM="RDNA4"; GFX_SUGGEST="12.0.0" ;;
            *gfx11*)          GFX_FAM="RDNA3"; GFX_SUGGEST="11.0.0" ;;
            *gfx103*)         GFX_FAM="RDNA2"; GFX_SUGGEST="10.3.0" ;;
            *gfx94*|*gfx90a*) GFX_FAM="CDNA";  GFX_SUGGEST="" ;;
            *)                GFX_FAM="";      GFX_SUGGEST="" ;;
        esac
        # Not `[ -n ... ] && say ...`: a false test returns non-zero, which under
        # `set -e` exits. Same trap as the pipeline above.
        if [ -n "$GFX_FAM" ]; then say "that is $GFX_FAM"; fi

        if [ -n "$HSA_OVERRIDE" ]; then
            say "HSA_OVERRIDE_GFX_VERSION=$HSA_OVERRIDE will be set in the drop-in"
        else
            case "$GFX_FAM" in
                RDNA4)
                    # Deliberately hedged. Whether this works depends on how new
                    # the ROCm build inside your Ollama is, and that is not
                    # something this script can inspect.
                    warn "RDNA4 is recent enough that support depends on the ROCm build bundled"
                    warn "with your Ollama version. If it reports 'no compatible GPUs' below,"
                    warn "re-run with --hsa-override ${GFX_SUGGEST}, and if that fails, 11.0.0."
                    ;;
                RDNA3|CDNA)
                    say "$GFX_FAM is officially supported - an override is usually unnecessary."
                    if [ -n "$GFX_SUGGEST" ]; then
                        say "If Ollama says 'no compatible GPUs' below, try --hsa-override $GFX_SUGGEST."
                    fi
                    ;;
                RDNA2)
                    warn "RDNA2 consumer cards usually need --hsa-override $GFX_SUGGEST."
                    ;;
                *)
                    warn "many consumer AMD cards need --hsa-override"
                    warn "(RDNA4: 12.0.0, RDNA3: 11.0.0, RDNA2: 10.3.0)."
                    warn "If Ollama reports 'no compatible GPUs' below, that is the first thing to try."
                    ;;
            esac
        fi
        ;;
    cpu)
        warn "CPU mode: models will run, MoE models tolerably, dense models very slowly."
        ;;
esac

# ----- how much GPU memory, and therefore which model ------------------------
#
# Reported, never enforced. The point is to answer "what should I pull?" at the
# moment the question comes up, rather than leaving someone to pull a 32B onto a
# 16 GB card and conclude the tool is broken when it crawls. Parsing is guarded
# both ways: a number outside a plausible range is treated as no number at all,
# because a confidently wrong VRAM figure is worse than an absent one.
VRAM_MB=""
case "$GPU" in
    nvidia)
        VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null \
                  | head -1 | tr -dc '0-9' || true)
        ;;
    amd)
        if command -v rocm-smi >/dev/null 2>&1; then
            # rocm-smi's output has changed shape across versions; take the first
            # integer on a line mentioning total, then sanity-check it below.
            VRAM_MB=$(rocm-smi --showmeminfo vram 2>/dev/null \
                      | grep -iE 'total' | grep -oE '[0-9]{4,}' | head -1 || true)
            # Some versions report bytes rather than MB.
            if [ -n "$VRAM_MB" ] && [ "$VRAM_MB" -gt 1048576 ] 2>/dev/null; then
                VRAM_MB=$((VRAM_MB / 1024 / 1024))
            fi
        fi
        ;;
esac
if [ -n "$VRAM_MB" ] && [ "$VRAM_MB" -ge 1024 ] 2>/dev/null && [ "$VRAM_MB" -le 262144 ] 2>/dev/null; then
    VRAM_GB=$((VRAM_MB / 1024))
    say "GPU memory: about ${VRAM_GB} GB"
    if   [ "$VRAM_GB" -ge 32 ]; then FITS="32B at long context, or a 70B dense with care"
    elif [ "$VRAM_GB" -ge 22 ]; then FITS="27B-32B, or a 30B MoE"
    elif [ "$VRAM_GB" -ge 14 ]; then FITS="14B, or a 20B MoE"
    elif [ "$VRAM_GB" -ge 10 ]; then FITS="8B-14B"
    else                             FITS="3B-8B"
    fi
    say "comfortable here: $FITS (docs/inference-host.md section 6 has the table)"
    if [ -z "$PULL_MODEL" ]; then
        # Prove the path with something that pulls in a minute. A first run that
        # fails after a 20 GB download tells you nothing you could not have
        # learned from a 2 GB one.
        say "to verify the whole path first, re-run with: --pull llama3.2:3b"
    fi
elif [ "$GPU" != cpu ]; then
    warn "could not read GPU memory - size models by hand (docs/inference-host.md section 6)."
fi

# ----- Ollama itself ---------------------------------------------------------
if command -v ollama >/dev/null 2>&1 && [ "$UPDATE" -eq 0 ]; then
    say "ollama is already installed ($(ollama --version 2>/dev/null || echo version unknown)) - skipping the installer (--update to force)"
else
    say "running the official Ollama installer"
    curl -fsSL https://ollama.com/install.sh | sh || die "the Ollama installer failed"
fi
command -v ollama >/dev/null 2>&1 || die "ollama is still not on PATH after the installer"

# ----- model directory -------------------------------------------------------
if [ -n "$MODELS_DIR" ]; then
    say "model directory: $MODELS_DIR"
    sudo mkdir -p "$MODELS_DIR"
    # The service runs as the ollama system user the installer created; a
    # root-owned models dir fails on the first pull with a permissions error
    # that never mentions whose fault it is.
    if id ollama >/dev/null 2>&1; then
        sudo chown ollama:ollama "$MODELS_DIR"
    else
        warn "no 'ollama' user exists - leaving ownership of $MODELS_DIR alone"
    fi
else
    # Saying nothing here left the obvious next question - "where is the 20 GB
    # going?" - unanswered in the one place someone is looking. The official
    # installer creates an `ollama` system user whose home is /usr/share/ollama,
    # and the service inherits it, so blobs land on the ROOT filesystem unless
    # told otherwise.
    say "model directory: /usr/share/ollama/.ollama/models (Ollama's default, on the OS disk)"
    # Only nag when it actually matters. `|| true` because df can fail and this
    # runs under `set -e`.
    FREE_GB=$(df -Pk "${INSTALL_ROOT}/" 2>/dev/null | awk 'NR==2 {print int($4/1048576)}' || true)
    if [ -n "$FREE_GB" ] && [ "$FREE_GB" -lt 50 ] 2>/dev/null; then
        warn "about ${FREE_GB} GB free there. A 32B at Q4 is roughly 20 GB, and a pull that"
        warn "runs out of room fails partway rather than politely. Consider --models /mnt/models"
        warn "(docs/inference-host.md section 3), or expand root - Ubuntu's default LVM layout"
        warn "leaves much of the disk unallocated (section 1 has the lvextend)."
    elif [ -n "$FREE_GB" ]; then
        say "about ${FREE_GB} GB free there"
    fi
fi

# ----- systemd drop-in -------------------------------------------------------
# A drop-in named after this project, not an edit to override.conf: re-running
# regenerates OUR file and only ours, so hand-made overrides survive.
DROPIN_DIR="${INSTALL_ROOT}/etc/systemd/system/ollama.service.d"
DROPIN="$DROPIN_DIR/rsconclave.conf"

build_dropin() {
    printf '# Written by tools/install-ollama.sh - edit by re-running it, not by hand.\n'
    printf '[Service]\n'
    printf 'Environment="OLLAMA_HOST=%s:11434"\n' "$BIND_ADDR"
    printf 'Environment="OLLAMA_KEEP_ALIVE=%s"\n' "$KEEP_ALIVE"
    if [ -n "$MODELS_DIR" ]; then printf 'Environment="OLLAMA_MODELS=%s"\n' "$MODELS_DIR"; fi
    if [ -n "$HSA_OVERRIDE" ]; then printf 'Environment="HSA_OVERRIDE_GFX_VERSION=%s"\n' "$HSA_OVERRIDE"; fi
}

if [ -f "$DROPIN" ] && build_dropin | cmp -s - "$DROPIN" 2>/dev/null; then
    say "systemd drop-in already matches - leaving it alone"
else
    if [ -f "$DROPIN" ]; then say "updating systemd drop-in $DROPIN"; else say "writing systemd drop-in $DROPIN"; fi
    sudo mkdir -p "$DROPIN_DIR"
    build_dropin | sudo tee "$DROPIN" >/dev/null
fi

say "restarting ollama"
sudo systemctl daemon-reload
sudo systemctl enable ollama >/dev/null 2>&1 || true
sudo systemctl restart ollama

# ----- wait for the API ------------------------------------------------------
say "waiting for the API on 127.0.0.1:11434"
UP=0
for _ in $(seq 1 30); do
    if curl -sf -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then UP=1; break; fi
    sleep 1
done
if [ "$UP" -ne 1 ]; then
    die "ollama did not answer within 30s - check: journalctl -u ollama -n 50"
fi
say "API answers"

# ----- did inference land on the GPU? ---------------------------------------
# Ollama states its verdict once at startup. Surfacing that line here is the
# difference between finding out now and finding out three days later when a
# "slow model" turns out to have been on the CPU the whole time.
if command -v journalctl >/dev/null 2>&1; then
    COMPUTE=$(sudo journalctl -u ollama --no-pager -n 60 2>/dev/null \
        | grep -iE 'inference compute|no compatible GPUs' | tail -2 || true)
    if [ -n "$COMPUTE" ]; then
        printf '%s\n' "$COMPUTE" | sed 's/^/    /'
    fi
    if printf '%s' "$COMPUTE" | grep -qi 'no compatible GPUs' && [ "$GPU" != cpu ]; then
        warn "Ollama found NO compatible GPU even though the driver checks passed."
        if [ "$GPU" = amd ]; then
            warn "On AMD this is usually the gfx version: re-run with --hsa-override (see docs/inference-host.md)."
        fi
        warn "Everything will work, at CPU speed. Fix this before pulling big models."
    fi
fi

# ----- firewall --------------------------------------------------------------
# Ollama has no authentication, so a wide bind is only safe behind a firewall.
# Rules are added only for hosts you named; nothing is opened to everyone.
# ${#arr[@]} rather than any [@]-expansion guard: a quoted "${arr[@]+set}"
# expands to ZERO words for an empty array, which turns the test into
# [ = set ] and prints "unary operator expected" on every keyless run.
if [ "${#ALLOW_FROM[@]}" -gt 0 ]; then
    if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -qi '^status: active'; then
        for addr in "${ALLOW_FROM[@]}"; do
            say "ufw: allowing $addr to 11434"
            sudo ufw allow from "$addr" to any port 11434 proto tcp >/dev/null
        done
    elif command -v firewall-cmd >/dev/null 2>&1 && sudo firewall-cmd --state >/dev/null 2>&1; then
        for addr in "${ALLOW_FROM[@]}"; do
            say "firewalld: allowing $addr to 11434"
            sudo firewall-cmd --permanent \
                --add-rich-rule="rule family=ipv4 source address=$addr port port=11434 protocol=tcp accept" >/dev/null
        done
        sudo firewall-cmd --reload >/dev/null
    else
        warn "no active ufw or firewalld found - add the equivalent rules in whatever this box uses:"
        for addr in "${ALLOW_FROM[@]}"; do
            warn "  allow $addr -> tcp/11434"
        done
    fi
elif [ "$BIND_ADDR" = "0.0.0.0" ]; then
    warn "bound to 0.0.0.0 with no --allow-from rules. Ollama has NO authentication;"
    warn "restrict port 11434 to the hosts that need it, e.g.:"
    warn "  sudo ufw allow from <rsconclave-host> to any port 11434 proto tcp"
fi

# ----- optional starter model ------------------------------------------------
if [ -n "$PULL_MODEL" ]; then
    say "pulling $PULL_MODEL (this is the slow part)"
    ollama pull "$PULL_MODEL" || die "pull failed"
    say "smoke test: one short generation"
    REPLY=$(curl -sf -m 300 http://127.0.0.1:11434/api/generate \
        -H 'content-type: application/json' \
        -d "{\"model\":\"$PULL_MODEL\",\"prompt\":\"Say ready.\",\"stream\":false,\"options\":{\"num_predict\":8}}" \
        | sed -n 's/.*"response":"\([^"]*\)".*/\1/p' || true)
    if [ -n "$REPLY" ]; then say "model answered: $REPLY"; else warn "no reply parsed - check manually with: ollama run $PULL_MODEL"; fi

    if [ "$TUNE" -eq 1 ]; then
        # Chained rather than reimplemented: measure-ctx.sh already knows how
        # to probe, extrapolate and bake, and it lives in the same directory.
        MEASURE="$(cd "$(dirname "$0")" && pwd)/measure-ctx.sh"
        if [ ! -f "$MEASURE" ]; then
            warn "--tune: measure-ctx.sh not found next to this script - run it by hand later"
        else
            say "tuning: measuring $PULL_MODEL's real context cost (loads it twice - takes a while)"
            sh "$MEASURE" "$PULL_MODEL" --apply || warn "tuning failed - the model still works, at Ollama's default window"
        fi
    fi
fi

echo
say "done. Ollama is listening on ${BIND_ADDR}:11434"
if [ "$BIND_ADDR" = "127.0.0.1" ]; then
    warn "--local-only means other machines (and RSConclave in a container) cannot reach it."
fi
say "next: point an RSConclave endpoint at http://<this-box>:11434 (kind: ollama),"
say "and size context windows with tools/measure-ctx.sh once a model is pulled."
