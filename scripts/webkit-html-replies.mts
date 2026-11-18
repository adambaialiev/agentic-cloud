// Note #1193 — a reply is one surface: the agent's HTML, drawn whole.
//
// Adam, 18 Nov 2026, with a screenshot of one Chief of Staff reply drawn in
// three layers (words set by the Workspace, a card with two buttons, a recap
// repeating both): "let's show agent generated interactive html only".
//
// Drives the built Workspace in Playwright's WebKit (Safari's engine) and
// Chromium on a phone-sized screen, light and dark, in the Chief of Staff's
// chat and in an agent's chat, on conversations that hold every kind of
// reply at once: an old Markdown one, the very reply of his screenshot, a
// reply laid out as an interface with its own style, a reply of words alone,
// a harness's error text, the plain lines an agent writes while it works, a
// sentence before a form. It checks what is drawn and how:
//
//  - a reply that styles itself, runs or asks is ONE card holding ONE frame,
//    with none of its words set beside it by the Workspace;
//  - words-only HTML and anything that is not HTML are words on the page,
//    never an empty space;
//  - no recap block under either chat, with a recap on record;
//  - lines written before a turn's HTML reply are drawn quiet;
//  - the header and the message box stand exactly where they stood;
//  - every frame near the screen shows, light, on a phone set to dark too;
//  - a tap in a frame is the person's message, naming the reply, once;
//  - a chat opens AT its end, however tall its newest framed replies grow;
//  - a long conversation of framed replies, read from its end to its start,
//    keeps only the frames near the screen alive, and moves nothing.
//
// Not in the CI browser stage (that stage installs Chrome only), so it is
// named `webkit-*`, not `verify-*`. Run it by hand:
//
//   npm --prefix backend run build:workspace-ui
//   (mkdir -p ~/pw && cd ~/pw && npm i playwright && npx playwright install webkit chromium && sudo npx playwright install-deps)
//   PLAYWRIGHT_DIR=~/pw OUT_DIR=/tmp/html-replies backend/node_modules/.bin/tsx scripts/webkit-html-replies.mts
//
// SHELL_DIR=<dir> draws with a different built shell: production's own, say,
// downloaded as it is served (index.html and its assets/), which is how the
// change was checked live. REAL_REPLY=<file> puts a reply an agent really
// wrote at the end of both chats.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import type { RecapMessage } from '../backend/src/shared/workspace-recap-chat.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { openSqliteDb } from '../backend/src/services/sqlite/sqlite-db.js';
import { SqliteDirectMessageStorage } from '../backend/src/services/sqlite/sqlite-direct-message-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'html-replies');
mkdirSync(OUT, { recursive: true });

const PORT = Number(process.env.PORT || 4203);
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

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** The reply of Adam's screenshot, as the Chief of Staff wrote it. */
const SCREENSHOT_REPLY = [
  '<p>Agreed. The guide page is the one page that didn\'t get the new look. Theo designed the rest of the site, so it should go to him to keep everything consistent.</p>',
  '<p>Theo is still working on the read change. When he reports back, I\'ll hand him two things in order: the "No notifications" fix, then a redesign of the guide page. Both are recorded on <a href="/workspace/notes/33">note #33</a>.</p>',
  '<p>If you\'d rather not wait, Elias is free now. He built the start page, but his conversation is 40% full and he didn\'t work on Theo\'s new look.</p>',
  '<button data-reply="Give it to Elias now">Give it to Elias now</button> <button data-reply="Wait for Theo">Wait for Theo</button>',
  '<p>My own chat is now about half full. Once these Hail changes are done, a fresh chat would help.</p>',
].join('\n');

