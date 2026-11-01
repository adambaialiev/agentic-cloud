import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FoldLong } from './FoldLong.js';

/**
 * The browser as it really answers: the clipped `.md` reports its whole
 * content, and any box around it reports only what shows — the 310px the
 * stylesheet leaves once the fold is on. jsdom lays nothing out, so this is
 * the part of the browser the fold depends on.
 */
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get(this: HTMLElement) {
    if (this.classList.contains('md')) return 900;
    if (this.querySelector('.md')) return this.closest('.mdwrap.folded') ? 310 : 900;
    return 0;
  } });
});
afterEach(() => { delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight; });

/** A new children element on every render, the way Home's card hands one over. */
function Parent({ boxed, tick }: { boxed: boolean; tick: number }) {
  const md = <div className="md" data-tick={tick}>A long reply.</div>;
  return <FoldLong contentKey="a long reply">{boxed ? <div className="agentlastbody">{md}</div> : md}</FoldLong>;
}

describe('the fold (note #461)', () => {
  it.each([['the write-up itself', false], ['a box around the write-up', true]])(
    'holds still when the page re-renders, with %s inside it', (_, boxed) => {
      const { container, rerender } = render(<Parent boxed={boxed} tick={0} />);
      expect(container.querySelector('.mdwrap.folded')).toBeTruthy();
      // Home re-renders on every poll and every "5m ago" tick. The fold used
      // to measure the box, read 310 back, unfold, then fold again next time.
      for (let tick = 1; tick <= 4; tick++) {
        rerender(<Parent boxed={boxed} tick={tick} />);
        expect(container.querySelector('.mdwrap.folded .readmore')).toBeTruthy();
      }
      fireEvent.click(screen.getByRole('button', { name: 'Read more' }));
      rerender(<Parent boxed={boxed} tick={5} />);
      expect(container.querySelector('.mdwrap.folded')).toBeNull();
    });

  it('leaves the fold as it was when the node has no layout at all', () => {
    const { container, rerender } = render(<Parent boxed={false} tick={0} />);
    expect(container.querySelector('.mdwrap.folded')).toBeTruthy();
    // A hidden screen answers 0 for every height: no answer, not "short".
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 0 });
    rerender(<Parent boxed={false} tick={1} />);
    expect(container.querySelector('.mdwrap.folded')).toBeTruthy();
  });
});
