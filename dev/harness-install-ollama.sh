#!/usr/bin/env bash
# Stub harness for tools/install-ollama.sh. Fakes every system command the
# script touches (sudo, systemctl, lspci, nvidia-smi, journalctl, ufw, curl,
# ollama) so every branch runs on a box with no root, no systemd and no GPU -
# including this Windows one. PASS/FAIL per scenario, non-zero exit on failure.
#
# This is how the installer was verified at all: it targets a Linux systemd
# box and was written on a machine that is neither. The stubs prove the logic
# (option handling, drop-in content, idempotency, refusal paths, the full
# --pull --tune chain into measure-ctx.sh --apply); they cannot prove the real
# Ollama installer, systemd, or a GPU behave as stubbed. Run the real thing on
# a disposable box before trusting it anywhere that matters.
#
#   bash dev/harness-install-ollama.sh
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
BIN="$T/bin"
ROOT="$T/root"
LOG="$T/log"
mkdir -p "$BIN" "$ROOT/dev" "$LOG"

fail=0
check() { # label, condition-result
    if [ "$2" = 0 ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=$((fail+1)); fi
}

# ---------- stubs ----------
cat > "$BIN/sudo" <<'EOF'
#!/bin/sh
exec "$@"
EOF
cat > "$BIN/lspci" <<'EOF'
#!/bin/sh
case "${STUB_PCI:-nvidia}" in
  nvidia) echo "01:00.0 VGA compatible controller: NVIDIA Corporation GA102 [Stub]" ;;
  amd)    echo "03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [Stub]" ;;
  none)   echo "00:02.0 Audio device: Stub Audio" ;;
esac
EOF
cat > "$BIN/nvidia-smi" <<'EOF'
#!/bin/sh
case "$*" in
  *memory.total*) echo 24576 ;;
  *) : ;;
esac
exit "${STUB_SMI_EXIT:-0}"
EOF
cat > "$BIN/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "$STUB_LOG/systemctl.log"
exit 0
EOF
cat > "$BIN/journalctl" <<'EOF'
#!/bin/sh
echo "${STUB_JOURNAL:-msg=\"inference compute\" library=cuda name=\"Stub RTX 3090\"}"
EOF
cat > "$BIN/ufw" <<'EOF'
#!/bin/sh
case "$1" in
  status) echo "Status: active" ;;
  *) echo "ufw $*" >> "$STUB_LOG/ufw.log" ;;
esac
exit 0
EOF
cat > "$BIN/ollama" <<'EOF'
#!/bin/sh
echo "ollama $*" >> "$STUB_LOG/ollama.log"
case "$1" in
  --version) echo "ollama version 0.stub" ;;
esac
exit 0
EOF
# curl: the installer fetch, the API poll, the smoke generate, and a /api/ps
# whose footprint GROWS between calls so measure-ctx computes a real slope.
cat > "$BIN/curl" <<'EOF'
#!/bin/sh
args="$*"
case "$args" in
  *ollama.com*) echo 'echo installer-ran >> "$STUB_LOG/installer.log"'; exit 0 ;;
  */api/tags*)  echo '{"models":[]}'; exit 0 ;;
  */api/generate*) echo '{"response":"Ready."}'; exit 0 ;;
  */api/ps*)
    n=$(cat "$STUB_LOG/ps.count" 2>/dev/null || echo 0)
    n=$((n+1)); echo "$n" > "$STUB_LOG/ps.count"
    if [ "$n" -le 1 ]; then size=19000000000; else size=19600000000; fi
    echo "{\"models\":[{\"name\":\"stub:7b\",\"details\":{\"x\":1},\"size\":$size,\"size_vram\":$size}]}"
    exit 0 ;;
  *) exit 0 ;;
esac
EOF
# rocminfo / rocm-smi are OPTIONAL for the script, so both stubs can be made to
# vanish (STUB_NO_ROCMINFO / STUB_NO_ROCMSMI) to prove the absent path too.
cat > "$BIN/rocminfo" <<'EOF'
#!/bin/sh
[ -n "${STUB_NO_ROCMINFO:-}" ] && exit 127
echo "  Name:                    gfx000"
echo "  Marketing Name:          Stub CPU Agent"
echo "  Name:                    ${STUB_GFX:-gfx1100}"
echo "  Marketing Name:          Stub AMD GPU"
EOF
cat > "$BIN/rocm-smi" <<'EOF'
#!/bin/sh
[ -n "${STUB_NO_ROCMSMI:-}" ] && exit 127
case "$*" in
  *showmeminfo*) echo "GPU[0]  : VRAM Total Memory (B): ${STUB_VRAM_B:-25757220864}" ;;
  *) : ;;
