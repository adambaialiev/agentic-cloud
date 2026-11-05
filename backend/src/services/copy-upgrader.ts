/**
 * The upgrader's home in a company's own Agentic Cloud (note #1008, designed
 * on note #1007). An upgrade runs on a one-shot machine in the app
 * `<prefix>-upgrader`, outside every app it rolls, so it can put the old
 * release back even when the new Workspace is what broke. That machine needs
 * two things only the Workspace holds: the organization's Fly token and the
 * backup bucket's keys (its run record lives there). At every start the
 * Workspace makes the app if it is missing and sets those as the app's
 * secrets; the installer's `upgrade` command (and, later, the Workspace's own
 * Upgrade button) then starts the machine there.
 *
 * Nothing here logs a value: Fly's secrets call answers with the value it
 * stored, so its body is never read (FlyClient.setAppSecret).
 */
import type { FlyClient } from './fly-client.js';

/** The app the upgrader runs in, named from the copy's prefix. */
export const upgraderAppName = (prefix: string) => `${prefix}-upgrader`;

/** What the upgrader machine is given, by name, from the backend's own environment. */
export const UPGRADER_SECRET_NAMES = [
  'FLY_API_TOKEN',
  'BACKUP_S3_ENDPOINT',
  'BACKUP_S3_BUCKET',
  'BACKUP_S3_ACCESS_KEY_ID',
  'BACKUP_S3_SECRET_ACCESS_KEY',
] as const;

export interface EnsureCopyUpgraderOptions {
  prefix: string;
  org: string;
  env: Record<string, string | undefined>;
  fly: Pick<FlyClient, 'getApp' | 'createApp' | 'setAppSecret'>;
  log?: (line: string) => void;
}

export type EnsureCopyUpgraderResult =
  | { ok: true; app: string; created: boolean }
  | { ok: false; app: string; reason: string };

export async function ensureCopyUpgrader(options: EnsureCopyUpgraderOptions): Promise<EnsureCopyUpgraderResult> {
  const app = upgraderAppName(options.prefix);
  const log = options.log ?? ((line: string) => console.log(line));
  const missing = UPGRADER_SECRET_NAMES.filter((name) => !options.env[name]?.trim());
  if (missing.length) {
    // Without the bucket there is nowhere to keep a run record, and without the
    // token nothing to deploy with: the command then runs the upgrade itself.
    const reason = `not set up: this backend has no ${missing.join(', ')}`;
    log(`[copy-upgrader] ${app} ${reason}`);
    return { ok: false, app, reason };
  }
  let created = false;
  const exists = await options.fly.getApp(app).then(() => true, (error: { status?: number }) => {
    if (error?.status === 404) return false;
    throw error;
  });
  if (!exists) {
    await options.fly.createApp({ appName: app, orgSlug: options.org });
    created = true;
  }
  // Set every start, so a rotated token or bucket key reaches the next
  // upgrade. The app has no standing machine, so nothing restarts.
  for (const name of UPGRADER_SECRET_NAMES) {
    await options.fly.setAppSecret(app, name, options.env[name]!.trim());
  }
  log(`[copy-upgrader] ${app} ${created ? 'made' : 'ready'}: ${UPGRADER_SECRET_NAMES.length} secrets set`);
  return { ok: true, app, created };
}
