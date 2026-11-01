/**
 * What has been JOTTED DOWN, directly under the agents that read it.
 *
 * The card is a GLIMPSE, not the list: the most recent few, then a row onto
 * the screen that holds all of them. Every note on home made this the tallest
 * section on the page by some distance.
 *
 * Unlike Knowledge and Sites it stands on an EMPTY account too, because the
 * row at the foot of it is how the user writes one — a section that is a way
 * IN is worth a row of its own, the way Agents is. It goes only when the
 * backend has no note store at all: null is that answer, and it really is
 * absent.
 */

import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { toFor, workspaceScope } from '../../routes.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { NoteSwipeRow } from '../notes/NoteRow.js';
import { ArchiveDoorRow, NotesDoorRow, NotesEmpty, WriteNoteRow } from '../notes/NoteList.js';
import { NOTES_SHOWN } from '../notes/note-words.js';
import { pruneNotePreviewUrls } from '../notes/note-previews.js';
import { useArchiveFromList } from '../notes/useArchiveFromList.js';

/** `onWrite` rather than a composer of its own: the box is a transient leaf
 *  and a leaf COVERS the screen it opened over. Rendered from here it would
 *  sit between the fleet above and the classic card below — a form embedded in
 *  the middle of Home rather than a screen standing in front of it. */
export function Notes({ onWrite }: { onWrite: () => void }) {
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const archive = useArchiveFromList();

  const stored = state?.notes;
  // One identity per read, so the prune below does not run on every render.
  const notes = useMemo(() => stored ?? null, [stored]);
  const archived = state?.notesArchived ?? 0;
  useEffect(() => { pruneNotePreviewUrls(notes); }, [notes]);

  const scope = workspaceScope(state?.org?.orgId);
  const openNote = (number: number) => navigate(toFor({ kind: 'note', id: String(number), ...scope })!);

  if (!notes) return null;

  // An idle note is the same note its row calls Unclaimed: no live lease,
  // proposal, merge or deployment is holding it. The state payload already
  // carries that answer for every row, so the heading adds no request.
  const idle = notes.filter((note) => note.work?.state === 'unclaimed').length;
  return (
    <>
      <h2 className="noteshead homehead" id="notesHead">
        <span>Notes</span>
        <span
          className="notecounts"
          id="noteCounts"
          aria-label={`${notes.length} notes total, ${idle} idle`}
        >
          <span>{notes.length} total</span>
          <span className="sep"> · </span>
          <span className="idle">{idle} idle</span>
        </span>
      </h2>
      <div className="card" id="notesCard">
        <div id="notes">
          {notes.length === 0 ? <NotesEmpty archived={archived} /> : null}
          {notes.slice(0, NOTES_SHOWN).map((note) => (
            <NoteSwipeRow note={note} key={note.id} onOpen={openNote} onArchive={archive} />
          ))}
          {/* The door, only when there is something behind it: at six notes or
              fewer the card already holds every one, and a row saying "all 6
              notes" over the six of them is a tap that gives nothing back. */}
          {notes.length > NOTES_SHOWN
            ? <NotesDoorRow notes={notes} onOpen={() => navigate(toFor({ kind: 'notes', ...scope })!)} />
            : null}
          {/* The archive under both, last: it is the least urgent thing in the
              card and must not sit between the notes and the way to the rest
              of them. */}
          {archived
            ? <ArchiveDoorRow archived={archived} onOpen={() => navigate(toFor({ kind: 'noteArchive', ...scope })!)} />
            : null}
        </div>
        <WriteNoteRow id="newNoteBtn" onPress={onWrite} />
      </div>
    </>
  );
}
