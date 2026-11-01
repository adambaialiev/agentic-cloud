#!/usr/bin/env bash
#
# Takes a consistent snapshot of the live SQLite database into a spool
# directory, and hands it to the unprivileged uploader.
#
#   /var/lib/infinite-agents/backend.db  ->  /var/lib/dbbackup/spool/backend.db
#
# This is the ONLY part of the backup that needs privileges, which is exactly
# why it is its own script: the unit runs it via `ExecStartPre=+`, so the step
# that reads the database runs as root while the step that holds the Storage
# Box key runs as `dbbackup` and cannot read the database at all.
#
# Why it cannot simply run unprivileged: the database is in WAL mode. A reader
# has to attach to the -shm file to take a read transaction, and the directory
# is owned by `app`. It would appear to work — the backend keeps a valid -shm
# on disk — right up until the backend is stopped, which is precisely when you
# most want a snapshot to be possible.
#
# `.backup` is SQLite's online backup API, not a file copy: it is safe against
# a database being written underneath it, and it folds the WAL into the result.
# A `cp` of backend.db here would silently omit 1.6 MB of committed WAL.
#
set -euo pipefail

DB="${SQLITE_DB_PATH:-/var/lib/infinite-agents/backend.db}"
SPOOL_DIR="${DB_BACKUP_SPOOL_DIR:-/var/lib/dbbackup/spool}"
SERVICE_USER="${DB_BACKUP_USER:-dbbackup}"
SNAPSHOT="$SPOOL_DIR/backend.db"

log()  { printf '[snapshot-db] %s\n' "$*"; }
warn() { printf '[snapshot-db] WARNING: %s\n' "$*" >&2; }

[[ -f "$DB" ]] || { warn "$DB does not exist"; exit 1; }

mkdir -p "$SPOOL_DIR"

# Never write directly at the name the uploader reads: a snapshot interrupted
# half-written must not be mistaken for a whole one.
part="$SNAPSHOT.part"
rm -f "$part"

if ! sqlite3 "$DB" ".backup '$part'" 2>/dev/null; then
  warn "sqlite3 .backup failed"
  rm -f "$part"
  exit 1
fi

# Read it back with SQLite itself. A snapshot that will not open is a snapshot
# that will not restore, and here the original is still right next to it.
if ! result="$(sqlite3 "$part" 'PRAGMA integrity_check;' 2>/dev/null)" || [[ "$result" != "ok" ]]; then
  warn "snapshot failed integrity_check: ${result:-<no output>}"
  rm -f "$part"
  exit 1
fi

# An empty-but-valid database passes integrity_check happily. Backing one up
# over a good copy is the failure mode that looks like success for weeks, so
# refuse it rather than report a green run.
tables="$(sqlite3 "$part" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo 0)"
if (( tables < 1 )); then
  warn "snapshot holds no tables — refusing to hand over an empty database"
  rm -f "$part"
  exit 1
fi

mv -f "$part" "$SNAPSHOT"

# The uploader runs as an unprivileged user and has to be able to read this.
# 0600 because the row values include the platform's secrets: encrypted at
# rest since #1089, but the ciphertext is still nobody else's business.
if [[ $EUID -eq 0 ]] && id -u "$SERVICE_USER" >/dev/null 2>&1; then
  chown "$SERVICE_USER:$SERVICE_USER" "$SNAPSHOT"
fi
chmod 600 "$SNAPSHOT"

log "snapshot ready: $(du -h "$SNAPSHOT" | cut -f1), $tables tables"
