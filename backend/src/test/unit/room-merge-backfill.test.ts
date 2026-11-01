import { describe, expect, it } from 'vitest';
import { InMemoryOrgStorage, type OrgStorage } from '../../services/org-storage.js';
import { SqliteOrgStorage } from '../../services/sqlite/sqlite-org-storage.js';
import { InMemoryQuickNoteStorage, type QuickNoteStorage } from '../../services/quick-note-storage.js';
import { SqliteQuickNoteStorage } from '../../services/sqlite/sqlite-quick-note-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { seedLegacyRoomsTable } from './legacy-rooms-fixture.js';
import { InMemoryLegacyRooms, type LegacyRoom, type LegacyRoomStore } from '../../services/legacy-rooms.js';
import { SqliteLegacyRooms } from '../../services/sqlite/sqlite-legacy-rooms.js';
import { backfillRoomMerge } from '../../services/room-merge-backfill.js';
import { newQuickNoteComment } from '../../services/quick-note-storage.js';

type Stores = { orgStorage: OrgStorage; notes: QuickNoteStorage; legacyRooms: LegacyRoomStore; addRoom: (row: LegacyRoom) => LegacyRoom };

/**
 * Rooms leave the product (note #843), stage 1: every room's notes onto the
 * workplace's own namespace, then the stamp. Since stage 3 (note #923) the
 * rooms are read from what is left of them — the old table — and the merge
 * still runs for a database that skipped the release carrying it. Run against
 * both stores, because production is the SQLite one and its `move` is its own
 * transaction.
 */
const STORES: Array<[string, () => Stores]> = [
  ['memory', () => {
    const legacyRooms = new InMemoryLegacyRooms();
    return { orgStorage: new InMemoryOrgStorage(), notes: new InMemoryQuickNoteStorage(), legacyRooms, addRoom: (row) => legacyRooms.add(row) };
  }],
  ['sqlite', () => {
    const db = openSqliteDb(':memory:');
    return { orgStorage: new SqliteOrgStorage(db), notes: new SqliteQuickNoteStorage(db), legacyRooms: new SqliteLegacyRooms(db), addRoom: seedLegacyRoomsTable(db) };
  }],
];

/** A workplace as production held it on 30 Oct: both shelves merged, rooms
 *  not — Platform at the workplace's own namespace, Growth and the Chief of
 *  Staff's Workspace room beside it. */
