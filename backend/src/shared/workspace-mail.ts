/**
 * Every person's own address on the platform's mail domain — the name they
 * choose at signup and the grammar it has to keep. Slice 1 of the email
 * service (note #509) allocates the address; the inbox behind it follows.
 *
 * The rules live here, in shared code, because the browser has to say "that
 * one is taken" before the form is sent and the backend has to be the one
 * that actually decides. Two copies of this grammar would drift.
 */

import { RESERVED_MAILBOX_LOCALS, isReservedHandle } from './handles.js';

/** The platform's own mail domain: every personal address here is on it. */
export const DEFAULT_MAIL_DOMAIN = 'agenticcloudcomputer.com';

const MAIL_DOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * A private copy (note #804) puts addresses on the customer's own domain:
 * the backend reads MAIL_DOMAIN, and the Workspace shell it serves carries
 * the same value in `<meta name="acc-mail-domain">` for the browser, which
 * has no environment of its own. Anything unset or malformed is ours.
 */
function configuredMailDomain(): string {
  // Through globalThis: this module also compiles for the public site, which
  // has neither Node's types nor a server environment.
  const host = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    document?: { querySelector(selector: string): { getAttribute(name: string): string | null } | null };
  };
  const fromServer = host.process?.env?.MAIL_DOMAIN;
  const fromShell = host.document?.querySelector('meta[name="acc-mail-domain"]')?.getAttribute('content') ?? undefined;
  const value = (fromServer ?? fromShell ?? '').trim().toLowerCase();
  return MAIL_DOMAIN_SHAPE.test(value) ? value : DEFAULT_MAIL_DOMAIN;
}

/** The one domain every personal address is on. */
export const MAIL_DOMAIN = configuredMailDomain();

export const MAIL_LOCAL_MIN = 3;
export const MAIL_LOCAL_MAX = 32;

/**
 * Lowercase letters and digits, with single dots or hyphens between them.
 * Deliberately narrower than RFC 5321 allows: an address a person reads out
 * loud, types on a phone keyboard and recognizes in a From line cannot
 * contain quoting, capitals or two dots in a row.
 */
const MAIL_LOCAL_SHAPE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** The staff and role mailboxes nobody may take, kept with every other
 *  reserved word in `shared/handles.ts` (the name is also the public address). */
export const RESERVED_MAIL_LOCALS: readonly string[] = RESERVED_MAILBOX_LOCALS;

/**
 * The name is also the person's public address at the root of the domain
 * (knowledge page "public-addresses", 2026-09-26): `adam` is
 * `adam@agenticcloudcomputer.com` AND `agenticcloudcomputer.com/adam`. So a
 * word the domain already answers on — a landing page, an entry door, the
 * first word of a Workspace address — is refused here exactly as a staff
 * mailbox is. One namespace, one check, shared with workplace handles.
 */
const isReservedMailLocal = isReservedHandle;

export type MailLocalProblem = 'empty' | 'too-short' | 'too-long' | 'shape' | 'reserved';

/**
 * What the person typed, reduced to the candidate we test and store: spaces
 * off, lowercase, and a whole address accepted as its own local part so
 * pasting `adam@agenticcloudcomputer.com` into the field works. Anything
 * else keeps its characters so `mailLocalProblem` can explain the refusal
 * rather than silently repairing an address somebody will have for years.
 */
export function normalizeMailLocal(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  const local = at === -1 ? trimmed : trimmed.slice(0, at);
  const domain = at === -1 ? '' : trimmed.slice(at + 1);
  // A pasted address is only that address; another domain is not ours to take
  // the name from, and returning '' makes it a refusal rather than a silent
  // rewrite of somebody else's mailbox into one of ours.
  if (at !== -1 && domain !== MAIL_DOMAIN) return '';
  return local;
}

/** The one reason this local part cannot be an address here, or null. */
export function mailLocalProblem(local: string): MailLocalProblem | null {
  if (!local) return 'empty';
  if (local.length < MAIL_LOCAL_MIN) return 'too-short';
  if (local.length > MAIL_LOCAL_MAX) return 'too-long';
  if (!MAIL_LOCAL_SHAPE.test(local)) return 'shape';
  if (isReservedMailLocal(local)) return 'reserved';
  return null;
}

