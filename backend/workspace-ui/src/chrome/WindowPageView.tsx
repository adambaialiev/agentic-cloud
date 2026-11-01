/**
 * One page of a window (note #722): the screen at its address — or a leaf
 * with none — under a head of the window's own, as the page's persistent
 * header heads a screen (`PageHead`): Back, what is live on the page, Close,
 * and under them the screen's own name (`ScreenTitle` fills this slot as it
 * fills the page's).
 *
 * Back here asks the page's own leaves first — a runtime picker, a form —
 * through a `BackProvider` of the page's own, so a leaf opened inside a page
 * never answers a Back meant for another page. Failing that it closes the
 * page (`onBack`). Close puts the whole window away.
 *
 * Pages under the top one stay drawn, hidden, so coming Back to one finds it
 * as it was left: its reads, its half-typed remark, its reading line.
 */

import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DestinationsContext } from './destinations.js';
import { HeadPresence } from './HeadPresence.js';
import { HeadSlotContext } from './head-slot.js';
import { BackProvider } from './PageHead.js';
import { useBack } from './useBack.js';
import { WindowLocation, WindowNavigation } from './WindowNavigation.js';
import type { WindowMoves, WindowPage } from './window-pages.js';
import { Svg } from '../ui/icons.js';

function PageFrame({ top, onBack, onClose, backRef, children }: {
  top: boolean;
  onBack: () => void;
  onClose: () => void;
  backRef: { current: (() => void) | null };
  children: ReactNode;
}) {
  const back = useBack();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const goBack = () => {
    if (back.handle()) return;
    onBack();
  };
  // The window's Escape is this page's Back while it is the one on top.
  useEffect(() => {
    if (!top) return;
    backRef.current = goBack;
    return () => { if (backRef.current === goBack) backRef.current = null; };
  });
  // A hidden box keeps no scroll offset: the line a page was read to is
  // held while another page stands over it, and given back when it is
  // uncovered.
  const line = useRef(0);
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    if (top) node.scrollTop = line.current;
    else line.current = node.scrollTop;
  }, [top]);
  return (
    <>
      <header className="pagehead windowhead">
        <nav className="pagenav" aria-label="Window navigation">
          <button className="back" id={top ? 'windowBack' : undefined} type="button" onClick={goBack}>
            <Svg name="back" size={20} />Back
          </button>
          <HeadPresence />
          <button className="agentsheetclose" id={top ? 'windowClose' : undefined} type="button" aria-label="Close" onClick={onClose}>
            <Svg name="x" size={18} />
          </button>
        </nav>
        <div className="pageid" ref={setSlot} />
      </header>
      <div
        className="agentsheetlist homesheetbody windowbody"
        ref={body}
        onScroll={(event) => { if (top) line.current = event.currentTarget.scrollTop; }}
      >
        <HeadSlotContext value={slot}>{children}</HeadSlotContext>
      </div>
    </>
  );
}

export function WindowPageView({ page, level, top, moves, onBack, onClose, backRef, children }: {
  page: WindowPage;
  /** 1 for the window's first page. */
  level: number;
  top: boolean;
  moves: WindowMoves;
  onBack: () => void;
  onClose: () => void;
  /** Where the page on top leaves its Back, for the window's Escape. */
  backRef: { current: (() => void) | null };
  /** What the page draws when it is not its address's screen: a leaf. */
  children?: ReactNode;
}) {
  const destinations = useContext(DestinationsContext);
  return (
    <div className="sheetlevel windowpage" hidden={!top} data-level={level} data-address={`${page.pathname}${page.search}`}>
      <WindowLocation page={page}>
        <WindowNavigation level={level} moves={moves}>
          <BackProvider>
            <PageFrame top={top} onBack={onBack} onClose={onClose} backRef={backRef}>
              {children ?? destinations}
            </PageFrame>
          </BackProvider>
        </WindowNavigation>
      </WindowLocation>
    </div>
  );
}
