#!/usr/bin/env bash
#
# Idempotent provisioning for the internal git host on ia-media
# (docs/agent-git-phase1.md). Run as root ON the box. Copy this directory
# there first:
#
#   rsync -az infra/git-host/ root@<git-host>:/root/git-host/
#   ssh root@<git-host> 'GIT_HOST_SECRET=... BACKEND_URL=https://... bash /root/git-host/provision.sh'
#
# What it does: an `agentgit` service user, the repos directory, Node (only if
# missing), the systemd unit, and a Caddy vhost for git.<ip>.sslip.io.
#
# What it deliberately does NOT touch: MinIO, its data at /srv/minio/data, the
# existing Caddy vhost, or the firewall's existing rules. This box's first job
# is storage; the git service is a guest on it.
#
# Required env:
#   GIT_HOST_SECRET   shared secret, same value as the backend's
#   BACKEND_URL       public origin of the platform backend
# Optional:
#   GIT_VHOST         the hostname to serve (default git.<public-ip>.sslip.io)
#   REPOS_ROOT        default /var/lib/agentgit/repos
#   BACKEND_IPS       space-separated IPs allowed to reach /internal/*
#                     (default: the ia-backend hosts)
#   CI_WEBHOOK_URL    the ONE CI dispatcher a repo may notify, e.g.
#   CI_WEBHOOK_SECRET http://<runner>:8787/webhook + its shared secret.
#                     Repos turn CI on through the API by BOOLEAN; the URL
#                     lives here so a caller can never aim this host at an
#                     address of their choosing. Unset → `repo ci enable`
#                     refuses and every repo stays silent, as before.
#                     BOTH are re-read from this script's environment on
#                     every run: omit them on a later run and CI goes dark
#                     host-wide, so pass them every time (same rule as
#                     GIT_HOST_SECRET).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER=agentgit
APP_DIR=/opt/agentgit
ENV_DIR=/etc/agentgit
ENV_FILE="${ENV_DIR}/agentgit.env"
BACKUP_ENV_FILE="${ENV_DIR}/backup.env"
BACKUP_KEY_FILE="${ENV_DIR}/backup_key"
OPS_NOTIFY_ENV_FILE="${ENV_DIR}/ops-notify.env"
REPOS_ROOT="${REPOS_ROOT:-/var/lib/agentgit/repos}"
UNIT_NAME=agentgit.service
NODE_MAJOR=22

