/**
 * Every note, on its own screen: the same rows home glimpses, with nothing
 * left off.
 *
 * The list follows the data, because home's card is not the only place a load
 * has to keep fresh — a reader can be standing here while the five-second
 * read lands, or have just archived the note that put them here. That is free
 * in this shell: the rows are the provider's `notes`, so a read repaints them
 * where they stand.
 *
 * Arriving is arriving at the LIST — the whole of it. A query typed here on
 * an earlier visit has been answered; starting inside it reads as notes gone
 * missing, and a screen that mounts fresh is exactly that rule. The state the
 * list is narrowed to is different: it is written into this entry's address
 * (`notes-address.ts`, note #419), so Back from a note returns to the list as
 * it was left, while a door into Notes — which writes no state — still opens
 * the whole of it.
 *
 * The workplace's one list (note #843). While notes were a room's it was the
 * room's the address or the viewed room named, and the Chief of Staff's own
 * room had a list of its own under its name; both are the same notes now.
 */

import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { toFor, workspaceScope } from '../../routes.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { NoteComposer } from './NoteComposer.js';
import { NoteSwipeRow } from './NoteRow.js';
import {
  ArchiveDoorRow, NoteFilterChips, NoteSearchField, NoteSearchRows, NotesEmpty, WriteNoteRow,
} from './NoteList.js';
import {
  NOTE_SEARCH_AT, noteFilterChips, noteFilterSub, noteInFilter, noteSearchSub, notesScreenSub,
} from './note-words.js';
import type { NoteWorkFilter } from './note-words.js';
import { addressNoteFilter, notesAddressWith } from './notes-address.js';
import { pruneNotePreviewUrls } from './note-previews.js';
import { useArchiveFromList } from './useArchiveFromList.js';
import { useNoteSearch } from './useNoteSearch.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

export function NotesScreen() {
  const { state, status } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  // The Workplace window's "Write a note" lands here with the box up (note
  // #843), as Add a secret lands on the secrets screen with its form.
  const [composing, setComposing] = useState(() => Boolean((location.state as { compose?: boolean } | null)?.compose));
  // Taken once, and the entry forgets it: a save ends on the new note, and
  // Back from there must land on the list, not on a second empty box.
  useEffect(() => {
    const arrived = location.state as Record<string, unknown> | null;
    if (!arrived?.compose) return;
    const kept = { ...arrived };
    delete kept.compose;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: Object.keys(kept).length ? kept : null });
  }, [location.pathname, location.search, location.state, navigate]);
  const search = useNoteSearch();
  // The chip lives in this entry's address, so the list a note was opened
  // from is the list Back returns to. Written in place: the browser's Back
  // still goes back a SCREEN, not a chip at a time.
  const [address, setAddress] = useSearchParams();
  const filter = addressNoteFilter(address);
  const setFilter = (next: NoteWorkFilter) => {
    setAddress(notesAddressWith(address, next), { replace: true, state: location.state });
  };
  const archive = useArchiveFromList();

  const stored = state?.notes;
  // One identity per read: `?? []` builds a fresh array every render, and the
  // prune below would then run on each of them.
  const notes = useMemo(() => stored ?? [], [stored]);
  const shown = useMemo(() => notes.filter((note) => noteInFilter(note.work, filter)), [notes, filter]);
  const chips = noteFilterChips(notes, filter);
  const archived = state?.notesArchived ?? 0;
  // Only what the account carries now: the map measures what it HAS, not
  // everything this session has ever painted.
  useEffect(() => { pruneNotePreviewUrls(notes); }, [notes]);

  const scope = workspaceScope(state?.org?.orgId);
  const openNote = (number: number) => navigate(toFor({ kind: 'note', id: String(number), ...scope })!);
  const openArchive = () => navigate(toFor({ kind: 'noteArchive', ...scope })!);

  if (composing) return <NoteComposer onClose={() => setComposing(false)} />;
  // "0 notes" before the read lands is a lie, and the reader acts on it: the
  // screen says nothing until it has something true to say.
  if (status === 'loading') {
    return (
      <div className="screen" id="screenNotes" aria-busy="true">
        <ScreenTitle title="Notes" />
        <div id="loading"><span className="sr-only">Loading your notes…</span></div>
      </div>
    );
  }

  return (
    <div className="screen" id="screenNotes">
      <ScreenTitle title="Notes" />
      <div className="sub" id="notesSub">
        {search.active
          ? noteSearchSub(search)
          : filter === 'all'
            ? notesScreenSub(notes.length)
            : noteFilterSub(shown.length, notes.length, filter)}
      </div>
      <div className="card">
        <NoteSearchField
          search={search}
          holderId="notesSearch"
          earned={notes.length + archived >= NOTE_SEARCH_AT}
        />
        {/* A search spans the archive as well as this list, so the chips —
            which cannot reach in there — stand down while one is under way.
            The choice itself is kept: clearing the field puts the reader back
            in front of the list they left, chip and all. */}
        {search.active
          ? null
          : <NoteFilterChips chips={chips} chosen={filter} onChoose={setFilter} />}
        <div id="notesList">
          {/* A search under way owns the list: the rows are its results and
              the subtitle is its count. The archive door keeps its place at
              the foot — it answers a different question and a search must not
              wall it off. */}
          {search.active
            ? <NoteSearchRows search={search} onOpen={openNote} />
            : notes.length === 0
              ? <NotesEmpty archived={archived} />
              // The chosen state can be emptied by a read landing under the
              // reader's hands. Its chip stands (`noteFilterChips`), and the
              // subtitle above says what happened, so this line is only the
              // way back.
              : shown.length === 0
                ? <div className="empty">All shows every note.</div>
                : shown.map((note) => (
                  <NoteSwipeRow
                    note={note}
                    key={note.id}
                    onOpen={openNote}
                    onArchive={archive}
                  />
                ))}
        </div>
        <WriteNoteRow id="notesAddBtn" onPress={() => setComposing(true)} />
      </div>
      {/* In a card of its own so it is not read as one more note in the list
          above it. */}
      {archived ? (
        <div className="card" id="notesArchiveCard">
          <div id="notesArchiveDoor"><ArchiveDoorRow archived={archived} onOpen={openArchive} /></div>
        </div>
      ) : null}
    </div>
  );
}
