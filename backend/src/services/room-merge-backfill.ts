import { orgKnowledgeShelfNamespace } from './org-git.js';
import type { OrgStorage } from './org-storage.js';
import type { LegacyRoomStore } from './legacy-rooms.js';
import type { QuickNoteStorage } from './quick-note-storage.js';
import { workplaceNumberSeries } from './workplace-numbers.js';
import type { OrgDocument } from '../types/org.js';

/**
 * Rooms leave the product (note #843, Adam, 30 Oct 2026: "Let's remove
 * rooms. I think it's not actually helpful."). Stage 1 of four: the data.
 *
 * Knowledge (note #566) and secrets (note #783) already stand on one shelf
 * per workplace, at the workplace's own namespace. Notes are the last store
 * that still lives per room, so each room's notes — live and archived — are
 * moved onto that namespace and the workplace is stamped `roomsMerged`. From
 * the stamp on, every room of the workplace resolves there
 * (`OrgGitService.resolveNamespace`); before it, every room keeps reading
 * its own notes, so no note is ever missing between the release and the
 * merge.
 *
 * House rules, the same as the two shelves': idempotent, safe to retry after
 * a partial run, one workplace's trouble never holds up another's, and it
 * returns counts.
 *
 * - A note is MOVED, not copied (`QuickNoteStorage.move`, note #111): the
 *   same document keeps its words, margin, files, lease and linked work, and
 *   remembers its old room and number in `previousLocations`, which is how a
 *   proposal linked to it still finds it.
 * - It keeps its number when the workplace's namespace does not hold that
 *   number already. Numbers have come from one workplace series since note
 *   #741, so only notes from before 12 Oct can clash (production: 76 of
 *   Growth's and one of the Workspace room's, against Platform's); such a
 *   note takes the series' next number. The rule, the note's own: the
 *   simplest thing that keeps the data.
 * - The 100-live-note ceiling is a rule about writing a note, not about
 *   moving one: everything moves, and a workplace left above the ceiling
 *   (Demonstrations, 122) takes no new note until it archives some.
 * - Nothing waits for the shelves: a workplace whose knowledge or secret
 *   shelf is not merged yet is deferred to the next boot, so the stamp never
 *   points a room at a namespace whose other stores it does not read yet.
 *
 * The room rows stay. Stage 1's Workspace still draws them; they go in
 * stage 3, when `namespaces` on the stamp is what keeps their records the
 * workplace's.
 */
export interface RoomMergeBackfillDeps {
  orgStorage: Pick<OrgStorage, 'listOrgs' | 'updateOrg'>;
  /** The old rooms, read from what is left of them (note #923). */
  legacyRooms: Pick<LegacyRoomStore, 'listByOrg'>;
  quickNoteStorage: Pick<QuickNoteStorage, 'listByUser' | 'listArchivedByUser' | 'move'>;
  now?: () => Date;
}

export interface RoomMergeBackfillResult {
  /** Workplaces stamped by this run. */
  workplaces: number;
  /** Notes moved onto a workplace's namespace by this run, renumbered ones included. */
  moved: number;
  /** Notes that could not keep their number. */
  renumbered: Array<{ orgId: string; roomId: string; from: number; to: number }>;
  /** Notes found at a room's namespace after its workplace was stamped, and moved. */
  swept: number;
  /** Workplaces left for the next boot, with the reason. */
  deferred: Array<{ orgId: string; reason: string }>;
}

/** Every room the workplace had, the Chief of Staff's hidden one included. */
async function roomsOf(deps: RoomMergeBackfillDeps, org: OrgDocument) {
  return deps.legacyRooms.listByOrg(org.orgId);
}

/**
 * Move every note standing at one of these namespaces onto the workplace's.
 * Oldest number first, so where two rooms' notes clash the earlier one keeps
 * the number and nothing about the order depends on the store.
 */
