/**
 * Which severity a context fill is at. ONE definition, used by the ring on an
 * agent's row, the ring on its own header, the ring in the chat's pinned
 * header, the bar on the agent screen. Four readings of one fact, and two
 * copies of these thresholds is how they start disagreeing about one agent.
 * (The words agents read the figure by use the lower pair below.)
 *
 * Amber past two thirds, red near the top: the point of showing this at all
 * is to be noticed BEFORE an agent starts dropping things, not to confirm it
 * afterwards. A fresh chat is the fix and it costs one message.
 */
export const CONTEXT_WARN_PERCENT = 67;
export const CONTEXT_HOT_PERCENT = 90;

/**
 * The words an agent is given for HANDING WORK to another read the same
 * figure earlier (notes #456, #449). The Workspace Agent got this lower pair
 * first; on 2026-09-29 the owner judged its rule the better one ("90% is too
 * much") and every room agent now hands work over by it too. From 40% warn
 * and keep the request small, from 60% ask for a fresh chat first. The ring
 * keeps the thresholds above — it says when an agent is filling up, not when
 * a hand-over should start clean — so these are a second, deliberately lower
 * pair, not a drifted copy. And the percentage is only a safety net: whether
 * the recipient's previous work is finished and its conversation still helps
 * the new task is what decides.
 */
export const HANDOFF_CONTEXT_WARN_PERCENT = 40;
export const HANDOFF_CONTEXT_HOT_PERCENT = 60;

/**
 * The Chief of Staff's own chat starts fresh by itself at the end of a turn
 * that ends this full (note #738), after writing the handoff the fresh chat
 * starts from. Above the hand-over pair, so a conversation still worth
 * having is not cut, and below the ring's red, so it never runs that hot:
 * on 2026-10-11 it reached 89% because only the person could reset it.
 */
export const WORKSPACE_AGENT_FRESH_CHAT_PERCENT = 75;

export function contextHeat(pct: number): '' | 'warn' | 'hot' {
  return pct >= CONTEXT_HOT_PERCENT ? 'hot' : pct >= CONTEXT_WARN_PERCENT ? 'warn' : '';
}
