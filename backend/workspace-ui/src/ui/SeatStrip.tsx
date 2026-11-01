/**
 * The workplace's subscriptions: each private sign-in it may use, as its
 * own PLATE, with "Add sub" as the last plate. A note keeps the compact set
 * in one sideways row (notes #345/#348); Home wraps every plate into its one
 * vertical reading flow instead (note #471).
 *
 * They used to be a stack of full-width rows inside one card — a list, read
 * top to bottom. But subscriptions are a small set you pick BETWEEN, and a
 * pile of them pushed the fleet off the first screen for a reader who only
 * wanted to know which sign-in is hot. Side by side, each is one glance
 * wide. A note keeps that hand-off surface to the height of one plate; Home
 * shows the complete set without asking for a second scrolling direction.
 *
 * One shared component for every screen that carries it — Home, and the note
 * underneath whose words the work is dealt out (note #348). A seat is what a Workspace
 * agent spends, so wherever agents are offered this stands above them, and a
 * second copy of "how full is each sign-in" is a second copy to keep honest
 * as the plate, the live dot and the door keep moving. What the caller
 * brings is the only part that differs: the ids the shared stylesheet
 * dresses this instance by, and whether the screen owes it a heading — Home
 * already places it in the Workplace half; anywhere else the row would
 * arrive unannounced.
 */

import { useNavigate } from 'react-router-dom';
import type { WorkspaceSeatUsage } from '../../../src/shared/workspace-api.js';
import { Icon } from './icons.js';
import { seatHasCurrentUsage, seatStatusWords, subscriptionName, usageSeverity } from './seat-words.js';
import { SeatUseDot } from './SeatUse.js';
import { toFor } from '../routes.js';
import { useWorkspace } from '../workspace/useWorkspace.js';

function SeatPlate({ seat, seats, onOpen }: {
  seat: WorkspaceSeatUsage;
  seats: WorkspaceSeatUsage[];
  onOpen: () => void;
}) {
  const { agents, state } = useWorkspace();
  const windows = seatHasCurrentUsage(seat) ? seat.windows ?? [] : [];
  const status = seatStatusWords(seat);
  return (
    <button className="seatcard" type="button" onClick={onOpen}>
      <div className="seathead">
        <div className="name plain">
          {/* Its own box on purpose: a bare text node in a flex line is an
              anonymous flex item, and `text-overflow` does not apply to one
              — a long sign-in name was cut mid-letter with no ellipsis.
              Every plate is named by its product, ChatGPT as much as Claude
              (note #667): the stored label carries the sign-in date, which
              the seat's own screen shows and a plate has no room for. */}
          <span className="label">{subscriptionName(seat.provider)}</span>
          {seat.planText ? <span className="plan">{seat.planText}</span> : null}
          <SeatUseDot seat={seat} agents={agents} seats={seats} activeSeatIds={state?.org?.activeSeatIds} />
        </div>
      </div>
      {windows.length
        ? (
          <div className="seatstats">
            {windows.map((window, index) => {
              const sev = usageSeverity(window.usedPercent);
              return (
                <span className="seatstat" key={index}>
                  <span className="track">{window.trackText || 'usage'}</span>
                  <span className={`pct${sev ? ` ${sev}` : ''}`}>{window.percentText}%</span>
                </span>
              );
            })}
          </div>
        )
        : (
          <div className="seatstate">
            {/* An OpenCode key never reads usage (note #780): its plate says
                where the usage is, and a benched one still says Resting. */}
            {seat.provider === 'opencode'
              ? (seat.status === 'active'
                ? <span className="pct quiet">usage in OpenCode</span>
                : <span className={`pill ${status.tone}`}>{status.text}</span>)
              : seatHasCurrentUsage(seat)
                ? <span className="pct quiet">no reading yet</span>
                : <span className={`pill ${status.tone}`}>{status.text}</span>}
          </div>
        )}
      {/* No "Primary" here (the owner, note #773): a compact plate is a
          glance at how full each sign-in is. Which one turns use first is
          said on "Your subscriptions" and on the sign-in's own page. */}
    </button>
  );
}

export interface SeatStripProps {
  /** Section ids, so the shared stylesheet dresses this row as itself — and
   *  so Home's own chain of siblings, which its spacing rules key on, keeps
   *  the names it has always had. */
  ids: { head?: string; section: string; row: string };
  /** The heading to stand over the row, on a screen where the plates would
   *  otherwise arrive with nothing saying what they are. Home passes none. */
  head?: string;
  /** Home keeps this door as plain language; the compact note handoff keeps
   *  the glyph that distinguishes the door in its sideways row. */
  addIcon?: boolean;
}

export function SeatStrip({ ids, head, addIcon = true }: SeatStripProps) {
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const org = state?.org ?? null;
  // The older personal workspace has no workplace and therefore no
  // sign-ins. The empty section stays a SIBLING rather than disappearing:
  // Home's "this screen opens with no gap above its first heading" rule is
  // written as a chain of hidden siblings, and a missing node breaks it.
  if (!org) {
    return (
      <>
        {head ? <h2 id={ids.head} hidden>{head}</h2> : null}
        <div className="seatsection" id={ids.section} hidden />
      </>
    );
  }
  const seats = org.seatUsage ?? [];
  const seatsTo = toFor({ kind: 'seats', orgId: org.orgId })!;
  return (
    <>
      {head ? <h2 id={ids.head}>{head}</h2> : null}
      <div className="seatsection" id={ids.section}>
        {/* With no sign-ins the strip is one Add plate, and the sentence that
            says why stands above it rather than pretending to be a plate. */}
        {seats.length === 0 ? <div className="empty">No sign-ins here yet — sign one in and your agents can start work.</div> : null}
        <div className="seatstrip" id={ids.row}>
          {seats.map((seat) => (
            <SeatPlate
              key={seat.seatId}
              seat={seat}
              seats={seats}
              onOpen={() => navigate(toFor({ kind: 'seat', id: seat.seatId, orgId: org.orgId })!)}
            />
          ))}
          <button className="seatadd" type="button" onClick={() => navigate(seatsTo)}>
            {addIcon ? <Icon name="plus" size={15} /> : null}<span>Add sub</span>
          </button>
        </div>
      </div>
    </>
  );
}
