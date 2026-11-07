import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import type { CopyAlertCondition, CopyPulse, CopyPulseDay, CopyPulseRecord, StoredCopyPulse } from '../../shared/copy-pulse.js';
import { COPY_HISTORY_DAYS, pulseDay, storedPulse, type CopyPulseStore } from '../copy-pulse-storage.js';

/** The pulses of private copies, on disk (copy-pulse-storage.ts says what each table is for). */
export class SqliteCopyPulseStore implements CopyPulseStore {
  constructor(private readonly db: SqliteDb) {}

  async record(pulse: CopyPulse, receivedAt: string): Promise<CopyPulseRecord> {
    const stored = storedPulse(pulse, receivedAt);
    const doc = serializeDoc(stored);
    this.db.transaction(() => {
      this.db.prepare(
        'INSERT INTO copy_pulses (copy_id, first_seen_at, last_seen_at, doc) VALUES (?, ?, ?, ?)'
        + ' ON CONFLICT(copy_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, doc = excluded.doc',
      ).run(pulse.copyId, stored.receivedAt, stored.receivedAt, doc);
      this.db.prepare(
        'INSERT INTO copy_pulse_days (copy_id, day, last_seen_at, doc) VALUES (?, ?, ?, ?)'
        + ' ON CONFLICT(copy_id, day) DO UPDATE SET last_seen_at = excluded.last_seen_at, doc = excluded.doc',
      ).run(pulse.copyId, pulseDay(stored.receivedAt), stored.receivedAt, doc);
    })();
    return (await this.get(pulse.copyId))!;
  }

  async list(): Promise<CopyPulseRecord[]> {
    const rows = this.db.prepare('SELECT copy_id, first_seen_at, last_seen_at, doc FROM copy_pulses').all() as Row[];
    return rows.map(toRecord);
  }

  async get(copyId: string): Promise<CopyPulseRecord | null> {
    const row = this.db.prepare('SELECT copy_id, first_seen_at, last_seen_at, doc FROM copy_pulses WHERE copy_id = ?').get(copyId) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  async days(copyId: string, limit = COPY_HISTORY_DAYS): Promise<CopyPulseDay[]> {
    const rows = this.db.prepare('SELECT copy_id, day, last_seen_at, doc FROM copy_pulse_days WHERE copy_id = ? ORDER BY day DESC LIMIT ?')
      .all(copyId, limit) as Array<{ copy_id: string; day: string; last_seen_at: string; doc: string }>;
    return rows.map((row) => ({ copyId: row.copy_id, day: row.day, lastSeenAt: row.last_seen_at, pulse: deserializeDoc<StoredCopyPulse>(row.doc) }));
  }

  async alerts(copyId: string): Promise<Partial<Record<CopyAlertCondition, string>>> {
    const rows = this.db.prepare('SELECT condition, raised_at FROM copy_pulse_alerts WHERE copy_id = ?').all(copyId) as Array<{ condition: CopyAlertCondition; raised_at: string }>;
    return Object.fromEntries(rows.map((row) => [row.condition, row.raised_at]));
  }

  async setAlert(copyId: string, condition: CopyAlertCondition, raisedAt: string | null): Promise<void> {
    if (raisedAt) {
      this.db.prepare('INSERT INTO copy_pulse_alerts (copy_id, condition, raised_at) VALUES (?, ?, ?) ON CONFLICT(copy_id, condition) DO UPDATE SET raised_at = excluded.raised_at')
        .run(copyId, condition, raisedAt);
    } else {
      this.db.prepare('DELETE FROM copy_pulse_alerts WHERE copy_id = ? AND condition = ?').run(copyId, condition);
    }
  }
}

interface Row { copy_id: string; first_seen_at: string; last_seen_at: string; doc: string }
const toRecord = (row: Row): CopyPulseRecord => ({
  copyId: row.copy_id, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, pulse: deserializeDoc<StoredCopyPulse>(row.doc),
});
