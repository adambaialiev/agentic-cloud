/**
 * ONE note, on its own screen, end to end against a scripted API: the words,
 * who to ask, the row of agents that could take it on, its margin, its files
 * and what can be done to it — the same things the legacy page's grab()-based
 * tests hold `#screenNote` to, driven the way a person drives it.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceAgentsLiveAnswer,
  WorkspaceNoteRecord,
  WorkspaceStateAnswer,
} from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { LIVE_POLL_MS } from '../../workspace/WorkspaceProvider.js';
import { READ_AGAIN_MS, READ_LIMIT_MS } from '../../ui/read.js';
import { WAIT_HOLD_MS, WAIT_QUIET_MS } from '../../ui/wait.js';
import { WorkspaceApiError, type WorkspaceApi } from '../../api/client.js';
import {
  agent, agentScreenScript, emptyState, homeShelf, note, noteRecord, scriptedApi, versionAnswer, workspaceScript,
  type Answer,
} from '../../test/fixtures.js';

function renderAt(path: string, api: WorkspaceApi) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App api={api} />
    </MemoryRouter>,
  );
}

/** The same shell with a real entry underneath the last address: the only way
 *  a test can tell a note that was OPENED from one that was pasted, which is
 *  the whole of what returning through the parent turns on. */
function renderFrom(paths: string[], api: WorkspaceApi) {
  return render(
    <MemoryRouter initialEntries={paths} initialIndex={paths.length - 1}>
      <App api={api} />
    </MemoryRouter>,
  );
}

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };

/** A workplace with a fleet in it, so the hand-off row has somebody to
 *  draw. The note itself is answered by `api/notes/<n>`. (It was a room's
 *  fleet, while there were rooms — note #843.) */
const workplaceState = (overrides: Partial<WorkspaceStateAnswer> = {}) => emptyState({
  org,
  notes: [],
  noteFiles: true,
  ...overrides,
});

function openNote(record: WorkspaceNoteRecord, state = workplaceState(), extra: Record<string, Answer> = {}) {
  const scripted = scriptedApi({
    ...workspaceScript(() => state),
    [`GET api/notes/${record.number}`]: () => ({ note: record }),
    ...extra,
  });
  renderAt(`/notes/${record.number}?org=o1`, scripted.api);
  return scripted;
}

const body = () => document.getElementById('noteBody')!;
const sub = () => document.getElementById('noteSub')!;

afterEach(() => { vi.useRealTimers(); });

describe('the note as a document', () => {
  it('makes another note it names a door to that note', async () => {
    openNote(noteRecord({
      number: 12,
      title: 'Deploys',
      html: '<p>Deploys</p><p>This is the other half of note #284, not of PR #560.</p>',
    }));
    const link = await waitFor(() => {
      const found = body().querySelector('a.noteref');
      expect(found).toBeTruthy();
      return found as HTMLAnchorElement;
    });
    expect(link.textContent).toBe('note #284');
    // The address a copied link carries — the workplace's, from the one
    // registry. (It named a room too, until rooms left the product — note #843.)
    expect(link.getAttribute('href')).toBe('/notes/284?org=o1');
    // The proposal number beside it is not a note and does not become one.
    expect(body().textContent).toContain('PR #560');
    expect(body().querySelectorAll('a.noteref').length).toBe(1);
  });

  it('renders it under a heading that is not repeated', async () => {
    openNote(noteRecord({
      number: 12, title: 'Deploys', html: '<h1>Deploys</h1><p>The lane moved.</p><ul><li>one</li></ul>',
    }));
    await screen.findByRole('heading', { name: 'Deploys', level: 1 });
    // One `waitFor` around all three, re-querying each time: `KnowledgeHtml`
    // builds these in an effect and replaces the whole subtree when it runs
    // again, so a node held from an earlier poll is a node that may already
    // have been swapped out from under the assertion.
    await waitFor(() => {
      expect(body().querySelector('p')?.textContent).toBe('The lane moved.');
      expect(body().querySelectorAll('h1')).toHaveLength(0);
      expect(body().querySelector('li')?.textContent).toBe('one');
    });
  });

  it('does not print the first line twice when a note has no headings at all', async () => {
    openNote(noteRecord({
      number: 13, title: 'Call the plumber back', html: '<p>Call the plumber back</p><p>He is closed Mondays.</p>',
    }));
    await screen.findByRole('heading', { name: 'Call the plumber back' });
    await waitFor(() => expect([...body().querySelectorAll('p')].map((p) => p.textContent))
      .toEqual(['He is closed Mondays.']));
  });

  it('keeps the opening line when the screen title is only a CUT of it', async () => {
    openNote(noteRecord({
      number: 14, title: 'A very long note about the…', html: '<p>A very long note about the plumbing</p>',
    }));
    await screen.findByRole('heading', { name: 'A very long note about the…' });
    await waitFor(() => expect(body().querySelector('p')!.textContent).toBe('A very long note about the plumbing'));
  });

  it('holds its heading to two lines, and keeps under it what they may cut', async () => {
    const opening = 'A note whose first sentence is longer than two lines of a header can hold whole';
    openNote(noteRecord({ number: 18, title: opening, html: `<p>${opening}</p><p>And more.</p>` }));
    const heading = await screen.findByRole('heading', { name: opening, level: 1 });
    expect(heading.classList.contains('clamped')).toBe(true);
    await waitFor(() => expect([...body().querySelectorAll('p')].map((p) => p.textContent))
      .toEqual([opening, 'And more.']));
  });

  it('is its heading and nothing under it, on a one-line note', async () => {
    openNote(noteRecord({ number: 15, title: 'The wifi code is 4417', html: '<p>The wifi code is 4417</p>' }));
    await screen.findByRole('heading', { name: 'The wifi code is 4417' });
    await waitFor(() => expect(body().textContent).toBe(''));
  });

  it('never lets a note become live markup, whatever it carries', async () => {
    openNote(noteRecord({
      number: 16, title: 'Careful', html: '<p onclick="boom()">Careful</p><script>boom()</script><img src="javascript:boom()">',
    }));
    await screen.findByRole('heading', { name: 'Careful' });
    await waitFor(() => expect(body().querySelector('.kpage')).toBeTruthy());
    expect(body().querySelector('script')).toBeNull();
    // The picture element survives the allowlist; the URL it was pointed at
    // does not, so nothing here becomes a live target.
    expect(body().querySelector('img')!.getAttribute('src')).toBeNull();
    expect(body().innerHTML).not.toContain('onclick');
  });

  it('says so rather than rendering a blank screen for an empty note', async () => {
    openNote(noteRecord({ number: 17, title: 'Empty', html: '' }));
    await screen.findByRole('heading', { name: 'Empty' });
    expect(await screen.findByText('This note is empty.')).toBeTruthy();
  });

  it('says what went wrong rather than sitting on Loading…', async () => {
    const scripted = scriptedApi({
      ...workspaceScript(() => workplaceState()),
      'GET api/notes/99': () => { throw new WorkspaceApiError('No such note.', 404, {}); },
    });
    renderAt('/notes/99?org=o1', scripted.api);
    expect(await screen.findByText('No such note.')).toBeTruthy();
  });
});

/**
 * Notes #308 and #306, which are one screen and one cause.
 *
 * #308 is a note screen holding the word "Loading…" forever, screenshotted to
 * the minute a release went out underneath it: the read was accepted by a
 * process that was on its way out, nothing ever came back, and a screen that
 * draws "Loading…" for a pending promise draws it until the tab is closed.
 *
 * #306 is the other end of the same thing — the screen has no copy of the note
 * to fall back on, so every arrival starts from nothing, and Back flashes the
 * wait on a note the reader was looking at seconds ago.
 */
