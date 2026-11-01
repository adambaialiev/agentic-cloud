import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, type InitialEntry } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceChatAnswer, WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { WorkspaceApiError } from '../../api/client.js';
import {
  agent, chatMessage, chatScript, emptyState, homeShelf, noteRecord, pickerPage, scriptedApi, versionAnswer, workspaceScript,
  type Answer,
} from '../../test/fixtures.js';
import { WAIT_QUIET_MS } from '../../ui/wait.js';
import { LIVE_POLL_MS } from '../../workspace/WorkspaceProvider.js';
import { MANAGED_JOB_POLL_MS } from '../jobs/useManagedJobs.js';
import { CHAT_TOUCH_QUERY } from './chat-compose.js';
import { CHAT_POLL_MS, CHAT_STARTERS } from './ChatScreen.js';
import { OUTBOX_UNSURE_GRACE_MS, OUTBOX_UNSURE_REASON } from './outbox.js';

/**
 * The agent chat, end to end against a scripted API — the transcript and its
 * roles, the composer and its attachments, Stop, the pinned header and its
 * pickers, and the one Back exception in the navigation model. The same
 * things the legacy page's grab()-based chat tests hold it to.
 */

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };
const felix = () => agent({ id: 'felix', name: 'Felix', model: 'Opus', effort: 'high' });
const state = (over: Partial<WorkspaceStateAnswer> = {}) =>
  emptyState({ org, agents: [felix()], ...over });

function open(
  chat: () => WorkspaceChatAnswer,
  extra: Record<string, Answer> = {},
  /** Entries rather than paths, so a test can open the chat on an entry it
   *  has put its own state on. */
  entries: InitialEntry[] = ['/chat/felix'],
  /** The fleet as this run's state read answers it — what the wait knows
   *  about the agent before its transcript has said anything (note #309). */
  world: () => WorkspaceStateAnswer = () => state(),
) {
  const scripted = scriptedApi({
    ...workspaceScript(world),
    ...chatScript('felix', chat),
    'GET api/agents/felix/jobs': () => ({ jobs: [] }),
    ...extra,
  });
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <App api={scripted.api} />
    </MemoryRouter>,
  );
  return scripted;
}

const head = () => screen.findByRole('heading', { name: 'Felix' });
const log = () => document.getElementById('agentChatLog')!;
/** Every file the screen hands the browser to save (note #552): the anchor
 *  it clicks, by href and download name. jsdom would otherwise try to
 *  navigate on the click and say so on stderr. */
const savedFiles = () => {
  const list: { href: string; download: string }[] = [];
  const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    list.push({ href: this.getAttribute('href') ?? '', download: this.download });
  });
  return { list, restore: () => spy.mockRestore() };
};
const rows = () => [...log().querySelectorAll('.chatmsg')];

/** A window a finger drives — the one reading that keeps Enter as the newline
 *  key (note #291). jsdom's own `matchMedia` matches nothing, so a test that
 *  does not call this is at a desk, exactly as a browser with no pointing
 *  device is. */
function onAPhone() {
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: media === CHAT_TOUCH_QUERY,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/** An open chat whose send route records what it was given. */
async function composerPosting(sent: unknown[]) {
  open(() => ({ messages: [], working: false }), {
    'POST api/agents/felix/chat': (call) => {
      sent.push(JSON.parse(String(call.init?.body)));
      return { ok: true, name: 'Felix', steered: false };
    },
  });
  await head();
  return { box: document.getElementById('agentChatText') as HTMLTextAreaElement };
}

// The phone that moves its own page is remembered across visits on purpose
// (KEYBOARD_PHONE_KEY); between tests it must not be.
afterEach(() => { vi.useRealTimers(); localStorage.removeItem('chat-keyboard-phone'); });

describe('the pinned header', () => {
  it('names who is answering and with what, and stands in for the persistent one', async () => {
    open(() => ({ messages: [], working: false }));
    await head();
    // The chat pins its own identity header, so the persistent navigation bar
    // steps aside (note #188).
    expect(document.getElementById('pageHead')).toBeNull();
    expect(document.querySelector('.chathead .back')).toBeTruthy();
    expect(document.getElementById('chatHome')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
    expect(document.getElementById('agentChatStatus')!.textContent).toBe('Claude Code · Opus · high');
    expect(document.getElementById('agentChatStatus')!.getAttribute('aria-label'))
      .toBe('Change model and effort. Current: Claude Code · Opus · high');
  });

  /**
   * Note #439: the header is the only place a conversation names the agent,
   * and it went nowhere — the way to the agent's own screen was Back and a
   * guess about what was underneath. The name is the door; the face is the
   * same door, out of the reading order so it is not announced twice.
   */
  it('opens the agent\'s own screen from the identity in the header', async () => {
    open(() => ({ messages: [], working: false }));
    await head();
    const face = document.getElementById('agentChatFace')!;
    expect(face.tagName).toBe('A');
    expect(face.getAttribute('href')).toBe('/agents/felix');
    expect(face.getAttribute('aria-hidden')).toBe('true');
    const door = screen.getByRole('link', { name: 'Felix: open agent details' });
    expect(door.getAttribute('href')).toBe('/agents/felix');
    expect(door.contains(document.getElementById('agentChatTitle'))).toBe(true);
    fireEvent.click(door);
    await waitFor(() => expect(document.getElementById('screenAgent')).toBeTruthy());
  });

  /**
   * Note #657 put the room the agent works in on the name line, inside the
   * same door, until rooms left the product (note #843). An older state that
   * still names the agent's room draws none.
   */
  it('names no room beside the agent\'s name, whatever room an older state names', async () => {
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix'], () => state({
      agents: [agent({ id: 'felix', name: 'Felix' })],
    }));
    await head();
    expect(document.getElementById('agentChatRoom')).toBeNull();
    expect(screen.queryByText('Math school')).toBeNull();
    expect(screen.getByRole('link', { name: 'Felix: open agent details' })).toBeTruthy();
  });

  it('wears the context fill the transcript read carried, not a second request', async () => {
    open(() => ({ messages: [], working: false, context: { usedPercent: 94, tokens: 1, window: 2, at: 't' } }));
    await head();
    await waitFor(() => expect(document.querySelector('#agentChatFace .ctxring.hot')).toBeTruthy());
    expect(document.querySelector('#agentChatFace .ctxring')!.getAttribute('aria-label'))
      .toBe('Context window 94% full');
  });

  it('summarizes active background jobs in one quiet door and opens their exact descriptions', async () => {
    const jobs = [
      { id: 'j_111111111111111111111111', label: 'npm run build:workspace-ui', startedAt: '2026-09-18T10:00:00Z' },
      { id: 'j_222222222222222222222222', label: 'node scripts/render.mjs', startedAt: '2026-09-18T10:01:00Z' },
    ];
    open(() => ({ messages: [], working: false }), {
      'GET api/agents/felix/jobs': () => ({ jobs }),
    });
    const door = await screen.findByRole('button', { name: '2 background jobs. Open details' });
    expect(door.textContent).toBe('2 background jobs');
    expect(door.querySelector('.chatjobdot')).toBeTruthy();
    expect(door.querySelector('svg')).toBeTruthy();
    expect(door.querySelector('.chatjob')).toBeNull();
    expect(door.parentElement?.previousElementSibling?.classList.contains('chathead')).toBe(true);
    expect(door.parentElement?.nextElementSibling?.classList.contains('chatpane')).toBe(true);

    fireEvent.click(door);
    await screen.findByRole('heading', { name: 'Background jobs' });
    expect(document.getElementById('screenAgentJobs')).toBeTruthy();
    expect([...document.querySelectorAll('.jobcommand')].map((row) => row.textContent)).toEqual([
      'npm run build:workspace-ui',
      'node scripts/render.mjs',
    ]);
    expect(document.getElementById('agentJobsList')!.textContent).toContain('j_111111111111111111111111');
    expect(document.getElementById('agentJobsList')!.textContent).toContain('j_222222222222222222222222');
    fireEvent.click(document.getElementById('pageBack')!);
    await waitFor(() => expect(document.getElementById('screenAgentChat')).toBeTruthy());
  });

  it('uses singular grammar and removes the subheader when the last job finishes', async () => {
    vi.useFakeTimers();
    let jobs = [
      { id: 'j_111111111111111111111111', label: 'npm run build:workspace-ui', startedAt: '2026-09-18T10:00:00Z' },
    ];
    open(() => ({ messages: [], working: false }), {
      'GET api/agents/felix/jobs': () => ({ jobs }),
    });
    await act(async () => { await Promise.resolve(); });

    const strip = document.getElementById('agentChatJobs')!;
    expect(strip.textContent).toBe('1 background job');
    expect(strip.getAttribute('aria-label')).toBe('1 background job. Open details');

    jobs = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(MANAGED_JOB_POLL_MS); });
    expect(document.getElementById('agentChatJobs')).toBeNull();
  });

  it('does not reserve a second header row when there are no background jobs', async () => {
    open(() => ({ messages: [], working: false }));
    await head();
    await waitFor(() => expect(document.querySelector('.chatpane')).toBeTruthy());
    expect(document.getElementById('agentChatJobs')).toBeNull();
  });

  it('pauses background-job polling while the page is hidden and catches up when shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const active = [{
      id: 'j_111111111111111111111111',
      label: 'npm run build',
      startedAt: '2026-09-18T10:00:00Z',
    }];
    const scripted = open(() => ({ messages: [], working: false }), {
      'GET api/agents/felix/jobs': () => ({ jobs: active }),
    });
    const reads = () => scripted.calls.filter((call) => call.path === 'api/agents/felix/jobs').length;
    await waitFor(() => expect(reads()).toBe(1));

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(MANAGED_JOB_POLL_MS * 3); });
    expect(reads()).toBe(1);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(reads()).toBe(2));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });
});

describe('an empty conversation (note #188)', () => {
  it('offers three first jobs, and a tap sends one as it stands', async () => {
    const sent: unknown[] = [];
    await composerPosting(sent);
    const starters = await waitFor(() => {
      const found = [...document.querySelectorAll('#chatStarters .chatstarter')];
      expect(found).toHaveLength(3);
      return found;
    });
    expect(starters.map((node) => node.textContent)).toEqual([...CHAT_STARTERS]);
    expect(log().textContent).toContain('Nothing here yet — say hello.');
    fireEvent.click(starters[0]!);
    await waitFor(() => expect(sent).toEqual([{ message: CHAT_STARTERS[0] }]));
  });

  it('offers none once the conversation holds a message', async () => {
    open(() => ({ messages: [chatMessage({ seq: 1, role: 'owner', text: 'hi' })], working: false }));
    await head();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(document.getElementById('chatStarters')).toBeNull();
  });
});

