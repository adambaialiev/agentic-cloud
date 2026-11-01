#!/usr/bin/env bash
# Put the backend back on a release it already ran, by flipping the `current`
# symlink. Layer 1 of a bad day (docs/platform-on-own-git.md): most outages
# are "we shipped something bad", and the fix is going back one step — this
# command touches neither git nor the backend's own machinery, and it lives
# ON the backend box (installed by every deploy as /usr/local/bin/ia-rollback)
# so it still works when the CI runner is sick too.
#
# Usage: ia-rollback           # newest release that is not `current`
#        ia-rollback <sha>     # a specific releases/<sha>
#        ia-rollback --list    # show what there is to roll to
set -euo pipefail

ROOT=/opt/infinite-agents
RELEASES="$ROOT/releases"
SERVICE=infinite-agents-backend
HEALTH_URL="http://localhost:3001/api/health"

current="$(readlink -f "$ROOT/current" 2>/dev/null || true)"

list() {
  local d marker
  for d in $(ls -1dt "$RELEASES"/*/ 2>/dev/null); do
    d="${d%/}"
    marker=" "
    [ "$(readlink -f "$d")" = "$current" ] && marker="*"
    printf '%s %s  %s\n' "$marker" "$(date -u -r "$d" +%FT%TZ)" "$(basename "$d")"
  done
}

if [ "${1:-}" = "--list" ]; then
  list
  exit 0
fi

target=""
if [ -n "${1:-}" ]; then
  if [ ! -d "$RELEASES/$1" ]; then
    echo "no such release: $RELEASES/$1 — these exist:" >&2
    list >&2
    exit 1
  fi
  target="$RELEASES/$1"
else
  # Newest release that is not the one currently running.
  for d in $(ls -1dt "$RELEASES"/*/ 2>/dev/null); do
    d="${d%/}"
    if [ "$(readlink -f "$d")" != "$current" ]; then
      target="$d"
      break
    fi
  done
  if [ -z "$target" ]; then
    echo "nothing to roll back to — only the current release exists" >&2
    exit 1
  fi
fi

if [ "$(readlink -f "$target")" = "$current" ]; then
  echo "already on $(basename "$target") — nothing to do"
  exit 0
fi

echo "rolling: $(basename "${current:-none}") -> $(basename "$target")"
ln -sfn "$target" "$ROOT/current"

# Same guard as deploy-prod: a deliberately dormant service stays down.
if ! systemctl is-enabled --quiet "$SERVICE"; then
  echo "service dormant — symlink flipped, not started"
  exit 0
fi
systemctl restart "$SERVICE"

for i in $(seq 1 12); do
  # Socket activation makes the TCP handshake succeed even when no Node
  # process is accepting yet. Bound the whole request, not just the connect.
  code=$(curl -fsS --max-time 3 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)
  if [ "$code" = "200" ]; then
    echo "healthy on $(basename "$target") after $i attempt(s)"
    exit 0
  fi
  sleep 2
done
# Deliberately no automatic flip-back: a rollback that rolls itself back can
# ping-pong, and the operator is already at a terminal. Say it loudly instead.
echo "backend did not answer 200 on $(basename "$target") after ~60s — NOT flipping back on its own; ia-rollback --list and pick" >&2
exit 1
