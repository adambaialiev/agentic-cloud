import { describe, expect, it } from 'vitest';
import {
  PERSON_HERE_WINDOW_MS,
  PERSON_RECAP_MAX_LENGTH,
  personActionLines,
  personIsHere,
  personLiveFields,
  personRecapText,
} from '../../services/person-recap.js';

/**
 * The People page's pure half (note #328): when a person counts as here,
 * what the row receives, and the lines the action routes write.
 */
describe('person recap', () => {
  const now = Date.parse('2026-09-05T12:00:00.000Z');

  it('is here while the seen-stamp is inside the window, and not a moment longer', () => {
    expect(personIsHere(undefined, now)).toBe(false);
    expect(personIsHere('not a date', now)).toBe(false);
    expect(personIsHere(new Date(now - PERSON_HERE_WINDOW_MS + 1000).toISOString(), now)).toBe(true);
    expect(personIsHere(new Date(now - PERSON_HERE_WINDOW_MS).toISOString(), now)).toBe(false);
  });

  it('sends absent fields, never empty ones, so `here` is a fact and not a false', () => {
    expect(personLiveFields({}, now)).toEqual({});
    const seen = new Date(now - 10_000).toISOString();
    expect(personLiveFields({ lastSeenAt: seen, recap: { text: 'Messaged Ruby', at: seen } }, now))
      .toEqual({ lastSeenAt: seen, here: true, recap: 'Messaged Ruby', recapAt: seen });
    const stale = new Date(now - 3 * 3600_000).toISOString();
    const fields = personLiveFields({ lastSeenAt: stale, recap: { text: '', at: stale } }, now);
    expect(fields).toEqual({ lastSeenAt: stale });
    expect(fields).not.toHaveProperty('here');
  });

  it('writes plain facts that every member can already see — never the message itself', () => {
    expect(personActionLines.messaged('Ruby')).toBe('Messaged Ruby');
    expect(personActionLines.messaged(undefined)).toBe('Messaged an agent');
    expect(personActionLines.decidedProposal('approve', 634, 'Subscription item active dot'))
      .toBe('Approved proposal #634: Subscription item active dot');
    expect(personActionLines.decidedProposal('reject', 7, '')).toBe('Rejected proposal #7');
    expect(personActionLines.decidedKnowledge('approve', 87, 'When a machine sleeps'))
      .toBe('Approved knowledge proposal #87: When a machine sleeps');
    expect(personActionLines.wroteNote(328, 'Workplace people page')).toBe('Wrote note #328: Workplace people page');
    expect(personActionLines.handedNote(328, 'Ruby')).toBe('Handed note #328 to Ruby');
  });

  it('keeps the verb and the number when a title runs long, and the row length overall', () => {
    const title = 'A very long proposal title that keeps going on and on about the pricing page redesign and more';
    const line = personActionLines.decidedProposal('approve', 12, title);
    expect(line.startsWith('Approved proposal #12: A very long proposal title')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(PERSON_RECAP_MAX_LENGTH);
    expect(personRecapText('  tabs\tand\nnewlines  ')).toBe('tabs and newlines');
    expect(personRecapText('x'.repeat(200)).length).toBe(PERSON_RECAP_MAX_LENGTH);
  });
});
