#!/usr/bin/env bash
#
# PID 1 for every user's Fly Machine.
#
# The rootfs is rebuilt from the image on image rolls — and, unless the
# machine's guest config sets persist_rootfs, on EVERY stop/start. Either way
# the ONLY durable storage is the Fly Volume mounted at /data. On each boot this script:
#   1. seeds the agent home from a baked skeleton the FIRST time the volume is
#      empty, and never touches user data on any later boot (the home dir is
#      the product's retention hook — treat it as sacred);
#   2. presents that volume-backed home at the path the backend hardcodes,
#      /home/agent (DEFAULT_DEVELOPMENT_SSH_USER = 'agent');
#   3. refreshes the MACHINE-FACTS block in the agent's CLAUDE.md / AGENTS.md
#      from the FLY_* env vars, preserving all user-authored content;
#   4. keeps a stable SSH host identity on the volume across image rolls;
#   5. injects the backend's public key (AUTHORIZED_KEYS env) into both the
#      root and agent authorized_keys so ssh-client.ts can connect;
#   6. applies an nftables firewall pinning inbound SSH (:2222) to the backend
#      peer, BEFORE sshd starts (cross-tenant isolation on the shared 6PN net);
#   7. runs the agent's boot hooks (~/.boot.d/*.sh, detached, as the agent) so
#      services the agent wants back after a machine sleep restart themselves;
#   8. starts sshd in the foreground.
#
# Env vars honored (see README "machine-create contract"):
#   AUTHORIZED_KEYS  - one or more SSH public keys (newline or literal "\n"
#                      separated) authorized for root and agent. Required for
#                      the backend to connect.
#   BACKEND_PEER_IP  - the backend's WireGuard 6PN address. When set, the boot
#                      firewall accepts SSH (:2222) only from it. When unset
#                      (dev/e2e), it falls back to the machine's own /48 prefix
#                      so local/e2e machines stay reachable. See README.
#   CPU_KIND         - "performance" (dedicated cores) or "shared", as the
#                      backend built or resized this machine. Only the WORD is
#                      injected: how many cores and how much memory the machine
#                      actually has are read from the guest itself, so they
#                      cannot disagree with it. Absent (dev/e2e, or a machine
#                      the backend has not written config to since this
#                      shipped) leaves the kind off the facts line rather than
#                      guessing it.
#   PUBLIC_PORT      - the machine's public port (default 8080). The boot firewall
#                      always accepts it (ahead of the fdaa::/16 drop), so a
#                      service the agent runs on 0.0.0.0:$PUBLIC_PORT is reachable
#                      via the pre-provisioned Fly service with NO runtime expose
#                      call. Anything the agent serves there is live at the app's
#                      https://<app>.fly.dev.
#   DATA_DIR         - volume mount point. Default /data.
#   AGENT_USER       - development user. Default agent.

set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

DATA_DIR="${DATA_DIR:-/data}"
AGENT_USER="${AGENT_USER:-agent}"
AGENT_HOME="/home/${AGENT_USER}"
VOLUME_HOME="${DATA_DIR}/home/${AGENT_USER}"
HOSTKEY_DIR="${DATA_DIR}/ssh"
SENTINEL="${DATA_DIR}/.ia-initialized"
SKELETON="/opt/agent-skeleton"