/** The sentence a person reads under the field. */
export function mailLocalHint(problem: MailLocalProblem): string {
  switch (problem) {
    case 'empty': return 'Choose the name that comes before the @.';
    case 'too-short': return `Use at least ${MAIL_LOCAL_MIN} characters.`;
    case 'too-long': return `Use at most ${MAIL_LOCAL_MAX} characters.`;
    case 'reserved': return 'That name is kept for the platform. Choose another.';
    case 'shape': return 'Use lowercase letters and numbers, with single dots or hyphens between them.';
  }
}

/** The full address a valid local part becomes. */
export function mailAddress(local: string): string {
  return `${local}@${MAIL_DOMAIN}`;
}

/**
 * What somebody typed into the sign-in field, read as an address here when
 * they left the domain off: `adam` is `adam@agenticcloudcomputer.com`, while
 * an account created before this service keeps signing in with the outside
 * email it was made with.
 */
export function mailSignInAddress(value: string): string {
  return value.includes('@') ? value : mailAddress(value);
}

/** Whether an address is one of ours — the sign-in name of an account made
 *  here, rather than an outside email somebody proved they own. */
export function isMailDomainAddress(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.toLowerCase().endsWith(`@${MAIL_DOMAIN}`);
}

/** A person's mailbox as every screen outside the mail service sees it. */
export interface WorkspaceMailboxSummary {
  address: string;
}

/** GET auth/email/address — is this name free? */
export interface WorkspaceMailAddressAvailability {
  local: string;
  address: string;
  available: boolean;
  problem?: MailLocalProblem;
}

/** POST api/mail/address — the answer after a name is claimed. */
export interface WorkspaceMailAddressClaimAnswer {
  mailbox: WorkspaceMailboxSummary;
}

// ── The inbox behind the address (slice 2) ─────────────────────────────────
// Everything below describes mail that has ARRIVED. It is derived from a MIME
// message a stranger wrote, so every field is what we could read rather than
// what the sender promised: `from` is the From header's claim, and
// `authentication` is what the domain's own checks made of it.

export interface WorkspaceMailParty {
  address: string;
  name?: string;
}

/** One row of the list. */
export interface WorkspaceMailMessageSummary {
  id: string;
  from?: WorkspaceMailParty;
  subject: string;
  snippet: string;
  /** When it reached us. The sender's own clock is `sentAt`, and it lies. */
  receivedAt: string;
  sentAt?: string;
  files: number;
  /** Nothing proved it came from where it says. Shown, never hidden. */
  suspicious?: boolean;
  /** The MIME could not be read. The original is still downloadable. */
  unreadable?: boolean;
  /**
   * Which way it went. Absent means it arrived, which is nearly every row;
   * `sent` is a message this person sent, and such a row is named by `to`
   * rather than by `from`. In every list but Sent (slice 9) that means one
   * they STARTED: a reply is read under the message it answers, and Sent is
   * the one list it is a row of.
   */
  direction?: 'in' | 'sent';
  /** Who it went to. On a sent row; a detail carries it either way. */
  to?: WorkspaceMailParty[];
  /**
   * NEW: it arrived and its owner has not opened it yet. The list draws such
   * a row heavier, the way every mail app does. Absent on a message this
   * person sent — there is nothing there for them to read.
   */
  unread?: boolean;
  /**
   * The agent that wrote it, when one did (note #509, slice 6). Shown to the
   * OWNER only — the recipient sees the person's own address and name, since
   * the address is theirs — so that a row they did not write says so.
   */
  sentBy?: string;
  /**
   * Where it is kept, when that is not the inbox (slice 7). A message in
   * Trash is still whole; `trash` wins over `spam` wins over `archive`, and
   * Restore puts an archived message back in the archive.
   */
  place?: WorkspaceMailPlace;
  /** The agent that put it there, when a person did not. */
  movedBy?: string;
  /**
   * WHY it is in Spam (slice 13), when it is: the domain's checks marked it
   * (`suspicious`), its sender is on this person's blocked list, or somebody
   * — this person, or the agent `movedBy` names — marked it. The screen owes
   * a different sentence for each, and the answer is the server's.
   */
  spamWhy?: 'suspicious' | 'blocked' | 'marked';
  /**
   * On a letter this person FORWARDED (slice 12): our id of the letter it
   * forwards. A forward answers nothing — it reaches somebody who never
   * wrote — but it is kept in that letter's conversation, and this is the
   * link the conversation screen draws "Forwarded to … on …" from.
   */
  forwards?: string;
  /**
   * Its owner STARRED it (note #666): a mark that says "come back to this",
   * and nothing more — it moves nothing. Every starred letter not in Trash or
   * Spam is in Starred.
   */
  starred?: true;
  /** The agent that starred it, when a person did not. */
  starredBy?: string;
}

