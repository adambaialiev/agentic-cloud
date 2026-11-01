import { describe, expect, it } from 'vitest';
import type { WorkspaceCheckRow } from '../../../../src/shared/workspace-api.js';
import { checkBucket, checksGreen, checksSide, pipClass, tallyChecks } from './checks.js';
import { deliveryGroups, deliveryStage, deliveryWaiting, DELIVERY_RECENT_MS } from './delivery.js';
import { agentSignature, approveHint, decisionWording, formerAgentSignature, knowledgeDecisionWording, statusPill } from './proposal-words.js';

/** The decision screens' arithmetic and sentences, on their own. */

const check = (over: Partial<WorkspaceCheckRow> = {}): WorkspaceCheckRow => ({
  context: 'ci/checks', state: 'success', startedAt: 't', ...over,
});

describe('what a check means', () => {
  it('pairs every state with the bucket and the colour that state means', () => {
    expect(checkBucket('success')).toBe('passed');
    expect(checkBucket('skipped')).toBe('nothing-to-do');
    expect(checkBucket('pending')).toBe('running');
    expect(checkBucket('superseded')).toBe('no-verdict');
    expect(checkBucket('error')).toBe('failed');
    // Grey covers both "did nothing" and "never reported": neither is green,
    // and neither is a failure.
    expect(['success', 'pending', 'failure', 'superseded', 'skipped'].map(pipClass))
      .toEqual(['ok', 'wait', 'bad', 'skip', 'skip']);
  });

  it('counts what BROKE apart from what merely never ran', () => {
    const tally = tallyChecks([
      check({ state: 'failure' }), check({ state: 'pending' }),
      check({ state: 'superseded' }), check({ state: 'success' }),
    ]);
    expect(tally).toMatchObject({ failing: 1, running: 1, unjudged: 1, passed: 1, worst: 'failure' });
    expect(checksSide([check({ state: 'superseded' })])).toBe('1 never ran');
    expect(checksSide([check(), check()])).toBe('2 passed');
  });

  it('calls a sha CI has not judged yet anything but green', () => {
    expect(checksGreen([])).toBe(false);
    expect(checksGreen([check({ state: 'skipped' }), check()])).toBe(true);
    expect(checksGreen([check({ state: 'superseded' })])).toBe(false);
  });
});

describe('what approving would do, said before it is done', () => {
  const pr = { from: 'agent/x', to: 'main' };

  it('names both branches, and warns without disabling when actions failed', () => {
    expect(approveHint(pr, [])).toBe('Approving merges agent/x into main. Nothing changes until you decide, '
      + 'and the agent hears the outcome either way.');
    expect(approveHint(pr, [check({ state: 'failure' })]))
      .toContain('The actions failed on this change');
  });

  it('says which of the four things a gated repository is waiting on', () => {
    const gated = { ...pr, requireChecks: true };
    expect(approveHint(gated, [])).toContain('None have run for this commit yet');
    expect(approveHint(gated, [check({ state: 'pending' })])).toContain('They are still running');
    expect(approveHint(gated, [check({ state: 'failure' })])).toContain('They are failing');
    expect(approveHint(gated, [check({ state: 'superseded' })])).toContain('One never ran for this commit');
    // Green: the gate says nothing more than the ordinary line.
    expect(approveHint(gated, [check()])).toContain('Approving merges agent/x into main');
  });
});

/**
 * Note #705: a deleted agent's remark used to sign with its driver alone —
 * "Adam B · 7d ago" — and read as the person's own words. Its signature says
 * an agent wrote it, whatever is still known about that agent.
 */
