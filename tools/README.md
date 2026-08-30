# tools/

Six scripts, none of them required to run the app. This page exists because
they were each documented in the section of the README that needed them, which
works fine if you are reading front to back and not at all if you are browsing
the directory wondering what any of this is.

Every one of them is safe to re-run.

| Script | Reach for it when |
|---|---|
| [`install.sh`](install.sh) | Deploying onto a Linux box. Installs Docker if missing, builds and starts the container, generates a self-signed cert, and seeds an admin account so the login page is never sitting unclaimed on your network. `--with-ollama-host` also points the default endpoint at Ollama on that machine and checks it is reachable from inside the container. |
| [`install-ollama.sh`](install-ollama.sh) | Building the inference host itself. Installs Ollama, detects the GPU (NVIDIA or AMD, including the gfx target and whether an HSA override is likely needed), writes the systemd drop-in, opens the firewall, and reports where models will be stored. |
| [`measure-ctx.sh`](measure-ctx.sh) | Deciding `num_ctx` for a model. No table can tell you: attention geometry matters as much as parameter count, and two models of similar size can differ more than tenfold per token. Loads the model at two context sizes, reads the real footprint from `/api/ps`, and extrapolates the largest window that stays GPU-resident. Budgets against what is **free** on the card rather than its nameplate size, because a model still resident from an earlier council turn leaves less room than an idle-box measurement promises - `--assume-empty` sizes for the whole card instead. `--apply` bakes it into the model, and works against a remote `--host` too - the whole run is HTTP, and a Modelfile whose `FROM` is a model name is resolved by that daemon out of its own blobs. VRAM detection is the one local step, so a remote host must state `--vram`. |
| [`gen-cert.sh`](gen-cert.sh) | Wanting HTTPS. Writes a self-signed pair into `data/certs/`, which the server picks up on restart. `install.sh` calls this for you. |
| [`install-hooks.sh`](install-hooks.sh) | Working on the code. Installs a pre-commit hook that refreshes `dist/rsconclave.bundle`. |
| [`make-bundle.sh`](make-bundle.sh) | Carrying the repo to a box with no route to this machine's git. Produces `dist/rsconclave.bundle` - all branches and tags in one file. A git bundle rather than a tar of the working tree on purpose: it can only contain committed history, so `data/` (prompts, transcripts, certs, accounts) is structurally unable to ride along, and the far side pulls updates from it incrementally. |
| [`screenshots/run.sh`](screenshots/run.sh) | Regenerating the README images. Starts a scripted fake inference server so every shot is reproducible rather than whatever happened to be on screen. |

Start with `install.sh` if you want the app running, and `install-ollama.sh` if
you need something for it to talk to.
