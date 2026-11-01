import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceAgentVersionAnswer, WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import { WorkspaceApiError } from '../../api/client.js';
import { App } from '../../App.js';
import {
  agent, agentScreenScript, emptyState, noteRecord, scriptedApi, versionAnswer, workspaceScript, type Answer,
} from '../../test/fixtures.js';
import { LIVE_POLL_MS } from '../../workspace/WorkspaceProvider.js';
import { RESIZE_FOLLOW_MS, RESIZE_POLL_MS } from './MachinePicker.js';

/**
 * The agent's own screen, end to end against a scripted API — the same things
 * the legacy page's grab()-based tests hold it to (telegram-miniapp-page.test.ts:
 * the machine/model/site rows, the session-limit card, who drives it, the turn
 * count, the live repaint, the context bar and its reset, the proposal
 * history, the warm open and the delete), driven the way a person drives them.
 */

function open(state: WorkspaceStateAnswer, extra: Record<string, Answer> = {}, path = '/agents/felix') {
  const scripted = scriptedApi({ ...workspaceScript(() => state), ...extra });
  render(
    <MemoryRouter initialEntries={[path]}>
      <App api={scripted.api} />
    </MemoryRouter>,
  );
  return scripted;
}

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };
const felix = () => agent({ id: 'felix', name: 'Felix', model: 'Opus', effort: 'high' });
const title = () => screen.findByRole('heading', { name: 'Felix' });
const facts = () => document.getElementById('agentFacts')!;
const rowFor = (label: string) => within(facts()).getByText(label).closest('.drow') as HTMLElement;

afterEach(() => { vi.useRealTimers(); });

describe('what the screen says about the agent', () => {
  it('states the machine, the model and the site — and skips what it does not know', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      agentScreenScript('felix', () => versionAnswer({
        installed: '1.2.3',
        pinned: '1.2.3',
        machine: { awake: false, region: 'ams', regionName: 'Amsterdam', memoryMb: 4096, cpuKind: 'shared', cpus: 2 },
        model: 'Opus',
        effort: 'high',
        turnCount: 1204,
        workedMs: 8_100_000,
        workedSince: '2026-09-24T00:00:00.000Z',
        siteUrl: 'https://shop.agentbuilt.app',
        lastActiveAt: new Date().toISOString(),
      })),
    );
    await title();
    expect(document.getElementById('agentInfoSub')!.textContent).toBe('Claude Code · Opus · high');
    expect(document.getElementById('agentInfoSub')!.tagName).toBe('BUTTON');
    expect(document.getElementById('agentInfoSub')!.getAttribute('aria-label'))
      .toBe('Choose model and effort. Current: Claude Code · Opus · high');
    await waitFor(() => expect(within(facts()).getByText('Machine')).toBeTruthy());
    // Shared vs dedicated is said out loud (note #268) — it is the fact that
    // explains an agent that has gone mysteriously slow, and `2x` says nothing
    // about it to anybody who has not read Fly's price list.
    expect(rowFor('Machine').querySelector('.v')!.textContent).toBe('Asleep · Amsterdam · 2 shared cores · 4 GB');
    // "Asleep" is the normal state of a healthy agent, so the row says what wakes it.
    expect(rowFor('Machine').querySelector('.v.dim')!.textContent).toBe('It wakes on your next message.');
    expect(rowFor('Turns').querySelector('.v')!.textContent).toBe('1,204');
    // How long it has worked, for life (note #644) — and, for an agent older
    // than the counting, since when.
    expect(rowFor('Worked').querySelector('.v')!.textContent).toBe('2h 15m');
    expect(rowFor('Worked').textContent).toContain('Counted since');
    expect(rowFor('Worked').textContent).toContain('2026');
    expect(rowFor('Thinks with').querySelector('.v')!.textContent).toBe('Opus · high');
    expect(rowFor('Thinks with').querySelector('button.runtimevalue')).toBeTruthy();
    expect(rowFor('Its site').querySelector('.v')!.textContent).toBe('shop.agentbuilt.app');
    // Nothing is waiting on this agent, so there is no Status row at all.
    expect(within(facts()).queryByText('Status')).toBeNull();
    const card = document.getElementById('agentInfoCard')!;
    expect(within(card).getByText('Claude Code')).toBeTruthy();
    expect(card.textContent).toContain('1.2.3 · up to date');
    expect(within(card).getByText('CLAUDE.md')).toBeTruthy();
    expect(card.textContent).toContain('v4 · up to date');
  });

  it('opens the header machine door warm, off the record, before any machine read lands', async () => {
    open(
      emptyState({
        org,
        // The record's shape rides the state read, so the door is there on
        // the first paint rather than a second after it.
        agents: [{ ...felix(), machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 } }],
      }),
      // The read that would say more never answers — the machine card's
      // reason for existing.
      agentScreenScript('felix', () => { throw new WorkspaceApiError('control plane unreachable', 503, {}); }),
    );
    await title();
    const door = document.getElementById('agentInfoMachine')!;
    // There is no Machine row in the facts card at all, and the header still
    // names the machine.
    expect(within(facts()).queryByText('Machine')).toBeNull();
    expect(door.tagName).toBe('BUTTON');
    expect(door.textContent).toBe('2 dedicated cores · 4 GB');
    // Under the runtime door, not instead of it, and named differently from
    // the Machine row so a screen reader can tell the two apart.
    expect(document.getElementById('agentInfoSub')!.nextElementSibling).toBe(door);
    expect(door.getAttribute('aria-label')).toBe('Choose the machine size. Current: 2 dedicated cores · 4 GB');
  });

  it('the header machine door says what the live read found, and opens the same picker the row does', async () => {
    open(
      emptyState({
        org,
        // A stale record shape: this machine was moved up a rung since.
        agents: [{ ...felix(), machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 } }],
      }),
      {
        ...agentScreenScript('felix', () => versionAnswer({
          machine: { awake: true, region: 'ams', regionName: 'Amsterdam', memoryMb: 8192, cpuKind: 'performance', cpus: 4 },
        })),
        'GET api/agents/felix/machine': () => ({
          awake: true, cpuKind: 'performance', cpus: 4, memoryMb: 8192, current: 'performance-4x',
          canResize: true, disclaimer: 'Estimates.', sizes: [],
        }),
      },
    );
    await title();
    const door = () => document.getElementById('agentInfoMachine')!;
    // One machine, never described two ways on one screen: the live read wins
    // the moment it lands, on the header and on the row alike.
    await waitFor(() => expect(door().textContent).toBe('4 dedicated cores · 8 GB'));
    expect(rowFor('Machine').querySelector('.v')!.textContent)
      .toBe('Awake · Amsterdam · 4 dedicated cores · 8 GB');
    fireEvent.click(door());
    expect(await screen.findByRole('heading', { name: 'Felix’s machine' })).toBeTruthy();
  });

  it('leaves the header machine door out when nothing has ever read that machine', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      agentScreenScript('felix', () => versionAnswer({})),
    );
    await title();
    await waitFor(() => expect(document.getElementById('agentInfoCard')!.textContent).toContain('Claude Code'));
    // No record shape and no live one: a door with nothing to say is not a
    // door. The runtime door beside it is unaffected.
    expect(document.getElementById('agentInfoMachine')).toBeNull();
    expect(within(facts()).queryByText('Machine')).toBeNull();
    expect(document.getElementById('agentInfoSub')!.textContent).toBe('Claude Code · Opus · high');
  });

  it('says who drives it, and offers the subscription it can change', async () => {
    open(
      emptyState({
        org: { ...org, seatUsage: [{ seatId: 's1', provider: 'claude', label: 'Max 20x', selected: true, windows: [] }] },
        agents: [agent({ ...felix(), seatId: 's1' })],
        user: {
          name: 'Saddam',
          profile: { firstName: 'Saddam', lastName: '', incomplete: false, photoUrl: '/me.png' },
          account: { browserLogin: { enabled: true, method: 'totp', username: 'saddam' } },
        },
      }),
      agentScreenScript('felix', () => versionAnswer()),
    );
    await title();
    expect(rowFor('Driven by').textContent).toContain('Saddam — you');
    expect((rowFor('Driven by').querySelector('img.aface') as HTMLImageElement).getAttribute('src')).toBe('/me.png');
    expect(rowFor('Subscription').querySelector('.v')!.textContent).toBe('Max 20x');
    // It offered the room it stood in, a door to move it, until rooms left
    // the product (note #843).
    expect(within(facts()).queryByText('Room')).toBeNull();
  });

  // Note #773: an agent can be given its own subscription.
  const claudeMax = { seatId: 's1', provider: 'claude', label: 'Claude · 30 Sept 2026', planText: 'Max 20x', selected: true, windows: [{ usedPercent: 40, percentText: '40', trackText: 'this week' }] };
  const claudeAi = { seatId: 's2', provider: 'claude', label: 'Claude · 17 Oct 2026', planText: 'Ai', selected: false, windows: [{ usedPercent: 72, percentText: '72', trackText: '5 hours' }] };
  const chatgpt = { seatId: 'c1', provider: 'codex', label: 'ChatGPT · 1 Oct 2026', planText: 'Plus', selected: true, windows: [] };

  it('the Subscription row opens a picker: workplace default first, then this harness’s own sign-ins', async () => {
    let pin: string | undefined;
    const written: unknown[] = [];
    const state = () => emptyState({
      org: { ...org, seats: 3, seatProviders: ['claude', 'codex'], seatUsage: [claudeMax, claudeAi, chatgpt] },
      agents: [agent({ ...felix(), ...(pin ? { seatId: pin } : {}) })],
    });
    open(
      state(),
      {
        'GET api/state': state,
        ...agentScreenScript('felix', () => versionAnswer()),
        'POST api/agents/felix/seat': (call) => {
          const sent = JSON.parse(String(call.init?.body)) as { seatId: string };
          written.push(sent);
          pin = sent.seatId || undefined;
          return { ok: true, seatId: sent.seatId || null };
        },
      },
    );
    await title();
    expect(rowFor('Subscription').querySelector('.v')!.textContent).toBe('Workplace default');
    // No chosen subscription, so the header says nothing about one.
    expect(document.getElementById('agentInfoSeat')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Choose the subscription/ }));
    expect(await screen.findByRole('heading', { name: 'Subscription for Felix' })).toBeTruthy();
    const list = document.getElementById('seatPickerList')!;
    const rows = () => [...list.querySelectorAll('.crow')].map((row) => [
      row.querySelector('.name')!.textContent, row.classList.contains('current'),
    ]);
    // Claude sign-ins only — a Claude Code agent cannot spend ChatGPT.
    expect(rows()).toEqual([['Workplace default', true], ['Claude Max 20x', false], ['Claude Ai', false]]);
    expect(list.textContent).toContain('Follows your primary — now Claude Max 20x');
    // The default row already names the primary, so no row repeats it.
    expect(list.textContent).not.toContain('Primary');
    expect(screen.getByText(/moves on to your next one and\s+comes back once it has room again/)).toBeTruthy();

    fireEvent.click(list.querySelector('[data-seat-id="s2"]') as HTMLElement);
    await waitFor(() => expect(written).toEqual([{ seatId: 's2' }]));
    // The badge landing on the tapped row is the confirmation — no toast.
    await waitFor(() => expect(rows()).toEqual([['Workplace default', false], ['Claude Max 20x', false], ['Claude Ai', true]]));
    expect(document.getElementById('banner')).toBeNull();

    // Back on the agent: the row and the header both name the choice.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await title();
    await waitFor(() => expect(rowFor('Subscription').querySelector('.v')!.textContent).toBe('Claude Ai'));
    expect(document.getElementById('agentInfoSeat')!.textContent).toBe('on Claude Ai');

    // And back to the default from the same picker.
    fireEvent.click(document.getElementById('agentInfoSeat')!);
    fireEvent.click(await screen.findByText('Workplace default'));
    await waitFor(() => expect(written).toEqual([{ seatId: 's2' }, { seatId: '' }]));
  });

  it('a pin naming a sign-in that left reads as the workplace default', async () => {
    open(
      emptyState({
        org: { ...org, seats: 1, seatUsage: [claudeMax] },
          agents: [agent({ ...felix(), seatId: 'gone' })],
      }),
      agentScreenScript('felix', () => versionAnswer()),
    );
    await title();
    expect(rowFor('Subscription').querySelector('.v')!.textContent).toBe('Workplace default');
    expect(document.getElementById('agentInfoSeat')).toBeNull();
  });

  it('warns on a session limit and offers Resume only after reset', async () => {
    const state = emptyState({
      org,
      agents: [agent({ ...felix(), sessionLimit: { hitAt: 'h', resetAt: 'r', resetsText: 'at 4pm', resumeReady: false } })],
    });
    const { unmount } = render(<div />);
    unmount();
    open(state, agentScreenScript('felix', () => versionAnswer()));
    await title();
    expect(document.querySelector('.agentlimithead')!.textContent).toBe('Session limit reached');
    expect(document.querySelector('.agentlimittext')!.textContent).toContain('The subscription resets at 4pm');
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('offers Resume once the subscription is ready, and sends it as an ordinary message', async () => {
    const sent: unknown[] = [];
    open(
      emptyState({
        org,
        agents: [agent({ ...felix(), sessionLimit: { hitAt: 'h', resetAt: 'r', resumeReady: true } })],
      }),
      {
        ...agentScreenScript('felix', () => versionAnswer()),
        'POST api/agents/felix/message': (call) => {
          sent.push(JSON.parse(String(call.init?.body)));
          return { ok: true, name: 'Felix' };
        },
      },
    );
    await title();
    expect(document.querySelector('.agentlimithead')!.textContent).toBe('Session limit reset');
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    // An ordinary owner message, not a hidden mutation: it keeps the native
    // conversation and the transcript on the path every follow-up takes.
    await waitFor(() => expect(sent).toEqual([{ message: 'resume' }]));
    expect((await screen.findByRole('alert')).textContent).toContain('Felix is resuming');
  });

  it('an agent that is not ready leads with what it is waiting for', async () => {
    open(
      emptyState({ org, agents: [agent({ ...felix(), status: 'needs-seat', cli: 'codex' })] }),
      agentScreenScript('felix', () => versionAnswer()),
    );
    await title();
    expect(rowFor('Status').querySelector('.v')!.textContent)
      .toContain('it wakes once you sign in to ChatGPT in Your subscriptions');
  });
});

