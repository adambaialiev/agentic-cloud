import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import type {
  FlyIdleReaperAlert,
  FlyIdleReaperAlertStore,
} from '../fly-idle-reaper.js';

/**
 * Durable reaper throttle state: one tiny row per unrecorded app alert or
 * missing client-org connection, so a backend deploy cannot repeat either.
 */
export class SqliteFlyIdleReaperAlertStore implements FlyIdleReaperAlertStore {
  constructor(private readonly db: SqliteDb) {}

  get(appKey: string): FlyIdleReaperAlert | undefined {
    const row = this.db.prepare('SELECT doc FROM fly_idle_reaper_alerts WHERE app_key = ?')
      .get(appKey) as { doc: string } | undefined;
    return row ? deserializeDoc<FlyIdleReaperAlert>(row.doc) : undefined;
  }

  put(alert: FlyIdleReaperAlert): void {
    this.db.prepare(
      'INSERT INTO fly_idle_reaper_alerts (app_key, doc) VALUES (?, ?)'
      + ' ON CONFLICT(app_key) DO UPDATE SET doc = excluded.doc',
    ).run(alert.appKey, serializeDoc(alert));
  }
}