log() { printf '\n=== %s ===\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root" >&2
  exit 1
fi
# No apostrophes or parentheses in these messages: bash 5.2 mis-parses a quote
# inside ${VAR:?word} and silently swallows the following lines, which fails
# far away from the real cause (the next variable reads as "unbound").
: "${GIT_HOST_SECRET:?set GIT_HOST_SECRET - the same value as the backend}"
: "${BACKEND_URL:?set BACKEND_URL - the public origin of the platform backend}"

PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
fi
[[ -n "$PUBLIC_IP" ]] || { echo "could not determine this box's public IPv4; set GIT_VHOST explicitly" >&2; exit 1; }
# Deliberately not one nested expansion: bash 5.2 (Ubuntu 24.04, this box)
# raises a spurious "unbound variable" for the INNER name when a pattern
# substitution sits inside a ${x:-default} and `set -u` is on.
GIT_VHOST_DEFAULT="git.${PUBLIC_IP//./-}.sslip.io"
GIT_VHOST="${GIT_VHOST:-$GIT_VHOST_DEFAULT}"
# ia-backend. (ia-backend-dev used to be listed here; that box was deleted on
# 2026-09-05 — note #343.) Override when the backend moves.
BACKEND_IPS="${BACKEND_IPS:?set BACKEND_IPS to the backend host public IP}"

# ---------------------------------------------------------------------------
log "Packages (git, curl, ca-certificates)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates

# ---------------------------------------------------------------------------
# Node only if absent: this box may already run something that pins a version,
# and silently upgrading a neighbour's runtime is exactly the kind of drift a
# storage box should not suffer.
if command -v node >/dev/null 2>&1; then
  log "Node already present ($(node --version)) — leaving it alone"
else
  log "Node.js ${NODE_MAJOR} LTS (NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi

# ---------------------------------------------------------------------------
log "Service user + directories"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
# The trash is a sibling of the repos root, so a delete is a rename on one
# filesystem (docs/agent-git-project-repos.md slice 5). Deliberately NOT an
# env var: `deploy-git-host` does not re-run this script, so a new variable
# would reach a live box only by hand — git-host.mjs derives the same path
# from REPOS_ROOT instead, and this line only settles ownership up front.
mkdir -p "$APP_DIR" "$ENV_DIR" "$REPOS_ROOT" "$(dirname "$REPOS_ROOT")/trash"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$(dirname "$REPOS_ROOT")"
chmod 700 "$(dirname "$REPOS_ROOT")"
# root:agentgit, not root:root. The files in here are already 640 root:agentgit,
# but the DIRECTORY was root:root 750 — which the service never noticed, because
# systemd reads its EnvironmentFile as root before dropping privileges. The
# backup job is the first thing to run AS agentgit and read a file here, and it
# could not traverse the directory to reach its own key.
chown root:"$SERVICE_USER" "$ENV_DIR"
chmod 750 "$ENV_DIR"

# ---------------------------------------------------------------------------
log "Service files"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "${SCRIPT_DIR}/git-host.mjs" "${APP_DIR}/git-host.mjs"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "${SCRIPT_DIR}/backup-repos.sh" "${APP_DIR}/backup-repos.sh"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "${SCRIPT_DIR}/notify.sh" "${APP_DIR}/notify.sh"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "${SCRIPT_DIR}/notify-unit-failure.sh" "${APP_DIR}/notify-unit-failure.sh"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "${SCRIPT_DIR}/backup-heartbeat.sh" "${APP_DIR}/backup-heartbeat.sh"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "${SCRIPT_DIR}/maintain-repos.sh" "${APP_DIR}/maintain-repos.sh"
# ALL the hooks, not a listed one: git-host.mjs reads every name in its
# HOOK_NAMES at startup, so a hook missing here is a service that cannot boot
# on a fresh box (post-receive was missing from this line until 2026-08-12).
mkdir -p "${APP_DIR}/hooks"
for hook in "${SCRIPT_DIR}/hooks/"*; do
  install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$hook" "${APP_DIR}/hooks/$(basename "$hook")"
done

# The env file is rewritten every run: the secret and backend URL come from
# this script's environment, so a rotation is one re-run.
cat > "$ENV_FILE" <<EOF
PORT=3002
REPOS_ROOT=${REPOS_ROOT}
GIT_HOST_SECRET=${GIT_HOST_SECRET}
BACKEND_URL=${BACKEND_URL}
DISK_MAX_USED_PERCENT=${DISK_MAX_USED_PERCENT:-80}
CI_WEBHOOK_URL=${CI_WEBHOOK_URL:-}
CI_WEBHOOK_SECRET=${CI_WEBHOOK_SECRET:-}
RECOVERY_TOKEN_SHA256=${RECOVERY_TOKEN_SHA256:-}
RECOVERY_TOKEN_OWNER=${RECOVERY_TOKEN_OWNER:-}
RECOVERY_TOKEN_REPO=${RECOVERY_TOKEN_REPO:-}
EOF
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

install -m 0644 "${SCRIPT_DIR}/${UNIT_NAME}" "/etc/systemd/system/${UNIT_NAME}"
install -m 0644 "${SCRIPT_DIR}/agentgit-backup.service" /etc/systemd/system/agentgit-backup.service
install -m 0644 "${SCRIPT_DIR}/agentgit-backup.timer" /etc/systemd/system/agentgit-backup.timer
install -m 0644 "${SCRIPT_DIR}/agentgit-backup-hot.service" /etc/systemd/system/agentgit-backup-hot.service
install -m 0644 "${SCRIPT_DIR}/agentgit-backup-hot.timer" /etc/systemd/system/agentgit-backup-hot.timer
install -m 0644 "${SCRIPT_DIR}/agentgit-backup-failed@.service" '/etc/systemd/system/agentgit-backup-failed@.service'
install -m 0644 "${SCRIPT_DIR}/agentgit-maintenance.service" /etc/systemd/system/agentgit-maintenance.service
install -m 0644 "${SCRIPT_DIR}/agentgit-maintenance.timer" /etc/systemd/system/agentgit-maintenance.timer

# ---------------------------------------------------------------------------
log "Backup config and key"
# Unlike agentgit.env, this file is created ONCE and never rewritten: it holds
# the backup target, which an operator sets by hand and which no environment
# variable of this script knows. Re-provisioning must not silently unpoint the
# backups.
if [[ ! -f "$BACKUP_ENV_FILE" ]]; then
  cat > "$BACKUP_ENV_FILE" <<'EOF'
# Off-box backup target for the git repos. Until BACKUP_SSH_TARGET is set the
# nightly job does nothing at all, successfully.
#
# For a Hetzner Storage Box (port 23, path relative to the account home):
#   BACKUP_SSH_TARGET=u123456@u123456.your-storagebox.de:git-backups
#   BACKUP_SSH_PORT=23
# For an ordinary SSH host, use port 22 and any path the user can write.
BACKUP_SSH_TARGET=
BACKUP_SSH_PORT=23
BACKUP_SSH_KEY=/etc/agentgit/backup_key
BACKUP_KEEP_DAILY=14
BACKUP_KEEP_WEEKLY=8

# Reports every run to the backend's staleness monitor, which is what notices
# if this job stops running at all. Both unset means silent.
BACKUP_HEARTBEAT_URL=
BACKUP_HEARTBEAT_SECRET=
EOF
  chown root:"$SERVICE_USER" "$BACKUP_ENV_FILE"
  chmod 640 "$BACKUP_ENV_FILE"
  log "wrote ${BACKUP_ENV_FILE} - set BACKUP_SSH_TARGET in it to switch backups on"
else
  log "${BACKUP_ENV_FILE} already exists - leaving it alone"
fi

# Same rule as backup.env: created once, never rewritten. The bot token is set
# by hand and no environment variable of this script knows it.
if [[ ! -f "$OPS_NOTIFY_ENV_FILE" ]]; then
  cat > "$OPS_NOTIFY_ENV_FILE" <<'EOF'
# Operational Telegram bot. Backup runs report here; unset means silent, which
# is why installing this before the bot exists costs nothing.
#
# Token from @BotFather. Chat id: message the bot once, then
#   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"id":[0-9-]*'
TELEGRAM_OPS_BOT_TOKEN=
TELEGRAM_OPS_CHAT_ID=
EOF
  chown root:"$SERVICE_USER" "$OPS_NOTIFY_ENV_FILE"
  chmod 640 "$OPS_NOTIFY_ENV_FILE"
  log "wrote ${OPS_NOTIFY_ENV_FILE} - fill it in to switch notifications on"
else
  log "${OPS_NOTIFY_ENV_FILE} already exists - leaving it alone"
fi

# The key is generated here rather than by hand so the private half never
# travels: only the public half below ever leaves this box.
if [[ ! -f "$BACKUP_KEY_FILE" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C "agentgit-backup@$(hostname)" -f "$BACKUP_KEY_FILE"
  log "generated a backup key"
fi
chown root:"$SERVICE_USER" "$BACKUP_KEY_FILE" "${BACKUP_KEY_FILE}.pub"
chmod 640 "$BACKUP_KEY_FILE"
chmod 644 "${BACKUP_KEY_FILE}.pub"

# ---------------------------------------------------------------------------
log "Caddy vhost for ${GIT_VHOST}"
CADDYFILE=/etc/caddy/Caddyfile
if [[ -f "$CADDYFILE" ]] && ! grep -q "${GIT_VHOST}" "$CADDYFILE"; then
  # Appended as a SEPARATE vhost, never a path inside the MinIO one: a routing
  # mistake must not be able to expose one service through the other's URLs.
  cat >> "$CADDYFILE" <<EOF

${GIT_VHOST} {
	# Pushes of a large repo take a while and stream; the default 100s read
	# timeout would sever them mid-pack.
	request_body {
		max_size 512MB
	}
	# The control API is for the backend only. It already requires the shared
	# secret, but there is no reason for it to be reachable from the internet
	# at all — defence in depth, and it makes scanning it a non-event.
	@internal_foreign {
		path /internal/*
		not remote_ip ${BACKEND_IPS}
	}
	respond @internal_foreign 404
	reverse_proxy 127.0.0.1:3002
}
EOF
  systemctl reload caddy || systemctl restart caddy
else
  log "Caddyfile already mentions ${GIT_VHOST} (or Caddy is not installed) — not touching it"
fi

# ---------------------------------------------------------------------------
log "Enabling the service"
systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
# The timers are safe to start before a target is configured: the backup job
# exits 0 immediately while BACKUP_SSH_TARGET is empty, and maintenance needs
# no configuration at all.
systemctl enable --now agentgit-backup.timer
systemctl enable --now agentgit-backup-hot.timer
systemctl enable --now agentgit-maintenance.timer
sleep 1
systemctl --no-pager --lines=10 status "$UNIT_NAME" || true

cat <<EOF

Done.

  repos root : ${REPOS_ROOT}
  service    : ${UNIT_NAME}  (journalctl -u ${UNIT_NAME} -f)
  public URL : https://${GIT_VHOST}
  CI         : ${CI_WEBHOOK_URL:-not configured — \`repo ci enable\` will refuse}

Set these on the BACKEND host and restart it:

  GIT_HOST_BASE_URL=https://${GIT_VHOST}
  GIT_HOST_CONTROL_URL=https://${GIT_VHOST}
  GIT_HOST_SECRET=<the same secret>

Health check from this box:

  curl -s localhost:3002/health

Backups (nightly, off-box) are installed but INACTIVE until you point them
somewhere. Add this public key to the target, then set BACKUP_SSH_TARGET in
${BACKUP_ENV_FILE}:

$(cat "${BACKUP_KEY_FILE}.pub")

  systemctl start agentgit-backup    # run one now
  journalctl -u agentgit-backup -n 50

EOF