describe('the transcript', () => {
  it('presents each role safely and in its own shape', async () => {
    open(() => ({
      messages: [
        chatMessage({ seq: 1, role: 'owner', text: '**not** markdown' }),
        chatMessage({ seq: 2, role: 'agent', text: '**Done** — see `x`.' }),
        chatMessage({ seq: 3, role: 'platform', text: '[Platform] Message from agent Oscar: rebased', fromAvatarUrl: '/faces/oscar.png' }),
        chatMessage({ seq: 4, role: 'platform', text: 'Turn stopped by the user.' }),
        chatMessage({ seq: 5, role: 'platform', kind: 'new-chat-divider', text: 'Fresh chat' }),
      ],
      working: false,
    }));
    await head();
    await waitFor(() => expect(rows()).toHaveLength(5));
    const [owner, reply, peer, notice, divider] = rows();
    // The owner's own words are preserved exactly as typed.
    expect(owner!.className).toContain('chatmsg owner');
    expect(owner!.textContent).toBe('**not** markdown');
    expect(owner!.querySelector('strong')).toBeNull();
    // Agents write Markdown, through the renderer that builds elements.
    expect(reply!.className).toContain('chatmsg agent');
    expect(reply!.querySelector('.chatmarkdown strong')!.textContent).toBe('Done');
    // A peer is a third person SPEAKING, so it wears the bubble and a name —
    // never the receipt card (note #183).
    expect(peer!.className).toContain('chatmsg peer');
    expect(peer!.querySelector('.chatfrom')!.textContent).toBe('Oscar');
    expect((peer!.querySelector('.chatfrom img.face') as HTMLImageElement).getAttribute('src')).toBe('/faces/oscar.png');
    expect(peer!.querySelector('.chatnotice')).toBeNull();
    // A platform event the reader CAUSED is one quiet line, not a receipt
    // card with a chip on it (note #384).
    expect(notice!.className).toContain('chatmsg chatquiet');
    expect(notice!.textContent).toBe('You stopped this turn');
    expect(notice!.querySelector('.chatnotice')).toBeNull();
    expect(notice!.querySelector('.badge')).toBeNull();
    // The fresh-chat marker is punctuation, not an event.
    expect(divider!.className).toContain('newchatdivider');
    expect(divider!.querySelector('.chatnotice')).toBeNull();
  });

  it('leaves the bubble to the reader and puts the platform’s narration in the margin', async () => {
    open(() => ({
      messages: [
        chatMessage({ seq: 1, role: 'owner', text: 'how is it going' }),
        chatMessage({ seq: 2, role: 'agent', text: 'Two files left.' }),
        chatMessage({ seq: 3, role: 'platform', text: '[Platform] Message from agent Oscar: rebased' }),
        chatMessage({ seq: 4, role: 'platform', text: 'Sent to Alex: reread the note and start again.' }),
        chatMessage({
          seq: 5, role: 'platform',
          text: 'Knowledge proposal #7 ("Rooms") awaits your decision — Update one page. Nothing changes until you approve.',
          open: { kp: 'k1' },
        }),
      ],
      working: false,
    }));
    await head();
    await waitFor(() => expect(rows()).toHaveLength(5));
    const [owner, reply, peer, narration, ask] = rows();
    // Note #481. Every agent speaking here — this one and any other — gives
    // up the balloon, and the reader keeps the only one in the column.
    expect(reply!.classList.contains('flat')).toBe(true);
    expect(peer!.classList.contains('flat')).toBe(true);
    expect(owner!.classList.contains('flat')).toBe(false);
    // A receipt no recogniser claimed is the platform narrating what it did
    // on the reader's behalf, and annotates from the margin…
    expect(narration!.className).toContain('chatmsg platform aside');
    expect(narration!.querySelector('.chatnoticetitle')!.textContent)
      .toContain('Sent to Alex: reread the note and start again.');
    // …while a frame is kept for what the reader has to DECIDE.
    expect(ask!.className).toContain('chatmsg platform');
    expect(ask!.classList.contains('aside')).toBe(false);
  });

  it('decides agent-authored email inside the chat, over the exact message', async () => {
    const approval = {
      id: 'ma_1', kind: 'send' as const, from: { name: 'Saddam', address: 'saddam@agenticcloudcomputer.com' },
      to: { name: 'Ada Lovelace', address: 'ada@example.com' }, subject: 'Tuesday',
      text: 'Are you free at four?\nI can bring the notes.', requestedBy: 'Felix',
      status: 'pending' as const, createdAt: '2026-09-16T10:00:00.000Z',
    };
    const scripted = open(() => ({
      messages: [chatMessage({
        seq: 1, role: 'platform', text: 'Felix wants to send email.',
        mailApprovalId: approval.id, mailApproval: approval,
      })],
      working: false,
    }), {
      'POST api/mail/approvals/ma_1/decision': () => ({
        approval: { ...approval, status: 'sent', decidedAt: '2026-09-16T10:01:00.000Z', sentMessageId: 'mm_1' },
      }),
    });
    await head();
    const card = await waitFor(() => {
      const node = document.querySelector('[data-mail-approval="ma_1"]');
      expect(node).toBeTruthy();
      return node!;
    });
    expect(card.textContent).toContain('Felix wants to send this message');
    expect(card.textContent).toContain('saddam@agenticcloudcomputer.com');
    expect(card.textContent).toContain('Ada Lovelace <ada@example.com>');
    expect(card.textContent).toContain('Tuesday');
    expect(card.textContent).toContain('Are you free at four?');
    expect(card.querySelectorAll('a')).toHaveLength(0);
    // Note #530: no envelope beside the eyebrow, and the letter itself stands
    // in its own box — the whole body, nothing but the body.
    expect(card.querySelector('.chatnoticeicon')).toBeNull();
    expect(card.querySelector('.icon')).toBeNull();
    expect(card.querySelector('.mailapprovaltext')?.textContent).toBe('Are you free at four?\nI can bring the notes.');
    expect(screen.getByRole('button', { name: 'Send email' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Don’t send' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Send email' }));
    await screen.findByText('Sent to ada@example.com.');
    expect(scripted.calls.find((call) => call.path === 'api/mail/approvals/ma_1/decision')?.init)
      .toMatchObject({ method: 'POST' });
    const posted = scripted.calls.find((call) => call.path === 'api/mail/approvals/ma_1/decision')!;
    expect(JSON.parse(String(posted.init?.body))).toEqual({ decision: 'approve' });
    expect(screen.queryByRole('button', { name: 'Send email' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Don’t send' })).toBeNull();
  });

  it('lists everybody an agent\'s forward reaches and every file that leaves with it (slice 12)', async () => {
    const approval = {
      id: 'ma_2', kind: 'forward' as const, from: { address: 'saddam@agenticcloudcomputer.com' },
      to: { address: 'bob@example.com' }, cc: [{ address: 'carol@example.com' }, { address: 'dan@example.com' }],
      subject: 'Fwd: The brief', text: 'For you.\n\n---------- Forwarded message ---------\nFrom: Priya', requestedBy: 'Felix',
      attachments: [
        { fileName: 'brief.pdf', size: 2_400_000, contentType: 'application/pdf' },
        { fileName: 'notes.txt', size: 512, contentType: 'text/plain' },
      ],
      status: 'pending' as const, createdAt: '2026-09-23T10:00:00.000Z',
    };
    open(() => ({
      messages: [chatMessage({ seq: 1, role: 'platform', text: 'Felix wants to forward a letter.', mailApprovalId: approval.id, mailApproval: approval })],
      working: false,
    }));
    await head();
    const card = await waitFor(() => {
      const node = document.querySelector('[data-mail-approval="ma_2"]');
      expect(node).toBeTruthy();
      return node!;
    });
    expect(card.textContent).toContain('Felix wants to forward this letter');
    const facts = [...card.querySelectorAll('.mailapprovalfacts > div')].map((row) => row.textContent);
    expect(facts).toContain('Cccarol@example.com, dan@example.com');
    const files = [...card.querySelectorAll('.mailapprovalfiles li')].map((item) => item.textContent);
    expect(files).toEqual(['brief.pdf 2.3 MB', 'notes.txt 512 B']);
  });

  it('opens a registered Workspace link from an ordinary agent reply and leaves an unknown path as text', async () => {
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'agent',
        text: '[Read the reason](/notes/470?org=o1&room=r1) and [leave here](/not-a-route).',
      })],
      working: false,
    }), { 'GET api/notes/470': () => ({ note: noteRecord({ number: 470, title: 'Why the link was plain text' }) }) });
    await head();
    const reply = await waitFor(() => {
      const node = log().querySelector('.chatmsg.agent');
      expect(node).toBeTruthy();
      return node!;
    });
    const links = [...reply.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]!.textContent).toBe('Read the reason');
    // At the note's own address: the workplace kept, the room an older link
    // still names dropped (note #843).
    expect(links[0]!.getAttribute('href')).toBe('/notes/470?org=o1');
    expect(reply.textContent).toContain('[leave here](/not-a-route)');
    fireEvent.click(links[0]!);
    await waitFor(() => expect(document.getElementById('screenNote')).toBeTruthy());
  });

  it('makes a peer’s face the door onto that agent, and leaves an unknown name a picture', async () => {
    const oscar = agent({ id: 'oscar', name: 'Oscar' });
    open(() => ({
      messages: [
        chatMessage({ seq: 1, role: 'platform', text: '[Platform] Message from agent Oscar: rebased', fromAvatarUrl: '/faces/oscar.png' }),
        chatMessage({ seq: 2, role: 'platform', text: '[Platform] Message from agent Ghost: gone since', fromAvatarUrl: '/faces/ghost.png' }),
      ],
      working: false,
    }), {}, ['/chat/felix'], () => state({ agents: [felix(), oscar] }));
    await head();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const [known, unknown] = rows();
    // The fleet has an Oscar, so his face is the way to him (note #353).
    const door = known!.querySelector('.chatfrom a.facebtn')!;
    expect(door.getAttribute('href')).toBe('/agents/oscar');
    expect(door.getAttribute('aria-label')).toBe('Open Oscar');
    expect(door.querySelector('img.face')!.getAttribute('src')).toBe('/faces/oscar.png');
    // The name beside it stays words. Note #339 took the affordance off it.
    expect(known!.querySelector('.chatfrom')!.textContent).toBe('Oscar');
    // Nobody in the fleet is Ghost: the picture stands exactly as it did.
    expect(unknown!.querySelector('.chatfrom a')).toBeNull();
    expect(unknown!.querySelector('.chatfrom img.face')!.getAttribute('src')).toBe('/faces/ghost.png');
  });

  it('a receipt that names a proposal is a real button and opens it', async () => {
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'platform',
        text: 'Your user APPROVED PR #12 ("Move Home") in infinite-agents: slice-2 is merged into main.\n',
        open: { pr: 'p1' },
      })],
      working: false,
    }), { 'GET api/prs/p1': () => { throw new WorkspaceApiError('gone', 404, {}); } });
    await head();
    const card = await waitFor(() => {
      const node = log().querySelector('.chatmsg.platform');
      expect(node).toBeTruthy();
      return node!;
    });
    // A door on a card is a real <button>: the pressed state, Enter and Space
    // all arrive with the tag (note #159).
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute('aria-label')).toBe('See what changed: Move Home');
    expect(card.querySelector('.chatnoticedoor')!.textContent).toBe('See what changed');
    fireEvent.click(card);
    // The proposal's own screen is behind the door, at the registered address.
    await waitFor(() => expect(document.getElementById('screenPr')).toBeTruthy());
  });

  it('draws knowledge proposal states as plain coloured words on the compact receipt', async () => {
    open(() => ({
      messages: [
        chatMessage({
          seq: 1, role: 'platform',
          text: 'Knowledge proposal #7 ("Rooms") awaits your decision — Update one page. Nothing changes until you approve.',
          open: { kp: 'k1' },
        }),
        chatMessage({
          seq: 2, role: 'platform',
          text: 'Your user APPROVED knowledge proposal #8 ("Deploys").',
          open: { kp: 'k2' },
        }),
        chatMessage({
          seq: 3, role: 'platform',
          text: 'Your user REJECTED knowledge proposal #9 ("Machines"). They said: "not yet".',
          open: { kp: 'k3' },
        }),
      ],
      working: false,
    }));
    await head();
    const cards = await waitFor(() => {
      const found = [...log().querySelectorAll('.chatmsg.platform.knowledge')];
      expect(found).toHaveLength(3);
      return found;
    });
    expect(cards.map((card) => card.querySelector('.chatnoticestatus')?.textContent))
      .toEqual(['Awaiting approval', 'Live', 'Rejected']);
    expect(cards.every((card) => card.querySelector('.chatnoticeicon') === null)).toBe(true);
    expect(cards.every((card) => card.querySelector('.badge') === null)).toBe(true);
    expect(cards[0]!.querySelector('.chatnoticestatus')!.classList.contains('act')).toBe(true);
    expect(cards[1]!.querySelector('.chatnoticestatus')!.classList.contains('ok')).toBe(true);
    expect(cards[2]!.querySelector('.chatnoticestatus')!.classList.contains('danger')).toBe(true);
  });

  it('a note the words name is a door to it, wherever the words came from', async () => {
    open(() => ({
      messages: [
        chatMessage({ seq: 1, role: 'owner', text: 'pick up the note #284' }),
        chatMessage({ seq: 2, role: 'agent', text: 'On it. That is the other half of PR #560.' }),
        chatMessage({ seq: 3, role: 'agent', text: 'Landed: **note #284** and note #263 with it.' }),
      ],
      working: false,
    }));
    await head();
    const links = await waitFor(() => {
      const found = [...log().querySelectorAll('a.noteref')];
      expect(found.length).toBe(3);
      return found;
    });
    expect(links.map((link) => link.textContent)).toEqual(['note #284', 'note #284', 'note #263']);
    // The reader's own words are still exactly the words they typed.
    expect(rows()[0]!.textContent).toBe('pick up the note #284');
    // A proposal number is not a note and never becomes one.
    expect(log().textContent).toContain('PR #560');
    // The workplace's note: the address names the workplace, and no room
    // since rooms left the product (note #843).
    expect(links[0]!.getAttribute('href')).toBe('/notes/284?org=o1');
  });

  it('a receipt that picks a note up opens that note', async () => {
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'platform',
        text: 'Fresh conversation. You reset the previous one yourself and left this handoff for exactly '
          + 'this moment: pick up note #284, the token is sk-xyz.\n\nThis is your own note, addressed to you.',
      })],
      working: false,
    }), { 'GET api/notes/284': () => ({ note: noteRecord({ number: 284, title: 'each note should be a link' }) }) });
    await head();
    const line = await waitFor(() => {
      const node = log().querySelector('.chatmsg.chatquiet');
      expect(node).toBeTruthy();
      return node!;
    });
    // Note #394. The receipt is a quiet line now, so the door is the anchor
    // inside its sentence — the same one a note gets in any other message —
    // rather than a card the whole row is a button for. The sentence still
    // reads whole, and the handoff's own words never reach the screen.
    expect(line.textContent).toBe('Picking up note #284');
    expect(log().querySelector('.chatmsg.platform')).toBeNull();
    expect(log().querySelector('.chatnotice')).toBeNull();
    expect(log().textContent).not.toContain('sk-xyz');
    const door = line.querySelector('a.noteref')!;
    expect(door.textContent).toBe('note #284');
    fireEvent.click(door);
    await waitFor(() => expect(document.getElementById('screenNote')).toBeTruthy());
  });

  it('a receipt with nothing behind it stays inert', async () => {
    open(() => ({
      messages: [
        chatMessage({ seq: 1, role: 'platform', text: 'Your user DELETED the site shop.' }),
        // And a quiet line is inert by its nature (note #384).
        chatMessage({ seq: 2, role: 'platform', text: 'Turn stopped by the user.' }),
      ],
      working: false,
    }));
    await head();
    await waitFor(() => expect(log().querySelector('.chatmsg.platform')).toBeTruthy());
    expect(log().querySelector('.chatmsg.platform')!.tagName).toBe('DIV');
    expect(log().querySelector('.chatnoticedoor')).toBeNull();
    expect(log().querySelector('.chatmsg.chatquiet')!.tagName).toBe('DIV');
  });

  it('draws a generic receipt without a robot or Platform eyebrow', async () => {
    open(() => ({
      messages: [chatMessage({ seq: 1, role: 'platform', text: 'Something new happened. More detail.' })],
      working: false,
    }));
    await head();
    const receipt = await waitFor(() => {
      const node = log().querySelector('.chatmsg.platform');
      expect(node).toBeTruthy();
      return node!;
    });
    expect(receipt.querySelector('.chatnoticeicon')).toBeNull();
    expect(receipt.querySelector('.chatnoticelabel')).toBeNull();
    expect(receipt.querySelector('.chatnoticehead')).toBeNull();
    expect(receipt.querySelector('.chatnoticeplaintitle > .chatnoticetime')).toBeTruthy();
    expect(receipt.textContent).toContain('Something new happened.');
    expect(receipt.textContent).toContain('More detail.');
    expect(receipt.textContent).not.toContain('Platform');
  });

  it('stands a divider before the first message of each day', async () => {
    open(() => ({
      messages: [
        chatMessage({ seq: 1, at: '2026-09-01T10:00:00Z' }),
        chatMessage({ seq: 2, at: '2026-09-01T11:00:00Z' }),
        chatMessage({ seq: 3, at: '2026-09-02T09:00:00Z' }),
      ],
      working: false,
    }));
    await head();
    await waitFor(() => expect(log().querySelectorAll('.chatday')).toHaveLength(2));
  });

  it('says so honestly when there is nothing here yet', async () => {
    open(() => ({ messages: [], working: false }));
    await head();
    expect((await screen.findByText('Answers land here.'))).toBeTruthy();
  });

  it('appends only what is new on each poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer: WorkspaceChatAnswer = { messages: [chatMessage({ seq: 1, text: 'first' })], working: false };
    open(() => answer);
    await head();
    await waitFor(() => expect(rows()).toHaveLength(1));
    // A poll's rows are news landing in a watched conversation, so they rise.
    answer = { messages: [chatMessage({ seq: 2, text: 'second' })], working: false };
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_POLL_MS + 50); });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[1]!.className).toContain('arriving');
    expect(rows()[0]!.className).not.toContain('arriving');
    // …and a repeat of the same rows changes nothing.
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_POLL_MS + 50); });
    await waitFor(() => expect(rows()).toHaveLength(2));
  });
});

