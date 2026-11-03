import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceOrgDetail,
  WorkspaceSeatRecord,
  WorkspaceBucketRow,
  WorkspaceSecretRow,
  WorkspaceSiteRow,
  WorkspaceStateAnswer,
} from '../../../src/shared/workspace-api.js';
import { App } from '../App.js';
import { WorkspaceApiError } from '../api/client.js';
import { holdPeople } from './org/people-cache.js';
import { standInWorkplace, standingWorkplace } from '../workspace/standing-workplace.js';
import { agent, emptyState, homeShelf, note, scriptedApi, workspaceScript, type Answer, type Call } from '../test/fixtures.js';
import { CLOUD_READ_AGAIN_MS } from '../cloud/useCloudRead.js';
import { SEAT_SIGNIN_POLL_MS } from './seats/SeatSignInScreen.js';
import { LIVE_POLL_MS } from '../workspace/WorkspaceProvider.js';
import { WAIT_HOLD_MS, WAIT_QUIET_MS } from '../ui/wait.js';

/**
 * The administration screens (slice 8) end to end against a scripted API:
 * what the legacy page's grab()-based tests held its workplace, seats,
 * sign-in, site, secrets and profile screens to. (And its rooms, until rooms
 * left the product — note #843.)
 */

function renderAt(path: string, script: Record<string, Answer>) {
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}
const body = (call: Call) => JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;
const WEEK_MS = 7 * 24 * 3600_000;
const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 2, seats: 1, seatProviders: ['claude'] };
const orgState = (overrides: Partial<WorkspaceStateAnswer> = {}) => emptyState({
  org, canCreateOrg: true,
  organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 2, agents: 1 }, { orgId: 'o2', name: 'Side Hustle', role: 'member', active: false, members: 1, agents: 0 }],
  agents: [agent({ id: 'a', name: 'Ada', avatarUrl: '/faces/ada.png' })],
  ...overrides,
});
const orgDetail = (overrides: Partial<WorkspaceOrgDetail> = {}): WorkspaceOrgDetail => ({
  name: 'Nomad Trading', role: 'admin',
  members: [
    { userId: 'u1', name: 'Saddam', you: true, role: 'admin', joinedAt: '2026-08-01T00:00:00Z', agents: 1, workedMs: 0 },
    { userId: 'u2', name: 'Mira Chen', you: false, role: 'member', joinedAt: '2026-08-20T00:00:00Z', invitedByName: 'Saddam', agents: 3, workedMs: 0 },
  ],
  invites: [{
    token: 'tok-1',
    link: 'https://acc.test/invite/tok-1',
    createdAt: '2026-09-01T00:00:00Z',
  }],
  canDelete: false, blocked: 'Nomad Trading still has 1 agent.',
  fly: { connected: true, orgSlug: 'nomad-trading', peer: 'up' },
  git: { repoCount: 2, totalSizeBytes: 5 * 1024 * 1024, host: { health: 'ok', volumeSizeGb: 10, diskUsedPercent: 12, growByGb: 10, growMonthlyUsd: 1.5, repoMaxBytes: 1024 * 1024 * 1024, repoMaxBytesAfterGrow: 2 * 1024 * 1024 * 1024 }, backup: { bucket: 'nomad-backups', everyHours: 6, last: { at: '2026-09-02T09:00:00Z', ok: true } } },
  ...overrides,
});
const seat = (overrides: Partial<WorkspaceSeatRecord> = {}): WorkspaceSeatRecord => ({
  seatId: 's1', provider: 'claude', label: 'Claude · signed in 1 Sep', planText: 'Max 5x', status: 'active', selected: true, createdAt: '2026-09-01T00:00:00Z',
  windows: [{ label: '5 hours', usedPercent: 40, percentText: '40', trackText: '5 hours', windowMins: 300, resetAt: new Date(Date.now() + 3600_000).toISOString() }, { label: '7 days', usedPercent: 91, percentText: '91', trackText: 'this week', windowMins: 10_080, resetAt: new Date(Date.now() + 0.4 * WEEK_MS).toISOString() }],
  ...overrides,
});
const site = (overrides: Partial<WorkspaceSiteRow> = {}): WorkspaceSiteRow => ({
  // The answer still has a field for the room that deployed it; nothing on
  // screen reads it since rooms left the product (note #843).
  name: 'shop', url: 'https://shop.agentbuilt.app', preset: 'static', status: 'live', kind: 'site', agentName: 'Ada', agentAvatarUrl: '/faces/ada.png', createdAt: '2026-08-30T00:00:00Z', lastDeployAt: '2026-09-02T08:00:00Z', ...overrides,
});
const bucket = (overrides: Partial<WorkspaceBucketRow> = {}): WorkspaceBucketRow => ({
  name: 'bishkek-3d-tiles', public: true, bucket: 'iabkt-547027dcc674', hostedOn: 'platform', createdAt: '2026-09-01T00:00:00Z',
  createdBy: 'Caleb (Bishkek 3D)', agentName: 'Caleb', agentAvatarUrl: '/faces/caleb.png', agentId: 'caleb',
  // The answer may still name the room its keys were saved from; the page
  // said so until rooms left the product (note #843).
  publicUrl: 'https://iabkt-547027dcc674.fly.storage.tigris.dev',
  secretNames: ['BISHKEK_3D_TILES_S3_ENDPOINT', 'BISHKEK_3D_TILES_S3_BUCKET', 'BISHKEK_3D_TILES_S3_ACCESS_KEY_ID', 'BISHKEK_3D_TILES_S3_SECRET_ACCESS_KEY'],
  ...overrides,
});
const secret = (overrides: Partial<WorkspaceSecretRow> = {}): WorkspaceSecretRow => ({
  name: 'GH_TOKEN', maskedValue: '••••', maskedPreview: 'ghp_…9f', valueLength: 40, valueKind: 'token', description: 'GitHub pushes', scope: 'shared', updatedAt: '2026-09-01T00:00:00Z', ...overrides,
});
const quiet: Record<string, Answer> = {
  'GET api/org/signin': () => ({ signin: null }),
};
/** The ladder the cloud screen's own read answers with (note #355). */
const machineSizes = () => [
  { id: 'shared-1x', cpuKind: 'shared', cpus: 1, memoryMb: 2048, hourlyUsd: 0.0107 },
  { id: 'performance-2x', cpuKind: 'performance', cpus: 2, memoryMb: 4096, hourlyUsd: 0.0861 },
  { id: 'performance-4x', cpuKind: 'performance', cpus: 4, memoryMb: 8192, hourlyUsd: 0.1722 },
];
const newAgentMachine = (overrides: Record<string, unknown> = {}) => ({
  current: 'performance-2x', chosen: false, canChoose: true,
  sizes: machineSizes(),
  disclaimer: 'Estimates from Fly\u2019s published prices — the Fly dashboard is the authority.',
  ...overrides,
});
/** Every cloud-screen test reads it; the ones about the machines say nothing
 *  about it, so the answer is here rather than in each of them. */
const cloudQuiet: Record<string, Answer> = {
  ...quiet,
  'GET api/org/agent-machine': () => newAgentMachine(),
};

/** Answer the app's own yes/no, where `window.confirm` used to stand. The
 *  dialog is a portal on the body, so it is found by role and answered by
 *  the verb on its button — never by a stub of a browser API. */
const answerAsk = async (verb: string) => {
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: verb }));
};

afterEach(() => { vi.useRealTimers(); });

