# Fly machine image

The baked OCI image every user's Fly Machine boots from. It replaces the
runtime bootstrap in `backend/src/services/server-bootstrap.ts`: instead of
SSHing into a fresh Ubuntu VM and running ~2 minutes of `apt-get` + `npm
install -g`, machines boot from this image with everything already installed,
so **machine creation takes seconds** and a **fleet-wide CLI upgrade is just
"roll a new image"**.

This directory is image work only. The backend integration (`FlySandboxClient`)
is a later step; the [machine-create contract](#step-5-machine-create-contract)
at the end says exactly what that step must pass.

> The image is **one of three channels** that change a running machine, and the
> only one that owns the rootfs. Before putting something here, check
> [how a change reaches an agent's machine](../../docs/machine-update-channels.md)
> — anything in the agent's HOME or the CLI version has a different owner, and
> the image reaches no machine that already exists until it is rolled.

## What's inside

Base: `ubuntu:24.04` (matches the current Hetzner `ubuntu-24.04` sandbox image).

| Component | Detail | Why |
|---|---|---|
| `openssh-server` | key-only, IPv6-reachable (see [SSH](#ssh-contract)) | the whole executor path is SSH + tmux |
| `tmux` | default distro build | executor drives long-lived tmux sessions |
| Node.js | **LTS, pinned via `NODE_MAJOR` build arg (default 22)** from NodeSource | the CLIs need a modern Node; Ubuntu's `nodejs` is too old |
| `@anthropic-ai/claude-code` | global npm install (`claude`) | the Claude harness CLI |
| `@openai/codex` | global npm install (`codex`) | the Codex harness CLI |
| `git`, `gh` | `gh` from GitHub's apt repo | repo work + the funnel's GitHub flows |
| `curl`, `unzip`, `jq`, `ripgrep` (`rg`) | | baseline tooling the harness/prompts assume |
| `build-essential`, `python3`, `make`, `g++` | | native module builds |
| `rsync`, `sudo`, `locales` (en_US.UTF-8) | | first-boot seeding, agent self-serve apt, UTF-8 TUIs |
| Docker | Ubuntu's `docker.io` (29) + `docker-compose-v2` + `docker-buildx`, **not started at boot** — see [Docker](#docker-note-1167) | agents bring their project's stack up with `docker compose`, and CI runs the same image |
| Chrome | **pinned via `CHROME_VERSION`**, under `/opt/puppeteer` (root's `~/.cache/puppeteer` links to it, `$CHROME`/`$CHROME_PATH` name it for everyone else), plus its shared libraries and `fonts-liberation` | CI's browser stage is 37 checks that all need it, and it was downloading ~500 MB per run; agents taking screenshots get the libraries that used to vanish on every image roll |

### Parity with `server-bootstrap.ts`

Everything the current bootstrap does is covered by the image, so the bootstrap
becomes unnecessary:

| Bootstrap step | Covered by |
|---|---|
| `apt-get install ... ca-certificates curl unzip jq ripgrep git gh tmux nodejs npm build-essential python3 make g++` | apt layer (Node/npm upgraded to pinned LTS; `gh` via official repo) |
| `useradd -m -s /bin/bash agent` | baked `useradd -m -s /bin/bash agent` |
| copy root's `authorized_keys` to `/home/agent/.ssh` | entrypoint writes `AUTHORIZED_KEYS` to **both** root and agent |
| pre-create `/tmp/tmux-$(id -u agent)` mode 700 | entrypoint creates it for agent (and root) every boot |
| `npm install -g @openai/codex` | baked global install |
| `npm install -g @anthropic-ai/claude-code` | baked global install |
| version-marker echoes for prep detection | not needed — versions are known at build; `claude --version` / `codex --version` still work over SSH |

Two intentional additions beyond the bootstrap: **passwordless `sudo` for
`agent`** (so a single dev user can self-serve `apt-get` installs instead of a
second root SSH round-trip) and **persistent SSH host keys** (below).

## Volume / first-boot contract

**The rootfs is ephemeral and is wiped on every image roll. The only durable
storage is the Fly Volume.** Nothing stateful may live outside it.

- The volume is mounted at **`/data`** (override with `DATA_DIR`).
- The agent home lives on the volume at **`/data/home/agent`** and is presented
  at **`/home/agent`** — the path the backend hardcodes
  (`DEFAULT_DEVELOPMENT_SSH_USER = 'agent'`,
  `getDefaultDevelopmentRootForSshUser('agent') === '/home/agent'`). The
  entrypoint **bind-mounts** `/data/home/agent` → `/home/agent` (falling back to
  a symlink where bind mount isn't permitted, e.g. an unprivileged local
  `docker run`).
- Persistent SSH host keys live at **`/data/ssh/`** so the machine's SSH
  identity is **stable across image rolls and reboots** (they are not
  regenerated when the rootfs resets).

On every boot the entrypoint:

1. **First boot only** (no `/data/.ia-initialized` sentinel): seeds
   `/data/home/agent` from the baked skeleton (`/opt/agent-skeleton`, source in
   [`skel/`](./skel)) with `rsync --ignore-existing`, `chown`s it to `agent`,
   and writes the sentinel. **Later boots skip seeding entirely and never touch
   user data** — the home dir is the product's retention hook, treated as
   sacred.
2. Ensures the home is presented at `/home/agent` (idempotent; no-op if already
   mounted/linked).
3. **Refreshes the machine-facts block** in `/home/agent/CLAUDE.md` and
   `/home/agent/AGENTS.md` from the `FLY_*` env vars — see
   [Agent instruction files](#agent-instruction-files-claudemd--agentsmd).
4. Generates host keys on the volume if missing.
5. Writes `AUTHORIZED_KEYS` into root's and agent's `authorized_keys`
   (overwrites only that file — supports key rotation, touches nothing else).
6. Creates the tmux runtime dirs and starts `sshd -D`.

Idempotency: steps 2–6 run every boot and are safe to repeat; step 1 runs once
per volume lifetime.

## Agent instruction files (`CLAUDE.md` + `AGENTS.md`)

The skeleton seeds two identical instruction files into the agent home so the
coding CLIs know where they are running and what survives a restart:
**`CLAUDE.md`** (read by Claude Code) and **`AGENTS.md`** (read by Codex).
They carry the same content — two files only because the CLIs read
different filenames.

What ships here is a **stub**, not the docs an agent ends up reading. The
backend's identity pass (`writeTelegramAgentIdentity` in
`agent-service.ts`) replaces everything below the machine-facts block
with the current platform docs — at agent creation, and again on any machine
whose stored `identityVersion` is behind `TELEGRAM_AGENT_IDENTITY_VERSION`. That
pass **creates both files itself when they are missing**, machine-facts markers
included, so it does not depend on this seed at all. The seed exists for the
window before the first write lands: it gives `entrypoint.sh` a file to stamp
real machine facts into on first boot, and it carries the few physics an agent
would need if that write were delayed.

**So anything that can change goes in the platform docs, not here.** The docs
reach machines that already exist; the skeleton reaches new volumes only.

Near the top each file carries a delimited **machine-facts block**:

```
<!-- MACHINE-FACTS:START -->
... regenerated every boot ...
<!-- MACHINE-FACTS:END -->
```

**Boot contract (entrypoint step 3):** on every boot the entrypoint rewrites
**only** the lines between `MACHINE-FACTS:START` and `MACHINE-FACTS:END`,
leaving everything outside the markers byte-for-byte intact — so the agent's own
edits (including anything it adds below the block) always survive. And it
rewrites them **only when a fact actually changed** (see below). The block is
regenerated from these Fly-injected env vars, each falling back to `unknown`
when absent (e.g. a local `docker run` with no `FLY_*`):

| Field in the block | Source env var |
|---|---|
| App | `FLY_APP_NAME` |
| Machine ID | `FLY_MACHINE_ID` |
| Region | `FLY_REGION` |
| Private 6PN IPv6 | `FLY_PRIVATE_IP` |
| Image ref | `FLY_IMAGE_REF` |
| Machine version | `FLY_MACHINE_VERSION` |
| Facts generated at | UTC timestamp of the boot that last *changed* a fact |

Behavior details:

- **An unchanged block is not rewritten at all.** The entrypoint re-renders the
  block using the timestamp the file already carries and compares it byte-for-
  byte with what is on disk; when they match it returns without touching the
  file, mtime included. This is not tidiness — `CLAUDE.md` is the agent's
  instruction file, and the coding CLI re-reads it every turn and compares it
  against the copy it injected when the conversation started. One changed byte
  and it re-sends the ENTIRE file into the live conversation as *"these differ
  from their earlier copies"*: ~48 KB, about 12k tokens, on every resumed turn,
  permanently occupying the context window the agent is measured on. Machines
  sleep after 15 idle minutes, so before this rule most turns paid it for a
  moved timestamp and nothing else (measured on one real 10-turn conversation:
  9 re-reads, ~108k tokens, every diff a single `Facts generated at` line).
  Tested by `backend/src/test/unit/machine-facts-refresh.test.ts`, which drives
  the real script through `entrypoint.sh --refresh-machine-facts <file>`.
- **Marker replacement** is done with `awk` (the fresh block is rendered to a
  temp file and spliced in via `getline`, so no multiline `awk -v` — portable
  across BSD awk / mawk / gawk); the new file is written beside the target and
  `mv`d in atomically, then `chown`ed `agent:agent`.
- **Missing markers** (an older volume, or the user deleted the block): the
  entrypoint **appends** a fresh block to the end of the file rather than
  rewrite it — it never clobbers or corrupts user content.
- **Missing file** (the user removed `CLAUDE.md`/`AGENTS.md` entirely): skipped;
  the entrypoint does not recreate it.
- **Never blocks boot**: any failure logs a warning and continues, consistent
  with the rest of the entrypoint.

Below the markers the seed carries four lines and nothing else — the physics
that has never moved: `/home/agent` is durable while the rest of the rootfs is
ephemeral, port 8080 is public, ordinary background children die with a turn,
raw tmux survives only the turn (not machine sleep), restartable processes use
`~/.boot.d`, and docker does not run here. Everything else an agent is told —
production hosting, secrets, git repos, the `ATTACH:` convention — lives in the
platform docs and travels by the identity pass, because that is the only
channel that reaches a machine which already exists.

The port line is repeated in the seed because the image is what makes it true:
**port 8080 is the public port** — anything
the agent serves on `0.0.0.0:8080` is instantly live at `https://<app>.fly.dev`
(pre-provisioned service + firewall-open by default, no expose step, no reboot),
so "just listen on 8080" is the fastest way to show a live page. Any *other*
port is reachable only internally *until it is exposed*, and making a non-8080
port public is not something the agent can do itself (it holds no cloud
credentials) — the file tells it to **ask the user to "expose port N"**, which
the setup assistant fulfills via the `expose_port` tool, returning a
`https://<app>.fly.dev` URL. See
[Public port exposure](#public-port-exposure-expose_port) below.

## Baked CLI defaults and hooks (`skel/` + `codex-managed-hooks.json`)

The image and durable-home skeleton seed operator defaults for both baked CLIs.

`~/.claude/settings.json` (Claude Code):

- **No commit attribution**: `includeCoAuthoredBy: false` (both the legacy
  top-level key and the current `attribution.includeCoAuthoredBy` shape, so it
  holds across CLI versions) — machine agents must not add
  `Co-Authored-By: Claude` / "Generated with Claude Code" trailers to user
  commits.
- **No self-updates**: `env.DISABLE_AUTOUPDATER = "1"`. CLI versions are pinned
  fleet-wide via `config/harnessCliVersions` (`npm --prefix backend run
  cli:versions -- bump` + the pre-sleep updater); the CLI's own autoupdater
  would drift machines ahead of the pin between idle cycles.
- **Unfinished-shell tombstones**: hooks around `PreToolUse` and shell completion
  (including Claude's `PostToolUseFailure`) for `Bash`, plus `SessionEnd` /
  `SessionStart`, record a shell call before it starts and clear it only after
  the harness reports completion. A Claude Bash call that returns a native
  background task ID stays open until a terminal task notification or a
  successful `TaskStop`; launch success is not mistaken for process completion.
  If a session ends with a call or native task still open (or disappears
  without running `SessionEnd`), the next session receives a concise recovery
  fact and the private record moves to
  `~/.agentbuilt/harness-tombstones-v1/archive/`. Commands are bounded and
  credential-shaped values are redacted before anything reaches disk.

`~/.codex/config.toml` (Codex):

- **No startup update check**: `check_for_update_on_startup = false` — same
  central-management rationale; the check would only nag about versions we
  haven't rolled yet. (No attribution key exists for Codex: the pinned version
  adds no trailer to user commits, and newer versions gate attribution on the
  user's own ChatGPT account setting, server-side.)
- **Whole AGENTS.md**: `project_doc_max_bytes = 262144` — Codex's own default
  is 32 KiB and it drops the remainder in silence, so the platform doc has to
  be read under a cap with headroom rather than under Codex's.
- **The model's real context window**: `model_context_window = 1000000` — Codex
  budgets against a model's default `context_window` (272,000 on the gpt-5.6
  family) unless told otherwise, while the same catalog entry gives
  `max_context_window = 872000`. The request is clamped per model and 5% is
  held back for the reply, so one value suits every model: gpt-5.6 agents get
  828,400 tokens instead of 258,400, and a model with a smaller ceiling
  (gpt-5.5) is unaffected.

`/etc/codex/hooks.json` carries the Codex copy of the same unfinished-shell
lifecycle hooks. It lives in Codex's managed system layer so the platform-owned
handler runs without asking each user to trust it; `~/.codex/hooks.json` remains
the user's own, independently reviewed hook file. This is intentionally a
tombstone, not a retry engine: a missing completion says the shell may have
been terminated, not that its side effects failed or rolled back. It covers
shell calls still owned by the harness. A shell which already returned after
self-daemonizing a process has completed its hook lifecycle and remains a
`~/.boot.d` service (or, for finite work, an `agentbuilt job`) rather than an
open harness call.

The home skeleton seeds its files on **first boot only**. The managed Codex
hook is also baked into the ephemeral rootfs, and all of these defaults are
**converged on machines that already exist**: `buildTelegramAgentCliDefaultsScript`
runs as part of the identity write. It installs the managed file immediately
and writes a durable `~/.boot.d/15-codex-managed-hooks.sh` installer so the file
returns after an older rootfs resets. A changed default therefore reaches the
whole fleet on the next `TELEGRAM_AGENT_IDENTITY_VERSION` bump, before the next
image roll.

The convergence **merges** — `~/.claude/settings.json` is also where an agent
keeps its own permissions, hooks and model choice, and user entries survive.
Only handlers identifiable by the platform command are replaced on a later
identity pass. User Codex hooks are not changed; the operator hook occupies its
own managed file. Codex's TOML keys are written above any `[table]` header,
where a top-level key is still top-level.
The seed and convergence sources are pinned to each other by meaning in
`agent-cli-defaults-script.test.ts`; change one and change the other.

## Env vars the entrypoint honors

| Var | Required | Default | Purpose |
|---|---|---|---|
| `AUTHORIZED_KEYS` | **yes** | — | SSH public key(s) authorized for `root` and `agent`. Newline- or literal-`\n`-separated. Injected **at machine-create time**, not baked. Without it the backend cannot connect. |
| `BACKEND_PEER_IP` | no | — | The backend's WireGuard 6PN address. The boot firewall accepts inbound SSH (`:2222`) only from it. Injected **at machine-create time** by `FlySandboxClient` (from `FLY_BACKEND_PEER_IP`). Unset in dev/e2e → the firewall falls back to the machine's own /48 prefix so local machines stay reachable. See [Firewall](#firewall-cross-tenant-isolation). |
| `PUBLIC_PORT` | no | `8080` | The machine's public port. The boot firewall always accepts it (ahead of the `fdaa::/16` drop), so a service on `0.0.0.0:$PUBLIC_PORT` is reachable via the pre-provisioned Fly service (443/80 → this port, baked into the initial machine config) with **no runtime expose call and no reboot**. Injected **at machine-create time** by `FlySandboxClient` (from `FLY_PUBLIC_PORT`). |
| `CPU_KIND` | no | — | `performance` (dedicated cores) or `shared`, as the backend built or resized this machine. The ONLY part of its own shape a machine cannot see from inside — Fly throttles shared vCPUs on the host, so `/proc` reads identically on both — and the facts block turns it into `- CPU: 2 dedicated cores` (note #393). How many cores and how much memory are read from the guest itself (`nproc`, `/proc/meminfo`), never from env, so nothing injected can disagree with the machine. Injected by `FlySandboxClient` at machine-create and at every resize, and by `MachineImageUpdater` on an image roll (which is what carries it to machines that predate it). Unset → the kind is left off the line rather than guessed. |
| `DATA_DIR` | no | `/data` | Volume mount point. |
| `AGENT_USER` | no | `agent` | Development/harness user. Changing it also changes the home path, so leave it unless the backend's `DEFAULT_DEVELOPMENT_SSH_USER` changes too. |

## SSH contract

The image's sshd matches what `ssh-client.ts` / `hetzner-sandbox-client.ts`
expect today:

- **Users**: `agent` (development + harness work) and `root` (admin exec). Both
  get the injected key.
- **Auth**: public-key only. `PasswordAuthentication no`,
  `PermitRootLogin prohibit-password`.
- **Port**: `2222` — NOT the backend's Hetzner-era default of 22. Fly's init
  runs its own SSH daemon (hallpass) bound to port 22 on the machine's 6PN
  IPv6 address before the entrypoint starts, so our sshd can never own :22 on
  the address the backend connects to (verified live 2026-07-11: connecting to
  `<6pn-ipv6>:22` reaches hallpass and key auth fails). Step 5 must pass port
  2222 in `SshExecConnectionConfig`.
- **Reachability**: listens on all addresses, both families (`AddressFamily
  any`), so it answers over the machine's **private 6PN IPv6** — there is no
  public IP.
- **Login shell**: `agent`'s shell is `/bin/bash`, so `bash -lc` and tmux login
  windows start cleanly (the exact breakage the bootstrap's `usermod -s
  /bin/bash` guarded against).
- **Locale / TERM**: `en_US.UTF-8` generated; `TERM=xterm-256color` defaulted;
  sshd `AcceptEnv LANG LC_* TERM COLUMNS LINES`. Keeps tmux + the CLI TUIs
  rendering correctly.

### What step 5 must change vs. the Hetzner path

- **Host = the machine's private 6PN IPv6**, not a public v4 address.
  `getBootstrapServerPublicAddress()` / `getHetznerServerPublicAddress()` return
  public v4; the Fly client must resolve the machine's private IPv6 instead.
- **No bootstrap step.** Skip `prepareBootstrapServerEnvironment` entirely — the
  image is the environment. (`createDevelopmentSandbox` should behave like
  `prepareEnvironment: false`, but "already prepared".)
- **Host-key verification**: host keys are now stable per machine (persisted on
  the volume). `expectedHostKey` on `SshExecConnectionConfig` is still optional;
  you may leave it unset (current behavior) or, for defense-in-depth, capture
  the machine's `/data/ssh/ssh_host_ed25519_key.pub` at create time and pin it.
- **Username**: connect as `agent` for harness/dev work (already the default via
  `DEFAULT_DEVELOPMENT_SSH_USER`), `root` for admin — no change.
- **Port 2222, not 22** (see above) — the one connection-config change besides
  the host address.

## Firewall (cross-tenant isolation)

All user machines run on the Fly org's **default 6PN network** (`fdaa:99:600e::/48`).
The earlier plan put each user's app on its own custom network, but the backend's
single WireGuard peer only routes the default network, so custom-network machines
were unreachable over 6PN. With everyone on one shared network and users running
arbitrary code, any machine could otherwise reach any other machine's sshd —
isolation therefore moves **into this image**, as an nftables firewall the
entrypoint applies on every boot **before sshd starts**.

The ruleset (nftables `ip6` table `fly_fw`, `input` hook, `policy accept`):

```
table ip6 fly_fw {
  chain input {
    type filter hook input priority 0; policy accept;
    iif "lo" accept                                  # loopback
    ct state established,related accept              # our own reply traffic
    meta l4proto ipv6-icmp accept                    # 6PN neighbor discovery (load-bearing)
    tcp dport 2222 ip6 saddr <ALLOWED> accept        # SSH ingress pin
    tcp dport <PUBLIC_PORT> accept                   # public port (default 8080)
    ip6 saddr fdaa::/16 drop                         # every other tenant
  }
}
```

- `<ALLOWED>` is **`BACKEND_PEER_IP`** when the env var is set (prod), else the
  machine's **own /48 prefix**, derived at boot from the machine's `fdaa:…`
  address (first three hextets → `fdaa:xx:yy::/48`). The fallback keeps dev/e2e
  machines reachable from same-network peers when no explicit backend peer is
  injected.
- **The public port (`PUBLIC_PORT`, default 8080) is always accepted**, ahead of
  the `fdaa::/16 drop`, so a server the agent runs on `0.0.0.0:$PUBLIC_PORT` is
  reachable via the pre-provisioned Fly service (443/80 → this port, baked into
  the initial machine config by `FlySandboxClient`) with no runtime expose call
  and no reboot. Digits-only, defaults to `8080`, never the SSH ports.
- **`policy accept`** deliberately restricts only `fdaa::/16` sources. Outbound
  is untouched (users need full egress), and public exposure is not pre-empted:
  the `expose_port` tool inserts its per-port `accept` rules ahead of the
  `fdaa::/16 drop` (see [Public port exposure](#public-port-exposure-expose_port)).
- **Exposed ports are re-applied on every boot.** After the SSH-pin rule and
  before the `fdaa::/16 drop`, the entrypoint reads
  **`${DATA_DIR}/exposed-ports`** (one port per line, written by `expose_port`;
  absent on a machine with nothing exposed) and emits a
  `tcp dport <port> accept` for each. A runtime `nft` rule is lost on reboot, so
  this file on the volume is what makes an exposure durable. Blank lines and the
  machine's own SSH ports (22/2222) are skipped.
- Applied idempotently every boot via the `add table; delete table; table {…}`
  atomic-reload idiom.
- **Degrades gracefully off Fly**: on a host with no `fdaa` address (a local
  `docker run`, the smoke test) the step logs and skips, so the image still boots
  and is reachable over the published port. A local run therefore has **no**
  firewall — that is expected; the firewall is a 6PN construct.

`BACKEND_PEER_IP` is part of the machine-create contract (alongside
`AUTHORIZED_KEYS`) — see the [contract](#step-5-machine-create-contract) below.

## Public port exposure (`expose_port`)

**The common case needs no tool call.** Every machine is created with the shared
IPv4 allocated and a 443/80 → **`PUBLIC_PORT`** (default **8080**) service baked
into its *initial* config, and the firewall accepts 8080 by default — so a server
the agent runs on `0.0.0.0:8080` is instantly live at `https://<app>.fly.dev`
with no expose step and **no reboot** (the onboarding aha site uses this). Calling
`expose_port(8080)` is still safe and idempotent: because the service is already
wired, it skips the config update (so it stays reboot-free) and just records the
published URL.

For **any other** internal port, a machine starts with the firewall dropping all
non-backend `fdaa::/16` inbound, so the service is private. The `expose_port`
**setup-agent tool** (Option A — the *administrator* agent owns exposure; the
coding agent on the machine never holds cloud credentials) makes one public.
Given an internal port it, idempotently:

1. **Allocates the app's shared IPv4** (free, one per app) over Fly's GraphQL API
   so fly-proxy has a public address — skipped if the app already has one.
2. **Adds a machine `services` block** mapping public **443** (`tls`+`http`) and
   **80** (`http`, `force_https` → 301 to 443) to `internal_port = <port>`, via a
   whole-config Machines-API update. **This reboots the machine** (Fly reboots a
   running machine on a config change); the `/data` volume and the agent home on
   it persist. Services are keyed by `internal_port`, so re-exposing a port is a
   no-op and the fly.dev hostname routes to one 443 service at a time.
3. **Opens the firewall** for the port. fly-proxy forwards public traffic to the
   machine over 6PN (the `fdaa` space the firewall drops), so an `nft` accept is
   **inserted ahead of the `fdaa::/16 drop`** at runtime, and the port is
   appended to **`${DATA_DIR}/exposed-ports`** so the boot firewall (above)
   re-opens it after the reboot and every future one.

The tool returns **`https://<app>.fly.dev`** — the app's default hostname. Ports
**22** and **2222** are refused (Fly hallpass / our sshd). `unexpose_port`
reverses steps 2–3 (drops the service, deletes the runtime rule, removes the port
from `exposed-ports`); the allocated shared IPv4 is left in place (free and
harmless). The runtime nft add/delete and the persist-file edits run as `agent`
via passwordless `sudo`, and tolerate the `fly_fw` table being absent (a local
`docker run` has no 6PN firewall to punch through).

## Docker (note #1167)

Installed in the image since 12 Nov 2026; until then every agent was told it
could never work here. Four pieces, all in this directory:

| Piece | What it does |
|---|---|
| `docker/docker` → `/usr/local/bin/docker` | ahead of `/usr/bin` on PATH: when the daemon does not answer, starts it, then `exec`s the real CLI. Client-only commands (`--version`, help, `compose config`, …) pass straight through, so they stay instant and work where no daemon can run (the smoke test). Skipped when `DOCKER_HOST` is set. |
| `docker/agentbuilt-dockerd` → `/usr/local/sbin/` | idempotent "start it if it is not answering": picks the data root, `setsid -f dockerd`, waits for `/_ping`, fails fast with the daemon's own words if it exits. Logs to `/var/log/agentbuilt-dockerd.log`. |
| `docker/daemon.json` → `/etc/docker/` | classic overlay2 store, the `local` log driver (rotates), `mirror.gcr.io` as Docker Hub mirror. |
| entrypoint step 7b, `start_docker_if_asked` | at boot: clears the previous boot's `/run` leftovers, and starts the daemon only if a container on the volume has a restart policy Docker honours at daemon start. |

**Why not at boot.** dockerd + containerd take ~135 MB (measured on a 2 GB
agent machine), and most agents never run a container.

**Where the data lives.** Never on `/`: the root is an overlay, and Docker
cannot mount a container's layers on overlay — pulls succeed, then every
`run` fails with `failed to mount … overlay … invalid argument` (measured).
On an agent machine the data is `/data/docker` on the volume, so images and
named volumes survive sleep and image rolls, and Fly's auto-extend (80% →
+5 GB, up to 50 GB) grows it. A machine with no `/data` mount (a lane-A CI
machine, a local `docker run` of this image) gets a sparse ext4 file on the
root, loop-mounted at `/var/lib/docker`, sized to the root's free space minus
1 GB — about 5.7 GB on a performance-4x lane-A machine.

**Sleep is a power cut.** The reaper stops the machine; nothing signals
dockerd first, so containers die mid-write (Postgres recovers as after a
power loss — measured with a hard kill of every Docker process). Running
containers do not keep a machine awake: the reaper's gates are turns, live
terminals, managed jobs and recent activity, and a container is none of those.
On the next boot, `always` and `unless-stopped`-not-stopped-by-hand
containers come back because step 7b starts the daemon; a container with no
policy stays down, as on any laptop after a reboot. The rootfs survives a
stop/start (`rootfs: { persist: 'restart' }`), so the old `docker.pid` is
still there at boot and a reused pid in it makes dockerd refuse to start —
that is why step 7b clears it.

**Why these daemon.json choices.** overlay2 over the containerd image store:
postgres:16-alpine + nginx:alpine took 347 MB vs 480 MB, on a volume that
starts at 5 GB. `local` log driver: json-file never rotates, so a chatty
container could fill the volume. `mirror.gcr.io`: Docker Hub allows 100
anonymous pulls an hour per address (`ratelimit-limit: 100;w=3600`), Fly
machines on a host share an egress address, and pulls through the mirror did
not move the counter; a miss falls through to Docker Hub.

**Networking.** Published ports answer on the machine's 6PN address too
(docker-proxy binds `::`), so a container on `8080:<port>` IS the public
preview. The `fly_fw` input chain still drops other tenants on every other
port: for IPv6 (no container has an IPv6 address) a published port is docker-proxy, a host process, so its traffic goes through `input`.

**Proven on 12 Nov 2026.** On an agent machine (1 dedicated core, 2 GB):
first `docker compose up -d` of Postgres + nginx 11 s including pulls;
`pg_isready`, nginx 200 on 127.0.0.1 and on the 6PN address, service-name DNS
between containers; hard kill of every Docker process then step 7b → both
`unless-stopped` containers back with their data; `docker compose stop` →
step 7b leaves Docker off; next `docker` command starts it in ~1.4 s. On a
lane-A CI machine (performance-4x, no volume): the loop disk came up, overlay2
on extfs, Postgres + nginx pulled, started and healthy in 20 s.

Then the real thing: this image built and booted as a throwaway machine in the
scratch org (1 dedicated core, 2 GB, a volume at `/data`, `--rootfs-persist
restart`). As `agent`, `docker compose up -d --wait` started Docker on first
use and brought Postgres + nginx (on 8080) up healthy; a row went into
Postgres. `fly machine stop` + `start` — the reaper's own call — and step 7b
logged `restarts unless-stopped; starting Docker`: both containers back
healthy, nginx 200 on 8080, the row still there. The probe also found the one
race step 7b guards against: a `fly machine exec` that started Docker BEFORE
the entrypoint reached step 7b had its pid file and socket cleared from under
it, so step 7b now leaves a running daemon alone.

## Build locally

The three CLI versions are **required build-args** — the build fails without
them, by design. They are not a per-build choice: they come from the fleet pin
in the backend's config store, which is the only place a CLI version is decided.
CI reads it (`GET /api/harness-cli-versions`, over the SSH path it already uses)
and passes it in; see [the `machine-image` job](../ci-runner/run-job.sh).

Until 2026-08-08 they defaulted to `latest`, which meant every image build was a
version decision taken by the npm registry — and the pre-sleep updater then
corrected each machine back to the pin, but only for the CLI its own agent uses.
Both mechanisms owned one number and disagreed; the image now asks the pin.

```sh
cd infra/fly-machine-image

# Locally, name the versions you want — there is no default:
docker build -t fly-machine-image:dev \
  --build-arg NODE_MAJOR=22 \
  --build-arg CLAUDE_VERSION=2.1.223 \
  --build-arg CODEX_VERSION=0.145.0 .

# Or take the fleet pin, the same way CI does:
curl -fsS https://<backend-host>/api/harness-cli-versions
```

Run it like Fly will (volume at `/data`, key via env). `--cap-add SYS_ADMIN`
lets the entrypoint use a real bind mount as it does on Fly:

```sh
docker run --rm -it --cap-add SYS_ADMIN \
  -e AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
  -v ia-home:/data -p 2222:2222 fly-machine-image:dev
# then: ssh -p 2222 agent@127.0.0.1
```

### Smoke test

[`smoke-test.sh`](./smoke-test.sh) builds the image and asserts the full
contract end to end: key injection (agent + root), CLIs, tmux, and home-dir
persistence across a container recreation on the same volume.

```sh
./smoke-test.sh
```

Requires `docker`, `ssh`, `ssh-keygen` on the host.

## How CI publishes

[`.github/workflows/fly-machine-image.yml`](../../.github/workflows/fly-machine-image.yml):

- **Every PR / push** that touches this directory runs a **validation build**
  (no registry needed) so a broken Dockerfile or CLI install fails fast.
- **On `main` (or manual dispatch), with `FLY_API_TOKEN` set**, it builds and
  pushes to `registry.fly.io/<FLY_IMAGE_APP>:<label>` and `:latest`.

Before it can push, Owner does the one-time setup:

1. Create a Fly app to hold the images: `fly apps create ia-machine-images`
   (or change `FLY_IMAGE_APP` in the workflow).
2. Add a repo secret **`FLY_API_TOKEN`** (`fly tokens create org` or
   `fly tokens create deploy`).

Manual equivalent, no CI:

```sh
flyctl auth docker
docker build -t registry.fly.io/ia-machine-images:$(git rev-parse --short HEAD) infra/fly-machine-image
docker push registry.fly.io/ia-machine-images:$(git rev-parse --short HEAD)
```

## Step 5 machine-create contract

`FlySandboxClient` (step 5 in the plan) creates each user's app + volume +
machine. What it must pass at **machine create** for this image to boot and be
reachable:

- **Image ref**: `registry.fly.io/<FLY_IMAGE_APP>:<label>` (pin a specific
  label, not `latest`, so a fleet roll is deliberate).
- **Env** (`config.env`):
  - `AUTHORIZED_KEYS` = the backend's SSH **public** key (the counterpart of the
    private key `ssh-client.ts` connects with). Required.
  - `BACKEND_PEER_IP` = the backend's WireGuard 6PN address (e.g.
    `fdaa:0:1:a7b:1:2:3:4`). The boot firewall pins inbound SSH
    (`:2222`) to it. Strongly recommended in prod; when omitted the firewall
    falls back to the machine's own /48, which is fine for dev/e2e but does not
    isolate cross-tenant on a shared network. `FlySandboxClient` injects it from
    `FLY_BACKEND_PEER_IP`.
  - `PUBLIC_PORT` = the machine's public port (default `8080`). The boot firewall
    accepts it by default. `FlySandboxClient` injects it from `FLY_PUBLIC_PORT`.
  - `CPU_KIND` = `performance` or `shared`, matching `config.guest.cpu_kind`.
    The machine's facts block says which kind of cores it has; cores and memory
    it reads from the guest itself. Optional — without it the facts line says
    how many cores and stops there.
  - optional `DATA_DIR` / `AGENT_USER` only if diverging from defaults.
- **Mounts** (`config.mounts`): the per-user Fly Volume with
  **`destination: "/data"`**. The image owns the internal `/data → /home/agent`
  presentation; the volume itself just needs to land at `/data`.
- **Services / ports**: a **443/80 → `PUBLIC_PORT` (8080)** `services` block is
  baked into the **initial** config (and the app's free **shared** IPv4 allocated
  at create), so the machine boots publish-ready with **no post-create reboot** —
  a server the agent runs on 8080 is instantly live at `https://<app>.fly.dev`.
  Setting `services` on an already-running machine reboots it, which is why this
  is pre-provisioned rather than added later. Do **not** allocate a *dedicated*
  public IP (a dedicated v4 costs $2/mo and widens attack surface) — the shared v4
  is free. The backend still reaches sshd on **port 2222 over the private 6PN
  IPv6** (Fly's hallpass owns :22 there). Additional ports beyond 8080 are added
  on demand later by [`expose_port`](#public-port-exposure-expose_port).
- **Guest size**: 4GB / 2 shared vCPU per the plan's settled free-tier size
  (image is size-agnostic).

After create + `started`, connect as `agent@<private-ipv6>:2222` for
harness/dev work, `root@<private-ipv6>:2222` for admin — same executor, only
the port differs from the Hetzner path.
