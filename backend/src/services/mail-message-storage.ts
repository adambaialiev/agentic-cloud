/**
 * A message that arrived at somebody's own address (note #509, slice 2).
 *
 * The document is what the inbox screen will read, and the raw bytes behind
 * it are what makes that safe: everything below is derived from a MIME
 * message we did not write, so anything the parser could not make sense of
 * is recorded rather than guessed at, and `raw` always holds exactly what
 * the sender sent. A message is never dropped for being unreadable.
 */

/** One `Name <address>` pair off a header, as far as we could read it. */
export interface MailPartyRef {
  address: string;
  name?: string;
}

/** A file that came with the message, already in media storage. */
export interface MailAttachmentRecord {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  storagePath: string;
  /** `<cid>` for a picture the HTML body points at, without the brackets. */
  contentId?: string;
  /** True for a part the body references rather than a file to download. */
  inline?: boolean;
}

/** What the domain's own filtering said about the sender, verbatim. */
export interface MailAuthenticationVerdict {
  spf?: string;
  dkim?: string;
  dmarc?: string;
  /** The whole `Authentication-Results` header, kept for the cases the three
   *  fields above flatten. */
  raw?: string;
}

export interface MailMessageDocument {
  id: string;
  /**
   * Which way it went. Absent means `in` — every row written before replies
   * existed (note #509 slice 4) is mail that arrived.
   */
  direction?: 'in' | 'sent';
  /** For a reply: OUR id of the message it answers. Never a stranger's id. */
  answers?: string;
  /**
   * For a FORWARD (slice 12): OUR id of the letter it passes on. A forward
   * answers nothing — its `answers` is empty, so it is counted as a NEW
   * message, which is what it is to the person it reaches — but it joins
   * that letter's conversation, and this is the link its screen draws
   * "Forwarded to … on …" from.
   */
  forwards?: string;
  /**
   * A REPLY whose Cc named somebody the answered letter was not addressed to
   * (slice 12). It reached somebody who had not written, so it spent the NEW
   * allowance as well as the reply one, and `countNewSince` counts it.
   */
  reachesNew?: true;
  /**
   * The AGENT that sent this, when a person did not (note #509, slice 6).
   * An agent writes from its owner's address — the address is theirs, and so
   * is what goes out of it — so the recipient sees the person, exactly as
   * they do when that person's agent pushes code under their name. This is
   * how the OWNER can still tell which of the two wrote it.
   */
  sentBy?: { agentId: string; name?: string };
  /**
   * For a reply: the words the person actually typed, without the quoted
   * message under them. `text` is what WENT OUT and is the record; this is
   * what they said, and it is what their own screen shows them — nobody
   * re-reads their own reply to see the quote they already had in front of
   * them when they wrote it.
   */
  wrote?: string;
  /** Who owns the address it arrived at. The only person who may read it. */
  userId: string;
  /** The envelope recipient — the mailbox, lowercased. */
  address: string;
  /** The envelope sender (SMTP MAIL FROM), which is NOT the From header and
   *  is what a bounce would go to. */
  envelopeFrom: string;
  /** When we stored it, not the sender's clock. */
  receivedAt: string;
  /** The sender's own `Date`, when it had one that parsed. */
  sentAt?: string;
  /** RFC 5322 Message-ID, angle brackets stripped. Absent is legal. */
  messageId?: string;
  inReplyTo?: string;
  /**
   * RFC 5322 References, angle brackets stripped, oldest first (slice 8):
   * every message the sender's client says came before this one in its
   * conversation. Kept, capped, from the day conversations were built — mail
   * stored before then has only its `inReplyTo`.
   */
  references?: string[];
  /**
   * The CONVERSATION this message is part of (slice 8): the id of the message
   * that started it, here. Decided once, when the message is stored, from the
   * headers that say what it answers — never from its subject — and never
   * changed afterwards: a message joins one conversation, and nothing a
   * stranger writes can glue two of this person's conversations together.
   */
  thread?: string;
  from?: MailPartyRef;
  to: MailPartyRef[];
  cc: MailPartyRef[];
  replyTo: MailPartyRef[];
  subject: string;
  /** The first line or two, for a list that shows one row per message. */
  snippet: string;
  /** The plain-text body, up to the inline ceiling. */
  text?: string;
  /** The HTML body, up to the inline ceiling. Stored as it arrived; whatever
   *  renders it is the thing that has to make it safe. */
  html?: string;
  /** True when a body was longer than we store inline. The whole of it is
   *  always in `raw`. */
  bodyTruncated?: boolean;
  attachments: MailAttachmentRecord[];
  /** Attachments past the ceiling, present in `raw` and nowhere else. */
  attachmentsTruncated?: number;
  raw: { storagePath: string; size: number };
  authentication?: MailAuthenticationVerdict;
  /** DMARC said no, or nothing authenticated at all. Kept, never dropped —
   *  the screen is what decides how loudly to say so. */
  suspicious?: boolean;
  /** Why the MIME parse failed, when it did. The envelope, subject and raw
   *  bytes are still here; the body and attachments are only in `raw`. */
  parseError?: string;
  /**
   * When the OWNER opened it. Absent means it is still new, which is what
   * makes its row stand out in the list.
   *
   * Set by the person's own screen opening the message, and by nothing else:
   * an agent reading its owner's mail leaves this alone on purpose, because
   * the question this field answers is "has the person seen it", and an agent
   * reading their post does not make them read it.
   */
  readAt?: string;
  /**
   * When it was put in the ARCHIVE (slice 7): out of the inbox, kept whole,
   * still found by a search. Absent means it is where it arrived.
   */
  archivedAt?: string;
  /**
   * When it was moved to TRASH (slice 7). A soft delete and nothing more:
   * the row, its words and its bytes all stay, and restoring it clears this
   * and nothing else, so it goes back where it was — the archive, when it
   * had been archived first. There is no clock on it and no way from here to
   * remove a message for good.
   */
  trashedAt?: string;
  /** The AGENT that archived it, when a person did not. The same honesty as
   *  `sentBy`: a message that left the owner's inbox without them touching it
   *  is exactly what they should be able to see at a glance. */
  archivedBy?: { agentId: string; name?: string };
  /** The agent that moved it to Trash, when a person did not. */
  trashedBy?: { agentId: string; name?: string };
  /**
   * When it was put in SPAM (slice 13): out of the inbox, kept whole, out of
   * every search but Spam's own. Three things put a letter here — the domain's
   * own checks (`suspicious`, on the way in), a sender its owner BLOCKED, and
   * its owner or their agent saying so — and `spamWhy` records which, because
   * the screen owes the reader a different sentence for each. Trash still
   * wins over it, and Restore leaves a spam letter in Spam.
   */
  spamAt?: string;
  spamWhy?: 'suspicious' | 'blocked' | 'marked';
  /** The agent that marked it spam, when a person did not. */
  spamBy?: { agentId: string; name?: string };
  /**
   * The owner said this is NOT spam. What keeps the boot pass that files
   * suspicious mail into Spam from filing it again, and nothing else: a sender
   * blocked afterwards still takes it with them, because that is a decision
   * made later about the sender, not the letter.
   */
  notSpam?: true;
  /**
   * When its owner STARRED it (note #666): a mark on one letter that says
   * "come back to this", and nothing else. It moves nothing — a starred
   * letter stays in the inbox, the archive or wherever it is kept — and the
   * Starred list is every letter wearing it that is not in Trash or Spam.
   * Any letter can wear it, one this person sent included; a conversation
   * is starred while any letter in it is.
   */
  starredAt?: string;
  /** The agent that starred it, when a person did not — named on the owner's
   *  own list for the reason `archivedBy` is. */
  starredBy?: { agentId: string; name?: string };
}