/** A reply laid out as an interface: its own style, what happened, what is waiting, the answer. */
const INTERFACE_REPLY = `<style>
.head{display:flex;align-items:baseline;gap:8px;margin:0 0 10px}
.pill{font-size:12px;padding:2px 8px;border-radius:999px;background:#e7f0fd;color:#1a68d8}
.rows{border:1px solid rgba(104,103,98,.28);border-radius:10px;margin:0 0 12px}
.rows div{display:flex;justify-content:space-between;gap:12px;padding:8px 12px}
.rows div+div{border-top:1px solid rgba(104,103,98,.2)}
.rows span{color:#686762}
.quiet{background:#efefef;color:#1f1e1d}
</style>
<div class="head"><h3>Guide page redesign</h3><span class="pill">waiting on you</span></div>
<div class="rows">
<div><b>Theo</b><span>busy: the read change</span></div>
<div><b>Elias</b><span>free, chat 40% full</span></div>
<div><b>Recorded on</b><a href="/workspace/notes/33">note #33</a></div>
</div>
<form data-reply="Guide page redesign">
<p><label><input type="radio" name="who" value="Theo, when he reports back" checked> Wait for Theo</label><br>
<label><input type="radio" name="who" value="Elias, now"> Give it to Elias now</label></p>
<p><input name="note" placeholder="Anything to pass on (optional)" style="width:100%"></p>
<button type="submit">Send</button> <button type="button" class="quiet" data-reply="Decide later">Later</button>
</form>`;

const cosMessages: RecapMessage[] = [
  { id: 'c1', role: 'owner', text: 'How did yesterday go?', at: iso(60 * 26) },
  { id: 'c2', role: 'assistant', text: '**Yesterday** went fine: three changes merged.\n\n- the start page\n- the read change\n- one fix to notifications', at: iso(60 * 26 - 1) },
  { id: 'c3', role: 'owner', text: 'The guide page still looks old. Who should redo it?', at: iso(40) },
  { id: 'c4', role: 'assistant', text: SCREENSHOT_REPLY, at: iso(39) },
  { id: 'c5', role: 'owner', text: 'Show me that as one screen.', at: iso(20) },
  { id: 'c6', role: 'assistant', text: INTERFACE_REPLY, at: iso(19) },
  { id: 'c7', role: 'owner', text: 'And is the start page live?', at: iso(10) },
  { id: 'c8', role: 'assistant', text: '<h3>Start page</h3><p>Live since this morning, checked on a phone. Nothing is waiting on you there. It is written up on <a href="/workspace/notes/33">note #33</a>.</p>', at: iso(9) },
  { id: 'c9', role: 'owner', text: 'Thanks. Anything else?', at: iso(3) },
  { id: 'c10', role: 'assistant', text: 'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}', at: iso(2) },
];