describe('files on a message', () => {
  it('draws the caption in its own bubble with the files under it', async () => {
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'owner',
        text: 'here they are',
        files: [
          { id: 'f1', fileName: 'shot.png', contentType: 'image/png', sizeBytes: 2048 },
          { id: 'f2', fileName: 'notes.zip', contentType: 'application/zip', sizeBytes: 512 },
        ],
      })],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/f1?preview=1': () => ({ url: 'blob:pic' }),
    });
    await head();
    const row = await waitFor(() => {
      const node = log().querySelector('.chatmsg.chatfile');
      expect(node).toBeTruthy();
      return node! as HTMLElement;
    });
    // The words first, in a bubble of their own, and the files under it
    // standing outside that bubble (note #160).
    expect(row.querySelector('.chatfilecaption')!.textContent).toBe('here they are');
    // The clock goes with the words, which are now the message's last line.
    expect(row.querySelector('.chatfilecaption')!.getAttribute('data-time')).toBeTruthy();
    expect(row.getAttribute('data-time')).toBeNull();
    const items = [...row.querySelectorAll('.chatfileitem')];
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('shot.png · 2 KB');
    // A picture is part of the message, so it is seen and not merely named.
    const picture = await waitFor(() => {
      const node = items[0]!.querySelector('img');
      expect(node).toBeTruthy();
      return node!;
    });
    // …and a file that is not a picture is only named.
    expect(items[1]!.querySelector('img')).toBeNull();
    // The label says what the tap will DO, which is only "full screen" once
    // there is a picture on the row to open (note #294); before that a tap
    // saves the file, and says so (note #552).
    expect(items[0]!.getAttribute('aria-label')).toBe('Download shot.png');
    fireEvent.load(picture);
    await waitFor(() => expect(items[0]!.getAttribute('aria-label')).toBe('Open shot.png full screen'));
    // A file that is only ever saved says so (note #552): in its name, and
    // with the download mark at its right edge — which a picture's row, a
    // caption under something drawn, never wears.
    expect(items[1]!.getAttribute('aria-label')).toBe('Download notes.zip');
    expect(items[1]!.querySelector('.chatfileline .chatsave')).not.toBeNull();
    expect(items[0]!.querySelector('.chatfileline .chatsave')).toBeNull();
  });

  /**
   * Note #294: a picture in the transcript opens where every other picture in
   * the Workspace opens — the shared full-screen viewer — and the message's
   * other pictures are its gallery. Anything else still leaves for the
   * browser's own handler, which is where a file's Download lives.
   */
  it('opens a picture full screen, with the message’s others as its gallery', async () => {
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'owner',
        text: 'both of these',
        files: [
          { id: 'f1', fileName: 'one.png', contentType: 'image/png', sizeBytes: 2048 },
          { id: 'f2', fileName: 'two.png', contentType: 'image/png', sizeBytes: 4096 },
        ],
      })],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/f1?preview=1': () => ({ url: 'blob:one' }),
      'GET api/agents/felix/chat/files/f2?preview=1': () => ({ url: 'blob:two' }),
    });
    await head();
    const items = await waitFor(() => {
      const nodes = [...log().querySelectorAll('.chatfileitem')];
      expect(nodes).toHaveLength(2);
      nodes.forEach((node) => expect(node.querySelector('img')).toBeTruthy());
      return nodes as HTMLElement[];
    });
    // Only a picture the reader can SEE is one the viewer can show, so the
    // gallery is built from the ones that painted.
    for (const node of items) fireEvent.load(node.querySelector('img')!);

    fireEvent.click(items[1]!);
    const viewer = await screen.findByRole('dialog');
    expect(viewer.id).toBe('imageViewer');
    // Opened ON the picture that was tapped, not on the first of them.
    expect(document.getElementById('imageViewerName')!.textContent).toBe('two.png');
    expect((document.getElementById('imageViewerImage') as HTMLImageElement).getAttribute('src')).toBe('blob:two');
    expect(document.getElementById('imageViewerCount')!.textContent).toBe('2 of 2');
    // …and the other picture on the message is one step away.
    fireEvent.click(document.getElementById('imageViewerPrev')!);
    await waitFor(() => expect(document.getElementById('imageViewerName')!.textContent).toBe('one.png'));
  });

  /**
   * Note #544: the gallery is the whole conversation, not the one message.
   * The screenshot two messages up is one step away, in the order it was
   * said, and a picture that was never painted is not a slide.
   */
  it('steps through every painted picture in the conversation, in order', async () => {
    open(() => ({
      messages: [
        chatMessage({ seq: 1, role: 'agent', text: 'first', files: [{ id: 'a1', fileName: 'one.png', contentType: 'image/png', sizeBytes: 1 }] }),
        chatMessage({ seq: 2, role: 'owner', text: 'a note', files: [{ id: 'b1', fileName: 'notes.zip', contentType: 'application/zip', sizeBytes: 1 }] }),
        chatMessage({
          seq: 3,
          role: 'agent',
          text: 'two more',
          files: [
            { id: 'c1', fileName: 'two.png', contentType: 'image/png', sizeBytes: 1 },
            { id: 'c2', fileName: 'three.png', contentType: 'image/png', sizeBytes: 1 },
          ],
        }),
        chatMessage({ seq: 4, role: 'agent', text: 'broken', files: [{ id: 'd1', fileName: 'gone.png', contentType: 'image/png', sizeBytes: 1 }] }),
      ],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/a1?preview=1': () => ({ url: 'blob:one' }),
      'GET api/agents/felix/chat/files/c1?preview=1': () => ({ url: 'blob:two' }),
      'GET api/agents/felix/chat/files/c2?preview=1': () => ({ url: 'blob:three' }),
      'GET api/agents/felix/chat/files/d1?preview=1': () => ({ url: 'blob:gone' }),
    });
    await head();
    const pictures = await waitFor(() => {
      const nodes = [...log().querySelectorAll('.chatfileitem img')];
      expect(nodes).toHaveLength(4);
      return nodes as HTMLImageElement[];
    });
    // Three paint; the last never does.
    for (const img of pictures.slice(0, 3)) fireEvent.load(img);
    fireEvent.error(pictures[3]!);
    await waitFor(() => expect(log().querySelectorAll('.chatfileitem.haspicture')).toHaveLength(3));

    // Tap the SECOND message's first picture: it is slide 2 of 3, and the
    // slide before it is on a different message.
    fireEvent.click(pictures[1]!.closest('.chatfileitem')!);
    await screen.findByRole('dialog');
    expect(document.getElementById('imageViewerName')!.textContent).toBe('two.png');
    expect(document.getElementById('imageViewerCount')!.textContent).toBe('2 of 3');
    fireEvent.click(document.getElementById('imageViewerPrev')!);
    await waitFor(() => expect(document.getElementById('imageViewerName')!.textContent).toBe('one.png'));
    expect((document.getElementById('imageViewerImage') as HTMLImageElement).getAttribute('src')).toBe('blob:one');
    fireEvent.click(document.getElementById('imageViewerNext')!);
    fireEvent.click(document.getElementById('imageViewerNext')!);
    await waitFor(() => expect(document.getElementById('imageViewerName')!.textContent).toBe('three.png'));
    // …and the broken one is not a slide, so there is no step past it.
    expect((document.getElementById('imageViewerNext') as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * Note #552: a picture the reader is looking at full screen can be SAVED
   * from there — the one place the name is one tap away once the picture is
   * up (its row gave the name up when the picture painted). The viewer's
   * Download goes back through the screen, which mints a URL signed for
   * saving at the press, exactly as an archive's row does.
   */
  it('offers Download in the viewer, minting a URL signed for saving at the press', async () => {
    const asked: string[] = [];
    const saved = savedFiles();
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'agent',
        text: 'the shot',
        files: [{ id: 'f1', fileName: 'shot.png', contentType: 'image/png', sizeBytes: 2048 }],
      })],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/f1?preview=1': () => ({ url: 'blob:pic' }),
      'GET api/agents/felix/chat/files/f1': (call) => { asked.push(String(call.path)); return { url: 'blob:save', fileName: 'shot.png' }; },
    });
    await head();
    const item = await waitFor(() => {
      const node = log().querySelector('.chatfileitem');
      expect(node?.querySelector('img')).toBeTruthy();
      return node! as HTMLElement;
    });
    fireEvent.load(item.querySelector('img')!);
    await waitFor(() => expect(item.getAttribute('aria-label')).toBe('Open shot.png full screen'));
    fireEvent.click(item);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Download shot.png' }));
    // Signed for SAVING — not the preview URL the viewer is drawing, which
    // is signed inline and would open in the tab rather than save.
    await waitFor(() => expect(asked).toEqual(['api/agents/felix/chat/files/f1']));
    await waitFor(() => expect(saved.list).toEqual([{ href: 'blob:save', download: 'shot.png' }]));
    // The viewer stays: saving a picture is not leaving it.
    expect(screen.queryByRole('dialog')).not.toBeNull();
    saved.restore();
  });

  it('saves a file that is not a picture through an anchor, under a fresh URL', async () => {
    const asked: string[] = [];
    const opener = vi.spyOn(window, 'open').mockImplementation(() => null);
    const saved = savedFiles();
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'owner',
        text: '',
        files: [{ id: 'f9', fileName: 'notes.zip', contentType: 'application/zip', sizeBytes: 512 }],
      })],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/f9': (call) => { asked.push(String(call.path)); return { url: 'blob:doc', fileName: 'notes.zip' }; },
    });
    await head();
    const item = await waitFor(() => {
      const node = log().querySelector('.chatfileitem');
      expect(node).toBeTruthy();
      return node! as HTMLElement;
    });
    fireEvent.click(item);
    // The URL is minted at the TAP: one minted at paint could be dead by now.
    await waitFor(() => expect(asked).toEqual(['api/agents/felix/chat/files/f9']));
    // …and the browser is handed it through an anchor in THIS tab (note
    // #552), never a new window: by the time the URL exists the tap is over,
    // and a window opened after it is a popup Safari refuses in silence.
    await waitFor(() => expect(saved.list).toEqual([{ href: 'blob:doc', download: 'notes.zip' }]));
    expect(opener).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    opener.mockRestore();
    saved.restore();
  });

  /**
   * Note #403: a PDF is the second thing an agent hands over that the
   * Workspace can show, and until this it was a name, a size and a download.
   */
  it('shows a PDF as a document and opens it full screen, in the Workspace', async () => {
    const opener = vi.spyOn(window, 'open').mockImplementation(() => null);
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'agent',
        text: '',
        files: [{ id: 'f7', fileName: 'design-review.pdf', contentType: 'application/pdf', sizeBytes: 892_000 }],
      })],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/f7?preview=1': () => ({ url: 'https://signed.example/review.pdf' }),
    });
    await head();
    const item = await waitFor(() => {
      const node = log().querySelector('.chatpdfitem');
      expect(node).toBeTruthy();
      return node! as HTMLElement;
    });
    // The top of page one, above the name the card keeps: a band of a page
    // cannot say "design-review.pdf · 892 KB", which is the other half of
    // what a document is.
    const preview = item.querySelector('.pdfpreview iframe') as HTMLIFrameElement;
    expect(preview.getAttribute('src'))
      .toBe('https://signed.example/review.pdf#page=1&toolbar=0&navpanes=0&scrollbar=0&statusbar=0&view=FitH');
    expect(preview.getAttribute('loading')).toBe('lazy');
    expect(item.textContent).toContain('design-review.pdf · 871 KB');

    // The tap target is a real <button> — an <iframe> is interactive content
    // and cannot live inside one, so the card is a <div> and the name line
    // is the control, stretched over it by the stylesheet.
    const tap = item.querySelector('button.chatfileline') as HTMLButtonElement;
    expect(tap.getAttribute('aria-label')).toBe('Open design-review.pdf full screen');
    fireEvent.click(tap);

    const viewer = await screen.findByRole('dialog');
    expect(viewer.id).toBe('pdfViewer');
    expect(document.getElementById('pdfViewerName')!.textContent).toBe('design-review.pdf');
    expect((document.getElementById('pdfViewerFrame') as HTMLIFrameElement).getAttribute('src'))
      .toBe('https://signed.example/review.pdf#view=FitH');
    // It stays IN the Workspace: nothing left for the browser's own handler,
    // and no second read — the URL the preview is already drawn on is the
    // one the viewer opens.
    expect(opener).not.toHaveBeenCalled();
    opener.mockRestore();
  });

  /**
   * Note #557: an HTML page an agent wrote is the third thing the Workspace
   * can show, and until this a tap on one downloaded it.
   */
  it('opens an HTML page full screen, sandboxed, with its Download in the viewer', async () => {
    const opener = vi.spyOn(window, 'open').mockImplementation(() => null);
    const saved = savedFiles();
    const minted: string[] = [];
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'agent',
        text: '',
        files: [
          // The generic header an agent's `attach` sends, with the name as
          // the witness — which is how the owner's report arrived.
          { id: 'f8', fileName: 'live-calibration-review.html', contentType: 'application/octet-stream', sizeBytes: 7_000 },
          { id: 'f9', fileName: 'notes.zip', contentType: 'application/zip', sizeBytes: 512 },
        ],
      })],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/f8?preview=1': () => { minted.push('preview'); return { url: 'https://signed.example/review.html?inline' }; },
      'GET api/agents/felix/chat/files/f8': () => { minted.push('save'); return { url: 'https://signed.example/review.html?save', fileName: 'live-calibration-review.html' }; },
    });
    await head();
    const items = await waitFor(() => {
      const nodes = [...log().querySelectorAll('.chatfileitem')];
      expect(nodes).toHaveLength(2);
      return nodes as HTMLElement[];
    });
    const page = items[0]!;
    // The row keeps a named file's shape — no band, no frame per row — and
    // says what its tap does once there is a link to open the page on.
    expect(page.querySelector('iframe')).toBeNull();
    expect(page.textContent).toContain('live-calibration-review.html · 7 KB');
    await waitFor(() => expect(page.getAttribute('aria-label')).toBe('Open live-calibration-review.html full screen'));
    expect(minted).toEqual(['preview']);
    // …and it no longer wears the download mark a save-only row does; the
    // markdown beside it still does.
    expect(page.querySelector('.chatfileline .chatsave')).toBeNull();
    expect(items[1]!.querySelector('.chatfileline .chatsave')).not.toBeNull();

    fireEvent.click(page);
    const viewer = await screen.findByRole('dialog');
    expect(viewer.id).toBe('pdfViewer');
    expect(viewer.className).toContain('htmlviewer');
    expect(document.getElementById('pdfViewerName')!.textContent).toBe('live-calibration-review.html');
    const frame = document.getElementById('pdfViewerFrame') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('https://signed.example/review.html?inline');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox');
    expect(opener).not.toHaveBeenCalled();

    // Download goes back through the screen: a link signed for SAVING, minted
    // at the press, through an anchor and not a window (note #552).
    fireEvent.click(document.getElementById('pdfViewerSave')!);
    await waitFor(() => expect(minted).toEqual(['preview', 'save']));
    await waitFor(() => expect(saved.list).toEqual([{ href: 'https://signed.example/review.html?save', download: 'live-calibration-review.html' }]));
    expect(opener).not.toHaveBeenCalled();
    opener.mockRestore();
    saved.restore();
  });

  /**
   * Note #677: a Markdown file — the write-up an agent hands over most — was
   * a name and a download, read afterwards as a wall of asterisks. It is a
   * card with the top of its page on it, and a tap opens the whole of it.
   */
  it('shows a Markdown file as a page, and opens it full screen drawn from its words', async () => {
    const opener = vi.spyOn(window, 'open').mockImplementation(() => null);
    const saved = savedFiles();
    const asked: string[] = [];
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'agent',
        text: '',
        files: [{ id: 'f10', fileName: 'SHIP-IT.md', contentType: 'text/markdown; charset=utf-8', sizeBytes: 17_000 }],
      })],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/f10/text': (call) => {
        asked.push(String(call.path));
        return { kind: 'markdown', fileName: 'SHIP-IT.md', content: '# Ship it\n\nTwo things to know:\n\n- the accounts\n- **the link**' };
      },
      'GET api/agents/felix/chat/files/f10': (call) => { asked.push(String(call.path)); return { url: 'blob:md', fileName: 'SHIP-IT.md' }; },
    });
    await head();
    const item = await waitFor(() => {
      const node = log().querySelector('.chatmditem');
      expect(node?.querySelector('.mdglimpse h1')).toBeTruthy();
      return node! as HTMLElement;
    });
    // The top of the page above the name the card keeps; a picture of the
    // page, which nothing in can take a tap or the focus.
    const glimpse = item.querySelector('.mdglimpse')!;
    expect(glimpse.querySelector('h1')!.textContent).toBe('Ship it');
    expect(glimpse.getAttribute('aria-hidden')).toBe('true');
    expect(glimpse.hasAttribute('inert')).toBe(true);
    expect(item.textContent).toContain('SHIP-IT.md · 17 KB');
    const tap = item.querySelector('button.chatfileline') as HTMLButtonElement;
    expect(tap.getAttribute('aria-label')).toBe('Open SHIP-IT.md full screen');
    // Not a download any more, so it does not wear the download mark.
    expect(item.querySelector('.chatsave')).toBeNull();

    fireEvent.click(tap);
    const viewer = await screen.findByRole('dialog');
    expect(viewer.id).toBe('pdfViewer');
    expect(viewer.className).toBe('mdviewer');
    expect(document.getElementById('pdfViewerName')!.textContent).toBe('SHIP-IT.md');
    const page = document.getElementById('pdfViewerStage')!;
    expect(page.querySelector('h1')!.textContent).toBe('Ship it');
    expect(page.querySelector('li strong')!.textContent).toBe('the link');
    // The words the card already read: no second read to open them.
    expect(asked).toEqual(['api/agents/felix/chat/files/f10/text']);
    expect(opener).not.toHaveBeenCalled();

    // Download goes back through the screen, signed for saving at the press.
    fireEvent.click(document.getElementById('pdfViewerSave')!);
    await waitFor(() => expect(saved.list).toEqual([{ href: 'blob:md', download: 'SHIP-IT.md' }]));
    expect(asked).toEqual(['api/agents/felix/chat/files/f10/text', 'api/agents/felix/chat/files/f10']);
    opener.mockRestore();
    saved.restore();
  });

  it('keeps a Markdown file it cannot draw as the named row that saves it', async () => {
    const saved = savedFiles();
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'agent',
        text: '',
        files: [
          { id: 'f11', fileName: 'dump.md', contentType: 'text/markdown', sizeBytes: 3_000_000 },
          { id: 'f12', fileName: 'gone.md', contentType: 'text/markdown', sizeBytes: 10 },
        ],
      })],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/f11/text': () => ({ kind: 'too-large', fileName: 'dump.md', maxBytes: 2 * 1024 * 1024 }),
      'GET api/agents/felix/chat/files/f12/text': () => { throw new WorkspaceApiError('That file is no longer on this chat', 404, {}); },
      'GET api/agents/felix/chat/files/f11': () => ({ url: 'blob:dump', fileName: 'dump.md' }),
    });
    await head();
    const rows = await waitFor(() => {
      const nodes = [...log().querySelectorAll('.chatfileitem')];
      expect(nodes.map((node) => node.getAttribute('aria-label'))).toEqual(['Download dump.md', 'Download gone.md']);
      return nodes as HTMLElement[];
    });
    expect(log().querySelector('.chatmditem')).toBeNull();
    expect(rows[0]!.querySelector('.chatsave')).not.toBeNull();
    fireEvent.click(rows[0]!);
    await waitFor(() => expect(saved.list).toEqual([{ href: 'blob:dump', download: 'dump.md' }]));
    expect(screen.queryByRole('dialog')).toBeNull();
    saved.restore();
  });

  /**
   * Note #693: Clara's rendered clip was "agenticcloud-second-brain.mp4 ·
   * 3.1 MB" and a download arrow. A video and a recording play where they
   * were said, and the name under the player is still how to save them.
   */
  it('plays a video and a recording where they were said, with the name as their Download (note #693)', async () => {
    const opener = vi.spyOn(window, 'open').mockImplementation(() => null);
    const saved = savedFiles();
    const asked: string[] = [];
    const later = new Date(Date.now() + 15 * 60_000).toISOString();
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'agent',
        text: '',
        files: [
          { id: 'f20', fileName: 'agenticcloud-second-brain.mp4', contentType: 'video/mp4', sizeBytes: 3_250_000 },
          { id: 'f21', fileName: 'voiceover.mp3', contentType: 'audio/mpeg', sizeBytes: 812_000 },
        ],
      })],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/f20?preview=1': (call) => { asked.push(String(call.path)); return { url: 'https://signed.example/clip.mp4?inline', expiresAt: later }; },
      'GET api/agents/felix/chat/files/f21?preview=1': (call) => { asked.push(String(call.path)); return { url: 'https://signed.example/voice.mp3?inline', expiresAt: later }; },
      'GET api/agents/felix/chat/files/f20': (call) => { asked.push(String(call.path)); return { url: 'https://signed.example/clip.mp4?save', fileName: 'agenticcloud-second-brain.mp4' }; },
    });
    await head();
    const clip = await waitFor(() => {
      const node = log().querySelector('.chatvideoitem');
      expect(node?.querySelector('video')?.getAttribute('src')).toBeTruthy();
      return node! as HTMLElement;
    });
    const player = clip.querySelector('video')!;
    // The browser's own player, on the preview link — `#t=0.001` is what has
    // Safari on a phone draw the first frame rather than a black box — and
    // played in the conversation, not thrown full screen on a phone.
    expect(player.getAttribute('src')).toBe('https://signed.example/clip.mp4?inline#t=0.001');
    expect(player.hasAttribute('controls')).toBe(true);
    expect(player.hasAttribute('playsinline')).toBe(true);
    expect(player.getAttribute('preload')).toBe('metadata');
    const recording = await waitFor(() => {
      const node = log().querySelector('.chataudioitem audio');
      expect(node?.getAttribute('src')).toBe('https://signed.example/voice.mp3?inline');
      return node!;
    });
    expect(recording.hasAttribute('controls')).toBe(true);

    // 16:9 until the player has read the clip, then the clip's own shape — a
    // phone-shaped promo is drawn upright, not as a sliver in a wide box.
    expect(clip.style.getPropertyValue('--video-shape')).toBe('16 / 9');
    Object.defineProperty(player, 'videoWidth', { value: 1080 });
    Object.defineProperty(player, 'videoHeight', { value: 1920 });
    fireEvent.loadedMetadata(player);
    await waitFor(() => expect(clip.style.getPropertyValue('--video-shape')).toBe('1080 / 1920'));

    // The name stays, and it is the Download, saying so (note #552).
    const name = clip.querySelector('button.chatfileline') as HTMLButtonElement;
    expect(name.textContent).toContain('agenticcloud-second-brain.mp4 · 3.1 MB');
    expect(name.getAttribute('aria-label')).toBe('Download agenticcloud-second-brain.mp4');
    expect(name.querySelector('.chatsave')).not.toBeNull();
    fireEvent.click(name);
    await waitFor(() => expect(saved.list).toEqual([{ href: 'https://signed.example/clip.mp4?save', download: 'agenticcloud-second-brain.mp4' }]));
    // Saved through an anchor, and nothing opened full screen over it.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).not.toHaveBeenCalled();
    expect(asked.filter((path) => path.endsWith('?preview=1'))).toHaveLength(2);
    opener.mockRestore();
    saved.restore();
  });

  it('renews a player’s link that ran out, and names a clip it cannot play (note #693)', async () => {
    let links = 0;
    const asked: string[] = [];
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'agent',
        text: '',
        files: [
          { id: 'f22', fileName: 'demo.mp4', contentType: 'video/mp4', sizeBytes: 900_000 },
          { id: 'f23', fileName: 'IMG_0412.mov', contentType: 'video/quicktime', sizeBytes: 9_000_000 },
        ],
      })],
      working: false,
    }), {
      // Minted an hour ago and pressed now: the first link is already dead.
      'GET api/agents/felix/chat/files/f22?preview=1': () => {
        links += 1;
        return links === 1
          ? { url: 'https://signed.example/demo.mp4?old', expiresAt: new Date(Date.now() - 45 * 60_000).toISOString() }
          : { url: 'https://signed.example/demo.mp4?new', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
      },
      'GET api/agents/felix/chat/files/f23?preview=1': (call) => {
        asked.push(String(call.path));
        return { url: 'https://signed.example/IMG_0412.mov?inline', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
      },
    });
    await head();
    const [demo, mov] = await waitFor(() => {
      const nodes = [...log().querySelectorAll('.chatvideoitem video')];
      expect(nodes.map((node) => node.getAttribute('src'))).toEqual([
        'https://signed.example/demo.mp4?old#t=0.001', 'https://signed.example/IMG_0412.mov?inline#t=0.001',
      ]);
      return nodes as HTMLVideoElement[];
    });

    // A link past its life is the link's fault: a fresh one, once.
    fireEvent.error(demo!);
    await waitFor(() => expect(demo!.getAttribute('src')).toBe('https://signed.example/demo.mp4?new#t=0.001'));
    expect(links).toBe(2);
    // A clip that fails on a good link is the clip's: a container this
    // browser cannot open goes back to the named row whose tap saves it,
    // with no second read.
    fireEvent.error(mov!);
    await waitFor(() => {
      const rows = [...log().querySelectorAll('.chatfileitem')];
      expect(rows.map((node) => node.getAttribute('aria-label'))).toEqual([null, 'Download IMG_0412.mov']);
    });
    expect(asked).toHaveLength(1);
    // …and so does the renewed one, if it fails too: once is the bargain.
    fireEvent.error(log().querySelector('.chatvideoitem video')!);
    await waitFor(() => expect(log().querySelector('.chatvideoitem')).toBeNull());
    expect(links).toBe(2);
    expect([...log().querySelectorAll('.chatfileitem')].map((node) => node.getAttribute('aria-label')))
      .toEqual(['Download demo.mp4', 'Download IMG_0412.mov']);
  });

  it('frames a picture at its own size before the bytes arrive, and lays the bytes over the frame', async () => {
    let minted = 0;
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'owner',
        text: '',
        files: [{ id: 'f1', fileName: 'shot.png', contentType: 'image/png', sizeBytes: 2048, width: 1179, height: 2556 }],
      })],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/f1?preview=1': () => { minted += 1; return { url: 'blob:pic' }; },
    });
    await head();
    const item = await waitFor(() => {
      const node = log().querySelector('.chatfileitem');
      expect(node).toBeTruthy();
      return node! as HTMLElement;
    });
    // The frame is up at once — the row already knows how big the picture
    // is — and it hands the stylesheet the picture's ratio and pixel width,
    // which is what gives it the picture's final box with nothing loaded.
    // The name line is gone and the frame is grey: this is a picture
    // loading, not a file named.
    const frame = item.querySelector('.chatpicture') as HTMLElement;
    expect(frame).toBeTruthy();
    expect(frame.style.getPropertyValue('--picture-ratio')).toBe('1179 / 2556');
    expect(frame.style.getPropertyValue('--picture-width')).toBe('1179px');
    expect(item.className).toBe('chatfileitem haspicture loading');
    // The bytes land OVER the frame once the preview URL exists…
    const picture = await waitFor(() => {
      const node = item.querySelector('img.chatpicturebytes') as HTMLImageElement;
      expect(node).toBeTruthy();
      return node;
    });
    expect(picture.getAttribute('src')).toBe('blob:pic');
    expect(picture.parentElement).toBe(frame);
    expect(minted).toBe(1);
    // …and the frame stays exactly what it was: the row's box never changes.
    fireEvent.load(picture);
    expect(item.className).toBe('chatfileitem haspicture');
    expect(item.querySelector('.chatpicture')).toBe(frame);
    expect(frame.style.getPropertyValue('--picture-ratio')).toBe('1179 / 2556');
  });

  it('frames a picture stored without a size once the preview read has measured it', async () => {
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'owner',
        text: '',
        files: [{ id: 'f1', fileName: 'old.png', contentType: 'image/png', sizeBytes: 2048 }],
      })],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/f1?preview=1': () => ({ url: 'blob:old', width: 640, height: 480 }),
    });
    await head();
    const item = await waitFor(() => {
      const node = log().querySelector('.chatfileitem');
      expect(node).toBeTruthy();
      return node! as HTMLElement;
    });
    // The preview read is what measured it (and wrote the size back), so the
    // frame and the bytes arrive together — and the bytes still land into a
    // frame rather than growing the row.
    await waitFor(() => expect(item.querySelector('.chatpicture')).toBeTruthy());
    expect((item.querySelector('.chatpicture') as HTMLElement).style.getPropertyValue('--picture-ratio')).toBe('640 / 480');
    expect(item.querySelector('img.chatpicturebytes')!.getAttribute('src')).toBe('blob:old');
    expect(item.className).toBe('chatfileitem haspicture loading');
  });

  it('puts the name back when a framed picture fails to load', async () => {
    open(() => ({
      messages: [chatMessage({
        seq: 1,
        role: 'owner',
        text: '',
        files: [{ id: 'f1', fileName: 'shot.png', contentType: 'image/png', sizeBytes: 2048, width: 10, height: 10 }],
      })],
      working: false,
    }), {
      'GET api/agents/felix/chat/files/f1?preview=1': () => ({ url: 'blob:gone' }),
    });
    await head();
    const picture = await waitFor(() => {
      const node = log().querySelector('img.chatpicturebytes');
      expect(node).toBeTruthy();
      return node! as HTMLImageElement;
    });
    fireEvent.error(picture);
    const item = log().querySelector('.chatfileitem')!;
    expect(item.className).toBe('chatfileitem');
    expect(item.querySelector('img')).toBeNull();
    expect(item.textContent).toContain('shot.png · 2 KB');
  });
});

