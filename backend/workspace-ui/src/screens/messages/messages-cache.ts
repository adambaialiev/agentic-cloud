/**
 * Direct messages as this person last saw them, per workplace (note #1102).
 *
 * Adam, 9 Nov 2026: "Messages data should be cached, Ui should be cache.
 * Analyze why it loads kinda slow." Every open of Messages or of a
 * conversation used to start from nothing — "Loading…" for the whole read,
 * and the read is the workplace's messaging machine, which sleeps after ten
 * quiet minutes and takes seconds to wake. So what the person has already
 * seen is kept, drawn in the first frame, and the fresh read lands behind it:
 * it replaces the list and appends to a conversation, never empties either.
 *
 * Where: in this tab's memory, and in this browser's own storage so a reload
 * or a phone reopening the page also paints at once. Whose: ONE person's —
 * every entry is filed under the signed-in username, a shelf finding entries
 * of anyone else drops them before it answers, a cached conversation is used
 * only while the server still names the same viewer, and sign-out empties it
 * all (`SessionProvider`). The messaging machine stays the only source of
 * truth (note #608): nothing here is ever sent anywhere, and no agent reads
 * a browser. Bounded: a conversation keeps its newest 50 messages and a
 * workplace its 12 most recently opened conversations.
 */

import type { DirectMessage, DirectMessageInbox, DirectMessagePerson } from '../../../../src/shared/direct-messages.js';

const PREFIX = 'agentbuilt.dm.v1:';
export const KEPT_MESSAGES = 50;
export const KEPT_THREADS = 12;

/** A conversation as last drawn: who, where, the rows, and where the reader stood. */
export interface HeldThread {
  viewerId: string;
  orgName: string;
  person: DirectMessagePerson;
  messages: DirectMessage[];
  hasMore: boolean;
  /** Tab memory only: where the reader stood when they left. */
  scroll?: { top: number; following: boolean };
  at: number;
}
interface Shelf { inbox?: DirectMessageInbox; threads: Record<string, HeldThread> }

const memory = new Map<string, Shelf>();

const storage = (): Storage | null => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};
const keyOf = (person: string, orgId: string) => `${PREFIX}${encodeURIComponent(person)}:${orgId}`;

/** Anything kept for somebody else is gone before this person reads a word. */
function dropOthers(person: string): void {
  const shelf = storage(); if (!shelf) return;
  const mine = `${PREFIX}${encodeURIComponent(person)}:`;
  const gone: string[] = [];
  for (let i = 0; i < shelf.length; i += 1) {
    const key = shelf.key(i);
    if (key?.startsWith(PREFIX) && !key.startsWith(mine)) gone.push(key);
  }
  for (const key of gone) shelf.removeItem(key);
  for (const key of [...memory.keys()]) if (!key.startsWith(mine)) memory.delete(key);
}

function load(person: string, orgId: string): Shelf {
  dropOthers(person);
  const key = keyOf(person, orgId);
  const held = memory.get(key);
  if (held) return held;
  let kept: Shelf = { threads: {} };
  try {
    const raw: unknown = JSON.parse(storage()?.getItem(key) ?? 'null');
    if (raw && typeof raw === 'object' && typeof (raw as Shelf).threads === 'object') kept = raw as Shelf;
  } catch { /* unreadable: start empty */ }
  memory.set(key, kept);
  return kept;
}

function save(person: string, orgId: string, shelf: Shelf): void {
  const key = keyOf(person, orgId);
  memory.set(key, shelf);
  const newest = Object.entries(shelf.threads).sort(([, a], [, b]) => b.at - a.at).slice(0, KEPT_THREADS);
  shelf.threads = Object.fromEntries(newest);
  // Scroll is the tab's; the device keeps the words and the list.
  const persisted = { ...(shelf.inbox ? { inbox: shelf.inbox } : {}), threads: Object.fromEntries(newest.map(([id, t]) => {
    const { scroll: _scroll, ...rest } = t;
    return [id, rest];
  })) };
  try { storage()?.setItem(key, JSON.stringify(persisted)); }
  catch { /* storage full or refused: memory still answers for this tab */ }
}

export function heldInbox(person: string | undefined, orgId: string | null | undefined): DirectMessageInbox | null {
  if (!person || !orgId) return null;
  return load(person, orgId).inbox ?? null;
}

export function holdInbox(person: string | undefined, orgId: string | null | undefined, inbox: DirectMessageInbox): void {
  if (!person || !orgId) return;
  const shelf = load(person, orgId);
  if (shelf.inbox && JSON.stringify(shelf.inbox) === JSON.stringify(inbox)) return;
  save(person, orgId, { ...shelf, inbox });
}

export function heldThread(person: string | undefined, orgId: string | null | undefined, peerId: string): HeldThread | null {
  if (!person || !orgId || !peerId) return null;
  return load(person, orgId).threads[peerId] ?? null;
}

export function holdThread(person: string | undefined, orgId: string | null | undefined, peerId: string,
  thread: Omit<HeldThread, 'at' | 'messages'> & { messages: DirectMessage[] }): void {
  if (!person || !orgId || !peerId) return;
  const shelf = load(person, orgId);
  const messages = thread.messages.slice(-KEPT_MESSAGES);
  // Older history beyond what is kept is still there: say so.
  const hasMore = thread.hasMore || thread.messages.length > KEPT_MESSAGES;
  // A conversation read newer than the kept list moves that row on: its last
  // line, and nothing unread — the reader is looking at it.
  const newest = messages.at(-1);
  const inbox = shelf.inbox && newest ? {
    ...shelf.inbox,
    threads: shelf.inbox.threads.map((row) => (row.person.userId === peerId && newest.id > row.lastMessage.id
      ? { ...row, lastMessage: newest, unread: 0 } : row)),
  } : shelf.inbox;
  if (inbox && shelf.inbox) inbox.unread = inbox.threads.reduce((n, row) => n + row.unread, 0);
  save(person, orgId, { ...shelf, ...(inbox ? { inbox } : {}), threads: { ...shelf.threads, [peerId]: { ...thread, messages, hasMore, at: Date.now() } } });
}

/** One conversation or one workplace, gone: the reader lost it. */
export function forgetThread(person: string | undefined, orgId: string | null | undefined, peerId: string): void {
  if (!person || !orgId) return;
  const shelf = load(person, orgId);
  if (!shelf.threads[peerId]) return;
  const { [peerId]: _gone, ...threads } = shelf.threads;
  save(person, orgId, { ...shelf, threads });
}
export function forgetDirectMessagesOf(person: string | undefined, orgId: string | null | undefined): void {
  if (!person || !orgId) return;
  const key = keyOf(person, orgId);
  memory.delete(key);
  try { storage()?.removeItem(key); } catch { /* nothing to remove */ }
}

/** Everything, everyone's: sign-out, and every test. */
export function forgetDirectMessages(): void {
  memory.clear();
  const shelf = storage(); if (!shelf) return;
  const gone: string[] = [];
  for (let i = 0; i < shelf.length; i += 1) { const key = shelf.key(i); if (key?.startsWith(PREFIX)) gone.push(key); }
  for (const key of gone) shelf.removeItem(key);
}
