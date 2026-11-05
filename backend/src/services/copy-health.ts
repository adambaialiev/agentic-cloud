/**
 * A private copy's own health, for its admin (note #813, stage 3 piece 3 of
 * note #811): one plain line per part of the copy — the Workspace and its
 * release, the database and its backups, the disk, the code host, previews and
 * sites, mail in — each asked live, never remembered. And the diagnostics
 * bundle: the same report plus which settings are set, as a file the admin
 * downloads and sends us only if they choose to.
 *
 * The one thing it asks outside the copy is our update service's public
 * release list (note #1005, services/copy-release-check.ts): a plain GET with
 * nothing about the copy in it, about once an hour, so the Workspace line can
 * say whether a newer release is out. COPY_UPDATES_URL=off turns it off.
 *
 * Neither holds a message, a file, a key or a person's name: settings that
 * are keys say only "set" or "not set".
 */
import { stat, statfs } from 'node:fs/promises';
import type { WorkspaceCopyHealth, WorkspaceCopyHealthPart, WorkspaceCopyRelease, WorkspaceCopyReleases, WorkspaceCopyUpdates } from '../shared/workspace-api.js';
import type { LicenceStatus } from './copy-licence.js';
import { compareReleases, RELEASE_VERSION_SHAPE, type ReleaseCheck, type ReleaseCheckState } from './copy-release-check.js';

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
  /** Email's state, read live: a copy installs without it and an admin sets
   *  it up later (note #946). With it, mailHealthUrl is not used. */
  mail?: () => { phase: 'off' | 'provider' | 'records' | 'on'; healthUrl: string | null };
  env: Record<string, string | undefined>;
  /** The licence, when the copy has the check on (note #814). */
  licence?: () => Promise<LicenceStatus>;
  /** Whether a newer release is out (note #1005); absent reads as off. */
  updates?: Pick<ReleaseCheck, 'current'> & Partial<Pick<ReleaseCheck, 'notes'>>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** Settings a diagnostics bundle shows whole: names, places and images. */
