/**
 * The details-page reading behind an agent's avatar ring.
 *
 * Kept as one component for room agents and the Workspace Agent: both are
 * measurements of the last prompt their own conversation sent, and the
 * number, heat thresholds, token wording and in-flight caveat must not drift
 * merely because one agent belongs to a room and the other to a person.
 */

import type { WorkspaceAgentContext } from '../../../src/shared/workspace-api.js';
import { compactTokens } from './file-kind.js';
import { contextHeat, contextPercent } from './context-heat.js';
import { TypeIcon } from './icons.js';
import { relative } from './time.js';

export function ContextUsageRow({ context, busy }: {
  context: WorkspaceAgentContext | null | undefined;
  busy: boolean;
}) {
  const pct = contextPercent(context);
  if (pct === null || !context) return null;
  const heat = contextHeat(pct);
  return (
    <div className="crow contextrow">
      <TypeIcon glyph="gauge" />
      <div className="main">
        <div className="name plain">Context window</div>
        <div className="cline wrap">
          <span className="ctext">
            {pct}% used · {compactTokens(context.tokens)} of {compactTokens(context.window)} tokens
            {context.at ? ` · ${relative(context.at)}` : ''}
          </span>
        </div>
        <div className={heat ? `meter ${heat}` : 'meter'}>
          <div className={heat ? `meter-fill ${heat}` : 'meter-fill'} style={{ width: `${pct}%` }} />
        </div>
        {busy ? <div className="cline wrap"><span className="ctext">Measured before the turn running now.</span></div> : null}
      </div>
    </div>
  );
}
