# Backend host (Hetzner `ia-backend`)

> **History.** The Hetzner box this describes was deleted on 8 Nov 2026 (note #1072); see `docs/control-plane-on-fly.md` for where each piece runs now.

Provisioning + deploy target for the Infinite Agents backend as it moves off
Render onto a Hetzner VM inside the Fly WireGuard org (growth-phase plan,
implementation step 2). See the growth-phase infrastructure plan (kept privately) and the
cutover runbook `docs/backend-cutover-runbook.md`.

## The VM

- **`ia-backend`** — Ubuntu 24.04, cx23, IP `<backend-host>`, region `fsn1`.
- SSH admin: `root` via `~/.ssh/hetzner_backend`.
- Runs `wg-quick@fly` (WireGuard peer into the Fly org) — **never touch
  `/etc/wireguard/` or that service**; the private key is unrecoverable.

## What lives here

| File | Purpose |
|---|---|
| `provision.sh` | Idempotent, run as root on the VM. Installs Node 22, the `app` user, deploy key, systemd units (**disabled**), placeholder env, ufw (22 only), unattended-upgrades. |
| `infinite-agents-backend.service` | systemd service. Runs `node dist/index.js` as `app`, inherits its HTTP listener, and uses `EnvironmentFile=/etc/infinite-agents/backend.env`. |
| `infinite-agents-backend.socket` | Owns `[::1]:3001` across service restarts. Connections queue here while Node starts, preventing the restart gap from surfacing as 502 responses. |
| `backend.env.placeholder` | Documented dummy env. Installed to `/etc/infinite-agents/backend.env` (600, root). Real values copied from Render at cutover. |
| `set-machine-image` | Installed to `/usr/local/bin` (root, 0755) by every deploy-prod. Repoints `FLY_MACHINE_IMAGE` to one tag under a **fixed** registry and restarts the backend, verifying each step; with `--git-host` it repoints `FLY_GIT_HOST_IMAGE` instead (ghcr `git-host-…` tags only) and with `--msg-host` `FLY_MSG_HOST_IMAGE` (ghcr `msg-host-…` tags only), and each form refuses the others' tags. The image-build jobs call it over SSH so a root key never has to live in GitHub Actions. |

### Why `set-machine-image` exists

`.github/workflows/fly-machine-image.yml` builds and smoke-tests the image every
agent machine boots from, but a pushed image nobody points at changes nothing —
three skel edits sat unused in the registry on 2026-08-07 for exactly that
reason. The workflow now finishes the job over SSH as `app`.

It needs one privileged effect: *make this image the one new machines boot from*.
A root key in Actions would grant every other effect too, permanently, to anyone
who can edit a workflow file. So this script holds that single effect and
validates its own argument — the registry path is baked in, only the tag comes
from the caller, and the charset excludes anything sed or the shell would treat
as syntax. `sudoers` lets `app` run this and nothing else new.

Failure behaviour matters as much as the happy path: the edit is staged in a
temp file, the previous env is kept at `backend.env.previous`, ownership and
mode are applied **before** the swap, and if the service does not come back the
script prints the exact restore command and exits non-zero. Existing agent
machines are untouched by the swap itself — they converge afterwards, on their
own: the backend's `MachineImageUpdater` moves each one onto the new ref the
next time the idle reaper finds it asleep, and
`backend/scripts/roll-machine-image.mjs` forces the rest immediately.

## How the backend builds and runs

- Build: `npm ci && npm run build` (`tsc -b` → `backend/dist/`), then
  `npm prune --omit=dev`. This mirrors what Render did (Render used git-push +
  the same npm build/start scripts).
- Run: `node dist/index.js`, Node 22. In production Express inherits the
  systemd-owned listener on `[::1]:3001`; ordinary local launches still use
  `PORT`. The Telegram bot uses a **webhook** (there is no getUpdates polling
  loop — whichever backend calls `setWebhook` last owns the bot).

## Deploy layout on the VM

```
/opt/infinite-agents/
  releases/<git-sha>/   dist/ node_modules/ package.json  (one per deploy)
  current -> releases/<git-sha>   (atomically swapped symlink)
```

The systemd unit runs from `/opt/infinite-agents/current`.

## Re-provisioning

```sh
rsync -az infra/backend-host/ root@<backend-host>:/root/backend-host/
ssh root@<backend-host> \
  'DEPLOY_PUBKEY="$(cat /root/backend-host/deploy_key.pub)" bash /root/backend-host/provision.sh'
```

It never enables/starts the service or socket and never touches WireGuard. Safe
to re-run.

## Deploy pipeline

The CI runner's `deploy-prod` job builds and rsyncs a release, validates and
installs the service/socket pair, and restarts the service **only if it is
enabled**. The socket remains open across every restart and the job waits for
the public health endpoint before passing. It is safe to run before cutover —
code and units land, while a dormant service and socket stay down.

## Current state (left dormant)

Service `infinite-agents-backend` and its socket are **installed, disabled, and
stopped**. The env file is the **placeholder** (no real secrets). Cutover is
manual — see `docs/backend-cutover-runbook.md`.
