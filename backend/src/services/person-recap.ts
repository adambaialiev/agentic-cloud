import type { OrgMembershipDocument } from '../types/org.js';

/**
 * The People page's two live facts about a HUMAN in a workplace (note
 * #328): whether they are here right now, and one line on the latest thing
 * they drove. The agent rows have a summarizer (agent-recap.ts); a person
 * has, for now, the platform's own record of what they did — the action
 * routes write it, the tick reads it. What a summarizer would add on top is
 * written up on the knowledge page `people-page-and-person-recap`.
 *
 * Pure: the router owns storage and clocks, this module owns the words and
 * the thresholds, so the page and the tests read the same rule.
 */

/**
 * How often an authenticated request may write the seen-stamp. The Workspace
 * ticks every five seconds while open, so a stamp per request would be a
 * write per tick per reader; once a minute is plenty for a fact read to the
 * minute — and the window below is sized against it.
 */
export const PERSON_SEEN_STAMP_MS = 60_000;

/**
 * "Here now" means the Workspace is open in front of them: a stamp newer
 * than this. Three minutes is the stamp interval with room for one missed
 * tick; a hidden tab stops ticking, so a person who put the phone down
 * fades to "Active 3m ago" rather than reading as here all afternoon.
 */
export const PERSON_HERE_WINDOW_MS = 3 * 60_000;

/** One brief line beside the other people in the workplace — the same
 *  design length the agent rows are written to. */
export const PERSON_RECAP_MAX_LENGTH = 120;

/** A title quoted inside a recap line gets this much before an ellipsis, so
 *  the verb and the number — the half that says what happened — stay. */
const PERSON_RECAP_TITLE_MAX_LENGTH = 60;

export function personIsHere(lastSeenAt: string | undefined, nowMs = Date.now()): boolean {
  if (!lastSeenAt) return false;
  const seen = Date.parse(lastSeenAt);
  return Number.isFinite(seen) && nowMs - seen < PERSON_HERE_WINDOW_MS;
}

/** The membership's live half as the page receives it: absent fields, never
 *  empty ones, so `here` reads as a fact and not a false. */
export function personLiveFields(
  membership: Pick<OrgMembershipDocument, 'lastSeenAt' | 'recap'>,
  nowMs = Date.now(),
): { lastSeenAt?: string; here?: true; recap?: string; recapAt?: string } {
  return {
    ...(membership.lastSeenAt ? { lastSeenAt: membership.lastSeenAt } : {}),
    ...(personIsHere(membership.lastSeenAt, nowMs) ? { here: true as const } : {}),
    ...(membership.recap?.text
      ? { recap: membership.recap.text, ...(membership.recap.at ? { recapAt: membership.recap.at } : {}) }
      : {}),
  };
}

/** Control characters out, whitespace collapsed, cut at a word boundary with
 *  an ellipsis — the agent recap's normalizer at the row's own length. */
export function personRecapText(raw: string, max = PERSON_RECAP_MAX_LENGTH): string {
  const line = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${kept.replace(/[\s,;:.!?-]+$/, '')}…`;
}

function quoted(title: string | undefined): string {
  const clean = personRecapText(title ?? '', PERSON_RECAP_TITLE_MAX_LENGTH);
  return clean ? `: ${clean}` : '';
}

/**
 * The lines the action routes write — plain facts every member of the
 * workplace can already see elsewhere (an agent's name and that it is
 * working, a proposal's title, a note's title). Never the words of a message
 * to an agent: that chat is the owner's alone.
 */
export const personActionLines = {
  messaged: (agentName: string | undefined): string => personRecapText(`Messaged ${agentName || 'an agent'}`),
  /** The room's reset button (note #707), however many it asked. */
  askedFreshChats: (agentNames: string[]): string => personRecapText(
    `Asked ${agentNames.length === 1 ? agentNames[0] : `${agentNames.length} agents`} to start a fresh chat`,
  ),
  decidedProposal: (decision: 'approve' | 'reject', number: number, title: string | undefined): string => personRecapText(
    `${decision === 'approve' ? 'Approved' : 'Rejected'} proposal #${number}${quoted(title)}`,
  ),
  decidedKnowledge: (decision: 'approve' | 'reject', number: number, title: string | undefined): string => personRecapText(
    `${decision === 'approve' ? 'Approved' : 'Rejected'} knowledge proposal #${number}${quoted(title)}`,
  ),
  /** Put a knowledge page back from its History (note #746). */
  restoredKnowledge: (page: string, number: number): string => personRecapText(`Put knowledge page "${page}" back (change #${number})`),
  wroteNote: (number: number, title: string | undefined): string => personRecapText(`Wrote note #${number}${quoted(title)}`),
  handedNote: (number: number, agentName: string | undefined): string => personRecapText(
    `Handed note #${number} to ${agentName || 'an agent'}`,
  ),
};
