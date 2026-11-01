import { describe, expect, it, vi } from 'vitest';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { SqliteOrgStorage } from '../../services/sqlite/sqlite-org-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { InMemoryLegacyRooms } from '../../services/legacy-rooms.js';
import { SqliteLegacyRooms } from '../../services/sqlite/sqlite-legacy-rooms.js';
import { dropRooms } from '../../services/room-drop.js';
import { seedLegacyRoomsTable } from './legacy-rooms-fixture.js';

/**
 * Rooms, stage 3 (note #923): the rooms leave the database. Run on SQLite,
 * because production is SQLite and the field strip is SQL over its documents.
 */
async function mergedDatabase() {
  const db = openSqliteDb(':memory:');
  const orgStorage = new SqliteOrgStorage(db);
  const org = await orgStorage.createOrg({ name: 'ACC', createdByUserId: 'founder' });
  await orgStorage.updateOrg(org.orgId, { git: { namespaceId: 'base-ns' }, roomsMerged: { mergedAt: '2026-10-30T18:36:50.000Z', namespaces: ['room-growth'] } });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'founder', role: 'admin' });
  const addRoom = seedLegacyRoomsTable(db);
  addRoom({ roomId: 'room-platform', orgId: org.orgId, name: 'Platform', namespaceId: 'base-ns' });
  addRoom({ roomId: 'room-growth', orgId: org.orgId, name: 'Growth', namespaceId: 'room-growth' });
  // Made after the merge (an agent's home room, stage 2): its namespace was never recorded.
  addRoom({ roomId: 'room-late', orgId: org.orgId, name: 'ACC', namespaceId: 'room-late' });
  const raw = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  raw('INSERT INTO users (user_id, doc) VALUES (?, ?)', 'founder', JSON.stringify({
    userId: 'founder', telegram: { agents: { a1: { id: 'a1', name: 'Noah', orgId: org.orgId, roomId: 'room-growth' }, a2: { id: 'a2', name: 'Ada', orgId: org.orgId } } },
  }));
  raw('INSERT INTO secrets (user_id, secret_id, doc) VALUES (?, ?, ?)', 'base-ns', 's1', JSON.stringify({ secretId: 's1', key: 'user-env:FLY_API_TOKEN', value: 'sealed', rooms: ['room-platform'] }));
  raw('INSERT INTO secrets (user_id, secret_id, doc) VALUES (?, ?, ?)', 'base-ns', 's2', JSON.stringify({ secretId: 's2', key: 'user-env:OPENAI', value: 'sealed' }));
  raw('INSERT INTO agent_schedules (schedule_id, org_id, agent_id, live, doc) VALUES (?, ?, ?, ?, ?)', 'sch1', org.orgId, 'a1', 1, JSON.stringify({ id: 'sch1', orgId: org.orgId, roomId: 'room-growth', agentId: 'a1' }));
  raw('INSERT INTO storage_buckets (bucket_id, user_id, org_id, name, doc) VALUES (?, ?, ?, ?, ?)', 'b1', 'founder', org.orgId, 'files', JSON.stringify({ id: 'b1', roomId: 'room-growth', createdBy: { agentId: 'a1', agentName: 'Noah', roomName: 'Growth' } }));
  raw('INSERT INTO deployments (deployment_id, name, user_id, doc) VALUES (?, ?, ?, ?)', 'd1', 'site', 'founder', JSON.stringify({ id: 'd1', roomId: 'room-growth', lastDeployBy: { agentId: 'a1', userId: 'founder', roomName: 'Growth' } }));
  raw('INSERT INTO git_repos (repo_id, user_id, name, doc) VALUES (?, ?, ?, ?)', 'r1', 'base-ns', 'api', JSON.stringify({ id: 'r1', ciSecretsNamespaceId: 'room-growth', ciSecretsRoomId: 'room-growth', sharedWithNamespaceIds: ['room-growth'] }));
  const member = db.prepare('SELECT doc FROM org_members WHERE org_id = ? AND user_id = ?').get(org.orgId, 'founder') as { doc: string };
  raw('UPDATE org_members SET doc = ? WHERE org_id = ? AND user_id = ?', JSON.stringify({ ...JSON.parse(member.doc), roomRecaps: { 'room-growth': { recap: { text: '- old', at: 'x', fingerprint: 'f' } } } }), org.orgId, 'founder');
  const doc = (table: string, key: string, id: string) => JSON.parse((db.prepare(`SELECT doc FROM ${table} WHERE ${key} = ?`).get(id) as { doc: string }).doc);
  return { db, orgStorage, org, legacyRooms: new SqliteLegacyRooms(db), doc };
}

