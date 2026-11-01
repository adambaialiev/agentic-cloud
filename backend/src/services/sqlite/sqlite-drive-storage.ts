import type { DriveEntries, DriveEntry, DriveStorage } from '../drive-storage.js';
import type { SqliteDb } from './sqlite-db.js';

export class SqliteDriveStorage implements DriveStorage {
  constructor(private readonly db: SqliteDb) {}
  private snapshot(orgId: string): DriveEntries {
    const rows = this.db.prepare('SELECT doc FROM drive_items WHERE org_id = ?').all(orgId) as { doc: string }[];
    return new Map(rows.map(({ doc }) => { const item = JSON.parse(doc) as DriveEntry; return [item.id, item]; }));
  }
  async read(orgId: string): Promise<DriveEntries> { return this.snapshot(orgId); }
  async change<T>(orgId: string, update: (entries: DriveEntries) => T): Promise<T> {
    // The lock covers both the ancestry checks and writes. Two moves cannot
    // each validate against the old tree and then create a cycle together.
    return this.db.transaction(() => {
      const entries = this.snapshot(orgId);
      const before = new Map([...entries].map(([id, item]) => [id, JSON.stringify(item)]));
      const answer = update(entries);
      const save = this.db.prepare('INSERT INTO drive_items (org_id, item_id, doc) VALUES (?, ?, ?) ON CONFLICT (org_id, item_id) DO UPDATE SET doc = excluded.doc');
      const remove = this.db.prepare('DELETE FROM drive_items WHERE org_id = ? AND item_id = ?');
      for (const [id, item] of entries) {
        const doc = JSON.stringify(item);
        if (before.get(id) !== doc) save.run(orgId, id, doc);
      }
      for (const id of before.keys()) if (!entries.has(id)) remove.run(orgId, id);
      return answer;
    }).immediate();
  }
}
