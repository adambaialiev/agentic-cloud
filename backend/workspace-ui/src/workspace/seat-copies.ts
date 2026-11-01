/**
 * ONE copy of each subscription (note #697, in our owner's words: "If I open
 * a subscription details page, I see stale data for a moment and then it
 * updates. … In the home page, the data was fresh. … I think there should be
 * one source of truth.").
 *
 * The browser hears about a subscription from two reads. The state read
 * (`org.seatUsage`) is the one Home's plates are drawn from, and it is asked
 * again on every arrival Home, every focus and every turn that starts or
 * ends. The seats read (`api/org/seats`, held by `SeatsProvider`) is the full
 * record the subscription's own page and the list draw, and it is asked only
 * when one of those screens opens. A record held since the morning was what
 * a page opened in the afternoon painted first: the morning's percentages,
 * under numbers Home had shown a second earlier, until its own read
 * replaced them.
 *
 * Both reads stamp each subscription with the instant the server last
 * changed it (`updatedAt`), so nothing here guesses at freshness: a screen
 * draws whichever copy is newer, and asks again for the one that is behind.
 * A row without a stamp — from a server older than this — compares as level,
 * and everything behaves as it did before.
 */

import { useEffect } from 'react';
import { useSeats } from './useSeats.js';
import { useWorkspace } from './useWorkspace.js';

type Stamped = { updatedAt?: string } | null | undefined;

function stampOf(copy: Stamped): number | null {
  const at = Date.parse(copy?.updatedAt ?? '');
  return Number.isFinite(at) ? at : null;
}

/** How the seats read's record of a subscription stands against Home's row
 *  for it: below zero when the record is older, above when it is newer, and
 *  zero when they are level or either has no stamp to compare. */
export function compareSeatCopies(record: Stamped, row: Stamped): number {
  const a = stampOf(record);
  const b = stampOf(row);
  return a === null || b === null ? 0 : Math.sign(a - b);
}

/** The record is older than what Home's plate already shows. */
export function seatRecordIsBehind(record: Stamped, row: Stamped): boolean {
  return compareSeatCopies(record, row) < 0;
}

/**
 * While a screen that draws the seats read is open, keep the two copies in
 * step: a record older than Home's row asks the seats read again (it was held
 * from an earlier visit, or a turn ended and the state read moved on under
 * the open page), and a record newer than Home's row asks the state read
 * again (this page's read found a reading Home has not shown) — so the reader
 * who goes back finds the plate already saying what this page said. Each
 * disagreement is acted on once: it is keyed by the stamps that disagree,
 * and an answer that brings the copies level clears it.
 *
 * Call it before the screen's own read goes out on arrival: a seats read
 * already out may have left before Home moved on, so the one asked for here
 * waits for it and goes out after it — which, called first, is the screen's
 * own read rather than a second one behind it.
 */
export function useSeatCopiesInStep(): void {
  const { state, reload } = useWorkspace();
  const { seats, fetch } = useSeats();
  const rows = state?.org?.seatUsage;
  let behind = '';
  let ahead = '';
  for (const record of seats ?? []) {
    const row = rows?.find((entry) => entry.seatId === record.seatId);
    const order = compareSeatCopies(record, row);
    if (order < 0) behind += `${record.seatId}@${row?.updatedAt} `;
    else if (order > 0) ahead += `${record.seatId}@${record.updatedAt} `;
  }
  useEffect(() => {
    if (!behind) return;
    fetch()
      .catch(() => [])
      .then(() => fetch({ force: true }))
      .catch(() => { /* the screen's own read says how a failure looks */ });
  }, [behind, fetch]);
  useEffect(() => {
    if (ahead) void reload();
  }, [ahead, reload]);
}