const PLAIN_SETTINGS = [
  'COPY_RELEASE', 'WORKSPACE_URL', 'APPS_DOMAIN', 'MAIL_DOMAIN', 'PRIVATE_COPY', 'FLY_ORG', 'FLY_REGION',
  'FLY_IMAGE_APP', 'FLY_MACHINE_IMAGE', 'FLY_APP_RUNTIME_IMAGE', 'FLY_GIT_HOST_IMAGE', 'FLY_MSG_HOST_IMAGE',
  'GIT_HOST_BASE_URL', 'GIT_HOST_CONTROL_URL', 'FLY_BACKEND_PEER_IP', 'WORKSPACE_EMAIL_FROM', 'FLY_APP_NAME',
  'SMTP_HOST', 'SMTP_PORT', 'COPY_UPDATES_URL',
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

/** The upgrade, as it is done today (the guide's "Later: upgrades"). */
export const HOW_TO_UPGRADE = 'To upgrade, whoever installed this Agentic Cloud runs node install.mjs upgrade in the folder they installed it from.';
/** A last good answer older than this no longer says what is latest. */
const LATEST_GOOD_FOR_MS = 24 * 3600_000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 5 Nov 2026, 13:02 UTC */
export function whenWords(iso: string): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

/**
 * Running beside latest (note #1005): the state, and the words the
 * Workspace line ends with. Pure, so every state is tested on its own.
 */
export function releaseStanding(
  running: string | null,
  check: ReleaseCheckState | null,
  at: Date,
  startedAt: Date,
): { updates: WorkspaceCopyUpdates; words: string } {
  const base = {
    running,
    latest: null as string | null,
    reachedAt: check?.reachedAt ?? null,
    triedAt: check?.triedAt ?? null,
    lastError: check?.lastError ?? null,
    howToUpgrade: null as string | null,
  };
  if (!check || !check.on) return { updates: { ...base, state: 'off' }, words: 'update checks are off' };
  const reached = check.reachedAt ? new Date(check.reachedAt).getTime() : null;
  if (reached === null || at.getTime() - reached > LATEST_GOOD_FOR_MS) {
    const since = whenWords(check.reachedAt ?? startedAt.toISOString());
    const words = check.triedAt ? `latest unknown, update service not reached since ${since}` : 'latest not asked yet';
    return { updates: { ...base, state: 'unknown' }, words };
  }
  const latest = check.latest;
  // A failed ask since the last good answer: say how old the answer is.
  const asOf = check.lastError ? ` (as of ${sinceWords(at.getTime() - reached)})` : '';
  if (!latest) return { updates: { ...base, state: 'unknown' }, words: 'latest unknown, the update service lists no release' };
  if (!running || !RELEASE_VERSION_SHAPE.test(running)) {
    return { updates: { ...base, latest, state: 'unknown' }, words: `latest ${latest}${asOf}` };
  }
  if (compareReleases(latest, running) > 0) {
    return { updates: { ...base, latest, state: 'behind', howToUpgrade: HOW_TO_UPGRADE }, words: `latest ${latest}${asOf}` };
  }
  return { updates: { ...base, latest, state: 'current' }, words: `latest ${latest}${asOf}` };
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

  async function standing() {
    const check = options.updates ? await options.updates.current() : null;
    return releaseStanding(options.release ?? null, check, now(), options.startedAt);
  }

  async function workspace(words: string): Promise<CopyHealthPart> {
    const release = options.release ? `release ${options.release}` : 'release unknown';
    const commit = options.commit ? ` (${options.commit.slice(0, 8)})` : '';
    return { key: 'workspace', name: 'Workspace', ok: true, line: `Up ${upWords(now().getTime() - options.startedAt.getTime())} · ${release}${commit} · ${words}` };
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
    const mail = options.mail?.();
    if (mail && mail.phase !== 'on' && mail.phase !== 'records') {
      // Not a fault: email is optional, and set up from the Mail section.
      return { key: 'mail-in', name: 'Mail in', ok: true, line: mail.phase === 'provider' ? 'being set up: the mail receiver is not made yet' : 'not set up: an admin can set it up under Mail' };
    }
    const url = mail ? mail.healthUrl : options.mailHealthUrl;
    if (!url) return null;
    const { json, error } = await ask(url);
    if (mail?.phase === 'records' && !json?.ok) return { key: 'mail-in', name: 'Mail in', ok: false, line: `being set up: the mail receiver is starting (${error ?? 'unexpected answer'})` };
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
    const { updates, words } = await standing();
    const parts = await Promise.all([workspace(words), licence(), database(), disk(), codeHost(), previews(), mailIn()]);
    return {
      release: options.release ?? null,
      commit: options.commit ?? null,
      running: updates.running,
      latest: updates.latest,
      updates,
      checkedAt: now().toISOString(),
      parts: parts.filter((part): part is CopyHealthPart => part !== null),
    };
  }

  /**
   * The What's new screen (note #1006): every release newer than the one
   * running, newest first, then the running one ("what this release
   * brought"), each with its notes. With the running release unknown, the
   * latest alone.
   */
  async function releases(): Promise<WorkspaceCopyReleases> {
    const check = options.updates ? await options.updates.current() : null;
    const { updates } = releaseStanding(options.release ?? null, check, now(), options.startedAt);
    const running = options.release && RELEASE_VERSION_SHAPE.test(options.release) ? options.release : null;
    const listed = check?.releases ?? [];
    const picked = running
      ? listed.filter((entry) => compareReleases(entry.version, running) > 0)
      : listed.filter((entry) => entry.version === check?.latest);
    const shown = [...picked].sort((a, b) => compareReleases(b.version, a.version));
    if (running) shown.push(listed.find((entry) => entry.version === running) ?? { version: running, date: null });
    const notes = await Promise.all(shown.map((entry) => options.updates?.notes?.(entry.version) ?? Promise.resolve(null)));
    return {
      updates,
      releases: shown.map((entry, i): WorkspaceCopyRelease => ({
        version: entry.version,
        date: entry.date ?? null,
        summary: entry.summary ?? null,
        notes: notes[i] ?? null,
        running: entry.version === running,
      })),
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
      ...await report().then((health) => ({ running: health.running, latest: health.latest, health })),
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

  return { report, diagnostics, releases };
}

export type CopyHealth = ReturnType<typeof createCopyHealth>;
