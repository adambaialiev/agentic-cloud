#!/usr/bin/env bash
#
# Nightly off-box backup of the platform database, straight from ia-backend to
# the Storage Box.
#
#   /var/lib/dbbackup/spool/backend.db  ->  <target>/db/<YYYY-MM-DD>.db.gz
#
# The snapshot itself is taken by snapshot-db.sh, which the unit runs as root
# before this. By the time this script starts, the database is a plain file in
# the spool that this user owns; from here on nothing needs privileges and
# nothing touches the live database.
#
# WHY THIS EXISTS AS ITS OWN JOB. Until it did, the database's only off-box
# copy was a side effect of the object-store backup: sqlite-backup.mjs uploaded
# the nightly snapshot INTO MinIO on ia-media, and a 04:30 media job then
# carried the whole object store — snapshot included — to the Storage Box. That
# chain worked, but it meant the most important dataset on the platform was
# backed up by the job that exists for the least important one, and restoring
# it meant restoring a MinIO tree and standing MinIO up to get one file out,
# because objects on disk carry inline bitrot hashes and are not the file you
# stored. Now the database travels on its own, and a restore is a download and
# a gunzip. Both halves of that old path have since been retired.
#
# The transport, retention and pruning below started life in the object-store
# job and are kept verbatim: same Storage Box, same failure modes, and one set
# of habits to remember at 3am rather than two. The git bundle job next door
# (infra/git-host/backup-repos.sh) is the last other user of these shapes.
#
set -euo pipefail

SPOOL_DIR="${DB_BACKUP_SPOOL_DIR:-/var/lib/dbbackup/spool}"
STATE_DIR="${DB_BACKUP_STATE_DIR:-/var/lib/dbbackup}"
LOCK_FILE="${DB_BACKUP_LOCK_FILE:-/var/lib/dbbackup/backup.lock}"
STATE_FILE="$STATE_DIR/fingerprint"
SNAPSHOT="$SPOOL_DIR/backend.db"

KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-8}"

TRANSPORT="${BACKUP_TRANSPORT:-sftp}"
TARGET="${BACKUP_SSH_TARGET:-}"
LOCAL_ROOT="${BACKUP_LOCAL_ROOT:-}"
SSH_PORT="${BACKUP_SSH_PORT:-23}"
SSH_KEY="${BACKUP_SSH_KEY:-/etc/dbbackup/backup_key}"
KNOWN_HOSTS="${BACKUP_KNOWN_HOSTS:-/var/lib/dbbackup/known_hosts}"

NOTIFY="${DB_BACKUP_NOTIFY:-/opt/dbbackup/notify.sh}"
# Tells the backend this run happened, so it can notice when they stop.
HEARTBEAT="${DB_BACKUP_HEARTBEAT:-/opt/dbbackup/backup-heartbeat.sh}"

TODAY="$(date -u +%F)"
STAMP="$(date -u +%FT%TZ)"
REMOTE_DIR="db"

log()  { printf '[backup-db] %s\n' "$*"; }
warn() { printf '[backup-db] WARNING: %s\n' "$*" >&2; }

sftp_userhost=""
sftp_base=""
target_id=""
notify_target=""

setup_transport() {
  case "$TRANSPORT" in
    sftp)
      [[ -n "$TARGET" ]] || { log "BACKUP_SSH_TARGET is not set — nothing to do"; exit 0; }
      [[ "$TARGET" == *:* ]] || { warn "BACKUP_SSH_TARGET must look like user@host:path"; exit 1; }
      sftp_userhost="${TARGET%%:*}"
      sftp_base="${TARGET#*:}"
      sftp_base="${sftp_base%/}"
      [[ -r "$SSH_KEY" ]] || { warn "cannot read $SSH_KEY"; exit 1; }
      touch "$KNOWN_HOSTS" 2>/dev/null || true
      target_id="sftp:$TARGET:$SSH_PORT"
      notify_target="${sftp_userhost#*@}:${sftp_base}"
      ;;
    local)
      [[ -n "$LOCAL_ROOT" ]] || { warn "BACKUP_TRANSPORT=local needs BACKUP_LOCAL_ROOT"; exit 1; }
      mkdir -p "$LOCAL_ROOT"
      sftp_base="${LOCAL_ROOT%/}"
      target_id="local:$sftp_base"
      notify_target="$sftp_base"
      ;;
    *) warn "unknown BACKUP_TRANSPORT: $TRANSPORT"; exit 1 ;;
  esac
}

