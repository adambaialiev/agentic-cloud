/**
 * The teammates' agents strip at the foot of the agents picker (2026-09-23,
 * the owner: "those agents should not be hidden from other humans … even
 * there, we should make some compact UI showing avatars of other humans'
 * agents existing and working in the room"). It stood on a room's Agents tab
 * and showed that room's, until rooms left the product (note #843): it is
 * every teammate's agent now.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceAgentsLiveAnswer, WorkspaceKnowledgeProposalRow, WorkspaceProposalRow, WorkspaceStateAnswer, WorkspaceTeamAgentRow } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { agent, emptyState, homeShelf, pickerPage, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { forgetPreviews } from '../../ui/preview-urls.js';
import { LIVE_POLL_MS } from '../../workspace/WorkspaceProvider.js';
import { groupProposalCount, teamAgentLabel, teamGroups, teamProposals } from './team-words.js';

function Address() {
  const location = useLocation();
  return <div data-testid="address">{location.pathname}</div>;
}

const home = (state: WorkspaceStateAnswer, extra: Record<string, Answer> = {}) => {
  const scripted = scriptedApi({ ...workspaceScript(() => state), ...extra });
  render(<MemoryRouter initialEntries={['/']}><Address /><App api={scripted.api} /></MemoryRouter>);
  return scripted;
};

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };
const dana = { userId: 'dana', name: 'Dana Ives', photoUrl: '/people/dana.png' };
const ben = { userId: 'ben', name: 'Ben Ortiz' };
const team = (over: Partial<WorkspaceTeamAgentRow> & Pick<WorkspaceTeamAgentRow, 'id' | 'name'>): WorkspaceTeamAgentRow => ({
  status: 'ready', owner: dana, ...over,
});
/** The strip, by the name it gives itself ("…in this room" until note #843). */
const findStrip = () => screen.findByRole('region', { name: 'Teammates’ agents' });

afterEach(() => { vi.useRealTimers(); forgetPreviews(); });

const pr = (over: Partial<WorkspaceProposalRow> & Pick<WorkspaceProposalRow, 'id' | 'title' | 'canDecide'>): WorkspaceProposalRow => ({
  number: 4, repoName: 'shop', body: null, from: 'checkout', to: 'main', status: 'open', createdAt: 't', decidedAt: null,
  agentName: 'Leo', agentAvatarUrl: '/avatars/leo', agentId: 'leo', ...over,
});
const kp = (over: Partial<WorkspaceKnowledgeProposalRow> & Pick<WorkspaceKnowledgeProposalRow, 'id' | 'title' | 'canDecide'>): WorkspaceKnowledgeProposalRow => ({
  number: 9, status: 'open', pages: ['deploy-runbook'], createdAt: 't', agentName: 'Otis', agentAvatarUrl: '/avatars/otis', agentId: 'otis', ...over,
});

describe('teamGroups', () => {
  it('groups by the person who drives them, the ones mid-turn and their people first, else the server’s order', () => {
    const groups = teamGroups([
      team({ id: 'nora', name: 'Nora' }),
      team({ id: 'otis', name: 'Otis', owner: ben, working: true }),
      team({ id: 'leo', name: 'Leo', working: true }),
      team({ id: 'mia', name: 'Mia', owner: ben }),
    ]);
    expect(groups.map((group) => [group.owner.name, group.agents.map((row) => row.id)])).toEqual([
      ['Ben Ortiz', ['otis', 'mia']],
      ['Dana Ives', ['leo', 'nora']],
    ]);
  });

  it('puts each proposal with the person whose agent made it, and a stray one after everybody (note #652)', () => {
    const groups = teamGroups(
      [team({ id: 'leo', name: 'Leo' }), team({ id: 'otis', name: 'Otis', owner: ben })],
      teamProposals(
        [
          pr({ id: 'leo-pr', title: 'Leo’s', canDecide: false }),
          pr({ id: 'gone-pr', title: 'Gone', canDecide: false, agentId: 'gone', userName: 'Cleo Park' }),
          pr({ id: 'nameless', title: 'Nameless', canDecide: false, agentId: undefined, userName: undefined }),
        ],
        [kp({ id: 'otis-kp', title: 'Otis’s', canDecide: false })],
      ),
    );
    expect(groups.map((group) => [group.owner.name, group.agents.map((row) => row.id),
      [...group.proposals.knowledge, ...group.proposals.changes].map((row) => row.id)])).toEqual([
      ['Dana Ives', ['leo'], ['leo-pr']],
      ['Ben Ortiz', ['otis'], ['otis-kp']],
      ['Cleo Park', [], ['gone-pr']],
      [undefined, [], ['nameless']],
    ]);
    expect(groups.map(groupProposalCount)).toEqual([1, 1, 1, 1]);
  });

  it('says whose agent a face is, and whether it is at work', () => {
    expect(teamAgentLabel(team({ id: 'leo', name: 'Leo', working: true }))).toBe('Leo, Dana Ives’s agent, working now');
    expect(teamAgentLabel(team({ id: 'otis', name: 'Otis', status: 'setting-up', owner: { userId: 'x' } })))
      .toBe('Otis, a teammate’s agent, being set up');
  });
});