describe('opening at the end', () => {
  it('waits for the shell when the transcript lands before the agent is known', async () => {
    // The transcript read wins the race against the state read (one storage
    // read against a dozen), so the rows are held while the screen is still
    // a spinner. The follow must not be spent on a pane that is not there.
    let releaseState: () => void = () => {};
    const stateHeld = new Promise<void>((resolve) => { releaseState = resolve; });
    const scripted = scriptedApi({
      ...workspaceScript(() => state()),
      'GET api/state': async () => { await stateHeld; return state(); },
      ...chatScript('felix', () => ({
        messages: [chatMessage({ seq: 1, role: 'agent', text: 'first' }), chatMessage({ seq: 2, role: 'owner', text: 'last' })],
        working: false,
      })),
    });
    render(
      <MemoryRouter initialEntries={['/chat/felix']}>
        <App api={scripted.api} />
      </MemoryRouter>,
    );
    // The rows are in hand before the shell exists.
    await waitFor(() => expect(scripted.calls.filter((call) => call.path.startsWith('api/agents/felix/chat')).length).toBe(1));
    expect(document.getElementById('agentChatScroll')).toBeNull();
    // jsdom lays nothing out, so the pane's scroll is watched directly: the
    // follow is the one write to it, and it has to come AFTER the shell.
    const writes: number[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get() { return 0; },
      set(value: number) { if ((this as Element).id === 'agentChatScroll') writes.push(value); },
    });
    try {
      await act(async () => { releaseState(); });
      await head();
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(writes.length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(Element.prototype, 'scrollTop', descriptor);
    }
  });
});

describe('the way back to the newest message (note #334)', () => {
  const felixSays = () => ({ messages: [chatMessage({ seq: 1, role: 'agent', text: 'hello' })], working: false });
  const anchor = () => document.getElementById('agentChatJump')!.parentElement as HTMLElement;

  /** jsdom lays nothing out, so the pane is given its geometry by hand: a
   *  transcript five panes tall, and the line the reader is on. Writes to
   *  the scroll are recorded, not applied — what the jump WROTE is the fact. */
  function paneAt(scrollTop: number, writes: number[] = []) {
    const node = document.getElementById('agentChatScroll')!;
    Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => 3000 });
    Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(node, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { writes.push(value); } });
    return node;
  }
  /** The handler takes the first scroll at a NEW pane height for the pane
   *  resizing under the reader and reads nothing from it; the second, at a
   *  settled height, is the reader. So a change of line is two scrolls. */
  const reader = (node: HTMLElement) => { fireEvent.scroll(node); fireEvent.scroll(node); };

  it('is not there at the end, appears a pane up, and goes again on the way back', async () => {
    open(felixSays);
    await head();
    expect(anchor().hidden).toBe(true);
    // A pane and a half above the newest message.
    reader(paneAt(3000 - 600 - 900));
    expect(anchor().hidden).toBe(false);
    // Half a pane short of it: the end is a flick away again.
    reader(paneAt(3000 - 600 - 300));
    expect(anchor().hidden).toBe(true);
  });

  it('takes the reader to the newest message when tapped, and goes at once', async () => {
    open(felixSays);
    await head();
    const writes: number[] = [];
    reader(paneAt(0, writes));
    expect(anchor().hidden).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to the newest message' }));
    expect(writes).toContain(3000);
    expect(anchor().hidden).toBe(true);
  });
});

