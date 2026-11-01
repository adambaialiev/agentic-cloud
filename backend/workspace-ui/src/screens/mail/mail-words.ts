/**
 * How a message describes itself on screen (note #509, slice 3).
 *
 * Every string here is about a message a STRANGER wrote, so the rule behind
 * all of them is the same: say what we actually know, and never dress up a
 * claim as a fact. A From header is the sender's own claim about who they
 * are — it is what a reader needs to see, and it is not proof — so the words
 * that report on the checks stand apart from it rather than inside it.
 */

import { isMailDomainAddress } from '../../../../src/shared/workspace-mail.js';
import type {
  WorkspaceMailConversationSummary,
  WorkspaceMailMessageDetail,
  WorkspaceMailMessageSummary,
  WorkspaceMailParty,
  WorkspaceMailReply,
  WorkspaceMailThreadMessage,
} from '../../../../src/shared/workspace-mail.js';

/** Who a row says it is from: the name when there is one, else the address,
 *  and something honest when the message carried neither. */
export function mailSender(message: WorkspaceMailMessageSummary): string {
  return message.from?.name?.trim() || message.from?.address || 'Unknown sender';
}

/**
 * Who a ROW is about. A message that arrived is named by whoever sent it; one
 * this person wrote is named by who they wrote to, because "from: me" on my
 * own list row says nothing at all. In Sent (slice 9) every row is theirs,
 * and every one of them — a reply among them — says who it went to.
 */
export function mailRowName(message: WorkspaceMailMessageSummary): string {
  if (message.direction !== 'sent') return mailSender(message);
  const first = message.to?.[0];
  const who = first?.name?.trim() || first?.address || 'nobody';
  return `To ${who}`;
}

/**
 * WHEN a message came, said the way a mail app says it (note #529).
 *
 * The list used to carry the same "41m ago" every other list in this app
 * carries, and it is the wrong reading for mail: an inbox is scanned down
 * the right-hand edge for WHICH DAY something arrived, and a column of
 * relative ages makes the reader do that arithmetic themselves. So today is
 * a clock, an older message is its day, and one from another year says the
 * year too — three shapes, never two of them ambiguous with each other.
 *
 * Calendar days, not 24-hour blocks: 23:50 and 00:10 are twenty minutes
 * apart and belong to different days, which is what a person means.
 * `absolute()` is still on the row as its title, so the exact moment is one
 * hover away and nothing is lost by the short form.
 */
export function mailWhen(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = new Date(now);
  if (midnight(at) === midnight(today)) return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = { day: 'numeric', month: 'short' } as const;
  return at.getFullYear() === today.getFullYear()
    ? at.toLocaleDateString('en-GB', day)
    : at.toLocaleDateString('en-GB', { ...day, year: 'numeric' });
}

/**
 * THE ENVELOPE, in the two lines a reader actually needs (note #545).
 *
 * The screen used to draw the envelope as a filled card of labelled lines —
 * `From:`, `To:`, the date — standing above the words, which made the chrome
 * the heaviest thing on a page whose whole point is somebody's letter, and
 * said the sender's name twice: once under the subject and again after
 * `From:`. What is left is the two facts only an envelope can carry.
 *
 * WHO it is from, named exactly as the list names it — and under that, what
 * the name does not say: the address that name claims, who ELSE got it, the
 * copy list, and the agent that wrote it when the reader did not.
 *
 * The reader's own address is `you`. It is on every message they own, so
 * spelling it out on every one teaches them to skip the line that also
 * carries the recipients they were not expecting.
 */
export interface MailEnvelope {
  /** The first line: who this message is with. */
  who: string;
  /** The second line, already joined — empty when there is nothing to add. */
  detail: string;
}

/** A recipient, as short as it can be said: their name, their address when
 *  they have no name, and `you` for the person reading the screen. */
function recipient(party: WorkspaceMailParty, mine: string): string {
  if (mine && party.address.toLowerCase() === mine.toLowerCase()) return 'you';
  return party.name?.trim() || party.address;
}

/** Three names and a count, never a wall of addresses: a message with a long
 *  recipient list is a mailing list, and reading it out is not the point. */
