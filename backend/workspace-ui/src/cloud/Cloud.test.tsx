import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceOrgDetail } from '../../../src/shared/workspace-api.js';
import { App } from '../App.js';
import { emptyState, homeShelf, scriptedApi, workspaceScript, type Answer } from '../test/fixtures.js';
import { WorkspaceApiError } from '../api/client.js';
import { READ_AGAIN_MS } from '../ui/read.js';
import { CLOUD_REFRESH_MS } from './useCloud.js';
const org = { orgId: 'o1', name: 'Good Company', role: 'admin', members: 1, seats: 1, seatProviders: ['codex'] };
const state = () => emptyState({ org });
/** No cloud of its own: hosted on ours (note #664), with its allowance. */
const hostedFly = (agents = 3, sites = 1) => ({
  connected: false as const, hosted: true as const,
  agents: { used: agents, limit: 20 }, sites: { used: sites, limit: 30 },
});
const disconnected = (role = 'admin') => ({ orgId: 'o1', role, fly: hostedFly(), machines: null });
const connected = (active = 2) => ({ orgId: 'o1', role: 'admin', fly: { connected: true, orgSlug: 'good-company', peer: 'up' }, machines: { active, sleeping: 3, checkedAt: new Date().toISOString() } });
/** The workplace's own record, which is where the card reads its account and
 *  its tunnel from; the counts on it come from `api/org/cloud`. */
const detail = (fly: WorkspaceOrgDetail['fly'], role: 'admin' | 'member' = 'admin'): { org: WorkspaceOrgDetail } => ({
  org: {
    orgId: 'o1', name: 'Good Company', role, canDelete: false, fly,
    members: [{ userId: 'u1', name: 'Saddam', you: true, role, joinedAt: '2026-08-01T00:00:00Z', agents: 0, workedMs: 0 }],
    invites: role === 'admin' ? [] : null,
  },
});
/** Home, where the New agent dialog is opened from — the agents picker by the
 *  message box. (It was a room's, in the picker, until rooms left the product
 *  — note #843.) The cloud card is not here any more (note #642), and since
 *  note #664 the dialog reads no cloud either — there is nothing to connect
 *  before an agent. */