describe('a note whose read does not come back', () => {
  const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  /** A read whose connection was accepted and then abandoned. */
  const silence = () => new Promise<never>(() => { /* deliberately never settles */ });

  /** Everything the read is given, spent: three attempts and the two pauses. */
  const WHOLE_READ = READ_LIMIT_MS * 3 + READ_AGAIN_MS.reduce((a, b) => a + b, 0);

  it('says the server did not answer, rather than holding Loading… forever', async () => {
    vi.useFakeTimers();
    let answers = false;
    const record = noteRecord({ number: 12, title: 'Deploys', html: '<p>The lane moved.</p>' });
    const scripted = scriptedApi({
      ...workspaceScript(() => workplaceState({ notes: [note({ number: 12, title: 'Deploys' })] })),
      'GET api/notes/12': () => (answers ? { note: record } : silence()),
    });
    renderAt('/notes/12?org=o1', scripted.api);
    await tick(0);

    // While it may still be arriving, nothing is claimed and nothing flashes —
    // but the header already says WHICH note, from the row that opened it.
    await tick(300);
    expect(screen.getByRole('heading', { name: 'Deploys' })).toBeTruthy();
    expect(document.getElementById('noteWait')).toBeTruthy();
    expect(document.getElementById('noteSlow')).toBeNull();

    // Past one attempt it is plainly not arriving, and the screen stops
    // implying that it is.
    await tick(READ_LIMIT_MS);
    expect(document.getElementById('noteSlow')!.textContent)
      .toBe('The server is not answering. Trying again…');

    // Out of attempts: a sentence the reader can act on, and the way to act.
    await tick(WHOLE_READ);
    expect(body().textContent).toContain('The server did not answer.');
    const again = screen.getByRole('button', { name: 'Try again' });

    // And the way out works: the backend is back, and one tap has the note.
    answers = true;
    await act(async () => { fireEvent.click(again); });
    // One tick for the hold on the wait already on screen to lapse — it was
    // drawn half a minute ago, so there is none of it left to serve.
    await tick(1);
    expect(body().textContent).toContain('The lane moved.');
    expect(document.getElementById('noteWait')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('draws no wait for a quick answer, and does not blink away one it has drawn', async () => {
    vi.useFakeTimers();
    let land = () => { /* replaced by the read below */ };
    const record = noteRecord({ number: 12, title: 'Deploys', html: '<p>The lane moved.</p>' });
    const scripted = scriptedApi({
      ...workspaceScript(() => workplaceState()),
      'GET api/notes/12': () => new Promise((resolve) => { land = () => resolve({ note: record }); }),
    });
    renderAt('/notes/12?org=o1', scripted.api);
    await tick(0);

    // While the answer may still be immediate, nothing new is drawn — which is
    // why most readers never see a wait on this screen at all.
    await tick(WAIT_QUIET_MS - 50);
    expect(document.getElementById('noteWait')).toBeNull();
    await tick(100);
    expect(document.getElementById('noteWait')).toBeTruthy();

    // The answer lands right behind it. Snatching it away now would be the
    // flash of loading state note #287 objected to, so it stays for its hold.
    await act(async () => { land(); });
    expect(document.getElementById('noteWait')).toBeTruthy();
    await tick(WAIT_HOLD_MS + 50);
    expect(document.getElementById('noteWait')).toBeNull();
    expect(body().textContent).toContain('The lane moved.');
  });

  it('offers no Try again on an answer that will not change', async () => {
    const scripted = scriptedApi({
      ...workspaceScript(() => workplaceState()),
      'GET api/notes/99': () => { throw new WorkspaceApiError('No such note.', 404, {}); },
    });
    renderAt('/notes/99?org=o1', scripted.api);
    expect(await screen.findByText('No such note.')).toBeTruthy();
    // Asking again would be told the same thing, and a button under a true
    // sentence invites the reader to disbelieve it.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('comes Back to a note it has already read with no wait at all', async () => {
    let reads = 0;
    // `stall` is turned on for the trip BACK, so that anything on screen then
    // is what the held copy put there and nothing else.
    let stall = false;
    const record = noteRecord({
      number: 12, title: 'Deploys', html: '<p>The lane moved.</p>',
      agentId: 'kai', agentName: 'Kai', agentAvatarUrl: '/faces/kai.png',
    });
    const scripted = scriptedApi({
      ...workspaceScript(() => workplaceState({ agents: [agent({ id: 'kai', name: 'Kai' })] })),
      'GET api/notes/12': () => { reads += 1; return stall ? silence() : { note: record }; },
      'GET api/agents/kai/version': () => ({ cliLabel: 'Claude Code', cliUpdateAvailable: false, busy: false, turnCount: 0 }),
      'GET api/agents/kai/chat/latest': () => ({ message: null }),
      'GET api/agents/kai/prs': () => ({ prs: [] }),
    });
    renderAt('/notes/12?org=o1', scripted.api);
    await screen.findByRole('heading', { name: 'Deploys' });

    // Exactly the trip note #306 describes: off to an agent, and back.
    fireEvent.click(within(sub()).getByRole('button', { name: 'Open Kai' }));
    await screen.findByRole('heading', { name: 'Kai' });
    const asked = reads;
    stall = true;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Back' })); });

    // The note is simply there — no aria-busy, no held lines, no flash.
    expect(screen.getByRole('heading', { name: 'Deploys' })).toBeTruthy();
    expect(body().textContent).toContain('The lane moved.');
    expect(document.getElementById('screenNote')!.getAttribute('aria-busy')).toBeNull();
    expect(document.getElementById('noteWait')).toBeNull();
    // And it did go and ask, underneath: served from a copy, never stale.
    expect(reads).toBeGreaterThan(asked);
  });

  it('leaves the note standing when the silent refresh is the thing that fails', async () => {
    vi.useFakeTimers();
    let broken = false;
    const record = noteRecord({
      number: 12, title: 'Deploys', html: '<p>The lane moved.</p>',
      agentId: 'kai', agentName: 'Kai', agentAvatarUrl: '/faces/kai.png',
    });
    const scripted = scriptedApi({
      ...workspaceScript(() => workplaceState({ agents: [agent({ id: 'kai', name: 'Kai' })] })),
      'GET api/notes/12': () => {
        if (broken) throw new WorkspaceApiError('Bad gateway', 502, {});
        return { note: record };
      },
      'GET api/agents/kai/version': () => ({ cliLabel: 'Claude Code', cliUpdateAvailable: false, busy: false, turnCount: 0 }),
      'GET api/agents/kai/chat/latest': () => ({ message: null }),
      'GET api/agents/kai/prs': () => ({ prs: [] }),
    });
    renderAt('/notes/12?org=o1', scripted.api);
    await tick(0);
    expect(screen.getByRole('heading', { name: 'Deploys' })).toBeTruthy();

    fireEvent.click(within(sub()).getByRole('button', { name: 'Open Kai' }));
    await tick(0);
    broken = true;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Back' })); });
    await tick(WHOLE_READ);

    // The reader asked for nothing. Taking the note off the screen to report a
    // hiccup they did not cause is the worse of the two answers.
    expect(body().textContent).toContain('The lane moved.');
    expect(body().textContent).not.toContain('Bad gateway');
  });
});

describe('who to ask about the note', () => {
  it('names it, says who wrote it and when it moved', async () => {
    openNote(noteRecord({
      number: 12, title: 'Deploys', byUser: true, authorName: 'Owner Example',
      updatedAt: new Date(Date.now() - 3600_000).toISOString(),
    }));
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(sub().textContent).toContain('Note #12');
    expect(sub().textContent).toContain('Written by Owner Example');
    expect(sub().textContent).toContain('updated 1h ago');
  });

  it('wears the agent’s face, and the face opens that agent', async () => {
    openNote(
      noteRecord({ number: 12, title: 'Deploys', agentId: 'kai', agentName: 'Kai', agentAvatarUrl: '/faces/kai.png' }),
      workplaceState({ agents: [agent({ id: 'kai', name: 'Kai' })] }),
      {
        'GET api/agents/kai/version': () => ({ cliLabel: 'Claude Code', cliUpdateAvailable: false, busy: false, turnCount: 0 }),
        'GET api/agents/kai/chat/latest': () => ({ message: null }),
        'GET api/agents/kai/prs': () => ({ prs: [] }),
      },
    );
    await screen.findByRole('heading', { name: 'Deploys' });
    const door = within(sub()).getByRole('button', { name: 'Open Kai' });
    expect((door.querySelector('img.face') as HTMLImageElement).getAttribute('src')).toBe('/faces/kai.png');
    fireEvent.click(door);
    expect(await screen.findByRole('heading', { name: 'Kai' })).toBeTruthy();
  });

  it('keeps the picture and offers no door when the fleet no longer has that agent', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', agentName: 'Ghost', agentAvatarUrl: '/faces/ghost.png' }));
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(sub().querySelector('img.face')).toBeTruthy();
    expect(within(sub()).queryByRole('button')).toBeNull();
  });

  it('wears the human author’s face as a door, and the dot when there is no picture', async () => {
    openNote(noteRecord({
      number: 12, title: 'Mine', byUser: true, authorName: 'Owner Example', authorUserId: 'u1',
    }));
    await screen.findByRole('heading', { name: 'Mine' });
    const door = within(sub()).getByRole('button', { name: 'Open Owner Example' });
    expect(door.querySelector('.face.dot')).toBeTruthy();
  });

  it('has no face at all for a note whose agent left none', async () => {
    openNote(noteRecord({ number: 12, title: 'Bare', agentName: 'Ghost' }));
    await screen.findByRole('heading', { name: 'Bare' });
    expect(sub().querySelector('.face')).toBeNull();
    expect(sub().textContent).toContain('Written by Ghost');
  });

  // Note #236, in the owner's words: "I see the note that it is working by an
  // agent. In such case I should see an avatar as door to the agent."
  it('wears the face of the agent that HAS the note, and it opens that agent', async () => {
    openNote(
      noteRecord({
        number: 12, title: 'Deploys', byUser: true, authorName: 'Owner Example', authorUserId: 'u1',
        work: { state: 'working', agentName: 'Kai', agentId: 'kai' },
      }),
      workplaceState({ agents: [agent({ id: 'kai', name: 'Kai', avatarUrl: '/faces/kai.png' })] }),
      agentScreenScript('kai', () => versionAnswer()),
    );
    await screen.findByRole('heading', { name: 'Deploys' });
    // The whole sentence is still one sentence: the face is slipped in front
    // of the words it belongs to, and adds nothing to them.
    expect(sub().textContent).toContain('Note #12 · Working by Kai · Written by Owner Example ·');
    const door = within(sub()).getByRole('button', { name: 'Open Kai' });
    expect((door.querySelector('img.avatar') as HTMLImageElement).getAttribute('src')).toBe('/faces/kai.png');
    // …and it stands ON the work words, not beside the author's portrait at
    // the head of the line, which is the person this note is NOT about.
    expect(door.nextSibling!.textContent).toBe('Working by Kai');
    fireEvent.click(door);
    expect(await screen.findByRole('heading', { name: 'Kai' })).toBeTruthy();
  });

  it('draws the same door on a note an agent has been handed', async () => {
    openNote(
      noteRecord({
        number: 12, title: 'Deploys', byUser: true, authorName: 'Owner Example',
        work: { state: 'handed', agentName: 'Kai', agentId: 'kai' },
      }),
      workplaceState({ agents: [agent({ id: 'kai', name: 'Kai', avatarUrl: '/faces/kai.png' })] }),
    );
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(sub().textContent).toContain('Handed to Kai');
    expect(within(sub()).getByRole('button', { name: 'Open Kai' })).toBeTruthy();
  });

  it('changes an already-open handed note to Working when the live claim arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const record = noteRecord({
      number: 12, title: 'Deploys', byUser: true, authorName: 'Owner Example',
      work: { state: 'handed', agentName: 'Kai', agentId: 'kai' },
    });
    let detail = record;
    let live: WorkspaceAgentsLiveAnswer = {
      agents: [{ id: 'kai', working: true }], recaps: [], sessionLimits: [], noteClaims: [],
    };
    const { calls } = openNote(
      record,
      workplaceState({
        notes: [note({ number: 12, title: 'Deploys', work: record.work })],
        agents: [agent({ id: 'kai', name: 'Kai', working: true, avatarUrl: '/faces/kai.png' })],
      }),
      {
        'GET api/agents/live': () => live,
        'GET api/notes/12': () => ({ note: detail }),
      },
    );
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(sub().textContent).toContain('Handed to Kai');

    live = {
      ...live,
      noteClaims: [{
        id: record.id,
        work: { state: 'working', agentName: 'Kai', agentId: 'kai', expiresAt: 'later' },
      }],
    };
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    await waitFor(() => expect(sub().textContent).toContain('Working by Kai'));
    // Claim arrival is narrow: neither the full Workspace nor the note body
    // was fetched again to repaint one state phrase.
    expect(calls.filter((call) => call.path === 'api/state')).toHaveLength(1);
    expect(calls.filter((call) => call.path === 'api/notes/12')).toHaveLength(1);

    // Release is not guessed from absence: the tick buys one full list read,
    // and the open screen asks only for this note to learn its true fallback.
    detail = { ...record, work: { state: 'unclaimed' } };
    live = { ...live, noteClaims: [] };
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    await waitFor(() => expect(sub().textContent).toContain('Unclaimed'));
    expect(calls.filter((call) => call.path === 'api/state')).toHaveLength(2);
    expect(calls.filter((call) => call.path === 'api/notes/12')).toHaveLength(2);
  });

  it('names a teammate’s agent without a face: there is no screen to land on', async () => {
    openNote(noteRecord({
      number: 12, title: 'Deploys', byUser: true, authorName: 'Owner Example',
      work: { state: 'working', agentName: 'Noah' },
    }));
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(sub().textContent).toContain('Working by Noah');
    expect(sub().querySelector('.workface')).toBeNull();
  });

  it('draws ONE face when the agent that has the note is the one that wrote it', async () => {
    openNote(
      noteRecord({
        number: 12, title: 'Deploys', agentId: 'kai', agentName: 'Kai', agentAvatarUrl: '/faces/kai.png',
        work: { state: 'working', agentName: 'Kai', agentId: 'kai' },
      }),
      workplaceState({ agents: [agent({ id: 'kai', name: 'Kai', avatarUrl: '/faces/kai.png' })] }),
    );
    await screen.findByRole('heading', { name: 'Deploys' });
    // Two portraits of one agent is a duplicate, not a second fact — and the
    // face at the head of the line is already that agent's door.
    expect(within(sub()).getAllByRole('button', { name: 'Open Kai' }).length).toBe(1);
    expect(sub().querySelector('.workface')).toBeNull();
  });
});

