# RSConclave - Docker deployment

Copy-paste reference for the path this app is actually built for: a container on
a Linux box, sitting next to your inference server, reachable from every device
you own. The README explains what RSConclave is and how to try it; this covers
standing it up permanently and the things that will bite when you do.

**Just want to look at it first?** Clone it and run `npm start` - no Docker, no
GPU, no accounts to create. See
[Try it without a GPU](README.md#try-it-without-a-gpu).

---

## The short version

```bash
git clone https://github.com/RootSwitch/RSConclave
cd RSConclave
./tools/install.sh --with-ollama-host
```

That installs Docker if it is missing, generates a self-signed certificate,
creates an admin account **before** the first visitor can claim the instance,
brings the stack up and waits for the container to actually answer rather than
just to start. It is safe to re-run: existing certificates, override files and
the data volume are left alone. `--help` lists the options.

Doing it by hand is two commands and worth understanding once:

```bash
./tools/gen-cert.sh 192.168.1.50 lab.lan    # optional, but see HTTPS below
docker compose up -d --build
```

The image is `node:24-alpine` plus the source. No install step, no build stage,
around 180 MB.

---

## Claim the instance before the network does

The first visitor to an unclaimed instance owns it. That is deliberate and it is
fine on a laptop; on a LAN it is a race you can lose to anyone who portscans
faster than you finish your coffee.

Set `ADMIN_PASSWORD` in the compose environment and the account is created
before the server starts listening, so there is no window at all:

```yaml
environment:
  ADMIN_PASSWORD: something-long-from-a-password-manager
```

`tools/install.sh` writes this into an untracked `docker-compose.override.yml`
(mode 600, gitignored) rather than the tracked compose file, which is also why
`git pull` never conflicts with your per-box settings. The variable is ignored
once any account exists, so leaving it set does nothing after first boot.

**Lost every password?** Delete `data/users.json` and
`data/authsessions.json`. Accounts reset; every transcript, persona and preset
survives, because they live under `data/users/<name>/`.

---

## Reaching your inference box

Endpoints are resolved **from inside the container**, which is the single most
common way to configure this wrong. `127.0.0.1` in the container is the
container - not your desktop, and not the host.

| Where Ollama runs | Base URL to configure |
|---|---|
| Another machine | `http://10.0.0.5:11434` - its real address |
| The same host as this container | `http://host.docker.internal:11434` |

A fresh volume starts with no endpoints at all; add them in Settings on first
run. The **Test** button runs live model discovery, so it doubles as a
connectivity check - use it before assuming the app is broken.

### Co-hosted on the inference box

The compose file maps `host.docker.internal` to the host gateway even on Linux,
where Docker does not provide that name by default, and Settings has a
**+ host Ollama** button that pre-fills it.

One extra step is required on the host, and it is not optional:

```bash
# Ollama must listen beyond loopback
OLLAMA_HOST=0.0.0.0 ollama serve
```

Container traffic arrives on the docker bridge, not on loopback. A
`127.0.0.1`-bound Ollama will resolve, accept the connection attempt, and
refuse it - which reads like a firewall problem and is not one.

---

## HTTPS

There is no flag and no second port. The server speaks plain HTTP until a
certificate exists at the configured paths, then HTTPS on the same port.

```bash
./tools/gen-cert.sh 192.168.1.50 lab.lan
docker compose restart
```

The startup line then says `https://` and names the certificate it loaded. To
bring your own, drop the PEM pair at `data/certs/server.crt` and `server.key`,
or point `TLS_CERT` and `TLS_KEY` elsewhere.

**A certificate it cannot read does not crash the server.** It logs the fix and
stays on HTTP, which is a deliberate choice - a crashloop over file permissions
is a worse failure than a working HTTP service telling you what is wrong. The
container runs as uid 1000, so the answer is nearly always:

```bash
chown -R 1000:1000 data/certs
```

Browsers warn once per browser about a self-signed certificate. A public CA will
not issue for a single-label name, so a warning-free certificate needs a
subdomain you control that resolves to this host, issued via a DNS challenge.

---

## Your data, and backing it up

Sessions, personas, presets and endpoint config live in the `rsconclave-data`
named volume, so rebuilding the image never touches your history.

```bash
docker run --rm -v rsconclave_rsconclave-data:/d -v "$PWD:/out" alpine \
    tar czf /out/rsconclave-backup.tar.gz -C /d .
```

**The compose project name is pinned** (`name: rsconclave`), so the volume is
always `rsconclave_rsconclave-data` regardless of what you called the checkout
directory. This matters more than it looks: without the pin, renaming the
directory silently attaches a fresh empty volume, and every session you have
ever written appears to have vanished. It has not - it is still in the volume
named after the old directory.

Everything is plaintext JSON. Session files hold every prompt and response
verbatim. Treat that volume with whatever care you would give a notebook you had
written the same things in.

---

## Do not remove `init: true`

The compose file puts an init process at PID 1. Node does not reap children it
did not spawn, and the healthcheck's HTTPS probe leaves one behind on every run.

Without it the zombies accrue against the host uid's process limit until that
user cannot fork. The symptom is SSH refusing to start a shell on the host, which
looks nothing whatsoever like a problem with a chat UI, and you will spend a long
evening on it.

---

## Updating

```bash
git pull
docker compose up -d --build
```

Your data is in the volume and your settings are in the untracked override file,
so neither is in the update's path.

### A box with no route to your git remote

Bundles carry only committed history, so `data/` structurally cannot ride along
in one.

```bash
./tools/make-bundle.sh                                # produces dist/rsconclave.bundle
# copy it over by scp, USB, whatever reaches the box
git clone /path/to/rsconclave.bundle rsconclave       # first time
git pull                                              # after overwriting the bundle in place
```

`tools/install-hooks.sh` makes every commit refresh that bundle automatically.
That is a development convenience for pushing to an offline box; a cloner who
never runs the script is unaffected by it.

---

## Keeping it running

Compose with `restart: unless-stopped` covers the ordinary cases: reboots,
crashes, the OOM killer.

Outside Docker it is a plain foreground process, so a Scheduled Task at logon or
a service manager like NSSM both work. There is no daemon mode built in, and that
is deliberate - a tool holding your prompts should be one you can see running and
stop by closing a window.

---

## Production hardening (single user to standing service)

A container on your own desk needs none of this. Fold it in when the thing
becomes something other people use.

**Trust model.** This is a tool for a trusted LAN or a VPN, and the README says
so up front. Authentication is real - scrypt at N=16384, sha256-hashed opaque
session tokens, HttpOnly SameSite cookies, per-IP lockout counted before the
work rather than after - but there is no per-request CSRF token beyond SameSite
plus a cross-site guard, and no general API rate limit outside login. Do not put
it on the open internet. Most findings against a tool in this position assume an
attacker who can already reach the LAN and hold an account, which is a different
threat than the one this design is answering.

**Access control**
- Publish the port to a trusted interface, not `0.0.0.0` on a public NIC. The
  container binds `0.0.0.0` internally because port publishing requires it; what
  the network can reach is decided by the compose port mapping and your firewall.
- Give each person their own account. Sessions, personas and presets are
  per-user, one account cannot read another's transcripts, and live token
  streams only reach the run's owner. Shared credentials throw all of that away.
- There are no roles. The only guard rails are "no deleting yourself" and "no
  deleting the last user", so everyone with an account can manage accounts.

**One GPU, one generation**
- Runs are strictly sequential across users, because the box holds one model at
  a time. A second person sees "box busy" - never whose run, never its content -
  and can start theirs the moment it finishes. This is the hardware truth the
  whole design rests on, not a limitation to work around, and telling people
  before they ask turns a bug report into understood behaviour.

**Data retention**
- Transcripts are kept until deleted. Deleting an account does not destroy its
  writing: the directory is archived aside with a timestamp, specifically so
  recreating that username does not hand the new person the old one's history.
  Sweep those archives yourself when you mean it.
- Back up the volume before upgrades. It is JSON; it restores by being put back.

**Observability**
- The healthcheck polls `/api/health`, the one route that answers without a
  login, and it reports nothing but liveness.
- Container logs carry startup lines (which scheme, which certificate, whether
  an account exists) and any background run failure. `docker compose logs -f`
  is the first place to look and usually the last.

**Already handled, no action needed**
- Atomic writes with fsync for every session, account and config file, plus a
  Windows retry path for the rename.
- A present-but-unreadable `users.json` fails closed instead of being read as
  "no accounts yet", which would have re-opened first-run setup to the network.
- SSE sends `X-Accel-Buffering: no`, so token streams survive nginx-style
  reverse proxies with no extra configuration.
- Background run failures are caught at the launch boundary; an unreachable
  endpoint or a stale endpoint id surfaces in the UI instead of taking the
  process down with an unhandled rejection.
- Per-IP login lockout, connection caps on the event stream, and small body
  limits on the unauthenticated routes.

---

## When something is wrong

| Symptom | Where to look |
|---|---|
| "Cannot reach `<endpoint>`" | Endpoint is resolved from the container. Use the box's real address, or `host.docker.internal` when co-hosted with `OLLAMA_HOST=0.0.0.0` set. |
| Startup says `http://` after you made a certificate | The container cannot read it. `chown -R 1000:1000 data/certs`, then restart. |
| Every session gone after renaming the directory | Nothing is lost. The volume is named for the old directory; the project name pin prevents this going forward. |
| Setup page offers to claim an instance you already own | `users.json` is unreadable, not empty - the server refuses to treat that as "no accounts". Fix its permissions or restore it; do not claim again. |
| Host SSH stops giving you a shell | Something removed `init: true`. See above. |
| "Box busy" and nobody is generating | A run holds the box until it finishes or is stopped. Its owner can stop it; `docker compose restart` clears it outright. |
| Model list empty in Settings | Press **Test** on the endpoint - it runs real discovery and reports the actual error. |
