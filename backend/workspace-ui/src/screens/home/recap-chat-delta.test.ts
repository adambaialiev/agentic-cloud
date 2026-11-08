import { afterEach, describe, expect, it } from 'vitest';
import type { RecapChatAnswer, RecapChatDeltaAnswer, RecapMessage } from '../../../../src/shared/workspace-recap-chat.js';
import { forgetRecapChatReads, markRecapChatRead, RECAP_WHOLE_READ_AFTER_MS, recapChatPath, recapChatWantsWhole, wholeRecapAnswer } from './recap-chat-delta.js';

/** Note #1071: the page's half of reading only what is new. */
const row = (id: string, text = `row ${id}`): RecapMessage => ({ id, role: 'assistant', text, at: '2026-11-08T12:00:00.000Z' });
const held: RecapChatAnswer = { orgId: 'o1', working: true, phase: 'Thinking…', waiting: [], version: 'v1', messages: [row('a'), row('b'), row('c')] };
const delta = (since: string, rows: RecapMessage[], removed: string[] = [], extra: Partial<RecapChatDeltaAnswer> = {}): RecapChatDeltaAnswer => ({
  orgId: 'o1', working: false, waiting: [], version: 'v2', delta: { since, rows, removed }, ...extra,
});
afterEach(() => forgetRecapChatReads());

describe('wholeRecapAnswer', () => {
  it('takes a whole answer as it came', () => {
    const whole: RecapChatAnswer = { orgId: 'o1', working: false, waiting: [], version: 'v9', messages: [row('z')] };
    expect(wholeRecapAnswer(held, whole)).toBe(whole);
  });
  it('lays a delta over what is held: changed rows in place, new ones at the end, gone ones out, and the small state from the delta', () => {
    const next = wholeRecapAnswer(held, delta('v1', [row('b', 'b, now merged'), row('d')], ['c']))!;
    expect(next.messages.map((m) => [m.id, m.text])).toEqual([['a', 'row a'], ['b', 'b, now merged'], ['d', 'row d']]);
    expect(next.messages[0]).toBe(held.messages[0]);
    expect(next).toMatchObject({ version: 'v2', working: false });
    expect(next).not.toHaveProperty('phase');
    expect(next).not.toHaveProperty('delta');
  });
  it('an empty delta keeps every row object', () => {
    const next = wholeRecapAnswer(held, delta('v1', []))!;
    next.messages.forEach((m, at) => expect(m).toBe(held.messages[at]));
  });
  it('a delta from a version this tab does not hold, or with nothing held, is refused', () => {
    expect(wholeRecapAnswer(held, delta('v0', [row('d')]))).toBeNull();
    expect(wholeRecapAnswer(null, delta('v1', [row('d')]))).toBeNull();
  });
});

describe('when a read names a version', () => {
  it('names the held version, and none when asked to start again or nothing held has one', () => {
    expect(recapChatPath('api/recap/chat', held, false)).toBe('api/recap/chat?since=v1');
    expect(recapChatPath('api/recap/chat', held, true)).toBe('api/recap/chat');
    expect(recapChatPath('api/recap/chat', { ...held, version: undefined }, false)).toBe('api/recap/chat');
    expect(recapChatPath('api/recap/chat', null, false)).toBe('api/recap/chat');
  });
  it('asks whole before any good read, and again after a minute without one', () => {
    expect(recapChatWantsWhole('o1', 1_000)).toBe(true);
    markRecapChatRead('o1', 1_000);
    expect(recapChatWantsWhole('o1', 1_000 + RECAP_WHOLE_READ_AFTER_MS)).toBe(false);
    expect(recapChatWantsWhole('o1', 1_001 + RECAP_WHOLE_READ_AFTER_MS)).toBe(true);
    expect(recapChatWantsWhole('o2', 1_000)).toBe(true);
  });
});
