/**
 * Note #1125, in real Chrome: files and pictures in direct messages, for
 * people and for the Chief of Staff's draft. Two fixture people in one
 * workplace (a third as the outsider), two browser sessions, the real
 * Workspace router and the REAL messaging server (infra/msg-host/msg-host.mjs,
 * as a child process with its files on a scratch directory) — the bytes go
 * exactly where production puts them.
 *
 *   npm --prefix backend run build:workspace-ui
 *   OUT_DIR=/tmp/shots backend/node_modules/.bin/tsx scripts/verify-workspace-dm-files.mts
 *
 * What it proves: the paperclip, paste and drag-and-drop each attach; a
 * picture arrives as a small copy made by the sender's browser and opens full
 * size in the viewer; another file is its name, its size and a download of
 * the exact bytes; the inbox says "Photo"; an outsider gets nothing; the
 * Chief of Staff's card shows its file as a picture and the tap sends both,
 * marked. The card's row is seeded as `member message --file` places it (that
 * route is unit-tested in direct-message-approval.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';
import { settleAfterShot, tap } from './browser-settle.mjs';
import { harnessEstablishedWorkplace } from './workspace-harness-auth.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { InMemorySecretStorage } from '../backend/src/services/secret-storage.js';
import { InMemoryWorkspaceWebAuthStorage, WorkspaceWebAuthService } from '../backend/src/services/workspace-web-auth.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { generateTotpCode } from '../backend/src/utils/totp.js';
import { openSqliteDb } from '../backend/src/services/sqlite/sqlite-db.js';
import { RemoteDirectMessageStorage } from '../backend/src/services/remote-direct-message-storage.js';
import { SqliteDirectMessageUnreadStore } from '../backend/src/services/sqlite/sqlite-direct-message-unread-store.js';
import { DirectMessageApprovalService, SqliteDirectMessageApprovalStorage } from '../backend/src/services/direct-message-approval.js';
import { describeDirectMessageUpload } from '../backend/src/routes/direct-messages.js';
import { startMsgHost } from '../backend/src/test/unit/msg-host-process.js';

const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const out = process.env.OUT_DIR || '/home/agent/dm-files-proof'; mkdirSync(out, { recursive: true });
const chromeRoot = `${process.env.HOME}/.cache/puppeteer/chrome`;
const chrome = process.env.CHROME || path.join(chromeRoot, readdirSync(chromeRoot).sort().at(-1)!, 'chrome-linux64/chrome');

/** A real PNG: a 1600x900 gradient, so the small copy is visibly smaller. */
function png(width: number, height: number): Buffer {
  const crc = (buf: Buffer) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const o = y * (width * 3 + 1) + 1 + x * 3; raw[o] = (x * 255) / width; raw[o + 1] = (y * 255) / height; raw[o + 2] = 160; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const scratch = mkdtempSync(path.join(tmpdir(), 'dm-files-'));
const photo = png(1600, 900), photoPath = path.join(scratch, 'whiteboard.png'); writeFileSync(photoPath, photo);
const plan = Buffer.from('%PDF-1.4\n% fixture plan\n' + 'x'.repeat(4000)), planPath = path.join(scratch, 'launch plan.pdf'); writeFileSync(planPath, plan);

const users = new InMemoryUserStorage(), orgs = new InMemoryOrgStorage();
harnessEstablishedWorkplace(orgs);
const auth = new WorkspaceWebAuthService(new InMemoryWorkspaceWebAuthStorage(), users, new SecretCipher(randomBytes(32).toString('base64')));
const enroll = async (username: string, first: string, last: string) => {
  const seed = await auth.startEnrollment(username);
  const issued = await auth.finishEnrollment({ enrollmentToken: seed.enrollmentToken, code: generateTotpCode(seed.secret) });
  await users.updateProfile(issued.userId, { person: { firstName: first, lastName: last } });
  return issued;
};
// Fixture people, never real ones.
const owner = await enroll('fixture_owner', 'Rowan', 'Vale'), mate = await enroll('fixture_mate', 'Tamsin', 'Okoro'), third = await enroll('fixture_third', 'Ibby', 'Lane');
const org = await orgs.createOrg({ name: 'Fixture Studio', createdByUserId: owner.userId });
await orgs.addMember({ orgId: org.orgId, userId: owner.userId, role: 'admin' });
await orgs.addMember({ orgId: org.orgId, userId: mate.userId, role: 'member' });
await orgs.addMember({ orgId: org.orgId, userId: third.userId, role: 'member' });

const host = await startMsgHost({ orgId: org.orgId, filesDir: path.join(scratch, 'machine-files') });
const db = openSqliteDb(':memory:');
const messages = new RemoteDirectMessageStorage(host, new SqliteDirectMessageUnreadStore(db));
const approvals = new DirectMessageApprovalService(new SqliteDirectMessageApprovalStorage(db), () => messages,
  async (orgId, userId) => Boolean(await orgs.getMembership(orgId, userId)));

const app = express(); app.use(express.json());
const server = app.listen(Number(process.env.PORT || 0), '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
app.use(workspaceRootRoutes());
app.use('/workspace', workspaceRoutes({
  userStorage: users, orgStorage: orgs, directMessageStorage: messages, directMessageApprovals: approvals, workspaceWebAuth: auth,
  workspaceWebOrigin: origin, workspaceUiDir: path.resolve('backend/dist/workspace-ui'), secretStorage: new InMemorySecretStorage(),
} as RouteDeps));

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const errors: string[] = [];
  const open = async (session: typeof owner, phone: boolean) => {
    const context = await browser.createBrowserContext();
    await context.setCookie({ name: 'acc_session', value: session.token, url: origin, httpOnly: true }, { name: 'acc_csrf', value: session.csrfToken, url: origin });
    const page = await context.newPage();
    await page.setViewport(phone ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1280, height: 860 });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('response', (response) => { if (response.status() >= 400 && !response.url().includes('/favicon')) errors.push(`${response.status()} ${response.url()}`); });
    return page;
  };
  const a = await open(owner, true), b = await open(mate, false), c = await open(third, false);
  const conversation = (peer: string) => `${origin}/messages/${peer}?org=${org.orgId}`;

  // ── 1. The paperclip: a photo and a PDF, with words, on the phone. ──
  await a.goto(conversation(mate.userId));
  await a.waitForSelector('#directMessageAttach', { timeout: 15_000 });
  check('the composer has a paperclip', await a.$eval('#directMessageAttach', (node) => node.getAttribute('aria-label')) === 'Attach files');
  const input = await a.$('#directMessageFile');
  await (input as unknown as { uploadFile: (...paths: string[]) => Promise<void> }).uploadFile(photoPath, planPath);
  await a.waitForFunction(() => document.querySelectorAll('#directMessageDraft .chatdraftitem').length === 2, { timeout: 5_000 });
  check('both picks wait in the draft, the picture previewed', await a.$$eval('#directMessageDraft .chatdraftitem', (nodes) => nodes.map((node) => node.textContent)).then((t) => t[0]!.includes('whiteboard.png') && t[1]!.includes('launch plan.pdf'))
    && await a.$eval('#directMessageDraft img.preview', (img) => (img as HTMLImageElement).src.startsWith('blob:')));
  await a.type('textarea[aria-label="Message"]', 'The whiteboard from today, and the plan.');
  await a.screenshot({ path: `${out}/1-draft-phone.png` });
  await settleAfterShot(a);
  await tap(a, 'button.chatsend');
  await a.waitForFunction(() => {
    const img = document.querySelector('[role=log] .chatmsg.chatfile[data-message-id] img') as HTMLImageElement | null;
    return Boolean(img?.complete && img.naturalWidth > 0);
  }, { timeout: 20_000 });
  const sent = (await messages.page(org.orgId, owner.userId, mate.userId, 5)).messages.at(-1)!;
  const kept = sent.files ?? [];
  check('the message holds the words and both files, in order', sent.text === 'The whiteboard from today, and the plan.'
    && kept.map((f) => f.name).join('|') === 'whiteboard.png|launch plan.pdf', JSON.stringify(kept));
  check('the photo is a picture by its bytes, with a small copy made upright by the browser', kept[0]?.type === 'image/png' && kept[0]?.thumb === true
    && kept[0]?.width === 640 && kept[0]?.height === 360, JSON.stringify(kept[0]));
  check('the PDF is a file, its size exact', kept[1]?.size === plan.length && kept[1]?.thumb === undefined);
  const machineFiles = readdirSync(path.join(scratch, 'machine-files')).sort();
  check('the bytes are on the messaging machine\'s volume: the file, its small copy, the PDF', machineFiles.length === 3
    && machineFiles.includes(`${kept[0]!.id}.thumb`), JSON.stringify(machineFiles));
  const drawnSrc = await a.$eval('[role=log] .chatmsg.chatfile[data-message-id] img', (img) => (img as HTMLImageElement).getAttribute('src'));
  check('the bubble draws the small copy, not the full photo', Boolean(drawnSrc?.includes('thumb=1')), String(drawnSrc));
  check('nothing overflows the phone', await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await a.screenshot({ path: `${out}/2-sent-phone.png` });
  await settleAfterShot(a);

  // ── 2. The teammate, at a desk: picture, file row, full size, download. ──
  await b.goto(conversation(owner.userId));
  await b.waitForFunction(() => {
    const img = document.querySelector('[role=log] .chatmsg.chatfile img') as HTMLImageElement | null;
    return Boolean(img?.complete && img.naturalWidth > 0);
  }, { timeout: 20_000 });
  const theirs = await b.$eval('[role=log] .chatmsg.chatfile', (node) => ({
    side: node.classList.contains('agent') ? 'theirs' : 'mine',
    caption: node.querySelector('.chatfilecaption')?.textContent,
    thumbWidth: (node.querySelector('img') as HTMLImageElement).naturalWidth,
    row: node.querySelector('a.chatfileitem')?.textContent,
    href: node.querySelector('a.chatfileitem')?.getAttribute('href'),
  }));
  check('the teammate sees the words, the picture and the file row', theirs.side === 'theirs' && theirs.caption === 'The whiteboard from today, and the plan.'
    && theirs.thumbWidth === 640 && /launch plan\.pdf · 4 KB/.test(theirs.row ?? ''), JSON.stringify(theirs));
  const downloaded = await b.evaluate(async (href) => {
    const res = await fetch(href!, { credentials: 'same-origin' });
    return { status: res.status, size: (await res.arrayBuffer()).byteLength, disposition: res.headers.get('content-disposition'), type: res.headers.get('content-type') };
  }, theirs.href);
  check('the download is the exact bytes, as an attachment', downloaded.status === 200 && downloaded.size === plan.length
    && /^attachment; filename="launch plan.pdf"/.test(downloaded.disposition ?? '') && downloaded.type === 'application/octet-stream', JSON.stringify(downloaded));
  await tap(b, '[role=log] .chatmsg.chatfile button.chatfileitem');
  await b.waitForFunction(() => {
    const img = document.querySelector('.imageviewer img') as HTMLImageElement | null;
    return Boolean(img?.complete && img.naturalWidth > 0);
  }, { timeout: 10_000 });
  check('a tap opens the full photo in the viewer', await b.$eval('.imageviewer img', (img) => (img as HTMLImageElement).naturalWidth) === 1600);
  await b.screenshot({ path: `${out}/3-viewer-desk.png` });
  await b.keyboard.press('Escape');
  await b.waitForFunction(() => !document.querySelector('.imageviewer img'), { timeout: 5_000 }).catch(() => {});
  await b.screenshot({ path: `${out}/4-teammate-desk.png` });
  await settleAfterShot(b);

  // ── 3. The outsider gets nothing, even with the address. ──
  await c.goto(`${origin}/?org=${org.orgId}`);
  const outsider = await c.evaluate(async (href) => (await fetch(href!, { credentials: 'same-origin' })).status, theirs.href?.replace(owner.userId, mate.userId));
  const outsider2 = await c.evaluate(async (href) => (await fetch(href!, { credentials: 'same-origin' })).status, theirs.href);
  check('a third member of the workplace cannot read the file by its address', outsider === 404 && outsider2 === 404, `${outsider} ${outsider2}`);

  // ── 4. Paste and drag-and-drop, then a picture alone; the inbox says "Photo". ──
  await b.evaluate(() => {
    const box = document.querySelector('textarea[aria-label="Message"]')!;
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 200;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#c44'; ctx.fillRect(0, 0, 300, 200);
    return new Promise<void>((resolve) => canvas.toBlob((blob) => {
      const data = new DataTransfer(); data.items.add(new File([blob!], 'image.png', { type: 'image/png' }));
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      resolve();
    }, 'image/png'));
  });
  await b.waitForFunction(() => document.querySelectorAll('#directMessageDraft .chatdraftitem').length === 1, { timeout: 5_000 });
  check('a pasted picture is attached', await b.$eval('#directMessageDraft', (node) => node.textContent?.includes('image.png')));
  await b.evaluate(() => {
    const target = document.querySelector('#screenDirectMessage')!;
    const data = new DataTransfer(); data.items.add(new File(['dropped notes'], 'notes.txt', { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await b.waitForFunction(() => document.querySelectorAll('#directMessageDraft .chatdraftitem').length === 2, { timeout: 5_000 });
  check('a dropped file is attached', await b.$eval('#directMessageDraft', (node) => node.textContent?.includes('notes.txt')));
  // Take the dropped one back off; send the picture alone.
  await tap(b, '#directMessageDraft .chatdraftitem:nth-child(2) .remove');
  await b.waitForFunction(() => document.querySelectorAll('#directMessageDraft .chatdraftitem').length === 1, { timeout: 5_000 });
  await tap(b, 'button.chatsend');
  await b.waitForFunction(() => document.querySelectorAll('[role=log] .chatmsg.chatfile[data-message-id]').length === 2, { timeout: 15_000 });
  const alone = (await messages.page(org.orgId, mate.userId, owner.userId, 5)).messages.at(-1)!;
  check('a picture alone is a whole message', alone.text === '' && alone.files?.length === 1 && alone.files[0]!.thumb === true, JSON.stringify(alone));
  await a.goto(`${origin}/messages?org=${org.orgId}`);
  await a.waitForSelector('#screenMessages .ctext', { timeout: 15_000 });
  check('the inbox says "Photo"', await a.$eval('#screenMessages .ctext', (node) => node.textContent) === 'Photo');
  await a.screenshot({ path: `${out}/5-inbox-phone.png` });
  await settleAfterShot(a);

  // ── 5. The Chief of Staff's draft with a picture: the card, the tap. ──
  const at = new Date(Date.now() - 60_000).toISOString();
  const wa = await users.reserveWorkspaceAssistant(owner.userId, org.orgId);
  if (!wa) throw new Error('the Workspace Agent was not reserved');
  // What `member message "Tamsin" "…" --file ~/inbox/chart.png` does: the
  // file onto the machine as the person's unsent upload, then the draft.
  const chart = png(900, 500);
  const waiting = await messages.files!.upload(org.orgId, owner.userId, mate.userId, describeDirectMessageUpload(chart, 'chart.png', undefined), chart);
  const draft = await approvals.request({ userId: owner.userId, orgId: org.orgId, agentId: wa.id, to: { userId: mate.userId, name: 'Tamsin Okoro' },
    text: 'Tamsin, here is the **chart** from the review.', files: [waiting] });
  await orgs.touchMember(org.orgId, owner.userId, {
    workspaceAgentSettings: { cli: 'claude', model: 'opus', effort: 'high' },
    workspaceRecapChat: {
      messages: [
        { id: 'o1', role: 'owner' as const, at, text: 'Send Tamsin the chart I sent you.' },
        { id: 'c1', role: 'action' as const, at, text: 'Workspace Agent wants to send Tamsin Okoro a direct message with a file. Nothing will be sent until you approve it here.', messageApprovalId: draft.id },
      ],
      receipts: [], pending: [],
    },
  } as never);
  await a.goto(`${origin}/?org=${org.orgId}`);
  const card = `#recapChatLog [data-message-approval="${draft.id}"]`;
  await a.waitForFunction((selector) => {
    const img = document.querySelector(`${selector} .messageapprovalfiles img`) as HTMLImageElement | null;
    return Boolean(img?.complete && img.naturalWidth > 0);
  }, { timeout: 15_000 }, card);
  check('the card shows the words and the file as a picture', await a.$eval(card, (node) => ({
    words: node.querySelector('.mailapprovaltext')?.textContent, width: (node.querySelector('.messageapprovalfiles img') as HTMLImageElement).naturalWidth,
  })).then((d) => d.words === 'Tamsin, here is the chart from the review.' && d.width === 900));
  check('the teammate cannot see the waiting file', await b.evaluate(async (href) => (await fetch(href, { credentials: 'same-origin' })).status,
    `/workspace/api/messages/${owner.userId}/files/${waiting.id}?org=${org.orgId}`) === 404);
  await a.$eval(card, (node) => node.scrollIntoView({ block: 'center' }));
  await a.screenshot({ path: `${out}/6-card-waiting-phone.png` });
  await settleAfterShot(a);
  await tap(a, `${card} button.btn.primary`);
  await a.waitForFunction((selector) => document.querySelector(`${selector} .chatnoticestatus`)?.textContent === 'Sent', { timeout: 10_000 }, card);
  check('sent: the card keeps neither words nor file', await a.$eval(card, (node) => !node.querySelector('.mailapprovaltext') && !node.querySelector('.messageapprovalfiles')));
  const stored = db.prepare('SELECT doc FROM workspace_message_approvals').all() as Array<{ doc: string }>;
  check('the platform keeps no word or file name of it', !stored.some((one) => /chart/.test(one.doc)));
  await b.goto(conversation(owner.userId));
  await b.waitForFunction(() => {
    const rows = document.querySelectorAll('[role=log] .chatmsg.chatfile[data-message-id]');
    const last = rows[rows.length - 1];
    const img = last?.querySelector('img') as HTMLImageElement | null;
    return Boolean(last?.querySelector('.dmvia') && img?.complete && img.naturalWidth > 0);
  }, { timeout: 15_000 });
  const released = await b.$$eval('[role=log] .chatmsg.chatfile[data-message-id]', (nodes) => {
    const last = nodes.at(-1)!;
    return { caption: (last.querySelector('.chatfilecaption') as HTMLElement).innerText, via: last.querySelector('.dmvia')?.textContent, bold: last.querySelector('strong')?.textContent };
  });
  check('the teammate gets the words and the picture, from the person, marked', released.caption === 'Tamsin, here is the chart from the review.'
    && released.bold === 'chart' && released.via === 'via their Chief of Staff', JSON.stringify(released));
  await b.screenshot({ path: `${out}/7-teammate-cos-desk.png` });

  const unexpected = errors.filter((error) => !/\/api\/messages\/[^/]+\/files\/[^?]+\?org=.*$/.test(error) || !error.startsWith('404'));
  check('no page errors and no failed requests but the outsider\'s refused reads', unexpected.length === 0, JSON.stringify(unexpected));
} finally {
  await browser.close();
  server.close();
  await host.stop();
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log(`\nAll checks passed. Screenshots in ${out}`);