describe('the recap and the last reply', () => {
  it('keeps the recap first and adds the exact reply beneath it, as Markdown', async () => {
    open(
      emptyState({
        org,
        agents: [agent({ ...felix(), recap: 'Built the landing page.', recapAt: new Date().toISOString() })],
      }),
      {
        ...agentScreenScript('felix', () => versionAnswer()),
        'GET api/agents/felix/chat/latest': () => ({ message: { text: '**Done** — the page is `live`.', at: 't' } }),
      },
    );
    await title();
    expect(document.getElementById('agentInfoAbout')!.textContent).toBe('Built the landing page.');
    await waitFor(() => expect(document.getElementById('agentInfoLast')).toBeTruthy());
    const body = document.getElementById('agentInfoLastMessage')!;
    // Showing the reply never removes the recap above it.
    expect(document.getElementById('agentInfoAbout')).toBeTruthy();
    expect(body.querySelector('.md.agentmessage strong')!.textContent).toBe('Done');
    expect(body.querySelector('code')!.textContent).toBe('live');
    expect(rowFor('Recap from').querySelector('.v')!.textContent).toBe('just now');
  });

  it('folds a long last reply behind Read more, outside the message itself (note #461)', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true,
      get(this: HTMLElement) {
        if (!this.closest('#agentInfoLastMessage')) return 0;
        if (this.classList.contains('md')) return 900;
        return this.closest('.mdwrap.folded') ? 310 : 900;
      } });
    try {
      open(
        emptyState({ org, agents: [agent({ ...felix(), lastReply: { text: 'A very long report.', at: 't' } })] }),
        { 'GET api/agents/felix/version': () => versionAnswer(), 'GET api/agents/felix/prs': () => ({ prs: [] }) },
      );
      await title();
      const last = () => document.getElementById('agentInfoLast')!;
      await waitFor(() => expect(last().querySelector('.mdwrap.folded')).toBeTruthy());
      // The button is the fold's, not a word of the reply.
      expect(document.getElementById('agentInfoLastMessage')!.textContent).toBe('A very long report.');
      fireEvent.click(screen.getByRole('button', { name: 'Read more' }));
      expect(last().querySelector('.mdwrap.folded')).toBeNull();
      expect(last().querySelector('.readmore')).toBeNull();
    } finally {
      // jsdom keeps scrollHeight on Element; this own copy only shadowed it.
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });

  it('opens warm on the reply the state read already carried', async () => {
    open(
      emptyState({
        org,
        agents: [agent({ ...felix(), lastReply: { text: 'Seeded words.', at: 't' } })],
      }),
      // The narrow read is deliberately never answered here: the seed is what
      // makes the FIRST open warm, and it must stand on its own.
      { 'GET api/agents/felix/version': () => versionAnswer(), 'GET api/agents/felix/prs': () => ({ prs: [] }) },
    );
    await title();
    expect(document.getElementById('agentInfoLastMessage')!.textContent).toBe('Seeded words.');
  });

  it('opens a registered Workspace link from Last reply and leaves an unsafe path as text', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...agentScreenScript('felix', () => versionAnswer()),
        'GET api/agents/felix/chat/latest': () => ({
          message: {
            // Written while notes were a room's: the link still names one.
            text: '[Read the reason](/notes/470?org=o1&room=r1) and [do not open](/notes/..).',
            at: 't',
          },
        }),
        'GET api/notes/470': () => ({ note: noteRecord({ number: 470, title: 'Why the link was plain text' }) }),
      },
    );
    await title();
    const body = await waitFor(() => {
      const node = document.getElementById('agentInfoLastMessage');
      expect(node).toBeTruthy();
      return node!;
    });
    const links = [...body.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]!.textContent).toBe('Read the reason');
    // The workplace's note it is now, the old room dropped (note #843).
    expect(links[0]!.getAttribute('href')).toBe('/notes/470?org=o1');
    expect(body.textContent).toContain('[do not open](/notes/..)');
    fireEvent.click(links[0]!);
    await waitFor(() => expect(document.getElementById('screenNote')).toBeTruthy());
  });

  it('stamps the reply with how long ago it was said (note #558)', async () => {
    // Stamped before the screen opens: the answer is built when the read
    // lands, and a time measured there is younger than the clock the screen
    // mounted with — 12 minutes would round to 11.
    const at = new Date(Date.now() - 12 * 60_000).toISOString();
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...agentScreenScript('felix', () => versionAnswer()),
        'GET api/agents/felix/chat/latest': () => ({
          message: { text: 'The file strip is live.', at },
        }),
      },
    );
    await title();
    await waitFor(() => expect(document.getElementById('agentInfoLast')).toBeTruthy());
    expect(document.getElementById('agentInfoLast')!.querySelector('.agentlastlabel')!.textContent)
      .toBe('Last reply · 12m ago');
  });

  it('stamps the warm open too, off the seed the state read carried (note #558)', async () => {
    open(
      emptyState({
        org,
        agents: [agent({ ...felix(), lastReply: { text: 'Seeded words.', at: new Date(Date.now() - 3 * 3600_000).toISOString() } })],
      }),
      { 'GET api/agents/felix/version': () => versionAnswer(), 'GET api/agents/felix/prs': () => ({ prs: [] }) },
    );
    await title();
    expect(document.getElementById('agentInfoLast')!.querySelector('.agentlastlabel')!.textContent)
      .toBe('Last reply · 3h ago');
  });

  it('keeps the bare label when the reply carries no usable time', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...agentScreenScript('felix', () => versionAnswer()),
        // Ahead of this reader's clock — the same nothing `relative` answers
        // an unreadable stamp with, rather than "in -0m".
        'GET api/agents/felix/chat/latest': () => ({
          message: { text: 'Said a moment from now.', at: new Date(Date.now() + 60 * 60_000).toISOString() },
        }),
      },
    );
    await title();
    await waitFor(() => expect(document.getElementById('agentInfoLast')).toBeTruthy());
    expect(document.getElementById('agentInfoLast')!.querySelector('.agentlastlabel')!.textContent)
      .toBe('Last reply');
  });
});

