import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { workspaceRoutes } from '../../routes/workspace.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../../services/sqlite/sqlite-mail-message-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import type { MailMessageDocument } from '../../services/mail-message-storage.js';
import { mailHtmlNamesImage, mailImageSources, mailSenderKey } from '../../services/mail-pictures.js';
import {
  fetchMailRemoteImage, isPublicAddress, mailImageTransport, MAIL_REMOTE_IMAGE_MAX_BYTES, pinnedAddressLookup,
  type MailImageTransport,
} from '../../services/mail-remote-image.js';
import type { WorkspaceMailConversationAnswer, WorkspaceMailImageSendersAnswer } from '../../shared/workspace-mail.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

/**
 * PICTURES IN LETTERS (note #509, slice 10).
 *
 * What is worth a test here is not that a picture appears — it is everything
 * that must NOT happen when one does: nobody else's mail is reachable through
 * the two new doors; the proxy fetches only a URL the letter itself names,
 * and only out on the internet; bytes that are not a picture, or too many of
 * them, are refused; and a sender is on the always-load list for one person
 * and no other.
 */

const MINE = 'alice@agenticcloudcomputer.com';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let seq = 0;
const letter = (over: Partial<MailMessageDocument> = {}): MailMessageDocument => {
  seq += 1;
  return {
    id: `mp_${seq}`,
    userId: 'alice',
    address: MINE,
    envelopeFrom: 'bounces@example.com',
    receivedAt: new Date(Date.UTC(2026, 8, 23, 9, seq)).toISOString(),
    messageId: `p${seq}@example.com`,
    from: { name: 'Fly.io', address: 'billing@fly.io' },
    to: [{ address: MINE }],
    cc: [],
    replyTo: [],
    subject: 'Your September invoice',
    snippet: 'Invoice 4821.',
    html: '<p>Invoice 4821</p><img src="https://cdn.example.com/logo.png">'
      + '<img src="https://track.example.com/open.gif" width="1" height="1">'
      + '<img src="cid:seal">',
    attachments: [{
      id: 'ma_seal', fileName: 'seal.png', contentType: 'image/png', size: 2048,
      storagePath: 'users/alice/mail/mp/seal.png', contentId: 'seal', inline: true,
    }],
    raw: { storagePath: `users/alice/mail/mp_${seq}/raw.eml`, size: 100 },
    ...over,
  };
};

/** A stand-in for the request, which is handed the addresses the service has
 *  already checked — so a test can say what the other end answered AND what
 *  the socket was allowed to reach. */
const answering = (
  reply: (url: string) => Response,
  seen: Array<{ url: string; addresses: readonly string[] }> = [],
): MailImageTransport => async (url, { addresses }) => {
  seen.push({ url, addresses });
  return { response: reply(url), release: () => {} };
};

/** The pieces of a Workspace under test: one mailbox, two people. */
async function serve(messages: SqliteMailMessageStorage, db: ReturnType<typeof openSqliteDb>, over: Partial<RouteDeps> = {}) {
  const users = new InMemoryUserStorage();
  await users.createProfile('alice', { email: 'a@example.test' });
  await users.createProfile('bob', { email: 'b@example.test' });
  const mailboxes = new MailboxService(new SqliteMailboxStorage(db));
  const deps: Partial<RouteDeps> = { userStorage: users, mailMessages: messages, mailboxes, ...over };
  await addWorkspaceTestAuth(deps, users, { 42: 'alice', 43: 'bob' });
  const app = express();
  app.use(express.json());
  app.use('/workspace', workspaceRoutes(deps as RouteDeps));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    call: (identity: number, apiPath: string, init: RequestInit = {}) => fetch(
      `${origin}/workspace/api/${apiPath}`,
      { ...init, redirect: 'manual', headers: { ...workspaceTestHeaders(identity), ...(init.headers ?? {}) } },
    ),
  };
}

