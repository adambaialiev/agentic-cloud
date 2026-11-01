/**
 * Mail out over standard SMTP (note #815): any provider, not only Resend.
 *
 * A private copy sends as its own domain through whatever its company
 * already uses (Postmark, Amazon SES, Mailgun, its own relay, or Resend's
 * SMTP door). Four settings, all of which our own platform leaves unset:
 *
 *   SMTP_HOST      the provider's submission host
 *   SMTP_PORT      587 (the default) starts plain and must upgrade to TLS;
 *                  465 is TLS from the first byte
 *   SMTP_USER      and
 *   SMTP_PASSWORD  the provider's credentials, when it asks for any
 *
 * They carry both streams, the sign-in links and people's own mail, each
 * only where no Resend key is set for it (index.ts), so a backend with
 * Resend keys sends exactly as before.
 *
 * SMTP has no idempotency key. The Message-ID stands in for it: made from
 * the key, so a retry carries the same id and a receiving server that has
 * seen it may file the two as one. That is weaker than Resend's promise, and
 * the outbox's own rules above this file are what keep retries rare.
 */

import { createHash } from 'node:crypto';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { MailSendError, type MailSender, type OutboundMail, type OutboundMailParty } from './mail-sender.js';
import { TransactionalWorkspaceEmailSender } from './workspace-verification-email.js';

export interface SmtpSettings {
  host: string;
  port: number;
  user?: string;
  password?: string;
}

/** The settings from the environment, or null when SMTP_HOST is unset. */
export function smtpSettingsFromEnv(env: Record<string, string | undefined>): SmtpSettings | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number.parseInt(env.SMTP_PORT?.trim() || '587', 10);
  const user = env.SMTP_USER?.trim();
  const password = env.SMTP_PASSWORD ?? '';
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    ...(user ? { user, password } : {}),
  };
}

/** What a sender needs from a transport: nodemailer's, or a test's. */
export interface SmtpTransport {
  sendMail(message: SendMailOptions): Promise<{ messageId?: string }>;
}

/**
 * One transport for the process. TLS always: 465 speaks it at once, any
 * other port must upgrade with STARTTLS or the message is not sent, so the
 * password never crosses the network in the clear.
 */
export function createSmtpTransport(settings: SmtpSettings): SmtpTransport {
  const implicitTls = settings.port === 465;
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: implicitTls,
    requireTLS: !implicitTls,
    ...(settings.user ? { auth: { user: settings.user, pass: settings.password ?? '' } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    // 15 MB of files is roughly 20 MB of base64 on the wire.
    socketTimeout: 90_000,
  });
}

/** `<hash-of-key@domain>`: the same key always makes the same id. */
export function messageIdFor(idempotencyKey: string, fromAddress: string): string {
  const domain = fromAddress.split('@').pop()?.replace(/[<>\s]/g, '') || 'localhost';
  const local = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
  return `<${local}@${domain}>`;
}

/** The address inside `Name <address>`, or the whole string. */
function bareAddress(from: string): string {
  return /<([^>]+)>/.exec(from)?.[1] ?? from;
}

const party = (who: OutboundMailParty) => (who.name?.trim() ? { name: who.name.trim(), address: who.address } : who.address);

const bracket = (id: string): string => (id.startsWith('<') ? id : `<${id}>`);

/** What the provider said, without anything that came from us. */
function providerReason(error: unknown): string {
  const smtp = error as { responseCode?: number; response?: string; code?: string; message?: string };
  if (smtp.response) return smtp.response.slice(0, 200);
  return (smtp.code ?? smtp.message ?? String(error)).slice(0, 200);
}

/** People's own mail (note #509 slice 4) over SMTP. */
export class SmtpMailSender implements MailSender {
  constructor(private readonly transport: SmtpTransport) {}

  async send(mail: OutboundMail): Promise<{ providerId?: string }> {
    const files = mail.attachments ?? [];
    try {
      const info = await this.transport.sendMail({
        from: party(mail.from),
        to: mail.to.map(party),
        ...(mail.cc?.length ? { cc: mail.cc.map(party) } : {}),
        // A reply to the reply comes back to the address it was sent from,
        // exactly as through Resend.
        replyTo: mail.from.address,
        subject: mail.subject,
        text: mail.text,
        messageId: messageIdFor(mail.idempotencyKey, mail.from.address),
        ...(mail.inReplyTo ? { inReplyTo: bracket(mail.inReplyTo) } : {}),
        ...(mail.references?.length ? { references: mail.references.map(bracket) } : {}),
        ...(files.length
          ? {
            attachments: files.map((file) => ({
              filename: file.fileName,
              content: Buffer.from(file.data),
              ...(file.contentType && file.contentType !== 'application/octet-stream' ? { contentType: file.contentType } : {}),
            })),
          }
          : {}),
      });
      return info.messageId ? { providerId: info.messageId } : {};
    } catch (error) {
      throw new MailSendError(`The mail server refused it. ${providerReason(error)}`.trim());
    }
  }
}

/** Sign-in links and notices over SMTP, from WORKSPACE_EMAIL_FROM. */
export class SmtpWorkspaceVerificationEmailSender extends TransactionalWorkspaceEmailSender {
  constructor(private readonly options: { transport: SmtpTransport; from: string }) {
    super();
  }

  protected async post(to: string, idempotencyKey: string, mail: { subject: string; text: string; html: string }): Promise<void> {
    try {
      await this.options.transport.sendMail({
        from: this.options.from,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        messageId: messageIdFor(idempotencyKey, bareAddress(this.options.from)),
      });
    } catch (error) {
      // The link is in the message, never in what is thrown.
      throw new Error(`Verification email server refused it. ${providerReason(error)}`.trim());
    }
  }
}
