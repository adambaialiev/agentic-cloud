# Self-Hosted Machines

> **⚠️ The user-facing self-hosted flow was removed in [PR #720](https://github.com/owner/infinite-agents/pull/720).** There is no longer any way for a user to register or connect their own machine: the `/api/self-hosted` route, the `connect-self-hosted.sh` script, the relay daemon, and the `register_self_hosted_machine` / `reconnect_self_hosted_machine` agent tools are all gone. The self-hosted **runtime** (`websocket_relay` provider handling, relay execution, unregister-on-delete) remains inside the execution engine but is inert — no registration path can create a self-hosted record. This document is retained as historical reference for that runtime.

Self-hosted machines let you add computers you already own, such as home-lab boxes, development workstations, or cloud VMs in restrictive networks, to the Infinite Agents platform. Once connected, a self-hosted machine appears as a regular server with terminal and agent support.

## Connection Model

Self-hosted machines use a single connection method: `websocket_relay`.

The target machine runs a lightweight Bun relay daemon that opens an outbound WebSocket connection to the platform relay server. Commands are sent as JSON frames over that WebSocket. The daemon executes them locally with `child_process` and returns stdout, stderr, and exit status.

This works through NAT, firewalls, and restrictive networks because the target machine initiates the connection. No inbound ports or SSH server are required.

The relay uses bidirectional JSON `ping`/`pong` heartbeats. By default both sides probe every 30 seconds and treat a connection as stale after 75 seconds without a valid response or inbound frame. Stale sockets are closed so the machine is marked offline promptly and the local daemon can reconnect.

## One-Command Connect

After you register a self-hosted machine in the platform, you receive a one-line connect command. Run it on the target machine:

```bash
bash <(curl -s 'https://your-app.example/connect-self-hosted.sh') --record-id sh_xxxxxxxxxx --token shm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx --api-url 'https://api.your-platform.example'
```

Native Windows is not supported. On Windows, install/use WSL2 and run the Linux command above inside the WSL2 shell.

### What the Script Does

1. Checks for `curl`, `tmux`, and Bun, installing Bun automatically when needed.
2. Registers lightweight machine metadata with the platform API.
3. Downloads the relay daemon from `/api/self-hosted/relay-daemon.js`.
4. Starts the WebSocket relay loop with automatic reconnects.

The script runs in the foreground. Use `tmux`, `screen`, systemd, or another process supervisor for long-running persistence.

### Script Options

| Option | Default | Description |
|--------|---------|-------------|
| `--record-id` | required | Machine record ID from the platform, starting with `sh_` |
| `--token` | required | Per-machine bearer token shown once at registration time |
| `--api-url` | required | Platform API base URL |
| `--host` | auto-detected | Optional hostname metadata override |

Pass the per-machine bearer token with `--token`. The raw token is shown once at registration time.

## Prerequisites

- Linux, macOS, or WSL2 on Windows
- `curl`
- `tmux`
- Bun is preferred. If Bun cannot be installed automatically, the connect script falls back to Node.js with WebSocket support and uses `--experimental-websocket` when that flag is needed and available.
- Outbound HTTPS/WebSocket access to the platform

## Security Model

When you register a self-hosted machine, the platform generates a unique per-machine bearer token. Only the token hash is stored on the platform. The raw token is shown once at registration time and is used to complete registration and authenticate the WebSocket relay connection.

The relay daemon runs as the local user who starts the script. Commands execute with that user's permissions. The platform does not install SSH keys, require root, or take ownership of the machine.

## Platform Configuration

The platform-side self-hosted configuration uses these environment variables:

| Variable | Purpose |
|----------|---------|
| `SELF_HOSTED_PUBLIC_API_URL` | Public API base URL passed to the static connect script |
| `SELF_HOSTED_PUBLIC_APP_URL` | Public frontend app base URL used for the static connect script |
| `SELF_HOSTED_CONNECT_SCRIPT_URL` | Optional full static connect script URL override |
| `SELF_HOSTED_RELAY_ENABLED` | Enable WebSocket relay, enabled by default unless set to `false` or `0` |
| `SELF_HOSTED_RELAY_HEARTBEAT_INTERVAL_MS` | Platform-to-daemon heartbeat interval, default `30000` |
| `SELF_HOSTED_RELAY_DEAD_CONNECTION_TIMEOUT_MS` | Platform timeout before closing a quiet relay socket, default `75000` |

If `SELF_HOSTED_PUBLIC_APP_URL` is unset, generated commands also accept `FRONTEND_URL` or `PUBLIC_URL`, then fall back to `WEB_APP_BASE_URL`, `CORS_ORIGIN`, and finally the production app URL.

The local relay daemon also accepts optional environment overrides:

| Variable | Purpose |
|----------|---------|
| `RELAY_HEARTBEAT_INTERVAL_MS` | Daemon-to-platform heartbeat interval, default `30000` |
| `RELAY_HEARTBEAT_TIMEOUT_MS` | Daemon timeout before closing and reconnecting a quiet socket, default `75000` |
| `RECONNECT_INITIAL_DELAY_MS` | Initial reconnect delay, default `1000` |
| `RECONNECT_MAX_DELAY_MS` | Maximum reconnect delay, default `30000` |
| `RECONNECT_BACKOFF_FACTOR` | Reconnect backoff multiplier, default `1.8` |
| `RECONNECT_JITTER_MS` | Random reconnect jitter, default `250` |

## Platform Integration

Once connected, a self-hosted machine appears alongside managed cloud servers:

- Listed with provider `self_hosted`
- Status shows online or offline relay state
- Terminal sessions and agent commands route through the WebSocket relay
- The machine can be selected as the user's default development server

## Operations

To disconnect a machine temporarily, stop the connect script. To remove it from the platform, delete the machine record; the platform unregisters the record and closes any active relay connection, but it does not shut down or otherwise modify the physical machine. If the connection drops due to a network interruption or platform restart, the daemon reconnects after a short delay while the record still exists.

For long-running manual setups:

```bash
tmux new-session -d -s infinite-agents \
  "bash <(curl -s 'https://your-app.example/connect-self-hosted.sh') --record-id sh_xxx --token shm_xxx --api-url 'https://api.your-platform.example'"
```

For production setups, run the same command under systemd or another process supervisor.
