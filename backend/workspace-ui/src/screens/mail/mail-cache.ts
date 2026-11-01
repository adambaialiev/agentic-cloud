/**
 * The last mail this tab actually read — the lists, and the conversations
 * opened from them.
 *
 * The same rule the note and cloud caches exist for, and our owner has asked
 * for it three times in his own words: a screen is a route, so Back rebuilds
 * it from nothing and the reader watches a skeleton drawn over what they were
 * looking at a second ago. The answer outlives the screen here instead: a
 * visit opens on the held copy and refreshes underneath it.
 *
 * Per TAB, like its two siblings, and emptied by `SessionProvider` on sign-out
 * and by the test setup between tests. Keyed by the list alone — which place,
 * or which search (slice 7) — and by nothing else: an inbox belongs to the
 * signed-in person, so there is no room or workplace that could change the
 * answer, and sign-out is what changes the person.
 *
 * Since slice 8 a PLACE holds conversations and a SEARCH holds letters, which
 * is what each of them is a list of. Sent (slice 9) is letters too — it is
 * the one list a reply is a row of — and is held for as long as the tab
 * lives, where searches take their turn out of a short queue.
 */

import type {
  WorkspaceMailConversation,
  WorkspaceMailConversationMoveAnswer,
  WorkspaceMailConversationSummary,
  WorkspaceMailConversationsAnswer,
  WorkspaceMailMessageSummary,
  WorkspaceMailMessagesAnswer,
  WorkspaceMailPlace,
  WorkspaceMailStarAnswer,
  WorkspaceMailView,
} from '../../../../src/shared/workspace-mail.js';
import type { MailPlaceName } from './mail-words.js';

/** How many opened conversations are worth keeping: Back goes to the one you
 *  just left, and a reader walking down an inbox goes a handful deep. */
export const MAIL_CONVERSATIONS_KEPT = 12;
/** How many searches: Back from a result lands on the words that found it,
 *  and a person typing asks a new one every few letters. */
export const MAIL_SEARCHES_KEPT = 6;

/** Which list of LETTERS: where it looked, and the words when it is a search. */
export interface MailListKey {
  view: WorkspaceMailView;
  search?: string;
}

const listKey = ({ view, search }: MailListKey): string => `${view}:${search ?? ''}`;
const viewOf = (key: string): WorkspaceMailView => key.split(':')[0] as WorkspaceMailView;
/** A search, rather than a list that is only a list: only searches are
 *  evicted, so coming Back to Sent never lands on a skeleton. */
const isSearch = (key: string): boolean => key.slice(key.indexOf(':') + 1).length > 0;

const heldPlaces = new Map<MailPlaceName, WorkspaceMailConversationsAnswer>();
const heldLetters = new Map<string, WorkspaceMailMessagesAnswer>();
const heldConversations = new Map<string, WorkspaceMailConversation>();

export function heldMailPlace(place: MailPlaceName = 'inbox'): WorkspaceMailConversationsAnswer | null {
  return heldPlaces.get(place) ?? null;
}

export function holdMailPlace(answer: WorkspaceMailConversationsAnswer, place: MailPlaceName = 'inbox'): void {
  heldPlaces.set(place, answer);
}

/** The last answer for a list of LETTERS: a search, or Sent. */
export function heldMailLetters(list: MailListKey): WorkspaceMailMessagesAnswer | null {
  return heldLetters.get(listKey(list)) ?? null;
}

export function holdMailLetters(answer: WorkspaceMailMessagesAnswer, list: MailListKey): void {
  const key = listKey(list);
  heldLetters.delete(key);
  heldLetters.set(key, answer);
  const searches = [...heldLetters.keys()].filter(isSearch);
  for (const oldest of searches.slice(0, Math.max(0, searches.length - MAIL_SEARCHES_KEPT))) heldLetters.delete(oldest);
}

/**
 * A conversation has just been opened, and so read, every letter in it. The
 * server made the same decision on the way in; this is only so that Back
 * does not paint a heavy row for the conversation the reader has in front of
 * them, for the half-second before the list refreshes underneath.
 */
export function markMailConversationRead(conversation: Pick<WorkspaceMailConversation, 'id' | 'messages'>): void {
  const ids = new Set(conversation.messages.map((message) => message.id));
  for (const [place, answer] of heldPlaces) {
    if (!answer.conversations.some((row) => row.id === conversation.id && row.unread)) continue;
    heldPlaces.set(place, {
      ...answer,
      conversations: answer.conversations.map((row) => {
        if (row.id !== conversation.id) return row;
        const next = { ...row, opens: row.latest.id };
        delete next.unread;
        return next;
      }),
    });
  }
  for (const [key, answer] of heldLetters) {
    if (!answer.messages.some((message) => ids.has(message.id) && message.unread)) continue;
    heldLetters.set(key, { ...answer, messages: answer.messages.map((message) => (ids.has(message.id) ? { ...message, unread: false } : message)) });
  }
}

