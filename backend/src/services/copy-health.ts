/**
 * A private copy's own health, for its admin (note #813, stage 3 piece 3 of
 * note #811): one plain line per part of the copy — the Workspace and its
 * release, the database and its backups, the disk, the code host, previews and
 * sites, mail in — each asked live, never remembered. And the diagnostics
 * bundle: the same report plus which settings are set, as a file the admin
 * downloads and sends us only if they choose to. Nothing here calls us.
 *
 * Neither holds a message, a file, a key or a person's name: settings that
 * are keys say only "set" or "not set".
 */
import { stat, statfs } from 'node:fs/promises';
import type { WorkspaceCopyHealth, WorkspaceCopyHealthPart } from '../shared/workspace-api.js';
import type { LicenceStatus } from './copy-licence.js';

export type CopyHealthPart = WorkspaceCopyHealthPart;
export type CopyHealthReport = WorkspaceCopyHealth;

export interface CopyHealthOptions {
  release?: string;
  commit?: string;
  startedAt: Date;
  dbPath?: string;
  /** The disk the database lives on. */
  dataDir?: string;
  /** The last scheduled database backup, when backups are set up. */
  lastDbBackup?: () => { at: string; ok: boolean; detail?: string } | undefined;
  backupEveryHours?: number;
  gitHealthUrl?: string;
  routerHealthUrl?: string;
  mailHealthUrl?: string;
  env: Record<string, string | undefined>;
  /** The licence, when the copy has the check on (note #814). */
  licence?: () => Promise<LicenceStatus>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** Settings a diagnostics bundle shows whole: names, places and images. */
const PLAIN_SETTINGS = [
  'COPY_RELEASE', 'WORKSPACE_URL', 'APPS_DOMAIN', 'MAIL_DOMAIN', 'PRIVATE_COPY', 'FLY_ORG', 'FLY_REGION',
  'FLY_IMAGE_APP', 'FLY_MACHINE_IMAGE', 'FLY_APP_RUNTIME_IMAGE', 'FLY_GIT_HOST_IMAGE', 'FLY_MSG_HOST_IMAGE',
  'GIT_HOST_BASE_URL', 'GIT_HOST_CONTROL_URL', 'FLY_BACKEND_PEER_IP', 'WORKSPACE_EMAIL_FROM', 'FLY_APP_NAME',
  'SMTP_HOST', 'SMTP_PORT',
] as const;
/** Settings that are keys: a bundle says only whether each is there. */
const KEY_SETTINGS = [
  'FLY_API_TOKEN', 'FLY_SSH_PRIVATE_KEY', 'FLY_SSH_PUBLIC_KEY', 'SECRETS_MASTER_KEY', 'GIT_HOST_SECRET',
  'CI_STATUS_SECRET', 'MAIL_INGEST_SECRET', 'FIRST_ACCOUNT_CODE', 'RESEND_API_KEY', 'RESEND_MAIL_API_KEY',
  'SMTP_USER', 'SMTP_PASSWORD',
  'MEDIA_S3_ENDPOINT', 'MEDIA_S3_BUCKET', 'MEDIA_S3_ACCESS_KEY_ID', 'MEDIA_S3_SECRET_ACCESS_KEY',
  'BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY',
] as const;

const megabytes = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

export function sinceWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function upWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

export function createCopyHealth(options: CopyHealthOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  /** One part's own health answer, or why there was none. */
  const ask = async (url: string): Promise<{ json?: Record<string, unknown>; error?: string }> => {
    try {
      // The code host sleeps when idle; asking wakes it, which takes seconds.
      const answer = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      if (!answer.ok) return { error: `answered ${answer.status}` };
      return { json: await answer.json() as Record<string, unknown> };
    } catch (error) {
      return { error: error instanceof Error && error.name === 'TimeoutError' ? 'no answer in 20 s' : 'not reachable' };
    }
  };

  async function workspace(): Promise<CopyHealthPart> {
    const release = options.release ? `release ${options.release}` : 'release unknown';
    const commit = options.commit ? ` (${options.commit.slice(0, 8)})` : '';
    return { key: 'workspace', name: 'Workspace', ok: true, line: `Up ${upWords(now().getTime() - options.startedAt.getTime())} · ${release}${commit}` };
  }

  async function database(): Promise<CopyHealthPart> {
    const size = options.dbPath ? await stat(options.dbPath).then((s) => megabytes(s.size)).catch(() => null) : null;
    const prefix = size ? `${size} · ` : '';
    const last = options.lastDbBackup?.();
    const every = options.backupEveryHours ?? 24;
    if (!options.lastDbBackup) return { key: 'database', name: 'Database', ok: false, line: `${prefix}no backups: the backup bucket is not set up` };
    if (!last) {
      const sinceStart = now().getTime() - options.startedAt.getTime();
      return {
        key: 'database', name: 'Database', ok: sinceStart < 30 * 60_000,
        line: `${prefix}${sinceStart < 30 * 60_000 ? 'first backup within 10 min of start' : 'no backup since the last start'}`,
      };
    }
    const age = now().getTime() - new Date(last.at).getTime();
    if (!last.ok) return { key: 'database', name: 'Database', ok: false, line: `${prefix}last backup failed ${sinceWords(age)}${last.detail ? `: ${last.detail}` : ''}` };
    const overdue = age > 2 * every * 3600_000;
    return { key: 'database', name: 'Database', ok: !overdue, line: `${prefix}backed up ${sinceWords(age)} · every ${every} h` };
  }

  async function disk(): Promise<CopyHealthPart> {
    if (!options.dataDir) return { key: 'disk', name: 'Disk', ok: true, line: 'not measured here' };
    try {
      const s = await statfs(options.dataDir);
      const total = s.blocks * s.bsize;
      const used = total - s.bavail * s.bsize;
      const percent = total ? Math.round((used / total) * 100) : 0;
      return { key: 'disk', name: 'Disk', ok: percent < 85, line: `${percent}% of ${megabytes(total)} used` };
    } catch {
      return { key: 'disk', name: 'Disk', ok: false, line: 'could not be read' };
    }
  }

  async function codeHost(): Promise<CopyHealthPart | null> {
    if (!options.gitHealthUrl) return null;
    const { json, error } = await ask(options.gitHealthUrl);
    if (!json?.ok) return { key: 'code-host', name: 'Code host', ok: false, line: error ? `not answering (${error})` : 'answering, but not well' };
    const used = typeof json.diskUsedPercent === 'number' ? json.diskUsedPercent : null;
    return { key: 'code-host', name: 'Code host', ok: used === null || used < 85, line: `answering${used === null ? '' : ` · disk ${used}% used`}` };
  }

  async function previews(): Promise<CopyHealthPart | null> {
    if (!options.routerHealthUrl) return null;
    const { json, error } = await ask(options.routerHealthUrl);
    return json?.ok
      ? { key: 'previews', name: 'Previews and sites', ok: true, line: 'answering, certificate good' }
      : { key: 'previews', name: 'Previews and sites', ok: false, line: `not answering (${error ?? 'unexpected answer'})` };
  }

  async function mailIn(): Promise<CopyHealthPart | null> {
    if (!options.mailHealthUrl) return null;
    const { json, error } = await ask(options.mailHealthUrl);
    if (!json?.ok) return { key: 'mail-in', name: 'Mail in', ok: false, line: `not answering (${error ?? 'unexpected answer'})` };
    return json.starttls
      ? { key: 'mail-in', name: 'Mail in', ok: true, line: 'answering, encryption on' }
      : { key: 'mail-in', name: 'Mail in', ok: false, line: 'answering, but no certificate yet: mail arrives unencrypted' };
  }

  async function licence(): Promise<CopyHealthPart | null> {
    if (!options.licence) return null;
    const status = await options.licence();
    return { key: 'licence', name: 'Licence', ok: status.state === 'valid' && !status.overLimit, line: status.short };
  }

  async function report(): Promise<CopyHealthReport> {
    const parts = await Promise.all([workspace(), licence(), database(), disk(), codeHost(), previews(), mailIn()]);
    return {
      release: options.release ?? null,
      commit: options.commit ?? null,
      checkedAt: now().toISOString(),
      parts: parts.filter((part): part is CopyHealthPart => part !== null),
    };
  }

  /** What the admin may send us: the report and how the copy is set up. */
  async function diagnostics() {
    const env = options.env;
    return {
      kind: 'acc-copy-diagnostics',
      format: 1,
      generatedAt: now().toISOString(),
      about: 'Made by this copy for its admin to send to support. It holds no messages, code, files, mail, keys or names of people: settings that are keys say only whether they are set.',
      health: await report(),
      settings: {
        ...Object.fromEntries(PLAIN_SETTINGS.map((name) => [name, env[name] ?? null])),
        ...Object.fromEntries(KEY_SETTINGS.map((name) => [name, env[name] ? 'set' : 'not set'])),
      },
      // The usage report a licence renewal is settled from (note #814).
      ...(options.licence ? { licence: await options.licence().then((status) => ({
        id: status.licence?.id ?? null,
        state: status.state,
        licensedPeople: status.licence?.people ?? null,
        people: status.people,
        peakPeople: status.peakPeople,
        ends: status.licence?.ends ?? null,
      })) } : {}),
      runtime: {
        node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        memoryMB: Math.round(process.memoryUsage().rss / 1e6),
      },
    };
  }

  return { report, diagnostics };
}

export type CopyHealth = ReturnType<typeof createCopyHealth>;