describe('which pictures a letter names', () => {
  it('reads the sources out of the stored markup, entities and all', () => {
    const html = '<img src="https://a.example/one.png?a=1&amp;b=2">'
      + "<img src='https://a.example/two.png'><img src=https://a.example/three.png><img alt=\"none\">";
    expect(mailImageSources(html)).toEqual([
      'https://a.example/one.png?a=1&b=2',
      'https://a.example/two.png',
      'https://a.example/three.png',
    ]);
    // The proxy's whole bound: a URL this letter does not point at is not one
    // a signed-in caller can have us fetch.
    expect(mailHtmlNamesImage(html, 'https://a.example/one.png?a=1&b=2')).toBe(true);
    expect(mailHtmlNamesImage(html, 'https://evil.example/anything.png')).toBe(false);
    expect(mailHtmlNamesImage(undefined, 'https://a.example/one.png')).toBe(false);
    expect(mailSenderKey('  Billing@Fly.IO ')).toBe('billing@fly.io');
  });
});

describe('what the proxy will go and fetch', () => {
  it('knows what is out on the internet and what is inside', () => {
    for (const inside of ['127.0.0.1', '10.0.0.4', '172.16.9.9', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(isPublicAddress(inside), inside).toBe(false);
    }
    for (const out of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:93.184.216.34']) {
      expect(isPublicAddress(out), out).toBe(true);
    }
  });

  it('refuses anything that is not an http address out on the internet', async () => {
    const never: MailImageTransport = () => { throw new Error('nothing should have been fetched'); };
    expect(await fetchMailRemoteImage('file:///etc/passwd', { transport: never })).toEqual({ refused: 'not_a_url' });
    expect(await fetchMailRemoteImage('https://user:pw@example.com/x.png', { transport: never })).toEqual({ refused: 'not_a_url' });
    expect(await fetchMailRemoteImage('http://127.0.0.1:8080/x.png', { transport: never })).toEqual({ refused: 'not_public' });
    // A name is only as good as what it answers — including a name that
    // answers with one public address and one inside.
    expect(await fetchMailRemoteImage('https://rebind.example/x.png', {
      transport: never,
      resolve: async () => ['93.184.216.34', '10.1.2.3'],
    })).toEqual({ refused: 'not_public' });
  });

  it('follows a redirect, and checks where it lands by the same rule', async () => {
    const seen: Array<{ url: string; addresses: readonly string[] }> = [];
    const transport = answering((url) => (url.endsWith('/moved.png')
      ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
      : new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })), seen);
    const resolve = async (host: string) => (host === 'cdn.example.com' ? ['93.184.216.34'] : ['169.254.169.254']);
    expect(await fetchMailRemoteImage('https://cdn.example.com/moved.png', { transport, resolve }))
      .toEqual({ refused: 'not_public' });
    expect(seen.map((one) => one.url)).toEqual(['https://cdn.example.com/moved.png']);
  });

  it('takes the bytes only when they sniff as a picture, and never an SVG', async () => {
    const resolve = async () => ['93.184.216.34'];
    const served = (body: BodyInit, type: string) => answering(
      () => new Response(body, { status: 200, headers: { 'content-type': type } }),
    );
    expect(await fetchMailRemoteImage('https://cdn.example.com/logo.png', { transport: served(PNG, 'image/png'), resolve }))
      .toMatchObject({ contentType: 'image/png' });
    // A page pretending to be a picture, and a document that can carry script.
    expect(await fetchMailRemoteImage('https://cdn.example.com/x.png', { transport: served('<html>hi</html>', 'image/png'), resolve }))
      .toEqual({ refused: 'not_an_image' });
    expect(await fetchMailRemoteImage('https://cdn.example.com/x.svg', {
      transport: served('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml'), resolve,
    })).toEqual({ refused: 'not_an_image' });
    // The ceiling is enforced on the bytes, not on the length claimed.
    expect(await fetchMailRemoteImage('https://cdn.example.com/huge.png', {
      transport: served(Buffer.alloc(MAIL_REMOTE_IMAGE_MAX_BYTES + 1), 'image/png'), resolve,
    })).toEqual({ refused: 'too_large' });
    expect(await fetchMailRemoteImage('https://cdn.example.com/gone.png', {
      transport: answering(() => new Response('no', { status: 404 })), resolve,
    })).toEqual({ refused: 'unreachable' });
  });
});