# ---------------------------------------------------------------------------
# The MACHINE-FACTS block in the agent's CLAUDE.md / AGENTS.md (used by step 3
# below, defined up here so `--refresh-machine-facts` can reach it before the
# boot steps run).
#
# Both files are seeded from the skeleton on first boot and are then durable,
# user-editable content on the volume. Near the top each carries a delimited
# block:
#     <!-- MACHINE-FACTS:START -->
#     ...
#     <!-- MACHINE-FACTS:END -->
# On every boot we regenerate ONLY the lines between those markers from the
# FLY_* env vars (falling back to "unknown" when a var is absent, e.g. a local
# docker run), leaving everything the user wrote outside the markers byte-for-
# byte intact.
#
# UNCHANGED FACTS LEAVE THE FILE ALONE, and that rule is the whole reason this
# is more than a `cat >`. CLAUDE.md is the agent's instruction file: the coding
# CLI reads it on every turn, compares it against the copy it injected when the
# conversation started, and when a single byte differs it re-sends the ENTIRE
# file into the conversation as "these differ from their earlier copies".
# Ours is ~48 KB — about 12k tokens — so a boot that moved nothing but a
# timestamp used to cost every resumed conversation 12k tokens of duplicated
# instructions, permanently, in the context window the agent is measured on.
# Machines sleep after 15 idle minutes, so that was most turns. Measured on one
# real 10-turn conversation: 9 re-reads, ~108k wasted tokens, every one of them
# differing only in `Facts generated at`.
#
# So: render the block with the timestamp the file ALREADY carries, and when
# that matches what is on disk byte-for-byte, do nothing at all — no rewrite,
# no new mtime. The timestamp then reads as "when these facts last changed",
# which is the honest thing for it to say.
#
# Missing-marker policy: if the file exists but has no markers (an older
# machine, or the user deleted them) we APPEND a fresh block to the end rather
# than rewrite the file — we never corrupt or clobber user content. If the file
# does not exist at all we skip it (the user may have removed it on purpose).
#
# Never blocks boot: any failure logs a warning and continues.
# ---------------------------------------------------------------------------
FACTS_START='<!-- MACHINE-FACTS:START -->'
FACTS_END='<!-- MACHINE-FACTS:END -->'

# How much machine the agent is standing on (note #393). Agents could read
# their app, region and image but never their SIZE, and the shape is the fact
# that changes how they should work: on shared cores a sustained build is
# throttled to a crawl (measured on this fleet: 91-94% steal), and every agent
# on one read that as a bug in its own code. Memory is a wall here, not a
# slope -- these machines have no swap.
#
# Cores and memory are read from the GUEST, not from anything injected, so
# they are what the machine actually has. Only the shared/dedicated word comes
# from the backend (CPU_KIND), because the guest cannot see it: Fly throttles
# shared vCPUs on the host and /proc looks identical either way.
machine_cpu_fact() {
  local cores kind
  cores="$(nproc 2>/dev/null || true)"
  case "${cores}" in
    ''|*[!0-9]*) printf 'unknown'; return 0 ;;
  esac
  case "${CPU_KIND:-}" in
    performance) kind=' dedicated' ;;
    shared) kind=' shared' ;;
    *) kind='' ;;
  esac
  if [ "${cores}" = '1' ]; then
    printf '1%s core' "${kind}"
  else
    printf '%s%s cores' "${cores}" "${kind}"
  fi
}

# MemTotal is a little under the memory the machine was built with (firmware
# and the kernel take their cut before the agent sees any), so round to the
# shape the owner chose and was billed for -- 4 GB, not "3.8 GB" -- and fall
# back to MB below a gigabyte so a small machine still reads honestly.
machine_ram_fact() {
  awk '/^MemTotal:/ {
    mb = $2 / 1024
    if (mb >= 1024) { printf "%d GB", int(mb / 1024 + 0.5) } else { printf "%d MB", int(mb + 0.5) }
    found = 1
    exit
  } END { if (!found) printf "unknown" }' /proc/meminfo 2>/dev/null || printf 'unknown'
}

render_machine_facts() {
  # The block, markers included, stamped with the timestamp passed in ($1).
  # FLY_* are injected by Fly into the running machine; each falls back to
  # "unknown" off Fly.
  cat <<EOF
${FACTS_START}
<!-- Checked on every boot from the machine itself and rewritten only when a fact changes. Do not edit by hand — changes inside these markers are overwritten. -->
- App: ${FLY_APP_NAME:-unknown}
- Machine ID: ${FLY_MACHINE_ID:-unknown}
- Region: ${FLY_REGION:-unknown}
- CPU: $(machine_cpu_fact)
- RAM: $(machine_ram_fact)
- Private 6PN IPv6: ${FLY_PRIVATE_IP:-unknown}
- Image ref: ${FLY_IMAGE_REF:-unknown}
- Machine version: ${FLY_MACHINE_VERSION:-unknown}
- Facts generated at: $1
${FACTS_END}
EOF
}

# The block currently in $1, markers included, or nothing when it has none.
current_machine_facts() {
  awk -v s="${FACTS_START}" -v e="${FACTS_END}" '
    index($0, s) { inside=1 }
    inside { print }
    index($0, e) && inside { exit }
  ' "$1"
}

