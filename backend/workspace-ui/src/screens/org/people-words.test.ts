import { describe, expect, it } from 'vitest';
import type { WorkspaceOrgMember } from '../../../../src/shared/workspace-api.js';
import { applyPeopleLive, formerAgentsLine, peopleClockMoves, peopleInOrder, peopleSubLine, peopleWorkedLine, personAgentCountLine, personFactsLine, personRecapAgo, personStatusLine } from './people-words.js';

const now = Date.parse('2026-09-05T12:00:00.000Z');
const person = (overrides: Partial<WorkspaceOrgMember> & { userId: string }): WorkspaceOrgMember => ({
  name: overrides.userId, you: false, role: 'member', joinedAt: '2026-08-01T00:00:00.000Z', agents: 0, workedMs: 0,
  ...overrides,
});

describe('the words on a person’s row', () => {
  it('says here now, else when they were last, else when they joined', () => {
    expect(personStatusLine({ here: true, lastSeenAt: 'x', joinedAt: 'y' }, now)).toBe('Here now');
    expect(personStatusLine({ lastSeenAt: new Date(now - 4 * 60_000).toISOString(), joinedAt: 'y' }, now)).toBe('Active 4m ago');
    expect(personStatusLine({ joinedAt: new Date(now - 2 * 86_400_000).toISOString() }, now)).toBe('Joined 2d ago');
    expect(personStatusLine({ joinedAt: new Date(now + 60_000).toISOString() }, now)).toBe('Just joined');
  });

  it('places the latest line in time, as an ago (note #385)', () => {
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(personRecapAgo({ recap: 'Messaged Ruby', recapAt: at(30_000) }, now)).toBe('just now');
    expect(personRecapAgo({ recap: 'Messaged Ruby', recapAt: at(5 * 60_000) }, now)).toBe('5m ago');
    expect(personRecapAgo({ recap: 'Messaged Ruby', recapAt: at(3 * 3_600_000) }, now)).toBe('3h ago');
    expect(personRecapAgo({ recap: 'Messaged Ruby', recapAt: at(2 * 86_400_000) }, now)).toBe('2d ago');
    // No line to place, and no stamp to place it with: nothing is drawn
    // rather than a stamp with nothing above it or a line dated by guess.
    expect(personRecapAgo({ recapAt: at(60_000) }, now)).toBe('');
    expect(personRecapAgo({ recap: 'Messaged Ruby' }, now)).toBe('');
    // A server clock a second ahead of the browser is the common case for a
    // stamp written this instant; it reads as just now, never as nothing.
    expect(personRecapAgo({ recap: 'Messaged Ruby', recapAt: at(-1_000) }, now)).toBe('just now');
    expect(personRecapAgo({ recap: 'Messaged Ruby', recapAt: 'not a time' }, now)).toBe('just now');
  });

  it('runs the clock exactly while a row says something that moves', () => {
    const seen = new Date(now - 60_000).toISOString();
    expect(peopleClockMoves([])).toBe(false);
    // Here now, nothing driven yet: both readings stand still.
    expect(peopleClockMoves([{ here: true, lastSeenAt: seen }])).toBe(false);
    expect(peopleClockMoves([{ lastSeenAt: seen }])).toBe(true);
    // Here now, but their latest line is aging on the plate.
    expect(peopleClockMoves([{ here: true, lastSeenAt: seen, recap: 'Messaged Ruby', recapAt: seen }])).toBe(true);
    // A recap with no stamp draws no ago, so it must not start the clock.
    expect(peopleClockMoves([{ here: true, lastSeenAt: seen, recap: 'Messaged Ruby' }])).toBe(false);
  });

  it('names the role and the agents they drive', () => {
    expect(personFactsLine({ role: 'admin', agents: 3 })).toBe('Admin · 3 agents');
    expect(personFactsLine({ role: 'member', agents: 1 })).toBe('Member · 1 agent');
    expect(personFactsLine({ role: 'member', agents: 0 })).toBe('Member · no agents');
  });

  it('says how many agents somebody drives, and never which (note #346)', () => {
    expect(personAgentCountLine(3)).toBe('3 agents');
    expect(personAgentCountLine(1)).toBe('1 agent');
    // Never a bare "0" under an AGENTS label: the member screen's value is
    // read as a sentence, like every other value on that card.
    expect(personAgentCountLine(0)).toBe('No agents yet');
  });

  it('counts the people and how many are here', () => {
    expect(peopleSubLine([{ here: true }])).toBe('Just you');
    expect(peopleSubLine([{ here: true }, {}, {}])).toBe('3 people · 1 here now');
    expect(peopleSubLine([{}, {}])).toBe('2 people');
  });

  it('folds a tick over the rows in place and says whether anything moved', () => {
    const rows = [person({ userId: 'a', lastSeenAt: 't1' }), person({ userId: 'b', recap: 'Messaged Ruby', recapAt: 't0' })];
    const still = applyPeopleLive(rows, [{ userId: 'a', lastSeenAt: 't1' }, { userId: 'b', recap: 'Messaged Ruby', recapAt: 't0' }]);
    expect(still.changed).toBe(false);
    expect(still.people).toBe(rows);
    const moved = applyPeopleLive(rows, [{ userId: 'a', lastSeenAt: 't2', here: true }, { userId: 'b', recap: 'Messaged Ruby', recapAt: 't0' }]);
    expect(moved.changed).toBe(true);
    expect(moved.people[0]).toMatchObject({ userId: 'a', lastSeenAt: 't2', here: true, name: 'a' });
    expect(moved.people[1]).toBe(rows[1]);
    // A tick that no longer carries a fact takes it off the row.
    const gone = applyPeopleLive(moved.people, [
      { userId: 'a', lastSeenAt: 't2' }, { userId: 'b', recap: 'Messaged Ruby', recapAt: 't0' },
    ]);
    expect(gone.people[0]!.here).toBeUndefined();
  });

  it('drops a row the tick no longer carries, because that person has left', () => {
    const rows = [person({ userId: 'a', here: true }), person({ userId: 'b', here: true })];
    // The tick answers with every current member, so an absent row is a
    // membership that ended — not a fact the answer happened to omit.
    const left = applyPeopleLive(rows, [{ userId: 'a', here: true }]);
    expect(left.changed).toBe(true);
    expect(left.people.map((row) => row.userId)).toEqual(['a']);
    // A tick still cannot ADD anybody: a new member's name, face and agent
    // count only arrive with the next full read.
    const joined = applyPeopleLive(left.people, [{ userId: 'a', here: true }, { userId: 'c', here: true }]);
    expect(joined.people.map((row) => row.userId)).toEqual(['a']);
  });

  it('leads with the people here, then the most recently seen, then by joining', () => {
    const order = peopleInOrder([
      person({ userId: 'old', joinedAt: '2026-07-01T00:00:00.000Z' }),
      person({ userId: 'seen', lastSeenAt: '2026-09-05T11:00:00.000Z' }),
      person({ userId: 'here', lastSeenAt: '2026-09-05T10:00:00.000Z', here: true }),
      person({ userId: 'new', joinedAt: '2026-09-01T00:00:00.000Z' }),
    ]).map((entry) => entry.userId);
    expect(order).toEqual(['here', 'seen', 'old', 'new']);
  });

  it('names the agents no longer here whose hours are in their total (note #644)', () => {
    expect(formerAgentsLine({})).toBe('');
    expect(formerAgentsLine({ formerAgents: [] })).toBe('');
    expect(formerAgentsLine({ formerAgents: [{ name: 'Ruby', workedMs: 11_400_000 }] })).toBe('including Ruby 3h 10m, no longer here');
    expect(formerAgentsLine({ formerAgents: [{ name: 'Ruby', workedMs: 11_400_000 }, { name: 'Max', workedMs: 720_000 }, { name: 'Kit', workedMs: 60_000 }] }))
      .toBe('including Ruby 3h 10m, Max 12m and Kit 1m, no longer here');
    expect(peopleWorkedLine(null)).toBe('');
    expect(peopleWorkedLine({ workedMs: 0 })).toBe('');
    expect(peopleWorkedLine({ workedMs: 41 * 3_600_000 + 20 * 60_000 })).toBe('agents worked 1d 17h');
    expect(peopleWorkedLine({ workedMs: 14 * 3_600_000 + 20 * 60_000 })).toBe('agents worked 14h 20m');
  });
});