function people(names: string[]): string {
  if (names.length <= 3) return names.join(', ');
  const rest = names.length - 3;
  return `${names.slice(0, 3).join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`;
}

export function mailEnvelope(message: WorkspaceMailThreadMessage, mine = ''): MailEnvelope {
  const parts: string[] = [];
  if (message.direction === 'sent') {
    // A message this person STARTED is named by who it went to, exactly as
    // its row is, so the addresses are what the second line still owes.
    const addresses = message.to.map((party) => party.address);
    if (addresses.length) parts.push(people(addresses));
  } else {
    // The address only when the name is not already it: `ada@example.com`
    // twice over is not a second fact.
    if (message.from?.name?.trim() && message.from.address) parts.push(message.from.address);
    const to = message.to.map((party) => recipient(party, mine));
    if (to.length) parts.push(`to ${people(to)}`);
  }
  const cc = message.cc.map((party) => recipient(party, mine));
  if (cc.length) parts.push(`copy to ${people(cc)}`);
  // First in the list on a row, last here: on a row it changes who the reader
  // thinks wrote it, and here the name above has already said that.
  if (message.sentBy) parts.push(`sent by ${message.sentBy}`);
  return { who: mailRowName(message), detail: parts.join(' · ') };
}

/** `Ada Lovelace <ada@example.com>`, or just the address. */
export function mailParty(party: WorkspaceMailParty): string {
  return party.name?.trim() ? `${party.name} <${party.address}>` : party.address;
}

export function mailParties(parties: WorkspaceMailParty[]): string {
  return parties.map(mailParty).join(', ');
}

/**
 * WHERE AN ANSWER WENT, said as short as it can honestly be said.
 *
 * Under one message every answer went to the same person, and their whole
 * `Name <address>` on each of them is a line of chrome repeated down the
 * thread — the name is enough, and the address is already on the envelope at
 * the top of the screen.
 *
 * Unless it is NOT the same address. Where a reply goes is chosen by whoever
 * wrote: a message can ask for answers at an address that is not the one it
 * came from, and a reader who assumes otherwise has told somebody else what
 * they thought they were saying in private. In that one case the address is
 * spelled out, because that is the case it matters in.
 */
export function mailReplyTo(reply: WorkspaceMailReply, message: WorkspaceMailMessageDetail): string {
  if (!reply.to.length) return '';
  const from = message.from?.address?.trim().toLowerCase() ?? '';
  const elsewhere = reply.to.some((party) => party.address.trim().toLowerCase() !== from);
  return elsewhere ? mailParties(reply.to) : reply.to.map((party) => party.name?.trim() || party.address).join(', ');
}

/**
 * What the domain's checks made of the sender, in a sentence — or nothing,
 * which is the common and uninteresting case.
 *
 * Only a FAILED check is worth a line. "This message passed DKIM" is noise on
 * every ordinary message, and a screen that says it everywhere teaches the
 * reader to ignore the one place it matters.
 */
export function mailSuspicion(message: Pick<WorkspaceMailThreadMessage, 'suspicious' | 'from' | 'authentication'>): string {
  if (!message.suspicious) return '';
  // The one worth its own sentence: a message wearing an address on this
  // domain. Everyone here has a reason to trust those, and this is the only
  // place a reader is told that a particular one has not earned it.
  if (isMailDomainAddress(message.from?.address)) {
    return 'This message says it comes from an address on this domain, and it has not proved it. '
      + 'Nothing here sends mail that cannot prove it, so treat it as forged.';
  }
  const auth = message.authentication;
  if (auth?.dmarc === 'fail') {
    return 'This message failed the check that proves it came from the domain it claims. Treat it as if it were forged.';
  }
  return 'Nothing vouched for this sender, so who it says it is from cannot be trusted.';
}

/** The line under an unreadable message: what we could not do, said plainly.
 *  It used to point at the original underneath, which note #517 took off the
 *  screen — so it now says only what is true of what the reader can see. */
export const MAIL_UNREADABLE = 'This message could not be read, so there are no words to show. Its envelope above is all we could make out.';

/** The one line the body owes when pictures were left out. Said once, plainly,
 *  rather than as a badge on every gap — and only when a picture at somebody
 *  else's address was actually dropped (slice 10). A letter whose pictures
 *  all travelled inside it has nothing left out, and says nothing. */
