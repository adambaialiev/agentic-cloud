/**
 * When a completed turn's recap is the conversation's newest news (note #945).
 *
 * The recap block these words were written for left every chat with note
 * #1193 (see TurnRecap.tsx); what is left is the one question the Chief of
 * Staff's read-aloud still asks: is the latest turn over, with nothing newer
 * happening, so that its recap may be spoken?
 */

import type { WorkspaceTurnRecap } from '../../../../src/shared/turn-recap.js';

/**
 * Whether the line belongs at the end of this conversation now: a completed
 * turn on record, nothing running or on its way, and the conversation's last
 * word not the reader's own (that starts the next turn), nor a reply newer
 * than the turn the record knows of.
 */
export function showsTurnRecap(
  turn: WorkspaceTurnRecap | undefined,
  conversation: { busy: boolean; last?: { role: string; at?: string }; lastReplyAt?: string },
): turn is WorkspaceTurnRecap {
  if (!turn || conversation.busy || !conversation.last) return false;
  if (conversation.last.role === 'owner') return false;
  const ended = Date.parse(turn.endedAt);
  const replied = Date.parse(conversation.lastReplyAt ?? '');
  return !Number.isFinite(replied) || replied <= ended;
}
