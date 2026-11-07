#!/usr/bin/env bash
# CI job runner — the daemon's muscle. Mirrors the (frozen) GitHub Actions
# workflows step for step so a green status here means what a green check
# meant before:
#   checks       ci-cd.yml       (frontend tests+lint+build, backend tests)
#   deploy-prod  backend-deploy.yml (artifact → ia-backend → GUARDED restart)
#
# There is no dev lane. The dev host (ia-backend-dev) was deleted on
# 2026-09-05 (note #343): we merge straight to main, so the `dev` branch and
# the box it deployed to had been unused since August.
#
# deploy-git-host mirrors no workflow — the git host never had one, which is
# the point of it (ia-media → restart → health → roll back on failure).
#
# Usage: run-job.sh <checks|deploy-prod|deploy-git-host|…> <sha>
# Expects: WORKDIR (with repo checkout at $WORKDIR/repo), GH_TOKEN, and the
# deploy SSH key at ~/.ssh/deploy_key (the hetzner-cloud key both hosts trust).
set -euo pipefail

KIND="$1"
SHA="$2"
WORKDIR="${WORKDIR:-/home/runner/ci-work}"
REPO_DIR="$WORKDIR/repo"
SSH_KEY="$HOME/.ssh/deploy_key"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new"

PROD_HOST="${IA_PROD_HOST:?IA_PROD_HOST is unset: add the backend host to /etc/ia-ci/env}"
DEPLOY_ROOT=/opt/infinite-agents
# The git host lives on ia-media, beside MinIO — a different box from the
# backend, reached with the same root key.
# Since note #1032 the central code host is the Fly app IA_GIT_HOST_APP and
# no box answers SSH for it; IA_GIT_HOST_HOST is needed only by the old path.
GIT_HOST_HOST="${IA_GIT_HOST_HOST:-}"
[ -n "$GIT_HOST_HOST" ] || [ -n "${IA_GIT_HOST_APP:-}" ] || { echo "neither IA_GIT_HOST_HOST nor IA_GIT_HOST_APP is set" >&2; exit 1; }
GIT_HOST_ROOT=/opt/agentgit

echo "=== $KIND @ $SHA on $(hostname) ($(date -u +%FT%TZ)) ==="

# ── Remote builds (docs/platform-on-own-git.md) ─────────────────────────────
# Ask the daemon (localhost, same box) to build $SHA on a throwaway lane A
# machine, so this keyed box never executes repo code. Echoes the artifact
# path on success. Exit 1 = build machinery unavailable (an old daemon, lane A
# unconfigured, Fly down) — the caller may fall back to a LOCAL build to keep
# deploys alive, loudly. Exit 2 = the BUILD ITSELF failed: the commit does not
# build, and retrying it locally would only reach the same verdict after
# executing the very code this split exists to keep off the box.
# --- CI on Fly (note #1032 stage 3) -----------------------------------------
# On Fly the dispatcher has no dockerd: DOCKER_HOST=ssh://ia-ci-builder points
# its docker CLI at the builder machine (app CI_BUILDER_APP), which is started
# for an image job and stopped when it ends. Every step of a job still runs
# here; only docker itself, and the smoke tests that must sit beside it, run
# on the builder. With a local dockerd (the Hetzner box) all of this is a no-op.
builder_remote() { [[ "${DOCKER_HOST:-}" == ssh://* ]]; }
fly_api() { curl -fsS -m 60 -H "Authorization: Bearer $FLY_API_TOKEN" -H 'content-type: application/json' "$@"; }
json_get() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let v=JSON.parse(d);for(const k of process.argv[1].split(".").filter(Boolean)){v=v==null?v:v[k]}process.stdout.write(v==null?"":String(v))})' "$1"; }
BUILDER_ID=""
builder_down() {
  [ -n "$BUILDER_ID" ] || return 0
  fly_api -X POST "https://api.machines.dev/v1/apps/${CI_BUILDER_APP:-ia-ci-builder}/machines/$BUILDER_ID/stop" >/dev/null 2>&1 \
    && echo "builder $BUILDER_ID stopped" || echo "builder $BUILDER_ID: stop failed (it costs money until stopped)" >&2
}
builder_up() {
  builder_remote || return 0
  local api="https://api.machines.dev/v1/apps/${CI_BUILDER_APP:-ia-ci-builder}/machines" state
  BUILDER_ID=$(fly_api "$api" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const m=JSON.parse(d);process.stdout.write(m.length===1?m[0].id:"")})')
  [ -n "$BUILDER_ID" ] || { echo "the builder app must have exactly one machine" >&2; return 1; }
  trap builder_down EXIT
  state=$(fly_api "$api/$BUILDER_ID" | json_get state)
  if [ "$state" != started ]; then
    fly_api -X POST "$api/$BUILDER_ID/start" >/dev/null || true
    fly_api "$api/$BUILDER_ID/wait?state=started&timeout=60" >/dev/null || true
  fi
  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then echo "builder $BUILDER_ID ready (was $state)"; return 0; fi
    sleep 2
  done
  echo "the builder did not answer docker within 2 minutes" >&2
  return 1
}
# smoke_test <dir> [VAR=value ...]: the image's smoke test, on the machine
# whose dockerd holds the image (it publishes ports on 127.0.0.1 there).
smoke_test() {
  local dir="$1"; shift
  if builder_remote; then
    tar -C "$dir" -cf - . | ssh ia-ci-builder \
      "rm -rf /root/smoke && mkdir -p /root/smoke && tar -xf - -C /root/smoke && cd /root/smoke && env $(printf '%q ' "$@") bash ./smoke-test.sh"
  else
    env "$@" "$dir/smoke-test.sh"
  fi
}
# roll_app_image <app> <image>: move every machine of a Fly app onto an image
# and wait until each is started and the app's /health answers. For our own
# central code host, which follows every green code-host image (note #1032).
roll_app_image() {
  local app="$1" image="$2" api="https://api.machines.dev/v1/apps/$1/machines" id cfg
  for id in $(fly_api "$api" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const m of JSON.parse(d))console.log(m.id)})'); do
    cfg=$(fly_api "$api/$id" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const m=JSON.parse(d);m.config.image=process.argv[1];process.stdout.write(JSON.stringify({config:m.config}))})' "$image")
    fly_api -X POST "$api/$id" -d "$cfg" >/dev/null
    fly_api "$api/$id/wait?state=started&timeout=120" >/dev/null || true
    echo "$app machine $id now on $image"
  done
  for _ in $(seq 1 30); do
    curl -fsS -m 10 "https://$app.fly.dev/health" >/dev/null 2>&1 && { echo "$app answers /health"; return 0; }
    sleep 4
  done
  echo "$app did not answer /health after the roll" >&2
  return 1
}

# machine_image_label <sha> <claude> <codex> <opencode>: the agent image's tag,
# naming BOTH things it is built from — the commit and the three pinned CLIs
# (note #1052). With the commit alone, a pin bump rebuilt at an unchanged
# commit pushed new bytes under an old tag, and the fleet's image roller, which
# compares tags, read every machine on the old bytes as current, forever (trap
# 2 on the updating-the-fleet-cli page). `+` is not legal in a tag; `_` stands
# in for it. Mirrors machineImageTag() in backend/src/services/machine-image-tag.ts
# (this box runs no repo code); machine-image-tag.test.ts holds the two together.
machine_image_label() {
  local label="sha-${1:0:12}-c$2-x$3-o$4"
  label="${label//+/_}"
  if [[ ! "${1:0:12}" =~ ^[0-9a-f]{12}$ || ! "$label" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]]; then
    echo "cannot make an image tag from commit '$1' and pins '$2' '$3' '$4'" >&2
    return 1
  fi
  printf '%s' "$label"
}
# ghcr_tag_state <owner/repo> <tag>: prints "present" or "absent"; returns 1 when
# the registry gives no clear answer. Anonymous: the package is public, and an
# anonymous pull token is all the fleet itself ever has.
ghcr_tag_state() {
  local token code
  token=$(curl -fsS -m 20 "https://ghcr.io/token?scope=repository:$1:pull" | json_get token) || return 1
  [ -n "$token" ] || return 1
  code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -I \
    -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/$1/manifests/$2") || return 1
  case "$code" in
    200) echo present ;;
    404) echo absent ;;
    *) return 1 ;;
  esac
}

request_remote_build() {
  local kind="$1" resp id state
  resp=$(curl -fsS -m 20 -X POST http://127.0.0.1:8787/build \
    -H 'content-type: application/json' \
    -d "{\"kind\":\"$kind\",\"sha\":\"$SHA\"}" 2>/dev/null) || return 1
  id=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).buildId||""))}catch{}})')
  [ -n "$id" ] || return 1
  echo "remote build $id started" >&2
  for _ in $(seq 1 120); do
    sleep 10
    resp=$(curl -fsS -m 20 "http://127.0.0.1:8787/build/$id" 2>/dev/null) || continue
    state=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).state||""))}catch{}})')
    case "$state" in
      running) continue ;;
      success)
        printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).artifact||""))}catch{}})'
        return 0 ;;
      failure)
        echo "remote build FAILED — the commit does not build. Machine log tail:" >&2
        printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(Buffer.from(JSON.parse(d).logTailB64||"","base64").toString())}catch{}})' >&2
        return 2 ;;
      *)
        echo "remote build errored: $(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).description||""))}catch{}})')" >&2
        return 1 ;;
    esac
  done
  echo "remote build $id: gave up waiting after 20m" >&2
  return 1
}

