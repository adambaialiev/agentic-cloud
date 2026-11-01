import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../App.js';
import { emptyState, scriptedApi, signedOut, workspaceScript, type Answer, type Call } from '../../test/fixtures.js';
import type {
  WorkspacePublicAddressAnswer,
  WorkspacePublicPersonBoard,
} from '../../../../src/shared/workspace-api.js';
import type { LeaderboardDay } from '../../../../src/shared/leaderboard.js';
import { dayTitle, dayWordsUtc, formatHours, formatTokens } from './board-words.js';

/**
 * A builder's page (note #200): their week, all time and last 90 days, the
 * door to it from the header's account menu, and Settings' X profile. The
 * public Leaderboard went on 28 Oct 2026 (Adam, note #824), and with it its
 * Settings switch and the sign-up line; these tests also pin that it stays
 * gone.
 */

const HOUR = 3_600_000;
const body = (call: Call) => JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;

function renderAt(path: string, script: Record<string, Answer>) {
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

describe('a builder’s page', () => {
  it('writes hours and tokens short, with the unit on the number', () => {
    expect([formatHours(214 * HOUR), formatHours(24 * 60_000), formatHours(0), formatHours(59.6 * 60_000)]).toEqual(['214h', '24min', '0h', '1h']);
    expect([formatTokens(96_240_000), formatTokens(512_300), formatTokens(640)]).toEqual(['96.2M', '512K', '640']);
  });

  const person = (over: Partial<Extract<WorkspacePublicAddressAnswer, { kind: 'person' }>['person']> = {}): WorkspacePublicAddressAnswer => ({
    kind: 'person',
    person: { handle: 'adam', name: 'Adam B', repos: [], ...over },
  });

  it('adds Follow on X, this week and the last 90 days, and no place on any board', async () => {
    renderAt('/adam', {
      'GET auth/session': signedOut,
      'GET api/public/addresses/adam': () => person({
        x: 'AdamBuiltThis',
        board: { agents: 10, working: 6, runs: ['claude', 'codex'], week: { workingMs: 214 * HOUR, merged: 38, claude: 96_200_000 }, grid: [0, 4], gridStart: '2026-07-13', days: [{ workingMs: null, merged: 0 }, { workingMs: null, merged: 3 }], allTime: { workingMs: 300 * HOUR, claude: 120_000_000 } },
      }),
    });
    expect(await screen.findByRole('heading', { name: 'Adam B' })).toBeTruthy();
    const follow = screen.getByRole('link', { name: 'Follow @AdamBuiltThis on X' });
    expect(follow.getAttribute('href')).toBe('https://x.com/AdamBuiltThis');
    expect(follow.getAttribute('target')).toBe('_blank');
    expect(screen.queryByText(/Leaderboard/)).toBeNull();
    expect(screen.getByText('6 of 10 agents working now')).toBeTruthy();
    expect(screen.getByText('214h')).toBeTruthy();
    expect(screen.getByText('changes merged')).toBeTruthy();
    expect(screen.getByText('96.2M')).toBeTruthy();
    // What the number is, said plainly (note #203): output tokens since Monday.
    expect(document.getElementById('personTokens')!.textContent).toBe('Claude Code 96.2M tokens written');
    expect(document.getElementById('personTokensHint')!.textContent)
      .toBe('Tokens written: what this person’s agents wrote since Monday, not what they read.');
    expect(screen.queryByText(/Codex .* tokens/)).toBeNull();
    expect(screen.getByRole('group', { name: 'Activity over the last 90 days' }).children).toHaveLength(91);
    // All time (note #209), saying since when it counts.
    expect(document.getElementById('personAllTime')!.textContent).toContain('Claude Code tokens written');
    // The person and their week: no empty repositories card under it.
    expect(screen.queryByText('Public repositories')).toBeNull();
  });

  describe('tapping a day of the last 90 (note #208)', () => {
    // Monday 12 October 2026: 20 July to today, the 13th week its Monday
    // only. The ledgers kept days from 10 October, square 82.
    const days: LeaderboardDay[] = Array.from({ length: 85 }, (_, index) => (
      index < 82 ? { workingMs: null, merged: index === 63 ? 4 : 0 } : { workingMs: 0, merged: 0 }
    ));
    days[82] = { workingMs: 2 * HOUR, merged: 1, claude: 1_200_000 }; // Sat 10 Oct
    days[83] = { workingMs: 22 * 60_000, merged: 3, claude: 640, codex: 512_300 }; // Sun 11 Oct
    const board: WorkspacePublicPersonBoard = {
      agents: 16, working: 3, runs: ['claude'], week: { workingMs: 24 * 60_000, merged: 0, claude: 1_000 },
      grid: days.map((day) => (day.workingMs ? 2 : 0)), gridStart: '2026-07-20', days, allTime: { workingMs: 2 * HOUR },
    };
    const open = async () => {
      renderAt('/adam', { 'GET auth/session': signedOut, 'GET api/public/addresses/adam': () => person({ board }) });
      await screen.findByRole('heading', { name: 'Adam B' });
      return screen.getByRole('group', { name: 'Activity over the last 90 days' });
    };
    const square = (day: string) => screen.getByRole('button', { name: dayTitle(day) });
    const panel = () => document.getElementById('personDay');
    const title = () => panel()!.querySelector('.lbdaytitle')!.textContent;
    const stats = () => [...panel()!.querySelectorAll('.lbstats > div')].map((stat) => stat.textContent);
    const tokens = () => panel()!.querySelector('.lbtokens')?.textContent;

    it('says what a square is for, and makes each day up to today a square to tap', async () => {
      const grid = await open();
      expect(within(grid).getAllByRole('button')).toHaveLength(85);
      expect(grid.querySelectorAll('.lbcell.later')).toHaveLength(6);
      expect(screen.getByText(/Tap a day to see its numbers\.$/)).toBeTruthy();
      expect(panel()).toBeNull();
    });

    it('shows the day’s date, agent hours, merges and tokens written, and switches with another tap', async () => {
      await open();
      fireEvent.click(square('2026-10-10'));
      expect(title()).toBe(dayTitle('2026-10-10'));
      expect(stats()).toEqual(['2hagent hours', '1change merged']);
      expect(tokens()).toBe('Claude Code 1.2M tokens written');
      expect(square('2026-10-10').getAttribute('aria-expanded')).toBe('true');
      // The day takes the hint's place.
      expect(screen.queryByText(/Tap a day to see its numbers/)).toBeNull();

      fireEvent.click(square('2026-10-11'));
      expect(title()).toBe(dayTitle('2026-10-11'));
      expect(stats()).toEqual(['22minagent hours', '3changes merged']);
      expect(tokens()).toBe('Claude Code 640 tokens writtenCodex 512K tokens written');
      expect(square('2026-10-10').getAttribute('aria-expanded')).toBe('false');

      // Today, with nothing yet: zeros, since the ledgers keep today.
      fireEvent.click(square('2026-10-12'));
      expect(stats()).toEqual(['0hagent hours', '0changes merged']);
      expect(tokens()).toBe('No tokens written');
      expect(panel()!.querySelector('.lbdaynote')).toBeNull();
    });

    it('shows a day before the ledgers kept days as no data, not zero, and still its merges', async () => {
      await open();
      fireEvent.click(square('2026-09-21'));
      expect(stats()).toEqual(['–agent hours', '4changes merged']);
      expect(tokens()).toBeUndefined();
      expect(panel()!.querySelector('.lbdaynote')!.textContent).toMatch(/^No hours or tokens were counted before .*2026\.$/);
    });

    it('raises a pointed-at day as a card over the grid, and none for the open day (2026-10-27)', async () => {
      await open();
      const card = () => document.querySelector('.daycard');
      fireEvent.mouseEnter(square('2026-10-11'));
      expect(card()!.getAttribute('role')).toBe('tooltip');
      expect(card()!.querySelector('.lbdaytitle')!.textContent).toBe(dayTitle('2026-10-11'));
      expect([...card()!.querySelectorAll(':scope > span')].map((line) => line.textContent))
        .toEqual(['22min agent hours', '3 changes merged', 'Claude Code 640 tokens written', 'Codex 512K tokens written']);
      // Pointing opens nothing: the hint stays.
      expect(panel()).toBeNull();
      fireEvent.mouseLeave(square('2026-10-11'));
      expect(card()).toBeNull();

      // Before the ledgers: no hours, never a zero, and no token line.
      fireEvent.mouseEnter(square('2026-09-21'));
      expect([...card()!.querySelectorAll(':scope > span')].map((line) => line.textContent))
        .toEqual(['– agent hours', '4 changes merged']);
      fireEvent.mouseLeave(square('2026-09-21'));

      fireEvent.click(square('2026-10-10'));
      fireEvent.mouseEnter(square('2026-10-10'));
      expect(card()).toBeNull();
    });

    it('closes on a tap outside, on the same square again, and on Escape — and stays open for a tap on itself', async () => {
      await open();
      fireEvent.click(square('2026-10-10'));
      fireEvent.pointerDown(panel()!);
      expect(panel()).not.toBeNull();
      fireEvent.pointerDown(document.getElementById('personWeek')!);
      expect(panel()).toBeNull();
      expect(screen.getByText(/Tap a day to see its numbers\.$/)).toBeTruthy();

      fireEvent.click(square('2026-10-10'));
      fireEvent.click(square('2026-10-10'));
      expect(panel()).toBeNull();

      fireEvent.click(square('2026-10-10'));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(panel()).toBeNull();
    });

    it('is one stop in the tab order, and the arrow keys walk a day up and down, a week across', async () => {
      const grid = await open();
      expect(within(grid).getAllByRole('button').filter((cell) => cell.tabIndex === 0)).toEqual([square('2026-10-12')]);
      fireEvent.click(square('2026-10-10'));
      expect(within(grid).getAllByRole('button').filter((cell) => cell.tabIndex === 0)).toEqual([square('2026-10-10')]);
      fireEvent.keyDown(square('2026-10-10'), { key: 'ArrowDown' });
      expect(document.activeElement).toBe(square('2026-10-11'));
      expect(title()).toBe(dayTitle('2026-10-11'));
      fireEvent.keyDown(square('2026-10-11'), { key: 'ArrowLeft' });
      expect(document.activeElement).toBe(square('2026-10-04'));
      fireEvent.keyDown(square('2026-10-04'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe(square('2026-10-11'));
      // Nothing past today to walk to.
      fireEvent.keyDown(square('2026-10-11'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe(square('2026-10-11'));
    });
  });

  it('shows their totals over all time, Claude Code and Codex apart, and since when they count (note #209)', async () => {
    renderAt('/adam', {
      'GET auth/session': signedOut,
      'GET api/public/addresses/adam': () => person({
        board: {
          agents: 16, working: 3, runs: ['claude', 'codex'], week: { workingMs: 24 * 60_000, merged: 0, claude: 18_462 },
          grid: [0, 4], gridStart: '2026-07-20', days: [{ workingMs: null, merged: 0 }, { workingMs: 0, merged: 0 }],
          allTime: { workingMs: 41 * HOUR, claude: 2_640_000, codex: 512_300 },
        },
      }),
    });
    expect(await screen.findByRole('heading', { name: 'All time' })).toBeTruthy();
    const card = document.getElementById('personAllTime')!;
    expect([...card.querySelectorAll('.lbstats > div')].map((stat) => stat.textContent))
      .toEqual(['41hagent hours', '2.6MClaude Code tokens written', '512KCodex tokens written']);
    expect(document.getElementById('personAllTimeSince')!.textContent)
      .toBe(`Counted since ${dayWordsUtc('2026-10-10')}, when hours and tokens began to be kept by day.`);
  });

  it('shows only the provider they ran, and hours alone when no tokens were written', async () => {
    renderAt('/adam', {
      'GET auth/session': signedOut,
      'GET api/public/addresses/adam': () => person({
        board: {
          agents: 1, working: 0, runs: ['codex'], week: { workingMs: 0, merged: 0 }, grid: [0], gridStart: '2026-07-20',
          days: [{ workingMs: null, merged: 0 }], allTime: { workingMs: 3 * HOUR },
        },
      }),
    });
    await screen.findByRole('heading', { name: 'All time' });
    const card = document.getElementById('personAllTime')!;
    expect([...card.querySelectorAll('.lbstats > div')].map((stat) => stat.textContent)).toEqual(['3hagent hours']);
  });

  it('is the person and their repositories when the page carries no numbers', async () => {
    renderAt('/adam', { 'GET auth/session': signedOut, 'GET api/public/addresses/adam': () => person() });
    expect(await screen.findByRole('heading', { name: 'Adam B' })).toBeTruthy();
    expect(screen.queryByText('This week')).toBeNull();
    expect(screen.queryByText('All time')).toBeNull();
    expect(screen.queryByRole('link', { name: /Follow/ })).toBeNull();
    expect(screen.getByText('Public repositories')).toBeTruthy();
  });
});

describe('the Leaderboard is gone (note #824)', () => {
  it('has no page at /leaderboard: the shell reads it as an address nobody holds', async () => {
    // The edge sends the old address home (public/_redirects); this is
    // what the Workspace itself says if it is ever asked.
    const { calls } = renderAt('/leaderboard', { 'GET auth/session': signedOut });
    expect(await screen.findByRole('heading', { name: 'Nothing at this address' })).toBeTruthy();
    expect(calls.some((call) => call.path.startsWith('api/public/leaderboard'))).toBe(false);
  });

  it('says nothing about it under Create account', async () => {
    renderAt('/signup', { 'GET auth/session': signedOut });
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy();
    expect(document.getElementById('authLeaderboardNote')).toBeNull();
    expect(screen.queryByText(/Leaderboard/)).toBeNull();
  });
});

describe('the account menu opens your builder page (note #824)', () => {
  const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 1, seats: 0, seatProviders: [] };
  const withAddress = (address?: string) => {
    const state = emptyState({ org });
    return { ...state, user: { ...state.user!, account: { ...state.user!.account, ...(address ? { mailbox: { address } } : {}) } } };
  };

  it('makes the name the door to their own page, with no Leaderboard row', async () => {
    renderAt('/', {
      ...workspaceScript(() => withAddress('adam@agenticcloudcomputer.com')),
      'GET api/public/addresses/adam': () => ({ kind: 'person', person: { handle: 'adam', name: 'Adam B', repos: [] } }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Your account' }));
    const menu = await screen.findByRole('menu', { name: 'Your account' });
    expect(within(menu).queryByText('Leaderboard')).toBeNull();
    const self = within(menu).getAllByRole('menuitem')[0]!;
    expect(self.id).toBe('accountMenuSelf');
    fireEvent.click(self);
    expect(await screen.findByRole('heading', { name: 'Adam B' })).toBeTruthy();
  });

  it('leaves the name as words for someone with no address yet', async () => {
    renderAt('/', workspaceScript(() => withAddress()));
    fireEvent.click(await screen.findByRole('button', { name: 'Your account' }));
    const menu = await screen.findByRole('menu', { name: 'Your account' });
    expect(menu.querySelector('#accountMenuSelf')).toBeNull();
    expect(menu.querySelector('#accountMenuName')).toBeTruthy();
  });
});

describe('Settings → Your builder page', () => {
  const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 1, seats: 0, seatProviders: [] };

  it('keeps the X profile they add, and has no Leaderboard switch', async () => {
    let settings: { x?: string } = {};
    const { calls } = renderAt('/profile', {
      ...workspaceScript(() => emptyState({ org })),
      'GET api/profile/x': () => settings,
      'PUT api/profile/x': (call) => {
        const asked = body(call);
        settings = { x: String(asked.x).replace(/^@/, '') || undefined };
        return settings;
      },
    });

    expect(await screen.findByRole('heading', { name: 'Your builder page' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: /Leaderboard/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /X profile/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@AdamBuiltThis' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('@AdamBuiltThis · a Follow on X button on your page')).toBeTruthy();
    expect(body(calls.find((call) => call.init?.method === 'PUT')!)).toEqual({ x: '@AdamBuiltThis' });
  });

  it('refuses what cannot be an X handle before sending it', async () => {
    const { calls } = renderAt('/profile', {
      ...workspaceScript(() => emptyState({ org })),
      'GET api/profile/x': () => ({}),
    });
    fireEvent.click(await screen.findByRole('button', { name: /X profile/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'not a handle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('That is not an X handle');
    expect(calls.some((call) => call.init?.method === 'PUT')).toBe(false);
  });
});