async function moveNotes(
  deps: RoomMergeBackfillDeps,
  org: OrgDocument,
  sources: Array<{ roomId: string; namespaceId: string }>,
  onRenumbered: (entry: { roomId: string; from: number; to: number }) => void,
): Promise<number> {
  const workplace = orgKnowledgeShelfNamespace(org);
  const numbering = {
    series: workplaceNumberSeries(org.orgId, workplace),
    namespaces: [workplace, ...sources.map((source) => source.namespaceId)],
  };
  let moved = 0;
  for (const source of sources) {
    const notes = [
      ...await deps.quickNoteStorage.listByUser(source.namespaceId),
      ...await deps.quickNoteStorage.listArchivedByUser(source.namespaceId),
    ].sort((a, b) => a.number - b.number || a.createdAt.localeCompare(b.createdAt));
    for (const note of notes) {
      const next = await deps.quickNoteStorage.move(note.id, workplace, numbering);
      if (!next || next.userId !== workplace) {
        throw new Error(`note #${note.number} of room ${source.roomId} did not move`);
      }
      moved += 1;
      if (next.number !== note.number) onRenumbered({ roomId: source.roomId, from: note.number, to: next.number });
    }
  }
  return moved;
}

async function mergeOneWorkplace(
  deps: RoomMergeBackfillDeps,
  org: OrgDocument,
  result: RoomMergeBackfillResult,
): Promise<void> {
  if (!org.knowledgeShelf?.mergedAt || !org.secretShelf?.mergedAt) {
    throw new Error('its knowledge and secret shelves are not merged yet');
  }
  const workplace = orgKnowledgeShelfNamespace(org);
  const sources = (await roomsOf(deps, org))
    .filter((room) => room.namespaceId !== workplace)
    .map((room) => ({ roomId: room.roomId, namespaceId: room.namespaceId }));

  // 1. Every room's notes onto the workplace's namespace. A failure part way
  //    leaves the workplace unstamped and the next boot carries on; until
  //    then a note already moved shows in the room standing at the
  //    workplace's namespace rather than its own.
  const renumbered: RoomMergeBackfillResult['renumbered'] = [];
  const onRenumbered = (entry: { roomId: string; from: number; to: number }) => renumbered.push({ orgId: org.orgId, ...entry });
  let moved = await moveNotes(deps, org, sources, onRenumbered);

  // 2. The stamp: from here every room reads the workplace.
  await deps.orgStorage.updateOrg(org.orgId, {
    roomsMerged: {
      mergedAt: (deps.now?.() ?? new Date()).toISOString(),
      namespaces: [...new Set(sources.map((source) => source.namespaceId))],
    },
  });

  // 3. Once more, for a note written into a room while step 1 ran: a room
  //    read its own namespace until the stamp, and nothing reads it now.
  moved += await moveNotes(deps, org, sources, onRenumbered);
  result.workplaces += 1;
  result.moved += moved;
  result.renumbered.push(...renumbered);
}

/**
 * A note written at a room's own namespace after its workplace was stamped
 * — only a write already in flight across the stamp can do that — would be
 * a note nobody can see. Every boot moves any such note onto the workplace,
 * the same way.
 */
async function sweepLeftovers(deps: RoomMergeBackfillDeps, org: OrgDocument, result: RoomMergeBackfillResult): Promise<void> {
  const workplace = orgKnowledgeShelfNamespace(org);
  const rooms = await roomsOf(deps, org);
  const byNamespace = new Map<string, string>();
  for (const namespaceId of org.roomsMerged?.namespaces ?? []) byNamespace.set(namespaceId, '');
  for (const room of rooms) byNamespace.set(room.namespaceId, room.roomId);
  byNamespace.delete(workplace);
  const sources = [...byNamespace].map(([namespaceId, roomId]) => ({ namespaceId, roomId }));
  result.swept += await moveNotes(deps, org, sources, (entry) => result.renumbered.push({ orgId: org.orgId, ...entry }));
}

export async function backfillRoomMerge(deps: RoomMergeBackfillDeps): Promise<RoomMergeBackfillResult> {
  const result: RoomMergeBackfillResult = { workplaces: 0, moved: 0, renumbered: [], swept: 0, deferred: [] };
  for (const org of await deps.orgStorage.listOrgs()) {
    try {
      if (org.roomsMerged?.mergedAt) {
        await sweepLeftovers(deps, org, result);
        continue;
      }
      await mergeOneWorkplace(deps, org, result);
    } catch (error) {
      result.deferred.push({ orgId: org.orgId, reason: (error as Error).message });
    }
  }
  return result;
}
