/**
 * The note LISTS, end to end against a scripted API: home's glimpse, the
 * notes screen, the archive and the search across both — the same things the
 * legacy page's grab()-based tests hold its note rows to
 * (telegram-miniapp-notes), driven the way a person drives them.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { WorkspaceApiError, type WorkspaceApi } from '../../api/client.js';
import { emptyState, homeShelf, note, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { forgetNotePreviewUrls } from './note-previews.js';
import { SEARCH_DEBOUNCE_MS } from './useNoteSearch.js';

/** The address itself: the notes list writes its chosen state into its own
 *  entry (note #419), and that is only true if the address says so. */
function Address() {
  const location = useLocation();
  return <div data-testid="address">{`${location.pathname}${location.search}`}</div>;
}
const address = () => screen.getByTestId('address').textContent;

function renderAt(path: string, api: WorkspaceApi) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Address />
      <App api={api} />
    </MemoryRouter>,
  );
}

const at = (path: string, state: WorkspaceStateAnswer, extra: Record<string, Answer> = {}) => {
  const scripted = scriptedApi({ ...workspaceScript(() => state), ...extra });
  renderAt(path, scripted.api);
  return scripted;
};

// Home keeps its notes card in the Workplace window, which is not what Home
// opens on; the notes SCREEN has no window at all. One helper for both,
// because most of these tests only care that the notes are in front of them
// — whichever screen is drawing them.
const findNotes = async () => {
  // Wait for whichever screen is drawing the notes to have read its state:
  // the notes screen's own list, or Home. Then, on Home, walk to the card
  // through `homeShelf`, the way a person does: Home is the Chief of Staff's
  // conversation (note #715), and the notes are the Workplace window's,
  // opened by the workplace's name in the header. (They were a room's shelf,
  // a tab of the agents picker, until rooms left the product — note #843.) A
  // personal workspace has no window: its Home draws the card in its one
  // column.
  await waitFor(() => {
    if (!document.getElementById('screenNotes') && !document.getElementById('agentsSection')
      && !document.getElementById('homeWorkplaceDoor')) {
      throw new Error('no notes yet, on either screen');
    }
  });
  if (!document.getElementById('screenNotes')) await homeShelf('notes');
  return screen.findByRole('heading', { name: /^Notes/ });
};
const rowOf = (title: string) => screen.getByText(title).closest('.crow') as HTMLElement;
const rows = (boxId: string) => [...document.querySelectorAll(`#${boxId} .crow`)] as HTMLElement[];
// `isPrimary` is what a real finger sends and what the row insists on: a
// second touch mid-gesture must not start a second drag.
const touch = { pointerId: 1, pointerType: 'touch', isPrimary: true };
const swipe = (row: HTMLElement, to: number) => {
  fireEvent.pointerDown(row, { ...touch, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(row, { ...touch, clientX: to, clientY: 0 });
  fireEvent.pointerUp(row, { ...touch, clientX: to, clientY: 0 });
};

beforeEach(() => { forgetNotePreviewUrls(); });
afterEach(() => { vi.useRealTimers(); });

describe('a note as a row', () => {
  it('is the note’s first line, with the rest of it underneath', async () => {
    at('/', emptyState({
      notes: [note({
        number: 12, title: 'Call the plumber back', preview: 'He is closed on Mondays.',
        agentName: 'Kai', agentAvatarUrl: '/faces/kai.png', updatedAt: '2026-09-02T09:00:00Z',
      })],
    }));
    await findNotes();
    const row = rowOf('Call the plumber back');
    expect(row.querySelector('.name')!.textContent).toBe('Call the plumber back');
    const line = row.querySelector('.cline')!;
    expect((line.querySelector('img.face') as HTMLImageElement).getAttribute('src')).toBe('/faces/kai.png');
    expect(line.querySelector('.ctext.keep')!.textContent).toBe('Kai');
    expect([...line.querySelectorAll('.ctext')].map((n) => n.textContent))
      .toEqual(['Kai', 'He is closed on Mondays.']);
    // The number is the name every other surface calls this note by, in the
    // column the numbers live in (note #19).
    expect(row.querySelector('.cside .num')!.textContent).toBe('#12');
    expect(row.querySelector('.cside .cwhen')).toBeTruthy();
  });

  it('is the agent alone on a one-line note — no repeat of itself, no dangling separator', async () => {
    at('/', emptyState({ notes: [note({ number: 3, title: 'The wifi code is 4417', agentName: 'Kai' })] }));
    await findNotes();
    const line = rowOf('The wifi code is 4417').querySelector('.cline')!;
    expect(line.textContent).toBe('Kai');
    expect(line.querySelector('.csep')).toBeNull();
  });

  it('shows every structured state the note can be in', async () => {
    at('/', emptyState({
      notes: [
        note({ number: 1, title: 'Idle one', work: { state: 'unclaimed' } }),
        note({ number: 2, title: 'Handed one', work: { state: 'handed', agentName: 'Kai' } }),
        note({ number: 3, title: 'Busy one', work: { state: 'working', agentName: 'Oscar' } }),
        note({ number: 4, title: 'Proposed one', work: { state: 'proposal', proposalNumber: 9 } }),
        note({ number: 5, title: 'Merged one', work: { state: 'merged', proposalNumber: 9 } }),
        note({ number: 6, title: 'Live one', work: { state: 'live', proposalNumber: 9 } }),
      ],
    }));
    await findNotes();
    expect(rowOf('Idle one').querySelector('.badge')!.textContent).toBe('Unclaimed');
    expect(rowOf('Handed one').querySelector('.badge')!.className).toBe('badge agent');
    expect(rowOf('Handed one').querySelector('.badge')!.textContent).toBe('Handed to Kai');
    expect(rowOf('Busy one').querySelector('.badge')!.className).toBe('badge busy');
    expect(rowOf('Busy one').querySelector('.badge')!.textContent).toBe('Working by Oscar');
    expect(rowOf('Proposed one').querySelector('.badge')!.textContent).toBe('PR #9');
    expect(rowOf('Merged one').querySelector('.badge')!.textContent).toBe('Merged');
    expect(rowOf('Live one').querySelector('.badge')!.className).toBe('badge ok');
  });

  it('counts a handed note as dealt with, not idle, in the heading', async () => {
    at('/', emptyState({
      notes: [
        note({ number: 1, title: 'One', work: { state: 'unclaimed' } }),
        note({ number: 2, title: 'Two', work: { state: 'handed', agentName: 'Kai' } }),
        note({ number: 3, title: 'Three', work: { state: 'unclaimed' } }),
      ],
    }));
    await findNotes();
    const counts = document.getElementById('noteCounts')!;
    expect(counts.textContent).toBe('3 total · 2 idle');
    expect(counts.getAttribute('aria-label')).toBe('3 notes total, 2 idle');
  });

  it('signs a person’s note with their name and face, never "you wrote this"', async () => {
    at('/', emptyState({
      notes: [
        note({ number: 1, title: 'Mine', byUser: true, authorName: 'Owner Example', authorPhotoUrl: '/faces/owner.png' }),
        note({ number: 2, title: 'Faceless', byUser: true, authorName: 'Owner Example' }),
        note({ number: 3, title: 'Unnamed', byUser: true }),
        note({ number: 4, title: 'Theirs', byMember: true, authorName: 'Aisha Karimova' }),
      ],
    }));
    await findNotes();
    expect((rowOf('Mine').querySelector('img.face') as HTMLImageElement).getAttribute('src')).toBe('/faces/owner.png');
    expect(rowOf('Mine').querySelector('.ctext.keep')!.textContent).toBe('Owner Example');
    // The dot every faceless person wears, drawn rather than poured in.
    expect(rowOf('Faceless').querySelector('.face.dot svg')).toBeTruthy();
    expect(rowOf('Unnamed').querySelector('.ctext.keep')!.textContent).toBe('You');
    expect(rowOf('Theirs').querySelector('.ctext.keep')!.textContent).toBe('Aisha Karimova');
  });

  it('says what the newest remark SAID, signed by its OWN author', async () => {
    at('/', emptyState({
      notes: [note({
        number: 7, title: 'The plumber', byUser: true, authorName: 'Owner Example', comments: 1,
        lastComment: {
          html: '<p>Called them, <strong>closed Mondays</strong>.</p>',
          text: 'Called them, closed Mondays.',
          agentName: 'Kai', agentAvatarUrl: '/faces/kai.png',
        },
      })],
    }));
    await findNotes();
    const said = rowOf('The plumber').querySelector('.cline.said')!;
    // The remark's WORDS are built as DOM by the allowlist renderer, inside an
    // effect — the line exists a tick before its text does. Reading straight
    // through was a race that only showed up on a slower machine (the same
    // one Decisions.test.tsx had); wait for the words, then read the line.
    await waitFor(() => expect(said.querySelector('strong')).not.toBeNull());
    expect(said.querySelector('.ctext.keep')!.textContent).toBe('Kai');
    expect((said.querySelector('img.face') as HTMLImageElement).getAttribute('src')).toBe('/faces/kai.png');
    expect(said.textContent).toContain('Called them, closed Mondays.');
    expect(said.querySelector('strong')!.textContent).toBe('closed Mondays');
    // "1 comment" over the comment itself is the row telling the reader twice.
    expect([...rowOf('The plumber').querySelectorAll('.badge')]).toHaveLength(0);
  });

  it('keeps the count when there is more behind the remark it shows', async () => {
    at('/', emptyState({
      notes: [note({
        number: 7, title: 'Busy thread', byUser: true, comments: 4,
        lastComment: { html: '<p>Done.</p>', text: 'Done.', byPerson: true, userName: 'Owner Example' },
      })],
    }));
    await findNotes();
    expect(rowOf('Busy thread').querySelector('.badge')!.textContent).toBe('4 comments');
    // A person's remark is signed with their own name, not the note's author.
    expect(rowOf('Busy thread').querySelector('.cline.said .ctext.keep')!.textContent).toBe('Owner Example');
  });

  it('gives an unsigned remark the dot, so the line still reads as somebody else’s words', async () => {
    at('/', emptyState({
      notes: [note({
        number: 8, title: 'Orphaned', byUser: true,
        lastComment: { html: '<p>Left behind.</p>', text: 'Left behind.' },
      })],
    }));
    await findNotes();
    const said = rowOf('Orphaned').querySelector('.cline.said')!;
    expect(said.querySelector('.face.dot')).toBeTruthy();
    expect(said.querySelector('.csep')).toBeNull();
  });

  it('does not leave an empty line where the words used to be', async () => {
    at('/', emptyState({
      notes: [note({
        number: 9, title: 'Just mine', comments: 1,
        lastComment: { html: '<p>Fine.</p>', text: 'Fine.', agentName: 'Kai' },
      })],
    }));
    await findNotes();
    const lines = [...rowOf('Just mine').querySelectorAll('.cline')];
    expect(lines).toHaveLength(1);
    expect(lines[0]!.classList.contains('said')).toBe(true);
  });

  it('is a real link to the note, so the browser can open it in a new tab', async () => {
    at('/', emptyState({
      org: { orgId: 'o1', name: 'Nomad', role: 'admin', members: 1, seats: 1, seatProviders: [] },
      // The answer still names the room the workplace once stood in; the link
      // carries none (note #843).
      notes: [note({ number: 115, title: 'Preview files' })],
    }));
    await findNotes();
    const row = rowOf('Preview files');
    expect(row.tagName).toBe('A');
    // The address a copied link carries — written by the one registry, the
    // same one a tap writes: the workplace's, and no room.
    expect(row.getAttribute('href')).toBe('/notes/115?org=o1');
    // An anchor is already a door: it must not also claim to be a button.
    expect(row.getAttribute('role')).toBeNull();
    // A link is draggable by default, which would fight the swipe.
    expect(row.getAttribute('draggable')).toBe('false');
  });

  it('leaves a modifier-click to the browser, and answers a plain one itself', async () => {
    at('/', emptyState({
      org: { orgId: 'o1', name: 'Nomad', role: 'admin', members: 1, seats: 1, seatProviders: [] },
      notes: [note({ number: 115, title: 'Preview files' })],
    }), { 'GET api/notes/115': () => ({ note: { number: 115, title: 'Preview files', html: '<p>Body</p>', comments: [] } }) });
    await findNotes();
    const row = rowOf('Preview files');
    const withMeta = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    fireEvent(row, withMeta);
    // Untouched: the browser opens its own tab, and the shell stays put.
    expect(withMeta.defaultPrevented).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Preview files' })).toBeNull();
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    fireEvent(row, plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(await screen.findByRole('heading', { name: 'Preview files' })).toBeTruthy();
  });

  it('opens the note by NUMBER, which is what addresses one', async () => {
    at('/', emptyState({
      org: { orgId: 'o1', name: 'Nomad', role: 'admin', members: 1, seats: 1, seatProviders: [] },
      notes: [note({ number: 115, title: 'Preview files' })],
    }), { 'GET api/notes/115': () => ({ note: { number: 115, title: 'Preview files', html: '<p>Body</p>', comments: [] } }) });
    await findNotes();
    fireEvent.click(rowOf('Preview files'));
    expect(await screen.findByRole('heading', { name: 'Preview files' })).toBeTruthy();
  });
});

/**
 * A note link named the room the note was looked up in, and one that named
 * the wrong room was corrected in place (note #741), until rooms left the
 * product (note #843): numbers are the workplace's, and a note is read with
 * no room at all. A link copied before then still carries `&room=`.
 */
describe('an old link that names a room (note #843)', () => {
  it('opens the note the number names, asking with no room, and leaves the address alone', async () => {
    const { calls } = at('/notes/741?org=o1&room=r2', emptyState({
      org: { orgId: 'o1', name: 'Nomad', role: 'admin', members: 1, seats: 1, seatProviders: [] },
    }), {
      'GET api/notes/741': () => ({ note: { number: 741, title: 'Number notes across the workplace', html: '<p>Body</p>', comments: [] } }),
    });
    expect(await screen.findByRole('heading', { name: 'Number notes across the workplace' })).toBeTruthy();
    expect(calls.filter((call) => call.path.startsWith('api/notes/741')).map((call) => call.path)).toEqual(['api/notes/741']);
    expect(calls.some((call) => /[?&]room=/.test(call.path) || 'room' in (call.scope ?? {}))).toBe(false);
    // Nothing to correct: the screen does not rewrite an address it can read.
    expect(address()).toBe('/notes/741?org=o1&room=r2');
  });

  it('opens the one notes list from a link to a room’s, the Chief of Staff’s own included (notes #458, #487)', async () => {
    // The answer still carries the Chief of Staff's old copy as `workspace`;
    // nothing reads it — the workplace's notes are the one list.
    const { calls } = at('/notes?org=o1&room=ws', emptyState({
      org: { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 1, seats: 0, seatProviders: [] },
      notes: [note({ number: 3, title: 'A workplace note' })], notesArchived: 0,
      workspace: { room: 'ws', notes: [note({ number: 7, title: 'Call the printer' })], notesArchived: 2 },
    } as never));
    // The title stands before the state lands; the row is what says it has.
    expect(await screen.findByText('A workplace note')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Notes/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Chief of Staff’s room' })).toBeNull();
    expect(screen.queryByText('Call the printer')).toBeNull();
    expect(screen.queryByText('2 notes put away')).toBeNull();
    expect(calls.some((call) => /[?&]room=/.test(call.path) || 'room' in (call.scope ?? {}))).toBe(false);
  });
});

describe('what a note carries, on its row', () => {
  it('names the attached file and counts what is behind it', async () => {
    const { calls } = at('/', emptyState({
      notes: [note({
        number: 115, title: 'Preview files', byUser: true, files: 3,
        attachmentPreview: { id: 'photo-1', fileName: 'IMG_4045.png', contentType: 'image/png', sizeBytes: 335872 },
      })],
    }), { 'GET api/notes/115/files/photo-1': () => ({ url: 'https://signed.example/IMG_4045.png', fileName: 'IMG_4045.png', expiresAt: new Date(Date.now() + 900_000).toISOString() }) });
    await findNotes();
    const row = rowOf('Preview files');
    const fileLine = row.querySelector('.cline.nfile')!;
    const mark = fileLine.querySelector('.notepeek')!;
    // The row has no repeated leading note icon; the mark belongs to the main
    // cell, beside the file name.
    expect(row.firstElementChild!.classList.contains('main')).toBe(true);
    expect(mark.getAttribute('title')).toBe('IMG_4045.png');
    expect(fileLine.textContent).toBe('IMG_4045.png+2 more');
    expect(row.textContent).not.toContain('335872');
    await waitFor(() => expect(mark.querySelector('img')!.getAttribute('src'))
      .toBe('https://signed.example/IMG_4045.png'));
    expect(calls.filter((call) => call.path.includes('/files/'))).toHaveLength(1);
  });

  it('previews a non-image as its file kind without asking storage for pixels', async () => {
    const { calls } = at('/', emptyState({
      notes: [note({
        number: 116, title: 'The report', byUser: true, files: 1,
        attachmentPreview: { id: 'doc-1', fileName: 'report.pdf', contentType: 'application/pdf', sizeBytes: 2048 },
      })],
    }));
    await findNotes();
    const mark = rowOf('The report').querySelector('.notepeek')!;
    expect(mark.querySelector('svg')).toBeTruthy();
    expect(mark.querySelector('img')).toBeNull();
    expect(calls.some((call) => call.path.includes('/files/'))).toBe(false);
  });

  it('falls back to a bare count on a backend that sends no preview', async () => {
    at('/', emptyState({ notes: [note({ number: 5, title: 'Old shape', byUser: true, files: 2 })] }));
    await findNotes();
    expect(rowOf('Old shape').querySelector('.badge')!.textContent).toBe('2 files');
  });

  it('mints one URL for a photograph home and the notes screen both draw', async () => {
    const state = emptyState({
      notes: [note({
        number: 115, title: 'Preview files', byUser: true, files: 1,
        attachmentPreview: { id: 'photo-1', fileName: 'a.png', contentType: 'image/png', sizeBytes: 1 },
      })],
    });
    const { calls } = at('/notes', state, {
      'GET api/notes/115/files/photo-1': () => ({ url: 'https://signed.example/a.png', fileName: 'a.png', expiresAt: new Date(Date.now() + 900_000).toISOString() }),
    });
    await screen.findByText('Preview files');
    await waitFor(() => expect(document.querySelector('.notepeek img')).toBeTruthy());
    // The row is rebuilt by every state read; the browser holds those bytes
    // against that exact URL, so the picture goes back WITH the row.
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Back' })); });
    await findNotes();
    await waitFor(() => expect(document.querySelector('.notepeek img')).toBeTruthy());
    expect(calls.filter((call) => call.path.includes('/files/'))).toHaveLength(1);
  });

  it('asks again after storage refused it once — a refusal must not blank the glimpse for the session', async () => {
    let refuse = true;
    const state = emptyState({
      notes: [note({
        number: 115, title: 'Preview files', byUser: true, files: 1,
        attachmentPreview: { id: 'photo-1', fileName: 'a.png', contentType: 'image/png', sizeBytes: 1 },
      })],
    });
    const { calls } = at('/notes', state, {
      'GET api/notes/115/files/photo-1': () => {
        if (refuse) throw new WorkspaceApiError('Storage said no.', 503, {});
        return { url: 'https://signed.example/a.png', fileName: 'a.png', expiresAt: new Date(Date.now() + 900_000).toISOString() };
      },
    });
    await screen.findByText('Preview files');
    await waitFor(() => expect(calls.filter((call) => call.path.includes('/files/'))).toHaveLength(1));
    expect(document.querySelector('.notepeek img')).toBeNull();
    refuse = false;
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Back' })); });
    await findNotes();
    await waitFor(() => expect(document.querySelector('.notepeek img')).toBeTruthy());
  });

  it('never holds a URL it cannot tell the age of', async () => {
    const state = emptyState({
      notes: [note({
        number: 115, title: 'Preview files', byUser: true, files: 1,
        attachmentPreview: { id: 'photo-1', fileName: 'a.png', contentType: 'image/png', sizeBytes: 1 },
      })],
    });
    const { calls } = at('/notes', state, {
      'GET api/notes/115/files/photo-1': () => ({ url: 'https://signed.example/a.png', fileName: 'a.png', expiresAt: 'not a date' }),
    });
    await screen.findByText('Preview files');
    await waitFor(() => expect(document.querySelector('.notepeek img')).toBeTruthy());
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Back' })); });
    await findNotes();
    // An undatable URL is used once and never held: the next paint mints its
    // own rather than drawing a picture an expired signature has broken.
    await waitFor(() => expect(calls.filter((call) => call.path.includes('/files/')).length).toBe(2));
  });
});

describe('home’s glimpse of the notes', () => {
  it('stands on an empty account, because the row at the foot is a way IN', async () => {
    at('/', emptyState({ notes: [] }));
    await findNotes();
    expect(screen.getByText('Keep quick context here')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Write a note/ })).toBeTruthy();
  });

  // The Workplace window has no box of its own: Write a note opened one in
  // place while the card was a room's shelf, until rooms left the product
  // (note #843). Now it opens the notes list with the box up — and the note
  // it saves is one Back away from that LIST, not from a second empty box.
  it('writes from the Workplace window on the notes list, which Back from the saved note lands on', async () => {
    at('/', emptyState({
      org: { orgId: 'o1', name: 'Nomad', role: 'admin', members: 1, seats: 1, seatProviders: [] },
      notes: [], noteFiles: true,
    }), {
      'POST api/notes': () => ({ ok: true, note: note({ number: 21, title: 'The wifi code is 4417' }), title: 'The wifi code is 4417' }),
      'GET api/notes/21': () => ({ note: { number: 21, title: 'The wifi code is 4417', html: '<p>The wifi code is 4417</p>', comments: [] } }),
    });
    await findNotes();
    fireEvent.click(document.getElementById('newNoteBtn')!);
    await screen.findByRole('heading', { name: 'Write a note' });
    expect(address()).toBe('/notes?org=o1');
    fireEvent.change(document.getElementById('noteText')!, { target: { value: 'The wifi code is 4417' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'The wifi code is 4417' });
    fireEvent.click(document.getElementById('pageBack')!);
    await waitFor(() => expect(document.getElementById('notesList')).toBeTruthy());
    expect(address()).toBe('/notes?org=o1');
    expect(screen.queryByRole('heading', { name: 'Write a note' })).toBeNull();
    expect(document.getElementById('noteText')).toBeNull();
  });

  it('goes entirely when the backend has no note store at all', async () => {
    at('/', emptyState({ notes: null }));
    await homeShelf();
    expect(document.getElementById('notesCard')).toBeNull();
  });

  it('stops at six and offers the rest, saying how many there are in all', async () => {
    at('/', emptyState({
      notes: Array.from({ length: 9 }, (_, at$) => note({ number: at$ + 1, title: `Note ${at$ + 1}` })),
    }));
    await findNotes();
    expect(rows('notes').filter((row) => row.querySelector('.num'))).toHaveLength(6);
    expect(screen.getByRole('button', { name: /All 9 notes/ })).toBeTruthy();
  });

  it('draws no door when the card already holds every note', async () => {
    at('/', emptyState({
      notes: Array.from({ length: 6 }, (_, at$) => note({ number: at$ + 1, title: `Note ${at$ + 1}` })),
    }));
    await findNotes();
    expect(screen.queryByRole('button', { name: /All 6 notes/ })).toBeNull();
  });

  it('offers the archive on home too, because a five-note account has no other way in', async () => {
    at('/', emptyState({ notes: [note({ number: 1, title: 'One' })], notesArchived: 3 }));
    await findNotes();
    expect(screen.getByRole('button', { name: /Archive/ }).textContent).toContain('3 notes put away');
  });
});

describe('swiping a note right to archive it', () => {
  it('offers the gesture on the home glance and the full notes list', async () => {
    at('/', emptyState({ notes: [note({ number: 1, title: 'Swipe me', yours: true })] }));
    await findNotes();
    const row = rowOf('Swipe me');
    expect(row.classList.contains('noteswiperow')).toBe(true);
    expect(row.getAttribute('aria-description')).toBe('Swipe right to archive this note.');
    expect(row.closest('.noteswipe')!.querySelector('.noteswipeaction')!.textContent).toContain('Archive');
  });

  // Note #637: filing a note is its author's to do, so the row a teammate
  // wrote is the plain row — no action behind it, and nothing under the
  // finger that could end in a refusal.
  it('offers nothing to swipe on a note the reader does not keep', async () => {
    at('/', emptyState({
      notes: [
        note({ number: 1, title: 'Theirs', byMember: true, authorName: 'Aisha Karimova' }),
        note({ number: 2, title: 'Mine', yours: true }),
      ],
    }));
    await findNotes();
    const theirs = rowOf('Theirs');
    expect(theirs.classList.contains('noteswiperow')).toBe(false);
    expect(theirs.getAttribute('aria-description')).toBeNull();
    expect(theirs.closest('.noteswipe')).toBeNull();
    // …and the reader's own row beside it still carries the gesture, so this
    // is the note that decides and not the list.
    expect(rowOf('Mine').classList.contains('noteswiperow')).toBe(true);
  });

  it('settles a short swipe back without opening or archiving the note', async () => {
    const { calls } = at('/', emptyState({ notes: [note({ number: 1, title: 'Swipe me', yours: true })] }));
    await findNotes();
    const row = rowOf('Swipe me');
    swipe(row, 40);
    expect(calls.some((call) => call.path.includes('/archive'))).toBe(false);
    // The gesture consumed its own release, so the note underneath never opens.
    fireEvent.click(row);
    expect(document.getElementById('screenNote')).toBeNull();
    expect(row.closest('.noteswipe')!.className).toBe('noteswipe');
  });

  it('archives past the threshold, removes the row, and never opens the note', async () => {
    let notes = [note({ number: 1, title: 'Swipe me', yours: true }), note({ number: 2, title: 'Keep me', yours: true })];
    const scripted = scriptedApi({
      ...workspaceScript(() => emptyState({ notes })),
      'POST api/notes/1/archive': () => { notes = notes.filter((row) => row.number !== 1); return { ok: true, number: 1, title: 'Swipe me' }; },
    });
    renderAt('/', scripted.api);
    await findNotes();
    swipe(rowOf('Swipe me'), 200);
    await waitFor(() => expect(screen.queryByText('Swipe me')).toBeNull());
    expect(screen.getByText('Keep me')).toBeTruthy();
    expect(document.getElementById('screenNote')).toBeNull();
  });

  it('restores the row and reports the error when the archive is refused', async () => {
    at('/', emptyState({ notes: [note({ number: 1, title: 'Swipe me', yours: true })] }), {
      'POST api/notes/1/archive': () => { throw new WorkspaceApiError('That note is claimed.', 409, {}); },
    });
    await findNotes();
    const row = rowOf('Swipe me');
    swipe(row, 200);
    expect((await screen.findByRole('alert')).textContent).toContain('That note is claimed.');
    await waitFor(() => expect(row.closest('.noteswipe')!.className).toBe('noteswipe'));
    expect(screen.getByText('Swipe me')).toBeTruthy();
  });

  it('lets a vertical drag be a scroll, not a swipe', async () => {
    const { calls } = at('/', emptyState({ notes: [note({ number: 1, title: 'Swipe me', yours: true })] }));
    await findNotes();
    const row = rowOf('Swipe me');
    fireEvent.pointerDown(row, { ...touch, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(row, { ...touch, clientX: 4, clientY: 60 });
    fireEvent.pointerUp(row, { ...touch, clientX: 4, clientY: 60 });
    expect(calls.some((call) => call.path.includes('/archive'))).toBe(false);
    // …and the tap it ends with still opens the note, because nothing
    // horizontal happened.
    expect(row.closest('.noteswipe')!.className).toBe('noteswipe');
  });
});

describe('the notes screen', () => {
  const listState = (count: number, archived = 0) => emptyState({
    notes: Array.from({ length: count }, (_, at$) => note({ number: at$ + 1, title: `Note ${at$ + 1}` })),
    notesArchived: archived,
  });

  it('leaves nothing off, and says how many there are', async () => {
    at('/notes', listState(9));
    await screen.findByText('Note 9');
    expect(rows('notesList')).toHaveLength(9);
    expect(document.getElementById('notesSub')!.textContent).toBe('9 notes, shared with the workplace and its agents.');
  });

  it('draws the same row home draws, opened the same way', async () => {
    at('/notes', emptyState({ notes: [note({ number: 44, title: 'Only one' })] }), {
      'GET api/notes/44': () => ({ note: { number: 44, title: 'Only one', html: '<p>Body</p>', comments: [] } }),
    });
    await screen.findByText('Only one');
    expect(document.getElementById('notesSub')!.textContent).toBe('One note, shared with the workplace and its agents.');
    fireEvent.click(rowOf('Only one'));
    expect(await screen.findByRole('heading', { name: 'Only one' })).toBeTruthy();
  });

  it('says the archive is there, in a card of its own under the list', async () => {
    at('/notes', listState(2, 5));
    await screen.findByText('Note 1');
    const door = document.getElementById('notesArchiveDoor')!;
    expect(door.textContent).toContain('5 notes put away');
    expect(door.closest('.card')!.id).toBe('notesArchiveCard');
  });

  it('is not a dead end when everything has been put away', async () => {
    at('/notes', listState(0, 4));
    expect(await screen.findByText('No active notes')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Write a note/ })).toBeTruthy();
    expect(document.getElementById('notesArchiveDoor')).toBeTruthy();
  });

  it('opens the archive from its door, and fetches those rows on the tap', async () => {
    const { calls } = at('/notes', listState(2, 1), {
      'GET api/notes/archive': () => ({ notes: [note({ number: 90, title: 'Last month', archivedAt: '2026-08-01T09:00:00Z' })] }),
    });
    await screen.findByText('Note 1');
    expect(calls.some((call) => call.path === 'api/notes/archive')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Archive/ }));
    expect(await screen.findByRole('heading', { name: 'Archive' })).toBeTruthy();
    expect(await screen.findByText('Last month')).toBeTruthy();
  });
});

describe('narrowing the notes screen to one state (note #307)', () => {
  const stateful = (extra: Record<string, Answer> = {}, path = '/notes') => at(path, emptyState({
    notes: [
      note({ number: 1, title: 'Idle one', work: { state: 'unclaimed' } }),
      note({ number: 2, title: 'Idle two', work: { state: 'unclaimed' } }),
      note({ number: 3, title: 'Idle three', work: { state: 'unclaimed' } }),
      note({ number: 4, title: 'Handed one', work: { state: 'handed', agentName: 'Kai' } }),
      note({ number: 5, title: 'Busy one', work: { state: 'working', agentName: 'Oscar' } }),
      note({ number: 6, title: 'Busy two', work: { state: 'working', agentName: 'Zoe' } }),
      note({ number: 7, title: 'Landed one', work: { state: 'merged', proposalNumber: 9 } }),
      note({ number: 8, title: 'Out there one', work: { state: 'live', proposalNumber: 9 } }),
      note({ number: 9, title: 'Out there two', work: { state: 'live', proposalNumber: 10 } }),
    ],
    notesArchived: 1,
  }), extra);
  const chips = () => [...document.querySelectorAll('#notesFilter .chip')].map((chip) => chip.textContent);
  const chosen = () => document.querySelector('#notesFilter .chip.here')?.textContent;
  const tapChip = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }));
  const titles = () => rows('notesList').map((row) => row.querySelector('.name')!.textContent);

  it('offers the states this list is actually in, and nothing it is not', async () => {
    stateful();
    await screen.findByText('Idle one');
    // No note here is in a proposal, and a chip for it would be a tap that
    // gives nothing back — the same rule that keeps an empty archive shut.
    expect(chips()).toEqual(['All', 'Unclaimed', 'Handed over', 'Working', 'Merged', 'Live']);
    expect(chosen()).toBe('All');
  });

  it('narrows the list to the chosen state, and counts it above', async () => {
    stateful();
    await screen.findByText('Idle one');
    tapChip('Unclaimed');
    expect(titles()).toEqual(['Idle one', 'Idle two', 'Idle three']);
    expect(document.getElementById('notesSub')!.textContent).toBe('3 of 9 notes are unclaimed.');
    expect(chosen()).toBe('Unclaimed');
    expect(document.querySelector('#notesFilter .chip.here')!.getAttribute('aria-current')).toBe('true');
    // …and the chip a row's own badge answers to.
    expect(rowOf('Idle one').querySelector('.badge')!.textContent).toBe('Unclaimed');
    tapChip('Live');
    expect(titles()).toEqual(['Out there one', 'Out there two']);
    expect(document.getElementById('notesSub')!.textContent).toBe('2 of 9 notes are live.');
    tapChip('All');
    expect(titles()).toHaveLength(9);
    expect(document.getElementById('notesSub')!.textContent).toBe('9 notes, shared with the workplace and its agents.');
  });

  it('is not offered where narrowing would give nothing back', async () => {
    at('/notes', emptyState({
      notes: [
        note({ number: 1, title: 'Idle one', work: { state: 'unclaimed' } }),
        note({ number: 2, title: 'Landed one', work: { state: 'merged', proposalNumber: 2 } }),
      ],
    }));
    await screen.findByText('Idle one');
    // Two states, but the whole list is already in front of the reader.
    expect(document.getElementById('notesFilter')).toBeNull();
  });

  it('nor when every note in a long list is in the same state', async () => {
    at('/notes', emptyState({
      notes: Array.from({ length: 9 }, (_, at$) => note({
        number: at$ + 1, title: `Note ${at$ + 1}`, work: { state: 'unclaimed' },
      })),
    }));
    await screen.findByText('Note 9');
    expect(document.getElementById('notesFilter')).toBeNull();
  });

  it('stands down while a search owns the list, and comes back with the choice intact', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stateful({
      'GET api/notes/search?q=idle': () => ({ notes: [note({ number: 40, title: 'A match from the archive' })] }),
    });
    await screen.findByText('Idle one');
    tapChip('Working');
    expect(titles()).toEqual(['Busy one', 'Busy two']);
    const field = screen.getByRole('searchbox', { name: 'Search notes' });
    fireEvent.change(field, { target: { value: 'idle' } });
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
    await screen.findByText('A match from the archive');
    // A search spans the archive, which these chips cannot reach into.
    expect(document.getElementById('notesFilter')).toBeNull();
    fireEvent.change(field, { target: { value: '' } });
    expect(chosen()).toBe('Working');
    expect(titles()).toEqual(['Busy one', 'Busy two']);
  });

  it('comes Back from a note to the state it was opened from (note #419)', async () => {
    stateful({
      'GET api/notes/7': () => ({ note: { number: 7, title: 'Landed one', html: '<p>Body</p>', comments: [] } }),
    });
    await screen.findByText('Idle one');
    tapChip('Merged');
    expect(titles()).toEqual(['Landed one']);
    expect(address()).toBe('/notes?state=merged');
    fireEvent.click(rowOf('Landed one'));
    await screen.findByRole('heading', { name: 'Landed one' });
    fireEvent.click(document.getElementById('pageBack')!);
    await screen.findByText('Landed one');
    expect(chosen()).toBe('Merged');
    expect(titles()).toEqual(['Landed one']);
    expect(document.getElementById('notesSub')!.textContent).toBe('One of 9 notes is merged.');
  });

  it('writes the chip into its own entry, so Back leaves the SCREEN, not a chip at a time', async () => {
    const scripted = scriptedApi({ ...workspaceScript(() => emptyState({
      notes: Array.from({ length: 9 }, (_, i) => note({
        number: i + 1, title: `Note ${i + 1}`, work: { state: i < 5 ? 'unclaimed' : 'live', proposalNumber: 1 },
      })),
    })) });
    render(
      <MemoryRouter initialEntries={['/', '/notes?org=o1']} initialIndex={1}>
        <Address />
        <App api={scripted.api} />
      </MemoryRouter>,
    );
    await screen.findByText('Note 9');
    tapChip('Unclaimed');
    tapChip('Live');
    // Every other parameter stays exactly as it arrived.
    expect(address()).toBe('/notes?org=o1&state=live');
    tapChip('All');
    // All is what an address with no state already says.
    expect(address()).toBe('/notes?org=o1');
    tapChip('Live');
    fireEvent.click(document.getElementById('pageBack')!);
    await waitFor(() => expect(address()).toBe('/'));
  });

  it('opens a copied address in the state it names', async () => {
    stateful({}, '/notes?state=working');
    await screen.findByText('Busy one');
    expect(chosen()).toBe('Working');
    expect(titles()).toEqual(['Busy one', 'Busy two']);
  });

  it('reads a state it does not know as the whole list, not as an empty one', async () => {
    stateful({}, '/notes?state=someday');
    await screen.findByText('Idle one');
    expect(chosen()).toBe('All');
    expect(titles()).toHaveLength(9);
  });

  it('keeps the way back when the last note in a state goes from under the reader', async () => {
    let notes = [
      note({ number: 1, title: 'Idle one', work: { state: 'unclaimed' } }),
      note({ number: 2, title: 'Idle two', work: { state: 'unclaimed' } }),
      note({ number: 3, title: 'Idle three', work: { state: 'unclaimed' } }),
      note({ number: 4, title: 'Idle four', work: { state: 'unclaimed' } }),
      note({ number: 5, title: 'Idle five', work: { state: 'unclaimed' } }),
      note({ number: 6, title: 'Landed one', yours: true, work: { state: 'merged', proposalNumber: 9 } }),
    ];
    const scripted = scriptedApi({
      ...workspaceScript(() => emptyState({ notes })),
      'POST api/notes/6/archive': () => {
        notes = notes.filter((row) => row.number !== 6);
        return { ok: true, number: 6, title: 'Landed one' };
      },
    });
    renderAt('/notes', scripted.api);
    await screen.findByText('Landed one');
    fireEvent.click(screen.getByRole('button', { name: 'Merged' }));
    expect(titles()).toEqual(['Landed one']);
    swipe(rowOf('Landed one'), 200);
    await waitFor(() => expect(screen.queryByText('Landed one')).toBeNull());
    // The chip the reader is standing in stays, empty, because a narrowed
    // list whose chips have gone is a reader with no way back.
    expect(chosen()).toBe('Merged');
    expect(document.getElementById('notesSub')!.textContent).toBe('Nothing here is merged now.');
    expect(document.querySelector('#notesList .empty')!.textContent).toBe('All shows every note.');
    tapChip('All');
    expect(titles()).toHaveLength(5);
  });
});