/**
 * Where a message is kept (slice 7). Two stamps decide it rather than one
 * field, so that Trash can be undone exactly: `trash` wins over `archive`,
 * and restoring out of Trash leaves an archived message archived.
 */
export type MailPlace = 'inbox' | 'archive' | 'spam' | 'trash';
/**
 * What a list can be asked for: one place; `all` — everything that is not in
 * Trash, which is what a search looks through unless told otherwise; or
 * `sent` (slice 9) — everything that has gone OUT of this address, replies
 * included.
 *
 * `sent` is the one view that is not a place. A letter is kept in the inbox,
 * the archive or Trash and is in exactly one of them; Sent asks the other
 * question — what has this address said — and answers it with letters that
 * are kept all over the place. The only thing it leaves out is Trash, for
 * the reason a search leaves it out: that is what putting something there
 * means.
 */
export type MailView = MailPlace | 'all' | 'sent' | 'starred';
/**
 * `starred` (note #666) is the other view that is not a place: every letter
 * its owner starred, wherever it is kept, one row per letter — replies this
 * person sent included, since any letter can be starred. It leaves out Trash
 * and Spam, the two places a letter goes when its reader is done with it or
 * nothing vouched for it.
 */
export const MAIL_VIEWS: readonly MailView[] = ['inbox', 'archive', 'spam', 'trash', 'all', 'sent', 'starred'];
/** The six ways a message changes place, each the undo of another. Spam and
 *  Not spam (slice 13) are the third pair. */
