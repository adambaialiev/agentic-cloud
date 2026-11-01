import type { LegacyRoom } from '../../services/legacy-rooms.js';
import type { SqliteDb } from '../../services/sqlite/sqlite-db.js';

/** An old database's rooms table, as the schema created it before stage 3 (note #923). */
export function seedLegacyRoomsTable(db: SqliteDb): (row: LegacyRoom) => LegacyRoom {
  db.exec('CREATE TABLE IF NOT EXISTS org_rooms (room_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, namespace_id TEXT NOT NULL, doc TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO org_rooms (room_id, org_id, namespace_id, doc) VALUES (?, ?, ?, ?)');
  return (row) => {
    insert.run(row.roomId, row.orgId, row.namespaceId, JSON.stringify({ ...row, createdByUserId: 'founder', createdAt: '2026-09-01T00:00:00.000Z' }));
    return row;
  };
}
