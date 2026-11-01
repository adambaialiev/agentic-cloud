import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceOrgDetail, WorkspacePeopleAnswer } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { agent, emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { PEOPLE_POLL_MS } from './usePeople.js';

/**
 * The People page (note #328) end to end against a scripted API: the
 * workplace's members drawn like the fleet, with their faces, a state
 * line, the latest thing they drove — and a tick that moves those two facts
 * without re-reading the workplace.
 */

function renderAt(path: string, script: Record<string, Answer>) {
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 2, seats: 1, seatProviders: ['claude'] };
const state = () => emptyState({
  org, canCreateOrg: true,
  organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 2, agents: 1 }],
  agents: [agent({ id: 'a', name: 'Ada' })],
});
// A minute past two hours, so the row's clock cannot round it down to 1h.
const twoHoursAgo = () => new Date(Date.now() - 121 * 60_000).toISOString();
const members = (): WorkspacePeopleAnswer['people'] => [
  { userId: 'u1', name: 'Saddam', you: true, role: 'admin', joinedAt: '2026-08-01T00:00:00Z', agents: 1, workedMs: 0, photoUrl: '/faces/saddam.png', lastSeenAt: twoHoursAgo(), recap: 'Approved proposal #634: Subscription item active dot', recapAt: twoHoursAgo() },
  { userId: 'u2', name: 'Mira Chen', you: false, role: 'member', joinedAt: '2026-08-20T00:00:00Z', agents: 2, workedMs: 0, lastSeenAt: new Date().toISOString(), here: true },
];
/** What the people lists read (`api/org/people`), and what the member's own
 *  screen still reads behind a plate (`api/org`) — the same people. */
const people = (): WorkspacePeopleAnswer => ({ org: { orgId: 'o1', name: 'Nomad Trading', role: 'admin', workedMs: 0 }, people: members() });
const orgDetail = (): WorkspaceOrgDetail => ({
  name: 'Nomad Trading', role: 'admin', invites: null, fly: { connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 } }, members: members(),
});

afterEach(() => { vi.useRealTimers(); });

