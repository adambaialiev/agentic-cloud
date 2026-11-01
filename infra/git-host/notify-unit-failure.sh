#!/usr/bin/env bash
#
# systemd `OnFailure=` handler. Reports a unit that failed WITHOUT reporting
# itself — killed by its own timeout, or exited early enough that it never
# reached its summary (a repos root that vanished, a target that no longer
# parses). Those are precisely the failures that would otherwise be silent,
# and silence is the thing the whole notification exists to prevent.
#
# Usage (from the unit): notify-unit-failure.sh %n
#
set -uo pipefail

UNIT="${1:-a unit}"
NOTIFY="${OPS_NOTIFY_SCRIPT:-/opt/agentgit/notify.sh}"
MARKER="${OPS_NOTIFY_MARKER:-/var/lib/agentgit/last-notify}"
QUIET_WINDOW="${OPS_NOTIFY_QUIET_WINDOW:-120}"

[[ -x "$NOTIFY" ]] || exit 0

# The job sends its own message with per-repo detail and THEN exits non-zero,
# which trips this handler too. If it managed that, it already said everything
# useful and a second vaguer alert is just noise.
now="$(date -u +%s)"
last="$(cat "$MARKER" 2>/dev/null || echo 0)"
[[ "$last" =~ ^[0-9]+$ ]] || last=0
if (( now - last < QUIET_WINDOW )); then
  exit 0
fi

"$NOTIFY" "🔴 ${UNIT} failed on $(hostname) and did not say why.

It died before it could report — timed out, or exited before its summary.

  journalctl -u ${UNIT} -n 50" || true
exit 0
