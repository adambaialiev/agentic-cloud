/**
 * The notes list's address: which state it is narrowed to (note #419).
 *
 * The chip used to live in the screen's own memory, so opening a note from
 * "Merged" and coming Back landed on All — the list the reader had narrowed
 * was gone the moment they looked at one row of it. Now the chip is written
 * into the list's own entry:
 *
 *     /workspace/notes?org=<org>&room=<room>&state=merged
 *
 * IN PLACE — a replace, never a push — so Back from a note returns to the
 * list as it was left, while Back from the list still leaves the SCREEN
 * rather than walking back through every chip tapped on it. An address with
 * no `state` is the whole list, which is what a door into Notes writes, so
 * arriving fresh is still arriving at every note.
 *
 * The word is the state's own (`handed`, `proposal`), not the chip's label:
 * labels are presentation and may be reworded; a copied link must keep
 * naming the same state. Pure, and the only place this parameter is written.
 */

import { NOTE_WORK_STATES } from './note-words.js';
import type { NoteWorkFilter, NoteWorkState } from './note-words.js';

export const NOTE_FILTER_PARAM = 'state';

/** The state an address narrows to; All for none, and for a word that names
 *  no state — an old or mistyped link opens the whole list, not an empty one. */
export function addressNoteFilter(search: URLSearchParams): NoteWorkFilter {
  const word = (search.get(NOTE_FILTER_PARAM) ?? '').trim();
  return (NOTE_WORK_STATES as readonly string[]).includes(word) ? word as NoteWorkState : 'all';
}

/** The same address with `filter` written into it and every other parameter
 *  as it arrived. All writes nothing: an absent `state` already means it. */
export function notesAddressWith(search: URLSearchParams, filter: NoteWorkFilter): URLSearchParams {
  const next = new URLSearchParams();
  for (const [key, value] of search) {
    if (key !== NOTE_FILTER_PARAM) next.append(key, value);
  }
  if (filter !== 'all') next.set(NOTE_FILTER_PARAM, filter);
  return next;
}
