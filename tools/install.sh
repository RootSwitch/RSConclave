#!/usr/bin/env bash
# install.sh - one-shot deploy of RSConclave onto a Linux box.
#
# Brings up the container, generates a self-signed certificate so the box
# speaks HTTPS, and claims the instance with an admin account so the login
# page is never sitting unclaimed on your network.
#
# SAFE TO RE-RUN. It never regenerates an existing certificate, never
# overwrites an existing override file, and never touches the data volume.
# Re-running reconciles the box to this layout and restarts the container.
#
# Usage:
#   ./tools/install.sh [options]
#
#   --port N              published port                (default: 7777)
#   --host-name NAME      name/IP the cert is issued for (default: auto-detected)
#   --admin-password PW   seed the first account         (default: generated)
#   --with-ollama-host    point the default endpoint at Ollama on THIS host
#   --no-tls              skip certificate generation (HTTP only)
#   --update              git pull before building
#
# Requires: docker with the compose plugin. Installs neither Ollama nor a
# GPU driver - see docs/inference-host.md for the host build.
set -euo pipefail

PORT=7777
HOST_NAME=""
ADMIN_PASSWORD=""
WITH_OLLAMA_HOST=0
NO_TLS=0
UPDATE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --port)             PORT=$2; shift 2 ;;
        --host-name)        HOST_NAME=$2; shift 2 ;;
        --admin-password)   ADMIN_PASSWORD=$2; shift 2 ;;
        --with-ollama-host) WITH_OLLAMA_HOST=1; shift ;;
        --no-tls)           NO_TLS=1; shift ;;
        --update)           UPDATE=1; shift ;;
        -h|--help)          sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%swarn%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%serror%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

cd "$(dirname "$0")/.."

# ----- docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    say "installing Docker"
    curl -fsSL https://get.docker.com | sh || die "Docker install failed"
    sudo usermod -aG docker "$USER" || true
    # Group membership only applies to new logins, so every docker call below
    # would fail on permissions. Stop here rather than half-installing.
    say "Docker is installed and you were added to the docker group."
    say "Log out and back in, then run this script again."
    exit 0
fi
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is required"
DC="docker compose"
docker info >/dev/null 2>&1 || DC="sudo docker compose"

# Written as an if, not `[ test ] && action`: under `set -e` a false test makes
# the whole && list the failing command, and the script exits silently. Same
# reason for every other conditional in this file.
if [ "$UPDATE" -eq 1 ]; then
    say "updating the checkout"
    git pull --ff-only
fi

# ----- host name for the certificate ---------------------------------------
if [ -z "$HOST_NAME" ]; then
    # `|| true` on each: -I is a Linux-only flag, absent on BusyBox and macOS.
    # Under `set -e -o pipefail` a bare assignment from a failing pipeline
    # aborts the script here, before a single line of output - which reads as
    # the script doing nothing at all.
    HOST_NAME=$(hostname -I 2>/dev/null | awk '{print $1}') || true
    if [ -z "$HOST_NAME" ]; then HOST_NAME=$(hostname 2>/dev/null) || true; fi
    if [ -z "$HOST_NAME" ]; then HOST_NAME=localhost; fi
    say "using $HOST_NAME for the certificate (override with --host-name)"
fi

# ----- TLS ------------------------------------------------------------------
if [ "$NO_TLS" -eq 0 ]; then
    if [ -f data/certs/server.crt ] && [ -f data/certs/server.key ]; then
        say "certificate already present, leaving it alone"
    else
        say "generating a self-signed certificate for $HOST_NAME"
        ./tools/gen-cert.sh "$HOST_NAME" || die "certificate generation failed"
    fi
    # The container runs as uid 1000 and mounts this read-only; a root-owned
    # key is unreadable there and the server silently stays on HTTP.
    sudo chown -R 1000:1000 data/certs 2>/dev/null || true
fi

# ----- first account --------------------------------------------------------
# Without this the login page sits unclaimed until someone visits, and on a
# shared network the first visitor need not be you.
GENERATED=0
if [ -z "$ADMIN_PASSWORD" ]; then
    # No trailing `head -c N`: it would close the pipe early, SIGPIPE the
    # stage before it, and pipefail would turn that into a failed install -
    # intermittently, depending on how fast base64 flushed. 18 random bytes
    # encode to exactly 24 unpadded characters, so trimming the awkward ones
    # still leaves roughly 22.
    ADMIN_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=\n')
    GENERATED=1