describe('the version card', () => {
  it('opens on the state seed before any version read answers', async () => {
    const seed = versionAnswer({ cliLabel: 'Claude Code', installed: '9.9.9', pinned: '9.9.9', turnCount: 7 });
    const scripted = open(
      emptyState({ org, agents: [agent({ ...felix(), version: seed })] }),
      // No version route at all: a warm screen must not need one.
      { 'GET api/agents/felix/chat/latest': () => ({ message: null }), 'GET api/agents/felix/prs': () => ({ prs: [] }) },
    );
    await title();
    expect(document.getElementById('agentInfoCard')!.textContent).toContain('9.9.9 · up to date');
    expect(rowFor('Turns').querySelector('.v')!.textContent).toBe('7');
    // …and it still asked, so the rows refresh underneath.
    expect(scripted.calls.some((call) => call.path === 'api/agents/felix/version')).toBe(true);
  });

  it('a CLI update that rides the machine image holsters its own button', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      agentScreenScript('felix', () => versionAnswer({
        installed: '1.0.0', pinned: '1.1.0', cliUpdateAvailable: true,
        image: { current: false, canUpdate: true },
      })),
    );
    await title();
    await waitFor(() => expect(document.getElementById('agentInfoCard')!.textContent).toContain('1.0.0 → 1.1.0'));
    expect(document.getElementById('agentInfoCard')!.textContent)
      .toContain('included in the machine software update below');
    // Two buttons would invite a second tap for work the first one covers.
    expect(screen.queryByRole('button', { name: 'Update Claude Code' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Update machine software' })).toBeTruthy();
  });

  it('offers the CLI update on its own when the image is already current', async () => {
    const posted: string[] = [];
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...agentScreenScript('felix', () => versionAnswer({
          installed: '1.0.0', pinned: '1.1.0', cliUpdateAvailable: true,
          image: { current: true, canUpdate: false },
        })),
        'POST api/agents/felix/update-cli': (call) => { posted.push(call.path); return { ok: true }; },
      },
    );
    await title();
    const button = await screen.findByRole('button', { name: 'Update Claude Code' });
    fireEvent.click(button);
    await waitFor(() => expect(posted).toEqual(['api/agents/felix/update-cli']));
    expect((await screen.findByRole('alert')).textContent).toContain('Updated — all set.');
  });

  it('the machine update asks first, and does nothing when the answer is no', async () => {
    const posted: string[] = [];
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...agentScreenScript('felix', () => versionAnswer({ image: { current: false, canUpdate: true } })),
        'POST api/agents/felix/update-machine': (call) => { posted.push(call.path); return { ok: true }; },
      },
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: 'Update machine software' }));
    expect(screen.getByRole('dialog').textContent).toContain('It restarts the machine');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(posted).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Update machine software' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(posted).toEqual(['api/agents/felix/update-machine']));
  });

  it('locks the update buttons while a turn runs, and unlocks them when it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let working = true;
    const scripted = open(
      emptyState({
        org,
        agents: [agent({ ...felix(), working: true })],
      }),
      {
        ...agentScreenScript('felix', () => versionAnswer({ image: { current: false, canUpdate: true } })),
        'GET api/agents/live': () => ({
          agents: working ? [{ id: 'felix', working: true as const }] : [], recaps: [], sessionLimits: [],
        }),
      },
    );
    await title();
    const update = await screen.findByRole('button', { name: 'Update machine software' });
    expect((update as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('.busyhint')!.textContent).toContain('Felix is busy with a task right now');
    // The turn ends; the tick that repaints the fleet repaints this too.
    working = false;
    scripted.script['GET api/state'] = () => emptyState({ org, agents: [felix()] });
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 50); });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Update machine software' }) as HTMLButtonElement).disabled).toBe(false));
    expect((document.querySelector('.busyhint') as HTMLElement).hidden).toBe(true);
  });
});

describe('the header says whether the agent is working', () => {
  const pill = () => document.getElementById('agentHeadState');

  it('turns over with the turn, without the reader touching anything', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let working = true;
    const scripted = open(
      emptyState({ org, agents: [agent({ ...felix(), working: true })] }),
      {
        ...agentScreenScript('felix', () => versionAnswer()),
        'GET api/agents/live': () => ({
          agents: working ? [{ id: 'felix', working: true as const }] : [], recaps: [], sessionLimits: [],
        }),
      },
    );
    await title();
    expect(pill()!.textContent).toBe('Active');
    expect(pill()!.className).toContain('active');
    // A live region, and one that names who it is about: read on its own,
    // out of the header, "Active" names nobody.
    expect(pill()!.getAttribute('role')).toBe('status');
    expect(pill()!.getAttribute('aria-label')).toBe('Felix is active');
    // The turn ends. The tick that repaints the fleet repaints the header.
    working = false;
    scripted.script['GET api/state'] = () => emptyState({ org, agents: [felix()] });
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 50); });
    await waitFor(() => expect(pill()!.textContent).toBe('Ready'));
    expect(pill()!.className).toContain('idle');
    expect(pill()!.getAttribute('aria-label')).toBe('Felix is ready');
  });

  it('does not call an agent idle when it is paused', async () => {
    open(
      emptyState({ org, agents: [agent({ ...felix(), status: 'needs-seat' })] }),
      agentScreenScript('felix', () => versionAnswer()),
    );
    await title();
    // Idle means "it can take a message". This one cannot, and the Status
    // row below says what it is waiting for.
    expect(pill()!.textContent).toBe('Paused');
    expect(pill()!.className).toContain('waiting');
  });

  it('says a retired agent is retired', async () => {
    open(
      emptyState({ org, agents: [agent({ ...felix(), status: 'retired' })] }),
      agentScreenScript('felix', () => versionAnswer()),
    );
    await title();
    expect(pill()!.textContent).toBe('Retired');
  });

  it('claims nothing about an agent that is not there', async () => {
    open(emptyState({ org, agents: [] }), {}, '/agents/gone');
    expect((await screen.findByRole('alert')).textContent).toContain('That agent is not here');
    expect(pill()).toBeNull();
  });

  it('stands only on the agent’s own screen', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      agentScreenScript('felix', () => versionAnswer()),
    );
    await title();
    expect(pill()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(pill()).toBeNull());
  });
});

