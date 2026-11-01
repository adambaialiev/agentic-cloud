/**
 * The actions a change ran through: one row that says the answer and opens
 * the detail beneath it.
 *
 * A repo with no CI says so and has nothing to open — never a grey "0
 * actions", which reads like a result. Anything not green opens ITSELF: a
 * failure is why the reader is here, and the log tail is the only artifact it
 * has. Once the reader has opened or closed the list, a five-second refresh
 * leaves it exactly as they left it, which is what the `open` state here is
 * for: the rows repaint underneath without the card closing under a finger.
 */

import { useState, type ReactNode } from 'react';
import type { WorkspaceCheckRow, WorkspaceCheckState } from '../../../../src/shared/workspace-api.js';
import { Icon, TypeIcon, type IconName, type IconTint } from '../../ui/icons.js';
import { elapsed, relative, useNow } from '../../ui/time.js';
// One row-that-is-a-door for the whole shell: tap and Enter mean the same
// thing here as they do on Home.
import { PressableRow } from '../home/PressableRow.js';
import { checksSide, pipClass, tallyChecks } from './checks.js';

export function CheckPip({ state }: { state: WorkspaceCheckState | string }) {
  return <span className={`pip ${pipClass(state)}`} />;
}

/** One summary row, in the app's own row language: a 28px mark, what it is,
 *  its one number on the right, and a chevron only where there is somewhere
 *  to go. */
export function SummaryRow({ glyph, tint, name, side, opens, onPress, className }: {
  glyph: IconName;
  tint?: IconTint;
  name: string;
  side?: ReactNode;
  opens?: boolean;
  onPress?: () => void;
  className?: string;
}) {
  const classes = `crow${opens ? ' open' : ''}${className ? ` ${className}` : ''}`;
  const body = (
    <>
      <TypeIcon glyph={glyph} tint={tint} />
      <div className="main"><div className="name plain">{name}</div></div>
      {side}
      {opens ? <Icon name="chev" size={17} className="icon chev" /> : null}
    </>
  );
  if (!onPress) return <div className={classes}>{body}</div>;
  return <PressableRow className={classes} onPress={onPress}>{body}</PressableRow>;
}

/**
 * When a check HAPPENED, for the row's right-hand column: the moment it
 * finished, falling back to the moment it started for a run stored before the
 * host recorded completions. A job STILL RUNNING spends that column on a clock
 * counting up instead — it has nothing else that moves, and a finished job's
 * description already says how long it took.
 */
function CheckWhen({ check }: { check: WorkspaceCheckRow }) {
  const running = check.state === 'pending' && Boolean(check.startedAt);
  const now = useNow(running);
  if (running) return <span className="cwhen crun">{elapsed(check.startedAt, now)}</span>;
  const when = relative(check.completedAt || check.startedAt || '', now);
  return when ? <span className="cwhen">{when}</span> : null;
}

/**
 * One check row: its name, what happened to it, and its right-hand column.
 * A failed row opens its log tail — the only artifact a failed check has.
 *
 * `startClosed` is the repository's Actions LIST, where a screenful of runs
 * with every red log unrolled would bury the repository under its history. On
 * a proposal the opposite is true: the one failed check is why the reader
 * came, so it opens itself. `side` replaces the clock for a list that dates
 * each run in the column its other numbers sit in.
 */
export function CheckRow({ check, side, startClosed }: {
  check: WorkspaceCheckRow;
  side?: string;
  startClosed?: boolean;
}) {
  const settled = check.state === 'success' || check.state === 'skipped';
  const [tailShown, setTailShown] = useState(!settled && !startClosed);
  const row = (
    <>
      <CheckPip state={check.state} />
      <div className="main">
        <div className="cname">{check.context}</div>
        <div className="cdesc">{check.description || check.state}</div>
      </div>
      {side === undefined ? <CheckWhen check={check} /> : <span className="cwhen">{side}</span>}
    </>
  );
  if (!check.logTail) return <div className="checkrow">{row}</div>;
  return (
    <>
      <PressableRow className="checkrow open" onPress={() => setTailShown(!tailShown)}>{row}</PressableRow>
      <pre className="logtail" hidden={!tailShown}>{check.logTail}</pre>
    </>
  );
}

/** The Actions card: one row per context. `className` is what it is standing
 *  in — a card of its own by default, a plain block when it hangs under the
 *  Actions row INSIDE the proposal's summary card, where a second card
 *  background would draw a box inside a box. */
export function ChecksCard({ checks, className = 'card', hidden }: {
  checks: readonly WorkspaceCheckRow[];
  className?: string;
  hidden?: boolean;
}) {
  return (
    <div className={className} hidden={hidden}>
      {checks.map((check, at) => <CheckRow check={check} key={`${check.context}:${at}`} />)}
    </div>
  );
}

/**
 * The Actions row and the list under it. The list opens itself when anything
 * is not green — a failure is why the reader is here — and thereafter keeps
 * whatever the reader last did with it.
 */
export function ChecksRow({ checks }: { checks: readonly WorkspaceCheckRow[] }) {
  const tally = tallyChecks(checks);
  const wrong = Boolean(tally.failing || tally.running || tally.unjudged);
  const [open, setOpen] = useState(wrong);
  if (checks.length === 0) {
    return <SummaryRow glyph="play" name="Actions" side={<span className="cside">no CI in this repo</span>} />;
  }
  return (
    <>
      <SummaryRow
        glyph="play"
        name="Actions"
        opens
        onPress={() => setOpen(!open)}
        side={<><CheckPip state={tally.worst} /><span className="cside">{checksSide(checks)}</span></>}
      />
      <ChecksCard checks={checks} className="prlist" hidden={!open} />
    </>
  );
}