sftp_run() {
  sftp -q -b - -P "$SSH_PORT" -i "$SSH_KEY" \
    -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o "UserKnownHostsFile=$KNOWN_HOSTS" -o ConnectTimeout=20 \
    "$sftp_userhost"
}

# Creates the directory path and clears anything already at today's name, in a
# batch whose output is dropped — sftp reports a delete of a missing file as an
# error even when the command is marked ignorable, and a nightly job that cries
# wolf gets ignored.
remote_prepare() {
  local target="$1"
  local path="" component prefix="" full
  if [[ "$TRANSPORT" == local ]]; then
    mkdir -p "$sftp_base/$REMOTE_DIR"
    rm -f "$sftp_base/$target" "$sftp_base/$target.part"
    return
  fi
  full="$sftp_base/$REMOTE_DIR"
  # An absolute path splits to an empty first field; dropping it silently
  # rebuilds the tree under the sftp login directory instead — invisible with
  # the relative path the Storage Box actually uses.
  [[ "$full" == /* ]] && prefix="/"
  {
    IFS='/' read -ra parts <<<"$full"
    for component in "${parts[@]}"; do
      [[ -n "$component" ]] || continue
      path="${path:+$path/}$component"
      printf -- '-mkdir %s%s\n' "$prefix" "$path"
    done
    printf -- '-rm %s\n-rm %s.part\n' "$sftp_base/$target" "$sftp_base/$target"
  } | sftp_run >/dev/null 2>&1 || true
}

remote_put() {
  local src="$1"
  local rel="$2"
  local dst="$sftp_base/$rel"
  local tmp="$sftp_base/$rel.part"
  if [[ "$TRANSPORT" == local ]]; then
    cp "$src" "$tmp" && mv -f "$tmp" "$dst"
    return
  fi
  # Land the bytes under a temp name and rename over the target: a half-sent
  # database must never sit at a path whose name claims it is a whole day.
  local out
  if out="$(printf -- 'put %s %s\nrename %s %s\n' "$src" "$tmp" "$tmp" "$dst" | sftp_run 2>&1)"; then
    return 0
  fi
  printf '%s\n' "$out" >&2
  return 1
}

remote_ls() {
  local out
  if [[ "$TRANSPORT" == local ]]; then
    [[ -d "$sftp_base/$REMOTE_DIR" ]] || return 0
    out="$(ls -1 "$sftp_base/$REMOTE_DIR" 2>/dev/null || true)"
  else
    out="$(printf 'cd %s\nls -1\n' "$sftp_base/$REMOTE_DIR" | sftp_run 2>/dev/null || true)"
  fi
  printf '%s\n' "$out" \
    | while IFS= read -r line; do line="${line%$'\r'}"; printf '%s\n' "${line##*/}"; done \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.db\.gz$' || true
}

remote_rm() {
  local rel="$1"
  if [[ "$TRANSPORT" == local ]]; then
    rm -f "$sftp_base/$rel"
    return
  fi
  printf -- 'rm %s\n' "$sftp_base/$rel" | sftp_run >/dev/null 2>&1
}

# Reads archive names on stdin, prints the ones to delete. Identical rules to
# the git bundles and the object store: recent dailies, then one per ISO week —
# and never the newest, whatever its age, because an unchanged database is
# skipped by the uploader and a pure age rule would eventually delete the only
# copy.
prune_plan() {
  local newest="" weeks_kept=0 seen_weeks=" " name date age week
  local sorted
  sorted="$(sort -r)"
  [[ -n "$sorted" ]] || return 0
  newest="$(printf '%s\n' "$sorted" | head -1)"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    [[ "$name" != "$newest" ]] || continue
    date="${name%.db.gz}"
    age=$(( ( $(date -u -d "$TODAY" +%s) - $(date -u -d "$date" +%s) ) / 86400 ))
    (( age <= KEEP_DAILY )) && continue
    week="$(date -u -d "$date" +%G-%V)"
    if [[ "$seen_weeks" != *" $week "* ]] && (( weeks_kept < KEEP_WEEKLY )); then
      seen_weeks+="$week "
      weeks_kept=$(( weeks_kept + 1 ))
      continue
    fi
    printf '%s\n' "$name"
  done <<<"$sorted"
}

prune() {
  local listing="${1-}"
  local doomed name
  [[ -n "$listing" ]] || listing="$(remote_ls)" || return 0
  [[ -n "$listing" ]] || return 0
  doomed="$(printf '%s\n' "$listing" | prune_plan)" || return 0
  [[ -n "$doomed" ]] || return 0
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if remote_rm "$REMOTE_DIR/$name"; then
      log "  pruned $REMOTE_DIR/$name"
    else
      # Housekeeping is never fatal: a prune that failed the run would hide the
      # upload that succeeded.
      warn "could not prune $REMOTE_DIR/$name"
    fi
  done <<<"$doomed"
}

notify_result() {
  local status="$1"
  local detail="$2"
  local body
  # Before the notifier guard on purpose: the heartbeat is what makes a job
  # that stops running visible at all, so it must fire even on a box where the
  # Telegram notifier is missing or unconfigured.
  [[ -x "$HEARTBEAT" ]] && "$HEARTBEAT" db "$status" "$detail" || true
  [[ -x "$NOTIFY" ]] || return 0
  if [[ "$status" == ok ]]; then
    body="✅ database backup OK — $(hostname)"
  else
    body="🔴 database backup FAILED — $(hostname)"
  fi
  body+=$'\n'"$detail"$'\n'"target: $notify_target"
  "$NOTIFY" "$body" || true
}

main() {
  setup_transport

  if [[ ! -f "$SNAPSHOT" ]]; then
    # snapshot-db.sh runs as ExecStartPre and fails the unit if it cannot
    # produce this, so reaching here means someone ran the uploader alone.
    warn "no snapshot at $SNAPSHOT — snapshot-db.sh has not run"
    notify_result fail "no snapshot to upload — snapshot-db.sh did not run"
    return 1
  fi

  mkdir -p "$STATE_DIR"
  log "starting $STAMP (transport=$TRANSPORT)"

  local work
  work="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$work'; rm -f '$SNAPSHOT'" EXIT

  # Of the snapshot's own bytes, not the compressed artifact: gzip embeds an
  # mtime, so two compressions of an identical database differ.
  local digest fingerprint
  digest="$(sha256sum "$SNAPSHOT" | cut -d' ' -f1)"
  fingerprint="$(printf '%s %s\n' "$digest" "$target_id" | sha256sum | cut -d' ' -f1)"

  local listing=""
  if [[ -f "$STATE_FILE" ]] && [[ "$(cat "$STATE_FILE")" == "$fingerprint" ]]; then
    # State is a claim about the far end, and the far end is where things get
    # deleted by accident.
    listing="$(remote_ls)"
    if [[ -n "$listing" ]]; then
      log "database unchanged since last backup"
      prune "$listing"
      notify_result ok "unchanged — $(du -h "$SNAPSHOT" | cut -f1) on disk, nothing to send"
      return 0
    fi
    warn "state says backed up but the target holds nothing — uploading again"
  fi

  local archive="$work/$TODAY.db.gz"
  if ! gzip -c "$SNAPSHOT" > "$archive"; then
    warn "gzip failed"
    notify_result fail "could not compress the snapshot"
    return 1
  fi

  # Verify what will actually be SENT, by putting it back through the whole
  # path a restore takes: decompress it, open it with SQLite, ask SQLite
  # whether it is intact. `gzip -t` alone only proves the envelope survived.
  local restored="$work/verify.db"
  if ! gzip -dc "$archive" > "$restored" 2>/dev/null; then
    warn "archive did not decompress — NOT uploaded"
    notify_result fail "the archive did not decompress"
    return 1
  fi
  local check
  if ! check="$(sqlite3 "$restored" 'PRAGMA integrity_check;' 2>/dev/null)" || [[ "$check" != "ok" ]]; then
    warn "decompressed archive failed integrity_check — NOT uploaded"
    notify_result fail "the archive did not verify as a database"
    return 1
  fi
  rm -f "$restored"

  local size
  size="$(du -h "$archive" | cut -f1)"
  remote_prepare "$REMOTE_DIR/$TODAY.db.gz"
  if ! remote_put "$archive" "$REMOTE_DIR/$TODAY.db.gz"; then
    warn "upload failed"
    notify_result fail "upload to $notify_target failed"
    return 1
  fi
  log "uploaded $TODAY.db.gz ($size)"

  # Only after the bytes are on the far end, so a failed upload retries
  # tomorrow rather than being recorded as done.
  printf '%s\n' "$fingerprint" > "$STATE_FILE"

  prune

  local tables
  tables="$(sqlite3 "$SNAPSHOT" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo '?')"
  notify_result ok "$tables tables · $size uploaded"
  return 0
}

# Before the lock, not inside main: the lock file lives in the state directory
# and `exec 9>` cannot create a path that is not there yet.
mkdir -p "$(dirname "$LOCK_FILE")" "$STATE_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another run holds the lock — exiting"
  exit 0
fi

main "$@"