describe('the context window', () => {
  const withContext = (usedPercent: number) => agent({
    ...felix(),
    avatarUrl: '/faces/felix.png',
    context: { usedPercent, tokens: 140_000, window: 200_000, at: new Date().toISOString() },
  });

  it('says how full it is and heats up as it fills', async () => {
    const { unmount } = render(<div />);
    unmount();
    open(
      emptyState({ org, agents: [withContext(71)] }),
      agentScreenScript('felix', () => versionAnswer()),
    );
    await title();
    const row = document.querySelector('.contextrow')!;
    expect(row.querySelector('.ctext')!.textContent).toContain('71% used · 140k of 200k tokens');
    expect(row.querySelector('.meter.warn')).toBeTruthy();
    expect((row.querySelector('.meter-fill') as HTMLElement).style.width).toBe('71%');
    // The same reading, drawn, on the face at the top of the screen.
    expect(document.querySelector('#agentInfoHead .ctxring.warn')!.getAttribute('aria-label'))
      .toBe('Context window 71% full');
  });

  it('asks the agent to reset through the idle-only message door, and stays spent', async () => {
    const sent: unknown[] = [];
    open(
      emptyState({ org, agents: [withContext(94)] }),
      {
        ...agentScreenScript('felix', () => versionAnswer()),
        'POST api/agents/felix/message': (call) => {
          sent.push(JSON.parse(String(call.init?.body)));
          return { ok: true, name: 'Felix' };
        },
      },
    );
    await title();
    expect(document.querySelector('.contextrow .meter.hot')).toBeTruthy();
    const ask = screen.getByRole('button', { name: 'Ask agent to reset chat' });
    fireEvent.click(ask);
    // The wording is the platform's reset command, not a direct mutation: the
    // agent gets one turn to preserve durable state and answers in its chat.
    await waitFor(() => expect(sent).toEqual([{ message: 'reset chat' }]));
    const spent = await screen.findByRole('button', { name: 'Asked — it will answer in its chat' });
    expect((spent as HTMLButtonElement).disabled).toBe(true);
  });

  it('is absent entirely when nothing has ever measured it', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      agentScreenScript('felix', () => versionAnswer()),
    );
    await title();
    expect(document.querySelector('.contextrow')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask agent to reset chat' })).toBeNull();
    expect(document.querySelector('#agentInfoHead .ctxring.warn')).toBeNull();
  });
});

describe('the proposal history', () => {
  const pr = (over: Record<string, unknown>) => ({
    id: 'p1', number: 4, repoName: 'infinite-agents', title: 'Move Home', body: null,
    from: 'slice-2', to: 'main', status: 'merged', createdAt: 't', decidedAt: null, agentName: 'Felix',
    ...over,
  });
  const page = (over: Record<string, unknown>) => ({
    id: 'k1', number: 2, title: 'Write down the deploy lane', status: 'approved',
    pages: ['how-a-change-reaches-production'], createdAt: 't', agentName: 'Felix',
    ...over,
  });

  it('lists what this agent proposed, newest first, with the outcome leading the line', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      agentScreenScript('felix', () => versionAnswer(), [
        pr({ id: 'p1', number: 4, status: 'merged' }),
        pr({ id: 'p2', number: 3, status: 'open', title: 'Add rooms' }),
      ] as never),
    );
    await title();
    await waitFor(() => expect(document.getElementById('agentPrs')!.hidden).toBe(false));
    const rows = [...document.querySelectorAll('#agentPrs .crow')];
    expect(rows.map((row) => row.querySelector('.prstate')!.textContent)).toEqual(['Merged', 'Awaiting approval']);
    // The agent is already named by this screen, so the row spends its line
    // on the repository instead of the source branch.
    expect(rows[0]!.querySelector('.bname')!.textContent).toBe('infinite-agents');
  });

  /**
   * Note #276: a knowledge proposal is this agent's work too, and the history
   * is one list rather than two piles — so the two kinds sort against each
   * other on when they were proposed, and each keeps its own vocabulary
   * (a change MERGES, a page is APPROVED).
   */
  it('mixes knowledge proposals into the same list, in the order they were proposed', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      agentScreenScript(
        'felix',
        () => versionAnswer(),
        [
          pr({ id: 'p1', number: 4, status: 'merged', createdAt: '2026-08-03T00:00:00.000Z' }),
          pr({ id: 'p2', number: 3, status: 'open', title: 'Add rooms', createdAt: '2026-08-01T00:00:00.000Z' }),
        ] as never,
        [
          page({ id: 'k1', number: 2, createdAt: '2026-08-02T00:00:00.000Z' }),
        ] as never,
      ),
    );
    await title();
    await waitFor(() => expect(document.querySelectorAll('#agentPrs .crow').length).toBe(3));
    const rows = [...document.querySelectorAll('#agentPrs .crow')];
    expect(rows.map((row) => row.querySelector('.name')!.textContent))
      .toEqual(['Move Home', 'Write down the deploy lane', 'Add rooms']);
    expect(rows.map((row) => row.querySelector('.prstate')!.textContent))
      .toEqual(['Merged', 'Approved', 'Awaiting approval']);
    // Which pages it would change, where the change row says which repository.
    expect(rows[1]!.querySelector('.bname')!.textContent).toBe('how-a-change-reaches-production');
  });

  it('opens a knowledge row at the proposal it is about, not at the page', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...agentScreenScript('felix', () => versionAnswer(), [], [page({ id: 'k1' })] as never),
        'GET api/knowledge/proposals/k1': () => ({
          proposal: {
            id: 'k1', number: 2, title: 'Write down the deploy lane', status: 'approved',
            pages: ['how-a-change-reaches-production'], createdAt: 't', agentName: 'Felix', canDecide: false,
          },
          changes: [],
        }),
      },
    );
    await title();
    await waitFor(() => expect(document.querySelectorAll('#agentPrs .crow').length).toBe(1));
    fireEvent.click(document.querySelector('#agentPrs .crow')!);
    expect(await screen.findByRole('heading', { level: 1, name: 'Write down the deploy lane' })).toBeTruthy();
    expect(document.getElementById('screenKp')).toBeTruthy();
  });

  it('leaves no empty card for an agent that has proposed nothing', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      agentScreenScript('felix', () => versionAnswer()),
    );
    await title();
    expect(document.getElementById('agentPrs')!.hidden).toBe(true);
    expect(document.getElementById('agentPrsHead')!.hidden).toBe(true);
  });
});