describe('the composer', () => {
  it('sends words and paints the row the read brings back', async () => {
    const sent: unknown[] = [];
    let answer: WorkspaceChatAnswer = { messages: [], working: false };
    open(() => answer, {
      'POST api/agents/felix/chat': (call) => {
        sent.push(JSON.parse(String(call.init?.body)));
        answer = { messages: [chatMessage({ seq: 1, role: 'owner', text: 'hello' })], working: false };
        return { ok: true, name: 'Felix', steered: false };
      },
    });
    await head();
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    const send = document.getElementById('agentChatSend') as HTMLButtonElement;
    // Nothing to send is not a send.
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '  hello  ' } });
    expect(send.disabled).toBe(false);
    fireEvent.submit(document.getElementById('agentChatForm')!);
    await waitFor(() => expect(sent).toEqual([{ message: 'hello' }]));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(box.value).toBe('');
  });

  it('sends on Enter where there is a keyboard, and opens a line on Shift+Enter (note #291)', async () => {
    const sent: unknown[] = [];
    const { box } = await composerPosting(sent);
    fireEvent.change(box, { target: { value: 'hello' } });
    // A press that sends takes the newline with it, so the box does not grow a
    // row on its way out; a press that does not send leaves the browser's own
    // default standing, which IS the new line.
    expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(false);
    await waitFor(() => expect(sent).toEqual([{ message: 'hello' }]));
    fireEvent.change(box, { target: { value: 'first line' } });
    expect(fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(sent).toHaveLength(1);
    expect(box.value).toBe('first line');
  });

  it('leaves Enter as the newline key on a touch keyboard, where there is no Shift to hold', async () => {
    onAPhone();
    const sent: unknown[] = [];
    const { box } = await composerPosting(sent);
    fireEvent.change(box, { target: { value: 'hello' } });
    expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(true);
    expect(sent).toHaveLength(0);
    expect(box.value).toBe('hello');
  });

  it('puts a touch keyboard away once the message has gone (note #305)', async () => {
    onAPhone();
    const sent: unknown[] = [];
    const { box } = await composerPosting(sent);
    box.focus();
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    await waitFor(() => expect(sent).toEqual([{ message: 'hello' }]));
    // Dropping the focus is what lowers a touch keyboard: half the screen
    // stops being keys over the answer the reader just asked for.
    await waitFor(() => expect(document.activeElement).not.toBe(box));
  });

  it('keeps the focus at a desk, where there is no keyboard to put away', async () => {
    const sent: unknown[] = [];
    const { box } = await composerPosting(sent);
    box.focus();
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    await waitFor(() => expect(sent).toEqual([{ message: 'hello' }]));
    // Nothing is covering anything here, so the only thing a blur could do is
    // cost note #291's Enter the next message.
    expect(document.activeElement).toBe(box);
  });

  it('gives a refused message back to the box, and takes its bubble down (note #658)', async () => {
    onAPhone();
    open(() => ({ messages: [], working: false }), {
      'POST api/agents/felix/chat': () => {
        throw new WorkspaceApiError('Felix is not reachable.', 503, { error: 'Felix is not reachable.' });
      },
    });
    await head();
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    box.focus();
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    expect((await screen.findByRole('alert')).textContent).toContain('Felix is not reachable.');
    // The words are where they can go again, and the conversation does not
    // claim a message that never went.
    expect(box.value).toBe('hello');
    expect(log().querySelector('.chatmsg.sending')).toBeNull();
    expect((document.getElementById('agentChatSend') as HTMLButtonElement).disabled).toBe(false);
  });

  it('never sends on the Enter that is finishing an IME word', async () => {
    const sent: unknown[] = [];
    const { box } = await composerPosting(sent);
    fireEvent.change(box, { target: { value: 'にほん' } });
    expect(fireEvent.keyDown(box, { key: 'Enter', isComposing: true })).toBe(true);
    // Safari commits the candidate with `isComposing` already false.
    expect(fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('does not send twice when Enter is pressed again straight after', async () => {
    const sent: unknown[] = [];
    let release: () => void = () => {};
    open(() => ({ messages: [], working: false }), {
      'POST api/agents/felix/chat': (call) => new Promise((resolve) => {
        sent.push(JSON.parse(String(call.init?.body)));
        release = () => resolve({ ok: true, name: 'Felix', steered: false });
      }),
    });
    await head();
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    // The box empties in the same event the message is taken in, so the
    // second press finds nothing to send.
    expect(box.value).toBe('');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(async () => { release(); });
    expect(sent).toHaveLength(1);
  });

  it('keeps the box live while a message is on its way, and sends the next one after it (note #658)', async () => {
    const sent: string[] = [];
    const releases: Array<() => void> = [];
    let answer: WorkspaceChatAnswer = { messages: [], working: false };
    open(() => answer, {
      'POST api/agents/felix/chat': (call) => new Promise((resolve) => {
        const { message } = JSON.parse(String(call.init?.body)) as { message: string };
        sent.push(message);
        releases.push(() => {
          answer = {
            ...answer,
            messages: [...answer.messages, chatMessage({ seq: answer.messages.length + 1, role: 'owner', text: message, at: new Date().toISOString() })],
          };
          resolve({ ok: true, name: 'Felix', steered: false });
        });
      }),
    });
    await head();
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    const send = document.getElementById('agentChatSend') as HTMLButtonElement;
    fireEvent.change(box, { target: { value: 'first' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    await waitFor(() => expect(sent).toEqual(['first']));
    // Nothing is held still for the wait: not the box, not the paperclip,
    // not Send once there is something to send.
    expect(box.readOnly).toBe(false);
    expect(box.disabled).toBe(false);
    expect((document.getElementById('agentChatAttach') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(box, { target: { value: 'second' } });
    expect(send.disabled).toBe(false);
    fireEvent.submit(document.getElementById('agentChatForm')!);
    expect(box.value).toBe('');
    // Both are in the conversation, in order — but the second goes only
    // once the first is on the record.
    expect([...log().querySelectorAll('.chatmsg.sending')].map((row) => row.textContent)).toEqual(['first', 'second']);
    expect(sent).toEqual(['first']);
    await act(async () => { releases[0]!(); });
    await waitFor(() => expect(sent).toEqual(['first', 'second']));
    await act(async () => { releases[1]!(); });
    await waitFor(() => expect(rows().map((row) => row.textContent)).toEqual(['first', 'second']));
    expect(log().querySelector('.chatmsg.sending')).toBeNull();
  });

  it('reports a refusal without losing what was typed', async () => {
    open(() => ({ messages: [], working: false }), {
      'POST api/agents/felix/chat': () => {
        throw new WorkspaceApiError('That message is too long.', 400, { error: 'That message is too long.' });
      },
    });
    await head();
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    expect((await screen.findByRole('alert')).textContent).toContain('That message is too long.');
    expect(box.value).toBe('hello');
  });

  it('gives back what was queued behind a refused message, in front of what was typed since', async () => {
    let refuse: () => void = () => {};
    const sent: string[] = [];
    open(() => ({ messages: [], working: false }), {
      'POST api/agents/felix/chat': (call) => new Promise((_resolve, reject) => {
        sent.push((JSON.parse(String(call.init?.body)) as { message: string }).message);
        refuse = () => reject(new WorkspaceApiError('Felix could not be started.', 503, { error: 'Felix could not be started.' }));
      }),
    });
    await head();
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'first' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    fireEvent.change(box, { target: { value: 'second' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    fireEvent.change(box, { target: { value: 'third, still typing' } });
    await waitFor(() => expect(sent).toEqual(['first']));
    await act(async () => { refuse(); });
    expect((await screen.findByRole('alert')).textContent).toContain('Felix could not be started.');
    // The later message never went: sending it after the refused one would
    // reorder the conversation.
    expect(sent).toEqual(['first']);
    expect(box.value).toBe('first\n\nsecond\n\nthird, still typing');
    expect(log().querySelector('.chatmsg.sending')).toBeNull();
  });

  it('counts only once the cap is in sight', async () => {
    open(() => ({ messages: [], working: false }));
    await head();
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    const count = document.getElementById('agentChatCount') as HTMLElement;
    // Note #704: ten thousand, so a long brief goes in one message.
    expect(box.maxLength).toBe(10_000);
    fireEvent.change(box, { target: { value: 'x'.repeat(4000) } });
    expect(count.hidden).toBe(true);
    fireEvent.change(box, { target: { value: 'x'.repeat(9600) } });
    expect(count.hidden).toBe(false);
    expect(count.textContent).toBe('9600 / 10000');
  });

  it('packs a caption and its files into the envelope the upload route reads', async () => {
    let body: Blob | null = null;
    open(() => ({ messages: [], working: false }), {
      'POST api/agents/felix/chat/files': (call) => { body = call.init?.body as Blob; return { ok: true, name: 'Felix' }; },
    });
    await head();
    const picker = document.getElementById('agentChatFile') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    fireEvent.change(picker, { target: { files: [file] } });
    const draft = document.getElementById('agentChatDraft') as HTMLElement;
    await waitFor(() => expect(draft.hidden).toBe(false));
    expect(draft.querySelector('.name')!.textContent).toBe('shot.png');
    expect(draft.querySelector('.meta')!.textContent).toBe('3 B · ready to send');
    // A file set is a complete message even with no caption.
    expect((document.getElementById('agentChatSend') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(document.getElementById('agentChatText')!, { target: { value: 'look' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    await waitFor(() => expect(body).toBeTruthy());
    // jsdom's Blob has no arrayBuffer(); FileReader is the reader it does have.
    const bytes = new Uint8Array(await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(body!);
    }));
    const length = new DataView(bytes.buffer).getUint32(0);
    const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
    expect(manifest).toEqual({
      message: 'look',
      files: [{ fileName: 'shot.png', contentType: 'image/png', sizeBytes: 3 }],
    });
    expect([...bytes.subarray(4 + length)]).toEqual([1, 2, 3]);
    // The draft empties with the send.
    await waitFor(() => expect(draft.hidden).toBe(true));
  });

  it('sends a file past one part in parts first, says how far on the bubble, and names it in the message (note #943)', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const at = (rest: string) => `api/agents/felix/chat/uploads/${id}${rest}?upload=u1&name=film.mp4`;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let body: Blob | null = null;
    const scripted = open(() => ({ messages: [], working: false }), {
      'POST api/agents/felix/chat/uploads': () => ({ id, uploadId: 'u1', partBytes: 8 * 1024 * 1024, parts: 3 }),
      [`PUT ${at('/parts/1')}`]: () => ({ partNumber: 1, etag: 'e1' }),
      [`PUT ${at('/parts/2')}`]: async () => { await gate; return { partNumber: 2, etag: 'e2' }; },
      [`PUT ${at('/parts/3')}`]: async () => { await gate; return { partNumber: 3, etag: 'e3' }; },
      [`POST api/agents/felix/chat/uploads/${id}/complete`]: () => ({ id, fileName: 'film.mp4', sizeBytes: 20 * 1024 * 1024 }),
      'POST api/agents/felix/chat/files': (call) => { body = call.init?.body as Blob; return { ok: true, name: 'Felix' }; },
    });
    await head();
    const film = new File([new Uint8Array(20 * 1024 * 1024)], 'film.mp4', { type: 'video/mp4' });
    fireEvent.change(document.getElementById('agentChatFile')!, { target: { files: [film] } });
    await waitFor(() => expect((document.getElementById('agentChatDraft') as HTMLElement).hidden).toBe(false));
    fireEvent.submit(document.getElementById('agentChatForm')!);
    // One part of three in: 8 MB of 20.
    await waitFor(() => expect(log().querySelector('.chatmsg.sending')?.getAttribute('data-time')).toBe('Sending… 40%'));
    release();
    await waitFor(() => expect(body).toBeTruthy());
    const complete = scripted.calls.find((call) => call.path.endsWith('/complete'))!;
    expect(JSON.parse(String(complete.init?.body))).toEqual({
      uploadId: 'u1', fileName: 'film.mp4',
      parts: [{ partNumber: 1, etag: 'e1' }, { partNumber: 2, etag: 'e2' }, { partNumber: 3, etag: 'e3' }],
    });
    const bytes = new Uint8Array(await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(body!);
    }));
    const length = new DataView(bytes.buffer).getUint32(0);
    // The message names the file and carries none of its bytes.
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)))).toEqual({
      message: '', files: [{ fileName: 'film.mp4', contentType: 'video/mp4', upload: id }],
    });
    expect(bytes.length).toBe(4 + length);
  });

  it('takes any number of files of any size (note #943), and refuses only an empty one and one past the 78 GB the parts can carry', async () => {
    open(() => ({ messages: [], working: false }));
    await head();
    const picker = document.getElementById('agentChatFile') as HTMLInputElement;
    // Note #672: no count cap — twelve screenshots are one message.
    const many = Array.from({ length: 12 }, (_, i) => new File([new Uint8Array([1])], `f${i}.txt`, { type: 'text/plain' }));
    fireEvent.change(picker, { target: { files: many } });
    const draft = document.getElementById('agentChatDraft') as HTMLElement;
    await waitFor(() => expect(draft.hidden).toBe(false));
    expect(draft.querySelectorAll('.chatdraftitem')).toHaveLength(12);
    // Note #943: no size cap either — a 38.4 MB film (the owner's) and four
    // 24 MB ones on top all join the draft.
    const sized = (name: string, size: number) => {
      const file = new File([new Uint8Array([1])], name, { type: 'video/mp4' });
      Object.defineProperty(file, 'size', { value: size });
      return file;
    };
    fireEvent.change(picker, { target: { files: [sized('film.mp4', 40_265_318), ...[1, 2, 3, 4].map((n) => sized(`video-${n}.mp4`, 24 * 1024 * 1024))] } });
    await waitFor(() => expect(draft.querySelectorAll('.chatdraftitem')).toHaveLength(17));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(picker, { target: { files: [sized('disk.img', 80 * 1024 ** 3)] } });
    expect((await screen.findByRole('alert')).textContent).toContain('A chat file can be up to 78 GB — this one is 80 GB.');
    expect(draft.querySelectorAll('.chatdraftitem')).toHaveLength(17);
    fireEvent.change(picker, { target: { files: [new File([], 'empty.txt', { type: 'text/plain' })] } });
    expect((await screen.findByRole('alert')).textContent).toContain('That file is empty.');
  });

  it('a picked file can be taken off again', async () => {
    open(() => ({ messages: [], working: false }));
    await head();
    fireEvent.change(document.getElementById('agentChatFile')!, {
      target: { files: [new File([new Uint8Array([1])], 'a.txt', { type: 'text/plain' })] },
    });
    const draft = document.getElementById('agentChatDraft') as HTMLElement;
    await waitFor(() => expect(draft.hidden).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.txt' }));
    await waitFor(() => expect(draft.hidden).toBe(true));
  });

  /** Note #294 again, on the other half of the screen: a picture picked but
   *  not yet sent opens in the same viewer a sent one does. */
  it('previews a picked picture full screen, and sends anything else out', async () => {
    const opener = vi.spyOn(window, 'open').mockImplementation(() => null);
    open(() => ({ messages: [], working: false }));
    await head();
    fireEvent.change(document.getElementById('agentChatFile')!, {
      target: {
        files: [
          new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' }),
          new File([new Uint8Array([1])], 'notes.md', { type: 'text/markdown' }),
        ],
      },
    });
    await waitFor(() => expect((document.getElementById('agentChatDraft') as HTMLElement).hidden).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Preview shot.png full screen' }));
    const viewer = await screen.findByRole('dialog');
    expect(viewer.id).toBe('imageViewer');
    expect(document.getElementById('imageViewerName')!.textContent).toBe('shot.png');
    // One picture among the picked files is a gallery of one, not of two.
    expect(document.getElementById('imageViewerCount')).toBeNull();
    expect(opener).not.toHaveBeenCalled();
    fireEvent.click(document.getElementById('imageViewerClose')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Preview notes.md' }));
    expect(opener).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    opener.mockRestore();
  });
});

describe('a turn that is running', () => {
  const busy = (): WorkspaceChatAnswer => ({
    messages: [chatMessage({ seq: 1, text: 'on it' })],
    working: true,
    activity: 'Bash: npm test',
  });

  it('shows the typing bubble with the newest tool line', async () => {
    open(busy);
    await head();
    const live = document.getElementById('agentChatLive') as HTMLElement;
    await waitFor(() => expect(live.hidden).toBe(false));
    expect(document.getElementById('agentChatActivity')!.textContent).toBe('Bash: npm test');
    expect(live.querySelector('.tdots')).toBeTruthy();
  });

  it('names the agent when the turn has called no tool yet', async () => {
    open(() => ({ messages: [], working: true }));
    await head();
    await waitFor(() => expect(document.getElementById('agentChatActivity')!.textContent).toBe('Felix is working'));
  });

  it('is answered by the transcript when Stop really stops it', async () => {
    let answer = busy();
    open(() => answer, {
      'POST api/agents/felix/stop': () => {
        answer = {
          messages: [chatMessage({ seq: 2, role: 'platform', text: 'Turn stopped by the user.' })],
          working: false,
        };
        return { ok: true, stopped: true, name: 'Felix' };
      },
    });
    await head();
    await waitFor(() => expect((document.getElementById('agentChatLive') as HTMLElement).hidden).toBe(false));
    fireEvent.click(document.getElementById('agentChatStop')!);
    // A stopped turn appends the row this screen draws; a toast as well would
    // print the fact twice, over the composer it covers.
    await waitFor(() => expect(log().textContent).toContain('You stopped this turn'));
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect((document.getElementById('agentChatLive') as HTMLElement).hidden).toBe(true));
  });

  it('toasts only the turn that had already finished', async () => {
    let answer = busy();
    open(() => answer, {
      'POST api/agents/felix/stop': () => {
        answer = { messages: [], working: false };
        return { ok: true, stopped: false, name: 'Felix' };
      },
    });
    await head();
    await waitFor(() => expect((document.getElementById('agentChatLive') as HTMLElement).hidden).toBe(false));
    fireEvent.click(document.getElementById('agentChatStop')!);
    expect((await screen.findByRole('alert')).textContent).toContain('Felix had already finished.');
  });

  it('takes the live row down the moment the turn ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer = busy();
    open(() => answer);
    await head();
    await waitFor(() => expect((document.getElementById('agentChatLive') as HTMLElement).hidden).toBe(false));
    answer = { messages: [], working: false };
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_POLL_MS + 50); });
    await waitFor(() => expect((document.getElementById('agentChatLive') as HTMLElement).hidden).toBe(true));
  });
});

describe('Back out of a conversation', () => {
  it('spends the entry this page session pushed', async () => {
    open(() => ({ messages: [], working: false }), {
      ...versionScript(),
    }, ['/', '/chat/felix']);
    await head();
    fireEvent.click(document.querySelector('.chathead .back')!);
    // Home, because Home is what this session pushed the chat on top of.
    expect(await homeShelf()).toBeTruthy();
  });

  it('replaces a pasted or reloaded chat with its agent, never a second entry', async () => {
    open(() => ({ messages: [], working: false }), { ...versionScript() }, ['/chat/felix']);
    await head();
    fireEvent.click(document.querySelector('.chathead .back')!);
    // The product's contextual rule still says Chat → Agent, and the entry is
    // REPLACED so the next browser Back does not walk through a duplicate.
    await waitFor(() => expect(document.getElementById('agentInfoTitle')).toBeTruthy());
    expect(document.getElementById('agentInfoTitle')!.textContent).toBe('Felix');
  });

  it('does not repeat Back with a Home action', async () => {
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix']);
    await head();
    expect(document.getElementById('chatHome')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
  });
});

describe('the draft left behind (note #515)', () => {
  /** Away and back the way a reader really goes: Back to the agent's own
   *  screen, then its Open chat door — two whole screens apart, with the
   *  composer destroyed and rebuilt in between. */
  const stepAwayAndBack = async () => {
    fireEvent.click(document.querySelector('.chathead .back')!);
    await waitFor(() => expect(document.getElementById('agentInfoTitle')).toBeTruthy());
    fireEvent.click(document.getElementById('agentChat')!);
    await head();
  };
  const box = () => document.getElementById('agentChatText') as HTMLTextAreaElement;

  it('is in the box again when the reader comes back to the conversation', async () => {
    open(() => ({ messages: [], working: false }), { ...versionScript() }, ['/chat/felix']);
    await head();
    fireEvent.change(box(), { target: { value: 'half a thought' } });
    await stepAwayAndBack();
    expect(box().value).toBe('half a thought');
    // And the composer is live on it, not showing words it will not send.
    expect((document.getElementById('agentChatSend') as HTMLButtonElement).disabled).toBe(false);
  });

  it('has nothing waiting once the message has actually gone', async () => {
    open(() => ({ messages: [], working: false }), {
      ...versionScript(),
      'POST api/agents/felix/chat': () => ({ ok: true, name: 'Felix', steered: false }),
    }, ['/chat/felix']);
    await head();
    fireEvent.change(box(), { target: { value: 'sent and done' } });
    fireEvent.click(document.getElementById('agentChatSend')!);
    await waitFor(() => expect(box().value).toBe(''));
    await stepAwayAndBack();
    expect(box().value).toBe('');
  });

});

describe('a message on its way (note #658)', () => {
  /** The same walk the draft tests take: Back to the agent, and in again. */
  const stepAwayAndBack = async () => {
    fireEvent.click(document.querySelector('.chathead .back')!);
    await waitFor(() => expect(document.getElementById('agentInfoTitle')).toBeTruthy());
    fireEvent.click(document.getElementById('agentChat')!);
    await head();
  };
  const box = () => document.getElementById('agentChatText') as HTMLTextAreaElement;
  const sending = () => [...log().querySelectorAll<HTMLElement>('.chatmsg.sending')];
  const activity = () => document.getElementById('agentChatActivity')!.textContent;
  /** A send route that holds its answer until the test lets it go, and
   *  writes the owner's row on the record as it does — the route's own order. */
  const held = (answer: { current: WorkspaceChatAnswer }, sent: string[]) => {
    const releases: Array<() => void> = [];
    const route = (call: { init?: RequestInit }) => new Promise((resolve) => {
      const { message } = JSON.parse(String(call.init?.body)) as { message: string };
      sent.push(message);
      releases.push(() => {
        const seq = answer.current.messages.length + 1;
        answer.current = {
          messages: [...answer.current.messages, chatMessage({ seq, role: 'owner', text: message, at: new Date().toISOString() })],
          working: true,
        };
        resolve({ ok: true, name: 'Felix', steered: false });
      });
    });
    return { route, release: (at = 0) => releases[at]!() };
  };

  it('is in the conversation the moment it is sent, and says what it is waiting on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const answer = { current: { messages: [chatMessage({ seq: 1, text: 'Hello there.' })], working: false } as WorkspaceChatAnswer };
    const sent: string[] = [];
    const send = held(answer, sent);
    open(() => answer.current, {
      'POST api/agents/felix/chat': (call) => {
        // The machine is gone, so the route rebuilds it before the row is
        // written — and the chat read says so meanwhile.
        answer.current = { ...answer.current, preparing: true };
        return send.route(call);
      },
    });
    await head();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.change(box(), { target: { value: '?' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    // At once, before the server has said anything: the bubble, and an empty box.
    expect(sending().map((row) => row.textContent)).toEqual(['?']);
    expect(sending()[0]!.dataset.time).toBe('Sending…');
    expect(sending()[0]!.className).toContain('owner');
    expect(box().value).toBe('');
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_POLL_MS + 50); });
    await waitFor(() => expect(activity()).toBe('Getting Felix’s machine ready'));
    // No turn has started, so there is nothing to Stop.
    expect(document.getElementById('agentChatStop')).toBeNull();
    await act(async () => { send.release(); });
    // The row takes the bubble's place — once, and without rising in again
    // as though it had been sent a second time.
    await waitFor(() => expect(sending()).toHaveLength(0));
    const owner = [...log().querySelectorAll('.chatmsg.owner')];
    expect(owner.map((row) => row.textContent)).toEqual(['?']);
    expect(owner[0]!.className).not.toContain('arriving');
    await waitFor(() => expect(activity()).toBe('Felix is working'));
    expect(document.getElementById('agentChatStop')).toBeTruthy();
    expect(sent).toEqual(['?']);
  });

  it('follows the bubble down in the commit it is drawn in, not by a slide that starts it under the fold (note #764)', async () => {
    const answer = { current: { messages: [chatMessage({ seq: 1, text: 'Hello there.' })], working: false } as WorkspaceChatAnswer };
    const send = held(answer, []);
    open(() => answer.current, { 'POST api/agents/felix/chat': send.route });
    await head();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const pane = log().closest<HTMLElement>('.chatpane')!;
    const slides: unknown[] = [], writes: number[] = [];
    let top = 0;
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => 4000 });
    Object.defineProperty(pane, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { writes.push(value); top = value; } });
    pane.scrollTo = ((options: unknown) => { slides.push(options); }) as typeof pane.scrollTo;
    fireEvent.change(box(), { target: { value: 'Ship it' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    expect(sending().map((row) => row.textContent)).toEqual(['Ship it']);
    expect(writes).toContain(4000);
    expect(slides).toEqual([]);
    await act(async () => { send.release(); });
  });

  it('keeps going when the reader steps away, and never comes back as a draft to send twice', async () => {
    const answer = { current: { messages: [], working: false } as WorkspaceChatAnswer };
    const sent: string[] = [];
    const send = held(answer, sent);
    open(() => answer.current, { ...versionScript(), 'POST api/agents/felix/chat': send.route }, ['/chat/felix']);
    await head();
    fireEvent.change(box(), { target: { value: 'are you there?' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    await waitFor(() => expect(sent).toEqual(['are you there?']));
    await stepAwayAndBack();
    // The message is still on its way, where it was left — and the box holds
    // nothing that would send it a second time.
    expect(sending().map((row) => row.textContent)).toEqual(['are you there?']);
    expect(box().value).toBe('');
    expect((document.getElementById('agentChatSend') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { send.release(); });
    await waitFor(() => expect(sending()).toHaveLength(0));
    expect(rows().map((row) => row.textContent)).toEqual(['are you there?']);
    expect(box().value).toBe('');
    expect(sent).toEqual(['are you there?']);
  });

  it('is found on the record after a dropped answer, rather than handed back', async () => {
    let answer: WorkspaceChatAnswer = { messages: [], working: false };
    open(() => answer, {
      'POST api/agents/felix/chat': () => {
        // Admitted — and then the connection went before the answer came.
        answer = { messages: [chatMessage({ seq: 1, role: 'owner', text: 'hello', at: new Date().toISOString() })], working: true };
        throw new TypeError('Failed to fetch');
      },
    });
    await head();
    fireEvent.change(box(), { target: { value: 'hello' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    await waitFor(() => expect(rows().map((row) => row.textContent)).toEqual(['hello']));
    expect(sending()).toHaveLength(0);
    expect(box().value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('comes back to the box when a dropped send is never found on the record', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open(() => ({ messages: [], working: false }), {
      'POST api/agents/felix/chat': () => { throw new TypeError('Failed to fetch'); },
    });
    await head();
    fireEvent.change(box(), { target: { value: 'hello' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    // Not yet: a dropped answer proves nothing, so the bubble waits to be found.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(sending()).toHaveLength(1);
    expect(box().value).toBe('');
    await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_UNSURE_GRACE_MS); });
    expect((await screen.findByRole('alert')).textContent).toContain(OUTBOX_UNSURE_REASON);
    expect(sending()).toHaveLength(0);
    expect(box().value).toBe('hello');
  });

  it('names the files of a message on its way, and picks them again if it is refused', async () => {
    let refuse: (() => void) | null = null;
    open(() => ({ messages: [], working: false }), {
      'POST api/agents/felix/chat/files': () => new Promise((_resolve, reject) => {
        refuse = () => reject(new WorkspaceApiError('Those files could not be uploaded just now. Nothing was sent.', 503, {
          error: 'Those files could not be uploaded just now. Nothing was sent.',
        }));
      }),
    });
    await head();
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    fireEvent.change(document.getElementById('agentChatFile')!, { target: { files: [file] } });
    fireEvent.change(box(), { target: { value: 'look' } });
    fireEvent.submit(document.getElementById('agentChatForm')!);
    const bubble = sending()[0]!;
    expect(bubble.querySelector('.chatfilecaption')!.textContent).toBe('look');
    expect(bubble.querySelector('.chatfileline')!.textContent).toBe('shot.png · 3 B');
    const draft = document.getElementById('agentChatDraft') as HTMLElement;
    expect(draft.hidden).toBe(true);
    // The body is built (big files sent in parts first, note #943) before
    // the request goes, so the request is a beat behind the bubble.
    await waitFor(() => expect(refuse).not.toBeNull());
    await act(async () => { refuse!(); });
    expect((await screen.findByRole('alert')).textContent).toContain('Nothing was sent.');
    expect(box().value).toBe('look');
    await waitFor(() => expect(draft.hidden).toBe(false));
    expect(draft.querySelector('.name')!.textContent).toBe('shot.png');
    expect(sending()).toHaveLength(0);
  });
});

describe('the runtime picker over the chat', () => {
  it('opens from the header and returns to the same transcript', async () => {
    open(() => ({ messages: [chatMessage({ seq: 1, text: 'still here' })], working: false }), {
      'GET api/agents/felix/runtime': () => ({
        cli: 'claude', model: 'Opus', effort: 'high',
        models: [{ value: 'Opus', label: 'Opus', efforts: [{ value: 'high', label: 'high' }] }],
      }),
    });
    await head();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(document.getElementById('agentChatStatus')!);
    expect(await screen.findByRole('heading', { name: 'How Felix thinks' })).toBeTruthy();
    // Back closes the leaf; the transcript behind it was never refetched.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(log().textContent).toContain('still here'));
  });

  it('keeps the unsent draft standing behind the leaf', async () => {
    open(() => ({ messages: [], working: false }), {
      'GET api/agents/felix/runtime': () => ({
        cli: 'claude', model: 'Opus', effort: 'high',
        models: [{ value: 'Opus', label: 'Opus', efforts: [{ value: 'high', label: 'high' }] }],
      }),
    });
    await head();
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'half a thought' } });
    fireEvent.click(document.getElementById('agentChatStatus')!);
    expect(await screen.findByRole('heading', { name: 'How Felix thinks' })).toBeTruthy();
    // The screen is hidden under the leaf, not unmounted: the words survive.
    expect(document.getElementById('screenAgentChat')!.hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(document.getElementById('screenAgentChat')!.hidden).toBe(false));
    expect((document.getElementById('agentChatText') as HTMLTextAreaElement).value).toBe('half a thought');
  });
});

/**
 * The sheet behind the stack grouped its cards by room under a tab row —
 * All, then every room, each room's tab the room's whole view — until rooms
 * left the product (note #843). What stayed is All: one list of every agent,
 * working first, then the fleet's own order.
 */
describe('the agents stack in the composer (notes #581, #713)', () => {
  const crowd = () => state({
    agents: [felix(), agent({ id: 'ben', name: 'Ben' }), agent({ id: 'ada', name: 'Ada' })],
  });
  const elsewhere = () => ({
    ...chatScript('ben', () => ({ messages: [], working: false })),
    'GET api/agents/ben/jobs': () => ({ jobs: [] }),
  });
  const sheet = () => document.getElementById('agentSwitchSheet');
  const stack = () => document.getElementById('agentChatSwitch');
  const openSheet = async () => {
    fireEvent.click(stack()!);
    await waitFor(() => expect(sheet()).toBeTruthy());
    return sheet()!;
  };

  it('stands in a workplace even with nobody to switch to — the way to make one is behind it — and wears this one face then', async () => {
    open(() => ({ messages: [], working: false }));
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    expect([...stack()!.querySelectorAll('.face')]).toHaveLength(1);
    const panel = await openSheet();
    expect(panel.querySelectorAll('#agentSwitchGrid .crow')).toHaveLength(0);
    expect(panel.querySelector('#agentSwitchEmpty #newAgentBtn')).toBeTruthy();
    expect(panel.querySelector('#agentSwitchTabs')).toBeNull();
  });

  it('is not there in a personal workspace with nobody to switch to', async () => {
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix'], () => emptyState({ agents: [felix()] }));
    await head();
    // A door onto a list of the one conversation already open is a control
    // that does nothing dressed as one that does.
    expect(stack()).toBeNull();
  });

  it('wears the faces of the other agents, never the one being read', async () => {
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix'], crowd);
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    expect(stack()!.querySelectorAll('.face')).toHaveLength(2);
    expect(stack()!.getAttribute('aria-label')).toBe('Your agents');
  });

  const faces = (panel: Element) => [...panel.querySelectorAll('#agentSwitchGrid .crow')].map((one) => one.getAttribute('data-agent'));
  const search = () => document.getElementById('agentSwitchSearch') as HTMLInputElement;

  it('opens the agents it promised as their cards, in one list, and never this one', async () => {
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix'], crowd);
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    const panel = await openSheet();
    // No categories over it (note #843): the fleet's own order.
    expect(panel.querySelector('#agentSwitchTabs')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    // Exactly the faces on the button. Felix is the conversation being read,
    // so there is no card for it (the owner, 2026-09-20).
    expect(faces(panel)).toEqual(['ben', 'ada']);
    expect(panel.querySelector('[data-agent="felix"]')).toBeNull();
    // The card the fleet draws everywhere (note #721), and a door like it.
    expect(panel.querySelector('#agentSwitchGrid.plates')).toBeTruthy();
    expect(panel.querySelector('[data-agent="ben"]')!.getAttribute('role')).toBe('button');
  });

  it('lists every agent, whatever room an older record still names', async () => {
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix'], () => state({
      agents: [felix(), agent({ id: 'ben', name: 'Ben' }), agent({ id: 'old', name: 'Old' }), agent({ id: 'gus', name: 'Gus' })],
    }));
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    const panel = await openSheet();
    expect(faces(panel)).toEqual(['ben', 'old', 'gus']);
    expect(screen.queryByText('Math school')).toBeNull();
  });

  it('draws each agent as the card the fleet draws everywhere — state, model, machine and recap (note #721)', async () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix'], () => state({
      agents: [
        felix(),
        agent({ id: 'ben', name: 'Ben', working: true, lastActiveAt: minutesAgo(1) }),
        agent({
          id: 'ada', name: 'Ada', lastActiveAt: minutesAgo(46), model: 'opus', effort: 'xhigh',
          machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
          recap: 'Wrote up the dispatcher interviews.',
        }),
      ],
    }));
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    const panel = await openSheet();
    expect(panel.querySelector('[data-agent="ben"] .livedot')).toBeTruthy();
    expect(panel.querySelector('[data-agent="ada"] .livedot')).toBeNull();
    const ada = panel.querySelector('[data-agent="ada"]')!;
    expect(ada.querySelector('.ctext')!.textContent).toBe('Active 46m ago');
    expect(ada.querySelector('.cruntime')!.textContent).toBe('opus · xhigh');
    expect(ada.querySelector('.cmachine')).toBeTruthy();
    expect(ada.querySelector('.cabout')!.textContent).toBe('Wrote up the dispatcher interviews.');
    // (It was compared with the very card a room's own tab drew for the same
    // agent while there were rooms — note #843.)
  });

  it('leads with the agents working now and holds the places under a finger (note #775)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let busy = ['ben'];
    const world = () => state({
      agents: [
        felix(),
        agent({ id: 'ada', name: 'Ada', working: busy.includes('ada') || undefined }),
        agent({ id: 'gus', name: 'Gus', working: busy.includes('gus') || undefined }),
        agent({ id: 'ben', name: 'Ben', working: busy.includes('ben') || undefined }),
        agent({ id: 'zoe', name: 'Zoë', working: busy.includes('zoe') || undefined }),
      ],
    });
    open(() => ({ messages: [], working: false }), {
      'GET api/agents/live': () => ({ agents: busy.map((id) => ({ id })), recaps: [], sessionLimits: [] }),
    }, ['/chat/felix'], world);
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    const panel = await openSheet();
    // Ben, third in the fleet, leads because he is working; the idle keep the
    // fleet's own order. (He led from the second room's group while there
    // were rooms.)
    expect(faces(panel)).toEqual(['ben', 'ada', 'gus', 'zoe']);
    // The search keeps the same rule.
    fireEvent.change(search(), { target: { value: 'e' } });
    expect(faces(panel)).toEqual(['ben', 'zoe']);
    fireEvent.change(search(), { target: { value: '' } });

    const list = panel.querySelector('#agentSwitchList') as HTMLElement;
    const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); }); };
    const working = (id: string) => Boolean(panel.querySelector(`[data-agent="${id}"] .livedot`));
    // Scrolled down into the list: Zoë starts and Ben stops, and her card
    // says so where it stands — no card changes places.
    list.scrollTop = 240;
    fireEvent.scroll(list);
    busy = ['zoe'];
    await tick();
    await waitFor(() => expect(working('zoe')).toBe(true));
    expect(working('ben')).toBe(false);
    expect(faces(panel)).toEqual(['ben', 'ada', 'gus', 'zoe']);
    // Back at the top, the new order is drawn.
    list.scrollTop = 0;
    fireEvent.scroll(list);
    expect(faces(panel)).toEqual(['zoe', 'ada', 'gus', 'ben']);
    // A finger on the list holds it too, at the top; lifting it lets go.
    fireEvent.touchStart(list, { touches: [{ clientX: 10, clientY: 10 }] });
    busy = ['gus'];
    await tick();
    await waitFor(() => expect(working('gus')).toBe(true));
    expect(faces(panel)).toEqual(['zoe', 'ada', 'gus', 'ben']);
    fireEvent.touchEnd(list, { touches: [] });
    expect(faces(panel)).toEqual(['gus', 'ada', 'ben', 'zoe']);
  });

  it('lists what waits on the reader over the cards, and not over a search (note #721)', async () => {
    open(() => ({ messages: [], working: false }), {
      'GET api/decisions': () => ({
        prs: [{
          id: 'pr-9', number: 9, repoName: 'trading', title: 'Add the order book', body: null, from: 'orders',
          to: 'main', status: 'open', createdAt: 't', decidedAt: null, canDecide: true,
          agentName: 'Ben', agentAvatarUrl: '/faces/ben.png', agentId: 'ben',
        }],
        knowledgeProposals: [{
          id: 'kp-3', number: 3, title: 'Fractions handbook', status: 'open', pages: ['fractions'],
          createdAt: 't', agentName: 'Ada', agentAvatarUrl: '/faces/ada.png', agentId: 'ada', canDecide: true,
        }],
      }),
    }, ['/chat/felix'], crowd);
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    const panel = await openSheet();
    // The workplace's whole queue, read for itself (it was every room's,
    // while the state read carried only one room's — note #843).
    const rows = await waitFor(() => {
      const found = [...panel.querySelectorAll('#agentSwitchDecisions .crow')];
      expect(found).toHaveLength(2);
      return found;
    });
    expect(rows.map((row) => row.querySelector('.name')!.textContent)).toEqual(['Add the order book', 'Fractions handbook']);
    expect(document.getElementById('agentSwitchDecisionsHead')!.textContent).toBe('Waiting for your decision');
    // Above the cards, under their own heading — after the unread replies,
    // which stand hidden with nothing unread.
    const list = panel.querySelector('#agentSwitchList')!;
    expect([...list.children].map((child) => child.id)).toEqual([
      'unreadMessagesHead', 'unreadMessages',
      'agentSwitchDecisionsHead', 'agentSwitchDecisions', 'agentSwitchAgentsHead', 'agentSwitchGrid',
    ]);
    expect(document.getElementById('unreadMessages')!.hidden).toBe(true);
    // A search asks for an agent by name: the queue steps aside for it.
    fireEvent.change(search(), { target: { value: 'ben' } });
    expect(panel.querySelector('#agentSwitchDecisions')).toBeNull();
    fireEvent.change(search(), { target: { value: '' } });
    // And a row is the proposal's door: a page inside the picker (note #722).
    fireEvent.click(await waitFor(() => panel.querySelector('#agentSwitchDecisions .crow')!));
    await waitFor(() => expect(pickerPage()).toBe('/decisions/pr/pr-9'));
    expect(sheet()).toBeTruthy();
  });

  it('shows no queue over the cards when nothing waits', async () => {
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix'], crowd);
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    const panel = await openSheet();
    expect(faces(panel)).toEqual(['ben', 'ada']);
    expect(panel.querySelector('#agentSwitchDecisions')).toBeNull();
    expect(panel.querySelector('#agentSwitchAgentsHead')).toBeNull();
  });

  it('filters the faces by name as the reader types, and Enter opens the first', async () => {
    open(() => ({ messages: [], working: false }), elsewhere(), ['/chat/felix'], crowd);
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    const panel = await openSheet();
    fireEvent.change(search(), { target: { value: 'BE' } });
    expect(faces(panel)).toEqual(['ben']);
    // Escape empties the search first; only an empty one closes the sheet.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(search().value).toBe('');
    expect(faces(panel)).toEqual(['ben', 'ada']);
    expect(sheet()).toBeTruthy();
    fireEvent.change(search(), { target: { value: 'ben' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeTruthy();
    await waitFor(() => expect(sheet()).toBeNull());
  });

  // A search inside one room's tab said "Nobody called … in <room>" and
  // offered to search every room, until rooms left the product (note #843):
  // there is one list to search.
  it('says so when nobody goes by the name typed', async () => {
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix'], crowd);
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    const panel = await openSheet();
    fireEvent.change(search(), { target: { value: 'zed' } });
    expect(faces(panel)).toEqual([]);
    expect(document.getElementById('agentSwitchNone')!.textContent).toBe('Nobody called “zed”.');
    expect(screen.queryByRole('button', { name: /Search all/ })).toBeNull();
    fireEvent.change(search(), { target: { value: '' } });
    expect(document.getElementById('agentSwitchNone')).toBeNull();
    expect(faces(panel)).toEqual(['ben', 'ada']);
  });

  it('plays its way out before it goes — Close, the dim and Escape alike', async () => {
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix'], crowd);
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    const scrim = () => sheet()!.parentElement!;
    const leaves = async (how: () => void) => {
      await openSheet();
      how();
      // Still on screen, sliding away: the exit is played, not skipped…
      expect(sheet()).toBeTruthy();
      expect(scrim().classList.contains('leaving')).toBe(true);
      // …and then it is gone. jsdom plays no animation, so this is the
      // exit's own length; a browser says when its animation has finished
      // (the real-Chrome check, verify-workspace-agent-switch).
      await waitFor(() => expect(sheet()).toBeNull());
    };
    await leaves(() => fireEvent.click(document.getElementById('agentSwitchClose')!));
    await leaves(() => fireEvent.click(scrim()));
    await leaves(() => fireEvent.keyDown(document, { key: 'Escape' }));
  });

  it('just goes when the reader has asked for less movement', async () => {
    // jsdom has no `matchMedia` at all; this reader's browser answers one question yes.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {},
    }));
    try {
      open(() => ({ messages: [], working: false }), {}, ['/chat/felix'], crowd);
      await head();
      await waitFor(() => expect(stack()).toBeTruthy());
      await openSheet();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(sheet()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not summon the shared Back bar over the chat’s own', async () => {
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix'], crowd);
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    await openSheet();
    // A leaf that REPLACES the chat borrows the persistent header for its way
    // out; this one covers part of the screen and draws its own Close, so the
    // chat keeps the one header it has (`chrome/back-context`).
    expect(document.getElementById('pageHead')).toBeNull();
    expect(document.getElementById('screenAgentChat')!.hidden).toBe(false);
  });

  it('walks through a card into that conversation and stands down', async () => {
    open(() => ({ messages: [], working: false }), elsewhere(), ['/chat/felix'], crowd);
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    const panel = await openSheet();
    fireEvent.click(panel.querySelector('[data-agent="ben"]')!);
    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeTruthy();
    // The chat screen is the same route with a different id, so the sheet is
    // still mounted across the jump and has to notice the address moved.
    await waitFor(() => expect(sheet()).toBeNull());
  });

  it('leaves each conversation its own unsent words', async () => {
    const chat = () => ({ messages: [], working: false });
    open(chat, {
      ...chatScript('ben', chat),
      'GET api/agents/ben/jobs': () => ({ jobs: [] }),
    }, ['/chat/felix'], crowd);
    await head();
    const box = () => document.getElementById('agentChatText') as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: 'for Felix only' } });
    await waitFor(() => expect(stack()).toBeTruthy());
    fireEvent.click((await openSheet()).querySelector('[data-agent="ben"]')!);
    // `ChatRoute` keys the screen by agent id (App.tsx), so the whole chat —
    // composer included — is rebuilt for the agent switched to, and reads
    // THAT conversation's remembered draft. Words typed for one agent must
    // never arrive in the box of another.
    await screen.findByRole('heading', { name: 'Ben' });
    expect(box().value).toBe('');
    // And the words left behind are still waiting where they were written.
    fireEvent.click((await openSheet()).querySelector('[data-agent="felix"]')!);
    await screen.findByRole('heading', { name: 'Felix' });
    expect(box().value).toBe('for Felix only');
  });

  it('closes on Escape, leaving the draft where it was', async () => {
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix'], crowd);
    await head();
    await waitFor(() => expect(stack()).toBeTruthy());
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'half a thought' } });
    await openSheet();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(sheet()).toBeNull());
    // Nothing under the sheet was unmounted: the chat kept its own draft.
    expect((document.getElementById('agentChatText') as HTMLTextAreaElement).value).toBe('half a thought');
  });
});

