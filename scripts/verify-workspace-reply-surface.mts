/**
 * Note #1193, in real Chrome: an agent's reply is one surface, and no recap
 * block stands under it.
 *
 * Adam, 18 Nov 2026, with a screenshot of one Chief of Staff reply drawn in
 * three layers (words set by the Workspace, a card with two buttons, a RECAP
 * block repeating both): "let's show agent generated interactive html only".
 * Asked about the recap block: hide it in chat. About the short lines an
 * agent writes while it works: keep them, as quiet plain lines.
 *
 * This stands where `verify-workspace-turn-recap` stood (notes #945, #976),
 * on the same two conversations, each with a recap on record: the Chief of
 * Staff's (Home) and an agent's. It checks, on a phone-sized screen, that
 *
 *  - neither chat draws the recap block, its chip, its facts or its words;
 *  - a reply that asks is ONE card holding ONE locked frame, with none of its
 *    words set beside it, and the frame really shows (the loading
 *    placeholder of note #1192 gives way to the page);
 *  - the plain line written before the turn's HTML reply is drawn quiet;
 *  - a tap in the frame is sent as the person's message, naming the reply;
 *  - the header and the message box stand, and nothing overflows.
 *
 *   npm --prefix backend run build:workspace-ui
 *   OUT_DIR=/tmp/shots backend/node_modules/.bin/tsx scripts/verify-workspace-reply-surface.mts
 *
 * WebKit, dark mode and a long conversation are in `webkit-html-replies.mts`,
 * which is run by hand (the CI browser stage installs Chrome only).
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
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'reply-surface-proof');
mkdirSync(OUT, { recursive: true });
const SHELL = path.join(REPO, 'backend/dist/workspace-ui');

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
/** Oscar's conversation: an ask, a line while he worked, the reply that ended the turn. */
const OSCAR_REPLY = '<style>.rec{border:1px solid rgba(104,103,98,.28);border-radius:10px;padding:8px 12px;margin:0 0 12px}</style>'
  + '<h3>Paused on DNS</h3><p>The install is ready. Add these two records at your registrar:</p>'
  + '<div class="rec"><b>CNAME</b> agents &rarr; edge.example.net<br><b>TXT</b> _acme &rarr; 4f1c…</div>'
  + '<button data-reply="Done, the records are added">Done</button> <button data-reply="Show me how">Show me how</button>';
