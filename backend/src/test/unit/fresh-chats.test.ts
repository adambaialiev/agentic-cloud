import { describe, expect, it } from 'vitest';
import { agentReadyForFreshChat, agentWorkFinished, freshChatRefusal, type FreshChatRow } from '../../shared/fresh-chats.js';

/**
 * Note #707: who the room's reset button may ask. One definition, read by the
 * page to draw the door and by the server again at the press.
 */
describe('agentWorkFinished', () => {
  it('stands only while the verdict is newer than the last turn end', () => {
    expect(agentWorkFinished({ workFinishedAt: '2026-10-08T10:00:30Z', lastTurnEndedAt: '2026-10-08T10:00:00Z' })).toBe(true);
    // A summary that failed left the previous turn's verdict behind.
    expect(agentWorkFinished({ workFinishedAt: '2026-10-08T10:00:30Z', lastTurnEndedAt: '2026-10-08T11:00:00Z' })).toBe(false);
    expect(agentWorkFinished({ lastTurnEndedAt: '2026-10-08T10:00:00Z' })).toBe(false);
    expect(agentWorkFinished({ workFinishedAt: 'garbage' })).toBe(false);
    // A record from before turn ends were stamped has nothing to be newer than.
    expect(agentWorkFinished({ workFinishedAt: '2026-10-08T10:00:30Z' })).toBe(true);
  });
});

describe('freshChatRefusal', () => {
  const safe: FreshChatRow = {
    id: 'oscar', status: 'ready', finished: true,
    context: { usedPercent: 31, tokens: 310_000, window: 1_000_000, at: 't' },
  };

  it('lets an idle, finished agent with a conversation and nothing waiting through', () => {
    expect(freshChatRefusal(safe)).toBeNull();
    expect(agentReadyForFreshChat(safe)).toBe(true);
    // A live site is not waiting on anything.
    expect(agentReadyForFreshChat({ ...safe, doing: { kind: 'site', count: 1, host: 'shop.agentbuilt.app' } })).toBe(true);
  });

  it('keeps the conversation of anything that can still come back to it, and says why', () => {
    const cases: Array<[Partial<FreshChatRow>, string]> = [
      [{ status: 'needs-seat' }, 'is not ready to run'],
      [{ working: true }, 'is working right now'],
      [{ context: undefined }, 'has no conversation to clear'],
      [{ context: { usedPercent: 0, tokens: 900, window: 1_000_000, at: 't' } }, 'has no conversation to clear'],
      [{ finished: undefined }, 'has work that is not finished'],
      [{ doing: { kind: 'proposal', count: 1, number: 12 } }, 'has a proposal waiting'],
      [{ activeJobs: 1 }, 'has a background job running'],
      [{ sessionLimit: { hitAt: 't', resetAt: 't', resumeReady: false } }, 'is stopped on its subscription limit'],
    ];
    for (const [change, reason] of cases) {
      expect(freshChatRefusal({ ...safe, ...change } as FreshChatRow)).toBe(reason);
    }
    expect(freshChatRefusal(safe, new Set(['oscar']))).toBe('is holding a note it works from');
    expect(freshChatRefusal(safe, new Set(['ada']))).toBeNull();
  });
});
