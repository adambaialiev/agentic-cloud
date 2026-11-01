import type { WorkspaceForwardedProposal } from '../../../../src/shared/workspace-recap-chat.js';
import { KNOWLEDGE_STATE_TEXT, PR_STATE_TEXT, prStateKey } from '../home/proposal-state-words.js';

/** The queue's tone, in the notice's own status classes. */
const STATUS_TONE: Record<string, string> = { '': 'act', ' ok': 'ok', ' mut': 'mut', ' warn': 'danger' };

/** The words the card's status says: the queue's own, except that an open
 *  proposal says whose move it is — the reader's, or a teammate's. */
export function forwardedState(entry: WorkspaceForwardedProposal): { label: string; tone: string } {
  const proposal = entry.pr ?? entry.knowledge;
  if (!proposal) return { label: 'No longer there', tone: 'mut' };
  const status = proposal.status === 'open' && proposal.draft ? 'draft' : proposal.status;
  if (status === 'open' && !proposal.canDecide) return { label: 'Awaiting a teammate', tone: 'mut' };
  const words = entry.pr ? PR_STATE_TEXT[prStateKey(entry.pr)] : KNOWLEDGE_STATE_TEXT[status];
  return words ? { label: words.label, tone: STATUS_TONE[words.tone] ?? 'mut' } : { label: String(status || ''), tone: 'mut' };
}

/** What the door says — the room agents' proposal cards' own words: an ask
 *  is decided, an outcome is read. */
export function forwardedDoor(entry: WorkspaceForwardedProposal): string | null {
  const proposal = entry.pr ?? entry.knowledge;
  if (!proposal) return null;
  if (proposal.status === 'open' && !proposal.draft && proposal.canDecide) return 'Review and decide';
  if (proposal.status === 'merged') return 'See what changed';
  return 'See the proposal';
}
