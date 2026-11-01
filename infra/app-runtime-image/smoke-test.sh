#!/usr/bin/env bash
#
# Build the app-runtime image and boot it twice locally — once per serve mode —
# asserting the workload actually answers on :8080. Mirrors the agent image's
# smoke test idiom: a throwaway host dir stands in for the Fly Volume.
#
#   ./smoke-test.sh            # uses `docker`; needs the daemon running

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMG="ia-app-runtime:smoke"
NAME="ia-app-runtime-smoke"

log() { printf '[smoke] %s\n' "$*" >&2; }
cleanup() {
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  [ -n "${VOL:-}" ] && rm -rf "${VOL}"
}
trap cleanup EXIT

log "Building image…"
docker build -q -t "${IMG}" "${HERE}" >/dev/null

# --- late first deploy -----------------------------------------------------
# A fresh machine boots EMPTY and the first sync arrives later; the
# supervisor must pick it up without a restart (E2E lesson, 2026-08-04).
VOL="$(mktemp -d)"
log "Booting (empty volume)…"
docker run -d --name "${NAME}" \
  -v "${VOL}:/data" -p 127.0.0.1:18080:8080 \
  -e AUTHORIZED_KEYS="ssh-ed25519 AAAA smoke@test" \
  "${IMG}" >/dev/null
sleep 4
mkdir -p "${VOL}/site"
echo '<h1>smoke-late-ok</h1>' > "${VOL}/site/index.html"
for i in $(seq 1 15); do
  body="$(curl -fsS -m 2 http://127.0.0.1:18080/ 2>/dev/null || true)"
  [ -n "${body}" ] && break
  sleep 1
done
echo "${body}" | grep -q 'smoke-late-ok' || { log "FAIL: supervisor never noticed the late first deploy"; docker logs "${NAME}" >&2; exit 1; }
log "late-first-deploy OK"
docker rm -f "${NAME}" >/dev/null
rm -rf "${VOL}"

# --- static mode -----------------------------------------------------------
VOL="$(mktemp -d)"
mkdir -p "${VOL}/site"
echo '<h1>smoke-static-ok</h1>' > "${VOL}/site/index.html"

log "Booting (static mode)…"
docker run -d --name "${NAME}" \
  -v "${VOL}:/data" -p 127.0.0.1:18080:8080 \
  -e AUTHORIZED_KEYS="ssh-ed25519 AAAA smoke@test" \
  "${IMG}" >/dev/null

for i in $(seq 1 20); do
  body="$(curl -fsS -m 2 http://127.0.0.1:18080/ 2>/dev/null || true)"
  [ -n "${body}" ] && break
  sleep 1
done
echo "${body}" | grep -q 'smoke-static-ok' || { log "FAIL: static mode never served"; docker logs "${NAME}" >&2; exit 1; }
log "static mode OK"

# Restart hook: kill the pid on the volume, expect the loop to respawn.
docker exec "${NAME}" bash -c 'kill "$(cat /data/app.pid)"'
sleep 4
curl -fsS -m 2 http://127.0.0.1:18080/ | grep -q 'smoke-static-ok' \
  || { log "FAIL: supervisor did not respawn after kill"; exit 1; }
log "restart-loop OK"

docker rm -f "${NAME}" >/dev/null
rm -rf "${VOL}"

# --- service mode ----------------------------------------------------------
VOL="$(mktemp -d)"
mkdir -p "${VOL}/app"
cat > "${VOL}/app/run.sh" <<'EOF'
#!/usr/bin/env bash
exec node -e '
  require("http").createServer((_, res) => res.end("smoke-service-ok"))
    .listen(process.env.PORT || 8080, "0.0.0.0");
'
EOF
chmod +x "${VOL}/app/run.sh"

log "Booting (service mode)…"
docker run -d --name "${NAME}" \
  -v "${VOL}:/data" -p 127.0.0.1:18080:8080 \
  -e AUTHORIZED_KEYS="ssh-ed25519 AAAA smoke@test" \
  "${IMG}" >/dev/null

for i in $(seq 1 20); do
  body="$(curl -fsS -m 2 http://127.0.0.1:18080/ 2>/dev/null || true)"
  [ -n "${body}" ] && break
  sleep 1
done
echo "${body}" | grep -q 'smoke-service-ok' || { log "FAIL: service mode never served"; docker logs "${NAME}" >&2; exit 1; }
log "service mode OK"

log "PASS"
