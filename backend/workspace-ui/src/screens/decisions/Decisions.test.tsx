import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceKnowledgeProposalDetailAnswer,
  WorkspaceProposalDetailAnswer,
  WorkspaceStateAnswer,
} from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { WorkspaceApiError, type WorkspaceApi } from '../../api/client.js';
import { agent, emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { WAIT_HOLD_MS, WAIT_QUIET_MS } from '../../ui/wait.js';
import { forgetProposalPreviewUrls } from './proposal-previews.js';

/**
 * The two Decisions screens, end to end against a scripted API — the same
 * things the legacy page's grab()-based tests hold `openPr` and
 * `openKnowledgeProposal` to (telegram-miniapp-page and -knowledge tests),
 * driven the way a person drives them.
 */

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };

function renderAt(path: string, api: WorkspaceApi) {
  return render(
    <MemoryRouter initialEntries={['/', path]} initialIndex={1}>
      <App api={api} />
    </MemoryRouter>,
  );
}

const PATCH = [
  'diff --git a/src/one.ts b/src/one.ts',
  '@@ -1,2 +1,2 @@',
  ' kept',
  '-gone',
  '+new',
].join('\n');

function proposal(overrides: Partial<WorkspaceProposalDetailAnswer> = {}): WorkspaceProposalDetailAnswer {
  const { pr, ...rest } = overrides;
  return {
    pr: {
      id: 'p1',
      number: 12,
      repoName: 'infinite-agents',
      title: 'Move the checkout to React',
      body: 'It replaces the old page.',
      from: 'agent/checkout',
      to: 'main',
      diffStat: { insertions: 12, deletions: 3 },
      status: 'open',
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      decidedAt: null,
      agentName: 'Felix',
      agentAvatarUrl: '/faces/felix.png',
      agentId: 'felix',
      userName: 'Saddam',
      agentRuntime: { cli: 'claude', model: 'Opus', effort: 'high' },
      canDecide: true,
      comments: [],
      ...pr,
    },
    checks: [],
    patch: PATCH,
    patchTruncated: false,
    commits: [{ sha: 'abc1234def', subject: 'Move the checkout', at: new Date(Date.now() - 60_000).toISOString() }],
    diffStat: { files: 1, insertions: 12, deletions: 3 },
    headSha: 'abc1234def',
    requireChecks: false,
    ...rest,
  };
}

function knowledge(
  overrides: Partial<WorkspaceKnowledgeProposalDetailAnswer> = {},
): WorkspaceKnowledgeProposalDetailAnswer {
  const { proposal: record, ...rest } = overrides;
  return {
    proposal: {
      id: 'k1',
      number: 4,
      title: 'How a change reaches production',
      status: 'open',
      pages: ['how-a-change-reaches-production'],
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      agentName: 'Felix',
      agentAvatarUrl: '/faces/felix.png',
      agentId: 'felix',
      userName: 'Saddam',
      agentRuntime: { cli: 'claude', model: 'Opus' },
      canDecide: true,
      note: 'The deploy lane moved.',
      comments: [],
      ...record,
    },
    changes: [{
      page: 'how-a-change-reaches-production',
      action: 'edit',
      title: 'How a change reaches production',
      html: '<h1>How a change reaches production</h1>\n<p>one</p>\n<p>three</p>',
      currentHtml: '<h1>How a change reaches production</h1>\n<p>one</p>\n<p>two</p>',
    }],
    ...rest,
  };
}

/** Home's queue, with the row this proposal was opened from — everything the
 *  screen can paint before its own read has answered. */
const queued = (): WorkspaceStateAnswer => emptyState({
  org,
  agents: [agent({ id: 'felix', name: 'Felix', avatarUrl: '/faces/felix.png' })],
  prs: [{
    id: 'p1', number: 12, repoName: 'infinite-agents', title: 'Move the checkout to React',
    body: 'The cached write-up.', from: 'agent/checkout', to: 'main', status: 'open',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), decidedAt: null,
    agentName: 'Felix', agentId: 'felix', agentAvatarUrl: '/faces/felix.png', canDecide: true,
  }],
});

/** The knowledge queue's row for the same proposal — including how many pages
 *  it would change, which is what lets the wait draw one card each. */
const queuedKnowledge = (): WorkspaceStateAnswer => emptyState({
  org,
  agents: [agent({ id: 'felix', name: 'Felix', avatarUrl: '/faces/felix.png' })],
  knowledgeProposals: [{
    id: 'k1', number: 4, title: 'How a change reaches production', status: 'open',
    pages: ['how-a-change-reaches-production', 'deploys'],
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    agentName: 'Felix', agentId: 'felix', agentAvatarUrl: '/faces/felix.png', canDecide: true,
  }],
});

const fleet = (): WorkspaceStateAnswer => emptyState({
  org,
  agents: [agent({ id: 'felix', name: 'Felix', avatarUrl: '/faces/felix.png' })],
});

/** Two agents who can take a review, beside candidates the shared row must
 * not offer: the idle author and another working agent. The author being idle
 * is the regression case from note #333. Ruby is one the answer still files
 * under another room: the row walled her off while there were rooms (note
 * #85), and offers her like anyone else since they left the product (note
 * #843). */
const reviewFleet = (): WorkspaceStateAnswer => emptyState({
  org,
  agents: [
    agent({ id: 'felix', name: 'Felix', avatarUrl: '/faces/felix.png' }),
    agent({ id: 'kai', name: 'Kai', cli: 'codex', model: 'gpt-6-astra', effort: 'high' }),
    agent({ id: 'busy', name: 'Oscar', working: true }),
    agent({ id: 'elsewhere', name: 'Ruby' }),
  ],
});

function openPr(detail = proposal(), extra: Record<string, Answer> = {}, state = fleet()) {
  const scripted = scriptedApi({
    ...workspaceScript(() => state),
    'GET api/prs/p1': () => detail,
    ...extra,
  });
  renderAt('/decisions/pr/p1', scripted.api);
  return scripted;
}

function openKnowledge(detail = knowledge(), extra: Record<string, Answer> = {}, state = fleet()) {
  const scripted = scriptedApi({
    ...workspaceScript(() => state),
    'GET api/knowledge/proposals/k1': () => detail,
    ...extra,
  });
  renderAt('/decisions/knowledge/k1', scripted.api);
  return scripted;
}

/** The one toast, once it is up: `waitFor` resolves on the first call that
 *  does not throw, so the assertion has to be INSIDE it — a bare lookup
 *  returns null happily and the test then reads a property off nothing. */
async function toast(): Promise<HTMLElement> {
  return waitFor(() => {
    const node = document.getElementById('banner');
    expect(node).toBeTruthy();
    return node!;
  });
}

/**
 * Under fake timers the shell's OWN read has to land before the screen under
 * test is even mounted — and only then does its wait start counting. Advancing
 * once does both at the end of the same window, so the wait's timer is left
 * scheduled beyond it and nothing is ever drawn. Two advances: one to let the
 * screen exist, one to make it late.
 */
const waitedFor = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

const prScreen = () => screen.findByRole('heading', { level: 1, name: 'Move the checkout to React' });
const rowOf = (name: string) => screen.getByText(name).closest('.crow') as HTMLElement;

afterEach(() => { vi.useRealTimers(); forgetProposalPreviewUrls(); });

