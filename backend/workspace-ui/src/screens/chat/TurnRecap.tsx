/**
 * The recap line under a conversation's latest completed turn (note #945).
 *
 * The owner, 2026-11-01, with a screenshot of his terminal Claude Code: "recap
 * line like in terminal claude code." Two muted lines under the end of the
 * turn — the platform's facts about it, then the recap in italics:
 *
 *   Worked for 12s · done 8:38 PM · 1 background job still running
 *   Recap: We're setting up … Next, add the 17 records, then reply "done".
 *
 * The recap is the agent row's own (agent-row-recap-design, one source), and
 * it arrives after the reply, when the summary does: until then the facts
 * line stands alone — never a placeholder, never a spinner — and when a later
 * summary rewrites the recap the line changes in place.
 *
 * Only the LATEST completed turn wears it, and only while nothing newer is
 * happening: a running turn has its typing row, and a message on its way is
 * the reader's news. Older turns keep no line — the conversation above is the
 * history, and a line under every turn would be wallpaper (the note's own
 * worry: keep history readable).
 */

import type { WorkspaceTurnRecap } from '../../../../src/shared/turn-recap.js';
import { turnFacts } from './turn-recap-words.js';

export function TurnRecap({ id, turn, jobs, waiting }: { id: string; turn: WorkspaceTurnRecap; jobs?: number; waiting?: string[] }) {
  const facts = turnFacts(turn, { jobs, waiting });
  return (
    <div className="turnrecap" id={id} data-recap={turn.recap ? 'arrived' : 'none'}>
      {facts ? <p className="turnfacts">{facts}</p> : null}
      {/* Keyed on its words: a rewrite arrives as the first one did. */}
      {turn.recap ? <p className="turnrecaptext" key={turn.recap}>Recap: {turn.recap}</p> : null}
    </div>
  );
}
