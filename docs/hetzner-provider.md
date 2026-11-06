# Hetzner Cloud Provider Integration

> Status (2026-11-06): history. Nothing in the backend imports `services/hetzner-client.ts` any more and the managed-server tools below no longer exist. Agents' machines and sites run on Fly machines (`services/fly-client.ts`).

This backend provisions managed cloud servers on Hetzner Cloud.

## Environment

Required:

- `HETZNER_API_TOKEN`: Hetzner Cloud project API token.

Optional runtime selection:

- `MANAGED_SERVER_PROVIDER=hetzner`: use Hetzner for default development sandbox provisioning.
- `CLOUD_SERVER_PROVIDER=hetzner`: fallback alias for the same runtime selection.

Optional Hetzner sandbox defaults:

- `HETZNER_SANDBOX_LOCATION`: default Hetzner location, default `nbg1`.
- `HETZNER_SANDBOX_SERVER_TYPE`: default server type, default `cpx22`.
- `HETZNER_SANDBOX_IMAGE`: default image, default `ubuntu-24.04`.
- `HETZNER_SANDBOX_SSH_KEY_NAME`: name used when uploading the configured SSH public key.
- `HETZNER_SSH_PRIVATE_KEY`, `HETZNER_SSH_PUBLIC_KEY`, `HETZNER_SSH_PASSPHRASE`, `HETZNER_SSH_USERNAME`, `HETZNER_SSH_PORT`: SSH settings.

## Tool Usage

The generic managed server tools accept `provider: "hetzner"`:

- `list-servers`
- `list-server-sizes`
- `create-server`
- `upgrade-server`
- `delete-server`

Provider-specific mapping:

- Platform `size` maps to Hetzner `server_type`.
- Platform `region` maps to Hetzner `location`.
- Supported locations are `fsn1`, `nbg1`, `hel1`, `ash`, `hil`, and `sin`.
- Tags are stored in the platform managed-server record. During create, sanitized tags are also written as Hetzner labels under `infinite-agents/tag-*`.

## Limitations

- Existing storage fields still use legacy names such as `serverId`; for Hetzner this means provider server id.
- Hetzner resize uses `change_type`; `disk: true` requests permanent disk growth through `upgrade_disk`.
- The Hetzner Cloud API rate limit is 3,600 requests per hour. The implementation uses normal paginated REST calls and action polling.
