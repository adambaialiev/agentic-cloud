/**
 * Conversations (note #509, slice 8) — what the two doors onto a person's
 * mail, their own Workspace and their agent's CLI, say about one.
 *
 * Before this, an answer to a reply landed as a fresh, unrelated row: the
 * reply sat under the message it answered, and the letter answering THAT had
 * nowhere to go. A conversation is every message that answers another in it,
 * joined by the headers mail clients write for exactly this — In-Reply-To and
 * References — and by nothing else. Never by subject: two strangers who both
 * wrote "Re: invoice" are not in one conversation.
 */

import type { MailConversation, MailMessageDocument, MailPartyRef, MailPlace } from './mail-message-storage.js';
import { mailMovedBy, mailPlaceOf } from './mail-places.js';

/**
 * How many earlier messages one letter may name before the rest are ignored.
 * A real thread's References are a handful and the nearest are the ones that
 * matter; a stranger's header could name thousands, and each is a lookup.
 */
export const MAIL_REFS_KEPT = 20;

/** Whether a message is a row of the list: what arrived, and what this person
 *  started. A reply is read in its conversation and is never one. */
export function isMailListRow(doc: Pick<MailMessageDocument, 'direction' | 'answers'>): boolean {
  return (doc.direction ?? 'in') === 'in' || !doc.answers;
}

/**
 * The messages one letter says it follows, NEAREST FIRST: what it answers,
 * then its References from the last back — the order a conversation is best
 * found in, because the message it directly answers is the likeliest to be
 * here. Its own id is never among them, and there are at most
 * `MAIL_REFS_KEPT`.
 */
export function mailRefs(doc: Pick<MailMessageDocument, 'messageId' | 'inReplyTo' | 'references'>): string[] {
  const named = [doc.inReplyTo, ...[...(doc.references ?? [])].reverse()];
  const refs: string[] = [];
  for (const ref of named) {
    if (!ref || ref === doc.messageId || refs.includes(ref)) continue;
    refs.push(ref);
    if (refs.length >= MAIL_REFS_KEPT) break;
  }
  return refs;
}

/**
 * A References header, as ids: `<a@x> <b@y>` → `['a@x', 'b@y']`. Anything
 * that is not an angle-bracketed id is not an id — a header folded by a
 * careless client still reads, and a header of free text reads as nothing.
 */
export function readReferences(header: string | undefined): string[] {
  if (!header) return [];
  const ids = [...header.matchAll(/<([^<>\s]{1,510})>/g)].map((match) => match[1]!.trim()).filter(Boolean);
  // The nearest are the ones worth keeping: a thread fifty letters long names
  // the first one and the last few, and the middle is the part we can lose.
  return ids.slice(-MAIL_REFS_KEPT);
}

/**
 * Where a conversation is kept: in the inbox while ANY of its letters is,
 * else in the archive while any is there, else in Trash. So one answer
 * arriving in a conversation that was put away brings it back to the inbox —
 * the answer is new, and new mail is what the inbox is for — and nothing else
 * in it is moved to make that true.
 */
export function mailConversationPlace(messages: MailMessageDocument[]): MailPlace {
  const places = messages.filter(isMailListRow).map(mailPlaceOf);
  if (places.includes('inbox')) return 'inbox';
  if (places.includes('archive')) return 'archive';
  // Spam (slice 13) sits between the archive and Trash: a conversation whose
  // every letter is in Spam or Trash is in Spam while any is there.
  if (places.includes('spam')) return 'spam';
  return places.length ? 'trash' : 'inbox';
}

