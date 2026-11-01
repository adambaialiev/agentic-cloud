#!/usr/bin/env bash
# Lane A: runs INSIDE the ephemeral Fly machine, as its init command
# (docs/ci-two-lane-runner.md). The machine is created by lane-a.mjs with
# auto_destroy, so this script's exit is the machine's destruction — nothing
# here outlives the job.
#
# Env contract (set by lane-a.mjs at machine create):
#   CI_KIND         job kind (phase 1: only 'checks')
#   CI_SHA          commit to build
#   CI_REPO_URL     https clone URL, credential-free
#   CI_CLONE_TOKEN  token for that host, read access to this repo
#   CI_RESULT_URL   the dispatcher's /job-result endpoint
#   CI_JOB_ID       opaque id naming this job to the dispatcher
#   CI_JOB_TOKEN    per-job HMAC key for signing the result
#   CI_SECRET_NAMES comma-separated names of owner-granted secrets riding
#                   this job's env under their own names (protected-branch
#                   runs only); their values are masked out of the log tail
#   CI_PUBLISH_TOKEN, CI_PUBLISH_SITE, CI_PUBLISH_API_URL
#                   present only on a protected-branch run of a repository
#                   linked to a site (`agentbuilt repo publish`): a one-hour
#                   key for that site alone. ci.sh never sees the key; after it
#                   passes, .agentbuilt/deploy.sh runs with it as
#                   AGENTBUILT_TOKEN, and its outcome rides the same report.
#
# The result is ALWAYS posted, pass or fail — a machine that vanishes without
# reporting is indistinguishable from one that never ran, so the dispatcher's
# watchdog treats silence as an error after a grace period. This script's only
# unreported exit is the report itself failing, and it retries that once.
#
# Build kinds (build-backend, build-site) additionally deliver an ARTIFACT:
# the machine cannot be reached from outside (no sshd, no 6PN peering with
# the runner), so it PUSHES the tarball to the dispatcher's /job-artifact —
# authenticated with the same per-job HMAC as the result, over the artifact's
# own sha256, so a tampered or truncated upload is refused rather than
# deployed (docs/platform-on-own-git.md → the artifact path).
set -uo pipefail

LOG=/tmp/job.log
PHASES=/tmp/phases.tsv
PUBLISH_LOG=/tmp/publish.log
: > "$LOG"; : > "$PHASES"; : > "$PUBLISH_LOG"
# Out of the environment before anything from the repository runs, so ci.sh
# (which runs on every branch's behalf, even if only approved code reaches
# here) has no key it could publish with. Hygiene, not a wall: both scripts
# are the same approved commit on the same machine.
PUBLISH_TOKEN="${CI_PUBLISH_TOKEN:-}"
unset CI_PUBLISH_TOKEN
# Set by publish(): empty means no publish was attempted, and the report
# carries no publish object.
PUBLISH_EXIT=""
JOB_START=$(date +%s)
LAST_MARK=$JOB_START

mark() {
  local now; now=$(date +%s)
  printf '%s\t%s\n' "$1" "$((now - LAST_MARK))" >> "$PHASES"
  LAST_MARK=$now
}

say() { printf '=== %s ===\n' "$*" >> "$LOG"; }