describe('the shell the conversation stands in', () => {
  it('takes the page\u2019s own scroll while the conversation is up, and gives it back after', async () => {
    open(() => ({ messages: [], working: false }), {}, ['/chat/felix']);
    await head();
    await waitFor(() => expect(document.body.classList.contains('agent-chat-open')).toBe(true));
    fireEvent.click(document.querySelector('.chathead .back')!);
    await screen.findByRole('heading', { name: 'Felix' });
    expect(document.body.classList.contains('agent-chat-open')).toBe(false);
  });

  // Note #278: the header and the composer are the shell's furniture. Only
  // what the reader READS may move under them.
  it('puts the transcript and nothing else inside the one scroller', async () => {
    open(() => ({ messages: [chatMessage({ seq: 1, role: 'owner', text: 'hello' })], working: true }));
    await head();
    const pane = document.getElementById('agentChatScroll')!;
    expect(pane.contains(log())).toBe(true);
    expect(pane.contains(document.getElementById('agentChatLive'))).toBe(true);
    expect(pane.contains(document.querySelector('.chathead'))).toBe(false);
    expect(pane.contains(document.getElementById('agentChatForm'))).toBe(false);
  });

  // Note #322: a keyboard painted OVER the page is measured from the visual
  // viewport, and measured AGAIN through its slide. Reading that height lays
  // the page out first, so the shell must still be wearing the last reading
  // when the next one is taken: a shell unset for the read is laid out a
  // whole screen tall in between, and WebKit clamps the transcript's scroll
  // to that taller pane — which is how the newest lines ended up under the
  // composer by exactly a keyboard once the keys were up.
  it('keeps the keyboard\u2019s height on the shell while it takes the next reading', async () => {
    const shellAtRead: string[] = [];
    const listeners = new Set<() => void>();
    let height = 400;
    let offsetTop = 0;
    vi.stubGlobal('visualViewport', {
      get height() {
        shellAtRead.push(document.documentElement.style.getPropertyValue('--chat-shell-height'));
        return height;
      },
      get offsetTop() { return offsetTop; },
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    });
    open(() => ({ messages: [chatMessage({ seq: 1, role: 'agent', text: 'hello' })], working: false }));
    await head();
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--chat-shell-height')).toBe('400px'));
    expect(document.getElementById('agentChatForm')!.dataset.keyboardOverlay).toBe('true');
    const before = shellAtRead.length;
    act(() => { listeners.forEach((fn) => fn()); });
    await waitFor(() => expect(shellAtRead.length).toBeGreaterThan(before));
    expect(shellAtRead.slice(before)).toEqual(shellAtRead.slice(before).map(() => '400px'));
    expect(document.documentElement.style.getPropertyValue('--chat-shell-height')).toBe('400px');

    // A viewport event must place the shell during its delivery. Waiting
    // for another animation frame briefly shows the old size and offset.
    height = 350;
    offsetTop = 24;
    act(() => { listeners.forEach((fn) => fn()); });
    expect(document.documentElement.style.getPropertyValue('--chat-shell-height')).toBe('350px');
    expect(document.getElementById('screenAgentChat')!.style.transform).toBe('translateY(24px)');
    height = window.innerHeight;
    offsetTop = 0;
    act(() => { listeners.forEach((fn) => fn()); });
    expect(document.documentElement.style.getPropertyValue('--chat-shell-height')).toBe('');
    expect(document.getElementById('screenAgentChat')!.style.transform).toBe('');
    expect(document.getElementById('agentChatForm')!.dataset.keyboardOverlay).toBeUndefined();
  });

  // The keyboard's slide is watched, not chased. A phone pans the page under
  // its rising keyboard a frame ahead of every reading it sends, so a shell
  // written to each reading sat a step behind the viewport for the whole
  // slide — the flicker the owner saw on tapping the box. Readings that keep
  // changing are held; the one that stands still is written.
  it('holds the shell through a keyboard\u2019s slide and writes the reading it ends on', async () => {
    const listeners = new Set<() => void>();
    let height = window.innerHeight;
    let offsetTop = 0;
    vi.stubGlobal('visualViewport', {
      get height() { return height; },
      get offsetTop() { return offsetTop; },
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    });
    open(() => ({ messages: [chatMessage({ seq: 1, role: 'agent', text: 'hello' })], working: false }));
    await head();
    const shell = () => document.documentElement.style.getPropertyValue('--chat-shell-height');
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    act(() => { box.focus(); });
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // Four frames of a keyboard on its way up, each announced as a browser
    // would announce it, and none of them written.
    for (const fraction of [0.9, 0.8, 0.7, 0.6]) {
      await frame();
      height = Math.round(window.innerHeight * fraction);
      offsetTop += 10;
      act(() => { listeners.forEach((fn) => fn()); });
      expect(shell()).toBe('');
      expect(document.getElementById('screenAgentChat')!.style.transform).toBe('');
    }
    // The keyboard has landed: the reading stands still, and is written.
    await waitFor(() => expect(shell()).toBe(`${height}px`));
    expect(document.getElementById('screenAgentChat')!.style.transform).toBe('translateY(40px)');
    expect(document.getElementById('agentChatForm')!.dataset.keyboardOverlay).toBe('true');
  });

  // Measured on the owner's iPhone (iOS 18, 2026-09-05): with the keyboard
  // up, `innerHeight` IS the visual viewport's height, the layout viewport
  // (`documentElement.clientHeight`) stays the whole screen, and the page has
  // been SCROLLED to bring the box over the keys — animated with the keyboard
  // itself. Every shell written while it arrived fought that motion and lost
  // (a jump, or a flash); the owner picked the version that leaves it alone.
  // But iOS did not always give that page scroll back when the keyboard went,
  // leaving the composer stranded a keyboard-height above the bottom. The
  // close restores only that scroll, once the whole viewport is back.
  it('leaves an iPhone keyboard alone while it moves, then restores the page after it goes (note #351)', async () => {
    const listeners = new Set<() => void>();
    const layout = 775;
    let inner = layout;
    let height = layout;
    let offsetTop = 0;
    let scrollY = 0;
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(layout);
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => inner });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    vi.stubGlobal('visualViewport', {
      get height() { return height; },
      get offsetTop() { return offsetTop; },
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    });
    try {
      open(() => ({ messages: [chatMessage({ seq: 1, role: 'agent', text: 'hello' })], working: false }));
      await head();
      const shell = () => document.documentElement.style.getPropertyValue('--chat-shell-height');
      const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
      // Spied only from here: the screen's own opening scroll is not what
      // this test is about.
      const scrollTo = vi.fn((_x: number, y: number) => { scrollY = y; });
      Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo });
      act(() => { box.focus(); });
      // The keyboard lands: window and visual viewport both 455, the page
      // scrolled by the phone — and one frame later, the scroll reported as
      // a pan. Nothing is written while either arrives.
      inner = 455; height = 455; scrollY = 320;
      act(() => { listeners.forEach((fn) => fn()); });
      offsetTop = 320;
      act(() => { listeners.forEach((fn) => fn()); });
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(shell()).toBe('');
      expect(document.getElementById('screenAgentChat')!.style.transform).toBe('');
      expect(document.getElementById('agentChatForm')!.dataset.keyboardOverlay).toBeUndefined();
      expect(scrollTo).not.toHaveBeenCalled();
      expect(localStorage.getItem('chat-keyboard')).toBeNull();
      // The keyboard goes. Its geometry is allowed to finish first; only then
      // is the page scroll it left behind returned to the chat's top.
      act(() => { box.blur(); });
      inner = layout; height = layout; offsetTop = 0;
      act(() => { listeners.forEach((fn) => fn()); });
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 0));
      expect(scrollY).toBe(0);
      expect(shell()).toBe('');
      expect(document.getElementById('screenAgentChat')!.style.transform).toBe('');
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: layout });
      Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
    }
  });

  it('places the shell for a keyboard it has met before, before that keyboard moves', async () => {
    const listeners = new Set<() => void>();
    let height = window.innerHeight;
    vi.stubGlobal('visualViewport', {
      get height() { return height; },
      offsetTop: 0,
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    });
    open(() => ({ messages: [chatMessage({ seq: 1, role: 'agent', text: 'hello' })], working: false }));
    await head();
    const shell = () => document.documentElement.style.getPropertyValue('--chat-shell-height');
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    // The first keyboard is met as it arrives, and its geometry remembered
    // once it has stood for the whole of the settling window.
    act(() => { box.focus(); });
    height = 500;
    act(() => { listeners.forEach((fn) => fn()); });
    await waitFor(() => expect(shell()).toBe('500px'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    act(() => { box.blur(); });
    height = window.innerHeight;
    act(() => { listeners.forEach((fn) => fn()); });
    await waitFor(() => expect(shell()).toBe(''));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(JSON.parse(localStorage.getItem('chat-keyboard')!)).toMatchObject({ height: 500, top: 0, width: window.innerWidth, window: window.innerHeight });
    // The second is placed for at the focus itself — nothing has moved yet.
    act(() => { box.focus(); });
    expect(shell()).toBe('500px');
    expect(document.getElementById('agentChatForm')!.dataset.keyboardOverlay).toBe('true');
    // …and a remembered keyboard that never comes is given back, without
    // waiting out the whole window a real one is given.
    await waitFor(() => expect(shell()).toBe(''), { timeout: 550 });
    localStorage.removeItem('chat-keyboard');
  });
});