/**
 * The lists that can be asked for (`?in=`): one of the three places; `all` —
 * everything not in Trash, which is where a search looks unless told; or
 * `sent` (slice 9), everything that has gone OUT of this address, replies
 * included. Sent is the one that is not a place: a letter in it is kept in
 * the inbox or the archive like any other, and the only thing it leaves out
 * is Trash.
 */
export type WorkspaceMailView = 'inbox' | 'archive' | 'spam' | 'trash' | 'all' | 'sent' | 'starred';

/** Where a letter is kept when that is not the inbox: the archive, Spam
 *  (slice 13) or Trash. */
export type WorkspaceMailPlace = 'archive' | 'spam' | 'trash';

/** The six moves, each the undo of another. Spam and Not spam are slice 13's. */
export type WorkspaceMailMove = 'archive' | 'unarchive' | 'spam' | 'unspam' | 'trash' | 'restore';

export interface WorkspaceMailFile {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  /** A picture the body points at with `cid:`, rather than a file to keep. */
  inline?: boolean;
  contentId?: string;
}

/** One reply this person sent to a message, as it is read under it. */
export interface WorkspaceMailReply {
  id: string;
  to: WorkspaceMailParty[];
  /** Everybody else it was copied to (slice 12). */
  cc?: WorkspaceMailParty[];
  /** The files that went with it (slice 12). */
  attachments?: WorkspaceMailFile[];
  /** What the person wrote, without the quoted message under it: that quote
   *  is for the recipient, who did not have the conversation in front of them. */
  text: string;
  sentAt: string;
  /**
   * The agent that wrote this answer, when one did — the same fact the list
   * carries on a message an agent sent (`sentBy` above), said in the one
   * other place an agent's words leave this address. `agentbuilt mail show`
   * has always printed it; the owner's own screen used to show an agent's
   * reply as if they had typed it themselves.
   */
  sentBy?: string;
}

export interface WorkspaceMailMessageDetail extends WorkspaceMailMessageSummary {
  to: WorkspaceMailParty[];
  cc: WorkspaceMailParty[];
  replyTo: WorkspaceMailParty[];
  text?: string;
  html?: string;
  /** The stored body stops short of the whole message; the original does not. */
  bodyTruncated?: boolean;
  files: number;
  attachments: WorkspaceMailFile[];
  authentication?: { spf?: string; dkim?: string; dmarc?: string };
  /**
   * This reader has asked for pictures from this sender to be loaded, always
   * (slice 10). Decided by the SERVER off their own list of addresses, never
   * by the screen — so a message drawn from a held copy cannot quietly load a
   * remote picture the reader took off the list on another tab.
   */
  imagesAllowed?: true;
  /**
   * This letter's sender is on the reader's BLOCKED list (slice 13). The
   * server's answer, off the list, for the reason `imagesAllowed` is: the
   * letter offers Unblock rather than Block, and it must be right.
   */
  senderBlocked?: true;
  /** Bytes of the original message, downloadable as the file id `raw`. */
  rawSize: number;
  /** Replies this person has already sent to it, oldest first. */
  replies: WorkspaceMailReply[];
  /**
   * Who a reply would go to — read off the message by the server, never
   * chosen by the screen. Absent when there is nobody to answer, which is
   * also when the screen offers no Reply.
   */
  answerTo?: WorkspaceMailParty;
}

/** POST api/mail/messages/:id/reply */
export interface WorkspaceMailReplyAnswer {
  reply: WorkspaceMailReply;
}

/** POST api/mail/send — a new message, to somebody who has not written. */
export interface WorkspaceMailSendAnswer {
  message: WorkspaceMailMessageSummary;
}

/** POST api/mail/messages/:id/forward — the forward, which is a letter of
 *  its own in Sent and in the conversation of the letter it forwards. */
export interface WorkspaceMailForwardAnswer {
  message: WorkspaceMailMessageSummary;
}

// ── Writing grows up (slice 12): Cc, files out, forwarding ──────────────────
// Every number here is enforced by the SERVER; the screens and the CLI read
// the same constants only so that they can say the limit before the person
// runs into it. The ceilings on how many messages a person may send stay
// per MESSAGE — a Cc does not multiply them — which is exactly why the
// number of people one message reaches is capped: a message is never a list.

