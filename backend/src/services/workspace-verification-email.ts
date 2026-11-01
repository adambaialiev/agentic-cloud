export interface WorkspaceVerificationEmail {
  email: string;
  verificationUrl: string;
  expiresAt: string;
  idempotencyKey: string;
}

export interface WorkspacePasswordResetEmail {
  email: string;
  /** The address the person signs in with, so the mail says which account it is about. */
  signInName: string;
  resetUrl: string;
  expiresAt: string;
  idempotencyKey: string;
}

export interface WorkspaceRecoveryConfirmationEmail {
  email: string;
  signInName: string;
  confirmUrl: string;
  expiresAt: string;
  idempotencyKey: string;
}

/**
 * A plain notice to a person — nothing to click that proves anything, so no
 * expiry footer: "a workplace you are in is being deleted" (2026-09-22). The
 * paragraphs are the words; the action, when there is one, is an ordinary
 * link to the Workspace.
 */
export interface WorkspaceNoticeEmail {
  email: string;
  subject: string;
  paragraphs: readonly string[];
  action?: { label: string; url: string };
  idempotencyKey: string;
}

export interface WorkspaceVerificationEmailSender {
  sendVerification(message: WorkspaceVerificationEmail): Promise<void>;
  /** Optional so a fixture sender that only confirms addresses still fits;
   * the service answers "unavailable" for the flows a sender cannot carry. */
  sendPasswordReset?(message: WorkspacePasswordResetEmail): Promise<void>;
  sendRecoveryConfirmation?(message: WorkspaceRecoveryConfirmationEmail): Promise<void>;
  sendNotice?(message: WorkspaceNoticeEmail): Promise<void>;
}

export interface ResendWorkspaceVerificationEmailSenderOptions {
  apiKey: string;
  from: string;
  fetch?: typeof globalThis.fetch;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The words of every transactional email, whatever carries it: Resend
 * below, or standard SMTP in a private copy (services/smtp-mail.ts, note
 * #815). The bearer confirmation URL is deliberately never included in
 * thrown errors or logs. */
export abstract class TransactionalWorkspaceEmailSender implements WorkspaceVerificationEmailSender {
  /** Hand one finished message to the provider. */
  protected abstract post(to: string, idempotencyKey: string, mail: { subject: string; text: string; html: string }): Promise<void>;

  async sendVerification(message: WorkspaceVerificationEmail): Promise<void> {
    await this.deliver(message.email, message.idempotencyKey, {
      subject: 'Confirm your Workspace email',
      lead: 'Confirm that this email address belongs to you.',
      url: message.verificationUrl,
      action: 'Confirm email',
    });
  }

  async sendPasswordReset(message: WorkspacePasswordResetEmail): Promise<void> {
    await this.deliver(message.email, message.idempotencyKey, {
      subject: 'Reset your Workspace password',
      lead: `Somebody asked to reset the password for ${message.signInName}. If that was you, choose a new one here.`,
      url: message.resetUrl,
      action: 'Choose a new password',
    });
  }

  async sendRecoveryConfirmation(message: WorkspaceRecoveryConfirmationEmail): Promise<void> {
    await this.deliver(message.email, message.idempotencyKey, {
      subject: 'Confirm your recovery email',
      lead: `Confirm that ${message.signInName} may reset a forgotten password through this address.`,
      url: message.confirmUrl,
      action: 'Confirm recovery email',
    });
  }

  async sendNotice(message: WorkspaceNoticeEmail): Promise<void> {
    const action = message.action;
    await this.post(message.email, message.idempotencyKey, {
      subject: message.subject,
      text: [...message.paragraphs, ...action ? [`${action.label}: ${action.url}`] : []].join('\n\n'),
      html: message.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')
        + (action ? `<p><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a></p>` : ''),
    });
  }

  private async deliver(to: string, idempotencyKey: string, words: { subject: string; lead: string; url: string; action: string }): Promise<void> {
    const footer = 'This single-use link expires in 30 minutes. If you did not request it, you can ignore this email.';
    await this.post(to, idempotencyKey, {
      subject: words.subject,
      text: [words.lead, '', words.url, '', footer].join('\n'),
      html: `<p>${escapeHtml(words.lead)}</p>`
        + `<p><a href="${escapeHtml(words.url)}">${escapeHtml(words.action)}</a></p>`
        + `<p>${footer}</p>`,
    });
  }
}

/** Transactional email delivery through Resend's small HTTPS API surface.
 * Resend's idempotency key closes the ambiguous-response case where the
 * provider accepted a request but our connection ended first. */
export class ResendWorkspaceVerificationEmailSender extends TransactionalWorkspaceEmailSender {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: ResendWorkspaceVerificationEmailSenderOptions) {
    super();
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  protected async post(to: string, idempotencyKey: string, mail: { subject: string; text: string; html: string }): Promise<void> {
    const response = await this.fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ from: this.options.from, to: [to], ...mail }),
    });
    if (!response.ok) {
      throw new Error(`Verification email provider returned HTTP ${response.status}.`);
    }
  }
}