refresh_machine_facts_file() {
  local file="$1" factsfile tmp current stamp
  [ -f "${file}" ] || { log "machine-facts: ${file} absent; skipping."; return 0; }

  # Render the block to its own file. awk then reads it with getline; passing a
  # multiline value via `awk -v` is NOT portable (BSD awk and mawk both reject a
  # literal newline in a -v assignment), so we never do that.
  factsfile="$(mktemp)" \
    || { log "WARNING: machine-facts: mktemp failed for ${file}; skipping."; return 0; }

  if grep -qF "${FACTS_START}" "${file}" && grep -qF "${FACTS_END}" "${file}"; then
    # Is anything but the timestamp actually different? Re-render the block
    # with the stamp the file already carries and compare byte-for-byte; when
    # they match, this boot changed nothing and the file is left untouched.
    current="$(mktemp)" \
      || { log "WARNING: machine-facts: mktemp failed for ${file}; skipping."; rm -f "${factsfile}"; return 0; }
    current_machine_facts "${file}" > "${current}"
    stamp="$(sed -n 's/^- Facts generated at: //p' "${current}" | head -1)"
    if [ -n "${stamp}" ]; then
      render_machine_facts "${stamp}" > "${factsfile}"
      if cmp -s "${factsfile}" "${current}"; then
        log "machine-facts: ${file} already current; leaving it untouched."
        rm -f "${factsfile}" "${current}"
        return 0
      fi
    fi
    rm -f "${current}"
  fi

  render_machine_facts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${factsfile}"

  # Output temp beside the target so the final mv is an atomic same-filesystem
  # rename (the target lives on the volume).
  tmp="$(mktemp "${file}.facts.XXXXXX")" \
    || { log "WARNING: machine-facts: mktemp failed for ${file}; skipping."; rm -f "${factsfile}"; return 0; }

  if grep -qF "${FACTS_START}" "${file}" && grep -qF "${FACTS_END}" "${file}"; then
    # Replace the existing block in place: pass through everything up to the
    # START marker, splice in the freshly rendered block (which carries its own
    # markers), drop the old body, then resume after the END marker.
    if ! awk -v s="${FACTS_START}" -v e="${FACTS_END}" -v ff="${factsfile}" '
      index($0, s) { while ((getline line < ff) > 0) print line; close(ff); skip=1; next }
      index($0, e) && skip { skip=0; next }
      !skip { print }
    ' "${file}" > "${tmp}"; then
      log "WARNING: machine-facts: awk rewrite failed for ${file}; leaving it untouched."
      rm -f "${tmp}" "${factsfile}"
      return 0
    fi
  else
    # No markers: append a fresh block rather than risk clobbering user text.
    log "machine-facts: no markers in ${file}; appending a fresh block."
    if ! { cat "${file}" && printf '\n' && cat "${factsfile}"; } > "${tmp}"; then
      log "WARNING: machine-facts: append failed for ${file}; leaving it untouched."
      rm -f "${tmp}" "${factsfile}"
      return 0
    fi
  fi
  rm -f "${factsfile}"

  if mv "${tmp}" "${file}"; then
    chown "${AGENT_USER}:${AGENT_USER}" "${file}" || true
    log "machine-facts: refreshed ${file}."
  else
    log "WARNING: machine-facts: failed to install new ${file}; leaving it untouched."
    rm -f "${tmp}"
  fi
  return 0
}

# Test/debug entry point: refresh the named files' facts blocks and exit,
# without running any boot step. The unit test drives the real shell through
# this, because the alternative — asserting on a copy of the script — only
# pins what someone typed.
if [ "${1:-}" = "--refresh-machine-facts" ]; then
  shift
  for facts_file in "$@"; do
    refresh_machine_facts_file "${facts_file}"
  done
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Volume layout + first-boot home seeding.
# ---------------------------------------------------------------------------
mkdir -p "${VOLUME_HOME}" "${HOSTKEY_DIR}"

