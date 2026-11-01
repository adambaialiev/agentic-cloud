import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../App.js';
import { WorkspaceApiError } from '../../api/client.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import type { WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import type {
  WorkspaceMailConversation,
  WorkspaceMailConversationSummary,
  WorkspaceMailMessageDetail,
  WorkspaceMailMessageSummary,
  WorkspaceMailStarAnswer,
  WorkspaceMailThreadMessage,
} from '../../../../src/shared/workspace-mail.js';
import {
  heldMailConversation, heldMailLetters, heldMailPlace, holdMailConversation, holdMailLetters, holdMailPlace, mailConversationMoved,
  mailPageKept, mailStarChanged,
} from './mail-cache.js';
import { MAIL_POLL_MS } from './MailScreen.js';
import { mailAddressWith, mailConversationsPath, mailListPath } from './mail-address.js';
import { quoteRepeats, splitQuotedHtml, splitQuotedText } from './mail-quote.js';
import {
  mailConversationLine, mailConversationName, mailEnvelope, mailOwnLine, mailReplyTo, mailWhen, reflowMailText,
} from './mail-words.js';

/**
 * The inbox (note #509, slice 3).
 *
 * What is worth asserting is not that a list lists. It is the promises this
 * screen makes about mail a stranger sent: a message is shown as ONE body and
 * the reader is never asked to choose between two versions of it (note #534),
 * no picture in a message is ever fetched, nothing the sender wrote runs or
 * becomes live markup in this app, and a message we could not read still
 * reaches its owner whole.
 */

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 1, seats: 0, seatProviders: [] };
const ADDRESS = 'adam@agenticcloudcomputer.com';

const account = (mailbox?: { address: string }): Partial<WorkspaceStateAnswer> => ({
  user: {
    name: 'Saddam',
    profile: { firstName: 'Saddam', lastName: 'B', incomplete: false },
    account: {
      browserLogin: { enabled: true, method: 'email', email: ADDRESS, secondFactorEnabled: false, verificationStatus: 'verified' },
      ...(mailbox ? { mailbox } : {}),
    },
  },
});

const summary: WorkspaceMailMessageSummary = {
  id: 'mm_1',
  from: { name: 'Ada Lovelace', address: 'ada@example.com' },
  subject: 'The engine',
  snippet: 'It weaves algebraic patterns.',
  receivedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  files: 1,
};

const detail = (over: Partial<WorkspaceMailMessageDetail> = {}): WorkspaceMailMessageDetail => ({
  ...summary,
  to: [{ address: ADDRESS }],
  cc: [],
  replyTo: [],
  text: 'It weaves algebraic patterns.\n\n  — Ada',
  attachments: [{ id: 'ma_1', fileName: 'notes.pdf', contentType: 'application/pdf', size: 2048 }],
  rawSize: 7046,
  replies: [],
  ...over,
});

/** One letter as it stands in a conversation (slice 8). */
const letter = (over: Partial<WorkspaceMailThreadMessage> = {}): WorkspaceMailThreadMessage => {
  const one: Partial<WorkspaceMailMessageDetail> = detail();
  delete one.replies;
  delete one.answerTo;
  return { ...one as WorkspaceMailThreadMessage, ...over };
};

/** One conversation, as a row of a place's list. */
const row = (over: Partial<WorkspaceMailConversationSummary> = {}): WorkspaceMailConversationSummary => ({
  id: 'mm_1',
  with: [{ name: 'Ada Lovelace', address: 'ada@example.com' }],
  subject: 'The engine',
  latest: { id: 'mm_1', snippet: 'It weaves algebraic patterns.', receivedAt: summary.receivedAt },
  count: 1,
  opens: 'mm_1',
  files: 1,
  ...over,
});

/** A whole conversation, as the screen reads it: by default the one letter. */
const conversationOf = (messages: WorkspaceMailThreadMessage[] = [letter()], over: Partial<WorkspaceMailConversation> = {}): WorkspaceMailConversation => ({
  ...row({
    id: messages[0]!.id,
    subject: messages[0]!.subject,
    count: messages.length,
    latest: { id: messages.at(-1)!.id, snippet: messages.at(-1)!.snippet, receivedAt: messages.at(-1)!.receivedAt },
    opens: messages.at(-1)!.id,
  }),
  messages,
  ...over,
});
/** The answer `GET api/mail/conversations/:id` gives for one letter. */
const opened = (over: Partial<WorkspaceMailThreadMessage> = {}, conversation: Partial<WorkspaceMailConversation> = {}) => ({
  conversation: conversationOf([letter(over)], conversation),
});

function renderAt(path: string, script: Record<string, Answer>) {
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

/** A place's list: conversations. */
const inbox = (conversations: WorkspaceMailConversationSummary[] = [row()]) => ({ address: ADDRESS, conversations });
/** A search's list: letters. */
const found = (messages: WorkspaceMailMessageSummary[] = [summary]) => ({ address: ADDRESS, messages });

describe('the inbox', () => {
  it('lists what has arrived, newest first, and says what a message carries', async () => {
    renderAt('/mail', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations': () => inbox([row(), row({ id: 'mm_2', subject: 'Second', files: 0, suspicious: true, opens: 'mm_2' })]),
    });
    expect(await screen.findByText('The engine')).toBeTruthy();
    expect(screen.getAllByText('Ada Lovelace').length).toBe(2);
    expect(screen.getAllByText('It weaves algebraic patterns.').length).toBe(2);
    expect(screen.getByText('1 file')).toBeTruthy();
    // A mark only where there is something to say.
    expect(screen.getByText('unverified sender')).toBeTruthy();
    // And WHEN it came, the way mail says it: the clock for something that
    // arrived today, never the "4m ago" the rest of this app counts in.
    const when = document.querySelectorAll('#mailList .mailwhen');
    expect(when.length).toBe(2);
    expect(when[0]!.textContent).toBe(mailWhen(summary.receivedAt));
    expect(when[0]!.textContent).toMatch(/^\d{1,2}:\d{2}( ?[AP]M)?$/);
    expect(when[0]!.getAttribute('datetime')).toBe(summary.receivedAt);
  });

  it('is laid out like an inbox: the hour against the right edge, the way to write one on top, and no marks in the margin', async () => {
    renderAt('/mail', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations': () => inbox([
        row(),
        row({ id: 'mm_2', subject: 'The crop', started: true, with: [{ name: 'Priya Raman', address: 'priya@harborlight.co' }], opens: 'mm_2' }),
      ]),
    });
    await screen.findByText('The crop');
    const card = document.getElementById('mailList')!;
    // The door to writing one stands at the HEAD of the card, not under a
    // hundred messages, and carries the class that takes its stray top rule
    // off where the card's own edge already is.
    expect(card.firstElementChild!.id).toBe('mailWrite');
    expect(card.firstElementChild!.className).toBe('addrow cardtop');

    const rows = card.querySelectorAll('.crow.open');
    // The words are the whole row: no face, no monogram, nothing in the
    // column the text starts in. The owner asked for that in as many words
    // ("I don't want avatars"), so it is asserted rather than remembered.
    expect(card.querySelectorAll('.crow .avatar, .crow .icon, .crow .iconbox').length).toBe(0);
    // The one mark the card carries is the search field's magnifier, at the
    // head of the list — never a row's (slice 7).
    expect([...card.querySelectorAll('.icon')].every((icon) => icon.closest('#mailSearch'))).toBe(true);
    // The name and the hour share the first line, in that order.
    const head = rows[0]!.querySelector('.mailtop')!;
    expect(head.children[0]!.textContent).toContain('Ada Lovelace');
    expect(head.children[1]!.classList.contains('mailwhen')).toBe(true);
    // The subject line is the subject alone now — the time left it for the
    // edge, and nothing followed it out.
    expect(rows[0]!.querySelector('.mailsubject')!.textContent).toBe('The engine');
    // And no chevron: the row opens, and an inbox row has never needed one to
    // say so. The right-hand edge belongs to the clock.
    expect(rows[0]!.querySelector('.chev')).toBeNull();
  });

  it('draws a message nobody has opened yet heavier than the rest', async () => {
    renderAt('/mail', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations': () => inbox([
        row({ unread: true }),
        row({ id: 'mm_2', subject: 'Read already', opens: 'mm_2' }),
      ]),
    });
    await screen.findByText('The engine');
    const rows = document.querySelectorAll('#mailList .crow.open');
    expect(rows.length).toBe(2);
    expect(rows[0]!.classList.contains('mailnew')).toBe(true);
    expect(rows[1]!.classList.contains('mailnew')).toBe(false);
    // Weight is invisible to a screen reader, so the row says the word too.
    expect(rows[0]!.querySelector('.sr-only')?.textContent).toBe('New. ');
    expect(rows[1]!.querySelector('.sr-only')).toBeNull();
    // The subject is the line that takes the emphasis; the CSS reaches it by
    // name, so the name has to be on it.
    expect(rows[0]!.querySelector('.cline.mailsubject .ctext')?.textContent).toBe('The engine');
  });

  it('stops calling a conversation new the moment the reader opens it', async () => {
    holdMailPlace(inbox([row({ unread: true })]));
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened(),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    // The list this reader came from is held in this tab; Back must not paint
    // a heavy row for the conversation they are looking at.
    await waitFor(() => expect(heldMailPlace()?.conversations[0]!.unread).toBeUndefined());
  });

  it('says where mail would land when none has', async () => {
    renderAt('/mail', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations': () => inbox([]),
    });
    expect(await screen.findByText(/Nothing has arrived yet/)).toBeTruthy();
    // The address is on the screen's own sub-line and in the sentence that
    // says where mail would land.
    expect(screen.getAllByText(ADDRESS).length).toBe(2);
  });

  it('opens the door from Home for an account that has an address', async () => {
    renderAt('/overview', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations': () => inbox(),
    });
    const door = await screen.findByRole('link', { name: /Mail/ });
    // The registry's own path; the router's basename is added by the shell.
    expect(door.getAttribute('href')).toBe('/mail');
    expect(screen.getByText(ADDRESS)).toBeTruthy();
  });

  it('keeps asking while the inbox is open, and stops while a message is being written', async () => {
    vi.useFakeTimers();
    try {
      const scripted = renderAt('/mail', {
        ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
        'GET api/mail/conversations': () => inbox(),
        'POST api/mail/send': () => ({ message: { ...summary, id: 'mm_out', direction: 'sent' as const, to: [{ address: 'ada@example.com' }] } }),
      });
      const reads = () => scripted.calls.filter((call) => call.path === 'api/mail/conversations').length;
      const flush = async (ms = 10) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
      await flush();
      expect(reads()).toBe(1);
      // A letter that lands while she is looking at the list turns up in it.
      await flush(MAIL_POLL_MS);
      expect(reads()).toBe(2);
      // Writing one: the list is behind the composer, so nothing asks for it.
      fireEvent.click(screen.getByRole('button', { name: 'Write email' }));
      await flush();
      const paused = reads();
      await flush(MAIL_POLL_MS * 2);
      expect(reads()).toBe(paused);
      // Closing the composer starts it again.
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await flush(MAIL_POLL_MS);
      expect(reads()).toBeGreaterThan(paused);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says on Home how many messages are new, and wears the dot for them', async () => {
    renderAt('/overview', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/unread': () => ({ unread: 2 }),
      'GET api/mail/conversations': () => inbox(),
    });
    expect(await screen.findByText('2 new messages')).toBeTruthy();
    expect(screen.getByLabelText('2 new messages')).toBeTruthy();
    // The count displaces the address rather than crowding in beside it.
    expect(screen.queryByText(ADDRESS)).toBeNull();
  });

  it('shows the address on Home, and no dot, when nothing is new', async () => {
    renderAt('/overview', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/unread': () => ({ unread: 0 }),
    });
    const door = await screen.findByRole('link', { name: /Mail/ });
    expect(door.textContent).toContain(ADDRESS);
    expect(door.querySelector('.unreaddot')).toBeNull();
  });

  it('has no door for an account that has not taken an address', async () => {
    renderAt('/', { ...workspaceScript(() => emptyState({ org, ...account() })) });
    // Home has drawn: the reader's own account menu stands on every one of
    // them (note #634).
    await screen.findByRole('button', { name: 'Your account' });
    expect(screen.queryByRole('link', { name: /^Mail/ })).toBeNull();
  });
});

