# app-runtime-image — production deployment machines

The image every PRODUCTION deployment machine boots from
(docs/deployments-phase1.md). A deliberately minimal sibling of
`../fly-machine-image`: no harness CLIs, no tmux, no sudo, no build
toolchain. One machine serves one user app.

## Serve modes

The entrypoint picks the mode from the volume on each boot — a redeploy that
changes shape needs no machine-config change, only a sync + restart:

| Mode | Trigger | What runs |
|---|---|---|
| `service` | `/data/app/run.sh` exists (executable) | `run.sh` as user `app`, `PORT=$PUBLIC_PORT` |
| `static` | `/data/site/` non-empty | `caddy file-server --root /data/site` |

`run.sh` wins when both exist. Neither present → supervisor idles (machine is
freshly provisioned, first sync hasn't happened yet).

## Supervision & the restart hook

The workload runs under a detached restart loop; the child pid is written to
`/data/app.pid`. **Killing that pid IS the restart** — the loop respawns the
workload in ~2s. `agentbuilt restart` and post-sync restarts both do exactly
that over the backend's SSH. Logs append to `/data/logs/app.log` (rotated to
the last 1 MB when it crosses 10 MB, at boot).

## Volume contract (`/data`)

```
site/      static content (mode: static)
app/       service code incl. run.sh (mode: service)
logs/      app.log — what `agentbuilt logs` tails
app.pid    current workload pid (restart hook)
ssh/       persistent SSH host keys
```

Deploy sync writes `site.new/` (or `app.new/`), atomic-renames over the live
dir, then kills `app.pid`.

## Env contract (machine create)

Same shape as the agent image: `AUTHORIZED_KEYS` (backend root key — the
backend connects only as root here), `BACKEND_PEER_IP` (pins SSH :2222
ingress), `PUBLIC_PORT` (default 8080). A service deployed with
`--secret NAME` also carries those saved secrets as machine env (note #661);
the supervisor inherits the machine env, so `run.sh` sees them. Changing them
is a machine-config update, which Fly applies with a restart. The nftables boot firewall mirrors
the agent image's: :2222 from the backend peer, the public port from
anywhere, all other fdaa::/16 inbound dropped.

## Building

CI-less for now (GitHub Actions is disabled repo-wide): build on Fly's
remote builders — no local Docker needed:

```
cd infra/app-runtime-image
printf 'app = "<images-app>"\n[build]\n  dockerfile = "Dockerfile"\n' > fly.toml
FLY_API_TOKEN=… flyctl deploy . --build-only --push \
  --image-label app-<label> --remote-only
rm fly.toml
```

Images land in `registry.fly.io/<images-app>:app-<label>`
(`ia-machine-images`). The backend consumes the ref via
`FLY_APP_RUNTIME_IMAGE`.

`smoke-test.sh` boots both modes under local Docker and asserts they serve —
usable anywhere Docker actually works (not the agent machines; their rootfs
can't nest overlayfs and 6PN DNS breaks bridged containers).