/** Addresses on the Cc line, one box each. */
export const MAIL_MAX_CC = 3;
/** Everybody one message reaches: To and Cc together. No Bcc, ever. */
export const MAIL_MAX_RECIPIENTS = 1 + MAIL_MAX_CC;
/** Files on one message that goes out. */
export const MAIL_OUT_MAX_FILES = 5;
/** One file. */
export const MAIL_OUT_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Every file on one message together. The provider's own ceiling is 40 MB
 *  after base64, which this stays well inside. */
export const MAIL_OUT_TOTAL_MAX_BYTES = 15 * 1024 * 1024;
/**
 * The content type of a send, reply or forward that carries files: the chat
 * composer's envelope — four big-endian bytes saying how long the UTF-8 JSON
 * manifest is, the manifest (the message's fields and `files: [{ fileName,
 * contentType, sizeBytes }]`), then each file's bytes in order. No base64
 * expansion on the way in. A message with no files is still plain JSON.
 */
export const MAIL_UPLOAD_CONTENT_TYPE = 'application/vnd.agentbuilt.mail-files';

/**
 * What the provider (Resend) refuses to carry at all, copied from its own
 * list. Refused HERE, before anything is counted or any card is placed, so
 * that nobody approves a letter that could never have gone.
 */
export const MAIL_REFUSED_EXTENSIONS: readonly string[] = [
  'adp', 'app', 'asp', 'bas', 'bat', 'cer', 'chm', 'cmd', 'com', 'cpl', 'crt', 'csh', 'der', 'exe', 'fxp',
  'gadget', 'hlp', 'hta', 'inf', 'ins', 'isp', 'its', 'js', 'jse', 'ksh', 'lib', 'lnk', 'mad', 'maf', 'mag',
  'mam', 'maq', 'mar', 'mas', 'mat', 'mau', 'mav', 'maw', 'mda', 'mdb', 'mde', 'mdt', 'mdw', 'mdz', 'msc',
  'msh', 'msh1', 'msh2', 'mshxml', 'msh1xml', 'msh2xml', 'msi', 'msp', 'mst', 'ops', 'pcd', 'pif', 'plg',
  'prf', 'prg', 'reg', 'scf', 'scr', 'sct', 'shb', 'shs', 'sys', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1',
  'psc2', 'tmp', 'url', 'vb', 'vbe', 'vbs', 'vps', 'vsmacros', 'vss', 'vst', 'vsw', 'vxd', 'ws', 'wsc',
  'wsf', 'wsh', 'xnk',
];
const REFUSED_EXTENSIONS = new Set(MAIL_REFUSED_EXTENSIONS);

/** Why one file cannot go out by mail, or null when it can. A name that
 *  starts with a dot is refused rather than renamed: `.env` is precisely the
 *  kind of file nobody means to send. */
export function mailOutFileRefusal(file: { fileName: string; size: number }): string | null {
  const name = file.fileName.trim();
  if (!name) return 'A file needs a name.';
  if (name.startsWith('.')) return `${name} starts with a dot, and a hidden file does not go out by mail.`;
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (extension && REFUSED_EXTENSIONS.has(extension)) return `Mail cannot carry .${extension} files: ${name} would be refused.`;
  if (file.size <= 0) return `${name} is empty.`;
  if (file.size > MAIL_OUT_FILE_MAX_BYTES) return `${name} is larger than 10 MB, which is the most one file here can be.`;
  return null;
}

/** Why a set of files cannot go out together, or null when it can. */
export function mailOutFilesRefusal(files: ReadonlyArray<{ fileName: string; size: number }>): string | null {
  if (files.length > MAIL_OUT_MAX_FILES) return `A message carries at most ${MAIL_OUT_MAX_FILES} files.`;
  for (const file of files) {
    const refusal = mailOutFileRefusal(file);
    if (refusal) return refusal;
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAIL_OUT_TOTAL_MAX_BYTES) return 'The files come to more than 15 MB, which is the most one message can carry.';
  return null;
}

/**
 * One agent-authored email waiting in the conversation where it was asked
 * for. The browser gets the whole message because there is deliberately no
 * second detail screen: the decision is made in chat, over these exact words.
 */
