/**
 * What the chat holds while it is still being read (note #309).
 *
 * There are two waits on this screen and they are not the same wait. The
 * SHELL is out while the fleet read is — a pasted chat link, a reload — and
 * until it lands there is no name to pin, no composer and no pane: the whole
 * screen is the wait. The TRANSCRIPT is out on every chat opened for the
 * first time this page session, with the header and the composer already
 * standing; only the pane between them is empty.
 *
 * Both are built out of the same held bubbles, on purpose. A cold open that
 * loses its fleet race draws the shell around them and then hands the pane
 * over to the real one with the bubbles still in it — the wait carries on
 * where it was rather than starting again as something else.
 *
 * The proposal screen's three rules (note #299) hold here too, with one that
 * this screen adds.
 *
 *  - Draw only where the answer is CERTAIN to land. The header, the pane and
 *    the composer are on every chat ever drawn, so they are held every time.
 *    The BUBBLES are not: an agent nobody has ever spoken to answers with
 *    "Nothing here yet — say hello", and a wait that drew a conversation over
 *    that would have lied about the one thing the reader came to see. So the
 *    caller says whether this conversation is known to have been had — the
 *    fleet row carries the agent's own last words — and the pane holds
 *    nothing at all when it has not.
 *  - Stand in the SAME boxes. Every held row here is a real `.chatmsg` with
 *    a real `.chathead` above it and a real `.chatbar` below: only their
 *    fills are borrowed. That matters most at the bottom edge — a wait that
 *    left the composer out would give the transcript the composer's height
 *    for as long as it lasted, and take it back the moment the read landed,
 *    which is the whole conversation jumping (note #302).
 *  - Decoration, so `aria-hidden`. The words come from the one `.sr-only`
 *    line the screen says and from `aria-busy` on the screen itself.
 *
 * And the one this screen adds: THE HELD PANE IS NOT THE REAL PANE. The
 * transcript's scroller is a ref the whole screen scrolls through, and the
 * layout effect that opens a conversation at its newest message waits for
 * that ref to exist before it spends its follow. A wait that put the ref on
 * its own pane would spend the follow on a box that is about to be thrown
 * away, and the conversation would open at its FIRST message (note #278).
 * So nothing here is given a ref, and nothing here carries a live id.
 */

import { SkelText } from '../../ui/Skel.js';
import { Svg } from '../../ui/icons.js';

/**
 * The run of held turns.
 *
 * Alternating sides with the last word the agent's, because that is the
 * shape of a conversation with an agent — and the shape is the whole of what
 * a wait can honestly promise. Widths are explicit rather than left to the
 * content: a real bubble is as wide as its words and caps at 86%, and a
 * percentage inside a box that is sizing itself to its content resolves
 * against nothing.
 *
 * Long enough to reach the foot of a phone's pane, because a chat opens at
 * its NEWEST message: what the reader is about to be shown is a pane full of
 * conversation, and a short run of held turns at the top of an otherwise
 * empty box promises something smaller than what lands. It costs nothing to
 * overrun a short pane — the wait never scrolls, and the pane it overruns is
 * one the transcript is about to fill past its own end anyway.
 */
const TURNS: Array<{ side: 'agent' | 'owner'; width: string; lines: string[] }> = [
  { side: 'agent', width: '78%', lines: ['100%', '54%'] },
  { side: 'owner', width: '52%', lines: ['100%'] },
  { side: 'agent', width: '84%', lines: ['100%', '100%', '46%'] },
  { side: 'owner', width: '61%', lines: ['100%', '38%'] },
  { side: 'agent', width: '69%', lines: ['100%'] },
  { side: 'owner', width: '46%', lines: ['100%'] },
  { side: 'agent', width: '86%', lines: ['100%', '100%', '71%'] },
  { side: 'owner', width: '58%', lines: ['100%', '42%'] },
  { side: 'agent', width: '74%', lines: ['100%', '100%'] },
  // Two of the agent's in a row, which is what an agent's conversation
  // actually looks like — and which puts the real stylesheet's own rule for
  // that pair (a 2px gap and a squared-off corner) under the wait as well.
  { side: 'agent', width: '63%', lines: ['100%', '51%'] },
];

/** One held turn: the bubble's own box, its own corner cut, and its lines. */
function SkelTurn({ side, width, lines, at }: {
  side: 'agent' | 'owner';
  width: string;
  lines: string[];
  at: number;
}) {
  return (
    <div className={`chatmsg ${side} chatwaitmsg`} style={{ width }} aria-hidden="true">
      {lines.map((line, row) => (
        <SkelText key={row} width={line} delay={`${(at * 0.12 + row * 0.06).toFixed(2)}s`} />
      ))}
    </div>
  );
}

/** The transcript, held. Sits where the real rows sit — inside the log, which
 *  is the flex column that gives each bubble its side. */
export function ChatWaitTurns() {
  return <>{TURNS.map((turn, at) => <SkelTurn key={at} {...turn} at={at} />)}</>;
}

/**
 * The whole screen, for a chat opened before the fleet read has said who is
 * answering.
 *
 * Back is drawn as ITSELF rather than held. It works without knowing anything
 * about the agent, and a reader whose cold open is slow should not be shut in
 * with a breathing rectangle and no way out of it — which is what this screen
 * used to be. What is HELD is only what the read has to answer for: the face,
 * the name, and the line saying what it thinks with.
 *
 * The composer is held rather than offered, for the reason the proposal's
 * decision bar is: a box that takes a message the screen cannot send yet is
 * a promise it cannot keep.
 */
export function ChatShellWait({ turns, onBack }: {
  turns: boolean;
  onBack: () => void;
}) {
  return (
    <>
      <div className="chathead">
        <button className="back" type="button" onClick={onBack}><Svg name="back" size={20} />Back</button>
        <div className="chatface" aria-hidden="true">
          <div className="ctxring blank"><span className="skel face" /></div>
        </div>
        <div className="chatwho" aria-hidden="true">
          <h1><span className="skel skel-inline" style={{ width: '128px', height: '15px' }} /></h1>
          {/* The runtime line is a FLEX row whose chevron sets its height, so
              the wrapper is the flex item and the bar sits inside it — a bare
              bar would stand at its own 10px where a whole 18px line stands
              now, and the header would grow when the name landed. */}
          <div className="sub chatruntime chatwaitruntime">
            <span><span className="skel skel-inline" style={{ width: '104px', height: '10px' }} /></span>
          </div>
        </div>
      </div>
      <div className="chatpane">
        <div className="chatwaitlog">{turns ? <ChatWaitTurns /> : null}</div>
      </div>
      <ChatWaitBar />
    </>
  );
}

/**
 * The composer, held. With `agents`, the door to the agents and rooms stands
 * before the pill, as it does on Home and on every chat in a workplace
 * (note #718): three held faces in the stack's own box — the most the real
 * stack shows — so the bar is the width it lands at.
 */
export function ChatWaitBar({ agents = false }: { agents?: boolean }) {
  return (
    <div className="chatbar chatwaitbar" aria-hidden="true">
      <div className="row">
        {agents
          ? (
            <span className="chatagents chatwaitagents">
              <span className="skel chatwaitface" />
              <span className="skel chatwaitface" />
              <span className="skel chatwaitface" />
            </span>
          )
          : null}
        <div className="chatinput">
          <span className="chatattach"><span className="skel skel-glyph" /></span>
          <span className="chatwaitbox"><span className="skel skel-inline" style={{ width: '46%', height: '11px' }} /></span>
        </div>
        <span className="skel skel-send" />
      </div>
    </div>
  );
}
