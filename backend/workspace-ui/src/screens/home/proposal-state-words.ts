/** The proposal states as every list words them — Home's queue, an agent's
 *  history, and the Chief of Staff's forwarded cards (note #724). */

/**
 * What became of a proposal, as coloured text — for a list where the states
 * MIX. Two of them carry hue because two are what such a list is asking:
 * green for landed, and the accent for one still waiting on you. Everything
 * else is grey — decided, and no longer anybody's move.
 */
export const PR_STATE_TEXT: Record<string, { label: string; tone: string }> = {
  open: { label: 'Awaiting approval', tone: '' },
  // Quiet (note #293): recorded, not yet made ready by its agent. Grey — it
  // is nobody's move, least of all the reader's.
  draft: { label: 'Still being prepared', tone: ' mut' },
  merged: { label: 'Merged', tone: ' ok' },
  rejected: { label: 'Rejected', tone: ' mut' },
  withdrawn: { label: 'Withdrawn', tone: ' mut' },
  stale: { label: 'Went stale', tone: ' mut' },
  conflict: { label: 'Conflict', tone: ' warn' },
};

/**
 * The same shades for a knowledge proposal, in its OWN words rather than the
 * change vocabulary with one entry bent to fit: a change MERGES into a
 * branch, a page is APPROVED and lands on the base, and a row that said
 * "Merged" over a page would be describing something that never happened.
 * There is no `stale` here — a page that moves underneath a proposal ends as
 * a conflict, and nothing else expires.
 */
export const KNOWLEDGE_STATE_TEXT: Record<string, { label: string; tone: string }> = {
  open: { label: 'Awaiting approval', tone: '' },
  draft: { label: 'Still being prepared', tone: ' mut' },
  approved: { label: 'Approved', tone: ' ok' },
  rejected: { label: 'Rejected', tone: ' mut' },
  withdrawn: { label: 'Withdrawn', tone: ' mut' },
  conflict: { label: 'Conflict', tone: ' warn' },
};
