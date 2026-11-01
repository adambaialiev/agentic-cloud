#!/bin/sh
# Boot the git host on a Fly machine: prepare the volume, drop privileges,
# serve. Runs as root exactly long enough to own the volume's directories —
# the server itself runs as the unprivileged `agentgit`, the same split the
# ia-media systemd unit enforces with ReadWritePaths.
set -eu

DATA_ROOT="${DATA_ROOT:-/data}"
mkdir -p "$DATA_ROOT/repos" "$DATA_ROOT/trash"
chown -R agentgit:agentgit "$DATA_ROOT"

# `::` binds both families: the backend arrives over the org's WireGuard peer
# and agent machines over 6PN (IPv6); the Fly proxy health checks over IPv4.
exec setpriv --reuid agentgit --regid agentgit --clear-groups \
  env HOME=/var/lib/agentgit-home \
      HOST="${HOST:-::}" \
      PORT="${PORT:-8080}" \
      REPOS_ROOT="$DATA_ROOT/repos" \
      TRASH_ROOT="$DATA_ROOT/trash" \
  node /opt/agentgit/git-host.mjs
