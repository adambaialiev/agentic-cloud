/**
 * What a subscription's own page holds while its read is still out (note
 * #625: "When I open a subscription page, and it doesn't yet has data, it
 * shows poorly designed loading state and it display text 'Seat'").
 *
 * The page is reached cold far more often than warm: Home's plates are drawn
 * from the state read, which never fills the seats cache, so the tap a reader
 * actually makes lands on a page whose `api/org/seats` read has only just
 * gone out — and that read may wait on a provider probe. It used to answer
 * with the word "Seat" over one grey "Loading…" line.
 *
 * The state read already names every one of this member's subscriptions here
 * (`org.seatUsage`), so the page draws what it knows as ITSELF — the name, the
 * product, the plan, the status — and holds only what it does not know as
 * bars, in the same containers the real rows use, so nothing moves when the
 * answer lands. Its reading is drawn as itself too, now that it carries every
 * word a usage row says (note #697) — so this card is left for the rows that
 * row cannot draw: a paused or signed-out subscription's last reading, which
 * it leaves out, or a row from a server that did not name its windows.
 * Everything here is `aria-hidden`: the words a screen reader needs come from
 * the `.sr-only` line the page says once.
 */

import type { WorkspaceSeatUsage } from '../../../../src/shared/workspace-api.js';
import { seatHasCurrentUsage } from '../../ui/seat-words.js';

const delayAt = (at: number) => `${(at * 0.12).toFixed(2)}s`;

/** A bar inside a line of text: it takes that line's box, so a held line is as
 *  tall as the words that replace it (`ui/Skel.tsx`). */
export function SeatBar({ width, height = 11, at = 0 }: { width: string; height?: number; at?: number }) {
  return <span className="skel skel-inline" aria-hidden="true" style={{ width, height: `${height}px`, animationDelay: delayAt(at) }} />;
}

/** A usage row's name — "5 hours", "7 days · other models", "7 days · Fable" —
 *  varied so the wait reads as rows about to fill rather than as one repeated
 *  graphic. In PIXELS, because the name is a flex item sized by its own
 *  content, where a percentage has nothing to resolve against and the bar
 *  comes out zero wide. */
const TRACKS = ['72px', '164px', '112px'];

/**
 * The usage card of one subscription, held: a row per reading the state read
 * says it has — its name and share, the meter, the pace line where the window
 * is paced, and the reset — then the "Checked" foot. A subscription with no
 * live reading (paused, or needing a sign-in) holds one row: what it will say
 * then is the last reading the server kept, which nothing here knows.
 */
export function SeatUsageWait({ seat }: { seat: WorkspaceSeatUsage | null }) {
  const windows = seat && seatHasCurrentUsage(seat) ? seat.windows : [];
  const rows = windows.length ? windows.map((window) => Boolean(window.pace)) : [false];
  return (
    <div className="card" id="seatUsageWait" aria-hidden="true">
      {rows.map((paced, at) => (
        <div className="row" key={at}>
          <div className="main">
            <div className="usage-top">
              <span className="name plain"><SeatBar width={TRACKS[at % TRACKS.length]!} at={at} /></span>
              <span className="usage-pct"><SeatBar width="58px" at={at} /></span>
            </div>
            <span className="skel skel-meter" style={{ animationDelay: delayAt(at) }} />
            {paced ? <div className="usage-pace"><SeatBar width="62%" height={10} at={at} /></div> : null}
            <div className="meta"><SeatBar width="48%" height={10} at={at} /></div>
          </div>
        </div>
      ))}
      {windows.length ? <div className="usage-foot"><SeatBar width="92px" height={10} /></div> : null}
    </div>
  );
}