if [ ! -e "${SENTINEL}" ]; then
  log "First boot: seeding ${VOLUME_HOME} from ${SKELETON}."
  # Copy skeleton defaults WITHOUT overwriting anything a returning volume
  # might already hold (belt-and-suspenders: --ignore-existing).
  if [ -d "${SKELETON}" ]; then
    rsync -a --ignore-existing "${SKELETON}/" "${VOLUME_HOME}/"
  fi
  chown -R "${AGENT_USER}:${AGENT_USER}" "${VOLUME_HOME}"
  chmod 750 "${VOLUME_HOME}"
  # Marker lives on the volume, so it is absent only on a genuinely fresh
  # volume. Later boots (and image rolls) see it and skip seeding entirely.
  touch "${SENTINEL}"
  log "First-boot seeding complete."
else
  log "Existing volume detected; leaving user data untouched."
fi

# The home dir itself must be owned by agent so ssh/tmux work, but do NOT
# recurse (would rewrite perms on user files and is unnecessary — agent's
# uid/gid are stable across images). Cheap and idempotent.
chown "${AGENT_USER}:${AGENT_USER}" "${VOLUME_HOME}" || true

# ---------------------------------------------------------------------------
# 2. Present the volume-backed home at /home/agent.
#
# Prefer a bind mount (keeps realpath == /home/agent). Fly Machines are full
# Firecracker microVMs and allow it; fall back to a symlink where mount is not
# permitted (e.g. an unprivileged local `docker run`), which works everywhere.
# ---------------------------------------------------------------------------
present_home() {
  if mountpoint -q "${AGENT_HOME}"; then
    log "${AGENT_HOME} already bind-mounted."
    return 0
  fi
  # Already the symlink we want?
  if [ -L "${AGENT_HOME}" ] && [ "$(readlink -f "${AGENT_HOME}")" = "$(readlink -f "${VOLUME_HOME}")" ]; then
    log "${AGENT_HOME} already symlinked to volume."
    return 0
  fi
  mkdir -p "${AGENT_HOME}"
  if mount --bind "${VOLUME_HOME}" "${AGENT_HOME}" 2>/dev/null; then
    log "Bind-mounted ${VOLUME_HOME} -> ${AGENT_HOME}."
    return 0
  fi
  log "Bind mount unavailable; falling back to symlink."
  # The baked ${AGENT_HOME} only ever holds /etc/skel defaults from useradd -m,
  # so removing it loses no user data.
  rm -rf "${AGENT_HOME}"
  ln -s "${VOLUME_HOME}" "${AGENT_HOME}"
}
present_home

# ---------------------------------------------------------------------------
# 3. Refresh the MACHINE-FACTS block in the agent's CLAUDE.md / AGENTS.md.
#    (Rules and rationale are with the functions near the top of this file.)
# ---------------------------------------------------------------------------
refresh_machine_facts_file "${AGENT_HOME}/CLAUDE.md"
refresh_machine_facts_file "${AGENT_HOME}/AGENTS.md"

# ---------------------------------------------------------------------------
# 4. Stable SSH host identity on the volume.
# ---------------------------------------------------------------------------
if [ ! -f "${HOSTKEY_DIR}/ssh_host_ed25519_key" ]; then
  log "Generating persistent SSH host keys on the volume."
  ssh-keygen -q -t ed25519 -N '' -f "${HOSTKEY_DIR}/ssh_host_ed25519_key"
fi
if [ ! -f "${HOSTKEY_DIR}/ssh_host_rsa_key" ]; then
  ssh-keygen -q -t rsa -b 4096 -N '' -f "${HOSTKEY_DIR}/ssh_host_rsa_key"
fi
chmod 600 "${HOSTKEY_DIR}"/ssh_host_*_key
chmod 644 "${HOSTKEY_DIR}"/ssh_host_*_key.pub

# ---------------------------------------------------------------------------
# 5. Inject the backend's public key into root + agent authorized_keys.
#    Overwrites only authorized_keys (idempotent, supports key rotation); no
#    other user data is touched.
# ---------------------------------------------------------------------------
write_authorized_keys() {
  local user="$1" home="$2" keys="$3"
  install -d -m 700 -o "${user}" -g "${user}" "${home}/.ssh"
  # Normalize a literal "\n" separator (env vars can't carry real newlines
  # everywhere) into actual newlines.
  printf '%b\n' "${keys}" | sed '/^$/d' > "${home}/.ssh/authorized_keys"
  chmod 600 "${home}/.ssh/authorized_keys"
  chown "${user}:${user}" "${home}/.ssh/authorized_keys"
}

