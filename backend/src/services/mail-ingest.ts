import { randomBytes } from 'node:crypto';
import PostalMime, { decodeWords, type Address, type Email, type Mailbox } from 'postal-mime';
import { isMailDomainAddress } from '../shared/workspace-mail.js';
import type { MailboxStorage } from './mailbox-storage.js';
import type { MediaStorage } from './media-storage.js';
import { readReferences } from './mail-threads.js';
import { replyRecipient } from './mail-outbox.js';
import { mailSenderKey } from './mail-pictures.js';
import type { MailArrival } from '../types/mail-arrival.js';
import type {
  MailAttachmentRecord,
  MailAuthenticationVerdict,
  MailMessageDocument,
  MailMessageStorage,
  MailPartyRef,
} from './mail-message-storage.js';

/**
 * Inbound mail (note #509, slice 2): the half that happens after Cloudflare's
 * Email Worker has handed us a message addressed to somebody here.
 *
 * Two rules shape everything below.
 *
 * ONE: the raw bytes are the message. Every field in the stored document is
 * something we *derived* from a MIME message a stranger wrote, so the raw
 * copy goes to media storage first and the parse is allowed to fail — a
 * message we cannot read is stored with the reason, never dropped.
 *
 * TWO: only an explicit answer bounces a sender. An address nobody holds is
 * refused in words (`unknown_address`), so whoever mistyped it finds out;
 * anything that is merely broken on our side throws, because a bounce is
 * permanent and an outage is not.
 */

/** Cloudflare Email Routing refuses anything larger before we see it. */
export const MAIL_MAX_BYTES = 25 * 1024 * 1024;
/** Body kept in the row itself; the whole of it always stays in the raw copy. */
export const MAIL_MAX_INLINE_TEXT = 128 * 1024;
export const MAIL_MAX_INLINE_HTML = 512 * 1024;
export const MAIL_MAX_ATTACHMENTS = 50;
const SNIPPET_LENGTH = 200;

export type MailIngestErrorCode = 'unknown_address' | 'too_large' | 'empty_message';

export class MailIngestError extends Error {
  constructor(readonly code: MailIngestErrorCode, message: string) {
    super(message);
    this.name = 'MailIngestError';
  }
}

export interface MailIngestResult {
  id: string;
  address: string;
  /** The same message, delivered twice. Success — the sender must not retry. */
  duplicate: boolean;
  /** Present when the MIME could not be read; the raw bytes are stored anyway. */
  parseError?: string;
}

/** Where one message's bytes live. Its own prefix, so a delete is one call. */
export function mailStoragePrefix(userId: string, messageId: string): string {
  return ['users', userId, 'mail', messageId, ''].join('/');
}

/** The envelope recipient, reduced to the address we look up. */
export function normalizeEnvelopeAddress(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  // A display name is not part of an envelope address, but a careless caller
  // can still send one: in `Adam <adam@…>` the address is the bracketed half,
  // so the brackets are read BEFORE they are stripped.
  const bracketed = trimmed.match(/<([^<>]*)>\s*$/);
  return (bracketed ? bracketed[1]! : trimmed).trim();
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('hex')}`;
}

function flattenAddresses(value: Address[] | Address | undefined): MailPartyRef[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((entry): MailPartyRef[] => {
    const group = (entry as { group?: Mailbox[] }).group;
    if (group) return flattenAddresses(group);
    const address = (entry as Mailbox).address?.trim();
    if (!address) return [];
    const name = (entry as Mailbox).name?.trim();
    return [{ address, ...(name ? { name } : {}) }];
  });
}

/** Tags out, whitespace collapsed: the one line a list row shows. */
export function mailSnippet(text: string | undefined, html: string | undefined): string {
  const source = text?.trim()
    || (html ? html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ') : '');
  const flat = source
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1)}…` : flat;
}

/**
 * What the domain's own filtering wrote about the sender. Cloudflare checks
 * SPF, DKIM and DMARC before the message reaches a Worker and records the
 * verdicts in `Authentication-Results`; we keep the three words and the
 * whole header, and let the screen decide how loudly to say so.
 */
