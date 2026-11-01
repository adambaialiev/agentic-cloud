/**
 * Who asked, and of whom, on a request an agent left on a repository or a
 * site (2026-09-23).
 *
 * A request the reader cannot decide used to read "A deletion request is
 * waiting for its agent's owner" — naming neither the agent nor the person,
 * because the server searched only the reader's own fleet for the name. It
 * searches the whole workplace now, and says whose agent it was, so the line
 * says both: "Leo asked Dana Ives to delete this site". The reader's own
 * request is still asked of "you".
 */

import type { WorkspaceRepoAsk } from '../../../src/shared/workspace-api.js';
import { personName } from './chief-of-staff.js';

export function askedOf(ask: Pick<WorkspaceRepoAsk, 'canDecide' | 'byAgentName' | 'byOwnerName'>): string {
  const asker = ask.byAgentName ? personName(ask.byAgentName) : 'An agent';
  if (ask.canDecide !== false) return `${asker} asked you`;
  return `${asker} asked ${ask.byOwnerName || 'its owner'}`;
}