export const MAIL_NO_PICTURES = 'Pictures in this message are not loaded.';

/**
 * The tap that loads them, with what it costs IN THE BUTTON (slice 10).
 *
 * Not in a footnote under it and not in a help page: the reader is deciding
 * at the moment they read these words, and what they are deciding is whether
 * this sender may learn the letter was opened. Our proxy is what keeps their
 * address, their device and their hour out of it — it cannot keep the fact
 * itself, so the button says the true half out loud.
 */
export const MAIL_LOAD_PICTURES = 'Load pictures (the sender may learn you opened this)';

/** The standing yes, offered only after the first load and only for the one
 *  sender: there is no switch here that says "every picture, from anybody". */
export const mailAlwaysPictures = (address: string): string => `Always load pictures from ${address}`;

/** And the way back off that list, on every letter from a sender on it. */
export const mailStopPictures = (address: string): string => `Stop loading pictures from ${address}`;

/**
 * Plain-text mail, made readable on a phone.
 *
 * A letter written in a mail client arrives hard-wrapped at about 72 columns:
 * the sender's paragraphs carry line breaks that were a typewriter decision,
 * not a meaning. Shown as they are on a 390px screen, every one of those
 * lines wraps again halfway across and then breaks at the source newline, so
 * a paragraph reads as a ragged column — which is what the first picture of
 * this screen showed.
 *
 * So a run of lines that is plainly one wrapped paragraph is joined back into
 * one, and everything that might be a SHAPE the sender drew is left alone:
 *
 *   - a blank line still separates paragraphs;
 *   - a line starting with whitespace is an indent — a signature, a code
 *     block, a table — and keeps its break;
 *   - a quote (`>`), a bullet or a numbered item starts its own line;
 *   - a SHORT line (under `WRAP_COLUMN`) ended where the sender wanted it to,
 *     so the line after it starts a new one.
 *
 * The last rule is the one doing the work: a hard-wrapped paragraph is a run
 * of long lines, and the last line of it — the short one — is where it ends.
 */
const WRAP_COLUMN = 55;
const STARTS_ITS_OWN_LINE = /^(\s|>|[-*•]\s|\d+[.)]\s)/;

export function reflowMailText(text: string): string {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const previous = out.length ? out[out.length - 1]! : null;
    const joins = previous !== null
      && previous.trim().length >= WRAP_COLUMN
      && !STARTS_ITS_OWN_LINE.test(previous)
      && line.trim().length > 0
      && !STARTS_ITS_OWN_LINE.test(line);
    if (joins) out[out.length - 1] = `${previous!.replace(/\s+$/, '')} ${line.trim()}`;
    else out.push(line);
  }
  return out.join('\n');
}

/** The longest reply the box takes — the same number the server refuses past,
 *  so a paste that would be rejected cannot be typed in the first place. */
export const MAIL_REPLY_MAX = 20_000;

// ── Where a message is kept (slice 7) ──────────────────────────────────────

/** The lists the mail screen draws: the places a letter is kept, SENT
 *  (slice 9), which is not a place but the other question — what has gone
 *  out of this address — and STARRED (note #666), every letter its reader
 *  marked to come back to, wherever it is kept. */
export type MailPlaceName = 'inbox' | 'archive' | 'spam' | 'trash' | 'sent' | 'starred';

export const MAIL_PLACE_TITLE: Record<MailPlaceName, string> = {
  inbox: 'Mail',
  archive: 'Archive',
  spam: 'Spam',
  trash: 'Trash',
  sent: 'Sent',
  starred: 'Starred',
};

/** What an empty list says. Trash's line carries the promise that makes it
 *  safe to put things there; Sent's says what will appear in it. */
export const MAIL_PLACE_EMPTY: Record<Exclude<MailPlaceName, 'inbox'>, string> = {
  archive: 'Nothing has been archived. A message you archive leaves the inbox and waits here, whole.',
  spam: 'Spam is empty. A message nothing vouched for, or from a sender you blocked, lands here instead of the inbox — whole, and one tap from it.',
  trash: 'Trash is empty. Nothing put here is ever deleted for good — you can restore it.',
  sent: 'Nothing has gone out of this address yet. Every message you send, and every answer you write, is kept here.',
  starred: 'Nothing is starred. Tap the star on a message to keep it here — it stays where it is, too.',
};