describe('Home cards', () => {
  it('draws the seats, the sites and the secrets on Home, each a door to its screen', async () => {
    renderAt('/overview', {
      ...workspaceScript(() => orgState({
        org: { ...org, seatUsage: [{ seatId: 's1', provider: 'claude', label: 'Claude · 1 Sep', planText: 'Max 5x', selected: true, windows: [{ usedPercent: 91, percentText: '91', trackText: 'this week' }] }] },
        sites: [site(), site({ name: 'api', kind: 'service', status: 'provisioning', url: undefined })],
        secrets: [secret(), secret({ name: 'OPENAI_KEY', description: undefined, scope: 'agent', agentId: 'a', agentName: 'Ada' })],
      })),
      ...quiet,
    });
    const seats = await screen.findByText('Claude');
    const card = seats.closest('.seatcard') as HTMLElement;
    expect(within(card).getByText('Max 5x')).toBeTruthy();
    // Nobody is mid-turn on it, so it carries no mark at all (note #326):
    // being primary is not being used, and the dot only means the latter.
    expect(card.querySelector('.seatdot')).toBeNull();
    expect(card.querySelector('.pct.hot')!.textContent).toBe('91%');
    const addSub = screen.getByRole('button', { name: /Add sub/ });
    expect(addSub).toBeTruthy();
    expect(addSub.querySelector('.icon')).toBeNull();
    // Note #345: one sideways row of plates. The door is the LAST plate IN
    // the strip, not a rail under it, and no card wraps them — jsdom cannot
    // see the scrolling, but it can see that the shape allows it.
    const strip = document.getElementById('seatsHome')!;
    expect(strip.closest('.card')).toBeNull();
    expect([...strip.children].map((node) => node.className)).toEqual(['seatcard', 'seatadd']);

    // The sign-ins above, the SITES (note #566) and the SECRETS (note #783)
    // belong to the workplace, so they share its window — each a row onto a
    // screen of its own since note #960.
    expect(document.getElementById('indexSites')!.textContent).toBe('Sites2 sites on agentbuilt.app');
    expect(document.getElementById('indexSecrets')!.textContent).toBe('Secrets2 secrets');
    await homeShelf('sites');
    expect(screen.getByRole('heading', { name: 'Sites' })).toBeTruthy();
    expect(document.querySelector('#screenSites #sitesCard')).toBeTruthy();
    const shop = screen.getByText('shop').closest('.crow') as HTMLElement;
    expect(shop.querySelector('.cwhen')!.textContent).toContain('updated');
    const api = screen.getByText('api').closest('.crow') as HTMLElement;
    expect(within(api).getByText('setting up')).toBeTruthy();
    expect(api.querySelector('.cside')!.textContent).toBe('app');
    // The domain is the screen's line, not a footer explaining the list.
    expect(document.getElementById('sitesSub')!.textContent).toBe('2 sites on agentbuilt.app');
    expect(screen.queryByText(/Each site is at its own name/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    await homeShelf('secrets');
    expect(screen.getByRole('heading', { name: 'Secrets' })).toBeTruthy();
    expect(document.querySelector('#screenSecrets #secretsList')).toBeTruthy();
    const gh = screen.getByText('GH_TOKEN').closest('.crow') as HTMLElement;
    expect(within(gh).getByText('GitHub pushes')).toBeTruthy();
    expect(screen.getByText('No description yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add a secret/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    // The site's row is the Sites screen's: open it again to walk through.
    await homeShelf('sites');
    fireEvent.click(screen.getByText('shop').closest('.crow') as HTMLElement);
    expect(await screen.findByRole('heading', { name: 'shop' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(document.getElementById('screenSites')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await homeShelf('secrets');
    fireEvent.click(await screen.findByText('GH_TOKEN'));
    await screen.findByText('What it’s for');
    expect(screen.getByText('token · 40 characters')).toBeTruthy();
  });

  it('collapses many secrets into one door, hides Add a secret from a member, and sends the seats door to the seats', async () => {
    renderAt('/', {
      ...workspaceScript(() => orgState({ org: { ...org, role: 'member' }, secrets: Array.from({ length: 6 }, (_, i) => secret({ name: `KEY_${i}` })) })),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [], available: [] }),
    });
    // The Workplace window's Secrets card FIRST: a role query cannot see a
    // window the reader has not opened, so "no Add a secret" would otherwise
    // pass on any Home at all — including one where the button is standing
    // right there.
    await homeShelf('secrets');
    expect(document.getElementById('secretsSub')!.textContent).toContain('6 secrets');
    expect(screen.queryByRole('button', { name: /Add a secret$/ })).toBeNull();
    // With no sign-ins the sentence explaining the empty row stands ABOVE
    // the strip rather than sitting in it as a plate of its own (note #345).
    // The strip is the Workplace window's.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(document.getElementById('seatsHome')).toBeTruthy());
    const strip = document.getElementById('seatsHome')!;
    expect(strip.querySelector('.empty')).toBeNull();
    expect(document.getElementById('seatsHomeSection')!.querySelector('.empty')!.textContent)
      .toContain('No sign-ins here yet');
    expect([...strip.children].map((node) => node.className)).toEqual(['seatadd']);
    fireEvent.click(screen.getByRole('button', { name: /Add sub/ }));
    expect(await screen.findByRole('heading', { name: 'Your subscriptions' })).toBeTruthy();
  });

  // Note #326. The chip on a subscription used to be drawn from `selected`
  // and a current reading, which is a fact about ASSIGNMENT: it claimed use
  // on a primary nobody had touched, and said nothing at all on a fallback
  // three pinned agents were working. One live dot, drawn from the fleet.
  it('marks the subscription its agents are working on, primary or not', async () => {
    const primary = { seatId: 's1', provider: 'claude', label: 'Claude · new', planText: 'Max 20x', selected: true, windows: [] };
    const fallback = { seatId: 's2', provider: 'claude', label: 'Claude · old', planText: 'Max 5x', selected: false, windows: [] };
    renderAt('/overview', {
      ...workspaceScript(() => orgState({
        org: { ...org, seats: 2, seatUsage: [primary, fallback] },
        agents: [
          // Pinned to the FALLBACK and mid-turn: the seat its lease spends.
          agent({ id: 'a', name: 'Ada', seatId: 's2', working: true }),
          // Unpinned and idle: it would spend the primary, but not right now.
          agent({ id: 'b', name: 'Bo' }),
          // Unpinned and mid-turn: this one lights the primary. (It stood in
          // another room, while there were rooms — a seat stood above them;
          // note #843.)
          agent({ id: 'c', name: 'Cleo', working: true }),
        ],
      })),
      ...quiet,
    });
    // Both items are titled "Claude" (note #142) — the PLAN is what tells
    // this member's two sign-ins apart, here as on the screen.
    const fallbackCard = (await screen.findByText('Max 5x')).closest('.seatcard') as HTMLElement;
    expect(fallbackCard.querySelector('.livedot.seatdot')).toBeTruthy();
    // The dot is decoration; the words beside it are what a reader who
    // cannot see the colour gets, and they carry the count.
    expect(fallbackCard.querySelector('.seatdot')!.getAttribute('aria-hidden')).toBe('true');
    expect(within(fallbackCard).getByText(/In use — one agent is working on it now/)).toBeTruthy();
    const primaryCard = screen.getByText('Max 20x').closest('.seatcard') as HTMLElement;
    expect(primaryCard.querySelector('.livedot.seatdot')).toBeTruthy();
    expect(within(primaryCard).getByText(/In use — one agent is working on it now/)).toBeTruthy();
  });

  it('keeps the compact plates free of "Primary" (the owner, note #773)', async () => {
    const primary = { seatId: 's1', provider: 'claude', label: 'Claude · new', planText: 'Max 20x', selected: true, windows: [] };
    const fallback = { seatId: 's2', provider: 'claude', label: 'Claude · old', planText: 'Max 5x', selected: false, windows: [] };
    renderAt('/overview', {
      ...workspaceScript(() => orgState({ org: { ...org, seats: 2, seatUsage: [primary, fallback] } })),
      ...quiet,
    });
    const card = (await screen.findByText('Max 20x')).closest('.seatcard') as HTMLElement;
    expect(card.textContent).not.toContain('Primary');
  });

  it('lights the briefing’s actual Codex seat during its lease and clears it on release', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const codex = { seatId: 'codex-1', provider: 'codex', label: 'ChatGPT · 25 Sep 2026', selected: true, windows: [] };
    const claude = { seatId: 'claude-1', provider: 'claude', label: 'Claude', selected: true, windows: [] };
    let activeSeatIds: string[] = [];
    renderAt('/overview', {
      ...workspaceScript(() => orgState({
        org: { ...org, seatUsage: [codex, claude], activeSeatIds: [] },
        agents: [agent({ id: 'a', name: 'Ada' })],
      })),
      ...quiet,
      'GET api/agents/live': () => ({ agents: [], recaps: [], sessionLimits: [], activeSeatIds }),
    });
    const codexCard = (await screen.findByText('ChatGPT')).closest('.seatcard') as HTMLElement;
    const claudeCard = screen.getByText('Claude').closest('.seatcard') as HTMLElement;
    expect(codexCard.querySelector('.seatdot')).toBeNull();

    activeSeatIds = ['codex-1'];
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    await waitFor(() => expect(codexCard.querySelector('.livedot.seatdot')).toBeTruthy());
    expect(within(codexCard).getByText('In use by your Chief of Staff or briefing now')).toBeTruthy();
    expect(claudeCard.querySelector('.seatdot')).toBeNull();

    activeSeatIds = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    await waitFor(() => expect(codexCard.querySelector('.seatdot')).toBeNull());
  });

  it('sends a pin naming a deleted sign-in to the primary, as its lease goes', async () => {
    renderAt('/overview', {
      ...workspaceScript(() => orgState({
        org: {
          ...org,
          seats: 2,
          seatUsage: [
            { seatId: 's1', provider: 'claude', label: 'Claude · new', planText: 'Max 20x', selected: true, windows: [] },
            { seatId: 's2', provider: 'claude', label: 'Claude · old', planText: 'Max 5x', selected: false, windows: [] },
          ],
        },
        // A pin naming a seat that is GONE leases as the default does, so this
        // agent counts against the primary — the rule the agent's own screen
        // already says out loud ("Workplace default").
        agents: [agent({ id: 'a', name: 'Ada', seatId: 'deleted', working: true })],
      })),
      ...quiet,
    });
    const fallbackCard = (await screen.findByText('Max 5x')).closest('.seatcard') as HTMLElement;
    expect(fallbackCard.querySelector('.seatdot')).toBeNull();
    const primaryCard = screen.getByText('Max 20x').closest('.seatcard') as HTMLElement;
    expect(primaryCard.querySelector('.livedot.seatdot')).toBeTruthy();
  });

});

describe('the cloud screen', () => {
  it('names each agent machine with its face, calls a check machine what it is, and says what each figure is', async () => {
    renderAt('/workplace/cloud?org=o1', {
      ...workspaceScript(() => orgState()),
      ...cloudQuiet,
      'GET api/org/spend': () => ({
        orgSlug: 'nomad-trading',
        // 2.55 + 0.31 + 1.9 — the three metered rows, and the fourth left out.
        totals: { estimatedMonthlyUsd: 126.84, runningMonthlyUsd: 126.84, spentThisMonthUsd: 4.76, unmeasured: 1, running: 2, stopped: 0 },
        // As the answer arrives: biggest spender first, ordered by
        // `org-spend.ts` (note #336).
        machines: [{
          app: 'ia-agent00000001', machineId: 'm1', kind: 'agent', state: 'started',
          size: 'performance-4x 8GB', estimatedMonthlyUsd: 124.75, runningMonthlyUsd: 124.75,
          hourlyUsd: 0.1722, agent: { id: 'a', name: 'Ada', avatarUrl: '/faces/ada.png', driver: 'Mira Vale' },
          activeMs: 10 * 3_600_000 + 27 * 60_000, totalMonthlyUsd: 2.55,
        }, {
          // The check lane: one row for the month's runs (note #319), whether
          // or not a job machine is up at this moment.
          app: 'ia-ci-jobs', machineId: 'm3', kind: 'ci', state: 'started',
          size: 'performance-4x 8GB', estimatedMonthlyUsd: 1.9, runningMonthlyUsd: 124,
          hourlyUsd: 0.1722, activeMs: 11 * 3_600_000 + 2 * 60_000, totalMonthlyUsd: 1.9, runs: 121,
        }, {
          // An agent machine whose record is gone keeps its app as its handle.
          app: 'ia-agent00000002', machineId: 'm4', kind: 'agent', state: 'stopped',
          size: 'performance-4x 8GB', estimatedMonthlyUsd: 0.75, runningMonthlyUsd: 124.75,
          hourlyUsd: 0.1722,
        }, {
          // A site: up since Fly last started it, so its month is a fact too.
          app: 'iapp-site0000001', machineId: 'm2', kind: 'site', state: 'started',
          size: 'shared-1x 0.3GB', estimatedMonthlyUsd: 2.09, runningMonthlyUsd: 2.09,
          hourlyUsd: 0.0027, activeMs: 58 * 3_600_000, totalMonthlyUsd: 0.31, awakeSince: '2026-08-07T08:29:16Z',
        }],
        disclaimer: 'Estimates from Fly’s published prices — the Fly dashboard is the authority.',
      }),
    });

    expect(await screen.findByText('Ada')).toBeTruthy();
    // The money reads straight down the card, biggest first — the order the
    // answer arrives in (note #336), which the screen keeps rather than
    // inventing one of its own.
    expect([...document.querySelectorAll('#orgSpendList .spendrow .spendtotal strong')]
      .map((node) => node.textContent)).toEqual(['~$2.55', '~$1.9', '~$0.75', '~$0.31']);
    const agentRow = screen.getByText('Ada').closest('.spendrow') as HTMLElement;
    // Whose agent it is, after its own name (note #336).
    expect(agentRow.querySelector('.spendname .nametext')!.textContent).toBe('Ada (Mira Vale)');
    expect(within(agentRow).getByText('Agent machine · running · performance-4x 8GB')).toBeTruthy();
    // Awake, and marked as well as said: the word stays, the dot leads it.
    expect(agentRow.querySelector('.cline .statedot.awake')).toBeTruthy();
    expect(agentRow.querySelector('.cline .statedot')!.getAttribute('aria-hidden')).toBe('true');
    expect(within(agentRow).getByText('10h 27m')).toBeTruthy();
    expect(within(agentRow).getByText('$0.172')).toBeTruthy();
    expect(within(agentRow).getByText('~$2.55')).toBeTruthy();
    // Metered, so the figure is what it has cost — and it wears the agent's face.
    expect(within(agentRow).getByText('so far this month')).toBeTruthy();
    expect((agentRow.querySelector('img.avatar') as HTMLImageElement).getAttribute('src')).toBe('/faces/ada.png');
    // …which is the way in to the agent (note #359). The picture alone: the
    // name beside it stays plain text.
    const door = agentRow.querySelector('.spendname a.facebtn') as HTMLAnchorElement;
    expect(door.getAttribute('href')).toBe('/agents/a');
    expect(door.getAttribute('aria-label')).toBe('Open Ada');
    expect(door.querySelector('img.avatar')).toBeTruthy();
    expect(agentRow.querySelector('.nametext a')).toBeNull();

    const siteRow = screen.getByText('Site').closest('.spendrow') as HTMLElement;
    expect(within(siteRow).getByText('$0.0027')).toBeTruthy();
    // Up since its last start: what it has cost, and from when that counts.
    expect(within(siteRow).getByText('~$0.31')).toBeTruthy();
    expect(within(siteRow).getByText('so far this month')).toBeTruthy();
    expect(within(siteRow).getByText('2d 10h')).toBeTruthy();
    expect(within(siteRow).getByText('7 Aug')).toBeTruthy();
    expect(within(siteRow).getByText('running · shared-1x 0.3GB')).toBeTruthy();

    // The check lane is one row: the month's runs, priced for their length —
    // never "$124 per month if left on" for a machine that lives minutes.
    const ciRow = screen.getByText('CI checks').closest('.spendrow') as HTMLElement;
    expect(within(ciRow).getByText('121 checks this month · one running now · performance-4x 8GB')).toBeTruthy();
    expect(within(ciRow).getByText('11h 2m')).toBeTruthy();
    expect(within(ciRow).getByText('~$1.9')).toBeTruthy();
    expect(within(ciRow).getByText('so far this month')).toBeTruthy();
    expect(within(ciRow).queryByText(/if left on/)).toBeNull();
    expect(screen.queryByText('Leftover machine', { selector: '.nametext' })?.closest('.spendrow')).not.toBe(ciRow);

    // A machine no agent claims is named for what it is (note #375), and keeps
    // its app on the line below as the one handle to look it up by.
    const strayRow = screen.getByText('Leftover machine', { selector: '.nametext' }).closest('.spendrow') as HTMLElement;
    expect(within(strayRow).getByText('ia-agent00000002 · asleep · performance-4x 8GB')).toBeTruthy();
    expect(within(strayRow).getByText('per month asleep')).toBeTruthy();
    // Asleep: the same dot, grey — the class the stylesheet paints blue is
    // the one thing that is missing.
    expect(strayRow.querySelector('.cline .statedot')).toBeTruthy();
    expect(strayRow.querySelector('.cline .statedot.awake')).toBeNull();
    // A machine with no agent record has nobody to name it for.
    expect(strayRow.querySelector('.namedriver')).toBeNull();
    // …and nowhere to go: a row that is not an agent's wears the kind's glyph
    // and is not a door (note #359).
    expect(strayRow.querySelector('.facebtn')).toBeNull();
    expect(siteRow.querySelector('.facebtn')).toBeNull();
    expect(ciRow.querySelector('.facebtn')).toBeNull();
    expect(document.querySelectorAll('#orgSpendList .facebtn').length).toBe(1);
    // The check lane's mark says whether a check is running at this moment.
    expect(ciRow.querySelector('.cline .statedot.awake')).toBeTruthy();
    expect(screen.getByText(/five-minute machine sweep/)).toBeTruthy();
    expect(screen.getByText(/add up the length of every run this month/)).toBeTruthy();

    // The month so far, added up, over the column it adds up (note #342) —
    // the three metered rows, in the same words those rows use.
    const sub = document.getElementById('orgSpendSub')!;
    expect(sub.querySelector('strong')!.textContent).toBe('~$4.76');
    expect(sub.textContent).toBe('~$4.76 total so far this month \u00b7 2 running, 0 asleep');
    // And the stray row's $124.75-a-month projection is nowhere near it: a
    // sum of facts is the only figure allowed at the top of this screen.
    expect(sub.textContent).not.toMatch(/124/);
    // What the sum leaves out is said under the list rather than left to be
    // discovered by adding the column up by hand.
    expect(screen.getByText(/One machine nothing measures is not in the total at the top/)).toBeTruthy();
    // …and WHAT that odd row is, which is the question the screen was asked
    // (note #375): no agent on it, nothing running, storage only.
    expect(screen.getByText(/One machine here belongs to no agent/)).toBeTruthy();
  });

  /**
   * The cloud account is workplace-wide, but an agent's screen and chat
   * belong only to the person who owns it (note #380). An admin therefore
   * sees a teammate's machine and identity here without being offered a door
   * that the destination must refuse.
   */
  it('opens only the viewer’s own agents and leaves a teammate’s face as identity', async () => {
    renderAt('/workplace/cloud?org=o1', {
      ...workspaceScript(() => orgState()),
      ...cloudQuiet,
      'GET api/org/spend': () => ({
        orgSlug: 'nomad-trading',
        totals: {
          estimatedMonthlyUsd: 1.5, runningMonthlyUsd: 249.5,
          spentThisMonthUsd: 1.5, unmeasured: 0, running: 0, stopped: 2,
        },
        machines: [{
          app: 'ia-agent00000001', machineId: 'm1', kind: 'agent', state: 'stopped',
          size: 'performance-1x 2GB', estimatedMonthlyUsd: 0.75, runningMonthlyUsd: 124.75,
          hourlyUsd: 0.0431, agent: { id: 'a', name: 'Ada', avatarUrl: '/faces/ada.png', driver: 'Saddam' },
          activeMs: 0, totalMonthlyUsd: 0.75,
        }, {
          app: 'ia-agent00000002', machineId: 'm2', kind: 'agent', state: 'stopped',
          size: 'performance-4x 8GB', estimatedMonthlyUsd: 0.75, runningMonthlyUsd: 124.75,
          hourlyUsd: 0.1722, agent: { id: 'teammate-ruby', name: 'Ruby', avatarUrl: '/faces/ruby.png', driver: 'Emma' },
          activeMs: 0, totalMonthlyUsd: 0.75,
        }],
        namesRead: true,
        disclaimer: 'Estimates from Fly’s published prices — the Fly dashboard is the authority.',
      }),
    });

    const ruby = (await screen.findByText('Ruby')).closest('.spendrow') as HTMLElement;
    expect(within(ruby).getByText('(Emma)')).toBeTruthy();
    expect(ruby.querySelector('img.avatar')?.getAttribute('src')).toBe('/faces/ruby.png');
    expect(within(ruby).queryByRole('link', { name: 'Open Ruby' })).toBeNull();
    expect(within(ruby).queryByRole('link')).toBeNull();

    const ada = screen.getByText('Ada').closest('.spendrow') as HTMLElement;
    expect(within(ada).getByRole('link', { name: 'Open Ada' }).getAttribute('href')).toBe('/agents/a');
    expect(document.querySelectorAll('#orgSpendList .facebtn')).toHaveLength(1);
  });

  /**
   * Another workplace's machines in the same cloud account are the server's
   * to leave out and this screen's to COUNT (note #635): a list silently
   * shorter than the account is the one thing a bill must not be.
   */
  const sharedAccount = (machines: unknown[], machinesElsewhere: number) => ({
    ...workspaceScript(() => orgState()),
    ...cloudQuiet,
    'GET api/org/spend': () => ({
      orgSlug: 'acme-trading',
      totals: {
        estimatedMonthlyUsd: 0.75, runningMonthlyUsd: 124.75,
        spentThisMonthUsd: machines.length ? 0.75 : 0, unmeasured: 0, running: 0, stopped: machines.length,
      },
      machines,
      namesRead: true,
      machinesElsewhere,
      disclaimer: 'Estimates from Fly’s published prices — the Fly dashboard is the authority.',
    }),
  });
  const adaMachine = {
    app: 'ia-agent00000001', machineId: 'm1', kind: 'agent', state: 'stopped',
    size: 'performance-1x 2GB', estimatedMonthlyUsd: 0.75, runningMonthlyUsd: 124.75,
    hourlyUsd: 0.0431, agent: { id: 'a', name: 'Ada', avatarUrl: '/faces/ada.png' },
    activeMs: 0, totalMonthlyUsd: 0.75,
  };

  it('counts the machines of other workplaces at the foot of the list, and says they are not in the total', async () => {
    renderAt('/workplace/cloud?org=o1', sharedAccount([adaMachine], 3));

    const row = (await screen.findByText('3 machines outside this workplace')).closest('.spendrow') as HTMLElement;
    expect(row.id).toBe('orgSpendElsewhere');
    expect(within(row).getByText('In this cloud account too · not listed here or in the total')).toBeTruthy();
    // Last in the list, under this workplace's own rows, and carrying no money.
    expect(document.querySelector('#orgSpendList > :last-child')).toBe(row);
    expect(row.querySelector('.spendtotal')).toBeNull();
    expect(row.querySelector('.facebtn')).toBeNull();
    expect(screen.getByText(/The 3 machines outside this workplace run in this cloud account but belong to other workplaces/)).toBeTruthy();
    // The line over the list is this workplace's rows only.
    expect(document.getElementById('orgSpendSub')!.textContent).toBe('~$0.75 total so far this month · 0 running, 1 asleep');
  });

  it('says whose nothing it is when every machine in the account is another workplace’s', async () => {
    renderAt('/workplace/cloud?org=o1', sharedAccount([], 1));

    expect(await screen.findByText('Nothing of this workplace runs in the cloud account yet.')).toBeTruthy();
    expect(screen.getByText('1 machine outside this workplace')).toBeTruthy();
    expect(screen.queryByText('Nothing runs in the cloud account yet.')).toBeNull();
  });

  it('draws no count when the account holds nothing of anybody else’s', async () => {
    renderAt('/workplace/cloud?org=o1', sharedAccount([adaMachine], 0));

    await screen.findByText('Ada');
    expect(document.getElementById('orgSpendElsewhere')).toBeNull();
    expect(screen.queryByText(/outside this workplace/)).toBeNull();
  });

  /**
   * The row that IS an agent's, before that agent has recorded it (note #375).
   *
   * The app is stamped on the record before it exists and the machine id only
   * lands once the machine is up, so for the first minutes of every agent's
   * life its machine is real, billed, and named by no `serverId`. Those are
   * also the minutes its owner is most likely to be on this screen — they
   * just asked for the agent — so the row has to read as theirs rather than
   * as the leftover it is otherwise indistinguishable from.
   */
  it('names a machine being set up for its agent, and calls only the unclaimed one leftover', async () => {
    renderAt('/workplace/cloud?org=o1', {
      ...workspaceScript(() => orgState({
        agents: [
          agent({ id: 'a', name: 'Ada', avatarUrl: '/faces/ada.png' }),
          agent({ id: 'b', name: 'Bo', avatarUrl: '/faces/bo.png', status: 'setting-up' }),
        ],
      })),
      ...cloudQuiet,
      'GET api/org/spend': () => ({
        orgSlug: 'nomad-trading',
        totals: { estimatedMonthlyUsd: 125.5, runningMonthlyUsd: 249.5, spentThisMonthUsd: 0, unmeasured: 2, running: 1, stopped: 1 },
        machines: [{
          app: 'ia-agent00000003', machineId: 'm5', kind: 'agent', state: 'started',
          size: 'performance-1x 2GB', estimatedMonthlyUsd: 124.75, runningMonthlyUsd: 124.75,
          hourlyUsd: 0.0431, agent: { id: 'b', name: 'Bo', avatarUrl: '/faces/bo.png' }, settingUp: true,
        }, {
          app: 'ia-agent00000002', machineId: 'm4', kind: 'agent', state: 'stopped',
          size: 'performance-4x 8GB', estimatedMonthlyUsd: 0.75, runningMonthlyUsd: 124.75, hourlyUsd: 0.1722,
        }],
        disclaimer: 'Estimates from Fly’s published prices — the Fly dashboard is the authority.',
      }),
    });

    const setup = (await screen.findByText('Bo')).closest('.spendrow') as HTMLElement;
    // Its agent's own name and face, and the line says what is being done to it.
    expect(within(setup).getByText('Being set up · running · performance-1x 2GB')).toBeTruthy();
    expect((setup.querySelector('img.avatar') as HTMLImageElement).getAttribute('src')).toBe('/faces/bo.png');
    // Its face is the door onto the agent, exactly as a finished machine's is.
    expect(setup.querySelector('a.facebtn')!.getAttribute('href')).toBe('/agents/b');
    // Nothing meters it yet, so its money is a projection and says so.
    expect(within(setup).getByText('per month if left on')).toBeTruthy();

    // Only the row no agent claims is called a leftover, and the count under
    // the list is that one row — not both machines nothing meters.
    const stray = screen.getByText('Leftover machine', { selector: '.nametext' }).closest('.spendrow');
    expect(stray).not.toBe(setup);
    expect(within(stray as HTMLElement).getByText('ia-agent00000002 · asleep · performance-4x 8GB')).toBeTruthy();
    expect(screen.getByText(/One machine here belongs to no agent/)).toBeTruthy();
    expect(screen.queryByText(/2 machines here belong to no agent/)).toBeNull();
  });

  /**
   * The button the explanation earned (note #375): a leftover machine is
   * nobody's, so its row is the one place in this list where there is
   * something to DO.
   *
   * Two rules are worth holding here, and they are both about where the
   * button is NOT. It stands on a leftover and on nothing else — an agent's
   * machine, a site and the check lane are all somebody's — and it stands
   * only when the server says it read the agent records (`namesRead`),
   * because a failed read makes every row on this screen look unclaimed.
   */
  const removable = (machines: Array<{ state: string; totalMonthlyUsd?: number }>, namesRead = true) => ({
    ...workspaceScript(() => orgState()),
    ...cloudQuiet,
    'GET api/org/spend': () => ({
      orgSlug: 'nomad-trading',
      // Counted from the rows, so the line over the list and the list agree
      // before the removal exactly as they must after it.
      totals: {
        estimatedMonthlyUsd: 128.34, runningMonthlyUsd: 376.84,
        spentThisMonthUsd: Math.round(machines.reduce((sum, m) => sum + (m.totalMonthlyUsd ?? 0), 0) * 100) / 100,
        unmeasured: machines.filter((m) => m.totalMonthlyUsd === undefined).length,
        running: machines.filter((m) => m.state === 'started').length,
        stopped: machines.filter((m) => m.state === 'stopped').length,
      },
      machines,
      namesRead,
      disclaimer: 'Estimates from Fly’s published prices — the Fly dashboard is the authority.',
    }),
    'DELETE api/org/machines/ia-agent00000002': () => ({ ok: true, app: 'ia-agent00000002', machines: 1 }),
    'DELETE api/org/machines/ia-agent00000003': () => ({ ok: true, app: 'ia-agent00000003', machines: 1 }),
  });
  const adaRow = {
    app: 'ia-agent00000001', machineId: 'm1', kind: 'agent' as const, state: 'started',
    size: 'performance-4x 8GB', estimatedMonthlyUsd: 124.75, runningMonthlyUsd: 124.75,
    hourlyUsd: 0.1722, agent: { id: 'a', name: 'Ada', avatarUrl: '/faces/ada.png' },
    activeMs: 3_600_000, totalMonthlyUsd: 2.55,
  };
  const siteRow = {
    app: 'iapp-site0000001', machineId: 'm2', kind: 'site' as const, state: 'stopped',
    size: 'shared-1x 0.3GB', estimatedMonthlyUsd: 2.09, runningMonthlyUsd: 2.09, hourlyUsd: 0.0027,
  };
  const leftoverRow = (app: string, machineId: string) => ({
    app, machineId, kind: 'agent' as const, state: 'stopped',
    size: 'performance-4x 8GB', estimatedMonthlyUsd: 0.75, runningMonthlyUsd: 124.75, hourlyUsd: 0.1722,
  });

  it('removes a machine no agent is on, and offers that nowhere else', async () => {
    const { calls } = renderAt('/workplace/cloud?org=o1', removable([
      adaRow, siteRow, leftoverRow('ia-agent00000002', 'm4'), leftoverRow('ia-agent00000003', 'm5'),
    ]));
    await screen.findByText('Ada');
    // One per leftover, and nowhere else: four rows, two buttons.
    const buttons = () => [...document.querySelectorAll('#orgSpendList .spendremove')];
    expect(buttons().length).toBe(2);
    const agentRow = screen.getByText('Ada').closest('.spendrow') as HTMLElement;
    expect(agentRow.querySelector('.spendremove')).toBeNull();
    expect(screen.getByText('Site').closest('.spendrow')!.querySelector('.spendremove')).toBeNull();

    // Asking is not doing: the card names the machine, and the backdrop's
    // answer is no.
    fireEvent.click(buttons()[0]!);
    expect(screen.getByText(/ia-agent00000002 and everything on it are destroyed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.querySelector('.ask')).toBeNull();
    expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false);

    fireEvent.click(buttons()[0]!);
    // Scoped to the card: the rows below it say "Remove" too, which is the
    // whole point of the card standing over them.
    const card = document.querySelector('.ask') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'api/org/machines/ia-agent00000002'
      && call.init?.method === 'DELETE')).toBe(true));

    // The row goes without a second read of the account, and the figures over
    // the list are recounted from what is left: one fewer asleep, one fewer
    // machine nothing meters.
    await waitFor(() => expect(document.querySelectorAll('#orgSpendList .spendrow').length).toBe(3));
    expect(screen.queryByText('ia-agent00000002 · asleep · performance-4x 8GB')).toBeNull();
    expect(screen.getByText('ia-agent00000003 · asleep · performance-4x 8GB')).toBeTruthy();
    expect(calls.filter((call) => call.path === 'api/org/spend').length).toBe(1);
    expect(document.getElementById('orgSpendSub')!.textContent)
      .toBe('~$2.55 total so far this month · 1 running, 2 asleep');
    expect(screen.getByText(/One machine here belongs to no agent/)).toBeTruthy();
  });

  /**
   * Replacing the cloud (note #372: "I should be able to replace my cloud. In
   * my cloud details screen, I should be able to replace with different ones,
   * so replace the fly token key").
   *
   * Two acts wear one button, and what is worth holding is that the screen
   * never confuses them. A fresh token for the SAME Fly org rotates a
   * credential and changes nothing a reader can see, so the machines below it
   * are left exactly where they are. A token for a DIFFERENT org is a move,
   * which nobody may make by accident — the screen asks, naming the account
   * Fly says the token belongs to, and only then are the old account's
   * machines taken off the glass rather than refreshed underneath.
   */
  const replaceable = (rows = [adaRow], answers: Array<Record<string, unknown>> = []) => {
    let asked = 0;
    let read = 0;
    return {
      ...workspaceScript(() => orgState()),
      ...cloudQuiet,
      'GET api/org/spend': () => {
        // The second read is the NEW account: one machine, another name.
        const second = read++ > 0;
        return {
          orgSlug: second ? 'other-co' : 'nomad-trading',
          totals: {
            estimatedMonthlyUsd: 124.75, runningMonthlyUsd: 124.75, spentThisMonthUsd: 2.55,
            unmeasured: 0, running: 1, stopped: 0,
          },
          machines: second ? [] : rows,
          namesRead: true,
          disclaimer: 'Estimates from Fly’s published prices — the Fly dashboard is the authority.',
        };
      },
      'POST api/org/fly': () => (answers[asked++] ?? { ok: true, orgSlug: 'nomad-trading', appCount: 3, peer: 'up', previousSlug: 'nomad-trading', moved: false }),
    };
  };
  /** This workplace keeps its repositories, their backups and its files in
   *  the account a move would leave — the common shape, and the one the
   *  question has to name. */
  const leaves = { gitHost: true, gitBackup: true, media: true };
  const pasteAndSend = (token: string, label: string) => {
    fireEvent.change(document.getElementById('replaceCloudToken') as HTMLInputElement, { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: label }));
  };

  it('names the account over the bill, and a fresh token for it rotates in place', async () => {
    const { calls } = renderAt('/workplace/cloud?org=o1', replaceable());
    // The slug was always in the answer and never said; it is the first card.
    await screen.findByText('nomad-trading');
    expect(document.querySelector('#orgCloudAccount .name')!.textContent).toBe('nomad-trading');
    // Over everything, because everything below is a reading of it.
    const account = document.getElementById('orgCloudAccount')!;
    expect(account.compareDocumentPosition(document.getElementById('orgSpendList')!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // The box is a tap behind the button, never left open over a working cloud.
    expect(document.getElementById('replaceCloudToken')).toBeNull();
    fireEvent.click(document.getElementById('orgCloudReplace')!);
    pasteAndSend('fo1_fresh', 'Replace cloud');

    await waitFor(() => expect(document.getElementById('banner')!.textContent)
      .toBe('Cloud token replaced. nomad-trading is still your cloud.'));
    expect(body(calls.find((call) => call.path === 'api/org/fly')!)).toEqual({ token: 'fo1_fresh' });
    // Nothing moved, so nothing is re-read and the row stays put.
    expect(calls.filter((call) => call.path === 'api/org/spend').length).toBe(1);
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(document.querySelector('.scrim')).toBeNull();
  });

  it('a token for another account is a question first, and answering no sends nothing more', async () => {
    const { calls } = renderAt('/workplace/cloud?org=o1', replaceable([adaRow], [
      { ok: false, move: { fromSlug: 'nomad-trading', toSlug: 'other-co', appCount: 4, leaves } },
    ]));
    await screen.findByText('nomad-trading');
    fireEvent.click(document.getElementById('orgCloudReplace')!);
    pasteAndSend('fo1_elsewhere', 'Replace cloud');

    // Where the token really points, and what a move would cost. The machines
    // are counted off the screen; the repositories and files are read from the
    // workplace's own record, because nobody has those on screen to count
    // and a warning about machines alone reads as a promise about the rest.
    await screen.findByText(/That token is for/);
    const said = document.getElementById('replaceCloudMove')!.textContent ?? '';
    expect(said).toContain('The one machine on this screen is what stays behind.');
    expect(said).toContain('That includes your repositories and their backups, '
      + 'and every file on a note, page or chat, which live in nomad-trading too.');
    // Neither half of what happens to an agent is promised: which one depends
    // on how Fly answers for an app the new token cannot see.
    expect(said).toContain('Its next turn either fails or builds it a fresh, empty computer '
      + 'in other-co — and either way the machine left behind keeps billing in nomad-trading');
    fireEvent.click(screen.getByRole('button', { name: 'Keep nomad-trading' }));

    expect(document.querySelector('.scrim')).toBeNull();
    expect(calls.filter((call) => call.path === 'api/org/fly').length).toBe(1);
    // The account on the glass is the one it always was.
    expect(document.querySelector('#orgCloudAccount .name')!.textContent).toBe('nomad-trading');
  });

  it('a confirmed move re-sends the same paste and takes the old account off the screen', async () => {
    const { calls } = renderAt('/workplace/cloud?org=o1', replaceable([adaRow], [
      { ok: false, move: { fromSlug: 'nomad-trading', toSlug: 'other-co', appCount: 4, leaves } },
      { ok: true, orgSlug: 'other-co', appCount: 4, peer: 'up', previousSlug: 'nomad-trading', moved: true },
    ]));
    await screen.findByText('nomad-trading');
    fireEvent.click(document.getElementById('orgCloudReplace')!);
    pasteAndSend('fo1_elsewhere', 'Replace cloud');
    await screen.findByText(/That token is for/);
    fireEvent.click(screen.getByRole('button', { name: 'Move to other-co' }));

    await waitFor(() => expect(document.getElementById('banner')!.textContent)
      .toBe('Your cloud is now other-co. Everything in nomad-trading is still there, on that account\u2019s bill.'));
    const sent = calls.filter((call) => call.path === 'api/org/fly');
    // The second send names the org the question named: a bare yes would be a
    // yes to wherever the token resolved the second time.
    expect(sent.map(body)).toEqual([
      { token: 'fo1_elsewhere' },
      { token: 'fo1_elsewhere', replace: 'other-co' },
    ]);
    // The machines held here were a reading of an account this workplace
    // has just left. They go, and the screen waits for the new one's.
    await waitFor(() => expect(document.querySelector('#orgCloudAccount .name')!.textContent).toBe('other-co'));
    expect(screen.queryByText('Ada')).toBeNull();
    expect(calls.filter((call) => call.path === 'api/org/spend').length).toBe(2);
  });

  it('offers no removal at all when the server could not read whose machines these are', async () => {
    renderAt('/workplace/cloud?org=o1', removable([
      adaRow, leftoverRow('ia-agent00000002', 'm4'),
    ], false));
    await screen.findByText('Leftover machine');
    // Every row looks unclaimed on a failed read, which is exactly why the
    // one destructive control on this screen is withheld.
    expect(document.querySelectorAll('#orgSpendList .spendremove').length).toBe(0);
  });

  /**
   * The card a pointer resting on one of those faces raises (note #359).
   *
   * It is the shell's one hover card, so what is worth checking here is not
   * how it is drawn — Home's own tests hold that — but that this screen hands
   * it the right agent: the fleet's live row for a machine whose agent the
   * fleet still has, and the row's own two facts for one it does not. A
   * machine outlives the agent that ran it by however long it takes to tear
   * down, so the second case is a real row on a real account, not a
   * defensive branch.
   */
  it('raises the agent behind a face, and says only what it knows about one the fleet has lost', async () => {
    const machine = (agentId: string, name: string) => ({
      app: `ia-agent-${agentId}`, machineId: `m-${agentId}`, kind: 'agent' as const, state: 'started',
      size: 'performance-4x 8GB', estimatedMonthlyUsd: 124.75, runningMonthlyUsd: 124.75,
      hourlyUsd: 0.1722, agent: { id: agentId, name, avatarUrl: `/faces/${agentId}.png` },
      activeMs: 3_600_000, totalMonthlyUsd: 1.5,
    });
    renderAt('/workplace/cloud?org=o1', {
      ...workspaceScript(() => orgState({
        agents: [agent({
          id: 'a', name: 'Ada', avatarUrl: '/faces/a.png',
          model: 'Opus', effort: 'high', working: true, recap: 'Rebuilt the checkout and proposed #4.',
        })],
      })),
      ...cloudQuiet,
      'GET api/org/spend': () => ({
        orgSlug: 'nomad-trading',
        totals: { estimatedMonthlyUsd: 249.5, runningMonthlyUsd: 249.5, spentThisMonthUsd: 3, unmeasured: 0, running: 2, stopped: 0 },
        machines: [machine('a', 'Ada'), machine('gone', 'Otto')],
        disclaimer: 'Estimates from Fly’s published prices — the Fly dashboard is the authority.',
      }),
    });

    expect(await screen.findByText('Ada')).toBeTruthy();
    const faces = [...document.querySelectorAll('#orgSpendList .spendname .facehover')];
    expect(faces.length).toBe(2);
    expect(document.querySelector('.agentcard')).toBeNull();

    fireEvent.mouseOver(faces[0]!);
    const card = document.querySelector('.agentcard')!;
    expect(card.querySelector('.name')!.textContent).toBe('Ada');
    // Read off the LIVE fleet, not off the spend row: the row knows a name, a
    // face and a driver, and none of the three facts below.
    expect(card.querySelector('.cruntime')!.textContent).toBe('Claude Code · Opus · high');
    expect(card.querySelector('.statetext')!.textContent).toBe('Active');
    expect(card.querySelector('.cabout')!.textContent).toBe('Rebuilt the checkout and proposed #4.');
    // Drawn OUT of the card the row sits in, which clips its own overflow.
    expect(card.closest('#orgSpendList')).toBeNull();
    fireEvent.mouseOut(faces[0]!);
    expect(document.querySelector('.agentcard')).toBeNull();

    // An agent the fleet no longer holds keeps its name and its picture, and
    // the card invents no runtime, no state and no recap for it.
    fireEvent.mouseOver(faces[1]!);
    const lost = document.querySelector('.agentcard')!;
    expect(lost.querySelector('.name')!.textContent).toBe('Otto');
    expect(lost.querySelector('.cruntime')).toBeNull();
    expect(lost.querySelector('.headstate')).toBeNull();
    expect(lost.querySelector('.cabout')).toBeNull();
    // No dead door: a stale row or a teammate's agent is not in this
    // viewer's fleet, and its detail screen would refuse the address.
    expect(faces[1]!.querySelector('a.facebtn')).toBeNull();
    expect(faces[0]!.querySelector('a.facebtn')!.getAttribute('href')).toBe('/agents/a');
  });

  /**
   * The wait (note #314: "Cloud spending screen should have skeleton loading
   * Ui"). The reader's screenshot was this screen holding one grey box with
   * the word "Loading…" in it, where a list of machines and their money was
   * about to land.
   */
  const openSpendSlowly = (answer: () => Promise<never> | Promise<unknown>) => renderAt(
    '/workplace/cloud?org=o1',
    { ...workspaceScript(() => orgState()), ...cloudQuiet, 'GET api/org/spend': answer },
  );
  const spendAnswer = () => ({
    orgSlug: 'nomad-trading',
    totals: { estimatedMonthlyUsd: 126.84, runningMonthlyUsd: 126.84, spentThisMonthUsd: 2.55, unmeasured: 0, running: 1, stopped: 0 },
    machines: [{
      app: 'ia-agent00000001', machineId: 'm1', kind: 'agent', state: 'started',
      size: 'performance-4x 8GB', estimatedMonthlyUsd: 124.75, runningMonthlyUsd: 124.75,
      hourlyUsd: 0.1722, agent: { id: 'a', name: 'Ada' }, activeMs: 3_600_000, totalMonthlyUsd: 2.55,
    }],
    disclaimer: 'Estimates from Fly’s published prices — the Fly dashboard is the authority.',
  });

  it('waits in the shape of the list, not behind the word “Loading”', async () => {
    vi.useFakeTimers();
    openSpendSlowly(() => new Promise<never>(() => {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT_QUIET_MS + 20); });
    // The word the reader photographed is gone.
    expect(screen.queryByText('Loading…')).toBeNull();
    // All three blocks the answer fills are held, not just the card: a
    // summary line that appears later pushes the card down under the reader.
    expect(document.querySelectorAll('#orgSpendList .spendrow')).toHaveLength(3);
    expect(document.querySelector('#orgSpendSub .skel')).toBeTruthy();
    expect(document.querySelector('#orgSpendHint .skel')).toBeTruthy();
    // Said once, for a reader who cannot see any of it; the bars themselves
    // are decoration and are hidden from the tree.
    expect(document.getElementById('screenOrgCloud')!.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Loading the cloud account…')).toBeTruthy();
    expect([...document.querySelectorAll('#orgSpendList .spendrow')]
      .every((row) => row.getAttribute('aria-hidden') === 'true')).toBe(true);
    // …and the choice above them is NOT held: its own read answered from the
    // workplace's record while the machine list is still out to Fly, so
    // it is on the screen for real (note #355).
    expect(within(document.getElementById('orgNewAgentCard')!).getByText('2 dedicated cores · 4 GB')).toBeTruthy();
    expect(document.querySelector('#orgNewAgentCard .skel')).toBeNull();
  });

  it('draws nothing at all for a read that answers straight away (note #287)', async () => {
    vi.useFakeTimers();
    openSpendSlowly(async () => spendAnswer());
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(document.querySelector('.skel')).toBeNull();
    expect(screen.getByText('Ada')).toBeTruthy();
    // And nothing turns up afterwards: a skeleton that appears once the
    // answer is on screen is the same flicker seen from the other side.
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT_QUIET_MS + WAIT_HOLD_MS); });
    expect(document.querySelector('.skel')).toBeNull();
  });

  it('replaces the held rows with the real ones once the read lands', async () => {
    vi.useFakeTimers();
    let release: (value: unknown) => void = () => {};
    const slow = new Promise<unknown>((resolve) => { release = resolve; });
    openSpendSlowly(() => slow);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT_QUIET_MS + 20); });
    expect(document.querySelectorAll('#orgSpendList .spendrow')).toHaveLength(3);
    // Released first, THEN the clock: the hold's own timer is scheduled by an
    // effect that cannot run until the answer has been committed, so advancing
    // inside the same act would step past a timer nothing had set yet.
    await act(async () => { release(spendAnswer()); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT_HOLD_MS + 20); });
    expect(document.querySelector('.skel')).toBeNull();
    expect(screen.getByText('Ada')).toBeTruthy();
    // The month's spend and the count — and no projected figure over the
    // list: `estimatedMonthlyUsd` is 126.84 here and appears nowhere.
    expect(document.getElementById('orgSpendSub')!.textContent)
      .toBe('~$2.55 total so far this month \u00b7 1 running, 0 asleep');
    // Every row is metered, so nothing is owed about what the sum left out.
    expect(screen.queryByText(/not in the total at the top/)).toBeNull();
  });

  /**
   * NOTE #355. The screen is the cloud's own screen, not a bill: the thing a
   * reader can DECIDE stands above the machines, and deciding it changes what
   * new agents are built on without touching one machine that is running.
   */
  it('says what new agents are built on, and changes it', async () => {
    const { calls } = renderAt('/workplace/cloud?org=o1', {
      ...workspaceScript(() => orgState()),
      ...cloudQuiet,
      'GET api/org/spend': () => ({
        orgSlug: 'nomad-trading',
        totals: { estimatedMonthlyUsd: 0, runningMonthlyUsd: 0, spentThisMonthUsd: 0, unmeasured: 0, running: 0, stopped: 0 },
        machines: [],
        disclaimer: 'Estimates from Fly\u2019s published prices — the Fly dashboard is the authority.',
      }),
      'POST api/org/agent-machine': (call) => {
        expect(body(call)).toEqual({ size: 'performance-4x' });
        expect(call.scope?.org).toBe('o1');
        return { ...newAgentMachine({ current: 'performance-4x', chosen: true }), ok: true, changed: true };
      },
    });

    // The screen is named for the cloud, and the machines are one section of
    // it rather than the whole page.
    expect(await screen.findByRole('heading', { name: 'Cloud' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Machines' })).toBeTruthy();
    const card = document.getElementById('orgNewAgentCard')!;
    // What the row says is the shape AND its price — the two facts the choice
    // is made on, in the ladder's own words.
    expect(within(card).getByText('2 dedicated cores · 4 GB')).toBeTruthy();
    // Nobody has chosen yet, so the line says where the value came from.
    expect(within(card).getByText('about $0.09 an hour awake · standard')).toBeTruthy();
    // Above the machines, where a decision is found (note #355).
    expect(card.compareDocumentPosition(document.getElementById('orgSpendList')!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText(/Agents already here keep the size they run on/)).toBeTruthy();

    fireEvent.click(document.getElementById('orgNewAgentRow')!);
    expect(await screen.findByRole('heading', { name: 'Machine for new agents' })).toBeTruthy();
    // The rung in force is a state, not a button that would write the value
    // it already has; every other one is an offer.
    const rung = (id: string) => document.querySelector(`[data-size="${id}"]`) as HTMLElement;
    expect(rung('performance-2x').className).toContain('current');
    expect(rung('performance-2x').tagName).toBe('DIV');
    expect(rung('performance-4x').tagName).toBe('BUTTON');
    // Both ladders are offered, and the shared one is warned about in the
    // same breath — the measurement, not a hedge.
    expect(document.getElementById('orgMachineShared')!.querySelectorAll('[data-size]')).toHaveLength(1);
    expect(screen.getByText(/91–94% of its processor time went to other tenants/)).toBeTruthy();
    // What it does not do is said before the tap as well as after it.
    expect(screen.getByText(/Machines already running keep the size they are on/)).toBeTruthy();

    fireEvent.click(rung('performance-4x'));
    expect(await screen.findByText(/Saved\. New agents are built on 4 dedicated cores · 8 GB/)).toBeTruthy();
    expect(calls.filter((call) => call.path === 'api/org/agent-machine' && call.init?.method === 'POST')).toHaveLength(1);
    // The badge lands on the tapped rung, which IS the confirmation.
    expect(rung('performance-4x').className).toContain('current');

    // And Back leaves the row underneath saying what was just chosen, from
    // the write's own answer rather than a second read.
    fireEvent.click(document.getElementById('pageBack')!);
    await screen.findByRole('heading', { name: 'Cloud' });
    expect(within(document.getElementById('orgNewAgentCard')!).getByText('4 dedicated cores · 8 GB')).toBeTruthy();
  });

  /**
   * The rare case the held card exists for: BOTH reads are slow (one link,
   * one bad connection). Without a shape held for the choice, the machine
   * list is held at the top of the screen and then pushed down when the
   * choice lands — the settle note #314's wait was written to prevent.
   */
  it('holds a shape for the choice too, when its own read is late as well', async () => {
    vi.useFakeTimers();
    renderAt('/workplace/cloud?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/agent-machine': () => new Promise<never>(() => {}),
      'GET api/org/spend': () => new Promise<never>(() => {}),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT_QUIET_MS + 20); });
    const card = document.getElementById('orgNewAgentCard')!;
    expect(card.querySelectorAll('.skel').length).toBeGreaterThan(0);
    // One row, because this read has one answer whatever the account holds —
    // it is the machine LIST whose length cannot be known.
    expect(card.querySelectorAll('.crow')).toHaveLength(1);
    // And it is decoration: the words the screen owes a reader who cannot see
    // it were said once, at the top.
    expect(card.getAttribute('aria-hidden')).toBe('true');
  });

  it('tells a member what new agents get without offering them the choice', async () => {
    renderAt('/workplace/cloud?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/agent-machine': () => newAgentMachine({ canChoose: false }),
      'GET api/org/spend': () => Promise.reject(new WorkspaceApiError('Only a workplace admin can inspect workplace spending.', 403, {})),
    });
    expect(await screen.findByText('2 dedicated cores · 4 GB')).toBeTruthy();
    // The fact, with no affordance that could only refuse them.
    expect(document.getElementById('orgNewAgentRow')!.tagName).toBe('DIV');
    expect(document.querySelector('#orgNewAgentCard .chev')).toBeNull();
  });

  /** A failure is exempt from the hold: an answer the reader has to act on
   *  should never be kept behind a wait that is no longer waiting for it. */
  it('says what went wrong instead of holding a shape that is not coming', async () => {
    vi.useFakeTimers();
    openSpendSlowly(() => Promise.reject(new Error('The cloud account could not be read.')));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT_QUIET_MS + 20); });
    expect(screen.getByText('The cloud account could not be read.')).toBeTruthy();
    expect(document.querySelector('.skel')).toBeNull();
  });
});

