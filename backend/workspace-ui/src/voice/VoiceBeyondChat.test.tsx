import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import type { WorkspaceApi } from '../api/client.js';
import {
  emptyState, noteRecord, scriptedApi, workspaceScript, type Answer,
} from '../test/fixtures.js';
import { forgetMicrophone, giveMicrophone, openDialogsInJsdom } from './fake-microphone.js';
import { forgetVoiceStatus } from './voice-status.js';

/**
 * Dictating somewhere that is not chat (note #365).
 *
 * The full-screen recorder existed, and only the chat composer opened it —
 * every other writing field in the Workspace got the inline microphone and a
 * wave the size of a thumbnail, under a phone keyboard covering half the
 * screen. A note is the field a person is most likely to SPEAK rather than
 * type, so these prove the same dialog opens over a note and over the margin,
 * wearing each one's own words rather than chat's.
 */

function renderAt(path: string, api: WorkspaceApi) {
  return render(<MemoryRouter initialEntries={[path]}><App api={api} /></MemoryRouter>);
}

const state = (overrides = {}) => emptyState({ notes: [], noteFiles: true, ...overrides });
const heard = (text: string) => ({ 'POST api/transcribe': () => ({ text }) });

/** Open the note composer from the notes screen, microphone in hand. */
async function openComposer(extra: Record<string, Answer> = {}) {
  giveMicrophone();
  const scripted = scriptedApi({ ...workspaceScript(() => state()), ...extra });
  renderAt('/', scripted.api);
  await screen.findByRole('heading', { name: /^Notes/ });
  fireEvent.click(screen.getByRole('button', { name: /Write a note/ }));
  await screen.findByRole('heading', { name: 'Write a note' });
  return scripted;
}

/** A workplace whose notes hold files, so the note's own screen draws whole.
 *  (A room of it, while there were rooms — note #843.) */
const workplaceState = () => emptyState({
  org: { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] },
  notes: [], noteFiles: true,
});

/** Open a saved note and its comment box, microphone in hand. */
async function openMargin(extra: Record<string, Answer> = {}) {
  giveMicrophone();
  const scripted = scriptedApi({
    ...workspaceScript(workplaceState),
    'GET api/notes/21': () => ({ note: noteRecord({ number: 21, title: 'The wifi code is 4417' }) }),
    ...extra,
  });
  renderAt('/notes/21?org=o1', scripted.api);
  fireEvent.click(await screen.findByRole('button', { name: /Write a comment/ }));
  return scripted;
}

const photo = (name: string) => new File(['x'], name, { type: 'image/png' });
/** Past the 100 MB a note's file may be. */
const huge = (name: string) => {
  const file = new File(['x'], name, { type: 'image/png' });
  Object.defineProperty(file, 'size', { value: 101 * 1024 * 1024 });
  return file;
};

/** Pick files through the DIALOG's own picker, not the composer's. */
function attach(chosen: File[]) {
  const picker = document.getElementById('voiceReviewFile') as HTMLInputElement;
  Object.defineProperty(picker, 'files', { value: chosen, configurable: true });
  fireEvent.change(picker);
}

