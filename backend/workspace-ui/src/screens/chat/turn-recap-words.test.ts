import { describe, expect, it } from 'vitest';
import { showsTurnRecap } from './turn-recap-words.js';

describe('when a turn\'s recap is the newest news (note #945)', () => {
  it('holds only for a completed turn that is the conversation\'s latest', () => {
    const turn = { endedAt: '2026-11-01T20:38:12Z' };
    const reply = { role: 'agent', at: '2026-11-01T20:38:11Z' };
    expect(showsTurnRecap(turn, { busy: false, last: reply, lastReplyAt: reply.at })).toBe(true);
    expect(showsTurnRecap(undefined, { busy: false, last: reply })).toBe(false);
    expect(showsTurnRecap(turn, { busy: true, last: reply })).toBe(false);
    expect(showsTurnRecap(turn, { busy: false })).toBe(false);
    expect(showsTurnRecap(turn, { busy: false, last: { role: 'owner', at: '2026-11-01T20:39:00Z' } })).toBe(false);
    // A reply newer than the turn on record belongs to a turn not stamped yet.
    expect(showsTurnRecap(turn, { busy: false, last: reply, lastReplyAt: '2026-11-01T20:40:00Z' })).toBe(false);
  });
});
