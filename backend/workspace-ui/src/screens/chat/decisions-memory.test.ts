import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDecisionsAnswer } from '../../../../src/shared/workspace-api.js';
import { DECISIONS_KEPT_MS, forgetHeldDecisions, heldDecisions, holdDecisions } from './decisions-memory.js';

const answer = (): WorkspaceDecisionsAnswer => ({
  prs: [{
    id: 'pr-1', number: 4, repoName: 'shop', title: 'Add checkout', body: 'A long write-up.', from: 'checkout', to: 'main',
    status: 'open', createdAt: 't', decidedAt: null, agentName: 'Felix', agentId: 'felix', canDecide: true,
  }] as WorkspaceDecisionsAnswer['prs'],
  knowledgeProposals: [{
    id: 'kp-3', number: 3, title: 'Fractions handbook', status: 'open', pages: ['fractions'],
    createdAt: 't', agentName: 'Bo', agentId: 'bo', canDecide: true,
  }] as WorkspaceDecisionsAnswer['knowledgeProposals'],
});

afterEach(() => { vi.useRealTimers(); });

describe('the agents sheet\'s waiting list, remembered (note #745)', () => {
  it('gives back what was last read for this workplace, and nothing for another', () => {
    holdDecisions('o1', answer());
    expect(heldDecisions('o1')?.prs.map((row) => row.title)).toEqual(['Add checkout']);
    expect(heldDecisions('o1')?.knowledgeProposals.map((row) => row.title)).toEqual(['Fractions handbook']);
    expect(heldDecisions('o2')).toBeNull();
    expect(heldDecisions('')).toBeNull();
  });

  it('keeps only what a row draws, never the write-up', () => {
    holdDecisions('o1', answer());
    expect(heldDecisions('o1')?.prs[0]?.body).toBeNull();
    expect(window.sessionStorage.getItem('agentbuilt.waitingDecisions')).not.toContain('A long write-up');
  });

  it('survives a reload of the tab, and so does the record of what was decided in it', async () => {
    holdDecisions('o1', answer());
    const decided = await import('../../workspace/decided.js');
    decided.markDecided('pr', 'pr-1', 'merged');
    // A reload: every module comes up fresh, the tab's storage does not.
    vi.resetModules();
    const memory = await import('./decisions-memory.js');
    const record = await import('../../workspace/decided.js');
    const remembered = memory.heldDecisions('o1');
    expect(remembered?.prs.map((row) => row.id)).toEqual(['pr-1']);
    expect(record.stillWaiting('pr', remembered!.prs)).toEqual([]);
    expect(record.decidedHere('pr', 'pr-1')).toBe('merged');
    memory.forgetHeldDecisions();
    record.forgetDecided();
  });

  it('draws nothing from a list too old to mean anything', () => {
    vi.useFakeTimers();
    holdDecisions('o1', answer());
    vi.advanceTimersByTime(DECISIONS_KEPT_MS + 1);
    expect(heldDecisions('o1')).toBeNull();
  });

  it('forgets all of it on sign-out', () => {
    holdDecisions('o1', answer());
    forgetHeldDecisions();
    expect(heldDecisions('o1')).toBeNull();
    expect(window.sessionStorage.getItem('agentbuilt.waitingDecisions')).toBeNull();
  });
});
