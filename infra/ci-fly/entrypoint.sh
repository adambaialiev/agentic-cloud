#!/bin/bash
# CI on Fly (note #1032 stage 3). See Dockerfile for the two roles.
set -euo pipefail
ROLE="${CI_ROLE:?CI_ROLE must be dispatcher or builder}"

write_secret_file() { # <path> <owner> <value>
  # Blank lines dropped: a multi-line Fly secret imported with """ quotes
  # arrives with one at each end, and OpenSSH refuses such a key ("error in
  # libcrypto"). No key or authorized_keys line ever contains one.
  umask 077; printf '%s\n' "$3" | sed '/^[[:space:]]*$/d' > "$1"; chown "$2" "$1"; chmod 600 "$1"
}

if [ "$ROLE" = builder ]; then
  mkdir -p /data/docker /data/ssh /root/.ssh
  # Host keys on the volume, so the dispatcher's known_hosts stays valid.
  for t in ed25519 rsa; do
    [ -f "/data/ssh/ssh_host_${t}_key" ] || ssh-keygen -q -t "$t" -N '' -f "/data/ssh/ssh_host_${t}_key"
  done
  write_secret_file /root/.ssh/authorized_keys root "${BUILDER_SSH_PUBKEY:?BUILDER_SSH_PUBKEY unset}"
  dockerd --data-root /data/docker > /var/log/dockerd.log 2>&1 &
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info --format 'dockerd {{.ServerVersion}}, {{.Driver}}' || { tail -20 /var/log/dockerd.log; exit 1; }
  # Private network only: this app has no services, so nothing outside the
  # organisation can reach it, and only the dispatcher holds the key. Port
  # 2222, because Fly's own `fly ssh` service holds port 22 on 6PN.
  exec /usr/sbin/sshd -D -e -p 2222 \
    -o HostKey=/data/ssh/ssh_host_ed25519_key -o HostKey=/data/ssh/ssh_host_rsa_key \
    -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
    -o PermitRootLogin=prohibit-password -o AcceptEnv='*'
fi

[ "$ROLE" = dispatcher ] || { echo "unknown CI_ROLE $ROLE" >&2; exit 2; }
R=/data/runner
mkdir -p "$R/ci-work" "$R/ci-logs" "$R/ci-artifacts" "$R/.ssh" /data/opt-ia-ci
# First boot: the daemon's code from the image. After that, the self-update
# job owns /opt/ia-ci, exactly as on the box.
[ -f /data/opt-ia-ci/daemon.mjs ] || cp -a /opt/ia-ci-seed/. /data/opt-ia-ci/
write_secret_file "$R/.ssh/deploy_key" runner "${DEPLOY_SSH_KEY:?DEPLOY_SSH_KEY unset}"
write_secret_file "$R/.ssh/builder_key" runner "${BUILDER_SSH_KEY:?BUILDER_SSH_KEY unset}"
cat > "$R/.ssh/config" <<CFG
Host ia-ci-builder
  HostName ${CI_BUILDER_APP:-ia-ci-builder}.internal
  Port 2222
  User root
  IdentityFile $R/.ssh/builder_key
  StrictHostKeyChecking accept-new
  UserKnownHostsFile $R/.ssh/known_hosts_builder
  ServerAliveInterval 30
CFG
chown -R runner:runner "$R" /data/opt-ia-ci

# CI_DAEMON=off keeps the machine up without the daemon: the state before a
# cutover, when the old dispatcher still owns the webhooks.
if [ "${CI_DAEMON:-on}" = off ]; then
  echo "CI_DAEMON=off: dispatcher idle"; exec sleep infinity
fi
# Restart=always, as systemd gave it: the self-update job ends the daemon on
# purpose (.restart-requested) and expects it back on the new code.
while true; do
  setpriv --reuid runner --regid runner --init-groups \
    env -u DEPLOY_SSH_KEY -u BUILDER_SSH_KEY -u BUILDER_SSH_PUBKEY \
    env HOME="$R" WORKDIR="$R/ci-work" LOG_DIR="$R/ci-logs" ARTIFACT_DIR="$R/ci-artifacts" \
        RUNJOB=/opt/ia-ci/run-job.sh DOCKER_HOST="${CI_DOCKER_HOST:-ssh://ia-ci-builder}" \
    node /opt/ia-ci/daemon.mjs || echo "daemon exited $?"
  sleep 3
done