describe('one letter', () => {
  it('shows the sender’s own text, keeping the shape they gave it', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened(),
    });
    expect(await screen.findByRole('heading', { name: 'The engine' })).toBeTruthy();
    // The envelope names the sender ONCE, and the second line carries what
    // the name does not say (note #545). No `From:` label, no address of the
    // reader's own spelled out on a message they own.
    expect(document.querySelector('.mailwho .name')?.textContent).toBe('Ada Lovelace');
    expect(document.querySelector('.mailabout')?.textContent).toBe('ada@example.com · to you');
    expect(screen.queryByText(/From:/)).toBeNull();
    expect(screen.queryByText(new RegExp(ADDRESS))).toBeNull();
    // And the header's own second line no longer repeats that name under the
    // subject, which is where the duplication started.
    expect(document.querySelector('.phead .sub')).toBeNull();
    // A message and its answers are stamped by one clock, so the heading that
    // says which is which is one a reader can see: `homehead` hides a heading
    // for Home's self-naming cards, and this is a detail screen.
    expect(document.querySelector('.mailfileshead')?.className).not.toContain('homehead');
    const body = document.querySelector('.mailtext');
    expect(body?.textContent).toContain('  — Ada');
    // What the SENDER attached, and nothing else: the raw `.eml` is still
    // kept and an agent can still fetch it, but it is not a row here (#517).
    expect(screen.getByText('notes.pdf')).toBeTruthy();
    expect(screen.queryByText('The original message')).toBeNull();
    expect(screen.queryByText(/exactly as it arrived/)).toBeNull();
  });

  it('draws no files shelf for a message that carried nothing', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      // rawSize is what it was: the bytes are kept, they are simply not a row.
      'GET api/mail/conversations/mm_1': () => opened({ attachments: [] }),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    expect(document.querySelector('.mailfiles')).toBeNull();
    expect(document.querySelector('.mailfileshead')).toBeNull();
    expect(screen.queryByText('The original message')).toBeNull();
  });

  it('never renders the sender’s markup in this app, and fetches no picture', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened({
          text: '',
          html: '<p onclick="alert(1)">Hello <b>there</b></p><img src="https://tracker.example.com/open.gif">'
            + '<script>window.stolen = 1</script><style>body{display:none}</style>',
          attachments: [],
        }),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    // Waited for, not read straight after the heading: SafeHtml fills its host
    // in an effect, so the body lands one tick after the screen does. Reading
    // it synchronously passed on an idle machine and came back EMPTY on a
    // loaded CI host (2026-09-15) — a flake, not a finding.
    const body = await waitFor(() => {
      const drawn = document.querySelector('.mailhtml');
      expect(drawn?.textContent).toContain('Hello there');
      return drawn;
    });
    // The sender's script and stylesheet are not in the document at all, and
    // neither is the image that would have told them the message was opened.
    expect(document.querySelector('.mailhtml script')).toBeNull();
    expect(document.querySelector('.mailhtml style')).toBeNull();
    expect(document.querySelectorAll('.mailhtml img').length).toBe(0);
    expect(body?.querySelector('p')?.getAttribute('onclick')).toBeNull();
    expect(screen.getByText(/Pictures in this message are not loaded/)).toBeTruthy();
    expect((window as unknown as { stolen?: number }).stolen).toBeUndefined();
  });

  it('draws the formatted half of a message carrying both, with no way to the other', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened({
          text: 'Formatted words\n\nMachines\n$12.40\n',
          html: '<p>Formatted <b>words</b></p><img src="https://track.example.com/open.gif">'
            + '<script>window.stolen = 1</script>',
        }),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    // The sender's own shape, unasked — and it is the ONLY body drawn: the
    // machine-flattened text half its sender generated is not on the screen
    // and there is nothing to tap to reach it (note #534).
    await waitFor(() => expect(document.querySelector('.mailhtml')?.textContent).toContain('Formatted words'));
    expect(document.querySelector('.mailtext')).toBeNull();
    expect(document.querySelector('#mailBodySwitch')).toBeNull();
    expect(screen.queryByRole('button', { name: /version$/ })).toBeNull();
    // Still nothing of theirs: no picture requested, no script in the
    // document, and the line saying pictures were left out stands on its own.
    expect(document.querySelectorAll('.mailhtml img').length).toBe(0);
    expect(document.querySelector('.mailhtml script')).toBeNull();
    expect((window as unknown as { stolen?: number }).stolen).toBeUndefined();
    expect(document.querySelector('.mailnotes')?.textContent)
      .toBe('Pictures in this message are not loaded.');
  });

  it('keeps the plain text for a message that carried no markup', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened(),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    expect(document.querySelector('.mailtext')).toBeTruthy();
    expect(document.querySelector('.mailhtml')).toBeNull();
    // Nothing was left out of a hand-typed letter, so the quiet line under
    // the body is not drawn at all rather than drawn empty.
    expect(document.querySelector('.mailnotes')).toBeNull();
  });

  it('falls back to the text half when the allowlist empties the markup', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened({
          text: 'It weaves algebraic patterns.',
          // A formatted half made entirely of things this app refuses to
          // build. It is a real shape — a one-pixel tracker wrapped in
          // markup we do not know — and the builder comes back with nothing.
          html: '<marquee>Hello</marquee><img src="https://track.example.com/open.gif">',
        }),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    // The reader gets the words, not an empty card: with the switch gone this
    // is the only thing standing between them and a blank message.
    await waitFor(() => expect(document.querySelector('.mailtext')?.textContent)
      .toContain('It weaves algebraic patterns.'));
    expect(document.querySelector('.mailhtml')).toBeNull();
    expect(screen.queryByText('This message had no words in it.')).toBeNull();
  });

  it('says so when neither half of a message has words in it', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened({ text: '', html: '<script>window.stolen = 1</script>', attachments: [] }),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    expect(await screen.findByText('This message had no words in it.')).toBeTruthy();
    expect(document.querySelector('.mailhtml')).toBeNull();
    expect((window as unknown as { stolen?: number }).stolen).toBeUndefined();
  });

  it('keeps a message it could not read, and says so', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened({ text: '', html: '', attachments: [], unreadable: true, subject: 'Broken' }),
    });
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    // And says only what is true of what is on the screen: the line no longer
    // sends the reader to a download that is not drawn (#517).
    expect(screen.queryByText(/downloaded below/)).toBeNull();
    expect(screen.queryByText('The original message')).toBeNull();
  });

  it('warns in plain words when nothing vouched for the sender', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened({ suspicious: true, authentication: { dmarc: 'fail', spf: 'fail' } }),
    });
    expect(await screen.findByText(/Treat it as if it were forged/)).toBeTruthy();
  });

  it('asks for a short-lived URL when a file is opened, and opens it outside the app', async () => {
    const windowOpen = vi.fn();
    vi.stubGlobal('open', windowOpen);
    const { calls } = renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened(),
      'GET api/mail/messages/mm_1/files/ma_1': () => ({ url: 'https://files.test/signed', fileName: 'notes.pdf', expiresAt: 'soon' }),
    });
    await screen.findByText('notes.pdf');
    fireEvent.click(screen.getByText('notes.pdf'));
    await waitFor(() => expect(calls.some((call) => call.path === 'api/mail/messages/mm_1/files/ma_1')).toBe(true));
    await waitFor(() => expect(windowOpen).toHaveBeenCalledWith('https://files.test/signed', '_blank', 'noopener,noreferrer'));
    vi.unstubAllGlobals();
  });
});

describe('plain text on a phone', () => {
  it('joins a hard-wrapped paragraph back together and leaves every deliberate shape alone', () => {
    const letter = [
      'Hello,',
      '',
      'Here is the brief we talked through on Tuesday — the photograph is the',
      'one for the header. Anything you want changed, say so.',
      '',
      '> You said the header should be wider than the one before it, and I',
      '> agree with you about that.',
      '',
      '- the brief',
      '- the photograph',
      '',
      '  — Priya',
      '    Harborlight',
    ].join('\n');
    const lines = reflowMailText(letter).split('\n');
    // The wrapped paragraph is one line again…
    expect(lines[2]).toBe('Here is the brief we talked through on Tuesday — the photograph is the one for the header. Anything you want changed, say so.');
    // …and everything the sender drew on purpose kept its own line.
    expect(lines.filter((line) => line.startsWith('> ')).length).toBe(2);
    expect(lines.filter((line) => line.startsWith('- ')).length).toBe(2);
    expect(lines.at(-2)).toBe('  — Priya');
    expect(lines.at(-1)).toBe('    Harborlight');
    // A blank line is still a paragraph break.
    expect(lines[1]).toBe('');
  });

  it('leaves a short line where the sender put it', () => {
    expect(reflowMailText('Yes.\nThank you.')).toBe('Yes.\nThank you.');
  });
});