export type MailMove = 'archive' | 'unarchive' | 'spam' | 'unspam' | 'trash' | 'restore';
export const MAIL_MOVES: readonly MailMove[] = ['archive', 'unarchive', 'spam', 'unspam', 'trash', 'restore'];

export type MailMoveOutcome =
  /** `moved: false` when it was already there — asking twice is not an error. */
  | { moved: boolean; doc: MailMessageDocument }
  | { refused: 'no_such_message' | 'is_reply' | 'in_trash' | 'in_spam' };

/** What the list screen asks for: a page of messages, newest first. */
export interface MailMessagePage {
  messages: MailMessageDocument[];
  /** The cursor to ask for the next page with, when there is one. */
  nextBefore?: string;
}

export interface MailListOptions {
  limit?: number;
  /** The previous page's `nextBefore`. The same seq cursor with or without
   *  a search, because a search is ordered the way the list is: newest first. */
  before?: string;
  /** Which place, or `sent`. Defaults to the inbox — or, when there is a
   *  search, to `all`: a person looking for a letter they archived must still
   *  find it. A search of `sent` looks through Sent alone, as Trash does. */
  in?: MailView;
  /** Words to look for in who it is from (or to), its subject and its body. */
  search?: string;
}

/**
 * One conversation (slice 8): every message in it, the replies this person
 * sent included, oldest first. A LIST reads it without the bodies — a row
 * needs who, what, when and where, never the words of every letter in it.
 */
export interface MailConversation {
  thread: string;
  messages: MailMessageDocument[];
}

export interface MailConversationPage {
  conversations: MailConversation[];
  /** The cursor to ask for the next page with, when there is one. */
  nextBefore?: string;
}

export interface MailConversationListOptions {
  limit?: number;
  /** The previous page's `nextBefore`: the newest activity of its last row. */
  before?: string;
  /** Which place. Defaults to the inbox. */
  in?: MailPlace;
}

export type MailConversationMoveOutcome =
  /** `moved: false` when nothing in it needed moving. */
  | { moved: boolean; conversation: MailConversation }
  | { refused: 'no_such_message' | 'in_trash' | 'in_spam' };

/**
 * Starring (note #666). A star is put on ONE letter, or taken off; `whole`
 * is what a conversation's row does. Starring it stars the newest letter in
 * it that ARRIVED — what the other side said, which is what a reader starring
 * a conversation means to come back to, and never a forward or an answer of
 * their own that happens to be newer — or, while nobody has written back, the
 * newest letter they sent; never one in Trash or Spam. Taking the star off
 * takes it off every letter in it, since a row that still wore a star after
 * the tap would be telling its reader the tap did nothing.
 */
