import { randomBytes } from 'node:crypto';
import type { MailboxStorage } from './mailbox-storage.js';
import type { MailAttachmentRecord, MailMessageDocument, MailMessageStorage, MailPartyRef } from './mail-message-storage.js';
import { MailSendError, type MailSender, type OutboundMailFile } from './mail-sender.js';
import type { MediaStorage } from './media-storage.js';
import { MAIL_DOMAIN, MAIL_MAX_CC, mailOutFileRefusal, mailOutFilesRefusal } from '../shared/workspace-mail.js';
import { outreachMailHtml } from '../shared/outreach.js';
import { MAIL_REFS_KEPT } from './mail-threads.js';
import { mailPlaceOf } from './mail-places.js';
import { mailStoragePrefix } from './mail-ingest.js';

/**
 * Everything this platform SENDS on a person's behalf (note #509, slices 4
 * and 5): answering a message, and writing a new one.
 *
 * Replying stays the safe shape it always had — the recipient is never taken
 * from the request, it is READ OFF the message being answered, from its
 * Reply-To or its From — so there is still no way to aim a reply at somebody
 * who never wrote.
 *
 * Writing a NEW message does take a recipient from the request, which is the
 * thing slice 4 deliberately would not do, and Saddam asked for it on
 * 2026-09-15. That decision has to be paid for in brakes rather than in
 * hope, because a free address on this domain that can reach strangers is
 * exactly what a spammer wants one for — and the domain it would burn is the
 * one our own sign-in links are sent from:
 *
 *   - `MAIL_NEW_PER_HOUR` / `MAIL_NEW_PER_DAY` cold messages, counted off
 *     the stored rows rather than a counter in memory that a deploy would
 *     reset — and counted separately from replies, so answering your mail all
 *     afternoon never spends the allowance for reaching strangers;
 *   - FOUR people per message at most (slice 12): one To and up to three Cc,
 *     one box each, no Bcc, no list. The ceilings stay per MESSAGE — a Cc
 *     does not multiply them — which is exactly why the reach of one message
 *     is capped: a blast still has to be sent a few at a time;
 *   - plain words, with up to five files (10 MB each, 15 MB together) since
 *     slice 12, none of a kind the provider refuses to carry.
 *
 * FORWARDING (slice 12) is writing to somebody new with a letter under your
 * words, so it spends the NEW allowance, not the reply one: it reaches
 * somebody who has not written. And a reply whose Cc names somebody the
 * letter it answers was not addressed to reaches somebody new in exactly the
 * same way, so it spends the NEW allowance as well as the reply one (see
 * `replyReachesNew`) — otherwise three typed Cc boxes on twenty replies an
 * hour would be sixty strangers an hour through a door meant for answering.
 *
 * What is NOT here, and is the honest gap: nothing about the AGE or standing
 * of the account. A signup minted a minute ago may write its first cold
 * message immediately, within those ceilings.
 *
 * The sent copy is stored like any other message, with `direction: 'sent'`.
 * A reply also carries the id of the message it answers, so it reads UNDER
 * that message; a new message answers nothing and is therefore a row of its
 * own in the list.
 */

/** How many replies one person may send in a rolling hour. Generous for a
 *  person answering their mail, useless to anybody with other intentions. */
export const MAIL_REPLIES_PER_HOUR = 20;
/**
 * How many NEW messages — to people who have not written first — one person
 * may send. Tighter than replies and on two clocks, because these are the
 * only ones a stranger can receive: an hour's ceiling stops a burst, and the
 * day's stops a patient one running all night under it.
 */
export const MAIL_NEW_PER_HOUR = 10;
export const MAIL_NEW_PER_DAY = 30;

/**
 * The ceilings one send is held to. Every door of the mail screens and the
 * agents' mail verbs uses `MAIL_ALLOWANCE`; a caller that is itself a narrower
 * door may pass a wider one — today only Outreach (note #1111), whose sends
 * leave only on the platform operator's own press on his own site. The count
 * is always everything the person sent: a wider allowance raises the
 * ceiling, it never stops the cold letters being counted.
 */
export interface MailAllowance {
  newPerHour: number;
  newPerDay: number;
  repliesPerHour: number;
}
export const MAIL_ALLOWANCE: MailAllowance = { newPerHour: MAIL_NEW_PER_HOUR, newPerDay: MAIL_NEW_PER_DAY, repliesPerHour: MAIL_REPLIES_PER_HOUR };
/** The longest message we will send. The words; files are counted apart. */
export const MAIL_REPLY_MAX_CHARS = 20_000;
/** The longest subject we will send. Longer than any mail client shows. */
export const MAIL_SUBJECT_MAX_CHARS = 200;

/**
 * An address we are willing to hand a mail provider, read STRICTLY: one
 * address, no display name, no comma. The strictness is the point — a field
 * that quietly accepted `a@b, c@d` would turn the one-recipient rule into a
 * suggestion, and everything else here rests on it.
 */