/**
 * The screen that would not hold still (note #368: "Cloud details page data
 * should be cached and refetch silently").
 *
 * The same complaint note #354 fixed on Home, one screen along and more
 * expensive: this screen is a route, so leaving it unmounts BOTH its reads,
 * and the machine list is a walk of every app in the Fly account. Coming back
 * drew two seconds of skeleton over a bill that had been on the glass a
 * second earlier.
 *
 * The trip below is the one the note is about, made through the door the
 * reader actually taps: the workplace screen (Home until note #642), into the
 * machines, back, and in again.
 */
describe('the cloud screen holds still', () => {
  const cloudCounts = () => ({
    orgId: 'o1', role: 'admin',
    fly: { connected: true, orgSlug: 'nomad-trading', peer: 'up' },
    machines: { active: 1, sleeping: 0, checkedAt: new Date().toISOString() },
  });
  const bill = (spent: number) => ({
    orgSlug: 'nomad-trading',
    totals: { estimatedMonthlyUsd: 124.75, runningMonthlyUsd: 124.75, spentThisMonthUsd: spent, unmeasured: 0, running: 1, stopped: 0 },
    machines: [{
      app: 'ia-agent00000001', machineId: 'm1', kind: 'agent', state: 'started',
      size: 'performance-4x 8GB', estimatedMonthlyUsd: 124.75, runningMonthlyUsd: 124.75,
      hourlyUsd: 0.1722, agent: { id: 'a', name: 'Ada' }, activeMs: 3_600_000, totalMonthlyUsd: spent,
    }],
    disclaimer: 'Estimates from Fly\u2019s published prices — the Fly dashboard is the authority.',
  });
  const openWorkplace = (script: Record<string, Answer>) => renderAt('/workplace?org=o1', {
    ...workspaceScript(() => orgState()),
    ...cloudQuiet,
    'GET api/org': () => ({ org: orgDetail() }),
    'GET api/org/cloud': cloudCounts,
    ...script,
  });
  /** In through the door on the workplace screen, which is the one a reader
   *  taps: the cloud card is there now rather than on Home (note #642). */
  const intoTheMachines = () => fireEvent.click(screen.getByText('See cloud details').closest('button')!);
  /** The one machine row's own money. Asked for by selector rather than by
   *  its words: the month's total at the top of the screen adds up to the
   *  same figure when there is one row, so `getByText` matches twice. */
  const rowTotal = () => document.querySelector('#orgSpendList .spendrow .spendtotal strong')?.textContent ?? '';

  it('comes Back to the machines it already read, with no wait drawn over them', async () => {
    let reads = 0;
    // Stalled for the trip BACK, so that anything on the screen then is what
    // the held copy put there and nothing else.
    let stall = false;
    openWorkplace({
      'GET api/org/spend': () => { reads += 1; return stall ? new Promise<never>(() => {}) : bill(2.55); },
    });
    await screen.findByText('nomad-trading');
    intoTheMachines();
    expect(await screen.findByText('Ada')).toBeTruthy();
    const asked = reads;
    stall = true;

    fireEvent.click(document.getElementById('pageBack')!);
    await screen.findByText('nomad-trading');
    intoTheMachines();

    // No await: the rows are there in the render the tap produced, which is
    // what "no flash" means. A cache read after an effect would show a
    // skeleton for a frame and pass a test that waited.
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(document.querySelector('#orgSpendList .spendrow .spendtotal strong')!.textContent).toBe('~$2.55');
    expect(document.querySelector('#screenOrgCloud .skel')).toBeNull();
    expect(screen.queryByText('Loading the cloud account…')).toBeNull();
    expect(document.getElementById('screenOrgCloud')!.getAttribute('aria-busy')).toBeNull();
    // The choice above the list comes back too — a cheap read, but the same
    // flash from a cheaper cause.
    expect(within(document.getElementById('orgNewAgentCard')!).getByText('2 dedicated cores · 4 GB')).toBeTruthy();
    // And a trip this short costs no read at all: the figures cannot have
    // moved, and the walk behind them is the whole Fly account.
    expect(reads).toBe(asked);
    // What a held answer wears instead of a wait: its age.
    expect(document.getElementById('orgSpendRead')!.textContent)
      .toMatch(/^Checked at \d{1,2}:\d{2}(\s?[AP]M)? · read again each visit$/);
  });

  it('reads again once what it holds has aged, and swaps the figures underneath', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let spent = 2.55;
    let reads = 0;
    openWorkplace({ 'GET api/org/spend': () => { reads += 1; return bill(spent); } });
    await screen.findByText('nomad-trading');
    intoTheMachines();
    await waitFor(() => expect(rowTotal()).toBe('~$2.55'));
    const asked = reads;

    fireEvent.click(document.getElementById('pageBack')!);
    await screen.findByText('nomad-trading');
    spent = 3.10;
    await act(async () => { await vi.advanceTimersByTimeAsync(CLOUD_READ_AGAIN_MS); });
    intoTheMachines();

    // Still no wait — the old figure is up while the new one is fetched.
    expect(document.querySelector('#screenOrgCloud .skel')).toBeNull();
    expect(rowTotal()).toBe('~$2.55');
    // …and it is replaced underneath, silently.
    await waitFor(() => expect(rowTotal()).toBe('~$3.1'));
    expect(reads).toBeGreaterThan(asked);
  });

  it('absorbs a refresh that fails, rather than taking the bill away to report it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let broken = false;
    openWorkplace({
      'GET api/org/spend': () => {
        if (broken) throw new WorkspaceApiError('Bad gateway', 502, {});
        return bill(2.55);
      },
    });
    await screen.findByText('nomad-trading');
    intoTheMachines();
    await waitFor(() => expect(rowTotal()).toBe('~$2.55'));
    const stamped = document.getElementById('orgSpendRead')!.textContent;

    fireEvent.click(document.getElementById('pageBack')!);
    await screen.findByText('nomad-trading');
    broken = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(CLOUD_READ_AGAIN_MS); });
    intoTheMachines();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    // The reader asked for nothing. Taking the bill off the screen to report
    // a hiccup they did not cause is the worse of the two answers; the
    // "Checked at" stamp standing still is the honest one.
    expect(rowTotal()).toBe('~$2.55');
    expect(document.body.textContent).not.toContain('Bad gateway');
    expect(document.getElementById('orgSpendRead')!.textContent).toBe(stamped);
  });

  it('does put the machines away when the answer is a refusal rather than a hiccup', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let refused = false;
    openWorkplace({
      'GET api/org/spend': () => {
        if (refused) throw new WorkspaceApiError('Only a workplace admin can inspect workplace spending.', 403, {});
        return bill(2.55);
      },
    });
    await screen.findByText('nomad-trading');
    intoTheMachines();
    await waitFor(() => expect(rowTotal()).toBe('~$2.55'));

    fireEvent.click(document.getElementById('pageBack')!);
    await screen.findByText('nomad-trading');
    refused = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(CLOUD_READ_AGAIN_MS); });
    intoTheMachines();

    // What is held is no longer true — an account this reader may no longer
    // be entitled to see — so it goes, and the screen says why.
    expect(await screen.findByText('Only a workplace admin can inspect workplace spending.')).toBeTruthy();
    expect(document.querySelector('#orgSpendList .spendrow')).toBeNull();
    expect(document.getElementById('orgSpendRead')).toBeNull();
  });

  /** The wait is GATED, not deleted: a first visit has nothing to hold up. */
  it('still waits in the shape of the list on a first visit', async () => {
    vi.useFakeTimers();
    openWorkplace({ 'GET api/org/spend': () => new Promise<never>(() => {}) });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    intoTheMachines();
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT_QUIET_MS + 20); });
    expect(document.querySelectorAll('#orgSpendList .spendrow')).toHaveLength(3);
    expect(document.querySelector('#orgSpendList .skel')).toBeTruthy();
    expect(document.getElementById('orgSpendRead')).toBeNull();
  });
});