if [ -n "${AUTHORIZED_KEYS:-}" ]; then
  log "Installing AUTHORIZED_KEYS for root and ${AGENT_USER}."
  write_authorized_keys root /root "${AUTHORIZED_KEYS}"
  write_authorized_keys "${AGENT_USER}" "${AGENT_HOME}" "${AUTHORIZED_KEYS}"
else
  log "WARNING: AUTHORIZED_KEYS is empty; the backend will not be able to connect."
fi

# ---------------------------------------------------------------------------
# 6. tmux runtime dir for the agent user (matches ssh-client.ts expectations:
#    /tmp/tmux-<uid>, mode 700, owned by the user).
# ---------------------------------------------------------------------------
agent_uid="$(id -u "${AGENT_USER}")"
install -d -m 700 -o "${AGENT_USER}" -g "${AGENT_USER}" "/tmp/tmux-${agent_uid}"
install -d -m 700 -o root -g root "/tmp/tmux-0"

# ---------------------------------------------------------------------------
# 7. Firewall: pin inbound SSH (:2222) to the backend peer, applied BEFORE sshd
#    starts. All machines share the Fly org's DEFAULT 6PN network and users run
#    arbitrary code, so without this any machine could reach any other machine's
#    sshd. The ruleset (nftables, ip6 table `fly_fw`, input hook, policy accept):
#      - accept loopback;
#      - accept established/related (so our own outbound replies come back);
#      - accept ALL ICMPv6 (6PN neighbor discovery is load-bearing — dropping it
#        breaks connectivity);
#      - accept TCP :2222 from BACKEND_PEER_IP when set, else from the machine's
#        own /48 (derived from its fdaa address) so dev/e2e stays reachable;
#      - accept the public port (PUBLIC_PORT, default 8080) from anywhere, so the
#        pre-provisioned Fly service reaches a server the agent runs on it;
#      - re-accept any ports the user later exposed via expose_port;
#      - drop everything else sourced from fdaa::/16 (other tenants);
#      - policy accept leaves outbound untouched (users need full egress) and
#        does not pre-empt future fly-proxy public exposure: a later expose_port
#        tool inserts its per-port accepts ahead of the fdaa drop.
#
#    Degrades gracefully: on a host with no fdaa (6PN) address — a local
#    `docker run` or the smoke test — it logs and skips, so the image still
#    boots and is reachable over the published port.
# ---------------------------------------------------------------------------
apply_machine_firewall() {
  # The machine's own 6PN address is a global fdaa:… address on its interface.
  # It is only needed for the /48-fallback rule below: with an explicit
  # BACKEND_PEER_IP the ruleset never references it, so don't wait for it —
  # on production machines the address showed up tentative (IPv6 DAD) for the
  # WHOLE poll window, and this loop burned its full 10s on every boot, which
  # was most of the wake-on-traffic latency. Without a peer (dev/e2e), poll
  # briefly instead of sampling once — a single early sample made a real Fly
  # machine take the local/docker skip path and boot with no firewall at all.
  local own6 allowed prefix i
  own6=""
  for i in 1 2 3 4 5 6 7 8 9 10; do
    own6="$(ip -6 -o addr show scope global 2>/dev/null \
              | awk '{print $4}' | cut -d/ -f1 \
              | grep -iE '^fdaa:' | head -n1 || true)"
    [ -n "${own6}" ] && break
    [ -n "${BACKEND_PEER_IP:-}" ] && break
    sleep 1
  done

  # With an explicit backend peer the ruleset doesn't depend on the machine's
  # own address, so a detection miss must not skip the firewall.
  if [ -z "${own6}" ] && [ -z "${BACKEND_PEER_IP:-}" ]; then
    log "No fdaa (6PN) address present; skipping machine firewall (local/docker run)."
    return 0
  fi

  if [ -n "${BACKEND_PEER_IP:-}" ]; then
    allowed="${BACKEND_PEER_IP}"
    log "Firewall: pinning SSH :2222 ingress to BACKEND_PEER_IP ${allowed}."
  else
    # Fall back to the machine's own /48 (first three hextets of its fdaa
    # address). Keeps dev/e2e machines reachable from same-network peers when no
    # explicit backend peer is injected.
    prefix="$(printf '%s' "${own6}" | awk -F: '{ printf "%s:%s:%s::/48", $1, $2, $3 }')"
    allowed="${prefix}"
    log "Firewall: BACKEND_PEER_IP unset; falling back to own /48 ${allowed}."
  fi

  if ! command -v nft >/dev/null 2>&1; then
    log "WARNING: nft not found; cannot apply machine firewall."
    return 0
  fi

  # Re-open any publicly exposed ports. `expose_port` persists them (one per
  # line) to ${DATA_DIR}/exposed-ports on the volume; a runtime nft rule is lost
  # on reboot, so we rebuild each accept here. fly-proxy forwards public traffic
  # to the machine over 6PN (fdaa space), so these accepts MUST sit ahead of the
  # `fdaa::/16 drop` below or the exposed inbound would be dropped. Absent file =
  # no exposed ports (the common case) and this stays empty.
  # The public port is always accepted (ahead of the fdaa drop) so a service on
  # 0.0.0.0:${PUBLIC_PORT} is reachable via the pre-provisioned Fly service with
  # no runtime expose call. Digits only; defaults to 8080; never the SSH ports.
  local public_port public_accept
  public_port="$(printf '%s' "${PUBLIC_PORT:-8080}" | tr -cd '0-9')"
  [ -n "${public_port}" ] || public_port="8080"
  public_accept=""
  if [ "${public_port}" != "22" ] && [ "${public_port}" != "2222" ]; then
    public_accept="    tcp dport ${public_port} accept
"
    log "Firewall: accepting public port ${public_port} by default (PUBLIC_PORT)."
  fi

  local exposed_accepts port
  exposed_accepts=""
  if [ -f "${DATA_DIR}/exposed-ports" ]; then
    while IFS= read -r port || [ -n "${port}" ]; do
      # Keep only digits; skip blanks and the machine's own SSH ports.
      port="$(printf '%s' "${port}" | tr -cd '0-9')"
      [ -n "${port}" ] || continue
      [ "${port}" = "22" ] && continue
      [ "${port}" = "2222" ] && continue
      # The public port is already accepted above; don't emit a duplicate rule.
      [ "${port}" = "${public_port}" ] && continue
      exposed_accepts="${exposed_accepts}    tcp dport ${port} accept
"
      log "Firewall: re-opening exposed port ${port} from ${DATA_DIR}/exposed-ports."
    done < "${DATA_DIR}/exposed-ports"
  fi

  # `add table; delete table; table {…}` is the idempotent atomic-reload idiom:
  # add makes delete safe when the table is absent; delete clears any prior
  # ruleset; the block then defines a fresh one. Safe to run on every boot.
  # ${exposed_accepts} expands to zero or more accept lines just above the drop.
  if nft -f - <<EOF
add table ip6 fly_fw
delete table ip6 fly_fw
table ip6 fly_fw {
  chain input {
    type filter hook input priority 0; policy accept;
    iif "lo" accept
    ct state established,related accept
    meta l4proto ipv6-icmp accept
    tcp dport 2222 ip6 saddr ${allowed} accept
${public_accept}${exposed_accepts}    ip6 saddr fdaa::/16 drop
  }
}
EOF
  then
    log "Firewall applied: SSH :2222 from ${allowed}; other fdaa::/16 inbound dropped."
  else
    # A microVM PID 1 on Fly has the capability to load nft; failure here is
    # unexpected. Do NOT block boot — log loudly so it is visible.
    log "WARNING: failed to apply nftables firewall; continuing without it."
  fi
}
apply_machine_firewall