# Install the production service + socket as one validated pair. On the first
# adoption the old Node process already owns :3001, so it must stop once before
# systemd can take the listener. Every later deploy leaves the socket running
# and restarts only the service: connections made during startup wait in the
# socket backlog instead of becoming Caddy 502 responses.
# Put production back on the release that was serving before this deploy
# moved `current`, then say plainly where it ended up. Called only after the
# new release failed to activate or to answer /api/health; the job still exits
# non-zero afterwards, because the deploy DID fail — the point is that the
# failure no longer stays live until a person reads the red pip.
#
# `ia-rollback <sha>` is the on-box command this same job installed a moment
# ago; it flips the symlink, restarts, and polls localhost itself. It is given
# the sha explicitly — bare `ia-rollback` picks "newest release that is not
# current", which after this deploy would be the broken one.
roll_back_prod() {
  local prev="$1" prev_sha
  if [ -z "$prev" ] || [ "$prev" = "$RELEASE" ] || [ "$prev" = "$DEPLOY_ROOT/current" ]; then
    echo "no previous release to roll production back to — $SHA stays current; ssh root@$PROD_HOST ia-rollback --list" >&2
    return 0
  fi
  prev_sha=$(basename "$prev")
  echo "rolling production back from $SHA to $prev_sha" >&2
  if ssh $SSH_OPTS "root@$PROD_HOST" "ia-rollback '$prev_sha'"; then
    # The broken release is removed so a later bare `ia-rollback` cannot land
    # on it; a re-run of this job ships it again from the artifact.
    ssh $SSH_OPTS "root@$PROD_HOST" "rm -rf '$RELEASE'" || true
    echo "production is back on $prev_sha and healthy; $SHA is not live and its release dir was removed" >&2
  else
    echo "rollback to $prev_sha did not come back healthy either — production needs a human now: ssh root@$PROD_HOST ia-rollback --list" >&2
  fi
}

install_prod_backend_units() {
  local stage="/run/infinite-agents-backend-units-$SHA"
  local src="$REPO_DIR/infra/backend-host"

  ssh $SSH_OPTS "root@$PROD_HOST" "install -d -o root -g root -m 0700 '$stage'"
  rsync -az -e "ssh $SSH_OPTS" \
    "$src/infinite-agents-backend.service" \
    "$src/infinite-agents-backend.socket" \
    "$src/set-machine-image" \
    "root@$PROD_HOST:$stage/"

  ssh $SSH_OPTS "root@$PROD_HOST" "bash -s -- '$stage'" <<'REMOTE'
set -euo pipefail
stage="$1"
service=infinite-agents-backend.service
socket=infinite-agents-backend.socket
trap 'rm -rf "$stage"' EXIT

# Parse the exact staged files together before replacing either live unit.
systemd-analyze verify "$stage/$service" "$stage/$socket"
bash -n "$stage/set-machine-image"

service_enabled=0
service_active=0
socket_active=0
systemctl is-enabled --quiet "$service" && service_enabled=1 || true
systemctl is-active --quiet "$service" && service_active=1 || true
systemctl is-active --quiet "$socket" && socket_active=1 || true

install -o root -g root -m 0644 "$stage/$service" "/etc/systemd/system/$service"
install -o root -g root -m 0644 "$stage/$socket" "/etc/systemd/system/$socket"
install -o root -g root -m 0755 "$stage/set-machine-image" /usr/local/bin/set-machine-image
systemctl daemon-reload

if [ "$service_enabled" = 1 ]; then
  # Keep the existing boot policy, adding the socket to it. If this is the
  # first migration, release Node's old listener before systemd binds it.
  systemctl enable "$service" "$socket" >/dev/null
  if [ "$socket_active" = 1 ]; then
    systemctl restart "$service"
    echo 'backend service restarted; socket stayed active'
  else
    systemctl stop "$service"
    systemctl start "$socket"
    systemctl start "$service"
    echo 'backend migrated to socket activation'
  fi
elif [ "$service_active" = 1 ]; then
  # Preserve the unusual manually-started-but-disabled state without silently
  # making it persistent across boot.
  systemctl stop "$service"
  systemctl start "$socket"
  systemctl start "$service"
  echo 'backend migrated to socket activation; service remains disabled'
else
  # Provisioned hosts are deliberately dormant. Shipping a release and units
  # must not turn one on.
  systemctl disable "$service" "$socket" >/dev/null 2>&1 || true
  systemctl stop "$service" >/dev/null 2>&1 || true
  systemctl stop "$socket" >/dev/null 2>&1 || true
  echo 'service dormant — release and socket unit staged, not started'
fi
REMOTE
}

# ── "Did anything this job ships change?" — asked of a RANGE ────────────────
# Every deploy job below self-skips (exit 78) when nothing it ships changed.
# Until 2026-09-08 each asked that of ONE commit — `git diff $SHA~1 $SHA` —
# and a fast-forward merge lands the branch's LAST commit as the pushed tip.
# A branch ending in a site, docs or test commit therefore answered "no"
# while the commits under it changed the backend, and nothing ever looked at
# those: the deploy skipped, the daemon mapped the skip to success, and
# production served the previous release with every check green (the
# Workspace type scale, 2026-09-07, for hours). Coalescing hid it on a busy
# afternoon — a deploy that supersedes a queued one runs with IA_FORCE_JOB=1 —
# which is why it looked random; a merge in a quiet moment ran alone and lost.
#
# The right question is "what changed since this job LAST TRIED", so the
# filter diffs from that sha to $SHA. Tried, not shipped: a release that fails
# its health gate is rolled back, and if the near end were what is SERVING,
# every docs-only merge behind it would try the same broken tree again — a
# minute of degraded production per merge until a fix lands. The old filter
# left a rollback alone; this one does too. Where the near end comes from:
#   deploy-prod     the prod host itself: $DEPLOY_ROOT/last-attempt, written
#                   just before `current` moves; before that file exists, the
#                   `current` symlink into releases/<sha>. Read, not kept.
#   everything else $WORKDIR/attempted/<kind>, written by this runner when the
#                   job starts its work, or finds an empty range (it advances).
# Every way of NOT knowing — host unreachable, symlink missing, no record, a
# sha this clone no longer has, a diff that fails — answers "run". A needless
# run costs minutes and the deploys are health-gated with a rollback behind
# them; a wrong skip is invisible and sits in production until somebody
# fetches what it serves. The one skip that is not about paths: a sha that is
# already CONTAINED in the near end (a redelivered webhook, a hand re-run of
# an old push) is never shipped, because that would move production backwards
# on the strength of a diff that reads the newer code as "changes".
# Two-argument diff, deliberately: after a rollback the near end is not an
# ancestor of the merge, and a merge-base (three-dot) diff would hide the
# very revert that has to ship.
ATTEMPTED_DIR="$WORKDIR/attempted"
# The filter runs before every job on the prod lane; a host that is down must
# answer "unknown" in seconds, not after TCP gives up.
FILTER_SSH_OPTS="$SSH_OPTS -o ConnectTimeout=15 -o BatchMode=yes"

# Prints the sha $KIND last tried from this runner, or nothing.
last_attempted() { cat "$ATTEMPTED_DIR/$KIND" 2>/dev/null || true; }

# Remembers $SHA as what $KIND last tried (or last found nothing to do for).
record_attempt() {
  mkdir -p "$ATTEMPTED_DIR"
  printf '%s\n' "$SHA" > "$ATTEMPTED_DIR/$KIND.tmp" && mv -f "$ATTEMPTED_DIR/$KIND.tmp" "$ATTEMPTED_DIR/$KIND"
}

# Keeps only a full sha: anything else (a path that is not a release, an error
# line, nothing) is an unknown.
as_sha() {
  local v="$1"
  v=${v%/}
  v=${v##*/}
  case "$v" in
    *[!0-9a-f]*) ;;
    ????????????????????????????????????????) printf '%s' "$v" ;;
  esac
}

# The sha production last TRIED — $DEPLOY_ROOT/last-attempt on the prod host,
# else the basename of the `current` symlink's target — or nothing when that
# cannot be read.
prod_last_attempt() {
  local answer
  answer=$(ssh $FILTER_SSH_OPTS "root@$PROD_HOST" \
    "cat '$DEPLOY_ROOT/last-attempt' 2>/dev/null || readlink -f '$DEPLOY_ROOT/current' 2>/dev/null" 2>/dev/null) || return 0
  as_sha "$(printf '%s' "$answer" | head -n1)"
  return 0
}