export type WorkspaceMailApprovalStatus = 'pending' | 'sending' | 'sent' | 'rejected';
export interface WorkspaceMailApproval {
  id: string;
  kind: 'send' | 'reply' | 'forward';
  from: WorkspaceMailParty;
  to: WorkspaceMailParty;
  /** Everybody else it goes to (slice 12). Absent when nobody. */
  cc?: WorkspaceMailParty[];
  subject: string;
  /** What goes out, whole — for a forward, the words AND the letter quoted
   *  under them, because that is what leaves. */
  text: string;
  /**
   * Every file that leaves with it, by name and size (slice 12): the owner is
   * approving what goes out of their address, and a file is the part of a
   * letter nobody can read off the words.
   */
  attachments?: Array<{ fileName: string; size: number; contentType: string }>;
  requestedBy: string;
  status: WorkspaceMailApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  sentMessageId?: string;
  /** The last send attempt failed and the request is open again. */
  error?: string;
}

/** GET/POST api/mail/approvals/:id[/decision]. */
export interface WorkspaceMailApprovalAnswer {
  approval: WorkspaceMailApproval;
}

/** GET api/mail/messages[?in=inbox|archive|spam|trash|all|sent|starred][&q=words][&before=cursor] */
export interface WorkspaceMailMessagesAnswer {
  /** The reader's own address, so the screen can say whose inbox this is. */
  address?: string;
  messages: WorkspaceMailMessageSummary[];
  /** Cursor for the next page, when there is one. */
  nextBefore?: string;
}

/** POST api/mail/messages/:id/(archive|unarchive|trash|restore) — the
 *  message as it now stands. */
export interface WorkspaceMailMoveAnswer {
  message: WorkspaceMailMessageSummary;
}

/** GET api/mail/unread — the count the door on Home wears. */
export interface WorkspaceMailUnreadAnswer {
  unread: number;
}

/** GET api/mail/messages/:id */
export interface WorkspaceMailMessageAnswer {
  message: WorkspaceMailMessageDetail;
}

// ── Who a letter wakes (slice 11) ──────────────────────────────────────────

/** One agent this person could choose. Their own, in any of their rooms. */
export interface WorkspaceMailWakeCandidate {
  id: string;
  name: string;
  /** The harness it thinks with, so two agents of one name are tellable. */
  cli?: string;
  /** The room it works in, when this backend can name one. */
  room?: string;
}

/**
 * GET/PUT api/mail/wake — the opt-in choice of ONE agent to be woken when a
 * letter arrives. `agent` is null for NOBODY, which is the default and what
 * a deleted or moved-away agent silently falls back to.
 */
export interface WorkspaceMailWakeAnswer {
  agent: WorkspaceMailWakeCandidate | null;
  agents: WorkspaceMailWakeCandidate[];
  /**
   * A choice was made and the agent it named is gone — deleted, or moved out
   * of this person's reach. The wake falls back to nobody on its own and
   * says nothing; this is how SETTINGS says so, which is the one place the
   * person can do anything about it.
   */
  lapsed?: true;
}

/** PUT api/mail/wake — `null` chooses nobody. */
export interface WorkspaceMailWakeRequest {
  agentId: string | null;
}

// ── Conversations (slice 8) ────────────────────────────────────────────────

/**
 * One CONVERSATION, as a row of the list: every message that answers another
 * in it, joined by the headers mail writes for that — never by subject — and
 * the replies this person sent among them.
 */
export interface WorkspaceMailConversationSummary {
  /** The conversation's key. Opaque: a screen opens a conversation by any
   *  message in it, and names the one it wants to stand at. */
  id: string;
  /** Who it is with — everybody who wrote in it or was written to, in the
   *  order they joined, and never the reader. */
  with: WorkspaceMailParty[];
  /** Nobody has written back yet: every message in it is one this person
   *  sent. Its row is named by who it went to, as a sent row always was. */
  started?: boolean;
  /** Its first message's subject — the conversation's name. */
  subject: string;
  /** The newest message: the row's first line and its clock. */
  latest: {
    id: string;
    snippet: string;
    receivedAt: string;
    /** This person wrote it, which the row's first line says. */
    direction?: 'sent';
    /** The agent that wrote it, when one did. */
    sentBy?: string;
  };
  /** How many messages are in it, the replies this person sent included. */
  count: number;
  /** The message a tap opens it at: the first one not yet opened, else the newest. */
  opens: string;
  /** Any message in it that arrived and has not been opened. */
  unread?: boolean;
  /** Files, across the whole conversation. */
  files: number;
  /** Any message in it that nothing vouched for. */
  suspicious?: boolean;
  unreadable?: boolean;
  /**
   * Where it is kept, when that is not the inbox: in the inbox while any
   * message in it is, else in the archive while any is, else in Trash. An
   * answer arriving in a conversation that was put away brings it back.
   */
  place?: WorkspaceMailPlace;
  /** The agent that put it there, when a person did not. */
  movedBy?: string;
  /** Why it is in Spam, when it is (slice 13): read off the letter that
   *  decides its place, exactly as `movedBy` is. */
  spamWhy?: 'suspicious' | 'blocked' | 'marked';
  /** How many of its messages are in Trash while the conversation is not —
   *  one an agent trashed alone, or the ones left there when an answer
   *  brought the rest back. */
  trashed?: number;
  /** Any letter in it is starred (note #666), outside Trash and Spam. */
  starred?: true;
}

