import { describe, expect, it } from 'vitest';
import type { WorkspaceNoteRow, WorkspaceNotificationRow } from '../../../src/shared/workspace-api.js';
import {
  agentNamed,
  applyLiveNoteClaims,
  applyLiveTick,
  carryAgentRecapArrivals,
  groupUnreadConversations,
  markdownPreview,
  readerNeedsAttention,
  type HomeAgent,
} from './live.js';

const ORIGIN = 'https://acc.test';
const agent = (id: string, extra: Partial<HomeAgent> = {}): HomeAgent => ({ id, name: id, cli: 'claude', status: 'ready', ...extra });
const notification = (extra: Partial<WorkspaceNotificationRow>): WorkspaceNotificationRow => ({
  notificationId: 'n', userId: 'u', kind: 'agent_completed', title: '', body: '', url: '/chat/a',
  source: 'direct_agent_chat', dedupeKey: 'd', createdAt: '2026-09-02T10:00:00Z', ...extra,
});
const quickNote = (id: string, work?: WorkspaceNoteRow['work']): WorkspaceNoteRow => ({
  id, number: 1, title: id, preview: '', createdAt: 't', updatedAt: 't', ...(work ? { work } : {}),
});

describe('the live tick', () => {
  it('patches the tail of a working row and reports no move while the set holds still', () => {
    const before = [agent('a', { working: true, activity: 'Read: x' }), agent('b')];
    const result = applyLiveTick(before, {
      agents: [{ id: 'a', working: true, activity: 'Bash: npm test', activitySince: '2026-09-02T09:59:00Z' }],
      recaps: [], sessionLimits: [],
    });
    expect(result.moved).toBe(false);
    expect(result.agents[0]).toMatchObject({ working: true, activity: 'Bash: npm test', activitySince: '2026-09-02T09:59:00Z' });
    expect(result.agents[1]!.working).toBeUndefined();
    // Nothing was mutated: the previous rows still say what they said.
    expect(before[0]!.activity).toBe('Read: x');
  });

  it('reports a move when a turn starts or ends', () => {
    expect(applyLiveTick([agent('a')], { agents: [{ id: 'a', working: true }], recaps: [], sessionLimits: [] }).moved).toBe(true);
    expect(applyLiveTick([agent('a', { working: true })], { agents: [], recaps: [], sessionLimits: [] }).moved).toBe(true);
  });

  it('folds in a recap that changed and stamps its arrival, and leaves an unchanged one alone', () => {
    const rows = [agent('a', { recap: 'old', recapAt: '1' }), agent('b', { recap: 'same', recapAt: '1', recapArrivedAt: 5 })];
    const result = applyLiveTick(rows, {
      agents: [], sessionLimits: [],
      recaps: [{ id: 'a', recap: 'new', recapAt: '2' }, { id: 'b', recap: 'same', recapAt: '1' }],
    }, 1000);
    expect(result.changed).toBe(true);
    expect(result.agents[0]).toMatchObject({ recap: 'new', recapAt: '2', recapArrivedAt: 1000 });
    expect(result.agents[1]).toMatchObject({ recap: 'same', recapArrivedAt: 5 });
  });

  it('adds, updates and drops a session limit by its version', () => {
    const limit = { hitAt: 'h', resetAt: 'r', resumeReady: false };
    const added = applyLiveTick([agent('a')], { agents: [], recaps: [], sessionLimits: [{ id: 'a', ...limit }] });
    expect(added.changed).toBe(true);
    expect(added.agents[0]!.sessionLimit).toEqual(limit);
    const same = applyLiveTick(added.agents, { agents: [], recaps: [], sessionLimits: [{ id: 'a', ...limit }] });
    expect(same.changed).toBe(false);
    const ready = applyLiveTick(added.agents, { agents: [], recaps: [], sessionLimits: [{ id: 'a', ...limit, resumeReady: true }] });
    expect(ready.agents[0]!.sessionLimit?.resumeReady).toBe(true);
    const dropped = applyLiveTick(added.agents, { agents: [], recaps: [], sessionLimits: [] });
    expect(dropped.changed).toBe(true);
    expect(dropped.agents[0]!.sessionLimit).toBeUndefined();
  });

  it('raises, changes and clears the durable job count on a row that stood still', () => {
    // Note #588: a job starting or finishing moves no other fact about the
    // agent, so before this the plate waited for a navigation to hear of it.
    const idle = [agent('a'), agent('b', { activeJobs: 1 })];
    const started = applyLiveTick(idle, { agents: [], recaps: [], sessionLimits: [], jobs: [{ id: 'a', count: 2 }, { id: 'b', count: 1 }] });
    expect(started.changed).toBe(true);
    expect(started.moved).toBe(false);
    expect(started.agents[0]!.activeJobs).toBe(2);
    expect(started.agents[1]!.activeJobs).toBe(1);

    const same = applyLiveTick(started.agents, { agents: [], recaps: [], sessionLimits: [], jobs: [{ id: 'a', count: 2 }, { id: 'b', count: 1 }] });
    expect(same.changed).toBe(false);

    // Absent from the list is the answer "none", and the plate loses its row
    // rather than keeping a count nothing is behind any more.
    const finished = applyLiveTick(started.agents, { agents: [], recaps: [], sessionLimits: [], jobs: [{ id: 'a', count: 1 }] });
    expect(finished.changed).toBe(true);
    expect(finished.agents[0]!.activeJobs).toBe(1);
    expect(finished.agents[1]!).not.toHaveProperty('activeJobs');
  });

  it('raises and clears the finished verdict on a row that stood still, and keeps it through silence', () => {
    // Note #707: the verdict is written seconds after the turn ends, after the
    // full read the turn end bought — so it rides the tick, like the recap.
    const idle = [agent('a'), agent('b', { finished: true })];
    const raised = applyLiveTick(idle, { agents: [], recaps: [], sessionLimits: [], finished: ['a', 'b'] });
    expect(raised.changed).toBe(true);
    expect(raised.moved).toBe(false);
    expect(raised.agents.map((row) => row.finished)).toEqual([true, true]);
    expect(applyLiveTick(raised.agents, { agents: [], recaps: [], sessionLimits: [], finished: ['a', 'b'] }).changed).toBe(false);

    const cleared = applyLiveTick(raised.agents, { agents: [], recaps: [], sessionLimits: [], finished: ['a'] });
    expect(cleared.changed).toBe(true);
    expect(cleared.agents[1]!).not.toHaveProperty('finished');

    // An older backend says nothing about it: nothing is wiped.
    const silent = applyLiveTick(raised.agents, { agents: [], recaps: [], sessionLimits: [] });
    expect(silent.changed).toBe(false);
    expect(silent.agents.map((row) => row.finished)).toEqual([true, true]);
  });

  it('leaves every count alone when the answer says nothing about jobs', () => {
    // A page open across a backend release older than note #588: silence is
    // not "nothing is running", and wiping the plates on it would be a lie
    // the next full read has to undo.
    const result = applyLiveTick([agent('a', { activeJobs: 3 })], { agents: [], recaps: [], sessionLimits: [] });
    expect(result.changed).toBe(false);
    expect(result.agents[0]!.activeJobs).toBe(3);
  });

  it('patches a note claim in place and leaves a proposal ahead of it', () => {
    const claim = { state: 'working' as const, agentName: 'Kai', agentId: 'kai', expiresAt: 'later' };
    const started = applyLiveNoteClaims(
      [quickNote('n1', { state: 'handed', agentName: 'Kai' }), quickNote('n2', { state: 'proposal', proposalNumber: 12 })],
      [{ id: 'n1', work: claim }, { id: 'n2', work: claim }],
    );
    expect(started.changed).toBe(true);
    expect(started.reload).toBe(false);
    expect(started.notes?.[0]!.work).toEqual(claim);
    expect(started.notes?.[1]!.work).toEqual({ state: 'proposal', proposalNumber: 12 });
    expect(applyLiveNoteClaims(started.notes, [{ id: 'n1', work: claim }]).changed).toBe(false);
  });

  it('asks for one authoritative read when a painted claim disappears', () => {
    const rows = [quickNote('n1', { state: 'working', agentName: 'Kai', expiresAt: 'later' })];
    const ended = applyLiveNoteClaims(rows, []);
    expect(ended.changed).toBe(false);
    expect(ended.reload).toBe(true);
    expect(ended.notes).toBe(rows);
    // An old backend's silence is not the answer "the claim ended".
    expect(applyLiveNoteClaims(rows, undefined)).toEqual({ notes: rows, changed: false, reload: false });
  });
});