describe('a change proposal', () => {
  it('leads with the repository, the number, the branches and who asked', async () => {
    openPr();
    await prScreen();
    const eyebrow = document.getElementById('prEyebrow')!;
    expect(eyebrow.querySelector('.rname')!.textContent).toBe('infinite-agents');
    expect(eyebrow.querySelector('a.rname')!.getAttribute('href'))
      // The repository is the workplace's (note #566); its address names no room.
      .toBe('/repositories/infinite-agents?org=o1');
    expect(eyebrow.textContent).toContain('· #12');
    const pills = document.getElementById('prPills')!;
    expect(pills.querySelector('.pill')!.textContent).toBe('Waiting for you');
    expect([...pills.querySelectorAll('.bname')].map((node) => node.textContent))
      .toEqual(['main', 'agent/checkout']);
    expect(pills.querySelector('.arrow')!.textContent).toBe('←');
    // Signed with the human behind the agent (note #80), then the concrete
    // runtime it will answer with.
    const who = document.getElementById('prWho')!;
    expect(who.querySelector('.proposalby > div')!.textContent).toBe('Felix (Saddam) proposed this · 5m ago');
    expect(who.querySelector('.proposalruntime')!.textContent).toBe('Claude Code · Opus · high');
    expect((who.querySelector('img.face') as HTMLImageElement).getAttribute('src')).toBe('/faces/felix.png');
    // The face is a door to the agent's CHAT (note #617), because the fleet
    // still has it and it is ready to talk.
    expect(who.querySelector('a.facebtn')!.getAttribute('href')).toBe('/chat/felix');
    // …and it answers a pointer with the one fact this block does not write
    // out: whether that agent is working right now (note #295).
    fireEvent.mouseOver(who.querySelector('.facehover')!);
    const card = document.querySelector('.agentcard')!;
    expect(card.querySelector('.name')!.textContent).toBe('Felix');
    expect(card.querySelector('.statetext')!.textContent).toBe('Ready');
    fireEvent.mouseOut(who.querySelector('.facehover')!);
    expect(document.querySelector('.agentcard')).toBeNull();
  });

  it('carries the chat door under the line that names the agent, and none for an agent nobody can open', async () => {
    openPr(proposal(), { 'GET api/agents/felix/chat': () => ({ messages: [], working: false }) });
    await prScreen();
    const door = document.getElementById('prChat')!;
    expect(door.textContent).toContain('Open chat');
    expect(door.querySelector('svg path')?.getAttribute('d'))
      .toBe('M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z');
    expect(door.previousElementSibling!.id).toBe('prWho');
    fireEvent.click(door);
    // A tap writes the registered address, and the conversation is behind it.
    await waitFor(() => expect(document.getElementById('agentChatTitle')).toBeTruthy());
    expect(document.getElementById('agentChatTitle')!.textContent).toBe('Felix');
  });

  it('opens the chat from the face, and the agent page when there is no chat to open yet', async () => {
    openPr(proposal(), { 'GET api/agents/felix/chat': () => ({ messages: [], working: false }) });
    await prScreen();
    fireEvent.click(document.querySelector('#prWho a.facebtn')!);
    await waitFor(() => expect(document.getElementById('agentChatTitle')).toBeTruthy());
    expect(document.getElementById('agentChatTitle')!.textContent).toBe('Felix');
  });

  it('keeps the face a door to the agent page while that agent has no chat to open', async () => {
    const settingUp = emptyState({
      org,
      agents: [agent({ id: 'felix', name: 'Felix', avatarUrl: '/faces/felix.png', status: 'setting-up' })],
    });
    openPr(proposal(), {}, settingUp);
    await prScreen();
    expect(document.querySelector('#prWho a.facebtn')!.getAttribute('href')).toBe('/agents/felix');
    expect(document.getElementById('prChat')).toBeNull();
  });

  it('draws no chat door for a proposal whose agent this workspace no longer has', async () => {
    openPr(proposal({ pr: { agentId: 'gone' } as never }));
    await prScreen();
    expect(document.getElementById('prChat')).toBeNull();
  });

  it('hands the review to an idle non-author and returns to the proposal', async () => {
    const scripted = openPr(proposal(), {
      'POST api/agents/kai/message': () => ({ ok: true, name: 'Kai' }),
    }, reviewFleet());
    await prScreen();

    // The shared row keeps the author and idle walls: Kai and Ruby can take
    // this on. (It kept a room wall too, until rooms left the product — note
    // #843.)
    const hands = document.getElementById('prHands')!;
    expect([...hands.querySelectorAll('.hand:not(.createhand) .hname')].map((node) => node.textContent))
      .toEqual(['Kai', 'Ruby']);
    expect(document.getElementById('prHandsHint')!.textContent).toContain('hand over this proposal');
    // Review material, then the hand-off, then remarks about the change.
    const proposalNode = document.getElementById('screenPr')!;
    const children = [...proposalNode.children];
    expect(children.findIndex((node) => node.id === 'prHandsHead'))
      .toBeLessThan(children.findIndex((node) => node.id === 'prCommentsHead'));

    fireEvent.click(within(hands).getByRole('button', { name: /^Send Kai/ }));
    await screen.findByRole('heading', { name: 'Kai' });
    expect((document.getElementById('noteSendText') as HTMLTextAreaElement).value)
      .toBe('review change proposal #12 in infinite-agents, “Move the checkout to React”');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await prScreen();
    const sent = scripted.calls.find((call) => call.path === 'api/agents/kai/message')!;
    expect(JSON.parse(String(sent.init!.body))).toEqual({
      message: 'review change proposal #12 in infinite-agents, “Move the checkout to React”',
    });
    // Sent with no scope: it was the room's, while there were rooms (note #843).
    expect(sent.scope).toBeUndefined();
    expect((await toast()).textContent).toContain('Kai is on it — the answer lands in its chat.');
  });

  it('names the row for the review it asks for, not for handing the proposal away', async () => {
    // A proposal is not passed on the way a note is: it stays the author's,
    // and what another agent is offered here is a look at it (note #390).
    // The note and page screens keep the hand-over words, so the name has to
    // come from the caller rather than from the shared row.
    openPr(proposal(), {}, reviewFleet());
    await prScreen();
    expect(document.getElementById('prHandsHead')!.textContent).toBe('Ask for review');
  });

  it('offers no review hand-off once the proposal is a decided record', async () => {
    openPr(proposal({ pr: { status: 'merged', decidedAt: new Date().toISOString() } as never }), {}, reviewFleet());
    await prScreen();
    expect(document.getElementById('prHandsHead')!.hidden).toBe(true);
    expect(document.getElementById('prHandsCard')!.hidden).toBe(true);
  });

  it('keeps the queue’s write-up on screen while the live detail is still being read', async () => {
    let release: (value: WorkspaceProposalDetailAnswer) => void = () => {};
    const slow = new Promise<WorkspaceProposalDetailAnswer>((resolve) => { release = resolve; });
    openPr(proposal(), { 'GET api/prs/p1': () => slow }, queued());
    await screen.findByText('The cached write-up.');
    // Note #299: everything the row carried is painted as ITSELF, at once. A
    // skeleton over a title, a state or a signature the reader has already
    // read on the row they tapped would be a step backwards.
    expect(document.getElementById('prEyebrow')!.textContent).toContain('infinite-agents');
    expect(document.getElementById('prPills')!.querySelector('.pill')!.textContent).toBe('Waiting for you');
    expect([...document.querySelectorAll('#prPills .bname')].map((node) => node.textContent))
      .toEqual(['main', 'agent/checkout']);
    expect(document.getElementById('prWho')!.textContent).toContain('Felix');
    expect(document.getElementById('prChat')).toBeTruthy();
    await act(async () => { release(proposal()); });
    await screen.findByText('It replaces the old page.');
  });

  it('holds the shape of what it is still reading, and offers no decision until it can', async () => {
    vi.useFakeTimers();
    let release: (value: WorkspaceProposalDetailAnswer) => void = () => {};
    const slow = new Promise<WorkspaceProposalDetailAnswer>((resolve) => { release = resolve; });
    openPr(proposal(), { 'GET api/prs/p1': () => slow }, queued());
    await waitedFor(WAIT_QUIET_MS + 20);
    // The summary card is the one block on this screen that ALWAYS lands, so
    // it is the one the wait holds; the runtime is the one fact about the
    // agent the queue row does not carry.
    expect(document.querySelectorAll('#prSummaryWait .crow')).toHaveLength(3);
    expect(document.querySelector('#prWho .cruntime .skel')).toBeTruthy();
    // The room for the decision, and nothing that can be tapped inside it: an
    // Approve the screen cannot yet honour is a promise it should not make.
    expect(document.getElementById('prDecideWait')).toBeTruthy();
    expect(document.querySelectorAll('#prDecideWait button')).toHaveLength(0);
    expect(document.getElementById('screenPr')!.className).toContain('hasbar');
    await act(async () => {
      release(proposal());
      await vi.advanceTimersByTimeAsync(WAIT_HOLD_MS + 20);
    });
    expect(document.getElementById('prSummary')).toBeTruthy();
    expect(document.getElementById('prSummaryWait')).toBeNull();
    expect(document.querySelector('.skel')).toBeNull();
  });

  it('draws nothing at all when the read answers straight away (note #287)', async () => {
    vi.useFakeTimers();
    openPr(proposal(), {}, queued());
    await waitedFor(20);
    expect(document.getElementById('prSummary')).toBeTruthy();
    expect(document.querySelector('.skel')).toBeNull();
    // And it stays that way: a skeleton that turns up after the answer is the
    // same flicker seen from the other side.
    await act(async () => { await vi.advanceTimersByTimeAsync(WAIT_QUIET_MS + WAIT_HOLD_MS); });
    expect(document.querySelector('.skel')).toBeNull();
  });

  it('holds the whole shape for a proposal opened cold, and no decision it cannot promise', async () => {
    vi.useFakeTimers();
    const slow = new Promise<WorkspaceProposalDetailAnswer>(() => {});
    openPr(proposal(), { 'GET api/prs/p1': () => slow });
    await waitedFor(WAIT_QUIET_MS + 20);
    // No row was read, so nothing is known: the eyebrow, the pills, the
    // signature and the write-up are all held — the eyebrow included, because
    // it lives in the header and leaving it out would shorten the header and
    // shove the whole screen up when the read lands.
    expect(document.getElementById('prEyebrowWait')).toBeTruthy();
    expect(document.getElementById('prPillsWait')).toBeTruthy();
    expect(document.getElementById('prWhoWait')).toBeTruthy();
    expect(document.querySelector('#prBody .skel-md')).toBeTruthy();
    expect(document.getElementById('prSummaryWait')).toBeTruthy();
    expect(document.getElementById('prDecideWait')).toBeNull();
    expect(document.getElementById('screenPr')!.className).not.toContain('hasbar');
  });

  it('turns the wait into the error and leaves the cached write-up standing', async () => {
    vi.useFakeTimers();
    openPr(proposal(), {
      'GET api/prs/p1': () => { throw new WorkspaceApiError('No such proposal on this account', 404, {}); },
    }, queued());
    await waitedFor(WAIT_QUIET_MS + 40);
    expect(screen.getByText('No such proposal on this account')).toBeTruthy();
    expect(screen.getByText('The cached write-up.')).toBeTruthy();
    // A failure is not a wait: nothing breathes over an answer that is never
    // going to arrive.
    expect(document.querySelector('.skel')).toBeNull();
  });

  it('sizes the change, lists its commits and says what CI made of it', async () => {
    openPr(proposal({
      checks: [
        { context: 'ci/checks', state: 'success', description: 'Passed in 1.6m', startedAt: 't', completedAt: 't' },
      ],
    }));
    await prScreen();
    const files = rowOf('1 file changed');
    expect(files.querySelector('.plus')!.textContent).toBe('+12');
    expect(files.querySelector('.minus')!.textContent).toBe('−3');
    fireEvent.click(rowOf('1 commit'));
    expect(screen.getByText('abc1234')).toBeTruthy();
    const actions = rowOf('Actions');
    expect(actions.querySelector('.pip')!.className).toBe('pip ok');
    expect(actions.querySelector('.cside')!.textContent).toBe('1 passed');
    // The glanceable change summary leads the agent's longer explanation.
    expect(document.getElementById('prSummary')!.nextElementSibling)
      .toBe(document.querySelector('#prBody .mdwrap'));
  });

  it('says "no CI in this repo" rather than a grey zero that reads like a result', async () => {
    openPr();
    await prScreen();
    const actions = rowOf('Actions');
    expect(actions.querySelector('.cside')!.textContent).toBe('no CI in this repo');
    expect(actions.className).not.toContain('open');
  });

  it('opens the failing action’s log by itself — it is why the reader is here', async () => {
    openPr(proposal({
      checks: [{ context: 'ci/checks', state: 'failure', description: 'Failed', startedAt: 't', logTail: 'boom' }],
    }));
    await prScreen();
    expect(rowOf('Actions').querySelector('.pip')!.className).toBe('pip bad');
    const tail = document.querySelector('.logtail') as HTMLElement;
    expect(tail.textContent).toBe('boom');
    expect(tail.hidden).toBe(false);
  });

  it('counts a superseded action as never run, in grey, not as a broken build', async () => {
    openPr(proposal({
      checks: [{ context: 'ci/checks', state: 'superseded', startedAt: 't' }],
      requireChecks: true,
    }));
    await prScreen();
    expect(rowOf('Actions').querySelector('.pip')!.className).toBe('pip skip');
    expect(rowOf('Actions').querySelector('.cside')!.textContent).toBe('1 never ran');
    expect(document.getElementById('prHint')!.textContent)
      .toContain('One never ran for this commit');
  });
});