describe('a second visit (note #630)', () => {
  // Answers that never come: the second visit must stand on what the first read.
  const never = () => new Promise<never>(() => {});
  const runtime = () => ({
    cli: 'claude', model: 'Opus', effort: 'high',
    models: [{ value: 'Opus', label: 'Opus', efforts: [{ value: 'high', label: 'high' }] }],
  });

  it('opens on what the last visit read, and refreshes it underneath', async () => {
    const state = emptyState({ org, agents: [felix()] });
    const machine = { awake: false, region: 'ams', regionName: 'Amsterdam', memoryMb: 4096, cpuKind: 'shared', cpus: 2 };
    const pr = {
      id: 'p1', number: 12, repoName: 'shop', title: 'Add the price list', body: null,
      from: 'prices', to: 'main', status: 'open', createdAt: 't', decidedAt: null, agentName: 'Felix',
    } as unknown as NonNullable<Parameters<typeof agentScreenScript>[2]>[number];
    open(state, {
      ...agentScreenScript('felix', () => versionAnswer({ installed: '1.2.3', pinned: '1.2.3', machine }), [pr]),
      'GET api/agents/felix/chat/latest': () => ({ message: { role: 'agent', text: 'Price list is up.', at: new Date().toISOString(), seq: 3 } }),
    });
    await waitFor(() => expect(within(facts()).getByText('Machine')).toBeTruthy());
    await waitFor(() => expect(document.getElementById('agentPrs')!.hidden).toBe(false));
    await waitFor(() => expect(document.getElementById('agentInfoLastMessage')!.textContent).toContain('Price list is up.'));
    cleanup();

    const again = open(state, {
      'GET api/agents/felix/version': never,
      'GET api/agents/felix/chat/latest': never,
      'GET api/agents/felix/prs': never,
    });
    await title();
    // The first frame, before any of the three reads has answered.
    expect(rowFor('Machine').querySelector('.v')!.textContent).toBe('Asleep · Amsterdam · 2 shared cores · 4 GB');
    expect(document.getElementById('agentInfoCard')!.textContent).toContain('1.2.3 · up to date');
    expect(document.getElementById('agentInfoCard')!.textContent).not.toContain('Checking…');
    expect(document.getElementById('agentPrs')!.hidden).toBe(false);
    expect(document.getElementById('agentInfoLastMessage')!.textContent).toContain('Price list is up.');
    // …and it still asks, silently.
    expect(again.calls.map((call) => call.path)).toEqual(expect.arrayContaining([
      'api/agents/felix/version', 'api/agents/felix/chat/latest', 'api/agents/felix/prs',
    ]));
  });

  it('a failed refresh leaves the held facts standing, unannounced', async () => {
    const state = emptyState({ org, agents: [felix()] });
    open(state, agentScreenScript('felix', () => versionAnswer({ installed: '1.2.3', pinned: '1.2.3' })));
    await waitFor(() => expect(document.getElementById('agentInfoCard')!.textContent).toContain('1.2.3 · up to date'));
    cleanup();
    open(state, agentScreenScript('felix', () => { throw new WorkspaceApiError('control plane unreachable', 503, {}); }));
    await title();
    await act(async () => { await Promise.resolve(); });
    expect(document.getElementById('agentInfoCard')!.textContent).toContain('1.2.3 · up to date');
    expect(document.getElementById('agentInfoCard')!.textContent).not.toContain('control plane unreachable');
  });

  it('the model & effort picker opens on the choices it last read', async () => {
    const state = emptyState({ org, agents: [felix()] });
    open(state, {
      ...agentScreenScript('felix', () => versionAnswer({ model: 'Opus', effort: 'high' })),
      'GET api/agents/felix/runtime': runtime,
    });
    fireEvent.click(await screen.findByRole('button', { name: /Choose model and effort/ }));
    await waitFor(() => expect(document.querySelector('#agentRuntimeModels .crow.current')).toBeTruthy());
    cleanup();

    open(state, {
      ...agentScreenScript('felix', () => versionAnswer({ model: 'Opus', effort: 'high' })),
      'GET api/agents/felix/runtime': never,
    });
    fireEvent.click(await screen.findByRole('button', { name: /Choose model and effort/ }));
    expect(await screen.findByRole('heading', { name: 'How Felix thinks' })).toBeTruthy();
    expect(document.querySelector('#agentRuntimeModels .crow.current')!.textContent).toContain('Opus');
    expect(screen.queryByText('Loading choices…')).toBeNull();
  });

  it('shows its choices at once on a cold open, from the catalog and the agent’s own row (note #718)', async () => {
    const nova = agent({ id: 'nova', name: 'Nova', cli: 'claude', model: 'sonnet', effort: 'xhigh' });
    const state = emptyState({ org, agents: [nova] });
    open(state, {
      ...agentScreenScript('nova', () => versionAnswer({ model: 'sonnet', effort: 'xhigh' })),
      'GET api/agents/nova/runtime': never,
    }, '/agents/nova');
    fireEvent.click(await screen.findByRole('button', { name: /Choose model and effort/ }));
    expect(await screen.findByRole('heading', { name: 'How Nova thinks' })).toBeTruthy();
    // Nothing has answered, and the whole Claude catalog stands, the current
    // pair marked: the models in the catalog's order, the levels Sonnet offers.
    expect(screen.queryByText('Loading choices…')).toBeNull();
    const names = Array.from(document.querySelectorAll('#agentRuntimeModels .crow .name')).map((node) => node.textContent);
    expect(names).toEqual(['Fable', 'Opus', 'Sonnet']);
    expect(document.querySelector('#agentRuntimeModels .crow.current')!.textContent).toContain('Sonnet');
    const levels = Array.from(document.querySelectorAll('#agentRuntimeEfforts [role="radio"]')).map((node) => node.textContent);
    expect(levels).toEqual(['Medium', 'High', 'Extra high', 'Max']);
    expect(document.querySelector('#agentRuntimeEfforts [role="radio"][aria-checked="true"]')!.textContent).toBe('Extra high');
    // A tap before the read answers is a write like any other.
    const written = {
      cli: 'claude', model: 'opus', effort: 'xhigh', ok: true,
      models: [{ value: 'opus', label: 'opus', efforts: [{ value: 'high', label: 'high' }, { value: 'xhigh', label: 'xhigh', heavy: true }] }],
    };
    cleanup();
    const again = open(state, {
      ...agentScreenScript('nova', () => versionAnswer({ model: 'sonnet', effort: 'xhigh' })),
      'GET api/agents/nova/runtime': never,
      'POST api/agents/nova/runtime': () => written,
    }, '/agents/nova');
    fireEvent.click(await screen.findByRole('button', { name: /Choose model and effort/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Opus' }));
    await waitFor(() => expect(document.querySelector('#agentRuntimeModels .crow.current')!.textContent).toContain('Opus'));
    const post = again.calls.find((call) => call.path === 'api/agents/nova/runtime' && call.init?.method === 'POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ model: 'opus' });
  });
});

describe('the leaves this screen opens', () => {
  it('the header runtime opens the picker, writes a choice, and Back returns to the agent', async () => {
    const written: unknown[] = [];
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...agentScreenScript('felix', () => versionAnswer({ model: 'Opus', effort: 'high' })),
        'GET api/agents/felix/runtime': () => ({
          cli: 'claude',
          model: 'Opus',
          effort: 'high',
          models: [
            { value: 'Opus', label: 'Opus', efforts: [{ value: 'high', label: 'high' }, { value: 'low', label: 'low' }] },
            { value: 'Sonnet', label: 'Sonnet', efforts: [{ value: 'high', label: 'high' }] },
          ],
        }),
        'POST api/agents/felix/runtime': (call) => {
          written.push(JSON.parse(String(call.init?.body)));
          return { ok: true, cli: 'claude', model: 'Sonnet', effort: 'high', models: [
            { value: 'Opus', label: 'Opus', efforts: [{ value: 'high', label: 'high' }] },
            { value: 'Sonnet', label: 'Sonnet', efforts: [{ value: 'high', label: 'high' }] },
          ] };
        },
      },
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Choose model and effort/ }));
    expect(await screen.findByRole('heading', { name: 'How Felix thinks' })).toBeTruthy();
    // The current choice is a state, not a no-op button.
    await waitFor(() => expect(document.querySelector('#agentRuntimeModels .crow.current')).toBeTruthy());
    expect(document.querySelector('#agentRuntimeModels .crow.current')!.textContent).toContain('Opus');
    // Effort follows the SELECTED model, never a CLI-wide list.
    // Effort is a scale of the model's own steps, in words; the chosen one is checked.
    expect([...document.querySelectorAll('#agentRuntimeEfforts .effortstep')].map((step) => [step.textContent, step.getAttribute('aria-checked')]))
      .toEqual([['High', 'true'], ['Low', 'false']]);
    fireEvent.click(screen.getByRole('button', { name: /Sonnet/ }));
    await waitFor(() => expect(written).toEqual([{ model: 'Sonnet' }]));
    // Note #237: the leaf stays on screen, so the badge arriving on the row
    // that was tapped IS the confirmation — and no toast repeats it.
    await waitFor(() => expect(document.querySelector('#agentRuntimeModels .crow.current')!.textContent).toContain('Sonnet'));
    expect(document.getElementById('banner')).toBeNull();
    // Back closes the leaf rather than spending a history entry.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await title()).toBeTruthy();
  });

  it('marks the heavy effort levels on their own rows, and says once what they cost', async () => {
    // Note #482. The reader is choosing how fast their subscription window
    // empties, and until now the card offered six rungs that all looked alike.
    const heavyModels = [
      {
        value: 'opus',
        label: 'opus',
        efforts: [
          { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' },
          { value: 'xhigh', label: 'xhigh', heavy: true },
          { value: 'max', label: 'max', heavy: true },
        ],
      },
      { value: 'fable', label: 'fable', efforts: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }] },
    ];
    open(
      emptyState({ org, agents: [agent({ id: 'felix', name: 'Felix', model: 'opus', effort: 'xhigh' })] }),
      {
        ...agentScreenScript('felix', () => versionAnswer({ model: 'opus', effort: 'xhigh' })),
        'GET api/agents/felix/runtime': () => ({ cli: 'claude', model: 'opus', effort: 'xhigh', models: heavyModels }),
        'POST api/agents/felix/runtime': () => ({ ok: true, cli: 'claude', model: 'fable', effort: 'high', models: heavyModels }),
      },
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Choose model and effort/ }));
    await waitFor(() => expect(document.querySelector('#agentRuntimeEfforts .effortstep.current')).toBeTruthy());

    // The heavy steps are marked and nothing else is — including the chosen
    // step, whose reader is already spending it; the line under the scale
    // says the mark for the chosen heavy step.
    expect([...document.querySelectorAll('#agentRuntimeEfforts .effortstep')].map((step) => step.textContent))
      .toEqual(['Medium', 'High', 'Extra high', 'Max']);
    expect([...document.querySelectorAll('#agentRuntimeEfforts .effortstep.heavy')].map((step) => step.textContent))
      .toEqual(['Extra high', 'Max']);
    expect(document.querySelector('#agentRuntimeEfforts .effortstep.current')!.textContent).toBe('Extra high');
    const now = document.getElementById('agentRuntimeEffortNow')!;
    expect(now.textContent).toContain('Much more compute');
    expect(now.classList.contains('heavy')).toBe(true);
    // A model is not an effort: no row in the model card ever carries it.
    expect(document.querySelectorAll('#agentRuntimeModels .heavy').length).toBe(0);

    // And the screen says once, underneath, what "much more compute" means.
    const cost = document.getElementById('agentRuntimeEffortCost')!;
    expect(cost.textContent).toContain('Extra high and Max think for much longer before answering');
    expect(cost.textContent).toContain('usage much faster');

    // The caution follows the SELECTED model: fable offers no heavy level, so
    // there is nothing to warn about and nothing is said.
    fireEvent.click(screen.getByRole('button', { name: /Fable/ }));
    await waitFor(() => expect(document.querySelector('#agentRuntimeModels .crow.current')!.textContent).toContain('Fable'));
    expect(document.querySelectorAll('#agentRuntimeEfforts .effortstep.heavy').length).toBe(0);
    expect(document.getElementById('agentRuntimeEffortNow')!.classList.contains('heavy')).toBe(false);
    expect(document.getElementById('agentRuntimeEffortCost')).toBeNull();
  });

  it('puts the new model on the header and the fleet row before the state read answers', async () => {
    // Note #296. The state read a runtime change asks for is the heaviest one
    // this app makes, and until it lands every painted copy of the agent —
    // this header, the runtime line under it, the row on Home behind — still
    // says the old model. The server's own answer corrects them first.
    let stateReads = 0;
    const opus = emptyState({
      org,
      agents: [agent({ id: 'felix', name: 'Felix', model: 'Opus', effort: 'high' })],
    });
    open(
      opus,
      {
        ...agentScreenScript('felix', () => versionAnswer({ model: 'Opus', effort: 'high' })),
        // The screen opens on a real read; every read after it hangs fire, which
        // is the case under test — the change is written and the heavy state
        // read that confirms it has not answered.
        'GET api/state': () => {
          stateReads += 1;
          if (stateReads > 1) throw new WorkspaceApiError('the read that confirms it is still out', 503, {});
          return opus;
        },
        'GET api/agents/felix/runtime': () => ({
          cli: 'claude', model: 'Opus', effort: 'high',
          models: [
            { value: 'Opus', label: 'Opus', efforts: [{ value: 'high', label: 'high' }] },
            { value: 'fable', label: 'fable', efforts: [{ value: 'xhigh', label: 'xhigh' }] },
          ],
        }),
        'POST api/agents/felix/runtime': () => ({
          ok: true, cli: 'claude', model: 'fable', effort: 'xhigh',
          models: [
            { value: 'Opus', label: 'Opus', efforts: [{ value: 'high', label: 'high' }] },
            { value: 'fable', label: 'fable', efforts: [{ value: 'xhigh', label: 'xhigh' }] },
          ],
        }),
      },
    );
    await title();
    expect(document.getElementById('agentInfoSub')!.textContent).toBe('Claude Code · Opus · high');
    fireEvent.click(await screen.findByRole('button', { name: /Change model and effort/ }));
    await waitFor(() => expect(document.querySelector('#agentRuntimeModels .crow.current')).toBeTruthy());
    const before = stateReads;
    fireEvent.click(screen.getByRole('button', { name: /Fable/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));

    // The header behind the picker is already on the new runtime — and it is
    // the crowned name, since the row it draws from now says fable.
    await waitFor(() => expect(document.getElementById('agentInfoSub')!.textContent).toBe('Claude Code · fable · xhigh'));
    expect(document.getElementById('agentInfoTitle')!.querySelector('svg.crown')).toBeTruthy();
    // Not because a fresh state arrived: every read since the write failed,
    // and the frozen fixture would have said Opus anyway.
    expect(stateReads).toBeGreaterThan(before);
  });

  it('crowns a Codex agent the moment GPT-6 Astra is the model it runs', async () => {
    // Note #324, and the same route note #296 opened: the mark follows the
    // model on the row, so picking a CLI's flagship earns it and nothing about
    // WHICH harness that is enters into it.
    // The server is the authority on what an agent runs, so the fixture moves
    // when the write lands — the crown is then read off a state that really
    // says Astra, not off the optimistic echo alone.
    let running = 'gpt-5.6-sol';
    const state = () => emptyState({
      org,
      agents: [agent({ id: 'mira', name: 'Mira', cli: 'codex', model: running, effort: 'max' })],
    });
    const codexModels = [
      { value: 'gpt-6-astra', label: 'gpt-6-astra', efforts: [{ value: 'max', label: 'max' }] },
      { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol', efforts: [{ value: 'max', label: 'max' }] },
    ];
    open(
      state(),
      {
        ...agentScreenScript('mira', () => versionAnswer({ model: running, effort: 'max' })),
        'GET api/state': () => state(),
        'GET api/agents/mira/runtime': () => ({ cli: 'codex', model: running, effort: 'max', models: codexModels }),
        'POST api/agents/mira/runtime': () => {
          running = 'gpt-6-astra';
          return { ok: true, cli: 'codex', model: running, effort: 'max', models: codexModels };
        },
      },
      '/agents/mira',
    );
    await screen.findByRole('heading', { name: 'Mira' });
    // A Codex agent one rung down is bare, exactly as an Opus one is.
    expect(document.getElementById('agentInfoSub')!.textContent).toBe('Codex · gpt-5.6-sol · max');
    expect(document.getElementById('agentInfoTitle')!.querySelector('.crown')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: /Change model and effort/ }));
    await waitFor(() => expect(document.querySelector('#agentRuntimeModels .crow.current')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /GPT-6 Astra/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));

    await waitFor(() => expect(document.getElementById('agentInfoSub')!.textContent).toBe('Codex · gpt-6-astra · max'));
    const heading = document.getElementById('agentInfoTitle')!;
    expect(heading.querySelector('svg.crown')).toBeTruthy();
    expect(heading.querySelector('.nametext')!.textContent).toBe('Mira');
  });

  it('says a refused runtime change under the card that asked, and still raises no toast', async () => {
    const refusal = 'Felix is working — the model changes at the end of the turn.';
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...agentScreenScript('felix', () => versionAnswer({ model: 'Opus', effort: 'high' })),
        'GET api/agents/felix/runtime': () => ({
          cli: 'claude',
          model: 'Opus',
          effort: 'high',
          models: [
            { value: 'Opus', label: 'Opus', efforts: [{ value: 'high', label: 'high' }, { value: 'low', label: 'low' }] },
            { value: 'Sonnet', label: 'Sonnet', efforts: [{ value: 'high', label: 'high' }] },
          ],
        }),
        'POST api/agents/felix/runtime': () => { throw new WorkspaceApiError(refusal, 409, {}); },
      },
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Change model and effort/ }));
    await waitFor(() => expect(document.querySelector('#agentRuntimeModels .crow.current')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Sonnet/ }));
    // Under the Model card, where the row that did not move still is.
    const said = await screen.findByText(refusal);
    expect(said.id).toBe('agentRuntimeModelFail');
    expect(said.getAttribute('role')).toBe('alert');
    expect(document.getElementById('agentRuntimeEffortFail')).toBeNull();
    // The toast note #237 took away does not come back for the refusal.
    expect(document.getElementById('banner')).toBeNull();
    // Nothing was written, so the choice the reader arrived with still stands.
    expect(document.querySelector('#agentRuntimeModels .crow.current')!.textContent).toContain('Opus');
    // The next attempt clears the last one rather than stacking beside it.
    fireEvent.click(screen.getByRole('radio', { name: 'Low' }));
    await waitFor(() => expect(document.getElementById('agentRuntimeEffortFail')).toBeTruthy());
    expect(document.getElementById('agentRuntimeModelFail')).toBeNull();
    expect(document.getElementById('banner')).toBeNull();
  });

  // The Room row opened a picker that moved the agent to another room, until
  // rooms left the product (note #843): an agent is the workplace's.

  /**
   * Note #268. The machine row used to be a fact and nothing more; it is now
   * the door to what the machine is MADE OF and the sizes it can move onto.
   */
  const machineAnswer = (overrides: Record<string, unknown> = {}) => ({
    awake: false,
    region: 'ams',
    regionName: 'Amsterdam',
    cpuKind: 'shared',
    cpus: 2,
    memoryMb: 4096,
    current: 'shared-2x',
    storageGb: 50,
    canResize: true,
    disclaimer: 'Estimates from Fly’s published prices.',
    sizes: [
      { id: 'shared-2x', cpuKind: 'shared', cpus: 2, memoryMb: 4096, hourlyUsd: 0.0297 },
      { id: 'performance-4x', cpuKind: 'performance', cpus: 4, memoryMb: 8192, hourlyUsd: 0.1722, standard: true },
    ],
    ...overrides,
  });

  const machineScript = (
    read: () => Record<string, unknown>,
    picked?: (size: string) => void,
  ): Record<string, Answer> => ({
    ...agentScreenScript('felix', () => versionAnswer({
      machine: { awake: false, region: 'ams', regionName: 'Amsterdam', memoryMb: 4096, cpuKind: 'shared', cpus: 2 },
    })),
    'GET api/agents/felix/machine': read,
    'POST api/agents/felix/machine': (call) => {
      const size = String(JSON.parse(String(call.init?.body)).size);
      picked?.(size);
      return { ok: true, changed: true, restarted: Boolean(read().awake), ...read(), current: size };
    },
  });
  /** The screen's reads in order — the open, then each re-read while it
   *  follows a change — with the last answer standing for every read after. */
  const readsInOrder = (...answers: Record<string, unknown>[]) => {
    let reads = 0;
    return () => answers[Math.min(reads++, answers.length - 1)]!;
  };
  const onFourDedicated = (overrides: Record<string, unknown> = {}) => machineAnswer({
    cpuKind: 'performance', cpus: 4, memoryMb: 8192, current: 'performance-4x', ...overrides,
  });
  const tapped = () => document.querySelector('#agentMachineDedicated [data-size="performance-4x"]')!;
  const wasCurrent = () => document.querySelector('#agentMachineShared [data-size="shared-2x"]')!;
  const nextRead = () => act(async () => { vi.advanceTimersByTime(RESIZE_POLL_MS); });

  it('the machine row opens what the machine is made of, and the sizes it could be', async () => {
    open(emptyState({ org, agents: [felix()] }), machineScript(() => machineAnswer()));
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Machine details and size/ }));
    expect(await screen.findByRole('heading', { name: 'Felix’s machine' })).toBeTruthy();

    const details = () => document.getElementById('agentMachineFacts')!;
    await waitFor(() => expect(details().textContent).toContain('2 shared cores · 4 GB'));
    // The disk is the one thing a size change does NOT touch, so it is named
    // beside the sizes rather than left to be guessed at.
    expect(details().textContent).toContain('50 GB');
    expect(details().textContent).toContain('Amsterdam');
    // A sleeping machine is the FREE case: nothing is running to interrupt.
    expect(details().textContent).toContain('wakes up on the new size');

    // The size it is on is a state, never a no-op button that would spend a
    // reboot to change nothing.
    const here = document.querySelector('#agentMachineShared [data-size="shared-2x"]')!;
    expect(here.className).toContain('current');
    expect(here.tagName).toBe('DIV');
    // Priced per AWAKE hour — a machine sleeps after fifteen idle minutes and
    // a monthly figure would overstate every rung.
    const other = document.querySelector('#agentMachineDedicated [data-size="performance-4x"]')!;
    expect(other.tagName).toBe('BUTTON');
    expect(other.textContent).toContain('4 dedicated cores · 8 GB');
    expect(other.textContent).toContain('about $0.17 an hour awake');
    expect(other.textContent).toContain('standard');
    // Shared is offered AND warned about, with the measurement.
    expect(document.getElementById('agentMachineSharedHint')!.textContent).toContain('91–94%');
  });

  it('a sleeping machine changes size with no question asked, and says it wakes up different', async () => {
    const picked: string[] = [];
    open(
      emptyState({ org, agents: [felix()] }),
      machineScript(() => machineAnswer(), (size) => picked.push(size)),
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Machine details and size/ }));
    fireEvent.click(await screen.findByRole('button', { name: /4 dedicated cores/ }));

    await waitFor(() => expect(picked).toEqual(['performance-4x']));
    // No dialog: there was nothing running on it to interrupt.
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.getElementById('agentMachineDone')!.textContent)
      .toBe('Saved. It wakes up on 4 dedicated cores · 8 GB.'));
    // The badge lands on the row that was tapped, as the runtime picker does.
    expect(document.querySelector('#agentMachineDedicated [data-size="performance-4x"]')!.className)
      .toContain('current');
  });

  it('an AWAKE machine asks before it restarts, and does nothing when the answer is no', async () => {
    const picked: string[] = [];
    open(
      emptyState({ org, agents: [felix()] }),
      machineScript(() => machineAnswer({ awake: true }), (size) => picked.push(size)),
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Machine details and size/ }));
    fireEvent.click(await screen.findByRole('button', { name: /4 dedicated cores/ }));

    expect(screen.getByRole('dialog').textContent).toContain('restarts');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(picked).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /4 dedicated cores/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Change size' }));
    await waitFor(() => expect(picked).toEqual(['performance-4x']));
    await waitFor(() => expect(document.getElementById('agentMachineDone')!.textContent)
      .toBe('Restarted on 4 dedicated cores · 8 GB. Its files are kept.'));
  });

  /**
   * What the first version got wrong (the owner's screenshot, 2026-09-06).
   * Fly reports a resized machine neither started nor stopped for a second
   * or two, and a read inside that window still says the OLD shape. Read
   * once and never again, the screen painted "Restarting" of a sleeping
   * machine, the old size, the badge on the old rung and a "Saved" line off
   * the bottom of the phone — then waited for a re-read that never came.
   */
  it('a change lands on the rung that was tapped, and the screen follows the machine until Fly confirms it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const inWindow = machineAnswer({ restarting: true });
    const read = readsInOrder(machineAnswer(), inWindow, onFourDedicated());
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...machineScript(read),
        'POST api/agents/felix/machine': () => ({ ok: true, changed: true, restarted: false, ...inWindow }),
      },
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Machine details and size/ }));
    fireEvent.click(await screen.findByRole('button', { name: /4 dedicated cores/ }));

    // The tapped rung says so, where the thumb already is — and the badge
    // stays where it was rather than hopping on a read that still says old.
    await waitFor(() => expect(tapped().className).toContain('moving'));
    expect(tapped().textContent).toContain('changing…');
    expect(wasCurrent().className).toContain('current');
    // The facts card says which of the two things is happening, in words
    // this screen knows to be true: it was asleep, and it stays asleep.
    const facts = () => document.getElementById('agentMachineFacts')!.textContent!;
    expect(facts()).toContain('Changing size');
    expect(facts()).not.toContain('Restarting');
    expect(facts()).toContain('Changing to 4 dedicated cores · 8 GB');
    expect(document.getElementById('agentMachineDone')).toBeNull();
    expect(document.getElementById('agentMachineSettling')).toBeNull();

    // One re-read still inside the window; the next one has arrived.
    await nextRead();
    expect(tapped().className).toContain('moving');
    await nextRead();
    await waitFor(() => expect(tapped().className).toContain('current'));
    expect(wasCurrent().className).not.toContain('current');
    expect(document.getElementById('agentMachineDone')!.textContent)
      .toBe('Saved. It wakes up on 4 dedicated cores · 8 GB.');
    expect(facts()).toContain('4 dedicated cores · 8 GB');
    expect(facts()).toContain('Asleep');
    expect(facts()).not.toContain('Changing to');
  });

  it('an awake machine says it is restarting onto the new size, then that it has', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const inWindow = machineAnswer({ awake: false, restarting: true });
    const read = readsInOrder(machineAnswer({ awake: true }), inWindow, onFourDedicated({ awake: true }));
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...machineScript(read),
        'POST api/agents/felix/machine': () => ({ ok: true, changed: true, restarted: true, ...inWindow }),
      },
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Machine details and size/ }));
    fireEvent.click(await screen.findByRole('button', { name: /4 dedicated cores/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Change size' }));

    const now = () => document.getElementById('agentMachineNow')!.textContent!;
    await waitFor(() => expect(now()).toContain('Restarting'));
    // Neither "Asleep" (Fly's flag says stopped for a moment mid-reboot) nor
    // "Saved, it wakes up on" — the machine was running and is coming back.
    expect(now()).toContain('It comes back on its own on 4 dedicated cores · 8 GB');
    expect(tapped().className).toContain('moving');

    await nextRead();
    await nextRead();
    await waitFor(() => expect(document.getElementById('agentMachineDone')!.textContent)
      .toBe('Restarted on 4 dedicated cores · 8 GB. Its files are kept.'));
    expect(now()).toContain('Awake');
    expect(tapped().className).toContain('current');
  });

  it('opened mid-change, it re-reads until the machine settles and the sizes come back on their own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open(
      emptyState({ org, agents: [felix()] }),
      machineScript(readsInOrder(machineAnswer({ restarting: true }), machineAnswer())),
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Machine details and size/ }));

    await waitFor(() => expect(document.getElementById('agentMachineSettling')).toBeTruthy());
    expect(document.getElementById('agentMachineSettling')!.textContent).toContain('come back on their own');
    expect((tapped() as HTMLButtonElement).disabled).toBe(true);

    await nextRead();
    await waitFor(() => expect(document.getElementById('agentMachineSettling')).toBeNull());
    expect((tapped() as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById('agentMachineFacts')!.textContent).toContain('Asleep');
  });

  it('stops following after two minutes and calls the change unconfirmed, not done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const inWindow = machineAnswer({ restarting: true });
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...machineScript(readsInOrder(machineAnswer(), inWindow)),
        'POST api/agents/felix/machine': () => ({ ok: true, changed: true, restarted: false, ...inWindow }),
      },
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Machine details and size/ }));
    fireEvent.click(await screen.findByRole('button', { name: /4 dedicated cores/ }));
    await waitFor(() => expect(tapped().className).toContain('moving'));

    await act(async () => { vi.advanceTimersByTime(RESIZE_FOLLOW_MS + RESIZE_POLL_MS); });
    await waitFor(() => expect(document.getElementById('agentMachineFail')!.textContent)
      .toContain('has not reported 4 dedicated cores · 8 GB yet'));
    expect(tapped().className).not.toContain('moving');
    expect(document.getElementById('agentMachineDone')).toBeNull();
  });

  /** A resize is a machine config write and Fly reboots a running machine on
   *  any successful one — mid-turn that kills the answer being written. */
  it('offers no size while a turn runs, and says when it will', async () => {
    open(
      emptyState({ org, agents: [agent({ ...felix(), working: true })] }),
      machineScript(() => machineAnswer()),
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Machine details and size/ }));

    // The read has to LAND first: `waitFor` is satisfied by a callback that
    // does not throw, and a null querySelector does not throw.
    await waitFor(() => expect(document.querySelector('#agentMachineDedicated .crow')).toBeTruthy());
    const row = document.querySelector('#agentMachineDedicated [data-size="performance-4x"]')!;
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById('agentMachineBusy')!.textContent).toContain('as soon as this turn finishes');
  });

  it('a machine still restarting is neither awake nor asleep, and takes no new size', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      machineScript(() => machineAnswer({ awake: false, restarting: true })),
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Machine details and size/ }));

    await waitFor(() => expect(document.querySelector('#agentMachineDedicated .crow')).toBeTruthy());
    // "Changing size", not "Restarting": a sleeping machine is in this window
    // for a second or two after a resize as well, and it never restarts.
    expect(document.getElementById('agentMachineFacts')!.textContent).toContain('Changing size');
    // Saying "Asleep" of a machine rebooting under the reader contradicts the
    // line the same screen showed a second ago.
    expect(document.getElementById('agentMachineFacts')!.textContent).not.toContain('Asleep');
    expect((document.querySelector('#agentMachineDedicated [data-size="performance-4x"]') as HTMLButtonElement).disabled)
      .toBe(true);
    expect(document.getElementById('agentMachineSettling')).toBeTruthy();
  });

  it('a backend that cannot move the machine says so instead of offering a dead row', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      machineScript(() => machineAnswer({ canResize: false })),
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Machine details and size/ }));

    await waitFor(() => expect(document.querySelector('#agentMachineDedicated .crow')).toBeTruthy());
    const row = document.querySelector('#agentMachineDedicated [data-size="performance-4x"]')!;
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById('agentMachineFixed')).toBeTruthy();
    // What it IS is still worth reading, so the facts stand.
    expect(document.getElementById('agentMachineFacts')!.textContent).toContain('2 shared cores · 4 GB');
  });

  it('says a refusal under the ladder, and a no-op change for what it was', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...machineScript(() => machineAnswer()),
        'POST api/agents/felix/machine': () => {
          throw new WorkspaceApiError('Felix is busy — change the machine when this turn finishes.', 400, {});
        },
      },
    );
    await title();
    fireEvent.click(await screen.findByRole('button', { name: /Machine details and size/ }));
    fireEvent.click(await screen.findByRole('button', { name: /4 dedicated cores/ }));

    await waitFor(() => expect(document.getElementById('agentMachineFail')!.textContent)
      .toContain('busy'));
    // Said under the card whose row was tapped, where the reader is already
    // looking — at the foot of the screen, below four lines about shared
    // cores, it is a message that reader never scrolls to.
    expect(document.getElementById('agentMachineFail')!.previousElementSibling!.id)
      .toBe('agentMachineDedicatedHint');
  });
});

