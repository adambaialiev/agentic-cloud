/**
 * How full a subscription window is: the pill, the meter and the full row
 * with its reset countdown, in the legacy class vocabulary. A window that
 * knows its own length also carries a PACE — the tick where an even spend
 * would stand, and the line saying how far off it this one is (note #279).
 */

import type { WorkspaceSeatWindow } from '../../../src/shared/workspace-api.js';
import { type Pace, paceMarkText, paceWords, windowPace } from './pace.js';
import { resetPhrase, usageSeverity } from './seat-words.js';
import { useNow } from './time.js';

export function UsagePill({ window: w }: { window: Pick<WorkspaceSeatWindow, 'usedPercent' | 'percentText' | 'trackText'> }) {
  const sev = usageSeverity(w.usedPercent);
  return <span className={`pct${sev ? ` ${sev}` : ''}`}>{w.percentText}%{w.trackText ? ` (${w.trackText})` : ' used'}</span>;
}

export function UsageMeter({ usedPercent, pace }: { usedPercent: number; pace?: Pace | null }) {
  const sev = usageSeverity(usedPercent);
  const severity = sev ? ` ${sev}` : '';
  return (
    <div className={`meter${severity}`}>
      <div className={`meter-fill${severity}`} style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }} />
      {pace ? <div className="meter-pace" style={{ left: `${pace.expectedPercent}%` }} title={paceMarkText(pace)} /> : null}
    </div>
  );
}

export function UsageWindowRow({ window: w }: { window: WorkspaceSeatWindow }) {
  // The countdown moves on its own; the shared clock ticks it — and the pace
  // is measured against the same instant, so the two never disagree.
  const now = useNow(Boolean(w.resetAt));
  const sev = usageSeverity(w.usedPercent);
  const countdown = w.resetAt ? resetPhrase(w.resetAt, now) : null;
  const stamp = countdown ? `Resets ${countdown}` : w.resetsText ? `Resets ${w.resetsText}` : null;
  const pace = windowPace(w, now);
  const pacing = pace ? paceWords(pace) : null;
  return (
    <div className="row">
      <div className="main">
        <div className="usage-top">
          <span className="name plain">{w.label}</span>
          <span className={`usage-pct${sev ? ` ${sev}` : ''}`}>{w.percentText}% used</span>
        </div>
        <UsageMeter usedPercent={w.usedPercent} pace={pace} />
        {pacing
          ? (
            <div className={`usage-pace${pacing.tone ? ` ${pacing.tone}` : ''}`}>
              <span className="pace-off">{pacing.lead}</span>
              {pacing.tail ? <> · {pacing.tail}</> : null}
            </div>
          )
          : null}
        {w.detailText || stamp
          ? (
            <div className="meta">
              {w.detailText}{w.detailText && stamp ? ' · ' : ''}
              {stamp ? <span className="resetclock">{stamp}</span> : null}
            </div>
          )
          : null}
      </div>
    </div>
  );
}
