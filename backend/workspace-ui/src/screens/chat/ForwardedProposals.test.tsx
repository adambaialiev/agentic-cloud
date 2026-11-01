import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceKnowledgeProposalRow, WorkspaceProposalRow } from '../../../../src/shared/workspace-api.js';
import type { RecapChatAnswer, WorkspaceForwardedProposal } from '../../../../src/shared/workspace-recap-chat.js';
import { App } from '../../App.js';
import { agent, emptyState, scriptedApi, workspaceScript } from '../../test/fixtures.js';
import { forwardedDoor, forwardedState } from './forwarded-words.js';

/**
 * Note #724: the proposals the Chief of Staff forwarded, drawn in its
 * conversation as the decision queue's own rows — and redrawn when a later
 * read says the proposal moved, though the row's words never did.
 */

const state = emptyState({
  org: { orgId: 'o1', name: 'Studio', role: 'admin', members: 1, seats: 0, seatProviders: [] },
  agents: [agent({ id: 'oscar', name: 'Oscar', avatarUrl: 'https://faces.test/oscar.png' })],
});
const now = new Date().toISOString();
const pr = (over: Partial<WorkspaceProposalRow> = {}): WorkspaceProposalRow => ({
  id: 'pr1', number: 1325, repoName: 'infinite-agents', title: 'Loading screen is the chat', body: null,
  from: 'note-718', to: 'main', status: 'open', createdAt: now, decidedAt: null,
  agentName: 'Oscar', agentId: 'oscar', agentAvatarUrl: 'https://faces.test/oscar.png', canDecide: true,
  diffStat: { insertions: 758, deletions: 151 }, ...over,
});
const kp = (over: Partial<WorkspaceKnowledgeProposalRow> = {}): WorkspaceKnowledgeProposalRow => ({
  id: 'kp1', number: 353, title: 'Models and effort', status: 'open', pages: ['models-and-effort'], createdAt: now,
  agentName: 'Oscar', agentId: 'oscar', canDecide: true, ...over,
});
const conversation = (forwarded: WorkspaceForwardedProposal[]): RecapChatAnswer => ({
  orgId: 'o1', working: false, waiting: [],
  messages: [
    { id: 'm1', role: 'owner', text: 'Anything waiting on me?', at: now },
    { id: 'm2', role: 'action', text: 'Forwarded PR #1325 in infinite-agents (Platform) — Loading screen is the chat', at: now, proposals: forwarded.map(({ kind, id }) => ({ kind, id })), forwarded },
    { id: 'm3', role: 'assistant', text: 'Oscar finished the loading screen.', at: now },
  ],
});

function Address() {
  const location = useLocation();
  return <div data-testid="address">{location.pathname}</div>;
}
afterEach(() => { document.body.classList.remove('agent-chat-open'); });
function mount(answer: () => RecapChatAnswer) {
  const scripted = scriptedApi({
    ...workspaceScript(() => state),
    'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: { cli: 'claude', model: 'opus', effort: 'high' }, models: [] }),
    'GET api/recap/settings': () => ({ orgId: 'o1', settings: { cli: 'claude', model: 'opus', effort: 'high' }, models: [] }),
    'GET api/recap/chat': () => answer(),
  });
  render(<MemoryRouter initialEntries={['/']}><Address /><App api={scripted.api} /></MemoryRouter>);
}

describe('forwarded proposals in the Chief of Staff\'s conversation (note #724)', () => {
  // The label named the proposal's room after the kind until rooms left the
  // product (note #843); a row an older server still sends with a room name
  // draws the kind alone.
  it('draws one card per proposal: its kind, state, the queue\'s row, and the door to decide', async () => {
    mount(() => conversation([
      { kind: 'pr', id: 'pr1', pr: pr() },
      { kind: 'knowledge', id: 'kp1', knowledge: kp() },
    ]));
    await waitFor(() => expect(document.querySelectorAll('#recapChatLog .chatmsg.forwarded')).toHaveLength(2));
    const cards = [...document.querySelectorAll('#recapChatLog .chatmsg.forwarded')];
    expect(cards.map((card) => card.querySelector('.chatnoticelabel')?.textContent)).toEqual(['Change proposal', 'Knowledge proposal']);
    expect(cards.map((card) => card.querySelector('.chatnoticestatus')?.textContent)).toEqual(['Awaiting approval', 'Awaiting approval']);
    expect(cards[0]!.querySelector('.crow .name')?.textContent).toBe('Loading screen is the chat');
    expect(cards[0]!.textContent).toContain('#1325');
    // The stored words stand in for old clients; under the cards they would say it twice.
    expect(document.getElementById('recapChatLog')!.textContent).not.toContain('Forwarded PR #1325');
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Review and decide' })[0]!));
    await waitFor(() => expect(screen.getByTestId('address').textContent).toContain('pr1'));
  });

  it('redraws a card when a later read says the proposal moved, though the row\'s words did not', async () => {
    let merged = false;
    mount(() => conversation([{ kind: 'pr', id: 'pr1', pr: pr(merged ? { status: 'merged', decidedAt: now } : {}) }]));
    await waitFor(() => expect(document.querySelector('#recapChatLog .chatmsg.forwarded .chatnoticestatus')?.textContent).toBe('Awaiting approval'));
    merged = true;
    await waitFor(() => expect(document.querySelector('#recapChatLog .chatmsg.forwarded .chatnoticestatus')?.textContent).toBe('Merged'), { timeout: 8000 });
    expect(document.querySelector('#recapChatLog .forwardeddoor')?.textContent).toBe('See what changed');
  }, 12_000);

  it('says whose move it is, and what is left of a proposal that is gone', () => {
    const open = { kind: 'pr' as const, id: 'pr1', pr: pr() };
    expect([forwardedState(open), forwardedDoor(open)]).toEqual([{ label: 'Awaiting approval', tone: 'act' }, 'Review and decide']);
    const teammates = { kind: 'pr' as const, id: 'pr1', pr: pr({ canDecide: false }) };
    expect([forwardedState(teammates), forwardedDoor(teammates)]).toEqual([{ label: 'Awaiting a teammate', tone: 'mut' }, 'See the proposal']);
    const rejected = { kind: 'knowledge' as const, id: 'kp1', knowledge: kp({ status: 'rejected' }) };
    expect([forwardedState(rejected), forwardedDoor(rejected)]).toEqual([{ label: 'Rejected', tone: 'mut' }, 'See the proposal']);
    const approved = { kind: 'knowledge' as const, id: 'kp1', knowledge: kp({ status: 'approved' }) };
    expect(forwardedState(approved)).toEqual({ label: 'Approved', tone: 'ok' });
    // Merged by auto-approve mode (note #944): never the reader's "Merged".
    const automatic = { kind: 'pr' as const, id: 'pr1', pr: pr({ status: 'merged', autoApproved: { at: 't', modeOnAt: 't', modeOnByName: 'Adam' } }) };
    expect([forwardedState(automatic), forwardedDoor(automatic)]).toEqual([{ label: 'Merged automatically', tone: 'ok' }, 'See what changed']);
    const gone = { kind: 'pr' as const, id: 'pr9' };
    expect([forwardedState(gone), forwardedDoor(gone)]).toEqual([{ label: 'No longer there', tone: 'mut' }, null]);
  });
});
