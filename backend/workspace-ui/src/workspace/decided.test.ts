import { describe, expect, it } from 'vitest';
import { decidedHere, markDecided, stillWaiting } from './decided.js';

describe('the proposals decided in this tab (note #743)', () => {
  it('takes a decided proposal out of every waiting list, by kind', () => {
    markDecided('pr', 'p1', 'merged');
    markDecided('knowledge', 'k1', 'rejected');
    expect(stillWaiting('pr', [{ id: 'p1' }, { id: 'p2' }, { id: 'k1' }])).toEqual([{ id: 'p2' }, { id: 'k1' }]);
    expect(stillWaiting('knowledge', [{ id: 'k1' }, { id: 'p1' }])).toEqual([{ id: 'p1' }]);
    expect(decidedHere('pr', 'p1')).toBe('merged');
    expect(decidedHere('knowledge', 'k1')).toBe('rejected');
  });

  it('decides nothing on an answer that leaves the proposal open', () => {
    // A refused merge (a conflict, a stale branch) answers `open`, and a flow
    // that declined to act answers nothing: the proposal still waits.
    markDecided('pr', 'p3', 'open');
    markDecided('pr', 'p4', null);
    markDecided('pr', 'p5', undefined);
    expect(stillWaiting('pr', [{ id: 'p3' }, { id: 'p4' }, { id: 'p5' }])).toHaveLength(3);
    expect(decidedHere('pr', 'p3')).toBeUndefined();
  });
});