/** Where a search looks, as the field says it — so nobody wonders whether
 *  the archive was searched. */
export const MAIL_SEARCH_PLACEHOLDER: Record<MailPlaceName, string> = {
  inbox: 'Search mail',
  archive: 'Search the archive',
  spam: 'Search Spam',
  trash: 'Search Trash',
  sent: 'Search Sent',
  starred: 'Search Starred',
};

/** The one line under the field while a search stands in for the list. */
export function mailSearchLine(found: number, words: string, place: MailPlaceName, more: boolean): string {
  const where = place === 'inbox' ? 'in your inbox and archive'
    : place === 'archive' ? 'in the archive'
      : place === 'spam' ? 'in Spam'
        : place === 'sent' ? 'in Sent'
          : place === 'starred' ? 'in Starred' : 'in Trash';
  if (!found) return `Nothing ${where} matches “${words}”.`;
  return `${more ? `The newest ${found}` : found} ${found === 1 ? 'message' : 'messages'} ${where} matching “${words}”.`;
}

/**
 * The mark a row wears for where it is kept, in a list that does not already
 * say so — and who put it there, when an agent did. The archive's own list
 * does not repeat "archived" on every row; it names the agent, because that
 * is the fact the owner could not otherwise see.
 */
export function mailPlaceMark(message: Pick<WorkspaceMailMessageSummary, 'place' | 'movedBy' | 'spamWhy'>, place: MailPlaceName): string {
  const by = message.movedBy;
  if (message.place === 'archive') return place === 'archive' ? (by ? `archived by ${by}` : '') : `archived${by ? ` by ${by}` : ''}`;
  if (message.place === 'trash') return by ? `put in Trash by ${by}` : '';
  // Spam's own list says WHY each row is there (slice 13): that is the fact
  // its reader is scanning for. Elsewhere — Sent, or a conversation partly
  // there — the place is the fact.
  if (message.place === 'spam') return place === 'spam' ? mailSpamWhy(message) : `in Spam${by ? `, marked by ${by}` : ''}`;
  return '';
}

/** Why a letter is in Spam, in a few words: the checks, the reader's own
 *  block list, or somebody's say-so — named when it was an agent's. */
export function mailSpamWhy(message: Pick<WorkspaceMailMessageSummary, 'movedBy' | 'spamWhy'>): string {
  if (message.spamWhy === 'suspicious') return 'unverified sender';
  if (message.spamWhy === 'blocked') return 'blocked sender';
  return message.movedBy ? `marked spam by ${message.movedBy}` : '';
}

/**
 * What the message screen says about where the message is, once it is not
 * the inbox — said from the server's answer, never from the button pressed.
 */
export function mailPlaceLine(message: Pick<WorkspaceMailMessageSummary, 'place' | 'movedBy' | 'spamWhy'>): string {
  const by = message.movedBy ? ` by ${message.movedBy}` : '';
  if (message.place === 'archive') return `Archived${by}. It is kept whole and still turns up in a search.`;
  if (message.place === 'trash') return `In Trash${message.movedBy ? `, put there${by}` : ''}. Nothing here is deleted for good.`;
  if (message.place === 'spam') {
    if (message.spamWhy === 'suspicious') return 'In Spam: nothing vouched for the sender, so it never reached the inbox. It is kept whole.';
    if (message.spamWhy === 'blocked') return 'In Spam: you blocked the sender. It is kept whole.';
    return `In Spam${message.movedBy ? `, marked${by}` : ''}. It is kept whole.`;
  }
  return '';
}

/**
 * THE STAR (note #666), as its button says it. The words are the control's
 * name for a reader who cannot see the glyph fill in, and they say what a
 * tap will DO, so they change with the state rather than naming it.
 */
export function mailStarLabel(starred: boolean, what: 'message' | 'conversation' = 'message'): string {
  return starred ? `Remove the star from this ${what}` : `Star this ${what}`;
}

