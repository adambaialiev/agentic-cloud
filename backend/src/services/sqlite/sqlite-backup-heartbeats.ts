import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import type { BackupHeartbeat, BackupHeartbeatStore } from '../backup-monitor.js';

/**
 * Durable store for the backup monitor. Two rows, written once a night — the
 * reason it is on disk at all is that "when did this last work?" has to
 * survive a restart. An in-memory monitor would come up after every deploy
 * believing both jobs had just checked in.
 */
export class SqliteBackupHeartbeatStore implements BackupHeartbeatStore {
  constructor(private readonly db: SqliteDb) {}

  get(job: string): BackupHeartbeat | undefined {
    const row = this.db.prepare('SELECT doc FROM backup_heartbeats WHERE job = ?')
      .get(job) as { doc: string } | undefined;
    return row ? deserializeDoc<BackupHeartbeat>(row.doc) : undefined;
  }

  put(heartbeat: BackupHeartbeat): void {
    this.db.prepare(
      'INSERT INTO backup_heartbeats (job, doc) VALUES (?, ?)'
      + ' ON CONFLICT(job) DO UPDATE SET doc = excluded.doc',
    ).run(heartbeat.job, serializeDoc(heartbeat));
  }

  list(): BackupHeartbeat[] {
    const rows = this.db.prepare('SELECT doc FROM backup_heartbeats').all() as { doc: string }[];
    return rows.map((row) => deserializeDoc<BackupHeartbeat>(row.doc));
  }
}
