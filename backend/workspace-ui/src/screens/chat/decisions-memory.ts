/**
 * The agents sheet's "waiting for your decision" list, as it was last read
 * (note #745).
 *
 * The owner, 2026-10-12: "if I close that window and open again, for a moment
 * it's empty, and after that only proposals are shown. It should be cached."
 * The sheet is built afresh every time it opens, and its list is a read of
 * every room's queue (`api/decisions`) that answers a moment later — so every
 * opening drew the agent cards alone and then pushed them down under the
 * proposals. The same answer the note, Drive and cloud screens got (notes
 * #306, #520): the read outlives the sheet, an opening draws the copy at
 * once, and the read goes out underneath it and replaces it in place.
 *
 * Kept in the tab's `sessionStorage` as well as in memory, so a reload — and
 * Safari dropping a page it was not showing, which on a phone is most of
 * them — opens on it too; the runtime line (note #735) is kept across visits
 * for the same reason. Per TAB rather than in `localStorage`: this is a live
 * reading of who is waiting on whom, and a tab nobody has opened for days
 * has no business painting it. Keyed by workplace, so a switch never shows
 * one workplace's queue in another's sheet, and only the fields a row draws
 * are kept: a write-up is not bounded, and nothing here needs it.
 *
 * What it never does is hand back a proposal already decided in this tab:
 * the sheet passes every copy, remembered or fresh, through note #743's
 * record (`workspace/decided.ts`), which is kept for exactly as long.
 * Forgotten on sign-out, because the next reader of this tab is someone else.
 */

import type { WorkspaceDecisionsAnswer } from '../../../../src/shared/workspace-api.js';

const KEY = 'agentbuilt.waitingDecisions';

/** Past this a remembered list is somebody else's afternoon: the sheet
 *  opens without one and waits for the read, as it always did. */
export const DECISIONS_KEPT_MS = 12 * 60 * 60_000;

interface Kept { at: number; answer: WorkspaceDecisionsAnswer }

const held = new Map<string, Kept>();

const shelf = (): Storage | null => {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
};

function stored(): Record<string, Kept> {
  try {
    const kept: unknown = JSON.parse(shelf()?.getItem(KEY) ?? '{}');
    return kept && typeof kept === 'object' ? kept as Record<string, Kept> : {};
  } catch {
    return {};
  }
}

const usable = (kept: Kept | undefined): kept is Kept => Boolean(kept)
  && typeof kept!.at === 'number' && Date.now() - kept!.at < DECISIONS_KEPT_MS
  && Array.isArray(kept!.answer?.prs) && Array.isArray(kept!.answer?.knowledgeProposals);

/** Only what a row of the list draws: everything but the write-ups. */
function slim(answer: WorkspaceDecisionsAnswer): WorkspaceDecisionsAnswer {
  return {
    ...answer,
    prs: (answer.prs ?? []).map((row) => ({ ...row, body: null })),
    knowledgeProposals: answer.knowledgeProposals ?? [],
  };
}

/** The list this tab last read for this workplace, if it has one fresh
 *  enough to draw. Read during a render, so the sheet's first frame has it. */
export function heldDecisions(workplace: string): WorkspaceDecisionsAnswer | null {
  if (!workplace) return null;
  const inTab = held.get(workplace);
  if (usable(inTab)) return inTab.answer;
  const kept = stored()[workplace];
  if (!usable(kept)) return null;
  held.set(workplace, kept);
  return kept.answer;
}

/** Keep what was just read. */
export function holdDecisions(workplace: string, answer: WorkspaceDecisionsAnswer): void {
  if (!workplace) return;
  const kept = { at: Date.now(), answer: slim(answer) };
  held.set(workplace, kept);
  try {
    shelf()?.setItem(KEY, JSON.stringify({ ...stored(), [workplace]: kept }));
  } catch { /* a full or refused store keeps the tab's own copy */ }
}

/** All of it, gone: sign-out, and the tests between themselves. */
export function forgetHeldDecisions(): void {
  held.clear();
  try { shelf()?.removeItem(KEY); } catch { /* nothing kept */ }
}