/** A copy of a row, standing where the server now says it is. Its old place
 *  goes first: a letter brought back to the inbox carries no `place` at all,
 *  and spreading that over the old copy would keep the old one. */
export function mailStandingAs<T extends { place?: WorkspaceMailPlace; movedBy?: string; trashed?: number; spamWhy?: 'suspicious' | 'blocked' | 'marked' }>(
  held: T,
  moved: { place?: WorkspaceMailPlace; movedBy?: string; trashed?: number; spamWhy?: 'suspicious' | 'blocked' | 'marked' },
): T {
  const next: T = { ...held, ...moved };
  if (!moved.place) delete next.place;
  if (!moved.movedBy) delete next.movedBy;
  if (!moved.spamWhy) delete next.spamWhy;
  if ('trashed' in held && !moved.trashed) delete next.trashed;
  return next;
}

/** Whether something in `place` belongs in a `view` list. Sent holds a
 *  letter wherever it is kept, Trash apart — it is not a place (slice 9);
 *  `all`, what a search from the inbox reads, leaves out Spam too (slice 13),
 *  and so does Starred (note #666), which holds a starred letter wherever it
 *  is kept otherwise. */
function belongsIn(place: WorkspaceMailMessageSummary['place'], view: WorkspaceMailView): boolean {
  const at = place ?? 'inbox';
  if (view === 'sent') return at !== 'trash';
  if (view === 'all' || view === 'starred') return at !== 'trash' && at !== 'spam';
  return at === view;
}

/**
 * A conversation has changed place, as the SERVER answered it. Every held
 * list is made to agree before the reader can get back to one: it leaves the
 * place it left and takes its turn — by its newest letter — in the place it
 * went to; every letter of it a held search or Sent list holds is redrawn
 * where the server says that letter now is, and leaves the list when Trash is
 * where that is; and the held copy of the conversation itself stands where it
 * now stands.
 */
export function mailConversationMoved(moved: WorkspaceMailConversationMoveAnswer): void {
  const row = moved.conversation;
  for (const [place, answer] of heldPlaces) {
    const at = answer.conversations.findIndex((one) => one.id === row.id);
    let conversations: WorkspaceMailConversationSummary[] = answer.conversations;
    if (!belongsIn(row.place, place)) {
      if (at < 0) continue;
      conversations = conversations.filter((one) => one.id !== row.id);
    } else if (at >= 0) {
      conversations = conversations.map((one) => (one.id === row.id ? row : one));
    } else {
      conversations = [...conversations];
      const turn = conversations.findIndex((one) => one.latest.receivedAt < row.latest.receivedAt);
      conversations.splice(turn < 0 ? conversations.length : turn, 0, row);
    }
    heldPlaces.set(place, { ...answer, conversations });
  }
  const places = new Map(moved.messages.map((message) => [message.id, message]));
  for (const [key, answer] of heldLetters) {
    const view = viewOf(key);
    if (!answer.messages.some((message) => places.has(message.id))) continue;
    heldLetters.set(key, {
      ...answer,
      messages: answer.messages.flatMap((message) => {
        const now = places.get(message.id);
        if (!now) return [message];
        return belongsIn(now.place, view) ? [mailStandingAs(message, now)] : [];
      }),
    });
  }
  const held = heldConversations.get(row.id);
  if (held) {
    holdMailConversation({
      ...mailStandingAs(held, row),
      messages: held.messages.map((message) => {
        const now = places.get(message.id);
        return now ? mailStandingAs(message, now) : message;
      }),
    });
  }
}

/** A copy of a row or a letter, starred as the server now says it is. */
export function mailStarredAs<T extends { starred?: true; starredBy?: string }>(held: T, now: { starred?: true; starredBy?: string }): T {
  const next: T = { ...held };
  delete next.starred;
  delete next.starredBy;
  return { ...next, ...(now.starred ? { starred: true as const } : {}), ...(now.starredBy ? { starredBy: now.starredBy } : {}) };
}

/**
 * A star has gone on or come off (note #666), as the SERVER answered it:
 * the conversation as it now stands and every letter in it. Every held list
 * is made to agree before the reader can get back to one — the row wears the
 * server's word; every letter of it a search or Sent holds is redrawn; the
 * held Starred list loses a letter that lost its star and gains one that
 * gained it, in its turn by when it came; and the held conversation itself
 * stands as it now stands.
 */