# changed_since <from-sha> <path regex>: true when the job has work to do.
# True on force, on an unknown <from>, and when the range touches the paths;
# false when $SHA is already contained in <from>, or a real, resolvable range
# touches none of them.
changed_since() {
  local from="$1" pattern="$2" files hits
  if [ "${IA_FORCE_JOB:-}" = "1" ]; then
    echo "forced (dispatched or coalesced) — the path filter is skipped"
    return 0
  fi
  if [ -z "$from" ]; then
    echo "no record of what $KIND last tried — running rather than guessing"
    return 0
  fi
  if [ "$from" = "$SHA" ]; then
    echo "$SHA is what $KIND last tried — nothing to do"
    return 1
  fi
  if ! git cat-file -e "$from^{commit}" 2>/dev/null; then
    git fetch --quiet origin "$from" 2>/dev/null || true
  fi
  if ! git cat-file -e "$from^{commit}" 2>/dev/null; then
    echo "last tried sha $from is not in this clone — running rather than guessing"
    return 0
  fi
  if git merge-base --is-ancestor "$SHA" "$from" 2>/dev/null; then
    echo "$SHA is already contained in $from — not shipping backwards"
    return 1
  fi
  if ! files=$(git diff --name-only "$from" "$SHA" 2>&1); then
    echo "could not diff $from..$SHA ($files) — running rather than guessing"
    return 0
  fi
  hits=$(printf '%s\n' "$files" | grep -E "$pattern" || true)
  if [ -n "$hits" ]; then
    echo "changed since $from:"
    printf '%s\n' "$hits" | head -20 | sed 's/^/  /'
    return 0
  fi
  echo "nothing matching since $from"
  return 1
}
# ── end of the range filter ─────────────────────────────────────────────────

# ── Fresh checkout of the exact SHA ─────────────────────────────────────────
# Except for the mirror: its sha lives on OUR host and reaches GitHub only
# when the job itself runs — fetching it from GitHub first would deadlock the
# very push that delivers it. The job needs no checkout; it works on refs.
if [ "$KIND" != "mirror-github" ]; then
  cd "$REPO_DIR"
  git fetch --quiet origin "$SHA"
  git checkout --quiet --force "$SHA"
  git clean -qfdx -e node_modules -e backend/node_modules
fi

# The offer gate for the release in infra/copy-release/VERSION (note #1008):
# infra/copy-release/gate.sh, with the standing test copy's token and state.
run_copy_release_gate() {
  if [ -z "${COPY_TEST_FLY_TOKEN:-}" ]; then
    echo "COPY_TEST_FLY_TOKEN is not set in /etc/ia-ci/env: there is no standing test copy to try this release on," >&2
    echo "so it is built but NOT offered. See the knowledge page private-copy, 'The standing test copy'." >&2
    exit 1
  fi
  : "${FLY_API_TOKEN:?FLY_API_TOKEN unset in /etc/ia-ci/env — cannot mark the release offered}"
  VERSION="$(tr -d '[:space:]' < infra/copy-release/VERSION)" \
    COPY_TEST_FLY_TOKEN="$COPY_TEST_FLY_TOKEN" FLY_API_TOKEN="$FLY_API_TOKEN" \
    COPY_TEST_STATE_DIR="${COPY_TEST_STATE_DIR:-$WORKDIR/copy-test}" \
    COPY_TEST_ADMIN_EMAIL="${COPY_TEST_ADMIN_EMAIL:-}" COPY_TEST_ADMIN_PASSWORD="${COPY_TEST_ADMIN_PASSWORD:-}" \
    COPY_TEST_VOICE_OPENROUTER_KEY="${COPY_TEST_VOICE_OPENROUTER_KEY:-}" \
    RELEASE_REPO="${COPY_RELEASE_REPO:-acc-copy-releases}" GATE_RUN="${SHA:0:12}" \
    ./infra/copy-release/gate.sh
}

