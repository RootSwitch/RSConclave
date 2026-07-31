# Building an inference host for RSConclave

A from-scratch runbook for a Linux box that serves local models over the
network, with RSConclave running on the same machine. Written for a
single-GPU host; the steps generalise to any card, NVIDIA or AMD.

You do not need this guide to use RSConclave - if you already have Ollama
running somewhere, add it in Settings and skip to
[§6](#6-choosing-models-and-context-sizes). This is for standing the box up
from nothing.

**The one rule that shapes everything:** a single GPU serves one model at a
time. Ollama swaps models in and out as requests arrive, which is exactly
why RSConclave runs its councils and roundtables sequentially. Plan around
that rather than fighting it.

---

## 1. OS

Ubuntu Server LTS is the path of least resistance for both vendors' drivers.
Use the **standard** install, not "minimized" - minimized strips editors and
utilities you will want on a box you SSH into.

Installer choices: install OpenSSH server (your way in), skip the featured
snaps (install Docker from its own repo later).

**Give root the whole disk.** Model blobs are tens of gigabytes and the
default layout does not expect that. There are two different situations here
and the wrong fix silently does nothing in the other one:

*The installer left free space in the volume group* - the usual case, because
Ubuntu's guided LVM allocates only part of the disk:

```bash
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv && sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
```

*You grew the underlying disk afterwards* - a VM whose virtual disk was
expanded. The partition still ends where it did, so the volume group has no
free extents and the command above reports there is nothing to extend. Grow
the partition and the physical volume first:

```bash
lsblk                                    # confirm the new size; note the LVM partition
sudo apt install -y cloud-guest-utils    # provides growpart
sudo growpart /dev/sda 3                 # DEVICE then NUMBER, separated by a space
sudo pvresize /dev/sda3
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
df -h /
```

Substitute your own names: the disk is `vda` on virtio and `nvme0n1` on NVMe,
and `lsblk` shows which partition holds LVM. All of it runs online - ext4
grows on a mounted root. If `lsblk` still shows the old size, the guest has
not noticed the expansion yet: reboot, or
`echo 1 | sudo tee /sys/class/block/sda/device/rescan`.

Then the basics:

```bash
sudo apt update && sudo apt install -y build-essential git curl pciutils lm-sensors htop tmux
```

> **Virtualising the host?** Use PCIe passthrough to a guest VM, not nested
> virtualisation. On Proxmox: q35 + OVMF, CPU type `host`, Secure Boot off
> (skips driver module signing), passthrough with All Functions on and
> Primary GPU **off** so you keep console access. Passthrough VMs pin all
> assigned RAM and cannot live-migrate.

---

## 2. GPU driver

Identify the card first: `lspci | grep -Ei 'vga|3d'`.

### NVIDIA (CUDA)

```bash
sudo ubuntu-drivers install --gpgpu     # server/headless driver branch
sudo reboot
nvidia-smi                              # must print the card and driver version
```

If `nvidia-smi` is missing after install, the utils package did not come
along: `sudo apt install -y nvidia-utils-<version>-server` matching the
driver branch that was installed.

### AMD (ROCm)

Ollama ships a ROCm build, so you need AMD's kernel driver and ROCm
userspace, not the whole HIP SDK:

AMD's own docs are the source of truth here and they have been reorganised at
least once - there is no longer a page called "Quick start install". What you
get instead is a selector, and the answers that matter for an inference box:

| Selector | Choose | Why |
|---|---|---|
| Device / Family | **AMD Radeon** | Instinct is the datacentre line, Ryzen the integrated one |
| Use case | **Compute** | See below - this is the choice that changes everything |
| OS / version | **Ubuntu**, matching your ISO exactly | Point releases are listed separately; 24.04.4 is not 24.04 |

**"Use case" is the one to get right.** It selects between two genuinely
different install paths:

- **Compute** - ROCm only, and it lets you pick your specific GPU, which is
  what produces the per-target package name below. Correct for a headless
  inference host: the graphics stack is weight you would install and never use.
- **Mixed Graphics and Compute** - the older `amdgpu-install` flow, which
  brings the full graphics stack along with ROCm. Correct if the box also
  drives a display or runs a desktop.

  It also builds an out-of-tree kernel module via DKMS, and **an unsigned
  module on a Secure Boot machine triggers MOK enrolment mid-install** - a
  blue key-management screen at the next reboot that has nothing to do with
  what you thought you were doing. Observed, not theorised. Either turn
  Secure Boot off first (§1) or take the Compute path, which builds no module
  and so never raises the question.

Either way the matrix also gives you the two facts worth writing down: your
card's **LLVM target** (`gfx1100` for RX 7900 XTX, `gfx1200` for RX 9000) and
the Ubuntu release and kernel AMD validates against.

The current shape is an apt repository plus a **per-target** ROCm package:

```bash
sudo apt install -y libatomic1 libquadmath0
sudo usermod -aG render,video "$LOGNAME"   # log out and back in

sudo mkdir --parents --mode=0755 /etc/apt/keyrings
wget https://repo.amd.com/rocm/packages-multi-arch/gpg/rocm.gpg -O - \
    | gpg --dearmor | sudo tee /etc/apt/keyrings/amdrocm.gpg > /dev/null
sudo tee /etc/apt/sources.list.d/rocm.list <<'EOF'
deb [arch=amd64 signed-by=/etc/apt/keyrings/amdrocm.gpg] https://repo.amd.com/rocm/packages-multi-arch/ubuntu2404 stable main
EOF
sudo apt update

# The package name carries BOTH the ROCm version and your card's target.
# Check what the repo actually offers rather than guessing:
apt-cache search amdrocm | sort
sudo apt install -y amdrocm7.14-gfx1100    # gfx1200 for RX 9000, etc.

sudo reboot
rocminfo | grep -m2 gfx                    # must name your target
```

**The per-target package is the part that catches people.** Install the wrong
one, or none, and the kernel side comes up fine while the runtime does not
recognise the card:

```
ROCk module is loaded
Warning: Agent creation failed.
The GPU node has an unrecognized id.
```

That message means userspace has no table entry for your ASIC - `ROCk module
is loaded` is telling you the kernel driver is working. It is a missing or
mismatched `amdrocm*-gfx*` package, not a broken driver, and no amount of
`HSA_OVERRIDE_GFX_VERSION` fixes it.

**Believe AMD's matrix about the kernel, not your instincts about new silicon.**
RDNA4 is validated on 24.04.4's **GA kernel 6.8**, not an HWE stack - newer
hardware does not automatically mean you want a newer kernel here, because the
support arrives through AMD's packages rather than the kernel tree.

Two AMD-specific things that catch people:

- **Group membership is mandatory.** Without `render` and `video`, ROCm sees
  no device and Ollama silently falls back to CPU. If generation is
  inexplicably slow, check `groups` before anything else.
- **Find out what card you actually have, in ROCm's terms.** The override below
  lies to ROCm about your gfx target, so knowing the real one turns guesswork
  into a lookup:

  ```bash
  rocminfo | grep -m2 gfx        # e.g. gfx1100 (RX 7900 XTX), gfx1201 (RX 9060 XT)
  ```

  `tools/install-ollama.sh` prints this for you and names the family.

- **Consumer cards may need a version override.** ROCm officially supports a
  short list (RX 7900 XTX/XT, W7900, MI-series); many others work once you
  claim a supported architecture. Set it in the Ollama service override in §4.

  | Family | gfx | `HSA_OVERRIDE_GFX_VERSION` |
  |---|---|---|
  | RDNA4 (RX 9000) | gfx120x | `12.0.0`, falling back to `11.0.0` |
  | RDNA3 (RX 7000) | gfx110x | `11.0.0` - often unnecessary, 7900 XTX is supported outright |
  | RDNA2 (RX 6000) | gfx103x | `10.3.0` |
  | CDNA (MI-series) | gfx90a, gfx94x | none |

  **RDNA4 is the one to expect friction from.** Whether it works depends on how
  new the ROCm build bundled inside your Ollama is, and no table can tell you
  that - only trying it. If Ollama reports "no compatible GPUs", work down the
  fallbacks. Ollama's `docs/gpu.md` keeps the current compatibility list; check
  there rather than trusting any table's age, including this one.

Either vendor: confirm the card is actually being used before moving on. A
model that loads onto CPU still answers, just at one or two tokens a second,
and **the placement is fixed for that load** - you have to unload and reload
to fix it, not merely free VRAM.

---

## 3. A disk for models

Model blobs are large and grow without warning. Give them their own
filesystem so a runaway pull cannot fill root:

```bash
sudo mkfs.ext4 /dev/sdX1
sudo mkdir -p /mnt/models
echo "UUID=$(sudo blkid -s UUID -o value /dev/sdX1) /mnt/models ext4 defaults 0 2" | sudo tee -a /etc/fstab
sudo mount -a
sudo chown -R ollama:ollama /mnt/models   # after installing Ollama in §4
```

---

## 4. Ollama

Everything in this section is one command if you cloned RSConclave onto the box
(it lives in the same repo, no other setup needed):

```bash
./tools/install-ollama.sh --models /mnt/models --allow-from 192.0.2.10     --pull qwen3-coder:30b --tune
```

That verifies the GPU driver actually works (refusing loudly if not - the
failure it prevents is Ollama silently running on CPU), installs Ollama, writes
the systemd settings below, restricts the port to the hosts you name, pulls a
first model, and - the `--tune` part - measures that model's real per-token
memory cost and bakes the largest fully-resident context window into it, which
is section 6 done for you. AMD boxes add `--hsa-override 11.0.0` (RDNA3) or
`10.3.0` (RDNA2) if needed. It is the newest tool in the repo: exercised
against stubbed system commands, so treat its first run on a real box as a
test, not a ceremony.

The manual equivalent, which is also what to read when the script refuses:

```bash
curl -fsSL https://ollama.com/install.sh | sh    # installs a systemd service
sudo systemctl edit ollama.service
```

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_MODELS=/mnt/models"
Environment="OLLAMA_KEEP_ALIVE=5m"
# AMD only, and only if your card needs the override from section 2:
# Environment="HSA_OVERRIDE_GFX_VERSION=11.0.0"
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart ollama
ollama pull gpt-oss:20b && ollama run gpt-oss:20b "say hi"
```

What each setting is for:

- **`OLLAMA_HOST=0.0.0.0:11434`** - listen beyond loopback. Required if
  RSConclave runs in a container on this same box, because container traffic
  arrives over the docker bridge, not localhost. Without it the address
  resolves and the connection is refused, which reads like a network fault
  and is not one.
- **`OLLAMA_MODELS`** - keep blobs on the data disk from §3.
- **`OLLAMA_KEEP_ALIVE`** - how long a model stays resident after its last
  request. Longer avoids reload latency between turns; shorter frees the card
  faster. `5m` is a reasonable default; drop it to `30s` if you switch models
  constantly.

**Ollama has no authentication.** Binding to `0.0.0.0` is only safe behind a
firewall. Restrict inbound 11434 to the hosts that need it:

```bash
sudo ufw allow from 192.0.2.10 to any port 11434 proto tcp
```

---

## 5. RSConclave on the same box

Running the UI beside the models means one machine to manage, and the same
sessions from your desktop or your phone.

```bash
git clone <your-rsconclave-remote> rsconclave && cd rsconclave
./tools/install.sh --with-ollama-host
```

The installer handles Docker, TLS, the data volume and an initial account.
The README's deployment section covers the manual equivalent if you would
rather do it by hand.

The one setting that matters here: in Settings, click **"+ host Ollama"**,
which fills in `http://host.docker.internal:11434`. The compose file maps
that name to the host gateway, and combined with `OLLAMA_HOST=0.0.0.0` from
§4 the container can reach the daemon running outside it.

Nothing needs a client on your workstation after this. Open the host's
address in a browser, and add it to your phone's home screen for an
app-like window.

---

## 6. Choosing models and context sizes

### Which models fit

Rough memory at Q4: **GB is about params in billions times 0.55**. So a 32B
lands near 19 GB, a 70B near 40 GB, a 120B MoE near 60 GB. FP16 is params
times 2.

| VRAM | Comfortable | Possible with care |
|---|---|---|
| 8 GB | 3B-8B models | 14B at low context |
| 12 GB | 8B-14B | 20B MoE |
| 16 GB | 14B, 20B MoE | 27B-32B at small context |
| 24 GB | 27B-32B, 30B MoE | 70B partially in RAM (slow) |
| 32 GB+ | 32B at long context | 70B dense |

**Prefer MoE models when you are near the limit.** A mixture-of-experts model
reads only its active parameters per token, so a 30B MoE with 3B active runs
roughly at 3B speed. That also means an MoE that spills into system RAM stays
usable, while a dense model of the same size crawls - the smallest of three
oversized models can easily be the slowest.

### How much context fits

This is the number no table can give you, because it depends on attention
geometry as much as size. Sliding-window and hybrid-Mamba models cost almost
nothing per token; dense grouped-query models cost a lot. Two models of
nearly identical parameter count can differ by more than tenfold in what a
long conversation costs them.

So measure it, on your card, for the model you actually run:

```bash
./tools/measure-ctx.sh qwen3-coder:30b
```

It loads the model at two context sizes, reads the real footprint from
Ollama's `/api/ps`, and reports bytes per token plus the largest window that
stays fully on the GPU - then prints the Modelfile line to bake it in.

**Why this matters more than it sounds:** Ollama's default context is small
(4096 unless a Modelfile says otherwise), and when a prompt exceeds the
window it is **silently truncated from the front** - which is where the
system prompt lives. The symptom is a model that gradually stops following
its instructions in long conversations, with nothing in any log. If a
persona seems to "forget who it is" after a while, this is almost always why.

RSConclave shows each model's real window in every picker and meters each
turn against it, so you can see the ceiling approaching rather than
discovering it afterwards.

---

## 7. Baking settings in with a Modelfile

A Modelfile creates a lightweight variant - a new manifest over the same
blobs, no re-download, negligible disk:

```
FROM qwen3-coder:30b
PARAMETER num_ctx 28672
PARAMETER temperature 0.7
```

```bash
ollama create qwen3-coder:30b -f Modelfile     # same name overwrites in place
```

Because it applies at the daemon, **every client** gets these defaults, not
just RSConclave. Valid parameters are narrower than people expect:
`num_ctx`, `temperature`, `top_k`, `top_p`, `min_p`, `repeat_penalty`,
`repeat_last_n`, `seed`, `stop`, `num_predict`. Note that **`keep_alive` is
not one of them** - it is a per-request field and an environment variable
only.

A trick worth knowing: `FROM` accepts a local GGUF path, so a quant you
downloaded by hand can be imported rather than re-pulled.

Two useful variants of the same model:

```
FROM qwen3-coder:30b            ->  qwen3-coder:30b        (fits VRAM, fast)
FROM qwen3-coder:30b            ->  qwen3-coder:30b-long   (spills to RAM, big window)
```

Tags are just manifests over shared blobs, so the second costs nothing on
disk. Pick the fast one for roundtables, the long one when you need the
window.

---

## 8. Operational notes

- **Watch three things** in tmux panes: `watch -n1 nvidia-smi` (or
  `watch -n1 rocm-smi`), `watch -n1 free -g` (read the *available* column),
  and `htop`.
- **Low GPU wattage on a spilled MoE is normal.** It is bandwidth-bound,
  waiting on system RAM, not idle. A fully resident model lights the card up.
- **Do not add a large swap file.** A model limping along on disk hides the
  clean "this does not fit" failure. Prefer `vm.swappiness=10` and let
  oversized loads fail honestly:
  ```bash
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf && sudo sysctl --system
  ```
- **Unload everything** (Ollama has no `--all`):
  ```bash
  ollama ps | awk 'NR>1 {print $1}' | xargs -r -n1 ollama stop
  ```
- **`OLLAMA_NUM_PARALLEL` multiplies KV cache.** If you raise it, every
  context figure you measured divides by that factor.

---

## 9. Network placement

Put the inference host somewhere with **default-deny egress**. It needs to
reach model registries when you pull, and nothing else afterwards - so open
443 outbound temporarily for a pull, then close it again. Models cache
permanently, so that window is per-model, not ongoing.

Inbound, allow only the hosts that use it. If RSConclave runs on this same
box, that is just your workstation and phone reaching the RSConclave port -
11434 need not be exposed to anything at all.

The reasoning is containment rather than paranoia: a model host that cannot
initiate outbound connections cannot exfiltrate what it is shown, and cannot
be pivoted through if something reaches it. That matters more once agents
with tool access are pointed at it.

---

## 10. Rebuild checklist

1. Ubuntu Server LTS, standard install, OpenSSH yes.
2. Base packages; `lspci` to identify the card.
3. Driver: `ubuntu-drivers install --gpgpu` (NVIDIA) or AMD's repo plus the
   `amdrocm*-gfx*` package for your card's target (`amdgpu-install
   --usecase=rocm` plus `render`/`video` groups (AMD). Confirm with
   `nvidia-smi` / `rocm-smi`.
4. Model disk mounted at `/mnt/models`, owned by `ollama`.
5. Ollama: `./tools/install-ollama.sh --models /mnt/models --allow-from <hosts>`
   (or by hand: systemd override for `OLLAMA_HOST`, `OLLAMA_MODELS`,
   `OLLAMA_KEEP_ALIVE`, plus `HSA_OVERRIDE_GFX_VERSION` on AMD if needed).
6. Firewall: 11434 restricted to known hosts (the script above does this for
   the hosts you name).
7. `vm.swappiness=10`.
8. RSConclave via `tools/install.sh`; add the host Ollama endpoint in
   Settings.
9. Pull models; `tools/measure-ctx.sh MODEL --apply` measures each one's real
   context cost and bakes the largest fully-resident `num_ctx` into it
   (`--pull MODEL --tune` on the installer does both steps for the first one).
