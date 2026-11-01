import type { LegacyRoom, LegacyRoomStore } from '../legacy-rooms.js';
import { deserializeDoc, type SqliteDb } from './sqlite-db.js';

/**
 * The old `org_rooms` rows, read for the migrations alone (note #923). The
 * schema stopped creating the table in stage 3, so a database made since
 * never has one, and an older one keeps it until room-drop.ts drops it.
 */
export class SqliteLegacyRooms implements LegacyRoomStore {
  constructor(private readonly db: SqliteDb) {}

  async present(): Promise<boolean> {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'org_rooms'").get());
  }

  private rows(where: string, ...args: string[]): LegacyRoom[] {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'org_rooms'").get()) return [];
    const rows = this.db.prepare(`SELECT doc FROM org_rooms ${where} ORDER BY rowid`).all(...args) as Array<{ doc: string }>;
    return rows.map((row) => {
      const doc = deserializeDoc<LegacyRoom & Record<string, unknown>>(row.doc);
      return {
        roomId: doc.roomId,
        orgId: doc.orgId,
        name: doc.name,
        namespaceId: doc.namespaceId,
        ...(doc.purpose === 'workspace' ? { purpose: 'workspace' as const } : {}),
      };
    });
  }

  async listByOrg(orgId: string): Promise<LegacyRoom[]> {
    return this.rows('WHERE org_id = ?', orgId);
  }

  async listAll(): Promise<LegacyRoom[]> {
    return this.rows('');
  }

  /**
   * One transaction: every room field still written on a record goes, then
   * the table. The fields are the ones only a room gave meaning to — an
   * agent's room, a key's room limit, a schedule's, a bucket's and a
   * deploy's room, a CI grant's asking room and a repository's retired room
   * shares, a member's per-room briefings. Namespaces stay: they are where
   * records live, and the workplace keeps every old one (roomsMerged).
   */
  async drop(): Promise<Record<string, number>> {
    const stripped: Record<string, number> = {};
    const strip = (table: string, key: string, pattern: string, edit: (doc: Record<string, unknown>) => boolean) => {
      const select = this.db.prepare(`SELECT rowid AS id, doc FROM ${table} WHERE doc LIKE ?`);
      const update = this.db.prepare(`UPDATE ${table} SET doc = ? WHERE rowid = ?`);
      let count = 0;
      for (const row of select.all(pattern) as Array<{ id: number; doc: string }>) {
        // Raw JSON in and out, so nothing but the dropped keys changes.
        const doc = JSON.parse(row.doc) as Record<string, unknown>;
        if (!edit(doc)) continue;
        update.run(JSON.stringify(doc), row.id);
        count += 1;
      }
      if (count) stripped[key] = count;
    };
    const drop = (doc: Record<string, unknown> | undefined, ...fields: string[]) => {
      let changed = false;
      for (const field of fields) {
        if (doc && field in doc) {
          delete doc[field];
          changed = true;
        }
      }
      return changed;
    };
    const tx = this.db.transaction(() => {
      strip('users', 'agents', '%"roomId"%', (doc) => {
        const agents = (doc.telegram as { agents?: Record<string, Record<string, unknown>> } | undefined)?.agents ?? {};
        let changed = false;
        for (const agent of Object.values(agents)) changed = drop(agent, 'roomId') || changed;
        return changed;
      });
      strip('secrets', 'secrets', '%"rooms"%', (doc) => drop(doc, 'rooms'));
      strip('agent_schedules', 'schedules', '%"roomId"%', (doc) => drop(doc, 'roomId'));
      strip('storage_buckets', 'buckets', '%"room%', (doc) => {
        const own = drop(doc, 'roomId');
        return drop(doc.createdBy as Record<string, unknown> | undefined, 'roomName') || own;
      });
      strip('deployments', 'deployments', '%"room%', (doc) => {
        const own = drop(doc, 'roomId');
        return drop(doc.lastDeployBy as Record<string, unknown> | undefined, 'roomName') || own;
      });
      strip('git_repos', 'repositories', '%"ciSecretsRoomId"%', (doc) => drop(doc, 'ciSecretsRoomId'));
      strip('git_repos', 'repositoryShares', '%"sharedWithNamespaceIds"%', (doc) => drop(doc, 'sharedWithNamespaceIds'));
      strip('org_members', 'members', '%"roomRecaps"%', (doc) => drop(doc, 'roomRecaps'));
      this.db.exec('DROP TABLE IF EXISTS org_rooms');
    });
    tx();
    return stripped;
  }
}