case "$KIND" in
  checks)
    # Frontend: deps, tests+coverage, lint (advisory, as in ci-cd.yml), build.
    npm ci --silent
    (cd backend && npm ci --silent)
    npm run test:frontend:coverage
    npm run lint || echo "lint failed (advisory, matching ci-cd.yml continue-on-error)"
    VITE_API_BASE_URL=http://localhost:3001 npm run build
    # Backend: tests (the coverage pass repeats the same tests; skip to halve
    # wall time — coverage numbers were never consumed anywhere).
    (cd backend && npm run test:core -- --reporter=dot)
    ;;

  deploy-prod)
    HOST="$PROD_HOST"
    # Filtered against what the host last TRIED, never against one commit
    # (changed_since, above). A coalesced or dispatched run is forced; that is
    # belt-and-braces now, not what stands between a merge and its users.
    LAST_TRIED=$(prod_last_attempt)
    # set-machine-image rides the same install as the units (install_prod_backend_units),
    # so a change to the helper alone must deploy too — or it never reaches the host.
    if ! changed_since "$LAST_TRIED" '^(backend/|infra/ci-runner/|infra/backend-host/(infinite-agents-backend\.(service|socket)|set-machine-image)$)'; then
      echo "no backend changes between last tried $LAST_TRIED and $SHA — prod deploy skipped"
      exit 78   # daemon maps 78 to "skipped", not success
    fi

    # The release artifact is built on a throwaway lane A machine — this box
    # holds the keys and must not execute repo code. Local build only as the
    # transitional fallback (old daemon without /build, lane A down), loudly.
    rm -rf .release
    mkdir -p .release
    BUILD_RC=0
    ARTIFACT=$(request_remote_build build-backend) || BUILD_RC=$?
    if [ "$BUILD_RC" = 2 ]; then
      echo "backend build failed on the build machine — failing the deploy" >&2
      exit 1
    elif [ "$BUILD_RC" = 0 ] && [ -n "$ARTIFACT" ] && [ -f "$ARTIFACT" ]; then
      tar -xzf "$ARTIFACT" -C .release
      rm -f "$ARTIFACT"
      # The artifact must be the sha this job was asked to deploy — a stale or
      # crossed-wires tarball must die here, not on the host.
      if [ "$(cat .release/RELEASE_SHA)" != "$SHA" ]; then
        echo "artifact RELEASE_SHA $(cat .release/RELEASE_SHA) != job sha $SHA — refusing to deploy it" >&2
        exit 1
      fi
      echo "release built on a lane A machine"
    elif [ "${IA_LOCAL_BUILD:-}" = "1" ]; then
      # Operator break-glass for a Fly outage: a human at a terminal decided
      # to execute repo code on the keyed box, and said so out loud.
      echo "IA_LOCAL_BUILD=1 — building LOCALLY on the keyed box (operator break-glass)" >&2
      cd backend
      npm ci --silent
      npm run build
      npm prune --omit=dev --silent
      cp -R dist node_modules assets scripts package.json package-lock.json ../.release/
      echo "$SHA" > ../.release/RELEASE_SHA
      cd ..
    else
      echo "remote build unavailable and this box does not execute repo code (docs/platform-on-own-git.md)." >&2
      echo "Break glass during a Fly outage: IA_LOCAL_BUILD=1 run-job.sh $KIND $SHA" >&2
      exit 1
    fi

    # The rollback command rides every deploy, so the box can always put
    # itself back on a previous release without git, the backend, or this
    # runner (layer 1 in docs/platform-on-own-git.md). Validated here first:
    # a rollback script that will not parse is discovered on the worst day.
    bash -n "$REPO_DIR/infra/ci-runner/ia-rollback.sh"
    rsync -az -e "ssh $SSH_OPTS" "$REPO_DIR/infra/ci-runner/ia-rollback.sh" \
      "root@$HOST:/usr/local/bin/ia-rollback"
    # rsync preserves the runner's uid; the command must be root's.
    ssh $SSH_OPTS "root@$HOST" "chown root:root /usr/local/bin/ia-rollback && chmod 755 /usr/local/bin/ia-rollback"

    RELEASE="$DEPLOY_ROOT/releases/$SHA"
    # What the host is running NOW, taken before `current` moves: it is where
    # production goes back to if this release does not come up.
    PREV_RELEASE=$(ssh $SSH_OPTS "root@$HOST" "readlink -f '$DEPLOY_ROOT/current' 2>/dev/null || true")
    # Root + chown app: the runner holds the hetzner-cloud root key; the app
    # deploy keypair lives only in the (frozen) GitHub secrets.
    ssh $SSH_OPTS "root@$HOST" "mkdir -p '$RELEASE'"
    rsync -az --delete -e "ssh $SSH_OPTS" .release/ "root@$HOST:$RELEASE/"
    # last-attempt is written BEFORE the symlink moves: it is the near end of
    # the next deploy's filter, so a release that fails its health gate and is
    # rolled back is not tried again by every unrelated merge behind it.
    ssh $SSH_OPTS "root@$HOST" "printf '%s\n' '$SHA' > '$DEPLOY_ROOT/last-attempt' && chown -R app:app '$RELEASE' && ln -sfn '$RELEASE' '$DEPLOY_ROOT/current'"

    # Prod activation is GUARDED: a dormant service stays down. A live host
    # gets its socket unit before Node starts, and subsequent deploys restart
    # only Node while the listener remains open.
    #
    # And it is GUARANTEED A WAY BACK: main is shipped straight to this host
    # thirty times a day with nobody watching, so a release that does not
    # answer within a minute is put back to the one that was serving before
    # the symlink moved — by this job, not by whoever notices first.
    prod_activated=1
    install_prod_backend_units || prod_activated=0
    prod_healthy=1
    if [ "$prod_activated" = 0 ]; then
      echo "prod backend activation failed for $SHA" >&2
      prod_healthy=0
    elif ssh $SSH_OPTS "root@$HOST" "systemctl is-enabled --quiet infinite-agents-backend"; then
      # Enabled means it is supposed to be serving. `is-active` was the old
      # gate, and a release crashing on boot fails it too (auto-restart is
      # not active) — which used to read as "dormant, nothing to check".
      prod_healthy=0
      for i in $(seq 1 12); do
        code=$(curl -fsS --max-time 3 -o /dev/null -w '%{http_code}' \
          https://api.agenticcloudcomputer.com/api/health || true)
        if [ "$code" = "200" ]; then echo "prod healthy after $i attempt(s)"; prod_healthy=1; break; fi
        sleep 2
      done
      [ "$prod_healthy" = 1 ] || echo "prod backend did not return 200 after ~60s on $SHA" >&2
    fi
    if [ "$prod_healthy" = 0 ]; then
      roll_back_prod "$PREV_RELEASE"
      exit 1
    fi

    # Prune old releases, keep the 5 most recent (matching both workflows).
    ssh $SSH_OPTS "root@$HOST" "ls -1dt $DEPLOY_ROOT/releases/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf"
    ;;

  deploy-git-host)
    # Since note #1032 the central code host is a Fly app running the code-host
    # image, and the git-host-image job rolls it onto every green build. There
    # is no box left to ship these files to.
    if [ -n "${IA_GIT_HOST_APP:-}" ]; then
      echo "the central code host is the Fly app $IA_GIT_HOST_APP: it follows the git-host-image job — skipped"
      exit 78
    fi
    # The git host had no pipeline at all: every change to it meant an SSH
    # session and a file copied by hand. On 2026-08-11 that finally cost
    # something — scp landed git-host.mjs root-owned 0600, the unit runs as
    # `agentgit`, and it crash-looped on EACCES reading its own entrypoint for
    # ~30 seconds, with every user's clones, pushes and merges failing behind
    # it. Each step below is one of the ways that afternoon went wrong.
    if ! changed_since "$(last_attempted)" '^infra/git-host/'; then
      echo "no git-host changes since the last attempt — skipped"
      record_attempt
      exit 78   # daemon maps 78 to "skipped", not success
    fi
    record_attempt   # tried, whatever happens next: a failure is red, not retried by unrelated merges
    SRC="$REPO_DIR/infra/git-host"

    # Validate HERE, before a byte reaches the box. A git-host.mjs that will
    # not parse takes every user's repo offline, and that box has no CI of its
    # own to fix it with.
    node --check "$SRC/git-host.mjs"
    node --check "$SRC/hooks/post-receive"
    sh -n "$SRC/hooks/pre-receive"
    # bash, not sh: the backup script uses arrays and [[ ]], which `sh -n`
    # on this runner would reject as syntax errors it will never hit in life.
    bash -n "$SRC/backup-repos.sh"
    bash -n "$SRC/maintain-repos.sh"
    bash -n "$SRC/notify.sh"
    bash -n "$SRC/notify-unit-failure.sh"
    bash -n "$SRC/backup-heartbeat.sh"
    node --check "$SRC/backup.mjs"

    # The hooks ship with it, always. git-host reads them at startup and
    # re-copies them into every bare repo on each push, so sending the server
    # without them leaves a hook fix inert in exactly the repos that needed it.
    rsync -az -e "ssh $SSH_OPTS" \
      "$SRC/git-host.mjs" "root@$GIT_HOST_HOST:$GIT_HOST_ROOT/git-host.staged.mjs"
    # backup.mjs is the org-host bundle job (byo-git slice 4); the server
    # imports it lazily on its backup route, so it travels with the server.
    rsync -az -e "ssh $SSH_OPTS" \
      "$SRC/backup.mjs" "root@$GIT_HOST_HOST:$GIT_HOST_ROOT/backup.staged.mjs"
    rsync -az --delete -e "ssh $SSH_OPTS" \
      "$SRC/hooks/" "root@$GIT_HOST_HOST:$GIT_HOST_ROOT/hooks.staged/"
    # The unit too, so an edit to it is not a silent no-op — reloaded below
    # only when it actually moved.
    rsync -az -e "ssh $SSH_OPTS" \
      "$SRC/agentgit.service" "root@$GIT_HOST_HOST:/etc/systemd/system/agentgit.service.staged"
    # The backup job rides along: script staged next to the server, its two
    # units staged beside the service's. It is not part of the health check
    # below — a backup that breaks must never roll back the git host — so it
    # is validated above instead, before a byte of it leaves this runner.
    rsync -az -e "ssh $SSH_OPTS" \
      "$SRC/backup-repos.sh" "root@$GIT_HOST_HOST:$GIT_HOST_ROOT/backup-repos.staged.sh"
    rsync -az -e "ssh $SSH_OPTS" \
      "$SRC/maintain-repos.sh" "root@$GIT_HOST_HOST:$GIT_HOST_ROOT/maintain-repos.staged.sh"
    rsync -az -e "ssh $SSH_OPTS" \
      "$SRC/notify.sh" "$SRC/notify-unit-failure.sh" "$SRC/backup-heartbeat.sh" \
      "root@$GIT_HOST_HOST:$GIT_HOST_ROOT/"
    rsync -az -e "ssh $SSH_OPTS" \
      "$SRC/agentgit-backup.service" "$SRC/agentgit-backup.timer" \
      "$SRC/agentgit-backup-hot.service" "$SRC/agentgit-backup-hot.timer" \
      "$SRC/agentgit-backup-failed@.service" \
      "$SRC/agentgit-maintenance.service" "$SRC/agentgit-maintenance.timer" \
      "root@$GIT_HOST_HOST:/etc/systemd/system/"

    ssh $SSH_OPTS "root@$GIT_HOST_HOST" bash <<'REMOTE'
set -euo pipefail
ROOT=/opt/agentgit

# The staged copy ends in .mjs deliberately: `node --check foo.mjs.new` dies
# with ERR_UNKNOWN_FILE_EXTENSION, because node reads the module type off the
# extension. A syntax check that "passes" by never running is worse than none —
# that is precisely how the bad file got through by hand.
node --check "$ROOT/git-host.staged.mjs"
node --check "$ROOT/backup.staged.mjs"

# Ownership and mode, explicitly, every single time. The unit runs as
# `agentgit`; a file that arrives root-owned 0600 is the exact EACCES
# crash-loop this job exists to make impossible.
chown agentgit:agentgit "$ROOT/git-host.staged.mjs"
chmod 755 "$ROOT/git-host.staged.mjs"
chown agentgit:agentgit "$ROOT/backup.staged.mjs"
chmod 755 "$ROOT/backup.staged.mjs"
mv -f "$ROOT/backup.staged.mjs" "$ROOT/backup.mjs"
chown -R agentgit:agentgit "$ROOT/hooks.staged"
chmod 755 "$ROOT/hooks.staged" "$ROOT/hooks.staged"/*

# Same ownership lesson as above, for the same reason: this runs as agentgit
# too, and a root-owned 0600 copy would fail nightly at 03:30 where nobody is
# watching.
bash -n "$ROOT/backup-repos.staged.sh"
chown agentgit:agentgit "$ROOT/backup-repos.staged.sh"
chmod 755 "$ROOT/backup-repos.staged.sh"
mv -f "$ROOT/backup-repos.staged.sh" "$ROOT/backup-repos.sh"
bash -n "$ROOT/maintain-repos.staged.sh"
chown agentgit:agentgit "$ROOT/maintain-repos.staged.sh"
chmod 755 "$ROOT/maintain-repos.staged.sh"
mv -f "$ROOT/maintain-repos.staged.sh" "$ROOT/maintain-repos.sh"

# rsync -a preserves the RUNNER's uid/gid, so these landed owned by 1000 while
# every other unit here is root:root. No user holds uid 1000 on this box today,
# which is the only reason it is not a way to edit a systemd unit — not a
# property worth depending on.
chown root:root /etc/systemd/system/agentgit-backup.service \
                /etc/systemd/system/agentgit-backup.timer \
                /etc/systemd/system/agentgit-backup-hot.service \
                /etc/systemd/system/agentgit-backup-hot.timer \
                '/etc/systemd/system/agentgit-backup-failed@.service' \
                /etc/systemd/system/agentgit-maintenance.service \
                /etc/systemd/system/agentgit-maintenance.timer
chmod 644 /etc/systemd/system/agentgit-backup.service \
          /etc/systemd/system/agentgit-backup.timer \
          /etc/systemd/system/agentgit-backup-hot.service \
          /etc/systemd/system/agentgit-backup-hot.timer \
          '/etc/systemd/system/agentgit-backup-failed@.service' \
          /etc/systemd/system/agentgit-maintenance.service \
          /etc/systemd/system/agentgit-maintenance.timer

# The notifier runs as agentgit, same ownership lesson as everything else here.
chown agentgit:agentgit "$ROOT/notify.sh" "$ROOT/notify-unit-failure.sh" "$ROOT/backup-heartbeat.sh"
chmod 755 "$ROOT/notify.sh" "$ROOT/notify-unit-failure.sh" "$ROOT/backup-heartbeat.sh"

# Keep what is running, so the health check below has something to put back.
cp -a "$ROOT/git-host.mjs" "$ROOT/git-host.mjs.previous"
rm -rf "$ROOT/hooks.previous"
cp -a "$ROOT/hooks" "$ROOT/hooks.previous"

mv -f "$ROOT/git-host.staged.mjs" "$ROOT/git-host.mjs"
rm -rf "$ROOT/hooks"
mv -f "$ROOT/hooks.staged" "$ROOT/hooks"

RELOADED=""
if cmp -s /etc/systemd/system/agentgit.service.staged /etc/systemd/system/agentgit.service; then
  rm -f /etc/systemd/system/agentgit.service.staged
else
  mv -f /etc/systemd/system/agentgit.service.staged /etc/systemd/system/agentgit.service
  systemctl daemon-reload
  RELOADED=" (unit changed, daemon-reload)"
fi

systemctl restart agentgit
echo "restarted agentgit$RELOADED"

# The timer's own units changed under it often enough to matter; re-reading
# them is cheap and enabling is idempotent. Deliberately after the restart:
# nothing here may delay the git host coming back.
systemctl daemon-reload
systemctl enable --now agentgit-backup.timer >/dev/null 2>&1 \
  && echo "backup timer: $(systemctl show -p NextElapseUSecRealtime --value agentgit-backup.timer)" \
  || echo "backup timer could not be enabled (backups are not running)" >&2
systemctl enable --now agentgit-backup-hot.timer >/dev/null 2>&1 \
  && echo "hot backup timer: $(systemctl show -p NextElapseUSecRealtime --value agentgit-backup-hot.timer)" \
  || echo "hot backup timer could not be enabled (intra-day backups are not running)" >&2
systemctl enable --now agentgit-maintenance.timer >/dev/null 2>&1 \
  && echo "maintenance timer: $(systemctl show -p NextElapseUSecRealtime --value agentgit-maintenance.timer)" \
  || echo "maintenance timer could not be enabled (weekly gc is not running)" >&2

# Read PORT as DATA, never by sourcing: that file holds GIT_HOST_SECRET, and
# sourcing it would pull the secret into this shell and any error it prints.
# Digits only, so nothing else can ride out of that file in this variable.
PORT=$(sed -n 's/^PORT=[^0-9]*\([0-9][0-9]*\).*/\1/p' /etc/agentgit/agentgit.env 2>/dev/null | head -1)
PORT=${PORT:-3002}