/** Tap the mic, let it record, stop it, and wait for the words to come back. */
async function dictate(field: string, into: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Dictate into ${field}` })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop recording' })); });
  await waitFor(() => expect((screen.getByRole('textbox', { name: into }) as HTMLTextAreaElement).value).toBeTruthy());
  return screen.getByRole('textbox', { name: into }) as HTMLTextAreaElement;
}

beforeEach(() => { openDialogsInJsdom(); });
afterEach(() => { forgetMicrophone(); forgetVoiceStatus(); vi.useRealTimers(); });

describe('dictating a note', () => {
  it('opens the full-screen recorder and puts the words in an editor of its own', async () => {
    await openComposer(heard('the wifi code is 4417'));
    const review = await dictate('Note', 'Your note');
    expect(review.value).toBe('the wifi code is 4417');
    // Its own words, not chat's — this dialog is over a note.
    expect(screen.getByRole('heading', { name: 'Review note' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Save note/ })).toBeTruthy();
    expect(screen.queryByText('Send message')).toBeNull();
  });

  it('grows the note review from the voice transcript itself', async () => {
    const spoken = Array.from({ length: 9 }, (_, i) => `Spoken line ${i + 1}.`).join('\n');
    const measured = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLTextAreaElement) {
        return this.classList.contains('voicereview-text') ? 318 : 0;
      });
    try {
      await openComposer(heard(spoken));
      const review = await dictate('Note', 'Your note');
      expect(review.value).toBe(spoken);
      expect(review.style.height).toBe('318px');
      expect(review.closest('.voicereview-editor')?.classList.contains('autogrow')).toBe(true);
    } finally {
      measured.mockRestore();
    }
  });

  it('saves what was corrected in the review, not what was heard', async () => {
    const sent: string[] = [];
    await openComposer({
      ...heard('the wifi code is four four one seven'),
      'POST api/notes': (call) => {
        sent.push(JSON.parse(String(call.init?.body)).text);
        return { ok: true, note: { id: 'n21', number: 21, title: 'The wifi code is 4417', preview: '', createdAt: 't', updatedAt: 't' }, title: 'The wifi code is 4417' };
      },
      'GET api/notes/21': () => ({ note: noteRecord({ number: 21, title: 'The wifi code is 4417' }) }),
    });
    const review = await dictate('Note', 'Your note');
    fireEvent.change(review, { target: { value: 'The wifi code is 4417' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save note/ })); });
    await waitFor(() => expect(sent).toEqual(['The wifi code is 4417']));
  });

  // The words are the reader's own. A save that fails must not eat them.
  it('keeps the words in the dialog when the save fails', async () => {
    await openComposer({
      ...heard('the wifi code is 4417'),
      'POST api/notes': () => { throw new Error('nope'); },
    });
    await dictate('Note', 'Your note');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save note/ })); });
    await screen.findByText(/could not be saved/);
    expect((screen.getByRole('textbox', { name: 'Your note' }) as HTMLTextAreaElement).value)
      .toBe('the wifi code is 4417');
  });

  // The point of a dialog that covers the phone is not having to leave it.
  // Dictating a note and then backing out to add the photograph it is ABOUT
  // is the friction this is here to remove.
  it('takes the note’s files without leaving the dialog, and saves them with it', async () => {
    const scripted = await openComposer({
      ...heard('the menu is on the wall'),
      'POST api/notes': () => ({ ok: true, note: { id: 'n21', number: 21, title: 'the menu is on the wall', preview: '', createdAt: 't', updatedAt: 't' }, title: 'the menu is on the wall' }),
      'POST api/notes/21/files': () => ({ ok: true, attachments: [] }),
      'GET api/notes/21': () => ({ note: noteRecord({ number: 21, title: 'the menu is on the wall' }) }),
    });
    await dictate('Note', 'Your note');
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
    attach([photo('menu.png')]);
    // The dialog shows the pick itself. The card underneath grows the same
    // draft — one draft, seen from both — so the photo is looked for INSIDE
    // the dialog rather than on the page.
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(within(dialog).getByLabelText('Preview menu.png full screen')).toBeTruthy());
    expect(screen.getAllByLabelText('Preview menu.png full screen')).toHaveLength(2);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save note/ })); });
    await waitFor(() => expect(scripted.calls.some((call) => call.path === 'api/notes/21/files')).toBe(true));
    const upload = scripted.calls.find((call) => call.path === 'api/notes/21/files')!;
    expect((upload.init!.headers as Record<string, string>)['x-note-file-name']).toBe('menu.png');
  });

  // Refused as a SET: the reader is told why, inside the dialog, and nothing
  // half-attaches behind the message.
  it('refuses a file the note could not carry, and attaches none of the pick', async () => {
    await openComposer(heard('the menu is on the wall'));
    await dictate('Note', 'Your note');
    attach([photo('fine.png'), huge('enormous.png')]);
    expect(await screen.findByText(/up to 100 MB/)).toBeTruthy();
    expect(screen.queryByText(/file attached/)).toBeNull();
    expect(screen.queryByLabelText('Preview fine.png full screen')).toBeNull();
  });

  /**
   * The shape of the screen, asked for in his own words (note #387): "let's
   * remove '8 words, 1 file attached'. Let's put 'Attach files' button there.
   * And let's put small attachments below big text input area."
   */
  it('puts the words first, the picks small underneath, and Attach beside Save', async () => {
    await openComposer(heard('the menu is on the wall'));
    await dictate('Note', 'Your note');
    const dialog = screen.getByRole('dialog');
    // Nothing counts anything at the reader any more.
    expect(dialog.textContent).not.toMatch(/\d+ words?/);
    expect(dialog.textContent).not.toMatch(/files? attached/);
    // Attach has come out of the header and stands in the row that commits.
    const attachBtn = within(dialog).getByRole('button', { name: 'Attach files' });
    expect(attachBtn.closest('.voicereview-sendrow')).toBeTruthy();
    expect(attachBtn.closest('.voicereview-head')).toBeNull();

    attach([photo('menu.png')]);
    await waitFor(() => expect(within(dialog).getByLabelText('Preview menu.png full screen')).toBeTruthy());
    // Small, in chat's own strip — and BELOW the box, not above it.
    const strip = dialog.querySelector('.voicereview-draft')!;
    expect(strip.classList.contains('chatdraft')).toBe(true);
    expect(strip.querySelector('.chatdraftitem .name')?.textContent).toBe('menu.png');
    const editor = dialog.querySelector('.voicereview-editor')!;
    expect(editor.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and the picks come before the buttons, which stay last on the screen.
    const actions = dialog.querySelector('.voicereview-actions')!;
    expect(strip.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * Note #387: opening one of those pictures full screen and closing it again
   * left the screen behind it broken — pushed down the phone with the text
   * input off the end of it.
   *
   * The dialog sizes itself to the browser's visible rectangle, because `dvh`
   * alone does not account for a keyboard. Those two readings used to be
   * written through unchecked and then kept for good: nothing measured again,
   * so one taken while the page was mid-reflow — a picture opening over this
   * one is enough to cause that on a phone — was the shape of the screen from
   * then on. The layout floors that keep the editor a box live in the
   * stylesheet, where the browser harness measures them; these are the two
   * guards that live here.
   */
  describe('the screen holds its shape whatever opens over it', () => {
    /** A browser reporting the visible rectangle a keyboard has left, or —
     *  when it is mid-reflow — something impossible. */
    const reports = (rectangle: { height: number; offsetTop: number }) => {
      const viewport = { ...rectangle, addEventListener() {}, removeEventListener() {} };
      Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
      return viewport;
    };
    const geometry = () => {
      const dialog = document.querySelector<HTMLDialogElement>('.voicereview')!;
      return { top: dialog.style.getPropertyValue('--voice-top'), height: dialog.style.getPropertyValue('--voice-height') };
    };

    it('refuses a reading that would push it off the phone, and re-reads on a picture', async () => {
      // `window.innerHeight` is jsdom's own 768. An offset past the bottom of
      // that is the reading note #387 arrived on.
      const viewport = reports({ height: 768, offsetTop: 900 });
      await openComposer(heard('the menu is on the wall'));
      await dictate('Note', 'Your note');
      // Clamped: with the whole window visible there is nowhere to be pushed.
      expect(geometry()).toEqual({ top: '0px', height: '768px' });

      // A keyboard takes the bottom half. Now there IS somewhere to go — as
      // far as sitting that rectangle on the bottom of the window, and no
      // further, whatever the browser says.
      attach([photo('menu.png')]);
      const dialog = screen.getByRole('dialog');
      await waitFor(() => expect(within(dialog).getByLabelText('Preview menu.png full screen')).toBeTruthy());
      viewport.height = 400;
      fireEvent.click(within(dialog).getByLabelText('Preview menu.png full screen'));
      await act(async () => { fireEvent.click(document.getElementById('imageViewerClose')!); });
      expect(geometry()).toEqual({ top: '368px', height: '400px' });
    });

    it('leaves the page underneath alone while a picture is up over it', async () => {
      reports({ height: 768, offsetTop: 0 });
      await openComposer(heard('the menu is on the wall'));
      await dictate('Note', 'Your note');
      attach([photo('menu.png')]);
      const dialog = screen.getByRole('dialog');
      await waitFor(() => expect(within(dialog).getByLabelText('Preview menu.png full screen')).toBeTruthy());
      // The viewer locks the document when it opens over a page. Here it is
      // portalled INTO this modal, which already seals that page off — and on
      // a phone `position: fixed` on the body moves the very rectangle this
      // screen has just measured itself against.
      fireEvent.click(within(dialog).getByLabelText('Preview menu.png full screen'));
      expect(document.getElementById('imageViewer')?.parentElement).toBe(dialog);
      expect(document.body.classList.contains('image-open')).toBe(false);
      await act(async () => { fireEvent.click(document.getElementById('imageViewerClose')!); });
      expect(document.getElementById('imageViewer')).toBeNull();
      expect(document.body.classList.contains('image-open')).toBe(false);
    });
  });

  // An edit is about the words; the saved note's own screen owns its files.
  it('offers no attach button while rewriting a note', async () => {
    giveMicrophone();
    const scripted = scriptedApi({
      ...workspaceScript(workplaceState),
      ...heard('the wifi code is 4417'),
      // `byUser` is what puts Edit on the screen — a note of somebody else's
      // is read, not rewritten.
      'GET api/notes/21': () => ({ note: noteRecord({ number: 21, title: 'The wifi code is 4417', byUser: true }) }),
    });
    renderAt('/notes/21?org=o1', scripted.api);
    fireEvent.click(await screen.findByRole('button', { name: /Edit note/ }));
    await waitFor(() => expect(document.getElementById('noteText')).toBeTruthy());
    await dictate('Note', 'Your note');
    expect(screen.getByRole('heading', { name: 'Review your changes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
  });
});

describe('dictating a comment', () => {
  it('opens the same recorder over the margin, in the margin’s words', async () => {
    await openMargin(heard('I called, they are closed Mondays'));
    const review = await dictate('Write a comment', 'Your comment');
    expect(review.value).toBe('I called, they are closed Mondays');
    expect(screen.getByRole('heading', { name: 'Review comment' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Post comment/ })).toBeTruthy();
  });

  it('posts what the review holds', async () => {
    const sent: string[] = [];
    await openMargin({
      ...heard('I called, they are closed Mondays'),
      'POST api/notes/21/comments': (call) => {
        sent.push(JSON.parse(String(call.init?.body)).text);
        return { comments: [] };
      },
    });
    const review = await dictate('Write a comment', 'Your comment');
    expect(review.closest('.voicereview-editor')?.classList.contains('autogrow')).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Post comment/ })); });
    await waitFor(() => expect(sent).toEqual(['I called, they are closed Mondays']));
  });
});