esac
exit 0
EOF
chmod +x "$BIN"/*
export PATH="$BIN:$PATH"
export STUB_LOG="$LOG"
export INSTALL_ROOT="$ROOT"
SCRIPT="$REPO/tools/install-ollama.sh"
run() { bash "$SCRIPT" "$@" >"$LOG/out.txt" 2>&1; echo $?; }

echo "=== A: nvidia happy path (--models, --allow-from, ufw) ==="
rc=$(run --models "$T/models" --allow-from 192.0.2.10)
check "exits 0" "$([ "$rc" = 0 ]; echo $?)"
DROPIN="$ROOT/etc/systemd/system/ollama.service.d/rsconclave.conf"
check "drop-in written" "$([ -f "$DROPIN" ]; echo $?)"
check "binds 0.0.0.0" "$(grep -q 'OLLAMA_HOST=0.0.0.0:11434' "$DROPIN"; echo $?)"
check "models dir in drop-in" "$(grep -q "OLLAMA_MODELS=$T/models" "$DROPIN"; echo $?)"
check "daemon-reload + restart" "$(grep -q daemon-reload "$LOG/systemctl.log" && grep -q restart "$LOG/systemctl.log"; echo $?)"
check "ufw rule added" "$(grep -q '192.0.2.10.*11434' "$LOG/ufw.log"; echo $?)"
check "GPU verdict surfaced" "$(grep -q 'inference compute' "$LOG/out.txt"; echo $?)"

echo "=== B: re-run is idempotent ==="
rc=$(run --models "$T/models" --allow-from 192.0.2.10)
check "exits 0 again" "$([ "$rc" = 0 ]; echo $?)"
check "drop-in left alone" "$(grep -q 'already matches' "$LOG/out.txt"; echo $?)"

echo "=== C: broken NVIDIA driver refuses; --gpu cpu overrides ==="
rc=$(STUB_SMI_EXIT=9 run)
check "dies on broken driver" "$([ "$rc" != 0 ]; echo $?)"
check "names the fix" "$(grep -q 'inference-host.md' "$LOG/out.txt"; echo $?)"
rc=$(STUB_SMI_EXIT=9 run --gpu cpu)
check "--gpu cpu proceeds" "$([ "$rc" = 0 ]; echo $?)"

echo "=== D: AMD needs /dev/kfd ==="
rc=$(STUB_PCI=amd run)
check "dies without kfd" "$([ "$rc" != 0 ]; echo $?)"
touch "$ROOT/dev/kfd"
rc=$(STUB_PCI=amd run --hsa-override 11.0.0)
check "proceeds with kfd" "$([ "$rc" = 0 ]; echo $?)"
check "HSA override in drop-in" "$(grep -q 'HSA_OVERRIDE_GFX_VERSION=11.0.0' "$DROPIN"; echo $?)"

echo "=== D2: AMD gfx target detection drives the override advice ==="
# 7900 XTX territory: officially supported, so the script should NOT push an
# override at someone whose card does not need one.
rc=$(STUB_PCI=amd STUB_GFX=gfx1100 run)
check "rdna3 proceeds without override" "$([ "$rc" = 0 ]; echo $?)"
check "rdna3 gfx reported" "$(grep -q 'ROCm gfx target(s): gfx1100' "$LOG/out.txt"; echo $?)"
check "rdna3 named" "$(grep -q 'that is RDNA3' "$LOG/out.txt"; echo $?)"
check "rdna3 not told it needs one" "$(grep -q 'officially supported' "$LOG/out.txt"; echo $?)"

# 9060 XT territory: new enough that the answer is honestly "depends on your
# Ollama", and the advice must say so rather than promise a value works.
rc=$(STUB_PCI=amd STUB_GFX=gfx1201 run)
check "rdna4 proceeds" "$([ "$rc" = 0 ]; echo $?)"
check "rdna4 named" "$(grep -q 'that is RDNA4' "$LOG/out.txt"; echo $?)"
check "rdna4 advice hedged, not promised" "$(grep -q 'depends on the ROCm build' "$LOG/out.txt"; echo $?)"
check "rdna4 gives both fallbacks" "$(grep -q '12.0.0, and if that fails, 11.0.0' "$LOG/out.txt"; echo $?)"

rc=$(STUB_PCI=amd STUB_GFX=gfx1030 run)
check "rdna2 named" "$(grep -q 'that is RDNA2' "$LOG/out.txt"; echo $?)"
check "rdna2 told to override" "$(grep -q 'hsa-override 10.3.0' "$LOG/out.txt"; echo $?)"

# rocminfo missing must degrade to the generic list, not crash or go silent.
rc=$(STUB_PCI=amd STUB_NO_ROCMINFO=1 run)
check "no rocminfo still proceeds" "$([ "$rc" = 0 ]; echo $?)"
check "no rocminfo says so" "$(grep -q 'gfx target unknown' "$LOG/out.txt"; echo $?)"
check "no rocminfo lists all families" "$(grep -q 'RDNA4: 12.0.0, RDNA3: 11.0.0, RDNA2: 10.3.0' "$LOG/out.txt"; echo $?)"

# An explicit override must win over any suggestion machinery.
rc=$(STUB_PCI=amd STUB_GFX=gfx1201 run --hsa-override 12.0.0)
check "explicit override acknowledged" "$(grep -q 'HSA_OVERRIDE_GFX_VERSION=12.0.0 will be set' "$LOG/out.txt"; echo $?)"
check "explicit override suppresses advice" "$([ "$(grep -c 'depends on the ROCm build' "$LOG/out.txt")" = 0 ]; echo $?)"

echo "=== D3: VRAM reporting picks the right model class ==="
# 24 GB (7900 XTX)
rc=$(STUB_PCI=amd STUB_GFX=gfx1100 STUB_VRAM_B=25757220864 run)
check "24GB reported" "$(grep -qE 'GPU memory: about 2[34] GB' "$LOG/out.txt"; echo $?)"
check "24GB suggests 27B-32B" "$(grep -q '27B-32B' "$LOG/out.txt"; echo $?)"
check "suggests a tiny model first" "$(grep -q 'pull llama3.2:3b' "$LOG/out.txt"; echo $?)"

# 16 GB (9060 XT)
rc=$(STUB_PCI=amd STUB_GFX=gfx1201 STUB_VRAM_B=17179869184 run)
check "16GB reported" "$(grep -qE 'GPU memory: about 1[56] GB' "$LOG/out.txt"; echo $?)"
check "16GB suggests 14B not 32B" "$(grep -q 'comfortable here: 14B' "$LOG/out.txt"; echo $?)"

# An implausible reading must be discarded rather than reported confidently.
rc=$(STUB_PCI=amd STUB_GFX=gfx1100 STUB_VRAM_B=12 run)
check "nonsense VRAM refused" "$(grep -q 'could not read GPU memory' "$LOG/out.txt"; echo $?)"
check "nonsense VRAM does not print a size" "$([ "$(grep -c 'GPU memory: about' "$LOG/out.txt")" = 0 ]; echo $?)"

# --pull given: the tiny-model hint would be noise, so it must not appear.
rc=$(STUB_PCI=amd STUB_GFX=gfx1100 run --pull stub:7b)
check "no tiny-model hint when --pull given" "$([ "$(grep -c 'pull llama3.2:3b' "$LOG/out.txt")" = 0 ]; echo $?)"

echo "=== E: option validation ==="
rc=$(run --tune)
check "--tune without --pull dies" "$([ "$rc" != 0 ]; echo $?)"
rc=$(run --gpu weird)
check "bad --gpu dies" "$([ "$rc" != 0 ]; echo $?)"

echo "=== F: --local-only ==="
rc=$(run --local-only)
check "exits 0" "$([ "$rc" = 0 ]; echo $?)"
check "binds 127.0.0.1" "$(grep -q 'OLLAMA_HOST=127.0.0.1:11434' "$DROPIN"; echo $?)"
check "warns about container reach" "$(grep -qi 'cannot reach' "$LOG/out.txt"; echo $?)"

echo "=== G: full chain --pull --tune -> measure -> apply ==="
rm -f "$LOG/ps.count" "$LOG/ollama.log"
rc=$(run --pull stub:7b --tune)
check "exits 0" "$([ "$rc" = 0 ]; echo $?)"
check "model pulled" "$(grep -q 'pull stub:7b' "$LOG/ollama.log"; echo $?)"
check "measure ran and recommended" "$(grep -q 'Recommended num_ctx' "$LOG/out.txt"; echo $?)"
check "recommendation APPLIED via ollama create" "$(grep -q 'create stub:7b -f' "$LOG/ollama.log"; echo $?)"
check "applied num_ctx echoed" "$(grep -q 'now defaults to num_ctx' "$LOG/out.txt"; echo $?)"

echo
if [ "$fail" = 0 ]; then echo "ALL SCENARIOS PASS"; else echo "$fail CHECK(S) FAILED"; tail -40 "$LOG/out.txt"; fi
rm -rf "$T"
exit "$fail"
