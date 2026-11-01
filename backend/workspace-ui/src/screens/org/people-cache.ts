/**
 * The last people this tab actually read, per workplace (note #612).
 *
 * The rule the note, mail and cloud caches already keep, asked for here in
 * the owner's words: "in workspace, humans cards should be cached, and
 * refetched silently". Home is a route, so coming back to it rebuilds the
 * people deck from nothing, and every visit used to paint a plate-shaped
 * skeleton over the cards the reader was looking at a second ago. The answer
 * outlives the screen here instead: `usePeople()` opens on the held copy and
 * reads underneath it.
 *
 * Keyed by WORKPLACE, because that is all the answer depends on — the same
 * key `usePeople()` reads by, which is why it reads the same in every room.
 * What the live tick says (who is here, their latest line) is folded into the
 * held copy as it lands, so a visit never opens on a "here now" older than
 * the one it last showed.
 *
 * Per TAB, and emptied by `SessionProvider` on sign-out and by the test setup
 * between tests. A reader who loses access to a workplace has that copy
 * dropped by `usePeople()` itself: the rows are a membership they no longer
 * have.
 */

import type { WorkspacePeopleAnswer } from '../../../../src/shared/workspace-api.js';

const held = new Map<string, WorkspacePeopleAnswer>();

/** The people last read in this workplace, if this tab has ever read them. */
export function heldPeople(orgId: string | null | undefined): WorkspacePeopleAnswer | null {
  return orgId ? held.get(orgId) ?? null : null;
}

export function holdPeople(orgId: string, answer: WorkspacePeopleAnswer): void {
  held.set(orgId, answer);
}

/** This workplace's copy, gone: the reader can no longer see its people. */
export function forgetPeopleOf(orgId: string): void {
  held.delete(orgId);
}

/** Every workplace, gone. Sign-out, and every test. */
export function forgetPeople(): void {
  held.clear();
}