describe('secrets', () => {
  it('adds a secret from Home, warns about a clash, and saves it for the workplace', async () => {
    const { calls } = renderAt('/', {
      ...workspaceScript(() => orgState({ secrets: [secret()] })),
      ...quiet,
      'POST api/secrets': (call) => { expect(body(call)).toEqual({ name: 'GH_TOKEN', value: 'ghp_new' }); return { ok: true, created: false, name: 'GH_TOKEN' }; },
    });
    await homeShelf('secrets');
    // From the Workplace window, Add opens the secrets screen with the form
    // up (note #783): a key is the workplace's, not a room's leaf.
    fireEvent.click(await screen.findByRole('button', { name: /Add a secret/ }));
    expect(await screen.findByRole('heading', { name: 'Add a secret' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'GH_TOKEN' } });
    expect(screen.getByText(/already exists/).textContent).toContain('Saving replaces the value');
    expect(screen.getByRole('button', { name: 'Replace the value of GH_TOKEN' })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Paste the value'), { target: { value: 'ghp_new' } });
    expect(screen.getByText('7 characters')).toBeTruthy();
    // Neither field is dictated into. Speech recognition must never
    // almost-match a credential, which is why these two carry spellcheck=false
    // and stand outside a <VoiceField> (see voice/VoiceField.tsx).
    expect(within(document.getElementById('screenAdd')!).queryByRole('button', { name: /^Dictate into/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace the value of GH_TOKEN' }));
    await screen.findByRole('heading', { name: 'Secrets' });
    expect(document.getElementById('screenSecrets')).toBeTruthy();
    expect(calls.filter((call) => call.path === 'api/secrets').length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /Add a secret/ }));
    await screen.findByRole('heading', { name: 'Add a secret' });
  });

  it('copies the value inside the tap, saves a description, and deletes with a confirm', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (text: string) => { writes.push(text); } } });
    const { calls } = renderAt('/secrets/GH_TOKEN?org=o1', {
      ...workspaceScript(() => orgState({ secrets: [secret()] })),
      ...quiet,
      'GET api/secrets/GH_TOKEN/value': () => ({ name: 'GH_TOKEN', value: 'ghp_secret' }),
      'PATCH api/secrets/GH_TOKEN/description': (call) => { expect(body(call)).toEqual({ description: 'Pushes to GitHub' }); return { ok: true, name: 'GH_TOKEN' }; },
      'DELETE api/secrets/GH_TOKEN': () => ({ ok: true, name: 'GH_TOKEN' }),
    });
    fireEvent.click(await screen.findByRole('button', { name: /Copy the value/ }));
    await waitFor(() => expect(writes).toEqual(['ghp_secret']));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByPlaceholderText('What is this key for?'), { target: { value: 'Pushes to GitHub' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'api/secrets/GH_TOKEN/description')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Delete this secret' }));
    await answerAsk('Delete');
    // Deleting lands on the workplace's secrets list (note #783).
    await waitFor(() => expect(document.getElementById('screenSecrets')).toBeTruthy());
    expect(calls.some((call) => call.path === 'api/secrets/GH_TOKEN' && call.init?.method === 'DELETE')).toBe(true);
  });

  // A shared key could be limited to some rooms, an admin picking them and
  // everyone reading them (note #783), until rooms left the product (note
  // #843): a shared key reaches the workplace, or its admins' agents.

  it('a member sees a shared secret without its actions, and an agent-private one with them', async () => {
    renderAt('/secrets/OPENAI_KEY?org=o1&agent=a', {
      ...workspaceScript(() => orgState({ org: { ...org, role: 'member' }, secrets: [secret({ name: 'OPENAI_KEY', scope: 'agent', agentId: 'a', agentName: 'Ada' })] })),
      ...quiet,
    });
    expect((await screen.findByText(/Only Ada can use this one/)).textContent).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy the value/ })).toBeTruthy();
    // Note #655: the owner of a private key may replace it from here — the
    // one safe path a member has to hand a token to their own agent.
    expect(screen.getByRole('button', { name: 'Replace the value' })).toBeTruthy();
    expect(screen.queryByText(/Whose agents get it/)).toBeNull();
  });

  // Note #655: whose agents a shared key reaches. A member sees the fact and
  // the names, and no switch; an admin gets the switch.
  it('shows a shared secret\'s audience and reach, with the switch for an admin only', async () => {
    renderAt('/secrets/FLY_TOKEN?org=o1', {
      ...workspaceScript(() => orgState({ org: { ...org, role: 'member' }, secrets: [secret({ name: 'FLY_TOKEN', scope: 'shared', audience: 'admins', reaches: ['Ben', 'Ruby'] })] })),
      ...quiet,
    });
    expect((await screen.findByText('Admins’ agents only')).textContent).toBeTruthy();
    expect(screen.getByText(/Reaches Ben and Ruby/).textContent).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open to everyone' })).toBeNull();
    // Note #645: no actions means no action card — the old one drew as an
    // empty grey box above its own excuse. The sentence stands alone.
    expect(document.getElementById('secretActions')).toBeNull();
    expect(document.querySelectorAll('#screenSecret .card').length).toBe(1);
    // No Which rooms row: there are none to limit it to (note #843).
    expect(document.getElementById('secretRooms')).toBeNull();
    expect(document.querySelector('#secretHint.locknote')?.textContent).toBe('Only a workplace admin can copy, replace, describe or delete a shared secret.');
  });

  it('an admin opens a shared secret to every agent in the workplace', async () => {
    const { calls } = renderAt('/secrets/FLY_TOKEN?org=o1', {
      ...workspaceScript(() => orgState({ secrets: [secret({ name: 'FLY_TOKEN', scope: 'shared', audience: 'admins', reaches: ['Ben'] })] })),
      ...quiet,
      'PATCH api/secrets/FLY_TOKEN/audience': (call) => { expect(body(call)).toEqual({ audience: 'everyone' }); return { ok: true, name: 'FLY_TOKEN', audience: 'everyone' }; },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Open to everyone' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'api/secrets/FLY_TOKEN/audience')).toBe(true));
  });
});

/** The workplace Home stands in, by the name in its header. (The agents
 *  picker's title named the room it stood in, while there were rooms — note
 *  #843; it is "Your agents" in every workplace now.) */
const homeWorkplace = () => document.querySelector('#homeOrganizations .orgswapname')?.textContent ?? null;
/** Whether any request named a room, in its address or its scope. */
const anyRoom = (calls: Call[]) => calls.some((call) => /[?&]room=/.test(call.path) || 'room' in (call.scope ?? {}));

