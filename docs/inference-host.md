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
snaps (install Docker from its own repo later). If you keep the default LVM
layout, expand root afterwards so you do not strand disk:

```bash
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv && sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
```

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

```bash
# Get the current amdgpu-install .deb URL from AMD's ROCm "Quick start
# install" page for your Ubuntu release - the version in the filename moves.
sudo apt install -y ./amdgpu-install_VERSION_all.deb
sudo amdgpu-install --usecase=rocm --no-dkms
sudo usermod -aG render,video "$USER"   # log out and back in
sudo reboot
rocm-smi                                # must list the card
```

Two AMD-specific things that catch people:

- **Group membership is mandatory.** Without `render` and `video`, ROCm sees
  no device and Ollama silently falls back to CPU. If generation is
  inexplicably slow, check `groups` before anything else.
- **Consumer cards may need a version override.** ROCm officially supports a
  short list (RX 7900 XTX/XT, W7900, MI-series); many others work once you
  claim a supported architecture. RDNA3 cards generally take
  `HSA_OVERRIDE_GFX_VERSION=11.0.0`, RDNA2 `10.3.0`. Set it in the Ollama
  service override in §4. Ollama's `docs/gpu.md` keeps the current
  compatibility list - check there rather than trusting any table's age,
  including this one.

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
3. Driver: `ubuntu-drivers install --gpgpu` (NVIDIA) or `amdgpu-install
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
