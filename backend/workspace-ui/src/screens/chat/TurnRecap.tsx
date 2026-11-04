/**
 * The recap line under a conversation's latest completed turn (note #945).
 *
 * The owner, 2026-11-01, with a screenshot of his terminal Claude Code: "recap
 * line like in terminal claude code." Since note #976 (Adam, 2026-11-04: "in
 * the chief of staff chat recaps should be more readable"; he chose the thin
 * left rule from three mock-ups) it reads as news, not as a caption: the
 * facts line small and muted, wearing a RECAP chip once there is a recap,
 * then the recap itself upright in the body face and colour, left in the
 * reply's column at about 60 characters, one sentence a line, behind a thin
 * rule in the hint colour:
 *
 *   [RECAP] Worked for 12s · done 8:38 PM · 1 background job still running
 *   | We're setting up …
 *   | Next, add the 17 records, then reply "done".
 *
 * One look in every conversation that draws it: the Chief of Staff's and
 * every agent's.
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
import { recapSentences, turnFacts } from './turn-recap-words.js';

export function TurnRecap({ id, turn, jobs, waiting }: { id: string; turn: WorkspaceTurnRecap; jobs?: number; waiting?: string[] }) {
  const facts = turnFacts(turn, { jobs, waiting });
  return (
    <div className="turnrecap" id={id} data-recap={turn.recap ? 'arrived' : 'none'}>
      {facts || turn.recap
        ? (
          <p className="turnfacts">
            {/* The label once there is something it labels: never over a missing recap. */}
            {turn.recap ? <span className="recaptag">Recap</span> : null}
            {facts ? <span className="turnfactswords">{facts}</span> : null}
          </p>
        )
        : null}
      {/* Keyed on its words: a rewrite arrives as the first one did. */}
      {turn.recap
        ? (
          <div className="turnrecaptext" key={turn.recap}>
            {recapSentences(turn.recap).map((sentence, at) => <p key={at}>{sentence}</p>)}
          </div>
        )
        : null}
    </div>
  );
}
