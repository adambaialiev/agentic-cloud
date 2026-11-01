/**
 * What a proposal screen holds while its live read is still out.
 *
 * Two rules, and the second is the one worth building for.
 *
 * It draws only where the answer is CERTAIN to land. The pills, the signature
 * and the summary card are on every proposal screen; the write-up, the chat
 * door, the linked notes and the decision bar are not, so those are held only
 * when the row that opened the screen already says they are there. A held box
 * that turns out to have nothing in it moves the page just as badly as one
 * that was never held.
 *
 * And it stands in the SAME boxes the real rows do — the same containers, the
 * same 28px mark, the same right-hand column — so nothing shifts under the
 * reader's eye when the read lands. A skeleton that makes the page jump is
 * worse than the word "Loading", which at least stayed still.
 *
 * Everything here is `aria-hidden`: it is decoration. The words a screen
 * reader needs come from the `.sr-only` line the screen says once, and from
 * `aria-busy` on the screen itself.
 */

import { SkelText } from '../../ui/Skel.js';

/** One summary row: the mark, the name, and the one number on the right. */
export function SkelRow({ name, side, at = 0 }: { name: string; side: string; at?: number }) {
  const delay = `${(at * 0.12).toFixed(2)}s`;
  return (
    <div className="crow" aria-hidden="true">
      <span className="skel skel-mark" style={{ animationDelay: delay }} />
      <div className="main"><div className="skel skel-line" style={{ width: name, animationDelay: delay }} /></div>
      <span className="skel skel-side" style={{ width: side, animationDelay: delay }} />
    </div>
  );
}

/**
 * The summary card: how big the change is, its commits, and what CI made of
 * it. An open proposal carries all three rows; a decided one has no Actions
 * row, because the checks that matter by then are the ones on main and those
 * belong to the delivery card.
 */
export function SkelSummary({ rows = 3 }: { rows?: number }) {
  const shape = [{ name: '52%', side: '58px' }, { name: '38%', side: '0px' }, { name: '31%', side: '84px' }];
  return (
    <div className="card" id="prSummaryWait" aria-hidden="true">
      {shape.slice(0, rows).map((row, at) => <SkelRow key={at} name={row.name} side={row.side} at={at} />)}
    </div>
  );
}

/** Which repository and which number — the one line under the name. It is on
 *  every proposal screen ever drawn, and it lives in the HEADER, so a wait
 *  that leaves it out shortens the header and pushes the whole screen up when
 *  the read lands. */
export function SkelEyebrow() {
  return (
    <div className="sub eyebrow" id="prEyebrowWait" aria-hidden="true">
      {/* Wrapped, because the eyebrow is a FLEX row: a bare bar would become a
          flex item and stand at its own 11px, where the name it replaces
          stands at a whole line of 13px text. The wrapper is the flex item and
          keeps that line box; the bar is inline inside it. */}
      <span><span className="skel skel-inline" style={{ width: '146px', height: '11px' }} /></span>
    </div>
  );
}

/** The state and the two branches, for a screen opened cold — from a link, or
 *  from a list that is not the decision queue. */
export function SkelPills() {
  return (
    <div className="pillrow" id="prPillsWait" aria-hidden="true">
      <span className="skel skel-pill" />
      <span className="skel skel-branch" style={{ width: '44px' }} />
      <span className="skel skel-branch" style={{ width: '118px' }} />
    </div>
  );
}

/** The signature, for a screen opened cold. The face is a circle because the
 *  one that replaces it is. */
export function SkelWho() {
  return (
    <div className="who" id="prWhoWait" aria-hidden="true">
      <span className="skel face" />
      <div className="proposalby">
        <SkelText width="58%" />
        <div className="cruntime proposalruntime"><SkelText width="42%" height={9} /></div>
      </div>
    </div>
  );
}

/** The runtime alone — what the queue row does NOT carry about an agent it
 *  otherwise names in full. */
export function SkelRuntime() {
  return <span className="skel skel-inline" style={{ width: '132px', height: '9px' }} aria-hidden="true" />;
}

/** The write-up, for a screen opened cold: the card it lands in, at a height a
 *  paragraph of it would fill. */
export function SkelWriteUp() {
  return (
    <div className="mdwrap" aria-hidden="true">
      <div className="md skel-md">
        {['96%', '88%', '92%', '61%'].map((width, at) => (
          <SkelText key={at} width={width} delay={`${(at * 0.09).toFixed(2)}s`} />
        ))}
      </div>
    </div>
  );
}

/**
 * The decision, held but not offered. The real bar's two buttons are the most
 * consequential taps in the Workspace, so the wait draws their room and
 * nothing that can be tapped — a fake Approve is a promise the screen cannot
 * keep until the read it is waiting for has landed.
 */
export function SkelDecide() {
  return (
    <div className="decidebar" id="prDecideWait" aria-hidden="true">
      <div className="actions">
        <span className="skel skel-btn" />
        <span className="skel skel-btn reject" />
      </div>
    </div>
  );
}

/**
 * One page a knowledge proposal would change, while the proposal is still
 * being read: what would happen to which page, the change itself, and the way
 * to read the page as it would be.
 *
 * The diff is the tall part of this card and there is no honest way to hold
 * its height — how many lines move IS the answer being waited for. What the
 * queue row does know is HOW MANY pages there are, so the wait draws one card
 * each: a reader learns the shape of the decision before its content.
 */
export function SkelKnowledgeChange({ at = 0 }: { at?: number }) {
  const delay = `${(at * 0.12).toFixed(2)}s`;
  return (
    <div className="card kchange" aria-hidden="true">
      <div className="khead">
        <span><span className="skel skel-inline" style={{ width: '58px', height: '10px', animationDelay: delay }} /></span>
        <span><span className="skel skel-inline" style={{ width: '96px', height: '10px', animationDelay: delay }} /></span>
      </div>
      <div className="skel-diff">
        {['84%', '67%', '91%', '48%'].map((width, line) => (
          <SkelText key={line} width={width} delay={`${(at * 0.12 + line * 0.09).toFixed(2)}s`} />
        ))}
      </div>
      <div className="crow kread">
        <span className="skel skel-mark" style={{ animationDelay: delay }} />
        <div className="main"><div className="skel skel-line" style={{ width: '108px', animationDelay: delay }} /></div>
      </div>
    </div>
  );
}
