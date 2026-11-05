#!/usr/bin/env bash
# The offer gate (note #1008): a release reaches companies only after the
# standing test copy, a real Agentic Cloud in our scratch Fly organization,
# has been upgraded to it and passed both drills. Run by CI's copy-release job
# right after the release is built, and alone as the dispatchable job
# copy-release-gate (to re-run it). By hand, on any box with node:
#
#   VERSION=2026.11.10.0 COPY_TEST_FLY_TOKEN=… FLY_API_TOKEN=… \
#   COPY_TEST_STATE_DIR=/home/runner/ci-work/copy-test infra/copy-release/gate.sh
#
# In order, each with that release's own code:
#   1. --drill backend: the new Workspace is made not to start, and the old
#      release and its database come back without it;
#   2. --drill: the new release comes up, fails on purpose, and is put back;
#   3. the upgrade itself, and the copy's own health check after it.
# Only then is `offered-<version>` pushed (infra/copy-release/offer.mjs),
# and the update service names it latest. Any failure stops here: the release
# stays built but unoffered, and companies keep the one they were offered.
#
# COPY_TEST_FLY_TOKEN is the scratch organization's token. FLY_API_TOKEN is
# ours, which may push to the release registry. COPY_TEST_STATE_DIR holds the
# test copy's <name>-copy.json (names and addresses only).
set -euo pipefail

: "${VERSION:?VERSION unset}"
: "${COPY_TEST_FLY_TOKEN:?COPY_TEST_FLY_TOKEN unset: no standing test copy to try the release on}"
: "${FLY_API_TOKEN:?FLY_API_TOKEN unset: cannot mark the release offered}"
: "${COPY_TEST_STATE_DIR:?COPY_TEST_STATE_DIR unset: where the state file of the test copy lives}"
NAME="${COPY_TEST_NAME:-acc-testcopy}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALLER="${COPY_TEST_INSTALLER:-$REPO_ROOT/infra/copy-installer/install.mjs}"
OFFER="${COPY_TEST_OFFER:-$REPO_ROOT/infra/copy-release/offer.mjs}"
STATE="$COPY_TEST_STATE_DIR/$NAME-copy.json"
[ -f "$STATE" ] || { echo "no test copy state at $STATE — see the knowledge page private-copy, 'The standing test copy'" >&2; exit 1; }

# flyctl, the version the upgrader image pins, checked by its SHA-256: the
# command follows the upgrader's log with it, and --here runs with it.
FLYCTL_VERSION="$(sed -n 's/^ARG FLYCTL_VERSION=//p' "$REPO_ROOT/infra/copy-installer/upgrader/Dockerfile")"
FLYCTL_SHA256="$(sed -n 's/^ARG FLYCTL_SHA256=//p' "$REPO_ROOT/infra/copy-installer/upgrader/Dockerfile")"
FLY_DIR="${COPY_TEST_FLYCTL_DIR:-$COPY_TEST_STATE_DIR/flyctl-$FLYCTL_VERSION}"
if [ ! -x "$FLY_DIR/flyctl" ]; then
  mkdir -p "$FLY_DIR"
  curl -fsSL -o "$FLY_DIR/flyctl.tgz" "https://github.com/superfly/flyctl/releases/download/v${FLYCTL_VERSION}/flyctl_${FLYCTL_VERSION}_Linux_x86_64.tar.gz"
  echo "${FLYCTL_SHA256}  $FLY_DIR/flyctl.tgz" | sha256sum -c - >/dev/null
  tar -xzf "$FLY_DIR/flyctl.tgz" -C "$FLY_DIR" flyctl && rm -f "$FLY_DIR/flyctl.tgz"
fi
export FLYCTL="$FLY_DIR/flyctl" FLY_NO_UPDATE_CHECK=1

UPDATES=()
[ -n "${COPY_TEST_UPDATES_URL:-}" ] && UPDATES=(--updates "$COPY_TEST_UPDATES_URL")
STARTED=$(date +%s)
step() {
  local title=$1; shift
  local at; at=$(date +%s)
  echo
  echo "== $title ($(date -u +%H:%M:%S) UTC)"
  if (cd "$COPY_TEST_STATE_DIR" && FLY_API_TOKEN="$COPY_TEST_FLY_TOKEN" node "$INSTALLER" "$@"); then
    echo "== $title: passed in $(( $(date +%s) - at )) s"
  else
    local code=$?
    echo "== $title: FAILED (exit $code) after $(( $(date +%s) - at )) s"
    echo
    echo "GATE FAILED: release $VERSION is built but NOT offered. Companies keep the release they were offered."
    echo "Look at the lines above, and at the test copy itself (knowledge page private-copy). To re-run the gate"
    echo "once it is fixed: dispatch copy-release-gate. To let it through anyway: infra/copy-release/offer.mjs $VERSION --override --by <who> --reason \"<why>\"."
    cleanup_peers
    exit 1
  fi
}

# `fly ssh` from this box (an upgrade --here) leaves a WireGuard peer named
# after it in the scratch organization each run; take ours away.
cleanup_peers() {
  FLY_API_TOKEN="$COPY_TEST_FLY_TOKEN" node "$REPO_ROOT/infra/copy-release/peers.mjs" "$STATE" || true
}

echo "Offer gate for release $VERSION on the standing test copy $NAME"
step "drill backend: the new Workspace never starts, the old one comes back without it" upgrade --name "$NAME" --release "$VERSION" --drill backend --json "${UPDATES[@]}"
step "drill: the new release comes up, fails on purpose, and is put back" upgrade --name "$NAME" --release "$VERSION" --drill --json "${UPDATES[@]}"
step "upgrade to $VERSION" upgrade --name "$NAME" --release "$VERSION" --json "${UPDATES[@]}"
step "the test copy's own health" status --state "$STATE" --json
cleanup_peers

echo
RELEASE_REPO="${RELEASE_REPO:-acc-copy-releases}" node "$OFFER" "$VERSION" --gate passed --run "${GATE_RUN:-gate-$(date -u +%Y%m%dT%H%M%SZ)}"
echo "GATE PASSED for $VERSION in $(( $(date +%s) - STARTED )) s; the update service now offers it."
