#!/usr/bin/env bash
#
# Nightly off-box backup of every bare repo on ia-media, as git bundles.
#
#   /var/lib/agentgit/repos/<userId>/<name>.git
#       -> <target>/git/<userId>/<name>/<YYYY-MM-DD>.bundle
#
# Why bundles and not a tar of the .git directory: a bundle is a single file
# that git itself can verify and clone from, so a restore is `git clone
# <file>` and a *test* of a restore is one command. A tarball is only ever as
# good as the last time somebody tried it.
#
# Why off the box at all: repos, media and (today) the database backups all
# live on this one 38 GB disk. A backup that dies with the box is not one.
#
# Why sftp rather than rsync: the intended target is a Hetzner Storage Box,
# whose SSH side is a restricted shell — sftp is the part guaranteed to be
# there, and it needs no matching rsync version on the far end. Bundles are
# fresh files every time, so rsync's delta transfer would buy nothing anyway.
#
# Runs as `agentgit` from agentgit-backup.timer. Reads its config from
# /etc/agentgit/backup.env; does nothing at all until BACKUP_SSH_TARGET is set,
# so provisioning this before the target exists is harmless.
#
set -euo pipefail

REPOS_ROOT="${REPOS_ROOT:-/var/lib/agentgit/repos}"
STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/agentgit/backup-state}"
LOCK_FILE="${BACKUP_LOCK_FILE:-/var/lib/agentgit/backup.lock}"

# Retention. Read the prune rules below before changing these: the newest
# bundle of a repo is kept regardless of what they say.
KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-8}"

# Transport. `sftp` is production; `local` writes to a directory, which is what
# the tests drive and what a locally-mounted target would use.
TRANSPORT="${BACKUP_TRANSPORT:-sftp}"
TARGET="${BACKUP_SSH_TARGET:-}"          # user@host:base/path
LOCAL_ROOT="${BACKUP_LOCAL_ROOT:-}"
SSH_PORT="${BACKUP_SSH_PORT:-23}"        # 23 is a Storage Box; a normal host is 22
SSH_KEY="${BACKUP_SSH_KEY:-/etc/agentgit/backup_key}"
# ProtectHome=true in the unit means ssh cannot write ~/.ssh/known_hosts, and
# an unwritable known_hosts turns accept-new into a hard failure on first run.
KNOWN_HOSTS="${BACKUP_KNOWN_HOSTS:-/var/lib/agentgit/known_hosts}"

# Operational notifications. Absent or unconfigured means silent.
NOTIFY="${BACKUP_NOTIFY:-/opt/agentgit/notify.sh}"
# Tells the backend this run happened, so it can notice when they stop.
HEARTBEAT="${BACKUP_HEARTBEAT:-/opt/agentgit/backup-heartbeat.sh}"

TODAY="$(date -u +%F)"
STAMP="$(date -u +%FT%TZ)"

# Tallied across the run and reported once at the end, so a normal night is one
# message rather than one per repo.
n_uploaded=0
n_unchanged=0
n_empty=0
bytes_uploaded=0
failures=""

log()  { printf '[backup-repos] %s\n' "$*"; }
warn() { printf '[backup-repos] WARNING: %s\n' "$*" >&2; }

# ── Transport ───────────────────────────────────────────────────────────────
# Three operations, one implementation each per transport: make a directory
# path, put a file there atomically, list a directory, remove a file.

sftp_userhost=""
sftp_base=""
target_id=""      # identifies the destination; part of the per-repo state key
notify_target=""  # the same destination, short enough to read on a phone

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
      # Host and path only. The login name adds nothing an operator reading a
      # phone notification needs.
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

# Batch sftp. Every caller passes commands on stdin. Commands that are allowed
# to fail are prefixed with `-` by the caller, per sftp's own convention.
sftp_run() {
  sftp -q -b - \
    -P "$SSH_PORT" \
    -i "$SSH_KEY" \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new \
    -o "UserKnownHostsFile=$KNOWN_HOSTS" \
    -o ConnectTimeout=20 \
    "$sftp_userhost"
}

