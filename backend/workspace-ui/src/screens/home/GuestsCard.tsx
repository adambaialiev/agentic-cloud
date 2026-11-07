import { useCallback, useEffect, useState } from 'react';
import type { GuestState, GuestTranscriptRecord, WorkspaceGuestsAnswer } from '../../../../src/shared/guest-agent.js';
import { useSession } from '../../session/useSession.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { Markdown } from '../../render/Markdown.js';
import { relative } from '../../ui/time.js';

type Transcript = GuestTranscriptRecord & { state: GuestState; partial: string | null };

const REMOVED_WORDS: Record<string, string> = {
  quiet: 'went after 30 quiet minutes',
  visitor: 'deleted by the visitor',
  owner: 'deleted by you',
  lifetime: 'reached its 3 hours',
  messages: 'used its 40 messages',
};

const STATE_WORDS: Partial<Record<GuestState, string>> = {
  creating: 'Getting ready',
  ready: 'Ready',
  working: 'Working',
  asleep: 'Asleep',
};

/**
 * The Guests group (note #1038): every agent a visitor of the home page made
 * in this workplace, collapsed at the foot of the agents list. Live ones
 * first, then the last 90 days. Opening one shows its conversation,
 * read-only — the person reads and may delete, but never types into a
 * guest's chat. Drawn only for the person whose workplace guests are made
 * in (the read answers 404 to everyone else).
 */
export function GuestsCard({ now }: { now: number }) {
  const { api } = useSession();
  // Asked only where guests are made: everyone else is never sent a read that would answer 404.
  const here = Boolean(useWorkspace().state?.guestsHere);
  const [list, setList] = useState<WorkspaceGuestsAnswer | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [opened, setOpened] = useState<Transcript | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const transcript = opened && opened.agentId === open ? opened : null;

  const read = useCallback(async () => {
    try {
      setList(await api.api<WorkspaceGuestsAnswer>('api/guests'));
    } catch {
      /* not this person's workplace, or not reachable: draw nothing */
    }
  }, [api]);

  useEffect(() => {
    if (!here) return undefined;
    const first = setTimeout(() => { void read(); }, 0);
    const timer = setInterval(() => { void read(); }, expanded ? 10_000 : 60_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [read, expanded, here]);

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const load = () => api.api<Transcript>(`api/guests/${encodeURIComponent(open)}`)
      .then((answer) => { if (live) setOpened(answer); })
      .catch(() => undefined);
    void load();
    const timer = setInterval(() => { void load(); }, 4_000);
    return () => { live = false; clearInterval(timer); };
  }, [api, open]);

  const remove = useCallback(async (agentId: string) => {
    setConfirming(null);
    try {
      await api.api(`api/guests/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
    } catch {
      /* the list says what happened */
    }
    void read();
  }, [api, read]);

  if (!here || !list) return null;
  const rows = [
    ...list.live.map((row) => ({ ...row, live: true as const, meta: [STATE_WORDS[row.state] ?? row.state, `${row.messages} message${row.messages === 1 ? '' : 's'}`, `made ${relative(row.createdAt, now) || 'just now'}`].join(' · ') })),
    ...list.past.map((row) => ({ ...row, live: false as const, meta: [`${row.messages} message${row.messages === 1 ? '' : 's'}`, REMOVED_WORDS[row.removedReason ?? 'quiet'] ?? 'removed', relative(row.removedAt ?? row.createdAt, now) || 'just now', ...(row.costUsd ? [`$${row.costUsd.toFixed(2)} at API prices`] : [])].join(' · ') })),
  ];
  return (
    <div className="card" id="agentGuests">
      <button className="drow visitrow" type="button" id="agentGuestsToggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <div className="k">{`Guests · ${list.live.length} live`}</div>
        <div className="v dim">{`Agents visitors made on the home page: ${list.madeToday} of ${list.limits.globalPerDay} today, each built on its own computer when its visitor asked. Read-only; kept 90 days, nothing about a visitor beyond what they typed.`}</div>
      </button>
      {!expanded ? null : rows.length === 0
        ? <div className="empty" id="agentGuestsEmpty">No visitor has made an agent yet.</div>
        : rows.map((row) => (
          <div className="visit" key={row.agentId} data-open={open === row.agentId ? '1' : undefined} data-live={row.live ? '1' : undefined}>
            <button className="drow visitrow" type="button" aria-expanded={open === row.agentId} onClick={() => setOpen(open === row.agentId ? null : row.agentId)}>
              <div className="v visitfirst">
                {row.avatarUrl ? <img className="guestface" src={row.avatarUrl} alt="" width={20} height={20} /> : null}
                {row.name}
              </div>
              <div className="v dim">{row.meta}</div>
            </button>
            {open === row.agentId
              ? (
                <div className="visitthread">
                  {row.live
                    ? confirming === row.agentId
                      ? (
                        <div className="guestconfirm">
                          <span>{`Delete ${row.name}? Its machine goes with it; the visitor sees it was removed.`}</span>
                          <button type="button" className="btn danger" onClick={() => { void remove(row.agentId); }}>{`Delete ${row.name}`}</button>
                          <button type="button" className="btn" onClick={() => setConfirming(null)}>Keep</button>
                        </div>
                      )
                      : <button type="button" className="btn guestdelete" onClick={() => setConfirming(row.agentId)}>Delete</button>
                    : null}
                  {!transcript
                    ? <div className="empty">Opening…</div>
                    : (
                      <>
                        {transcript.messages.map((message) => (
                          <div className="visitturn" key={message.id} data-role={message.role} data-state={message.state}>
                            {message.role === 'visitor'
                              ? <div className="visitq">{message.text}</div>
                              : <Markdown className="visita" source={message.text} />}
                            <div className="v dim">
                              {[relative(message.at, now) || 'just now', ...(message.seconds !== undefined ? [`${message.seconds} s`] : []), ...(message.costUsd !== undefined ? [`$${message.costUsd.toFixed(2)} at API prices`] : []), ...(message.state && message.state !== 'answered' ? [message.state] : [])].join(' · ')}
                            </div>
                            {message.flag ? <div className="hintblock visitflag">{message.flag}</div> : null}
                            {message.activity?.length
                              ? <div className="v dim visitfiles">{message.activity.map((item) => `${item.kind} ${item.label}`).join(' · ')}</div>
                              : null}
                          </div>
                        ))}
                        {transcript.partial ? <div className="visitturn" data-state="working"><div className="v dim">Writing…</div><Markdown className="visita" source={transcript.partial} /></div> : null}
                      </>
                    )}
                </div>
              )
              : null}
          </div>
        ))}
    </div>
  );
}
