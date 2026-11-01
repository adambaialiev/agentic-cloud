#!/usr/bin/env bash
#
# PID 1 for a PRODUCTION deployment machine (docs/deployments-phase1.md).
#
# The rootfs is ephemeral; the ONLY durable storage is the Fly Volume at
# /data. On each boot this script:
#   1. lays out the volume (/data/site, /data/app, /data/logs) and rotates
#      the app log;
#   2. keeps a stable SSH host identity on the volume across image rolls;
#   3. injects the backend's public key (AUTHORIZED_KEYS env) for root — the
#      backend connects only as root here (deploy sync, logs, restart);
#   4. applies the same nftables firewall as the agent image: SSH :2222 only
#      from the backend peer, the public port from anywhere, all other
#      fdaa::/16 (cross-tenant) inbound dropped;
#   5. starts the workload under a restart-loop supervisor:
#        service — /data/app/run.sh exists     → run it (PORT=8080)
#        static  — /data/site has content      → caddy file-server on :8080
#      The child's pid is written to /data/app.pid; killing that pid is a
#      restart (the loop respawns it). `agentbuilt restart` does exactly that.
#   6. starts sshd in the foreground.
#
# Env vars honored:
#   AUTHORIZED_KEYS  - backend SSH public key(s), newline or literal "\n"
#                      separated. Required for deploys.
#   BACKEND_PEER_IP  - backend's 6PN address; pins SSH ingress when set
#                      (falls back to the machine's own /48 — dev/e2e).
#   PUBLIC_PORT      - public port (default 8080).
#   DATA_DIR         - volume mount point. Default /data.

set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

DATA_DIR="${DATA_DIR:-/data}"
APP_USER="app"
SITE_DIR="${DATA_DIR}/site"
APP_DIR="${DATA_DIR}/app"
LOG_DIR="${DATA_DIR}/logs"
APP_LOG="${LOG_DIR}/app.log"
PID_FILE="${DATA_DIR}/app.pid"
HOSTKEY_DIR="${DATA_DIR}/ssh"

# ---------------------------------------------------------------------------
# 1. Volume layout + log rotation.
# ---------------------------------------------------------------------------
mkdir -p "${SITE_DIR}" "${APP_DIR}" "${LOG_DIR}" "${HOSTKEY_DIR}"
chown "${APP_USER}:${APP_USER}" "${SITE_DIR}" "${APP_DIR}" "${LOG_DIR}"

# Cap the app log across boots: keep the last 1 MB when it crosses 10 MB.
# (`agentbuilt logs` reads the tail anyway; a runaway logger must not fill
# the volume.)
if [ -f "${APP_LOG}" ] && [ "$(stat -c %s "${APP_LOG}" 2>/dev/null || echo 0)" -gt 10485760 ]; then
  tail -c 1048576 "${APP_LOG}" > "${APP_LOG}.tmp" && mv "${APP_LOG}.tmp" "${APP_LOG}"
  log "Rotated ${APP_LOG} (kept last 1 MB)."
fi
touch "${APP_LOG}" && chown "${APP_USER}:${APP_USER}" "${APP_LOG}"

# ---------------------------------------------------------------------------
# 2. Stable SSH host keys on the volume (same idiom as the agent image).
# ---------------------------------------------------------------------------
if [ ! -f "${HOSTKEY_DIR}/ssh_host_ed25519_key" ]; then
  log "Generating SSH host keys on the volume."
  ssh-keygen -q -t ed25519 -N '' -f "${HOSTKEY_DIR}/ssh_host_ed25519_key"
fi
mkdir -p /etc/ssh
cp "${HOSTKEY_DIR}/ssh_host_ed25519_key" "${HOSTKEY_DIR}/ssh_host_ed25519_key.pub" /etc/ssh/
chmod 600 /etc/ssh/ssh_host_ed25519_key

# ---------------------------------------------------------------------------
# 3. Backend key → root only. No development user here: every management
#    action (sync, logs, restart) is the backend acting on the user's behalf.
# ---------------------------------------------------------------------------
if [ -n "${AUTHORIZED_KEYS:-}" ]; then
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  printf '%b\n' "${AUTHORIZED_KEYS//\\n/$'\n'}" > /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  log "Installed AUTHORIZED_KEYS for root."
else
  log "WARNING: AUTHORIZED_KEYS unset; backend cannot connect."
fi

