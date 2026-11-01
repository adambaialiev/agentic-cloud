/**
 * Note #945, in real Chrome: the recap line under the latest completed turn,
 * in an agent's chat and in the Chief of Staff's (Home) — the owner's "recap line
 * like in terminal claude code". Two muted lines: the turn's facts, then the
 * row recap in italics, centred in the conversation column on a phone and at
 * a desk. Before this turn's summary lands the facts stand alone; when it
 * lands it appears in place, with no reload, and nothing above it moves.
 *
 *   npm --prefix backend run build:workspace-ui
 *   OUT_DIR=/tmp/shots backend/node_modules/.bin/tsx scripts/verify-workspace-turn-recap.mts
 *
 * `--shell <dir>` serves a different built shell (main's, say) and `--shots`
 * only takes the pictures, asserting nothing — how the "before" pictures on
 * the proposal were made.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { OrgGitService } from '../backend/src/services/org-git.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'turn-recap-proof');
mkdirSync(OUT, { recursive: true });
const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};
const SHELL = flag('--shell', path.join(REPO, 'backend/dist/workspace-ui'));
const SHOTS_ONLY = process.argv.includes('--shots');
const PREFIX = flag('--prefix', SHOTS_ONLY ? 'before' : 'after');

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().at(-1);
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4198);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const userStorage = new InMemoryUserStorage();
const orgStorage = new InMemoryOrgStorage();
harnessEstablishedWorkplace(orgStorage);
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(),
  mailbox.config,
  mailbox.mailboxes,
);

const now = Date.now();
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
/** Oscar's conversation: an ask, the work, the reply that ended the turn. */
const oscarRows = [
  { seq: 1, role: 'owner' as const, text: 'Set up our own Agentic Cloud at agents.example.site, please.', at: ago(140) },
  { seq: 2, role: 'agent' as const, text: 'On it — creating the Fly organisation and the installer config now.', at: ago(130) },
  {
    seq: 3, role: 'agent' as const, at: ago(15),
    text: 'The install is ready and **paused on DNS**. Add these records at your registrar:\n\n'
      + '| Type | Name | Value |\n|---|---|---|\n| CNAME | agents | edge.example.net |\n| TXT | _acme | 4f1c… |\n\n'
      + 'Then reply **done** and I will check them and finish.',
  },
];
/** Whether the agent's machine still runs a job past its turn. */
const oscarJobs = [{ id: 'j_111111111111111111111111', label: 'npm run build', startedAt: ago(20) }];

