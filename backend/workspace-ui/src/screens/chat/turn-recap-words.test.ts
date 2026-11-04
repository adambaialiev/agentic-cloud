import { describe, expect, it } from 'vitest';
import { doneAt, recapSentences, showsTurnRecap, turnFacts, workedFor } from './turn-recap-words.js';

describe('the recap line\'s words (note #945)', () => {
  it('says how long a turn worked the way the terminal does', () => {
    expect(workedFor(12_000)).toBe('12s');
    expect(workedFor(184_000)).toBe('3m 4s');
    expect(workedFor(120_000)).toBe('2m');
    expect(workedFor(3_720_000)).toBe('1h 2m');
  });

  it('says when it finished: the clock today, the day before that', () => {
    const now = new Date(2026, 10, 1, 20, 40).getTime();
    const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const today = new Date(2026, 10, 1, 20, 38);
    expect(doneAt(today.toISOString(), now)).toBe(clock(today));
    const yesterday = new Date(2026, 9, 31, 9, 5);
    expect(doneAt(yesterday.toISOString(), now)).toBe(`yesterday ${clock(yesterday)}`);
  });

  it('joins the facts, and names what is still running or awaited', () => {
    const turn = { startedAt: '2026-11-01T20:38:00Z', endedAt: '2026-11-01T20:38:12Z' };
    expect(turnFacts(turn).startsWith('Worked for 12s · done ')).toBe(true);
    expect(turnFacts(turn, { jobs: 2 })).toMatch(/ · 2 background jobs still running$/);
    expect(turnFacts(turn, { waiting: ['Alex', 'Mia'] })).toMatch(/ · waiting on Alex and Mia$/);
    // A turn whose start was never stamped still says when it was done.
    expect(turnFacts({ endedAt: turn.endedAt }).startsWith('Done ')).toBe(true);
  });

  it('stands only under a completed turn that is the conversation\'s latest', () => {
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

describe('the recap, a sentence a line (note #976)', () => {
  it('splits where a sentence ends and keeps every word', () => {
    const recap = "Iris's phone-framed films are live on the agenticcloudcomputer.com home page, verified live. Waiting on you: pick the opening frame! \"Done\" when it lands? (Maybe today.)";
    const sentences = recapSentences(recap);
    expect(sentences).toEqual([
      "Iris's phone-framed films are live on the agenticcloudcomputer.com home page, verified live.",
      'Waiting on you: pick the opening frame!',
      '"Done" when it lands?',
      '(Maybe today.)',
    ]);
    expect(sentences.join(' ')).toBe(recap);
  });
  it('leaves a version, a file name or a lower-case run alone', () => {
    expect(recapSentences('Shipped v1.2 of app.ts to main. e.g. the fix.')).toEqual(['Shipped v1.2 of app.ts to main. e.g. the fix.']);
    expect(recapSentences('One line only')).toEqual(['One line only']);
  });
});
