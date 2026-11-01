#!/usr/bin/env bash
#
# Reports one backup run to the backend's staleness monitor.
#
#   backup-heartbeat.sh <job> <ok|fail> [detail]
#
# The green Telegram line these jobs already send is only useful to someone who
# notices the morning it DOESN'T arrive, and nobody does. So every run also
# tells the backend it happened, and the backend watches the gaps — see
# backend/src/services/backup-monitor.ts.
#
# Shared by both backup jobs (git bundles on ia-media, the database on
# ia-backend) exactly like notify.sh next to it: one source file, installed on
# both boxes, so the two can never drift into reporting differently.
#
# It NEVER fails its caller and never blocks it for long. A monitor that cannot
# be reached must not turn a successful backup into a failed one — the whole
# point of this file is to make silence visible, and it would be absurd for it
# to cause an outage of the thing it watches. Every path exits 0.
#
# Config comes from the environment, which systemd already loads from the
# service's EnvironmentFile:
#   BACKUP_HEARTBEAT_URL     https://api.agenticcloudcomputer.com/api/agent-cli/ops/backup-heartbeat
#   BACKUP_HEARTBEAT_SECRET  shared with the backend
#
# The /agent-cli prefix reads oddly for an ops endpoint and is deliberate: that
# router is where the machine-to-machine ingests already live (the CI status
# ingest is /api/agent-cli/git/statuses), and one mount point for "things with
# their own shared secret" beats a second one that has to be remembered.
# Either one unset means silent — installing this before the backend knows
# about it is a no-op, not an error.
#
# set -e is deliberately absent, for the same reason as notify.sh: an early
# exit from a failed curl is exactly the behaviour this must not have.
set -uo pipefail

JOB="${1-}"
STATUS="${2-ok}"
DETAIL="${3-}"
URL="${BACKUP_HEARTBEAT_URL-}"
SECRET="${BACKUP_HEARTBEAT_SECRET-}"
TIMEOUT="${BACKUP_HEARTBEAT_TIMEOUT:-10}"

[[ -n "$JOB" ]] || exit 0
[[ -n "$URL" && -n "$SECRET" ]] || exit 0
[[ "$STATUS" == "fail" ]] || STATUS=ok

# Only ever ok/fail plus a short human detail. Built with a here-doc rather
# than string concatenation so a quote in the detail cannot produce invalid
# JSON — a malformed body would be accepted and dropped by the route, which is
# the silent-success failure this whole system exists to prevent.
payload="$(JOB="$JOB" STATUS="$STATUS" DETAIL="$DETAIL" python3 -c '
import json, os
print(json.dumps({
    "job": os.environ["JOB"],
    "status": os.environ["STATUS"],
    "detail": os.environ["DETAIL"][:500],
}))' 2>/dev/null)" || payload=""

if [[ -z "$payload" ]]; then
  # No python3, or it failed. Fall back to a minimal body with the detail
  # dropped: reporting THAT the backup ran matters; the prose does not.
  payload="{\"job\":\"${JOB}\",\"status\":\"${STATUS}\"}"
fi

# The secret goes in a HEADER, never the URL: curl prints the URL it was
# fetching in its error messages, and those land in the journal.
code="$(
  curl -sS -m "$TIMEOUT" -o /dev/null -w '%{http_code}' \
    -X POST "$URL" \
    -H 'content-type: application/json' \
    -H "x-backup-heartbeat-secret: ${SECRET}" \
    --data "$payload" 2>/dev/null
)" || code="000"

case "$code" in
  2*) exit 0 ;;
  # Worth a line in the journal, worth nothing more. If the monitor stops
  # hearing from this job it will say so itself, which is the point.
  *) printf 'backup-heartbeat: monitor did not accept the report (HTTP %s)\n' "$code" >&2 ;;
esac
exit 0