# Healthy means SERVING, not "systemd says active". The crash-loop that
# prompted all this reported `activating` while answering nothing at all. A 404
# on / is this host's correct answer — it serves three git endpoints and
# nothing else — so it proves the listener is really up.
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/" || true)
  if [ "$code" = "404" ] && systemctl is-active --quiet agentgit; then
    echo "git host healthy after $i attempt(s) on :$PORT"
    exit 0
  fi
  sleep 2
done

# The whole point of the job: a bad deploy ends as a failed status, not as an
# outage somebody has to notice first.
echo "git host did not serve after ~40s — rolling back" >&2
mv -f "$ROOT/git-host.mjs.previous" "$ROOT/git-host.mjs"
rm -rf "$ROOT/hooks"
mv -f "$ROOT/hooks.previous" "$ROOT/hooks"
systemctl restart agentgit
sleep 3
if systemctl is-active --quiet agentgit; then
  echo "rolled back to the previous git host, which is serving again" >&2
else
  echo "ROLLBACK ALSO FAILED — the git host is down and needs hands" >&2
fi
exit 1
REMOTE
    ;;

  deploy-site)
    # Mirrors the frozen deploy-cloudflare.yml. Checkout retired in August
    # 2026, so a site build needs only the Cloudflare deployment credentials;
    # keeping the old Paddle-token gate made truthful no-checkout releases
    # impossible to publish.
    : "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN unset in /etc/ia-ci/env}"
    : "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID unset in /etc/ia-ci/env}"

    # Site build on a lane A machine too — vite config and plugins are repo
    # code. The wrangler UPLOAD stays here with the Cloudflare token: pinned
    # tooling from the registry, not repo code.
    BUILD_RC=0
    ARTIFACT=$(request_remote_build build-site) || BUILD_RC=$?
    if [ "$BUILD_RC" = 2 ]; then
      echo "site build failed on the build machine — failing the deploy" >&2
      exit 1
    elif [ "$BUILD_RC" = 0 ] && [ -n "$ARTIFACT" ] && [ -f "$ARTIFACT" ]; then
      rm -rf dist
      mkdir -p dist
      tar -xzf "$ARTIFACT" -C dist
      rm -f "$ARTIFACT"
      echo "site built on a lane A machine"
    elif [ "${IA_LOCAL_BUILD:-}" = "1" ]; then
      echo "IA_LOCAL_BUILD=1 — building LOCALLY on the keyed box (operator break-glass)" >&2
      npm ci --silent
      npm run build
    else
      echo "remote build unavailable and this box does not execute repo code (docs/platform-on-own-git.md)." >&2
      echo "Break glass during a Fly outage: IA_LOCAL_BUILD=1 run-job.sh $KIND $SHA" >&2
      exit 1
    fi
    # --branch=main is explicit for the same reason the workflow's was:
    # production promotion must not depend on the runner's git state.
    npx --yes wrangler@3 pages deploy dist --project-name=infinite-agents --branch=main
    ;;

  machine-image)
    # Mirrors fly-machine-image.yml, which is GitHub-HOSTED (ubuntu-latest) and
    # so has not run since Actions froze on 2026-07-30. The consequence was
    # invisible: image changes merged, and every new agent machine kept booting
    # the last image built on 2026-07-28.
    # IA_FORCE_JOB is set by a /dispatch (a CLI pin bump). The pin lives outside
    # the repo, so the diff cannot answer whether this build is wanted — the
    # caller already decided it is.
    if ! changed_since "$(last_attempted)" '^infra/fly-machine-image/'; then
      echo "no machine-image changes since the last attempt — skipped"
      record_attempt
      exit 78   # daemon maps 78 to "skipped", not success
    fi
    record_attempt   # tried, whatever happens next: a failure is red, not retried by unrelated merges
    command -v docker >/dev/null || { echo "docker is not installed on this runner — see infra/ci-runner/README.md" >&2; exit 1; }
    : "${FLY_API_TOKEN:?FLY_API_TOKEN unset in /etc/ia-ci/env — cannot push to registry.fly.io}"
    : "${GHCR_PUSH_TOKEN:?GHCR_PUSH_TOKEN unset in /etc/ia-ci/env — cannot push the public image to ghcr.io}"
    # The ghcr account that owns the public package, and the docker-login user
    # for it. Config, not source: the repository carries no account name, and a
    # name baked in here was how a placeholder ("owner") once read like a value
    # and pushed every image build into permission_denied.
    : "${GHCR_OWNER:?GHCR_OWNER unset in /etc/ia-ci/env — the ghcr.io account that owns the public image}"

    # CLI versions come from the fleet PIN, never npm latest. The image bakes
    # the CLIs, so building `latest` made every image build a version decision
    # taken by the registry, which the pre-sleep updater then had to undo — and
    # only for the CLI that machine's agent uses, leaving the others drifted.
    # The pin is the control plane; this is the build asking it what to bake.
    #
    # The pin lives in the backend's config store, which this runner cannot
    # read, so it is fetched over the same SSH trust path used for
    # set-machine-image below. deploy-prod is queued AHEAD of this job, so the
    # backend answering is already the one built from $SHA.
    PIN_JSON="$(ssh $SSH_OPTS "root@$PROD_HOST" \
      'curl -fsS --max-time 20 localhost:3001/api/harness-cli-versions')" || {
      echo "could not read the CLI pin from $PROD_HOST — refusing to bake npm latest" >&2
      exit 1
    }

    # Validated here as well as in the backend: a dist-tag, a null or a blank
    # would each turn back into "latest" inside docker build, which is the whole
    # failure this job is closing.
    pin_version() {
      printf '%s' "$PIN_JSON" | node -e '
        let raw = "";
        process.stdin.on("data", (chunk) => { raw += chunk; });
        process.stdin.on("end", () => {
          const pinned = (JSON.parse(raw) || {})[process.argv[1]];
          if (typeof pinned === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pinned)) {
            process.stdout.write(pinned);
          }
        });
      ' "$1"
    }
    CLAUDE_VERSION="$(pin_version claude)"
    CODEX_VERSION="$(pin_version codex)"
    OPENCODE_VERSION="$(pin_version opencode)"
    [ -n "$CLAUDE_VERSION" ] && [ -n "$CODEX_VERSION" ] && [ -n "$OPENCODE_VERSION" ] || {
      echo "config doc has no valid pin for every CLI (claude='$CLAUDE_VERSION' codex='$CODEX_VERSION' opencode='$OPENCODE_VERSION') — refusing to bake npm latest" >&2
      exit 1
    }
    echo "baking pinned CLIs: claude $CLAUDE_VERSION, codex $CODEX_VERSION, opencode $OPENCODE_VERSION"

    # The tag names the commit AND the pins (note #1052), so a pin bump at an
    # unchanged commit is a new tag and every sleeping machine is offered it.
    LABEL="$(machine_image_label "$SHA" "$CLAUDE_VERSION" "$CODEX_VERSION" "$OPENCODE_VERSION")" || exit 1
    # Two registries, one image (byo-fly-design: "an image the client's org can
    # pull"). GHCR is the PUBLIC home — machines in client Fly orgs can only
    # pull public refs, so this is the ref the fleet boots from. The Fly-org
    # copy stays as the rollback path a GHCR outage cannot take away, and it
    # is what our fleet ran on before 2026-08-23.
    IMAGE_REF="registry.fly.io/ia-machine-images:$LABEL"
    PUBLIC_IMAGE_REF="ghcr.io/$GHCR_OWNER/ia-machine-images:$LABEL"
    echo "image tag: $LABEL"

    # One tag, one set of bytes. A tag already on ghcr was smoke-tested and
    # pushed by an earlier build of this very commit with these very pins, and
    # machines may already be on it: pushing new bytes over it would bring
    # trap 2 straight back (the roller would call those machines current). So
    # a rebuild of the same inputs only makes sure the fleet points at it.
    # ghcr is pushed LAST, after the smoke test and the Fly copy, so "present"
    # there means the whole build finished. No clear answer is a failure, not
    # a guess: ghcr is where this job pushes anyway.
    TAG_STATE="$(ghcr_tag_state "$GHCR_OWNER/ia-machine-images" "$LABEL")" || {
      echo "ghcr did not say whether $LABEL exists — refusing to build over a tag that may be live" >&2
      exit 1
    }
    if [ "$TAG_STATE" = present ]; then
      echo "$PUBLIC_IMAGE_REF is already published — same commit, same pins, so nothing to build; repointing only"
      ssh $SSH_OPTS "root@$PROD_HOST" "/usr/local/bin/set-machine-image '$PUBLIC_IMAGE_REF'"
      printf '%s\n' "$IMAGE_REF" > /opt/ia-ci/lane-a-image.new && mv -f /opt/ia-ci/lane-a-image.new /opt/ia-ci/lane-a-image
      exit 0
    fi

    # Started only now: a rebuild of a published tag above needs no builder.
    builder_up
    docker build \
      --build-arg "CLAUDE_VERSION=$CLAUDE_VERSION" \
      --build-arg "CODEX_VERSION=$CODEX_VERSION" \
      --build-arg "OPENCODE_VERSION=$OPENCODE_VERSION" \
      -t "fly-machine-image:$LABEL" infra/fly-machine-image

    # The gate, and the reason repointing below is safe to automate: this boots
    # the image, SSHes in, checks the CLIs, installs a ~/.boot.d hook, then
    # recreates the container on the SAME volume and verifies the home data and
    # the hook survived. Serial queue, so its fixed host port cannot collide.
    # The pinned versions go in too: the smoke test asserts the image actually
    # carries what this build asked for. Without them it only proves the CLIs
    # run, which is what let an image with a stale Codex through on 2026-09-11.
    smoke_test infra/fly-machine-image IMAGE_TAG="fly-machine-image:$LABEL" \
      CLAUDE_VERSION="$CLAUDE_VERSION" CODEX_VERSION="$CODEX_VERSION" OPENCODE_VERSION="$OPENCODE_VERSION"

    # Registry auth without flyctl: the Fly registry takes the API token as a
    # docker password, so the runner needs no extra tooling.
    printf '%s' "$FLY_API_TOKEN" | docker login registry.fly.io --username x --password-stdin
    docker tag "fly-machine-image:$LABEL" "$IMAGE_REF"
    docker push "$IMAGE_REF"

    # The public copy. The ghcr package was made public once, by hand, at its
    # first push (2026-08-23); pushes after that inherit the visibility, so a
    # new tag is publicly pullable the moment this returns.
    printf '%s' "$GHCR_PUSH_TOKEN" | docker login ghcr.io --username "$GHCR_OWNER" --password-stdin
    docker tag "fly-machine-image:$LABEL" "$PUBLIC_IMAGE_REF"
    docker push "$PUBLIC_IMAGE_REF"

    # A pushed image nobody points at changes nothing. `set-machine-image` is
    # the root-owned helper on the backend host (infra/backend-host/): it
    # accepts one tag under a fixed allowlist of registries, keeps the previous
    # env beside it, and fails loudly if the service does not come back. The
    # runner holds the root key, so it calls the helper directly; the sudoers
    # entry exists for the GitHub-Actions path, should Actions ever come back.
    # The PUBLIC ref is the one the fleet boots from — client-org machines
    # cannot pull anything else.
    ssh $SSH_OPTS "root@$PROD_HOST" "/usr/local/bin/set-machine-image '$PUBLIC_IMAGE_REF'"

    # Lane A CI machines follow the fleet: lane-a.mjs reads this file per job
    # (unless the LANE_A_IMAGE override is set), so CI stops booting an image
    # that quietly aged past what agents run. Written AFTER the smoke test and
    # repoint above — an image good enough for every new agent machine is good
    # enough for CI, and never the other way around.
    printf '%s\n' "$IMAGE_REF" > /opt/ia-ci/lane-a-image.new && mv -f /opt/ia-ci/lane-a-image.new /opt/ia-ci/lane-a-image
    echo "lane A image now $IMAGE_REF"

    # Existing machines keep their own image until deliberately rolled with
    # backend/scripts/roll-machine-image.mjs. This only changes what NEW
    # machines are created from.
    docker image rm "fly-machine-image:$LABEL" "$IMAGE_REF" >/dev/null 2>&1 || true
    ;;

  git-host-image)
    # The git-host image (byo-git-design slice 2): the ia-media service,
    # packaged for a client org's own Fly machine. Rebuilt when either the
    # service code or the image wrapper changes — the code exists once, in
    # infra/git-host, and this job stages it into the build context so
    # ia-media and the image ship the same bytes.
    if ! changed_since "$(last_attempted)" '^infra/(git-host|git-host-image)/'; then
      echo "no git-host changes since the last attempt — skipped"
      record_attempt
      exit 78   # daemon maps 78 to "skipped", not success
    fi
    record_attempt   # tried, whatever happens next: a failure is red, not retried by unrelated merges
    command -v docker >/dev/null || { echo "docker is not installed on this runner — see infra/ci-runner/README.md" >&2; exit 1; }
    builder_up
    : "${GHCR_PUSH_TOKEN:?GHCR_PUSH_TOKEN unset in /etc/ia-ci/env — cannot push the public image to ghcr.io}"
    # The ghcr account that owns the public package, and the docker-login user
    # for it. Config, not source: the repository carries no account name, and a
    # name baked in here was how a placeholder ("owner") once read like a value
    # and pushed every image build into permission_denied.
    : "${GHCR_OWNER:?GHCR_OWNER unset in /etc/ia-ci/env — the ghcr.io account that owns the public image}"

    # Same public package as the other two images, its own tag family: the
    # package's visibility was set once, so a new tag is publicly pullable
    # the moment the push returns — which is the property client orgs need.
    LABEL="git-host-sha-${SHA:0:12}"
    PUBLIC_IMAGE_REF="ghcr.io/$GHCR_OWNER/ia-machine-images:$LABEL"

    STAGE=$(mktemp -d)
    cp infra/git-host-image/Dockerfile infra/git-host-image/entrypoint.sh "$STAGE"/
    cp infra/git-host/git-host.mjs infra/git-host/backup.mjs infra/git-host/maintain-repos.sh "$STAGE"/
    cp -r infra/git-host/hooks "$STAGE/hooks"
    docker build -t "git-host-image:$LABEL" "$STAGE"
    rm -rf "$STAGE"

    # The gate: boots the container, proves health, the control API's secret,
    # fail-closed git auth, and volume ownership. Never pushes a broken image.
    smoke_test infra/git-host-image IMAGE_TAG="git-host-image:$LABEL"

    printf '%s' "$GHCR_PUSH_TOKEN" | docker login ghcr.io --username "$GHCR_OWNER" --password-stdin
    docker tag "git-host-image:$LABEL" "$PUBLIC_IMAGE_REF"
    docker push "$PUBLIC_IMAGE_REF"
    echo "pushed $PUBLIC_IMAGE_REF"

    # A pushed image nobody points at changes nothing — which is how production
    # went on naming the 23 August 2026 image for two months of merges, while
    # the code host it would start refused every push from a current backend
    # (note #809). Same root helper and same trust path as machine-image above;
    # --git-host writes FLY_GIT_HOST_IMAGE alone and accepts only this tag
    # family. deploy-prod is queued ahead of this job, so the backend that
    # reads the new value is already the one built from $SHA. It names the
    # image only for code hosts not yet created: an existing one keeps its own
    # image until it is rolled deliberately.
    ssh $SSH_OPTS "root@$PROD_HOST" "/usr/local/bin/set-machine-image --git-host '$PUBLIC_IMAGE_REF'"
    # Our own central code host follows every green build (note #1032): it
    # runs this image on Fly, so rolling it IS its deploy (deploy-git-host,
    # which shipped files to the Hetzner box, now skips when this is set).
    if [ -n "${IA_GIT_HOST_APP:-}" ]; then
      roll_app_image "$IA_GIT_HOST_APP" "$PUBLIC_IMAGE_REF"
    fi

    docker image rm "git-host-image:$LABEL" "$PUBLIC_IMAGE_REF" >/dev/null 2>&1 || true
    ;;

  msg-host-image)
    # The messaging-host image (note #608): the one machine a workplace's
    # direct messages live on. Same public package as the other images, its
    # own tag family; rebuilt only when the server or its wrapper changes.
    if ! changed_since "$(last_attempted)" '^infra/(msg-host|msg-host-image)/'; then
      echo "no msg-host changes since the last attempt — skipped"
      record_attempt
      exit 78   # daemon maps 78 to "skipped", not success
    fi
    record_attempt
    command -v docker >/dev/null || { echo "docker is not installed on this runner — see infra/ci-runner/README.md" >&2; exit 1; }
    builder_up
    : "${GHCR_PUSH_TOKEN:?GHCR_PUSH_TOKEN unset in /etc/ia-ci/env — cannot push the public image to ghcr.io}"
    : "${GHCR_OWNER:?GHCR_OWNER unset in /etc/ia-ci/env — the ghcr.io account that owns the public image}"

    LABEL="msg-host-sha-${SHA:0:12}"
    PUBLIC_IMAGE_REF="ghcr.io/$GHCR_OWNER/ia-machine-images:$LABEL"

    node --check infra/msg-host/msg-host.mjs
    STAGE=$(mktemp -d)
    cp infra/msg-host-image/Dockerfile infra/msg-host-image/entrypoint.sh "$STAGE"/
    cp infra/msg-host/msg-host.mjs "$STAGE"/
    docker build -t "msg-host-image:$LABEL" "$STAGE"
    rm -rf "$STAGE"

    # The gate: secret required, foreign workplace refused, idempotent send,
    # unprivileged process, fail-closed start. Never pushes a broken image.
    smoke_test infra/msg-host-image IMAGE_TAG="msg-host-image:$LABEL"

    printf '%s' "$GHCR_PUSH_TOKEN" | docker login ghcr.io --username "$GHCR_OWNER" --password-stdin
    docker tag "msg-host-image:$LABEL" "$PUBLIC_IMAGE_REF"
    docker push "$PUBLIC_IMAGE_REF"
    echo "pushed $PUBLIC_IMAGE_REF"

    # Repoint production at what was just proven and pushed, exactly as
    # git-host-image does (note #819, after note #809): --msg-host writes
    # FLY_MSG_HOST_IMAGE alone and accepts only this tag family. It names the
    # image only for messaging machines not yet built: an existing one is
    # woken on its own image, never recreated, so nothing live moves.
    ssh $SSH_OPTS "root@$PROD_HOST" "/usr/local/bin/set-machine-image --msg-host '$PUBLIC_IMAGE_REF'"

    docker image rm "msg-host-image:$LABEL" "$PUBLIC_IMAGE_REF" >/dev/null 2>&1 || true
    ;;

  copy-release)
    # One private-copy release (note #811): every image a copy runs, from this
    # commit, under the version in infra/copy-release/VERSION, pushed to our
    # private registry (registry.fly.io/acc-copy-releases) with a release
    # manifest naming them together. Customers reach it only through the
    # update service (infra/copy-updates), with a key we sign. Cut by changing
    # VERSION in an approved proposal; self-skips otherwise.
    if ! changed_since "$(last_attempted)" '^infra/copy-release/VERSION$'; then
      echo "infra/copy-release/VERSION unchanged since the last attempt — no new release"
      record_attempt
      exit 78   # daemon maps 78 to "skipped", not success
    fi
    record_attempt
    command -v docker >/dev/null || { echo "docker is not installed on this runner — see infra/ci-runner/README.md" >&2; exit 1; }
    builder_up
    : "${FLY_API_TOKEN:?FLY_API_TOKEN unset in /etc/ia-ci/env — cannot push to registry.fly.io}"
    # The agent and site images are the ones our own fleet runs right now:
    # read from production's settings, never guessed.
    LIVE_IMAGES="$(ssh $SSH_OPTS "root@$PROD_HOST" "grep -E '^(FLY_MACHINE_IMAGE|FLY_APP_RUNTIME_IMAGE)=' /etc/infinite-agents/backend.env")"
    COPY_MACHINE_IMAGE="$(printf '%s\n' "$LIVE_IMAGES" | sed -n 's/^FLY_MACHINE_IMAGE=//p' | tr -d "\"' ")"
    COPY_APP_RUNTIME_IMAGE="$(printf '%s\n' "$LIVE_IMAGES" | sed -n 's/^FLY_APP_RUNTIME_IMAGE=//p' | tr -d "\"' ")"
    printf '%s' "$FLY_API_TOKEN" | docker login registry.fly.io --username x --password-stdin
    VERSION="$(tr -d '[:space:]' < infra/copy-release/VERSION)" SHA="$SHA" FLY_API_TOKEN="$FLY_API_TOKEN" \
      RELEASE_REPO="${COPY_RELEASE_REPO:-acc-copy-releases}" \
      MACHINE_IMAGE="$COPY_MACHINE_IMAGE" APP_RUNTIME_IMAGE="$COPY_APP_RUNTIME_IMAGE" \
      ./infra/copy-release/build.sh
    # The offer gate (note #1008): built is not offered. The standing test
    # copy upgrades to it and passes both drills first; only then does the
    # update service name it latest. A red here means built, NOT offered.
    run_copy_release_gate
    ;;

  copy-release-gate)
    # The gate alone, for a release already built (dispatch it to re-run the
    # gate after a fix, or to try the release in VERSION again).
    run_copy_release_gate
    ;;

  deploy-db-backup)
    # The database's own off-box backup. Same box as the backend but its own
    # job: a backup that fails to install must not roll back a release, and a
    # bad release must not take the backups down with it.
    # The notifier scripts live with the git host but are installed here too —
    # ia-backend has no /opt/agentgit — so a change to either redeploys this.
    if ! changed_since "$(last_attempted)" '^(infra/db-backup/|infra/git-host/notify(-unit-failure)?\.sh$)'; then
      echo "no db-backup changes since the last attempt — skipped"
      record_attempt
      exit 78   # daemon maps 78 to "skipped", not success
    fi
    record_attempt   # tried, whatever happens next: a failure is red, not retried by unrelated merges
    SRC="$REPO_DIR/infra/db-backup"
    DB_ROOT=/opt/dbbackup

    # Validate on the runner, before a byte leaves it.
    bash -n "$SRC/snapshot-db.sh"
    bash -n "$SRC/backup-db.sh"
    bash -n "$SRC/provision.sh"

    # --rsync-path so the staging directory exists on the first ever deploy;
    # rsync does not create a destination it was not handed.
    rsync -az -e "ssh $SSH_OPTS" --rsync-path="mkdir -p $DB_ROOT/staged && rsync" \
      "$SRC/snapshot-db.sh" "$SRC/backup-db.sh" \
      "$REPO_DIR/infra/git-host/notify.sh" "$REPO_DIR/infra/git-host/notify-unit-failure.sh" \
      "$REPO_DIR/infra/git-host/backup-heartbeat.sh" \
      "root@$PROD_HOST:$DB_ROOT/staged/"
    rsync -az -e "ssh $SSH_OPTS" \
      "$SRC/dbbackup.service" "$SRC/dbbackup.timer" \
      "$SRC/dbbackup-failed@.service" \
      "root@$PROD_HOST:/etc/systemd/system/"

    ssh $SSH_OPTS "root@$PROD_HOST" bash <<'REMOTE'