# ---------------------------------------------------------------------------
# 4. Firewall — same contract as the agent image's apply_machine_firewall,
#    minus expose_port (deployment machines serve exactly one public port).
# ---------------------------------------------------------------------------
apply_machine_firewall() {
  local own6 allowed prefix i
  own6=""
  for i in 1 2 3 4 5 6 7 8 9 10; do
    own6="$(ip -6 -o addr show scope global 2>/dev/null \
              | awk '{print $4}' | cut -d/ -f1 \
              | grep -iE '^fdaa:' | head -n1 || true)"
    [ -n "${own6}" ] && break
    sleep 1
  done

  if [ -z "${own6}" ] && [ -z "${BACKEND_PEER_IP:-}" ]; then
    log "No fdaa (6PN) address present; skipping firewall (local/docker run)."
    return 0
  fi

  if [ -n "${BACKEND_PEER_IP:-}" ]; then
    allowed="${BACKEND_PEER_IP}"
  else
    prefix="$(printf '%s' "${own6}" | awk -F: '{ printf "%s:%s:%s::/48", $1, $2, $3 }')"
    allowed="${prefix}"
  fi

  if ! command -v nft >/dev/null 2>&1; then
    log "WARNING: nft not found; cannot apply firewall."
    return 0
  fi

  local public_port
  public_port="$(printf '%s' "${PUBLIC_PORT:-8080}" | tr -cd '0-9')"
  [ -n "${public_port}" ] || public_port="8080"

  if nft -f - <<EOF
add table ip6 fly_fw
delete table ip6 fly_fw
table ip6 fly_fw {
  chain input {
    type filter hook input priority 0; policy accept;
    iif "lo" accept
    ct state established,related accept
    meta l4proto ipv6-icmp accept
    tcp dport 2222 ip6 saddr ${allowed} accept
    tcp dport ${public_port} accept
    ip6 saddr fdaa::/16 drop
  }
}
EOF
  then
    log "Firewall applied: SSH :2222 from ${allowed}; public :${public_port}."
  else
    log "WARNING: failed to apply nftables firewall; continuing without it."
  fi
}
apply_machine_firewall

# ---------------------------------------------------------------------------
# 5. The workload, under a restart-loop supervisor.
#
# Mode is re-decided from the volume on EVERY cycle, not once at boot: a
# freshly provisioned machine boots with an empty volume, and the first sync
# lands minutes later when payment clears — the supervisor must notice and
# start serving without a machine restart (first E2E, 2026-08-04). It also
# means a redeploy that changes shape (static → service) applies on the next
# respawn. run.sh wins when both exist.
# ---------------------------------------------------------------------------
start_supervisor() {
  log "Starting workload supervisor (mode re-read from the volume each cycle)."

  # The loop runs as root but each child is dropped to ${APP_USER}. The child
  # pid on ${PID_FILE} is the restart hook: kill it and the loop respawns the
  # workload in ~2s. Detached (setsid) so sshd's lifecycle never touches it.
  setsid bash -c '
    DATA_DIR="'"${DATA_DIR}"'"
    APP_LOG="'"${APP_LOG}"'"; PID_FILE="'"${PID_FILE}"'"
    PUBLIC_PORT="'"${PUBLIC_PORT:-8080}"'"
    announced_idle=""
    while true; do
      if [ -x "${DATA_DIR}/app/run.sh" ]; then
        MODE="service"
      elif [ -d "${DATA_DIR}/site" ] && [ -n "$(ls -A "${DATA_DIR}/site" 2>/dev/null)" ]; then
        MODE="static"
      else
        if [ -z "${announced_idle}" ]; then
          echo "[supervisor] nothing to serve yet; waiting for the first deploy" >> "${APP_LOG}"
          announced_idle=1
        fi
        sleep 5
        continue
      fi
      announced_idle=""
      if [ "${MODE}" = "service" ]; then
        runuser -u '"${APP_USER}"' -- env PORT="${PUBLIC_PORT}" \
          bash -c "cd \"${DATA_DIR}/app\" && exec ./run.sh" >> "${APP_LOG}" 2>&1 &
      else
        runuser -u '"${APP_USER}"' -- \
          caddy file-server --root "${DATA_DIR}/site" --listen ":${PUBLIC_PORT}" \
          >> "${APP_LOG}" 2>&1 &
      fi
      child=$!
      echo "${child}" > "${PID_FILE}"
      wait "${child}"
      code=$?
      echo "[supervisor] workload (${MODE}, pid ${child}) exited ${code}; re-evaluating in 2s" >> "${APP_LOG}"
      sleep 2
    done
  ' &
}
start_supervisor

# ---------------------------------------------------------------------------
# 6. sshd in the foreground (PID 1's child; keeps the machine alive).
# ---------------------------------------------------------------------------
log "Starting sshd on :2222."
mkdir -p /run/sshd
exec /usr/sbin/sshd -D -e