export function readAuthentication(header: string | undefined): MailAuthenticationVerdict | undefined {
  if (!header) return undefined;
  const verdict = (method: string): string | undefined => {
    const found = new RegExp(`(?:^|[;\\s])${method}=([a-z]+)`, 'i').exec(header);
    return found ? found[1]!.toLowerCase() : undefined;
  };
  const value: MailAuthenticationVerdict = {
    ...(verdict('spf') ? { spf: verdict('spf') } : {}),
    ...(verdict('dkim') ? { dkim: verdict('dkim') } : {}),
    ...(verdict('dmarc') ? { dmarc: verdict('dmarc') } : {}),
    raw: header.slice(0, 1024),
  };
  return value;
}

/**
 * Nothing proved this came from where it says it did.
 *
 * Two cases, and the second one is the one that bites a mail service on its
 * own domain. A message claiming to be from OUR domain has to prove it with
 * DKIM — because `billing@agenticcloudcomputer.com` in a From line is
 * exactly what a phish would write, and it is the one sender our own readers
 * have no reason to doubt. The check cannot be delegated to the DMARC
 * verdict, because that verdict does not arrive: a forgery of our own domain
 * is stamped `dmarc=none` rather than `fail`, measured on 2026-09-14 under
 * `p=none` AND again on 2026-09-15 under `p=quarantine`, fifteen minutes
 * after the record changed and twice in a row. Tightening the zone tells
 * every OTHER receiver to bin a forgery; it does not change a word of what
 * reaches this function. Nobody else may claim to be us, whatever the
 * policy says.
 *
 * Everything from ANOTHER domain is judged by that domain's own rules: a
 * DMARC failure is a forgery, while an SPF failure with DKIM passing is an
 * ordinary forwarded message and is not marked.
 */
export function looksSuspicious(
  auth: MailAuthenticationVerdict | undefined,
  fromAddress?: string,
): boolean {
  if (isMailDomainAddress(fromAddress) && auth?.dkim !== 'pass') return true;
  if (!auth) return false;
  if (auth.dmarc === 'fail') return true;
  return auth.spf === 'fail' && auth.dkim !== 'pass';
}

/**
 * The last resort: when the MIME parser cannot read a message at all, this
 * reads its top headers so the row still says who it is from and what it is
 * about. Deliberately simple — unfold, split on the first colon — because it
 * runs exactly when the careful reader has already given up.
 */
export function scanHeaders(raw: Buffer): Map<string, string> {
  const text = raw.subarray(0, Math.min(raw.length, 256 * 1024)).toString('binary');
  const end = text.search(/\r?\n\r?\n/);
  const block = end === -1 ? text : text.slice(0, end);
  const headers = new Map<string, string>();
  for (const line of block.replace(/\r?\n[\t ]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(colon + 1).trim());
  }
  return headers;
}

/** `<abc@host>` → `abc@host`. Absent is legal; a Message-ID is not required. */
function bareMessageId(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^<|>$/g, '').trim();
  return trimmed ? trimmed.slice(0, 512) : undefined;
}

/** A name safe to put in a storage path and to hand a browser to save. */
export function safeAttachmentName(name: string | null | undefined, index: number): string {
  const cleaned = (name ?? '')
    // A sender chooses this string, and it ends up in a storage key and in a
    // Content-Disposition header: control characters and path separators have
    // no business in either.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\]/g, '-')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120) || `attachment-${index + 1}`;
}

function attachmentBytes(content: ArrayBuffer | Uint8Array | string, encoding?: string): Buffer {
  if (typeof content === 'string') return Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
  return Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content));
}

export interface MailIngestDeps {
  mailboxes: MailboxStorage;
  messages: MailMessageStorage;
  media: MediaStorage;
  now?: () => Date;
}

/**
 * Somebody who wants to be told that a letter landed (slice 11).
 *
 * Deliberately SYNCHRONOUS and returning nothing. This is called with
 * Cloudflare's Email Worker holding the SMTP transaction open, so nothing
 * downstream of it may make the sender wait — and nothing it does may become
 * an error, because an error here would be a bounce for a message that is
 * already safely stored.
 */
