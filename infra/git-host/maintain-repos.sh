#!/usr/bin/env bash
#
# Weekly on-box maintenance of every bare repo: a full `git gc` per repo, so
# loose objects and stale packs never quietly spend the one resource this box
# is designed around — its disk.
#
# Why a scheduled job at all: pushes meet `git gc --auto` inside receive-pack,
# and the host runs the same after each approved merge (merge-tree/commit-tree
# write loose objects no receive-pack ever sees). But --auto is a threshold
# check, and a repo can sit just under the threshold forever — this is the
# backstop that also collects what --auto never touches: stale reflogs, old
# packs, and the long tail of idle repos.
#
# Full `git gc`, not --auto, because this runs once a week in a quiet hour and
# its point is exactly the work the cheap path declined. It is safe beside
# concurrent pushes and merges: gc takes its own locks, and anything newer
# than gc.pruneExpire (14 days by default) survives even while unreachable —
# which also means an object created by a push this job races is never at
# risk.
#
# Runs as `agentgit` from agentgit-maintenance.timer. Reports failures through
# notify.sh (with repo names); a healthy run is a journal line, not a message
# — the weekly green line the backups earn exists because backup silence is
# invisible, while a gc that stops running shows up in /health's
# diskUsedPercent long before it hurts.
set -euo pipefail

REPOS_ROOT="${REPOS_ROOT:-/var/lib/agentgit/repos}"
TRASH_ROOT="${TRASH_ROOT:-$(dirname "$REPOS_ROOT")/trash}"
# How long a deleted repo stays restorable. This job is the ONLY thing that
# purges, so this number is the retention window in full — the product promise
# in `agentbuilt repo delete`'s output has to match it.
TRASH_KEEP_DAYS="${TRASH_KEEP_DAYS:-14}"
LOCK_FILE="${MAINT_LOCK_FILE:-/var/lib/agentgit/maintenance.lock}"
NOTIFY="${MAINT_NOTIFY:-/opt/agentgit/notify.sh}"

log()  { printf '[maintain-repos] %s\n' "$*"; }
warn() { printf '[maintain-repos] WARNING: %s\n' "$*" >&2; }

repo_kb() { du -sk "$1" 2>/dev/null | cut -f1 || echo 0; }

# Deleted repos, past their window (docs/agent-git-project-repos.md slice 5).
#
# Age is read from the directory's mtime, which git-host.mjs STAMPS as it moves
# the repo in — rename(2) leaves mtime at the repo's last write, so an idle repo
# would otherwise land here already older than the window. The stamp in the name
# says the same thing and is only a label; the mtime is what this `find` can
# actually ask about. Never fatal — a purge that fails costs disk, while exiting
# here would skip the gc pass this job exists for.
purge_trash() {
  [[ -d "$TRASH_ROOT" ]] || return 0

  local entry owner name purged=0 freed_kb=0 size
  while IFS= read -r entry; do
    owner="$(basename "$(dirname "$entry")")"
    name="$(basename "$entry")"
    size="$(repo_kb "$entry")"
    if rm -rf -- "$entry"; then
      purged=$(( purged + 1 ))
      freed_kb=$(( freed_kb + size ))
      log "purged $owner/$name (deleted more than ${TRASH_KEEP_DAYS}d ago, ${size} KB)"
    else
      warn "could not purge $owner/$name"
    fi
  done < <(find "$TRASH_ROOT" -mindepth 2 -maxdepth 2 -type d -name '*.git' \
             -mtime "+${TRASH_KEEP_DAYS}" | sort)

  (( purged > 0 )) && log "trash: $purged repo(s) purged, ${freed_kb} KB freed"
  # Empty per-user directories, once their last entry is gone.
  find "$TRASH_ROOT" -mindepth 1 -maxdepth 1 -type d -empty -delete 2>/dev/null || true
  return 0
}

main() {
  [[ -d "$REPOS_ROOT" ]] || { warn "$REPOS_ROOT does not exist"; exit 1; }

  # Before the gc pass, so the week's freed disk includes it — and so a purge
  # that goes wrong is visible in the same run rather than a week later.
  purge_trash

  local total=0 failed=0 failures="" freed_kb=0
  local repo owner name before after

  # Sorted so logs from two different weeks can be diffed.
  while IFS= read -r repo; do
    total=$(( total + 1 ))
    owner="$(basename "$(dirname "$repo")")"
    name="$(basename "$repo" .git)"
    before="$(repo_kb "$repo")"
    # nice: MinIO shares these cores, and nothing about housekeeping is urgent.
    if nice -n 10 git --git-dir "$repo" gc --quiet 2>/dev/null; then
      after="$(repo_kb "$repo")"
      freed_kb=$(( freed_kb + before - after ))
      log "$owner/$name: ${before} KB -> ${after} KB"
    else
      warn "$owner/$name: gc failed"
      failures+="$owner/$name"$'\n'
      failed=$(( failed + 1 ))
    fi
  done < <(find "$REPOS_ROOT" -mindepth 2 -maxdepth 2 -type d -name '*.git' | sort)

  log "finished: $total repo(s), $failed failure(s), $(( freed_kb > 0 ? freed_kb : 0 )) KB freed"

  if (( failed > 0 )) && [[ -x "$NOTIFY" ]]; then
    "$NOTIFY" "🔴 git maintenance FAILED — $(hostname)
$failed of $total repos failed gc:
${failures%$'\n'}

  journalctl -u agentgit-maintenance -n 50" || true
  fi
  (( failed == 0 ))
}

# Manual runs are the reason for this, not the timer: systemd will not start a
# oneshot that is already running, but a person on the box will.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another maintenance run holds the lock — exiting"
  exit 0
fi

main "$@"
