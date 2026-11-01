/**
 * An agent's face with its context fill drawn around it, or the bare face in
 * the same slot when there is nothing to draw.
 *
 * Wrapped either way, and that is the point of the `blank` case: the wrapper
 * is what sets the face's size, so an agent with no measurement wearing a
 * BARE avatar would show a bigger face than the agents beside it and the list
 * would look ragged for a reason nobody could name. Same slot, same face,
 * ring or no ring.
 *
 * The ring is the only thing saying the number, so it says it in words too:
 * a reader not looking at colour gets nothing from a gradient.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { WorkspaceAgentContext } from '../../../src/shared/workspace-api.js';
import { contextHeat, contextHue, contextPercent } from './context-heat.js';

export function ContextRing({ context, children, tooltip = true }: {
  context: WorkspaceAgentContext | null | undefined;
  children: ReactNode;
  /** Off where the face already opens a card of its own on hover — the
   *  agents switcher's peek (note #713) — so a native tooltip does not
   *  surface over it a second later saying something else. The words stay
   *  for a screen reader either way. */
  tooltip?: boolean;
}) {
  const pct = contextPercent(context);
  if (pct === null) return <div className="ctxring blank">{children}</div>;
  const tier = contextHeat(pct);
  const label = `Context window ${pct}% full`;
  return (
    <div
      className={tier ? `ctxring ${tier}` : 'ctxring'}
      style={{ '--ctx-pct': String(pct), '--ctx-hue': String(contextHue(pct)) } as CSSProperties}
      role="img"
      aria-label={label}
      title={tooltip ? label : undefined}
    >
      {children}
    </div>
  );
}

/** The turning ring a machine that is still coming up wears instead. Two
 *  rings around one face would be a claim that both mean something. */
export function WorkingFace({ children }: { children: ReactNode }) {
  return <div className="working">{children}</div>;
}
