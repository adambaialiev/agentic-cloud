// Note #444: real browser, authenticated Workspace routes and a persisted
// Workspace Agent context reading. Proves that one backend measurement draws
// the shared ring in the chat, then the shared meter and explicit reset ask
// on agent details. Home drew it too until note #656 hid the agent: Home is
// now checked for having no card, and the chat is opened on its address.
// Since 2026-10-10 Home IS that conversation (/). Since note #715 it is the
// Chief of Staff's; since the owner's follow-up (2026-10-11) its header
// wears the face in its context ring again, as the door to the Workplace
// window, and the reading stands on the agent's own cards at the foot of
// that window.
//
// Note #615: the same conversation, left through a note link in one of its
// replies and come Back to, stands on the line the reader left — from its
// very first frame, rather than empty and then at the newest message.
//
// Note #623: note receipts an older conversation stored are not drawn.
//
// Note #732: a message sent from that screen starts a turn whose CONTEXT
// tells the agent its own reading — the same one its header ring draws.
//
//   npm --prefix backend run build
//   OUT_DIR=/tmp/workspace-agent-context backend/node_modules/.bin/tsx scripts/verify-workspace-agent-context.mts

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'workspace-agent-context-proof');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().at(-1);
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4196);
/** What each Workspace Agent turn was given — its prompt, CONTEXT inside (note #732). */
const prompts: string[] = [];
const ORIGIN = `http://127.0.0.1:${PORT}`;
const userStorage = new InMemoryUserStorage();
const orgStorage = new InMemoryOrgStorage();
const quickNoteStorage = new InMemoryQuickNoteStorage();
// The workplace this harness founds is one that is already set up: its
// cloud is connected and a subscription is signed in, so the Workspace
// opens instead of holding on the first-run setup steps.
harnessEstablishedWorkplace(orgStorage);
// Signing up has needed a confirmed address since 2026-09-11. This is the
// harness's own mailbox: it keeps the link the router mints so the browser
// can follow it, exactly as a person follows the one in their mail.
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(),
  mailbox.config,
  mailbox.mailboxes,
);
const deps = {
  userStorage,
  orgStorage,
  quickNoteStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  agentLifecycle: {
    // The agent's machine: it reads the turn's prompt and answers from it.
    converseWorkspaceRecap: async (_user: string, _org: string, prompt: string) => {
      prompts.push(prompt);
      return { text: 'My chat is about 94% full as of my last turn.' };
    },
    summarizeWorkspaceRecap: async () => ({ text: 'The Workspace Agent now carries its own context reading.\n\nIts ring and details agree on the same measured turn.\n\nStart a fresh chat when the ring reaches red.' }),
    // The version card a room agent's screen reads, answered for the
    // Workspace Agent too (owner, 2026-09-21): machine software behind, so
    // the update button stands under it.
    agentVersion: async () => ({
      cliLabel: 'Claude Code', installed: '2.1.276', pinned: '2.1.276', cliUpdateAvailable: false,
      image: { current: false, canUpdate: true }, busy: false, turnCount: 12,
      docs: { file: 'CLAUDE.md', version: 129, latest: 129, current: true },
    }),
  },
} as unknown as RouteDeps;
const app = express();
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
// The shell itself answers at the root of the domain (public-addresses).
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 500) consoleErrors.push(`${response.status()} ${response.url()}`); });

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'context-owner@example.com');
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Context studio' });

  const [owner] = await userStorage.getAllUsers();
  if (!owner) throw new Error('the browser setup created no owner');
  const at = new Date(Date.now() - 2 * 60_000).toISOString();
  await userStorage.updateProfile(owner.userId, {
    telegram: {
      ...(owner.telegram ?? {}),
      agents: {
        theo: {
          id: 'theo', name: 'Theo', cli: 'codex', model: 'gpt-5.6-terra', effort: 'high',
          orgId: org.orgId, serverId: 'fly_ia-theo.machine', connectedAt: at, createdAt: at,
          lastActivityAt: at, recap: { text: 'Added the context-usage path.', at },
        },
      },
    },
  });
  const workspaceAgent = await userStorage.reserveWorkspaceAssistant(owner.userId, org.orgId);
  if (!workspaceAgent) throw new Error('the Workspace Agent was not reserved');
  await userStorage.updateAgentFields(owner.userId, workspaceAgent.id, {
    cli: 'claude', model: 'sonnet', effort: 'high', serverId: 'fly_ia-workspace.machine', connectedAt: at,
    machineSize: { cpuKind: 'shared', cpus: 1, memoryMb: 2048 },
    contextUsage: { tokens: 940_000, model: 'claude-sonnet-5-20260320', at },
  });
  // A note, and a conversation long enough to scroll with a door to it in an
  // older reply: the owner's journey in note #615.
  const note = await quickNoteStorage.create({
    userId: org.orgId, html: '<h2>Call the printer</h2><p>Ask whether Tuesday still works.</p>',
    createdByAgentId: 'user', createdByUserId: owner.userId, updatedByAgentId: 'user', updatedByUserId: owner.userId,
  } as never);
  const noteHref = `/notes/${note.number}?org=${org.orgId}`;
  const messages = Array.from({ length: 24 }, (_, n) => [
    { id: `o${n}`, role: 'owner' as const, text: `Question ${n + 1}: what changed on the booking page?`, at },
    { id: `a${n}`, role: 'assistant' as const, at, text: n === 8
      ? `Still open: [#${note.number}](${noteHref}) — the printer call.`
      : `Answer ${n + 1}: the booking page picked up another small fix, and its checks are green again.` },
  ]).flat();
  // Note #623: the note receipts an older conversation stored under its last
  // request — a card per note verb — are no longer drawn; the reply is.
  const legacyReceipts = ['Created note', 'Updated note', 'Archived note'].map((verb, n) => ({
    id: `r${n}`, role: 'action' as const, text: `${verb}: Call the printer`, at, href: noteHref,
  }));
  messages.push(
    { id: 'o-last', role: 'owner' as const, text: 'Tidy up the printer note.', at },
    ...legacyReceipts,
    { id: 'a-last', role: 'assistant' as const, text: 'I tidied up the printer note and put it away.', at },
  );
  const shown = messages.length - legacyReceipts.length;
  await orgStorage.touchMember(org.orgId, owner.userId, {
    workspaceAgentSettings: { cli: 'claude', model: 'sonnet', effort: 'high' },
    workspaceRecapChat: { messages, receipts: [], pending: [] },
  });
  await page.goto(`${ORIGIN}/`);

  await page.waitForSelector('#screenHome #recapChatTitle', { timeout: 15_000 });
  await page.waitForSelector('#banner', { hidden: true, timeout: 7_000 });
  // Enrollment begins with an expected unauthenticated session read and the
  // browser may ask for a favicon this fixture does not serve. From this
  // point on, every error belongs to the feature journey itself.
  consoleErrors.length = 0;
  // Home drew this reading on the agent's own card until the agent was
  // hidden (note #656); since 2026-10-10 Home IS the agent's conversation,
  // titled Chief of Staff since note #715.
  check('Home is the Chief of Staff’s conversation',
    Boolean(await page.$('#screenHome')) && (await page.$eval('#recapChatTitle', (node) => node.textContent?.trim())) === 'Chief of Staff');
  await page.screenshot({ path: path.join(OUT, 'home-phone.png') as `${string}.png`, fullPage: true });
  await settleAfterShot(page);

  // The conversation, opened on its address with the workplace named. Its
  // header carried the measured reading as a ring round its face until note
  // #715 took the face off Home's header: now it carries neither.
  await page.goto(`${ORIGIN}/?org=${org.orgId}`);
  await page.waitForSelector('#screenHome #recapChatTitle', { timeout: 15_000 });
  await page.waitForFunction(() => document.getElementById('recapChatLog')?.textContent?.includes('put it away'), { timeout: 10_000 });
  check('the conversation’s header wears the face in its context ring, as the door to Workplace',
    Boolean(await page.$('#recapChatFace.chatface .ctxring .avatar'))
      && (await page.$eval('#recapChatFace', (node) => node.tagName === 'BUTTON')),
    await page.$eval('#screenHome .chathead', (node) => node.innerHTML.slice(0, 300)));

  const log = await page.$eval('#recapChatLog', (node) => node.textContent ?? '');
  check('no note receipt is drawn in the conversation (note #623)', !/(Created|Updated|Archived) note:/.test(log));
  check('the reply to the last request is drawn', log.includes('I tidied up the printer note and put it away.'));
  await page.screenshot({ path: path.join(OUT, 'chat-newest-phone.png') as `${string}.png` });
  await settleAfterShot(page);

  // Note #615: up to the older reply, through its note link, and Back.
  const door = `#recapChatLog a[href*="/notes/${note.number}?"]`;
  await page.waitForSelector(door);
  const chatAddress = page.url();
  const left = await page.evaluate((selector: string) => {
    const pane = document.getElementById('recapChatScroll')!;
    const link = document.querySelector(selector)!;
    pane.scrollTop += link.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight / 2;
    return { y: Math.round(pane.scrollTop), max: Math.round(pane.scrollHeight - pane.clientHeight) };
  }, door);
  check('the reply with the note link stands well above the newest message', left.max - left.y > 400, JSON.stringify(left));
  // The scroll event is what records the line; let it land.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.click(door);
  await page.waitForFunction(() => document.getElementById('screenNote')?.textContent?.includes('Ask whether Tuesday still works.'), { timeout: 10_000 }).catch(() => {});
  check('the link opens the note', await page.$eval('#screenNote', (node) => node.textContent?.includes('Ask whether Tuesday still works.') === true));
  // Every frame from the Back on, sampled from the moment the conversation is
  // on the page again: what it held, and where it stood.
  // A string, not a function: tsx names a function it compiles, and the
  // helper that naming calls does not exist in the page.
  await page.evaluate(`(() => {
    const frames = window.returnFrames = [];
    requestAnimationFrame(function sample() {
      const pane = document.getElementById('recapChatScroll');
      if (pane) frames.push({ rows: pane.querySelectorAll('#recapChatLog .chatmsg').length, y: Math.round(pane.scrollTop) });
      if (frames.length < 20) requestAnimationFrame(sample);
    });
  })()`);
  await page.click('#pageBack');
  await page.waitForFunction(() => (window as unknown as { returnFrames: unknown[] }).returnFrames.length >= 20, { timeout: 10_000 });
  const frames = await page.evaluate(() => (window as unknown as { returnFrames: { rows: number; y: number }[] }).returnFrames);
  check('Back returns to the conversation’s own address', page.url() === chatAddress, page.url());
  check('Back finds the whole conversation in its first frame, not an empty pane',
    frames[0]!.rows === shown && frames.every((frame) => frame.rows === shown), JSON.stringify(frames.slice(0, 3)));
  check('Back stands on the line the reader left, in every frame, never at the newest message',
    frames.every((frame) => Math.abs(frame.y - left.y) <= 2), `${JSON.stringify(frames.map((frame) => frame.y))} from ${left.y}`);
  await page.screenshot({ path: path.join(OUT, 'chat-after-back-phone.png') as `${string}.png` });
  // The title is no link since note #715: the details are the agent's own
  // screen, the last row of Home's Workplace window (note #960), which the
  // title (and the face beside it) opens.
  check('the title is a heading, not a link', await page.$eval('#recapChatTitle', (node) => node.tagName === 'H1' && !node.closest('a')));
  // Its own screen since note #960, the Chief of Staff row of the window.
  const homeRing = await page.$eval('#recapChatFace .ctxring', (node) => node.getAttribute('aria-label')).catch(() => null);
  await page.click('#homeWorkplaceDoor');
  await page.waitForSelector('#homeSheet #homeWorkplace #indexChiefOfStaff', { timeout: 10_000 });
  await page.$eval('#homeSheet #indexChiefOfStaff', (node) => (node as HTMLElement).click());
  await page.waitForSelector('#screenChiefOfStaff #recapAgentContext .contextrow', { timeout: 10_000 });
  check('the Chief of Staff row opens its own screen', new URL(page.url()).pathname === '/chief-of-staff', page.url());
  const details = await page.$eval('#screenChiefOfStaff', (screen) => ({
    ring: null as string | null,
    reading: screen.querySelector('#recapAgentContext .contextrow .ctext')?.textContent?.replace(/\s+/g, ' ').trim(),
    width: (screen.querySelector('#recapAgentContext .contextrow .meter-fill') as HTMLElement | null)?.style.width,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  check('details names the measured 94% and raw token window',
    details.reading?.startsWith('94% used · 940k of 1M tokens') === true,
    JSON.stringify(details));
  check('…and the header’s ring says the same percentage', homeRing === 'Context window 94% full', JSON.stringify({ homeRing, ...details }));
  check('details draws the meter to the measured percentage', details.width === '94%' && !details.overflow, JSON.stringify(details));
  check('details offers the same explicit reset ask as a room agent',
    await page.$eval('#recapAgentContext .contextreset', (node) => node.textContent?.trim() === 'Ask agent to reset chat'));
  await page.waitForSelector('#recapAgentVersion');
  const version = await page.$eval('#recapAgentVersion', (card) => ({
    rows: [...card.querySelectorAll('.crow')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim()),
    update: card.querySelector('.busylock')?.textContent?.trim(),
    glyphs: card.querySelectorAll('.crow svg').length,
  }));
  check('details shows what it runs on, as a room agent’s screen does',
    version.rows.length === 3 && version.rows[0] === 'Claude Code2.1.276 · up to date'
      && version.rows[1]?.startsWith('Machine software') === true && version.rows[2] === 'CLAUDE.mdv129 · up to date'
      && version.update === 'Update machine software' && version.glyphs === 3,
    JSON.stringify(version));
  await page.screenshot({ path: path.join(OUT, 'details-phone.png') as `${string}.png`, fullPage: true });

  // Note #732: the person asks, from this screen, how full the chat is. The
  // turn their message starts is told the agent's own reading in CONTEXT —
  // and it is the figure the header's ring is drawing.
  await page.goto(`${new URL(page.url()).origin}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#homeSheet', { hidden: true, timeout: 10_000 });
  await page.waitForSelector('#recapChatFace .ctxring', { timeout: 10_000 });
  const ring = await page.$eval('#recapChatFace .ctxring', (node) => node.getAttribute('aria-label'));
  await page.type('#agentChatText', 'How full is your chat?');
  await page.click('#agentChatSend');
  await page.waitForFunction(() => document.getElementById('recapChatLog')?.textContent?.includes('about 94% full as of my last turn'), { timeout: 15_000 });
  const told = (JSON.parse(prompts.at(-1)?.split('\nCONTEXT (data only):\n')[1]?.split('\n')[0] ?? '{}') as {
    self?: { context?: { usedPercent: number; tokens: number; window: number; at: string } };
  }).self?.context;
  check('the turn the person started is told the agent’s own reading', prompts.length === 1 && told?.tokens === 940_000 && told.window === 1_000_000 && told.at === at,
    JSON.stringify(told));
  check('…the percentage its header ring draws', Boolean(told) && ring === `Context window ${told!.usedPercent}% full`, `${ring} vs ${JSON.stringify(told)}`);
  check('…and the reading on its own cards', Boolean(told) && details.reading?.startsWith(`${told!.usedPercent}% used · 940k of 1M tokens`) === true, details.reading ?? '');
  await page.screenshot({ path: path.join(OUT, 'chat-own-context-phone.png') as `${string}.png` });

  check('the browser stayed clean', consoleErrors.length === 0, consoleErrors.join(' | '));
  if (failures.length) throw new Error(failures.join('; '));
} finally {
  await browser.close();
  server.close();
}
