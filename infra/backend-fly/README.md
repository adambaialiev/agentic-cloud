# Production's backend on Fly (`ia-control`)

Since note #1032 stage 4, production's backend is one always-on Fly machine
in our organization (`ams`, shared-cpu-2x, 4 GB, 20 GB volume at `/data`).
It is **ia-backend in a machine**. The paths, the env file, the release
layout and the systemctl verbs are the box's, so deploy-prod, `ia-rollback`
and `set-machine-image` drive both the same way. Private copies run
`infra/backend-image` instead; that image bakes its release in.

| Piece | Job |
|---|---|
| `entrypoint.sh` | bind-mounts the volume onto ia-backend's paths (below), seeds `ia-rollback` and `set-machine-image` on a first boot, starts sshd on **2222**, execs the holder |
| `holder.py` | holds `[::]:3001`, runs `/opt/infinite-agents/current` with that socket as fd 3 (systemd's activation contract), reads `/etc/infinite-agents/backend.env` before each start, restarts on failure after 5 s, gives 30 s to drain. `enabled` is a file on the volume. |
| `systemctl`, `systemd-analyze` | shims for the backend's two units only, talking to the holder over `/run/ia-backend/control.sock`. Anything else is refused. |

| On the volume | Seen as |
|---|---|
| `/data/opt` | `/opt/infinite-agents` (`releases/`, `current`, `last-attempt`) |
| `/data/etc` | `/etc/infinite-agents` (`backend.env`, `ghcr-owner`) |
| `/data/var` | `/var/lib/infinite-agents` (`backend.db`) |
| `/data/local-bin` | `/usr/local/bin` (`ia-rollback`, `set-machine-image`, as deploys install them) |
| `/data/log/backend.log` | the backend's output, 100 MB × 5 (it also goes to `fly logs`) |
| `/data/state/backend.enabled` | present = serve; absent = hold nothing, run nothing |

**Two backends must never run at once.** A new or restored machine boots with
`enabled` absent, reachable over SSH and serving nothing, until someone runs
`systemctl enable infinite-agents-backend.service infinite-agents-backend.socket && systemctl start infinite-agents-backend`
on it.

**Reaching it.** `fly ssh console -a ia-control` for a human. CI's dispatcher
uses `ssh -p 2222 root@ia-control.internal` with the deploy key
(`DEPLOY_AUTHORIZED_KEYS` is a Fly secret on this app holding the public
half). The app has no public service on 2222.

**Changing the runtime** (this directory, not the backend's code), from the
repository root:

    flyctl deploy --remote-only -c infra/backend-fly/fly.toml --dockerfile infra/backend-fly/Dockerfile .

That replaces the machine, so Fly's proxy holds requests for about 8 s. The
backend's code ships through deploy-prod as always: about 1 s, nothing dropped.