# The report is the machine's last act. Log tail capped at 64 KB (the status
# doc's cap): a failing job's last lines are essentially always the part that
# matters, and the dispatcher stores nothing bigger.
# One log's tail, masked and base64'd. Granted secrets (CI_SECRET_NAMES, set
# by lane-a.mjs) and the publish key never leave in the report: their values
# are masked out of the tail first. Masking runs over a 128 KB window and
# THEN cuts to the 64 KB cap, so a value straddling the cut is still wholly
# inside the masked region — values cap at 8 KB, the margin is 64 KB.
masked_tail_b64() {
  local tail_text _names _name _value
  tail_text=$(tail -c 131072 "$1")
  if [ -n "${CI_SECRET_NAMES:-}" ]; then
    IFS=',' read -ra _names <<< "$CI_SECRET_NAMES"
    for _name in "${_names[@]}"; do
      _value="${!_name:-}"
      [ -n "$_value" ] && tail_text=${tail_text//"$_value"/[masked:$_name]}
    done
  fi
  [ -n "$PUBLISH_TOKEN" ] && tail_text=${tail_text//"$PUBLISH_TOKEN"/[masked:AGENTBUILT_TOKEN]}
  printf '%s' "$tail_text" | tail -c 65536 | base64 -w 0
}

report() {
  local exit_code="$1"
  local tail_b64 phases_json body sig publish_json=""
  tail_b64=$(masked_tail_b64 "$LOG")
  phases_json=$(awk -F'\t' 'BEGIN{printf "["} NR>1{printf ","} {printf "{\"name\":\"%s\",\"seconds\":%s}", $1, $2} END{printf "]"}' "$PHASES")
  if [ -n "$PUBLISH_EXIT" ]; then
    publish_json=$(printf ',"publish":{"exitCode":%s,"logTailB64":"%s"}' "$PUBLISH_EXIT" "$(masked_tail_b64 "$PUBLISH_LOG")")
  fi
  body=$(printf '{"jobId":"%s","exitCode":%s,"totalSeconds":%s,"phases":%s,"logTailB64":"%s"%s}' \
    "$CI_JOB_ID" "$exit_code" "$(($(date +%s) - JOB_START))" "$phases_json" "$tail_b64" "$publish_json")
  sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$CI_JOB_TOKEN" -r | cut -d' ' -f1)
  for attempt in 1 2; do
    curl -fsS -m 20 -X POST "$CI_RESULT_URL" \
      -H 'content-type: application/json' \
      -H "x-ia-job-signature: sha256=$sig" \
      -d "$body" >/dev/null 2>&1 && return 0
    sleep 5
  done
  return 1
}

# Deliver /tmp/artifact.tar.gz to the dispatcher. Derived URL, no new env —
# the same shape CLONE_TOKEN_URL uses on the dispatcher's own side.
upload_artifact() {
  local sha256 sig url
  url="${CI_RESULT_URL%/job-result}/job-artifact"
  sha256=$(sha256sum /tmp/artifact.tar.gz | cut -d' ' -f1)
  sig=$(printf '%s' "$CI_JOB_ID:$sha256" | openssl dgst -sha256 -hmac "$CI_JOB_TOKEN" -r | cut -d' ' -f1)
  say "uploading artifact ($(du -h /tmp/artifact.tar.gz | cut -f1))"
  for _attempt in 1 2 3; do
    curl -fsS -m 300 -X POST "$url" \
      -H 'content-type: application/octet-stream' \
      -H "x-ia-job-id: $CI_JOB_ID" \
      -H "x-ia-artifact-sha256: $sha256" \
      -H "x-ia-artifact-signature: sha256=$sig" \
      --data-binary @/tmp/artifact.tar.gz >> "$LOG" 2>&1 && return 0
    sleep 10
  done
  say "artifact upload failed after 3 attempts"
  return 1
}

# The machine takes no inbound connections — it dials out once — but it sits
# on the platform's private network beside every agent machine, hosted
# workplaces' included since note #664, and a test that listens on all
# interfaces would be reachable from any of them. So everything ARRIVING from
# that network is dropped. Loopback (the browser checks' own servers) and the
# replies to this machine's own outbound traffic (clone, npm, the report) are
# untouched. A missing or failing nft is logged, never fatal: the job matters
# more than the wall, and the watch in the idle reaper does not cover these
# short-lived machines, so the log line is the record.
wall_off_private_network() {
  if ! command -v nft >/dev/null 2>&1; then
    say "no nft on this image: private-network wall not applied"
    return 0
  fi
  if nft -f - >> "$LOG" 2>&1 <<'NFT'
table ip6 ci_wall {
  chain input {
    type filter hook input priority 0; policy accept;
    iif "lo" accept
    ct state established,related accept
    meta l4proto ipv6-icmp accept
    ip6 saddr fdaa::/16 drop
  }
}
NFT
  then
    say "private network walled off (inbound from fdaa::/16 dropped)"
  else
    say "private-network wall failed to apply; continuing without it"
  fi
}

# The repository's own publish step, in its own log so its outcome is its
# own check (deploy/<site>). The CLI is fetched from the backend that minted
# the key — the same file every agent machine installs — and is pointed at it
# by env alone, since this machine has no ~/.agentbuilt/config.json. 78 keeps
# its "skipped" meaning: a linked repository with no deploy.sh yet.
publish() {
  local site="${CI_PUBLISH_SITE:-}" api="${CI_PUBLISH_API_URL:-}"
  if [[ ! "$site" =~ ^[a-z0-9][a-z0-9-]{0,62}$ || ! "$api" =~ ^https?:// ]]; then
    printf '=== %s ===\n' "publish key arrived without a usable site or address — nothing published" >> "$PUBLISH_LOG"
    return 1
  fi
  if [[ ! -f .agentbuilt/deploy.sh ]]; then
    printf '=== %s ===\n' "no .agentbuilt/deploy.sh in this repo — nothing to publish" >> "$PUBLISH_LOG"
    return 78
  fi
  if ! curl -fsS -m 60 "${api%/}/api/agent-cli/install/agentbuilt" -o /usr/local/bin/agentbuilt >> "$PUBLISH_LOG" 2>&1; then
    printf '=== %s ===\n' "could not fetch the agentbuilt CLI from $api" >> "$PUBLISH_LOG"
    return 1
  fi
  chmod +x /usr/local/bin/agentbuilt
  printf '=== running .agentbuilt/deploy.sh for %s ===\n' "$site" >> "$PUBLISH_LOG"
  AGENTBUILT_API_URL="${api%/}" AGENTBUILT_TOKEN="$PUBLISH_TOKEN" AGENTBUILT_SITE="$site" \
    timeout 900 bash .agentbuilt/deploy.sh >> "$PUBLISH_LOG" 2>&1
}

run() {
  say "$CI_KIND @ $CI_SHA in $(hostname) ($(date -u +%FT%TZ))"
  wall_off_private_network

  # Credential as data, never in argv: netrc over a 077 umask. The host is
  # whatever CI_REPO_URL points at, so a repo moving from GitHub to the
  # platform git host changes nothing here.
  local host; host="${CI_REPO_URL#*://}"; host="${host%%/*}"
  ( umask 077; printf 'machine %s login x-access-token password %s\n' "$host" "$CI_CLONE_TOKEN" > ~/.netrc )

  # The actions/checkout shape: init + fetch the one sha, shallow. Nothing
  # else transfers, and it works for any reachable sha, branch tip or not.
  mkdir -p /tmp/work && cd /tmp/work || return 1
  git init -q . && git remote add origin "$CI_REPO_URL"
  if ! git fetch --quiet --depth 1 origin "$CI_SHA" >> "$LOG" 2>&1; then
    say "cannot fetch $CI_SHA from $CI_REPO_URL"; return 1
  fi
  git checkout --quiet --force "$CI_SHA"
  mark fetch

  case "$CI_KIND" in
    checks)
      # Mirrors run-job.sh `checks` (itself mirroring the frozen ci-cd.yml),
      # so a green pip here means what a green check always meant.
      say "npm ci (frontend)"
      npm ci --silent >> "$LOG" 2>&1 || return 1
      mark npm_ci_frontend
      say "npm ci (backend)"
      (cd backend && npm ci --silent) >> "$LOG" 2>&1 || return 1
      mark npm_ci_backend
      say "frontend tests"
      npm run test:frontend:coverage >> "$LOG" 2>&1 || return 1
      mark frontend_tests
      say "lint (advisory)"
      npm run lint >> "$LOG" 2>&1 || say "lint failed (advisory, matching ci-cd.yml continue-on-error)"
      mark lint
      say "frontend build"
      VITE_API_BASE_URL=http://localhost:3001 npm run build >> "$LOG" 2>&1 || return 1
      mark frontend_build
      say "backend tests"
      (cd backend && npm run test:core -- --reporter=dot) >> "$LOG" 2>&1 || return 1
      mark backend_tests
      ;;
    build-backend)
      # Mirrors run-job.sh deploy-prod's build half exactly: same
      # steps, same .release layout — the runner extracts this tarball where
      # its own local build used to leave the tree.
      say "npm ci (backend)"
      (cd backend && npm ci --silent) >> "$LOG" 2>&1 || return 1
      mark npm_ci_backend
      say "backend build"
      (cd backend && npm run build) >> "$LOG" 2>&1 || return 1
      mark backend_build
      (cd backend && npm prune --omit=dev --silent) >> "$LOG" 2>&1 || return 1
      mark npm_prune
      mkdir -p /tmp/release
      cp -R backend/dist backend/node_modules backend/assets backend/scripts \
        backend/package.json backend/package-lock.json /tmp/release/
      printf '%s\n' "$CI_SHA" > /tmp/release/RELEASE_SHA
      tar -czf /tmp/artifact.tar.gz -C /tmp/release .
      mark tar
      upload_artifact || return 1
      mark upload
      ;;
    build-site)
      # Mirrors run-job.sh deploy-site's build half. Checkout has retired, so
      # there is no billing token to pass into the published page bytes.
      say "npm ci (frontend)"
      npm ci --silent >> "$LOG" 2>&1 || return 1
      mark npm_ci_frontend
      say "site build"
      npm run build >> "$LOG" 2>&1 || return 1
      mark site_build
      tar -czf /tmp/artifact.tar.gz -C dist .
      mark tar
      upload_artifact || return 1
      mark upload
      ;;
    ci-script)
      # A platform repo's committed job definition (docs/ci-two-lane-runner.md
      # phase 2): deliberately a shell script, not a config dialect — the
      # audience is agents, and this machine is the security boundary. Exit 78
      # keeps its "skipped" meaning, both for an absent script (a repo that
      # never opted in must not collect red) and for a script's own filters.
      if [[ ! -f .agentbuilt/ci.sh ]]; then
        say "no .agentbuilt/ci.sh in this repo — nothing to run"
        return 78
      fi
      say "running .agentbuilt/ci.sh"
      bash .agentbuilt/ci.sh >> "$LOG" 2>&1
      local ci_exit=$?
      mark ci_script
      # Publishing on approval: only a run that PASSED, and only one carrying
      # a key (a protected-branch run of a linked repository).
      if [[ "$ci_exit" -eq 0 && -n "$PUBLISH_TOKEN" ]]; then
        publish
        PUBLISH_EXIT=$?
        mark publish
      fi
      return "$ci_exit"
      ;;
    *)
      say "unknown CI_KIND '$CI_KIND' — lane A runs untrusted job kinds only"
      return 1
      ;;
  esac
  return 0
}

run
CODE=$?
say "exit $CODE"
report "$CODE"
exit "$CODE"