describe('the delete', () => {
  const deletable = () => emptyState({ org, agents: [felix()] });

  it('shows the Workspace Agent\'s ask to remove the agent over the delete button, and Keep takes it off (note #710)', async () => {
    const kept: string[] = [];
    let fleet = [agent({ ...felix(), removeAsk: { at: '2026-10-09T10:00:00.000Z', canDecide: true, byAgentName: 'Workspace Agent', reason: 'its work is finished' } })];
    open(emptyState({ org, agents: fleet }), {
      ...workspaceScript(() => emptyState({ org, agents: fleet })),
      ...agentScreenScript('felix', () => versionAnswer()),
      'POST api/agents/felix/keep': (call) => { kept.push(call.path); fleet = [felix()]; return { ok: true, name: 'Felix' }; },
    });
    await title();
    expect(document.getElementById('agentRemoveAsk')!.textContent)
      .toBe('Chief of Staff asked you to remove this agent: its work is finished');
    // An ask lowers no gate: deleting is still the typed name.
    expect(screen.getByRole('button', { name: 'Delete this agent' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(kept).toEqual(['api/agents/felix/keep']));
    await waitFor(() => expect(document.getElementById('agentRemoveAsk')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Keep it' })).toBeNull();
  });

  it('cannot be tapped through: the name has to be typed', async () => {
    const deleted: string[] = [];
    open(deletable(), {
      ...agentScreenScript('felix', () => versionAnswer()),
      'DELETE api/agents/felix': (call) => { deleted.push(call.path); return { ok: true, name: 'Felix' }; },
    });
    await title();
    expect(document.getElementById('agentHint')!.textContent).toContain('Deleting erases its machine');
    fireEvent.click(screen.getByRole('button', { name: 'Delete this agent' }));
    const go = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type Felix to confirm'), { target: { value: 'felix' } });
    expect(go.disabled).toBe(true);
    // Trimmed, and only trimmed: a phone hands out a trailing space for free.
    fireEvent.change(screen.getByLabelText('Type Felix to confirm'), { target: { value: 'Felix ' } });
    expect(go.disabled).toBe(false);
    expect(deleted).toEqual([]);
  });

  // Home with the agents picker up: where the reader's agents are since
  // rooms left the product (note #843) — it was the room's Agents shelf.
  it('takes the reader to their agents with the card still leaving, then drops it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fleet = [felix()];
    const scripted = scriptedApi({
      ...workspaceScript(() => emptyState({ org, agents: fleet })),
      ...agentScreenScript('felix', () => versionAnswer()),
      'DELETE api/agents/felix': () => { fleet = []; return { ok: true, name: 'Felix' }; },
    });
    render(
      <MemoryRouter initialEntries={['/', '/agents/felix']} initialIndex={1}>
        <App api={scripted.api} />
      </MemoryRouter>,
    );
    await title();
    fireEvent.click(screen.getByRole('button', { name: 'Delete this agent' }));
    fireEvent.change(screen.getByLabelText('Type Felix to confirm'), { target: { value: 'Felix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // The agents first, so the card is on screen for the moment it leaves.
    const row = await waitFor(() => {
      const node = document.querySelector('#agentSwitchGrid .crow.deleting');
      expect(node).toBeTruthy();
      return node!;
    });
    expect(screen.getByRole('heading', { name: 'Your agents' })).toBeTruthy();
    expect(row.classList.contains('leaving')).toBe(true);
    expect(row.querySelector('.ctext')!.textContent).toBe('Erasing its machine…');
    // Mid-delete the row is no longer a door.
    expect(row.getAttribute('role')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await waitFor(() => expect(document.querySelector('#agentSwitchGrid .crow[data-agent]')).toBeNull());
    expect((await screen.findByRole('alert')).textContent).toContain('Deleted Felix');
  });
});

describe('the chat door', () => {
  it('is gone for an agent that can no longer take a turn', async () => {
    open(
      emptyState({ org, agents: [agent({ ...felix(), status: 'retired' })] }),
      agentScreenScript('felix', () => versionAnswer()),
    );
    await title();
    expect(document.getElementById('agentChat')).toBeNull();
    expect(document.getElementById('agentHint')!.textContent).toContain('Retired agents can no longer run');
  });

  it('opens the conversation', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      {
        ...agentScreenScript('felix', () => versionAnswer()),
        'GET api/agents/felix/chat': () => ({ messages: [], working: false }),
      },
    );
    await title();
    const door = document.getElementById('agentChat')!;
    expect(door.textContent).toBe('Open chat');
    expect(door.classList.contains('ghost')).toBe(true);
    expect(door.classList.contains('primary')).toBe(false);
    expect(door.querySelector('.icon')).toBeTruthy();
    fireEvent.click(door);
    await waitFor(() => expect(document.getElementById('agentChatTitle')).toBeTruthy());
    expect(document.getElementById('agentChatTitle')!.textContent).toBe('Felix');
  });
});

describe('an agent that is not there', () => {
  it('says so rather than painting an empty screen', async () => {
    open(emptyState({ org, agents: [] }), {}, '/agents/gone');
    expect((await screen.findByRole('alert')).textContent).toContain('That agent is not here');
  });

  // The way out was "Back to Rooms" while there were rooms (note #843): the
  // reader's agents now, the picker over Home.
  it('offers the way back to the reader’s agents', async () => {
    open(emptyState({ org, agents: [] }), {}, '/agents/gone');
    fireEvent.click(await screen.findByRole('button', { name: 'Back to your agents' }));
    expect(await screen.findByRole('heading', { name: 'Your agents' })).toBeTruthy();
    expect(document.getElementById('agentSwitchEmpty')).toBeTruthy();
  });
});

describe('a version read that fails', () => {
  it('says why on a screen with nothing else to show', async () => {
    open(
      emptyState({ org, agents: [felix()] }),
      { 'GET api/agents/felix/chat/latest': () => ({ message: null }), 'GET api/agents/felix/prs': () => ({ prs: [] }) },
    );
    await title();
    await waitFor(() => expect(document.getElementById('agentInfoCard')!.textContent).toContain('unscripted'));
  });

  it('leaves a warm screen’s rows standing', async () => {
    const seed: WorkspaceAgentVersionAnswer = versionAnswer({ installed: '9.9.9', pinned: '9.9.9' });
    open(
      emptyState({ org, agents: [agent({ ...felix(), version: seed })] }),
      { 'GET api/agents/felix/chat/latest': () => ({ message: null }), 'GET api/agents/felix/prs': () => ({ prs: [] }) },
    );
    await title();
    // A failed refresh does not erase rows that were true a moment ago.
    await waitFor(() => expect(document.getElementById('agentInfoCard')!.textContent).toContain('9.9.9'));
    expect(document.getElementById('agentInfoCard')!.textContent).not.toContain('unscripted');
  });
});