describe('dropping the rooms (note #923)', () => {
  it('copies the database first, records every old namespace, strips every room field, then drops the table — once', async () => {
    const { db, orgStorage, org, legacyRooms, doc } = await mergedDatabase();
    const order: string[] = [];
    const backup = vi.fn(async () => { order.push(`backup with ${(await legacyRooms.listAll()).length} rooms`); return '/data/backend.db.before-room-drop'; });

    const result = await dropRooms({ orgStorage, legacyRooms, backup });

    expect(order).toEqual(['backup with 3 rooms']);
    expect(result).toEqual({
      dropped: 3, recorded: 1, backup: '/data/backend.db.before-room-drop',
      stripped: { agents: 1, secrets: 1, schedules: 1, buckets: 1, deployments: 1, repositories: 1, repositoryShares: 1, members: 1 },
    });
    expect((await orgStorage.getOrg(org.orgId))?.roomsMerged).toEqual({ mergedAt: '2026-10-30T18:36:50.000Z', namespaces: ['room-growth', 'room-late'] });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'org_rooms'").get()).toBeUndefined();
    // Only the room fields went; everything beside them stands.
    expect(doc('users', 'user_id', 'founder').telegram.agents).toEqual({ a1: { id: 'a1', name: 'Noah', orgId: org.orgId }, a2: { id: 'a2', name: 'Ada', orgId: org.orgId } });
    expect(doc('secrets', 'secret_id', 's1')).toEqual({ secretId: 's1', key: 'user-env:FLY_API_TOKEN', value: 'sealed' });
    expect(doc('agent_schedules', 'schedule_id', 'sch1')).toEqual({ id: 'sch1', orgId: org.orgId, agentId: 'a1' });
    expect(doc('storage_buckets', 'bucket_id', 'b1')).toEqual({ id: 'b1', createdBy: { agentId: 'a1', agentName: 'Noah' } });
    expect(doc('deployments', 'deployment_id', 'd1')).toEqual({ id: 'd1', lastDeployBy: { agentId: 'a1', userId: 'founder' } });
    expect(doc('git_repos', 'repo_id', 'r1')).toEqual({ id: 'r1', ciSecretsNamespaceId: 'room-growth' });
    expect((await orgStorage.getMembership(org.orgId, 'founder')) as unknown as Record<string, unknown>).not.toHaveProperty('roomRecaps');

    // Gone means gone: the next boot finds nothing to do and copies nothing.
    const again = vi.fn(async () => 'never');
    expect(await dropRooms({ orgStorage, legacyRooms, backup: again })).toEqual({ dropped: 0, recorded: 0, stripped: {} });
    expect(again).not.toHaveBeenCalled();
  });

  it('keeps every room while any workplace is unmerged, and copies nothing', async () => {
    const { db, orgStorage, legacyRooms } = await mergedDatabase();
    const behind = await orgStorage.createOrg({ name: 'Skipped a release', createdByUserId: 'someone' });
    await orgStorage.updateOrg(behind.orgId, { roomsMerged: undefined });
    const backup = vi.fn(async () => 'never');

    const result = await dropRooms({ orgStorage, legacyRooms, backup });

    expect(result.dropped).toBe(0);
    expect(result.deferred).toContain(behind.orgId);
    expect(backup).not.toHaveBeenCalled();
    expect((await legacyRooms.listAll())).toHaveLength(3);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'org_rooms'").get()).toBeTruthy();
  });

  it('does not drop when the copy could not be made', async () => {
    const { orgStorage, legacyRooms } = await mergedDatabase();
    await expect(dropRooms({ orgStorage, legacyRooms, backup: async () => { throw new Error('disk full'); } })).rejects.toThrow('disk full');
    expect(await legacyRooms.listAll()).toHaveLength(3);
  });

  it('does nothing on a database made since, which never had a rooms table', async () => {
    const db = openSqliteDb(':memory:');
    const backup = vi.fn(async () => 'never');
    expect(await dropRooms({ orgStorage: new SqliteOrgStorage(db), legacyRooms: new SqliteLegacyRooms(db), backup })).toEqual({ dropped: 0, recorded: 0, stripped: {} });
    expect(backup).not.toHaveBeenCalled();
  });

  it('drops the in-memory stand-in the same way', async () => {
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Test', createdByUserId: 'founder' });
    const legacyRooms = new InMemoryLegacyRooms([{ roomId: 'r', orgId: org.orgId, name: 'Old', namespaceId: 'r-ns' }]);
    expect(await dropRooms({ orgStorage, legacyRooms })).toMatchObject({ dropped: 1, recorded: 1 });
    expect(await legacyRooms.present()).toBe(false);
    expect((await orgStorage.getOrg(org.orgId))?.roomsMerged?.namespaces).toEqual(['r-ns']);
  });
});

describe.each([
  ['memory', () => new InMemoryOrgStorage()],
  ['sqlite', () => new SqliteOrgStorage(openSqliteDb(':memory:'))],
] as const)('the workplace a namespace belongs to, on the %s store (note #923)', (_label, make) => {
  it('is found by its own namespace and by an old room\'s, and nothing else is', async () => {
    const orgStorage = make();
    const acc = await orgStorage.createOrg({ name: 'ACC', createdByUserId: 'founder' });
    await orgStorage.updateOrg(acc.orgId, { git: { namespaceId: 'base-ns' }, roomsMerged: { mergedAt: 'x', namespaces: ['room-growth'] } });
    const other = await orgStorage.createOrg({ name: 'Other', createdByUserId: 'someone' });
    await orgStorage.updateOrg(other.orgId, { git: { namespaceId: 'other-ns' } });
    expect((await orgStorage.getOrgByNamespace('base-ns'))?.orgId).toBe(acc.orgId);
    expect((await orgStorage.getOrgByNamespace('room-growth'))?.orgId).toBe(acc.orgId);
    expect((await orgStorage.getOrgByNamespace('other-ns'))?.orgId).toBe(other.orgId);
    expect(await orgStorage.getOrgByNamespace('founder')).toBeNull();
  });
});
