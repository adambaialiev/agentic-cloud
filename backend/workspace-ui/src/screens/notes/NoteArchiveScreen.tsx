/**
 * The archive: every note put away, most recently first.
 *
 * Its own fetch rather than a slice of the state read — unlike the notes
 * list, which is already in hand. These rows are read rarely, and a hundred
 * put-away titles in every state load would be a cost paid by every screen to
 * serve this one.
 *
 * The same rows the notes list draws: a note in here is still a whole note,
 * and reading one is the main reason to come. What is different is on the
 * note's own screen, where Archive is replaced by Restore and by the only
 * Delete in the product — and there is no swipe here, because the gesture
 * that files a note away has nothing left to do to one already filed.
 *
 * The workplace's one archive (note #843): it was the room's the address
 * named — or the Chief of Staff's own room's — while notes were a room's.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceNoteListAnswer, WorkspaceNoteRow } from '../../../../src/shared/workspace-api.js';
import { toFor, workspaceScope } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { NoteRow } from './NoteRow.js';
import { NoteSearchField, NoteSearchRows } from './NoteList.js';
import { NOTE_SEARCH_AT, archiveScreenSub, noteSearchSub } from './note-words.js';
import { useNoteSearch } from './useNoteSearch.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function NoteArchiveScreen() {
  const { state, status } = useWorkspace();
  const { api } = useSession();
  const navigate = useNavigate();
  const search = useNoteSearch();
  const [notes, setNotes] = useState<WorkspaceNoteRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void api.api<WorkspaceNoteListAnswer>('api/notes/archive')
      .then((answer) => { if (alive) { setNotes(answer.notes ?? []); setError(''); } })
      // A failed OPEN has nothing to leave standing, so it says why.
      .catch((failure) => { if (alive) setError(errorMessage(failure)); });
    return () => { alive = false; };
  }, [api]);

  const scope = workspaceScope(state?.org?.orgId);
  const openNote = (number: number) => navigate(toFor({ kind: 'note', id: String(number), ...scope })!);
  const archived = state?.notesArchived ?? 0;
  const live = state?.notes?.length ?? 0;

  if (status === 'loading') {
    return (
      <div className="screen" id="screenNoteArchive" aria-busy="true">
        <ScreenTitle title="Archive" />
        <div id="loading"><span className="sr-only">Loading your archive…</span></div>
      </div>
    );
  }

  return (
    <div className="screen" id="screenNoteArchive">
      <ScreenTitle title="Archive" />
      <div className="sub" id="noteArchiveSub">
        {search.active ? noteSearchSub(search) : archiveScreenSub(notes?.length ?? 0)}
      </div>
      <div className="card">
        <NoteSearchField
          search={search}
          holderId="noteArchiveSearch"
          earned={live + archived >= NOTE_SEARCH_AT}
        />
        <div id="noteArchiveList">
          {search.active
            ? <NoteSearchRows search={search} onOpen={openNote} />
            : error
              ? <div className="empty">{error}</div>
              : notes === null
                ? <div className="empty">Loading…</div>
                : notes.length === 0
                  // The last one restored or deleted from its own screen, which
                  // sends the reader back in here. Nothing is wrong; the archive
                  // is simply empty.
                  ? <div className="empty">Nothing in your archive.</div>
                  : notes.map((note) => (
                    <NoteRow note={note} key={note.id} onOpen={openNote} />
                  ))}
        </div>
      </div>
    </div>
  );
}