type Row = { seq: number; role: 'owner' | 'agent'; text: string; at: string; answerTo?: number };
const oscarRows: Row[] = [
  { seq: 1, role: 'owner', text: 'Set up our own Agentic Cloud at agents.example.site, please.', at: ago(140) },
  { seq: 2, role: 'agent', text: 'On it: creating the Fly organisation and the installer config now.', at: ago(130) },
  { seq: 3, role: 'agent', text: OSCAR_REPLY, at: ago(15) },
];
const sent: Array<{ message: string; answerTo?: number }> = [];
/** What the agent's machine still runs past its turn. */
const oscarJobs = [{ id: 'j_111111111111111111111111', label: 'npm run build', startedAt: ago(20) }];
const HOME_RECAP = 'Asked Oscar to set up your own cloud; he is paused on DNS. Next, add the records he listed.';
const OSCAR_RECAP = 'We are setting up your own Agentic Cloud; the install is paused on DNS.';

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
    agentActivity: () => null,
    isAgentPreparing: () => false,
    listManagedJobs: async (_user: string, agentId: string) => ({ jobs: agentId === 'oscar' ? oscarJobs : [], recent: [] }),
    chatMessageAgentFromUser: async (args: { message: string; answerTo?: number }) => {
      sent.push({ message: args.message, ...(args.answerTo !== undefined ? { answerTo: args.answerTo } : {}) });
      oscarRows.push({ seq: oscarRows.length + 1, role: 'owner', text: args.message, at: new Date().toISOString(), ...(args.answerTo !== undefined ? { answerTo: args.answerTo } : {}) });
      return { ok: true as const, recipient: { id: 'oscar', name: 'Oscar', cli: 'claude' as const } };
    },
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png` });
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

/** What one conversation draws. */
async function drawn(page: Page, log: string) {
  return page.evaluate((sel) => {
    const pane = document.querySelector<HTMLElement>(`${sel}`)!.closest<HTMLElement>('.chatpane')!;
    const rows = [...document.querySelectorAll<HTMLElement>(`${sel} .chatmsg.agent`)];
    return {
      rows: rows.map((row) => ({
        cls: row.className,
        kids: [...row.children].map((child) => child.className),
        frames: row.querySelectorAll('iframe').length,
        waiting: row.querySelectorAll('.chathtmlframe.waiting').length,
        native: (row.querySelector('.kpage, .chatmarkdown')?.textContent ?? '').slice(0, 40),
        size: getComputedStyle(row).fontSize,
        colour: getComputedStyle(row).color,
        frameHeight: Math.round(row.querySelector('iframe')?.getBoundingClientRect().height ?? 0),
      })),
      recap: document.querySelectorAll('.turnrecap, .turnrecaptext, .turnfacts, #agentChatRecap, #recapChatRecap').length,
      words: pane.textContent ?? '',
      head: (document.querySelector('.chathead')?.getBoundingClientRect().height ?? 0) > 30,
      box: (document.querySelector('#agentChatText')?.getBoundingClientRect().height ?? 0) > 20 && Boolean(document.querySelector('#agentChatSend')),
      fits: document.documentElement.scrollWidth <= innerWidth,
    };
  }, log);
}
/** Every frame in the conversation has given way from its placeholder to its page. */
const framesShown = (page: Page, log: string) => page.waitForFunction((sel) => {
  const boxes = [...document.querySelectorAll(`${sel} .chathtmlframe`)];
  return boxes.length > 0 && boxes.every((box) => box.querySelector('iframe') && !box.classList.contains('waiting'));
}, { timeout: 20_000 }, log);

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

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'surface-owner@example.com');
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
          // A completed turn with ITS recap on record: what the block drew.
          lastTurnStartedAt: ago(136), lastTurnEndedAt: ago(12),
          recap: { text: OSCAR_RECAP, at: ago(5) },
        },
      },
    },
  });
  const workspaceAgent = await userStorage.reserveWorkspaceAssistant(userId, org.orgId);
  if (!workspaceAgent) throw new Error('the Workspace Agent was not reserved');
  await userStorage.updateAgentFields(userId, workspaceAgent.id, {
    cli: 'claude', model: 'opus', effort: 'high', serverId: 'fly_ia-workspace.machine', connectedAt: ago(3600),
    lastTurnStartedAt: ago(74), lastTurnEndedAt: ago(10),
    recap: { text: HOME_RECAP, at: ago(4) },
  });
  await orgStorage.touchMember(org.orgId, userId, {
    workspaceAgentSettings: { cli: 'claude', model: 'opus', effort: 'high' },
    workspaceRecapChat: {
      receipts: [], pending: [{ agentId: 'oscar', name: 'Oscar', sentAt: ago(11), status: 'waiting' }],
      messages: [
        { id: 'o1', role: 'owner', text: 'Can someone set up our own cloud at agents.example.site?', at: ago(75) },
        { id: 'x1', role: 'action', text: 'Sent your request to Oscar.', at: ago(11) },
        // The shape of the reply in Adam's screenshot: words, then buttons, then a closing sentence.
        { id: 'a1', role: 'assistant', at: ago(11), text: '<p>Oscar is on it. He will need you to add some DNS records at your registrar.</p><button data-reply="Tell me when he asks">Tell me when he asks</button> <button data-reply="I will watch his chat">I will watch his chat</button><p>My own chat is about half full.</p>' },
      ],
    },
  } as never);

  // ── Home: the Chief of Staff's conversation ──────────────────────────────
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('#screenHome #recapChatLog .chatmsg.agent', { timeout: 15_000 });
  await framesShown(page, '#recapChatLog');
  await settle();
  await shot(page, 'home-phone');
  let seen = await drawn(page, '#recapChatLog');
  const homeReply = seen.rows.at(-1);
  check('Home: the reply is ONE card holding ONE frame, none of its words set beside it',
    Boolean(homeReply) && homeReply!.kids.length === 1 && homeReply!.kids[0] === 'chathtmlui' && homeReply!.frames === 1 && homeReply!.native === '', JSON.stringify(homeReply));
  check('Home: its frame shows, at the height of its page', Boolean(homeReply) && homeReply!.waiting === 0 && homeReply!.frameHeight > 80, JSON.stringify(homeReply));
  check('Home: no recap block, chip, facts or words, with a recap on record and Oscar awaited',
    seen.recap === 0 && !seen.words.includes('Asked Oscar to set up') && !seen.words.includes('Worked for') && !seen.words.includes('waiting on Oscar'), `${seen.recap}`);
  check('Home: the header and the message box stand', seen.head && seen.box);
  check('Home: nothing overflows', seen.fits);

  // ── Oscar's own chat ─────────────────────────────────────────────────────
  await page.goto(`${ORIGIN}/chat/oscar`);
  await page.waitForSelector('#agentChatLog .chatmsg.agent', { timeout: 15_000 });
  await framesShown(page, '#agentChatLog');
  await settle();
  await shot(page, 'chat-phone');
  seen = await drawn(page, '#agentChatLog');
  const [line, reply] = seen.rows;
  check('chat: the line written before the turn\'s HTML reply is a quiet plain line',
    Boolean(line) && /\bprogress\b/.test(line!.cls) && line!.size === '14px' && line!.native.startsWith('On it') && line!.frames === 0, JSON.stringify(line));
  check('chat: the reply is ONE card holding ONE frame, none of its words set beside it',
    Boolean(reply) && reply!.kids.length === 1 && reply!.kids[0] === 'chathtmlui' && reply!.frames === 1 && reply!.native === '' && reply!.colour !== line!.colour, JSON.stringify(reply));
  check('chat: its frame shows, at the height of its page', Boolean(reply) && reply!.waiting === 0 && reply!.frameHeight > 120, JSON.stringify(reply));
  check('chat: no recap block, chip, facts or words, with a recap on record and a job still running',
    seen.recap === 0 && !seen.words.includes('We are setting up your own') && !seen.words.includes('Worked for') && !seen.words.includes('still running'), `${seen.recap}`);
  check('chat: the header and the message box stand', seen.head && seen.box);
  check('chat: nothing overflows', seen.fits);

  // A tap in the frame is the person's message, naming the reply.
  const inner = page.frames().find((frame) => frame.parentFrame()?.url().endsWith('/workspace/reply-frame'));
  const words = inner ? await inner.evaluate(() => document.body.innerText) : '';
  check('chat: the page inside the frame holds the whole reply, opening words and buttons', words.includes('Paused on DNS') && words.includes('Add these two records') && words.includes('Done'), words.slice(0, 80));
  if (inner) await inner.click('button[data-reply="Done, the records are added"]');
  await page.waitForFunction(() => [...document.querySelectorAll('#agentChatLog .chatmsg.owner')].some((row) => (row.textContent ?? '').includes('Done, the records are added')), { timeout: 10_000 }).catch(() => {});
  check('chat: a tap in the frame is sent as the person\'s message, naming the reply, once',
    sent.length === 1 && sent[0]!.message === 'Done, the records are added' && sent[0]!.answerTo === 3, JSON.stringify(sent));
  await settle();
  await shot(page, 'chat-phone-answered');

  check('the browser stayed clean', errors.length === 0, errors.join(' | '));
  if (failures.length) throw new Error(failures.join('; '));
  console.log('reply surface: all checks passed');
} finally {
  await browser.close();
  server.close();
}
