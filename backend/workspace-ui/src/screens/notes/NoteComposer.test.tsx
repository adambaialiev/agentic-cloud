/**
 * Writing a note in the Workspace, and rewriting one of your own — the box
 * itself, the files it holds before there is a note to hang them on, and what
 * happens to the words when a save fails.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App.js';
import { WorkspaceApiError, type WorkspaceApi } from '../../api/client.js';
import { emptyState, note, noteRecord, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { NOTE_MAX_TEXT } from './note-words.js';

function renderAt(path: string, api: WorkspaceApi) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App api={api} />
    </MemoryRouter>,
  );
}

const state = (overrides = {}) => emptyState({ notes: [], noteFiles: true, ...overrides });

const openComposer = async (extra: Record<string, Answer> = {}, at = '/') => {
  const scripted = scriptedApi({ ...workspaceScript(() => state()), ...extra });
  renderAt(at, scripted.api);
  await screen.findByRole('heading', { name: /^Notes/ });
  fireEvent.click(screen.getByRole('button', { name: /Write a note/ }));
  await screen.findByRole('heading', { name: 'Write a note' });
  return scripted;
};

const box = () => document.getElementById('noteText') as HTMLTextAreaElement;
const pick = (file: File) => {
  const picker = document.getElementById('noteDraftFileInput') as HTMLInputElement;
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  fireEvent.change(picker);
};
const photo = (name = 'shot.png') => new File(['x'], name, { type: 'image/png' });

beforeEach(() => {
  // jsdom has no object URLs; the draft mints one per picked photograph.
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn((file: File) => `blob:${file.name}`),
    revokeObjectURL: vi.fn(),
  }));
});
afterEach(() => { vi.useRealTimers(); });

describe('writing one', () => {
  it('sends what was typed as TEXT, and opens the note that was created', async () => {
    const scripted = await openComposer({
      'POST api/notes': () => ({ ok: true, note: note({ number: 21, title: 'The wifi code is 4417' }), title: 'The wifi code is 4417' }),
      'GET api/notes/21': () => ({ note: noteRecord({ number: 21, title: 'The wifi code is 4417' }) }),
    });
    fireEvent.change(box(), { target: { value: 'The wifi code is 4417' } });
    expect(document.getElementById('noteCount')!.textContent).toBe('21 characters');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(document.getElementById('noteForm')!.contains(save)).toBe(true);
    expect(document.querySelector('#pageHead button:not(#pageBack)')).toBeNull();
    fireEvent.click(save);
    // Creation ends on the thing just created.
    expect(await screen.findByRole('heading', { name: 'The wifi code is 4417' })).toBeTruthy();
    const sent = scripted.calls.find((call) => call.path === 'api/notes' && call.init?.method === 'POST')!;
    expect(JSON.parse(String(sent.init!.body))).toEqual({ text: 'The wifi code is 4417' });
    expect((await screen.findByRole('alert')).textContent).toContain('Saved — “The wifi code is 4417” is in your notes.');
  });

  it('keeps the words in the box when the save fails', async () => {
    await openComposer({
      'POST api/notes': () => { throw new WorkspaceApiError('You have 100 notes.', 400, {}); },
    });
    fireEvent.change(box(), { target: { value: 'Something worth keeping' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('You have 100 notes.');
    expect(box().value).toBe('Something worth keeping');
  });

  it('does not send an empty note at all', async () => {
    const scripted = await openComposer();
    fireEvent.change(box(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => { await Promise.resolve(); });
    expect(scripted.calls.some((call) => call.path === 'api/notes' && call.init?.method === 'POST')).toBe(false);
  });

  it('caps the box at the same length the route refuses past', async () => {
    await openComposer();
    expect(box().maxLength).toBe(NOTE_MAX_TEXT);
  });

  it('grows and shrinks with typed prose instead of becoming a fixed inner scroller', async () => {
    await openComposer();
    let contentHeight = 286;
    Object.defineProperties(box(), {
      scrollHeight: { configurable: true, get: () => contentHeight },
      offsetHeight: { configurable: true, get: () => 102 },
      clientHeight: { configurable: true, get: () => 100 },
    });

    fireEvent.change(box(), { target: { value: Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n') } });
    expect(box().style.height).toBe('288px');

    contentHeight = 104;
    fireEvent.change(box(), { target: { value: 'One short line' } });
    expect(box().style.height).toBe('106px');
  });

  it('COVERS the screen it opened over rather than sitting inside it', async () => {
    await openComposer();
    // A form embedded between the fleet above and the classic card below is
    // not a leaf; the screen underneath goes entirely while the box is up.
    expect(document.getElementById('screenHome')).toBeNull();
    expect(screen.queryByRole('heading', { name: /^Agents/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Everything else' })).toBeNull();
    // …and Home lends it the header Home itself has none of.
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });

  it('keeps a half-written note when the reader backs out and comes back', async () => {
    await openComposer();
    fireEvent.change(box(), { target: { value: 'Half a thought' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: /^Notes/ });
    fireEvent.click(screen.getByRole('button', { name: /Write a note/ }));
    await screen.findByRole('heading', { name: 'Write a note' });
    expect(box().value).toBe('Half a thought');
  });
});

describe('attaching a file to a note that does not exist yet', () => {
  it('creates the note first, then sends each file to the number it came back with', async () => {
    const scripted = await openComposer({
      'POST api/notes': () => ({ ok: true, note: note({ number: 21, title: 'With pictures' }), title: 'With pictures' }),
      'POST api/notes/21/files': () => ({ ok: true, attachments: [] }),
      'GET api/notes/21': () => ({ note: noteRecord({ number: 21, title: 'With pictures', attachments: [] }) }),
    });
    fireEvent.change(box(), { target: { value: 'With pictures' } });
    pick(photo('one.png'));
    pick(photo('two.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'With pictures' });
    const uploads = scripted.calls.filter((call) => call.path === 'api/notes/21/files');
    expect(uploads).toHaveLength(2);
    expect(uploads.map((call) => (call.init!.headers as Record<string, string>)['x-note-file-name']))
      .toEqual(['one.png', 'two.png']);
    // The note itself went up first, with the words alone.
    expect(scripted.calls.findIndex((call) => call.path === 'api/notes'))
      .toBeLessThan(scripted.calls.findIndex((call) => call.path === 'api/notes/21/files'));
  });

  it('keeps the note when a file fails, and says which one did not make it', async () => {
    let attempt = 0;
    await openComposer({
      'POST api/notes': () => ({ ok: true, note: note({ number: 21, title: 'With pictures' }), title: 'With pictures' }),
      'POST api/notes/21/files': () => {
        attempt += 1;
        if (attempt === 2) throw new WorkspaceApiError('Storage is away.', 503, {});
        return { ok: true, attachments: [] };
      },
      'GET api/notes/21': () => ({ note: noteRecord({ number: 21, title: 'With pictures', attachments: [] }) }),
    });
    fireEvent.change(box(), { target: { value: 'With pictures' } });
    pick(photo('one.png'));
    pick(photo('two.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent)
      .toContain('Saved “With pictures” — but two.png did not attach. Try again from this note.');
    expect(await screen.findByRole('heading', { name: 'With pictures' })).toBeTruthy();
  });

  it('does not send the files at all when the note itself could not be saved', async () => {
    const scripted = await openComposer({
      'POST api/notes': () => { throw new WorkspaceApiError('You have 100 notes.', 400, {}); },
    });
    fireEvent.change(box(), { target: { value: 'With pictures' } });
    pick(photo('one.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    expect(scripted.calls.some((call) => call.path.endsWith('/files'))).toBe(false);
    // …and the picked file is still there, part of the same unsaved note.
    expect(screen.getByText(/one\.png/)).toBeTruthy();
  });

  it('shows a picked photo AS the photo, straight off the phone', async () => {
    await openComposer();
    pick(photo('shot.png'));
    await waitFor(() => expect(document.querySelector('.notephoto img')!.getAttribute('src')).toBe('blob:shot.png'));
    expect(screen.getByText('shot.png · 1 B · goes up when you save')).toBeTruthy();
    // Each pick is one slide, with the photo and its caption together.
    expect(document.getElementById('noteDraftFiles')!.children).toHaveLength(1);
  });

  it('leaves everything that is not a picture as a row', async () => {
    await openComposer();
    pick(new File(['x'], 'menu.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('menu.pdf')).toBeTruthy();
    expect(document.querySelector('.notephoto')).toBeNull();
  });

  /** Note #318: a picture picked but not yet saved opens where every other
   *  picture in the Workspace does — the shared full-screen viewer — off the
   *  object URL the draft already holds, with no note and no upload. */
  it('opens a picked photo full screen, and the other picks are its gallery', async () => {
    await openComposer();
    pick(photo('one.png'));
    pick(photo('two.png'));
    await waitFor(() => expect(document.querySelectorAll('.notephoto img')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Preview one.png full screen' }));
    const viewer = await screen.findByRole('dialog');
    expect(viewer.id).toBe('imageViewer');
    expect(document.getElementById('imageViewerName')!.textContent).toBe('one.png');
    // Both picks are ONE gallery, in the order they were picked, so the second
    // photo is a swipe away rather than a close-and-find-it-again.
    expect(document.getElementById('imageViewerCount')!.textContent).toBe('1 of 2');
    fireEvent.click(document.getElementById('imageViewerNext')!);
    await waitFor(() => expect(document.getElementById('imageViewerName')!.textContent).toBe('two.png'));
    expect((document.getElementById('imageViewerImage') as HTMLImageElement).getAttribute('src'))
      .toBe('blob:two.png');
  });

  it('sends a picked file that is not a picture out to the browser instead', async () => {
    const opener = vi.spyOn(window, 'open').mockImplementation(() => null);
    await openComposer();
    pick(new File(['x'], 'menu.pdf', { type: 'application/pdf' }));
    fireEvent.click(await screen.findByRole('button', { name: /^menu\.pdf/ }));
    expect(opener).toHaveBeenCalled();
    // There is no full-screen UI for a PDF anywhere in the Workspace, so the
    // viewer must not be asked to invent one.
    expect(screen.queryByRole('dialog')).toBeNull();
    opener.mockRestore();
  });

  it('takes a photo that will not decode out of the gallery, not just out of the frame', async () => {
    const opener = vi.spyOn(window, 'open').mockImplementation(() => null);
    await openComposer();
    pick(photo('good.png'));
    pick(photo('torn.png'));
    await waitFor(() => expect(document.querySelectorAll('.notephoto img')).toHaveLength(2));
    fireEvent.error(document.querySelectorAll('.notephoto img')[1]!);
    // It falls back to the plain row, which opens for the browser…
    await waitFor(() => expect(document.querySelectorAll('.notephoto')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /^torn\.png/ }));
    expect(opener).toHaveBeenCalled();
    // …and it is gone from the gallery too, so the swipe has no hole in it.
    fireEvent.click(screen.getByRole('button', { name: 'Preview good.png full screen' }));
    await screen.findByRole('dialog');
    expect(document.getElementById('imageViewerCount')).toBeNull();
    opener.mockRestore();
  });

  it('does not open the viewer from the ✕ that takes the photo back off', async () => {
    await openComposer();
    pick(photo('shot.png'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove shot.png' }));
    // The last pick gone, the card goes with it (note #604).
    await waitFor(() => expect(document.getElementById('noteDraftFilesCard')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('takes one back off without asking, because nothing has left the phone', async () => {
    await openComposer();
    pick(photo('shot.png'));
    await screen.findByRole('button', { name: 'Remove shot.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    // The last pick gone, the card goes with it (note #604).
    await waitFor(() => expect(document.getElementById('noteDraftFilesCard')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a picked file across backing out, exactly as it keeps the words', async () => {
    await openComposer();
    pick(photo('shot.png'));
    await screen.findByRole('button', { name: 'Remove shot.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: /^Notes/ });
    fireEvent.click(screen.getByRole('button', { name: /Write a note/ }));
    expect(await screen.findByRole('button', { name: 'Remove shot.png' })).toBeTruthy();
  });

  it('refuses a file the route would refuse, before spending the upload', async () => {
    await openComposer();
    const huge = photo('huge.png');
    Object.defineProperty(huge, 'size', { value: 101 * 1024 * 1024 });
    pick(huge);
    expect((await screen.findByRole('alert')).textContent).toContain('Files here are up to 100 MB');
    expect(document.getElementById('noteDraftFilesCard')).toBeNull();
  });

  it('offers the way in as a paperclip on Save’s row, and a files card only once one is picked (note #604)', async () => {
    await openComposer();
    const clip = screen.getByRole('button', { name: 'Attach a file' });
    expect(clip.textContent).toBe('');
    expect(clip.parentElement).toBe(screen.getByRole('button', { name: 'Save' }).parentElement);
    expect(document.getElementById('noteDraftFilesCard')).toBeNull();
    pick(photo('one.png'));
    expect(await screen.findByRole('button', { name: 'Remove one.png' })).toBeTruthy();
    expect(document.getElementById('noteDraftFilesCard')).toBeTruthy();
  });

  it('offers no files card on a backend that cannot hold one', async () => {
    const scripted = scriptedApi(workspaceScript(() => emptyState({ notes: [], noteFiles: false })));
    renderAt('/', scripted.api);
    await screen.findByRole('heading', { name: /^Notes/ });
    fireEvent.click(screen.getByRole('button', { name: /Write a note/ }));
    await screen.findByRole('heading', { name: 'Write a note' });
    expect(document.getElementById('noteDraftFilesCard')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach a file' })).toBeNull();
  });

  it('says which file it is on while the uploads run', async () => {
    let land: (value: unknown) => void = () => {};
    await openComposer({
      'POST api/notes': () => ({ ok: true, note: note({ number: 21, title: 'With pictures' }), title: 'With pictures' }),
      'POST api/notes/21/files': () => new Promise((resolve) => { land = resolve; }),
      'GET api/notes/21': () => ({ note: noteRecord({ number: 21, title: 'With pictures', attachments: [] }) }),
    });
    fireEvent.change(box(), { target: { value: 'With pictures' } });
    pick(photo('one.png'));
    pick(photo('two.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Attaching 1 of 2…')).toBeTruthy();
    act(() => land({ ok: true, attachments: [] }));
    expect(await screen.findByText('Attaching 2 of 2…')).toBeTruthy();
  });
});

describe('rewriting one of your own', () => {
  const openEditor = async (extra: Record<string, Answer> = {}) => {
    const scripted = scriptedApi({
      ...workspaceScript(() => state()),
      'GET api/notes/12': () => ({
        note: noteRecord({ number: 12, title: 'The wifi code is 4417', byUser: true, text: 'The wifi code is 4417' }),
      }),
      ...extra,
    });
    renderAt('/notes/12', scripted.api);
    await screen.findByRole('heading', { name: 'The wifi code is 4417' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await screen.findByRole('heading', { name: 'Edit note' });
    return scripted;
  };

  it('opens holding the text the note was TYPED as, never the markup', async () => {
    await openEditor();
    expect(box().value).toBe('The wifi code is 4417');
    expect(document.getElementById('noteFormSub')!.textContent).toBe('Your own note, in your own words.');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
  });

  it('PUTs the change and lands back on the note, not on home', async () => {
    const scripted = await openEditor({
      'PUT api/notes/12': () => ({ ok: true, note: note({ number: 12, title: 'The wifi code is 9911' }), title: 'The wifi code is 9911' }),
    });
    fireEvent.change(box(), { target: { value: 'The wifi code is 9911' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Saved your changes.');
    await screen.findByRole('heading', { name: 'The wifi code is 4417' });
    const sent = scripted.calls.find((call) => call.init?.method === 'PUT')!;
    expect(JSON.parse(String(sent.init!.body))).toEqual({ text: 'The wifi code is 9911' });
  });

  it('offers no files card while rewriting — an edit is about the words', async () => {
    await openEditor();
    expect(document.getElementById('noteDraftFilesCard')).toBeNull();
  });

  it('does not let an edit eat the half-written note underneath it', async () => {
    const scripted = scriptedApi({
      ...workspaceScript(() => state({ notes: [note({ number: 12, title: 'The wifi code is 4417', byUser: true })] })),
      'GET api/notes/12': () => ({
        note: noteRecord({ number: 12, title: 'The wifi code is 4417', byUser: true, text: 'The wifi code is 4417' }),
      }),
    });
    renderAt('/', scripted.api);
    await screen.findByRole('heading', { name: /^Notes/ });
    fireEvent.click(screen.getByRole('button', { name: /Write a note/ }));
    await screen.findByRole('heading', { name: 'Write a note' });
    fireEvent.change(box(), { target: { value: 'Half a thought' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: /^Notes/ });

    fireEvent.click(screen.getByText('The wifi code is 4417'));
    await screen.findByRole('heading', { name: 'The wifi code is 4417' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await screen.findByRole('heading', { name: 'Edit note' });
    expect(box().value).toBe('The wifi code is 4417');
    // Abandoning the edit leaves the note itself alone…
    fireEvent.change(box(), { target: { value: 'Not saved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'The wifi code is 4417' });
    expect(scripted.calls.some((call) => call.init?.method === 'PUT')).toBe(false);
    // …and the half-written note underneath is still waiting.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: /^Notes/ });
    fireEvent.click(screen.getByRole('button', { name: /Write a note/ }));
    await screen.findByRole('heading', { name: 'Write a note' });
    expect(box().value).toBe('Half a thought');
  });
});