const deps = {
  userStorage,
  orgStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: SHELL,
  orgGit: new OrgGitService({ orgStorage }),
  agentLifecycle: {
    agentChatMessages: async (_user: string, agentId: string, after: number) => (agentId === 'oscar' ? oscarRows.filter((row) => row.seq > after) : []),
    isAgentWorking: () => false,
    listManagedJobs: async (_user: string, agentId: string) => ({ jobs: agentId === 'oscar' ? oscarJobs : [], recent: [] }),
  },
} as unknown as RouteDeps;
const app = express();
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
app.use(workspaceRootRoutes({ workspaceUiDir: SHELL }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  if (SHOTS_ONLY) return;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}.png`) as `${string}.png` });
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

/**
 * Where the line sits against the column its conversation is read in: the
 * centre of each of its paragraphs against the centre of the pane's content
 * box, and its edges inside that box.
 */
async function placement(page: Page, line: string, pane: string) {
  return page.evaluate((lineSel, paneSel) => {
    const node = document.querySelector(lineSel);
    const scroller = document.querySelector(paneSel) as HTMLElement | null;
    if (!node || !scroller) return null;
    const box = scroller.getBoundingClientRect();
    const style = getComputedStyle(scroller);
    const left = box.left + parseFloat(style.paddingLeft);
    const right = box.right - parseFloat(style.paddingRight);
    const centre = (left + right) / 2;
    const parts = [...node.querySelectorAll('p')].map((p) => {
      const range = document.createRange();
      range.selectNodeContents(p);
      const r = range.getBoundingClientRect();
      return { centre: (r.left + r.right) / 2, left: r.left, right: r.right, italic: getComputedStyle(p).fontStyle, colour: getComputedStyle(p).color, size: getComputedStyle(p).fontSize };
    });
    const last = [...document.querySelectorAll(`${paneSel} .chatmsg`)].at(-1)?.getBoundingClientRect();
    return { centre, left, right, parts, below: last ? node.getBoundingClientRect().top >= last.bottom - 1 : true, align: getComputedStyle(node).textAlign };
  }, line, pane);
}
const centred = (where: Awaited<ReturnType<typeof placement>>) => Boolean(where && where.parts.length
  && where.parts.every((part) => Math.abs(part.centre - where.centre) <= 2 && part.left >= where.left - 1 && part.right <= where.right + 1));

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('response', (response) => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'recap-owner@example.com');
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Nomad Trading' });
  const [owner] = await userStorage.getAllUsers();
  if (!owner) throw new Error('the browser setup created no owner');
  const userId = owner.userId;
  await userStorage.updateProfile(userId, {
    telegram: {
      ...(owner.telegram ?? {}),
      agents: {
        oscar: {
          id: 'oscar', name: 'Oscar', cli: 'claude', model: 'opus', effort: 'high',
          orgId: org.orgId, serverId: 'fly_ia-oscar.machine', connectedAt: ago(3600), createdAt: ago(3600), lastActivityAt: ago(15),
          // The turn ended 12 s ago after 2 min 4 s of work; the recap on
          // record is the turn BEFORE's, so this turn's has not landed yet.
          lastTurnStartedAt: ago(136), lastTurnEndedAt: ago(12),
          recap: { text: 'Drafted the pricing page copy. It waits on your review.', at: ago(7200) },
        },
      },
    },
  });
  const workspaceAgent = await userStorage.reserveWorkspaceAssistant(userId, org.orgId);
  if (!workspaceAgent) throw new Error('the Workspace Agent was not reserved');
  await userStorage.updateAgentFields(userId, workspaceAgent.id, {
    cli: 'claude', model: 'opus', effort: 'high', serverId: 'fly_ia-workspace.machine', connectedAt: ago(3600),
    lastTurnStartedAt: ago(74), lastTurnEndedAt: ago(10),
    recap: { text: 'Asked Oscar to set up your own cloud; he is paused on DNS. Next, add the records he listed, then tell him "done".', at: ago(4) },
  });
  await orgStorage.touchMember(org.orgId, userId, {
    workspaceAgentSettings: { cli: 'claude', model: 'opus', effort: 'high' },
    workspaceRecapChat: {
      // Asked after Oscar's last turn ended, so the wait is still open: a turn
      // end later than the ask would close it as "finished without a reply".
      receipts: [], pending: [{ agentId: 'oscar', name: 'Oscar', sentAt: ago(11), status: 'waiting' }],
      messages: [
        { id: 'o1', role: 'owner', text: 'Can someone set up our own cloud at agents.example.site?', at: ago(75) },
        { id: 'x1', role: 'action', text: 'Sent your request to Oscar.', at: ago(11) },
        { id: 'a1', role: 'assistant', text: 'Oscar is on it. He will need you to add some DNS records at your registrar — I will tell you the moment he asks.', at: ago(11) },
      ],
    },
  } as never);

  // ── Home: the Chief of Staff's conversation ──────────────────────────────
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('#screenHome #recapChatLog .chatmsg', { timeout: 15_000 });
  if (!SHOTS_ONLY) await page.waitForSelector('#recapChatRecap .turnrecaptext', { timeout: 10_000 });
  await settle();
  await shot(page, 'home-phone');
  const homeFacts = await page.$eval('#recapChatRecap .turnfacts', (node) => node.textContent ?? '').catch(() => '');
  check('Home: the facts line says how long it worked, when, and whose answer it waits for', /^Worked for 1m 4s · done .+ · waiting on Oscar$/.test(homeFacts), homeFacts);
  const homeRecap = await page.$eval('#recapChatRecap .turnrecaptext', (node) => node.textContent ?? '').catch(() => '');
  check('Home: the recap is the record\'s, in italics', homeRecap.startsWith('Recap: Asked Oscar to set up your own cloud'), homeRecap);
  let where = await placement(page, '#recapChatRecap', '#recapChatScroll');
  check('Home (phone): centred in the conversation column, under the reply, muted and italic', centred(where) && where!.below && where!.parts[1]?.italic === 'italic' && where!.align === 'center', JSON.stringify(where));
  check('Home (phone): nothing overflows', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  await settle();
  await shot(page, 'home-desk');
  where = await placement(page, '#recapChatRecap', '#recapChatScroll');
  check('Home (desk): centred in the reading column, not the window', centred(where) && where!.right - where!.left <= 760, JSON.stringify(where));

  // ── Oscar's own chat ─────────────────────────────────────────────────────
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.goto(`${ORIGIN}/chat/oscar`);
  await page.waitForSelector('#agentChatLog .chatmsg', { timeout: 15_000 });
  if (!SHOTS_ONLY) await page.waitForSelector('#agentChatRecap', { timeout: 10_000 });
  await page.waitForFunction(() => !document.querySelector('#agentChatRecap') || (document.querySelector('#agentChatRecap')?.textContent ?? '').includes('background job'), { timeout: 10_000 }).catch(() => {});
  await settle();
  await shot(page, 'chat-phone-before-recap');
  const early = await page.$eval('#agentChatRecap', (node) => ({ facts: node.querySelector('.turnfacts')?.textContent ?? '', recap: node.querySelector('.turnrecaptext')?.textContent ?? null })).catch(() => null);
  check('chat: before this turn\'s summary lands, the facts stand alone — no old recap, no placeholder', Boolean(early && early.recap === null && /^Worked for 2m 4s · done .+ · 1 background job still running$/.test(early.facts)), JSON.stringify(early));

  // The summary lands: the next read carries it, and it appears in place.
  const replyTop = await page.$eval('#agentChatLog .chatmsg:last-of-type', (node) => node.getBoundingClientRect().top).catch(() => 0);
  await userStorage.updateAgentFields(userId, 'oscar', {
    recap: { text: 'We are setting up your own Agentic Cloud; the install is paused on DNS. Next, add the two records at your registrar, then reply "done".', at: new Date().toISOString() },
  });
  if (!SHOTS_ONLY) await page.waitForSelector('#agentChatRecap .turnrecaptext', { timeout: 12_000 });
  await settle();
  await shot(page, 'chat-phone');
  const late = await page.$eval('#agentChatRecap .turnrecaptext', (node) => node.textContent ?? '').catch(() => '');
  check('chat: the recap arrives by itself, with no reload', late.startsWith('Recap: We are setting up your own Agentic Cloud'), late);
  const replyTopAfter = await page.$eval('#agentChatLog .chatmsg:last-of-type', (node) => node.getBoundingClientRect().top).catch(() => 0);
  check('chat: the reply above did not jump down when it arrived', replyTopAfter <= replyTop + 1, `${replyTop} → ${replyTopAfter}`);
  where = await placement(page, '#agentChatRecap', '#agentChatScroll');
  check('chat (phone): centred in the conversation column, under the reply, muted and italic', centred(where) && where!.below && where!.parts[1]?.italic === 'italic', JSON.stringify(where));
  check('chat (phone): the reader is carried down to it', await page.evaluate(() => {
    const pane = document.getElementById('agentChatScroll')!;
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 4;
  }));
  check('chat (phone): nothing overflows', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  await settle();
  await shot(page, 'chat-desk');
  where = await placement(page, '#agentChatRecap', '#agentChatScroll');
  check('chat (desk): centred in the reading column, not the window', centred(where) && where!.right - where!.left <= 760, JSON.stringify(where));

  check('the browser stayed clean', errors.length === 0, errors.join(' | '));
  if (failures.length) throw new Error(failures.join('; '));
  if (!SHOTS_ONLY) console.log('turn recap: all checks passed');
} finally {
  await browser.close();
  server.close();
}
