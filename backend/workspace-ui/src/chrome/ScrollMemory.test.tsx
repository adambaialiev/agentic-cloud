import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackProvider } from './PageHead.js';
import { placeScroll } from './place-scroll.js';
import { ScrollMemory } from './ScrollMemory.js';
import { recallScroll } from './scroll-memory.js';
import { useBackClaim } from './useBack.js';

/**
 * jsdom has no layout at all, which is exactly why the browser's own clamp is
 * the thing these tests supply by hand: `fakePage` below is a document with a
 * height the test can change and a `scrollTo` that clamps against it the way
 * every real one does. That clamp IS the subject — note #280's landing line
 * and the reading line a Back owes the reader are the same number arriving
 * either side of a screen's late paint.
 *
 * Where a real browser is the only witness — a leaf coming up at its own
 * bottom because the clamp landed somewhere a fake page cannot model — the
 * job belongs to `scripts/verify-workspace-react-scroll.mts`, which measures
 * the same five landings in Chrome.
 */
function fakePage(height = 860) {
  const view = 860;
  let y = 0;
  let deliver: Array<() => void> = [];
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: view });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => height });
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly fire: () => void) {}
    observe() { deliver = [...deliver, this.fire]; }
    disconnect() { deliver = deliver.filter((one) => one !== this.fire); }
  });
  // A browser cannot scroll past what the document holds, and says so by
  // simply landing somewhere else than it was asked.
  vi.stubGlobal('scrollTo', (_x: number, to: number) => {
    y = Math.max(0, Math.min(to, height - view));
    window.dispatchEvent(new Event('scroll'));
  });
  // Nothing left holding the last page. A placement outlives the component
  // that made it by design (note #405) — it ends with the reader, the next
  // navigation, or a timer no test advances — so a leaf's parting placement
  // from the test before would otherwise still be listening here, pulling
  // this page towards a line measured in another document.
  placeScroll(0)();
  return {
    get y() { return y; },
    /** The screen's read lands and the page becomes its full self. */
    grow(next: number) { height = next; deliver.forEach((fire) => fire()); },
    shrink(next: number) { height = next; },
  };
}

/** The reader's own hand on the page.
 *
 *  The flick comes first, because that is the order a browser reports it in
 *  and it is how the shell tells a reader's scroll from a scroll nobody asked
 *  for (note #405). A bare `scrollTo` here would be modelling something the
 *  reader cannot do: move the page while leaving no sign that they touched
 *  it. */
const readerScrolls = (to: number) => {
  fireEvent.touchStart(window);
  window.scrollTo(0, to);
};

function Shell() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <ScrollMemory />
      {/* Which history entry is on screen, so a test can ask the store what
          it has kept for this one rather than for whichever came last. */}
      <span id="entryKey">{location.key}</span>
      <button type="button" onClick={() => navigate('/note')}>open</button>
      <button type="button" onClick={() => navigate(-1)}>back</button>
    </>
  );
}

const entryKey = () => document.getElementById('entryKey')!.textContent!;