# Makes the directory path exist and clears anything sitting at the target name
# — a bundle from an earlier run today, or a .part left by a killed one. sftp
# has no `mkdir -p`, so each component is its own command and every one of them
# is allowed to fail: "already exists" is the normal case.
#
# All of it happens in one batch whose output is discarded, so that the only
# sftp errors reaching the journal come from the upload itself. sftp prints
# "No such file or directory" for a delete of a file that is not there even
# when the command is marked ignorable, and a nightly job must not cry wolf.
remote_prepare() {
  local rel="$1" target="$2" path="" component prefix="" full
  if [[ "$TRANSPORT" == local ]]; then
    mkdir -p "$sftp_base/$rel"
    rm -f "$sftp_base/$target" "$sftp_base/$target.part"
    return
  fi
  full="$sftp_base/$rel"
  # Splitting an absolute path on "/" yields an empty first field, and dropping
  # it silently turns /srv/backups into a relative srv/backups built under the
  # sftp login directory — where the mkdirs succeed, the puts then fail, and
  # the tree is in the wrong place entirely.
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

# Atomic by construction: land the bytes under a temp name, then rename over
# the target. A half-finished `put` must never be left sitting at a path whose
# name says it is a complete backup of that day.
remote_put() {
  local src="$1" rel="$2"
  # Deliberately not folded into the line above: bash expands every word of a
  # `local` statement before assigning any of them, so a $rel there would read
  # the CALLER's rel, not this one.
  local dst="$sftp_base/$rel"
  local tmp="$sftp_base/$rel.part"
  if [[ "$TRANSPORT" == local ]]; then
    cp "$src" "$tmp" && mv -f "$tmp" "$dst"
    return
  fi
  # sftp echoes every command it runs in batch mode and there is no flag to
  # stop it, so a healthy night would be three lines of transcript per repo.
  # Hold it all, throw it away when the transfer worked, and print the whole
  # thing when it did not — the failing case is the only one worth reading.
  local out
  if out="$(printf -- 'put %s %s\nrename %s %s\n' "$src" "$tmp" "$tmp" "$dst" | sftp_run 2>&1)"; then
    return 0
  fi
  printf '%s\n' "$out" >&2
  return 1
}

# Only ever returns names matching the bundle pattern. Anything else on the
# far end — sftp banners, path prefixes, a stray .part from a killed run — is
# filtered out here rather than parsed, so the prune logic below can trust it.
remote_ls() {
  local rel="$1" out
  if [[ "$TRANSPORT" == local ]]; then
    [[ -d "$sftp_base/$rel" ]] || return 0
    out="$(ls -1 "$sftp_base/$rel" 2>/dev/null || true)"
  else
    out="$(printf 'cd %s\nls -1\n' "$sftp_base/$rel" | sftp_run 2>/dev/null || true)"
  fi
  # ${line##*/} rather than basename: this runs once per bundle on the far end,
  # and a repo at full retention would otherwise fork two dozen processes a
  # night to strip a path prefix bash can strip for free.
  printf '%s\n' "$out" \
    | while IFS= read -r line; do line="${line%$'\r'}"; printf '%s\n' "${line##*/}"; done \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.bundle$' || true
}

remote_rm() {
  local rel="$1"
  if [[ "$TRANSPORT" == local ]]; then
    rm -f "$sftp_base/$rel"
    return
  fi
  printf -- 'rm %s\n' "$sftp_base/$rel" | sftp_run >/dev/null 2>&1
}

# ── Retention ───────────────────────────────────────────────────────────────
# Reads bundle filenames on stdin, prints the ones to DELETE.
#
# The first rule exists because of the second: repos that never change are
# skipped by the uploader below, so a pure age rule would quietly delete the
# last copy of every idle repo. The newest bundle is therefore never a
# candidate, whatever its age.
prune_plan() {
  local newest="" weeks_kept=0 seen_weeks=" " name date age week
  local sorted; sorted="$(sort -r)"
  [[ -n "$sorted" ]] || return 0
  newest="$(printf '%s\n' "$sorted" | head -1)"

  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    [[ "$name" != "$newest" ]] || continue          # rule 1: never the newest

    date="${name%.bundle}"
    age=$(( ( $(date -u -d "$TODAY" +%s) - $(date -u -d "$date" +%s) ) / 86400 ))
    if (( age <= KEEP_DAILY )); then
      continue                                       # rule 2: recent dailies
    fi
    week="$(date -u -d "$date" +%G-%V)"              # rule 3: one per ISO week
    if [[ "$seen_weeks" != *" $week "* ]] && (( weeks_kept < KEEP_WEEKLY )); then
      seen_weeks+="$week "
      weeks_kept=$(( weeks_kept + 1 ))
      continue
    fi
    printf '%s\n' "$name"
  done <<<"$sorted"
}

# ── One repository ──────────────────────────────────────────────────────────

backup_repo() {
  local repo="$1" owner name rel state fingerprint bundle
  owner="$(basename "$(dirname "$repo")")"
  name="$(basename "$repo" .git)"
  rel="git/$owner/$name"
  state="$STATE_DIR/$owner/$name"

  # A repo with no refs is a repo somebody created and never pushed to.
  # `git bundle create --all` refuses to make an empty bundle, and it is right
  # to: there is nothing here to lose yet.
  if [[ -z "$(git --git-dir "$repo" for-each-ref --count=1 2>/dev/null)" ]]; then
    log "$owner/$name: empty, nothing to back up"
    n_empty=$(( n_empty + 1 ))
    return 0
  fi

  # Every ref and what it points at, plus which target it went to. If this has
  # not moved since the last successful upload, the bundle would be
  # byte-for-byte redundant — and most repos are idle most nights, so this is
  # the common path.
  #
  # The target is part of the key deliberately. Keyed on the refs alone, moving
  # BACKUP_SSH_TARGET to a new box would leave every repo looking "already
  # backed up" and the new target empty for as long as nobody pushed.
  fingerprint="$(
    { git --git-dir "$repo" for-each-ref --format='%(objectname) %(refname)'; printf 'target %s\n' "$target_id"; } \
      | sha256sum | cut -d' ' -f1
  )"

  local listing=""
  if [[ -f "$state" ]] && [[ "$(cat "$state")" == "$fingerprint" ]]; then
    # Trust, then verify. State is a claim about the far end, and the far end
    # is where things get deleted by accident. If it holds nothing for this
    # repo, the claim is wrong and the only safe reading is "not backed up".
    listing="$(remote_ls "$rel")"
    if [[ -n "$listing" ]]; then
      log "$owner/$name: unchanged since last backup"
      n_unchanged=$(( n_unchanged + 1 ))
      prune_repo "$rel" "$listing"
      return 0
    fi
    warn "$owner/$name: state says backed up but the target holds nothing — uploading again"
  fi

  bundle="$WORK/$name.bundle"
  # One repo at a time, deleted the moment it is uploaded. This disk is the
  # constraint the whole git host is designed around; a run that bundled
  # everything first would need a second copy of every repo to do it.
  # `--all` alone makes a bundle that holds every object but no HEAD, and
  # `git clone` of one lands you in "remote HEAD refers to nonexistent ref,
  # unable to checkout": no working tree, no local branch, just remote-tracking
  # refs. The data is all there, but a restore should not need explaining.
  # Naming HEAD explicitly is what makes the clone come out checked out.
  #
  # Only when it resolves, though. A repo whose HEAD points at a branch that
  # no longer exists makes `bundle create ... HEAD` fail outright, and a repo
  # that fails to bundle is a repo with no backup at all — far worse than one
  # that restores a little less tidily.
  local -a refs=(--all)
  if git --git-dir "$repo" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    refs+=(HEAD)
  else
    warn "$owner/$name: HEAD does not resolve — bundling refs only"
  fi
  if ! git --git-dir "$repo" bundle create "$bundle" "${refs[@]}" >/dev/null 2>&1; then
    warn "$owner/$name: bundle creation failed"
    failures+="$owner/$name — bundle creation failed"$'\n'
    rm -f "$bundle"
    return 1
  fi
  # Verify before upload, not after: an unverifiable bundle is worth finding
  # out about here, where the real repo is still sitting next to it.
  if ! git --git-dir "$repo" bundle verify "$bundle" >/dev/null 2>&1; then
    warn "$owner/$name: bundle failed verification — NOT uploaded"
    failures+="$owner/$name — bundle failed verification"$'\n'
    rm -f "$bundle"
    return 1
  fi

  remote_prepare "$rel" "$rel/$TODAY.bundle"
  if ! remote_put "$bundle" "$rel/$TODAY.bundle"; then
    warn "$owner/$name: upload failed"
    failures+="$owner/$name — upload failed"$'\n'
    rm -f "$bundle"
    return 1
  fi
  log "$owner/$name: uploaded $TODAY.bundle ($(du -h "$bundle" | cut -f1))"
  n_uploaded=$(( n_uploaded + 1 ))
  bytes_uploaded=$(( bytes_uploaded + $(stat -c %s "$bundle" 2>/dev/null || echo 0) ))
  rm -f "$bundle"

  # Written only after the bytes are on the far end, so a failed upload is
  # retried tomorrow rather than recorded as done.
  mkdir -p "$(dirname "$state")"
  printf '%s\n' "$fingerprint" > "$state"

  prune_repo "$rel"
  return 0
}

