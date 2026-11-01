/**
 * Fly sandbox-id codec.
 *
 * A Fly-backed sandbox is addressed by BOTH its per-user app and its machine:
 * the Machines API is keyed `POST /apps/{app}/machines/{id}`, so — unlike the
 * Hetzner path, where a bare numeric server id is enough — the sandbox id has to
 * carry the app slug alongside the machine id. It is the self-contained handle
 * every runtime method (`getSandbox`, `execSync`, wake-on-connect, …) parses to
 * reach the right machine, exactly as `hcloud-sandbox-<id>` is for Hetzner.
 *
 * Encoding: `fly-sandbox-<app>.<machineId>`.
 * - App slugs are DNS-safe (`[a-z][a-z0-9-]*`) and never contain a dot.
 * - Machine ids are lowercase hex (`[0-9a-f]+`), also dot-free.
 * So a single `.` unambiguously separates the two halves.
 *
 * The persisted `serverId` on an agent/server record uses the record form
 * `fly_<app>.<machineId>` (mirroring Hetzner's `hcloud_<id>`), which
 * {@link parseFlyServerRecordId} converts back into a sandbox id.
 *
 * This module is intentionally dependency-free so both the sandbox client and
 * the id-resolution seam (telegram-agent-service, user-sandbox-manager) can
 * import it without dragging in the HTTP client.
 */

const APP_SEGMENT = '[a-z][a-z0-9-]*';
const MACHINE_SEGMENT = '[0-9a-f]+';

const SANDBOX_ID_PATTERN = new RegExp(`^fly-sandbox-(${APP_SEGMENT})\\.(${MACHINE_SEGMENT})$`);
const RECORD_ID_PATTERN = new RegExp(`^fly_(${APP_SEGMENT})\\.(${MACHINE_SEGMENT})$`);

export interface FlySandboxTarget {
  appName: string;
  machineId: string;
}

export function buildFlySandboxId(appName: string, machineId: string): string {
  return `fly-sandbox-${appName}.${machineId}`;
}

export function parseFlySandboxId(sandboxId: string | null | undefined): FlySandboxTarget | null {
  const match = SANDBOX_ID_PATTERN.exec((sandboxId ?? '').trim());
  if (!match) {
    return null;
  }
  return { appName: match[1], machineId: match[2] };
}

export function isFlySandboxId(sandboxId: string | null | undefined): boolean {
  return parseFlySandboxId(sandboxId) !== null;
}

/** Record-id form persisted on agent/server records, e.g. `fly_<app>.<machine>`. */
export function buildFlyServerRecordId(appName: string, machineId: string): string {
  return `fly_${appName}.${machineId}`;
}

/**
 * Extract the app + machine from a stored `serverId`, accepting either the
 * record form (`fly_<app>.<machine>`) or a sandbox id
 * (`fly-sandbox-<app>.<machine>`). Returns null when it isn't a Fly id.
 * The app slug is what gives an agent its stable public URL
 * (`https://<app>.fly.dev`).
 */
export function parseFlyServerRecordTarget(
  serverRecordId: string | null | undefined,
): FlySandboxTarget | null {
  const trimmed = (serverRecordId ?? '').trim();
  if (!trimmed) {
    return null;
  }
  const alreadySandboxId = parseFlySandboxId(trimmed);
  if (alreadySandboxId) {
    return alreadySandboxId;
  }
  const recordMatch = RECORD_ID_PATTERN.exec(trimmed);
  if (!recordMatch) {
    return null;
  }
  return { appName: recordMatch[1], machineId: recordMatch[2] };
}

/**
 * Resolve a stored `serverId` into a Fly sandbox id, accepting either the
 * record form (`fly_<app>.<machine>`) or an already-built sandbox id
 * (`fly-sandbox-<app>.<machine>`). Returns null when it isn't a Fly id.
 */
export function parseFlyServerRecordId(serverRecordId: string | null | undefined): string | null {
  const trimmed = (serverRecordId ?? '').trim();
  if (!trimmed) {
    return null;
  }

  const alreadySandboxId = parseFlySandboxId(trimmed);
  if (alreadySandboxId) {
    return buildFlySandboxId(alreadySandboxId.appName, alreadySandboxId.machineId);
  }

  const recordMatch = RECORD_ID_PATTERN.exec(trimmed);
  if (!recordMatch) {
    return null;
  }
  return buildFlySandboxId(recordMatch[1], recordMatch[2]);
}
