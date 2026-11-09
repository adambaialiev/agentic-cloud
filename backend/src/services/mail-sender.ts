/**
 * Getting a person's own mail OUT (note #509, slice 4).
 *
 * One narrow door on purpose. Everything that decides WHO a message may go
 * to, and how often, is above this file; all this does is hand a finished
 * message to the provider. That separation is what lets the rules be read in
 * one place and tested without the internet.
 *
 * Resend carries it. The root domain is verified there and its DKIM record
 * is in the zone, so a reply is signed as `agenticcloudcomputer.com` and
 * aligns for DMARC; the Return-Path rides `send.agenticcloudcomputer.com`,
 * which has its own SPF record. That is deliberately NOT the
 * `updates.agenticcloudcomputer.com` subdomain the sign-in links use — a
 * person's ordinary mail must never be able to spend the reputation that
 * delivers somebody's confirmation link.
 */

export interface OutboundMailParty {
  address: string;
  name?: string;
}

/** A file that leaves with a message (slice 12), its bytes in hand. */
export interface OutboundMailFile {
  fileName: string;
  contentType: string;
  data: Uint8Array;
}

export interface OutboundMail {
  from: OutboundMailParty;
  to: OutboundMailParty[];
  /** Everybody else it goes to (slice 12). There is no Bcc, by design. */
  cc?: OutboundMailParty[];
  subject: string;
  text: string;
  /**
   * The same words as HTML, beside the text (note #1112: Outreach letters
   * only, so the provider's open pixel has a place). Everything else this
   * address sends is plain text alone.
   */
  html?: string;
  /** In the order the person put them on; the order is part of the payload
   *  the idempotency key names, so it must be the same on every attempt. */
  attachments?: OutboundMailFile[];
  /** The Message-ID this answers, without angle brackets, so the recipient's
   *  mail client files the reply in the conversation it belongs to. */
  inReplyTo?: string;
  /** The conversation so far, oldest first; the same ids, no brackets. */
  references?: string[];
  /**
   * Resend's own de-duplication, so a request we sent twice — a retry, a
   * connection that ended after the provider accepted it — is one message.
   *
   * ONE KEY PER MESSAGE, AND THE KEY NAMES THE WHOLE PAYLOAD. Resend keeps a
   * key for 24 hours and answers the same key with a DIFFERENT body with 409
   * `invalid_idempotent_request` — so a retry has to be byte-identical, Cc
   * and files included. That is why everything a retry could send is frozen
   * before the first attempt (an approval request stores its Cc and its
   * files' records), and why a changed payload under an old key is refused
   * rather than sent: it can never become a second message.
   */
  idempotencyKey: string;
}

export interface MailSender {
  /** Hands the message over. Resolves once the provider has accepted it,
   *  which is not the same as delivered — nothing here waits for that. */
  send(mail: OutboundMail): Promise<{ providerId?: string }>;
}

export class MailSendError extends Error {}

const address = (party: OutboundMailParty): string => (
  party.name?.trim() ? `${party.name.replace(/[<>"\r\n]/g, ' ').trim()} <${party.address}>` : party.address
);

const bracket = (id: string): string => (id.startsWith('<') ? id : `<${id}>`);

/** A content type the provider can be handed as it is; anything else is left
 *  for it to derive from the file name. */
const PLAIN_CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** How long the provider gets to take a message: words go in a moment, and
 *  15 MB of files is roughly 20 MB of base64 on the wire. */
const SEND_TIMEOUT_MS = 15_000;
const SEND_WITH_FILES_TIMEOUT_MS = 90_000;

export class ResendMailSender implements MailSender {
  private readonly fetch: typeof globalThis.fetch;

  constructor(
    private readonly options: { apiKey: string; fetch?: typeof globalThis.fetch },
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async send(mail: OutboundMail): Promise<{ providerId?: string }> {
    const headers: Record<string, string> = {};
    if (mail.inReplyTo) headers['In-Reply-To'] = bracket(mail.inReplyTo);
    if (mail.references?.length) headers.References = mail.references.map(bracket).join(' ');
    const files = mail.attachments ?? [];
    const response = await this.fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(files.length ? SEND_WITH_FILES_TIMEOUT_MS : SEND_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': mail.idempotencyKey,
      },
      body: JSON.stringify({
        from: address(mail.from),
        to: mail.to.map(address),
        ...(mail.cc?.length ? { cc: mail.cc.map(address) } : {}),
        // A reply to the reply comes back to the address it was sent from,
        // which is ours — so the conversation stays in the person's inbox
        // rather than escaping to whatever the provider would put here.
        reply_to: [mail.from.address],
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(files.length
          ? {
            attachments: files.map((file) => ({
              filename: file.fileName,
              content: Buffer.from(file.data).toString('base64'),
              // "Some bytes" says nothing the file's name does not say
              // better, so that one is left for the provider to derive.
              ...(PLAIN_CONTENT_TYPE.test(file.contentType) && file.contentType !== 'application/octet-stream'
                ? { content_type: file.contentType }
                : {}),
            })),
          }
          : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      }),
    });
    if (!response.ok) {
      // The body carries the provider's reason (an unverified domain, a
      // refused recipient). Worth keeping: it is the difference between "try
      // again" and "this will never work".
      const detail = await response.text().catch(() => '');
      throw new MailSendError(`The mail provider refused it (HTTP ${response.status}). ${detail.slice(0, 200)}`.trim());
    }
    const body = await response.json().catch(() => ({})) as { id?: string };
    return { ...(body.id ? { providerId: body.id } : {}) };
  }
}
