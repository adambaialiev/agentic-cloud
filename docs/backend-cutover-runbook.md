# Backend cutover runbook: Render → Hetzner `ia-backend`

> Status (2026-11-06): history. This cutover was done; the backend runs on the Hetzner host and Render is retired. Kept as the record of the move.

Manual, do-it-once procedure to move the live backend off Render onto the
Hetzner VM. Everything up to this point (VM provisioned, code deployable,
service **disabled + stopped**, placeholder env) is already done. This runbook is
the only place real secrets touch the VM.

- VM: `ia-backend`, `<backend-host>`, SSH `root` via `~/.ssh/hetzner_backend`.
- **Never touch `/etc/wireguard/` or `wg-quick@fly`.**
- The customer product is a browser Workspace. Cut over its HTTPS origin,
  cookie/CSRF trust configuration and stateful database together. The separate
  operator bot is optional and uses only `TELEGRAM_OPS_*` configuration.

## 0. Prerequisite — public HTTPS ingress (NOT yet set up)

The dormant VM only allows inbound SSH (22). The browser Workspace and agent
CLI API need public HTTPS, so before cutover the VM needs:

1. A public hostname pointing at `<backend-host>` (e.g. move the existing
   backend DNS record, or a new `api.` subdomain).
2. TLS termination + reverse proxy to `127.0.0.1:3001`. Recommended: Caddy
   (auto-TLS) or nginx + certbot.
3. `ufw allow 443/tcp` (and `80/tcp` if using HTTP-01 TLS challenges).

This is the one piece the growth-phase plan left unspecified. Decide the
hostname/proxy first — the steps below assume it resolves and terminates TLS.

## 1. Fill in real secrets

Copy every real value from the **Render dashboard → service `infinite-agents` →
Environment** into the env file. The names already match.

```sh
ssh root@<backend-host>
nano /etc/infinite-agents/backend.env     # replace every PLACEHOLDER_* value
chmod 600 /etc/infinite-agents/backend.env
```

Set `WORKSPACE_URL`, `CORS_ORIGIN`, `WEB_APP_BASE_URL`, and
`AGENTBUILT_API_URL` to their real public origins. Keep the Fly (`FLY_*`)
values current. If this host also owns the internal operator bot, set its
`TELEGRAM_OPS_WEBHOOK_URL`; no customer Telegram variables exist.

## 2. Database

Persistence is a SQLite file on this host: set `SQLITE_DB_PATH` (conventionally
`/var/lib/infinite-agents/backend.db`) and make sure the directory exists and is
writable by the service user. If it is unset the backend silently runs on
in-memory storage and loses everything on restart.

## 3. Start the backend on the VM

```sh
systemctl enable --now infinite-agents-backend
systemctl status infinite-agents-backend --no-pager
journalctl -u infinite-agents-backend -f
```

Confirm in the logs: `Server running on http://localhost:3001` and
`[Storage] Persistence: SQLite (…)` (not the in-memory warning). If configured,
also confirm the explicitly labelled ops-bot webhook sync; it has no customer
identity or agent-turn role.

## 4. Verify

- `curl -sS https://<your-host>/health` (or any known route) through the proxy.
- Open `https://<your-host>/login`, sign in, and confirm an authenticated
  state read plus a CSRF-protected write.
- Confirm an SSH-path action (e.g. a harness turn to a Fly machine) works over
  the `fly` WireGuard peer — this is the whole reason for the move.

## 5. Retire Render

Only after step 4 passes:

1. Render dashboard → service `infinite-agents` → **Suspend** (keep it a few
   days as instant rollback; delete later).
2. Leave its env vars in place while suspended so rollback is one click.

## 6. Rollback

If the VM backend misbehaves:

```sh
# Stop the service first, then its activation socket; disabling only the
# service would let the next HTTP request start it again.
systemctl disable --now infinite-agents-backend.service
systemctl disable --now infinite-agents-backend.socket
```

Then in Render: **Resume** the service and redeploy, and restore the public
Workspace/API origin to it. No data migration to undo — the SQLite file stays
where it is.

Release-level rollback (bad code, VM staying primary): repoint the symlink to a
previous release and restart —

```sh
ls -1dt /opt/infinite-agents/releases/*/         # pick the prior sha
ln -sfn /opt/infinite-agents/releases/<sha> /opt/infinite-agents/current
systemctl restart infinite-agents-backend
```

## 7. Post-cutover

- Update `VITE_API_BASE_URL` / `API_BASE_URL` GitHub secret + `DEPLOYMENT.md`
  from `https://infinite-agents.onrender.com` to the new backend host, and
  rebuild the frontend.
- The deploy pipeline now coalesces rapid `main` updates behind a 30-second
  quiet window, then restarts the live service once. systemd keeps
  `infinite-agents-backend.socket` listening throughout the restart (the
  dormant guard becomes a no-op once the service is enabled).
- Sanity-check `wg show fly latest-handshakes` still shows recent handshakes.