set -euo pipefail
ROOT=/opt/dbbackup

# The deploy updates files; it does not create the user, the key or the config.
# Saying so beats a chown failure fifty lines down.
id -u dbbackup >/dev/null 2>&1 || {
  echo "dbbackup user does not exist — run infra/db-backup/provision.sh on this box first" >&2
  exit 1
}

for f in snapshot-db.sh backup-db.sh notify.sh notify-unit-failure.sh backup-heartbeat.sh; do
  bash -n "$ROOT/staged/$f"
done

# snapshot-db.sh runs AS ROOT via ExecStartPre=+, so it stays root-owned and
# not writable by dbbackup. A dbbackup-writable file here would be a path from
# the unprivileged half of the job into the privileged one.
install -o root -g root -m 0755 "$ROOT/staged/snapshot-db.sh" "$ROOT/snapshot-db.sh"
install -o root -g root -m 0755 "$ROOT/staged/notify.sh" "$ROOT/notify.sh"
install -o root -g root -m 0755 "$ROOT/staged/notify-unit-failure.sh" "$ROOT/notify-unit-failure.sh"
install -o root -g root -m 0755 "$ROOT/staged/backup-heartbeat.sh" "$ROOT/backup-heartbeat.sh"
# The uploader runs as dbbackup and must be readable and executable by it.
install -o dbbackup -g dbbackup -m 0755 "$ROOT/staged/backup-db.sh" "$ROOT/backup-db.sh"
rm -rf "$ROOT/staged"

