import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceCopyHealth, WorkspaceCopyReleases, WorkspaceCopyUpgradeRun, WorkspaceCopyUpgradeState, WorkspaceOrgDetail,
} from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { WorkspaceApiError } from '../../api/client.js';

/**
 * Upgrade from inside the Workspace (note #1008, the mock-ups on note #1007):
 * the button beside the release line, the four-line confirmation, and one
 * run's progress that keeps going while the Workspace restarts, then success
 * with the new release's notes, or the old release put back.
 */
vi.mock('../../../../src/shared/private-copy.js', () => ({ PRIVATE_COPY: true, SIGNUP_CLOSED: false, FIRST_ACCOUNT_FRAGMENT: 'first-account' }));

const behind = {
  state: 'behind', running: '2026.11.01.1', latest: '2026.11.10.0', reachedAt: '2026-11-10T09:00:00.000Z',
  triedAt: '2026-11-10T09:00:00.000Z', lastError: null, howToUpgrade: 'To upgrade, whoever installed this Agentic Cloud runs node install.mjs upgrade in the folder they installed it from.',
} as const;
const health: WorkspaceCopyHealth = {
  release: '2026.11.01.1', commit: null, running: '2026.11.01.1', latest: '2026.11.10.0', updates: behind, checkedAt: new Date().toISOString(),
  parts: [{ key: 'workspace', name: 'Workspace', ok: true, line: 'Up 6 days · release 2026.11.01.1 · latest 2026.11.10.0' }],
};
const step = (key: string, label: string, state: 'done' | 'now' | 'wait' | 'fail', seconds: number | null = null, back = false) => ({ key, label, state, seconds, back });
const run = (over: Partial<WorkspaceCopyUpgradeRun>): WorkspaceCopyUpgradeRun => ({
  id: 'r1', requestedBy: 'Dana Rivera', from: '2026.11.01.1', to: '2026.11.10.0', drill: null,
  startedAt: '2026-11-10T15:02:00.000Z', finishedAt: null, phase: 'running', heardSecondsAgo: 4, message: null, snapshotAt: '2026-11-10T15:02:50.000Z',
  steps: [step('copy', 'Release copied into your registry', 'done', 41), step('snapshot', 'Database backed up, disks snapshotted', 'done', 9), step('to-b', 'Workspace → 2026.11.10.0', 'now'), step('smoke', 'Final check', 'wait')],
  ...over,
});
const offer: WorkspaceCopyUpgradeState = {
  running: '2026.11.01.1', latest: '2026.11.10.0', behind: true,
  offer: { version: '2026.11.10.0', date: '2026-11-10', agentsWorking: 3, minutes: 3 }, refusal: null, run: null,
};
const notes = '# Upgrades from the Workspace\n\n## What\'s new\n\n- An Upgrade button for admins.\n\n## Fixed\n\n- Nothing.\n\n## Needs you\n\n- Nothing.\n';
const releases: WorkspaceCopyReleases = {
  updates: { ...behind, state: 'current', running: '2026.11.10.0', latest: '2026.11.10.0', howToUpgrade: null },
  releases: [{ version: '2026.11.10.0', date: '2026-11-10', summary: 'Upgrades from the Workspace', notes, running: true }],
};
const detail = (role: 'admin' | 'member'): WorkspaceOrgDetail => ({
  orgId: 'o1', name: 'Theirco', role, invites: [], joinRequests: [],
  fly: { connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 } },
  members: [{ userId: 'u1', name: 'Dana Rivera', you: true, role, joinedAt: '2026-10-27T00:00:00Z', agents: 0, workedMs: 0 }],
});

async function open(path: string, role: 'admin' | 'member', upgrade: () => WorkspaceCopyUpgradeState, extra: Record<string, Answer> = {}) {
  vi.useFakeTimers();
  const org = { orgId: 'o1', name: 'Theirco', role, members: 2, seats: 0, seatProviders: [] };
  const state = () => emptyState({ org, canCreateOrg: true, organizations: [{ orgId: 'o1', name: 'Theirco', role, active: true, members: 2, agents: 0 }] });
  const scripted = scriptedApi({
    ...workspaceScript(state),
    'GET api/org': () => ({ org: detail(role) }),
    'GET api/copy/health': () => health,
    'GET api/copy/releases': () => releases,
    'GET api/copy/upgrade': () => upgrade(),
    ...extra,
  });
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  return scripted;
}
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

afterEach(() => { vi.useRealTimers(); });

