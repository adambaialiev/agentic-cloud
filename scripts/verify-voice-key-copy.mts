// Note #1116 (Adam, 10 Nov 2026): "if in some workplace it's already set up,
// why in other workplace I can't set it up automatically reusing the key …
// If I am admin for both of course."
//
// In real Chrome, against the REAL router and the REAL voice service (only
// OpenRouter's key check and the transcription itself are stand-ins): a
// person who is an admin of two workplaces, one with a dictation key saved
// and one without, presses a microphone in the one without. The "not set up"
// screen offers "Use the key from Eldiiar"; one tap copies the key on the
// server, the screen says the two are not linked, and the next press
// records. The key's value is checked to never reach the browser, and the
// Workplace screen then names where the copy came from.
//
//   npm --prefix backend run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-voice-key-copy.mts
//
// `CHROME=<path>` overrides the browser. Screenshots land in $OUT_DIR
// (default ~/mini-preview).
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { tap } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { OrgSecretsService } from '../backend/src/services/org-secrets.js';
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
import { InMemorySecretStorage } from '../backend/src/services/secret-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { VOICE_KEY_SECRET_NAME, WorkplaceVoiceService } from '../backend/src/services/workplace-voice.js';
import { InMemoryWorkspaceWebAuthStorage, WorkspaceWebAuthService } from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().at(-1);
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4197);
const ORIGIN = `http://127.0.0.1:${PORT}`;
// A key-shaped value, so a leak is findable byte for byte.
const KEY = `sk-or-v1-${randomBytes(32).toString('hex')}`;
const TAIL = KEY.slice(-12);

const userStorage = new InMemoryUserStorage();
const orgStorage = new InMemoryOrgStorage();
harnessEstablishedWorkplace(orgStorage);
const orgSecrets = new OrgSecretsService(new InMemorySecretStorage());
const checked: string[] = [];
const recorded: string[] = [];
const workplaceVoice = new WorkplaceVoiceService({
  orgStorage,
  orgSecrets,
  openRouter: {
    checkKey: async (key: string) => { checked.push(key); return 'ok'; },
    creditLeft: async () => 7.25,
    transcriptionModels: async () => [],
  },
  transcriber: { transcribe: async (args) => { recorded.push(args.apiKey); return { text: 'ship it on Friday', seconds: 2, costUsd: 0.0001 }; } },
  pauseReasonFor: () => null,
});
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(), userStorage, new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(), mailbox.config, mailbox.mailboxes,
);
const deps = {
  userStorage, orgStorage, workspaceWebAuth, workplaceVoice,
  quickNoteStorage: new InMemoryQuickNoteStorage(),
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
} as unknown as RouteDeps;
const app = express();
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['microphone']);
  const consoleErrors: string[] = [];
  const leaks: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', async (response) => {
    if (response.status() >= 500) consoleErrors.push(`${response.status()} ${response.url()}`);
    if (!response.url().includes('/workspace/api/')) return;
    const body = await response.text().catch(() => '');
    if (body.includes(TAIL)) leaks.push(response.url());
  });

  // Adam's shape: an admin of two workplaces. Eldiiar has its key; Studio,
  // where he is standing, has none.
  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'adam-two@example.com', { firstName: 'Adam', lastName: 'B' });
  const eldiiar = await orgStorage.createOrg({ name: 'Eldiiar', createdByUserId: account.userId });
  await orgStorage.addMember({ orgId: eldiiar.orgId, userId: account.userId, role: 'admin' });
  await workplaceVoice.saveKey(eldiiar.orgId, KEY, 'Adam B');
  checked.length = 0;
  const { org: studio } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Studio' });

  // 1. A microphone in Studio: the note composer's.
  await page.goto(`${ORIGIN}/notes?org=${studio.orgId}`, { waitUntil: 'networkidle0' });
  await tap(page, '#notesAddBtn');
  await page.waitForSelector('#screenNoteNew .voicebtn', { timeout: 15_000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await tap(page, '#screenNoteNew .voicebtn');
  await page.waitForSelector('dialog.voiceblocked[open]', { timeout: 15_000 });
  const offer = await page.$eval('dialog.voiceblocked', (node) => node.textContent ?? '');
  check('the "not set up" screen offers the key from the other workplace',
    offer.includes('You already saved a key in Eldiiar') && offer.includes('Use the key from Eldiiar'), offer.slice(0, 160));
  await page.screenshot({ path: path.join(OUT, 'n1116-mic-offer.png') });

  // 2. One tap.
  await tap(page, 'dialog.voiceblocked .voiceblocked-copy');
  await page.waitForFunction(() => document.querySelector('dialog.voiceblocked')?.textContent?.includes('Voice-to-text is on'), { timeout: 15_000 });
  const done = await page.$eval('dialog.voiceblocked', (node) => node.textContent ?? '');
  check('one tap turns it on and says the two are not linked',
    done.includes('its own copy of the key from Eldiiar') && done.includes('does not change the other'), done.slice(0, 200));
  await page.screenshot({ path: path.join(OUT, 'n1116-mic-copied.png') });
  check('the copy is Studio’s own secret, the same value, checked with OpenRouter first',
    await orgSecrets.getOrgSecret(studio.orgId, VOICE_KEY_SECRET_NAME) === KEY && checked.length === 1);

  // 3. The next press records, on Studio's copy.
  await tap(page, 'dialog.voiceblocked .btn.primary');
  await page.waitForFunction(() => !document.querySelector('dialog.voiceblocked'), { timeout: 10_000 });
  await tap(page, '#screenNoteNew .voicebtn');
  await page.waitForSelector('.voicereview-stop', { timeout: 15_000 });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await tap(page, '.voicereview-stop');
  await page.waitForFunction(
    () => (document.querySelector('.voicereview-text') as HTMLTextAreaElement | null)?.value.includes('Friday'),
    { timeout: 20_000 },
  );
  check('the next press records and transcribes', recorded.length === 1 && recorded[0] === KEY);
  await tap(page, '.voicereview-back');

  // 4. Removing the key in Eldiiar leaves Studio's copy where it is.
  await workplaceVoice.removeKey(eldiiar.orgId);
  check('removing the key in Eldiiar does not touch Studio’s copy',
    (await workplaceVoice.state(studio.orgId)).state === 'on' && await orgSecrets.getOrgSecret(eldiiar.orgId, VOICE_KEY_SECRET_NAME) === null);

  // 5. The Workplace screen names where it came from.
  await page.goto(`${ORIGIN}/workplace?org=${studio.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.getElementById('orgVoiceCard')?.textContent?.includes('copied by'), { timeout: 15_000 });
  const section = await page.$eval('#orgVoice', (node) => node.textContent ?? '');
  check('the Workplace screen says it is a copy from Eldiiar, kept apart',
    section.includes('copied by Adam B from Eldiiar') && section.includes('does not change Eldiiar'), section.slice(0, 240));
  const voice = await page.$('#orgVoice');
  await voice!.screenshot({ path: path.join(OUT, 'n1116-workplace-copied.png') });

  check('the key’s value never reached the browser', leaks.length === 0, leaks.join(', '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