function open(script: Record<string, Answer> = {}) {
  const scripted = scriptedApi({ ...workspaceScript(state), 'GET api/org/cloud': () => disconnected(), 'GET api/org/cloud?inventory=0': () => disconnected(), ...script });
  render(<MemoryRouter initialEntries={['/']}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}
/** The dialog over Home that is not its window (`#homeSheet` is one too). */
const askDialog = () => screen.queryAllByRole('dialog').find((one) => one.id !== 'homeSheet' && one.id !== 'agentSwitchSheet') ?? null;
/** The workplace screen, which is where the cloud card lives (note #642). */
function openWorkplace(script: Record<string, Answer> = {}) {
  const scripted = scriptedApi({
    ...workspaceScript(state),
    'GET api/org': () => detail({ connected: true, orgSlug: 'good-company', peer: 'up' }),
    'GET api/org/cloud': () => connected(),
    'GET api/org/cloud?inventory=0': () => disconnected(),
    ...script,
  });
  render(<MemoryRouter initialEntries={['/workplace?org=o1']}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}
const counts = () => document.querySelector('.cloudcounts')?.textContent ?? '';
afterEach(() => { vi.useRealTimers(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });

describe('the workplace’s cloud: ours by default (note #664), its own when it connected one before', () => {
  for (const role of ['admin', 'member'] as const) {
    it(`a hosted workplace shows no cloud settings to ${role === 'admin' ? 'an admin' : 'a member'} (note #668)`, async () => {
      const scripted = openWorkplace({
        'GET api/org': () => detail(hostedFly(role === 'admin' ? 3 : 20, role === 'admin' ? 1 : 0), role),
      });
      await screen.findByText('People');
      expect(document.getElementById('orgCloud')).toBeNull();
      expect(screen.queryByText('Agentic Cloud Computer')).toBeNull();
      expect(screen.queryByText('Free · nothing to connect')).toBeNull();
      expect(screen.queryByLabelText('Org deploy token')).toBeNull();
      expect(screen.queryByRole('button', { name: 'See cloud details' })).toBeNull();
      expect(scripted.calls.some((c) => c.path === 'api/org/cloud' || c.path === 'api/org/fly' || c.path === 'api/org/spend')).toBe(false);
    });
  }

  /** Note #801: the one exception to #668 — a workplace the platform marked. */
  const marked = () => ({ ...hostedFly(0, 0), ownCloudAllowed: true as const });
  it('a workplace the platform marked offers its admin the token form, and connecting reloads it (note #801)', async () => {
    let fly: WorkspaceOrgDetail['fly'] = marked();
    const scripted = openWorkplace({
      'GET api/org': () => detail(fly),
      'POST api/org/fly': () => {
        fly = { connected: true, orgSlug: 'customer-co', peer: 'up' };
        return { ok: true, orgSlug: 'customer-co', appCount: 0, peer: 'up', moved: false };
      },
    });
    const box = await screen.findByLabelText('Org deploy token');
    expect(document.getElementById('orgCloudConnect')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'fo1_customer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect cloud' }));
    await screen.findByText('customer-co');
    expect(scripted.calls.some((c) => c.path === 'api/org/fly')).toBe(true);
    expect(document.getElementById('orgCloudConnect')).toBeNull();
  });

  it('a member of a marked workplace sees no token form: connecting is the admin\'s errand (note #801)', async () => {
    openWorkplace({ 'GET api/org': () => detail(marked(), 'member') });
    await screen.findByText('People');
    expect(document.getElementById('orgCloud')).toBeNull();
    expect(screen.queryByLabelText('Org deploy token')).toBeNull();
  });

  it('a red line when Fly will not build until the bill is sorted, with the link to fix it (note #801)', async () => {
    openWorkplace({
      'GET api/org/cloud': () => ({
        ...connected(),
        billing: { problem: 'Fly says the bill for your Fly organization "good-company" is past due.', fixUrl: 'https://fly.io/dashboard/good-company/billing' },
      }),
    });
    const line = await waitFor(() => {
      const found = document.getElementById('orgCloudBilling');
      if (!found) throw new Error('no billing line yet');
      return found;
    });
    expect(line.textContent).toContain('is past due');
    expect(within(line).getByRole('link', { name: 'Open Fly billing' }).getAttribute('href')).toBe('https://fly.io/dashboard/good-company/billing');
  });

  it('draws the account, its tunnel and the door to the details', async () => {
    openWorkplace();
    await screen.findByText('good-company');
    await waitFor(() => expect(counts()).toContain('2 active3 sleeping'));
    const card = document.getElementById('orgCloudCard')!;
    expect(within(card).getByText('Your own cloud · private tunnel up')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'See cloud details' })).toBeTruthy();
  });

  /**
   * Note #642, the second half. "tunnel coming up" was worn by three
   * different situations — mid-setup, failed, and org #0's permanently
   * rolled-back peer — so it promised progress to two readers who were never
   * going to get any. Each state now says its own true thing, and the state
   * the record cannot speak to says nothing at all.
   */
  it('says what it knows about the tunnel, and nothing when it knows nothing', async () => {
    const lines: Record<string, string> = {
      up: 'Your own cloud · private tunnel up',
      'routed-elsewhere': 'Your own cloud · already reachable',
      failed: 'Private tunnel is not up',
      unknown: 'Your own cloud',
    };
    for (const [peer, line] of Object.entries(lines)) {
      const view = render(<MemoryRouter initialEntries={['/workplace?org=o1']}><App api={scriptedApi({
        ...workspaceScript(state),
        'GET api/org': () => detail({ connected: true, orgSlug: 'good-company', peer } as never),
        'GET api/org/cloud': () => connected(),
        'GET api/org/cloud?inventory=0': () => disconnected(),
      }).api} /></MemoryRouter>);
      const card = await screen.findByText('good-company').then((name) => name.closest('.card') as HTMLElement);
      expect(within(card).getByText(line)).toBeTruthy();
      // Only the one a reader can act on is marked; the benign route and the
      // silence must not look like faults.
      expect(within(card).queryByText('check it') ? 'marked' : 'plain').toBe(peer === 'failed' ? 'marked' : 'plain');
      // And no state of the tunnel ever reintroduces the promise.
      expect(card.textContent).not.toContain('coming up');
      view.unmount();
    }
  });

  it('hands a member the same sentence with no errand attached to it', async () => {
    openWorkplace({
      'GET api/org': () => detail({ connected: true, orgSlug: 'good-company', peer: 'failed' } as never, 'member'),
      'GET api/org/cloud': () => ({ ...connected(), role: 'member' }),
    });
    // The fact is everyone's; the mark asks for something only an admin can
    // do, so only an admin is given it.
    await screen.findByText('Private tunnel is not up');
    expect(document.querySelector('.badge.warn')).toBeNull();
    expect(screen.queryByRole('button', { name: 'See cloud details' })).toBeNull();
  });

  it('says nothing about the cloud on Home any more', async () => {
    open({ 'GET api/org/cloud': () => connected() });
    // Neither in the agents picker nor in the Workplace window.
    for (const shelf of ['agents', 'repositories'] as const) {
      await homeShelf(shelf);
      expect(document.querySelector('.cloudcounts')).toBeNull();
      expect(screen.queryByText('good-company')).toBeNull();
      expect(screen.queryByRole('button', { name: /cloud details/i })).toBeNull();
    }
  });

  for (const role of ['admin', 'member'] as const) {
    it(`New agent goes straight to the chooser for ${role === 'admin' ? 'an admin' : 'a member'} — nothing to connect first`, async () => {
      const scripted = open({
        'GET api/org/cloud': () => disconnected(role),
        'GET api/org/cloud?inventory=0': () => disconnected(role),
      });
      await homeShelf();
      fireEvent.click(document.getElementById('newAgentBtn')!);
      await screen.findByRole('heading', { name: 'New agent' });
      expect(within(askDialog()!).getByText('Codex')).toBeTruthy();
      expect(screen.queryByLabelText('Org deploy token')).toBeNull();
      expect(scripted.calls.some((c) => c.path === 'api/agents' || c.path === 'api/org/fly')).toBe(false);
      fireEvent.click(within(askDialog()!).getByText('Cancel'));
      expect(askDialog()).toBeNull();
    });
  }

  it('refreshes counts, pauses when hidden, catches up on return, and never calls failed inventory zero', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let active = 2;
    let failed = false;
    const scripted = openWorkplace({ 'GET api/org/cloud': () => failed ? { ...connected(), machines: null, inventoryError: 'Machine counts are unavailable.' } : connected(active) });
    await screen.findByText('good-company');
    await waitFor(() => expect(counts()).toContain('2 active'));
    active = 4;
    await act(async () => { await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_MS); });
    expect(counts()).toContain('4 active');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    fireEvent(document, new Event('visibilitychange'));
    const before = scripted.calls.filter(c => c.path === 'api/org/cloud').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_MS * 2); });
    expect(scripted.calls.filter(c => c.path === 'api/org/cloud')).toHaveLength(before);
    failed = true;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByText('Machine counts are unavailable.');
    expect(counts()).not.toContain('0 active');
    // The account is a fact of the workplace record, not of the inventory, so
    // a failed count never takes the cloud's name off the screen with it.
    expect(screen.getByText('good-company')).toBeTruthy();
  });
});

