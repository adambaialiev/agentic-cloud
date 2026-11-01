/**
 * The last copy of a note this tab actually read.
 *
 * Note #306, in the user's own words: "If I'm on a note details page and go to
 * an agent details page, and go back, I see that the note details page
 * refetches showing the flash of loading UI. It should read from cache and
 * refetch silently."
 *
 * He is describing the cost of a correct decision. `App.tsx` keys the note
 * screen on its number so that one note's margin, files and half-typed remark
 * can never survive into the next — which means Back REBUILDS the screen, from
 * nothing, every time. The screen is right to start empty; it is wrong to have
 * nothing to start FROM.
 *
 * So the note outlives the screen here rather than inside it. A read that
 * lands leaves its copy; the next screen on that address opens on it and
 * refreshes underneath, and the reader coming back sees the note they left,
 * with no wait drawn over it at all.
 *
 * Scope is deliberate on both axes. It is per TAB, not `sessionStorage`: a
 * note is small but a margin is not bounded, and a cache that has to be
 * serialised is a cache that has to be evicted for size rather than for age.
 * It was keyed by ROOM as well as number while the same number could name a
 * different note in a different room; since rooms left the product (note
 * #843) a workplace has one series of numbers, and the number is the note.
 */

import type { WorkspaceNoteRecord } from '../../../../src/shared/workspace-api.js';

/** How many notes are worth keeping. Back goes to the note you just left, and
 *  a reader walking a margin's mentions goes a handful deep; past that this is
 *  holding notes nobody is coming back to. */
export const NOTES_KEPT = 12;

const held = new Map<string, WorkspaceNoteRecord>();

const at = (number: string | number) => `#${number}`;

/** The note last read at this address, if this tab has ever read it. */
export function heldNote(number: string | number): WorkspaceNoteRecord | null {
  return held.get(at(number)) ?? null;
}

/** Keep what was just read — or just changed, since a local edit is the
 *  freshest copy there is and Back must not undo it on screen. */
export function holdNote(number: string | number, note: WorkspaceNoteRecord): void {
  const key = at(number);
  // Re-inserted rather than updated, so the map's own insertion order is a
  // least-recently-used list and the eviction below needs nothing else.
  held.delete(key);
  held.set(key, note);
  while (held.size > NOTES_KEPT) {
    const oldest = held.keys().next();
    if (oldest.done) break;
    held.delete(oldest.value);
  }
}

/** Forget it: the note has been archived, restored or deleted, and the copy
 *  held here is of the note as it was BEFORE. Serving that on the way back
 *  would put the wrong verb under the reader's finger — an Archive button on a
 *  note already in the archive — for as long as the fresh read takes. */
export function forgetNote(number: string | number): void {
  held.delete(at(number));
}

/** Every note, gone. Only sign-out has a reason to ask: the next reader of
 *  this tab is a different person. */
export function forgetNotes(): void {
  held.clear();
}