/** The clipboard jsdom does not have, and the writes it was handed. */
function clipboard(write: (text: string) => Promise<void> = async () => {}) {
  const writes: string[] = [];
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText: async (text: string) => { writes.push(text); return write(text); } },
  });
  return writes;
}

describe('taking a copy of the words', () => {
  it('copies them — the opening line included — and says it has', async () => {
    const writes = clipboard();
    openNote(noteRecord({
      number: 12, title: 'Wifi', html: '<h2>Wifi</h2><p>The code is 4417.</p>', agentName: 'Kai',
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy note' }));
    // The screen drops the opening line from the body because its own header
    // is showing it. A note pasted into a message has no header above it.
    await waitFor(() => expect(writes).toEqual(['Wifi\n\nThe code is 4417.']));
    expect((await screen.findByRole('alert')).textContent).toContain('Note copied.');
  });

  it('stands in the corner of the words themselves, not in the card of actions', async () => {
    clipboard();
    openNote(noteRecord({ number: 12, title: 'Wifi', agentName: 'Kai', yours: true }));
    const button = await screen.findByRole('button', { name: 'Copy note' });
    // Inside the note's own body, and the last thing in it: a copy is a thing
    // done to THESE words, and it sits where they end.
    expect(body().contains(button)).toBe(true);
    expect(body().lastElementChild!.contains(button)).toBe(true);
    expect(document.getElementById('noteActions')!.contains(button)).toBe(false);
    // A glyph and no label — and a name for a reader who cannot see it.
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')).toBeTruthy();
  });

  it('says so when the clipboard refuses, rather than claiming a copy', async () => {
    clipboard(async () => { throw new Error('Denied'); });
    openNote(noteRecord({ number: 12, title: 'Wifi', agentName: 'Kai' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy note' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not reach the clipboard');
  });

  it('offers no copy of a note with no words in it', async () => {
    clipboard();
    openNote(noteRecord({ number: 12, title: 'Bare', html: '' }));
    await screen.findByRole('heading', { name: 'Bare' });
    expect(screen.queryByRole('button', { name: 'Copy note' })).toBeNull();
  });
});

/**
 * A note said which room it stood in, under its title (note #556), and was
 * read in the room its address named, until rooms left the product (note
 * #843): a note is the workplace's now, one series of numbers. A link copied
 * before then still carries `&room=`, and must open the same note the
 * number names, asked for with no room at all.
 */
describe('an old link that names a room', () => {
  it('opens the note the number names, reads it once with no room, and says nothing of one', async () => {
    const scripted = scriptedApi({
      ...workspaceScript(() => workplaceState()),
      'GET api/notes/12': () => ({ note: noteRecord({ number: 12, title: 'Deploys', html: '<p>The lane moved.</p>' }) }),
    });
    renderAt('/notes/12?org=o1&room=r1', scripted.api);
    await screen.findByRole('heading', { name: 'Deploys' });
    await waitFor(() => expect(body().textContent).toContain('The lane moved.'));
    const reads = scripted.calls.filter((call) => call.path.startsWith('api/notes/12'));
    expect(reads.map((call) => call.path)).toEqual(['api/notes/12']);
    // No room in any request this screen made, in the path or the scope.
    expect(scripted.calls.some((call) => /[?&]room=/.test(call.path) || 'room' in (call.scope ?? {}))).toBe(false);
    expect(document.getElementById('noteRoomSub')).toBeNull();
  });
});

describe('what can be done with the note', () => {
  it('offers Edit only on the reader’s OWN words, and says who to ask otherwise', async () => {
    openNote(noteRecord({ number: 12, title: 'Theirs', agentName: 'Kai', yours: true }));
    await screen.findByRole('heading', { name: 'Theirs' });
    expect(screen.queryByRole('button', { name: 'Edit note' })).toBeNull();
    expect(document.getElementById('noteHint')!.textContent).toContain('ask Kai in its chat');
    // A note one of the reader's OWN agents keeps is still theirs to file.
    expect(screen.getByRole('button', { name: 'Archive note' })).toBeTruthy();
  });

  // Note #638. Nearly half the agent-written notes on an old account were
  // written by an agent that has since been deleted: no name to ask for, and
  // the card said "only its owner's agents can edit it" — which read, to the
  // owner, as a note belonging to another account.
  it('says the author is gone rather than naming another owner', async () => {
    openNote(noteRecord({ number: 12, title: 'Kept', yours: true, agentsCanEdit: true }));
    await screen.findByRole('heading', { name: 'Kept' });
    expect(screen.queryByRole('button', { name: 'Edit note' })).toBeNull();
    const hint = document.getElementById('noteHint')!.textContent!;
    expect(hint).toContain('no longer in this workplace');
    expect(hint).toContain('any of your agents');
    expect(hint).not.toContain('owner’s agents');
    // Still the reader's note: the verbs that were always theirs stay.
    expect(screen.getByRole('button', { name: 'Archive note' })).toBeTruthy();
  });

  it('promises no rewrite at all on a legacy note nobody can edit', async () => {
    openNote(noteRecord({ number: 12, title: 'Kept', yours: true }));
    await screen.findByRole('heading', { name: 'Kept' });
    expect(document.getElementById('noteHint')!.textContent).toContain('cannot be rewritten now');
    expect(screen.getByRole('button', { name: 'Archive note' })).toBeTruthy();
  });

  // Note #637. The reader could archive it, and move it to another room,
  // with nothing on the screen saying it was not theirs — the member who
  // wrote it would find it off their desk and only a timestamp to say why.
  it('offers nothing at all on a note a teammate wrote, and says whose it is', async () => {
    openNote(noteRecord({
      number: 12, title: 'Theirs', byMember: true, memberName: 'Aisha Karimova', authorName: 'Aisha Karimova',
    }));
    await screen.findByRole('heading', { name: 'Theirs' });
    expect(document.getElementById('noteActions')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit note' })).toBeNull();
    const hint = document.getElementById('noteHint')!.textContent!;
    // Named (2026-09-23): a teammate is never an anonymous "member".
    expect(hint).toContain('Aisha Karimova wrote this note');
    expect(hint).toContain('comments above');
  });

  it('offers nothing on a note another member’s agent keeps either', async () => {
    openNote(noteRecord({ number: 12, title: 'Theirs', agentName: 'Kai' }));
    await screen.findByRole('heading', { name: 'Theirs' });
    expect(document.getElementById('noteActions')).toBeNull();
    expect(document.getElementById('noteHint')!.textContent)
      .toContain('Kai, another workplace member’s agent, keeps this note');
  });

  // The margin is what a reader HAS on somebody else's note, so it must not
  // have gone with the buttons.
  it('keeps the margin open on a note that is not the reader’s', async () => {
    openNote(noteRecord({ number: 12, title: 'Theirs', byMember: true }));
    await screen.findByRole('heading', { name: 'Theirs' });
    expect(document.getElementById('noteCommentsCard')).toBeTruthy();
    expect(document.querySelector('#noteCommentsCard .addrow')).toBeTruthy();
  });

  it('offers no way out of the archive on a note that is not the reader’s', async () => {
    openNote(noteRecord({
      number: 12, title: 'Theirs', byMember: true, archivedAt: '2026-09-01T09:00:00Z', attachments: [],
    }));
    await screen.findByRole('heading', { name: 'Theirs' });
    expect(screen.queryByRole('button', { name: 'Restore note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete for good' })).toBeNull();
    expect(document.getElementById('noteHint')!.textContent).toContain('bring it back or delete it');
  });

  // Its own note had Move beside Edit, while there were rooms to move it
  // between (note #843): Edit is the one verb on the words now.
  it('offers Edit on the reader’s own words, with nothing to explain', async () => {
    openNote(noteRecord({ number: 12, title: 'Mine', byUser: true, text: 'Mine' }));
    await screen.findByRole('heading', { name: 'Mine' });
    expect(screen.getByRole('button', { name: 'Edit note' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Move note' })).toBeNull();
    expect(document.getElementById('noteHint')).toBeNull();
  });

  it('archives without a question and returns to the list it came from', async () => {
    // The list as the account really answers it: the note is on it until the
    // archive is accepted, and gone from the next read — which is what the
    // reader must be looking at when they land back on it (note #283).
    let rows = [note({ number: 12, title: 'Mine' })];
    const scripted = scriptedApi({
      ...workspaceScript(() => workplaceState({ notes: rows })),
      'GET api/notes/12': () => ({ note: noteRecord({ number: 12, title: 'Mine', byUser: true }) }),
      'POST api/notes/12/archive': () => { rows = []; return { ok: true, number: 12, title: 'Mine' }; },
    });
    renderFrom(['/notes?org=o1', '/notes/12?org=o1'], scripted.api);
    await screen.findByRole('heading', { name: 'Mine' });
    fireEvent.click(screen.getByRole('button', { name: 'Archive note' }));
    expect(await screen.findByRole('heading', { name: 'Notes' })).toBeTruthy();
    expect(document.getElementById('screenNotes')).toBeTruthy();
    expect(scripted.calls.some((call) => call.path === 'api/notes/12/archive' && call.init?.method === 'POST')).toBe(true);
    // The list the reader is put back on is the list without that note.
    await waitFor(() => expect(document.querySelectorAll('#notesList .crow .name').length).toBe(0));
    // The destination itself makes the result visible; no toast over it.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lands home from an address that was pasted, with nothing of ours beneath', async () => {
    openNote(noteRecord({ number: 12, title: 'Mine', byUser: true }), workplaceState(), {
      'POST api/notes/12/archive': () => ({ ok: true, number: 12, title: 'Mine' }),
    });
    await screen.findByRole('heading', { name: 'Mine' });
    fireEvent.click(screen.getByRole('button', { name: 'Archive note' }));
    await homeShelf();
  });

  it('keeps the archive button alive when archiving fails', async () => {
    openNote(noteRecord({ number: 12, title: 'Mine', byUser: true }), workplaceState(), {
      'POST api/notes/12/archive': () => { throw new WorkspaceApiError('An agent is working from it.', 409, {}); },
    });
    await screen.findByRole('heading', { name: 'Mine' });
    fireEvent.click(screen.getByRole('button', { name: 'Archive note' }));
    expect((await screen.findByRole('alert')).textContent).toContain('An agent is working from it.');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Archive note' }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('a note that is archived', () => {
  const archived = () => noteRecord({
    number: 12, title: 'Filed', byUser: true, text: 'Filed',
    archivedAt: '2026-09-01T09:00:00Z', attachments: [],
  });

  it('offers Restore and Delete, and no Edit even on the reader’s own note', async () => {
    openNote(archived());
    await screen.findByRole('heading', { name: 'Filed' });
    expect(screen.getByRole('button', { name: 'Restore note' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete for good' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit note' })).toBeNull();
    // Read-only is not un-copyable: the words are still there to be taken,
    // in their own corner rather than in this card.
    expect(body().contains(screen.getByRole('button', { name: 'Copy note' }))).toBe(true);
    expect(document.getElementById('noteHint')!.textContent).toContain('Restore it to edit it again.');
  });

  it('says on the header that it is archived, before who wrote it', async () => {
    openNote(archived());
    await screen.findByRole('heading', { name: 'Filed' });
    const line = sub().textContent!;
    expect(line.indexOf('Archived')).toBeLessThan(line.indexOf('Written by'));
  });

  // The notes list, where the note now is — top of it, most recently
  // touched. (It was the room's notes shelf on Home, while there were rooms —
  // note #843.)
  it('restores it and lands on the notes list, where the note now is', async () => {
    let rows: ReturnType<typeof note>[] = [];
    const scripted = scriptedApi({
      ...workspaceScript(() => workplaceState({ notes: rows, notesArchived: rows.length ? 0 : 1 })),
      'GET api/notes/12': () => ({ note: archived() }),
      'DELETE api/notes/12/archive': () => { rows = [note({ number: 12, title: 'Filed' })]; return { ok: true, number: 12, title: 'Filed' }; },
    });
    renderAt('/notes/12?org=o1', scripted.api);
    await screen.findByRole('heading', { name: 'Filed' });
    fireEvent.click(screen.getByRole('button', { name: 'Restore note' }));
    expect(await screen.findByRole('heading', { name: /^Notes/ })).toBeTruthy();
    expect(document.getElementById('screenNotes')).toBeTruthy();
    await waitFor(() => expect([...document.querySelectorAll('#notesList .crow .name')].map((n) => n.textContent))
      .toEqual(['Filed']));
    expect((await screen.findByRole('alert')).textContent).toContain('“Filed” is back in your notes.');
    expect(scripted.calls.some((call) => call.path === 'api/notes/12/archive' && call.init?.method === 'DELETE')).toBe(true);
  });

  it('asks before deleting for good, and does nothing at all if the answer is no', async () => {
    const scripted = openNote(archived());
    await screen.findByRole('heading', { name: 'Filed' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
    const ask = await screen.findByRole('dialog');
    expect(ask.textContent).toContain('Delete “Filed” for good?');
    expect(ask.textContent).toContain('this cannot be undone');
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(scripted.calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
  });

  it('deletes for good and goes back to the archive it came from', async () => {
    openNote(archived(), workplaceState({ notesArchived: 3 }), {
      'DELETE api/notes/12': () => ({ ok: true, number: 12, title: 'Filed' }),
      'GET api/notes/archive': () => ({ notes: [note({ number: 90, title: 'Still filed', archivedAt: 't' })] }),
    });
    await screen.findByRole('heading', { name: 'Filed' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete for good' }));
    expect(await screen.findByRole('heading', { name: 'Archive' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('Deleted “Filed”.');
  });

  it('leaves the archive rather than standing in an empty one', async () => {
    openNote(archived(), workplaceState({ notesArchived: 1, notes: [note({ number: 3, title: 'Still here' })] }), {
      'DELETE api/notes/12': () => ({ ok: true, number: 12, title: 'Filed' }),
    });
    await screen.findByRole('heading', { name: 'Filed' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete for good' }));
    // The archive is gone and so is the door onto it; the notes list is where
    // the reader now belongs.
    expect(await screen.findByRole('heading', { name: 'Notes' })).toBeTruthy();
    expect(document.getElementById('screenNotes')).toBeTruthy();
  });

  it('shows the files it kept, and no way to change them', async () => {
    openNote(noteRecord({
      number: 12, title: 'Filed', byUser: true, archivedAt: '2026-09-01T09:00:00Z',
      attachments: [{ id: 'f1', fileName: 'menu.pdf', contentType: 'application/pdf', sizeBytes: 2048, addedAt: 't' }],
    }));
    await screen.findByRole('heading', { name: 'Filed' });
    expect(screen.getByText('menu.pdf')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Attach a file/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove menu.pdf' })).toBeNull();
  });
});

describe('the row of agents a note can be handed to', () => {
  const fleet = (overrides: Partial<WorkspaceStateAnswer> = {}) => workplaceState({
    agents: [
      agent({
        id: 'kai', name: 'Kai', model: 'Opus', effort: 'high', recap: 'Built the landing page.',
        avatarUrl: '/faces/kai.png', context: { usedPercent: 71, tokens: 1, window: 2, at: '2026-09-02T09:00:00Z' },
      }),
      agent({ id: 'busy', name: 'Oscar', working: true }),
    ],
    ...overrides,
  });

  it('draws each idle agent with its ring, its runtime and what it last did', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), fleet());
    await screen.findByRole('heading', { name: 'Deploys' });
    const row = document.getElementById('noteHands')!;
    const tiles = [...row.querySelectorAll('.hand:not(.createhand)')];
    expect(tiles).toHaveLength(1);
    const tile = tiles[0] as HTMLElement;
    expect(tile.querySelector('.hname')!.textContent).toBe('Kai');
    expect(tile.querySelector('.hharness')!.textContent).toBe('Claude Code');
    expect(tile.querySelector('.hmodel')!.textContent).toBe('Opus');
    expect(tile.querySelector('.heffort')!.textContent).toBe('high');
    expect(tile.querySelector('.habout')!.textContent).toBe('Built the landing page.');
    // The ring is what makes the "reset chat" prefill visible BEFORE the tap.
    expect(tile.querySelector('.ctxring')!.getAttribute('aria-label')).toBe('Context window 71% full');
    expect((tile.querySelector('img.avatar') as HTMLImageElement).getAttribute('src')).toBe('/faces/kai.png');
    // The act, and the run facts, for a reader who cannot see the card.
    const label = tile.querySelector('.handpick')!.getAttribute('aria-label')!;
    expect(label).toContain('Send Kai');
    expect(label).toContain('Claude Code, Opus, high effort');
    expect(label).toContain('a message about this note');
    expect(label).toContain('Built the landing page.');
  });

  it('puts a Create agent plate after the agent choices, and explains both taps', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), fleet());
    await screen.findByRole('heading', { name: 'Deploys' });
    const tiles = [...document.getElementById('noteHands')!.children];
    expect(tiles[tiles.length - 1]!.classList.contains('createhand')).toBe(true);
    expect(document.getElementById('noteHandsHint')!.textContent)
      .toContain('Tap a face for agent details');
    // A note IS passed on — the agent takes the work — so this row keeps the
    // hand-over words the decision screens dropped (note #390).
    expect(document.getElementById('noteHandsHead')!.textContent).toBe('Hand it to an agent');
  });

  it('a candidate\'s card counts its background jobs, as its plate does (note #564)', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), workplaceState({
      agents: [
        agent({ id: 'felix', name: 'Felix', activeJobs: 2 }),
        agent({ id: 'solo', name: 'Solo', activeJobs: 1 }),
        agent({ id: 'quiet', name: 'Quiet' }),
      ],
    }));
    await screen.findByRole('heading', { name: 'Deploys' });
    await waitFor(() => expect(document.querySelectorAll('#noteHands .hand .handpick')).toHaveLength(3));
    const tile = (name: string) => ([...document.querySelectorAll('#noteHands .hand')] as HTMLElement[])
      .find((node) => node.querySelector('.hname')?.textContent?.includes(name))!;
    expect(tile('Felix').querySelector('.hjobs')!.textContent).toBe('2 background jobs');
    expect(tile('Solo').querySelector('.hjobs')!.textContent).toBe('1 background job');
    expect(tile('Quiet').querySelector('.hjobs')).toBeNull();
    // Inside the handoff's own target, and said once to a screen reader.
    expect(tile('Felix').querySelector('.handpick')!.getAttribute('aria-label')).toContain('2 background jobs running');
  });

  // The row offered only the agents of the room being viewed — the room
  // wall (note #85) — until rooms left the product (note #843): every agent
  // reads the workplace's notes, so every one is a candidate, even one the
  // answer still files under another room.
  it('offers every agent of the workplace, whatever room the answer still files it under', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), workplaceState({
      agents: [agent({ id: 'here', name: 'Here' }), agent({ id: 'elsewhere', name: 'Elsewhere' })],
    }));
    await screen.findByRole('heading', { name: 'Deploys' });
    const row = within(document.getElementById('noteHands')!);
    expect(row.getByRole('button', { name: /^Send Here/ })).toBeTruthy();
    expect(row.getByRole('button', { name: /^Send Elsewhere/ })).toBeTruthy();
  });

  it('says the fleet is busy rather than drawing an empty row', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), workplaceState({
      agents: [agent({ id: 'busy', name: 'Oscar', working: true })],
    }));
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(document.getElementById('noteHandsHint')!.textContent)
      .toBe('Your agent is working right now. This row comes back when it is free.');
  });

  it('says it in the plural once more than one agent is mid-turn', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), workplaceState({
      agents: [
        agent({ id: 'a', name: 'One', working: true }),
        agent({ id: 'b', name: 'Two', working: true }),
      ],
    }));
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(document.getElementById('noteHandsHint')!.textContent)
      .toBe('Every agent here is working right now. This row comes back when one is free.');
  });

  it('waits with the row while the agent it needs is being made', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), workplaceState({ agents: [] }));
    await screen.findByRole('heading', { name: 'Deploys' });
    // A workplace with no agents gets the creation plate: making its first
    // one is the useful next act (note #113). (It was a named room's, while
    // there were rooms — note #843.)
    expect(document.querySelector('#noteHands .createhand')).toBeTruthy();
    expect(document.getElementById('noteHandsHint')!.textContent)
      .toBe('Create an agent, then hand it this note when it is ready.');
  });

  it('asks the harness question OVER the screen, not inside the sideways row (note #347)', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), workplaceState({ agents: [] }));
    await screen.findByRole('heading', { name: 'Deploys' });
    fireEvent.click(document.querySelector('#noteHands .createhand')!);

    // The row scrolls sideways, and iPhone Safari draws a fixed backdrop
    // inside a scroller as PART of it — the dialog came up as a sliver
    // clipped to the row. It has to stand outside every scroller: on the
    // body, with the note's own row nowhere above it.
    await screen.findByRole('heading', { name: 'New agent' });
    const dialog = screen.getByRole('dialog', { name: '' });
    expect(within(dialog).getByRole('heading', { name: 'New agent' })).toBeTruthy();
    expect(dialog.closest('#noteHands')).toBeNull();
    expect(dialog.closest('#screenNote')).toBeNull();
    expect(dialog.parentElement?.parentElement).toBe(document.body);

    // Cancelling puts the row back exactly as it was, with the plate still there.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('#noteHands .createhand')).toBeTruthy();
  });

  it('keeps a newly created agent in the handoff row through setup until it can take the note', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = workplaceState({ agents: [] });
    const scripted = openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), state, {
      'POST api/agents': () => {
        setTimeout(() => {
          state.agents = [agent({ id: 'new', name: 'Ada', status: 'setting-up' })];
        }, 2000);
        return { ok: true };
      },
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    fireEvent.click(screen.getByRole('button', { name: 'Create an agent' }));
    await screen.findByRole('heading', { name: 'New agent' });
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Claude Code').closest('button')!);
    await waitFor(() => expect(screen.getByText('Creating agent…')).toBeTruthy());
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    const row = () => within(document.getElementById('noteHands')!);
    expect(row().getByText('Ada')).toBeTruthy();
    expect(row().getByRole('status').textContent).toBe('Setting up');
    expect(row().queryByRole('button', { name: /^Send Ada/ })).toBeNull();
    expect(row().queryByText('Creating agent…')).toBeNull();
    expect(document.getElementById('noteHandsHint')!.textContent).not.toContain('working right now');

    state.agents = [agent({ id: 'new', name: 'Ada', status: 'needs-sign-in' })];
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(row().getByRole('status').textContent).toBe('Signing in');
    state.agents = [agent({ id: 'new', name: 'Ada' })];
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(row().queryByRole('status')).toBeNull();
    fireEvent.click(row().getByRole('button', { name: /^Send Ada/ }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('pick up the note #12');
    const creates = scripted.calls.filter((call) => call.path === 'api/agents' && call.init?.method === 'POST');
    expect(creates).toHaveLength(1);
    // The runtime and nothing else: the agent is the workplace's, and no
    // room travels with it any more (note #843).
    expect(JSON.parse(String(creates[0]!.init!.body))).toEqual({ cli: 'claude' });
    expect(document.getElementById('screenHome')).toBeNull();
  });

  it('draws a setting-up agent the way the fleet list does — a turning ring and a moving meter (note #352)', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), workplaceState({
      agents: [
        agent({ id: 'kai', name: 'Kai', status: 'setting-up' }),
        agent({ id: 'ada', name: 'Ada', status: 'needs-sign-in' }),
        agent({ id: 'ben', name: 'Ben' }),
      ],
    }));
    await screen.findByRole('heading', { name: 'Deploys' });
    const row = within(document.getElementById('noteHands')!);
    const tile = (id: string) => document.querySelector(`#noteHands .hand:has([aria-label^="Open ${id} details"])`)!;

    // The word alone said nothing about whether anything was still happening.
    // The meter is the answer, and it is on the same waypoint home puts it.
    const meters = row.getAllByRole('progressbar');
    expect(meters.map((meter) => meter.getAttribute('aria-label')))
      .toEqual(['Setup step 1 of 3', 'Setup step 2 of 3']);
    expect(tile('Kai').querySelector('.steps span.now.live')).toBeTruthy();
    // Waiting on the reader, so the segment stays still: nothing is moving
    // until they sign in.
    expect(tile('Ada').querySelector('.steps span.now')).toBeTruthy();
    expect(tile('Ada').querySelector('.steps span.now.live')).toBeNull();

    // The machine coming up wears the turning ring instead of a context one —
    // two rings round one face would be two claims.
    expect(tile('Kai').querySelector('.handface .working')).toBeTruthy();
    expect(tile('Kai').querySelector('.handface .ctxring')).toBeNull();
    // An agent that can take the note has no setup left to draw.
    expect(tile('Ben').querySelector('.steps')).toBeNull();
    expect(tile('Ben').querySelector('.handface .ctxring')).toBeTruthy();
  });

  it('opens details for an agent still setting up without offering a handoff', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), workplaceState({
      agents: [agent({ id: 'kai', name: 'Kai', status: 'setting-up' })],
    }), agentScreenScript('kai', () => versionAnswer()));
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(screen.queryByRole('button', { name: /^Send Kai/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Kai details — Setting up' }));
    expect(await screen.findByRole('heading', { name: 'Kai' })).toBeTruthy();
    expect(document.getElementById('screenNoteSend')).toBeNull();
  });

  it('shows nothing at all where an account with no workplace could not use the advert', async () => {
    openNote(
      noteRecord({ number: 12, title: 'Deploys', byUser: true }),
      emptyState({ notes: [], noteFiles: true, agents: [] }),
    );
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(document.getElementById('noteHandsCard')!.hidden).toBe(true);
  });

  it('offers nobody on an archived note — that is work the account has finished with', async () => {
    openNote(noteRecord({
      number: 12, title: 'Filed', byUser: true, archivedAt: '2026-09-01T09:00:00Z',
    }), fleet());
    await screen.findByRole('heading', { name: 'Filed' });
    expect(document.getElementById('noteHandsCard')!.hidden).toBe(true);
    expect(document.getElementById('noteHandsHead')!.hidden).toBe(true);
  });

  it('stops offering a note around once an agent already has it', async () => {
    openNote(noteRecord({
      number: 12, title: 'Taken', byUser: true, work: { state: 'handed', agentName: 'Kai' },
    }), fleet());
    await screen.findByRole('heading', { name: 'Taken' });
    expect(document.getElementById('noteHandsCard')!.hidden).toBe(true);
    expect(sub().textContent).toContain('Handed to Kai');
  });

  it('offers it again once its proposal has stopped moving', async () => {
    openNote(noteRecord({
      number: 12, title: 'Stuck', byUser: true,
      work: { state: 'proposal', proposalNumber: 9, proposalStatus: 'conflict' },
    }), fleet());
    await screen.findByRole('heading', { name: 'Stuck' });
    expect(document.getElementById('noteHandsCard')!.hidden).toBe(false);
  });

  it('opens the agent from its face without handing over the note', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), fleet(), {
      'GET api/agents/kai/version': () => ({ cliLabel: 'Claude Code', cliUpdateAvailable: false, busy: false, turnCount: 0 }),
      'GET api/agents/kai/chat/latest': () => ({ message: null }),
      'GET api/agents/kai/prs': () => ({ prs: [] }),
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Kai details' }));
    expect(await screen.findByRole('heading', { name: 'Kai' })).toBeTruthy();
    expect(document.getElementById('screenNoteSend')).toBeNull();
  });
});