const ONE_ADDRESS = /^[^\s@,<>()[\]\\;:]+@[^\s@,<>()[\]\\;:.]+(?:\.[^\s@,<>()[\]\\;:.]+)+$/;

export function readOneRecipient(value: unknown): string | null {
  const wanted = String(value ?? '').trim();
  return ONE_ADDRESS.test(wanted) ? wanted : null;
}

/** Which agent is writing, when it is not the person themselves. */
export interface SentByAgent { agentId: string; name?: string }

export type MailOutboxErrorCode =
  | 'no_such_message'
  | 'not_replyable'
  | 'empty_reply'
  | 'too_long'
  | 'too_many'
  | 'send_failed'
  /** The recipient is not one address we can send to. */
  | 'bad_recipient'
  /** Writing to your own address: a loop, not a message. */
  | 'self_recipient'
  /** This account has no address of its own to send from. */
  | 'no_mailbox'
  /** More people than one message may reach (slice 12). */
  | 'too_many_recipients'
  /** A file that cannot go: too big, too many, hidden, or a refused kind. */
  | 'bad_file'
  /** Files were asked for and this backend has nowhere to keep them. */
  | 'files_unavailable'
  /** A forward of a letter that is in Trash, or not this person's. */
  | 'not_forwardable';

export class MailOutboxError extends Error {
  constructor(readonly code: MailOutboxErrorCode, message: string) {
    super(message);
    this.name = 'MailOutboxError';
  }
}

