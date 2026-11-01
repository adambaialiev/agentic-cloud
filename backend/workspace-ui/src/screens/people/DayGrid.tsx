/**
 * A builder's last 90 days on their own page, where each square opens its
 * day (note #208): the date, agent hours, changes merged and tokens written
 * that day — counts only, from the same ledgers as the week above it.
 *
 * A tap (or a click) opens a day under the grid, written as the week's card
 * above writes the week; another square switches days, and the same square,
 * a tap anywhere else or Escape closes it. It opens in the card rather than
 * floating over the grid, because a card big enough for four numbers hides
 * a third of the squares on a phone — the ones a reader would tap next.
 * The keys walk the grid as it is drawn: up and down a day, left and right
 * a week.
 *
 * A mouse resting on a square raises the same day as a card over it (the
 * owner, 2026-10-27), so a desktop reader can sweep the grid without a click
 * per day. It floats because a pointer hides nothing a finger would: it is
 * fixed and portalled out of the card that clips, takes no pointer events,
 * and a coarse pointer never sees it (as AgentHover's card). The open day
 * raises none: its numbers are already under the grid.
 *
 * The public site draws this grid in the home page's founder card (notes
 * #786, #826), inside the fence its copy of this app's stylesheet is scoped
 * under. A card portalled to <body> leaves that fence and loses every style,
 * so a page that fences the app names its fence in `hoverFence`, and the
 * card is portalled inside one. The Workspace passes none.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  LEADERBOARD_DAYS_FROM,
  LEADERBOARD_GRID_TOP,
  LEADERBOARD_GRID_WEEKS,
  leaderboardDayAt,
  type LeaderboardDay,
} from '../../../../src/shared/leaderboard.js';
import { dayTitle, dayWordsUtc, formatHours, formatTokens } from './board-words.js';

/** Less to more, under the grid. */
function GridLegend() {
  return (
    <div className="lblegend" aria-hidden="true">
      <span>Less</span>
      {Array.from({ length: LEADERBOARD_GRID_TOP + 1 }, (_, level) => <span key={level} className={`lbcell l${level}`} />)}
      <span>More</span>
    </div>
  );
}

const STEPS: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };

/** Air between the square and its card, and the closest the card may come
 *  to the edge of the window. */
const GAP = 8;
const EDGE = 12;

/** Centred over the square, under it when there is no room above; written
 *  from the ref, since where it fits depends on how tall it came out. */
function place(card: HTMLElement, anchor: DOMRect): void {
  const box = card.getBoundingClientRect();
  const above = anchor.top - GAP - box.height;
  const top = above >= EDGE ? above : anchor.bottom + GAP;
  const centred = anchor.left + anchor.width / 2 - box.width / 2;
  card.style.top = `${top}px`;
  card.style.left = `${Math.max(EDGE, Math.min(centred, window.innerWidth - EDGE - box.width))}px`;
}

/** The pointed-at day, in the open day's words, one line a measure. */
function DayCard({ title, day, anchor }: { title: string; day: LeaderboardDay; anchor: DOMRect }) {
  return (
    <div className="daycard" role="tooltip" ref={(node) => { if (node) place(node, anchor); }}>
      <div className="lbdaytitle">{title}</div>
      <span><b>{day.workingMs == null ? '–' : formatHours(day.workingMs)}</b> agent hours</span>
      <span><b>{day.merged}</b> {day.merged === 1 ? 'change merged' : 'changes merged'}</span>
      {day.workingMs == null ? null : (
        <>
          {day.claude != null ? <span>Claude Code <b>{formatTokens(day.claude)}</b> tokens written</span> : null}
          {day.codex != null ? <span>Codex <b>{formatTokens(day.codex)}</b> tokens written</span> : null}
          {day.claude == null && day.codex == null ? <span>No tokens written</span> : null}
        </>
      )}
    </div>
  );
}

export function DayGrid({ levels, days, gridStart, hoverFence }: {
  levels: readonly number[];
  days: readonly LeaderboardDay[];
  gridStart: string;
  /** The class of the fence a page scopes this app's stylesheet under, if any. */
  hoverFence?: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [focusAt, setFocusAt] = useState(Math.max(0, levels.length - 1));
  const [hover, setHover] = useState<{ index: number; anchor: DOMRect } | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const cells = useRef<Array<HTMLButtonElement | null>>([]);

  // A tap anywhere but a square or the day itself closes it; so does Escape.
  useEffect(() => {
    if (open == null) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (grid.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(null);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const walk = (event: KeyboardEvent, index: number) => {
    const step = STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    const next = index + step;
    if (next < 0 || next >= levels.length) return;
    setFocusAt(next);
    setOpen(next);
    cells.current[next]?.focus();
  };

  const day = open != null ? days[open] : undefined;
  const pointed = hover && hover.index !== open ? days[hover.index] : undefined;
  return (
    <>
      <div className="lbdaysgrid">
        <div ref={grid} className="lbgrid full lbdaypick" role="group" aria-label="Activity over the last 90 days">
          {Array.from({ length: LEADERBOARD_GRID_WEEKS * 7 }, (_, index) => {
            if (index >= levels.length) return <span key={index} className="lbcell later" />;
            return (
              <button
                key={index}
                ref={(node) => { cells.current[index] = node; }}
                type="button"
                className={`lbcell l${Math.min(LEADERBOARD_GRID_TOP, levels[index]!)}${index === open ? ' picked' : ''}`}
                tabIndex={index === focusAt ? 0 : -1}
                aria-label={dayTitle(leaderboardDayAt(gridStart, index))}
                aria-expanded={index === open}
                aria-controls={index === open ? 'personDay' : undefined}
                onClick={() => { setFocusAt(index); setOpen(open === index ? null : index); }}
                onKeyDown={(event) => walk(event, index)}
                onMouseEnter={(event) => setHover({ index, anchor: event.currentTarget.getBoundingClientRect() })}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
        </div>
        <GridLegend />
      </div>
      {hover && pointed
        ? createPortal(
          hoverFence
            ? <div className={hoverFence}><DayCard title={dayTitle(leaderboardDayAt(gridStart, hover.index))} day={pointed} anchor={hover.anchor} /></div>
            : <DayCard title={dayTitle(leaderboardDayAt(gridStart, hover.index))} day={pointed} anchor={hover.anchor} />,
          document.body,
        )
        : null}
      {open != null && day ? (
        <div ref={panel} className="lbday" id="personDay" role="status">
          <div className="lbdaytitle">{dayTitle(leaderboardDayAt(gridStart, open))}</div>
          <div className="lbstats">
            <div><b>{day.workingMs == null ? '–' : formatHours(day.workingMs)}</b><span>agent hours</span></div>
            <div><b>{day.merged}</b><span>{day.merged === 1 ? 'change merged' : 'changes merged'}</span></div>
          </div>
          {day.workingMs == null ? (
            // Before the ledgers kept days: no data, never a zero.
            <div className="formhint lbdaynote">No hours or tokens were counted before {dayWordsUtc(LEADERBOARD_DAYS_FROM)}.</div>
          ) : (
            <div className="lbtokens">
              {day.claude != null ? <span>Claude Code <b>{formatTokens(day.claude)}</b> tokens written</span> : null}
              {day.codex != null ? <span>Codex <b>{formatTokens(day.codex)}</b> tokens written</span> : null}
              {day.claude == null && day.codex == null ? <span>No tokens written</span> : null}
            </div>
          )}
        </div>
      ) : (
        <div className="formhint">Each square is a day; darker means more hours worked by this person’s agents. Tap a day to see its numbers.</div>
      )}
    </>
  );
}
