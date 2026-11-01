/**
 * Where each history entry was scrolled to, keyed by the entry — the store
 * behind `ScrollMemory`, kept in a module so a screen can ask it a question.
 *
 * The one asker is the chat. A conversation OPENS at its newest message, but
 * a conversation the reader comes BACK to — from the proposal behind a
 * receipt's door — owes them the row they tapped, not the bottom; the legacy
 * page's `returnToAgentChat` drew the same line. Whether this entry has a
 * remembered line is what tells the two apart.
 */

const positions = new Map<string, number>();

export function rememberScroll(key: string, y: number): void {
  positions.set(key, y);
}

/** The line remembered for this entry, or undefined for one never scrolled. */
export function recallScroll(key: string): number | undefined {
  return positions.get(key);
}

/**
 * A screen that scrolls a PANE of its own rather than the page keeps its
 * lines here, under the same entry key but in its own store.
 *
 * The chat is that screen (note #278): its transcript is an inner scroller
 * between a pinned header and a pinned composer, so the window reading above
 * is always zero and says nothing about where the reader was. Two stores
 * rather than one, because `ScrollMemory` would otherwise hand a pane's
 * offset to `window.scrollTo` on the way back in.
 */
const panes = new Map<string, number>();

export function rememberPaneScroll(key: string, y: number): void {
  panes.set(key, y);
}

/** The line remembered for this entry's pane, or undefined for a pane never
 *  scrolled — which is also what tells a conversation being OPENED from one
 *  the reader is coming back to. */
export function recallPaneScroll(key: string): number | undefined {
  return panes.get(key);
}