type Row = { seq: number; role: 'owner' | 'agent' | 'platform'; text: string; at: string; answerTo?: number };
const SIX = '<form data-reply="Six decisions">\n<p><label><input type="checkbox" name="deploy" checked> Deploy tonight</label></p>\n<p><label><input type="checkbox" name="notify" checked> Tell the team</label></p>\n<p><label><input type="checkbox" name="archive"> Archive the old page</label></p>\n<button type="submit">Send</button> <button type="button" data-reply="Yes to all three">Yes to all</button>\n</form>';
const felixRows: Row[] = [
  { seq: 1, role: 'owner', text: 'Is the checkout page building?', at: iso(60 * 30) },
  { seq: 2, role: 'agent', text: 'Checking the build.', at: iso(60 * 30 - 1) },
  { seq: 3, role: 'agent', text: 'Yes: the **checkout page** builds and the checks are green.\n\n1. the cart\n2. the payment form', at: iso(60 * 30 - 2) },
  { seq: 4, role: 'owner', text: 'Ship it when the checks pass.', at: iso(30) },
  { seq: 5, role: 'agent', text: 'Reading the note first.', at: iso(29) },
  { seq: 6, role: 'agent', text: 'Tests pass. Opening the proposal and waiting for its checks.', at: iso(27) },
  { seq: 7, role: 'agent', text: INTERFACE_REPLY.replace('Guide page redesign</h3>', 'Checkout page shipped</h3>').replace('waiting on you', 'live'), at: iso(22) },
  { seq: 8, role: 'owner', text: 'What is still open?', at: iso(6) },
  { seq: 9, role: 'agent', text: `Three decisions are **open**, all with my suggestion ticked:\n\n${SIX}`, at: iso(5) },
];
/** REAL_REPLY=<file>: a reply an agent really wrote, as the newest reply of both chats. */
const REAL = process.env.REAL_REPLY ? readFileSync(process.env.REAL_REPLY, 'utf8').trim() : '';
if (REAL) {
  cosMessages.push({ id: 'c11', role: 'owner', text: 'Chats show only the agent\'s interactive HTML: build it.', at: iso(1.5) }, { id: 'c12', role: 'assistant', text: REAL, at: iso(1) });
  felixRows.push({ seq: 10, role: 'owner', text: 'Chats show only the agent\'s interactive HTML: build it.', at: iso(2) }, { seq: 11, role: 'agent', text: 'Reading the note and the chat code first.', at: iso(1.8) }, { seq: 12, role: 'agent', text: REAL, at: iso(1) });
}
const FELIX_ROWS = felixRows.length;
const sent: Array<{ message: string; answerTo?: number }> = [];
/** The long conversation: one framed reply after another. */
const LONG = Number(process.env.LONG || 120);
const longRows: Row[] = Array.from({ length: LONG }, (_, n): Row[] => [
  { seq: n * 2 + 1, role: 'owner', text: `Step ${n + 1}?`, at: iso(LONG * 2 - n * 2) },
  { seq: n * 2 + 2, role: 'agent', at: iso(LONG * 2 - n * 2 - 1), text: `<style>.n{color:#1a68d8}</style><h3>Step <span class="n">${n + 1}</span></h3><p>Done with step ${n + 1}. The checkout page builds and the checks are green.</p>${'<p>One more line of what happened.</p>'.repeat(n % 4)}<button data-reply="Next after ${n + 1}">Next</button>` },
]).flat();
const rowsOf = (agentId: string) => (agentId === 'long' ? longRows : felixRows);

const agentLifecycle = {
  isAgentWorking: () => false,
  agentActivity: () => null,
  isAgentPreparing: () => false,
  listManagedJobs: async () => ({ jobs: [], recent: [] }),
  agentChatMessages: async (_userId: string, agentId: string, afterSeq: number) => rowsOf(agentId).filter((row) => row.seq > afterSeq),
  chatMessageAgentFromUser: async (args: { agentId?: string; message: string; answerTo?: number }) => {
    sent.push({ message: args.message, ...(args.answerTo !== undefined ? { answerTo: args.answerTo } : {}) });
    felixRows.push({ seq: felixRows.length + 1, role: 'owner', text: args.message, at: new Date().toISOString(), ...(args.answerTo !== undefined ? { answerTo: args.answerTo } : {}) });
    return { ok: true as const, recipient: { id: 'felix', name: 'Felix', cli: 'claude' as const } };
  },
  converseWorkspaceRecap: () => new Promise(() => {}),
  summarizeWorkspaceRecap: async () => ({ text: 'Quiet day.' }),
} as unknown as RouteDeps['agentLifecycle'];
const directMessageStorage = new SqliteDirectMessageStorage(openSqliteDb(':memory:'));
const deps = {
  userStorage, orgStorage, workspaceWebAuth, directMessageStorage, mailboxes: mailbox.mailboxes, workspaceWebOrigin: ORIGIN,
  workspaceUiDir: process.env.SHELL_DIR || path.join(REPO, 'backend/dist/workspace-ui'), workspaceUiDefault: 'react', agentLifecycle,
} as unknown as RouteDeps;

const app = express();
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const pw = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(process.env.HOME || '/home/agent', 'pw'), 'package.json'))('playwright') as typeof import('playwright');
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const ENGINES = (process.env.ENGINES || 'webkit,chromium').split(',') as Array<'webkit' | 'chromium'>;
const SCHEMES = (process.env.SCHEMES || 'light,dark').split(',') as Array<'light' | 'dark'>;
let accountNo = 0;

