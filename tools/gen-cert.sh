#!/bin/sh
# Generate a self-signed TLS certificate for RSConclave.
#
#   ./tools/gen-cert.sh [hostname-or-ip ...]
#
# Examples:
#   ./tools/gen-cert.sh                          # localhost only
#   ./tools/gen-cert.sh 192.168.1.50 lab.lan     # reachable names/IPs
#
# Writes server.crt + server.key into ./data/certs/, which docker-compose.yml
# mounts read-only at /app/data/certs. Override with CERT_DIR if your data
# directory lives elsewhere:
#
#   CERT_DIR=/srv/conclave/certs ./tools/gen-cert.sh 192.168.1.50
#
# The server detects the pair at startup and switches to HTTPS automatically,
# so restart the container afterwards. Browsers warn once per browser about a
# self-signed certificate. To use a real one instead, drop your own PEM pair
# at the same two paths.
#
# A public CA will not issue for a single-label name like "conclave" - if you
# want a warning-free certificate, use a subdomain you control that resolves
# to this host, and issue via a DNS challenge.
set -e

DIR="${CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/data/certs}"
mkdir -p "$DIR"

CN="${1:-localhost}"
SAN="DNS:localhost,IP:127.0.0.1"
for h in "$@"; do
    case "$h" in
        *[!0-9.]*) SAN="$SAN,DNS:$h" ;;   # anything non-numeric is a DNS name
        *)         SAN="$SAN,IP:$h" ;;
    esac
done

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$DIR/server.key" -out "$DIR/server.crt" \
    -subj "/CN=$CN" -addext "subjectAltName=$SAN"
chmod 600 "$DIR/server.key"

# The container runs as the "node" user (uid 1000); it must be able to read
# the key. Best-effort - rerun with sudo if this warns.
chown -R 1000:1000 "$DIR" 2>/dev/null || \
    echo "NOTE: could not chown $DIR to uid 1000 - run: sudo chown -R 1000:1000 $DIR"

echo ""
echo "Wrote $DIR/server.crt and server.key (valid 10 years, SAN: $SAN)."
echo "Restart RSConclave (docker compose restart) to enable HTTPS."