describe('the archive', () => {
  it('says what it is, and times each row by when it was PUT AWAY', async () => {
    at('/notes/archive', emptyState({ notesArchived: 2 }), {
      'GET api/notes/archive': () => ({
        notes: [
          note({ number: 90, title: 'Filed', updatedAt: '2026-06-01T09:00:00Z', archivedAt: '2026-09-01T12:00:00Z' }),
          note({ number: 91, title: 'Also filed', archivedAt: '2026-08-01T12:00:00Z' }),
        ],
      }),
    });
    await screen.findByRole('heading', { name: 'Archive' });
    await screen.findByText('Filed');
    expect(document.getElementById('noteArchiveSub')!.textContent)
      .toContain('2 notes, out of the list and still here');
    // The column agrees with the order the rows sit in.
    const when = rowOf('Filed').querySelector('.cwhen')!.textContent!;
    expect(when).not.toContain('mo');
    // No swipe here: the gesture that files a note away has nothing left to do.
    expect(rowOf('Filed').classList.contains('noteswiperow')).toBe(false);
  });

  it('says the archive is empty rather than that something went wrong', async () => {
    at('/notes/archive', emptyState({}), { 'GET api/notes/archive': () => ({ notes: [] }) });
    await screen.findByRole('heading', { name: 'Archive' });
    expect(await screen.findByText('Nothing in your archive.')).toBeTruthy();
    expect(document.getElementById('noteArchiveSub')!.textContent).toBe('');
  });

  it('says why when the rows cannot be read at all', async () => {
    at('/notes/archive', emptyState({}), {
      'GET api/notes/archive': () => { throw new WorkspaceApiError('The archive is away.', 503, {}); },
    });
    await screen.findByRole('heading', { name: 'Archive' });
    expect(await screen.findByText('The archive is away.')).toBeTruthy();
  });
});