describe('the subscriptions the note will be worked from', () => {
  const codex = {
    seatId: 'c1', provider: 'codex', label: 'ChatGPT · 25 Sep 2026', planText: 'Prolite', selected: true,
    windows: [{ usedPercent: 8, percentText: '8', trackText: 'usage' }],
  };
  const claude = {
    seatId: 'k1', provider: 'claude', label: 'Claude', planText: 'Max 20x', selected: true,
    windows: [{ usedPercent: 66, percentText: '66', trackText: '5 hours' }],
  };
  const withSeats = (seatUsage: unknown[], overrides: Partial<WorkspaceStateAnswer> = {}) => workplaceState({
    org: { ...org, seatUsage } as WorkspaceStateAnswer['org'],
    agents: [agent({ id: 'kai', name: 'Kai' })],
    ...overrides,
  });

  it('is the same sideways row of plates Home draws, standing above the agents', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), withSeats([codex, claude]));
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(screen.getByRole('heading', { name: 'Subscriptions' })).toBeTruthy();
    const strip = document.getElementById('noteSeats')!;
    // No card around it and the door as the LAST plate — the shape note #345
    // gave the row on Home, which is the row this note asked for (#348).
    expect(strip.closest('.card')).toBeNull();
    expect([...strip.children].map((node) => node.className)).toEqual(['seatcard', 'seatcard', 'seatadd']);
    expect(within(strip).getByRole('button', { name: /Add sub/ }).querySelector('.icon')).toBeTruthy();
    // Named by product alone, ChatGPT exactly as Claude — the sign-in date in
    // the stored label is the seat screen's to show (note #667).
    expect([...strip.querySelectorAll('.seathead .label')].map((node) => node.textContent))
      .toEqual(['ChatGPT', 'Claude']);
    expect(within(strip).getByText('66%')).toBeTruthy();
    // A seat is what the agent below it spends, so it stands above them.
    expect(strip.compareDocumentPosition(document.getElementById('noteHands')!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('opens the subscription a plate is tapped on', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), withSeats([claude]), {
      'GET api/org/seats': () => ({ seats: [{ ...claude, status: 'active', createdAt: '2026-09-01T00:00:00Z', label: 'Claude · 1 Sep' }], available: [] }),
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    fireEvent.click(document.getElementById('noteSeats')!.querySelector('.seatcard') as HTMLElement);
    expect(await screen.findByRole('heading', { name: 'Claude · 1 Sep' })).toBeTruthy();
  });

  it('keeps its place on a note an agent already holds, where no hand row is drawn', async () => {
    openNote(
      noteRecord({
        number: 12, title: 'Deploys', byUser: true,
        work: { state: 'working', agentId: 'kai', agentName: 'Kai' },
      }),
      withSeats([codex, claude]),
    );
    await screen.findByRole('heading', { name: 'Deploys' });
    // The hand row is gone — the note is somebody's job — and the strip is
    // still answering a live question: how fast the agent that HAS it spends.
    expect(document.getElementById('noteHandsCard')!.hidden).toBe(true);
    expect(document.getElementById('noteSeats')!.querySelectorAll('.seatcard')).toHaveLength(2);
  });

  it('says so above the row, and still offers the door, with no sign-ins yet', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), withSeats([]), {
      'GET api/org/seats': () => ({ seats: [], available: [] }),
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    const strip = document.getElementById('noteSeats')!;
    expect(strip.querySelector('.empty')).toBeNull();
    expect(document.getElementById('noteSeatsSection')!.querySelector('.empty')!.textContent)
      .toContain('No sign-ins here yet');
    expect([...strip.children].map((node) => node.className)).toEqual(['seatadd']);
    // The answer to the create-an-agent tile refusing for want of a seat.
    fireEvent.click(screen.getByRole('button', { name: /Add sub/ }));
    expect(await screen.findByRole('heading', { name: 'Your subscriptions' })).toBeTruthy();
  });

  it('draws nothing at all outside a workplace', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), emptyState({
      notes: [], noteFiles: true,
    }));
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(screen.queryByRole('heading', { name: 'Subscriptions' })).toBeNull();
    expect(document.getElementById('noteSeatsSection')!.hidden).toBe(true);
    expect(document.getElementById('noteSeats')).toBeNull();
  });
});