# ── Pruning ─────────────────────────────────────────────────────────────────

# Housekeeping, never fatal: a prune that fails costs disk on the target, while
# a prune that fails the *run* would turn a full target into "no backups at
# all" and hide the upload that actually succeeded.
prune_repo() {
  local rel="$1" listing="${2-}" doomed name
  # The caller passes a listing it already fetched, so an idle repo costs one
  # round trip a night rather than two.
  [[ -n "$listing" ]] || listing="$(remote_ls "$rel")" || return 0
  [[ -n "$listing" ]] || return 0
  doomed="$(printf '%s\n' "$listing" | prune_plan)" || return 0
  [[ -n "$doomed" ]] || return 0
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if remote_rm "$rel/$name"; then
      log "  pruned $rel/$name"
    else
      warn "could not prune $rel/$name"
    fi
  done <<<"$doomed"
}

# ── Run ─────────────────────────────────────────────────────────────────────

main() {
  setup_transport

  [[ -d "$REPOS_ROOT" ]] || { warn "$REPOS_ROOT does not exist"; exit 1; }
  mkdir -p "$STATE_DIR"

  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  local failed=0 total=0
  log "starting $STAMP (transport=$TRANSPORT)"

  # Sorted so a log from two different nights can be diffed.
  while IFS= read -r repo; do
    total=$(( total + 1 ))
    backup_repo "$repo" || failed=$(( failed + 1 ))
  done < <(find "$REPOS_ROOT" -mindepth 2 -maxdepth 2 -type d -name '*.git' | sort)

  log "finished: $total repo(s), $failed failure(s)"
  notify_summary "$total" "$failed"
  # A non-zero exit is what makes `systemctl status agentgit-backup` and the
  # journal say something went wrong. Silence is the enemy here.
  (( failed == 0 ))
}

