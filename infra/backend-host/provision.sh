#!/usr/bin/env bash
#
# Idempotent provisioning for the Infinite Agents backend host (Hetzner ia-backend).
# Run as root ON the VM. Copy this whole directory to the VM first, e.g.:
#
#   rsync -az infra/backend-host/ root@<backend-host>:/root/backend-host/
#   ssh root@<backend-host> 'DEPLOY_PUBKEY="$(cat /root/backend-host/deploy_key.pub)" bash /root/backend-host/provision.sh'
#
# Leaves the VM "ready but dormant": Node 22 + app user + deploy key + systemd
# service + socket units INSTALLED BUT DISABLED AND STOPPED + placeholder env.
# It never starts either unit and never touches /etc/wireguard or wg-quick@fly.
#
# Required env:
#   DEPLOY_PUBKEY   the PUBLIC half of the GitHub Actions deploy key (one line).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER=app
APP_HOME=/opt/infinite-agents
ENV_DIR=/etc/infinite-agents
ENV_FILE="${ENV_DIR}/backend.env"
UNIT_NAME=infinite-agents-backend.service
SOCKET_NAME=infinite-agents-backend.socket
NODE_MAJOR=22

log() { printf '\n=== %s ===\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
log "APT packages (git, rsync, ufw, unattended-upgrades, ca-certs, curl)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git rsync ufw unattended-upgrades ca-certificates curl gnupg

# ---------------------------------------------------------------------------
log "Node.js ${NODE_MAJOR} LTS (NodeSource)"
current_node="$(node --version 2>/dev/null || echo none)"
if [[ "${current_node}" != v${NODE_MAJOR}.* ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "node: $(node --version)  npm: $(npm --version)"

# ---------------------------------------------------------------------------
log "Application user '${APP_USER}' and deploy target ${APP_HOME}"
if ! id "${APP_USER}" >/dev/null 2>&1; then
  # System user, no login password, own shell so the deploy SSH session works.
  useradd --system --create-home --home-dir "${APP_HOME}" --shell /bin/bash "${APP_USER}"
fi
install -d -o "${APP_USER}" -g "${APP_USER}" -m 0755 "${APP_HOME}"
install -d -o "${APP_USER}" -g "${APP_USER}" -m 0755 "${APP_HOME}/releases"

# ---------------------------------------------------------------------------
log "Deploy key -> ${APP_USER} authorized_keys"
if [[ -z "${DEPLOY_PUBKEY:-}" ]]; then
  echo "DEPLOY_PUBKEY not set; skipping authorized_keys install." >&2
  echo "Re-run with DEPLOY_PUBKEY=... to enable CI deploys." >&2
else
  install -d -o "${APP_USER}" -g "${APP_USER}" -m 0700 "${APP_HOME}/.ssh"
  AUTH="${APP_HOME}/.ssh/authorized_keys"
  touch "${AUTH}"
  # Idempotent: only add if not already present.
  if ! grep -qF "${DEPLOY_PUBKEY}" "${AUTH}"; then
    printf '%s\n' "${DEPLOY_PUBKEY}" >> "${AUTH}"
  fi
  chown "${APP_USER}:${APP_USER}" "${AUTH}"
  chmod 600 "${AUTH}"
fi

# ---------------------------------------------------------------------------
log "Placeholder env ${ENV_FILE} (mode 600, root) — real secrets added at cutover"
install -d -o root -g root -m 0755 "${ENV_DIR}"
if [[ -f "${ENV_FILE}" ]]; then
  echo "${ENV_FILE} already exists; leaving it untouched (may hold real secrets)."
else
  install -o root -g root -m 0600 "${SCRIPT_DIR}/backend.env.placeholder" "${ENV_FILE}"
fi

# ---------------------------------------------------------------------------
log "systemd units ${UNIT_NAME} + ${SOCKET_NAME} — installed DISABLED and STOPPED"
install -o root -g root -m 0644 "${SCRIPT_DIR}/${UNIT_NAME}" "/etc/systemd/system/${UNIT_NAME}"
install -o root -g root -m 0644 "${SCRIPT_DIR}/${SOCKET_NAME}" "/etc/systemd/system/${SOCKET_NAME}"
systemctl daemon-reload
# Explicitly ensure dormant. Never enable/start here.
systemctl disable "${UNIT_NAME}" "${SOCKET_NAME}" >/dev/null 2>&1 || true
if systemctl is-active --quiet "${UNIT_NAME}"; then
  systemctl stop "${UNIT_NAME}"
fi
if systemctl is-active --quiet "${SOCKET_NAME}"; then
  systemctl stop "${SOCKET_NAME}"
fi
echo "service: enabled=$(systemctl is-enabled ${UNIT_NAME} 2>&1) active=$(systemctl is-active ${UNIT_NAME} 2>&1)"
echo "socket:  enabled=$(systemctl is-enabled ${SOCKET_NAME} 2>&1) active=$(systemctl is-active ${SOCKET_NAME} 2>&1)"

# ---------------------------------------------------------------------------
log "set-machine-image helper — the one privileged action CI needs beyond restart"
# The image-build workflow repoints FLY_MACHINE_IMAGE through this, so a root
# key never has to live in GitHub Actions. It validates its argument against a
# fixed registry before touching anything.
install -o root -g root -m 0755 "${SCRIPT_DIR}/set-machine-image" /usr/local/bin/set-machine-image
# The ghcr account that owns the public image is CONFIG, not source: the helper
# reads it from here and refuses without it. Provisioning cannot invent the
# value, so it says so out loud rather than installing a helper that will fail
# at the one moment it is needed.
if [ ! -r "${ENV_DIR}/ghcr-owner" ]; then
  echo "  NOTE: ${ENV_DIR}/ghcr-owner is missing — set-machine-image refuses until it holds"
  echo "        the ghcr.io account that owns the public image:"
  echo "        printf '%s\\n' '<owner>' > ${ENV_DIR}/ghcr-owner && chmod 644 ${ENV_DIR}/ghcr-owner"
fi

# ---------------------------------------------------------------------------
log "sudoers: let '${APP_USER}' restart ONLY its own service (for CI deploys)"
SUDOERS=/etc/sudoers.d/infinite-agents-backend
# Both unit-name forms: sudoers matches arguments literally, and the deploy
# workflow invokes systemctl WITHOUT the .service suffix.
UNIT_BASE="${UNIT_NAME%.service}"
cat > "${SUDOERS}" <<EOF
# Managed by infra/backend-host/provision.sh — do not edit by hand.
${APP_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${UNIT_NAME}, /usr/bin/systemctl stop ${UNIT_NAME}, /usr/bin/systemctl start ${UNIT_NAME}, /usr/bin/systemctl restart ${UNIT_BASE}, /usr/bin/systemctl stop ${UNIT_BASE}, /usr/bin/systemctl start ${UNIT_BASE}, /usr/local/bin/set-machine-image
EOF
chmod 440 "${SUDOERS}"
visudo -cf "${SUDOERS}"

# ---------------------------------------------------------------------------
log "sudoers: per-org WireGuard verbs (org-wireguard.ts runs these via sudo -n)"
# The backend converges client orgs' tunnels itself when an admin connects a
# cloud account from the Workspace — the exact argv shapes, nothing broader.
install -m 440 -o root -g root "$(dirname "$0")/sudoers-org-wireguard" \
  /etc/sudoers.d/infinite-agents-wireguard
visudo -cf /etc/sudoers.d/infinite-agents-wireguard

# ---------------------------------------------------------------------------
log "unattended-upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# ufw LAST, and carefully. Default: deny incoming, allow outgoing. Outgoing-allow
# keeps WireGuard's udp egress AND the `fly` interface working; ufw's built-in
# conntrack rule lets the wg return traffic back in. Only 22/tcp is opened.
log "ufw firewall (allow 22/tcp inbound only)"
ufw allow 22/tcp
ufw default deny incoming
ufw default allow outgoing
if ! ufw status | grep -q "Status: active"; then
  ufw --force enable
fi
ufw status verbose

# ---------------------------------------------------------------------------
log "WireGuard fly peer sanity check (must NOT have been disturbed)"
if wg show fly latest-handshakes >/dev/null 2>&1; then
  wg show fly latest-handshakes
else
  echo "WARNING: 'wg show fly' failed — investigate before cutover." >&2
fi

log "Provisioning complete — service and listener are dormant (disabled + stopped)."