# rsync -a preserves the runner's uid/gid; systemd units belong to root.
chown root:root /etc/systemd/system/dbbackup.service \
                /etc/systemd/system/dbbackup.timer \
                '/etc/systemd/system/dbbackup-failed@.service'
chmod 644 /etc/systemd/system/dbbackup.service \
          /etc/systemd/system/dbbackup.timer \
          '/etc/systemd/system/dbbackup-failed@.service'

systemctl daemon-reload
systemctl enable --now dbbackup.timer >/dev/null 2>&1 \
  && echo "db backup timer: $(systemctl show -p NextElapseUSecRealtime --value dbbackup.timer)" \
  || echo "db backup timer could not be enabled (backups are not running)" >&2

# Proves the shipped scripts parse and are reachable AS the users that will run
# them — not that a backup happened, which takes a night.
sudo -u dbbackup test -x "$ROOT/backup-db.sh" && echo "uploader is executable by dbbackup"
sudo -u dbbackup test ! -w "$ROOT/snapshot-db.sh" \
  && echo "privileged snapshot step is not writable by dbbackup"
REMOTE
    ;;

  mirror-github)
    # The read-only GitHub copy of the platform repo, refreshed on every ref
    # move of OUR host once the flip has happened (docs/platform-on-own-git.md).
    # Inert until then, twice over: the daemon queues this only when
    # PLATFORM_REPO is set, and this guard makes a stray by-hand run harmless.
    # Fetching from our host uses the RECOVERY token — read-only, one repo, so
    # the mirror doubles as a daily drive on the escape road.
    if [ -z "${PLATFORM_REPO:-}" ]; then
      echo "PLATFORM_REPO unset — mirroring is armed only after the source-of-truth flip"
      exit 78
    fi
    # Off by the owner's choice (note #936): once the platform repo is the
    # public agentic-cloud, there is no GitHub copy to keep. The old mirror
    # holds the PRIVATE infinite-agents history, and pushing the new
    # repository at it with --prune --force would replace that history.
    if [ "${GITHUB_MIRROR:-on}" = "off" ]; then
      echo "GITHUB_MIRROR=off in /etc/ia-ci/env — no GitHub copy is kept"
      exit 78
    fi
    : "${RECOVERY_GIT_TOKEN:?RECOVERY_GIT_TOKEN unset in /etc/ia-ci/env — the mirror fetches with the break-glass token}"
    PLATFORM_GIT_BASE="${PLATFORM_GIT_BASE:-https://git.agentbuilt.app}"
    INTERNAL_URL="$PLATFORM_GIT_BASE/$PLATFORM_REPO.git"
    MIRROR_DIR="$WORKDIR/platform-mirror.git"

    # Credentials as DATA in a private netrc under a throwaway HOME — both
    # tokens would otherwise ride argv, where ps and git's own error messages
    # print them.
    MIRROR_HOME="$(mktemp -d)"
    trap 'rm -rf "$MIRROR_HOME"' EXIT
    ( umask 077
      {
        printf 'machine %s login x-access-token password %s\n' "${PLATFORM_GIT_BASE#https://}" "$RECOVERY_GIT_TOKEN"
        printf 'machine github.com login x-access-token password %s\n' "$GH_TOKEN"
      } > "$MIRROR_HOME/.netrc"
    )

    if [ ! -d "$MIRROR_DIR" ]; then
      git init -q --bare "$MIRROR_DIR"
    fi
    # Heads and tags only, pruned both ways: agents' work branches and the
    # occasional force-push must arrive as deletions and rewrites, or the
    # mirror slowly stops being one. refs/pull and other decorations do not
    # travel — GitHub owns those on its own side.
    HOME="$MIRROR_HOME" git --git-dir "$MIRROR_DIR" fetch --quiet --prune "$INTERNAL_URL" \
      '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
    GITHUB_URL="https://github.com/$REPO.git"
    # Both sides printed the same way — ls-remote against a local directory
    # advertises exactly what it advertises over the wire, peeled tags and all,
    # so the two listings are comparable line for line.
    mirror_refs() {
      HOME="$MIRROR_HOME" git --git-dir "$MIRROR_DIR" ls-remote --heads --tags "$1" | sort
    }

    # GitHub answers a push with a 500 now and then, and it has been seen to
    # APPLY the ref updates while saying so: on 2026-09-23 two refs came back
    # "! [remote rejected] (Internal Server Error)" and both were already on
    # GitHub, at the right shas, when we looked. A red mirror is not free — the
    # status rides the sha whose push triggered the run, so a stale failure
    # paints a red pip on whatever proposal that sha heads and makes the
    # backend refuse its `pr ready`. So retry the push, and then judge by the
    # END STATE rather than by git's exit code: every ref matching ours IS the
    # copy being the copy, whatever the remote said while making it.
    pushed=
    for attempt in 1 2 3; do
      if HOME="$MIRROR_HOME" git --git-dir "$MIRROR_DIR" push --quiet --prune --force "$GITHUB_URL" \
           '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'; then
        pushed=yes
        [ "$attempt" = 1 ] || echo "push succeeded on attempt $attempt"
        break
      fi
      echo "push attempt $attempt failed"
      [ "$attempt" = 3 ] || sleep $(( attempt * 5 ))
    done
    if [ -z "$pushed" ]; then
      # A listing we cannot READ is its own failure and must never be mistaken
      # for "GitHub differs" — that would turn a blip into a false all-clear in
      # the one direction that matters.
      mirror_refs "$MIRROR_DIR" > "$MIRROR_HOME/ours.refs" \
        || { echo "could not list our own mirror's refs"; exit 1; }
      mirror_refs "$GITHUB_URL" > "$MIRROR_HOME/theirs.refs" \
        || { echo "could not read github.com/$REPO's refs after 3 failed push attempts"; exit 1; }
      if diff -q "$MIRROR_HOME/ours.refs" "$MIRROR_HOME/theirs.refs" > /dev/null; then
        echo "the push reported an error, but every ref on GitHub already matches ours — mirrored"
      else
        echo "github.com/$REPO still differs from $INTERNAL_URL after 3 push attempts:"
        diff "$MIRROR_HOME/ours.refs" "$MIRROR_HOME/theirs.refs" | head -20 || true
        exit 1
      fi
    fi
    echo "mirrored $INTERNAL_URL -> github.com/$REPO ($(git --git-dir "$MIRROR_DIR" rev-parse --short refs/heads/main 2>/dev/null || echo '?') on main)"
    ;;

  self-update)
    # The daemon runs the /opt/ia-ci copies, so until today every change to
    # this directory needed someone to SSH in and copy files by hand — which
    # meant a merged CI change sat inert until somebody remembered. This job is
    # that reinstall.
    if ! changed_since "$(last_attempted)" '^infra/ci-runner/'; then
      echo "no ci-runner changes since the last attempt — skipped"
      record_attempt
      exit 78   # daemon maps 78 to "skipped", not success
    fi
    record_attempt   # tried, whatever happens next: a failure is red, not retried by unrelated merges
    SRC="$REPO_DIR/infra/ci-runner"
    OPT=/opt/ia-ci

    # Validate BEFORE replacing anything. A daemon.mjs that will not parse
    # crash-loops, and there would be no CI left to fix it with.
    node --check "$SRC/daemon.mjs"
    node --check "$SRC/lane-a.mjs"
    bash -n "$SRC/run-job.sh"
    bash -n "$SRC/runner-agent.sh"

    # lane-a.mjs is imported by daemon.mjs, and runner-agent.sh is read by
    # lane-a.mjs at import — all four live in /opt/ia-ci together or the
    # daemon dies on its next restart.
    for f in daemon.mjs lane-a.mjs run-job.sh runner-agent.sh; do
      if cmp -s "$SRC/$f" "$OPT/$f"; then
        echo "$f unchanged"
        continue
      fi
      cp -a "$OPT/$f" "$OPT/$f.previous"
      # Temp + atomic rename, never a write in place: bash reads a script
      # incrementally, and THIS file is the one being replaced — an in-place
      # write would make the running shell resume mid-way through new bytes.
      # The rename swaps the directory entry; this process keeps its inode.
      cp "$SRC/$f" "$OPT/$f.new"
      chmod 755 "$OPT/$f.new"
      mv -f "$OPT/$f.new" "$OPT/$f"
      echo "installed $f (previous kept at $OPT/$f.previous)"
      # run-job.sh needs no restart: the daemon spawns it fresh per job, so the
      # next job already runs the new copy. Everything else is loaded when the
      # long-lived daemon starts (lane-a.mjs is imported, runner-agent.sh read
      # at import), so it has to come back — it checks for this flag when idle
      # and exits, and systemd's Restart=always brings it up on the new code.
      # No sudo anywhere: /opt/ia-ci is owned by the runner user.
      if [ "$f" != run-job.sh ]; then
        touch "$OPT/.restart-requested"
        echo "$f changed — daemon will restart itself once the queue is idle"
      fi
    done
    ;;

  *)
    echo "unknown job kind: $KIND" >&2
    exit 2
    ;;
esac

echo "=== $KIND @ $SHA: OK ==="
