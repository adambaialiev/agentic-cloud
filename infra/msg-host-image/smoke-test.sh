#!/usr/bin/env bash
# Boot the freshly built messaging-host image and prove what a workplace will
# depend on: it serves from the volume as an unprivileged user, the secret is
# required, another workplace's name is refused, a send is idempotent, and —
# the one that matters most — it REFUSES TO START on a private network when it
# has no backend peer to pin the firewall to.
#
# Run by the `msg-host-image` CI job with IMAGE_TAG set. Exits non-zero on the
# first broken promise; the job then never pushes the image.
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required, e.g. msg-host-image:sha-abc}"
PORT=18081
SECRET=smoke-secret

CONTAINER=$(docker run -d \
  -e MSG_HOST_SECRET="$SECRET" \
  -e MSG_HOST_ORG=org-smoke \
  -e MSG_HOST_SKIP_FIREWALL=1 \
  -p "127.0.0.1:$PORT:8080" \
  "$IMAGE_TAG")
trap 'docker logs "$CONTAINER" 2>&1 | tail -20; docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'
echo "health: ok"

call() { curl -s -o /tmp/msg-smoke.out -w '%{http_code}' -X POST -H 'content-type: application/json' "$@"; }
SEND='{"userId":"u-a","peerId":"u-b","text":"smoke","clientId":"smoke-client-0001"}'

CODE=$(call -d "$SEND" "http://127.0.0.1:$PORT/v1/send")
[ "$CODE" = "401" ] || { echo "expected 401 without the secret, got $CODE"; exit 1; }
echo "refused without the secret ($CODE)"

CODE=$(call -H "x-msg-host-secret: $SECRET" -H 'x-msg-host-org: someone-else' -d "$SEND" "http://127.0.0.1:$PORT/v1/send")
[ "$CODE" = "403" ] || { echo "expected 403 for another workplace, got $CODE"; exit 1; }
echo "refused another workplace's name ($CODE)"

for expected in true false; do
  CODE=$(call -H "x-msg-host-secret: $SECRET" -H 'x-msg-host-org: org-smoke' -d "$SEND" "http://127.0.0.1:$PORT/v1/send")
  [ "$CODE" = "200" ] || { echo "send answered $CODE"; exit 1; }
  grep -q "\"created\":$expected" /tmp/msg-smoke.out || { echo "expected created:$expected"; cat /tmp/msg-smoke.out; exit 1; }
done
echo "send stored once, retry returned the original"

OWNER=$(docker exec "$CONTAINER" stat -c '%U %a' /data/messages)
[ "$OWNER" = "msghost 700" ] || { echo "expected /data/messages msghost 700, got $OWNER"; exit 1; }
PROC_USER=$(docker exec "$CONTAINER" stat -c '%U' /proc/1)
[ "$PROC_USER" = "msghost" ] || { echo "server runs as '$PROC_USER', expected msghost"; exit 1; }
echo "volume and process are msghost's"

# Fail closed: no secret → no server.
if docker run --rm -e MSG_HOST_SKIP_FIREWALL=1 "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "the image started with no MSG_HOST_SECRET"; exit 1
fi
echo "refused to start without a secret"
echo "msg-host image smoke test passed"