/** Which lists a star can be put on a letter in: not Trash or Spam, where
 *  Starred could never show it. */
export const mailCanStar = (place: MailPlaceName | 'all' | undefined): boolean => place !== 'trash' && place !== 'spam';

/** Blocking a sender, and the way back, said on their letter (slice 13). */
export const mailBlockSender = (address: string): string => `Block ${address}`;
export const mailUnblockSender = (address: string): string => `Unblock ${address}`;

// ── Conversations (slice 8) ────────────────────────────────────────────────

/**
 * Who a conversation is WITH, as its row names it: everybody else who wrote
 * in it or was written to, three names and a count at most. While nobody has
 * written back it is named by who it went to, exactly as a sent row was.
 */
export function mailConversationName(row: Pick<WorkspaceMailConversationSummary, 'with' | 'started'>): string {
  const names = row.with.map((party) => party.name?.trim() || party.address);
  if (!names.length) return row.started ? 'To nobody' : 'Unknown sender';
  return row.started ? `To ${people(names)}` : people(names);
}

/**
 * The row's first line of words: the newest message's. When the reader wrote
 * it, it says so — the name on the line above is who the conversation is
 * WITH, and without `You:` their own words would read as the other side's.
 */
export function mailConversationLine(row: Pick<WorkspaceMailConversationSummary, 'latest' | 'started'>): string {
  const snippet = row.latest.snippet.trim();
  if (!snippet) return '';
  return row.latest.direction === 'sent' && !row.started ? `You: ${snippet}` : snippet;
}

/**
 * The line a conversation screen says about where it is kept, and — while it
 * is not in Trash itself — about the letters of it that are: an agent may
 * have put one there alone, or an answer may have brought the rest back.
 */
export function mailTrashedLine(trashed: number | undefined): string {
  if (!trashed) return '';
  return trashed === 1
    ? 'One message in this conversation is in Trash.'
    : `${trashed} messages in this conversation are in Trash.`;
}

/** The mark on one letter of a conversation that is kept somewhere the
 *  conversation is not — the only one worth a line is Trash. */
export function mailLetterPlace(message: Pick<WorkspaceMailMessageSummary, 'place' | 'movedBy' | 'spamWhy'>, conversationPlace: MailPlaceName): string {
  if (message.place === 'trash' && conversationPlace !== 'trash') {
    return `This message is in Trash${message.movedBy ? `, put there by ${message.movedBy}` : ''}.`;
  }
  // And Spam (slice 13): an answer from a blocked sender, or one the checks
  // failed, landing in a conversation that is still in the inbox.
  if (message.place === 'spam' && conversationPlace !== 'spam' && conversationPlace !== 'trash') {
    const why = mailSpamWhy(message);
    return `This message is in Spam${why ? ` (${why})` : ''}.`;
  }
  return '';
}

/**
 * Who wrote one message of a conversation, as the line above it says: the
 * sender's name for a letter that arrived; `From you to …` for one this
 * person sent — spelled out, because a reply is the one thing on this screen
 * the reader wrote, and the line has to say so in words (note #545).
 */
export function mailOwnLine(message: Pick<WorkspaceMailThreadMessage, 'to'> & Partial<Pick<WorkspaceMailThreadMessage, 'cc' | 'forwards'>>, senders: string[]): string {
  const said = message.forwards ? 'Forwarded to' : 'From you to';
  if (!message.to.length) return message.forwards ? 'Forwarded' : 'From you';
  // By name, as everywhere — unless it went to an address nobody in this
  // conversation wrote from, which is the Reply-To case `mailReplyTo` spells
  // out: the one time the address is the fact. A forward and a Cc (slice 12)
  // usually reach exactly such people, so they are named by address then too.
  const known = new Set(senders.map((address) => address.trim().toLowerCase()));
  const names = (parties: WorkspaceMailParty[]) => {
    const elsewhere = known.size > 0 && parties.some((party) => !known.has(party.address.trim().toLowerCase()));
    return elsewhere ? mailParties(parties) : parties.map((party) => party.name?.trim() || party.address).join(', ');
  };
  const cc = message.cc?.length ? `, copy to ${names(message.cc)}` : '';
  return `${said} ${names(message.to)}${cc}`;
}
