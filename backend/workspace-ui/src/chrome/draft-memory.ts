/**
 * What the reader was part-way through typing, held per TAB and keyed by the
 * conversation — note #515, in the user's own words: "In chat screen if user
 * drafted a message in text input, and went to another screen, that draft
 * message should be saved in the text input when user comes back to chat
 * screen".
 *
 * Every chat screen is keyed on its conversation in `App.tsx`, so that one
 * conversation's half-typed message can never survive into the next. That
 * keying is right and stays; what was missing is somewhere for the words to
 * WAIT while the screen is gone. Leaving a chat destroys the composer and
 * everything in it, and a draft is the one thing in there the reader made.
 *
 * Kept beside `scroll-memory.ts` because it answers the same question that
 * file does — what the reader left behind at this place — and forgotten where
 * this tab's other memories are forgotten: on sign-out, and after every test.
 *
 * Keyed by the CONVERSATION, not by the history entry. `scroll-memory` keys
 * by entry because two entries on one address may honestly be scrolled to
 * different lines; an unsent message has no such second reading — the same
 * chat reached a second way is the same words waiting to go to the same
 * person.
 *
 * TEXT ONLY, and deliberately. A picked file is part of a draft too, but its
 * object URL is minted at selection and revoked when the composer leaves (see
 * `ChatComposer`); holding files here would mean holding URLs open across
 * screens that composer can no longer revoke from, which is the leak that
 * discipline exists to prevent. The caption comes back; the files are picked
 * again.
 *
 * This is memory, not storage: it lives as long as the tab does. A reload
 * starts a conversation with an empty box, exactly as it starts a screen with
 * no held note.
 */

/** How many conversations' unsent words are worth keeping. A draft that is
 *  empty (or only spaces) is dropped rather than stored, so this counts only
 *  conversations the reader really did leave words in — and past a couple of
 *  dozen of those, the oldest is not one they are coming back to. */
export const DRAFTS_KEPT = 24;

const drafts = new Map<string, string>();

/** The unsent words of an agent's own conversation. Agent ids are unique
 *  across the platform, so the id alone names the conversation. */
export const agentDraftKey = (agentId: string): string => `chat:${agentId}`;

/** The unsent words of a workplace's Workspace Agent conversation — one per
 *  workplace, which is what that screen is keyed on. */
export const recapDraftKey = (orgId: string): string => `recap:${orgId}`;

/** The unsent words of a private conversation with one person. Keyed by
 *  workplace as well as thread, exactly as `MessageRoute` keys the screen. */
export const directDraftKey = (orgId: string | null | undefined, threadId: string): string =>
  `dm:${orgId ?? ''}:${threadId}`;

/** What was left in this conversation's box, or '' for one never typed in. */
export function recallDraft(key: string): string {
  return drafts.get(key) ?? '';
}

/** Hold what is in the box now. An empty draft is FORGOTTEN rather than
 *  stored: a box the reader cleared, and a box emptied by the send that
 *  succeeded, are both "nothing waiting here". */
export function rememberDraft(key: string, text: string): void {
  // Re-inserted rather than updated, so the map's own insertion order is a
  // least-recently-used list and the eviction below needs nothing else.
  drafts.delete(key);
  if (!text.trim()) return;
  drafts.set(key, text);
  while (drafts.size > DRAFTS_KEPT) {
    const oldest = drafts.keys().next();
    if (oldest.done) break;
    drafts.delete(oldest.value);
  }
}

/** Every draft, gone. Only sign-out has a reason to ask: the next reader of
 *  this tab is a different person, and unsent words are the most personal
 *  thing this tab is holding. */
export function forgetDrafts(): void {
  drafts.clear();
}