describe('searching the notes', () => {
  const searchable = (extra: Record<string, Answer> = {}) => at('/notes', emptyState({
    notes: Array.from({ length: 4 }, (_, at$) => note({ number: at$ + 1, title: `Note ${at$ + 1}` })),
    notesArchived: 2,
  }), extra);

  it('earns its field only once there is enough to hunt through — the archive counts', async () => {
    at('/notes', emptyState({ notes: [note({ number: 1, title: 'One' })], notesArchived: 1 }));
    await screen.findByText('One');
    expect(screen.queryByRole('searchbox', { name: 'Search notes' })).toBeNull();
  });

  it('asks the backend after the typing burst, and the results own the list', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = searchable({
      'GET api/notes/search?q=wifi': () => ({
        notes: [note({ number: 77, title: 'The wifi code', archivedAt: '2026-08-01T09:00:00Z' })],
      }),
    });
    const field = await screen.findByRole('searchbox', { name: 'Search notes' });
    fireEvent.change(field, { target: { value: 'wif' } });
    fireEvent.change(field, { target: { value: 'wifi' } });
    expect(calls.some((call) => call.path.startsWith('api/notes/search'))).toBe(false);
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
    expect(await screen.findByText('The wifi code')).toBeTruthy();
    // Exactly one ask: "wif" never left the page.
    expect(calls.filter((call) => call.path.startsWith('api/notes/search'))).toHaveLength(1);
    expect(rows('notesList')).toHaveLength(1);
    expect(document.getElementById('notesSub')!.textContent)
      .toBe('One match across your notes and your archive.');
    // A result from the archive says so — it is the one row that does not lead
    // where this screen's name promises.
    expect(rowOf('The wifi code').querySelector('.badge')!.textContent).toBe('Archived');
    // …and the archive door keeps its place at the foot.
    expect(document.getElementById('notesArchiveDoor')).toBeTruthy();
  });

  it('clears back to the list at once, with nothing fetched for an empty field', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = searchable({ 'GET api/notes/search?q=wifi': () => ({ notes: [] }) });
    const field = await screen.findByRole('searchbox', { name: 'Search notes' });
    fireEvent.change(field, { target: { value: 'wifi' } });
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
    expect(await screen.findByText('Nothing matches “wifi”.')).toBeTruthy();
    fireEvent.change(field, { target: { value: '' } });
    expect(rows('notesList')).toHaveLength(4);
    expect(calls.filter((call) => call.path.startsWith('api/notes/search'))).toHaveLength(1);
  });

  it('keeps the very field under the reader’s fingers when the list repaints', async () => {
    searchable();
    const field = await screen.findByRole('searchbox', { name: 'Search notes' });
    field.focus();
    fireEvent.change(field, { target: { value: 'wi' } });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('searchbox', { name: 'Search notes' })).toBe(field);
    expect(document.activeElement).toBe(field);
  });

  it('says why when the search itself fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    searchable({
      'GET api/notes/search?q=wifi': () => { throw new WorkspaceApiError('Search is away.', 503, {}); },
    });
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search notes' }), { target: { value: 'wifi' } });
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
    expect(await screen.findByText('Search is away.')).toBeTruthy();
  });

  it('starts from the LIST on every arrival, not from somebody’s old search', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    searchable({
      'GET api/notes/search?q=wifi': () => ({ notes: [note({ number: 77, title: 'The wifi code' })] }),
      'GET api/notes/archive': () => ({ notes: [] }),
    });
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search notes' }), { target: { value: 'wifi' } });
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
    await screen.findByText('The wifi code');
    fireEvent.click(screen.getByRole('button', { name: /Archive/ }));
    await screen.findByRole('heading', { name: 'Archive' });
    expect((screen.getByRole('searchbox', { name: 'Search notes' }) as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('The wifi code')).toBeNull();
  });
});