/**
 * An empty pane is four different things, and the port drew the same nothing
 * for three of them (note #301): a read in flight, a read that failed, and a
 * conversation with nothing in it. A reader could not tell "still loading"
 * from "will never load", which is exactly the question that got asked.
 */
describe('an empty transcript says which empty it is', () => {
  it('holds the shape of a conversation while the opening read is in flight', async () => {
    // A read that never answers: what the reader sees for as long as it takes.
    open(
      () => (new Promise(() => {}) as unknown as WorkspaceChatAnswer),
      {},
      ['/chat/felix'],
      // The fleet row is what says this conversation has been had at all —
      // without it the wait holds the screen and not the turns (below).
      () => state({ agents: [agent({ ...felix(), lastReply: { text: 'here I am', at: 't' } })] }),
    );
    await head();
    const held = await waitFor(() => {
      const turns = [...log().querySelectorAll('.chatwaitmsg')];
      expect(turns.length).toBeGreaterThan(0);
      return turns;
    });
    // Held turns stand in the real rows' own boxes, on both sides, so a column
    // of grey reads as a conversation rather than as a list (note #309).
    expect(held.every((node) => node.classList.contains('chatmsg'))).toBe(true);
    expect(held.some((node) => node.classList.contains('agent'))).toBe(true);
    expect(held.some((node) => node.classList.contains('owner'))).toBe(true);
    // Decoration, all of it: the words come from the one line said once.
    expect(held.every((node) => node.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(log().getAttribute('aria-busy')).toBe('true');
    expect(log().querySelector('.sr-only')!.textContent).toBe('Loading this conversation…');
    // And it is the WAIT that is drawn, not the answer to a conversation with
    // nothing in it — those two used to be indistinguishable.
    expect(log().querySelector('.chatempty')).toBeNull();
  });

  it('holds no turns for a conversation nobody has had yet', async () => {
    // Felix has never replied and has never run a turn, so "Nothing here yet
    // — say hello" is a real possible answer: a wait that drew a
    // conversation over it would promise the one thing the reader came for.
    open(() => (new Promise(() => {}) as unknown as WorkspaceChatAnswer));
    await head();
    await waitFor(() => expect(log().querySelector('.sr-only')).toBeTruthy());
    expect(log().querySelectorAll('.chatwaitmsg').length).toBe(0);
    expect(log().querySelector('.chatempty')).toBeNull();
    expect(log().getAttribute('aria-busy')).toBe('true');
  });

  it('draws nothing at all while the answer may still be immediate', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open(
      () => (new Promise(() => {}) as unknown as WorkspaceChatAnswer),
      {},
      ['/chat/felix'],
      () => state({ agents: [agent({ ...felix(), lastReply: { text: 'here I am', at: 't' } })] }),
    );
    await head();
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT_QUIET_MS - 60); });
    // A flash of loading state is itself the bug (note #287): under a quarter
    // of a second the screen says nothing, because an answer arriving in that
    // window is one the reader experiences as having simply worked.
    expect(log().querySelectorAll('.chatwaitmsg').length).toBe(0);
    expect(log().querySelector('.sr-only')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(log().querySelectorAll('.chatwaitmsg').length).toBeGreaterThan(0);
  });

  it('holds the whole shell while the fleet read is the one still out', async () => {
    // A pasted chat link or a reload: there is no name to pin and nobody to
    // send to yet, so the wait is the screen — and it is the shape of a chat,
    // not a ring in an empty rectangle.
    open(() => ({ messages: [], working: false }), {
      'GET api/state': () => new Promise(() => {}),
    });
    const screen_ = await waitFor(() => {
      const node = document.getElementById('screenAgentChat');
      expect(node?.querySelector('.chatwaitlog')).toBeTruthy();
      return node!;
    });
    expect(screen_.getAttribute('aria-busy')).toBe('true');
    // Header, pane and composer, so the read landing is a fill and not the
    // whole conversation moving to make room for a bar that was not there.
    expect(screen_.querySelector('.chathead')).toBeTruthy();
    expect(screen_.querySelector('.chatpane')).toBeTruthy();
    expect(screen_.querySelector('.chatwaitbar')).toBeTruthy();
    expect(screen_.querySelectorAll('.chatwaitmsg').length).toBeGreaterThan(0);
    // Back is drawn as itself: it works without knowing anything about the
    // agent, and a slow cold open must not shut the reader in with no way out.
    expect(screen_.querySelector('.chathead .back')!.textContent).toContain('Back');
    expect(screen_.querySelector('.chathead .pagehome')).toBeNull();
    expect(screen_.querySelector('[aria-label="Home"]')).toBeNull();
    // THE HELD PANE IS NOT THE REAL PANE. The transcript's scroller is a ref
    // the opening snap waits for; a wait that claimed it would spend that
    // snap on a box about to be thrown away, and the conversation would open
    // at its first message (note #278).
    expect(screen_.querySelector('#agentChatScroll')).toBeNull();
    expect(screen_.querySelector('#agentChatForm')).toBeNull();
    expect(screen_.querySelector('#agentChatLog')).toBeNull();
  });

  it('carries the reason a read failed, and a way to ask again', async () => {
    open(() => { throw new WorkspaceApiError('Chat is not available on this backend yet', 503, {}); });
    await head();
    const failed = await waitFor(() => {
      const node = log().querySelector('#agentChatFailed');
      expect(node).toBeTruthy();
      return node!;
    });
    // The pane holds the reason, because the banner that also carries it fades
    // and every poll after the opening read is deliberately silent.
    expect(failed.textContent).toContain('This conversation could not be loaded.');
    expect(failed.textContent).toContain('Chat is not available on this backend yet');
    expect(failed.getAttribute('role')).toBe('alert');
    expect(failed.querySelector('.chatretry')!.textContent).toBe('Try again');
    // Not "say hello", which would invite a message into a screen that never
    // managed to read what is already there.
    expect(log().textContent).not.toContain('say hello');
    expect(log().querySelector('#loading')).toBeNull();
  });

  it('replaces the failure with the transcript when the reader asks again', async () => {
    let up = false;
    open(() => {
      if (!up) throw new WorkspaceApiError('offline', 503, {});
      return { messages: [chatMessage({ seq: 1, role: 'agent', text: 'here I am' })], working: false };
    });
    await head();
    await waitFor(() => expect(log().querySelector('#agentChatFailed')).toBeTruthy());
    up = true;
    fireEvent.click(log().querySelector('.chatretry')!);
    await waitFor(() => expect(rows().length).toBe(1));
    expect(log().querySelector('#agentChatFailed')).toBeNull();
    expect(log().querySelector('#loading')).toBeNull();
  });

  it('keeps a transcript already read, and its quiet, when a later poll fails', async () => {
    let up = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open(() => {
      if (!up) throw new WorkspaceApiError('offline', 503, {});
      return { messages: [chatMessage({ seq: 1, role: 'agent', text: 'here I am' })], working: false };
    });
    await head();
    await waitFor(() => expect(rows().length).toBe(1));
    up = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_POLL_MS + 100); });
    // Silence is affordable here and only here: there is a conversation on the
    // page to go on reading, so a failed poll must not shout over it.
    expect(rows().length).toBe(1);
    expect(log().querySelector('#agentChatFailed')).toBeNull();
    expect(log().querySelector('#loading')).toBeNull();
  });
  it('paints a keyboard trace over the screen only when asked for one (keyboard-trace.ts)', async () => {
    open(() => ({ messages: [chatMessage({ seq: 1, role: 'agent', text: 'hello' })], working: false }));
    await head();
    expect(document.getElementById('agentChatTrace')).toBeNull();
    localStorage.setItem('chat-keyboard-trace', '1');
    try {
      cleanup();
      open(() => ({ messages: [chatMessage({ seq: 1, role: 'agent', text: 'hello' })], working: false }));
      await head();
      expect(document.getElementById('agentChatTrace')!.textContent).toContain('screenAgentChat');
      const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
      act(() => { box.focus(); });
      act(() => { box.blur(); });
      await waitFor(() => expect(document.getElementById('agentChatTrace')!.textContent).toContain('screenAgentChat blur'), { timeout: 5000 });
      expect(document.getElementById('agentChatTrace')!.textContent).toContain('vh vtop vpage inner sy dvh dsh bsh shell shift anc low');
    } finally {
      localStorage.removeItem('chat-keyboard-trace');
    }
  });
});

/** The agent screen's own reads, for the Back-lands-on-it case. */
function versionScript(): Record<string, Answer> {
  return {
    'GET api/agents/felix/version': () => versionAnswer(),
    'GET api/agents/felix/chat/latest': () => ({ message: null }),
    'GET api/agents/felix/prs': () => ({ prs: [] }),
  };
}
