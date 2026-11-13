import { describe, expect, it } from 'vitest';
import { InMemoryBackupHeartbeatStore } from '../../services/backup-monitor.js';
import {
  CENTRAL_GIT_BACKUP_JOB,
  createPlatformBackupReader,
  databaseBackupJob,
} from '../../services/platform-backup-runs.js';

/**
 * Note #1179: the Workplace screen read the Storage Box jobs (`db`, `git`) for
 * five days after they were torn down, and told every workplace its backups
 * had stopped. These pin the reader to the jobs a backend really runs.
 */
describe('what the platform’s own backups last managed', () => {
  const ok = (store: InMemoryBackupHeartbeatStore, job: string, at: string) =>
    store.put({ job, watchingSince: '2026-08-12T00:00:00.000Z', lastReportAt: at, lastSuccessAt: at, lastStatus: 'ok' });

  /** The heartbeat store as production held it on 13 Nov 2026. */
  function productionStore() {
    const store = new InMemoryBackupHeartbeatStore();
    ok(store, 'db', '2026-11-07T03:59:39.295Z');
    ok(store, 'git', '2026-11-06T15:47:17.027Z');
    ok(store, 'db-r2', '2026-11-13T07:34:16.978Z');
    ok(store, 'git-r2', '2026-11-13T00:34:52.292Z');
    ok(store, 'media', '2026-11-12T13:54:02.896Z');
    return store;
  }

  it('names the database job the way the job itself reports', () => {
    expect(databaseBackupJob({ DB_BACKUP_MONITOR_JOB: 'db-r2' })).toBe('db-r2');
    expect(databaseBackupJob({ DB_BACKUP_MONITOR_JOB: '  db-r2 ' })).toBe('db-r2');
    // A private copy sets nothing.
    expect(databaseBackupJob({})).toBe('db');
    expect(databaseBackupJob({ DB_BACKUP_MONITOR_JOB: ' ' })).toBe('db');
    expect(CENTRAL_GIT_BACKUP_JOB).toBe('git-r2');
  });

  it('on our platform, reads the R2 jobs and never the retired Storage Box ones', () => {
    const read = createPlatformBackupReader({
      store: productionStore(),
      databaseJob: databaseBackupJob({ DB_BACKUP_MONITOR_JOB: 'db-r2' }),
      codeJob: CENTRAL_GIT_BACKUP_JOB,
    });
    expect(read()).toEqual({
      workspace: { at: '2026-11-13T07:34:16.978Z', ok: true },
      code: { at: '2026-11-13T00:34:52.292Z', ok: true },
    });
  });

  it('in an own cloud with no ops channel, reads the database run the process recorded', () => {
    // No monitor there, so the store stays empty; the copy's health page reads
    // the same in-process record.
    const read = createPlatformBackupReader({
      store: new InMemoryBackupHeartbeatStore(),
      databaseJob: databaseBackupJob({}),
      lastDatabaseRun: () => ({ at: '2026-11-13T04:00:00.000Z', ok: true }),
    });
    expect(read()).toEqual({ workspace: { at: '2026-11-13T04:00:00.000Z', ok: true } });
  });

  it('in an own cloud that does report to a monitor, reads its `db` job', () => {
    const store = new InMemoryBackupHeartbeatStore();
    ok(store, 'db', '2026-11-13T04:00:00.000Z');
    const read = createPlatformBackupReader({ store, databaseJob: databaseBackupJob({}) });
    expect(read()).toEqual({ workspace: { at: '2026-11-13T04:00:00.000Z', ok: true } });
  });

  it('takes the newer of the store and the process’s own record, failures included', () => {
    const store = new InMemoryBackupHeartbeatStore();
    ok(store, 'db-r2', '2026-11-13T01:00:00.000Z');
    const failedLater = createPlatformBackupReader({
      store, databaseJob: 'db-r2',
      lastDatabaseRun: () => ({ at: '2026-11-13T07:00:00.000Z', ok: false }),
    });
    expect(failedLater().workspace).toEqual({ at: '2026-11-13T07:00:00.000Z', ok: false });
    const olderInMemory = createPlatformBackupReader({
      store, databaseJob: 'db-r2',
      lastDatabaseRun: () => ({ at: '2026-11-12T19:00:00.000Z', ok: true }),
    });
    expect(olderInMemory().workspace).toEqual({ at: '2026-11-13T01:00:00.000Z', ok: true });
  });

  it('passes a failed report through as failed', () => {
    const store = new InMemoryBackupHeartbeatStore();
    store.put({ job: 'git-r2', watchingSince: 't', lastReportAt: '2026-11-13T00:34:00.000Z', lastStatus: 'fail', lastSuccessAt: '2026-11-12T00:34:00.000Z' });
    const read = createPlatformBackupReader({ store, codeJob: CENTRAL_GIT_BACKUP_JOB });
    expect(read()).toEqual({ code: { at: '2026-11-13T00:34:00.000Z', ok: false } });
  });

  it('claims nothing for a job this backend does not run, whatever the store remembers', () => {
    const read = createPlatformBackupReader({ store: productionStore() });
    expect(read()).toEqual({});
  });
});
