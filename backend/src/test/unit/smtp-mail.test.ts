import { describe, expect, it } from 'vitest';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { MailSendError } from '../../services/mail-sender.js';
import {
  SmtpMailSender,
  SmtpWorkspaceVerificationEmailSender,
  createSmtpTransport,
  messageIdFor,
  smtpSettingsFromEnv,
  type SmtpTransport,
} from '../../services/smtp-mail.js';

/** nodemailer's own composer, writing the message to memory instead of a server. */
function memoryTransport() {
  const raw: string[] = [];
  const inner = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const transport: SmtpTransport = {
    async sendMail(message: SendMailOptions) {
      const info = await inner.sendMail(message) as { message: Buffer; messageId?: string };
      raw.push(info.message.toString('utf8'));
      return { ...(info.messageId ? { messageId: info.messageId } : {}) };
    },
  };
  return { transport, raw };
}

describe('mail out over standard SMTP (note #815)', () => {
  it('reads the four settings, and none without a host', () => {
    expect(smtpSettingsFromEnv({})).toBeNull();
    expect(smtpSettingsFromEnv({ SMTP_HOST: ' ', SMTP_USER: 'x' })).toBeNull();
    expect(smtpSettingsFromEnv({ SMTP_HOST: 'smtp.example.com' })).toEqual({ host: 'smtp.example.com', port: 587 });
    expect(smtpSettingsFromEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'resend', SMTP_PASSWORD: 'p w' }))
      .toEqual({ host: 'smtp.example.com', port: 465, user: 'resend', password: 'p w' });
    expect(smtpSettingsFromEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: 'nope' })?.port).toBe(587);
  });

  it('always speaks TLS: at once on 465, by a required upgrade on any other port', () => {
    const implicit = createSmtpTransport({ host: 'smtp.example.com', port: 465, user: 'u', password: 'p' }) as unknown as { options: Record<string, unknown> };
    expect(implicit.options).toMatchObject({ secure: true, requireTLS: false, auth: { user: 'u', pass: 'p' } });
    const upgrade = createSmtpTransport({ host: 'smtp.example.com', port: 587 }) as unknown as { options: Record<string, unknown> };
    expect(upgrade.options).toMatchObject({ secure: false, requireTLS: true });
    expect(upgrade.options.auth).toBeUndefined();
  });

  it('sends a person’s reply with its thread, its Cc and its file, and the same Message-ID on a retry', async () => {
    const { transport, raw } = memoryTransport();
    const sender = new SmtpMailSender(transport);
    const mail = {
      from: { address: 'ada@copy366.agentbuilt.app', name: 'Ada Example' },
      to: [{ address: 'bea@example.com' }],
      cc: [{ address: 'cy@example.com', name: 'Cy' }],
      subject: 'Re: the plan',
      text: 'Yes, Thursday works.',
      inReplyTo: 'abc@example.com',
      references: ['root@example.com', 'abc@example.com'],
      attachments: [{ fileName: 'plan.pdf', contentType: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]) }],
      idempotencyKey: 'outbox:42',
    };
    const first = await sender.send(mail);
    await sender.send(mail);

    const message = raw[0]!;
    expect(message).toContain('From: Ada Example <ada@copy366.agentbuilt.app>');
    expect(message).toContain('To: bea@example.com');
    expect(message).toContain('Cc: Cy <cy@example.com>');
    expect(message).toContain('Reply-To: ada@copy366.agentbuilt.app');
    expect(message).toContain('In-Reply-To: <abc@example.com>');
    expect(message).toContain('References: <root@example.com> <abc@example.com>');
    expect(message).toContain('Content-Type: application/pdf; name=plan.pdf');
    expect(message).toContain('Yes, Thursday works.');
    const id = messageIdFor('outbox:42', 'ada@copy366.agentbuilt.app');
    expect(id).toMatch(/^<[0-9a-f]{32}@copy366\.agentbuilt\.app>$/);
    expect(message).toContain(`Message-ID: ${id}`);
    expect(raw[1]).toContain(`Message-ID: ${id}`);
    expect(first.providerId).toBe(id);
    expect(message).not.toMatch(/^Bcc:/m);
  });

  it('says what the server said when it refuses', async () => {
    const sender = new SmtpMailSender({
      async sendMail() {
        throw Object.assign(new Error('Message failed'), { responseCode: 550, response: '550 5.7.1 Sender domain not verified' });
      },
    });
    const refused = sender.send({ from: { address: 'a@x.test' }, to: [{ address: 'b@y.test' }], subject: 's', text: 't', idempotencyKey: 'k' });
    await expect(refused).rejects.toBeInstanceOf(MailSendError);
    await expect(refused).rejects.toThrow('The mail server refused it. 550 5.7.1 Sender domain not verified');
  });

  it('sends sign-in links from the Workspace address, and never puts the link in an error', async () => {
    const { transport, raw } = memoryTransport();
    const sender = new SmtpWorkspaceVerificationEmailSender({ transport, from: 'Workspace <workspace@copy366.agentbuilt.app>' });
    await sender.sendVerification({
      email: 'bea@example.com',
      verificationUrl: 'https://copy366.agentbuilt.app/verify#token=secret-token',
      expiresAt: '2026-10-27T22:00:00Z',
      idempotencyKey: 'verify:1',
    });
    expect(raw[0]).toContain('From: Workspace <workspace@copy366.agentbuilt.app>');
    expect(raw[0]).toContain('Subject: Confirm your Workspace email');
    expect(raw[0]).toContain(`Message-ID: ${messageIdFor('verify:1', 'workspace@copy366.agentbuilt.app')}`);
    expect(raw[0]).toContain('secret-token');

    const failing = new SmtpWorkspaceVerificationEmailSender({
      transport: { async sendMail() { throw Object.assign(new Error('x'), { response: '421 try later' }); } },
      from: 'workspace@copy366.agentbuilt.app',
    });
    const error = await failing.sendPasswordReset!({
      email: 'bea@example.com', signInName: 'bea', resetUrl: 'https://x/reset#secret-token', expiresAt: '', idempotencyKey: 'r',
    }).catch((caught: Error) => caught);
    expect(String(error)).toContain('421 try later');
    expect(String(error)).not.toContain('secret-token');
  });
});