describe('the envelope', () => {
  const message = (over: Partial<WorkspaceMailMessageDetail> = {}) => detail(over);

  it('names the sender once and says what the name does not', () => {
    expect(mailEnvelope(message(), ADDRESS)).toEqual({
      who: 'Ada Lovelace', detail: 'ada@example.com · to you',
    });
  });

  it('does not print an address twice when that address is the only name', () => {
    expect(mailEnvelope(message({ from: { address: 'ada@example.com' } }), ADDRESS).detail).toBe('to you');
  });

  it('names the other recipients, and the reader among them, by name', () => {
    expect(mailEnvelope(message({
      to: [{ address: ADDRESS }, { name: 'Bea', address: 'bea@example.com' }],
      cc: [{ name: 'Cyd', address: 'cyd@example.com' }],
    }), ADDRESS).detail).toBe('ada@example.com · to you, Bea · copy to Cyd');
  });

  it('counts a long recipient list rather than reading it out', () => {
    const many = ['b', 'c', 'd', 'e', 'f'].map((one) => ({ address: `${one}@example.com` }));
    expect(mailEnvelope(message({ to: [{ address: ADDRESS }, ...many] }), ADDRESS).detail)
      .toBe('ada@example.com · to you, b@example.com, c@example.com and 3 others');
  });

  it('names a message this person started by who it went to, and says if an agent wrote it', () => {
    expect(mailEnvelope(message({
      direction: 'sent', from: { address: ADDRESS }, to: [{ name: 'Ada Lovelace', address: 'ada@example.com' }],
      sentBy: 'Ruby',
    }), ADDRESS)).toEqual({ who: 'To Ada Lovelace', detail: 'ada@example.com · sent by Ruby' });
  });

  it('says what it can about a message that carried no From header at all', () => {
    expect(mailEnvelope(message({ from: undefined, to: [] }), ADDRESS))
      .toEqual({ who: 'Unknown sender', detail: '' });
  });
});

describe('where an answer went', () => {
  const to = [{ name: 'Ada Lovelace', address: 'ada@example.com' }];
  const reply = { id: 'mm_a', to, text: 'Yes.', sentAt: new Date().toISOString() };

  it('says the name alone when the answer went back to whoever wrote', () => {
    expect(mailReplyTo(reply, detail())).toBe('Ada Lovelace');
  });

  it('spells out an address the message asked answers to be sent to instead', () => {
    const elsewhere = { ...reply, to: [{ name: 'Ada’s desk', address: 'desk@example.com' }] };
    expect(mailReplyTo(elsewhere, detail())).toBe('Ada’s desk <desk@example.com>');
  });

  it('says nothing rather than `To` and a blank', () => {
    expect(mailReplyTo({ ...reply, to: [] }, detail())).toBe('');
  });
});