describe('the decision on a change', () => {
  it('is one tap each way, with nothing on the bar asking to be filled in', async () => {
    openPr();
    await prScreen();
    const bar = document.getElementById('prDecide')!;
    expect(bar.className).toBe('decidebar');
    expect(bar.querySelectorAll('input, textarea').length).toBe(0);
    const buttons = [...bar.querySelectorAll('button')];
    expect(buttons.map((node) => node.textContent)).toEqual(['Approve & merge', 'Reject']);
    // The screen it covers reserves room for it.
    expect(document.getElementById('screenPr')!.className).toContain('hasbar');
  });

  it('wears the green only while nothing has failed, and says what approving would do', async () => {
    openPr();
    await prScreen();
    expect(document.querySelector('#prDecide .save')!.className).toContain('go');
    expect(document.getElementById('prHint')!.textContent)
      .toBe('Approving merges agent/checkout into main. Nothing changes until you decide, '
        + 'and the agent hears the outcome either way.');
  });

  it('loses the green and says "anyway" once an action has failed', async () => {
    openPr(proposal({ checks: [{ context: 'ci/checks', state: 'failure', startedAt: 't' }] }));
    await prScreen();
    const approve = document.querySelector('#prDecide .save') as HTMLButtonElement;
    expect(approve.className).not.toContain('go');
    expect(approve.textContent).toBe('Approve anyway');
    expect(approve.disabled).toBe(false);
  });

  it('shuts the merge on a repository that opted CI into the decision, and says why', async () => {
    openPr(proposal({ requireChecks: true, checks: [{ context: 'ci/checks', state: 'pending', startedAt: 't' }] }));
    await prScreen();
    const approve = document.querySelector('#prDecide .save') as HTMLButtonElement;
    expect(approve.textContent).toBe('Actions must pass first');
    expect(approve.disabled).toBe(true);
    expect(document.getElementById('prHint')!.textContent)
      .toContain('the merge button unlocks itself the moment they pass');
  });

  it('does not move the page for a merge decided somewhere else', async () => {
    // The same card, painted because a refresh found the proposal merged in
    // the chat or on another device. Nobody here tapped anything, and a screen
    // that scrolls itself under a reader who did not ask is a screen behaving
    // on its own.
    const went = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    openPr(proposal({
      pr: { status: 'merged', decidedAt: new Date().toISOString() } as never,
      delivery: { sha: 'ffff111', branch: 'main', mergedAt: new Date().toISOString(), live: true, checks: [] },
    }));
    await prScreen();
    expect(document.getElementById('prDelivery')).toBeTruthy();
    // The shell's own restoration still runs — `scrollTo(0, y)` on arrival.
    // What must NOT have happened is this screen moving the page itself.
    expect(went).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
    went.mockRestore();
  });

  it('says what it is doing while the merge runs, then follows the landing', async () => {
    const went = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    let land: (value: unknown) => void = () => {};
    const decision = new Promise((resolve) => { land = resolve; });
    const scripted = openPr(proposal(), {
      'POST api/prs/p1/decision': () => decision,
      'GET api/prs/p1/delivery': () => ({
        status: 'merged',
        decidedAt: new Date().toISOString(),
        delivery: {
          sha: 'ffff111', branch: 'main', mergedAt: new Date().toISOString(), live: true,
          checks: [{ context: 'deploy/prod', state: 'success', description: 'Live', startedAt: 't', completedAt: 't' }],
        },
      }),
    });
    await prScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & merge' }));
    // The tap starts a real merge on the host, which takes seconds: the button
    // says so in the word for the thing itself, and the sequence appears with
    // the merge active and the later two stages visibly next.
    await waitFor(() => expect(document.querySelector('#prDecide .save.busy')).toBeTruthy());
    // The button says what is under way, in the word for the thing itself, and
    // the header pill says the same about the proposal.
    expect(document.querySelector('#prDecide .save.busy')!.textContent).toBe('Merging');
    expect(document.querySelector('#prPills .pill')!.textContent).toBe('Merging');
    expect((document.querySelector('#prDecide .save') as HTMLButtonElement).disabled).toBe(true);
    const stages = [...document.querySelectorAll('.prdelivery .delivery-step .name')].map((n) => n.textContent);
    expect(stages).toEqual(['Merging into main', 'Checks on main', 'Delivery']);
    expect(document.querySelector('.prdelivery .cside')!.textContent).toBe('now');
    // The reader tapped a bar pinned to the BOTTOM of the screen and this
    // answer is written at the TOP of it, so the approval takes them there.
    // Matched on the SMOOTH form: the shell's own scroll restoration calls
    // `scrollTo(0, y)` on every navigation, so a bare "was it called" would
    // pass without this screen doing anything at all.
    await waitFor(() => expect(went).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'smooth' }),
    ));

    await act(async () => { land({ ok: true, status: 'merged' }); });
    // The merge announces itself in the TOAST and nowhere else (note #303):
    // with the tick that means "it worked", and with no second copy of the
    // sentence written into the screen underneath.
    const merged = await toast();
    expect(merged.textContent).toContain('Merged into main.');
    expect(merged.className).toContain('ok');
    expect(document.getElementById('prSaid')).toBeNull();
    // The header pill says what became of it, the bar is gone, and the queue
    // behind the screen has been re-read.
    expect(document.querySelector('#prPills .pill')!.textContent).toMatch(/^Merged/);
    expect(document.getElementById('prDecide')).toBeNull();
    expect(scripted.calls.filter((call) => call.path === 'api/state').length).toBeGreaterThan(1);
    went.mockRestore();
  });

  it('says CI is off on the later stages from the tap on, never waiting (note #662)', async () => {
    const went = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    let land: (value: unknown) => void = () => {};
    const decision = new Promise((resolve) => { land = resolve; });
    openPr(proposal({ ci: false }), {
      'POST api/prs/p1/decision': () => decision,
      'GET api/prs/p1/delivery': () => ({
        status: 'merged',
        decidedAt: new Date().toISOString(),
        delivery: { sha: 'ffff111', branch: 'main', mergedAt: new Date().toISOString(), live: false, checks: [], ci: false },
      }),
    });
    await prScreen();
    const later = () => [...document.querySelectorAll('.prdelivery .delivery-step')].slice(1)
      .map((row) => [row.querySelector('.ctext')!.textContent, row.querySelector('.cside')!.textContent]);
    const off = [
      ['CI is off for this repository.', 'off'],
      ['Nothing is delivered while CI is off.', 'off'],
    ];
    fireEvent.click(screen.getByRole('button', { name: 'Approve & merge' }));
    await waitFor(() => expect(document.querySelector('#prDecide .save.busy')).toBeTruthy());
    expect(later()).toEqual(off);
    await act(async () => { land({ ok: true, status: 'merged' }); });
    await toast();
    expect(later()).toEqual(off);
    expect(document.querySelector('.prdelivery')!.textContent).not.toContain('waiting');
    went.mockRestore();
  });

  it('gives the buttons back when the decision itself fails', async () => {
    openPr(proposal(), {
      'POST api/prs/p1/decision': () => { throw new WorkspaceApiError('The host is unreachable', 502, {}); },
    });
    await prScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & merge' }));
    await screen.findByText('The host is unreachable');
    // Written ON the screen, not drained away in five seconds: nothing was
    // merged, the bar is still there, and the reader has to act on it.
    expect(document.getElementById('prRefusal')!.textContent).toBe('The host is unreachable');
    expect(document.getElementById('banner')).toBeNull();
    const approve = screen.getByRole('button', { name: 'Approve & merge' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    expect(document.querySelector('.prdelivery')).toBeNull();
  });

  it('keeps the refusal on the screen when the flow declined to act', async () => {
    openPr(proposal(), {
      'POST api/prs/p1/decision': () => ({ ok: true, status: null, note: 'Already decided in the chat.' }),
    });
    await prScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(document.getElementById('prRefusal')).toBeTruthy());
    expect(document.getElementById('prRefusal')!.textContent).toBe('Already decided in the chat.');
    // Once, in one place. It used to be written twice over — the same sentence
    // in two hintlines a few rows apart.
    expect(document.getElementById('prSaid')).toBeNull();
    expect(document.getElementById('banner')).toBeNull();
  });

  it('offers no bar to a member who is not the one being asked, and says who is', async () => {
    openPr(proposal({ pr: { canDecide: false } as never }));
    await prScreen();
    expect(document.querySelector('#prDecide .decidebar')).toBeNull();
    expect(document.getElementById('prDecide')!.textContent)
      .toBe('Only the owner of the agent that proposed this change can approve or reject it.');
    expect(document.getElementById('screenPr')!.className).not.toContain('hasbar');
  });

  it('offers no bar on a quiet proposal, and says the agent is still on it (note #293)', async () => {
    openPr(proposal({ pr: { draft: true, canDecide: false } as never }));
    await prScreen();
    expect(document.querySelector('#prDecide .decidebar')).toBeNull();
    // Not "only the owner…": this IS the owner, and the reason is a different one.
    expect(document.getElementById('prDecide')!.textContent)
      .toBe('Felix is still working on this and has not asked for a decision yet. It will invite you when it is ready.');
    expect(document.getElementById('screenPr')!.className).not.toContain('hasbar');
    // The pill must not summon: nobody is waiting on the reader.
    expect(document.querySelector('.pill.quiet')!.textContent).toBe('Still being prepared');
    expect(screen.queryByText('Waiting for you')).toBeNull();
    // And the approve hint, which explains a tap that cannot happen, is hidden.
    expect((document.getElementById('prHint') as HTMLElement).hidden).toBe(true);
  });

  it('is a record once decided: the pill dates it and no bar remains', async () => {
    const decidedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    openPr(proposal({
      pr: { status: 'rejected', decidedAt, decisionNote: 'Use the other table.' } as never,
    }));
    await prScreen();
    expect(document.querySelector('#prPills .pill')!.textContent).toBe('Rejected 3m ago');
    expect(document.querySelector('#prPills .pill')!.className).toBe('pill rejected');
    expect(document.getElementById('prDecide')).toBeNull();
    expect(screen.getByText('Your note to the agent: Use the other table.')).toBeTruthy();
    expect(document.getElementById('prHint')!.hidden).toBe(true);
  });
});