describe('a full read', () => {
  it('marks only recap versions that arrived after the opening state', () => {
    const opened = carryAgentRecapArrivals([agent('a', { recap: 'first', recapAt: '1' }), agent('b')], null, 10);
    expect(opened[0]!.recapArrivedAt).toBeUndefined();
    const later = carryAgentRecapArrivals(
      [agent('a', { recap: 'second', recapAt: '2' }), agent('b', { recap: 'born' })],
      [{ ...opened[0]!, recapArrivedAt: undefined }, { ...opened[1]!, recapArrivedAt: 4 }],
      20,
    );
    expect(later[0]!.recapArrivedAt).toBe(20);
    // b had no recap before and has one now: that is an arrival too.
    expect(later[1]!.recapArrivedAt).toBe(20);
    const unchanged = carryAgentRecapArrivals([agent('a', { recap: 'second', recapAt: '2' })], later, 30);
    expect(unchanged[0]!.recapArrivedAt).toBe(20);
  });

  it('finds the one agent a name belongs to, and refuses to guess between two', () => {
    const fleet = [agent('a', { name: 'Oscar' }), agent('b', { name: 'Felix' }), agent('c', { name: 'Oscar' })];
    // The name as a transcript carries it: the sender's own, and the same
    // trimmed, case-insensitive match `agentbuilt agent message` makes.
    expect(agentNamed([fleet[0]!, fleet[1]!], ' oscar ')!.id).toBe('a');
    expect(agentNamed([fleet[0]!, fleet[1]!], 'Felix')!.id).toBe('b');
    // Two agents answer to it: no answer beats the wrong one.
    expect(agentNamed(fleet, 'Oscar')).toBeNull();
    // Nobody by that name, nothing to look in, nothing to look for.
    expect(agentNamed(fleet, 'Nobody')).toBeNull();
    expect(agentNamed(null, 'Oscar')).toBeNull();
    expect(agentNamed(fleet, '  ')).toBeNull();
  });
});

