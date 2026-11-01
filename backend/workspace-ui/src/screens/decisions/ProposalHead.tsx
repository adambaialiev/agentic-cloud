/**
 * The head of a proposal screen: the line under its name, the pills, who
 * proposed it, and the door to that agent.
 *
 * These are components rather than markup inside the screen because the screen
 * draws them TWICE — once from the live read, and once from the queue row the
 * reader tapped, while that read is still out. Sharing the blocks is what
 * makes "the wait sits in the same boxes as the answer" true by construction
 * instead of by two pieces of markup happening to agree.
 */

import { Link } from 'react-router-dom';
import { AgentHover } from '../../ui/AgentHover.js';
import { Icon } from '../../ui/icons.js';
import type { ReactNode } from 'react';

/** A branch, in the mono token a name travels in everywhere else — so
 *  `agent/ff-merge-ci` cannot break in half across two lines. */
export function BranchToken({ name }: { name: string }) {
  return <span className="branch"><Icon name="git" size={13} /><span className="bname">{name}</span></span>;
}

/**
 * Which repository, which number, and which requests it answers. The
 * repository's name was already printed in the accent colour every tappable
 * thing wears, so it read as a link long before it was one.
 */
export function ProposalEyebrow({ repoName, repoTo, number, notes, noteTo }: {
  repoName: string;
  repoTo: string | null;
  number?: number;
  notes?: ReadonlyArray<{ number: number; title?: string }>;
  noteTo?: (number: number) => string | null;
}) {
  return (
    <div className="sub eyebrow" id="prEyebrow">
      {repoTo
        ? <Link className="rname" to={repoTo}>{repoName}</Link>
        : <span className="rname">{repoName}</span>}
      {number ? ` · #${number}` : null}
      {notes?.length ? (
        <>
          {' · '}
          {/* One flex item for the whole run: commas between several notes are
              ordinary text inside it, not items of the eyebrow's gap, which
              would put that gap in FRONT of every comma. */}
          <span>
            {notes.map((note, at) => {
              const to = noteTo?.(note.number) ?? null;
              return (
                <span key={note.number}>
                  {at ? ', ' : null}
                  {to
                    ? <Link className="rname" to={to}>note #{note.number}</Link>
                    : <span className="rname">note #{note.number}</span>}
                </span>
              );
            })}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** What state it is in, and between which branches. */
export function ProposalPills({ pill, to, from }: {
  pill: { tone: string; text: string };
  to: string;
  from: string;
}) {
  return (
    <div className="pillrow" id="prPills">
      <span className={`pill ${pill.tone}`}>{pill.text}</span>
      <BranchToken name={to} />
      <span className="arrow">←</span>
      <BranchToken name={from} />
    </div>
  );
}

/**
 * Who proposed it and when, with the runtime under the signature.
 *
 * An agent brings its own face here exactly as it does on Home, and the face
 * is the way to the agent — its chat (`agentFaceTo`). An agent the fleet no longer has keeps its
 * picture and gets no door: a tap leading nowhere is worse than a picture
 * never offered as one.
 *
 * The face answers a POINTER too (note #295), in the same card the decision
 * queue's face raises — one gesture, one answer, wherever a proposal draws
 * an agent. Here it adds the one fact this block does not write out: whether
 * the agent is working right now.
 *
 * `runtime` is a node rather than a string because the wait puts a held line
 * there — the one fact on this row the queue does not carry.
 */
export function ProposalWho({ id, className = 'who', avatarUrl, agentId, agentTo, agentName, line, runtime, hidden }: {
  id: string;
  /** The knowledge queue's copy of this block is also the screen's `.sub`. */
  className?: string;
  avatarUrl?: string;
  /** Which agent the face is of, for the card a pointer raises on it. */
  agentId?: string;
  agentTo?: string | null;
  agentName?: string | null;
  line: ReactNode;
  runtime?: ReactNode;
  hidden?: boolean;
}) {
  return (
    <div className={className} id={id} hidden={hidden}>
      {avatarUrl ? (
        <AgentHover id={agentId} name={agentName} avatarUrl={avatarUrl}>
          {agentTo
            ? (
              <Link
                className="facebtn"
                to={agentTo}
                aria-label={agentName ? `Open ${agentName}` : 'Open this agent'}
              >
                <img className="face" src={avatarUrl} alt="" />
              </Link>
            )
            : <img className="face" src={avatarUrl} alt="" />}
        </AgentHover>
      ) : null}
      <div className="proposalby">
        <div>{line}</div>
        {runtime ? <div className="cruntime proposalruntime">{runtime}</div> : null}
      </div>
    </div>
  );
}

/**
 * The way to talk to the agent that wrote this (note #152): a question about
 * the change, or the "no, because…" the decision bar deliberately does not
 * collect. Absent rather than dead when there is nobody to open.
 *
 * A BUTTON, as the legacy page's is: `.btn` is a flex box either way, but an
 * anchor inherits the page's line-height where a form control does not, and
 * the four pixels that buys move every card under it.
 *
 * GHOST, not primary. This screen's primary tap is in the decision bar, so the
 * door keeps the accent but gives up the stronger primary weight. A door is
 * somewhere to go, not the thing to do.
 */
export function ChatDoor({ id, onPress }: { id: string; onPress: () => void }) {
  return (
    <button className="btn ghost" id={id} type="button" onClick={onPress}>
      <Icon name="message" size={17} /><span>Open chat</span>
    </button>
  );
}