describe('the diff behind a change', () => {
  it('opens off the files row as a screen of its own, and Back returns to the proposal', async () => {
    openPr();
    await prScreen();
    fireEvent.click(rowOf('1 file changed'));
    await screen.findByRole('heading', { level: 1, name: '1 file changed' });
    expect(document.getElementById('prDiffSub')!.textContent).toBe('+12−3 · agent/checkout → main');
    expect(document.querySelector('.diffpath')!.textContent).toBe('src/one.ts');
    // The decision follows the reader into the diff — it is where the question
    // is actually answered.
    expect(document.getElementById('prDecide')!.className).toBe('decidebar');
    expect(document.getElementById('screenPrDiff')!.className).toContain('hasbar');
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    await prScreen();
  });

  it('says why there is no patch rather than showing an empty screen', async () => {
    openPr(proposal({ patch: null }));
    await prScreen();
    fireEvent.click(rowOf('1 file changed'));
    await screen.findByText('No difference between the branches right now.');
  });

  it('passes the host’s own failure through', async () => {
    openPr(proposal({ patch: null, compareError: 'the branch is gone' }));
    await prScreen();
    fireEvent.click(rowOf('1 file changed'));
    await screen.findByText('The diff cannot be read right now: the branch is gone');
  });
});

describe('what a change proposal carries', () => {
  it('draws nothing at all for a proposal carrying no files', async () => {
    openPr();
    await prScreen();
    expect(document.getElementById('prFiles')).toBeNull();
  });

  it('shows a photo whole and keeps everything else a row', async () => {
    openPr(proposal({
      pr: {
        attachments: [
          { id: 'f1', fileName: 'after.png', contentType: 'image/png', sizeBytes: 2048, addedAt: 't' },
          { id: 'f2', fileName: 'trace.txt', contentType: 'text/plain', sizeBytes: 512, addedAt: 't' },
        ],
      } as never,
    }), {
      'GET api/prs/p1/files/f1?preview=1': () => ({ url: 'https://signed/after.png', fileName: 'after.png', expiresAt: 't' }),
    });
    await prScreen();
    const card = document.getElementById('prFiles')!;
    await waitFor(() => expect(card.querySelector('.notephoto img')).toBeTruthy());
    expect((card.querySelector('.notephoto img') as HTMLImageElement).getAttribute('src'))
      .toBe('https://signed/after.png');
    // Under each photo, the facts the plain row would have carried.
    expect(card.querySelector('.caprow .ctext')!.textContent).toBe('after.png · 2 KB');
    const row = within(card).getByText('trace.txt').closest('.crow')!;
    expect(row.querySelector('.ctext')!.textContent).toBe('512 B');

    // Note #366 came from this exact door: a proposal screenshot on an
    // iPhone. Keep the shared viewer wired here, with a zoom control that
    // changes the picture rather than merely looking enabled.
    fireEvent.click(card.querySelector('.notephoto')!);
    expect(document.getElementById('imageViewerName')?.textContent).toBe('after.png');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('1.5×');
    expect(document.getElementById('imageViewerImage')?.getAttribute('style')).toContain('scale(1.5)');
  });

  /**
   * Note #825, from Adam's phone: the sheet's pictures drew as flat grey
   * blocks with file names, slowly. The proposal's answer now carries each
   * picture's size and a signed URL, so the picture is asked for in the
   * first render with no further read, in a frame already its own shape —
   * the first eagerly, the rest as they scroll in.
   */
  it('draws a picture from the URL the proposal carried, in a frame of its shape, with no further read', async () => {
    const soon = new Date(Date.now() + 14 * 60_000).toISOString();
    const scripted = openPr(proposal({
      pr: {
        attachments: [
          { id: 'g1', fileName: 'home-desk.png', contentType: 'image/png', sizeBytes: 92947, addedAt: 't', width: 1440, height: 900, preview: { url: 'https://signed/home-desk.png', expiresAt: soon } },
          { id: 'g2', fileName: 'home-phone.png', contentType: 'image/png', sizeBytes: 176319, addedAt: 't', width: 780, height: 1688, preview: { url: 'https://signed/home-phone.png', expiresAt: soon } },
          { id: 'g3', fileName: 'trace.txt', contentType: 'text/plain', sizeBytes: 512, addedAt: 't' },
        ],
      } as never,
    }));
    await prScreen();
    const card = document.getElementById('prFiles')!;
    const frames = [...card.querySelectorAll('.notephoto')] as HTMLElement[];
    expect(frames).toHaveLength(2);
    // The frame carries the picture's proportions, so it is laid out at its
    // final shape before the bytes arrive, and says it is loading meanwhile.
    expect(frames[0]!.classList.contains('framed')).toBe(true);
    expect(frames[0]!.style.getPropertyValue('--picture-ratio')).toBe('1440 / 900');
    expect(frames[1]!.style.getPropertyValue('--picture-ratio')).toBe('780 / 1688');
    expect(frames[0]!.classList.contains('loading')).toBe(true);
    expect(frames[0]!.querySelector('.spinner')).toBeTruthy();
    // The picture is in the first render, off the carried URL…
    const imgs = [...card.querySelectorAll('.notephoto img')] as HTMLImageElement[];
    expect(imgs.map((img) => img.getAttribute('src'))).toEqual(['https://signed/home-desk.png', 'https://signed/home-phone.png']);
    // …the first eagerly and first in line, the rest as they scroll in…
    expect(imgs.map((img) => img.getAttribute('loading'))).toEqual(['eager', 'lazy']);
    expect(imgs[0]!.getAttribute('fetchpriority')).toBe('high');
    expect(imgs.map((img) => img.getAttribute('decoding'))).toEqual(['async', 'async']);
    // …and nobody asked the backend for a URL it had already been given.
    expect(scripted.calls.filter((call) => call.path.includes('/files/'))).toEqual([]);
    // When the bytes land the frame stops saying it is loading, and the
    // caption under it names the file.
    fireEvent.load(imgs[0]!);
    expect(frames[0]!.classList.contains('loading')).toBe(false);
    expect(frames[0]!.getAttribute('aria-label')).toBe('Open home-desk.png');
    expect(card.querySelector('.caprow .ctext')!.textContent).toBe('home-desk.png · 91 KB');
    // Full size on tap, stepping through the pictures the sheet is showing.
    fireEvent.click(frames[1]!);
    expect(document.getElementById('imageViewerName')?.textContent).toBe('home-phone.png');
  });

  it('mints a URL itself when the carried one is about to expire', async () => {
    const nearlyGone = new Date(Date.now() + 20_000).toISOString();
    const minted: string[] = [];
    openPr(proposal({
      pr: {
        attachments: [
          { id: 'g4', fileName: 'stale.png', contentType: 'image/png', sizeBytes: 2048, addedAt: 't', width: 100, height: 50, preview: { url: 'https://signed/stale.png', expiresAt: nearlyGone } },
        ],
      } as never,
    }), {
      'GET api/prs/p1/files/g4?preview=1': () => { minted.push('g4'); return { url: 'https://signed/fresh.png', fileName: 'stale.png', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }; },
    });
    await prScreen();
    const card = document.getElementById('prFiles')!;
    await waitFor(() => expect(card.querySelector('.notephoto img')).toBeTruthy());
    expect((card.querySelector('.notephoto img') as HTMLImageElement).getAttribute('src')).toBe('https://signed/fresh.png');
    expect(minted).toEqual(['g4']);
    // The shape still came from the answer: a fresh signature changes no pixels.
    expect((card.querySelector('.notephoto') as HTMLElement).style.getPropertyValue('--picture-ratio')).toBe('100 / 50');
  });

  it('leaves a photo whose URL will not load as a row the reader can still tap', async () => {
    openPr(proposal({
      pr: {
        attachments: [{ id: 'f1', fileName: 'after.png', contentType: 'image/png', sizeBytes: 2048, addedAt: 't' }],
      } as never,
    }), {
      // Landed a macrotask late, deliberately. A photo whose URL has not
      // answered yet renders the loading tile AND its caption `.crow`, so a
      // wait on `.crow` is satisfied while the read is still in flight — and
      // on a busy CI host the assertion below then ran against the loading
      // tile rather than the fallback row. The delay makes that ordering the
      // one this test always exercises.
      'GET api/prs/p1/files/f1?preview=1': async () => {
        await new Promise((resolve) => { setTimeout(resolve, 30); });
        throw new WorkspaceApiError('gone', 404, {});
      },
    });
    await prScreen();
    // Wait for the state under test — the photo giving up — not for a row
    // the loading tile already brought with it.
    await waitFor(() => expect(document.querySelector('#prFiles .notephoto')).toBeNull());
    expect(within(document.getElementById('prFiles')!).getByText('after.png')).toBeTruthy();
  });

  it('opens a PDF over the decision rather than downloading it', async () => {
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    openPr(proposal({
      pr: {
        attachments: [{ id: 'f3', fileName: 'audit.pdf', contentType: 'application/pdf', sizeBytes: 4096, addedAt: 't' }],
      } as never,
    }), {
      'GET api/prs/p1/files/f3?preview=1': () => ({ url: 'https://signed/audit.pdf', fileName: 'audit.pdf', expiresAt: 't' }),
    });
    await prScreen();
    const card = document.getElementById('prFiles')!;
    // A row still, not a band of page one: this screen is a decision, and the
    // diff under it is what the reader came for.
    const row = within(card).getByText('audit.pdf').closest('.crow') as HTMLElement;
    fireEvent.click(row);

    // Evidence a phone can read, read where the decision is made (note #403).
    const viewer = await screen.findByRole('dialog');
    expect(viewer.id).toBe('pdfViewer');
    expect((document.getElementById('pdfViewerFrame') as HTMLIFrameElement).getAttribute('src'))
      .toBe('https://signed/audit.pdf#view=FitH');
    expect(opened).not.toHaveBeenCalled();
  });

  it('names the notes it implements, as doors to the request itself', async () => {
    openPr(proposal({
      pr: { quickNotes: [{ number: 256, title: 'Move the Workspace UI to React' }] } as never,
    }));
    await prScreen();
    expect(document.getElementById('prEyebrow')!.textContent).toContain('note #256');
    const row = rowOf('Move the Workspace UI to React');
    expect(row.querySelector('.cside')!.textContent).toBe('#256');
  });
});