# ---------------------------------------------------------------------------
# 7b. Docker comes back only when a container asked to (note #1167).
#
# Docker is baked into the image but its daemon is NOT started at boot: it
# costs ~135 MB of memory (dockerd + containerd, measured 12 Nov 2026), and
# most agents never use it. The first `docker` command starts it
# (/usr/local/sbin/agentbuilt-dockerd, data in ${DATA_DIR}/docker).
#
# A sleep is a power cut for Docker: the daemon and every container die with
# the machine. So on boot, if any container on the volume carries a restart
# policy that Docker itself honours at daemon start — `always`, or
# `unless-stopped` that nobody stopped by hand — start the daemon now, and
# Docker brings those containers back on its own. That is Docker's analogue
# of ~/.boot.d, and it is what `restart: unless-stopped` in a compose file
# already means on any laptop. A container without a policy stays down, as it
# would after any reboot.
#
# The rootfs persists across a stop/start (rootfs persist: restart), so the
# previous boot's pid file, socket and exec-root are still in /run: nothing of
# Docker's is running yet, so they are stale by definition. Clear them, or a
# reused pid in docker.pid makes dockerd refuse to start.
#
# Detached and never waited on: sshd must not start later because a pull is
# slow. Any failure only shows in /var/log/agentbuilt-dockerd.log.
# ---------------------------------------------------------------------------
start_docker_if_asked() {
  # The overrides exist for the unit test (fly-machine-image-entrypoint
  # .test.ts), which runs this function against a scratch directory.
  local root="${DATA_DIR}/docker" dir policy
  local run="${DOCKER_RUN_DIR:-/var/run}"
  local starter="${DOCKERD_STARTER:-/usr/local/sbin/agentbuilt-dockerd}"
  # Nothing reaches this machine before this step in production (sshd starts
  # after it), but a `fly machine exec` can: a daemon already running owns
  # those files, and clearing them would orphan it. Measured on the n1167
  # probe machine, 12 Nov 2026.
  if pgrep -x "${DOCKERD_PROCESS:-dockerd}" >/dev/null 2>&1; then
    log "docker: already running; leaving it be."
    return 0
  fi
  rm -rf "${run}/docker.pid" "${run}/docker.sock" "${run}/docker" \
    "${run}/agentbuilt-dockerd.lock" 2>/dev/null || true
  [ -x "${starter}" ] || return 0
  [ -d "${root}/containers" ] || return 0
  for dir in "${root}"/containers/*/; do
    [ -f "${dir}hostconfig.json" ] || continue
    policy="$(jq -r '.RestartPolicy.Name // ""' "${dir}hostconfig.json" 2>/dev/null || true)"
    case "${policy}" in
      always) ;;
      unless-stopped)
        [ "$(jq -r '.HasBeenManuallyStopped // false' "${dir}config.v2.json" 2>/dev/null || true)" = "true" ] \
          && continue
        ;;
      *) continue ;;
    esac
    log "docker: container $(basename "${dir}" | cut -c1-12) restarts ${policy}; starting Docker."
    setsid -f "${starter}" >/dev/null 2>&1 </dev/null || true
    return 0
  done
  log "docker: no container asks to come back; Docker starts on first use."
}
start_docker_if_asked

# ---------------------------------------------------------------------------
# 8. Agent boot hooks: every ~/.boot.d/*.sh runs (as the agent) on each boot.
#
# The idle reaper stops machines when their user goes idle, and anything the
# agent left running (a preview site on :8080, a tmux session, a watcher)
# dies with the machine. Boot hooks are the comeback mechanism: the agent
# drops a start script into ~/.boot.d/ and its services return on every wake
# — without turning the machine into always-on hosting. Hooks live in the
# volume-backed home, so they also survive image rolls. Each hook is launched
# detached as the agent user AFTER the firewall is applied; output collects
# in ~/.boot.d/boot.log (truncated each boot). A broken hook must never block
# boot — failures only show in the log.
# ---------------------------------------------------------------------------
run_agent_boot_hooks() {
  local hooks_dir="${AGENT_HOME}/.boot.d"
  [ -d "${hooks_dir}" ] || return 0
  local boot_log="${hooks_dir}/boot.log"
  : > "${boot_log}" 2>/dev/null || true
  chown "${AGENT_USER}:${AGENT_USER}" "${boot_log}" 2>/dev/null || true
  local hook
  for hook in "${hooks_dir}"/*.sh; do
    [ -f "${hook}" ] || continue
    log "boot.d: launching ${hook}"
    printf '[boot.d] launching %s\n' "${hook}" >> "${boot_log}" 2>/dev/null || true
    setsid runuser -u "${AGENT_USER}" -- bash "${hook}" \
      >> "${boot_log}" 2>&1 < /dev/null &
  done
}
run_agent_boot_hooks

# ---------------------------------------------------------------------------
# 9. Start sshd in the foreground.
# ---------------------------------------------------------------------------
mkdir -p /run/sshd
# Validate config early so a broken image fails loudly instead of silently.
/usr/sbin/sshd -t
log "Starting sshd."
exec /usr/sbin/sshd -D -e
