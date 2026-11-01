/**
 * What somebody else's agent screen says about itself (note #640).
 *
 * Kept beside the screen rather than inside it because these two sentences
 * are the whole of what makes a page with no buttons read as deliberate: the
 * reader arrived by tapping a face, and the first thing they must learn is
 * that this agent is not theirs to drive — not that something failed to load.
 */

/** Who drives it, and what that means for the reader — named where the
 *  workplace can name them, and honest where it cannot.
 *
 *  `yours` is the rare case this screen also has to answer for: an agent of
 *  the reader's OWN that the fleet on this device is not carrying — one being
 *  deleted, or a list read that has not landed. Its control room is reached
 *  from the fleet, so the page says where rather than offering a door that
 *  leads back to this same address. */
export function otherAgentAbout(ownerName?: string, yours?: boolean): string {
  // "Move it" went with the rooms it moved between (note #843).
  if (yours) return 'Your own agent. Open it from your agents on Home to change what it runs or message it.';
  const whose = ownerName ? `${ownerName}’s agent` : 'A teammate’s agent';
  return `${whose}. You can see what it is and what it has been doing; only ${ownerName ?? 'its owner'} can message it or change how it runs.`;
}

/** The row that names the human behind it. "Driven by", not "Owner": the
 *  agent belongs to the workplace's work, and what this row answers is who
 *  to ask about it. */
export const otherAgentOwnerLabel = 'Driven by';
