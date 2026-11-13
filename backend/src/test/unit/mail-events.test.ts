import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RESEND_WEBHOOK_PATH, mailEventRoutes, readResendEvent, verifySvixSignature } from '../../routes/mail-events.js';
import { AppDoors, InMemoryAppDoorStore } from '../../services/app-doors.js';
import { mailHtml } from '../../services/mail-html.js';

/**
 * The mail provider's signed word on a letter an app sent (notes #1112,
 * #1178): verified over the exact bytes, recorded once on that app's feed,
 * and anybody else's mail kept nowhere.
 */
describe('The Resend webhook route (notes #1112, #1178)', () => {
  const SECRET = `whsec_${Buffer.from('a test signing secret, 32 bytes!').toString('base64')}`;
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });
  const sign = (secret: string, id: string, ts: string, body: string) => {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
  };
  async function serve(secret: string, apps: AppDoors | null) {
    const app = express();
    app.use(RESEND_WEBHOOK_PATH, express.raw({ type: () => true, limit: '256kb' }));
    app.use(express.json());
    app.use(mailEventRoutes({ apps: () => apps, secret: () => secret, now: () => new Date('2026-11-09T13:00:00Z') }));
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}${RESEND_WEBHOOK_PATH}`;
  }
  const payload = (type: string, emailId: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    type, created_at: '2026-11-09T13:00:06.000Z',
    data: { email_id: emailId, created_at: '2026-11-09T13:00:01.000Z', from: 'Adam B <adam@agenticcloudcomputer.com>', to: ['mara@northwind-health.test'], subject: 'Your agents need a workplace', ...extra },
  });
  const post = (url: string, body: string, headers: Record<string, string>) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const signed = (body: string, id = 'msg_1', ts = String(Date.parse('2026-11-09T13:00:00Z') / 1000), secret = SECRET) => ({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,bm90IGl0 ${sign(secret, id, ts, body)}` });

  it('verifies the signature over the exact bytes, refuses stale or forged posts, and records an app\'s letter once on its feed', async () => {
    const doors = new AppDoors(new InMemoryAppDoorStore(), () => new Date('2026-11-09T13:00:00Z'));
    await doors.sent({ userId: 'user-adam', site: 'outreach', mailId: 'mail-1', providerId: 're-1', at: '2026-11-09T12:59:00Z' });
    const url = await serve(SECRET, doors);
    const body = payload('email.bounced', 're-1', { bounce: { type: 'Permanent', subType: 'General', message: 'No such user.' } });
    expect((await post(url, body, {})).status).toBe(401);
    expect((await post(url, body, signed(body, 'msg_1', String(Date.parse('2026-11-09T12:50:00Z') / 1000)))).status).toBe(401);
    expect((await post(url, body, signed(body, 'msg_1', undefined, `whsec_${Buffer.from('another secret').toString('base64')}`))).status).toBe(401);
    expect((await post(url, `${body} `, signed(body))).status).toBe(401);
    const ok = await post(url, body, signed(body));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ recorded: true });
    // The same event again is the same record, not a second one.
    expect((await post(url, body, signed(body))).status).toBe(200);
    // Somebody else's letter, and an event the platform does not record (a click): 200, nothing kept.
    const other = payload('email.delivered', 're-somebody-else', { to: ['x@y.test'], subject: 'Hi' });
    expect(await (await post(url, other, signed(other, 'msg_2'))).json()).toEqual({ recorded: false });
    const click = payload('email.clicked', 're-1');
    expect(await (await post(url, click, signed(click, 'msg_3'))).json()).toEqual({ recorded: false });
    const feed = await doors.feed('user-adam', 'outreach', 0);
    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]).toMatchObject({ kind: 'mail-event', mailId: 'mail-1', event: 'bounced', detail: 'No such user.', at: '2026-11-09T13:00:06.000Z' });
  });

  it('answers 503 and records nothing without the secret, and 404 where nothing records mail events', async () => {
    const doors = new AppDoors(new InMemoryAppDoorStore());
    const body = payload('email.delivered', 're-1');
    expect((await post(await serve('', doors), body, signed(body))).status).toBe(503);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    expect((await post(await serve(SECRET, null), body, signed(body))).status).toBe(404);
  });

  it('reads Resend\'s events: the seven it records, a passing bounce, the address out of a display name', () => {
    expect(readResendEvent(JSON.parse(payload('email.opened', 're-1')), 'msg')).toMatchObject({ event: 'opened', providerId: 're-1', at: '2026-11-09T13:00:06.000Z', to: ['mara@northwind-health.test'] });
    expect(readResendEvent(JSON.parse(payload('email.complained', 're-1')), 'msg')!.event).toBe('spam');
    expect(readResendEvent(JSON.parse(payload('email.delivery_delayed', 're-1')), 'msg')!.event).toBe('delayed');
    expect(readResendEvent(JSON.parse(payload('email.bounced', 're-1', { bounce: { type: 'Transient', subType: 'MailboxFull' } })), 'msg')).toMatchObject({ permanent: false, detail: 'Transient, MailboxFull' });
    expect(readResendEvent(JSON.parse(payload('email.delivered', 're-1', { to: ['Mara Q <mara@northwind-health.test>'] })), 'msg')!.to).toEqual(['mara@northwind-health.test']);
    for (const type of ['email.clicked', 'email.sent', 'domain.updated']) expect(readResendEvent(JSON.parse(payload(type, 're-1')), 'msg')).toBeNull();
    expect(readResendEvent(JSON.parse(payload('email.delivered', '')), 'msg')).toBeNull();
    expect(verifySvixSignature(SECRET, { id: 'a', timestamp: '1', signature: 'v1,x' }, '{}', new Date(1000))).toBe(false);
  });
});

describe('The HTML copy of a letter (notes #1112, #1178)', () => {
  it('writes it from the same words: paragraphs, line breaks, links as links, the quote as a quote, everything escaped', () => {
    expect(mailHtml('Hi Mara,\n\nOne <b>line</b> & two\nhttps://agenticcloudcomputer.com/go/abc234.\n\nAdam\n\nOn Mon, Adam wrote:\n> First.\n> https://x.test/a?b=1&c=2\n'))
      .toBe('<p>Hi Mara,</p>\n<p>One &lt;b&gt;line&lt;/b&gt; &amp; two<br>\n<a href="https://agenticcloudcomputer.com/go/abc234">https://agenticcloudcomputer.com/go/abc234</a>.</p>\n'
        + '<p>Adam</p>\n<p>On Mon, Adam wrote:</p>\n<blockquote><p>First.<br>\n<a href="https://x.test/a?b=1&amp;c=2">https://x.test/a?b=1&amp;c=2</a></p></blockquote>');
  });
});