describe('who signs a remark whose agent is gone', () => {
  it('names the agent and its person when both are known', () => {
    expect(formerAgentSignature('Willow', 'Adam B')).toBe('Willow (Adam B), no longer here');
  });

  it('never collapses to the person alone', () => {
    expect(agentSignature(null, 'Adam B')).toBe('Adam B');
    expect(formerAgentSignature(null, 'Adam B')).toBe('Adam B\u2019s agent, no longer here');
  });

  it('still says an agent wrote it when nothing else is known', () => {
    expect(formerAgentSignature('Willow', null)).toBe('Willow, no longer here');
    expect(formerAgentSignature(null, null)).toBe('An agent, no longer here');
  });
});

describe('the status pill', () => {
  it('says what became of the proposal, and when', () => {
    const at = '2026-09-02T10:00:00.000Z';
    expect(statusPill({ status: 'open', decidedAt: null, to: 'main' }, false, '')).toEqual({ tone: 'open', text: 'Waiting for you' });
    expect(statusPill({ status: 'merged', decidedAt: at, to: 'main' }, false, '3m ago'))
      .toEqual({ tone: 'merged', text: 'Merged 3m ago' });
    expect(statusPill({ status: 'rejected', decidedAt: at, to: 'main' }, false, '3m ago'))
      .toEqual({ tone: 'rejected', text: 'Rejected 3m ago' });
    expect(statusPill({ status: 'conflict', decidedAt: null, to: 'main' }, false, ''))
      .toEqual({ tone: 'quiet', text: 'Conflicts with main' });
    expect(statusPill({ status: 'stale', decidedAt: null, to: 'main' }, false, '').text).toBe('Went stale');
    // Merged by auto-merge (note #944): the pill says no person did.
    expect(statusPill({ status: 'merged', decidedAt: at, to: 'main', autoApproved: { at, modeOnAt: at, modeOnByName: 'Adam' } }, false, '3m ago'))
      .toEqual({ tone: 'merged', text: 'Merged automatically 3m ago' });
    // A merge in flight outranks the record underneath it.
    expect(statusPill({ status: 'open', decidedAt: null, to: 'main' }, true, '').text).toBe('Merging');
  });

  it('turns each outcome into the sentence the reader gets', () => {
    expect(decisionWording('merged', 'main', 'Felix')).toBe('Merged into main.');
    expect(decisionWording('rejected', 'main', 'Felix')).toBe('Rejected — tell Felix what to change.');
    expect(decisionWording('rejected', 'main', null)).toBe('Rejected — tell the agent what to change.');
    expect(decisionWording('stale', 'main', 'Felix')).toContain('the branch changed after you were asked');
    expect(decisionWording('conflict', 'main', 'Felix')).toContain('it conflicts with main');
    // No wording at all is what sends the caller to the flow's own guard note.
    expect(decisionWording(null, 'main', 'Felix')).toBeNull();
  });

  it('says the same about a knowledge decision, in that queue’s words', () => {
    expect(knowledgeDecisionWording('approved')).toBe('Published.');
    expect(knowledgeDecisionWording('rejected')).toBe('Rejected — the agent has been told.');
    // A conflict on a page is answered by the flow's own note, which names the
    // page that moved; and an answer with no status at all is a refusal.
    expect(knowledgeDecisionWording('conflict')).toBeNull();
    expect(knowledgeDecisionWording(null)).toBeNull();
  });
});