/** `Re: ` once, however many times it has been round. */
export function replySubject(subject: string): string {
  const trimmed = (subject ?? '').trim();
  if (!trimmed) return 'Re: (no subject)';
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/**
 * Who a reply goes to: what the sender ASKED replies to go to, else who it
 * came from. Never the envelope sender — that is a bounce address, and
 * writing to it reaches a machine.
 */
export function replyRecipient(message: MailMessageDocument): MailPartyRef | null {
  const wanted = message.replyTo?.[0] ?? message.from ?? null;
  if (!wanted?.address?.includes('@')) return null;
  // Our own address is not a correspondent: answering it would post a message
  // straight back into this inbox, which is a loop, not a reply.
  if (wanted.address.toLowerCase() === message.address.toLowerCase()) return null;
  return wanted;
}

/**
 * The reply as it goes out: the person's words, then the message they are
 * answering, quoted the way every mail client quotes it — because a reply
 * arriving with no context is the one thing everybody complains about.
 */
export function replyBody(text: string, message: MailMessageDocument): string {
  const said = text.replace(/\s+$/, '');
  const who = message.from?.name?.trim() || message.from?.address || 'they';
  const when = message.sentAt ?? message.receivedAt;
  const on = new Date(when);
  const stamp = Number.isNaN(on.getTime()) ? '' : `On ${on.toUTCString()}, `;
  const quoted = (message.text ?? message.snippet ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(0, 200)
    .map((line) => `> ${line}`.replace(/\s+$/, ''))
    .join('\n');
  if (!quoted.trim()) return `${said}\n`;
  return `${said}\n\n${stamp}${who} wrote:\n${quoted}\n`;
}

/**
 * The References a reply carries (RFC 5322 §3.6.4): what the message it
 * answers followed, then that message itself — so every client the answer
 * reaches, ours included, can put it in the whole conversation and not only
 * under the one letter it answers (slice 8). A message that carried no
 * References but answered one gives that instead. The nearest
 * `MAIL_REFS_KEPT` are kept: a long thread's middle is the part to lose.
 */
export function replyReferences(message: Pick<MailMessageDocument, 'messageId' | 'inReplyTo' | 'references'>): string[] {
  const before = message.references?.length ? message.references : message.inReplyTo ? [message.inReplyTo] : [];
  const chain = [...before.filter((ref) => ref !== message.messageId), ...(message.messageId ? [message.messageId] : [])];
  return chain.filter((ref, at) => chain.indexOf(ref) === at).slice(-MAIL_REFS_KEPT);
}

/** `Fwd: ` once, however many times it has been passed on. */
export function forwardSubject(subject: string): string {
  const trimmed = (subject ?? '').trim();
  if (!trimmed) return 'Fwd: (no subject)';
  return /^(fwd?|fw)\s*:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`;
}

/** Words out of a letter that only came as markup, one block per line — the
 *  forward is plain text, and a letter flattened onto one line is unreadable. */
export function mailTextFromHtml(html: string): string {
  return String(html ?? '')
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(p|div|br|tr|li|h[1-6]|table|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((line) => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const partyLine = (party: MailPartyRef): string => (
  party.name?.trim() ? `${party.name.trim()} <${party.address}>` : party.address
);

/**
 * A forward as it goes out: the person's words, then the letter, introduced
 * the way every mail client introduces one — who it was from, when, what it
 * was called and who it was to — and then its words as text. A letter that
 * came only as markup is forwarded as its words; a letter longer than what is
 * kept here says so rather than stopping mid-sentence without a word.
 */
export function forwardBody(text: string, message: MailMessageDocument): string {
  const said = String(text ?? '').replace(/\s+$/, '');
  const on = new Date(message.sentAt ?? message.receivedAt);
  const lines = [
    '---------- Forwarded message ---------',
    ...(message.from?.address ? [`From: ${partyLine(message.from)}`] : []),
    ...(Number.isNaN(on.getTime()) ? [] : [`Date: ${on.toUTCString()}`]),
    `Subject: ${message.subject?.trim() || '(no subject)'}`,
    ...(message.to?.length ? [`To: ${message.to.map(partyLine).join(', ')}`] : []),
    ...(message.cc?.length ? [`Cc: ${message.cc.map(partyLine).join(', ')}`] : []),
  ];
  const words = (message.text?.trim() ? message.text : message.html ? mailTextFromHtml(message.html) : message.snippet ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '');
  const cut = message.bodyTruncated ? '\n\n[This letter was longer than what is kept here; the rest of it was not forwarded.]' : '';
  return `${said ? `${said}\n\n` : ''}${lines.join('\n')}\n\n${words}${cut}\n`;
}

/**
 * REPLY TO ALL (slice 12): everybody else the answered letter was addressed
 * to — its To and its Cc, minus this address and minus the person the reply
 * goes to — in the order the letter named them. At most `MAIL_MAX_CC`: the
 * rest are counted, not added, because a message here is never a list.
 */
export function replyAll(message: MailMessageDocument, to: MailPartyRef): { all: MailPartyRef[]; leftOut: number } {
  const skip = new Set([message.address.toLowerCase(), to.address.toLowerCase()]);
  const everybody: MailPartyRef[] = [];
  for (const party of [...(message.to ?? []), ...(message.cc ?? [])]) {
    const key = party.address?.toLowerCase();
    if (!key?.includes('@') || skip.has(key) || !readOneRecipient(party.address)) continue;
    skip.add(key);
    everybody.push(party.name?.trim() ? { address: party.address, name: party.name.trim() } : { address: party.address });
  }
  return { all: everybody.slice(0, MAIL_MAX_CC), leftOut: Math.max(0, everybody.length - MAIL_MAX_CC) };
}

/**
 * Does this reply's Cc reach somebody the answered letter was NOT addressed
 * to? Then it reaches somebody who has not written, exactly as a forward or a
 * new message does, and it spends the NEW allowance as well as the reply one.
 * Answering everybody a letter was already sent to — reply to all — does not.
 */
export function replyReachesNew(message: MailMessageDocument, cc: MailPartyRef[]): boolean {
  const on = new Set(
    [message.from, ...(message.replyTo ?? []), ...(message.to ?? []), ...(message.cc ?? [])]
      .map((party) => party?.address?.toLowerCase())
      .filter((address): address is string => Boolean(address)),
  );
  return cc.some((party) => !on.has(party.address.toLowerCase()));
}

/** A file as the request brought it: its bytes, not yet kept anywhere. */
export interface MailFileUpload {
  fileName: string;
  contentType?: string;
  data: Uint8Array;
}

/**
 * The name a file that goes out is kept and sent under. Control characters
 * and path separators go (it becomes part of a storage key and of a header
 * a stranger's client reads); a leading dot does NOT quietly go — it is
 * refused by `mailOutFileRefusal`, because `.env` is what nobody means to send.
 */
export function outgoingFileName(name: string): string {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\]/g, '-')
    .trim()
    .slice(0, 120);
}

const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export interface MailOutboxDeps {
  mailboxes: MailboxStorage;
  messages: MailMessageStorage;
  sender: MailSender;
  /** Where files that leave with a message are kept (slice 12). */
  media?: MediaStorage;
  now?: () => Date;
}

/** The immutable facts an agent's chat card shows before anything is sent. */
export interface MailSendPreview {
  from: string;
  to: MailPartyRef;
  /** Everybody else it goes to; empty when nobody (slice 12). */
  cc: MailPartyRef[];
  subject: string;
  /** The words. For a forward, everything that goes out: the words and the
   *  letter under them, because that is what the owner is letting leave. */
  text: string;
  /** Every file that leaves with it, in order (slice 12). */
  files: Array<{ fileName: string; size: number; contentType: string }>;
  /** A reply whose Cc reaches somebody new; it spent the NEW allowance too. */
  reachesNew?: boolean;
}

/** What a message carries besides its words (slice 12). */
export interface MailExtras {
  /** The Cc line: addresses, one per box. Empty boxes are nothing. */
  cc?: unknown;
  /** Files the request brought, not yet kept anywhere. */
  files?: MailFileUpload[];
  /**
   * Files ALREADY kept — an approval request's, staged when it was made, or
   * a forward's own. Their records are ours, never the request's: a caller
   * outside this service can only name a forwarded letter's files by id.
   */
  staged?: MailAttachmentRecord[];
}

export class MailOutboxService {
  private readonly now: () => Date;

  constructor(private readonly deps: MailOutboxDeps, now?: () => Date) {
    this.now = now ?? deps.now ?? (() => new Date());
  }

  /** The words, checked the same way for every kind of message. A forward
   *  may go with none: the letter under them is what is being sent. */
  private words(text: unknown, what: 'message' | 'reply' | 'forward'): string {
    const said = String(text ?? '').trim();
    if (!said && what !== 'forward') throw new MailOutboxError('empty_reply', 'Write something first.');
    if (said.length > MAIL_REPLY_MAX_CHARS) {
      const noun = what === 'reply' ? 'A reply' : 'A message';
      throw new MailOutboxError('too_long', `${noun} is at most ${MAIL_REPLY_MAX_CHARS.toLocaleString()} characters.`);
    }
    return said;
  }

  /**
   * The Cc line (slice 12), read as strictly as the To box: one address per
   * box, no display name, no comma. An empty box is nothing and a repeat of
   * somebody already on the message is dropped; more than `MAIL_MAX_CC` is
   * refused, never trimmed — a person should not learn from the recipient
   * that one of their boxes was quietly left off.
   */
  private readCc(value: unknown, own: string, already: string[]): MailPartyRef[] {
    const boxes = (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
      .map((box) => String(box ?? '').trim())
      .filter(Boolean);
    const seen = new Set(already.map((address) => address.toLowerCase()));
    const cc: MailPartyRef[] = [];
    for (const box of boxes) {
      const address = readOneRecipient(box);
      if (!address) throw new MailOutboxError('bad_recipient', `${box.slice(0, 80)} is not one email address. Put one address in each Cc box.`);
      const key = address.toLowerCase();
      if (key === own.toLowerCase()) throw new MailOutboxError('self_recipient', 'That is your own address.');
      if (seen.has(key)) continue;
      seen.add(key);
      cc.push({ address });
    }
    if (cc.length > MAIL_MAX_CC) {
      throw new MailOutboxError('too_many_recipients', `A message reaches four people at most: one To and up to ${MAIL_MAX_CC} Cc.`);
    }
    return cc;
  }

  /** Every file that would leave, checked together before anything is
   *  counted, kept or sent. */
  private readFiles(extras: MailExtras): MailSendPreview['files'] {
    const files = [
      ...(extras.staged ?? []).map((file) => ({ fileName: file.fileName, size: file.size, contentType: file.contentType })),
      ...(extras.files ?? []).map((file) => ({
        fileName: outgoingFileName(file.fileName),
        size: file.data.byteLength,
        contentType: CONTENT_TYPE.test(file.contentType ?? '') ? file.contentType! : 'application/octet-stream',
      })),
    ];
    const refusal = mailOutFilesRefusal(files);
    if (refusal) throw new MailOutboxError('bad_file', refusal);
    if (files.length && !this.deps.media) {
      throw new MailOutboxError('files_unavailable', 'Files cannot be sent from this backend yet. Send the words on their own.');
    }
    return files;
  }

  /** The NEW allowance: `MAIL_NEW_PER_HOUR` and `MAIL_NEW_PER_DAY` (or a
   *  narrower door's own, see `MailAllowance`), off the stored rows. */
  private async checkNewCeilings(userId: string, allowance: MailAllowance = MAIL_ALLOWANCE): Promise<void> {
    const now = this.now().getTime();
    const hourAgo = new Date(now - 60 * 60_000).toISOString();
    if (await this.deps.messages.countNewSince(userId, hourAgo) >= allowance.newPerHour) {
      throw new MailOutboxError('too_many', `You can start ${allowance.newPerHour} new messages an hour. Try again shortly.`);
    }
    const dayAgo = new Date(now - 24 * 60 * 60_000).toISOString();
    if (await this.deps.messages.countNewSince(userId, dayAgo) >= allowance.newPerDay) {
      throw new MailOutboxError('too_many', `You can start ${allowance.newPerDay} new messages a day. Replies are not counted.`);
    }
  }

  /** Validate a new message exactly as send() will, without contacting the provider. */
  async previewSend(args: {
    userId: string; to: unknown; subject: unknown; text: string; allowance?: MailAllowance;
  } & MailExtras): Promise<MailSendPreview> {
    const said = this.words(args.text, 'message');
    const recipient = readOneRecipient(args.to);
    if (!recipient) throw new MailOutboxError('bad_recipient', 'Write one email address to send this to.');
    const mailbox = await this.deps.mailboxes.getByUser(args.userId);
    if (!mailbox) throw new MailOutboxError('no_mailbox', 'This account has no address to send from.');
    if (recipient.toLowerCase() === mailbox.address.toLowerCase()) {
      throw new MailOutboxError('self_recipient', 'That is your own address.');
    }
    const cc = this.readCc(args.cc, mailbox.address, [recipient]);
    const files = this.readFiles(args);
    await this.checkNewCeilings(args.userId, args.allowance);
    return {
      from: mailbox.address,
      to: { address: recipient },
      cc,
      subject: String(args.subject ?? '').trim().slice(0, MAIL_SUBJECT_MAX_CHARS),
      text: said,
      files,
    };
  }

  /** Validate a reply and resolve its un-aimable recipient, without sending. */
  async previewReply(args: {
    userId: string; messageId: string; text: string;
  } & MailExtras): Promise<MailSendPreview> {
    const said = this.words(args.text, 'reply');
    const message = await this.deps.messages.get(args.userId, args.messageId);
    if (!message || (message.direction ?? 'in') !== 'in') {
      throw new MailOutboxError('no_such_message', 'No such message.');
    }
    const recipient = replyRecipient(message);
    if (!recipient) throw new MailOutboxError('not_replyable', 'This message has no address to reply to.');
    const mailbox = await this.deps.mailboxes.getByUser(args.userId);
    if (!mailbox) throw new MailOutboxError('no_mailbox', 'This account has no address to send from.');
    const cc = this.readCc(args.cc, mailbox.address, [recipient.address]);
    const files = this.readFiles(args);
    const hourAgo = new Date(this.now().getTime() - 60 * 60_000).toISOString();
    if (await this.deps.messages.countSentSince(args.userId, hourAgo) >= MAIL_REPLIES_PER_HOUR) {
      throw new MailOutboxError('too_many', `You can send ${MAIL_REPLIES_PER_HOUR} replies an hour. Try again shortly.`);
    }
    const reachesNew = replyReachesNew(message, cc);
    if (reachesNew) await this.checkNewCeilings(args.userId);
    return {
      from: mailbox.address,
      to: recipient,
      cc,
      subject: replySubject(message.subject),
      text: said,
      files,
      ...(reachesNew ? { reachesNew: true } : {}),
    };
  }

  /**
   * The letter a forward passes on, and the files of it that go too. Any
   * letter of this person's that is not in Trash — one that arrived or one
   * they sent — because Trash is where a letter was put so as NOT to be
   * dealt with, and a Reply is not offered from there either. `carry` names
   * the letter's own files by id; absent means every one of them that CAN go,
   * which is what a forward does unless somebody unticks a file — and what
   * the screen shows ticked. A kind the provider refuses is left off by
   * default (the card lists what does leave) and refused when named.
   */
  private async forwarded(userId: string, messageId: string, carry: unknown): Promise<{
    message: MailMessageDocument; carried: MailAttachmentRecord[];
  }> {
    const message = await this.deps.messages.get(userId, messageId);
    if (!message) throw new MailOutboxError('no_such_message', 'No such message.');
    if (mailPlaceOf(message) === 'trash') {
      throw new MailOutboxError('not_forwardable', 'That letter is in Trash. Restore it first to forward it.');
    }
    const own = message.attachments ?? [];
    if (carry === undefined || carry === null) {
      return { message, carried: own.filter((file) => !mailOutFileRefusal({ fileName: file.fileName, size: file.size })) };
    }
    if (!Array.isArray(carry)) throw new MailOutboxError('bad_file', 'Say which of the letter\'s files go with it.');
    const wanted = carry.map((id) => String(id ?? ''));
    const carried: MailAttachmentRecord[] = [];
    for (const id of wanted) {
      const file = own.find((entry) => entry.id === id);
      if (!file) throw new MailOutboxError('bad_file', 'That file is not on the letter being forwarded.');
      if (!carried.includes(file)) carried.push(file);
    }
    return { message, carried };
  }

  /** Validate a forward exactly as forward() will, without sending. */
  async previewForward(args: {
    userId: string; messageId: string; to: unknown; text: string; carry?: unknown;
  } & MailExtras): Promise<MailSendPreview & { carried: MailAttachmentRecord[] }> {
    const said = this.words(args.text, 'forward');
    const recipient = readOneRecipient(args.to);
    if (!recipient) throw new MailOutboxError('bad_recipient', 'Write one email address to forward this to.');
    const mailbox = await this.deps.mailboxes.getByUser(args.userId);
    if (!mailbox) throw new MailOutboxError('no_mailbox', 'This account has no address to send from.');
    if (recipient.toLowerCase() === mailbox.address.toLowerCase()) {
      throw new MailOutboxError('self_recipient', 'That is your own address.');
    }
    // An approval request's files were chosen and kept when it was made, so
    // they arrive as `staged`; the letter is still read, and still refused
    // if it has been put in Trash since.
    const { message, carried } = await this.forwarded(args.userId, args.messageId, args.staged ? [] : args.carry);
    const cc = this.readCc(args.cc, mailbox.address, [recipient]);
    const files = this.readFiles({ ...args, staged: [...carried, ...(args.staged ?? [])] });
    // A forward reaches somebody who has not written: the NEW allowance.
    await this.checkNewCeilings(args.userId);
    return {
      from: mailbox.address,
      to: { address: recipient },
      cc,
      subject: forwardSubject(message.subject),
      text: forwardBody(said, message),
      files,
      carried,
    };
  }

  /**
   * Keep files that leave with a message (slice 12) under that message's own
   * prefix — the same place an arrived letter's files are kept — so a sent
   * row points at them exactly as an arrived one does. An approval request
   * stages its files here under the id the message WILL have, which is what
   * makes them that message's files the moment it is sent.
   */
  async stageFiles(userId: string, messageKey: string, files: MailFileUpload[]): Promise<MailAttachmentRecord[]> {
    if (!files.length) return [];
    const media = this.deps.media;
    if (!media) throw new MailOutboxError('files_unavailable', 'Files cannot be sent from this backend yet. Send the words on their own.');
    const prefix = mailStoragePrefix(userId, messageKey);
    const kept: MailAttachmentRecord[] = [];
    try {
      for (const file of files) {
        const id = `ma_${randomBytes(9).toString('hex')}`;
        const fileName = outgoingFileName(file.fileName);
        const contentType = CONTENT_TYPE.test(file.contentType ?? '') ? file.contentType! : 'application/octet-stream';
        const storagePath = `${prefix}${id}/${fileName}`;
        await media.uploadObject({ storagePath, contentType, data: file.data });
        kept.push({ id, fileName, contentType, size: file.data.byteLength, storagePath });
      }
    } catch (error) {
      await this.dropStaged(userId, messageKey);
      throw new MailOutboxError('files_unavailable', `The files could not be kept: ${error instanceof Error ? error.message.slice(0, 120) : 'storage refused them'}.`);
    }
    return kept;
  }

  /** Throw away what `stageFiles` kept for a message that will not go. Only
   *  that message's own prefix — never a forwarded letter's files, which are
   *  under the letter's. Best effort: an orphan is harmless. */
  async dropStaged(userId: string, messageKey: string): Promise<void> {
    await this.deps.media?.deleteObjectsWithPrefix?.({ prefix: mailStoragePrefix(userId, messageKey) }).catch(() => { /* orphan */ });
  }

  /**
   * THE ONE WAY OUT, for all three kinds (slice 12): keep the request's files,
   * read every file's bytes, hand the whole message to the provider once, and
   * only then store the row. Nothing is stored for a message the provider
   * refused — a "sent" row nobody received is the worst of all records — and
   * the files this attempt kept are thrown away with it. Files an approval
   * staged stay: the request reopens and may be tried again.
   */
  private async deliver(args: {
    userId: string;
    id: string;
    messageId: string;
    preview: MailSendPreview;
    senderName?: string;
    body: string;
    extras: MailExtras;
    threading?: { inReplyTo?: string; references?: string[] };
    /** Send an HTML copy of the same words beside the text (Outreach, note #1112). */
    withHtml?: boolean;
    failure: string;
    row: (sent: Pick<MailMessageDocument, 'from' | 'to' | 'cc' | 'attachments'>) => MailMessageDocument;
  }): Promise<MailMessageDocument> {
    const { preview } = args;
    const staged = args.extras.staged ?? [];
    const fresh = args.extras.files ?? [];
    const kept = await this.stageFiles(args.userId, args.id, fresh);
    const records: MailAttachmentRecord[] = [...staged, ...kept].map((file) => ({
      id: file.id,
      fileName: file.fileName,
      contentType: file.contentType,
      size: file.size,
      storagePath: file.storagePath,
    }));
    const from = { address: preview.from, ...(args.senderName?.trim() ? { name: args.senderName.trim() } : {}) };
    let providerId: string | undefined;
    try {
      const attachments: OutboundMailFile[] = [];
      for (const [at, file] of records.entries()) {
        const data = at >= staged.length
          ? fresh[at - staged.length]!.data
          : await this.deps.media!.downloadObject({ storagePath: file.storagePath });
        attachments.push({ fileName: file.fileName, contentType: file.contentType, data });
      }
      const accepted = await this.deps.sender.send({
        from,
        to: [{ address: preview.to.address, ...(preview.to.name ? { name: preview.to.name } : {}) }],
        ...(preview.cc.length ? { cc: preview.cc } : {}),
        subject: preview.subject || '(no subject)',
        text: args.body,
        ...(args.withHtml ? { html: outreachMailHtml(args.body) } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(args.threading?.inReplyTo ? { inReplyTo: args.threading.inReplyTo } : {}),
        ...(args.threading?.references?.length ? { references: args.threading.references } : {}),
        // The message id is the key, and the key names this whole payload —
        // see `idempotencyKey`: the same message sent twice (a double tap, a
        // retried approval) is one message at the provider.
        idempotencyKey: args.messageId,
      });
      providerId = accepted?.providerId;
    } catch (error) {
      if (kept.length) await this.dropStaged(args.userId, args.id);
      if (error instanceof MailOutboxError) throw error;
      throw new MailSendError(error instanceof Error ? error.message : args.failure);
    }
    const sent = { ...args.row({ from, to: [preview.to], cc: preview.cc, attachments: records }), ...(providerId ? { providerId } : {}) };
    await this.deps.messages.store(sent);
    return sent;
  }

  private mint(outboundId?: string): { id: string; messageId: string } {
    const id = outboundId ?? `mm_${randomBytes(9).toString('hex')}`;
    return {
      id,
      messageId: outboundId ? `${id}@${MAIL_DOMAIN}` : `${id}.${Date.now().toString(36)}@${MAIL_DOMAIN}`,
    };
  }

  /** An approval retried after the provider took it: the stored row is the
   *  answer, never a second message. */
  private async alreadySent(userId: string, outboundId?: string): Promise<MailMessageDocument | null> {
    if (!outboundId) return null;
    const existing = await this.deps.messages.get(userId, outboundId);
    return existing?.direction === 'sent' ? existing : null;
  }

  /**
   * Write to somebody who has not written first (slice 5).
   *
   * The order of the checks is deliberate: everything free is decided before
   * anything is counted, and the ceilings are read last — so a person who
   * mistypes an address does not spend an hour's allowance learning it.
   */
  async send(args: {
    userId: string; to: unknown; subject: unknown; text: string; senderName?: string; sentBy?: SentByAgent;
    /** Stable provider/message id supplied by an approval request. */
    outboundId?: string;
    /** A narrower door's own ceilings (Outreach, note #1111); the mail screens never pass one. */
    allowance?: MailAllowance;
    /** An HTML copy of the same words beside the text: Outreach only (note #1112). */
    withHtml?: boolean;
  } & MailExtras): Promise<MailMessageDocument> {
    const existing = await this.alreadySent(args.userId, args.outboundId);
    if (existing) return existing;
    const preview = await this.previewSend(args);
    const { id, messageId } = this.mint(args.outboundId);
    // The words as written, with nothing appended: there is no conversation
    // to quote under a message that starts one.
    const body = `${preview.text}\n`;
    return this.deliver({
      userId: args.userId, id, messageId, preview, body, extras: args,
      ...(args.senderName ? { senderName: args.senderName } : {}),
      ...(args.withHtml ? { withHtml: true } : {}),
      failure: 'The message could not be sent.',
      row: (sent) => ({
        id,
        direction: 'sent',
        ...(args.sentBy ? { sentBy: args.sentBy } : {}),
        userId: args.userId,
        address: preview.from,
        envelopeFrom: preview.from,
        receivedAt: this.now().toISOString(),
        messageId,
        ...sent,
        replyTo: [],
        subject: preview.subject,
        snippet: preview.text.replace(/\s+/g, ' ').slice(0, 200),
        text: body,
        wrote: preview.text,
        raw: { storagePath: '', size: Buffer.byteLength(body, 'utf8') },
      }),
    });
  }

  /** Answer one message. Everything about WHO it goes to is decided here —
   *  except the Cc line, which is the person's (slice 12). */
  async reply(args: {
    userId: string; messageId: string; text: string; senderName?: string; sentBy?: SentByAgent;
    /** Stable provider/message id supplied by an approval request. */
    outboundId?: string;
  } & MailExtras): Promise<MailMessageDocument> {
    const existing = await this.alreadySent(args.userId, args.outboundId);
    if (existing) return existing;
    const preview = await this.previewReply(args);
    const message = await this.deps.messages.get(args.userId, args.messageId);
    // previewReply already proved this exact row and recipient. It is read a
    // second time only for the quoted body and threading headers; messages
    // are immutable, so the facts cannot move between the two reads.
    if (!message) throw new MailOutboxError('no_such_message', 'No such message.');
    const { id, messageId } = this.mint(args.outboundId);
    const body = replyBody(preview.text, message);
    const references = replyReferences(message);
    return this.deliver({
      userId: args.userId, id, messageId, preview, body, extras: args,
      ...(args.senderName ? { senderName: args.senderName } : {}),
      threading: { ...(message.messageId ? { inReplyTo: message.messageId } : {}), references },
      failure: 'The reply could not be sent.',
      row: (sent) => ({
        id,
        direction: 'sent',
        answers: message.id,
        ...(preview.reachesNew ? { reachesNew: true } : {}),
        ...(args.sentBy ? { sentBy: args.sentBy } : {}),
        userId: args.userId,
        address: preview.from,
        envelopeFrom: preview.from,
        receivedAt: this.now().toISOString(),
        messageId,
        ...(message.messageId ? { inReplyTo: message.messageId } : {}),
        ...(references.length ? { references } : {}),
        ...sent,
        replyTo: [],
        subject: preview.subject,
        snippet: preview.text.replace(/\s+/g, ' ').slice(0, 200),
        text: body,
        wrote: preview.text,
        // A reply has no raw copy of its own: we composed it, so the stored
        // text IS the message rather than something derived from bytes a
        // stranger sent. The field stays shaped like every other row's.
        raw: { storagePath: '', size: Buffer.byteLength(body, 'utf8') },
      }),
    });
  }

  /**
   * Write again in a thread THIS person started (note #1089, Outreach's day-4
   * and day-11 follow-ups): a reply to one of their own sent letters, to the
   * person that letter went to. `reply()` refuses our own outgoing copies on
   * purpose — answering one from the inbox would write to ourselves — so this
   * is its own door, and it keeps the same rule that matters: the recipient
   * is READ OFF the stored letter, never taken from the request. It reaches
   * nobody new, so it spends the reply allowance, and it carries the
   * threading headers so it lands under the first letter in their client and
   * in ours.
   */
  async followUp(args: {
    userId: string; messageId: string; text: string; senderName?: string; allowance?: MailAllowance; withHtml?: boolean;
  }): Promise<MailMessageDocument> {
    const said = this.words(args.text, 'reply');
    const message = await this.deps.messages.get(args.userId, args.messageId);
    if (!message || message.direction !== 'sent') throw new MailOutboxError('no_such_message', 'No such letter of yours.');
    const recipient = message.to?.[0];
    if (!recipient?.address?.includes('@')) throw new MailOutboxError('not_replyable', 'That letter has nobody to write to again.');
    const mailbox = await this.deps.mailboxes.getByUser(args.userId);
    if (!mailbox) throw new MailOutboxError('no_mailbox', 'This account has no address to send from.');
    if (recipient.address.toLowerCase() === mailbox.address.toLowerCase()) throw new MailOutboxError('self_recipient', 'That is your own address.');
    const hourAgo = new Date(this.now().getTime() - 60 * 60_000).toISOString();
    const repliesPerHour = (args.allowance ?? MAIL_ALLOWANCE).repliesPerHour;
    if (await this.deps.messages.countSentSince(args.userId, hourAgo) >= repliesPerHour) {
      throw new MailOutboxError('too_many', `You can send ${repliesPerHour} replies an hour. Try again shortly.`);
    }
    const preview: MailSendPreview = {
      from: mailbox.address, to: { address: recipient.address }, cc: [], subject: replySubject(message.subject), text: said, files: [],
    };
    const { id, messageId } = this.mint();
    const body = replyBody(said, message);
    const references = replyReferences(message);
    return this.deliver({
      userId: args.userId, id, messageId, preview, body, extras: {},
      ...(args.senderName ? { senderName: args.senderName } : {}),
      threading: { ...(message.messageId ? { inReplyTo: message.messageId } : {}), references },
      ...(args.withHtml ? { withHtml: true } : {}),
      failure: 'The follow-up could not be sent.',
      row: (sent) => ({
        id,
        direction: 'sent',
        answers: message.id,
        userId: args.userId,
        address: preview.from,
        envelopeFrom: preview.from,
        receivedAt: this.now().toISOString(),
        messageId,
        ...(message.messageId ? { inReplyTo: message.messageId } : {}),
        ...(references.length ? { references } : {}),
        ...sent,
        replyTo: [],
        subject: preview.subject,
        snippet: said.replace(/\s+/g, ' ').slice(0, 200),
        text: body,
        wrote: said,
        raw: { storagePath: '', size: Buffer.byteLength(body, 'utf8') },
      }),
    });
  }

  /**
   * Pass a letter on to somebody (slice 12). A message of its own — it
   * answers nothing, carries no threading headers (its recipient never had
   * the conversation) and spends the NEW allowance — kept in the conversation
   * of the letter it forwards and filed where that letter is, so forwarding
   * from the archive does not bring a conversation back to the inbox.
   */
  async forward(args: {
    userId: string; messageId: string; to: unknown; text: string; carry?: unknown;
    senderName?: string; sentBy?: SentByAgent;
    /** Stable provider/message id supplied by an approval request. */
    outboundId?: string;
  } & MailExtras): Promise<MailMessageDocument> {
    const existing = await this.alreadySent(args.userId, args.outboundId);
    if (existing) return existing;
    const preview = await this.previewForward(args);
    const message = await this.deps.messages.get(args.userId, args.messageId);
    if (!message) throw new MailOutboxError('no_such_message', 'No such message.');
    const said = String(args.text ?? '').trim();
    const { id, messageId } = this.mint(args.outboundId);
    return this.deliver({
      userId: args.userId, id, messageId, preview, body: preview.text,
      extras: { ...args, staged: [...preview.carried, ...(args.staged ?? [])] },
      ...(args.senderName ? { senderName: args.senderName } : {}),
      failure: 'The forward could not be sent.',
      row: (sent) => ({
        id,
        direction: 'sent',
        forwards: message.id,
        ...(message.archivedAt ? { archivedAt: message.archivedAt } : {}),
        ...(args.sentBy ? { sentBy: args.sentBy } : {}),
        userId: args.userId,
        address: preview.from,
        envelopeFrom: preview.from,
        receivedAt: this.now().toISOString(),
        messageId,
        ...sent,
        replyTo: [],
        subject: preview.subject,
        snippet: (said || message.snippet || '').replace(/\s+/g, ' ').slice(0, 200),
        text: preview.text,
        wrote: said,
        raw: { storagePath: '', size: Buffer.byteLength(preview.text, 'utf8') },
      }),
    });
  }
}