/** GET api/mail/conversations[?in=inbox|archive|trash][&before=cursor] */
export interface WorkspaceMailConversationsAnswer {
  address?: string;
  conversations: WorkspaceMailConversationSummary[];
  nextBefore?: string;
}

/**
 * One message as it stands in its conversation. A message this person SENT
 * carries what they wrote as its `text` — the quote under it went to the
 * recipient, who did not have the conversation in front of them.
 */
export type WorkspaceMailThreadMessage = Omit<WorkspaceMailMessageDetail, 'replies' | 'answerTo'>;

/** GET api/mail/conversations/:messageId — the conversation that message is in. */
export interface WorkspaceMailConversation extends WorkspaceMailConversationSummary {
  /** Every message in it, oldest first. */
  messages: WorkspaceMailThreadMessage[];
  /**
   * What a reply at the foot answers — the newest message in it that arrived
   * and names somebody to answer — and who that is, read off it by the
   * server. Absent when there is nobody to answer, which is also when the
   * screen offers no Reply.
   */
  reply?: {
    id: string;
    to: WorkspaceMailParty;
    /**
     * Reply to all (slice 12): everybody else the answered letter was
     * addressed to — its To and Cc, never this address and never `to` — which
     * the composer offers as the Cc line. At most `MAIL_MAX_CC`; `allLeftOut`
     * counts the rest, because a message here is never a list. Absent when
     * the letter went to nobody else.
     */
    all?: WorkspaceMailParty[];
    allLeftOut?: number;
  };
}

export interface WorkspaceMailConversationAnswer {
  conversation: WorkspaceMailConversation;
}

/** POST api/mail/conversations/:messageId/(archive|unarchive|trash|restore) —
 *  the conversation as it now stands, and where each of its messages is. */
export interface WorkspaceMailConversationMoveAnswer {
  conversation: WorkspaceMailConversationSummary;
  messages: Array<{ id: string; place?: WorkspaceMailPlace; movedBy?: string; spamWhy?: 'suspicious' | 'blocked' | 'marked' }>;
}

// ── Stars (note #666) ──────────────────────────────────────────────────────

/**
 * POST api/mail/messages/:id/(star|unstar) — one letter — and
 * POST api/mail/conversations/:id/(star|unstar) — a conversation's row, which
 * stars the newest letter in it that arrived (else the newest the reader
 * sent), outside Trash and Spam, and unstars all of it.
 *
 * Either way the answer is the conversation as it now stands and every letter
 * in it, so the screen can redraw each row and letter the star touched from
 * the server's word rather than from the tap.
 */
export interface WorkspaceMailStarAnswer {
  conversation: WorkspaceMailConversationSummary;
  messages: WorkspaceMailMessageSummary[];
}

// ── Spam and blocked senders (slice 13) ────────────────────────────────────

/**
 * The senders this person has blocked, lowercased and sorted — the answer to
 * GET api/mail/blocked-senders and to DELETE api/mail/blocked-senders/:address.
 * Blocking is offered on a letter that sender wrote, exactly where the picture
 * allowlist is, and the way back is on every letter of theirs.
 */
export interface WorkspaceMailBlockedSendersAnswer {
  addresses: string[];
}

/** POST api/mail/blocked-senders — the list, and how many of that sender's
 *  letters left the inbox and the archive for Spam with the decision. */
export interface WorkspaceMailBlockAnswer extends WorkspaceMailBlockedSendersAnswer {
  moved: number;
}

// ── Pictures in letters (slice 10) ─────────────────────────────────────────

/**
 * The senders whose pictures this person has asked to have loaded, lowercased
 * and sorted. There is deliberately no "always load pictures" of the general
 * kind: the list is the whole feature, and an address is put on it one at a
 * time from a letter that sender wrote.
 *
 * GET api/mail/image-senders, and the answer to POST and DELETE alike, so a
 * screen never has to guess what the list now holds.
 */
export interface WorkspaceMailImageSendersAnswer {
  addresses: string[];
}