function Harness() {
  return <MemoryRouter initialEntries={['/notes']}><Shell /></MemoryRouter>;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('the Workspace scroll', () => {
  it('is the app’s own to place, not the browser’s', () => {
    fakePage();
    render(<Harness />);
    // With `auto` the browser restores an offset of its own after this
    // component has already placed one, and the reader lands below the top of
    // a screen they have never opened (notes #280, #290).
    expect(history.scrollRestoration).toBe('manual');
  });

  it('opens a screen the reader has never been on at its top', () => {
    const page = fakePage(3000);
    render(<Harness />);
    readerScrolls(600);
    expect(page.y).toBe(600);

    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(page.y).toBe(0);
  });

  it('holds the reading line a Back owes until the screen is tall enough to show it', () => {
    const page = fakePage(3000);
    render(<Harness />);
    readerScrolls(600);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    // The note is a short screen, and the list is not painted again the
    // instant the reader turns back to it.
    page.shrink(860);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    // Clamped, because there is nothing there yet to scroll — and the clamp
    // must not be banked as the line the reader was on, or it is lost.
    expect(page.y).toBe(0);

    page.grow(3000);
    expect(page.y).toBe(600);
  });

  it('lets the reader who takes the page over keep it', () => {
    const page = fakePage(3000);
    render(<Harness />);
    readerScrolls(600);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    page.shrink(860);
    fireEvent.click(screen.getByRole('button', { name: 'back' }));

    // A flick inside the wait: a restore arriving after it would be a scroll
    // nobody asked for.
    fireEvent.touchStart(window);
    page.grow(3000);
    expect(page.y).toBe(0);

    // …and their own line is being kept again.
    readerScrolls(240);
    expect(page.y).toBe(240);
  });

  /**
   * Note #405. Reaching a line and KEEPING it are two different jobs, and
   * until now this shell only did the first: the top is the one line every
   * document can hold, so the placement returned in the same instruction it
   * was made in and the page belonged to nobody afterwards. Everything below
   * is a scroll the reader did not ask for, arriving a beat after the screen
   * landed — a focus without `preventScroll`, a screen's own `scrollTo` a
   * layout phase later, a fling still gliding, a window resized under a
   * screen that was still arriving.
   */
  it('takes the top back from a scroll the reader did not ask for', () => {
    const page = fakePage(3000);
    render(<Harness />);
    readerScrolls(600);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(page.y).toBe(0);

    // Something moves the page 70px, leaving no sign of a reader behind it.
    window.scrollTo(0, 70);
    expect(page.y).toBe(0);
  });

  it('holds a line a Back restored against the same nudge', () => {
    const page = fakePage(3000);
    render(<Harness />);
    readerScrolls(600);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(page.y).toBe(600);

    window.scrollTo(0, 670);
    expect(page.y).toBe(600);
  });

  it('gives the page up the moment the reader asks for it', () => {
    const page = fakePage(3000);
    render(<Harness />);
    readerScrolls(600);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));

    // Each of the four things a reader can do to take the page over, one per
    // fresh landing: the hold has to end on any of them, or the shell would
    // be scrolling against the hand that is moving it.
    for (const take of [
      () => fireEvent.touchStart(window),
      () => fireEvent.wheel(window),
      () => fireEvent.keyDown(window, { key: 'PageDown' }),
      () => fireEvent.pointerDown(window),
    ]) {
      take();
      window.scrollTo(0, 240);
      expect(page.y).toBe(240);
      // Back to a landing, for the next one to be measured from.
      fireEvent.click(screen.getByRole('button', { name: 'open' }));
      expect(page.y).toBe(0);
    }
  });

  it('does not fight a screen that is still too short to hold its line', () => {
    const page = fakePage(3000);
    render(<Harness />);
    readerScrolls(600);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    page.shrink(860);
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    // Nothing there yet to scroll: the clamp is the browser answering, not a
    // scroll to be taken back, and the wait is still the answer.
    expect(page.y).toBe(0);
    page.grow(3000);
    expect(page.y).toBe(600);
  });

  it('remembers a line per history entry, and only the reader’s own', () => {
    const page = fakePage(3000);
    render(<Harness />);
    const list = entryKey();
    readerScrolls(600);
    expect(recallScroll(list)).toBe(600);

    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    // An entry the reader has not scrolled has no line of its own — the
    // restore's own write to the top is not one of theirs.
    expect(recallScroll(entryKey())).toBeUndefined();
    // The list's own line is untouched by the screen that covered it.
    expect(recallScroll(list)).toBe(600);

    page.shrink(860);
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(page.y).toBe(0);
    expect(recallScroll(list)).toBe(600);
  });
});

/** A leaf is anything that claims Back: a picker, a form, the note composer.
 *  It stands over the screen that opened it and never touches the address. */
function Leaf({ onClose }: { onClose: () => void }) {
  useBackClaim(onClose);
  return <button type="button" onClick={onClose}>close</button>;
}

function ScreenWithLeaf() {
  const [open, setOpen] = useState(false);
  if (open) return <Leaf onClose={() => setOpen(false)} />;
  return <button type="button" onClick={() => setOpen(true)}>write</button>;
}

const renderLeafScreen = () => render(
  <MemoryRouter initialEntries={['/notes']}>
    <BackProvider>
      <ScrollMemory />
      <ScreenWithLeaf />
    </BackProvider>
  </MemoryRouter>,
);


describe('a transient leaf', () => {
  it('opens at its own top, and hands back the line it covered', () => {
    const page = fakePage(3000);
    renderLeafScreen();
    readerScrolls(900);

    // Note #280: nothing in the router hears a leaf open, so before this the
    // window simply kept the reader's offset and the composer came up at its
    // own bottom.
    fireEvent.click(screen.getByRole('button', { name: 'write' }));
    expect(page.y).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(page.y).toBe(900);
  });

  it('does not bank its own scrolling as the reader\u2019s line on the screen', () => {
    const page = fakePage(3000);
    renderLeafScreen();
    readerScrolls(900);
    fireEvent.click(screen.getByRole('button', { name: 'write' }));

    // A long form scrolled while it is up. It has no address, so this is
    // nobody's reading line — least of all the list's underneath.
    readerScrolls(300);
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(page.y).toBe(900);
  });
});
