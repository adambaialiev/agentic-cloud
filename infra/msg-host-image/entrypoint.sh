#!/bin/bash
# Boot the messaging host on a Fly machine: close the network, prepare the
# volume, drop privileges, serve. Runs as root exactly long enough to do the
# first two.
set -euo pipefail

log() { printf '[msg-host-entrypoint] %s\n' "$*"; }

DATA_ROOT="${DATA_ROOT:-/data}"
PORT="$(printf '%s' "${PORT:-8080}" | tr -cd '0-9')"
[ -n "$PORT" ] || PORT=8080

# ---------------------------------------------------------------------------
# Firewall. Every machine in the workplace's cloud shares one private network,
# agent machines included, so "no public address" is not "nobody can connect".
# Only the backend's own WireGuard peer may reach the port; every other
# private-network packet is dropped before the server sees it. The shared
# secret is still checked on every request — two locks, not one.
#
# FAIL CLOSED: on a Fly machine (an fdaa: address is present) with no
# BACKEND_PEER_IP, or with no working nft, this refuses to serve at all. A
# messaging host that any agent could dial is worse than one that is down.
# ---------------------------------------------------------------------------
own6=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  own6="$(ip -6 -o addr show scope global 2>/dev/null \
            | awk '{print $4}' | cut -d/ -f1 \
            | grep -iE '^fdaa:' | head -n1 || true)"
  [ -n "$own6" ] && break
  [ -n "${MSG_HOST_SKIP_FIREWALL:-}" ] && break
  sleep 1
done

if [ -n "${MSG_HOST_SKIP_FIREWALL:-}" ] && [ -z "$own6" ]; then
  # The image smoke test (plain docker, no private network) sets this. It is
  # ignored whenever an fdaa: address exists, so it cannot open a real host.
  log "No private-network address and MSG_HOST_SKIP_FIREWALL set; skipping firewall (local run)."
else
  peer="$(printf '%s' "${BACKEND_PEER_IP:-}" | tr -cd '0-9a-fA-F:')"
  if [ -z "$peer" ]; then
    log "BACKEND_PEER_IP is not set — refusing to serve messages to an open private network."
    exit 1
  fi
  nft -f - <<NFT
add table ip6 msg_fw
delete table ip6 msg_fw
table ip6 msg_fw {
  chain input {
    type filter hook input priority 0; policy accept;
    iif "lo" accept
    ct state established,related accept
    meta l4proto ipv6-icmp accept
    tcp dport ${PORT} ip6 saddr ${peer} accept
    ip6 saddr fdaa::/16 drop
  }
}
NFT
  log "Firewall applied: port ${PORT} answers ${peer} only."
fi

mkdir -p "$DATA_ROOT/messages"
chown -R msghost:msghost "$DATA_ROOT/messages"
chmod 0700 "$DATA_ROOT/messages"

# `exec` so the server is what the machine is running: its clean exit after an
# idle spell IS the machine stopping (restart policy `no`).
exec setpriv --reuid msghost --regid msghost --clear-groups \
  env HOME=/var/lib/msghost-home \
      HOST="${HOST:-::}" \
      PORT="$PORT" \
      MSG_HOST_DB="$DATA_ROOT/messages/messages.db" \
  node --disable-warning=ExperimentalWarning /opt/msghost/msg-host.mjs