export interface MailStarOptions {
  starred: boolean;
  whole?: boolean;
  atIso: string;
  by?: { agentId: string; name?: string };
}

export type MailStarOutcome =
  /** `changed: false` when every letter was already as asked. The whole
   *  conversation comes back either way, without its bodies, so both doors
   *  can redraw every row and letter the answer touches. */
  | { changed: boolean; doc: MailMessageDocument; conversation: MailConversation }
  /** A star is not put on a letter in Trash or Spam — the Starred list could
   *  never show it. Taking one off is never refused. */
  | { refused: 'no_such_message' | 'in_trash' | 'in_spam' };

/** Blocking one sender (slice 13): the list as it now stands, and how many
 *  letters of theirs left the inbox and the archive for Spam with it. */
export interface MailBlockOutcome {
  addresses: string[];
  moved: number;
}

export type MailMessageStoreOutcome =
  | { stored: 'new'; id: string }
  /** The same Message-ID at the same address, seen before. A redelivery is
   *  success, not a conflict: the sender must not be asked to try again. */
  | { stored: 'duplicate'; id: string };

export interface MailMessageStorage {
  store(doc: MailMessageDocument): Promise<MailMessageStoreOutcome>;
  get(userId: string, id: string): Promise<MailMessageDocument | null>;
  /**
   * THE LIST, newest first: what arrived, and what this person STARTED. A
   * reply is not a row here — it belongs under the message it answers, which
   * is where it is read — but a message written to somebody who never wrote
   * answers nothing, so a row of its own is the only place it could appear.
   *
   * `in: 'sent'` (slice 9) is the exception, and the one list a reply IS a
   * row of: everything that has gone out of this address, which is the
   * question the inbox cannot answer.
   */
  list(userId: string, opts?: MailListOptions): Promise<MailMessagePage>;
  /**
   * Move one message between the inbox, the archive and Trash (slice 7).
   * Only a row of the list can be ASKED to move: a reply is read under the
   * message it answers and goes wherever that message goes — so the replies
   * it holds are stamped with it, which is what makes Sent say where each of
   * them is kept. A message in Trash has to be restored before it can be
   * archived or brought back to the inbox, so that the one undo for Trash is
   * Restore.
   */
  move(userId: string, id: string, move: MailMove, opts: { atIso: string; by?: { agentId: string; name?: string } }): Promise<MailMoveOutcome>;
  /** The replies this person sent to one message, oldest first. */
  listAnswers(userId: string, messageId: string): Promise<MailMessageDocument[]>;
  /**
   * THE LIST AS CONVERSATIONS (slice 8), newest activity first — a reply this
   * person sent is activity too. A conversation is in the inbox while any of
   * its letters is; else in the archive while any is there; else in Trash. So
   * an answer arriving in a conversation that was put away brings it back to
   * the inbox, the way every mail client does, without moving anything else.
   * Paged by the newest activity's `seq`, which no two conversations share.
   */
  listConversations(userId: string, opts?: MailConversationListOptions): Promise<MailConversationPage>;
  /** The whole conversation a message is part of, with every body, oldest
   *  first. Null when the message is not this person's. */
  getConversation(userId: string, messageId: string): Promise<MailConversation | null>;
  /**
   * Move a whole conversation (slice 8): every letter of it that the move
   * applies to, under the same guards a single move has, in one transaction.
   * Replies are stamped with it — they go wherever their conversation goes,
   * and since slice 9 that is a fact Sent can read off them. Archive
   * and Move to inbox are refused only when ALL of it is in Trash — a
   * conversation that is partly in Trash archives the rest.
   */
  moveConversation(userId: string, messageId: string, move: MailMove, opts: { atIso: string; by?: { agentId: string; name?: string } }): Promise<MailConversationMoveOutcome>;
  /** The owner opened the conversation, and so read every letter in it.
   *  Answers how many were new. */
  markConversationRead(userId: string, thread: string, atIso: string): Promise<number>;
  /**
   * Star a letter, or take its star off (note #666) — or, with `whole`, the
   * conversation it is part of. One guarded update, so starring twice changes
   * nothing and a star is stamped with the FIRST time.
   */
  star(userId: string, messageId: string, opts: MailStarOptions): Promise<MailStarOutcome>;
  /**
   * The owner has now seen this message. Stamps `readAt` once and leaves an
   * already-read message alone, so the stamp says when they FIRST opened it.
   * Answers whether this read is the one that changed it.
   */
  markRead(userId: string, id: string, atIso: string): Promise<boolean>;
  /**
   * How many messages have ARRIVED and not been opened. Its own count rather
   * than a walk of the list, because the door on Home asks this every few
   * seconds and must never read anybody's private words to answer it.
   *
   * The INBOX's count: a message put in the archive or in Trash has been
   * dealt with, and a door that kept counting it would never go quiet.
   */
  countUnread(userId: string): Promise<number>;
  /**
   * EVERYTHING this person has sent, newest first — replies included. The
   * list above shows a reply under the message it answers, which is where a
   * reader wants it; this is the other question, "what has gone out of this
   * address", and it cannot be answered by walking the inbox.
   *
   * The same list the Workspace's Sent screen reads (slice 9), and
   * deliberately one definition of it: `list(in: 'sent')`, so the agent's
   * `mail sent` and its owner's screen can never disagree about what has
   * gone out.
   */
  listSent(userId: string, opts?: { limit?: number; before?: string }): Promise<MailMessagePage>;
  /**
   * How many replies this person has sent since a moment. The send limit is
   * counted off the stored messages rather than held in memory, so a deploy
   * does not hand anybody a fresh allowance.
   */
  countSentSince(userId: string, sinceIso: string): Promise<number>;
  /**
   * How many messages this person has STARTED since a moment — replies not
   * counted. Cold mail has its own, tighter ceiling than answering, so it
   * needs its own count: a busy afternoon of replies must not spend it.
   * A forward is counted (it answers nothing), and so is a reply whose Cc
   * reached somebody new (`reachesNew`, slice 12).
   */
  countNewSince(userId: string, sinceIso: string): Promise<number>;
  countForUser(userId: string): Promise<number>;
  /**
   * THE SENDERS WHOSE PICTURES THIS PERSON LOADS (slice 10), lowercased and
   * sorted. A remote picture is a read receipt, so nothing is fetched for a
   * letter unless its reader asked — once, per sender, from a letter that
   * sender wrote. There is no general "always load": this list is the only
   * way a picture is drawn without a tap, which is why it lives beside the
   * mail it decides about rather than in a settings store nobody would think
   * to look in.
   */
  imageSenders(userId: string): Promise<string[]>;
  /** Put one address on that list. Asking twice changes nothing. */
  allowImagesFrom(userId: string, address: string, atIso: string): Promise<string[]>;
  /** Take one off it — offered on every letter from a sender that is on it,
   *  because the way back has to be where the decision is visible. */
  stopImagesFrom(userId: string, address: string): Promise<string[]>;
  /**
   * THE SENDERS THIS PERSON HAS BLOCKED (slice 13), lowercased and sorted. A
   * letter from one of them lands in Spam on the way in and wakes nobody; the
   * letter is still stored whole, because nothing here drops mail.
   */
  blockedSenders(userId: string): Promise<string[]>;
  /**
   * Block one address: on the list, and every letter of theirs that is in the
   * inbox or the archive goes to Spam with it (the replies under each going
   * where it goes), stamped with why and with the agent's name when an agent
   * asked. Blocking twice changes nothing.
   */
  blockSender(userId: string, address: string, opts: { atIso: string; by?: { agentId: string; name?: string } }): Promise<MailBlockOutcome>;
  /** Take one off the list. Their letters stay where they are — Not spam
   *  brings one back, and that is a decision about a letter. */
  unblockSender(userId: string, address: string): Promise<string[]>;
}
