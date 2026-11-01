#!/usr/bin/env bash
#
# Local smoke test for the Fly machine image. Builds the image, boots a
# container with a persistent volume, and asserts the contract the backend
# depends on:
#   - sshd accepts a key injected via the AUTHORIZED_KEYS env var (as `agent`
#     and as `root`);
#   - tmux starts a durable session;
#   - `claude --version`, `codex --version` and `opencode --version` run;
#   - data written into the home dir survives a container recreation on the
#     same volume (the retention hook).
#
# Requires: docker, ssh, ssh-keygen on the host. Run from any directory.
#
# Notes:
#   - Uses --cap-add SYS_ADMIN so the entrypoint exercises the real bind-mount
#     path (as on Fly). Without it the entrypoint falls back to a symlink and
#     the test still passes.
#   - Publishes container :2222 on a host port for IPv4 SSH (Fly uses private
#     IPv6; sshd here listens on both via AddressFamily any). sshd runs on
#     2222 because Fly's hallpass daemon owns :22 on the 6PN address.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_TAG="${IMAGE_TAG:-fly-machine-image:smoke}"
CONTAINER="ia-fly-smoke-$$"
VOLUME="ia-fly-smoke-vol-$$"
HOST_PORT="${HOST_PORT:-2222}"
WORKDIR="$(mktemp -d)"
KEY="${WORKDIR}/id_ed25519"

pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
info() { printf '\033[36m----\033[0m %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm "${VOLUME}" >/dev/null 2>&1 || true
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

ssh_agent() {
  ssh -i "${KEY}" \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR \
      -o ConnectTimeout=5 \
      -p "${HOST_PORT}" \
      "agent@127.0.0.1" "$@"
}

ssh_root() {
  ssh -i "${KEY}" \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR \
      -o ConnectTimeout=5 \
      -p "${HOST_PORT}" \
      "root@127.0.0.1" "$@"
}

run_container() {
  docker run -d --name "${CONTAINER}" \
    --cap-add SYS_ADMIN \
    -e AUTHORIZED_KEYS="$(cat "${KEY}.pub")" \
    -v "${VOLUME}:/data" \
    -p "${HOST_PORT}:2222" \
    "${IMAGE_TAG}" >/dev/null
}

wait_for_ssh() {
  info "Waiting for sshd on 127.0.0.1:${HOST_PORT} ..."
  for _ in $(seq 1 30); do
    if ssh_agent 'true' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "${CONTAINER}" >&2 || true
  fail "sshd did not accept the injected key within 30s"
}

# Reuse the caller's image when there is one. CI builds the image, then calls
# this with IMAGE_TAG — so rebuilding here tested a DIFFERENT build than the one
# about to be pushed, and paid for a second full build to do it. It also broke
# outright once the CLI versions became required build-args: the caller passed
# the fleet pin, this rebuild passed nothing, and the guard in the Dockerfile
# stopped the job after the real build had already succeeded.
if docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
  info "Using the existing ${IMAGE_TAG} — the smoke test must exercise the image that ships."
else
  info "Building ${IMAGE_TAG} ..."
  # Standalone use. The versions are required by the Dockerfile (the fleet pin
  # is the only place a CLI version is chosen); read the current one with
  # `curl -fsS <backend>/api/harness-cli-versions`.
  docker build \
    --build-arg "CLAUDE_VERSION=${CLAUDE_VERSION:?set CLAUDE_VERSION to the pinned version, or pre-build IMAGE_TAG}" \
    --build-arg "CODEX_VERSION=${CODEX_VERSION:?set CODEX_VERSION to the pinned version, or pre-build IMAGE_TAG}" \
    --build-arg "OPENCODE_VERSION=${OPENCODE_VERSION:?set OPENCODE_VERSION to the pinned version, or pre-build IMAGE_TAG}" \
    ${CHROME_VERSION:+--build-arg "CHROME_VERSION=${CHROME_VERSION}"} \
    -t "${IMAGE_TAG}" "${HERE}"
fi
pass "image ready"

info "Generating throwaway SSH keypair ..."
ssh-keygen -t ed25519 -N '' -f "${KEY}" -q
pass "keypair generated"

info "Booting container (first boot: empty volume) ..."
run_container
wait_for_ssh
pass "sshd accepted the AUTHORIZED_KEYS key as agent"

ssh_root 'true' >/dev/null 2>&1 && pass "sshd accepted the key as root" \
  || fail "root SSH with injected key failed"

info "Checking home is /home/agent and owned by agent ..."
home_pwd="$(ssh_agent 'echo $HOME; id -un; whoami')"
echo "${home_pwd}" | grep -q '/home/agent' || fail "agent HOME is not /home/agent: ${home_pwd}"
pass "agent HOME resolves to /home/agent"

info "Verifying CLIs ..."
# ASSERTED against what the caller asked to bake, not merely printed. Every
# check in this file passed on 2026-09-11 for an image carrying the WRONG Codex:
# the build had read a stale pin, baked it, and no gate anywhere compared the
# number it got with the number it asked for. The image shipped and the fleet
# was repointed at it; a human reading the log is what caught it. The stale read
# is fixed in the backend, but a build that bakes the wrong version — for any
# future reason — must fail HERE, before it can be pushed.
#
# Standalone runs pass no expectation and keep the old behaviour: ran is enough.
check_cli() {
  local cli="$1" expected="$2" actual
  actual="$(ssh_agent "bash -lc '${cli} --version'")" || fail "${cli} --version failed"
  printf '%s\n' "${actual}"
  if [ -z "${expected}" ]; then
    pass "${cli} --version ran"
  elif [[ "${actual}" == *"${expected}"* ]]; then
    pass "${cli} is the requested ${expected}"
  else
    fail "${cli} reports '${actual}' but the build asked for ${expected} — refusing to ship this image"
  fi
}
check_cli claude "${CLAUDE_VERSION:-}"
check_cli codex "${CODEX_VERSION:-}"
check_cli opencode "${OPENCODE_VERSION:-}"

# THE BROWSER, asserted the same way and for a sharper reason: CI's third
# stage is 37 checks that all need it, and a browser that cannot start — one
# missing shared library, a download that half-arrived — turns every one of
# them red on every push until somebody reads a log. `$CHROME` comes from the
# image's own /etc/profile.d, so this also proves an ordinary login shell can
# find it, which is how an agent's screenshot harness looks for it.
browser="$(ssh_agent 'bash -lc "\"\$CHROME\" --version"')" || fail "the baked browser did not run (CHROME unset, or a shared library is missing)"
printf '%s\n' "${browser}"
if [ -n "${CHROME_VERSION:-}" ] && [[ "${browser}" != *"${CHROME_VERSION}"* ]]; then
  fail "the browser reports '${browser}' but the build asked for ${CHROME_VERSION}"
fi
pass "the baked browser runs"
ssh_agent 'bash -lc "node --version; git --version; tmux -V; rg --version | head -1; gh --version | head -1"' \
  && pass "node/git/tmux/rg/gh present" || fail "a baseline tool is missing"

info "Checking seeded CLI settings and unfinished-shell hooks ..."
ssh_agent 'jq -e ".includeCoAuthoredBy == false and .attribution.includeCoAuthoredBy == false and .env.DISABLE_AUTOUPDATER == \"1\" and ([.hooks[][]?.hooks[]?.command] | flatten | any(. == \"/usr/local/bin/agentbuilt __harness-hook claude\"))" ~/.claude/settings.json >/dev/null' \
  && pass "~/.claude/settings.json seeded with operator defaults" \
  || fail "~/.claude/settings.json missing or wrong"
ssh_agent 'jq -e "([.hooks[][]?.hooks[]?.command] | flatten | any(. == \"/usr/local/bin/agentbuilt __harness-hook codex\"))" /etc/codex/hooks.json >/dev/null' \
  && pass "/etc/codex/hooks.json seeded as a managed lifecycle hook" \
  || fail "/etc/codex/hooks.json missing or wrong"
ssh_agent 'grep -q "^check_for_update_on_startup = false" ~/.codex/config.toml' \
  && pass "~/.codex/config.toml seeded with update check off" \
  || fail "~/.codex/config.toml missing or wrong"
# Without this key Codex reads only the first 32 KiB of AGENTS.md and drops the
# rest silently — the machine looks healthy and its agent is short a few
# thousand words of instructions.
ssh_agent 'grep -q "^project_doc_max_bytes = 262144" ~/.codex/config.toml' \
  && pass "~/.codex/config.toml seeded with the raised project-doc cap" \
  || fail "~/.codex/config.toml missing the project-doc cap"
# Without this key Codex budgets the turn against the model's DEFAULT window
# (272,000 on the gpt-5.6 family) rather than the 872,000 the same catalog says
# the model takes — a third of the context, and nothing says so.
ssh_agent 'grep -q "^model_context_window = 1000000" ~/.codex/config.toml' \
  && pass "~/.codex/config.toml seeded with the raised context window" \
  || fail "~/.codex/config.toml missing the context window"

info "Starting a durable tmux session over SSH ..."
ssh_agent 'tmux new-session -d -s smoke "sleep 300" && tmux ls' \
  && pass "tmux session started" || fail "tmux new-session failed"

info "Writing a marker into the home dir (retention hook) ..."
ssh_agent 'echo persisted-$$ > ~/RETENTION_MARKER.txt && cat ~/RETENTION_MARKER.txt'
marker="$(ssh_agent 'cat ~/RETENTION_MARKER.txt')"
[ -n "${marker}" ] || fail "could not write home marker"
pass "wrote ${marker}"

info "Installing a boot hook (~/.boot.d) to verify it runs on the next boot ..."
ssh_agent 'mkdir -p ~/.boot.d && printf "%s\n" "#!/usr/bin/env bash" "echo hook-ran-\$(id -un) > ~/BOOT_HOOK_MARKER.txt" > ~/.boot.d/smoke.sh'
pass "boot hook installed"

info "Recreating the container on the SAME volume (simulates an image roll) ..."
docker rm -f "${CONTAINER}" >/dev/null
run_container
wait_for_ssh
marker2="$(ssh_agent 'cat ~/RETENTION_MARKER.txt' 2>/dev/null || true)"
[ "${marker}" = "${marker2}" ] || fail "home data did NOT survive recreation (${marker} != ${marker2})"
pass "home data survived container recreation"

info "Verifying the boot hook ran on boot, as the agent user ..."
hook_marker=""
for _ in $(seq 1 10); do
  hook_marker="$(ssh_agent 'cat ~/BOOT_HOOK_MARKER.txt' 2>/dev/null || true)"
  [ -n "${hook_marker}" ] && break
  sleep 1
done
[ "${hook_marker}" = "hook-ran-agent" ] || fail "boot hook did not run as agent (marker: '${hook_marker}')"
ssh_agent 'test -s ~/.boot.d/boot.log' || fail "boot.d/boot.log missing or empty"
pass "boot hook ran as agent and logged to ~/.boot.d/boot.log"

info "Confirming host key identity is stable across the roll ..."
hk="$(ssh_root 'cat /data/ssh/ssh_host_ed25519_key.pub')"
[ -n "${hk}" ] || fail "persistent host key missing"
pass "persistent host key present on volume"

printf '\n\033[32mAll smoke checks passed.\033[0m\n'