# One message per run, not per repo. A nightly "all fine" is the point rather
# than noise: the failure this whole job protects against is silence, and an
# operator who sees a green line every morning notices the morning it stops.
notify_summary() {
  local total="$1" failed="$2" size head body
  # Before the notifier guard on purpose: the heartbeat is what makes a job
  # that stops running visible at all, so it must fire even on a box where the
  # Telegram notifier is missing or unconfigured.
  if [[ -x "$HEARTBEAT" ]]; then
    if (( failed > 0 )); then
      "$HEARTBEAT" git fail "$failed of $total repos failed" || true
    else
      "$HEARTBEAT" git ok "$total repos, 0 failures" || true
    fi
  fi
  # Intra-day runs (agentgit-backup-hot.service) succeed silently: the
  # operator's contract stays one green line per day, from the nightly run,
  # while every failure — whichever run hits it — still says its piece below.
  # After the heartbeat on purpose: quiet must never mean unaccounted-for.
  if (( failed == 0 )) && [[ "${BACKUP_QUIET_OK:-0}" == 1 ]]; then
    return 0
  fi
  [[ -x "$NOTIFY" ]] || return 0

  # Human units. The exact byte count is in the journal for anyone who wants it.
  if (( bytes_uploaded >= 1048576 )); then
    size="$(( bytes_uploaded / 1048576 )) MB"
  elif (( bytes_uploaded >= 1024 )); then
    size="$(( bytes_uploaded / 1024 )) KB"
  else
    size="${bytes_uploaded} B"
  fi

  if (( failed > 0 )); then
    head="🔴 git backups FAILED — $(hostname)"
  else
    head="✅ git backups OK — $(hostname)"
  fi

  body="$head"$'\n'
  body+="$total repos · $n_uploaded uploaded ($size) · $n_unchanged unchanged"
  (( n_empty > 0 )) && body+=" · $n_empty empty"
  body+=$'\n'"target: $notify_target"
  if (( failed > 0 )); then
    body+=$'\n\n'"$failed failed:"$'\n'"${failures%$'\n'}"
  fi

  "$NOTIFY" "$body" || true
}

# Manual runs are the reason for this, not the timer: systemd will not start a
# oneshot that is already running, but a person on the box will.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another backup run holds the lock — exiting"
  exit 0
fi

main "$@"