async function legacyWorkplace(make: (typeof STORES)[number][1]) {
  const { orgStorage, notes, legacyRooms, addRoom } = make();
  const org = await orgStorage.createOrg({ name: 'ACC', createdByUserId: 'founder' });
  await orgStorage.updateOrg(org.orgId, { git: { namespaceId: 'base-ns' }, roomsMerged: undefined });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'founder', role: 'admin' });
  const platform = addRoom({ roomId: 'room-platform', orgId: org.orgId, name: 'Platform', namespaceId: 'base-ns' });
  const growth = addRoom({ roomId: 'room-growth', orgId: org.orgId, name: 'Growth', namespaceId: 'room-growth' });
  const workspace = addRoom({ roomId: 'room-ws', orgId: org.orgId, name: 'Workspace', namespaceId: 'room-ws', purpose: 'workspace' });
  const jot = (userId: string, html: string) => notes.create({ userId, html, createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a' });
  return { orgStorage, notes, legacyRooms, addRoom, org, platform, growth, workspace, jot };
}

describe.each(STORES)('the room merge (note #843) on the %s stores', (_label, make) => {
  it('moves every room\'s notes onto the workplace — live and archived, words, margin and lease kept — and renumbers only a clash', async () => {
    const { orgStorage, notes, legacyRooms, org, platform, growth, workspace, jot } = await legacyWorkplace(make);
    await jot('base-ns', '<p>Platform one</p>');
    const growthOne = await jot(growth.namespaceId, '<p>Growth one</p>');
    await notes.addComment(growthOne.id, newQuickNoteComment('agent-b', 'On it', 'founder'));
    await notes.claim(growthOne.id, { agentId: 'agent-b', agentName: 'Noah', userId: 'founder' }, new Date());
    const growthTwo = await jot(growth.namespaceId, '<p>Growth two, put away</p>');
    await notes.update(growthTwo.id, { archivedAt: '2026-10-20T10:00:00.000Z' });
    await jot(workspace.namespaceId, '<p>Chief of Staff memo</p>');

    const result = await backfillRoomMerge({ orgStorage, legacyRooms, quickNoteStorage: notes, now: () => new Date('2026-10-30T15:00:00.000Z') });

    expect(result).toMatchObject({ workplaces: 1, moved: 3, swept: 0, deferred: [] });
    // Growth's #1 and the Workspace room's #1 both met Platform's #1, so
    // each took the series' next number, in that order.
    expect(result.renumbered).toEqual([
      { orgId: org.orgId, roomId: growth.roomId, from: 1, to: 3 },
      { orgId: org.orgId, roomId: workspace.roomId, from: 1, to: 4 },
    ]);
    expect((await orgStorage.getOrg(org.orgId))?.roomsMerged).toEqual({
      mergedAt: '2026-10-30T15:00:00.000Z',
      namespaces: [growth.namespaceId, workspace.namespaceId],
    });
    // Nothing is left at a room's own namespace, and nothing at Platform's
    // moved — it already stood at the workplace's.
    for (const ns of [growth.namespaceId, workspace.namespaceId]) {
      expect(await notes.listByUser(ns)).toEqual([]);
      expect(await notes.listArchivedByUser(ns)).toEqual([]);
    }
    expect((await notes.listByUser('base-ns')).map((note) => note.number).sort()).toEqual([1, 3, 4]);
    // The same document: margin, lease and its old address all came along.
    const moved = (await notes.get(growthOne.id))!;
    expect(moved).toMatchObject({ userId: 'base-ns', number: 3, previousLocations: [{ userId: growth.namespaceId, number: 1 }] });
    expect(moved.comments?.map((comment) => comment.text)).toEqual(['On it']);
    expect(moved.claim?.agentName).toBe('Noah');
    // The archived note kept its number (nobody else held #2) and stays archived.
    expect(await notes.getByNumber('base-ns', 2)).toMatchObject({ id: growthTwo.id, archivedAt: '2026-10-20T10:00:00.000Z' });
    // The next note anywhere in the workplace comes after all of them.
    expect((await notes.create({ userId: 'base-ns', html: '<p>Next</p>', createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a' }, {
      series: `org:${org.orgId}`, namespaces: ['base-ns', platform.namespaceId, growth.namespaceId, workspace.namespaceId],
    })).number).toBe(5);
  });

  it('is a no-op the second time, and sweeps a note a room was given after the stamp', async () => {
    const { orgStorage, notes, legacyRooms, org, growth, jot } = await legacyWorkplace(make);
    await jot(growth.namespaceId, '<p>Growth one</p>');
    expect(await backfillRoomMerge({ orgStorage, legacyRooms, quickNoteStorage: notes })).toMatchObject({ workplaces: 1, moved: 1 });
    expect(await backfillRoomMerge({ orgStorage, legacyRooms, quickNoteStorage: notes })).toMatchObject({ workplaces: 0, moved: 0, swept: 0, renumbered: [] });

    // A write that was already on its way to the room as the stamp landed.
    const late = await jot(growth.namespaceId, '<p>Late</p>');
    const swept = await backfillRoomMerge({ orgStorage, legacyRooms, quickNoteStorage: notes });
    expect(swept).toMatchObject({ workplaces: 0, moved: 0, swept: 1, deferred: [] });
    expect((await notes.get(late.id))?.userId).toBe('base-ns');
    // The stamp is the first one; a sweep never moves it.
    expect((await orgStorage.getOrg(org.orgId))?.roomsMerged?.namespaces).toEqual([growth.namespaceId, expect.any(String)]);
  });

  it('waits for both shelves: a workplace whose secrets are still per room is deferred untouched', async () => {
    const { orgStorage, notes, legacyRooms, org, growth, jot } = await legacyWorkplace(make);
    await orgStorage.updateOrg(org.orgId, { secretShelf: undefined });
    const note = await jot(growth.namespaceId, '<p>Growth one</p>');
    const result = await backfillRoomMerge({ orgStorage, legacyRooms, quickNoteStorage: notes });
    expect(result).toMatchObject({ workplaces: 0, moved: 0, deferred: [{ orgId: org.orgId, reason: expect.stringContaining('shelves') }] });
    expect((await notes.get(note.id))?.userId).toBe(growth.namespaceId);
    expect((await orgStorage.getOrg(org.orgId))?.roomsMerged).toBeUndefined();
  });

  it('a workplace born since is stamped at birth and has nothing to move, with or without an old rooms table', async () => {
    const { orgStorage, notes, legacyRooms } = make();
    const fresh = await orgStorage.createOrg({ name: 'New', createdByUserId: 'someone' });
    expect(fresh.roomsMerged?.mergedAt).toBe(fresh.createdAt);
    expect(await backfillRoomMerge({ orgStorage, legacyRooms, quickNoteStorage: notes })).toMatchObject({ workplaces: 0, moved: 0, swept: 0, deferred: [] });
  });
});

describe('the room merge when a move fails', () => {
  it('leaves that workplace unstamped for the next boot and still merges the others', async () => {
    const orgStorage = new InMemoryOrgStorage();
    const notes = new InMemoryQuickNoteStorage();
    const legacyRooms = new InMemoryLegacyRooms();
    const make = async (name: string) => {
      const org = await orgStorage.createOrg({ name, createdByUserId: 'founder' });
      await orgStorage.updateOrg(org.orgId, { git: { namespaceId: `${name}-base` }, roomsMerged: undefined });
      const room = legacyRooms.add({ roomId: `${name}-growth`, orgId: org.orgId, name: 'Growth', namespaceId: `${name}-growth` });
      await notes.create({ userId: room.namespaceId, html: `<p>${name}</p>`, createdByAgentId: 'a', updatedByAgentId: 'a' });
      return { org, room };
    };
    const broken = await make('broken');
    const fine = await make('fine');
    const flaky: QuickNoteStorage = Object.assign(Object.create(notes), {
      move: async (id: string, userId: string, numbering?: Parameters<QuickNoteStorage['move']>[2]) => (
        (await notes.get(id))?.userId === broken.room.namespaceId ? null : notes.move(id, userId, numbering)
      ),
    });

    const result = await backfillRoomMerge({ orgStorage, legacyRooms, quickNoteStorage: flaky });

    expect(result.workplaces).toBe(1);
    expect(result.deferred).toEqual([{ orgId: broken.org.orgId, reason: expect.stringContaining('did not move') }]);
    expect((await orgStorage.getOrg(broken.org.orgId))?.roomsMerged).toBeUndefined();
    expect((await orgStorage.getOrg(fine.org.orgId))?.roomsMerged?.mergedAt).toBeTruthy();
    expect(await notes.listByUser(broken.room.namespaceId)).toHaveLength(1);
  });
});