describe('organizations', () => {
  it('opens the active workplace details from the switcher', async () => {
    const { calls } = renderAt('/workplaces', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org': (call) => {
        expect(call.scope?.org).toBe('o1');
        return { org: orgDetail() };
      },
    });
    const current = await screen.findByRole('link', { name: /Nomad Trading/ });
    expect(current.getAttribute('aria-current')).toBe('true');
    fireEvent.click(current);
    expect(await screen.findByRole('heading', { name: 'Nomad Trading' })).toBeTruthy();
    expect(calls.some((call) => call.path === 'api/org' && call.scope?.org === 'o1')).toBe(true);
  });

  it('switches the active workplace and reads the Workspace again, naming no room', async () => {
    let active = 'o1';
    const { calls } = renderAt('/workplaces', {
      ...workspaceScript(() => orgState(active === 'o1' ? {} : { org: { ...org, orgId: 'o2', name: 'Side Hustle' }, agents: [] })),
      ...quiet,
      'POST api/org/active': (call) => { expect(body(call)).toEqual({ orgId: 'o2' }); active = 'o2'; return { ok: true, orgId: 'o2', name: 'Side Hustle' }; },
    });
    expect(await screen.findByRole('heading', { name: 'Switch workplace' })).toBeTruthy();
    await screen.findByText(/Side Hustle/);
    expect(document.querySelector('.orgrow.current')!.textContent).toContain('Nomad Trading');
    fireEvent.click(screen.getByRole('button', { name: /Side Hustle/ }));
    await homeShelf();
    await waitFor(() => expect(homeWorkplace()).toBe('Side Hustle'));
    // Read again, in the workplace now stood in — and no read names a room,
    // which Home's load did while there were rooms (note #843).
    expect(calls.filter((call) => call.path === 'api/state').at(-1)?.scope?.org).toBe('o2');
    expect(anyRoom(calls)).toBe(false);
  });

  it('keeps this tab in its own workplace when another tab switches the account (note #628)', async () => {
    // Two tabs share one account marker on the server. THIS tab stood in
    // Nomad Trading; the other tab then switched the account to Side Hustle.
    standInWorkplace(null);
    let marker = 'o1';
    const stateFor = (orgId: string) => orgState(orgId === 'o1' ? {} : {
      org: { ...org, orgId: 'o2', name: 'Side Hustle' }, agents: [],
    });
    const script = (): Record<string, Answer> => ({
      ...workspaceScript(() => stateFor(marker)),
      ...quiet,
      // The server answers every read as the workplace it names, and as the
      // account's marker only when it names none.
      'GET auth/session': (call) => ({ authenticated: true, username: 'saddam', displayName: 'Saddam', session: { sessionId: 's1', createdAt: 't', lastSeenAt: 't', absoluteExpiresAt: 't' }, activeOrgId: call.scope?.org || marker }),
      'GET api/state': (call) => stateFor(call.scope?.org || marker),
    });
    const { calls } = renderAt('/', script());
    await homeShelf();
    expect(homeWorkplace()).toBe('Nomad Trading');
    expect(standingWorkplace()).toBe('o1');

    marker = 'o2';
    const before = calls.filter((call) => call.path === 'api/state').length;
    fireEvent(document, new Event('visibilitychange'));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(calls.filter((call) => call.path === 'api/state').length).toBeGreaterThan(before));
    // Every read this tab makes still names its own workplace…
    const reads = calls.filter((call) => call.path === 'api/state' || call.path === 'api/agents/live' || call.path === 'api/notifications');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((call) => call.scope?.org === 'o1')).toBe(true);
    // …and it is still Nomad Trading on screen, not the other tab's Side
    // Hustle: its name in the header, and its agent in the picker.
    await waitFor(() => expect(homeWorkplace()).toBe('Nomad Trading'));
    expect(document.querySelector('#agentSwitchGrid .crow[data-agent="a"]')).toBeTruthy();

    // A reload of this tab lands where it stood, not where the marker went.
    cleanup();
    const again = renderAt('/', script());
    await homeShelf();
    expect(homeWorkplace()).toBe('Nomad Trading');
    expect(again.calls.find((call) => call.path === 'auth/session')?.scope?.org).toBe('o1');
    standInWorkplace(null);
  });

  it('moves this tab into a workplace it has just created (note #670)', async () => {
    // Founding from the door of an existing workplace. The server makes the
    // new one the account's active workplace; the tab, standing in the old
    // one, has to be moved too or it simply stays where it was.
    standInWorkplace('o1');
    let marker = 'o1';
    const fresh = { orgId: 'o3', name: 'Fresh Start', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] };
    // A new workplace comes with no agents (note #726). (It came with no
    // rooms either, while there were rooms — note #843.)
    const stateFor = (orgId: string) => orgState({
      ...(orgId === 'o3' ? { org: fresh, agents: [] } : {}),
      organizations: [
        { orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: orgId === 'o1', members: 2, agents: 1 },
        ...(marker === 'o3' ? [{ orgId: 'o3', name: 'Fresh Start', role: 'admin', active: orgId === 'o3', members: 1, agents: 0 }] : []),
      ],
    });
    const { calls } = renderAt('/workplaces', {
      ...workspaceScript(() => stateFor(marker)),
      ...quiet,
      'GET api/state': (call) => stateFor(call.scope?.org || marker),
      'POST api/org': (call) => {
        expect(body(call)).toEqual({ name: 'Fresh Start' });
        marker = 'o3';
        return { ok: true, orgId: 'o3', name: 'Fresh Start' };
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'New workplace' }));
    fireEvent.change(document.getElementById('orgCreateName')!, { target: { value: 'Fresh Start' } });
    const posted = calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Create workplace' }));
    // Home, the new workplace's: its name in the header, and nobody in the
    // agents picker — nothing was furnished, and none of the old
    // workplace's agents came along.
    await waitFor(() => expect(document.getElementById('screenHome')).toBeTruthy());
    await waitFor(() => expect(homeWorkplace()).toBe('Fresh Start'));
    await waitFor(() => expect(document.getElementById('agentChatSwitch')).toBeTruthy());
    fireEvent.click(document.getElementById('agentChatSwitch')!);
    await waitFor(() => expect(document.getElementById('agentSwitchEmpty')).toBeTruthy());
    expect(document.querySelector('#agentSwitchGrid .crow[data-agent]')).toBeNull();
    expect(standingWorkplace()).toBe('o3');
    const after = calls.slice(posted).filter((call) => call.path === 'api/state');
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((call) => call.scope?.org === 'o3')).toBe(true);
    standInWorkplace(null);
  });

  it('follows the account, once, when the workplace this tab stood in is gone beneath it (note #628)', async () => {
    // Deleted for good from elsewhere while this tab stood in it: the reads
    // it names are refused, and the tab moves to wherever the account is
    // now — and the briefing reads that belong to a workplace are not made
    // for none.
    standInWorkplace('o1');
    let gone = false;
    const refuse = () => { throw new WorkspaceApiError('You do not belong to this workplace.', 403, { error: 'You do not belong to this workplace.' }); };
    const { calls } = renderAt('/', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET auth/session': (call) => ({ authenticated: true, username: 'saddam', displayName: 'Saddam', session: { sessionId: 's1', createdAt: 't', lastSeenAt: 't', absoluteExpiresAt: 't' }, activeOrgId: call.scope?.org || 'o1' }),
      'GET api/state': (call) => {
        if (call.scope?.org === 'o1' && gone) refuse();
        if (!call.scope?.org) return emptyState({ org: null, organizations: [], canCreateOrg: true });
        return orgState();
      },
      'GET api/agents/live': (call) => { if (call.scope?.org === 'o1' && gone) refuse(); return { agents: [], recaps: [], sessionLimits: [] }; },
      'GET api/recap': (call) => { if (!call.scope?.org) refuse(); return { orgId: 'o1', agent: { name: 'Workspace Agent', started: false, working: false, waiting: [] }, summary: null, sources: [], updating: false, stale: false, incomplete: false, since: 't', checkedAt: 't' }; },
    });
    await homeShelf();
    expect(homeWorkplace()).toBe('Nomad Trading');
    gone = true;
    fireEvent(document, new Event('visibilitychange'));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(standingWorkplace()).toBeNull());
    const reads = calls.filter((call) => call.path === 'api/state');
    const fallback = reads.at(-1)!;
    expect(fallback.scope?.org ?? null).toBeNull();
    expect(anyRoom(calls)).toBe(false);
    await waitFor(() => expect(homeWorkplace()).not.toBe('Nomad Trading'));
    // No briefing read was made for no workplace.
    expect(calls.filter((call) => call.path === 'api/recap' && !call.scope?.org)).toHaveLength(0);
    standInWorkplace(null);
  });

  it('restores every workplace from cache while its current state refreshes silently', async () => {
    let active = 'o1';
    let visitsToSecond = 0;
    let holdSecond = false;
    let releaseSecond: ((answer: WorkspaceStateAnswer) => void) | null = null;
    const stateFor = (orgId: string, refreshed = false) => {
      const second = orgId === 'o2';
      const name = second ? 'Side Hustle' : 'Nomad Trading';
      return emptyState({
        org: { ...org, orgId, name },
        organizations: [
          { orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: orgId === 'o1', members: 2, agents: 1 },
          { orgId: 'o2', name: 'Side Hustle', role: 'member', active: orgId === 'o2', members: 1, agents: 0 },
        ],
        agents: [agent({ id: second ? 'b' : 'a', name: second ? 'Bo' : 'Ada' })],
        notes: [note({
          number: second ? 2 : 1,
          title: second ? (refreshed ? 'Side note refreshed' : 'Side note cached') : 'Nomad note cached',
        })],
      });
    };
    const { calls } = renderAt('/workplaces', {
      ...workspaceScript(() => stateFor(active)),
      ...quiet,
      'GET api/state': () => {
        if (active === 'o2' && holdSecond) {
          return new Promise<WorkspaceStateAnswer>((resolve) => { releaseSecond = resolve; });
        }
        return stateFor(active);
      },
      'POST api/org/active': (call) => {
        const next = String(body(call).orgId);
        active = next;
        if (next === 'o2') {
          visitsToSecond += 1;
          holdSecond = visitsToSecond === 2;
        } else {
          holdSecond = false;
        }
        return { ok: true, orgId: next, name: next === 'o2' ? 'Side Hustle' : 'Nomad Trading' };
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: /Side Hustle/ }));
    // The notes are a screen the window's row opens (note #960); the switch
    // is Home's, so each look goes there and comes Back.
    await homeShelf('notes');
    expect(screen.getByText('Side note cached')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Switch workplace' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Nomad Trading/ }));
    await homeShelf('notes');
    expect(screen.getByText('Nomad note cached')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Switch workplace' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Side Hustle/ }));
    await waitFor(() => expect(releaseSecond).not.toBeNull());

    // The second workplace's full cached state is already on the glass. The
    // fresh read is still unresolved, but neither the app nor Notes went back
    // to a loading state.
    await homeShelf('notes');
    expect(screen.getByText('Side note cached')).toBeTruthy();
    expect(document.getElementById('workplaceLoadingSkeleton')).toBeNull();
    expect(screen.queryByText('Loading your notes…')).toBeNull();
    // The read still out is the second workplace's own (it named its room
    // too, while there were rooms — note #843).
    const lastRead = calls.filter((call) => call.path === 'api/state').at(-1);
    expect(lastRead?.scope?.org).toBe('o2');
    expect(anyRoom(calls)).toBe(false);

    await act(async () => { releaseSecond!(stateFor('o2', true)); });
    await screen.findByText('Side note refreshed');
    expect(screen.queryByText('Side note cached')).toBeNull();
  });

  it('founds a workplace from the picker and lands on Home — with no agents (notes #144, #726)', async () => {
    let founded = false;
    const { calls } = renderAt('/workplaces', {
      ...workspaceScript(() => (founded ? orgState({ org: { ...org, name: 'Acme Trading' }, agents: [] }) : emptyState({ canCreateOrg: true }))),
      ...quiet,
      'POST api/org': (call) => {
        expect(body(call)).toEqual({ name: 'Acme Trading' });
        founded = true;
        return { ok: true, orgId: 'o1', name: 'Acme Trading' };
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /New workplace/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /Workplace name/ }), { target: { value: '  Acme Trading ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workplace' }));
    await waitFor(() => expect(document.getElementById('screenHome')).toBeTruthy());
    expect(document.getElementById('requiredSetup')).toBeNull();
    await waitFor(() => expect(homeWorkplace()).toBe('Acme Trading'));
    // Nobody in the agents picker, which offers the first one: nothing was
    // furnished, and nothing asked for an agent by hand. (Nor for a room,
    // while there were rooms — note #843.)
    await waitFor(() => expect(document.getElementById('agentChatSwitch')).toBeTruthy());
    fireEvent.click(document.getElementById('agentChatSwitch')!);
    await waitFor(() => expect(document.getElementById('agentSwitchEmpty')).toBeTruthy());
    expect(document.getElementById('newAgentBtn')).toBeTruthy();
    expect(calls.some((call) => call.path === 'api/rooms' || call.path === 'api/agents')).toBe(false);
  });

  it('requires an explicit decision on each pending person and targets the viewed org', async () => {
    let pending = [
      { requestId: 'jr1', userId: 'u3', name: 'Mira', username: 'mira', requestedAt: new Date().toISOString() },
      { requestId: 'jr2', userId: 'u4', name: 'Pat', username: 'pat', requestedAt: new Date().toISOString() },
    ];
    const { calls } = renderAt('/workplace?org=o1', {
      ...workspaceScript(() => orgState()), ...quiet,
      'GET api/org': (call) => { expect(call.scope?.org).toBe('o1'); return { org: orgDetail({ orgId: 'o1', joinRequests: pending }) }; },
      'POST api/org/join-requests/jr1/decision': (call) => {
        expect(body(call)).toEqual({ decision: 'approve' });
        expect(call.scope?.org).toBe('o1');
        pending = pending.filter((request) => request.requestId !== 'jr1');
        return { ok: true, status: 'approved' };
      },
      'POST api/org/join-requests/jr2/decision': (call) => {
        expect(body(call)).toEqual({ decision: 'reject' });
        pending = [];
        return { ok: true, status: 'rejected' };
      },
    });
    const approve = await screen.findByRole('button', { name: 'Approve Mira' });
    const first = approve.closest('.orgjoin-request')!;
    expect(first.querySelector('.crow')).toBeTruthy();
    expect(approve.classList.contains('formcommit')).toBe(true);
    expect(within(first as HTMLElement).getByRole('button', { name: 'Decline Mira' }).classList.contains('join-decline')).toBe(true);
    expect(calls.some((call) => call.path.endsWith('/decision'))).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve Mira' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Approve Pat' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Decline Pat' }));
    await screen.findByText('No pending requests.');
    expect(document.querySelector('#orgJoinRequests .roomempty')).toBeTruthy();
  });

  it.each([false, true])('creates one manageable link when ClipboardItem fails; plain copy fails = %s', async (plainFails) => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const clipboard = {
      write: vi.fn().mockRejectedValue(new Error('ClipboardItem unsupported')),
      writeText: plainFails ? vi.fn().mockRejectedValue(new Error('Permission denied')) : vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    vi.stubGlobal('ClipboardItem', class {});
    try {
      let minted = 0;
      const invite = { token: 'new-token', link: 'https://workspace.test/invite/new-token', createdAt: new Date().toISOString() };
      renderAt('/workplace?org=o1', {
        ...workspaceScript(() => orgState()), ...quiet,
        'GET api/org': () => ({ org: orgDetail({ orgId: 'o1', invites: minted ? [invite] : [] }) }),
        'POST api/org/invites': (call) => { expect(call.scope?.org).toBe('o1'); minted += 1; return { ok: true, invite }; },
      });
      const create = await screen.findByRole('button', { name: 'Create invite link' });
      expect(create.classList.contains('addrow')).toBe(true);
      expect(document.querySelector('#orgInvitesList .roomempty')).toBeTruthy();
      fireEvent.click(create);
      await screen.findByText(plainFails ? 'Link created. Copy it from the field below.' : /Invite link copied\./);
      expect(minted).toBe(1);
      await waitFor(() => expect((screen.getByLabelText('Shareable invite link') as HTMLInputElement).value).toBe(invite.link));
      expect(clipboard.writeText).toHaveBeenCalledWith(invite.link);
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('a failed copy selects the existing link for manual copying without creating another', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: vi.fn().mockRejectedValue(new Error('Permission denied')),
      writeText: vi.fn().mockRejectedValue(new Error('Permission denied')),
    } });
    try {
      const { calls } = renderAt('/workplace?org=o1', {
        ...workspaceScript(() => orgState()), ...quiet,
        'GET api/org': () => ({ org: orgDetail() }),
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }));
      expect((await screen.findByRole('alert')).textContent).toContain('Select the link to copy it manually.');
      const input = screen.getByLabelText('Shareable invite link') as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(input.value.length);
      expect(calls.some((call) => call.path === 'api/org/invites' && call.init?.method === 'POST')).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  /**
   * A workplace minted several links back when they expired on their own.
   * Those links are in somebody's chat, so they are all listed and all
   * revocable — and no new one may join them.
   */
  it('a workplace that already holds several links keeps them, under a plural heading', async () => {
    renderAt('/workplace?org=o1', {
      ...workspaceScript(() => orgState()), ...quiet,
      'GET api/org': () => ({ org: orgDetail({ invites: [
        { token: 'tok-1', link: 'https://acc.test/invite/tok-1', createdAt: '2026-09-01T00:00:00Z' },
        { token: 'tok-2', link: 'https://acc.test/invite/tok-2', createdAt: '2026-08-20T00:00:00Z' },
      ] }) }),
    });
    expect(await screen.findAllByText(/Works until you revoke it/)).toHaveLength(2);
    expect(document.getElementById('orgInviteLinksTitle')!.textContent).toBe('Invite links');
    expect(document.querySelectorAll('#orgInvitesList .orgjoin-link')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Revoke link' })).toHaveLength(2);
    expect(document.getElementById('orgInviteBtn')).toBeNull();
  });

  it('the workplace screen: members, invites, cloud, code and the danger zone', async () => {
    const { calls } = renderAt('/workplace?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org': () => ({ org: orgDetail() }),
      'DELETE api/org/invites/tok-1': () => ({ ok: true }),
      'POST api/org/git/volume': () => ({ ok: true, sizeGb: 20 }),
    });
    expect(await screen.findByRole('heading', { name: 'Nomad Trading' })).toBeTruthy();
    expect(screen.getByText('2 people · you’re an admin')).toBeTruthy();
    // The people moved onto their own page (note #328): the screen keeps one
    // door onto it, wearing their faces and the count.
    const door = document.getElementById('orgPeopleDoor')!;
    expect(within(door).getByText('People')).toBeTruthy();
    expect(within(door).getByText('2 people')).toBeTruthy();
    expect(door.querySelectorAll('.faces .face')).toHaveLength(2);
    expect(screen.queryByText('Saddam (you)')).toBeNull();
    // One link per workplace: a singular heading over the one row, and no
    // door to make a second while it stands.
    expect(document.getElementById('orgInviteLinksTitle')!.textContent).toBe('Invite link');
    expect(document.querySelectorAll('#orgInvitesList .orgjoin-link')).toHaveLength(1);
    expect(document.getElementById('orgInviteBtn')).toBeNull();
    // No expiry is shown or implied: revoking is the only thing that ends one.
    expect(screen.getByText(/Works until you revoke it/)).toBeTruthy();
    expect(screen.queryByText(/expires/i)).toBeNull();
    const inviteLinkRow = document.querySelector('.orgjoin-link > .crow')!;
    expect(within(inviteLinkRow as HTMLElement).getByText('Invite link')).toBeTruthy();
    expect(inviteLinkRow.querySelector(':scope > .icon.ft')).toBeTruthy();
    expect(inviteLinkRow.querySelector(':scope > .iconbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create another workplace' })).toBeNull();
    expect(screen.getByText('nomad-trading')).toBeTruthy();
    expect(screen.getByText('Your own cloud · private tunnel up')).toBeTruthy();
    expect(screen.getByText('2 repositories · 5.0 MB')).toBeTruthy();
    expect(screen.getByText('10 GB volume · 1.00 GB for code · 12% used')).toBeTruthy();
    const renameActions = document.getElementById('orgNameActions')!;
    const backups = document.getElementById('orgBackups')!;
    expect(backups.compareDocumentPosition(renameActions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A secondary text action, not the primary pill (owner, 2026-09-22).
    const rename = within(renameActions).getByRole('button', { name: 'Rename this workplace' });
    expect(rename.classList.contains('ghost')).toBe(true);
    expect(rename.classList.contains('formcommit')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Grow storage to 20 GB/ }));
    await answerAsk('Grow storage');
    await waitFor(() => expect(calls.some((call) => call.path === 'api/org/git/volume')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke link' }));
    const revokeDialog = await screen.findByRole('dialog');
    expect(calls.some((call) => call.path === 'api/org/invites/tok-1')).toBe(false);
    fireEvent.click(within(revokeDialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((call) => call.path === 'api/org/invites/tok-1')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke link' }));
    const confirmRevoke = within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' });
    expect(confirmRevoke.classList.contains('danger')).toBe(true);
    fireEvent.click(confirmRevoke);
    await waitFor(() => expect(calls.some((call) => call.path === 'api/org/invites/tok-1')).toBe(true));
    // The read says there is no delete door here (the platform's own
    // workplace answers this way), so none is drawn and no reason is shown.
    expect(screen.queryByRole('button', { name: 'Delete this workplace' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'See cloud details' }));
    expect(await screen.findByRole('heading', { name: 'Cloud' })).toBeTruthy();
  });

  it('renames a workplace from its details and carries the shared name back to Home', async () => {
    let name = 'Nomad Trading';
    const state = () => {
      const current = orgState();
      return {
        ...current,
        org: current.org ? { ...current.org, name } : null,
        organizations: current.organizations.map((organization) => (
          organization.orgId === 'o1' ? { ...organization, name } : organization
        )),
      };
    };
    const { calls } = renderAt('/workplace?org=o1', {
      ...workspaceScript(state), ...quiet,
      'GET api/org': () => ({ org: orgDetail({ name }) }),
      'POST api/org/name': (call) => {
        expect(call.scope?.org).toBe('o1');
        expect(body(call)).toEqual({ name: 'Northstar Studio' });
        name = 'Northstar Studio';
        return { ok: true, orgId: 'o1', name };
      },
    });

    expect(await screen.findByRole('heading', { name: 'Nomad Trading' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rename this workplace' }));
    expect(await screen.findByRole('heading', { name: 'Rename workplace' })).toBeTruthy();
    expect(screen.queryByText('Everyone in this workplace sees the new name.')).toBeNull();
    const field = screen.getByLabelText('Workplace name') as HTMLInputElement;
    expect(field.value).toBe('Nomad Trading');
    const unchangedSave = screen.getByRole('button', { name: 'Save name' }) as HTMLButtonElement;
    expect(unchangedSave.disabled).toBe(true);
    expect(unchangedSave.classList.contains('formcommit')).toBe(true);

    fireEvent.change(field, { target: { value: '  Northstar   Studio  ' } });
    const save = screen.getByRole('button', { name: 'Save name' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    expect(await screen.findByRole('heading', { name: 'Northstar Studio' })).toBeTruthy();
    expect(await screen.findByText('Your workplace is now called Northstar Studio.')).toBeTruthy();
    expect(calls.filter((call) => call.path === 'api/org/name')).toHaveLength(1);
    expect(calls.filter((call) => call.path === 'api/state').length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    // Home is the Workspace Agent's conversation since 2026-10-10, and the
    // workplace's name stands at the far edge of its header.
    await waitFor(() => expect(document.getElementById('screenHome')).toBeTruthy());
    expect(document.getElementById('homeOrganizations')!.textContent).toContain('Northstar Studio');
  });

  it('does not offer workplace rename to a member', async () => {
    renderAt('/workplace?org=o1', {
      ...workspaceScript(() => orgState({ org: { ...org, role: 'member' } })), ...quiet,
      'GET api/org': () => ({ org: orgDetail({ role: 'member', invites: null }) }),
    });
    expect(await screen.findByRole('heading', { name: 'Nomad Trading' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename this workplace' })).toBeNull();
  });

  // Always three days ahead: a fixed date turns every lock into "being
  // deleted now" the morning it passes, and the member's wording vanishes.
  const purgeAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const deletion = {
    requestedAt: '2026-09-22T10:00:00Z',
    purgeAt,
    requestedByName: 'Saddam',
    canKeep: true,
  };
  const preview = (overrides: Record<string, unknown> = {}) => ({
    name: 'Nomad Trading',
    holds: { people: 2, rooms: 2, agents: 4, repos: 2, sites: 1, notes: 5, knowledge: 3, drive: 0, secrets: 1 },
    immediate: false,
    purgeAt,
    cloud: 'nomad-trading',
    ...overrides,
  });

  it('an admin deletes a populated workplace: it says what goes and what stays, then the Workspace locks', async () => {
    let scheduled = false;
    const { calls } = renderAt('/workplace?org=o1', {
      ...workspaceScript(() => (scheduled ? orgState({ org: { ...org, deletion } }) : orgState())),
      ...quiet,
      'GET api/org': () => ({ org: orgDetail({ canDelete: true, blocked: undefined, ...(scheduled ? { deletion } : {}) }) }),
      'GET api/org/deletion': () => preview(),
      'POST api/org/deletion': (call) => {
        expect(call.scope?.org).toBe('o1');
        expect(body(call)).toEqual({ name: 'Nomad Trading' });
        scheduled = true;
        return { ok: true, deletion };
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete this workplace' }));
    expect(await screen.findByRole('heading', { name: 'Delete workplace' })).toBeTruthy();
    const goes = await waitFor(() => {
      const found = document.getElementById('orgDeleteGoes');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(goes.textContent).toContain('Repositories2');
    expect(goes.textContent).toContain('Sites1 · its address becomes free');
    // The preview may still count rooms; they led this list until rooms left
    // the product (note #843), and are not a thing to lose any more.
    expect(goes.textContent).not.toContain('Rooms');
    // Nothing in Drive: a shelf with nothing on it is not listed.
    expect(goes.textContent).not.toContain('Drive');
    const stays = document.getElementById('orgDeleteStays')!;
    expect(stays.textContent).toContain('Everyone’s account');
    expect(stays.textContent).toContain('Your Fly account');
    expect(stays.textContent).toContain('nomad-trading: its machines and storage stay there');
    expect(stays.textContent).toContain('keep costing money until you remove them in Fly');
    expect(document.getElementById('orgDeleteWhen')!.textContent).toContain('Until then any admin can keep it.');
    expect(document.getElementById('orgDeleteTold')!.textContent).toContain('2 people');

    fireEvent.click(screen.getByRole('button', { name: 'Delete workplace' }));
    const dialog = await screen.findByRole('dialog');
    const confirmBtn = within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Type Nomad Trading to confirm'), { target: { value: 'Nomad Trading ' } });
    expect(confirmBtn.disabled).toBe(false);
    fireEvent.click(confirmBtn);

    expect(await screen.findByRole('heading', { name: 'Nomad Trading is being deleted' })).toBeTruthy();
    expect(screen.getByText(/Saddam asked to delete it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep this workplace' })).toBeTruthy();
    expect(calls.filter((call) => call.path === 'api/org/deletion' && call.init?.method === 'POST')).toHaveLength(1);
  });

  it('the lock screen keeps the workplace for an admin, and the Workspace comes back', async () => {
    let kept = false;
    const { calls } = renderAt('/', {
      ...workspaceScript(() => (kept ? orgState() : orgState({ org: { ...org, deletion } }))),
      ...quiet,
      'DELETE api/org/deletion': (call) => { expect(call.scope?.org).toBe('o1'); kept = true; return { ok: true }; },
    });
    expect(await screen.findByRole('heading', { name: 'Nomad Trading is being deleted' })).toBeTruthy();
    // Nothing of the workplace is mounted behind the lock.
    expect(screen.queryByRole('tab', { name: 'Workplace' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep this workplace' }));
    await homeShelf();
    expect(await screen.findByText('Nomad Trading will not be deleted.')).toBeTruthy();
    expect(calls.some((call) => call.path === 'api/org/deletion')).toBe(true);
  });

  it('a deletion email opened while another workplace is active shows the notice and Keep on its page', async () => {
    let kept = false;
    const { calls } = renderAt('/workplace?org=o2', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org': (call) => {
        expect(call.scope?.org).toBe('o2');
        return { org: orgDetail({ orgId: 'o2', name: 'Side Hustle', canDelete: false, blocked: undefined, ...(kept ? {} : { deletion }) }) };
      },
      'DELETE api/org/deletion': (call) => { expect(call.scope?.org).toBe('o2'); kept = true; return { ok: true }; },
    });
    const notice = await waitFor(() => {
      const found = document.getElementById('orgDeletionNotice');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(notice.textContent).toContain('Saddam asked to delete Side Hustle.');
    fireEvent.click(within(notice).getByRole('button', { name: 'Keep this workplace' }));
    expect(await screen.findByText('Side Hustle will not be deleted.')).toBeTruthy();
    await waitFor(() => expect(document.getElementById('orgDeletionNotice')).toBeNull());
    expect(calls.some((call) => call.path === 'api/org/deletion')).toBe(true);
  });

  it('a member reads the lock without Keep, and can still switch to another workplace', async () => {
    renderAt('/', {
      ...workspaceScript(() => orgState({ org: { ...org, role: 'member', deletion: { ...deletion, canKeep: false } } })),
      ...quiet,
    });
    expect(await screen.findByRole('heading', { name: 'Nomad Trading is being deleted' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep this workplace' })).toBeNull();
    expect(screen.getByText(/any of its admins can still keep it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch workplace' }));
    expect(await screen.findByRole('heading', { name: 'Switch workplace' })).toBeTruthy();
    expect(screen.getByText('Side Hustle')).toBeTruthy();
  });

  it('an empty workplace with only its admin goes at once, behind the typed name, onto a fresh Home', async () => {
    let deleted = false;
    renderAt('/workplace?org=o1', {
      ...workspaceScript(() => (deleted ? emptyState({ canCreateOrg: true }) : orgState())),
      ...quiet,
      'GET api/org': () => ({ org: orgDetail({ members: [orgDetail().members[0]!], invites: null, canDelete: true, blocked: undefined }) }),
      'GET api/org/deletion': () => preview({
        immediate: true,
        holds: { people: 1, rooms: 0, agents: 0, repos: 0, sites: 0, notes: 0, knowledge: 0, drive: 0, secrets: 0 },
      }),
      'POST api/org/deletion': () => { deleted = true; return { ok: true, deleted: true, activeOrgId: null }; },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete this workplace' }));
    expect(await screen.findByText('Nothing is in it and nobody else is here, so it is deleted as soon as you confirm.')).toBeTruthy();
    expect(screen.getByText('Nothing yet — the workplace is empty.')).toBeTruthy();
    expect(document.getElementById('orgDeleteTold')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete workplace' }));
    fireEvent.change(screen.getByLabelText('Type Nomad Trading to confirm'), { target: { value: 'Nomad Trading' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await homeShelf();
    expect(await screen.findByText('New workplace')).toBeTruthy();
  });

  it('the picker says which workplace is being deleted before anyone switches into it', async () => {
    renderAt('/workplaces', {
      ...workspaceScript(() => orgState({
        organizations: [
          { orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 2, agents: 1 },
          { orgId: 'o2', name: 'Side Hustle', role: 'member', active: false, members: 1, agents: 0, deletingAt: '2026-09-29T10:00:00Z' },
        ],
      })),
      ...quiet,
    });
    const row = (await screen.findByText('Side Hustle')).closest('.orgrow')!;
    const badge = within(row as HTMLElement).getByText('Being deleted');
    // Grey, not red (note #654): a fact about the workplace, not an alarm.
    expect(badge.className).toBe('badge mut');
    const current = screen.getByText('Nomad Trading').closest('.orgrow')!;
    expect(within(current as HTMLElement).queryByText('Being deleted')).toBeNull();
  });

  it('a sole admin with work keeps the detail page free of membership and blocker footers', async () => {
    const detail = orgDetail();
    renderAt('/workplace?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org': () => ({ org: orgDetail({ members: [detail.members[0]!], canDelete: false, blocked: 'Nomad Trading still has 21 agents, 6 rooms, 4 sites, 1 repository and 569 notes.' }) }),
    });
    await screen.findByRole('heading', { name: 'Nomad Trading' });
    expect(screen.queryByRole('heading', { name: 'Membership' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create another workplace' })).toBeNull();
    expect(screen.queryByText(/still has 21 agents/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete this workplace' })).toBeNull();
  });

  it('the member screen says how long their agents have worked, naming the ones no longer here (note #644)', async () => {
    const detail = orgDetail();
    detail.members[1] = { ...detail.members[1]!, workedMs: 12_000_000, formerAgents: [{ name: 'Ruby', workedMs: 3_000_000 }] };
    renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org': () => ({ org: detail }),
    });
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    // All time, since note #925: the hours lead the contribution's figures.
    expect(document.querySelector('#orgMemberWorked [data-stat="hours"]')!.textContent).toBe('3.3agent hours');
    expect(document.querySelector('#orgMemberWorked .cago')!.textContent).toBe('including Ruby 50m, no longer here');
  });

  it('the member screen changes a role and removes, returning to the people', async () => {
    const { calls } = renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org': () => ({ org: orgDetail() }),
      'POST api/org/members/u2/role': (call) => { expect(body(call)).toEqual({ role: 'admin' }); return { ok: true, role: 'admin' }; },
    });
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    expect(screen.getByText('Member of Nomad Trading')).toBeTruthy();
    // How many agents she drives (note #346); which ones ride `agentFaces`,
    // absent from this fixture (People.test draws them). The role is the
    // line under her name, not a row that repeats it.
    expect(document.querySelector('#orgMemberAgents .v')!.textContent).toBe('3 agents');
    expect(document.querySelector('#orgMemberCard')!.textContent).not.toContain('Role');
    // How long her agents have worked here (note #644), now All time's
    // first figure (note #925): zero said as zero, and no former agent is
    // named when there is none.
    expect(document.querySelector('#orgMemberWorked [data-stat="hours"]')!.textContent).toBe('0agent hours');
    expect(document.querySelector('#orgMemberWorked .cago')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Make admin' }));
    await answerAsk('Make an admin');
    // Back where the member was opened from: the People page (note #328).
    expect(await screen.findByRole('heading', { name: 'People' })).toBeTruthy();
    expect(calls.some((call) => call.path === 'api/org/members/u2/role')).toBe(true);
  });

  it('reads as facts, one card of actions, and the removal on its own at the foot (note #613)', async () => {
    renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(() => orgState({ messagesAvailable: true })),
      ...quiet,
      'GET api/org': () => ({ org: orgDetail() }),
    });
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    const card = document.querySelector('#orgMemberCard')!;
    // Never seen: "Seen · Joined 3w ago" over "Joined · 3w ago" said one
    // thing twice, so the Seen row waits for a stamp of its own.
    expect(card.textContent).not.toContain('Seen');
    // When and by whom are one moment, so one row.
    expect(document.querySelector('#orgMemberJoined .v')!.textContent).toMatch(/ · invited by Saddam$/);
    expect(card.textContent).not.toContain('Invited by');
    // Message and the role change are rows of ONE card.
    const actions = document.querySelector('#orgMemberActions')!;
    expect([...actions.querySelectorAll('button.addrow')].map((b) => b.textContent)).toEqual(['Message Mira Chen', 'Make admin']);
    // The removal stands apart, outside every card, and alone: what it
    // costs is said by the confirmation it asks, not by a paragraph under it.
    const danger = document.querySelector('#orgMemberDanger')!;
    expect(danger.closest('.card')).toBeNull();
    expect(danger.textContent).toBe('Remove from workplace');
  });

  it('writes to them from the Workspace\'s own mail when their email is tapped (note #626)', async () => {
    const withEmail = orgDetail();
    withEmail.members[1] = { ...withEmail.members[1]!, email: 'mira@example.com' };
    const { calls } = renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org': () => ({ org: withEmail }),
      'GET api/mail/messages': () => ({ address: 'saddam@example.com', messages: [] }),
      'POST api/mail/send': () => ({ message: {
        id: 'mm_out', direction: 'sent' as const, from: { address: 'saddam@example.com' }, to: [{ address: 'mira@example.com' }],
        subject: 'Hello', snippet: 'Hi Mira', receivedAt: new Date().toISOString(), files: 0,
      } }),
    });
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    // A button, not a mailto: link — the device's mail app is not ours.
    expect(document.querySelector('#orgMemberEmail a')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'mira@example.com' }));
    const toField = await screen.findByRole('textbox', { name: 'To' }) as HTMLInputElement;
    expect(document.querySelector('#screenMailCompose')).toBeTruthy();
    expect(toField.value).toBe('mira@example.com');
    fireEvent.change(document.querySelector('#mailComposeText')!, { target: { value: 'Hi Mira' } });
    fireEvent.click(document.querySelector('#mailComposeSend')!);
    // Sent: the inbox, not the composer again.
    await waitFor(() => expect(document.querySelector('#screenMail')).toBeTruthy());
    expect(body(calls.find((call) => call.path === 'api/mail/send')!)).toMatchObject({ to: 'mira@example.com', text: 'Hi Mira' });
  });

  it('has no Email row when the record carries none', async () => {
    renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org': () => ({ org: orgDetail() }),
    });
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    expect(document.querySelector('#orgMemberEmail')).toBeNull();
  });

  it('shows Seen once the person has been seen', async () => {
    const seen = orgDetail();
    seen.members[1] = { ...seen.members[1]!, lastSeenAt: new Date(Date.now() - 2 * 3600_000).toISOString() };
    renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org': () => ({ org: seen }),
    });
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    expect(document.querySelector('#orgMemberCard .livevalue')!.textContent).toBe('Active 2h ago');
  });

  it('comes back to the member it last read and refreshes it silently (note #613)', async () => {
    renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(() => orgState()), ...quiet,
      'GET api/org': () => ({ org: orgDetail() }),
    });
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    cleanup();

    // The second open's read is still out: the facts are already there.
    let land: (answer: { org: WorkspaceOrgDetail }) => void = () => {};
    const { calls } = renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(() => orgState()), ...quiet,
      'GET api/org': () => new Promise((resolve) => { land = resolve; }),
    });
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    expect(document.querySelector('#orgMemberAgents .v')!.textContent).toBe('3 agents');
    expect(screen.queryByText('Loading…')).toBeNull();
    await waitFor(() => expect(calls.some((call) => call.path === 'api/org')).toBe(true));

    // And the refetch replaces them in place when it lands.
    const moved = orgDetail();
    moved.members[1] = { ...moved.members[1]!, agents: 4 };
    await act(async () => { land({ org: moved }); });
    await waitFor(() => expect(document.querySelector('#orgMemberAgents .v')!.textContent).toBe('4 agents'));
  });

  it('opens at once from the People list a plate was drawn from (note #613)', async () => {
    const detail = orgDetail();
    holdPeople('o1', { org: { orgId: 'o1', name: detail.name, role: 'admin', workedMs: 0 }, people: detail.members });
    renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(() => orgState()), ...quiet,
      'GET api/org': () => new Promise(() => {}),
    });
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    expect(screen.getByText('Member of Nomad Trading')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make admin' })).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('drops the held member when the refetch says the reader lost the workplace', async () => {
    renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(() => orgState()), ...quiet,
      'GET api/org': () => ({ org: orgDetail() }),
    });
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    cleanup();
    renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(() => orgState()), ...quiet,
      'GET api/org': () => { throw new WorkspaceApiError('You are not a member of this workplace.', 403, {}); },
    });
    expect(await screen.findByText('You are not a member of this workplace.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Mira Chen' })).toBeNull();
  });

  it('places the Latest line in time, as the plate that opened it does (note #385)', async () => {
    // A minute past two hours, so the card's clock cannot round it to 1h.
    const twoHoursAgo = new Date(Date.now() - 121 * 60_000).toISOString();
    const withRecap = orgDetail();
    withRecap.members[1] = { ...withRecap.members[1]!, recap: 'Handed note #385 to Alex', recapAt: twoHoursAgo };
    renderAt('/workplace/members/u2?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org': () => ({ org: withRecap }),
    });
    expect(await screen.findByRole('heading', { name: 'Mira Chen' })).toBeTruthy();
    expect(screen.getByText('Handed note #385 to Alex')).toBeTruthy();
    expect(document.querySelector('#orgMemberCard .cago')!.textContent).toBe('2h ago');
  });

  it('counts the reader’s own agents too, and names only what the server sent', async () => {
    renderAt('/workplace/members/u1?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org': () => ({ org: orgDetail() }),
    });
    expect(await screen.findByRole('heading', { name: 'Saddam' })).toBeTruthy();
    // Ada is in this reader's OWN fleet, but the page names a member's agents
    // from their row (`agentFaces`, 2026-09-23) and never from the reader's
    // fleet — a row from an older backend carries none, and names none.
    expect(document.querySelector('#orgMemberAgents .v')!.textContent).toBe('1 agent');
    expect(document.querySelector('#screenOrgMember')!.textContent).not.toContain('Ada');
  });
});

/**
 * The rooms list, a room's own screen — renamed, reordered, deleted, asked to
 * be deleted by the Chief of Staff — and a new room to stand in, until rooms
 * left the product (note #843). Their addresses are retired places: a link
 * copied before then opens Home, the workplace the room was part of.
 */
describe('the rooms’ old addresses (note #843)', () => {
  for (const address of ['/rooms?org=o1', '/rooms/r2?org=o1']) {
    it(`opens Home from ${address.split('?')[0]}, with nothing of a room left to show`, async () => {
      const scripted = scriptedApi({ ...workspaceScript(() => orgState()), ...quiet });
      const Where = () => { const here = useLocation(); return <div data-testid="where">{here.pathname}</div>; };
      render(
        <MemoryRouter initialEntries={[address]}>
          <App api={scripted.api} />
          <Routes><Route path="*" element={<Where />} /></Routes>
        </MemoryRouter>,
      );
      await waitFor(() => expect(document.getElementById('screenHome')).toBeTruthy());
      expect(screen.getByTestId('where').textContent).toBe('/');
      expect(screen.queryByRole('heading', { name: 'Rooms' })).toBeNull();
      expect(scripted.calls.some((call) => call.path.startsWith('api/rooms'))).toBe(false);
    });
  }
});

describe('seats', () => {
  it('re-reads the list and an individual subscription on load and focus', async () => {
    const { calls } = renderAt('/seats?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [seat()], available: [] }),
    });
    const reads = () => calls.filter((call) => call.path === 'api/org/seats').length;
    await screen.findByText('Claude · signed in 1 Sep');
    expect(reads()).toBe(1);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(reads()).toBe(2));

    fireEvent.click(screen.getByText('Claude · signed in 1 Sep'));
    await screen.findByRole('heading', { name: 'Claude · signed in 1 Sep' });
    await waitFor(() => expect(reads()).toBe(3));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(reads()).toBe(4));
  });

  it('says Primary, in grey, on the list row turns use first — only beside another of its harness (note #773)', async () => {
    renderAt('/seats?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/seats': () => ({
        seats: [
          seat({ seatId: 's1', label: 'Claude · first', planText: 'Max 20x', selected: true }),
          seat({ seatId: 's2', label: 'Claude · second', planText: 'Ai', selected: false }),
          // Alone for its harness: first by default, nothing to be primary over.
          seat({ seatId: 'c1', provider: 'codex', label: 'ChatGPT · only', planText: 'Plus', selected: true }),
        ],
        available: [],
      }),
    });
    const row = async (label: string) => (await screen.findByText(label)).closest('.crow') as HTMLElement;
    const marks = async (label: string) => [...(await row(label)).querySelectorAll('.badge')]
      .map((badge) => [badge.textContent, badge.className]);
    expect(await marks('Claude · first')).toEqual([['Primary', 'badge mut']]);
    expect(await marks('Claude · second')).toEqual([]);
    expect(await marks('ChatGPT · only')).toEqual([]);
  });

  it('lists assigned seats with their usage and available sign-ins, and opens a seat', async () => {
    const { calls } = renderAt('/seats?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [seat()], available: [seat({ seatId: 's2', label: 'Claude · old', status: 'dead', selected: false })] }),
      'DELETE api/seats/s2': () => ({ ok: true }),
    });
    expect(await screen.findByText('One private sign-in assigned to Nomad Trading.')).toBeTruthy();
    const row = screen.getByText('Claude · signed in 1 Sep').closest('.crow') as HTMLElement;
    expect(row.querySelector('.seatdot')).toBeNull();
    expect(row.querySelector('.pct.hot')!.textContent).toBe('91% (this week)');
    expect(row.querySelector('.meter-fill.hot')).toBeTruthy();
    expect(within(row).getByText('Ready')).toBeTruthy();
    expect(screen.getByText(/Your current subscription access follows you the first time you enter a workplace/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your other sign-ins' })).toBeTruthy();
    expect(screen.getByText('Claude Code · needs sign-in · delete removes it everywhere')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await answerAsk('Delete');
    await waitFor(() => expect(calls.some((call) => call.path === 'api/seats/s2')).toBe(true));
    fireEvent.click(await screen.findByText('Claude · signed in 1 Sep'));
    expect(await screen.findByRole('heading', { name: 'Claude · signed in 1 Sep' })).toBeTruthy();
    expect(screen.getByText('Uses this subscription first')).toBeTruthy();
    expect(screen.getAllByText(/% used/).length).toBe(2);
    expect(screen.getAllByText(/^Resets in /).length).toBe(2);
  });

  // Note #491, in our owner's screenshot: an empty "Your seats" was two grey
  // boxes a hairline apart — one line of apology, then a card whose whole
  // contents were one line of accent text. The zero state now says what a
  // subscription is for, and the door stands at the foot of the list it
  // fills, which is the idiom every other shelf in the Workspace uses.
  it('answers an empty list with a real zero state, and the door stands in the list card', async () => {
    renderAt('/seats?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [], available: [] }),
    });
    const empty = (await screen.findByText('Your agents need a subscription')).closest('.roomempty') as HTMLElement;
    expect(empty.querySelector('.roomemptymark .icon')).toBeTruthy();
    expect(within(empty).getByText(/teammates and admins never see its credentials/)).toBeTruthy();
    const door = screen.getByRole('button', { name: 'Sign in a subscription' });
    expect(door.className).toBe('addrow');
    expect(door.closest('.card')).toBe(empty.closest('.card'));
    // One card on the whole screen: the door has none of its own.
    expect(document.querySelectorAll('#screenSeats .card').length).toBe(1);
    fireEvent.click(door);
    expect(await screen.findByRole('heading', { name: 'Sign in a subscription' })).toBeTruthy();
  });

  it('points an empty list at the sign-ins this member already holds', async () => {
    renderAt('/seats?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [], available: [seat({ seatId: 's2', label: 'Claude · old', selected: false })] }),
    });
    expect(await screen.findByText('Nothing assigned here yet')).toBeTruthy();
    expect(screen.getByText(/The sign-in you already hold can work here too/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your other sign-ins' })).toBeTruthy();
  });

  it('a seat says how far off an even pace each of its windows is', async () => {
    renderAt('/seats/s1?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [seat()], available: [] }),
    });
    // 91% spent with 60% of the week gone: 31 points ahead, and the rest of
    // the allowance lasts about another ten hours at that rate.
    const pace = (await screen.findByText(/ahead of an even pace/)).closest('.usage-pace') as HTMLElement;
    expect(pace.textContent).toMatch(/^31% ahead of an even pace · gone in \d+h( \d+m)?$/);
    expect(pace.className).toBe('usage-pace warn');
    const week = pace.closest('.row')!;
    expect(week.querySelector('.meter-pace')!.getAttribute('style')).toContain('left: 60');
    expect(week.querySelector('.meter-pace')!.getAttribute('title')).toBe('An even pace would be 60% by now');
    // The five-hour session window is read the same way (note #341): 40%
    // spent with four of its five hours gone is well under an even pace.
    const session = screen.getByText('5 hours').closest('.row')!;
    expect(session.querySelector('.usage-pace')!.textContent).toBe('40% under an even pace');
    expect(session.querySelector('.usage-pace')!.className).toBe('usage-pace');
    expect(session.querySelector('.meter-pace')!.getAttribute('title')).toBe('An even pace would be 80% by now');
  });

  it('leaves the subscription actions unboxed and without an explanatory footer', async () => {
    renderAt('/seats/s1?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [seat()], available: [] }),
    });
    const actions = await screen.findByText('Unassign from this workplace');
    const group = actions.closest('#seatActions') as HTMLElement;
    expect(group.closest('.card')).toBeNull();
    const remove = within(group).getByRole('button', { name: 'Remove subscription everywhere' });
    fireEvent.click(remove);
    // What it costs is said by the app's own card now, not by the browser's
    // box — so the words are read off the dialog, and its answer is red.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Remove “Claude · signed in 1 Sep” everywhere?' })).toBeTruthy();
    expect(within(dialog).getByText('Every workplace using it loses access to the subscription. You would have to sign in again to restore it.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Remove' }).classList.contains('danger')).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(document.getElementById('seatHint')).toBeNull();
  });

  it.each(['codex', 'claude'] as const)('shows %s pace two hours after the weekly reset', async (provider) => {
    renderAt('/seats/s1?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [seat({ provider, windows: [{
        label: '7 days', usedPercent: 5, percentText: '5', windowMins: 10_080,
        resetAt: new Date(Date.now() + WEEK_MS - 2 * 3600_000).toISOString(),
      }] })], available: [] }),
    });
    const pace = (await screen.findByText('4% ahead of an even pace')).closest('.usage-pace')!;
    expect(pace.textContent).toBe('4% ahead of an even pace · Period just started');
    expect(pace.className).toBe('usage-pace');
    expect(pace.closest('.row')!.querySelector('.meter-pace')!.getAttribute('title'))
      .toBe('An even pace would be 1% by now');
  });

  it('a five-hour window spent early says when the session runs out', async () => {
    renderAt('/seats/s1?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [seat({ windows: [{
        label: '5 hours', usedPercent: 34, percentText: '34', trackText: '5 hours', windowMins: 300,
        resetAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
      }] })], available: [] }),
    });
    const pace = (await screen.findByText('14% ahead of an even pace')).closest('.usage-pace')!;
    expect(pace.textContent).toMatch(/^14% ahead of an even pace · gone in 1h 5\dm$/);
    expect(pace.className).toBe('usage-pace warn');
    expect(pace.closest('.row')!.querySelector('.meter-pace')!.getAttribute('title'))
      .toBe('An even pace would be 20% by now');
  });

  it('a seat mutation drops the cache and replaces the address with the list, which reads again', async () => {
    const { calls } = renderAt('/seats/s1?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [seat({ selected: false })], available: [] }),
      'POST api/org/seats/s1/select': () => ({ ok: true }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Make primary here' }));
    expect(await screen.findByRole('heading', { name: 'Your subscriptions' })).toBeTruthy();
    await waitFor(() => expect(calls.filter((call) => call.path === 'api/org/seats').length).toBeGreaterThanOrEqual(2));
    const selectAt = calls.findIndex((call) => call.path === 'api/org/seats/s1/select');
    expect(calls.slice(selectAt).some((call) => call.path === 'api/org/seats')).toBe(true);
  });

  it('a seat mutation spends the entry underneath instead of stacking a second list (note #400)', async () => {
    // Walked to, not deep-linked: the list is then a real browser entry of
    // ours underneath the seat, which is the case the replace used to stack
    // a duplicate of — leaving Back to repaint the same list at the same
    // address, so the way out cost two taps.
    renderAt('/seats?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [seat({ selected: false })], available: [] }),
      'POST api/org/seats/s1/select': () => ({ ok: true }),
    });
    fireEvent.click(await screen.findByText('Claude · signed in 1 Sep'));
    fireEvent.click(await screen.findByRole('button', { name: 'Make primary here' }));
    expect(await screen.findByRole('heading', { name: 'Your subscriptions' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Your subscriptions' })).toBeNull());
  });

  // Note #625, in our owner's words: "When I open a subscription page, and it
  // doesn't yet has data, it shows poorly designed loading state and it
  // display text 'Seat'". Home's plates are drawn from the state read, which
  // never fills the seats cache — so the tap a reader actually makes opens a
  // page whose own read has only just gone out. That page was the word "Seat"
  // over one grey "Loading…" line.
  const heldRow = {
    seatId: 's1', provider: 'claude', label: 'Claude · signed in 1 Sep', planText: 'Max 5x', selected: true,
    windows: [{ usedPercent: 40, percentText: '40', trackText: '5 hours', pace: 'under' as const }, { usedPercent: 91, percentText: '91', trackText: 'this week' }],
  };

  it('a subscription opened before its read lands stands under its own name, with what the state read holds (note #625)', async () => {
    let land: (answer: unknown) => void = () => {};
    renderAt('/seats/s1?org=o1', {
      ...workspaceScript(() => orgState({ org: { ...org, seatUsage: [heldRow] } })),
      ...quiet,
      'GET api/org/seats': () => new Promise((resolve) => { land = resolve; }),
    });
    expect(await screen.findByRole('heading', { name: 'Claude · signed in 1 Sep' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Seat' })).toBeNull();
    expect(document.getElementById('seatSub')!.textContent).toBe('Claude Code subscription');
    // Once the wait is worth drawing: the facts the plate already knew, as
    // themselves, with only the day it was added held as a bar.
    const facts = await waitFor(() => {
      const card = document.getElementById('seatCardWait');
      expect(card).toBeTruthy();
      return card!;
    });
    expect(within(facts).getByText('Ready')).toBeTruthy();
    expect(within(facts).getByText('Max 5x')).toBeTruthy();
    expect(within(facts).getByText('Uses this subscription first')).toBeTruthy();
    expect(facts.querySelectorAll('.skel').length).toBe(1);
    // A usage row held per reading, the paced one with its pace line.
    expect(document.querySelectorAll('#seatUsageWait .row').length).toBe(2);
    expect(document.querySelectorAll('#seatUsageWait .usage-pace').length).toBe(1);
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByText('Loading this subscription…').className).toBe('sr-only');
    // Nothing is offered to act on a record that is not in hand yet.
    expect(screen.queryByRole('button', { name: 'Unassign from this workplace' })).toBeNull();

    await act(async () => { land({ seats: [seat()], available: [] }); });
    expect(await screen.findByRole('button', { name: 'Unassign from this workplace' })).toBeTruthy();
    expect(document.getElementById('seatCardWait')).toBeNull();
    expect(document.querySelectorAll('#screenSeat .skel').length).toBe(0);
    expect(screen.getByRole('heading', { name: 'Claude · signed in 1 Sep' })).toBeTruthy();
  });

  it('a subscription no longer assigned here says so under a real word, not "Seat" (note #625)', async () => {
    renderAt('/seats/gone?org=o1', {
      ...workspaceScript(() => orgState({ org: { ...org, seatUsage: [heldRow] } })),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [seat()], available: [] }),
    });
    expect(await screen.findByText('This subscription is no longer assigned here.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Subscription' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Seat' })).toBeNull();
  });

  it('the list opened before its read lands draws the rows the state read already holds (note #625)', async () => {
    renderAt('/seats?org=o1', {
      ...workspaceScript(() => orgState({ org: { ...org, seatUsage: [heldRow] } })),
      ...quiet,
      'GET api/org/seats': () => new Promise(() => {}),
    });
    const row = (await screen.findByText('Claude · signed in 1 Sep')).closest('.crow') as HTMLElement;
    expect(screen.getByText('One private sign-in assigned to Nomad Trading.')).toBeTruthy();
    expect(within(row).getByText('Claude Code · Max 5x')).toBeTruthy();
    expect(row.querySelector('.pct.hot')!.textContent).toBe('91% (this week)');
    expect(within(row).getByText('Ready')).toBeTruthy();
    expect(document.getElementById('seatsList')!.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('Loading…')).toBeNull();
    // The row is a door already: it only needs the id, which the state holds.
    fireEvent.click(row);
    expect(await screen.findByRole('heading', { name: 'Claude · signed in 1 Sep' })).toBeTruthy();
    expect(document.getElementById('seatSub')!.textContent).toBe('Claude Code subscription');
  });

  // Note #697, in our owner's words: "If I open a subscription details page, I
  // see stale data for a moment and then it updates. … In the home page, the
  // data was fresh. … I think there should be one source of truth." The page
  // painted the record the seats cache had held since an earlier visit — its
  // percentages older than the plate just tapped — until its own read landed.
  // Both reads now stamp a subscription, and the newer copy is the one drawn.
  const reading = (at: string, fiveHours: number) => {
    const windows = [
      { label: '5 hours', usedPercent: fiveHours, percentText: String(fiveHours), trackText: '5 hours', windowMins: 300, resetAt: new Date(Date.now() + 3600_000).toISOString() },
      { label: '7 days', usedPercent: 30, percentText: '30', trackText: 'this week', windowMins: 10_080, resetAt: new Date(Date.now() + 0.4 * WEEK_MS).toISOString() },
    ];
    return {
      row: { seatId: 's1', provider: 'claude', label: 'Claude · signed in 1 Sep', planText: 'Max 5x', selected: true, windows, usageRefreshedAt: at, updatedAt: at },
      record: seat({ windows, usageRefreshedAt: at, updatedAt: at }),
    };
  };
  const morning = reading('2026-10-04T08:00:00Z', 12);
  const afternoon = reading('2026-10-04T13:00:00Z', 65);
  const usageWords = () => [...document.querySelectorAll('#seatUsageCard .usage-pct')].map((node) => node.textContent);

  it('a subscription opened from Home draws the reading Home showed, never an older one it held (note #697)', async () => {
    let server = morning;
    let held = false;
    let land: (answer: unknown) => void = () => {};
    renderAt('/overview?org=o1', {
      ...workspaceScript(() => orgState({ org: { ...org, seatUsage: [server.row] } })),
      ...quiet,
      'GET api/org/seats': () => (held
        ? new Promise((resolve) => { land = resolve; })
        : { seats: [server.record], available: [] }),
    });
    // The morning visit fills the seats cache.
    fireEvent.click((await screen.findByText('Max 5x')).closest('.seatcard') as HTMLElement);
    await screen.findByRole('button', { name: 'Unassign from this workplace' });
    expect(usageWords()).toEqual(['12% used', '30% used']);

    // By the afternoon Home has moved on, and this time the page's own read
    // is slow.
    server = afternoon;
    held = true;
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(document.querySelector('.seatcard .pct')!.textContent).toBe('65%'));
    fireEvent.click(document.querySelector('.seatcard') as HTMLElement);
    await screen.findByRole('heading', { name: 'Claude · signed in 1 Sep' });
    // The held record still opens the page whole, actions and all — but its
    // usage is Home's reading, not the morning's 12%.
    expect(screen.getByRole('button', { name: 'Unassign from this workplace' })).toBeTruthy();
    expect(usageWords()).toEqual(['65% used', '30% used']);
    expect(screen.getAllByText(/^Resets in /).length).toBe(2);
    expect(document.querySelector('#seatUsageCard .usage-foot')!.textContent).toMatch(/^Checked /);
    expect(document.querySelectorAll('#screenSeat .skel').length).toBe(0);

    await act(async () => { land({ seats: [afternoon.record], available: [] }); });
    expect(usageWords()).toEqual(['65% used', '30% used']);
    expect(screen.getByRole('button', { name: 'Unassign from this workplace' })).toBeTruthy();
  });

  it('a subscription opened cold draws Home\'s reading in full while its own read is out (note #697)', async () => {
    renderAt('/seats/s1?org=o1', {
      ...workspaceScript(() => orgState({ org: { ...org, seatUsage: [afternoon.row] } })),
      ...quiet,
      'GET api/org/seats': () => new Promise(() => {}),
    });
    await waitFor(() => expect(usageWords()).toEqual(['65% used', '30% used']));
    expect(document.getElementById('seatUsageWait')).toBeNull();
    // Only the day it was added is not on Home's row.
    expect(document.querySelectorAll('#seatCardWait .skel').length).toBe(1);
    expect(document.getElementById('screenSeat')!.getAttribute('aria-busy')).toBe('true');
  });

  it('the list opened from Home again draws Home\'s newer rows, not the ones it held (note #697)', async () => {
    let server = morning;
    let held = false;
    renderAt('/overview?org=o1', {
      ...workspaceScript(() => orgState({ org: { ...org, seatUsage: [server.row] } })),
      ...quiet,
      'GET api/org/seats': () => (held ? new Promise(() => {}) : { seats: [server.record], available: [] }),
    });
    const row = () => (screen.getByText('Claude · signed in 1 Sep').closest('.crow') as HTMLElement).querySelector('.pct')!.textContent;
    fireEvent.click(await screen.findByRole('button', { name: 'Add sub' }));
    await waitFor(() => expect(document.getElementById('seatsList')!.getAttribute('aria-busy')).toBeNull());
    expect(row()).toBe('12% (5 hours)');

    server = afternoon;
    held = true;
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(document.querySelector('.seatcard .pct')!.textContent).toBe('65%'));
    fireEvent.click(screen.getByRole('button', { name: 'Add sub' }));
    await screen.findByRole('heading', { name: 'Your subscriptions' });
    expect(row()).toBe('65% (5 hours)');
  });

  it('an open subscription follows Home when a turn moves it on, and asks for its record again (note #697)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // A spend cap rides the record alone: Home's row leaves it out.
    const spending = (copy: typeof morning) => seat({ ...copy.record, windows: [...copy.record.windows!, { label: 'Extra usage', usedPercent: 70, percentText: '70', trackText: 'extra usage', spend: true, detailText: '$56.32 of $80.00' }] });
    let server = morning;
    let working: Array<{ id: string }> = [];
    let land: (answer: unknown) => void = () => {};
    let seatsAnswer: () => unknown = () => ({ seats: [spending(server)], available: [] });
    const { calls } = renderAt('/seats/s1?org=o1', {
      ...workspaceScript(() => orgState({ org: { ...org, seatUsage: [server.row] } })),
      ...quiet,
      'GET api/org/seats': () => seatsAnswer(),
      'GET api/agents/live': () => ({ agents: working, recaps: [], sessionLimits: [] }),
    });
    await screen.findByRole('button', { name: 'Unassign from this workplace' });
    expect(usageWords()).toEqual(['12% used', '30% used', '70% used']);
    const seatReads = () => calls.filter((call) => call.path === 'api/org/seats').length;
    const before = seatReads();

    // A turn starts: the live tick asks for the full state, which carries the
    // afternoon reading. The page draws it at once and asks for the record.
    server = afternoon;
    seatsAnswer = () => new Promise((resolve) => { land = resolve; });
    working = [{ id: 'a' }];
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    working = [];
    // Only the numbers move: the record's spend row and its actions stay put.
    await waitFor(() => expect(usageWords()).toEqual(['65% used', '30% used', '70% used']));
    expect(screen.getByRole('button', { name: 'Unassign from this workplace' })).toBeTruthy();
    expect(seatReads()).toBe(before + 1);
    await act(async () => { land({ seats: [spending(afternoon)], available: [] }); });
    expect(usageWords()).toEqual(['65% used', '30% used', '70% used']);
    expect(screen.getByRole('button', { name: 'Unassign from this workplace' })).toBeTruthy();
    expect(seatReads()).toBe(before + 1);
  });

  it('a subscription page whose own read is newer than Home asks the state read again, once (note #697)', async () => {
    let server = morning;
    const { calls } = renderAt('/seats/s1?org=o1', {
      ...workspaceScript(() => orgState({ org: { ...org, seatUsage: [server.row] } })),
      ...quiet,
      // This read waited on a provider probe: the server's rows moved on
      // under the state read Home already holds.
      'GET api/org/seats': () => { server = afternoon; return { seats: [afternoon.record], available: [] }; },
    });
    await screen.findByRole('button', { name: 'Unassign from this workplace' });
    expect(usageWords()).toEqual(['65% used', '30% used']);
    const paths = () => calls.map((call) => call.path);
    await waitFor(() => expect(paths().lastIndexOf('api/state')).toBeGreaterThan(paths().lastIndexOf('api/org/seats')));
    const stateReads = () => paths().filter((path) => path === 'api/state').length;
    const settled = stateReads();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(stateReads()).toBe(settled);
  });

  it('a paused seat wears the recovery card, and Check again repaints from the answer', async () => {
    renderAt('/seats/s1?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/seats': () => ({ seats: [seat({ status: 'payment_required', attention: 'payment_required', subscriptionStatus: 'past_due' })], available: [] }),
      'POST api/org/seats/s1/check': () => ({ check: 'ready', seat: seat() }),
    });
    expect(await screen.findByRole('heading', { name: 'Claude paused this subscription' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Last known usage' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Claude paused this subscription' })).toBeNull());
    expect(screen.getByRole('heading', { name: 'Usage' })).toBeTruthy();
  });
});