describe('the margin on a change proposal', () => {
  it('reads newest first, signs each remark and offers the box while the question is open', async () => {
    openPr(proposal({
      pr: {
        comments: [
          { text: '<p>First remark.</p>', createdAt: new Date(Date.now() - 120_000).toISOString(), agentName: 'Felix', userName: 'Saddam' },
          { text: '<p>Second remark.</p>', createdAt: new Date(Date.now() - 60_000).toISOString(), byPerson: true, userName: 'Saddam', authorUserId: 'u1' },
        ],
      } as never,
    }));
    await prScreen();
    const box = document.getElementById('prComments')!;
    // A remark's WORDS are built as DOM by the allowlist renderer, inside an
    // effect — so `.ncmt` exists a tick before the `.ctext` inside it does.
    // Reading straight through was a race that only showed up on a slower
    // machine; wait for the words, then read the thread.
    await waitFor(() => expect(box.querySelectorAll('.ncmt .ctext')).toHaveLength(2));
    const remarks = [...box.querySelectorAll('.ncmt')];
    expect(remarks.map((node) => node.querySelector('.ctext')!.textContent))
      .toEqual(['Second remark.', 'First remark.']);
    expect(remarks[1]!.querySelector('.commentby > div')!.textContent).toBe('Felix (Saddam) · 2m ago');
    expect(screen.getByRole('button', { name: /Write a comment/ })).toBeTruthy();
  });

  it('posts a remark and repaints the thread from what the server holds', async () => {
    const scripted = openPr(proposal(), {
      'POST api/prs/p1/comments': () => ({
        ok: true,
        comments: [{ text: '<p>Why this table?</p>', createdAt: new Date().toISOString(), byPerson: true, userName: 'Saddam' }],
      }),
    });
    await prScreen();
    fireEvent.click(screen.getByRole('button', { name: /Write a comment/ }));
    fireEvent.change(screen.getByLabelText('Write a comment'), { target: { value: 'Why this table?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Why this table?');
    const posted = scripted.calls.find((call) => call.path === 'api/prs/p1/comments')!;
    expect(JSON.parse(String(posted.init!.body))).toEqual({ text: 'Why this table?' });
    // The box collapses again with the post.
    expect(screen.getByRole('button', { name: /Write a comment/ })).toBeTruthy();
  });

  it('edits only the reader’s own comment in place and repaints it from the server', async () => {
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const scripted = openPr(proposal({
      pr: {
        comments: [
          { id: 'c-agent', text: '<p>Agent words.</p>', createdAt, agentName: 'Felix' },
          {
            id: 'c-own', text: '<p>Before.<br>Second line.</p>', editableText: 'Before.\nSecond line.',
            createdAt, byPerson: true, self: true, userName: 'Saddam', authorUserId: 'u1',
          },
        ],
      } as never,
    }), {
      'PUT api/prs/p1/comments/c-own': () => ({
        ok: true,
        comments: [
          { id: 'c-agent', text: '<p>Agent words.</p>', createdAt, agentName: 'Felix' },
          {
            id: 'c-own', text: '<p>Corrected.<br>Still two lines.</p>', editableText: 'Corrected.\nStill two lines.',
            createdAt, editedAt: new Date().toISOString(), byPerson: true, self: true,
            userName: 'Saddam', authorUserId: 'u1',
          },
        ],
      }),
    });
    await prScreen();
    await waitFor(() => expect(document.querySelectorAll('#prComments .ncmt .ctext')).toHaveLength(2));
    const own = document.querySelector('#prComments .ncmt') as HTMLElement;
    expect(own.querySelector('.ctext')!.textContent).toBe('Before.Second line.');
    expect(screen.getAllByRole('button', { name: 'Edit your comment' })).toHaveLength(1);
    expect(within(own).getByRole('button', { name: 'Edit your comment' })).toBeTruthy();

    fireEvent.click(within(own).getByRole('button', { name: 'Edit your comment' }));
    const field = within(own).getByRole('textbox', { name: 'Edit comment' }) as HTMLTextAreaElement;
    expect(field.value).toBe('Before.\nSecond line.');
    fireEvent.change(field, { target: { value: 'Corrected.\nStill two lines.' } });
    fireEvent.click(within(own).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(document.querySelector('#prComments .ncmt .ctext')?.textContent)
      .toBe('Corrected.Still two lines.'));
    const sent = scripted.calls.find((call) => call.path === 'api/prs/p1/comments/c-own')!;
    expect(sent.init?.method).toBe('PUT');
    expect(JSON.parse(String(sent.init?.body))).toEqual({ text: 'Corrected.\nStill two lines.' });
    expect(document.querySelector('#prComments .commentby')!.textContent).toContain('edited');
    expect(screen.queryByRole('textbox', { name: 'Edit comment' })).toBeNull();
  });

  /**
   * Note #518: the composer sends the words and nothing else — no picker, no
   * recipient list — and a remark that lands starts NOBODY, not even the agent
   * that opened the proposal. So the screen has nothing to say back either:
   * the thread repaints and the hint line stays empty.
   */
  it('posts the words alone, offers nobody, and reports no delivery', async () => {
    const scripted = openPr(proposal(), {
      'POST api/prs/p1/comments': () => ({
        ok: true,
        comments: [{
          id: 'c-new', text: '<p>ping @Felix</p>', createdAt: new Date().toISOString(),
          byPerson: true, userName: 'Saddam',
        }],
      }),
    });
    await prScreen();
    fireEvent.click(screen.getByRole('button', { name: /Write a comment/ }));
    const box = screen.getByLabelText('Write a comment');
    // Felix is this proposal's own author, and idle — the agent both
    // the picker and the author path would have started.
    fireEvent.change(box, { target: { value: 'ping @Felix' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('option')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(scripted.calls.some((call) => call.path === 'api/prs/p1/comments')).toBe(true));
    const posted = scripted.calls.find((call) => call.path === 'api/prs/p1/comments')!;
    expect(JSON.parse(String(posted.init!.body))).toEqual({ text: 'ping @Felix' });
    await waitFor(() => expect(document.querySelector('#prComments .ncmt .ctext')?.textContent)
      .toBe('ping @Felix'));
    // Nothing was started, so nothing is announced.
    expect(document.getElementById('prSaid')).toBeNull();
  });

  it('closes the margin with the decision', async () => {
    openPr(proposal({ pr: {
      status: 'merged', decidedAt: new Date().toISOString(),
      comments: [{
        id: 'c-own', text: '<p>Already decided.</p>', editableText: 'Already decided.',
        createdAt: new Date().toISOString(), byPerson: true, self: true,
      }],
    } as never }));
    await prScreen();
    expect(screen.queryByRole('button', { name: /Write a comment/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit your comment' })).toBeNull();
    // Note #647: the same closed margin, so neither door — a decided proposal
    // is the record of what was said before the decision.
    expect(screen.queryByRole('button', { name: 'Delete your comment' })).toBeNull();
    expect(document.getElementById('prCommentsCard')!.hidden).toBe(false);
  });
});

describe('a knowledge proposal', () => {
  it('waits in its own shape: what the row said, and one card per page it would change', async () => {
    vi.useFakeTimers();
    const slow = new Promise<WorkspaceKnowledgeProposalDetailAnswer>(() => {});
    openKnowledge(knowledge(), { 'GET api/knowledge/proposals/k1': () => slow }, queuedKnowledge());
    await waitedFor(WAIT_QUIET_MS + 20);
    // Painted, not held: the row carried all of it.
    expect(document.getElementById('kpTitle')!.textContent).toBe('How a change reaches production');
    expect(document.getElementById('kpSub')!.textContent).toContain('Felix');
    expect(document.querySelector('#kpSub a.facebtn')!.getAttribute('href')).toBe('/chat/felix');
    expect(document.getElementById('screenKp')!.className).toContain('hasbar');
    // Held: the reason, and the pages — and the row knows how many of those
    // there are, so the reader learns the shape of the decision before its
    // content exists.
    expect(document.querySelectorAll('#kpBody .kchange')).toHaveLength(2);
    expect(document.querySelector('#kpBody .skel-md')).toBeTruthy();
  });

  const kpScreen = () => screen.findByRole('heading', { level: 1, name: 'How a change reaches production' });

  it('names who asked, offers the chat door, and leads with the raw diff, open', async () => {
    openKnowledge();
    await kpScreen();
    expect(document.querySelector('#kpSub .proposalby > div')!.textContent)
      .toBe('Felix (Saddam) proposed this · 1m ago');
    expect(document.querySelector('#kpSub a.facebtn')!.getAttribute('href')).toBe('/chat/felix');
    expect(document.querySelector('#kpSub .proposalruntime')!.textContent).toBe('Claude Code · Opus');
    expect(document.getElementById('kpChat')!.textContent).toContain('Open chat');
    expect(screen.getByText('The deploy lane moved.')).toBeTruthy();
    const card = document.querySelector('.card.kchange')!;
    expect(card.querySelector('.kact')!.textContent).toBe('Update');
    expect(card.querySelector('.kname')!.textContent).toBe('how-a-change-reaches-production');
    // The diff IS the screen here, so it is open: a knowledge change is one
    // page, and asking for a tap to see the only thing on offer is a tap for
    // nothing.
    const file = card.querySelector('.difffile')!;
    expect(file.className).not.toContain('closed');
    expect(file.querySelector('.diffpath')!.textContent).toBe('how-a-change-reaches-production.html');
    expect([...file.querySelectorAll('.difflines .del')].map((n) => n.textContent)).toEqual(['-<p>two</p>']);
    expect([...file.querySelectorAll('.difflines .add')].map((n) => n.textContent)).toEqual(['+<p>three</p>']);
  });

  it('hands a knowledge review to an idle non-author by its account-wide number', async () => {
    const scripted = openKnowledge(knowledge(), {
      'POST api/agents/kai/message': () => ({ ok: true, name: 'Kai' }),
    }, reviewFleet());
    await kpScreen();
    const hands = document.getElementById('kpHands')!;
    expect([...hands.querySelectorAll('.hand:not(.createhand) .hname')].map((node) => node.textContent))
      .toEqual(['Kai', 'Ruby']);

    fireEvent.click(within(hands).getByRole('button', { name: /^Send Kai/ }));
    await screen.findByRole('heading', { name: 'Kai' });
    const box = document.getElementById('noteSendText') as HTMLTextAreaElement;
    expect(box.value)
      .toBe('review knowledge proposal #4, “How a change reaches production”');

    // Back belongs to the transient Send, not the proposal's history entry.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await kpScreen();
    fireEvent.click(within(document.getElementById('kpHands')!).getByRole('button', { name: /^Send Kai/ }));
    await screen.findByRole('heading', { name: 'Kai' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await kpScreen();
    const sent = scripted.calls.find((call) => call.path === 'api/agents/kai/message')!;
    expect(JSON.parse(String(sent.init!.body))).toEqual({
      message: 'review knowledge proposal #4, “How a change reaches production”',
    });
  });

  it('asks for review under the same name the change proposal uses', async () => {
    openKnowledge(knowledge(), {}, reviewFleet());
    await kpScreen();
    expect(document.getElementById('kpHandsHead')!.textContent).toBe('Ask for review');
  });

  it('calls a new page NEW KNOWLEDGE and a removal Removing, in the reader’s words', async () => {
    openKnowledge(knowledge({
      changes: [
        { page: 'new-thing', action: 'create', html: '<p>fresh</p>' },
        { page: 'old-thing', action: 'delete', currentHtml: '<p>stale</p>' },
      ],
    }));
    await kpScreen();
    const labels = [...document.querySelectorAll('.kchange .kact')];
    expect(labels.map((node) => node.textContent)).toEqual(['New knowledge', 'Removing']);
    expect(labels[1]!.className).toBe('kact gone');
  });

  it('says so plainly when a change would move nothing', async () => {
    openKnowledge(knowledge({
      changes: [{ page: 'same', action: 'edit', html: '<p>same</p>', currentHtml: '<p>same</p>' }],
    }));
    await kpScreen();
    expect(screen.getByText('This would leave the page exactly as it is.')).toBeTruthy();
    expect(document.querySelector('.kchange .difffile')).toBeNull();
  });

  it('offers the rendering as a button, and Back off it lands on the change', async () => {
    openKnowledge();
    await kpScreen();
    const read = screen.getByText('Read the page').closest('.crow')!;
    expect(read.className).toContain('kread');
    fireEvent.click(read);
    await waitFor(() => expect(document.getElementById('screenKnowledgePage')).toBeTruthy());
    // The page as it WOULD be — and its own <h1> is not printed twice.
    const body = document.getElementById('kpageBody')!;
    expect(body.querySelector('h1')).toBeNull();
    expect([...body.querySelectorAll('p')].map((node) => node.textContent)).toEqual(['one', 'three']);
    // A preview is a page that does not exist yet: nobody is offered it, and
    // it carries no margin of its own.
    expect(document.getElementById('kpageHandsCard')).toBeNull();
    expect(document.getElementById('kpageCommentsCard')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    await waitFor(() => expect(document.getElementById('screenKp')).toBeTruthy());
  });

  it('shows the page being taken away when the change is a removal', async () => {
    openKnowledge(knowledge({
      changes: [{ page: 'old-thing', action: 'delete', title: 'Old thing', currentHtml: '<p>stale</p>' }],
    }));
    await kpScreen();
    fireEvent.click(screen.getByText('Read the page').closest('.crow')!);
    await waitFor(() => expect(document.getElementById('kpageBody')!.textContent).toBe('stale'));
  });

  /**
   * A rename carries the page's bytes unchanged, so there is no diff to draw —
   * and an empty diff on this screen says "This would leave the page exactly
   * as it is", which is the opposite of what is being decided. The change IS
   * the address, so the card says both.
   */
  it('shows a rename as the move it is, in both addresses, with no empty diff', async () => {
    openKnowledge(knowledge({
      changes: [{
        page: 'workspace-react-migration', action: 'rename', renameTo: 'workspace-shell',
        title: 'Working on the Workspace shell',
        html: '<p>same words</p>', currentHtml: '<p>same words</p>',
      }],
    }));
    await kpScreen();
    expect(document.querySelector('.kchange .kact')!.textContent).toBe('Renaming');
    expect(document.querySelector('.kchange .kname')!.textContent)
      .toBe('workspace-react-migration → workspace-shell');
    expect(screen.getByText(/only its address changes/)).toBeTruthy();
    expect(screen.getByText(/comments move with it/)).toBeTruthy();
    // The line an unchanged page would otherwise get, which would read here as
    // "nothing happens".
    expect(screen.queryByText('This would leave the page exactly as it is.')).toBeNull();
    // And the page itself still reads, under the title it keeps.
    fireEvent.click(screen.getByText('Read the page').closest('.crow')!);
    await waitFor(() => expect(document.getElementById('kpageBody')!.textContent).toBe('same words'));
    expect(document.getElementById('kpageTitle')!.textContent).toBe('Working on the Workspace shell');
  });

  it('says on the screen that a page moved, and shuts the button rather than promising a refusal', async () => {
    openKnowledge(knowledge({
      changes: [{
        page: 'how-a-change-reaches-production', action: 'edit',
        html: '<p>new</p>', currentHtml: '<p>old</p>', moved: true,
      }],
    }));
    await kpScreen();
    expect(screen.getByText(/This page changed after the proposal was written/)).toBeTruthy();
    const approve = document.querySelector('#prDecide .save') as HTMLButtonElement;
    expect(approve.textContent).toBe('A page changed — cannot apply');
    expect(approve.disabled).toBe(true);
  });

  it('publishes in one tap, says so in the toast and leaves the reader where they were', async () => {
    const scripted = openKnowledge(knowledge(), {
      'POST api/knowledge/proposals/k1/decision': () => ({ ok: true, status: 'approved' }),
    });
    await kpScreen();
    const bar = document.getElementById('prDecide')!;
    expect([...bar.querySelectorAll('button')].map((node) => node.textContent))
      .toEqual(['Approve & publish', 'Reject']);
    expect(document.getElementById('screenKp')!.className).toContain('hasbar');
    fireEvent.click(screen.getByRole('button', { name: 'Approve & publish' }));
    const published = await toast();
    expect(published.textContent).toContain('Published.');
    expect(published.className).toContain('ok');
    // Note #303: the toast, and nothing else. The reader keeps the page they
    // were reading — no yank back to Home, and no card left standing there —
    // and the screen becomes the record: the bar goes, the signature line
    // says what happened.
    expect(document.getElementById('screenKp')).toBeTruthy();
    expect(document.getElementById('screenHome')).toBeNull();
    expect(document.getElementById('homeBanner')).toBeNull();
    await waitFor(() => expect(document.getElementById('prDecide')).toBeNull());
    expect(document.getElementById('screenKp')!.className).not.toContain('hasbar');
    expect(document.getElementById('kpSub')!.textContent).toContain('approved');
    const posted = scripted.calls.find((call) => call.path === 'api/knowledge/proposals/k1/decision')!;
    expect(JSON.parse(String(posted.init!.body))).toEqual({ decision: 'approve' });
    await waitFor(() => expect(scripted.calls.filter((call) => call.path === 'api/state').length)
      .toBeGreaterThan(1));
  });

  it('offers no bar on a quiet knowledge proposal, and says the agent is still on it (note #293)', async () => {
    openKnowledge(knowledge({ proposal: { draft: true, canDecide: false } as never }));
    await kpScreen();
    expect(document.querySelector('#prDecide .decidebar')).toBeNull();
    expect(document.getElementById('prDecide')!.textContent)
      .toBe('Felix is still working on this and has not asked for a decision yet. It will invite you when it is ready.');
    expect(document.getElementById('screenKp')!.className).not.toContain('hasbar');
    expect(document.getElementById('kpSub')!.textContent).toContain('still being prepared');
  });

  it('reports the flow’s own refusal instead of claiming it published', async () => {
    openKnowledge(knowledge(), {
      'POST api/knowledge/proposals/k1/decision': () => ({ ok: true, note: 'The page moved — ask for a fresh proposal.' }),
    });
    await kpScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & publish' }));
    await screen.findByText('The page moved — ask for a fresh proposal.');
    // Nothing was published, so nothing is toasted and the bar stays: the
    // refusal is on the screen, where the reader can act on it.
    expect(document.getElementById('kpSaid')!.textContent)
      .toBe('The page moved — ask for a fresh proposal.');
    expect(document.getElementById('banner')).toBeNull();
    expect(document.getElementById('prDecide')).toBeTruthy();
  });

  it('offers no bar to a member who is not the one being asked', async () => {
    openKnowledge(knowledge({ proposal: { canDecide: false } as never }));
    await kpScreen();
    expect(document.querySelector('#prDecide .decidebar')).toBeNull();
    expect(document.getElementById('prDecide')!.textContent)
      .toBe('Only the owner of the agent that proposed this page can approve or reject it.');
  });

  it('carries its own margin, under the same rules as the other queue', async () => {
    openKnowledge(knowledge({
      proposal: {
        comments: [{ text: '<p>Checked, still true.</p>', createdAt: new Date().toISOString(), agentName: 'Felix' }],
      } as never,
    }));
    await kpScreen();
    // The third copy of the race Oscar fixed on the note and change-proposal
    // screens (1eeeccb6): a remark's WORDS are built as DOM by the allowlist
    // renderer inside an effect, so `#kpComments` exists a tick before the
    // `.ctext` inside it does. Wait for the words, then read them.
    await waitFor(() => expect(document.querySelector('#kpComments .ctext')).toBeTruthy());
    expect(document.querySelector('#kpComments .ctext')!.textContent).toBe('Checked, still true.');
    expect(document.querySelector('#kpComments .commentby > div')!.textContent).toBe('Felix · just now');
  });
});