fi

# ----- compose override -----------------------------------------------------
# Untracked, so `git pull` can never conflict with your local settings.
WROTE_OVERRIDE=0
if [ -f docker-compose.override.yml ]; then
    say "docker-compose.override.yml exists, leaving it alone (port and password come from it)"
else
    WROTE_OVERRIDE=1
    say "writing docker-compose.override.yml"
    {
        echo "# Written by tools/install.sh. Untracked: your settings, not the project's."
        echo "services:"
        echo "  rsconclave:"
        echo "    ports:"
        echo "      - \"${PORT}:7777\""
        echo "    environment:"
        echo "      - ADMIN_PASSWORD=${ADMIN_PASSWORD}"
    } > docker-compose.override.yml
    chmod 600 docker-compose.override.yml   # it holds a password
fi

# ----- up -------------------------------------------------------------------
say "building and starting the container"
$DC up -d --build || die "compose up failed"

# ----- wait for it ----------------------------------------------------------
# A first run has just built an image and started a container; probing once a
# second later would report "not up" on exactly the runs where the check
# matters most. 40 x 3s is generous for a start and still bounded.
#
# Probe both schemes every round rather than trusting --no-tls: the server
# decides for itself, switching to HTTPS whenever it finds a cert pair. A
# leftover cert from an earlier run means --no-tls asked for HTTP and got
# HTTPS, and a single-scheme probe would call a healthy box dead.
say "waiting for RSConclave to answer"
SCHEME=""
for _ in $(seq 1 40); do
    if curl -sfk -m 3 "https://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then SCHEME=https; break; fi
    if curl -sf  -m 3 "http://127.0.0.1:${PORT}/api/health"  >/dev/null 2>&1; then SCHEME=http;  break; fi
    sleep 3
done
if [ -z "$SCHEME" ]; then
    die "no answer after two minutes - check '$DC logs'"
fi
if [ "$NO_TLS" -eq 0 ] && [ "$SCHEME" = http ]; then
    warn "answering on HTTP despite a certificate being present - check '$DC logs'"
fi

echo
say "RSConclave is up at ${SCHEME}://${HOST_NAME}:${PORT}"
# Only claim a password we actually applied. On a re-run the override file
# already exists and was left alone, so the one generated above went nowhere -
# printing it would send you to a login it does not open. The server also
# honours ADMIN_PASSWORD only while no account exists, so on a re-run the
# original password is still the real one.
if [ "$WROTE_OVERRIDE" -eq 0 ]; then
    printf '    sign in with the account this instance already has\n'
elif [ "$GENERATED" -eq 1 ]; then
    printf '    sign in as %sadmin%s with password %s%s%s\n' "$G" "$N" "$G" "$ADMIN_PASSWORD" "$N"
    printf '    (also stored in docker-compose.override.yml - change it in Settings)\n'
else
    printf '    sign in as %sadmin%s with the password you passed\n' "$G" "$N"
fi
if [ "$SCHEME" = https ]; then
    printf '    the certificate is self-signed, so expect a browser warning once\n'
fi

if [ "$WITH_OLLAMA_HOST" -eq 1 ]; then
    echo
    say "next: add Ollama running on this host"
    printf '    In Settings, click "+ host Ollama" - it fills in\n'
    printf '    http://host.docker.internal:11434 for you.\n'
    if systemctl is-active --quiet ollama 2>/dev/null; then
        if systemctl show ollama -p Environment 2>/dev/null | grep -q 'OLLAMA_HOST=0\.0\.0\.0'; then
            printf '    Ollama is running and listening beyond localhost. Good.\n'
        else
            warn "Ollama is running but does not appear to set OLLAMA_HOST=0.0.0.0."
            warn "Container traffic arrives over the docker bridge, so the endpoint will"
            warn "resolve and still refuse. Fix with: sudo systemctl edit ollama.service"
            warn "  [Service]"
            warn "  Environment=\"OLLAMA_HOST=0.0.0.0:11434\""
        fi
    else
        warn "no running Ollama service found on this host - see docs/inference-host.md"
    fi
fi
