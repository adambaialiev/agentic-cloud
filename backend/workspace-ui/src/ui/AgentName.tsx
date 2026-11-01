/**
 * An agent's NAME, wherever the app writes it — and the crown its CLI's
 * flagship model wears beside it (notes #296, #324).
 *
 * The mark went on the face first; our user asked for it here instead, and
 * the name is the better home for two reasons worth keeping. A face is a
 * photograph nobody chose, so a mark on it competes with whatever that
 * picture already puts in the corner — and the ring around the face is a
 * gauge, so a mark hanging over its edge eats a reading. The name has
 * neither problem: it is our own type, on our own background, at a size we
 * set.
 *
 * ONE copy, for the same reason `AgentFace` is one copy. Six places write an
 * agent's name — the fleet row, its own header, the chat header, the `@`
 * picker, an unread reply and a handoff tile — and a crown drawn in five of
 * them is a crown that means nothing in the sixth.
 *
 * It renders the CONTENT of the caller's own element rather than an element
 * of its own, because those six write the name into a div, a span and two
 * h1s carrying classes and ids the stylesheet and the tests key on. With no
 * crown the name comes out as the bare text node every screen had before;
 * with one it is `.nametext` plus the mark, which is what the stylesheet's
 * `:has(> .crown)` rules key on to keep the crown out of a long name's
 * ellipsis.
 */

import type { WorkspaceAgentRow } from '../../../src/shared/workspace-api.js';
import { agentWearsCrown } from './agent-crown.js';

/**
 * Filled, not one of `icons.tsx`'s stroked 24px glyphs: this is drawn at the
 * size of the text beside it — 11px on a handoff tile — and at eleven pixels
 * an outline crown is five grey hairs. Sized in `em` for the same reason, so
 * one declaration serves the 21px title on the agent's own screen and that
 * 11px tile without either of them naming a pixel.
 *
 * Decorative: every screen that draws it also writes the model in words,
 * either in the runtime line under the name or in the picker the line opens.
 */
export function Crown() {
  return (
    <svg className="crown" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.6 7.4 8 12.2 12 4.4l4 7.8 5.4-4.8-1.7 11.2H4.3Z" />
    </svg>
  );
}

export function AgentName({ agent }: { agent: Pick<WorkspaceAgentRow, 'name' | 'model'> }) {
  if (!agentWearsCrown(agent.model)) return <>{agent.name}</>;
  return (
    <>
      <span className="nametext">{agent.name}</span>
      <Crown />
    </>
  );
}