describe('the message a note hands an agent', () => {
  const withKai = (context?: { usedPercent: number }) => workplaceState({
    agents: [agent({
      id: 'kai', name: 'Kai',
      ...(context ? { context: { ...context, tokens: 1, window: 2, at: '2026-09-02T09:00:00Z' } } : {}),
    })],
  });

  const openSend = async (state = withKai(), record = noteRecord({ number: 12, title: 'Deploys', byUser: true }), extra: Record<string, Answer> = {}) => {
    const scripted = openNote(record, state, extra);
    await screen.findByRole('heading', { name: 'Deploys' });
    fireEvent.click(document.querySelector('.hand .handpick') as HTMLElement);
    await screen.findByRole('heading', { name: 'Kai' });
    return scripted;
  };

  it('opens on the agent, its Workspace conversation, and keeps Send below the box', async () => {
    await openSend();
    expect(document.getElementById('noteSendSub')!.textContent).toBe('Workspace conversation');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(document.getElementById('noteSendForm')!.contains(send)).toBe(true);
    expect((send.previousElementSibling as HTMLElement)?.classList.contains('card')).toBe(true);
    expect(document.querySelector('#pageHead button:not(#pageBack)')).toBeNull();
    expect((document.getElementById('noteSendText') as HTMLTextAreaElement).value)
      .toBe('pick up the note #12');
    // No footer under Send (note #618): the screen is the box and the button.
    expect(document.getElementById('noteSendHint')).toBeNull();
  });

  it('asks for a fresh chat first when the agent is carrying a measured fill', async () => {
    await openSend(withKai({ usedPercent: 61 }));
    expect((document.getElementById('noteSendText') as HTMLTextAreaElement).value)
      .toBe('reset chat and pick up the note #12');
  });

  it('leaves the box a box: the prefill is a suggestion the reader can rewrite', async () => {
    const scripted = await openSend(withKai(), noteRecord({ number: 12, title: 'Deploys', byUser: true }), {
      'POST api/notes/12/handoff': () => ({ ok: true, name: 'Kai', work: { state: 'handed', agentName: 'Kai' } }),
    });
    const box = document.getElementById('noteSendText') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'read #12 and tell me what it needs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(scripted.calls.some((call) => call.path === 'api/notes/12/handoff')).toBe(true));
    const sent = scripted.calls.find((call) => call.path === 'api/notes/12/handoff')!;
    expect(JSON.parse(String(sent.init!.body)))
      .toEqual({ agentId: 'kai', message: 'read #12 and tell me what it needs' });
  });

  it('paints the note’s new state from the answer, before any poll', async () => {
    await openSend(withKai(), noteRecord({ number: 12, title: 'Deploys', byUser: true }), {
      'POST api/notes/12/handoff': () => ({ ok: true, name: 'Kai', work: { state: 'handed', agentName: 'Kai' } }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Kai is on it — the answer lands in its chat.');
    // Back on the note, which already says who has it — no flash of Unclaimed.
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(sub().textContent).toContain('Handed to Kai');
    expect(document.getElementById('noteHandsCard')!.hidden).toBe(true);
  });

  it('keeps the words when the send fails, and says why', async () => {
    await openSend(withKai(), noteRecord({ number: 12, title: 'Deploys', byUser: true }), {
      'POST api/notes/12/handoff': () => { throw new WorkspaceApiError('Kai is working right now.', 409, {}); },
    });
    const box = document.getElementById('noteSendText') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'take this on' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Kai is working right now.');
    expect((document.getElementById('noteSendText') as HTMLTextAreaElement).value).toBe('take this on');
  });

  it('will not send an empty box, and says so by being unpressable', async () => {
    await openSend();
    fireEvent.change(document.getElementById('noteSendText')!, { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('holds the tap through an explicit safe-to-retry backend restart', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let attempts = 0;
    await openSend(withKai(), noteRecord({ number: 12, title: 'Deploys', byUser: true }), {
      'POST api/notes/12/handoff': () => {
        attempts += 1;
        if (attempts === 1) throw new WorkspaceApiError('Restarting.', 503, { code: 'restarting' });
        return { ok: true, name: 'Kai', work: { state: 'handed', agentName: 'Kai' } };
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(attempts).toBe(2);
    expect((await screen.findByRole('alert')).textContent).toContain('Kai is on it');
  });

  it('closes on Back without spending a history entry', async () => {
    await openSend();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(document.getElementById('screenNoteSend')).toBeNull();
  });
});

describe('the note’s margin', () => {
  const withThread = () => noteRecord({
    number: 12, title: 'Deploys', byUser: true,
    comments: [
      { text: '<p>First, from a while ago.</p>', createdAt: '2026-09-01T09:00:00Z', agentName: 'Kai', agentAvatarUrl: '/faces/kai.png', agentRuntime: { cli: 'claude', model: 'Opus', effort: 'high' } },
      { text: 'A plain old line\nwith a break', createdAt: '2026-09-02T09:00:00Z', byPerson: true, userName: 'Owner Example', authorUserId: 'u1' },
    ],
  });

  it('leads with the most recent remark, and signs each one', async () => {
    openNote(withThread());
    await screen.findByRole('heading', { name: 'Deploys' });
    const remarks = [...document.getElementById('noteComments')!.querySelectorAll('.ncmt')];
    expect(remarks).toHaveLength(2);
    expect(remarks[0]!.textContent).toContain('Owner Example');
    expect(remarks[1]!.textContent).toContain('Kai');
    // The harness, model and effort it will answer with, under its name.
    expect(remarks[1]!.querySelector('.cruntime')!.textContent).toBe('Claude Code · Opus · high');
    // A plain-text remark keeps its line breaks through the `.plain` fallback.
    await waitFor(() => expect(remarks[0]!.querySelector('.ctext.plain')).toBeTruthy());
  });

  /**
   * Note #705, the owner: "how is it possible that comment was created by
   * Adam B? Is it me?" The agent that wrote it had been deleted, and the line
   * signed it with its driver alone. It now says an agent wrote it.
   */
  it('signs a deleted agent’s remark as that agent, never as its person', async () => {
    openNote(noteRecord({
      number: 12, title: 'Redirect', byUser: true,
      comments: [
        { text: '<p>From before the ledger.</p>', createdAt: '2026-09-01T09:00:00Z', formerAgent: true, userName: 'Adam B' },
        {
          text: '<p>Done and live.</p>', createdAt: '2026-09-30T12:00:00Z',
          formerAgent: true, agentName: 'Willow', agentAvatarUrl: '/faces/willow.png', userName: 'Adam B',
        },
      ],
    }));
    await screen.findByRole('heading', { name: 'Redirect' });
    const remarks = [...document.getElementById('noteComments')!.querySelectorAll('.ncmt')];
    const signed = remarks.map((remark) => remark.querySelector('.commentby')!.textContent ?? '');
    expect(signed[0]).toMatch(/^Willow \(Adam B\), no longer here · /);
    expect(signed[1]).toMatch(/^Adam B’s agent, no longer here · /);
    // Willow keeps her face, which opens nothing: there is no agent behind it.
    expect(remarks[0]!.querySelector('img.face')!.getAttribute('src')).toBe('/faces/willow.png');
    expect(remarks[0]!.querySelector('.facebtn')).toBeNull();
    // And the person is never drawn as the author: no face of theirs, no door.
    expect(remarks[1]!.querySelector('.face')).toBeNull();
  });

  it('offers the box on a note nobody has remarked on — the margin is two-way', async () => {
    openNote(noteRecord({ number: 12, title: 'Quiet', byUser: true }));
    await screen.findByRole('heading', { name: 'Quiet' });
    expect(screen.getByRole('button', { name: /Write a comment/ })).toBeTruthy();
  });

  it('keeps the archive read-only: no box, and an empty thread hides whole', async () => {
    openNote(noteRecord({ number: 12, title: 'Filed', byUser: true, archivedAt: '2026-09-01T09:00:00Z' }));
    await screen.findByRole('heading', { name: 'Filed' });
    expect(screen.queryByRole('button', { name: /Write a comment/ })).toBeNull();
    expect(document.getElementById('noteCommentsCard')!.hidden).toBe(true);
  });

  it('sends the remark and redraws the thread from what the server holds', async () => {
    const scripted = openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }), workplaceState(), {
      'POST api/notes/12/comments': () => ({
        ok: true,
        comments: [{ text: '<p>Called them.</p>', createdAt: '2026-09-02T10:00:00Z', byPerson: true, userName: 'Owner Example' }],
      }),
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    fireEvent.click(screen.getByRole('button', { name: /Write a comment/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Write a comment' }), { target: { value: 'Called them.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.querySelectorAll('#noteComments .ncmt')).toHaveLength(1));
    const sent = scripted.calls.find((call) => call.path === 'api/notes/12/comments')!;
    expect(JSON.parse(String(sent.init!.body))).toEqual({ text: 'Called them.' });
    // The box collapses again, so what the reader sees is what the server holds.
    expect(screen.getByRole('button', { name: /Write a comment/ })).toBeTruthy();
  });

  /**
   * Note #647: the person who wrote a remark can take it back — from inside
   * Edit, on the owner's follow-up, so the resting thread carries one quiet
   * word on the reader's own remark and no red on any of them. The question
   * in front of it is the whole guard (a withdrawn remark cannot be restored)
   * and what repaints is the thread the server answers with, not a row hidden
   * locally.
   */
  it('takes back the reader’s own remark, behind one question, and repaints the thread', async () => {
    const mine = {
      id: 'c-own', text: '<p>Mine.</p>', editableText: 'Mine.', createdAt: '2026-09-02T09:00:00Z',
      byPerson: true, self: true, userName: 'Owner Example', authorUserId: 'u1',
    };
    const theirs = { id: 'c-kai', text: '<p>Kai’s.</p>', createdAt: '2026-09-01T09:00:00Z', agentName: 'Kai' };
    const scripted = openNote(
      noteRecord({ number: 12, title: 'Deploys', byUser: true, comments: [theirs, mine] }),
      workplaceState(),
      { 'DELETE api/notes/12/comments/c-own': () => ({ ok: true, comments: [theirs] }) },
    );
    await screen.findByRole('heading', { name: 'Deploys' });
    // One remark is the reader's own and carries Edit; the agent's carries
    // nothing. Delete is on neither until Edit is pressed.
    expect(screen.getAllByRole('button', { name: 'Edit your comment' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Delete your comment' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit your comment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete your comment' }));
    // Nothing has gone yet: the question stands between the tap and the loss.
    expect(screen.getByRole('dialog').textContent).toContain('cannot be undone');
    expect(scripted.calls.some((call) => call.path === 'api/notes/12/comments/c-own')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(document.querySelectorAll('#noteComments .ncmt')).toHaveLength(1));
    const sent = scripted.calls.find((call) => call.path === 'api/notes/12/comments/c-own')!;
    expect(sent.init?.method).toBe('DELETE');
    expect(document.querySelector('#noteComments .ncmt .ctext')!.textContent).toContain('Kai');
    expect(screen.queryByRole('button', { name: 'Delete your comment' })).toBeNull();
  });

  it('keeps the question answerable with no: the remark stays and nothing is sent', async () => {
    const mine = {
      id: 'c-own', text: '<p>Mine.</p>', editableText: 'Mine.', createdAt: '2026-09-02T09:00:00Z',
      byPerson: true, self: true, userName: 'Owner Example', authorUserId: 'u1',
    };
    const scripted = openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true, comments: [mine] }));
    await screen.findByRole('heading', { name: 'Deploys' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit your comment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete your comment' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // No is no: the editor is still open, with the words as they were.
    expect((screen.getByRole('textbox', { name: 'Edit comment' }) as HTMLTextAreaElement).value).toBe('Mine.');
    expect(document.querySelectorAll('#noteComments .ncmt')).toHaveLength(1);
    expect(scripted.calls.some((call) => call.path === 'api/notes/12/comments/c-own')).toBe(false);
  });

  /**
   * A note is read more than once while it is open — after an edit is saved,
   * on a Try again, when its lease ends under it — and each read answers the
   * note as it stood when it was ASKED. Under a slow enough machine a read
   * used to land after a remark had been posted and paint the thread without
   * it; on CI that showed up as this file's own flake. (The read in flight
   * was the opening read's twin, while the room it was looked up in had to
   * travel from the state — note #843; the reread after an edit is the one
   * left to stand in for it.)
   */
  it('keeps a remark a read already in flight would otherwise wipe', async () => {
    const record = noteRecord({ number: 12, title: 'Deploys', byUser: true, text: 'Deploys' });
    let reads = 0;
    let land: (() => void) | null = null;
    const scripted = scriptedApi({
      ...workspaceScript(() => workplaceState()),
      'GET api/notes/12': () => {
        reads += 1;
        // The reread after the edit is held open until the remark has been posted.
        if (reads === 1) return { note: record };
        return new Promise((resolve) => { land = () => resolve({ note: record }); });
      },
      'PUT api/notes/12': () => ({ ok: true, note: note({ number: 12, title: 'Deploys' }), title: 'Deploys' }),
      'POST api/notes/12/comments': () => ({
        ok: true,
        comments: [{ text: '<p>Called them.</p>', createdAt: '2026-09-02T10:00:00Z', byPerson: true, userName: 'Owner Example' }],
      }),
    });
    renderAt('/notes/12?org=o1', scripted.api);
    await screen.findByRole('heading', { name: 'Deploys' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await screen.findByRole('heading', { name: 'Edit note' });
    fireEvent.change(document.getElementById('noteText')!, { target: { value: 'Deploys, again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('heading', { name: 'Deploys' });
    await waitFor(() => expect(land).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Write a comment/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Write a comment' }), { target: { value: 'Called them.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.querySelectorAll('#noteComments .ncmt')).toHaveLength(1));
    land!();
    // The stale answer is dropped rather than painted: the remark stands.
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelectorAll('#noteComments .ncmt')).toHaveLength(1);
    expect(document.querySelector('#noteComments .ncmt .ctext')!.textContent).toContain('Called them.');
  });

  /**
   * Note #518: a remark on a note addresses nobody. Typing `@` used to open
   * the room's idle roster under the box and send the ids it matched; now the
   * name is ordinary text, the body is the words alone, and the agent finds
   * the margin when it next reads the note.
   */
  it('takes an @ as ordinary words, offering nobody and addressing nobody', async () => {
    const scripted = openNote(
      noteRecord({ number: 12, title: 'Deploys', byUser: true }),
      workplaceState({
        agents: [
          agent({ id: 'kai', name: 'Kai' }),
          agent({ id: 'busy', name: 'Oscar', working: true }),
        ],
      }),
      { 'POST api/notes/12/comments': () => ({ ok: true, comments: [] }) },
    );
    await screen.findByRole('heading', { name: 'Deploys' });
    fireEvent.click(screen.getByRole('button', { name: /Write a comment/ }));
    const box = screen.getByRole('textbox', { name: 'Write a comment' });
    // Kai is idle — exactly the agent the picker used to offer.
    fireEvent.change(box, { target: { value: '@Kai please look' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(scripted.calls.some((call) => call.path === 'api/notes/12/comments')).toBe(true));
    const sent = scripted.calls.find((call) => call.path === 'api/notes/12/comments')!;
    expect(JSON.parse(String(sent.init!.body))).toEqual({ text: '@Kai please look' });
  });
});

describe('the files card, on the note screen', () => {
  const signed = (name: string) => ({
    url: `https://signed.example/${name}`, fileName: name,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  });

  it('shows a photo AS a photo, everything else as a row, and mints URLs at tap time', async () => {
    const scripted = openNote(noteRecord({
      number: 12, title: 'Deploys', byUser: true,
      attachments: [
        { id: 'p1', fileName: 'shot.png', contentType: 'image/png', sizeBytes: 2048, addedAt: 't', byUser: true },
        { id: 'd1', fileName: 'menu.pdf', contentType: 'application/pdf', sizeBytes: 4096, addedAt: 't' },
      ],
    }), workplaceState(), {
      'GET api/notes/12/files/p1?preview=1': () => signed('shot.png'),
      'GET api/notes/12/files/d1?preview=1': () => signed('menu.pdf'),
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    // A photograph fetches its own URL to draw itself; a document waits for a tap.
    await waitFor(() => expect(document.querySelector('.notephoto img')!.getAttribute('src'))
      .toBe('https://signed.example/shot.png'));
    expect(scripted.calls.some((call) => call.path.startsWith('api/notes/12/files/d1'))).toBe(false);
    expect(screen.getByText('shot.png · 2 KB · you attached this')).toBeTruthy();
    expect(screen.getByText('4 KB')).toBeTruthy();
    // Each attachment is one slide, with the photo and its caption together.
    const slides = [...document.getElementById('noteFiles')!.children];
    expect(slides).toHaveLength(2);
    expect(slides[0]!.querySelectorAll('.notephoto, .caprow')).toHaveLength(2);

    // A PDF opens IN the Workspace now (note #403), on a URL minted at the
    // tap and signed to be drawn rather than saved — the browser's own
    // handler is no longer where a document goes.
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    fireEvent.click(screen.getByText('menu.pdf').closest('.crow') as HTMLElement);
    const viewer = await screen.findByRole('dialog');
    expect(viewer.id).toBe('pdfViewer');
    expect(document.getElementById('pdfViewerName')!.textContent).toBe('menu.pdf');
    expect((document.getElementById('pdfViewerFrame') as HTMLIFrameElement).getAttribute('src'))
      .toBe('https://signed.example/menu.pdf#view=FitH');
    expect(opened).not.toHaveBeenCalled();
    expect(scripted.calls.some((call) => call.path === 'api/notes/12/files/d1?preview=1')).toBe(true);
  });

  /** Every file the screen hands the browser to save: the anchor it clicks,
   *  by href and download name. jsdom would otherwise try to navigate on the
   *  click and say so on stderr. */
  const savedFiles = () => {
    const list: { href: string; download: string }[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      list.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
    return { list, restore: () => spy.mockRestore() };
  };

  /**
   * Note #690: a picture opened full screen from a note had no way to be
   * kept — the viewer's head held its name and Close, and the note itself
   * offered no Download either. Each picture now carries one, and it saves
   * the picture ON SCREEN (the second of two here), on a URL signed for
   * SAVING minted at the press — not the preview the viewer is drawing.
   */
  it('offers Download on a picture in the viewer, saving the one on screen (note #690)', async () => {
    const saved = savedFiles();
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    const scripted = openNote(noteRecord({
      number: 12, title: 'Deploys', byUser: true,
      attachments: [
        { id: 'p1', fileName: 'one.png', contentType: 'image/png', sizeBytes: 2048, addedAt: 't' },
        { id: 'p2', fileName: 'two.png', contentType: 'image/png', sizeBytes: 2048, addedAt: 't' },
      ],
    }), workplaceState(), {
      'GET api/notes/12/files/p1?preview=1': () => signed('preview-one.png'),
      'GET api/notes/12/files/p2?preview=1': () => signed('preview-two.png'),
      'GET api/notes/12/files/p1': () => signed('one.png'),
      'GET api/notes/12/files/p2': () => signed('two.png'),
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    await waitFor(() => expect(document.querySelectorAll('.notephoto img')).toHaveLength(2));
    for (const img of document.querySelectorAll('.notephoto img')) fireEvent.load(img);
    fireEvent.click(screen.getByRole('button', { name: 'Open one.png' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(document.getElementById('imageViewerName')!.textContent).toBe('two.png');
    // Nothing is minted for saving until the press.
    expect(scripted.calls.some((call) => call.path === 'api/notes/12/files/p2')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Download two.png' }));
    await waitFor(() => expect(saved.list).toEqual([{ href: 'https://signed.example/two.png', download: 'two.png' }]));
    expect(scripted.calls.some((call) => call.path === 'api/notes/12/files/p1')).toBe(false);
    // Through an anchor in this tab, never a window opened after the await:
    // Safari refuses that popup in silence (note #552).
    expect(opened).not.toHaveBeenCalled();
    // Saving is not closing: the reader is still looking at the picture.
    expect(document.getElementById('imageViewer')).toBeTruthy();
    saved.restore();
  });

  it('offers Download on a PDF in the document viewer too (note #690)', async () => {
    const saved = savedFiles();
    openNote(noteRecord({
      number: 12, title: 'Deploys', byUser: true,
      attachments: [{ id: 'd1', fileName: 'menu.pdf', contentType: 'application/pdf', sizeBytes: 4096, addedAt: 't' }],
    }), workplaceState(), {
      'GET api/notes/12/files/d1?preview=1': () => signed('preview-menu.pdf'),
      'GET api/notes/12/files/d1': () => signed('menu.pdf'),
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    fireEvent.click(screen.getByText('menu.pdf').closest('.crow') as HTMLElement);
    await screen.findByRole('dialog');
    fireEvent.click(document.getElementById('pdfViewerSave')!);
    await waitFor(() => expect(saved.list).toEqual([{ href: 'https://signed.example/menu.pdf', download: 'menu.pdf' }]));
    saved.restore();
  });

  it('saves a file the Workspace does not draw, through an anchor rather than a new window', async () => {
    const saved = savedFiles();
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    openNote(noteRecord({
      number: 12, title: 'Deploys', byUser: true,
      attachments: [{ id: 'z1', fileName: 'logs.zip', contentType: 'application/zip', sizeBytes: 512, addedAt: 't' }],
    }), workplaceState(), {
      'GET api/notes/12/files/z1': () => signed('logs.zip'),
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    fireEvent.click(screen.getByText('logs.zip').closest('.crow') as HTMLElement);
    await waitFor(() => expect(saved.list).toEqual([{ href: 'https://signed.example/logs.zip', download: 'logs.zip' }]));
    expect(opened).not.toHaveBeenCalled();
    saved.restore();
  });

  /**
   * The owner, 2026-10-04, once the chat played them (note #693): "in a note
   * attachment also video or audio should be played". A video and a
   * recording PLAY on their slides, and Download sits beside the ✕.
   */
  it('plays a video and a recording on their slides, with Download beside the ✕', async () => {
    const saved = savedFiles();
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    const scripted = openNote(noteRecord({
      number: 12, title: 'Launch video', byUser: true,
      attachments: [
        { id: 'v1', fileName: 'walkthrough.mp4', contentType: 'video/mp4', sizeBytes: 3_250_000, addedAt: 't', byUser: true },
        // The generic header an agent's `attach` sends, with the name as witness.
        { id: 'a1', fileName: 'voiceover.m4a', contentType: 'application/octet-stream', sizeBytes: 812_000, addedAt: 't' },
      ],
    }), workplaceState(), {
      'GET api/notes/12/files/v1?preview=1': () => signed('preview-walkthrough.mp4'),
      'GET api/notes/12/files/a1?preview=1': () => signed('preview-voiceover.m4a'),
      'GET api/notes/12/files/v1': () => signed('walkthrough.mp4'),
    });
    await screen.findByRole('heading', { name: 'Launch video' });
    // The player draws itself on a link signed to be PLAYED, not saved.
    const player = await waitFor(() => {
      const node = document.querySelector<HTMLVideoElement>('#noteFiles .notevideo video');
      expect(node?.getAttribute('src')).toBe('https://signed.example/preview-walkthrough.mp4#t=0.001');
      return node!;
    });
    expect(player.hasAttribute('controls')).toBe(true);
    expect(player.hasAttribute('playsinline')).toBe(true);
    const recording = await waitFor(() => {
      const node = document.querySelector('#noteFiles .noteaudio audio');
      expect(node?.getAttribute('src')).toBe('https://signed.example/preview-voiceover.m4a');
      return node!;
    });
    expect(recording.hasAttribute('controls')).toBe(true);
    // One slide each: the player, and the facts row a photo has under it.
    const slides = [...document.getElementById('noteFiles')!.children];
    expect(slides).toHaveLength(2);
    expect(slides[0]!.querySelectorAll('.notevideo, .caprow')).toHaveLength(2);
    expect(screen.getByText('walkthrough.mp4 · 3.1 MB · you attached this')).toBeTruthy();

    // 16:9 until the player has read the clip, then its own shape.
    const frame = document.querySelector<HTMLElement>('#noteFiles .notevideo')!;
    expect(frame.style.getPropertyValue('--video-shape')).toBe('16 / 9');
    Object.defineProperty(player, 'videoWidth', { value: 1080 });
    Object.defineProperty(player, 'videoHeight', { value: 1920 });
    fireEvent.loadedMetadata(player);
    await waitFor(() => expect(frame.style.getPropertyValue('--video-shape')).toBe('1080 / 1920'));

    // Download beside the ✕ saves the file, on a link minted at the press.
    expect(slides[0]!.querySelector('[aria-label="Remove walkthrough.mp4"]')).toBeTruthy();
    expect(scripted.calls.some((call) => call.path === 'api/notes/12/files/v1')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Download walkthrough.mp4' }));
    await waitFor(() => expect(saved.list).toEqual([{ href: 'https://signed.example/walkthrough.mp4', download: 'walkthrough.mp4' }]));
    expect(opened).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    saved.restore();
  });

  it('puts the plain row back for a clip this browser will not play, whose tap saves it', async () => {
    const saved = savedFiles();
    openNote(noteRecord({
      number: 12, title: 'Launch video', byUser: true,
      attachments: [{ id: 'v1', fileName: 'IMG_0412.mov', contentType: 'video/quicktime', sizeBytes: 9_000_000, addedAt: 't' }],
    }), workplaceState(), {
      'GET api/notes/12/files/v1?preview=1': () => signed('preview-IMG_0412.mov'),
      'GET api/notes/12/files/v1': () => signed('IMG_0412.mov'),
    });
    await screen.findByRole('heading', { name: 'Launch video' });
    const player = await waitFor(() => {
      const node = document.querySelector('#noteFiles .notevideo video');
      expect(node?.getAttribute('src')).toBeTruthy();
      return node!;
    });
    // A good link that will not play is the clip's fault: no second link.
    fireEvent.error(player);
    await waitFor(() => expect(document.querySelector('#noteFiles .notevideo')).toBeNull());
    fireEvent.click(screen.getByText('IMG_0412.mov').closest('.crow') as HTMLElement);
    await waitFor(() => expect(saved.list).toEqual([{ href: 'https://signed.example/IMG_0412.mov', download: 'IMG_0412.mov' }]));
    saved.restore();
  });

  it('falls back to the plain row when a photo’s URL cannot be minted', async () => {
    openNote(noteRecord({
      number: 12, title: 'Deploys', byUser: true,
      attachments: [{ id: 'p1', fileName: 'shot.png', contentType: 'image/png', sizeBytes: 2048, addedAt: 't' }],
    }), workplaceState(), {
      'GET api/notes/12/files/p1?preview=1': () => { throw new WorkspaceApiError('Storage is away.', 503, {}); },
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    await waitFor(() => expect(document.querySelector('.notephoto')).toBeNull());
    expect(screen.getByText('shot.png')).toBeTruthy();
  });

  it('offers the way in as a paperclip beside Copy, and no empty card (note #604)', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true, attachments: [] }));
    await screen.findByRole('heading', { name: 'Deploys' });
    const clip = screen.getByRole('button', { name: 'Attach a file' });
    // An icon, not a row of words: the name lives in aria-label alone.
    expect(clip.textContent).toBe('');
    expect(clip.closest('.notetools')).toBe(screen.getByRole('button', { name: 'Copy note' }).closest('.notetools'));
    expect(body().contains(clip)).toBe(true);
    expect(document.getElementById('noteFilesCard')).toBeNull();
  });

  it('stands directly under the words, above the agents and the margin (note #397)', async () => {
    openNote(noteRecord({
      number: 12, title: 'Deploys', byUser: true,
      attachments: [{ id: 'd1', fileName: 'menu.pdf', contentType: 'application/pdf', sizeBytes: 4096, addedAt: 't' }],
    }), workplaceState());
    await screen.findByRole('heading', { name: 'Deploys' });
    const card = document.getElementById('noteFilesCard')!;
    // A file is part of what the note SAYS, so it is the next thing after the
    // words — not something to be reached past the agents and the margin.
    expect(body().nextElementSibling).toBe(card);
    for (const below of ['noteSeatsSection', 'noteHandsCard', 'noteCommentsCard', 'noteActionsCard']) {
      expect(card.compareDocumentPosition(document.getElementById(below)!))
        .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  it('draws no files card and no paperclip when this backend cannot hold one', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true }));
    await screen.findByRole('heading', { name: 'Deploys' });
    expect(document.getElementById('noteFilesCard')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach a file' })).toBeNull();
  });

  it('asks before taking one off, and refreshes home so the badge goes with it', async () => {
    let reads = 0;
    const scripted = scriptedApi({
      ...workspaceScript(() => { reads += 1; return workplaceState(); }),
      'GET api/notes/12': () => ({
        note: noteRecord({
          number: 12, title: 'Deploys', byUser: true,
          attachments: [{ id: 'd1', fileName: 'menu.pdf', contentType: 'application/pdf', sizeBytes: 4096, addedAt: 't' }],
        }),
      }),
      'DELETE api/notes/12/files/d1': () => ({ ok: true, attachments: [] }),
    });
    renderAt('/notes/12?org=o1', scripted.api);
    await screen.findByRole('heading', { name: 'Deploys' });
    const before = reads;
    fireEvent.click(screen.getByRole('button', { name: 'Remove menu.pdf' }));
    const ask = await screen.findByRole('dialog');
    expect(ask.textContent).toContain('Take menu.pdf off this note?');
    fireEvent.click(within(ask).getByRole('button', { name: 'Take it off' }));
    await waitFor(() => expect(screen.queryByText('menu.pdf')).toBeNull());
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    // The last file gone, the card goes with it; the paperclip stays.
    expect(document.getElementById('noteFilesCard')).toBeNull();
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeTruthy();
  });

  it('shows the file on its way where it will land, and stands down once it has', async () => {
    let land: (value: unknown) => void = () => {};
    const scripted = openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true, attachments: [] }), workplaceState(), {
      'POST api/notes/12/files': () => new Promise((resolve) => { land = resolve; }),
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    const picker = document.getElementById('noteFileInput') as HTMLInputElement;
    const file = new File(['x'], 'menu.pdf', { type: 'application/pdf' });
    Object.defineProperty(picker, 'files', { value: [file], configurable: true });
    fireEvent.change(picker);
    expect(await screen.findByText('1 B · sending…')).toBeTruthy();
    // One at a time: the row below the button is the answer to "is it working".
    expect((screen.getByRole('button', { name: /Attach a file/ }) as HTMLButtonElement).disabled).toBe(true);
    act(() => land({ ok: true, attachments: [{ id: 'd1', fileName: 'menu.pdf', contentType: 'application/pdf', sizeBytes: 1, addedAt: 't', byUser: true }] }));
    await waitFor(() => expect(screen.queryByText('1 B · sending…')).toBeNull());
    expect(screen.getByText('menu.pdf')).toBeTruthy();
    expect(scripted.calls.find((call) => call.path === 'api/notes/12/files')!.init!.headers)
      .toMatchObject({ 'x-note-file-name': 'menu.pdf' });
  });

  it('sends a file past one part in parts and shows how far it has got (note #784)', async () => {
    let hold: (value: unknown) => void = () => {};
    const scripted = openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true, attachments: [] }), workplaceState(), {
      'POST api/notes/12/files/uploads': () => ({ id: 'f-1', uploadId: 'u1', partBytes: 8 * 1024 * 1024, parts: 2 }),
      'PUT api/notes/12/files/uploads/f-1/parts/1?upload=u1&name=demo.mov': () => ({ partNumber: 1, etag: '"a"' }),
      'PUT api/notes/12/files/uploads/f-1/parts/2?upload=u1&name=demo.mov': () => new Promise((resolve) => { hold = resolve; }),
      'POST api/notes/12/files/uploads/f-1/complete': () => ({
        ok: true, attachments: [{ id: 'f-1', fileName: 'demo.mov', contentType: 'video/quicktime', sizeBytes: 9 * 1024 * 1024, addedAt: 't', byUser: true }],
      }),
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    const picker = document.getElementById('noteFileInput') as HTMLInputElement;
    Object.defineProperty(picker, 'files', { value: [new File([new Uint8Array(9 * 1024 * 1024)], 'demo.mov', { type: 'video/quicktime' })], configurable: true });
    fireEvent.change(picker);
    expect(await screen.findByText('9.0 MB · sending… 88%')).toBeTruthy();
    act(() => hold({ partNumber: 2, etag: '"b"' }));
    await waitFor(() => expect(screen.queryByText(/sending…/)).toBeNull());
    await waitFor(() => expect(document.getElementById('noteFilesCard')!.textContent).toContain('demo.mov'));
    const start = scripted.calls.find((call) => call.path === 'api/notes/12/files/uploads')!;
    expect(JSON.parse(String(start.init?.body))).toEqual({ fileName: 'demo.mov', sizeBytes: 9 * 1024 * 1024, contentType: 'video/quicktime' });
    expect(scripted.calls.some((call) => call.path === 'api/notes/12/files')).toBe(false);
  });

  it('clears the row and says why when the upload fails', async () => {
    openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true, attachments: [] }), workplaceState(), {
      'POST api/notes/12/files': () => { throw new WorkspaceApiError('Storage is full.', 507, {}); },
    });
    await screen.findByRole('heading', { name: 'Deploys' });
    const picker = document.getElementById('noteFileInput') as HTMLInputElement;
    Object.defineProperty(picker, 'files', { value: [new File(['x'], 'menu.pdf', { type: 'application/pdf' })], configurable: true });
    fireEvent.change(picker);
    expect((await screen.findByRole('alert')).textContent).toContain('Storage is full.');
    await waitFor(() => expect(screen.queryByText(/sending…/)).toBeNull());
  });

  it('refuses a file the route would refuse, before spending the upload', async () => {
    const scripted = openNote(noteRecord({ number: 12, title: 'Deploys', byUser: true, attachments: [] }));
    await screen.findByRole('heading', { name: 'Deploys' });
    const picker = document.getElementById('noteFileInput') as HTMLInputElement;
    const huge = new File(['x'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(huge, 'size', { value: 101 * 1024 * 1024 });
    Object.defineProperty(picker, 'files', { value: [huge], configurable: true });
    fireEvent.change(picker);
    expect((await screen.findByRole('alert')).textContent).toContain('Files here are up to 100 MB');
    expect(scripted.calls.some((call) => call.path === 'api/notes/12/files')).toBe(false);
  });
});

// A note could be moved to another room (note #111), until rooms left the
// product (note #843): there is one list of notes, and nowhere to move one.