describe('teamProposals', () => {
  it('keeps the proposals the reader cannot decide, knowledge before changes, and names the count', () => {
    const picked = teamProposals(
      [pr({ id: 'mine', title: 'Mine', canDecide: true }), pr({ id: 'theirs', title: 'Theirs', canDecide: false })],
      [kp({ id: 'kmine', title: 'My page', canDecide: true }), kp({ id: 'ktheirs', title: 'Their page', canDecide: false })],
    );
    expect(picked.changes.map((row) => row.id)).toEqual(['theirs']);
    expect(picked.knowledge.map((row) => row.id)).toEqual(['ktheirs']);
    expect(teamProposals(undefined, undefined)).toEqual({ knowledge: [], changes: [] });
  });
});

describe('the strip at the foot of the agents picker', () => {
  it('puts the proposals their agents have made ready under each person, each a door, and keeps the reader’s own in the queue (note #652)', async () => {
    const mine = pr({ id: 'pr-mine', number: 3, title: 'Add checkout', canDecide: true, agentName: 'Felix', agentId: 'felix', agentAvatarUrl: '/avatars/felix' });
    home(emptyState({
      org,
      agents: [agent({ id: 'felix', name: 'Felix' })],
      teamAgents: [team({ id: 'leo', name: 'Leo', avatarUrl: '/avatars/leo', working: true }), team({ id: 'otis', name: 'Otis', owner: ben })],
      prs: [
        mine,
        pr({ id: 'pr-leo', number: 4, title: 'Fix the cart', canDecide: false, checks: { total: 1, failing: 0, pending: 0, worst: 'success' }, diffStat: { insertions: 12, deletions: 3 } }),
      ],
      knowledgeProposals: [kp({ id: 'kp-otis', title: 'Deploy runbook', canDecide: false })],
    }), {
      // The picker's own queue: what waits on this reader.
      'GET api/decisions': () => ({ prs: [mine], knowledgeProposals: [] }),
    });
    await homeShelf();
    const strip = await findStrip();
    expect(strip.querySelector('.teamcount')!.textContent).toBe('2 agents · 1 working · 2 proposals');
    expect(strip.querySelector('.teamcount')!.getAttribute('aria-label')).toBe('2 agents, 1 working now, 2 proposals awaiting their owners');
    const groups = [...strip.querySelectorAll('.teamgroup')];
    expect(groups.map((group) => group.querySelector('.ownername')!.textContent)).toEqual(['Dana Ives', 'Ben Ortiz']);
    expect(groups.map((group) => [...group.querySelectorAll('.teamproposals .crow .name')].map((node) => node.textContent)))
      .toEqual([['Fix the cart'], ['Deploy runbook']]);
    expect(groups[0]!.querySelector('.teamproposals')!.getAttribute('aria-label')).toBe('Dana Ives’s proposal, awaiting them');
    // The queue's own row: face, branch, repository, pip, size — and the live disc on the agent mid-turn.
    const cart = groups[0]!.querySelector('.crow')!;
    expect(cart.querySelector('.num')!.textContent).toBe('#4');
    expect(cart.querySelector('.face')!.getAttribute('src')).toBe('/avatars/leo');
    expect(cart.querySelector('.facedot')).toBeTruthy();
    expect(cart.querySelector('.bname')!.textContent).toBe('checkout');
    expect(cart.querySelector('.pip')!.className).toBe('pip ok');
    expect(cart.querySelector('.stat')!.textContent).toBe('+12−3');
    // The person's line still stands above their proposals.
    const line = groups[0]!.querySelector('.teamline')!;
    expect(line.compareDocumentPosition(cart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The reader's own proposal stays in the picker's queue and out of the strip.
    await waitFor(() => expect([...document.querySelectorAll('#agentSwitchDecisions .crow .name')].map((node) => node.textContent)).toEqual(['Add checkout']));
    // It opens inside the picker, over its list (note #722).
    fireEvent.click(cart);
    await waitFor(() => expect(pickerPage()).toBe('/decisions/pr/pr-leo'));
    expect(screen.getByTestId('address').textContent).toBe('/');
  });

  // "Left the room" was one way to be gone while there were rooms (note #843).
  it('stands for a proposal whose agent is gone, and says nothing of agents when there are none', async () => {
    home(emptyState({
      org,
      agents: [agent({ id: 'felix', name: 'Felix' })],
      prs: [pr({ id: 'pr-gone', title: 'Left behind', canDecide: false, agentId: undefined, userName: 'Cleo Park' })],
    }));
    await homeShelf();
    const strip = await findStrip();
    expect(strip.querySelector('.teamcount')!.textContent).toBe('1 proposal');
    expect([...strip.querySelectorAll('.ownername')].map((node) => node.textContent)).toEqual(['Cleo Park']);
    expect(strip.querySelectorAll('.teamface')).toHaveLength(0);
    expect([...strip.querySelectorAll('.teamproposals .crow .name')].map((node) => node.textContent)).toEqual(['Left behind']);
  });

  it('is not there when nobody else has an agent', async () => {
    home(emptyState({
      org,
      agents: [agent({ id: 'felix', name: 'Felix' })],
      teamAgents: [],
    }));
    await homeShelf();
    await screen.findByText('Felix');
    expect(document.getElementById('teamAgents')).toBeNull();
  });

  // It showed only the agents of the room on screen, and a teammate's agent
  // in another room not at all, until rooms left the product (note #843).
  it('shows every teammate’s agent, whatever room an older record names', async () => {
    home(emptyState({
      org,
      agents: [agent({ id: 'felix', name: 'Felix' })],
      teamAgents: [team({ id: 'mia', name: 'Mia' }), team({ id: 'leo', name: 'Leo' })],
    }));
    await homeShelf();
    const strip = await findStrip();
    expect(strip.querySelector('.teamcount')!.textContent).toBe('2 agents');
    expect(strip.querySelector('[data-team-agent="mia"]')).toBeTruthy();
    expect(strip.querySelector('[data-team-agent="leo"]')).toBeTruthy();
  });

  it('moves the live disc on the tick, with no state read behind it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let live: WorkspaceAgentsLiveAnswer = { agents: [], recaps: [], sessionLimits: [], teamWorking: ['leo'] };
    const { calls } = home(emptyState({
      org,
      teamAgents: [team({ id: 'leo', name: 'Leo', working: true }), team({ id: 'otis', name: 'Otis', owner: ben })],
    }), { 'GET api/agents/live': () => live });
    await homeShelf();
    await findStrip();
    const stateReads = () => calls.filter((call) => call.path === 'api/state').length;
    expect(stateReads()).toBe(1);
    live = { ...live, teamWorking: ['otis'] };
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    await waitFor(() => expect(document.querySelector('[data-team-agent="otis"] .livedot')).toBeTruthy());
    expect(document.querySelector('[data-team-agent="leo"] .livedot')).toBeNull();
    expect(document.querySelector('#teamAgents .teamcount')!.textContent).toBe('2 agents · 1 working');
    expect([...document.querySelectorAll('#teamAgents .ownername')].map((node) => node.textContent))
      .toEqual(['Ben Ortiz', 'Dana Ives']);
    expect(stateReads()).toBe(1);
    // An older backend's silence leaves every face as it was drawn.
    live = { agents: [], recaps: [], sessionLimits: [] };
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    expect(document.querySelector('[data-team-agent="otis"] .livedot')).toBeTruthy();
  });
});
