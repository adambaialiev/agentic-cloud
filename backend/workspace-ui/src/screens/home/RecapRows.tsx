/**
 * The Chief of Staff's own row shapes (note #725): what its conversation
 * shows of the platform's narration once `recapRowViews` has decided what
 * is news. The conversation itself, and the decision cards, stay
 * `ChatMessageRow`'s; these are the quiet shapes around them.
 */

import { Link, useNavigate } from 'react-router-dom';
import type { RecapLinePart, RecapRowView, RecapUnfinished } from '../../../../src/shared/recap-chat-rows.js';
import { toFor } from '../../routes.js';
import { useNoteRefs } from '../../render/useNoteRefs.js';
import { agentNamed } from '../../workspace/live.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { NoteLinked } from '../chat/ChatMessageRow.js';
import { badgeTone } from '../chat/chat-notice.js';

const moment = (at?: string) => (at ? new Date(at).toLocaleString() : undefined);
const arrivingClass = (arriving?: boolean) => (arriving ? ' arriving' : '');

/** A line's words with the agents in it named; a note in the words is a door, as in any message here. */
function Parts({ parts }: { parts: RecapLinePart[] }) {
  const notes = useNoteRefs();
  return <>{parts.map((part, at) => (typeof part === 'string'
    ? <NoteLinked key={at} text={part} notes={notes} />
    : <span className="recapname" key={at}>{part.agent}</span>))}</>;
}

/**
 * What the Chief of Staff did for the person: one line, and the message it
 * sent behind a tap — never split, as the generic receipt split it, into a
 * bold first sentence and a grey rest. No door: a message sent from here is
 * answered INTO this conversation (note #435).
 */
export function DidLine({ view, at, arriving }: { view: Extract<RecapRowView, { form: 'did' }>; at?: string; arriving?: boolean }) {
  const notes = useNoteRefs();
  const tag = view.own ? <span className="recaptag">on its own</span> : null;
  if (!view.body) {
    return <div className={`chatmsg recapdid${arrivingClass(arriving)}`} title={moment(at)}>{tag}<Parts parts={view.parts} /></div>;
  }
  return (
    <details className={`chatmsg recapdid${arrivingClass(arriving)}`} title={moment(at)}>
      <summary>{tag}<Parts parts={view.parts} /><span className="recapdidmore" aria-hidden="true" /></summary>
      <div className="recapdidbody"><NoteLinked text={view.body} notes={notes} /></div>
    </details>
  );
}

/** A hand-off that fell through, or a setting to fix — with the one door that helps. */
export function AttentionLine({ view, at, arriving, onOpenSettings }: {
  view: Extract<RecapRowView, { form: 'attention' }>;
  at?: string;
  arriving?: boolean;
  onOpenSettings: () => void;
}) {
  const { agents } = useWorkspace();
  const door = view.door;
  // The agent's own conversation: once a wait is over, nothing more will
  // land here, so the way to find out what happened is out of this one.
  const agent = door?.to === 'chat' ? agentNamed(agents, door.agent) : null;
  return (
    <div className={`chatmsg recapattention${view.tone === 'warn' ? ' warn' : ''}${arrivingClass(arriving)}`} title={moment(at)}>
      <div><Parts parts={view.parts} /></div>
      {door?.to === 'settings'
        ? <button className="recapdoor" type="button" onClick={onOpenSettings}>Check my settings</button>
        : agent
          ? <Link className="recapdoor" to={toFor({ kind: 'chat', id: agent.id })!}>{`Open ${agent.name}'s chat`}</Link>
          : null}
    </div>
  );
}

/**
 * The Chief of Staff asked the person to remove an agent (note #710): a
 * decision, so a card like the proposal and email cards, with the door to
 * the agent's screen where it is decided — and, once it has been, what was
 * decided rather than an ask nobody can answer any more.
 */
export function RemoveAgentCard({ view, at, arriving }: { view: Extract<RecapRowView, { form: 'remove-agent' }>; at?: string; arriving?: boolean }) {
  const { agents } = useWorkspace();
  const navigate = useNavigate();
  const agent = agentNamed(agents, view.agent);
  const named = (agents ?? []).some((candidate) => (candidate.name ?? '').trim().toLowerCase() === view.agent.trim().toLowerCase());
  // No agent by that name any more: removed. One without the ask: kept. Two
  // answering to the name: still asked, with no door to the wrong one.
  const state = !agents || (!agent && named) || agent?.removeAsk ? 'asked' : agent ? 'kept' : 'removed';
  const to = state === 'asked' && agent ? toFor({ kind: 'agent', id: agent.id }) : null;
  const badge = state === 'asked' ? 'Your decision' : state === 'kept' ? 'Kept' : 'Removed';
  const title = state === 'asked' ? `Remove ${view.agent}?` : state === 'kept' ? `${view.agent} was kept` : `${view.agent} was removed`;
  const door = `Decide on ${view.agent}'s screen`;
  const card = (
    <div className="chatnotice">
      <div className="chatnoticebody">
        <div className="chatnoticehead">
          <span className="chatnoticelabel">Remove an agent</span>
          <span className={badgeTone(state === 'asked' ? 'act' : 'mut')}>{badge}</span>
        </div>
        <div className="chatnoticetitle">{title}</div>
        {view.reason ? <div className="chatnoticedetail">{`${view.reason.charAt(0).toUpperCase()}${view.reason.slice(1)}.`}</div> : null}
        {to ? <div className="chatnoticedoor">{door}</div> : null}
      </div>
    </div>
  );
  const className = `chatmsg platform recapremove${arrivingClass(arriving)}`;
  if (!to) return <div className={className} title={moment(at)}>{card}</div>;
  return <button className={className} type="button" title={moment(at)} aria-label={`${door}: ${title}`} onClick={() => navigate(to)}>{card}</button>;
}

/** What the platform noticed (note #716), over the reply it led to, with a door to the thing itself. */
export function NoticedLine({ text, href, at, arriving }: { text: string; href?: string; at?: string; arriving?: boolean }) {
  return (
    <div className={`chatmsg recapnoticed${arrivingClass(arriving)}`} title={moment(at)}>
      <span className="recapnoticedlabel">Noticed</span>{text}
      {href ? <Link className="recapdoor" to={href}>Open</Link> : null}
    </div>
  );
}

/** The mark under the person's own words when their request did not complete. */
export function UnfinishedMark({ unfinished, busy, onRetry }: { unfinished: RecapUnfinished; busy: boolean; onRetry: (retry: 'resend' | 'continue') => void }) {
  const { retry } = unfinished;
  return (
    <div className="chatmsg recapunfinished">
      {unfinished.reason}
      {retry ? <> · <button className="recapdoor" type="button" disabled={busy} onClick={() => onRetry(retry)}>{retry === 'continue' ? 'Continue' : 'Send again'}</button></> : null}
    </div>
  );
}

/** A failure with no words of the person's above it: one quiet line where it happened. */
export function UnfinishedLine({ reason, at, arriving }: { reason: string; at?: string; arriving?: boolean }) {
  return <div className={`chatmsg chatquiet${arrivingClass(arriving)}`} title={moment(at)}>{reason}</div>;
}