describe('answering a conversation', () => {
  const answerable = (over: Partial<WorkspaceMailThreadMessage> = {}) => opened(over, {
    reply: { id: 'mm_1', to: { name: 'Ada Lovelace', address: 'ada@example.com' } },
  });

  it('offers Reply only when the server says there is somebody to answer', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened(),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    expect(screen.queryByRole('button', { name: /^Reply/ })).toBeNull();
  });

  it('writes the reply with no way to address it at anybody else, and shows it at the foot of the conversation', async () => {
    const conversation = answerable().conversation;
    const { calls } = renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => ({ conversation }),
      'POST api/mail/messages/mm_1/reply': () => {
        const reply = {
          id: 'mm_out', to: [{ name: 'Ada Lovelace', address: 'ada@example.com' }],
          text: 'It does indeed.', sentAt: new Date().toISOString(),
        };
        // The server's own copy is in the conversation the next read returns.
        conversation.messages = [...conversation.messages, letter({
          id: 'mm_out', direction: 'sent', from: { address: ADDRESS }, to: reply.to, text: reply.text,
          snippet: reply.text, receivedAt: reply.sentAt, attachments: [], files: 0,
        })];
        return { reply };
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reply to Ada Lovelace' }));

    // The recipient is shown and is not a field: there is exactly one input.
    expect(await screen.findByRole('heading', { name: 'Reply' })).toBeTruthy();
    expect(screen.getByText(/to Ada Lovelace <ada@example.com>/)).toBeTruthy();
    expect(document.querySelectorAll('#screenMailReply input[type=text], #screenMailReply input[type=email]').length).toBe(0);

    fireEvent.change(screen.getByPlaceholderText('Write your reply'), { target: { value: 'It does indeed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(() => expect(calls.some((call) => call.path === 'api/mail/messages/mm_1/reply')).toBe(true));
    const sent = calls.find((call) => call.path === 'api/mail/messages/mm_1/reply')!;
    // Words only — the route decides the recipient.
    expect(JSON.parse(String(sent.init?.body))).toEqual({ text: 'It does indeed.' });
    // Back in the conversation, with the answer standing at its foot — said
    // in words, not only in colour: the owner could not tell their own reply
    // from the letter it answered (note #545).
    expect(await screen.findByText(/From you to Ada Lovelace/)).toBeTruthy();
    const letters = document.querySelectorAll('#mailConversation .mailletter');
    expect(letters.length).toBe(2);
    expect(letters[1]!.classList.contains('mailown')).toBe(true);
    expect(letters[1]!.textContent).toContain('It does indeed.');
    expect(screen.getByRole('button', { name: 'Reply to Ada Lovelace' })).toBeTruthy();
    // One clock over the whole conversation: the answer is dated the way the
    // letter above it is, not aged in hours against it.
    const stamp = letters[1]!.querySelector('time');
    expect(stamp?.getAttribute('datetime')).toBeTruthy();
    expect(stamp?.textContent).not.toContain('ago');
  });

  it('keeps the words when the send fails, and says why', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => answerable(),
      'POST api/mail/messages/mm_1/reply': () => {
        throw new WorkspaceApiError('The reply could not be sent. Try again in a moment.', 502, {});
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reply to Ada Lovelace' }));
    fireEvent.change(await screen.findByPlaceholderText('Write your reply'), { target: { value: 'Hello again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByPlaceholderText('Write your reply') as HTMLTextAreaElement).value).toBe('Hello again');
  });
});

describe('a message wearing one of our own addresses', () => {
  it('says plainly that it has not proved it, rather than the general warning', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened({
          from: { name: 'Billing', address: 'billing@agenticcloudcomputer.com' },
          suspicious: true,
          authentication: { spf: 'none', dmarc: 'none' },
        }),
    });
    expect(await screen.findByText(/says it comes from an address on this domain/)).toBeTruthy();
    expect(screen.getByText(/treat it as forged/)).toBeTruthy();
  });
});

describe('writing to somebody who has not written first', () => {
  const sendable = () => ({
    ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
    'GET api/mail/conversations': () => inbox(),
  });

  it('writes one message to one person, and puts it at the top of the list', async () => {
    const written: WorkspaceMailConversationSummary[] = [];
    const sentRow = (): WorkspaceMailMessageSummary => ({
      id: 'mm_out', direction: 'sent', to: [{ address: 'ada@example.com' }],
      subject: 'About Tuesday', snippet: 'Are you free at four?',
      receivedAt: new Date().toISOString(), files: 0,
    });
    const { calls } = renderAt('/mail', {
      ...sendable(),
      // The server answers the way it now does: a message this person started
      // starts a conversation of its own, so the refresh after sending
      // returns it too.
      'GET api/mail/conversations': () => inbox([...written, row()]),
      'POST api/mail/send': () => {
        const message = sentRow();
        written.unshift(row({
          id: message.id, started: true, with: message.to!, subject: message.subject, files: 0, opens: message.id,
          latest: { id: message.id, snippet: message.snippet, receivedAt: message.receivedAt, direction: 'sent' },
        }));
        return { message };
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Write email' }));
    expect(await screen.findByRole('heading', { name: 'New message' })).toBeTruthy();
    // No small print under the form and no Cancel beside Send: the owner
    // took both off (note #611). Back is the way out.
    expect(document.querySelector('.mailnotes')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('name@example.com'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('What it is about'), { target: { value: 'About Tuesday' } });
    fireEvent.change(screen.getByPlaceholderText('Write your message'), { target: { value: 'Are you free at four?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(calls.some((call) => call.path === 'api/mail/send')).toBe(true));
    const sent = calls.find((call) => call.path === 'api/mail/send')!;
    expect(JSON.parse(String(sent.init?.body)))
      .toEqual({ to: 'ada@example.com', subject: 'About Tuesday', text: 'Are you free at four?' });

    // Back on the list, and the row this person wrote is named by who it went
    // to — "from: me" would say nothing on my own list.
    expect(await screen.findByText('To ada@example.com')).toBeTruthy();
  });

  it('will not send until there is both an address and something to say', async () => {
    renderAt('/mail', sendable());
    fireEvent.click(await screen.findByRole('button', { name: 'Write email' }));
    const button = () => screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('name@example.com'), { target: { value: 'ada@example.com' } });
    expect(button().disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Write your message'), { target: { value: 'Hello' } });
    expect(button().disabled).toBe(false);
  });

  it('keeps the words when the server refuses, and says why', async () => {
    renderAt('/mail', {
      ...sendable(),
      'POST api/mail/send': () => {
        throw new WorkspaceApiError('You can start 10 new messages an hour. Try again shortly.', 429, { code: 'too_many' });
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Write email' }));
    fireEvent.change(screen.getByPlaceholderText('name@example.com'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Write your message'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect((await screen.findByRole('alert')).textContent).toContain('10 new messages an hour');
    expect((screen.getByPlaceholderText('Write your message') as HTMLTextAreaElement).value).toBe('Hello');
  });
});

describe('a message sent a second ago', () => {
  it('still says an hour for a stamp that is a tick ahead of this tab', async () => {
    // The server stamped it and this tab's clock is a tick behind, so the
    // moment is in the FUTURE by the reader's clock. `relative` reads such a
    // moment as no reading at all, which is how the row came to say "The
    // header crop ·" and stop; a clock has no such hole in it.
    const justSent = row({
      id: 'mm_out', started: true, with: [{ address: 'ada@example.com' }], subject: 'The header crop', files: 0, opens: 'mm_out',
      // A minute ahead, not a second: the clock in this screen ticks while
      // the assertion waits, and a small skew would resolve itself and prove
      // nothing.
      latest: { id: 'mm_out', snippet: 'Sending it over.', receivedAt: new Date(Date.now() + 60_000).toISOString(), direction: 'sent' },
    });
    renderAt('/mail', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations': () => inbox([justSent]),
    });
    await screen.findByText('The header crop');
    const when = document.querySelector('#mailList .mailwhen')!;
    expect(when.textContent).toBe(mailWhen(justSent.latest.receivedAt));
    expect(when.textContent).toMatch(/^\d{1,2}:\d{2}( ?[AP]M)?$/);
  });
});

describe('when a message came', () => {
  const day = (days: number, hour = 9) => {
    const at = new Date();
    at.setDate(at.getDate() - days);
    at.setHours(hour, 5, 0, 0);
    return at.toISOString();
  };

  it('says the clock for today, the day for older, and the year beyond this one', () => {
    expect(mailWhen(day(0, 14))).toMatch(/^\d{1,2}:\d{2}( ?[AP]M)?$/);
    // Yesterday is a DAY, however few hours ago it was: 23:50 and 00:10 are
    // twenty minutes apart and belong to different days.
    expect(mailWhen(day(1))).toBe(new Date(day(1)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
    expect(mailWhen(day(1))).not.toMatch(/:/);
    const lastYear = new Date(day(1));
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    expect(mailWhen(lastYear.toISOString())).toContain(String(lastYear.getFullYear()));
  });

  it('says nothing at all for a stamp it cannot read, rather than "Invalid Date"', () => {
    expect(mailWhen('not a time')).toBe('');
  });

});

describe('searching, the archive and Trash (slice 7)', () => {
  const brief: WorkspaceMailMessageSummary = {
    ...summary, id: 'mm_brief', from: { name: 'Priya Raman', address: 'priya@harborlight.co' },
    subject: 'The brief, and one photograph', snippet: 'Here is the brief.', files: 0,
    receivedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  };
  const briefRow = row({
    id: 'mm_brief', with: [brief.from!], subject: brief.subject, files: 0, opens: 'mm_brief',
    latest: { id: 'mm_brief', snippet: brief.snippet, receivedAt: brief.receivedAt },
  });
  const withState = () => workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) }));

  it('reads each list from its own address, and keeps the search in the entry', () => {
    expect(mailConversationsPath('inbox')).toBe('api/mail/conversations');
    expect(mailConversationsPath('trash')).toBe('api/mail/conversations?in=trash');
    expect(mailListPath({ view: 'all', search: 'the brief' })).toBe('api/mail/messages?in=all&q=the+brief');
    const address = new URLSearchParams('keep=1&q=old');
    expect(mailAddressWith(address, 'new words').toString()).toBe('keep=1&q=new+words');
    expect(mailAddressWith(address, '').toString()).toBe('keep=1');
  });

  it('searches as it is typed — the inbox and the archive together — and finds LETTERS, each opening its conversation', async () => {
    const scripted = renderAt('/mail', {
      ...withState(),
      'GET api/mail/conversations': () => inbox([row(), briefRow]),
      'GET api/mail/messages?in=all&q=brief': () => found([{ ...brief, place: 'archive' }]),
    });
    await screen.findByText('The engine');
    const field = screen.getByRole('searchbox', { name: 'Search mail' });
    fireEvent.change(field, { target: { value: 'brief' } });
    expect(await screen.findByText('1 message in your inbox and archive matching “brief”.')).toBeTruthy();
    expect(screen.queryByText('The engine')).toBeNull();
    // The same row shape as the inbox's, and it says where the letter is kept.
    const result = document.querySelector('#mailList .crow.open')!;
    expect(result.querySelector('.mailtop .name')!.textContent).toBe('Priya Raman');
    expect(result.querySelector('.mailmarks')!.textContent).toBe('archived');
    // A result is the letter: it opens its conversation standing at it.
    expect(result.getAttribute('href')).toBe('/mail/mm_brief');
    expect(scripted.calls.filter((call) => call.path.includes('q=')).map((call) => call.path))
      .toEqual(['api/mail/messages?in=all&q=brief']);
    // Emptied, the field hands the inbox straight back.
    fireEvent.change(field, { target: { value: '' } });
    expect(await screen.findByText('The engine')).toBeTruthy();
    expect(document.getElementById('mailFound')).toBeNull();
  });

  it('opens on the words it was left with, so Back from a result lands on the results', async () => {
    renderAt('/mail?q=brief', {
      ...withState(),
      'GET api/mail/messages?in=all&q=brief': () => found([brief]),
    });
    expect(await screen.findByText('The brief, and one photograph')).toBeTruthy();
    expect((screen.getByRole('searchbox', { name: 'Search mail' }) as HTMLInputElement).value).toBe('brief');
  });

  it('says so when nothing matches, rather than leaving an empty card', async () => {
    renderAt('/mail?q=zebra', {
      ...withState(),
      'GET api/mail/messages?in=all&q=zebra': () => found([]),
    });
    expect(await screen.findByText('Nothing in your inbox and archive matches “zebra”.')).toBeTruthy();
    // Still the list's card, with the way to write one and the field.
    expect(document.getElementById('mailWrite')).toBeTruthy();
    expect(screen.queryByText(/Nothing has arrived yet/)).toBeNull();
  });

  it('keeps Starred, Sent, the archive, Spam and Trash a door away, at the foot of the inbox', async () => {
    renderAt('/mail', { ...withState(), 'GET api/mail/conversations': () => inbox() });
    await screen.findByText('The engine');
    const doors = document.getElementById('mailPlaces')!;
    expect([...doors.querySelectorAll('.crow')].map((door) => door.id))
      .toEqual(['mailStarredDoor', 'mailSentDoor', 'mailArchiveDoor', 'mailSpamDoor', 'mailTrashDoor']);
    expect(doors.querySelector('#mailStarredDoor')!.getAttribute('href')).toBe('/mail/starred');
    expect(doors.querySelector('#mailSentDoor')!.getAttribute('href')).toBe('/mail/sent');
    expect(doors.querySelector('#mailArchiveDoor')!.getAttribute('href')).toBe('/mail/archive');
    expect(doors.querySelector('#mailSpamDoor')!.getAttribute('href')).toBe('/mail/spam');
    expect(doors.querySelector('#mailTrashDoor')!.getAttribute('href')).toBe('/mail/trash');
    // Its own card, below the list, so neither reads as one more message.
    expect(document.getElementById('mailList')!.contains(doors)).toBe(false);
  });

  it('draws the archive and Trash as lists of their own, each searched in its own place', async () => {
    renderAt('/mail/trash', {
      ...withState(),
      'GET api/mail/conversations?in=trash': () => inbox([{ ...briefRow, place: 'trash', movedBy: 'Ruby' }]),
      'GET api/mail/messages?in=trash&q=brief': () => found([]),
    });
    expect(await screen.findByRole('heading', { name: 'Trash' })).toBeTruthy();
    expect(await screen.findByText('The brief, and one photograph')).toBeTruthy();
    // A conversation an agent put there says which agent, where its owner reads it.
    expect(screen.getByText('put in Trash by Ruby')).toBeTruthy();
    // Writing belongs to the inbox.
    expect(document.getElementById('mailWrite')).toBeNull();
    expect(document.getElementById('mailPlaces')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Trash' }), { target: { value: 'brief' } });
    expect(await screen.findByText('Nothing in Trash matches “brief”.')).toBeTruthy();
  });

  it('draws Spam as a list of its own that says WHY each row is there, searched in Spam alone (slice 13)', async () => {
    renderAt('/mail/spam', {
      ...withState(),
      'GET api/mail/conversations?in=spam': () => inbox([
        { ...briefRow, place: 'spam', spamWhy: 'blocked' },
        { ...row({ id: 'mm_forged', subject: 'Your card was declined', opens: 'mm_forged', files: 0, suspicious: true,
          with: [{ name: 'Agentbuilt Billing', address: 'billing@agenticcloudcomputer.com' }],
          latest: { id: 'mm_forged', snippet: 'Update your card.', receivedAt: brief.receivedAt } }), place: 'spam', spamWhy: 'suspicious' },
        { ...row({ id: 'mm_3', subject: 'Cheap watches', opens: 'mm_3', files: 0,
          latest: { id: 'mm_3', snippet: 'Rolex for 20.', receivedAt: brief.receivedAt } }), place: 'spam', movedBy: 'Ruby' },
      ]),
      'GET api/mail/messages?in=spam&q=brief': () => found([]),
    });
    expect(await screen.findByRole('heading', { name: 'Spam' })).toBeTruthy();
    expect(await screen.findByText('The brief, and one photograph')).toBeTruthy();
    const marks = [...document.querySelectorAll('#mailList .crow.open')].map((one) => one.querySelector('.mailmarks')?.textContent ?? '');
    expect(marks).toEqual(['blocked sender', 'unverified sender', 'marked spam by Ruby']);
    expect(document.getElementById('mailWrite')).toBeNull();
    expect(document.getElementById('mailPlaces')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Spam' }), { target: { value: 'brief' } });
    expect(await screen.findByText('Nothing in Spam matches “brief”.')).toBeTruthy();
  });

  it('offers Not spam and Trash from a conversation in Spam, no Reply, and says why it is there', async () => {
    const scripted = renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened({ place: 'spam', spamWhy: 'suspicious', suspicious: true, authentication: { dmarc: 'none' } }, { place: 'spam', spamWhy: 'suspicious', reply: { id: 'mm_1', to: { address: 'ada@example.com' } } }),
      'POST api/mail/conversations/mm_1/unspam': () => ({ conversation: row(), messages: [{ id: 'mm_1' }] }),
    });
    expect(await screen.findByText('In Spam: nothing vouched for the sender, so it never reached the inbox. It is kept whole.')).toBeTruthy();
    expect([...document.querySelectorAll('#mailTools button')].map((button) => button.textContent)).toEqual(['Not spam', 'Move to Trash']);
    expect(document.getElementById('mailReply')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Not spam' }));
    await waitFor(() => expect(document.getElementById('mailPlace')).toBeNull());
    expect(scripted.calls.map((call) => call.path)).toContain('api/mail/conversations/mm_1/unspam');
    // Back in the inbox, the buttons are the inbox's — Mark as spam among them.
    expect([...document.querySelectorAll('#mailTools button')].map((button) => button.textContent)).toEqual(['Archive', 'Mark as spam', 'Move to Trash']);
  });

  it('blocks a sender from their letter and reads the conversation again, then offers the way back', async () => {
    let blocked = false;
    const scripted = renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened(blocked ? { senderBlocked: true, place: 'spam', spamWhy: 'blocked' } : {}, blocked ? { place: 'spam', spamWhy: 'blocked' } : {}),
      'POST api/mail/blocked-senders': () => { blocked = true; return { addresses: ['ada@example.com'], moved: 1 }; },
      'DELETE api/mail/blocked-senders/ada%40example.com': () => { blocked = false; return { addresses: [] }; },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Block ada@example.com' }));
    expect(await screen.findByRole('button', { name: 'Unblock ada@example.com' })).toBeTruthy();
    expect(screen.getByText('In Spam: you blocked the sender. It is kept whole.')).toBeTruthy();
    const posted = scripted.calls.find((call) => call.path === 'api/mail/blocked-senders');
    expect(posted?.init?.body).toBe(JSON.stringify({ address: 'ada@example.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unblock ada@example.com' }));
    expect(await screen.findByRole('button', { name: 'Block ada@example.com' })).toBeTruthy();
  });

  it('says what an empty place is for', async () => {
    renderAt('/mail/archive', { ...withState(), 'GET api/mail/conversations?in=archive': () => inbox([]) });
    expect(await screen.findByRole('heading', { name: 'Archive' })).toBeTruthy();
    expect(await screen.findByText(/Nothing has been archived/)).toBeTruthy();
  });

  it('archives the whole conversation, says where it went from the SERVER’s answer, and offers the way back', async () => {
    holdMailPlace(inbox([row(), briefRow]));
    const scripted = renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened({}, { reply: { id: 'mm_1', to: summary.from! } }),
      'POST api/mail/conversations/mm_1/archive': () => ({ conversation: row({ place: 'archive' }), messages: [{ id: 'mm_1', place: 'archive' }] }),
      'POST api/mail/conversations/mm_1/unarchive': () => ({ conversation: row(), messages: [{ id: 'mm_1' }] }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(/^Archived\. It is kept whole/)).toBeTruthy();
    expect(scripted.calls.find((call) => call.path === 'api/mail/conversations/mm_1/archive')!.init?.method).toBe('POST');
    // Back to the inbox must not paint the row that has just left it.
    expect(heldMailPlace()!.conversations.map((one) => one.id)).toEqual(['mm_brief']);
    expect(heldMailPlace('archive')).toBeNull();
    expect(heldMailConversation('mm_1')!.place).toBe('archive');
    expect(heldMailConversation('mm_1')!.messages[0]!.place).toBe('archive');
    // The letter is still in front of the reader, and still answerable.
    expect(screen.getByRole('button', { name: 'Reply to Ada Lovelace' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move to inbox' }));
    await waitFor(() => expect(document.getElementById('mailPlace')).toBeNull());
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
    // And it takes its turn in the inbox again, by its newest letter.
    expect(heldMailPlace()!.conversations.map((one) => one.id)).toEqual(['mm_1', 'mm_brief']);
    expect(heldMailConversation('mm_1')!.place).toBeUndefined();
  });

  it('moves to Trash and back with Restore, and offers no reply from there', async () => {
    renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened({}, { reply: { id: 'mm_1', to: summary.from! } }),
      'POST api/mail/conversations/mm_1/trash': () => ({ conversation: row({ place: 'trash' }), messages: [{ id: 'mm_1', place: 'trash' }] }),
      'POST api/mail/conversations/mm_1/restore': () => ({ conversation: row(), messages: [{ id: 'mm_1' }] }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Move to Trash' }));
    expect(await screen.findByText('In Trash. Nothing here is deleted for good.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reply/ })).toBeNull();
    // The words are all still here — and no letter repeats that it is in
    // Trash: the line above says it for the whole conversation.
    expect(document.querySelector('.mailtext')!.textContent).toContain('It weaves algebraic patterns.');
    expect(document.querySelector('.mailletterplace')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('button', { name: 'Reply to Ada Lovelace' })).toBeTruthy();
    expect(document.getElementById('mailPlace')).toBeNull();
  });

  it('claims nothing when a move is refused, and says why', async () => {
    renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened(),
      'POST api/mail/conversations/mm_1/archive': () => { throw new WorkspaceApiError('That conversation is in Trash. Restore it first.', 409, {}); },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'That conversation is in Trash. Restore it first.');
    expect(document.getElementById('mailPlace')).toBeNull();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
  });
});

describe('conversations (slice 8)', () => {
  const withState = () => workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) }));
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const priya = { name: 'Priya Raman', address: 'priya@harborlight.co' };

  /** Three letters: Priya's brief, the answer the reader's agent sent, and
   *  Priya's answer to THAT — quoting it at the bottom, as every client does. */
  const thread = (): WorkspaceMailConversation => conversationOf([
    letter({
      id: 'mm_brief', from: priya, subject: 'The brief', receivedAt: at(90), attachments: [], files: 0,
      text: 'Here is the brief we talked through on Tuesday.\n\n  — Priya',
    }),
    letter({
      id: 'mm_ours', direction: 'sent', from: { address: ADDRESS }, to: [priya], subject: 'Re: The brief', receivedAt: at(60),
      text: 'Samira is away until this evening — she has the brief and will come back to you tonight.',
      snippet: 'Samira is away until this evening', sentBy: 'Ruby', attachments: [], files: 0, rawSize: 0,
    }),
    letter({
      id: 'mm_back', from: priya, subject: 'Re: The brief', receivedAt: at(5), attachments: [], files: 0,
      text: 'Thank you — tonight is fine.\n\nOn Tue, 22 Sep 2026 at 10:00, Adam <adam@agenticcloudcomputer.com> wrote:\n'
        + '> Samira is away until this evening — she has the brief and will come back to\n> you tonight.\n',
    }),
  ], { reply: { id: 'mm_back', to: priya } });

  it('draws one row per conversation: who it is with, how many, and the newest line — the reader’s own said as theirs', async () => {
    renderAt('/mail', {
      ...withState(),
      'GET api/mail/conversations': () => inbox([
        row({
          id: 'mm_brief', with: [priya], subject: 'The brief', count: 3, unread: true, opens: 'mm_back', files: 0,
          latest: { id: 'mm_back', snippet: 'Thank you — tonight is fine.', receivedAt: at(5) },
        }),
        row({
          id: 'mm_lease', with: [{ name: 'Dana Okonjo', address: 'dana@okonjo.studio' }], subject: 'The lease', count: 2, opens: 'mm_answer', files: 0,
          latest: { id: 'mm_answer', snippet: 'Both copies are signed.', receivedAt: at(50), direction: 'sent', sentBy: 'Ruby' },
          trashed: 1,
        }),
      ]),
    });
    await screen.findByText('The brief');
    const rows = [...document.querySelectorAll('#mailList .crow.open')];
    expect(rows.length).toBe(2);
    // Who it is with, and how many letters, on the name's own line — the
    // count after the names, the clock at the edge (note #529's row, whole).
    const top = rows[0]!.querySelector('.mailtop')!;
    expect(top.querySelector('.mailnames')!.textContent).toBe('Priya Raman');
    expect(top.querySelector('.mailcount')!.textContent).toBe('3');
    expect(top.children[1]!.classList.contains('mailwhen')).toBe(true);
    // New while any letter in it is, and a tap opens it at the first new one.
    expect(rows[0]!.classList.contains('mailnew')).toBe(true);
    expect(rows[0]!.getAttribute('href')).toBe('/mail/mm_back');
    // The newest line is the reader's own on the second row: said as theirs,
    // and which agent wrote it, where the owner reads it.
    expect(rows[1]!.textContent).toContain('You: Both copies are signed.');
    expect(rows[1]!.querySelector('.mailmarks')!.textContent).toBe('sent by Ruby · 1 in Trash');
    // Still no mark in any row's margin, and still no chevron.
    expect(document.querySelectorAll('#mailList .crow .avatar, #mailList .crow .icon, #mailList .crow .chev').length).toBe(0);
  });

  it('names a conversation by who it is with, and one nobody has answered by who it went to', () => {
    expect(mailConversationName({ with: [priya], started: false })).toBe('Priya Raman');
    expect(mailConversationName({ with: [{ address: 'dana@okonjo.studio' }], started: true })).toBe('To dana@okonjo.studio');
    expect(mailConversationName({ with: ['a', 'b', 'c', 'd', 'e'].map((one) => ({ address: `${one}@x.co` })) }))
      .toBe('a@x.co, b@x.co, c@x.co and 2 others');
    // A conversation the reader started and nobody answered is theirs from
    // top to bottom, so its line needs no `You:`.
    expect(mailConversationLine({ started: true, latest: { id: 'x', snippet: 'Hello', receivedAt: at(1), direction: 'sent' } })).toBe('Hello');
    expect(mailConversationLine({ latest: { id: 'x', snippet: 'Hello', receivedAt: at(1), direction: 'sent' } })).toBe('You: Hello');
  });

  it('reads the conversation oldest first — theirs as it arrived, the reader’s marked as theirs, the quote folded', async () => {
    renderAt('/mail/mm_back', { ...withState(), 'GET api/mail/conversations/mm_back': () => ({ conversation: thread() }) });
    expect(await screen.findByRole('heading', { name: 'The brief' })).toBeTruthy();
    const letters = [...document.querySelectorAll('#mailConversation .mailletter')];
    expect(letters.map((one) => one.id)).toEqual(['mailLetter-mm_brief', 'mailLetter-mm_ours', 'mailLetter-mm_back']);
    expect(letters[0]!.querySelector('.mailwho .name')!.textContent).toBe('Priya Raman');
    // The reader's own, in words and not only in colour — and which agent
    // wrote it from their address.
    expect(letters[1]!.classList.contains('mailown')).toBe(true);
    expect(letters[1]!.querySelector('.mailownhead .ctext')!.textContent).toBe('From you to Priya Raman');
    expect(letters[1]!.querySelector('.mailreplyby')!.textContent).toBe('Sent by Ruby');
    // Priya's answer carries a copy of the reader's letter at the bottom. It
    // is the letter just above, so it is folded behind a tap — and still
    // there, whole, one press away.
    expect(letters[2]!.querySelector('.mailtext')!.textContent).toBe('Thank you — tonight is fine.');
    const fold = within(letters[2] as HTMLElement).getByRole('button', { name: 'Show quoted text' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(letters[2]!.textContent).not.toContain('Adam <adam@agenticcloudcomputer.com> wrote');
    fireEvent.click(fold);
    expect(letters[2]!.querySelector('.mailquotedbody')!.textContent).toContain('Adam <adam@agenticcloudcomputer.com> wrote:');
    expect(letters[2]!.querySelector('.mailquotedbody')!.textContent).toContain('> Samira is away until this evening');
    expect(within(letters[2] as HTMLElement).getByRole('button', { name: 'Hide quoted text' })).toBeTruthy();
    // One Reply, at the foot, answering the newest letter that arrived.
    expect(screen.getAllByRole('button', { name: /^Reply/ }).map((button) => button.textContent)).toEqual(['Reply to Priya Raman']);
  });

  it('answers the letter the server names, not the one the address opened at', async () => {
    const { calls } = renderAt('/mail/mm_brief', {
      ...withState(),
      'GET api/mail/conversations/mm_brief': () => ({ conversation: thread() }),
      'POST api/mail/messages/mm_back/reply': () => ({
        reply: { id: 'mm_out', to: [priya], text: 'See you tonight.', sentAt: new Date().toISOString() },
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reply to Priya Raman' }));
    // The composer shows what is being answered: the newest letter from Priya.
    expect(await screen.findByText(/Thank you — tonight is fine/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Write your reply'), { target: { value: 'See you tonight.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'api/mail/messages/mm_back/reply')).toBe(true));
    expect(calls.some((call) => call.path === 'api/mail/messages/mm_brief/reply')).toBe(false);
  });

  it('says when some of it is in Trash while the rest is not, and brings those back', async () => {
    const scripted = renderAt('/mail/mm_back', {
      ...withState(),
      'GET api/mail/conversations/mm_back': () => {
        const conversation = thread();
        conversation.trashed = 1;
        conversation.messages[0] = { ...conversation.messages[0]!, place: 'trash', movedBy: 'Ruby' };
        return { conversation };
      },
      'POST api/mail/conversations/mm_back/restore': () => ({
        conversation: row({ id: 'mm_brief', count: 3 }), messages: [{ id: 'mm_brief' }, { id: 'mm_ours' }, { id: 'mm_back' }],
      }),
    });
    expect(await screen.findByText('One message in this conversation is in Trash.')).toBeTruthy();
    // The letter itself says so, and who put it there.
    expect(document.querySelector('#mailLetter-mm_brief .mailletterplace')!.textContent).toBe('This message is in Trash, put there by Ruby.');
    fireEvent.click(screen.getByRole('button', { name: 'Restore from Trash' }));
    await waitFor(() => expect(document.getElementById('mailTrashed')).toBeNull());
    expect(scripted.calls.find((call) => call.path === 'api/mail/conversations/mm_back/restore')!.init?.method).toBe('POST');
    expect(document.querySelector('.mailletterplace')).toBeNull();
  });

  it('spells out an address only when an answer went somewhere nobody in it wrote from', () => {
    expect(mailOwnLine({ to: [priya] }, [priya.address])).toBe('From you to Priya Raman');
    expect(mailOwnLine({ to: [{ name: 'Priya’s desk', address: 'desk@harborlight.co' }] }, [priya.address]))
      .toBe('From you to Priya’s desk <desk@harborlight.co>');
    expect(mailOwnLine({ to: [] }, [])).toBe('From you');
  });
});

describe('the quote at the bottom of an answer', () => {
  const earlier = ['Samira is away until this evening — she has the brief and will come back to you tonight.'];

  it('folds a trailing quote of a letter above it, with the line introducing it', () => {
    const text = 'Thank you.\n\nOn Tue, 22 Sep 2026 at 10:00, Adam <\nadam@agenticcloudcomputer.com> wrote:\n\n> Samira is away until this evening — she has the\n> brief and will come back to you tonight.\n\n';
    expect(splitQuotedText(text, earlier)).toEqual({
      said: 'Thank you.',
      quoted: 'On Tue, 22 Sep 2026 at 10:00, Adam <\nadam@agenticcloudcomputer.com> wrote:\n\n> Samira is away until this evening — she has the\n> brief and will come back to you tonight.',
    });
  });

  it('leaves alone a quote of something this conversation does not hold, one in the middle, and a message that is all quote', () => {
    const stranger = 'Thanks.\n\n> Something from a letter that never reached this mailbox.';
    expect(splitQuotedText(stranger, earlier)).toEqual({ said: stranger });
    const inline = '> Samira is away until this evening — she has the brief and will come back to you tonight.\nGood — tonight works.';
    expect(splitQuotedText(inline, earlier)).toEqual({ said: inline });
    const allQuote = '> Samira is away until this evening — she has the brief and will come back to you tonight.';
    expect(splitQuotedText(allQuote, earlier)).toEqual({ said: allQuote });
  });

  it('folds Outlook’s “Original Message” form too', () => {
    const text = 'Fine by me.\n\n-----Original Message-----\nFrom: Adam\nSamira is away until this evening — she has the brief and will come back to you tonight.';
    expect(splitQuotedText(text, earlier).said).toBe('Fine by me.');
  });

  it('folds a trailing quote in markup — Gmail’s, a bare blockquote with its introduction, and Outlook’s — into two halves of markup', () => {
    const gmail = '<div dir="ltr">Thank you.</div><br><div class="gmail_quote"><div class="gmail_attr">On Tue, Adam wrote:<br></div>'
      + '<blockquote class="gmail_quote">Samira is away until this evening — she has the brief and will come back to you tonight.</blockquote></div>';
    const cut = splitQuotedHtml(gmail, earlier);
    expect(cut.said).toContain('Thank you.');
    expect(cut.said).not.toContain('Samira');
    expect(cut.quoted).toContain('On Tue, Adam wrote:');
    expect(cut.quoted).toContain('Samira is away');

    const apple = '<div>Thank you.</div><div>On 22 Sep, Adam wrote:</div><blockquote type="cite"><div>Samira is away until this evening — she has the brief and will come back to you tonight.</div></blockquote>';
    const appleCut = splitQuotedHtml(apple, earlier);
    expect(appleCut.said).toBe('<div>Thank you.</div>');
    expect(appleCut.quoted).toContain('On 22 Sep, Adam wrote:');

    const outlook = '<div>Fine by me.</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Adam</div>'
      + '<div>Samira is away until this evening — she has the brief and will come back to you tonight.</div>';
    expect(splitQuotedHtml(outlook, earlier).said).toBe('<div>Fine by me.</div>');
  });

  it('keeps a blockquote that words follow — somebody answering point by point', () => {
    const inline = '<blockquote>Samira is away until this evening — she has the brief and will come back to you tonight.</blockquote><p>Tonight works.</p>';
    expect(splitQuotedHtml(inline, earlier)).toEqual({ said: inline });
  });

  it('knows a copy by its opening words, whatever a client did to its lines and marks', () => {
    expect(quoteRepeats('> Samira is away until this evening — she\n> has the brief and will come back to you tonight.', earlier)).toBe(true);
    // A client that trimmed the quote to its first line still quoted the letter.
    expect(quoteRepeats('> Samira is away until this evening', earlier)).toBe(true);
    expect(quoteRepeats('> Something else entirely', earlier)).toBe(false);
    expect(quoteRepeats('', earlier)).toBe(false);
  });
});

describe('Sent (slice 9)', () => {
  const withState = () => workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) }));
  const priya = { name: 'Priya Raman', address: 'priya@harborlight.co' };
  /** A letter that went out: a reply when it answers one, a message she
   *  started when not — both rows of Sent, and of no other list. */
  const went = (over: Partial<WorkspaceMailMessageSummary> = {}): WorkspaceMailMessageSummary => ({
    ...summary, id: 'mm_reply', direction: 'sent', to: [priya], from: { address: ADDRESS },
    subject: 'Re: The brief', snippet: 'Thursday suits us.', files: 0,
    receivedAt: new Date(Date.now() - 20 * 60_000).toISOString(), ...over,
  });

  it('lists every letter that went out, named by who it went to, with no way for one to be new', async () => {
    const crop = went({ id: 'mm_crop', subject: 'The crop, as promised', snippet: 'Attaching the header crop.', sentBy: 'Ruby', place: 'archive', receivedAt: new Date(Date.now() - 55 * 60_000).toISOString() });
    renderAt('/mail/sent', {
      ...withState(),
      'GET api/mail/messages?in=sent': () => found([went(), crop]),
    });
    expect(await screen.findByRole('heading', { name: 'Sent' })).toBeTruthy();
    await screen.findByText('The crop, as promised');
    const rows = [...document.querySelectorAll('#mailList .crow.open')];
    expect(rows.map((one) => one.querySelector('.mailtop .name')!.textContent)).toEqual(['To Priya Raman', 'To Priya Raman']);
    expect(rows.map((one) => one.querySelector('.mailsubject')!.textContent)).toEqual(['Re: The brief', 'The crop, as promised']);
    expect(screen.getByText('Thursday suits us.')).toBeTruthy();
    // Which of them an agent wrote — the only place its owner is told — and
    // where a letter is kept, since Sent is no place of its own.
    expect(rows[1]!.querySelector('.mailmarks')!.textContent).toBe('sent by Ruby · archived');
    // Nothing here can be new: she wrote all of it.
    expect(document.querySelectorAll('#mailList .mailnew').length).toBe(0);
    // A tap opens the conversation it is part of, standing at this letter.
    expect(rows[0]!.getAttribute('href')).toBe('/mail/mm_reply');
    // The clock rides the name's line, as it does in every mail list.
    expect(rows[0]!.querySelector('.mailtop .mailwhen')!.textContent).toBe(mailWhen(went().receivedAt));
    // Writing belongs to the inbox, and so do the doors.
    expect(document.getElementById('mailWrite')).toBeNull();
    expect(document.getElementById('mailPlaces')).toBeNull();
  });

  it('is searched in Sent alone', async () => {
    renderAt('/mail/sent', {
      ...withState(),
      'GET api/mail/messages?in=sent': () => found([went()]),
      'GET api/mail/messages?in=sent&q=priya': () => found([went()]),
      'GET api/mail/messages?in=sent&q=zebra': () => found([]),
    });
    await screen.findByText('Re: The brief');
    const field = screen.getByRole('searchbox', { name: 'Search Sent' });
    fireEvent.change(field, { target: { value: 'priya' } });
    expect(await screen.findByText('1 message in Sent matching “priya”.')).toBeTruthy();
    fireEvent.change(field, { target: { value: 'zebra' } });
    expect(await screen.findByText('Nothing in Sent matches “zebra”.')).toBeTruthy();
    expect(mailListPath({ view: 'sent' })).toBe('api/mail/messages?in=sent');
  });

  it('says what an empty Sent will hold', async () => {
    renderAt('/mail/sent', { ...withState(), 'GET api/mail/messages?in=sent': () => found([]) });
    expect(await screen.findByText(/Nothing has gone out of this address yet/)).toBeTruthy();
  });

  it('takes a letter out of the Sent list this tab holds when its conversation goes to Trash, and brings it back', () => {
    const letters = { address: ADDRESS, messages: [went(), went({ id: 'mm_crop' })] };
    holdMailLetters(letters, { view: 'sent' });
    mailConversationMoved({
      conversation: row({ id: 'mm_1', place: 'trash' }),
      messages: [{ id: 'mm_1', place: 'trash' }, { id: 'mm_reply', place: 'trash' }],
    });
    expect(heldMailLetters({ view: 'sent' })!.messages.map((one) => one.id)).toEqual(['mm_crop']);
    // Archived, it stays: Sent is not a place, and only Trash leaves it.
    holdMailLetters(letters, { view: 'sent' });
    mailConversationMoved({
      conversation: row({ id: 'mm_1', place: 'archive' }),
      messages: [{ id: 'mm_1', place: 'archive' }, { id: 'mm_reply', place: 'archive' }],
    });
    const held = heldMailLetters({ view: 'sent' })!;
    expect(held.messages.map((one) => one.id)).toEqual(['mm_reply', 'mm_crop']);
    expect(held.messages[0]!.place).toBe('archive');
  });
});

describe('pictures in a letter (slice 10)', () => {
  const withState = () => workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) }));
  const seal = { id: 'ma_seal', fileName: 'seal.png', contentType: 'image/png', size: 2048, inline: true, contentId: 'seal' };
  const drawn = () => Array.from(document.querySelectorAll<HTMLImageElement>('.mailhtml img')).map((img) => img.getAttribute('src'));

  it('draws a picture that travelled inside the message, with no tap and nothing said about pictures', async () => {
    renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened({
        text: '',
        html: '<p>Here it is:</p><img src="cid:seal" alt="The crop">',
        attachments: [seal],
      }),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    // Our own address, read with the reader's own session — the bytes are
    // already ours, so nobody outside is asked anything.
    await waitFor(() => expect(drawn()).toEqual(['/workspace/api/mail/messages/mm_1/inline/ma_seal']));
    // Nothing was left out, so the line that says something was is absent —
    // and so is the tap, because there is nothing to load.
    expect(document.querySelector('.mailnotes')).toBeNull();
    expect(document.querySelector('#mailPictures-mm_1')).toBeNull();
    // A `cid:` this message does not carry is dropped, not requested.
    expect(document.querySelectorAll('.mailhtml img[src^="cid:"]').length).toBe(0);
  });

  it('is the body even when the formatted half is one photograph and no words', async () => {
    renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened({ text: '', html: '<img src="cid:seal">', attachments: [seal] }),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    await waitFor(() => expect(drawn().length).toBe(1));
    expect(screen.queryByText('This message had no words in it.')).toBeNull();
  });

  it('leaves a remote picture until its reader asks, and then fetches it through our own proxy', async () => {
    const scripted = renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened({
        text: '',
        html: '<p>Invoice 4821</p><img src="https://cdn.example.com/logo.png">',
        attachments: [],
      }),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    await waitFor(() => expect(document.querySelector('.mailhtml')?.textContent).toContain('Invoice 4821'));
    expect(drawn()).toEqual([]);
    expect(document.querySelector('.mailnotes')?.textContent).toBe('Pictures in this message are not loaded.');
    // The cost is IN the button, not in a footnote under it.
    const load = screen.getByRole('button', { name: 'Load pictures (the sender may learn you opened this)' });
    fireEvent.click(load);
    await waitFor(() => expect(drawn()).toEqual([
      '/workspace/api/mail/messages/mm_1/remote-image?src=https%3A%2F%2Fcdn.example.com%2Flogo.png',
    ]));
    // Loaded, the line has nothing left to report — and the standing answer
    // is offered only now, for this sender alone.
    expect(document.querySelector('.mailnotes')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Load pictures/ })).toBeNull();
    const always = screen.getByRole('button', { name: 'Always load pictures from ada@example.com' });
    expect(scripted.calls.some((call) => call.path === 'api/mail/image-senders')).toBe(false);
    fireEvent.click(always);
    await waitFor(() => expect(scripted.calls.some((call) => call.path === 'api/mail/image-senders')).toBe(true));
  });

  it('never draws or fetches a tracking pixel, asked for or not', async () => {
    renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened({
        text: '',
        html: '<p>Invoice 4821</p><img src="https://cdn.example.com/logo.png">'
          + '<img src="https://track.example.com/open.gif" width="1" height="1">'
          + '<img src="https://track.example.com/beacon.gif" style="display:none">',
        attachments: [],
      }),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    await waitFor(() => expect(document.querySelector('.mailhtml')?.textContent).toContain('Invoice 4821'));
    fireEvent.click(screen.getByRole('button', { name: /^Load pictures/ }));
    // One picture asked for, and the two that were never going to be seen are
    // not in the document at all — no proxy URL for them either.
    await waitFor(() => expect(drawn().length).toBe(1));
    expect(drawn()[0]).toContain('cdn.example.com');
    expect(document.body.innerHTML).not.toContain('track.example.com');
  });

  it('loads on open for a sender the reader has put on the list, and offers the way back off it', async () => {
    const scripted = renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened({
        text: '',
        html: '<p>Invoice 4821</p><img src="https://cdn.example.com/logo.png">',
        attachments: [],
        imagesAllowed: true,
      }),
      'DELETE api/mail/image-senders/ada%40example.com': () => ({ addresses: [] }),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    // No tap: the server said this reader loads pictures from this sender.
    await waitFor(() => expect(drawn().length).toBe(1));
    expect(screen.queryByRole('button', { name: /^Load pictures/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop loading pictures from ada@example.com' }));
    // The server's answer is what the letter is redrawn from, so the picture
    // goes back behind the tap on the screen it was taken off on.
    await waitFor(() => expect(drawn()).toEqual([]));
    expect(scripted.calls.some((call) => call.path === 'api/mail/image-senders/ada%40example.com')).toBe(true);
    expect(await screen.findByRole('button', { name: /^Load pictures/ })).toBeTruthy();
  });
});

describe('writing grows up: Cc, files and forwarding (slice 12)', () => {
  /** A request body the way the server reads it: the manifest, then bytes. */
  const opened12 = async (body: unknown) => {
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(body as Blob);
    });
    const bytes = new Uint8Array(buffer);
    const length = new DataView(buffer).getUint32(0);
    return {
      manifest: JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as Record<string, unknown>,
      rest: new TextDecoder().decode(bytes.subarray(4 + length)),
    };
  };
  const pick = (...files: File[]) => fireEvent.change(document.getElementById('mailFileInput')!, { target: { files } });
  const sendable = () => ({
    ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
    'GET api/mail/conversations': () => inbox(),
  });

  it('writes with a Cc line and a file, and sends both in one upload', async () => {
    const { calls } = renderAt('/mail', {
      ...sendable(),
      'POST api/mail/send': () => ({ message: {
        id: 'mm_out', direction: 'sent', to: [{ address: 'ada@example.com' }], subject: 'Figures',
        snippet: 'Attached.', receivedAt: new Date().toISOString(), files: 1,
      } }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Write email' }));
    fireEvent.change(document.getElementById('mailToField')!, { target: { value: 'ada@example.com' } });
    // No Cc box until one is asked for: most letters go to one person.
    expect(document.getElementById('mailCcField-0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Cc' }));
    fireEvent.change(document.getElementById('mailCcField-0')!, { target: { value: 'bob@example.com' } });
    expect(screen.getByRole('button', { name: 'Add another Cc' })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('What it is about'), { target: { value: 'Figures' } });
    fireEvent.change(screen.getByPlaceholderText('Write your message'), { target: { value: 'Attached.' } });
    pick(new File(['a,b\n1,2'], 'figures.csv', { type: 'text/csv' }));
    expect(await screen.findByText('figures.csv')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(calls.some((call) => call.path === 'api/mail/send')).toBe(true));
    const sent = calls.find((call) => call.path === 'api/mail/send')!;
    expect((sent.init?.headers as Record<string, string>)['Content-Type']).toBe('application/vnd.agentbuilt.mail-files');
    const { manifest, rest } = await opened12(sent.init?.body);
    expect(manifest).toEqual({
      to: 'ada@example.com', subject: 'Figures', text: 'Attached.', cc: ['bob@example.com'],
      files: [{ fileName: 'figures.csv', contentType: 'text/csv', sizeBytes: 7 }],
    });
    expect(rest).toBe('a,b\n1,2');
  });

  it('says the limit at the moment of picking, and offers no fourth Cc box', async () => {
    renderAt('/mail', sendable());
    fireEvent.click(await screen.findByRole('button', { name: 'Write email' }));
    pick(new File(['MZ'], 'setup.exe'));
    expect((await screen.findByRole('alert')).textContent).toContain('Mail cannot carry .exe files');
    expect(screen.queryByText('setup.exe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Cc' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add another Cc' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add another Cc' }));
    expect(document.getElementById('mailCcField-2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add (another )?Cc/ })).toBeNull();
  });

  it('offers Reply to all when the letter went to others, and it only fills the Cc line', async () => {
    const { calls } = renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened({ cc: [{ address: 'carol@example.com' }] }, {
        reply: { id: 'mm_1', to: { name: 'Ada Lovelace', address: 'ada@example.com' }, all: [{ address: 'carol@example.com' }] },
      }),
      'POST api/mail/messages/mm_1/reply': () => ({ reply: {
        id: 'mm_out', to: [{ name: 'Ada Lovelace', address: 'ada@example.com' }], cc: [{ address: 'carol@example.com' }],
        text: 'Thanks, both.', sentAt: new Date().toISOString(),
      } }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reply to Ada Lovelace' }));
    fireEvent.click(await screen.findByRole('button', { name: /Reply to all — also carol@example.com/ }));
    expect((document.getElementById('mailCcField-0') as HTMLInputElement).value).toBe('carol@example.com');
    expect(screen.queryByRole('button', { name: /Reply to all/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Write your reply'), { target: { value: 'Thanks, both.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'api/mail/messages/mm_1/reply')).toBe(true));
    const sent = calls.find((call) => call.path === 'api/mail/messages/mm_1/reply')!;
    // Still no To in the request: the server reads it off the letter.
    expect(JSON.parse(String(sent.init?.body))).toEqual({ text: 'Thanks, both.', cc: ['carol@example.com'] });
  });

  it('forwards a letter with its files ticked, lets one be left off, and then says under it where it went', async () => {
    const conversation = opened().conversation;
    const { calls } = renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => ({ conversation }),
      'POST api/mail/messages/mm_1/forward': () => {
        const at = new Date().toISOString();
        conversation.messages = [...conversation.messages, letter({
          id: 'mm_fwd', direction: 'sent', forwards: 'mm_1', from: { address: ADDRESS }, to: [{ address: 'bob@example.com' }],
          subject: 'Fwd: The engine', text: undefined, snippet: '', receivedAt: at, attachments: [], files: 0,
        })];
        return { message: { id: 'mm_fwd', direction: 'sent', forwards: 'mm_1', to: [{ address: 'bob@example.com' }], subject: 'Fwd: The engine', snippet: '', receivedAt: at, files: 0 } };
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Forward' }));
    expect(await screen.findByRole('heading', { name: 'Forward' })).toBeTruthy();
    const box = screen.getByRole('checkbox', { name: 'Send notes.pdf with it' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    expect(screen.getByText(/left off/)).toBeTruthy();
    fireEvent.change(document.getElementById('mailForwardTo')!, { target: { value: 'bob@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send forward' }));

    await waitFor(() => expect(calls.some((call) => call.path === 'api/mail/messages/mm_1/forward')).toBe(true));
    const sent = calls.find((call) => call.path === 'api/mail/messages/mm_1/forward')!;
    expect(JSON.parse(String(sent.init?.body))).toEqual({ to: 'bob@example.com', text: '', carry: [] });
    // Back in the conversation: the forward stands as the reader's own, and
    // the letter it forwarded says where it went.
    expect(await screen.findByText(/^Forwarded to bob@example.com on /)).toBeTruthy();
    expect(screen.getByText('Forwarded with no words of your own.')).toBeTruthy();
    expect(document.querySelector('#mailLetter-mm_fwd .mailownhead')?.textContent).toContain('Forwarded to bob@example.com');
  });

  it('draws a file the provider refuses unticked, with the reason, and offers no Forward from Trash', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened({
        attachments: [{ id: 'ma_x', fileName: 'setup.exe', contentType: 'application/octet-stream', size: 20 }],
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Forward' }));
    const box = await screen.findByRole('checkbox', { name: 'Send setup.exe with it' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/Mail cannot carry \.exe files/)).toBeTruthy();
  });

  it('offers no Forward on a conversation in Trash', async () => {
    renderAt('/mail/mm_1', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) })),
      'GET api/mail/conversations/mm_1': () => opened({ place: 'trash' }, { place: 'trash' }),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
  });

  it('names a Cc on the reader\'s own letter, and a forward as a forward', () => {
    expect(mailOwnLine({ to: [{ name: 'Ada', address: 'ada@example.com' }], cc: [{ address: 'carol@example.com' }] }, ['ada@example.com']))
      .toBe('From you to Ada, copy to carol@example.com');
    expect(mailOwnLine({ to: [{ address: 'bob@example.com' }], forwards: 'mm_1' }, ['ada@example.com']))
      .toBe('Forwarded to bob@example.com');
  });
});

describe('stars and pages (note #666)', () => {
  const withState = () => workspaceScript(() => emptyState({ org, ...account({ address: ADDRESS }) }));
  const starAnswer = (starred: boolean, over: Partial<WorkspaceMailMessageSummary> = {}): WorkspaceMailStarAnswer => ({
    conversation: row(starred ? { starred: true } : {}),
    messages: [{ ...summary, ...(starred ? { starred: true as const } : {}), ...over }],
  });

  it('stars a conversation from its row without opening it, and draws the fill the server answered', async () => {
    let starred = false;
    const { calls } = renderAt('/mail', {
      ...withState(),
      'GET api/mail/conversations': () => inbox([row(starred ? { starred: true } : {})]),
      'POST api/mail/conversations/mm_1/star': () => { starred = true; return starAnswer(true); },
      'POST api/mail/conversations/mm_1/unstar': () => { starred = false; return starAnswer(false); },
    });
    const star = await screen.findByRole('button', { name: 'Star this conversation' });
    // BESIDE the row's link, never inside it: a button in a link is a tap
    // that does two things, and no mark lands in the row's own column.
    expect(star.closest('a')).toBeNull();
    expect(star.closest('.mailrow')!.querySelector('a.crow.open')!.getAttribute('href')).toBe('/mail/mm_1');
    expect(document.querySelectorAll('#mailList .crow .icon, #mailList .crow .mailstar').length).toBe(0);
    expect(star.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(star);
    const on = await screen.findByRole('button', { name: 'Remove the star from this conversation' });
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(on.classList.contains('on')).toBe(true);
    // Still the inbox: starring opened nothing.
    expect(document.getElementById('screenMail')).toBeTruthy();
    expect(calls.some((call) => call.path === 'api/mail/conversations/mm_1/star' && call.init?.method === 'POST')).toBe(true);
    // And the held inbox wears it too, so Back never paints the old row.
    expect(heldMailPlace('inbox')!.conversations[0]!.starred).toBe(true);
    fireEvent.click(on);
    expect(await screen.findByRole('button', { name: 'Star this conversation' })).toBeTruthy();
  });

  it('offers no star in Trash or Spam, where Starred could never show it', async () => {
    renderAt('/mail/trash', {
      ...withState(),
      'GET api/mail/conversations?in=trash': () => inbox([row({ place: 'trash' })]),
    });
    await screen.findByText('The engine');
    expect(document.querySelectorAll('.mailstar').length).toBe(0);
  });

  it('lists Starred as letters, says so when it is empty, and lets a letter go the moment its star comes off', async () => {
    const starredOne = { ...summary, starred: true as const };
    const agents = { ...summary, id: 'mm_2', subject: 'Second', starred: true as const, starredBy: 'Ruby' };
    renderAt('/mail/starred', {
      ...withState(),
      'GET api/mail/messages?in=starred': () => found([agents, starredOne]),
      'POST api/mail/messages/mm_1/unstar': () => starAnswer(false),
    });
    expect(await screen.findByRole('heading', { name: 'Starred' })).toBeTruthy();
    expect(document.getElementById('screenMailStarred')).toBeTruthy();
    expect(await screen.findByText('The engine')).toBeTruthy();
    // A star an agent put there says whose it was.
    expect(screen.getByText('1 file · starred by Ruby')).toBeTruthy();
    expect((screen.getByRole('searchbox') as HTMLInputElement).placeholder).toBe('Search Starred');
    fireEvent.click(document.getElementById('mailStar-mm_1')!);
    await waitFor(() => expect(screen.queryByText('The engine')).toBeNull());
    expect(screen.getByText('Second')).toBeTruthy();
    expect(heldMailLetters({ view: 'starred' })!.messages.map((message) => message.id)).toEqual(['mm_2']);
  });

  it('says what Starred is for while nothing is in it', async () => {
    renderAt('/mail/starred', { ...withState(), 'GET api/mail/messages?in=starred': () => found([]) });
    expect(await screen.findByText(/Nothing is starred\./)).toBeTruthy();
  });

  it('stars one letter of a conversation from the line that says who wrote it, and not in Trash', async () => {
    const { calls } = renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened(),
      'POST api/mail/messages/mm_1/star': () => starAnswer(true),
    });
    const star = await screen.findByRole('button', { name: 'Star this message' });
    expect(star.closest('.mailwho')).toBeTruthy();
    fireEvent.click(star);
    expect(await screen.findByRole('button', { name: 'Remove the star from this message' })).toBeTruthy();
    expect(calls.filter((call) => call.init?.method === 'POST').map((call) => call.path)).toEqual(['api/mail/messages/mm_1/star']);
    expect(heldMailConversation('mm_1')!.messages[0]!.starred).toBe(true);
  });

  it('says a refused star where the reader is looking, and leaves the letter as it was', async () => {
    renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened(),
      'POST api/mail/messages/mm_1/star': () => { throw new WorkspaceApiError('That message is in Trash. Restore it first, then star it.', 409, {}); },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Star this message' }));
    expect(await screen.findByText('That message is in Trash. Restore it first, then star it.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Star this message' })).toBeTruthy();
  });

  it('offers no star on a letter of a conversation in Trash', async () => {
    renderAt('/mail/mm_1', {
      ...withState(),
      'GET api/mail/conversations/mm_1': () => opened({ place: 'trash' }, { place: 'trash' }),
    });
    await screen.findByRole('heading', { name: 'The engine' });
    expect(screen.queryByRole('button', { name: 'Star this message' })).toBeNull();
  });

  it('shows the next page under the first, and keeps it there when the list refreshes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const first = [row(), row({ id: 'mm_2', subject: 'Second', opens: 'mm_2' })];
      const older = [row({ id: 'mm_3', subject: 'Third, from last week', opens: 'mm_3' })];
      let refreshed = 0;
      const { calls } = renderAt('/mail', {
        ...withState(),
        'GET api/mail/conversations': () => { refreshed += 1; return { ...inbox(first), nextBefore: '41' }; },
        'GET api/mail/conversations?before=41': () => inbox(older),
      });
      await screen.findByText('Second');
      const more = screen.getByRole('button', { name: 'Show older conversations' });
      fireEvent.click(more);
      expect(await screen.findByText('Third, from last week')).toBeTruthy();
      // The last page: nothing older, so no way to ask for it.
      expect(screen.queryByRole('button', { name: 'Show older conversations' })).toBeNull();
      expect(calls.some((call) => call.path === 'api/mail/conversations?before=41')).toBe(true);
      const before = refreshed;
      await act(async () => { await vi.advanceTimersByTimeAsync(MAIL_POLL_MS + 50); });
      await waitFor(() => expect(refreshed).toBeGreaterThan(before));
      // The refresh read the first page again and kept the older one under it.
      expect(screen.getByText('Third, from last week')).toBeTruthy();
      expect([...document.querySelectorAll('#mailList .mailsubject')].map((line) => line.textContent)).toEqual(['The engine', 'Second', 'Third, from last week']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pages letters too, by the cursor the server answered', async () => {
    renderAt('/mail/sent', {
      ...withState(),
      'GET api/mail/messages?in=sent': () => ({ ...found([{ ...summary, direction: 'sent', to: [{ address: 'bob@example.com' }] }]), nextBefore: '7' }),
      'GET api/mail/messages?in=sent&before=7': () => found([{ ...summary, id: 'mm_0', subject: 'The first one', direction: 'sent', to: [{ address: 'bob@example.com' }] }]),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Show older messages' }));
    expect(await screen.findByText('The first one')).toBeTruthy();
  });

  it('keeps the pages a refresh cannot place, and starts again when it cannot', () => {
    const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' }, d = { id: 'd' }, n = { id: 'n' };
    // Nothing older on the server: the first page is the whole list.
    expect(mailPageKept({ rows: [a, b] }, { rows: [a, b, c], nextBefore: '9' })).toEqual({ rows: [a, b] });
    // One page held: the fresh one replaces it.
    expect(mailPageKept({ rows: [a, b], nextBefore: '5' }, { rows: [a, b], nextBefore: '5' })).toEqual({ rows: [a, b], nextBefore: '5' });
    // A new letter pushed the first page down by one: what the held list had
    // after the fresh page's last row stays, with the cursor it had.
    expect(mailPageKept({ rows: [n, a], nextBefore: '6' }, { rows: [a, b, c, d], nextBefore: '2' }))
      .toEqual({ rows: [n, a, b, c, d], nextBefore: '2' });
    // Never twice.
    expect(mailPageKept({ rows: [b, a], nextBefore: '6' }, { rows: [a, b, c], nextBefore: '2' }))
      .toEqual({ rows: [b, a, c], nextBefore: '2' });
    // The fresh page's last row is nowhere in the held list: start again.
    expect(mailPageKept({ rows: [n], nextBefore: '6' }, { rows: [a, b, c], nextBefore: '2' })).toEqual({ rows: [n], nextBefore: '6' });
  });

  it('keeps every held list agreeing with a star, Starred included', () => {
    holdMailPlace(inbox([row(), row({ id: 'mm_2', opens: 'mm_2' })]), 'inbox');
    holdMailLetters(found([{ ...summary, id: 'mm_9', subject: 'Older star', starred: true, receivedAt: '2026-01-01T00:00:00.000Z' }]), { view: 'starred' });
    holdMailLetters(found([summary]), { view: 'all', search: 'engine' });
    holdMailConversation(conversationOf());
    mailStarChanged(starAnswer(true, { starredBy: 'Ruby' }));
    expect(heldMailPlace('inbox')!.conversations.map((one) => Boolean(one.starred))).toEqual([true, false]);
    // It joins Starred in its turn, newest first.
    expect(heldMailLetters({ view: 'starred' })!.messages.map((one) => one.id)).toEqual(['mm_1', 'mm_9']);
    expect(heldMailLetters({ view: 'all', search: 'engine' })!.messages[0]).toMatchObject({ starred: true, starredBy: 'Ruby' });
    expect(heldMailConversation('mm_1')).toMatchObject({ starred: true, messages: [{ starred: true, starredBy: 'Ruby' }] });
    mailStarChanged(starAnswer(false));
    expect(heldMailLetters({ view: 'starred' })!.messages.map((one) => one.id)).toEqual(['mm_9']);
    expect(heldMailLetters({ view: 'all', search: 'engine' })!.messages[0]).not.toHaveProperty('starred');
    expect(heldMailLetters({ view: 'all', search: 'engine' })!.messages[0]).not.toHaveProperty('starredBy');
    expect(heldMailPlace('inbox')!.conversations[0]).not.toHaveProperty('starred');
  });

  it('asks for a page by the cursor, and a starred list by its name', () => {
    expect(mailConversationsPath('inbox', '41')).toBe('api/mail/conversations?before=41');
    expect(mailConversationsPath('archive', '41')).toBe('api/mail/conversations?in=archive&before=41');
    expect(mailListPath({ view: 'starred' })).toBe('api/mail/messages?in=starred');
    expect(mailListPath({ view: 'starred', search: 'invoice' }, '3')).toBe('api/mail/messages?in=starred&q=invoice&before=3');
  });
});