/**
 * The card that would not hold still (note #354).
 *
 * "Fly cloud information should be read from cache, so UI should be stable.
 * Silently refetched should be." — over a screenshot showing 8 active and 23
 * sleeping. The card stood on Home when he wrote it and stands on the
 * workplace screen now (note #642); the complaint and the answer travelled
 * with it, because the screen it is on is a route either way.
 */
describe('the cloud card holds still', () => {
  /** A read whose connection was accepted and then abandoned. */
  const silence = () => new Promise<never>(() => { /* deliberately never settles */ });
  /** Everything a failing read spends before it gives up: three attempts, and
   *  the two pauses between them. Rejections are immediate here, so only the
   *  pauses cost time. */
  const WHOLE_READ = READ_AGAIN_MS.reduce((a, b) => a + b, 0) + 100;
  const spend = () => ({
    orgSlug: 'good-company',
    totals: { estimatedMonthlyUsd: 0, runningMonthlyUsd: 0, spentThisMonthUsd: 0, unmeasured: 0, running: 0, stopped: 0 },
    machines: [],
    disclaimer: 'Estimates from Fly’s published prices.',
  });

  it('comes Back to the counts it already read, with no wait drawn over them', async () => {
    let reads = 0;
    // Turned on for the trip BACK, so that anything on screen then is what the
    // held copy put there and nothing else.
    let stall = false;
    openWorkplace({
      'GET api/org/cloud': () => { reads += 1; return stall ? silence() : connected(2); },
      'GET api/org/spend': () => spend(),
      'GET api/org/agent-machine': () => ({ current: 'performance-2x', chosen: false, canChoose: true, sizes: [], disclaimer: '' }),
    });
    await screen.findByText('good-company');
    await waitFor(() => expect(counts()).toContain('2 active'));

    // Exactly the trip the note describes: off the card to the machines, back.
    fireEvent.click(screen.getByText('See cloud details').closest('button')!);
    await screen.findByText('Nothing runs in the cloud account yet.');
    const asked = reads;
    stall = true;
    await act(async () => { fireEvent.click(document.getElementById('pageBack')!); });

    // The card is simply there — no flash, no placeholder, same counts.
    expect(screen.getByText('good-company')).toBeTruthy();
    expect(counts()).toContain('2 active3 sleeping');
    expect(counts()).not.toContain('Reading machine counts');
    // And it did go and ask, underneath: served from a copy, never stale.
    expect(reads).toBeGreaterThan(asked);
  });

  it('absorbs a refresh that fails, rather than taking the counts away to report it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let broken = false;
    openWorkplace({
      'GET api/org/cloud': () => {
        if (broken) throw new WorkspaceApiError('Bad gateway', 502, {});
        return connected(2);
      },
    });
    await screen.findByText('good-company');
    await waitFor(() => expect(counts()).toContain('2 active'));
    broken = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_MS + WHOLE_READ); });

    // The reader asked for nothing. Taking the counts off the screen to report
    // a hiccup they did not cause is the worse of the two answers; holding
    // what was last read is the honest one.
    expect(counts()).toContain('2 active');
    expect(document.body.textContent).not.toContain('Bad gateway');
  });

  it('does put the counts away when the answer is a refusal rather than a hiccup', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let refused = false;
    openWorkplace({
      'GET api/org/cloud': () => {
        if (refused) throw new WorkspaceApiError('You are not a member of this workplace.', 403, {});
        return connected(2);
      },
    });
    await screen.findByText('good-company');
    await waitFor(() => expect(counts()).toContain('2 active'));
    refused = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_MS + WHOLE_READ); });

    // What is held is no longer true, and a machine count nobody is entitled
    // to any more must not be left on the screen.
    await waitFor(() => expect(counts()).toContain('You are not a member of this workplace.'));
    expect(counts()).not.toContain('active');
  });
});
