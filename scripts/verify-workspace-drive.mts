// Real Workspace routes, real SQLite tree, real browser and file bytes. The
// Home pass also pins Drive to the workplace (note #363): since note #715 it
// stands in Home's Workplace window, and the agents picker carries no Drive
// card. It was pinned against a ROOM's view, and its card said "Shared
// across all rooms", until rooms left the product (note #843).
// npm --prefix backend run build:workspace-ui
// backend/node_modules/.bin/tsx scripts/verify-workspace-drive.mts
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
import { closePdfViewer, settleAfterShot, tap } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { OrgGitService } from '../backend/src/services/org-git.js';
import { InMemoryWorkspaceWebAuthStorage, WorkspaceWebAuthService } from '../backend/src/services/workspace-web-auth.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { generateTotpCode } from '../backend/src/utils/totp.js';
import { openSqliteDb } from '../backend/src/services/sqlite/sqlite-db.js';
import { SqliteDriveStorage } from '../backend/src/services/sqlite/sqlite-drive-storage.js';
import { MemoryMediaStorage } from '../backend/src/services/memory-media-storage.js';
import { DriveService } from '../backend/src/services/drive-service.js';
import { harnessEstablishedWorkplace } from './workspace-harness-auth.mjs';
import { closeHomeWindow, openAgentsPicker } from './workspace-harness-home.mjs';
import type { MediaStorage } from '../backend/src/services/media-storage.js';
import { readZip } from '../backend/src/test/unit/zip-reader.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const out = process.env.OUT_DIR || '/home/agent/mini-preview';
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), 'drive-browser-'));
const users = new InMemoryUserStorage();
const orgs = new InMemoryOrgStorage();
// Past the setup gate, or none of the Workspace is mounted and every wait
// below times out on a screen reading "Connect your Fly cloud". Drive is
// what this harness is about; the workplace around it is scenery.
harnessEstablishedWorkplace(orgs);
const db = openSqliteDb(path.join(scratch, 'drive.sqlite'));
const driveStorage = new SqliteDriveStorage(db);
await users.createProfile('viewer', { email: 'drive@example.test', firstName: 'Saddam' });
const org = await orgs.createOrg({ name: 'Studio', createdByUserId: 'viewer', git: { namespaceId: 'viewer' } });
await orgs.addMember({ orgId: org.orgId, userId: 'viewer', role: 'admin' });
const auth = new WorkspaceWebAuthService(new InMemoryWorkspaceWebAuthStorage(), users, new SecretCipher(randomBytes(32).toString('base64')));
const enrollment = await auth.startEnrollment('drive_viewer', 'viewer');
const issued = await auth.finishEnrollment({ enrollmentToken: enrollment.enrollmentToken, code: generateTotpCode(enrollment.secret), authenticatedUserId: 'viewer' });
const objects = new Map<string, { data: Buffer; contentType: string }>();
const parted = new MemoryMediaStorage();
let origin = '';
const media = {
  async uploadObject({ storagePath, data, contentType }) { objects.set(storagePath, { data: Buffer.from(data as Uint8Array), contentType }); },
  async createReadAccess({ storagePath, promptSaveAs, responseDisposition }) { return {
    url: `${origin}/objects/${encodeURIComponent(storagePath)}?save=${encodeURIComponent(promptSaveAs ?? '')}&disposition=${encodeURIComponent(responseDisposition ?? '')}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }; },
  async downloadObject({ storagePath }) { return objects.get(storagePath)!.data; },
  async deleteObject({ storagePath }) { objects.delete(storagePath); },
  // A big file in parts (note #784): held apart until stitched, then served
  // from the same map as every other object.
  startMultipart: (args) => parted.startMultipart(args),
  uploadPart: (args) => parted.uploadPart(args),
  async completeMultipart(args) {
    const done = await parted.completeMultipart(args);
    objects.set(args.storagePath, parted.objects.get(args.storagePath)!);
    return done;
  },
  abortMultipart: (args) => parted.abortMultipart(args),
} as MediaStorage;
const service = new DriveService(driveStorage, media);
const actor = { orgId: org.orgId, userId: 'viewer', canDeleteForever: true };
const brand = await service.folder(actor, 'Brand assets', null);
await service.folder(actor, 'Documents', null);
await service.folder(actor, 'Project exports', null);
const welcome = await service.upload(actor, 'Welcome.txt', null, Buffer.from('A shared home for your files.'));
const campaign = await service.upload(actor, 'Campaign notes.md', null, Buffer.from('# Campaign\n\nIdeas for the **next launch**.'));
const makePdf = (words: string) => {
  const stream = `BT /F1 24 Tf 72 720 Td (${words.replace(/[()\\]/g, (char) => `\\${char}`)}) Tj ET`;
  const records = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  records.forEach((record, at) => { offsets.push(Buffer.byteLength(body)); body += `${at + 1} 0 obj\n${record}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${records.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${records.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
};
const pdfBytes = makePdf('Drive PDF preview');
const pdf = await service.upload(actor, 'Quarterly brief.pdf', null, pdfBytes);
const photo = await service.upload(actor, 'Profile photo.jpg', brand.id, readFileSync(path.join(root, 'backend/assets/agent-avatars/ada.jpg')));
/** A few seconds of a plain tone, as the WAV bytes a recorder would save. */
const makeWav = (seconds: number, hz: number) => {
  const rate = 8000; const samples = seconds * rate;
  const wav = Buffer.alloc(44 + samples);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples, 40);
  for (let at = 0; at < samples; at++) wav[44 + at] = 128 + Math.round(40 * Math.sin(2 * Math.PI * hz * at / rate));
  return wav;
};
const sounds = await service.folder(actor, 'Sounds', null);
await service.upload(actor, 'Morning tone.wav', sounds.id, makeWav(4, 440));
await service.upload(actor, 'Evening tone.wav', sounds.id, makeWav(3, 330));
const old = await service.upload(actor, 'Earlier draft.txt', null, Buffer.from('Previous draft'));
await service.trash(actor, old.id);
const app = express(); app.use(express.json());
app.get('/objects/:key', (req, res) => {
  const object = objects.get(req.params.key);
  if (!object) return res.status(404).end();
  res.type(object.contentType);
  if (req.query.save) res.attachment(String(req.query.save));
  else if (req.query.disposition) res.setHeader('Content-Disposition', String(req.query.disposition));
  res.end(object.data);
});
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
app.use(workspaceRootRoutes()); // the shell answers at the root of the domain (public-addresses)
app.use('/workspace', workspaceRoutes({ userStorage: users, orgStorage: orgs,
  orgGit: new OrgGitService({ orgStorage: orgs }), workspaceWebAuth: auth, workspaceWebOrigin: origin,
  workspaceUiDir: path.join(root, 'backend/dist/workspace-ui'), driveStorage, mediaStorage: media } as RouteDeps));
// The browser puppeteer downloaded, wherever this machine keeps it. Read off
// HOME rather than a name: CI runs as root, and a path spelled `/home/agent`
// is a harness that only ever runs on the machine it was written on — which
// is what this one was until 2026-09-15, when it was the only red one in the
// first CI run of the whole set.
const cache = process.env.CHROME_CACHE
  || path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
const build = readdirSync(cache).filter((entry) => entry.startsWith('linux-')).sort().at(-1)!;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || path.join(cache, build, 'chrome-linux64/chrome'),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  await browser.setCookie({ name: 'acc_session', value: issued.token, url: origin }, { name: 'acc_csrf', value: issued.csrfToken, url: origin });
  const open = async (suffix = '') => { await page.goto(`${origin}/drive${suffix}${suffix.includes('?') ? '&' : '?'}org=${org.orgId}`); };
  const button = async (label: string) => {
    const handle = await page.waitForSelector(`button::-p-text(${label})`);
    assert(handle, `button ${label}`); await handle.click();
  };
  const title = (name: string) => page.waitForFunction((text) => document.querySelector('#pageHead h1')?.textContent === text, {}, name);
  const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'fits the viewport');
  // Drive's card stands in Home's Workplace window (note #715; the overview's
  // old address opens it), and says it is the whole workplace's.
  await page.goto(`${origin}/overview?org=${org.orgId}&half=workplace`);
  await page.waitForSelector('#homeSheet #homeWorkplace #driveCard');
  const homeDrive = await page.$eval('#driveCard', (drive) => drive.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  assert.match(homeDrive, /Shared across the workplace/); await noOverflow();
  assert.doesNotMatch(homeDrive, /\broom/i, 'Drive names no room: rooms left the product (note #843)');
  await page.$eval('#driveHead', (element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(out, 'n363-drive-home-mobile.png') });
  // Home stands its window up again on a reload, so close it first.
  await closeHomeWindow(page);
  await openAgentsPicker(page, origin);
  assert.equal(await page.$('#agentSwitchSheet #driveCard'), null, 'the agents picker carries no Drive card: Drive is the workplace’s');
  await open();
  await page.waitForSelector('#driveItems .driverow'); await title('Drive'); await noOverflow();
  await page.screenshot({ path: path.join(out, 'n298-drive-mobile.png'), fullPage: true });
  await settleAfterShot(page);
  await page.click('a::-p-text(Welcome.txt)'); await title('Welcome.txt');
  await page.waitForFunction(() => document.querySelector('.code')?.textContent?.includes('A shared home for your files.'));
  assert.equal((await service.preview(actor, welcome.id)).kind, 'text');
  await open(); await tap(page, 'a::-p-text(Campaign notes.md)'); await title('Campaign notes.md');
  await page.waitForFunction(() => document.querySelector('#screenDriveFile .md h1')?.textContent === 'Campaign');
  assert.equal(await page.$eval('#screenDriveFile .md strong', (element) => element.textContent), 'next launch');
  await page.screenshot({ path: path.join(out, 'n-drive-markdown-preview.png'), fullPage: true });
  await button('View raw');
  assert.match(await page.$eval('.code .lines', (element) => element.textContent ?? ''), /\*\*next launch\*\*/);
  assert.equal((await service.preview(actor, campaign.id)).kind, 'markdown');
  await open(); await tap(page, 'a::-p-text(Quarterly brief.pdf)'); await title('Quarterly brief.pdf');
  const pdfFrame = await page.waitForSelector('iframe[title="Preview of Quarterly brief.pdf"]'); assert(pdfFrame);
  const frameBox = await pdfFrame.boundingBox(); assert(frameBox && frameBox.height >= 450 && frameBox.width <= 420);
  const framedDocument = await pdfFrame.contentFrame();
  assert(framedDocument); await framedDocument.waitForSelector('link[href*="pdf_embedder.css"]');
  const pdfUrl = await pdfFrame.evaluate((element) => (element as HTMLIFrameElement).src);
  const pdfResponse = await fetch(pdfUrl);
  assert.equal(pdfResponse.headers.get('content-type'), 'application/pdf');
  assert.equal(pdfResponse.headers.get('content-disposition'), 'inline');
  assert.deepEqual(Buffer.from(await pdfResponse.arrayBuffer()), pdfBytes);
  assert.equal((await service.preview(actor, pdf.id)).kind, 'pdf');
  await page.screenshot({ path: path.join(out, 'n-drive-pdf-preview.png'), fullPage: true });
  await settleAfterShot(page);
  // Everything this harness has to say about the PDF has been said. Close the
  // viewer before navigating: Chrome's PDF frame holds its fetch of the
  // document open, and Puppeteer will not call a navigation finished while a
  // frame it knows about is still loading — see browser-settle.mjs.
  await closePdfViewer(page, pdfFrame);
  await open(); await page.waitForSelector('#driveItems .driverow');
  await button('New folder');
  await page.type('input[aria-label="Folder name"]', 'Client work');
  await button('Create folder');
  await tap(page, 'a::-p-text(Client work)'); await title('Client work');
  const uploadPath = path.join(scratch, 'Brief — final.txt');
  writeFileSync(uploadPath, 'The final brief, uploaded from the browser.');
  const picker = await page.$('input[type=file]'); assert(picker); await picker.uploadFile(uploadPath);
  await page.waitForSelector('a::-p-text(Brief — final.txt)');
  const held = [...(await driveStorage.read(org.orgId)).values()].find((entry) => entry.name === 'Brief — final.txt');
  assert(held?.storagePath); assert.equal(objects.get(held.storagePath)?.data.toString(), 'The final brief, uploaded from the browser.');
  // Note #784: a file past one part goes up in parts, the status line counts
  // it up, and what lands is byte for byte what was picked.
  const bigPath = path.join(scratch, 'Screen recording.mov');
  const bigBytes = Buffer.alloc(20 * 1024 * 1024 + 777);
  for (let index = 0; index < bigBytes.length; index += 4093) bigBytes[index] = index % 251;
  writeFileSync(bigPath, bigBytes);
  await page.evaluate(`window.__progress = [];
    new MutationObserver(function () {
      var line = document.getElementById('driveUploading');
      if (line && line.textContent) window.__progress.push(line.textContent);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });`);
  const bigPicker = await page.$('input[type=file]'); assert(bigPicker); await bigPicker.uploadFile(bigPath);
  await page.waitForSelector('a::-p-text(Screen recording.mov)', { timeout: 60_000 });
  const bigHeld = [...(await driveStorage.read(org.orgId)).values()].find((entry) => entry.name === 'Screen recording.mov');
  assert(bigHeld?.storagePath);
  assert.equal(bigHeld.sizeBytes, bigBytes.length);
  assert.ok(objects.get(bigHeld.storagePath)!.data.equals(bigBytes), 'the big file landed byte for byte');
  const progress = await page.evaluate('window.__progress') as string[];
  assert.ok(progress.some((line) => /Screen recording\.mov… \d+%/.test(line)), `progress was shown: ${JSON.stringify(progress.slice(0, 5))}`);
  assert.equal(parted.uploads.size, 0);
  console.log(`big upload: ${bigBytes.length} bytes in parts, progress lines ${JSON.stringify([...new Set(progress)].slice(0, 6))}`);
  // Note #520: walking in and out of a folder must not blank what this tab has
  // already read. The observer runs ACROSS the tap, so a list taken off the
  // screen for even one commit — or a heading falling back to a placeholder
  // word — is caught here, where a screenshot taken after it settled never
  // could. Passed as a string: under tsx, a named arrow inside `evaluate`
  // reaches the page as `__name is not defined`.
  const watchWalk = () => page.evaluate(`window.__walk = { blanked: false, heads: [] };
    new MutationObserver(function () {
      if (!document.querySelector('#driveItems')) window.__walk.blanked = true;
      var head = document.querySelector('#pageHead h1');
      if (head && head.textContent) window.__walk.heads.push(head.textContent);
    }).observe(document.body, { childList: true, subtree: true });`);
  const walked = async () => await page.evaluate('window.__walk') as { blanked: boolean; heads: string[] };
  const crumb = async (index: number) => { const links = await page.$$('.drivecrumb a'); assert(links[index]); await links[index]!.click(); };
  await crumb(0); await title('Drive'); await page.waitForSelector('#driveItems .driverow');
  await watchWalk();
  await page.click('a::-p-text(Client work)'); await title('Client work');
  const backIn = await walked();
  assert.equal(backIn.blanked, false, 'a folder already read is drawn without its list being taken away first');
  assert.equal(backIn.heads.includes('Drive'), false, 'the heading goes straight to the folder, never back through the word Drive');
  await watchWalk();
  await page.click('a::-p-text(Brief — final.txt)'); await title('Brief — final.txt');
  assert.equal((await walked()).heads.includes('File'), false, 'a file opens on the name its own row already carried');
  await crumb(1); await title('Client work'); await page.waitForSelector('a::-p-text(Brief — final.txt)');
  await page.click('button[aria-label="Manage Brief — final.txt"]');
  await page.$eval('input[aria-label="Item name"]', (element) => (element as HTMLInputElement).select());
  await page.type('input[aria-label="Item name"]', 'Final brief.txt'); await button('Save name');
  await page.waitForSelector('a::-p-text(Final brief.txt)');
  await page.click('button[aria-label="Manage Final brief.txt"]'); await button('Move to folder');
  await button('Move here');
  await page.waitForFunction(() => !document.getElementById('screenDriveManage'));
  assert.equal((await service.detail(actor, held.id)).item.parentId, null);
  await open(); await page.waitForSelector('a::-p-text(Final brief.txt)');
  await page.type('input[aria-label="Search Drive"]', 'photo'); await button('Search');
  await tap(page, 'a::-p-text(Profile photo.jpg)'); await title('Profile photo.jpg');
  await page.waitForFunction(() => { const img = document.querySelector('.drivepreview img') as HTMLImageElement | null; return img && img.naturalWidth > 0; });
  await page.screenshot({ path: path.join(out, 'n298-drive-preview.png'), fullPage: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: scratch });
  await button('Download');
  const downloaded = path.join(scratch, 'Profile photo.jpg');
  const deadline = Date.now() + 10_000;
  while (!existsSync(downloaded) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(readFileSync(downloaded), objects.get(`users/${org.orgId}/drive/${photo.id}`)!.data);
  const access = await service.access(actor, photo.id, false);
  assert.deepEqual(Buffer.from(await (await fetch(access.url)).arrayBuffer()), objects.get(`users/${org.orgId}/drive/${photo.id}`)!.data);
  // Note #694: a picture is drawn as itself in its folder's list, through the
  // row's own address on the reader's session, and the folder saves as ONE
  // .zip holding exactly the bytes Drive holds.
  await open(`/folders/${brand.id}`); await title('Brand assets');
  await page.waitForFunction(() => {
    const img = document.querySelector('#driveItems .drivemark img') as HTMLImageElement | null;
    return Boolean(img && img.complete && img.naturalWidth > 0);
  });
  await page.screenshot({ path: path.join(out, 'n694-drive-picture-row.png') });
  await button('Download folder');
  const zipped = path.join(scratch, 'Brand assets.zip');
  const zipDeadline = Date.now() + 10_000;
  while (!existsSync(zipped) && Date.now() < zipDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const archive = readZip(readFileSync(zipped));
  assert.deepEqual(archive.map((entry) => entry.path), ['Brand assets/', 'Brand assets/Profile photo.jpg']);
  assert.deepEqual(archive[1]!.data, objects.get(`users/${org.orgId}/drive/${photo.id}`)!.data);
  // Note #698: a recording plays from its own row. Its mark is its play
  // button, the press starts real sound through the row's own address, the
  // line under its name counts, pause holds it, a second row takes the one
  // player over, and a track that reaches its end puts its play button back.
  await open(`/folders/${sounds.id}`); await title('Sounds');
  const soundLine = (name: string) => page.$$eval('#driveItems .driverow', (rows, wanted) => rows
    .find((row) => row.querySelector('.name')?.textContent === wanted)?.querySelector('.cline')?.textContent ?? '', name);
  await tap(page, 'button[aria-label="Play Morning tone.wav"]');
  await page.waitForSelector('button[aria-label="Pause Morning tone.wav"]');
  await page.waitForFunction(() => [...document.querySelectorAll('#driveItems .cline')]
    .some((line) => /· 0:0[1-3] \/ 0:04$/.test(line.textContent ?? '')));
  await page.screenshot({ path: path.join(out, 'n698-drive-audio-playing.png') });
  await page.click('button[aria-label="Pause Morning tone.wav"]');
  await page.waitForSelector('button[aria-label="Play Morning tone.wav"]');
  const paused = await soundLine('Morning tone.wav');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(await soundLine('Morning tone.wav'), paused, 'a paused track holds where it was');
  await page.click('button[aria-label="Play Evening tone.wav"]');
  await page.waitForSelector('button[aria-label="Pause Evening tone.wav"]');
  await page.waitForSelector('button[aria-label="Play Morning tone.wav"]');
  assert.match(await soundLine('Morning tone.wav'), /^\d+(\.\d)? KB$/, 'the row the player left goes back to its size');
  await page.waitForSelector('button[aria-label="Play Evening tone.wav"]', { timeout: 15_000 });
  assert.match(await soundLine('Evening tone.wav'), /^\d+(\.\d)? KB$/, 'a track that ended puts its play button back');
  await open(); await page.waitForSelector('button[aria-label="Manage Brand assets"]');
  await page.click('button[aria-label="Manage Brand assets"]'); await button('Move to Trash');
  await page.click('.ask .btn.primary');
  await page.waitForFunction(() => !document.getElementById('screenDriveManage'));
  await open('/trash'); await title('Trash');
  await page.waitForSelector('button[aria-label="Manage Brand assets"]');
  await page.screenshot({ path: path.join(out, 'n298-drive-trash.png'), fullPage: true });
  await settleAfterShot(page);
  await page.click('button[aria-label="Manage Brand assets"]'); await button('Restore');
  await page.waitForFunction(() => !document.getElementById('screenDriveManage'));
  assert.equal((await service.detail(actor, photo.id)).item.trashedAt, undefined);
  // Note #521: Drive is ONE place in the browser's history. Driven from Home,
  // because that is where the rule starts — the row is named after the place
  // it opens — and two steps in, the header's Back is the way OUT rather than
  // the way up, which is the breadcrumbs' job. Forward proves the walk itself
  // spent nothing: the single entry Drive made is still standing, at the
  // address its last step wrote.
  await page.goto(`${origin}/overview?org=${org.orgId}&half=workplace`);
  await page.waitForSelector('#homeSheet #driveCard');
  assert.equal(await page.$eval('#driveCard .name', (element) => element.textContent), 'Drive');
  // Every tap in this walk goes through `tap`, because every one of them
  // follows a READ rather than a picture: Home fills in under its own cards,
  // and each Drive screen draws its frame before its contents. CI lost both
  // of its 2026-09-17 attempts inside these four lines — the first on the
  // card below ("not clickable": the row moved as Home filled in), the second
  // on the file two lines under it ("no element found": the folder's contents
  // had not arrived).
  await tap(page, '#driveCard a'); await title('Drive');
  await page.waitForSelector('#driveItems .driverow');
  await tap(page, 'a::-p-text(Brand assets)'); await title('Brand assets');
  // This heading comes from the outline the previous listing already carried
  // (`drive-cache.ts` — the name and trail are never in doubt, only the
  // contents), so waiting for it is NOT waiting for the row below it.
  await tap(page, 'a::-p-text(Profile photo.jpg)'); await title('Profile photo.jpg');
  await page.click('#pageBack'); await page.waitForSelector('#homeSheet #homeWorkplace #driveCard');
  assert.equal(new URL(page.url()).pathname, '/', 'one tap of Back leaves Drive for Home’s Workplace window it was opened from');
  await page.goForward(); await title('Profile photo.jpg');
  await page.goBack(); await page.waitForSelector('#homeSheet #homeWorkplace #driveCard');
  assert.equal(new URL(page.url()).pathname, '/', 'the browser back button leaves Drive by the same entry');
  await open(); await page.waitForSelector('#driveItems .driverow');
  await page.setViewport({ width: 320, height: 700, deviceScaleFactor: 1 }); await noOverflow();
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 }); await noOverflow();
  await page.screenshot({ path: path.join(out, 'n298-drive-desktop.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: Drive in Home’s Workplace window and not in the agents picker; text, formatted/raw Markdown, PDF and image previews; folder creation, upload bytes, rename, move, workplace URLs, search, download bytes, a picture drawn in its row and its folder saved as one .zip, recordings played and paused from their rows, trash/restore tree, a walk in and out that never blanks a list or a heading, a Drive row named Drive and one tap of Back out of a file two steps deep, 320/420/1200px, no browser errors.');
  console.log(`Screenshots: ${out}/n363-drive-home-mobile.png, ${out}/n-drive-*-preview.png and ${out}/n298-drive-*.png`);
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close(); rmSync(scratch, { recursive: true, force: true });
}
