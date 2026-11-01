#!/usr/bin/env bash
#
# Idempotent provisioning for the database backup on ia-backend. Run as root
# ON the box. Copy this directory there first, together with the two notifier
# scripts it shares with the git host:
#
#   rsync -az infra/db-backup/ \
#         infra/git-host/notify.sh infra/git-host/notify-unit-failure.sh \
#         infra/git-host/backup-heartbeat.sh \
#         root@<backend-host>:/root/db-backup/
#   ssh root@<backend-host> 'bash /root/db-backup/provision.sh'
#
# Creates an unprivileged `dbbackup` user, its state, spool and config, an SSH
# key for the Storage Box, and the timer. Installs everything INACTIVE: without
# BACKUP_SSH_TARGET the job exits 0 having done nothing.
#
# What it deliberately does NOT touch: the backend, its release directories, or
# the live database. This is the only thing backing the database up now — the
# old two-hop path through MinIO (scripts/sqlite-backup.mjs plus the
# object-store job) was retired once this had run and been restore-drilled.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER=dbbackup
APP_DIR=/opt/dbbackup
ENV_DIR=/etc/dbbackup
STATE_DIR=/var/lib/dbbackup
SPOOL_DIR="${STATE_DIR}/spool"
ENV_FILE="${ENV_DIR}/backup.env"
KEY_FILE="${ENV_DIR}/backup_key"
OPS_NOTIFY_ENV_FILE="${ENV_DIR}/ops-notify.env"
SQLITE_DB_PATH="${SQLITE_DB_PATH:-/var/lib/infinite-agents/backend.db}"

log() { printf '\n=== %s ===\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Must run as root" >&2; exit 1; }

command -v sqlite3 >/dev/null 2>&1 || {
  echo "sqlite3 is not installed — the snapshot step cannot run without it" >&2
  exit 1
}

# ---------------------------------------------------------------------------
log "Service user + directories"
id -u "$SERVICE_USER" >/dev/null 2>&1 \
  || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DIR" "$ENV_DIR" "$STATE_DIR" "$SPOOL_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$STATE_DIR" "$SPOOL_DIR"
chmod 750 "$APP_DIR" "$STATE_DIR"
# The spool holds a whole copy of the database between the snapshot step and
# the upload. Nobody but this user has any business reading it.
chmod 700 "$SPOOL_DIR"
# root:dbbackup, not root:root. The job runs AS this user and reads its key out
# of here, so it has to be able to traverse the directory — the exact thing
# that broke the git host's first real backup run.
chown root:"$SERVICE_USER" "$ENV_DIR"
chmod 750 "$ENV_DIR"

# ---------------------------------------------------------------------------
log "Service files"
# Root-owned and not writable by the service user: this one runs AS ROOT via
# ExecStartPre=+, so a dbbackup-writable file here would be a way to escalate
# out of the unprivileged half of the job into the privileged one.
install -o root -g root -m 0755 "${SCRIPT_DIR}/snapshot-db.sh" "${APP_DIR}/snapshot-db.sh"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 \
  "${SCRIPT_DIR}/backup-db.sh" "${APP_DIR}/backup-db.sh"

# The notifier binary is shared with the git host on ia-media, but that box is
# not this one — ia-backend has no /opt/agentgit, so it gets its own copy from
# the same source file in the repo.
for helper in notify.sh notify-unit-failure.sh backup-heartbeat.sh; do
  if [[ -f "${SCRIPT_DIR}/${helper}" ]]; then
    install -o root -g root -m 0755 "${SCRIPT_DIR}/${helper}" "${APP_DIR}/${helper}"
  else
    log "WARNING: ${helper} was not copied alongside this script - notifications will be silent"
  fi
done

install -m 0644 "${SCRIPT_DIR}/dbbackup.service" /etc/systemd/system/dbbackup.service
install -m 0644 "${SCRIPT_DIR}/dbbackup.timer" /etc/systemd/system/dbbackup.timer
install -m 0644 "${SCRIPT_DIR}/dbbackup-failed@.service" '/etc/systemd/system/dbbackup-failed@.service'

# ---------------------------------------------------------------------------
log "Config and key"
# Created once, never rewritten: it holds the backup target, which an operator
# sets by hand and no environment variable of this script knows.
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
# Off-box backup target for the platform database. Until BACKUP_SSH_TARGET is
# set the nightly job does nothing at all, successfully.
#
# Same Storage Box as the git bundles and the object store, its own directory:
#   BACKUP_SSH_TARGET=u123456@u123456.your-storagebox.de:db-backups
BACKUP_SSH_TARGET=
BACKUP_SSH_PORT=23
BACKUP_SSH_KEY=${KEY_FILE}
SQLITE_DB_PATH=${SQLITE_DB_PATH}
BACKUP_KEEP_DAILY=14
BACKUP_KEEP_WEEKLY=8

# Reports every run to the backend's staleness monitor, which is what notices
# if this job stops running at all. Both unset means silent.
BACKUP_HEARTBEAT_URL=
BACKUP_HEARTBEAT_SECRET=
EOF
  chown root:"$SERVICE_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  log "wrote ${ENV_FILE} - set BACKUP_SSH_TARGET in it to switch backups on"
else
  log "${ENV_FILE} already exists - leaving it alone"
fi

if [[ ! -f "$OPS_NOTIFY_ENV_FILE" ]]; then
  cat > "$OPS_NOTIFY_ENV_FILE" <<'EOF'
# Operational Telegram bot. Same bot the git host and the object-store backup
# report to; unset is silent. Token from @BotFather, chat id from getUpdates.
TELEGRAM_OPS_BOT_TOKEN=
TELEGRAM_OPS_CHAT_ID=
EOF
  chown root:"$SERVICE_USER" "$OPS_NOTIFY_ENV_FILE"
  chmod 640 "$OPS_NOTIFY_ENV_FILE"
  log "wrote ${OPS_NOTIFY_ENV_FILE} - fill it in for notifications"
fi

# Generated here so the private half never travels; only the public half is
# ever printed.
if [[ ! -f "$KEY_FILE" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C "dbbackup@$(hostname)" -f "$KEY_FILE"
  log "generated a backup key"
fi
chown root:"$SERVICE_USER" "$KEY_FILE" "${KEY_FILE}.pub"
chmod 640 "$KEY_FILE"
chmod 644 "${KEY_FILE}.pub"

# ---------------------------------------------------------------------------
log "Enabling the timer"
systemctl daemon-reload
# Safe before a target exists: the job exits 0 immediately without one.
systemctl enable --now dbbackup.timer

cat <<EOF

Done.

  database   : ${SQLITE_DB_PATH} (read by the root pre-step only)
  spool      : ${SPOOL_DIR}
  state      : ${STATE_DIR}
  timer      : dbbackup.timer  (journalctl -u dbbackup -f)

Add this public key to the Storage Box, then set BACKUP_SSH_TARGET in
${ENV_FILE}:

$(cat "${KEY_FILE}.pub")

  systemctl start dbbackup     # run one now

EOF
