import { describe, expect, it, vi } from 'vitest';
import { ResendWorkspaceVerificationEmailSender } from '../../services/workspace-verification-email.js';

describe('ResendWorkspaceVerificationEmailSender', () => {
  it('sends both text and escaped HTML with an idempotency key', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));
    const sender = new ResendWorkspaceVerificationEmailSender({
      apiKey: 'secret-api-key',
      from: 'Workspace <workspace@example.com>',
      fetch,
    });
    await sender.sendVerification({
      email: 'owner@example.com',
      verificationUrl: 'https://app.example.com/workspace/verify-email#token=a&b',
      expiresAt: '2026-08-30T12:30:00.000Z',
      idempotencyKey: 'verification-hash',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer secret-api-key',
      'Idempotency-Key': 'verification-hash',
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: 'Workspace <workspace@example.com>',
      to: ['owner@example.com'],
      subject: 'Confirm your Workspace email',
    });
    expect(String(body.text)).toContain('#token=a&b');
    expect(String(body.html)).toContain('#token=a&amp;b');
  });

  it('sends a plain notice with no link-expiry small print (2026-09-22)', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'email-2' }), { status: 200 }));
    const sender = new ResendWorkspaceVerificationEmailSender({ apiKey: 'k', from: 'Workspace <workspace@example.com>', fetch });
    await sender.sendNotice({
      email: 'mira@example.com',
      subject: 'Nomad & Co will be deleted on 29 September',
      paragraphs: ['Saddam asked to delete the workplace Nomad & Co.', 'Any admin can keep it.'],
      action: { label: 'Open the Workspace', url: 'https://app.example.com/workspace/workplace?org=o1&x=1' },
      idempotencyKey: 'workplace-scheduled-o1-u2',
    });
    const [, init] = fetch.mock.calls[0]!;
    expect(init?.headers).toMatchObject({ 'Idempotency-Key': 'workplace-scheduled-o1-u2' });
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    expect(body.subject).toBe('Nomad & Co will be deleted on 29 September');
    expect(body.text).toBe([
      'Saddam asked to delete the workplace Nomad & Co.',
      'Any admin can keep it.',
      'Open the Workspace: https://app.example.com/workspace/workplace?org=o1&x=1',
    ].join('\n\n'));
    expect(body.html).toContain('<p>Saddam asked to delete the workplace Nomad &amp; Co.</p>');
    expect(body.html).toContain('href="https://app.example.com/workspace/workplace?org=o1&amp;x=1"');
    expect(body.text).not.toContain('expires');
  });

  it('never includes the bearer URL in provider errors', async () => {
    const sender = new ResendWorkspaceVerificationEmailSender({
      apiKey: 'secret-api-key',
      from: 'workspace@example.com',
      fetch: async () => new Response('contains-provider-detail', { status: 403 }),
    });
    const secretUrl = 'https://app.example.com/workspace/verify-email#token=never-log-this';
    await expect(sender.sendVerification({
      email: 'owner@example.com', verificationUrl: secretUrl,
      expiresAt: '2026-08-30T12:30:00.000Z', idempotencyKey: 'verification-hash',
    })).rejects.toThrow('Verification email provider returned HTTP 403.');
    await expect(sender.sendVerification({
      email: 'owner@example.com', verificationUrl: secretUrl,
      expiresAt: '2026-08-30T12:30:00.000Z', idempotencyKey: 'verification-hash',
    })).rejects.not.toThrow(secretUrl);
  });
});
