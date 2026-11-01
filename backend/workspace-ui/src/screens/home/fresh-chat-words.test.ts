import { describe, expect, it } from 'vitest';
import { freshChatsLabel, freshChatsQuestion, freshChatsResult, namesInWords } from './fresh-chat-words.js';

/** Note #707: every sentence the fleet's reset button says (a room's, until
 *  rooms left the product — note #843). */
describe('the reset button’s words', () => {
  it('names people the way a sentence does', () => {
    expect(namesInWords([])).toBe('');
    expect(namesInWords(['Oscar'])).toBe('Oscar');
    expect(namesInWords(['Oscar', 'Ada'])).toBe('Oscar and Ada');
    expect(namesInWords(['Oscar', 'Ada', 'Noah'])).toBe('Oscar, Ada and Noah');
  });

  it('counts on the door', () => {
    expect(freshChatsLabel(1)).toBe('Reset 1 finished agent');
    expect(freshChatsLabel(3)).toBe('Reset 3 finished agents');
  });

  it('asks about one agent by name, and about several by count with every name', () => {
    expect(freshChatsQuestion(['Oscar'])).toEqual({
      title: 'Reset Oscar?',
      message: 'Oscar has finished its work, and nothing is waiting on it. It saves what matters, then starts a fresh chat and answers you there.',
      verb: 'Reset',
    });
    expect(freshChatsQuestion(['Oscar', 'Ada', 'Noah'])).toEqual({
      title: 'Reset 3 finished agents?',
      message: 'Oscar, Ada and Noah have finished their work, and nothing is waiting on them. Each saves what matters, then starts a fresh chat and answers you there.',
      verb: 'Reset 3',
    });
  });

  it('reports who was asked and who was left alone, with the reason', () => {
    expect(freshChatsResult({ asked: [{ id: 'o', name: 'Oscar' }, { id: 'a', name: 'Ada' }], skipped: [] })).toEqual({
      text: 'Asked Oscar and Ada to start a fresh chat — each answers in its own chat.', ok: true,
    });
    expect(freshChatsResult({
      asked: [{ id: 'o', name: 'Oscar' }],
      skipped: [{ id: 'a', name: 'Ada', reason: 'is working right now' }, { id: 'x', reason: 'is no longer on this account' }],
    })).toEqual({
      text: 'Asked Oscar to start a fresh chat — it answers in its chat. Left as they are: Ada is working right now; One agent is no longer on this account.',
      ok: true,
    });
    expect(freshChatsResult({ asked: [], skipped: [{ id: 'a', name: 'Ada', reason: 'has a proposal waiting' }] })).toEqual({
      text: 'Nobody was reset. Left as it is: Ada has a proposal waiting.', ok: false,
    });
  });
});
