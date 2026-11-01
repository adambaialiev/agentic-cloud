import type { LegacyRoomStore } from './legacy-rooms.js';
import { orgKnowledgeShelfNamespace } from './org-git.js';
import type { OrgStorage } from './org-storage.js';

/**
 * Rooms, stage 3 (note #923, continuing note #843): the rooms go from the
 * database for good. Run at boot after the stage 1 merge (room-merge-backfill.ts)
 * has had its turn, so a database that skipped the release carrying the
 * merge is merged first and dropped on the same boot.
 *
 * - Nothing happens while ANY workplace is not fully merged — its knowledge
 *   and secret shelves (notes #566, #783) and its rooms (note #843) — because
 *   then a room still holds something nothing else can find. The rooms stay
 *   and the next boot asks again; the code no longer reads them either way.
 * - Before anything changes, the database is copied beside itself (the
 *   `backup` dependency), and the drop does not start unless that copy was
 *   made. The copy is the way back.
 * - Every room's own namespace is recorded on its workplace (`roomsMerged`
 *   `.namespaces`), so a record still standing at one — a decided proposal,
 *   a repository, a stored file — keeps resolving to the workplace.
 * - Then the rooms and every room field on other records go, in one
 *   transaction (LegacyRoomStore.drop).
 *
 * Idempotent: once the rooms are gone it returns at once.
 */
export interface RoomDropDeps {
  orgStorage: Pick<OrgStorage, 'listOrgs' | 'updateOrg'>;
  legacyRooms: LegacyRoomStore;
  /** Copies the database before the drop; resolves to where the copy went. */
  backup?: () => Promise<string>;
}

export interface RoomDropResult {
  /** Rooms dropped by this run (0 when there was nothing left to drop). */
  dropped: number;
  /** Old room namespaces newly recorded on their workplaces. */
  recorded: number;
  /** Records that lost a room field, by kind. */
  stripped: Record<string, number>;
  /** Where the database was copied before the drop. */
  backup?: string;
  /** Why nothing was dropped, when something was left to drop. */
  deferred?: string;
}

export async function dropRooms(deps: RoomDropDeps): Promise<RoomDropResult> {
  const result: RoomDropResult = { dropped: 0, recorded: 0, stripped: {} };
  if (!(await deps.legacyRooms.present())) return result;
  const orgs = await deps.orgStorage.listOrgs();
  const unmerged = orgs.filter((org) => !org.roomsMerged?.mergedAt || !org.knowledgeShelf?.mergedAt || !org.secretShelf?.mergedAt);
  if (unmerged.length) {
    result.deferred = `${unmerged.length} workplace(s) not merged yet: ${unmerged.slice(0, 5).map((org) => org.orgId).join(', ')}`;
    return result;
  }
  const rooms = await deps.legacyRooms.listAll();
  if (deps.backup) result.backup = await deps.backup();

  for (const org of orgs) {
    const workplace = orgKnowledgeShelfNamespace(org);
    const known = new Set(org.roomsMerged?.namespaces ?? []);
    const missing = [...new Set(rooms
      .filter((room) => room.orgId === org.orgId && room.namespaceId !== workplace && !known.has(room.namespaceId))
      .map((room) => room.namespaceId))];
    if (!missing.length) continue;
    await deps.orgStorage.updateOrg(org.orgId, {
      roomsMerged: { ...org.roomsMerged!, namespaces: [...known, ...missing] },
    });
    result.recorded += missing.length;
  }

  result.stripped = await deps.legacyRooms.drop();
  result.dropped = rooms.length;
  return result;
}