/** Everything a row of the list says about one conversation. */
export interface MailConversationFacts {
  thread: string;
  place: MailPlace;
  /** The agent that put it where it is, when a person did not. */
  movedBy?: string;
  /** Why it is in Spam, when it is: off the same letter `movedBy` reads. */
  spamWhy?: 'suspicious' | 'blocked' | 'marked';
  /** Every message in it, the replies this person sent included. */
  count: number;
  /** Its first message's subject — the conversation's name, not its latest "Re:". */
  subject: string;
  /** Who it is WITH: everybody who wrote in it or was written to, never this
   *  person's own address, in the order they joined. */
  with: MailPartyRef[];
  /** True while nobody else has written in it: every message is one this
   *  person sent. Its row is then named by who it went to. */
  started: boolean;
  /** The newest message: the row's first line, its clock and its author. */
  latest: MailMessageDocument;
  /** Where a tap opens it: the first message nobody has opened, else the newest. */
  opens: string;
  /** Any arrived message in it that its owner has not opened. */
  unread: boolean;
  files: number;
  /** Any arrived message in it that nothing vouched for. */
  suspicious: boolean;
  unreadable: boolean;
  /** How many of its letters are in Trash while the conversation is not. */
  trashed: number;
  /** Any letter in it is starred and in Starred — not in Trash or Spam
   *  (note #666). */
  starred: boolean;
}

export function mailConversationFacts(conversation: MailConversation): MailConversationFacts {
  const { messages } = conversation;
  const first = messages[0]!;
  const latest = messages[messages.length - 1]!;
  const own = first.address.toLowerCase();
  const people = new Map<string, MailPartyRef>();
  for (const message of messages) {
    // Who a conversation is WITH: whoever wrote in it, and whoever this
    // person wrote to in it, Cc included (slice 12) — but never the person a
    // letter was FORWARDED to. They were handed one letter of it; they are
    // not in the conversation, and naming them on its row would say so.
    if (message.forwards) continue;
    const parties = (message.direction ?? 'in') === 'sent'
      ? [...message.to, ...(message.cc ?? [])]
      : message.from ? [message.from] : [];
    for (const party of parties) {
      const key = party.address?.toLowerCase();
      if (!key || key === own) continue;
      // The first time somebody is named with a name is the name they keep:
      // an address alone on one message and `Priya Raman` on the next are the
      // same person, and the row should say Priya.
      const known = people.get(key);
      if (!known || (!known.name?.trim() && party.name?.trim())) people.set(key, party);
    }
  }
  const place = mailConversationPlace(messages);
  const rows = messages.filter(isMailListRow);
  const inPlace = rows.filter((message) => mailPlaceOf(message) === place);
  const mover = inPlace.length ? mailMovedBy(inPlace[inPlace.length - 1]!) : undefined;
  const spamWhy = place === 'spam' && inPlace.length ? inPlace[inPlace.length - 1]!.spamWhy : undefined;
  const unopened = messages.find((message) => (message.direction ?? 'in') === 'in' && !message.readAt);
  const arrived = messages.filter((message) => (message.direction ?? 'in') === 'in');
  return {
    thread: conversation.thread,
    place,
    ...(mover ? { movedBy: mover } : {}),
    ...(spamWhy ? { spamWhy } : {}),
    count: messages.length,
    subject: messages.find((message) => message.subject.trim())?.subject ?? first.subject,
    with: [...people.values()],
    started: arrived.length === 0,
    latest,
    opens: unopened?.id ?? latest.id,
    unread: Boolean(unopened),
    files: messages.reduce((sum, message) => sum + (message.attachments?.length ?? 0), 0),
    suspicious: arrived.some((message) => message.suspicious),
    unreadable: arrived.some((message) => message.parseError),
    trashed: place === 'trash' ? 0 : rows.filter((message) => mailPlaceOf(message) === 'trash').length,
    starred: messages.some((message) => message.starredAt && !message.trashedAt && !message.spamAt),
  };
}

/**
 * The message a reply at the foot of a conversation answers: its newest
 * letter that ARRIVED and names somebody to answer. Never one this person
 * sent — answering yourself is not a reply — and the recipient is still read
 * off that letter by the outbox, never chosen here.
 */
export function mailConversationAnswerable(
  messages: MailMessageDocument[],
  answerable: (message: MailMessageDocument) => boolean,
): MailMessageDocument | null {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]!;
    if ((message.direction ?? 'in') === 'in' && answerable(message)) return message;
  }
  return null;
}