describe('unread conversations', () => {
  it('groups direct replies per visible agent, newest first, and ignores the rest', () => {
    const agents = [agent('a'), agent('b')];
    const rows = groupUnreadConversations([
      notification({ notificationId: '1', url: '/chat/a', createdAt: '2026-09-02T10:00:00Z' }),
      notification({ notificationId: '2', url: '/chat/a', createdAt: '2026-09-02T11:00:00Z' }),
      notification({ notificationId: '3', url: '/chat/b', createdAt: '2026-09-02T12:00:00Z' }),
      notification({ notificationId: '4', url: '/chat/b', readAt: 'x' }),
      notification({ notificationId: '5', url: '/chat/zed' }),
      notification({ notificationId: '6', url: '/chat/a', source: undefined }),
      notification({ notificationId: '7', url: '/agents/a' }),
      notification({ notificationId: '8', url: 'https://elsewhere.test/chat/a' }),
      notification({ notificationId: '9', url: '/chat/a', kind: 'approval_required' }),
    ], agents, ORIGIN);
    expect(rows.map((row) => [row.agent.id, row.count, row.latestAt])).toEqual([
      ['b', 1, '2026-09-02T12:00:00Z'],
      ['a', 2, '2026-09-02T11:00:00Z'],
    ]);
  });

  it('says something waits on the reader by a decision they can take or an unread direct reply from their agent', () => {
    // One question about the workplace since note #843; it was asked room by
    // room (`roomNeedsAttention`) while there were rooms.
    const agents = [agent('a')];
    expect(readerNeedsAttention(agents, [], ORIGIN, 0)).toBe(false);
    expect(readerNeedsAttention(agents, [], ORIGIN, 1)).toBe(true);
    expect(readerNeedsAttention(agents, [notification({ url: '/chat/a' })], ORIGIN, 0)).toBe(true);
    // Not a reply already read, not a reply from an agent that is not theirs,
    // and not a completion the agent's own chat did not send.
    expect(readerNeedsAttention(agents, [notification({ url: '/chat/a', readAt: 'x' })], ORIGIN, 0)).toBe(false);
    expect(readerNeedsAttention(agents, [notification({ url: '/chat/zed' })], ORIGIN, 0)).toBe(false);
    expect(readerNeedsAttention(agents, [notification({ url: '/chat/a', source: undefined })], ORIGIN, 0)).toBe(false);
    expect(readerNeedsAttention(null, [notification({ url: '/chat/a' })], ORIGIN, 0)).toBe(false);
  });

  it('previews a reply as plain words, never as markup', () => {
    expect(markdownPreview('**Done** — see [the page](https://x.test) and `npm test`\n\n- one\n- two')).toBe('Done — see the page and npm test one two');
    expect(markdownPreview('# Heading\n```js\ncode\n```\n> quoted')).toBe('Heading quoted');
  });
});
