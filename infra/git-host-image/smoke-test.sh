#!/usr/bin/env bash
# Boot the freshly built git-host image and prove the things a client org
# will depend on: the server comes up on the volume, the control API answers
# the shared secret and refuses its absence, and an unverifiable git client
# FAILS CLOSED when the backend cannot be reached — which in this test it
# never can (BACKEND_URL points at a dead port on purpose).
#
# Run by the `git-host-image` CI job with IMAGE_TAG set. Exits non-zero on
# the first broken promise; the job then never pushes the image.
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required, e.g. git-host-image:sha-abc}"
PORT=18080
SECRET=smoke-secret

CONTAINER=$(docker run -d \
  -e GIT_HOST_SECRET="$SECRET" \
  -e BACKEND_URL=http://127.0.0.1:9 \
  -p "127.0.0.1:$PORT:8080" \
  "$IMAGE_TAG")
trap 'docker logs "$CONTAINER" 2>&1 | tail -20; docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done

HEALTH=$(curl -fsS "http://127.0.0.1:$PORT/health")
echo "health: $HEALTH"
echo "$HEALTH" | grep -q '"ok":true'

# The control API takes the shared secret…
curl -fsS -X POST \
  -H "x-git-host-secret: $SECRET" -H 'content-type: application/json' \
  -d '{"userId":"org-smoke","name":"probe","protectedBranches":["main"]}' \
  "http://127.0.0.1:$PORT/internal/repos" >/dev/null
echo "control API: created a repo with the secret"

# …and refuses its absence.
NO_SECRET=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -d '{}' \
  "http://127.0.0.1:$PORT/internal/repos")
[ "$NO_SECRET" = "401" ] || { echo "expected 401 without the secret, got $NO_SECRET"; exit 1; }
echo "control API: refused without the secret ($NO_SECRET)"

# A git client whose token cannot be verified (dead backend) fails CLOSED.
GIT_CODE=$(curl -s -o /dev/null -w '%{http_code}' -u agent:agb1.notreal.token \
  "http://127.0.0.1:$PORT/org-smoke/probe.git/info/refs?service=git-upload-pack")
[ "$GIT_CODE" = "503" ] || { echo "expected 503 fail-closed with a dead backend, got $GIT_CODE"; exit 1; }
echo "git endpoint: failed closed against a dead backend ($GIT_CODE)"

# The repo landed on the volume path as the unprivileged user.
docker exec "$CONTAINER" sh -c 'test -d /data/repos/org-smoke/probe.git && stat -c %U /data/repos/org-smoke/probe.git' | grep -qx agentgit
echo "volume: bare repo present, owned by agentgit"

# ── Standalone mode (byo-git slice 7): the off-boarding promise, same image,
# one env flip. The host calls nobody: an unauthenticated clone answers, and
# a push lands on a PROTECTED branch — the approval gates left with us.
PORT2=18081
CONTAINER2=$(docker run -d \
  -e GIT_HOST_SECRET="$SECRET" \
  -e BACKEND_URL=http://127.0.0.1:9 \
  -e GIT_HOST_STANDALONE=1 \
  -p "127.0.0.1:$PORT2:8080" \
  "$IMAGE_TAG")
trap 'docker logs "$CONTAINER2" 2>&1 | tail -20; docker rm -f "$CONTAINER" "$CONTAINER2" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT2/health" >/dev/null 2>&1 && break
  sleep 1
done
HEALTH2=$(curl -fsS "http://127.0.0.1:$PORT2/health")
echo "standalone health: $HEALTH2"
echo "$HEALTH2" | grep -q '"standalone":true'

# The control API still honors the secret (used here to seed a repo with a
# protected branch — in real life nobody holds this secret after off-boarding).
curl -fsS -X POST \
  -H "x-git-host-secret: $SECRET" -H 'content-type: application/json' \
  -d '{"userId":"org-smoke","name":"probe","protectedBranches":["main"]}' \
  "http://127.0.0.1:$PORT2/internal/repos" >/dev/null

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; docker rm -f "$CONTAINER" "$CONTAINER2" >/dev/null 2>&1 || true' EXIT
git init -q -b main "$WORK/push"
echo standalone > "$WORK/push/README.md"
git -C "$WORK/push" -c user.name=Smoke -c user.email=smoke@test add README.md
git -C "$WORK/push" -c user.name=Smoke -c user.email=smoke@test commit -qm standalone
# NO credentials in the URL, and main is protected — both must not matter now.
GIT_TERMINAL_PROMPT=0 git -C "$WORK/push" push -q "http://127.0.0.1:$PORT2/org-smoke/probe.git" main
echo "standalone: pushed to protected main with no credentials"
GIT_TERMINAL_PROMPT=0 git clone -q "http://127.0.0.1:$PORT2/org-smoke/probe.git" "$WORK/clone"
grep -qx standalone "$WORK/clone/README.md"
echo "standalone: cloned back with no credentials"

echo "smoke test passed"
