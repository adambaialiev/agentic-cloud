/**
 * One private copy (note #1058): what its newest pulse says, who to write to
 * — a draft in the reader's own mailbox, never a send — and its history, one
 * row per day it was heard from, as a small chart of turns per day and a
 * table under it. The platform operator's alone, like the list it opens from.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { WorkspaceCopyAnswer, WorkspaceCopyDay } from '../../../../src/shared/copy-pulse.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { absolute } from '../../ui/format.js';
import { relative, useNow } from '../../ui/time.js';
import { byCliWords, contactSubject, healthWords, releaseWords, shortDay, standingWords } from './copies-words.js';

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));
/**
 * Turns per day, oldest on the left: one series, so no legend — the heading
 * names it. Each bar is a day the copy was heard from; a missing day is a gap
 * the bars do not close over. A bar's title is its day and count, and the
 * table below is the same numbers to read.
 */
export function TurnsChart({ days }: { days: WorkspaceCopyDay[] }) {
  const shown = [...days].reverse();
  if (!shown.length) return null;
  const first = Date.parse(`${shown[0]!.day}T00:00:00Z`);
  const last = Date.parse(`${shown.at(-1)!.day}T00:00:00Z`);
  const span = Math.max(1, Math.round((last - first) / 86_400_000) + 1);
  const top = Math.max(1, ...shown.map((day) => day.turns24h));
  const width = 320;
  const height = 96;
  const slot = width / Math.max(span, 7);
  const bar = Math.max(2, slot - 2);
  return (
    <figure className="copychart" id="copyChart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Turns per day, ${shown.length} days, most ${top.toLocaleString('en-US')}`}>
        <line x1="0" x2={width} y1={height} y2={height} className="copychartbase" />
        {shown.map((day) => {
          const at = Math.round((Date.parse(`${day.day}T00:00:00Z`) - first) / 86_400_000);
          const tall = day.turns24h ? Math.max(2, (day.turns24h / top) * (height - 4)) : 0;
          return (
            <g key={day.day} data-day={day.day}>
              <title>{`${shortDay(day.day)}: ${day.turns24h.toLocaleString('en-US')} turns`}</title>
              {/* The hit target is the whole slot, taller than the bar. */}
              <rect x={at * slot} y="0" width={slot} height={height} className="copycharthit" />
              {tall ? <rect x={at * slot + (slot - bar) / 2} y={height - tall} width={bar} height={tall} rx={Math.min(2, bar / 2)} className="copychartbar" /> : null}
            </g>
          );
        })}
      </svg>
      <div className="copychartaxis" aria-hidden="true"><span>{shortDay(shown[0]!.day)}</span><span>{shortDay(shown.at(-1)!.day)}</span></div>
      <figcaption className="copychartcap">Most in a day: {top.toLocaleString('en-US')}</figcaption>
    </figure>
  );
}

function Fact({ id, k, children }: { id: string; k: string; children: React.ReactNode }) {
  return <div className="drow" id={id}><div className="k">{k}</div><div className="v">{children}</div></div>;
}

export function CopyScreen() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const navigate = useNavigate();
  const [answer, setAnswer] = useState<WorkspaceCopyAnswer | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api.api<WorkspaceCopyAnswer>(`api/copies/${encodeURIComponent(id)}`)
      .then((read) => { if (live) { setAnswer(read); setError(''); } })
      .catch((failure: unknown) => { if (live) setError(messageOf(failure)); });
    return () => { live = false; };
  }, [api, id]);

  const copy = answer?.copy;
  const now = useNow(false);
  const standing = copy ? standingWords(copy, now) : '';
  const write = () => {
    if (!copy) return;
    navigate(toFor({ kind: 'mail' })!, { state: { writeTo: copy.contactEmail, writeSubject: contactSubject(copy.domain) } });
  };

  return (
    <div className="screen" id="screenCopy" aria-busy={answer || error ? undefined : true}>
      <ScreenTitle title={copy?.domain ?? 'Copy'} sub={copy ? releaseWords(copy) : undefined} subId="copySub" />
      {error && !answer ? <div className="card"><div className="empty" id="copyError">{error}</div></div> : null}
      {!answer && !error ? <div className="card"><div className="empty">Loading…</div></div> : null}
      {copy && answer
        ? (
          <>
            {copy.standing === 'opted-out'
              ? <p className="hintblock mailwarn" id="copyOptedOut">Its admin turned the daily pulse off. These are the last numbers it sent, on {absolute(copy.lastSeenAt)}.</p>
              : copy.standing === 'silent'
                ? <p className="hintblock mailwarn" id="copySilent">{standing}: no pulse since {absolute(copy.lastSeenAt)}.</p>
                : null}
            <h2>Contact</h2>
            <div className="card" id="copyContact">
              <Fact id="copyContactName" k="Name">{copy.contactName}</Fact>
              <Fact id="copyContactEmail" k="Email">{copy.contactEmail}</Fact>
              <button className="addrow" id="copyWrite" type="button" onClick={write}>Write to {copy.contactName}</button>
            </div>
            <h2>Latest pulse</h2>
            <div className="card" id="copyLatest">
              <Fact id="copyRelease" k="Release">{releaseWords(copy)}</Fact>
              <Fact id="copyPeople" k="People">{copy.people.toLocaleString('en-US')}</Fact>
              <Fact id="copyAgents" k="Agents">{`${copy.agents.toLocaleString('en-US')} · ${byCliWords(copy.agentsByCli)}`}</Fact>
              <Fact id="copyTurns" k="Turns, 24h">{`${copy.turns24h.toLocaleString('en-US')} · ${byCliWords(copy.turnsLast24hByCli)}`}</Fact>
              <Fact id="copyMachineHours" k="Machine hours, 24h">{copy.machineHours24h.toLocaleString('en-US')}</Fact>
              <Fact id="copySites" k="Sites live">{copy.sitesLive.toLocaleString('en-US')}</Fact>
              <Fact id="copyHealth" k="Health">{healthWords(copy)}</Fact>
              <Fact id="copyActivity" k="Last activity">{copy.lastActivityAt ? relative(copy.lastActivityAt, now) || 'just now' : 'none yet'}</Fact>
              <Fact id="copySeen" k="Last seen">{absolute(copy.lastSeenAt)}</Fact>
              <Fact id="copyFirstSeen" k="First pulse">{absolute(copy.firstSeenAt)}</Fact>
            </div>
            <h2>Turns per day</h2>
            <div className="card" id="copyHistory">
              {answer.days.length
                ? (
                  <>
                    <TurnsChart days={answer.days} />
                    <div className="copytablewrap">
                      <table className="copytable" id="copyDays">
                        <thead>
                          <tr><th scope="col">Day</th><th scope="col">Turns</th><th scope="col">People</th><th scope="col">Agents</th><th scope="col">Release</th></tr>
                        </thead>
                        <tbody>
                          {answer.days.map((day) => (
                            <tr key={day.day} data-day={day.day}>
                              <th scope="row">{shortDay(day.day)}{day.pulseEnabled ? '' : ' · off'}</th>
                              <td>{day.turns24h.toLocaleString('en-US')}</td>
                              <td>{day.people.toLocaleString('en-US')}</td>
                              <td>{day.agents.toLocaleString('en-US')}</td>
                              <td>{day.release ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )
                : <div className="empty">No daily rows yet.</div>}
            </div>
          </>
        )
        : null}
    </div>
  );
}
