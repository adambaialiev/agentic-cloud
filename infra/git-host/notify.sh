#!/usr/bin/env bash
#
# Sends one operational message to the ops Telegram bot.
#
#   echo "text" | notify.sh
#   notify.sh "text"
#
# Deliberately talks to Telegram DIRECTLY rather than through the platform
# backend. This is the channel that has to be able to say "the backend is
# down", and one that routes through the backend cannot.
#
# It NEVER fails its caller and never blocks it for long: a notification that
# cannot be delivered must not turn a successful backup into a failed one, nor
# a failed one into a hang. Every path here exits 0.
#
# Config lives in /etc/agentgit/ops-notify.env:
#   TELEGRAM_OPS_BOT_TOKEN=123456:ABC...
#   TELEGRAM_OPS_CHAT_ID=987654321
# Unset means silent — installing this before the bot exists is a no-op.
#
# set -e is deliberately absent: an early `exit 1` from a failed command is
# exactly the behaviour this script must not have.
set -uo pipefail

CONFIG="${OPS_NOTIFY_ENV:-/etc/agentgit/ops-notify.env}"
API_BASE="${TELEGRAM_API_BASE:-https://api.telegram.org}"
TIMEOUT="${OPS_NOTIFY_TIMEOUT:-10}"
# Written after every delivered message, so the OnFailure unit can tell
# "the job reported its own failure" from "the job died before it could".
MARKER="${OPS_NOTIFY_MARKER:-/var/lib/agentgit/last-notify}"

message="${1-}"
[[ -n "$message" ]] || message="$(cat)"
[[ -n "$message" ]] || exit 0

TOKEN=""
CHAT=""
if [[ -r "$CONFIG" ]]; then
  # Read as DATA, never `source`: this file holds a bot token, and sourcing it
  # would execute any unquoted value and pull the token into this shell where
  # the next error message could print it.
  TOKEN="$(sed -n 's/^TELEGRAM_OPS_BOT_TOKEN=//p' "$CONFIG" | head -1 | tr -d '"'"'"' \r')"
  CHAT="$(sed -n 's/^TELEGRAM_OPS_CHAT_ID=//p' "$CONFIG" | head -1 | tr -d '"'"'"' \r')"
fi
if [[ -z "$TOKEN" || -z "$CHAT" ]]; then
  # Not configured is a normal state, not an error.
  exit 0
fi

# The token is in the URL, which is why curl's stderr is discarded rather than
# shown: a connection error prints the URL it was fetching, and that would
# write the bot token into the journal for good. Only the status code is kept,
# which says everything the operator needs and nothing they must not see.
code="$(
  curl -sS -m "$TIMEOUT" -o /dev/null -w '%{http_code}' \
    --data-urlencode "chat_id=${CHAT}" \
    --data-urlencode "text=${message}" \
    --data-urlencode "disable_web_page_preview=true" \
    "${API_BASE}/bot${TOKEN}/sendMessage" 2>/dev/null
)" || code="000"

if [[ "$code" == "200" ]]; then
  mkdir -p "$(dirname "$MARKER")" 2>/dev/null || true
  date -u +%s > "$MARKER" 2>/dev/null || true
  exit 0
fi

# Plain text, no URL, no token. 401/403 means the token or chat id is wrong;
# 000 means Telegram was unreachable.
printf 'ops-notify: Telegram did not accept the message (HTTP %s)\n' "$code" >&2
exit 0