describe('the Upgrade button (note #1008)', () => {
  it('stands beside the release line, asks with four lines, and starts the newest release', async () => {
    let current = offer;
    const scripted = await open('/workplace', 'admin', () => current, {
      'POST api/copy/upgrade': () => { current = { ...offer, offer: null, run: run({ phase: 'starting', steps: [step('start', 'Starting the upgrader', 'now')] }) }; return { id: 'r1' }; },
    });
    expect(document.querySelector('#orgCopyUpgradeHint')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to 2026.11.10.0' }));
    const dialog = document.querySelector('#copyUpgradeConfirm')!;
    expect(dialog.textContent).toContain('Upgrade to 2026.11.10.0?');
    expect(dialog.textContent).toContain('From 2026.11.01.1. It takes about 3 minutes.');
    expect(dialog.querySelectorAll('.upconfirm li')).toHaveLength(4);
    expect(dialog.textContent).toContain('3 agents are working.');
    expect(dialog.textContent).toContain('Anything written in those minutes is lost.');
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade now' }));
    await wait(20);
    const post = scripted.calls.find((call) => call.init?.method === 'POST' && call.path === 'api/copy/upgrade')!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ version: '2026.11.10.0' });
    expect(document.querySelector('#screenCopyUpgrade')!.getAttribute('data-phase')).toBe('starting');
  });

  it('says why there is no button, and keeps the command, when the upgrader is not set up yet', async () => {
    await open('/workplace', 'admin', () => ({ ...offer, offer: null, refusal: 'The upgrader is not set up here yet. Your engineer runs node install.mjs upgrade once; after that the button works.' }));
    expect(screen.queryByRole('button', { name: /^Upgrade to/ })).toBeNull();
    expect(document.querySelector('#orgCopyUpgradeRefusal')!.textContent).toContain('runs node install.mjs upgrade once');
    expect(document.querySelector('#orgCopyUpgradeHint')).not.toBeNull();
  });

  it('shows a run under way to any admin, instead of the button', async () => {
    await open('/workplace', 'admin', () => ({ ...offer, offer: null, run: run({}) }));
    expect(document.querySelector('#orgCopyUpgradeOpen')!.textContent).toContain('An upgrade to 2026.11.10.0 is under way.');
    expect(screen.queryByRole('button', { name: /^Upgrade to/ })).toBeNull();
  });
});

describe('the progress screen (note #1008)', () => {
  it('keeps the steps and reconnects by itself while the Workspace restarts, then shows the new release and its notes', async () => {
    let answer: () => WorkspaceCopyUpgradeState = () => ({ ...offer, offer: null, run: run({}) });
    await open('/workplace/upgrade', 'admin', () => answer());
    expect(screen.getByRole('heading', { name: 'Upgrading to 2026.11.10.0' })).toBeTruthy();
    expect([...document.querySelectorAll('.upsteps li')].map((li) => li.getAttribute('data-state'))).toEqual(['done', 'done', 'now', 'wait']);
    answer = () => { throw new WorkspaceApiError('Bad gateway', 502, {}); };
    await wait(2_100);
    expect(document.querySelector('#copyUpgradeAway')!.textContent).toContain('The Workspace is restarting itself.');
    expect(document.querySelectorAll('.upsteps li')).toHaveLength(4);
    answer = () => ({ ...offer, running: '2026.11.10.0', behind: false, offer: null, run: run({ phase: 'done', finishedAt: '2026-11-10T15:04:41.000Z', steps: run({}).steps.map((s) => ({ ...s, state: 'done' as const })) }) });
    await wait(2_100);
    expect(document.querySelector('#copyUpgradeAway')).toBeNull();
    expect(document.querySelector('#copyUpgradeDone')!.textContent).toContain('Your Agentic Cloud runs 2026.11.10.0. It took 2 min 41 s');
    await wait(20);
    expect(document.querySelector('#copyUpgradeNotesTitle')!.textContent).toBe('What\'s new in 2026.11.10.0');
    expect(document.querySelector('.copyreleasenotes')!.textContent).toContain('An Upgrade button for admins.');
  });

  it('after five minutes away, says the upgrade carries on outside the Workspace and names the engineer\'s check', async () => {
    let fail = false;
    await open('/workplace/upgrade', 'admin', () => { if (fail) throw new WorkspaceApiError('Bad gateway', 502, {}); return { ...offer, offer: null, run: run({}) }; });
    fail = true;
    await wait(5 * 60_000 + 4_000);
    expect(document.querySelector('#copyUpgradeAway')!.textContent).toContain('The Workspace has not answered for 5 minutes.');
    expect(document.querySelector('#copyUpgradeAway')!.textContent).toContain('node install.mjs status');
  });

  it('when a step failed: the old release is back, what failed, the diagnostics and Try again', async () => {
    await open('/workplace/upgrade', 'admin', () => ({
      ...offer, offer: null,
      run: run({
        phase: 'put-back', finishedAt: '2026-11-10T15:08:00.000Z', message: 'The upgrade to 2026.11.10.0 failed and agents.theirco.test is back on 2026.11.01.1 (6 min 0 s).',
        steps: [step('to-g', 'Code host → 2026.11.10.0', 'fail'), step('back-b', 'Workspace back to 2026.11.01.1', 'done', 52, true)],
      }),
    }));
    expect(screen.getByRole('heading', { name: 'The upgrade did not go through' })).toBeTruthy();
    expect(document.querySelector('#copyUpgradePutBack')!.textContent).toContain('2026.11.01.1 was put back, and every part answers.');
    expect(document.querySelector('#copyUpgradePutBack')!.textContent).toContain('Your data is as it was at 15:02 UTC; anything written between then and 15:08 is lost.');
    expect(document.querySelector('#copyUpgradeFailedTitle')!.closest('section')!.textContent).toContain('Code host → 2026.11.10.0');
    expect(screen.getByRole('button', { name: 'Download diagnostics' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('a run whose upgrader went quiet offers Carry on', async () => {
    const scripted = await open('/workplace/upgrade', 'admin', () => ({ ...offer, offer: null, run: run({ phase: 'stopped', heardSecondsAgo: 300 }) }), {
      'POST api/copy/upgrade/carry-on': () => ({ id: 'r1' }),
    });
    expect(screen.getByRole('heading', { name: 'The upgrade stopped part-way' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Carry on' }));
    await wait(20);
    expect(scripted.calls.some((call) => call.init?.method === 'POST' && call.path === 'api/copy/upgrade/carry-on')).toBe(true);
  });

  it('is an admin\'s alone', async () => {
    await open('/workplace/upgrade', 'member', () => offer);
    expect(document.querySelector('#screenCopyUpgrade')!.textContent).toContain('Only an admin of this workplace can upgrade it.');
  });
});
