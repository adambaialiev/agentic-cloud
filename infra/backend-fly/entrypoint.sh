#!/usr/bin/env bash
# The backend's Fly machine (note #1032, stage 4): the volume, sshd, the holder.
#
# The volume at /data is bind-mounted onto the paths ia-backend used, so
# deploy-prod, ia-rollback, set-machine-image and every operator habit find
# what they expect, and `readlink -f` answers the same paths as on the box:
#   /data/opt        -> /opt/infinite-agents     (releases/, current, last-attempt)
#   /data/etc        -> /etc/infinite-agents     (backend.env, ghcr-owner)
#   /data/var        -> /var/lib/infinite-agents (backend.db)
#   /data/local-bin  -> /usr/local/bin           (ia-rollback, set-machine-image, as deploys install them)
set -euo pipefail

for pair in opt:/opt/infinite-agents etc:/etc/infinite-agents var:/var/lib/infinite-agents local-bin:/usr/local/bin; do
  src="/data/${pair%%:*}" dst="${pair#*:}"
  mkdir -p "$src" "$dst"
  mountpoint -q "$dst" || mount --bind "$src" "$dst"
done
chmod 700 /data/etc
mkdir -p /opt/infinite-agents/releases /data/state /data/log /data/ssh /run/sshd /root/.ssh

# The two on-host commands, from this image the first time; every deploy
# replaces them on the volume afterwards.
for f in ia-rollback set-machine-image; do
  [ -e "/usr/local/bin/$f" ] || install -m 0755 "/opt/ia-seed/$f" "/usr/local/bin/$f"
done

# sshd on the private network only, port 2222 (Fly's own `fly ssh` holds 22).
# The app has no public service on 2222, so only machines in our own
# organization can reach it, and only with the deploy key.
[ -f /data/ssh/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N '' -f /data/ssh/ssh_host_ed25519_key
umask 077
printf '%s\n' "${DEPLOY_AUTHORIZED_KEYS:-}" | sed '/^[[:space:]]*$/d' > /root/.ssh/authorized_keys
umask 022
if [ -s /root/.ssh/authorized_keys ]; then
  /usr/sbin/sshd -p 2222 -o HostKey=/data/ssh/ssh_host_ed25519_key \
    -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
    -o PermitRootLogin=prohibit-password -o ClientAliveInterval=30
else
  echo "[entrypoint] DEPLOY_AUTHORIZED_KEYS is empty: no sshd, so deploys cannot reach this machine" >&2
fi

exec python3 /usr/local/sbin/holder.py
