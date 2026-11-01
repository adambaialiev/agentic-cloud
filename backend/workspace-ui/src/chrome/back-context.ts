import { createContext } from 'react';

/**
 * Who owns the way back right now.
 *
 * The legacy page's `goBack()` consults the contextual rules for transient
 * leaves — a runtime picker, a room picker, a form — BEFORE it spends a
 * browser entry (knowledge page "miniapp-navigation"). Those leaves have no
 * address by design, so there is no history entry for Back to move through;
 * the screen that opened one has to be asked whether it wants the return.
 *
 * `claim` registers that offer while the leaf is on screen. `handle` is what
 * every Back control calls first: true means a leaf took the return and no
 * history entry was spent.
 *
 * `claimed` is the same fact for the header rather than for the tap: Home and
 * the chat carry no persistent header, so a leaf standing over one of them
 * would have no way out at all — it has no address, so the browser's own Back
 * is not it either. The header appears for exactly as long as the leaf does.
 *
 * `covers: false` is the leaf that does not need that favour: one standing
 * over PART of the screen, with its own Close and the screen it came from
 * still readable beside it (note #581's agent sheet). Summoning the shared
 * bar for one of those puts a second Back above a chat that still has its
 * own and pushes the conversation down — and handing it the screen's scroll
 * line would move a page nobody left. It still takes the TAP: a partial leaf
 * is the newest thing on screen, and Back there means dismiss it.
 */
export interface BackValue {
  claim: (handler: () => void, options?: { covers?: boolean }) => () => void;
  handle: () => boolean;
  claimed: boolean;
}

export const BackContext = createContext<BackValue | null>(null);
