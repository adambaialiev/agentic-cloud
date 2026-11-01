import { describe, expect, it } from 'vitest';
import { turnRecapOf } from '../../shared/turn-recap.js';

/**
 * Note #945: what the chat's recap line is read from — the agent record's
 * turn stamps and its row recap, ONE source with the fleet row.
 */
describe('the latest completed turn and its recap (note #945)', () => {
  const turn = { lastTurnStartedAt: '2026-11-01T20:38:00.000Z', lastTurnEndedAt: '2026-11-01T20:38:12.000Z' };

  it('is nothing for a record with no turn on it', () => {
    expect(turnRecapOf(undefined)).toBeUndefined();
    expect(turnRecapOf({ recap: { text: 'Keeps the shop site.', at: '2026-11-01T20:00:00.000Z' } })).toBeUndefined();
  });

  it('carries the recap a summary wrote for this turn — a checkpoint during it, or the summary after it', () => {
    expect(turnRecapOf({ ...turn, recap: { text: 'Drafting the DNS records.', at: '2026-11-01T20:38:05.000Z' } }))
      .toEqual({ startedAt: turn.lastTurnStartedAt, endedAt: turn.lastTurnEndedAt, recap: 'Drafting the DNS records.' });
    expect(turnRecapOf({ ...turn, recap: { text: 'Paused on DNS.', at: '2026-11-01T20:38:40.000Z' } })?.recap).toBe('Paused on DNS.');
  });

  it('carries no recap until this turn\'s summary has arrived: an older one is the turn before\'s', () => {
    expect(turnRecapOf({ ...turn, recap: { text: 'Shipped the pricing page.', at: '2026-11-01T19:00:00.000Z' } }))
      .toEqual({ startedAt: turn.lastTurnStartedAt, endedAt: turn.lastTurnEndedAt });
  });

  it('counts a summary that came back with the same words, by when it came back', () => {
    expect(turnRecapOf({
      ...turn,
      recap: { text: 'Keeps the shop site.', at: '2026-11-01T19:00:00.000Z' },
      recapCheckedAt: '2026-11-01T20:38:30.000Z',
    })?.recap).toBe('Keeps the shop site.');
  });

  it('for a turn whose start was never stamped, waits for the summary after its end', () => {
    const ended = { lastTurnEndedAt: turn.lastTurnEndedAt };
    expect(turnRecapOf({ ...ended, recap: { text: 'Mid-turn words.', at: '2026-11-01T20:38:05.000Z' } }))
      .toEqual({ endedAt: turn.lastTurnEndedAt });
    expect(turnRecapOf({ ...ended, recap: { text: 'After.', at: '2026-11-01T20:38:30.000Z' } }))
      .toEqual({ endedAt: turn.lastTurnEndedAt, recap: 'After.' });
    // A start stamped AFTER the end is a different turn's: ignored.
    expect(turnRecapOf({ ...ended, lastTurnStartedAt: '2026-11-01T21:00:00.000Z' })).toEqual({ endedAt: turn.lastTurnEndedAt });
  });
});