export interface MailArrivalWatcher {
  noteArrival(arrival: MailArrival, opts: { suspicious?: boolean }): void;
}

export class MailIngestService {
  private readonly now: () => Date;
  private watcher?: MailArrivalWatcher;

  constructor(private readonly deps: MailIngestDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Set after construction because the thing that wants telling needs the
   * agent service, which is built later than this is (see index.ts). One
   * watcher: there is one question being answered — did a letter arrive.
   */
  watchArrivals(watcher: MailArrivalWatcher): void {
    this.watcher = watcher;
  }

  /** Does anybody hold this address? The question the Worker asks before it
   *  spends a sender's bandwidth on 25 MiB nobody can receive. */
  async deliverable(address: unknown): Promise<{ address: string; deliverable: boolean }> {
    const normalized = normalizeEnvelopeAddress(address);
    if (!normalized) return { address: '', deliverable: false };
    const mailbox = await this.deps.mailboxes.getByAddress(normalized);
    return { address: normalized, deliverable: Boolean(mailbox) };
  }

  /** Take one message in. Throws `MailIngestError` for the two answers a
   *  sender is owed, and anything else for an outage the sender should
   *  retry into. */
  async accept(args: { to: unknown; from: unknown; raw: Buffer }): Promise<MailIngestResult> {
    const address = normalizeEnvelopeAddress(args.to);
    if (!args.raw?.length) throw new MailIngestError('empty_message', 'The message had no content.');
    if (args.raw.length > MAIL_MAX_BYTES) {
      throw new MailIngestError('too_large', 'The message is larger than this mailbox accepts.');
    }
    const mailbox = address ? await this.deps.mailboxes.getByAddress(address) : null;
    if (!mailbox) throw new MailIngestError('unknown_address', 'Nobody here holds that address.');

    const messageKey = id('mm');
    const prefix = mailStoragePrefix(mailbox.userId, messageKey);
    // The raw copy first, and not best-effort: it is the one thing that makes
    // every derived field below safe to get wrong. If it cannot be stored the
    // whole delivery fails and the sending server tries again.
    await this.deps.media.uploadObject({
      storagePath: `${prefix}raw.eml`,
      contentType: 'message/rfc822',
      data: args.raw,
    });

    let parsed: Email | null = null;
    let parseError: string | undefined;
    try {
      parsed = await PostalMime.parse(args.raw);
    } catch (error) {
      parseError = error instanceof Error ? error.message.slice(0, 300) : 'The message could not be read.';
    }

    const read = parsed
      ? await this.documentFromParsed({ parsed, mailbox, address, args, messageKey, prefix })
      : this.documentFromHeaders({ raw: args.raw, mailbox, address, args, messageKey, prefix, parseError: parseError! });
    // WHERE IT LANDS (slice 13). A letter nothing vouched for, or one from a
    // sender its owner blocked, is filed into Spam as it is stored — still
    // whole, still theirs, one tap from the inbox — rather than left in the
    // inbox with a warning on it. Decided here, in the one place a letter
    // comes in, so the two doors that list mail never have to ask.
    const doc = this.filedOnArrival(read, await this.deps.messages.blockedSenders(mailbox.userId).catch(() => []));

    const outcome = await this.deps.messages.store(doc);
    if (outcome.stored === 'duplicate') {
      // The bytes we just uploaded belong to a message that is already here.
      await this.deps.media.deleteObjectsWithPrefix?.({ prefix }).catch(() => { /* best effort */ });
      // And nobody is woken for it. A sending server that never saw our
      // answer will send the same message again; the unique index makes that
      // one row, and this makes it one wake at most.
      return { id: outcome.id, address, duplicate: true, ...(parseError ? { parseError } : {}) };
    }
    // ONE NEW INBOUND LETTER, just stored. This is the only place a wake is
    // raised, which is what makes three of slice 11's rules structural rather
    // than checked: a sent row never passes through here, a redelivery
    // returned above, and a letter is always stored in the inbox — Trash is
    // somewhere its owner puts it afterwards.
    this.announce(doc);
    return { id: doc.id, address, duplicate: false, ...(parseError ? { parseError } : {}) };
  }

  /** Into Spam on arrival, or not: the checks' verdict first, then the
   *  owner's list. The reason rides the letter, because the screen owes a
   *  different sentence for each. */
  private filedOnArrival(doc: MailMessageDocument, blocked: string[]): MailMessageDocument {
    if (doc.suspicious) return { ...doc, spamAt: doc.receivedAt, spamWhy: 'suspicious' };
    const from = doc.from?.address ? mailSenderKey(doc.from.address) : '';
    if (from && blocked.includes(from)) return { ...doc, spamAt: doc.receivedAt, spamWhy: 'blocked' };
    return doc;
  }

  /** Tell the watcher, if there is one, and never let it cost a delivery. */
  private announce(doc: MailMessageDocument): void {
    if (!this.watcher) return;
    // A BLOCKED sender's letter is not an arrival anybody asked to hear about
    // (slice 13): it is not counted, not listed, and wakes nobody. A letter
    // the checks marked is still counted, unquoted, as slice 11 decided.
    if (doc.spamWhy === 'blocked') return;
    try {
      const answerTo = replyRecipient(doc);
      const arrival: MailArrival = {
        id: doc.id,
        address: doc.address,
        subject: doc.subject,
        receivedAt: doc.receivedAt,
        ...(doc.from?.address ? { from: doc.from.address } : doc.envelopeFrom ? { from: doc.envelopeFrom } : {}),
        ...(doc.from?.name ? { fromName: doc.from.name } : {}),
        ...(answerTo ? { answerTo: answerTo.address } : {}),
      };
      this.watcher.noteArrival(arrival, { suspicious: doc.suspicious === true });
    } catch (error) {
      console.warn('[MailInbound] could not raise an arrival:', error instanceof Error ? error.message : error);
    }
  }

  private async documentFromParsed(input: {
    parsed: Email;
    mailbox: { userId: string };
    address: string;
    args: { from: unknown; raw: Buffer };
    messageKey: string;
    prefix: string;
  }): Promise<MailMessageDocument> {
    const { parsed, mailbox, address, args, messageKey, prefix } = input;
    const attachments: MailAttachmentRecord[] = [];
    const carried = parsed.attachments.slice(0, MAIL_MAX_ATTACHMENTS);
    for (const [index, file] of carried.entries()) {
      const fileName = safeAttachmentName(file.filename, index);
      const attachmentId = id('ma');
      const data = attachmentBytes(file.content, file.encoding);
      const contentType = (file.mimeType || 'application/octet-stream').split(';')[0]!.trim();
      // One unreadable part must not cost the message: the whole of it is in
      // the raw copy either way, so a failed upload drops that file from the
      // list rather than the delivery.
      const stored = await this.deps.media.uploadObject({
        storagePath: `${prefix}${attachmentId}/${fileName}`,
        contentType,
        data,
      }).then(() => true).catch(() => false);
      if (!stored) continue;
      attachments.push({
        id: attachmentId,
        fileName,
        contentType,
        size: data.length,
        storagePath: `${prefix}${attachmentId}/${fileName}`,
        ...(file.contentId ? { contentId: file.contentId.replace(/^<|>$/g, '') } : {}),
        ...(file.disposition === 'inline' || file.related ? { inline: true } : {}),
      });
    }

    const text = parsed.text?.slice(0, MAIL_MAX_INLINE_TEXT);
    const html = parsed.html?.slice(0, MAIL_MAX_INLINE_HTML);
    const truncated = (parsed.text?.length ?? 0) > MAIL_MAX_INLINE_TEXT
      || (parsed.html?.length ?? 0) > MAIL_MAX_INLINE_HTML;
    const authentication = readAuthentication(
      parsed.headers.find((header) => header.key === 'authentication-results')?.value,
    );
    const sentAt = parsed.date ? new Date(parsed.date) : null;
    const from = flattenAddresses(parsed.from)[0];

    return {
      id: messageKey,
      userId: mailbox.userId,
      address,
      envelopeFrom: normalizeEnvelopeAddress(args.from),
      receivedAt: this.now().toISOString(),
      ...(sentAt && !Number.isNaN(sentAt.getTime()) ? { sentAt: sentAt.toISOString() } : {}),
      ...(bareMessageId(parsed.messageId) ? { messageId: bareMessageId(parsed.messageId) } : {}),
      ...(bareMessageId(parsed.inReplyTo) ? { inReplyTo: bareMessageId(parsed.inReplyTo) } : {}),
      // What else it follows, so an answer finds its conversation even when
      // the message it directly answers never reached this mailbox (slice 8).
      ...(readReferences(parsed.references).length ? { references: readReferences(parsed.references) } : {}),
      ...(from ? { from } : {}),
      to: flattenAddresses(parsed.to),
      cc: flattenAddresses(parsed.cc),
      replyTo: flattenAddresses(parsed.replyTo),
      subject: (parsed.subject ?? '').slice(0, 998),
      snippet: mailSnippet(parsed.text, parsed.html),
      ...(text ? { text } : {}),
      ...(html ? { html } : {}),
      ...(truncated ? { bodyTruncated: true } : {}),
      attachments,
      ...(parsed.attachments.length > carried.length
        ? { attachmentsTruncated: parsed.attachments.length - carried.length }
        : {}),
      raw: { storagePath: `${prefix}raw.eml`, size: args.raw.length },
      ...(authentication ? { authentication } : {}),
      ...(looksSuspicious(authentication, from?.address) ? { suspicious: true } : {}),
    };
  }

  /**
   * The unreadable case. Everything a list row needs is read off the top of
   * the raw bytes; the body and any files stay in the raw copy, where the
   * owner can still download the whole message.
   */
  private documentFromHeaders(input: {
    raw: Buffer;
    mailbox: { userId: string };
    address: string;
    args: { from: unknown };
    messageKey: string;
    prefix: string;
    parseError: string;
  }): MailMessageDocument {
    const { raw, mailbox, address, args, messageKey, prefix, parseError } = input;
    const headers = scanHeaders(raw);
    const decode = (value: string | undefined): string => {
      if (!value) return '';
      try { return decodeWords(value); } catch { return value; }
    };
    const fromHeader = decode(headers.get('from'));
    const fromAddress = normalizeEnvelopeAddress(fromHeader) || normalizeEnvelopeAddress(args.from);
    const sentAt = headers.get('date') ? new Date(headers.get('date')!) : null;
    const authentication = readAuthentication(headers.get('authentication-results'));
    return {
      id: messageKey,
      userId: mailbox.userId,
      address,
      envelopeFrom: normalizeEnvelopeAddress(args.from),
      receivedAt: this.now().toISOString(),
      ...(sentAt && !Number.isNaN(sentAt.getTime()) ? { sentAt: sentAt.toISOString() } : {}),
      ...(bareMessageId(headers.get('message-id')) ? { messageId: bareMessageId(headers.get('message-id')) } : {}),
      // An unreadable letter still says what it answers, so it still lands in
      // its conversation rather than on a row of its own (slice 8).
      ...(bareMessageId(headers.get('in-reply-to')) ? { inReplyTo: bareMessageId(headers.get('in-reply-to')) } : {}),
      ...(readReferences(headers.get('references')).length ? { references: readReferences(headers.get('references')) } : {}),
      ...(fromAddress ? { from: { address: fromAddress, ...(fromHeader.includes('<') ? { name: fromHeader.split('<')[0]!.trim().replace(/^"|"$/g, '') } : {}) } } : {}),
      to: [{ address }],
      cc: [],
      replyTo: [],
      subject: decode(headers.get('subject')).slice(0, 998),
      snippet: '',
      attachments: [],
      raw: { storagePath: `${prefix}raw.eml`, size: raw.length },
      ...(authentication ? { authentication } : {}),
      ...(looksSuspicious(authentication, fromAddress) ? { suspicious: true } : {}),
      parseError,
    };
  }
}