describe('the sign-in ceremony', () => {
  it('walks Claude: pick, open, paste the code whole, and land on the seats with the cache dropped first', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const opened: string[] = [];
    vi.stubGlobal('open', (url: string) => { opened.push(url); return null; });
    let phase: 'awaiting_code' | 'verifying' | 'done' = 'awaiting_code';
    let started = false;
    const status = () => ({ signin: { provider: 'claude', startedAt: 't', state: phase === 'awaiting_code' ? { phase, url: 'https://claude.ai/oauth' } : phase === 'done' ? { phase, seatId: 's9', label: 'Claude · new' } : { phase } } });
    const seatReads: number[] = [];
    const { calls } = renderAt('/seats/sign-in?org=o1', {
      ...workspaceScript(() => orgState()),
      'GET api/org/signin': () => (started ? status() : { signin: null }),
      'POST api/org/signin': (call) => { expect(body(call)).toEqual({ provider: 'claude' }); started = true; return status(); },
      'POST api/org/signin/code': (call) => { expect(body(call)).toEqual({ code: 'abc#def' }); phase = 'verifying'; return status(); },
      'GET api/org/seats': () => { seatReads.push(Date.now()); return { seats: [seat({ seatId: 's9', label: 'Claude · new' })], available: [] }; },
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Claude/ }));
    expect(await screen.findByRole('heading', { name: 'Sign in to Claude' })).toBeTruthy();
    expect([...document.querySelectorAll('#seatSignInBody .signinstep .stepk')].map((step) => step.textContent))
      .toEqual(['1Open and approve', '2Paste the code it gives you']);
    // Whose page the sign-in happens on, under the step that opens it (the
    // owner, 2026-10-09).
    expect(document.getElementById('seatSignInWhere')!.textContent).toBe('You sign in on Anthropic’s own page, and your password never touches us.');
    expect(document.getElementById('seatSignInWhere')!.closest('.signinstep')!.textContent).toContain('Open the Claude sign-in');
    // No machine is involved in either provider's sign-in, so none is named.
    expect(document.getElementById('seatSignInSub')!.textContent).toBe('');
    const finish = screen.getByRole('button', { name: 'Finish sign-in' }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open the Claude sign-in' }));
    expect(opened).toEqual(['https://claude.ai/oauth']);
    fireEvent.change(screen.getByLabelText('Paste the sign-in code'), { target: { value: ' abc#def ' } });
    expect(finish.disabled).toBe(false);
    // A poll that answers with the same state leaves the half-typed code alone.
    await act(async () => { await vi.advanceTimersByTimeAsync(SEAT_SIGNIN_POLL_MS + 10); });
    expect((screen.getByLabelText('Paste the sign-in code') as HTMLInputElement).value).toBe(' abc#def ');
    fireEvent.click(finish);
    expect(await screen.findByText('Checking the sign-in…')).toBeTruthy();
    phase = 'done';
    await act(async () => { await vi.advanceTimersByTimeAsync(SEAT_SIGNIN_POLL_MS + 10); });
    expect(await screen.findByRole('heading', { name: 'Your subscriptions' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Claude · new')).toBeTruthy());
    expect(calls.some((call) => call.path === 'api/org/signin/code')).toBe(true);
  });

  it('a fresh visit to the picker resumes the sign-in under way, at its own page', async () => {
    // Coming back to the tab — or reloading — mid-sign-in lands on the
    // provider's page with the same code, not on a picker that forgot it.
    renderAt('/seats/sign-in?org=o1', {
      ...workspaceScript(() => orgState()),
      'GET api/org/signin': () => ({ signin: { provider: 'codex', startedAt: 't', state: { phase: 'awaiting_approval', url: 'https://chatgpt.com/device', userCode: 'ABCD-EFGH' } } }),
    });
    expect(await screen.findByRole('heading', { name: 'Sign in to ChatGPT' })).toBeTruthy();
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    expect(screen.queryByLabelText('Paste the sign-in code')).toBeNull();
  });

  it('each subscription has its own page; Cancel goes back to the picker it came from', async () => {
    let signin: unknown = null;
    const posted: unknown[] = [];
    const deleted: number[] = [];
    renderAt('/seats/sign-in?org=o1', {
      ...workspaceScript(() => orgState()),
      'GET api/org/signin': () => ({ signin }),
      'POST api/org/signin': (call) => {
        posted.push(body(call));
        signin = { provider: 'codex', startedAt: 't', state: { phase: 'awaiting_approval', url: 'https://chatgpt.com/device', userCode: 'ABCD-EFGH' } };
        return { signin };
      },
      'DELETE api/org/signin': () => { deleted.push(1); signin = null; return { ok: true }; },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Codex/ }));
    expect(await screen.findByRole('heading', { name: 'Sign in to ChatGPT' })).toBeTruthy();
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    expect(posted).toEqual([{ provider: 'codex' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: 'Sign in a subscription' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Codex/ })).toBeTruthy();
    expect(deleted).toEqual([1]);
  });

  it('Start again after a failure restarts the SAME subscription, and the picker is a second choice', async () => {
    const posted: unknown[] = [];
    renderAt('/seats/sign-in/chatgpt?org=o1', {
      ...workspaceScript(() => orgState()),
      'GET api/org/signin': () => ({ signin: null }),
      'POST api/org/signin': (call) => {
        posted.push(body(call));
        return { signin: posted.length === 1
          ? { provider: 'codex', startedAt: 't', state: { phase: 'failed', reason: 'The sign-in expired — codes only live a few minutes. Start it again.' } }
          : { provider: 'codex', startedAt: 't2', state: { phase: 'awaiting_approval', url: 'https://chatgpt.com/device', userCode: 'QRST-5678' } } };
      },
    });
    expect(await screen.findByText(/codes only live a few minutes/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose another subscription' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(() => expect(posted).toEqual([{ provider: 'codex' }, { provider: 'codex' }]));
    expect(await screen.findByText('QRST-5678')).toBeTruthy();
  });

  it('holds a provider\'s two steps in place while its sign-in starts, then fills them', async () => {
    // The code is asked of OpenAI while the page is already up (2026-09-22):
    // the steps stand at their own size, the unknowns as placeholders, and
    // nothing can be pressed that has nothing behind it yet.
    let release!: () => void;
    const asked = new Promise<void>((resolve) => { release = resolve; });
    renderAt('/seats/sign-in/chatgpt?org=o1', {
      ...workspaceScript(() => orgState()),
      'GET api/org/signin': () => ({ signin: null }),
      'POST api/org/signin': () => asked.then(() => ({ signin: { provider: 'codex', startedAt: 't', state: { phase: 'awaiting_approval', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' } } })),
    });
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(document.getElementById('seatSignInBody')!.getAttribute('aria-busy')).toBe('true');
    expect([...document.querySelectorAll('#seatSignInBody .signinstep .stepk')].map((step) => step.textContent))
      .toEqual(['1Copy your code', '2Enter it and approve']);
    expect(document.getElementById('seatSignInCode')).toBeNull();
    expect(document.querySelectorAll('#seatSignInBody .skel')).toHaveLength(2);
    expect((screen.getByRole('button', { name: 'Open the ChatGPT sign-in' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Finish sign-in' }) as HTMLButtonElement).disabled).toBe(true);
    release();
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    expect(document.querySelectorAll('#seatSignInBody .skel')).toHaveLength(0);
    expect(document.getElementById('seatSignInBody')!.getAttribute('aria-busy')).toBe('false');
    expect((screen.getByRole('button', { name: 'Open the ChatGPT sign-in' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Finish sign-in says it is checking while it asks', async () => {
    let release!: () => void;
    const asked = new Promise<void>((resolve) => { release = resolve; });
    const awaiting = { provider: 'codex', startedAt: 't', state: { phase: 'awaiting_approval', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' } };
    let reads = 0;
    renderAt('/seats/sign-in/chatgpt?org=o1', {
      ...workspaceScript(() => orgState()),
      // The page's own first read answers at once; the Finish tap's is held.
      'GET api/org/signin': () => { reads += 1; return reads === 1 ? { signin: awaiting } : asked.then(() => ({ signin: awaiting })); },
    });
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    expect(((await screen.findByRole('button', { name: 'Checking…' })) as HTMLButtonElement).disabled).toBe(true);
    release();
    expect(await screen.findByRole('button', { name: 'Finish sign-in' })).toBeTruthy();
  });

  it('a page whose word names no subscription is the picker', async () => {
    renderAt('/seats/sign-in/gemini?org=o1', { ...workspaceScript(() => orgState()), ...quiet });
    expect(await screen.findByRole('heading', { name: 'Sign in a subscription' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Claude/ })).toBeTruthy();
  });

  it('walks ChatGPT: pick, the one-time code at once, and land on the seats when the poll sees the approval', async () => {
    // The server asks OpenAI for the code itself (2026-09-22): no machine to
    // start first, so the code is on screen from the very first answer.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const opened: string[] = [];
    vi.stubGlobal('open', (url: string) => { opened.push(url); return null; });
    let approved = false;
    let started = false;
    const awaiting = { provider: 'codex', startedAt: new Date().toISOString(), state: { phase: 'awaiting_approval', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' } };
    renderAt('/seats/sign-in?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/signin': () => ({ signin: !started ? null : approved
        ? { ...awaiting, state: { phase: 'done', seatId: 's9', label: 'ChatGPT · new' } }
        : awaiting }),
      'POST api/org/signin': (call) => { expect(body(call)).toEqual({ provider: 'codex' }); started = true; return { signin: awaiting }; },
      'GET api/org/seats': () => ({ seats: [seat({ seatId: 's9', provider: 'codex', label: 'ChatGPT · new' })], available: [] }),
    });
    fireEvent.click(await screen.findByRole('button', { name: /Codex/ }));
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    expect(screen.queryByText('Starting your private computer')).toBeNull();
    // The same two numbered steps Claude's screen has (2026-09-22).
    expect([...document.querySelectorAll('#seatSignInBody .signinstep .stepk')].map((step) => step.textContent))
      .toEqual(['1Copy your code', '2Enter it and approve']);
    expect(document.getElementById('seatSignInWhere')!.textContent).toBe('You sign in on OpenAI’s own page, and your password never touches us. This screen notices on its own once you approve.');
    expect(document.getElementById('seatSignInWhere')!.closest('.signinstep')!.textContent).toContain('Open the ChatGPT sign-in');
    // It ends the way every onboarding screen before it ends: the commit as
    // the tinted pill on the right, the way out quiet on the left.
    expect([...document.querySelectorAll('#seatSignInBody .signinfoot button')].map((button) => `${button.className}:${button.textContent}`))
      .toEqual(['btn bare:Cancel', 'formcommit:Finish sign-in']);
    fireEvent.click(screen.getByRole('button', { name: 'Open the ChatGPT sign-in' }));
    expect(opened).toEqual(['https://auth.openai.com/codex/device']);
    approved = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(SEAT_SIGNIN_POLL_MS + 10); });
    expect(await screen.findByRole('heading', { name: 'Your subscriptions' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('ChatGPT · new')).toBeTruthy());
  });

  it('a sign-in the server no longer holds says so, instead of waiting for an approval forever', async () => {
    // A restart that could not carry the ceremony over answers "no sign-in
    // here". That is not a blip to poll through: the member is told, and
    // the same subscription is one tap away.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let signin: unknown = { provider: 'codex', startedAt: new Date().toISOString(), state: { phase: 'awaiting_approval', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' } };
    const posted: unknown[] = [];
    renderAt('/seats/sign-in?org=o1', {
      ...workspaceScript(() => orgState()),
      ...quiet,
      'GET api/org/signin': () => ({ signin }),
      'POST api/org/signin': (call) => { posted.push(body(call)); return { signin: { provider: 'codex', startedAt: 't2', state: { phase: 'awaiting_approval', url: 'https://auth.openai.com/codex/device', userCode: 'QRST-5678' } } }; },
    });
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    signin = null;
    await act(async () => { await vi.advanceTimersByTimeAsync(SEAT_SIGNIN_POLL_MS + 10); });
    expect(await screen.findByText('This sign-in was interrupted — start it again.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(() => expect(posted).toEqual([{ provider: 'codex' }]));
    expect(await screen.findByText('QRST-5678')).toBeTruthy();
  });
});

describe('a site', () => {
  it('shows what it is, who can reach it, who deployed it last, and deletes behind typing its name', async () => {
    const opened: string[] = [];
    vi.stubGlobal('open', (url: string) => { opened.push(url); return null; });
    let deleted = false;
    const { calls } = renderAt('/sites/shop?org=o1', {
      ...workspaceScript(() => orgState({ sites: deleted ? [] : [site({ lastDeployedBy: 'Ruby (Growth)', lastDeployAt: '2026-09-18T10:00:00Z' })] })),
      ...quiet,
      // The workplace's, and asked for with no room (it carried the one on
      // screen while there were rooms — note #843).
      'DELETE api/sites/shop': (call) => { expect(call.scope).toBeUndefined(); deleted = true; return { ok: true, name: 'shop' }; },
    });
    expect(await screen.findByRole('heading', { name: 'shop' })).toBeTruthy();
    expect(await screen.findByText('A site, live.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /shop\.agentbuilt\.app/ }));
    expect(opened).toEqual(['https://shop.agentbuilt.app']);
    // A site belongs to the workplace (note #566): no room line, no move
    // door — and no paragraph saying so either, since it is the rule for
    // every site rather than a fact about this one (note #575).
    expect(screen.queryByText('tap to move the site')).toBeNull();
    expect(document.getElementById('siteReachHint')).toBeNull();
    expect(document.querySelector('#screenSite .formhint')).toBeNull();
    // The title already says what it is and that it is serving, so the kind
    // row is not repeated under it (note #575).
    expect(document.getElementById('siteKind')).toBeNull();
    // Another agent put what is live there, so both hands are named and
    // neither row carries the other's time.
    expect(screen.getByText('Deployed it first')).toBeTruthy();
    // Anyone may redeploy, so the screen answers "who changed this?".
    expect(document.getElementById('siteLastDeploy')!.textContent).toContain('Ruby (Growth)');
    expect(document.getElementById('siteLastDeploy')!.textContent).toContain('Last deployed it');
    // Nothing under the button: what deleting costs is said in the gate it
    // opens, not twice (note #575).
    expect(document.querySelector('#siteDanger .hintblock')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete this site' }));
    expect(screen.getByText(/the slot it was using goes back to your plan/)).toBeTruthy();
    expect(screen.getByText(/The address stays yours/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Type shop to confirm'), { target: { value: 'shop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // Once gone, the reader is on the Sites list it stood in (note #960).
    await waitFor(() => expect(document.getElementById('screenSites')).toBeTruthy());
    expect(calls.some((call) => call.path === 'api/sites/shop' && call.init?.method === 'DELETE')).toBe(true);
  });

  it('names one hand once, and says what a site that is not live is', async () => {
    renderAt('/sites/shop?org=o1', {
      ...workspaceScript(() => orgState({ sites: [site({ lastDeployedBy: 'Ada (Math school)' })] })),
      ...quiet,
    });
    // The agent that put the site there is the one that last deployed it —
    // one row, not the same name twice (note #575).
    expect(await screen.findByText(/Deployed it · updated/)).toBeTruthy();
    expect(document.getElementById('siteLastDeploy')).toBeNull();
    expect(document.querySelectorAll('#siteCard .crow').length).toBe(2);
  });

  it('says what a site that is not serving is', async () => {
    renderAt('/sites/api?org=o1', {
      ...workspaceScript(() => orgState({ sites: [site({ name: 'api', kind: 'service', status: 'provisioning', url: undefined })] })),
      ...quiet,
    });
    // Nothing above it says "app" while it is not running, so the kind row
    // stays for exactly this case.
    expect((await screen.findByText('An always-on app')).textContent).toBeTruthy();
    expect(screen.getByText('Being built. It goes live on its own in a minute or two.')).toBeTruthy();
  });

  // 2026-09-23: the agent that last deployed it wears its face and its door,
  // whoever's it is — it used to be a clock and "A teammate’s agent".
  it('draws a teammate’s agent that last deployed it with its face, a door to its page', async () => {
    renderAt('/sites/shop?org=o1', {
      ...workspaceScript(() => orgState({
        sites: [site({
          lastDeployedBy: 'Leo (Growth)', lastDeployAt: '2026-09-18T10:00:00Z',
          lastDeployer: { agentName: 'Leo', agentAvatarUrl: '/avatars/leo', agentId: 'leo' },
        })],
      })),
      ...quiet,
    });
    // Not the heading: the screen titles itself with the address's name while
    // the state is still loading, so the heading can stand before the row.
    await waitFor(() => expect(document.getElementById('siteLastDeploy')).toBeTruthy());
    const row = document.getElementById('siteLastDeploy')!;
    expect(row.textContent).toContain('Leo (Growth)');
    expect(row.querySelector('.icon')).toBeNull();
    expect(within(row).getByRole('button', { name: 'Open Leo' })).toBeTruthy();
  });

  it('keeps both answers to a deletion request in one action row', async () => {
    renderAt('/sites/shop?org=o1', {
      ...workspaceScript(() => orgState({ sites: [site({ deleteAsk: { at: '2026-09-02T09:00:00Z', canDecide: true, byAgentName: 'Ada' } })] })),
      ...quiet,
    });
    await screen.findByText(/^Ada asked you to delete this site/);
    const actions = document.querySelector('#siteDanger .site-danger-actions') as HTMLElement;
    expect(actions).toBeTruthy();
    expect(within(actions).getByRole('button', { name: 'Delete this site' })).toBeTruthy();
    expect(within(actions).getByRole('button', { name: 'Keep it' })).toBeTruthy();
  });

  it('an agent’s deletion request shows Keep it, and a member sees only the request', async () => {
    renderAt('/sites/shop?org=o1', {
      ...workspaceScript(() => orgState({ org: { ...org, role: 'member' }, sites: [site({ deleteAsk: { at: '2026-09-02T09:00:00Z', canDecide: false, byAgentName: 'Ada', byOwnerName: 'Dana Ives' } })] })),
      ...quiet,
    });
    // Who asked, and whom it waits on (2026-09-23) — it named neither.
    expect((await screen.findByText(/^Ada asked Dana Ives to delete this site/)).textContent).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete this site' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep it' })).toBeNull();
  });
});

describe('a bucket (note #778)', () => {
  it('is a door on the Storage screen the Workplace sheet opens, with no delete on the list (the owner, 2026-10-19)', async () => {
    renderAt('/overview?org=o1&half=workplace', {
      ...workspaceScript(() => orgState({ buckets: [bucket()] })),
      ...quiet,
    });
    await waitFor(() => expect(document.getElementById('indexStorage')).toBeTruthy());
    expect(document.getElementById('indexStorage')!.textContent).toBe('Storage1 bucket · 1 public');
    fireEvent.click(document.getElementById('indexStorage')!);
    await waitFor(() => expect(document.querySelector('#screenStorage #storageCard [data-bucket="bishkek-3d-tiles"]')).toBeTruthy());
    const row = document.querySelector('#storageCard [data-bucket="bishkek-3d-tiles"]') as HTMLElement;
    expect(document.getElementById('storageCard')!.textContent).not.toContain('Delete this bucket');
    expect(document.querySelector('#storageCard .btn')).toBeNull();
    fireEvent.click(row);
    expect(await screen.findByRole('heading', { name: 'bishkek-3d-tiles' })).toBeTruthy();
    expect(document.getElementById('screenBucket')).toBeTruthy();
  });

  it('says what it is to someone who did not make it, and deletes at its foot behind typing its name', async () => {
    let deleted = false;
    const { calls } = renderAt('/storage/bishkek-3d-tiles?org=o1', {
      ...workspaceScript(() => orgState({ buckets: deleted ? [] : [bucket()] })),
      ...quiet,
      'GET api/storage/bishkek-3d-tiles/usage': () => ({ usage: { bytes: 327_680_000, objects: 1204, truncated: false } }),
      // Asked for with no room (note #843).
      'DELETE api/storage/bishkek-3d-tiles': (call) => { expect(call.scope).toBeUndefined(); deleted = true; return { ok: true, name: 'bishkek-3d-tiles' }; },
    });
    // Not the heading: the screen titles itself with the address's name
    // while the state is still loading.
    await waitFor(() => expect(document.getElementById('bucketSub')).toBeTruthy());
    expect(document.getElementById('bucketSub')!.textContent).toMatch(/^Public: anyone with a file’s address can read it/);
    expect(document.querySelector('#bucketAddress .name')!.textContent).toBe('iabkt-547027dcc674.fly.storage.tigris.dev/…');
    expect(document.getElementById('bucketMaker')!.textContent).toContain('Created it');
    await waitFor(() => expect(document.querySelector('#bucketHolds .name')!.textContent).toBe('1,204 files · 312.5 MB'));
    // The keys are the workplace's: no room they were saved from (note #843).
    expect(document.querySelector('#bucketKeys .name')!.textContent).toBe('Its keys: 4 secrets');
    expect([...document.querySelectorAll('#bucketKeys code')].map((node) => node.textContent)).toEqual(bucket().secretNames);
    // The delete is the page's last thing, after the card.
    const danger = document.getElementById('bucketDanger')!;
    expect(document.getElementById('bucketCard')!.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(danger).getByRole('button', { name: 'Delete this bucket' }));
    expect(screen.getByText(/Every file in it is deleted, and the four secrets holding its keys are removed from the workplace/)).toBeTruthy();
    expect(screen.getByText(/Anything on the web that pointed at it stops working/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Type bishkek-3d-tiles to confirm'), { target: { value: 'bishkek-3d-tiles' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'api/storage/bishkek-3d-tiles' && call.init?.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(document.getElementById('screenBucket')).toBeNull());
  });

  it('a private one says what private means and has no address; a count it cannot read says so', async () => {
    renderAt('/storage/demo-files?org=o1', {
      ...workspaceScript(() => orgState({ buckets: [bucket({ name: 'demo-files', public: false, publicUrl: undefined })] })),
      ...quiet,
      'GET api/storage/demo-files/usage': () => ({}),
    });
    expect(await screen.findByText(/^Private: only agents and apps holding its keys/)).toBeTruthy();
    expect(document.getElementById('bucketAddress')).toBeNull();
    await waitFor(() => expect(document.querySelector('#bucketHolds .name')!.textContent).toBe('Could not be read just now'));
  });

  it('an agent’s request to delete it shows on the row and on the page, where Keep it answers it', async () => {
    const { calls } = renderAt('/storage/bishkek-3d-tiles?org=o1', {
      ...workspaceScript(() => orgState({ buckets: [bucket({ deleteAsk: { at: '2026-09-02T09:00:00Z', canDecide: true, byAgentName: 'Caleb' } })] })),
      ...quiet,
      'GET api/storage/bishkek-3d-tiles/usage': () => ({ usage: { bytes: 0, objects: 0, truncated: false } }),
      'POST api/storage/bishkek-3d-tiles/keep': () => ({ ok: true, name: 'bishkek-3d-tiles' }),
    });
    await screen.findByText(/^Caleb asked you to delete this bucket/);
    const actions = document.querySelector('#bucketDanger .site-danger-actions') as HTMLElement;
    expect(within(actions).getByRole('button', { name: 'Delete this bucket' })).toBeTruthy();
    fireEvent.click(within(actions).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'api/storage/bishkek-3d-tiles/keep')).toBe(true));
  });

  it('a member sees the page and the request, and no delete', async () => {
    renderAt('/storage/bishkek-3d-tiles?org=o1', {
      ...workspaceScript(() => orgState({ org: { ...org, role: 'member' }, buckets: [bucket({ deleteAsk: { at: '2026-09-02T09:00:00Z', canDecide: false, byAgentName: 'Caleb', byOwnerName: 'Dana Ives' } })] })),
      ...quiet,
      'GET api/storage/bishkek-3d-tiles/usage': () => ({}),
    });
    expect(await screen.findByText(/^Caleb asked Dana Ives to delete this bucket/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete this bucket' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep it' })).toBeNull();
  });
});

describe('settings', () => {
  it('shows the name as a settled fact, opens the editor on request, saves, and manages the picture', async () => {
    const { calls } = renderAt('/profile', {
      ...workspaceScript(() => orgState({ user: { name: 'Saddam Baialiev', profile: { firstName: 'Saddam', lastName: 'Baialiev', incomplete: false }, account: { browserLogin: { enabled: true, method: 'totp', username: 'saddam' } } } })),
      ...quiet,
      'POST api/profile': (call) => { expect(body(call)).toEqual({ firstName: 'Saddam', lastName: 'B' }); return { ok: true, name: 'Saddam B' }; },
    });
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    // A settled name is a fact, not a form.
    expect(await screen.findByText('Saddam Baialiev', { selector: '.meta' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /First name/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /First name/ }), { target: { value: 'Saddam' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Last name/ }), { target: { value: 'B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'api/profile')).toBe(true));
    expect(screen.getByRole('button', { name: 'Choose a picture' })).toBeTruthy();
    expect(screen.getByText('@saddam')).toBeTruthy();
    expect(screen.queryByText('Browser notifications')).toBeNull();
    expect(calls.some((call) => call.path === 'api/notifications/push')).toBe(false);
  });

  it('keeps an unset name settled until the reader chooses Add', async () => {
    renderAt('/profile', {
      ...workspaceScript(() => orgState({ user: { name: '', profile: { firstName: '', lastName: '', incomplete: true }, account: { browserLogin: { enabled: true, method: 'totp', username: 'saddam' } } } })),
      ...quiet,
    });
    const notSet = await screen.findByText('Not set yet');
    const card = notSet.closest('#profileNameCard') as HTMLElement;
    expect(card).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /First name/ })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: /Add/ }));
    expect(await screen.findByRole('textbox', { name: /First name/ })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /Last name/ })).toBeTruthy();
    expect(screen.getByText('Add your name and picture')).toBeTruthy();
  });

  /**
   * Who a letter wakes (note #509, slice 11). The choice is an OPT-IN, and
   * the card has to make that unmistakable: mail is the one thing here a
   * stranger writes, and the default has to read as the default.
   */
  const withAddress = () => orgState({
    user: {
      name: 'Saddam',
      profile: { firstName: 'Saddam', lastName: '', incomplete: false },
      account: {
        browserLogin: { enabled: true, method: 'totp', username: 'saddam' },
        mailbox: { address: 'saddam@agenticcloudcomputer.com' },
      },
    },
  });

  it('starts at nobody, and lets the owner choose one agent to be woken by mail', async () => {
    let chosen: { id: string; name: string; room?: string } | null = null;
    // The answer may still say which room each agent stood in; the rows said
    // it too until rooms left the product (note #843).
    const agents = [
      { id: 'ruby', name: 'Ruby', cli: 'claude', room: 'Platform' },
      { id: 'gus', name: 'Gus', cli: 'codex', room: 'Math school' },
    ];
    const { calls } = renderAt('/profile', {
      ...workspaceScript(withAddress),
      ...quiet,
      'GET api/mail/wake': () => ({ agent: chosen, agents }),
      'PUT api/mail/wake': (call) => {
        const asked = body(call).agentId as string | null;
        chosen = asked ? agents.find((one) => one.id === asked)! : null;
        return { agent: chosen, agents };
      },
    });
    // The default says what it is, in the words somebody deciding needs.
    expect(await screen.findByText('Nobody')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /When mail arrives, wake.*Change/ }));

    // The question stays on screen while it is being answered.
    expect(await screen.findByRole('button', { name: /When mail arrives, wake.*Cancel/ })).toBeTruthy();
    // Nobody first, because that is where the address stands.
    const picks = await screen.findAllByRole('button', { name: /Nobody|Ruby|Gus/ });
    expect(picks.map((one) => one.querySelector('.name')!.textContent)).toEqual(['Nobody', 'Ruby', 'Gus']);
    expect(picks[1]!.textContent).toContain('claude');
    expect(picks[1]!.textContent).not.toContain('Platform');

    fireEvent.click(screen.getByRole('button', { name: /Ruby/ }));
    await waitFor(() => expect(calls.some((call) => call.path === 'api/mail/wake' && call.init?.method === 'PUT')).toBe(true));
    expect(body(calls.find((call) => call.init?.method === 'PUT')!)).toEqual({ agentId: 'ruby' });
    // The row closes on the answer and says what it now does — including the
    // part somebody would otherwise have to guess: their chat stays quiet.
    await waitFor(() => expect(document.querySelector('.mailwakerow')!.textContent).toContain('Ruby'));
    expect(document.querySelector('.mailwakerow')!.textContent).not.toContain('Platform');
    expect(screen.queryByRole('button', { name: /Gus/ })).toBeNull();
  });

  it('says so when the agent that was chosen is no longer there', async () => {
    renderAt('/profile', {
      ...workspaceScript(withAddress),
      ...quiet,
      'GET api/mail/wake': () => ({ agent: null, agents: [{ id: 'gus', name: 'Gus' }], lapsed: true }),
    });
    // The wake itself falls back to nobody in silence; this is the only place
    // a person can be told that it did.
    expect(await screen.findByText('Your agent is gone — pick another')).toBeTruthy();
  });

  it('offers nothing to choose from when this person has no agents at all', async () => {
    renderAt('/profile', {
      ...workspaceScript(withAddress),
      ...quiet,
      'GET api/mail/wake': () => ({ agent: null, agents: [] }),
    });
    expect(await screen.findByText('Nobody')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /When mail arrives, wake/ })).toBeNull();
  });

  it('lists browser sessions, revokes one, and signs out everywhere', async () => {
    let sessions = [
      { sessionId: 'here', userId: 'u1', authMethod: 'totp', createdAt: 't', lastSeenAt: new Date().toISOString(), idleExpiresAt: 't', absoluteExpiresAt: 't', userAgent: 'Chrome', current: true },
      { sessionId: 'phone', userId: 'u1', authMethod: 'totp', createdAt: 't', lastSeenAt: new Date().toISOString(), idleExpiresAt: 't', absoluteExpiresAt: 't', userAgent: 'Safari', current: false },
    ];
    let signedIn = true;
    const { calls } = renderAt('/profile', {
      ...workspaceScript(() => orgState({
        user: {
          name: 'Saddam',
          profile: { firstName: 'Saddam', lastName: '', incomplete: true },
          account: { browserLogin: { enabled: true, method: 'email', email: 'saddam@example.com', secondFactorEnabled: false, verificationStatus: 'verified' } },
        },
      })),
      ...quiet,
      'GET auth/session': () => (signedIn ? { authenticated: true, username: 'saddam', displayName: 'Saddam', session: { sessionId: 'here', createdAt: 't', lastSeenAt: 't', absoluteExpiresAt: 't' } } : (() => { throw new WorkspaceApiError('authentication required', 401, {}); })()),
      'GET auth/sessions': () => ({ sessions }),
      'DELETE auth/sessions/phone': () => { sessions = sessions.filter((s) => s.sessionId !== 'phone'); return { revoked: true }; },
      'POST auth/logout-all': () => { signedIn = false; return { revoked: 1 }; },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Sessions$/ }));
    expect(await screen.findByText(/Safari · active/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Revoke$/ }));
    await waitFor(() => expect(screen.queryByText(/Safari · active/)).toBeNull());
    expect(calls.some((call) => call.path === 'auth/sessions/phone')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out every browser' }));
    await answerAsk('Sign out');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });

  it('lets an email account opt into authenticator security and receive recovery codes', async () => {
    let factorEnabled = false;
    const { calls } = renderAt('/profile', {
      ...workspaceScript(() => orgState({
        user: {
          name: 'Saddam',
          profile: { firstName: 'Saddam', lastName: '', incomplete: true },
          account: { browserLogin: { enabled: true, method: 'email', email: 'saddam@example.com', secondFactorEnabled: factorEnabled, verificationStatus: 'verified' } },
        },
      })),
      ...quiet,
      'POST auth/totp/start': () => ({
        enrollmentToken: 'totp-1', username: 'saddam@example.com', secret: 'JBSWY3DPEHPK3PXP',
        otpauthUrl: 'otpauth://totp/x', expiresAt: 't', qrDataUrl: 'data:image/png;base64,AAAA',
        otp: { digits: 6, periodSeconds: 30, kind: 'totp' },
      }),
      'POST auth/totp/finish': (call) => {
        expect(body(call)).toEqual({ enrollmentToken: 'totp-1', code: '654321' });
        factorEnabled = true;
        return { authenticated: true, username: 'saddam@example.com', recoveryCodes: ['AAAA-1111'], linkedExistingUser: true };
      },
      'POST auth/totp/disable': (call) => {
        expect(body(call)).toEqual({ code: '765432' });
        factorEnabled = false;
        return { disabled: true };
      },
      'POST auth/email/password': (call) => {
        expect(body(call)).toEqual({ currentPassword: 'old password', newPassword: 'new secure password' });
        return { changed: true };
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Password.*Change/ }));
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old password' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new secure password' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new secure password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'auth/email/password')).toBe(true));
    fireEvent.click(await screen.findByRole('button', { name: /Authenticator security/ }));
    expect(await screen.findByRole('heading', { name: 'Add authenticator security' })).toBeTruthy();
    expect(screen.getByAltText('Authenticator setup QR code')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Current code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable extra security' }));
    expect(await screen.findByText('AAAA-1111')).toBeTruthy();
    expect(calls.some((call) => call.path === 'auth/totp/finish')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'I saved them' }));
    fireEvent.click(await screen.findByRole('button', { name: /Authenticator security.*Disable/ }));
    fireEvent.change(screen.getByLabelText('Current code'), { target: { value: '765432' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off extra security' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'auth/totp/disable')).toBe(true));
  });

  it('lets a legacy authenticator account attach its primary email', async () => {
    let linked = false;
    const { calls } = renderAt('/profile', {
      ...workspaceScript(() => orgState({
        user: {
          name: 'Saddam',
          profile: { firstName: 'Saddam', lastName: '', incomplete: true },
          account: { browserLogin: linked
            ? { enabled: true, method: 'email', email: 'saddam@example.com', secondFactorEnabled: true, verificationStatus: 'pending' as const }
            : { enabled: true, method: 'totp', username: 'saddam' } },
        },
      })),
      ...quiet,
      'POST auth/email/link': (call) => {
        expect(body(call)).toEqual({ email: 'saddam@example.com', password: 'correct horse battery staple' });
        linked = true;
        return { authenticated: true, email: 'saddam@example.com', verificationRequired: true };
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Add email/ }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'saddam@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery staple' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'correct horse battery staple' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add email sign-in' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'auth/email/link')).toBe(true));
    expect(await screen.findByText('On')).toBeTruthy();
  });
});

describe('the old word in an address (note #432)', () => {
  it('opens a copied organization link on the same workplace, at its current address', async () => {
    const scripted = scriptedApi({
      ...workspaceScript(() => orgState()), ...quiet,
      'GET api/org': () => ({ org: orgDetail() }),
    });
    const Where = () => { const here = useLocation(); return <div data-testid="where">{here.pathname}{here.search}</div>; };
    render(
      <MemoryRouter initialEntries={['/organization?org=o1']}>
        <App api={scripted.api} />
        <Routes><Route path="*" element={<Where />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Nomad Trading' })).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/workplace?org=o1');
  });

  it('sends the old picker address to the workplaces picker', async () => {
    const scripted = scriptedApi({ ...workspaceScript(() => orgState()), ...quiet });
    const Where = () => { const here = useLocation(); return <div data-testid="where">{here.pathname}</div>; };
    render(
      <MemoryRouter initialEntries={['/organizations']}>
        <App api={scripted.api} />
        <Routes><Route path="*" element={<Where />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Switch workplace' })).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/workplaces');
  });
});