try {
  for (const engine of ENGINES) {
    const browser = await pw[engine].launch();
    for (const scheme of SCHEMES) {
      const tag = `${engine}-${scheme}`;
      const context = await browser.newContext(engine === 'webkit'
        ? { ...pw.devices['iPhone 13'], colorScheme: scheme }
        : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(String(error)));
      await page.addInitScript('window.__name = (fn) => fn');
      const shim = { browserContext: () => ({ setCookie: (...cookies: Array<Record<string, unknown>>) => context.addCookies(cookies.map(({ path: _path, ...cookie }) => cookie) as never) }) };
      accountNo += 1;
      const account = await harnessSignedIn(shim as never, workspaceWebAuth, ORIGIN, `replies-${accountNo}@example.com`);
      const org = (await harnessWorkplace(orgStorage, { userId: account.userId, name: 'ACC' })).org;
      const owner = (await userStorage.getAllUsers()).find((user) => user.userId === account.userId)!;
      const ended = { lastTurnStartedAt: iso(3), lastTurnEndedAt: iso(1), recap: { text: 'I shipped the checkout page. Three decisions are waiting on you.', at: iso(1) } };
      const agentOf = (id: string, name: string) => ({
        id, name, cli: 'claude', model: 'opus', effort: 'high', orgId: org.orgId,
        serverId: `fly_ia-${id}.machine`, connectedAt: iso(600), createdAt: iso(600), lastActivityAt: iso(5), ...ended,
      });
      await userStorage.updateProfile(owner.userId, {
        telegram: { ...(owner.telegram ?? {}), agents: { felix: agentOf('felix', 'Felix'), long: agentOf('long', 'Lena') } as never },
      });
      const cos = await userStorage.reserveWorkspaceAssistant(owner.userId, org.orgId);
      if (!cos) throw new Error('the Chief of Staff was not reserved');
      await userStorage.updateAgentFields(owner.userId, cos.id, { cli: 'claude', model: 'sonnet', effort: 'high', serverId: 'fly_ia-cos.machine', connectedAt: iso(600), ...ended } as never);
      await orgStorage.touchMember(org.orgId, owner.userId, {
        workspaceAgentSettings: { cli: 'claude', model: 'sonnet', effort: 'high' },
        workspaceRecapChat: { messages: cosMessages, receipts: [], pending: [] },
      });
      felixRows.length = FELIX_ROWS;
      sent.length = 0;

      const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`) });
      /** Every frame within the pane's sight has shown, and what the chat draws. */
      const settle = async (log: string) => {
        await page.waitForSelector(`${log} .chatmsg`, { timeout: 20_000 });
        await page.waitForFunction((sel) => {
          const boxes = [...document.querySelectorAll<HTMLElement>(`${sel} .chathtmlframe`)];
          const near = boxes.filter((box) => box.querySelector('iframe'));
          return near.length > 0 && near.every((box) => !box.classList.contains('waiting'));
        }, log, { timeout: 15_000 });
        await page.waitForTimeout(600);
      };
      const read = (log: string) => page.evaluate((sel) => {
        const rows = [...document.querySelectorAll<HTMLElement>(`${sel} .chatmsg`)];
        const pane = document.querySelector<HTMLElement>('.chatpane')!;
        return {
          rows: rows.map((row) => ({
            cls: row.className,
            kids: [...row.children].map((child) => child.className),
            frames: row.querySelectorAll('iframe').length,
            native: row.querySelector('.kpage, .chatmarkdown') ? (row.querySelector('.kpage, .chatmarkdown')!.textContent ?? '').slice(0, 60) : '',
            height: Math.round(row.getBoundingClientRect().height),
            size: getComputedStyle(row).fontSize,
            color: getComputedStyle(row).color,
          })),
          recap: document.querySelectorAll('.turnrecap, .recaptag, #agentChatRecap, #recapChatRecap').length,
          paneText: pane.textContent ?? '',
          head: Boolean(document.querySelector('.chathead') && document.querySelector('.chathead')!.getBoundingClientRect().height > 30),
          box: Boolean(document.querySelector<HTMLTextAreaElement>('#agentChatText') && document.querySelector('#agentChatText')!.getBoundingClientRect().height > 20),
          send: Boolean(document.querySelector('#agentChatSend')),
          waiting: document.querySelectorAll(`${sel} .chathtmlframe.waiting iframe`).length,
          failed: document.querySelectorAll(`${sel} .chathtmlfailed`).length,
          paneBackground: getComputedStyle(document.body).backgroundColor,
          card: (() => { const card = document.querySelector<HTMLElement>(`${sel} .chathtmlui`); return card ? getComputedStyle(card).backgroundColor : ''; })(),
        };
      }, log);
      /** What the page inside a frame looks like to the person: its colours. */
      const inside = async (nth: number) => {
        const outer = page.frames().filter((frame) => frame.url().endsWith('/workspace/reply-frame'))[nth];
        const inner = outer?.childFrames()[0];
        if (!inner) return null;
        return inner.evaluate(() => ({
          background: getComputedStyle(document.documentElement).backgroundColor,
          color: getComputedStyle(document.body).color,
          scheme: getComputedStyle(document.documentElement).colorScheme,
          text: (document.body.innerText || '').slice(0, 80),
          select: getComputedStyle(document.body).userSelect || 'auto',
        }));
      };

      // 1. The Chief of Staff's chat.
      await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
      await settle('#recapChatLog');
      let seen = await read('#recapChatLog');
      const agentRows = seen.rows.filter((row) => /\bagent\b/.test(row.cls));
      const [markdown, screenshot, laidOut, words, errorText] = agentRows;
      check(`${tag} · Chief of Staff: an old Markdown reply reads as Markdown, on the page`, Boolean(markdown) && !/\bhtml\b/.test(markdown!.cls) && markdown!.frames === 0 && markdown!.native.startsWith('Yesterday'), JSON.stringify(markdown));
      for (const [name, row] of [['the reply of the screenshot', screenshot], ['a reply laid out as an interface', laidOut]] as const) {
        check(`${tag} · Chief of Staff: ${name} is ONE card holding ONE frame, none of its words set beside it`,
          Boolean(row) && row!.kids.length === 1 && row!.kids[0] === 'chathtmlui' && row!.frames === 1 && row!.native === '', JSON.stringify(row));
      }
      check(`${tag} · Chief of Staff: a reply of words alone is on the page, no frame, no card`, Boolean(words) && words!.frames === 0 && words!.native.startsWith('Start page') && !words!.kids.includes('chathtmlui'), JSON.stringify(words));
      check(`${tag} · Chief of Staff: a reply that is not HTML is drawn as words, never an empty space`, Boolean(errorText) && errorText!.native.startsWith('API Error: 529') && errorText!.height > 20, JSON.stringify(errorText));
      check(`${tag} · Chief of Staff: no recap block, with a recap on record`, seen.recap === 0 && !seen.paneText.includes('Three decisions are waiting on you') && !seen.paneText.includes('Worked for'), String(seen.recap));
      check(`${tag} · Chief of Staff: the header and the message box stand`, seen.head && seen.box && seen.send);
      check(`${tag} · Chief of Staff: every frame near the screen has shown; none failed`, seen.waiting === 0 && seen.failed === 0, JSON.stringify({ waiting: seen.waiting, failed: seen.failed }));
      const first = await inside(0);
      check(`${tag} · Chief of Staff: the page inside is light (dark ink, nothing painted behind it) and its words select`,
        Boolean(first) && first!.background === 'rgba(0, 0, 0, 0)' && first!.color === 'rgb(31, 30, 29)' && first!.select !== 'none' && seen.card === 'rgb(255, 255, 255)', JSON.stringify({ first, card: seen.card }));
      const fromEnd = () => page.evaluate(() => { const pane = document.querySelector<HTMLElement>('.chatpane')!; return Math.round(pane.scrollHeight - pane.scrollTop - pane.clientHeight); });
      let off = await fromEnd();
      check(`${tag} · Chief of Staff: the chat opens AT its end, after every frame near it has grown to its page (${off} px from it)`, off <= 4, String(off));
      await shot('cos-end');
      if (REAL) {
        const real = agentRows.at(-1)!;
        check(`${tag} · Chief of Staff: the REAL reply is one card holding one frame, shown`, real.kids.length === 1 && real.kids[0] === 'chathtmlui' && real.frames === 1 && real.native === '' && real.height > 200, JSON.stringify(real));
        await page.evaluate(() => { const pane = document.querySelector<HTMLElement>('.chatpane')!; const card = [...document.querySelectorAll<HTMLElement>('#recapChatLog .chathtmlui')].at(-1)!; pane.scrollTop += card.getBoundingClientRect().top - pane.getBoundingClientRect().top - 70; });
        await page.waitForTimeout(500);
        await shot('cos-real-top');
      }
      await page.evaluate(() => { const pane = document.querySelector<HTMLElement>('.chatpane')!; pane.scrollTop = 0; });
      await page.waitForTimeout(700);
      await shot('cos-top');
      await page.evaluate(() => { const pane = document.querySelector<HTMLElement>('.chatpane')!; const card = document.querySelectorAll<HTMLElement>('#recapChatLog .chathtmlui')[1]!; pane.scrollTop += card.getBoundingClientRect().top - pane.getBoundingClientRect().top - 60; });
      await page.waitForTimeout(700);
      await shot('cos-interface');

      // 2. An agent's chat.
      await page.goto(`${ORIGIN}/chat/felix`, { waitUntil: 'domcontentloaded' });
      await settle('#agentChatLog');
      seen = await read('#agentChatLog');
      const felix = seen.rows.filter((row) => /\bagent\b/.test(row.cls));
      const [oldLine, oldReply, lineA, lineB, shipped, asks] = felix;
      check(`${tag} · agent: a turn answered in Markdown reads as it always did, both rows at full size`,
        Boolean(oldLine && oldReply) && !/progress/.test(oldLine!.cls) && !/progress/.test(oldReply!.cls) && oldLine!.size === '17px', JSON.stringify([oldLine?.cls, oldReply?.cls, oldLine?.size]));
      check(`${tag} · agent: the lines written before the turn's HTML reply are quiet plain lines`,
        Boolean(lineA && lineB) && /progress/.test(lineA!.cls) && /progress/.test(lineB!.cls) && lineA!.size === '14px' && lineA!.color !== oldLine!.color && lineA!.native.startsWith('Reading the note'), JSON.stringify([lineA, oldLine?.color]));
      check(`${tag} · agent: the reply is ONE card holding ONE frame`, Boolean(shipped) && shipped!.kids.length === 1 && shipped!.kids[0] === 'chathtmlui' && shipped!.frames <= 1 && shipped!.native === '', JSON.stringify(shipped));
      check(`${tag} · agent: a sentence before the first tag sits at the top of the same card`,
        Boolean(asks) && asks!.kids.length === 1 && asks!.kids[0] === 'chathtmlui' && asks!.frames <= 1 && asks!.native.startsWith('Three decisions are open'), JSON.stringify(asks));
      check(`${tag} · agent: no recap block, with a recap on record`, seen.recap === 0 && !seen.paneText.includes('Three decisions are waiting on you'), String(seen.recap));
      check(`${tag} · agent: the header and the message box stand`, seen.head && seen.box && seen.send);
      check(`${tag} · agent: every frame near the screen has shown; none failed`, seen.waiting === 0 && seen.failed === 0);
      off = await fromEnd();
      check(`${tag} · agent: the chat opens AT its end (${off} px from it)`, off <= 4, String(off));
      await shot('agent-end');
      if (REAL) {
        const real = felix.at(-1)!;
        check(`${tag} · agent: the REAL reply is one card holding one frame, shown, under its quiet working line`, real.kids.length === 1 && real.kids[0] === 'chathtmlui' && real.frames === 1 && real.native === '' && real.height > 200 && /progress/.test(felix.at(-2)!.cls), JSON.stringify(real));
        await page.evaluate(() => { const pane = document.querySelector<HTMLElement>('.chatpane')!; const card = [...document.querySelectorAll<HTMLElement>('#agentChatLog .chathtmlui')].at(-1)!; pane.scrollTop += card.getBoundingClientRect().top - pane.getBoundingClientRect().top - 150; });
        await page.waitForTimeout(500);
        await shot('agent-real-top');
        await page.evaluate(() => { const pane = document.querySelector<HTMLElement>('.chatpane')!; pane.scrollTop = pane.scrollHeight; });
        await page.waitForTimeout(400);
      }
      await page.evaluate(() => { const pane = document.querySelector<HTMLElement>('.chatpane')!; const row = document.querySelector<HTMLElement>('#agentChatLog .chatmsg.progress')!; pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - 120; });
      await page.waitForTimeout(700);
      await shot('agent-progress');

      // 3. A tap in the frame is the person's message, naming the reply, once.
      await page.evaluate(() => { const pane = document.querySelector<HTMLElement>('.chatpane')!; pane.scrollTop = pane.scrollHeight; });
      await page.waitForTimeout(500);
      const outers = page.frames().filter((frame) => frame.url().endsWith('/workspace/reply-frame'));
      const formFrame = outers.map((frame) => frame.childFrames()[0]).find((frame) => frame && frame.url() === 'about:srcdoc' && frame !== undefined);
      let tapped = false;
      for (const outer of outers) {
        const inner = outer.childFrames()[0];
        if (!inner) continue;
        const button = inner.locator('button[data-reply="Yes to all three"]');
        if (await button.count()) { await button.tap(); await button.tap({ timeout: 1500 }).catch(() => null); tapped = true; }
      }
      void formFrame;
      await page.waitForTimeout(1500);
      check(`${tag} · agent: a tap in the frame is sent as the person's message, naming the reply, once`,
        tapped && sent.length === 1 && sent[0]!.message === 'Yes to all three' && sent[0]!.answerTo === 9, JSON.stringify(sent));
      const bubble = await page.evaluate(() => [...document.querySelectorAll('#agentChatLog .chatmsg.owner')].at(-1)?.textContent ?? '');
      check(`${tag} · agent: the answer stands as the person's own bubble`, bubble.includes('Yes to all three'), bubble);
      await shot('agent-answered');

      // 4. Typing still works beside a form: the box takes words and sends them.
      await page.fill('#agentChatText', 'Typed instead.');
      await page.tap('#agentChatSend');
      await page.waitForTimeout(1200);
      check(`${tag} · agent: typing an answer still works beside buttons and forms`, sent.length === 2 && sent[1]!.message === 'Typed instead.' && sent[1]!.answerTo === undefined, JSON.stringify(sent));

      // 5. A long conversation of framed replies, read from its end to its start.
      await page.goto(`${ORIGIN}/chat/long`, { waitUntil: 'domcontentloaded' });
      const opened = Date.now();
      await settle('#agentChatLog');
      const openMs = Date.now() - opened;
      const census = () => page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>('.chatpane')!;
        return { frames: document.querySelectorAll('#agentChatLog iframe').length, cards: document.querySelectorAll('#agentChatLog .chathtmlui').length, height: pane.scrollHeight, top: pane.scrollTop };
      });
      const atEnd = await census();
      check(`${tag} · long chat (${LONG} framed replies): opens with only the frames near the screen built`, atEnd.cards === LONG && atEnd.frames > 0 && atEnd.frames <= 30, JSON.stringify({ ...atEnd, openMs }));
      let most = atEnd.frames;
      let moved = 0;
      // Read upwards as a thumb does, quickly: 350 px every 150 ms. (Thrown
      // a whole screen at a time, a frame can reach the screen before it has
      // been measured, and then it grows ON screen, as a picture does.)
      for (let step = 0; step < 1200; step += 1) {
        const before = await page.evaluate(() => {
          const pane = document.querySelector<HTMLElement>('.chatpane')!;
          const rows = [...document.querySelectorAll<HTMLElement>('#agentChatLog .chatmsg.owner')];
          const mark = rows.find((row) => row.getBoundingClientRect().top > pane.getBoundingClientRect().top + 40);
          return { top: pane.scrollTop, mark: mark ? { text: mark.textContent, y: mark.getBoundingClientRect().top } : null };
        });
        if (before.top <= 0) break;
        await page.evaluate(() => { document.querySelector<HTMLElement>('.chatpane')!.scrollTop -= 350; });
        await page.waitForTimeout(150);
        const after = await page.evaluate((text) => {
          const row = [...document.querySelectorAll<HTMLElement>('#agentChatLog .chatmsg.owner')].find((node) => node.textContent === text);
          return { y: row ? row.getBoundingClientRect().top : null, frames: document.querySelectorAll('#agentChatLog iframe').length };
        }, before.mark?.text ?? '');
        most = Math.max(most, after.frames);
        // A row that was on screen moved by exactly the scroll, give or take
        // a frame that was measured for the first time above it.
        if (before.mark && after.y !== null) moved = Math.max(moved, Math.abs(after.y - before.mark.y - Math.min(350, before.top)));
        if (process.env.TRACE && before.mark && after.y !== null) console.log(JSON.stringify({ step, top: before.top, y0: Math.round(before.mark.y), y1: Math.round(after.y), frames: after.frames, ...(await page.evaluate(() => { const pane = document.querySelector<HTMLElement>('.chatpane')!; return { top1: pane.scrollTop, h: pane.scrollHeight }; })) }));
      }
      await page.waitForTimeout(800);
      const atTop = await census();
      check(`${tag} · long chat: read to its start, never more than a screenful of frames alive (most ${most}, ${atTop.frames} at the top of ${LONG})`, most <= 40 && atTop.frames <= 40, JSON.stringify(atTop));
      check(`${tag} · long chat: reading upwards, the row under the thumb never jumps (most ${Math.round(moved)} px beyond the scroll)`, moved <= 8, String(moved));
      await shot('long-top');
      // Back to the end: the frames let go come back, at the height they had.
      const heightBefore = atTop.height;
      await page.evaluate(() => { const pane = document.querySelector<HTMLElement>('.chatpane')!; pane.scrollTop = pane.scrollHeight; });
      await page.waitForFunction(() => {
        const pane = document.querySelector<HTMLElement>('.chatpane')!;
        const boxes = [...document.querySelectorAll<HTMLElement>('#agentChatLog .chathtmlframe')].filter((box) => {
          const rect = box.getBoundingClientRect(); const view = pane.getBoundingClientRect();
          return rect.bottom > view.top && rect.top < view.bottom;
        });
        return boxes.length > 0 && boxes.every((box) => box.querySelector('iframe') && !box.classList.contains('waiting'));
      }, undefined, { timeout: 15_000 });
      const back = await census();
      check(`${tag} · long chat: back at its end the replies are drawn again and the conversation is as tall as it was`, Math.abs(back.height - heightBefore) <= 4, JSON.stringify({ before: heightBefore, after: back.height, frames: back.frames }));
      await shot('long-end');
      check(`${tag} · no page errors`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
      await context.close();
    }
    await browser.close();
  }
} finally {
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} FAILED:\n${failures.map((line) => `  - ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(`\nAll checks passed. Pictures in ${OUT}`);
process.exit(0);