export function mailStarChanged(answer: WorkspaceMailStarAnswer): void {
  const row = answer.conversation;
  for (const [place, held] of heldPlaces) {
    if (!held.conversations.some((one) => one.id === row.id)) continue;
    heldPlaces.set(place, { ...held, conversations: held.conversations.map((one) => (one.id === row.id ? mailStarredAs(one, row) : one)) });
  }
  const letters = new Map(answer.messages.map((message) => [message.id, message]));
  for (const [key, held] of heldLetters) {
    const starredList = viewOf(key) === 'starred';
    let messages = held.messages.flatMap((message) => {
      const now = letters.get(message.id);
      if (!now) return [message];
      return starredList && !now.starred ? [] : [mailStarredAs(message, now)];
    });
    // A letter that has just been starred joins Starred — the whole list, not
    // a search of it, whose words it may not say.
    if (starredList && !isSearch(key)) {
      const shown = new Set(messages.map((message) => message.id));
      const joining = answer.messages.filter((message) => message.starred && !shown.has(message.id) && belongsIn(message.place, 'all'));
      if (joining.length) {
        messages = [...messages, ...joining].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
      }
    }
    if (messages.length !== held.messages.length || messages.some((message, at) => message !== held.messages[at])) {
      heldLetters.set(key, { ...held, messages });
    }
  }
  const conversation = heldConversations.get(row.id);
  if (conversation) {
    holdMailConversation({
      ...mailStarredAs(conversation, row),
      messages: conversation.messages.map((message) => {
        const now = letters.get(message.id);
        return now ? mailStarredAs(message, now) : message;
      }),
    });
  }
}

/**
 * A list read again from its first page, KEEPING the older pages the reader
 * has already asked for (note #666). The open inbox refreshes every few
 * seconds, and a refresh that dropped everything past the first page would
 * pull the list out from under somebody reading its second.
 *
 * The first page is the server's word, whole. What the held list had after
 * the fresh page's last row stays after it, and the cursor it had with it:
 * those rows were read from the server a moment ago, and the next tap on
 * "older" carries on from where they end. When the fresh page's last row is
 * not in the held list at all — a flood of new mail pushed the whole of it
 * down — nothing can be placed, and the list starts again from page one.
 */
export function mailPageKept<T extends { id: string }>(
  fresh: { rows: T[]; nextBefore?: string },
  held: { rows: T[]; nextBefore?: string } | null,
): { rows: T[]; nextBefore?: string } {
  const plain = { rows: fresh.rows, ...(fresh.nextBefore ? { nextBefore: fresh.nextBefore } : {}) };
  if (!fresh.nextBefore || !held || held.rows.length <= fresh.rows.length) return plain;
  const last = fresh.rows[fresh.rows.length - 1];
  const at = last ? held.rows.findIndex((row) => row.id === last.id) : -1;
  if (at < 0) return plain;
  const seen = new Set(fresh.rows.map((row) => row.id));
  const tail = held.rows.slice(at + 1).filter((row) => !seen.has(row.id));
  return tail.length
    ? { rows: [...fresh.rows, ...tail], ...(held.nextBefore ? { nextBefore: held.nextBefore } : {}) }
    : plain;
}

/** The held conversation a message is part of, if this tab has read it. */
export function heldMailConversation(messageId: string): WorkspaceMailConversation | null {
  for (const conversation of heldConversations.values()) {
    if (conversation.messages.some((message) => message.id === messageId)) return conversation;
  }
  return null;
}

export function holdMailConversation(conversation: WorkspaceMailConversation): void {
  // Re-inserted rather than updated, so insertion order is a least-recently-
  // used list and the eviction below needs nothing else.
  heldConversations.delete(conversation.id);
  heldConversations.set(conversation.id, conversation);
  while (heldConversations.size > MAIL_CONVERSATIONS_KEPT) {
    const oldest = heldConversations.keys().next();
    if (oldest.done) break;
    heldConversations.delete(oldest.value);
  }
}

/** The LISTS this tab holds, let go: after a sender is blocked (slice 13)
 *  their letters have left the inbox and the archive on the server, and no
 *  held list can be made to agree without asking it. Opened conversations
 *  are kept — they are read again, one at a time. */
export function forgetMailLists(): void {
  heldPlaces.clear();
  heldLetters.clear();
}

/** Sign-out, and every test. What one person read is never another's. */
export function forgetMail(): void {
  heldPlaces.clear();
  heldLetters.clear();
  heldConversations.clear();
}