describe('the People page', () => {
  it('draws each person like an agent plate — face, facts, state, latest — with the people here leading', async () => {
    renderAt('/workplace/people?org=o1', {
      ...workspaceScript(state),
      'GET api/org/people': () => people(),
      'GET api/org': () => ({ org: orgDetail() }),
      'GET api/org/people/live': () => ({ people: [] }),
    });
    expect(await screen.findByRole('heading', { name: 'People' })).toBeTruthy();
    // The title stands before the record lands; the sub-line is what says it did.
    expect(await screen.findByText('Nomad Trading · 2 people · 1 here now')).toBeTruthy();
    const rows = [...document.querySelectorAll('#people .crow')] as HTMLElement[];
    expect(rows.map((row) => row.querySelector('.name')!.textContent)).toEqual(['Mira Chen', 'Saddam']);

    // Note #833's card: initials where there is no picture, "You" and
    // "Admin" as quiet words beside the name, no "Member", no agent count
    // line, and nothing in monospace.
    const mira = rows[0]!;
    expect(mira.querySelector('.personhead .avatar.initials')!.textContent).toBe('MC');
    expect(mira.querySelector('.personname')!.textContent).toBe('Mira Chen');
    expect(mira.querySelector('.cruntime')).toBeNull();
    expect(mira.textContent).not.toMatch(/Member|agents|no agents/);
    expect(mira.querySelector('.cline .livedot')).toBeTruthy();
    expect(mira.querySelector('.cline .ctext')!.textContent).toBe('Here now');
    expect(mira.querySelector('.cabout')).toBeNull();

    const saddam = rows[1]!;
    expect((saddam.querySelector('img.avatar') as HTMLImageElement).getAttribute('src')).toBe('/faces/saddam.png');
    expect([...saddam.querySelectorAll('.personname .badge')].map((badge) => badge.textContent)).toEqual(['You', 'Admin']);
    expect(saddam.querySelector('.cline .livedot')).toBeNull();
    expect(saddam.querySelector('.cline .ctext')!.textContent).toBe('Active 2h ago');
    expect(saddam.querySelector('.cabout')!.textContent).toBe('Approved proposal #634: Subscription item active dot');
    // WHEN that happened (note #385), riding the line's last word (note #833).
    expect(saddam.querySelector('.cago')!.textContent).toBe('2h\u00a0ago');
    // Nothing driven yet, so nothing to place in time.
    expect(mira.querySelector('.cago')).toBeNull();

    // A plate is a door onto the member's own screen.
    fireEvent.click(mira);
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    expect(screen.getByText('Here now')).toBeTruthy();
  });

  /**
   * Which agents a person drives (2026-09-23), and since 2026-10-28 what
   * each is doing (Adam: "what their agents cooking"): on the plate, one
   * line per agent — face, name, Working or Idle, its recap — the working
   * ones first and each a door to its agent, while the rest of the plate
   * still opens the person; and their page names every one. (It named each
   * one's room too, while there were rooms — note #843; the answer may still
   * carry `roomName`, and the page does not draw it.)
   */
  it('shows what each of a person’s agents is doing, on the plate and on their page, each a door', async () => {
    const withAgents = (): WorkspacePeopleAnswer['people'] => members().map((member) => (member.userId === 'u2'
      ? {
        ...member,
        agents: 2,
        agentFaces: [
          { id: 'kit', name: 'Kit', recap: 'Drafted the pricing page; waiting on Mira.' },
          { id: 'leo', name: 'Leo', avatarUrl: '/avatars/leo', roomName: 'Math school', working: true, recap: 'Fixing the footer on the landing page.' },
        ],
      }
      : member));
    renderAt('/workplace/people?org=o1', {
      ...workspaceScript(state),
      'GET api/org/people': () => ({ ...people(), people: withAgents() }),
      'GET api/org': () => ({ org: { ...orgDetail(), members: withAgents() } }),
      'GET api/org/people/live': () => ({ people: [] }),
      'GET api/agents/leo/card': () => ({
        agent: { id: 'leo', name: 'Leo', cli: 'claude', status: 'ready' },
        owner: { userId: 'u2', name: 'Mira Chen' },
      }),
    });
    await screen.findByText('Nomad Trading · 2 people · 1 here now');
    const mira = document.querySelector('#people .crow[data-person="u2"]') as HTMLElement;
    const lines = [...mira.querySelectorAll('.cagents .cagent')] as HTMLElement[];
    // The working one leads.
    expect(lines.map((line) => line.getAttribute('data-agent-door'))).toEqual(['leo', 'kit']);
    // Working is the blue dot alone (Adam, 31 Oct 2026), named for a screen reader; Idle keeps its word.
    expect(lines.map((line) => line.querySelector('.castate')!.textContent)).toEqual(['', 'Idle']);
    expect(lines[0]!.querySelector('.castate .livedot')!.getAttribute('aria-label')).toBe('Working');
    expect(lines.map((line) => line.querySelector('.carecap')?.textContent)).toEqual([
      'Fixing the footer on the landing page.', 'Drafted the pricing page; waiting on Mira.',
    ]);
    expect(mira.querySelector('.cagents')!.getAttribute('aria-label')).toBe('Mira Chen’s agents');

    fireEvent.click(mira.querySelector('.crow .name')!);
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    const pills = [...document.querySelectorAll('#orgMemberAgents .memberagent')] as HTMLElement[];
    expect(pills.map((pill) => pill.textContent)).toEqual([
      'LeoWorkingFixing the footer on the landing page.',
      'KitIdleDrafted the pricing page; waiting on Mira.',
    ]);
    expect(document.querySelector('#orgMemberAgents .v')!.textContent).toBe('2 agents');
    fireEvent.click(screen.getByRole('button', { name: 'Open Leo, working' }));
    expect(await screen.findByRole('heading', { name: 'Leo' })).toBeTruthy();
  });

  it('a press on an agent’s line opens that agent, not the person', async () => {
    const withAgents = (): WorkspacePeopleAnswer['people'] => members().map((member) => (member.userId === 'u2'
      ? { ...member, agentFaces: [{ id: 'leo', name: 'Leo', working: true, recap: 'Fixing the footer.' }] }
      : member));
    renderAt('/workplace/people?org=o1', {
      ...workspaceScript(state),
      'GET api/org/people': () => ({ ...people(), people: withAgents() }),
      'GET api/org/people/live': () => ({ people: [] }),
      'GET api/agents/leo/card': () => ({
        agent: { id: 'leo', name: 'Leo', cli: 'claude', status: 'ready' },
        owner: { userId: 'u2', name: 'Mira Chen' },
      }),
    });
    await screen.findByText('Nomad Trading · 2 people · 1 here now');
    fireEvent.click(document.querySelector('#people .cagent[data-agent="leo"] .carecap')!);
    expect(await screen.findByRole('heading', { name: 'Leo' })).toBeTruthy();
  });

  it('three agents on a plate, then a count; the page names them all', async () => {
    const many = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => ({ id, name: id.toUpperCase() }));
    renderAt('/workplace/people?org=o1', {
      ...workspaceScript(state),
      'GET api/org/people': () => ({ ...people(), people: members().map((member) => (member.userId === 'u2' ? { ...member, agents: 5, agentFaces: many } : member)) }),
      'GET api/org/people/live': () => ({ people: [] }),
    });
    await screen.findByText('Nomad Trading · 2 people · 1 here now');
    const mira = document.querySelector('#people .crow[data-person="u2"]') as HTMLElement;
    expect(mira.querySelectorAll('.cagent')).toHaveLength(3);
    expect(mira.querySelector('.cagentmore')!.textContent).toBe('+2 more agents');
  });

  it('a tick moves the state line and the latest line in place, without re-reading the workplace', async () => {
    vi.useFakeTimers();
    const seen = new Date().toISOString();
    const { calls } = renderAt('/workplace/people?org=o1', {
      ...workspaceScript(state),
      'GET api/org/people': () => people(),
      'GET api/org/people/live': () => ({ people: [
        { userId: 'u1', lastSeenAt: seen, here: true, recap: 'Messaged Ruby', recapAt: seen },
        { userId: 'u2', lastSeenAt: twoHoursAgo() },
      ] }),
    });
    // Under fake timers the reads are microtasks: one empty advance lands them.
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByRole('heading', { name: 'People' })).toBeTruthy();
    expect(screen.getByText('Nomad Trading · 2 people · 1 here now')).toBeTruthy();
    // The rows are read on open (and again when the workplace context
    // settles — the hook's own rule); the tick must never add to that.
    const orgReads = () => calls.filter((call) => call.path === 'api/org/people').length;
    const before = orgReads();
    expect(calls.some((call) => call.path === 'api/org/people/live')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(PEOPLE_POLL_MS + 50); });
    expect(calls.filter((call) => call.path === 'api/org/people/live')).toHaveLength(1);
    const rows = [...document.querySelectorAll('#people .crow')] as HTMLElement[];
    expect(rows.map((row) => row.querySelector('.name')!.textContent)).toEqual(['Saddam', 'Mira Chen']);
    expect(rows[0]!.querySelector('.cline .ctext')!.textContent).toBe('Here now');
    expect(rows[0]!.querySelector('.cabout')!.textContent).toBe('Messaged Ruby');
    // The tick carries the stamp with the line, so the ago moves with it.
    expect(rows[0]!.querySelector('.cago')!.textContent).toBe('just\u00a0now');
    expect(rows[1]!.querySelector('.cline .ctext')!.textContent).toBe('Active 2h ago');
    expect(screen.getByText('Nomad Trading · 2 people · 1 here now')).toBeTruthy();
    expect(orgReads()).toBe(before);
  });
  it('a tick moves an agent’s state and recap in place, and drops one that has gone (2026-10-28)', async () => {
    vi.useFakeTimers();
    const withAgents = (): WorkspacePeopleAnswer['people'] => members().map((member) => (member.userId === 'u2'
      ? { ...member, agents: 2, agentFaces: [{ id: 'leo', name: 'Leo', recap: 'Old line' }, { id: 'kit', name: 'Kit' }] }
      : member));
    renderAt('/workplace/people?org=o1', {
      ...workspaceScript(state),
      'GET api/org/people': () => ({ ...people(), people: withAgents() }),
      'GET api/org/people/live': () => ({ people: [
        { userId: 'u1', lastSeenAt: twoHoursAgo(), agents: [] },
        { userId: 'u2', lastSeenAt: new Date().toISOString(), here: true, agents: [{ id: 'leo', working: true, recap: 'Shipping the footer fix.' }] },
      ] }),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const line = () => document.querySelector('#people .cagent[data-agent="leo"]') as HTMLElement;
    expect(line().querySelector('.castate')!.textContent).toBe('Idle');
    expect(line().querySelector('.carecap')!.textContent).toBe('Old line');
    await act(async () => { await vi.advanceTimersByTimeAsync(PEOPLE_POLL_MS + 20); });
    expect(line().querySelector('.castate .livedot')!.getAttribute('aria-label')).toBe('Working');
    expect(line().querySelector('.castate')!.textContent).toBe('');
    expect(line().querySelector('.carecap')!.textContent).toBe('Shipping the footer fix.');
    expect(document.querySelector('#people .cagent[data-agent="kit"]')).toBeNull();
    expect(document.querySelectorAll('#people .crow[data-person="u2"] .cagent')).toHaveLength(1);
  });

  /**
   * Note #925: every person's card says what their agents did here this
   * week — hours, changes merged, tokens written per provider, and the
   * latest change's title — with zero said as zero, and the tick moves it
   * in place; the member's own screen reads the whole of it, live.
   */
  it('shows each person’s week here on their card, zero as zero, and the tick moves it (note #925)', async () => {
    vi.useFakeTimers();
    const week = (over: Partial<NonNullable<WorkspacePeopleAnswer['people'][number]['contribution']>> = {}) => ({
      week: { workingMs: 4 * 3_600_000, merged: 2, tokens: { claude: 182_000, codex: 41_000 } },
      latest: { id: 'pr-7', title: 'Live van map with ETAs on the dispatcher screen', at: twoHoursAgo(), number: 7, repo: 'dispatch', agentName: 'Leo' },
      ...over,
    });
    renderAt('/workplace/people?org=o1', {
      ...workspaceScript(state),
      'GET api/org/people': () => ({
        ...people(),
        people: members().map((member) => ({
          ...member,
          contribution: member.userId === 'u2' ? week() : { week: { workingMs: 0, merged: 0, tokens: {} } },
        })),
      }),
      'GET api/org/people/live': () => ({ people: [
        { userId: 'u1', lastSeenAt: twoHoursAgo(), contribution: { week: { workingMs: 0, merged: 0, tokens: {} } } },
        { userId: 'u2', lastSeenAt: new Date().toISOString(), here: true, contribution: week({
          week: { workingMs: 5 * 3_600_000, merged: 3, tokens: { claude: 190_000, codex: 41_000 } },
          latest: { id: 'pr-8', title: 'Driver ETAs in the customer text', at: new Date().toISOString(), number: 8, repo: 'dispatch', agentName: 'Leo' },
        }) },
      ] }),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const block = (userId: string) => document.querySelector(`#people .crow[data-person="${userId}"] .pcontrib`) as HTMLElement;
    const stats = (userId: string) => [...block(userId).querySelectorAll('.pcstats > div')]
      .map((stat) => `${stat.querySelector('b')!.textContent} ${stat.querySelector('span')!.textContent!.replace(/\u00a0/g, ' ')}`);
    expect(block('u2').querySelector('.pchead')!.textContent).toBe('This week');
    // One grammar (note #928): every figure a number over its label, tokens
    // one cell per provider that wrote any.
    expect(stats('u2')).toEqual(['4h agent hours', '2 changes merged', '182K tokens · Claude Code', '41K tokens · Codex']);
    expect(block('u2').querySelector('[data-stat="codex"]')!.getAttribute('title')).toBe('Tokens written: what their agents wrote, not what they read.');
    expect(block('u2').querySelector('.pclatest b, .pclatest strong')).toBeNull();
    expect(block('u2').querySelector('.pclatest')!.textContent).toBe('Merged: Live van map with ETAs on the dispatcher screen\u00a0·\u00a02h\u00a0ago');
    // Between the latest line and the agents, as the brief placed it.
    const card = document.querySelector('#people .crow[data-person="u2"]')!;
    expect([...card.children].map((child) => child.className)).toEqual(['personhead', 'pcontrib']);
    // Nothing yet is a row of zeros, never a missing block.
    expect(stats('u1')).toEqual(['0h agent hours', '0 changes merged', '0 tokens written']);
    expect(block('u1').querySelector('.pclatest')).toBeNull();
    // No rank, no medal: the deck keeps its order (here now leads).
    expect([...document.querySelectorAll('#people .crow')].map((row) => row.getAttribute('data-person'))).toEqual(['u2', 'u1']);

    await act(async () => { await vi.advanceTimersByTimeAsync(PEOPLE_POLL_MS + 20); });
    expect(stats('u2')).toEqual(['5h agent hours', '3 changes merged', '190K tokens · Claude Code', '41K tokens · Codex']);
    expect(block('u2').querySelector('.pctitle')!.textContent).toBe('Driver ETAs in the customer text');
    expect(block('u2').querySelector('.cago')!.textContent).toBe('just\u00a0now');
  });

  it('the member’s screen reads their whole contribution: this week, all time, and each change a door (note #925)', async () => {
    const { calls } = renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(state),
      'GET api/org/people': () => people(),
      'GET api/org': () => ({ org: { ...orgDetail(), members: members().map((member) => (member.userId === 'u2'
        ? { ...member, workedMs: 30 * 3_600_000, formerAgents: [{ name: 'Ruby', workedMs: 3_000_000 }] }
        : member)) } }),
      'GET api/org/members/u2/contribution': () => ({
        weekStart: '2026-10-26',
        tokensFrom: '2026-10-10',
        week: { workingMs: 4 * 3_600_000, merged: 2, tokens: { codex: 41_000 } },
        allTime: { workingMs: 30 * 3_600_000, merged: 17, tokens: { claude: 2_400_000, codex: 610_000 } },
        merged: [
          { id: 'pr-8', title: 'Driver ETAs in the customer text', at: new Date().toISOString(), number: 8, repo: 'dispatch', agentName: 'Leo' },
          { id: 'pr-7', title: 'Live van map with ETAs on the dispatcher screen', at: twoHoursAgo(), number: 7, repo: 'dispatch' },
        ],
      }),
    });
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    const stats = (selector: string) => [...document.querySelectorAll(`${selector} .pcstats > div`)]
      .map((stat) => `${stat.querySelector('b')!.textContent} ${stat.querySelector('span')!.textContent!.replace(/\u00a0/g, ' ')}`);
    await screen.findByText('Driver ETAs in the customer text');
    expect(stats('#orgMemberWeek')).toEqual(['4h agent hours', '2 changes merged', '41K tokens · Codex']);
    expect(stats('#orgMemberWorked')).toEqual(['30h agent hours', '17 changes merged', '2.4M tokens · Claude Code', '610K tokens · Codex']);
    expect([...document.querySelectorAll('#orgMemberWorked .cago')].map((line) => line.textContent))
      .toEqual(['including Ruby 50m, no longer here', 'Tokens counted since Oct 10, 2026.']);
    const changes = [...document.querySelectorAll('#orgMemberMerged .memberchange')] as HTMLElement[];
    expect(changes.map((row) => [row.querySelector('.mctitle')!.textContent, row.querySelector('.mcfacts')!.textContent, row.querySelector('.mcago')!.textContent]))
      .toEqual([
        ['Driver ETAs in the customer text', 'Leo · dispatch #8', 'just now'],
        ['Live van map with ETAs on the dispatcher screen', 'dispatch #7', '2h ago'],
      ]);
    // The agents row stays as it was; the old "Agents worked" row is All time now.
    expect(document.querySelector('#orgMemberAgents')).toBeTruthy();
    expect(document.querySelector('#orgMemberCard')!.textContent).not.toContain('Agents worked');
    fireEvent.click(changes[0]!);
    await act(async () => { await Promise.resolve(); });
    expect(calls.some((call) => call.path === 'api/org/members/u2/contribution')).toBe(true);
    // The door opened the proposal's own screen, which asks for it by id.
    expect(document.querySelector('#screenOrgMember')).toBeNull();
    expect(calls.some((call) => call.path === 'api/prs/pr-8')).toBe(true);
  });
});