describe('the landing after approval', () => {
  const base = { branch: 'main', mergedAt: new Date().toISOString(), checks: [], live: false };

  it('splits delivery actions from the landing’s own checks', () => {
    const groups = deliveryGroups({
      ...base,
      checks: [check({ context: 'ci/checks' }), check({ context: 'deploy/prod' })],
    });
    expect(groups.checks.map((row) => row.context)).toEqual(['ci/checks']);
    expect(groups.deploys.map((row) => row.context)).toEqual(['deploy/prod']);
  });

  it('says the later stages are NEXT while the merge itself is running', () => {
    const merging = { ...base, merging: true };
    expect(deliveryStage('checks', [], merging))
      .toMatchObject({ side: 'next', caption: 'Starts after the change lands on main.' });
    expect(deliveryStage('deploys', [], merging))
      .toMatchObject({ side: 'next', caption: 'Starts after the checks on main.' });
  });

  it('waits before it says nothing was reported', () => {
    expect(deliveryStage('checks', [], base)).toMatchObject({ state: 'pending', side: 'waiting' });
    expect(deliveryStage('checks', [], { ...base, settled: true }))
      .toMatchObject({ state: 'skipped', side: 'none', caption: 'No checks reported for this landing.' });
  });

  it('says CI is off at once instead of waiting for rows that cannot come (note #662)', () => {
    const off = { ...base, ci: false };
    expect(deliveryStage('checks', [], off))
      .toMatchObject({ state: 'skipped', side: 'off', caption: 'CI is off for this repository.' });
    expect(deliveryStage('deploys', [], off))
      .toMatchObject({ state: 'skipped', side: 'off', caption: 'Nothing is delivered while CI is off.' });
    // Mid-merge too: the later stages are not "next" when nothing will run.
    expect(deliveryStage('checks', [], { ...off, merging: true })).toMatchObject({ side: 'off' });
    // Nothing to poll for, however fresh the merge.
    expect(deliveryWaiting(off, 0)).toBe(false);
    // Rows that did arrive — CI switched off after they ran — still speak.
    const running = [check({ state: 'pending' })];
    expect(deliveryStage('checks', running, { ...off, checks: running }))
      .toMatchObject({ state: 'pending', side: '1 running' });
    expect(deliveryWaiting({ ...off, checks: running }, 0)).toBe(true);
    // CI on, or a backend too old to say, keeps the waiting it always had.
    expect(deliveryStage('checks', [], { ...base, ci: true })).toMatchObject({ side: 'waiting' });
    expect(deliveryWaiting({ ...base, ci: true }, 0)).toBe(true);
  });

  it('awards Live only once the follow window has settled, never mid-pipeline', () => {
    const live = { ...base, live: true };
    const passed = [check({ context: 'deploy/prod' })];
    expect(deliveryStage('deploys', passed, live)).toMatchObject({ side: '1 complete' });
    expect(deliveryStage('deploys', passed, { ...live, settled: true }))
      .toMatchObject({ side: 'Live', caption: 'This landing reached a live surface.' });
  });

  it('reports failures, runs and jobs that never started, in that order', () => {
    expect(deliveryStage('checks', [check({ state: 'failure' }), check({ state: 'pending' })], base))
      .toMatchObject({ state: 'failure', side: '1 failing' });
    expect(deliveryStage('checks', [check({ state: 'pending' })], base))
      .toMatchObject({ state: 'pending', side: '1 running' });
    expect(deliveryStage('checks', [check({ state: 'superseded' })], base))
      .toMatchObject({ state: 'superseded', side: '1 never ran' });
    expect(deliveryStage('checks', [check({ state: 'skipped' })], base))
      .toMatchObject({ state: 'skipped', side: 'nothing to do' });
  });

  it('keeps asking while a row runs, and stops on a landing old enough to be settled', () => {
    expect(deliveryWaiting({ ...base, checks: [check({ state: 'pending' })] }, 999)).toBe(true);
    expect(deliveryWaiting({ ...base, merging: true }, 0)).toBe(false);
    // Six minutes of silence with no row at all; one quiet minute once the run
    // has spoken.
    expect(deliveryWaiting(base, 71)).toBe(true);
    expect(deliveryWaiting(base, 72)).toBe(false);
    expect(deliveryWaiting({ ...base, checks: [check()] }, 11)).toBe(true);
    expect(deliveryWaiting({ ...base, checks: [check()] }, 12)).toBe(false);
    const old = { ...base, mergedAt: new Date(Date.now() - DELIVERY_RECENT_MS - 1000).toISOString() };
    expect(deliveryWaiting(old, 0)).toBe(false);
  });
});