describe('the pin between the check and the socket', () => {
  it('hands the request the addresses it checked, and never lets the name be asked again', async () => {
    // The rebinding a check-then-fetch cannot survive: this name answers with
    // a public address while it is being checked and with loopback a moment
    // later. What matters is that the SECOND answer reaches nothing — the
    // request is given the first one and no hostname to look up.
    let answers = 0;
    const seen: Array<{ url: string; addresses: readonly string[] }> = [];
    const resolve = async () => {
      answers += 1;
      return answers === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
    };
    const outcome = await fetchMailRemoteImage('https://rebind.example/logo.png', {
      resolve,
      transport: answering(() => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }), seen),
    });
    expect(outcome).toMatchObject({ contentType: 'image/png' });
    expect(seen).toEqual([{ url: 'https://rebind.example/logo.png', addresses: ['93.184.216.34'] }]);
    expect(answers).toBe(1);
  });

  it('answers a socket with the checked addresses whatever name it asks about', () => {
    const pinned = pinnedAddressLookup(['93.184.216.34', '2606:4700:4700::1111']);
    const one: Array<[Error | null, unknown, unknown]> = [];
    pinned('anything.example', undefined, ((error, address, family) => one.push([error, address, family])) as never);
    expect(one).toEqual([[null, '93.184.216.34', 4]]);
    const all: unknown[] = [];
    pinned('anything.example', { all: true }, ((_error, addresses) => all.push(addresses)) as never);
    expect(all).toEqual([[{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]]);
    // An empty list reaches nothing at all, rather than falling back to
    // whatever DNS would have said.
    const none: Array<Error | null> = [];
    pinnedAddressLookup([])('anything.example', undefined, ((error) => none.push(error)) as never);
    expect(none[0]).toBeInstanceOf(Error);
  });

  it('really connects to the pinned address, on a name that resolves to nothing', async () => {
    // `.invalid` can never resolve (RFC 2606), so a socket that reaches this
    // server reached it because the pin sent it there — which is the whole
    // claim. The request also proves the transport sends no cookies and asks
    // for a picture.
    const asked: Array<{ url: string | undefined; accept: string | undefined; host: string | undefined }> = [];
    const server = createServer((req, res) => {
      asked.push({ url: req.url, accept: req.headers.accept, host: req.headers.host });
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const connection = await mailImageTransport(`http://pinned.invalid:${port}/logo.png`, {
        addresses: ['127.0.0.1'],
        signal: AbortSignal.timeout(5_000),
      });
      try {
        expect(connection.response.status).toBe(200);
        expect(Buffer.from(await connection.response.arrayBuffer()).equals(PNG)).toBe(true);
      } finally {
        connection.release();
      }
      // The sender's own name is still what the request carries.
      expect(asked).toEqual([{ url: '/logo.png', accept: 'image/*', host: `pinned.invalid:${port}` }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe('the doors onto a letter’s pictures', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('hands out an inline picture as our own short-lived URL, to its owner alone', async () => {
    const db = openSqliteDb(':memory:');
    const messages = new SqliteMailMessageStorage(db);
    const invoice = letter();
    await messages.store(invoice);
    const signed: string[] = [];
    const mediaStorage = {
      createReadAccess: async ({ storagePath, responseDisposition }: { storagePath: string; responseDisposition?: string }) => {
        signed.push(`${storagePath}:${responseDisposition ?? ''}`);
        return { url: 'https://storage.test/seal.png?signature=1', expiresAt: '2026-09-23T10:00:00.000Z' };
      },
    } as unknown as RouteDeps['mediaStorage'];
    const served = await serve(messages, db, { mediaStorage });
    server = served.server;

    const drawn = await served.call(42, `mail/messages/${invoice.id}/inline/ma_seal`);
    expect(drawn.status).toBe(302);
    expect(drawn.headers.get('location')).toBe('https://storage.test/seal.png?signature=1');
    // The reader's own browser may keep it; nothing in front of them may.
    expect(drawn.headers.get('cache-control')).toBe('private, max-age=300');
    expect(signed).toEqual(['users/alice/mail/mp/seal.png:inline']);
    // Bob knows the ids and gets nothing: every read here is the owner's.
    expect((await served.call(43, `mail/messages/${invoice.id}/inline/ma_seal`)).status).toBe(404);
    // And a file that is not a picture is not drawn in a letter at all.
    const brief = letter({
      attachments: [{ id: 'ma_pdf', fileName: 'brief.pdf', contentType: 'application/pdf', size: 10, storagePath: 'users/alice/mail/brief.pdf' }],
    });
    await messages.store(brief);
    expect((await served.call(42, `mail/messages/${brief.id}/inline/ma_pdf`)).status).toBe(404);
    expect((await served.call(42, `mail/messages/${invoice.id}/inline/nope`)).status).toBe(404);
  });

  it('fetches a remote picture only for the letter that names it, and says nothing may cache it', async () => {
    const db = openSqliteDb(':memory:');
    const messages = new SqliteMailMessageStorage(db);
    const invoice = letter();
    await messages.store(invoice);
    const asked: string[] = [];
    const served = await serve(messages, db, {
      // The service's own rules have their own tests above; what this one is
      // about is the route: whose letter, which URL, and what it answers.
      mailRemoteImage: async (src: string) => {
        asked.push(src);
        return { body: PNG, contentType: 'image/png' };
      },
    });
    server = served.server;

    const logo = await served.call(42, `mail/messages/${invoice.id}/remote-image?src=${encodeURIComponent('https://cdn.example.com/logo.png')}`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(logo.headers.get('cache-control')).toBe('private, no-store');
    expect(logo.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await logo.arrayBuffer()).equals(PNG)).toBe(true);
    expect(asked).toEqual(['https://cdn.example.com/logo.png']);

    // A URL this letter does not name is not fetched at all — the door is not
    // a fetcher for anything a signed-in caller can type.
    const elsewhere = await served.call(42, `mail/messages/${invoice.id}/remote-image?src=${encodeURIComponent('http://169.254.169.254/latest/meta-data')}`);
    expect(elsewhere.status).toBe(404);
    expect(asked).not.toContain('http://169.254.169.254/latest/meta-data');
    // And somebody else's letter is somebody else's.
    expect((await served.call(43, `mail/messages/${invoice.id}/remote-image?src=${encodeURIComponent('https://cdn.example.com/logo.png')}`)).status).toBe(404);
  });

  it('keeps an always-load list per person, and says on the letter whose it is', async () => {
    const db = openSqliteDb(':memory:');
    const messages = new SqliteMailMessageStorage(db);
    const invoice = letter();
    await messages.store(invoice);
    const served = await serve(messages, db);
    server = served.server;
    const body = (address: string) => ({
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }),
    });

    const conversation = async (identity: number) => (
      (await (await served.call(identity, `mail/conversations/${invoice.id}`)).json()) as WorkspaceMailConversationAnswer
    );
    expect((await conversation(42)).conversation.messages[0]).not.toHaveProperty('imagesAllowed');

    const added = await served.call(42, 'mail/image-senders', body('Billing@Fly.io'));
    expect(await added.json() as WorkspaceMailImageSendersAnswer).toEqual({ addresses: ['billing@fly.io'] });
    // The letter now SAYS it, off the server's own list: the screen is never
    // the thing that decides a picture may be fetched.
    expect((await conversation(42)).conversation.messages[0]).toMatchObject({ imagesAllowed: true });
    // Asking twice is not an error, and a list is one person's.
    expect(await (await served.call(42, 'mail/image-senders', body('billing@fly.io'))).json())
      .toEqual({ addresses: ['billing@fly.io'] });
    expect(await (await served.call(43, 'mail/image-senders')).json()).toEqual({ addresses: [] });
    expect(await (await served.call(42, 'mail/image-senders')).json()).toEqual({ addresses: ['billing@fly.io'] });

    // And the way back off it.
    const removed = await served.call(42, `mail/image-senders/${encodeURIComponent('billing@fly.io')}`, { method: 'DELETE' });
    expect(await removed.json() as WorkspaceMailImageSendersAnswer).toEqual({ addresses: [] });
    expect((await conversation(42)).conversation.messages[0]).not.toHaveProperty('imagesAllowed');
    expect((await served.call(42, 'mail/image-senders', body('not an address'))).status).toBe(400);
  });
});
