/**
 * What the platform's own backup jobs last managed, for the Workplace screen's
 * Backups block (notes #357, #1179).
 *
 * The screen used to ask the heartbeat store for two job names typed into the
 * route, `db` and `git`. Those were the Storage Box jobs. When the backups
 * moved to R2 (note #1032) the live jobs began reporting as `db-r2` and
 * `git-r2`, the Storage Box went away on 8 Nov 2026, and the screen kept
 * reading the last report of two jobs that no longer existed: every workplace
 * was told its backups had stopped while they ran every six hours.
 *
 * So the names live HERE, once, and the writers and this reader take them from
 * the same place: a reader can no longer drift from what is actually running.
 * A job this backend does not run is not read at all, so a retired name cannot
 * speak for anything again.
 */
import type { BackupHeartbeatStore } from './backup-monitor.js';

/** One run, as the screen shows it: when, and whether it worked. */
export interface PlatformBackupRun {
  at: string;
  ok: boolean;
}

export interface PlatformBackupRuns {
  /** The database: chats, notes, proposals — every workplace's. */
  workspace?: PlatformBackupRun;
  /** The central code host's repo bundles. */
  code?: PlatformBackupRun;
}

/** The central code host's bundles into the backups bucket report under this. */
export const CENTRAL_GIT_BACKUP_JOB = 'git-r2';

/**
 * The database backup's heartbeat name. Production sets `db-r2` (it ran beside
 * the Storage Box script, which owned `db`, until the teardown); a private
 * copy sets nothing and reports as `db`.
 */
export function databaseBackupJob(env: Record<string, string | undefined>): string {
  return env.DB_BACKUP_MONITOR_JOB?.trim() || 'db';
}

export interface PlatformBackupReaderDeps {
  store: BackupHeartbeatStore;
  /** The database job's name, or undefined when this backend takes no database backups. */
  databaseJob?: string;
  /** The code job's name, or undefined when this backend bundles no repos. */
  codeJob?: string;
  /**
   * This process's own record of the database backup. A private copy has no
   * ops channel, so no staleness monitor and nothing in the heartbeat store —
   * this is the same fact its health page reads.
   */
  lastDatabaseRun?: () => PlatformBackupRun | undefined;
}

export function createPlatformBackupReader(deps: PlatformBackupReaderDeps): () => PlatformBackupRuns {
  const heartbeat = (job: string): PlatformBackupRun | undefined => {
    const beat = deps.store.get(job);
    if (!beat?.lastReportAt) return undefined;
    return { at: beat.lastReportAt, ok: beat.lastStatus !== 'fail' };
  };
  return () => {
    const runs: PlatformBackupRuns = {};
    if (deps.databaseJob) {
      const workspace = newest(heartbeat(deps.databaseJob), deps.lastDatabaseRun?.());
      if (workspace) runs.workspace = workspace;
    }
    if (deps.codeJob) {
      const code = heartbeat(deps.codeJob);
      if (code) runs.code = code;
    }
    return runs;
  };
}

function newest(a: PlatformBackupRun | undefined, b: PlatformBackupRun | undefined): PlatformBackupRun | undefined {
  if (!a || !b) return a ?? b;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
}
