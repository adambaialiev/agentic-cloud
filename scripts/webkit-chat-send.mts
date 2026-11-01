// Note #764 — a sent message, in every chat, from the frame Send is tapped.
//
// The owner, 2026-10-16: "In chat screens, when I send a message, I want it
// to be rendered smoothly right away, without some delay as it is now".
//
// Drives Playwright's WebKit — the engine Safari is built on — on the iPhone
// 15 Pro Max's screen, touch and user agent, and on a desk-sized window.
// Every chat screen: the Chief of Staff's, on a conversation as long as the
// owner's (1,200 messages); a room agent's; and a message to a person (the
// screen is switched off since note #583, and still answers at its address).
// The server takes its time over each send, as the owner's does: the Chief
// of Staff's answer is the whole conversation with every card read fresh, a
// room agent's waits for its machine — and the message is on the record
// before that answer is out, so a poll can bring its row first (1b).
//
// From the Send tap, every animation frame is sampled for a few seconds:
// where the reader's message stands, how opaque it is, and how many copies
// of it are on the page. Each chat must put the message on screen in the
// first frame after the tap — before the server answers — let it rise in to
// full strength, keep it there with no blink or jump when the server's row
// takes the bubble's place, and never show it twice. A send the server
// refuses is said, and the words are back in the box to be sent again.
//
// Before the fix the Chief of Staff's chat drew the message below the fold
// and scrolled to it only when an answer came back — 1.7 s at a desk — its
// row then rose in from nothing over the bubble, and a poll that got there
// first showed the message twice until the send's answer; a message to a
// person sat in a read-only box until the server answered; a room agent's
// slid in under a smooth scroll. TRACE=1 prints every sampled frame;
// SHOTS=1 takes the pictures instead of the timings.
//
// Not in the CI browser stage (that stage installs Chrome only), so it is
// named `webkit-*`, not `verify-*`. Run it by hand:
//
//   npm --prefix backend run build
//   (mkdir -p ~/pw && cd ~/pw && npm i playwright && npx playwright install webkit && sudo npx playwright install-deps webkit)
//   PLAYWRIGHT_DIR=~/pw OUT_DIR=/tmp/chat-send backend/node_modules/.bin/tsx scripts/webkit-chat-send.mts

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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
import { generateTotpCode } from '../backend/src/utils/totp.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'chat-send-webkit');
mkdirSync(OUT, { recursive: true });

const PORT = Number(process.env.PORT || 4201);
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** How long the server takes over one send before it answers. */
const SEND_MS = Number(process.env.SEND_MS || (process.env.SHOTS ? 2500 : 1500));
/** SHOTS=1: pictures of each send 0.3 s and 1.2 s after the tap (they take
 *  frames of their own, so the timings are read without them). */
const SHOTS = Boolean(process.env.SHOTS);
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
type Row = { seq: number; role: 'owner' | 'agent' | 'platform'; text: string; at: string };
const felixRows: Row[] = Array.from({ length: 80 }, (_, n): Row => ({
  seq: n + 1, role: n % 2 ? 'agent' : 'owner', at: iso(90 - n),
  text: n % 2 ? `Done with step ${n}. The checkout page builds and the checks are green.` : `Step ${n + 1}: carry on with the checkout page.`,
}));
/** The server's answer to a send, when the harness says it is refused. */
const refuse = { next: false };
/** How long the Chief of Staff's answer to the next send takes. */
const answerAfter = { ms: SEND_MS };
const agentLifecycle = {
  isAgentWorking: () => false,
  agentActivity: () => null,
  isAgentPreparing: () => false,
  listManagedJobs: async () => ({ jobs: [], recent: [] }),
  agentChatMessages: async (_userId: string, _agentId: string, afterSeq: number) => felixRows.filter((row) => row.seq > afterSeq),
  chatMessageAgentFromUser: async (args: { message: string }) => {
    // The agent's machine is woken before the message is admitted.
    await new Promise((resolve) => setTimeout(resolve, SEND_MS));
    felixRows.push({ seq: felixRows.length + 1, role: 'owner', text: args.message, at: new Date().toISOString() });
    return { ok: true as const, recipient: { id: 'felix', name: 'Felix', cli: 'claude' as const } };
  },
  converseWorkspaceRecap: () => new Promise(() => {}),
  summarizeWorkspaceRecap: async () => ({ text: 'Quiet day.' }),
} as unknown as RouteDeps['agentLifecycle'];
const directMessageStorage = new SqliteDirectMessageStorage(openSqliteDb(':memory:'));
const deps = {
  userStorage, orgStorage, workspaceWebAuth, directMessageStorage, mailboxes: mailbox.mailboxes, workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'), workspaceUiDefault: 'react', agentLifecycle,
} as unknown as RouteDeps;

const app = express();
// The Chief of Staff's answer to a send is the whole conversation with every
// proposal card read fresh: on the owner's 1,203 messages it is slow, and on
// a phone network slower still. The message is on the record before that
// answer is ready, so a poll can bring its row first. A refused one answers
// at once.
app.use((req, res, next) => {
  if (req.method !== 'POST' || !req.path.endsWith('/api/recap/chat')) { next(); return; }
  if (refuse.next) {
    refuse.next = false;
    res.status(409).json({ error: 'Your Chief of Staff could not take that just now.' });
    return;
  }
  const json = res.json.bind(res);
  const late = answerAfter.ms;
  answerAfter.ms = SEND_MS;
  res.json = ((body: unknown) => { setTimeout(() => json(body), late); return res; }) as typeof res.json;
  next();
});
// A message to a person: the messaging host answers once it has stored it.
app.use((req, res, next) => {
  if (req.method !== 'POST' || !/\/api\/messages\/[^/]+$/.test(req.path)) { next(); return; }
  const json = res.json.bind(res);
  res.json = ((body: unknown) => { setTimeout(() => json(body), SEND_MS); return res; }) as typeof res.json;
  next();
});
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

type Frame = { t: number; copies: number; shown: number; opacity: number; bottom: number; top: number; height: number; sending: boolean; rows: number };
const browser = await pw.webkit.launch();
try {
  for (const device of ['phone', 'desk'] as const) {
    const context = await browser.newContext(device === 'phone'
      ? { ...pw.devices['iPhone 15 Pro Max'] }
      : { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    await page.addInitScript('window.__name = (fn) => fn');
    const shim = { browserContext: () => ({ setCookie: (...cookies: Array<Record<string, unknown>>) => context.addCookies(cookies.map(({ path: _path, ...cookie }) => cookie) as never) }) };
    const account = await harnessSignedIn(shim as never, workspaceWebAuth, ORIGIN, `send-${device}@example.com`);
    const org = (await harnessWorkplace(orgStorage, { userId: account.userId, name: 'ACC' })).org;
    const owner = (await userStorage.getAllUsers()).find((user) => user.userId === account.userId)!;
    await userStorage.updateProfile(owner.userId, {
      telegram: {
        ...(owner.telegram ?? {}),
        agents: {
          felix: {
            id: 'felix', name: 'Felix', cli: 'claude', model: 'opus', effort: 'high', orgId: org.orgId,
            serverId: 'fly_ia-felix.machine', connectedAt: iso(600), createdAt: iso(600), lastActivityAt: iso(5),
          },
        } as never,
      },
    });
    const cos = await userStorage.reserveWorkspaceAssistant(owner.userId, org.orgId);
    if (!cos) throw new Error('the Chief of Staff was not reserved');
    await userStorage.updateAgentFields(owner.userId, cos.id, { cli: 'claude', model: 'sonnet', effort: 'high', serverId: 'fly_ia-cos.machine', connectedAt: iso(600) });
    const messages: RecapMessage[] = Array.from({ length: 600 }, (_, n): RecapMessage[] => [
      { id: `o${n}`, role: 'owner', text: `Question ${n + 1}: where is the booking page?`, at: iso(900 - n) },
      { id: `a${n}`, role: 'assistant', at: iso(900 - n), text: `Answer ${n + 1}: the booking page picked up another fix.\n\n- the calendar\n- the checks` },
    ]).flat();
    await orgStorage.touchMember(org.orgId, owner.userId, {
      workspaceAgentSettings: { cli: 'claude', model: 'sonnet', effort: 'high' },
      workspaceRecapChat: { messages, receipts: [], pending: [] },
    });

    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${device}-${name}.png`) });
    const press = (selector: string) => (device === 'phone' ? page.tap(selector) : page.click(selector));
    /** Tap Send with `text` in the box and sample every frame for `ms`. */
    const sendAndWatch = async (text: string, ms = 3000, box = '#agentChatText', button = '#agentChatSend', pictures = '', moments = [300, 1200]): Promise<Frame[]> => {
      // Just after a read has landed, so the next one is a whole poll away
      // and cannot happen to scroll the message into view for the screen.
      await page.waitForResponse((response) => response.request().method() === 'GET'
        && /\/api\/(recap\/chat|agents\/[^/]+\/chat|messages\/[^/?]+)(\?|$)/.test(new URL(response.url()).pathname + new URL(response.url()).search), { timeout: 6000 }).catch(() => null);
      await page.fill(box, text);
      await page.waitForSelector(`${button}:not([disabled])`);
      await page.evaluate(({ words, span }) => {
        const frames: Frame[] = ((window as unknown as { sendFrames: Frame[] }).sendFrames = []);
        document.querySelector(span.button)!.addEventListener('click', () => {
          const t0 = performance.now();
          const sample = () => {
            const pane = document.querySelector<HTMLElement>('.chatpane');
            const box = pane?.getBoundingClientRect();
            const log = document.querySelector<HTMLElement>('#recapChatLog, #agentChatLog, #screenDirectMessage .chatlog');
            const copies = [...(log?.querySelectorAll<HTMLElement>('.chatmsg.owner') ?? [])]
              .filter((node) => node.textContent?.includes(words));
            const node = copies.at(-1);
            const rect = node?.getBoundingClientRect();
            const shown = rect && box && rect.height
              ? Math.max(0, Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top)) / rect.height
              : 0;
            frames.push({
              t: Math.round(performance.now() - t0),
              copies: copies.length,
              shown: Math.round(shown * 100) / 100,
              opacity: node ? Math.round(Number(getComputedStyle(node).opacity) * 100) / 100 : 0,
              bottom: rect && box ? Math.round(box.bottom - rect.bottom) : -1,
              // Where it stands in the conversation itself, which a typing
              // bubble arriving under it does not move.
              top: rect && log ? Math.round(rect.top - log.getBoundingClientRect().top) : -1,
              height: rect ? Math.round(rect.height) : 0,
              sending: Boolean(node?.classList.contains('sending')),
              rows: log?.querySelectorAll('.chatmsg').length ?? 0,
            });
            if (performance.now() - t0 < span.ms) requestAnimationFrame(sample);
          };
          sample();
        }, { capture: true, once: true });
      }, { words: text, span: { ms, button } });
      await press(button);
      if (SHOTS && pictures) {
        let at = 0;
        for (const moment of moments) {
          await page.waitForTimeout(moment - at); at = moment;
          await shot(`${pictures}-${String(moment).padStart(4, '0')}ms`);
        }
        await page.waitForTimeout(Math.max(0, ms - at));
      }
      await page.waitForTimeout(SHOTS && pictures ? 300 : ms + 300);
      const frames = await page.evaluate(() => (window as unknown as { sendFrames: Frame[] }).sendFrames);
      if (process.env.TRACE) console.log(frames.map((f) => JSON.stringify(f)).join('\n'));
      return frames;
    };
    /**
     * The message is in place on screen within `within` ms of the tap — in
     * the first frame drawn after it — and has risen in (its entrance starts
     * transparent) to full strength within 400 ms;
     * from then on it stays on screen, there is never more than one of it, and
     * the server's row takes the bubble's place without moving or blinking.
     */
    const judge = (label: string, frames: Frame[], within = 50) => {
      const placed = (f: Frame) => f.copies >= 1 && f.shown >= 0.99;
      const first = frames.find(placed);
      const strong = frames.find((f) => placed(f) && f.opacity >= 0.95);
      const after = first ? frames.filter((f) => f.t >= first.t) : [];
      const lost = after.filter((f) => !placed(f));
      const blinks = strong ? frames.filter((f) => f.t > strong.t && f.opacity < 0.55) : [];
      const doubled = frames.filter((f) => f.copies > 1);
      const answered = frames.find((f) => !f.sending && f.copies === 1);
      check(`${device} · ${label}: in place on screen ${first ? `${first.t} ms` : 'never'} after the tap (≤ ${within} ms)`, Boolean(first) && first!.t <= within, JSON.stringify(first ?? frames.at(-1) ?? null));
      check(`${device} · ${label}: fully drawn ${strong ? `${strong.t} ms` : 'never'} after the tap (≤ 400 ms)`, Boolean(strong) && strong!.t <= 400, JSON.stringify(strong ?? null));
      check(`${device} · ${label}: stays on screen, no blink, through the server's answer (${answered ? `row at ${answered.t} ms` : 'no row yet'})`, lost.length === 0 && blinks.length === 0,
        lost.length || blinks.length ? JSON.stringify({ off: lost.length, blinks: blinks.length, e: lost[0] ?? blinks[0] }) : '');
      check(`${device} · ${label}: one copy, never two`, doubled.length === 0, doubled.length ? `${doubled.length} frames, from ${doubled[0]!.t} ms` : '');
      const swap = answered ? frames[frames.indexOf(answered) - 1] : undefined;
      check(`${device} · ${label}: the server's row takes the bubble's place without a jump`, Boolean(answered && swap) && Math.abs(answered!.top - swap!.top) <= 2 && Math.abs(answered!.height - swap!.height) <= 2 && answered!.opacity >= 0.95,
        JSON.stringify({ before: swap ?? null, row: answered ?? null }));
    };

    // 1. The Chief of Staff's chat, at its newest message.
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#recapChatLog .chatmsg', { timeout: 20_000 });
    await page.waitForTimeout(2500);
    let frames = await sendAndWatch(`Is the booking page live yet (${device})?`, 3000, undefined, undefined, 'cos');
    judge('Chief of Staff', frames);
    await page.waitForTimeout(1000);
    await shot('cos-answered');

    // 1b. The answer slower than a poll: the poll brings the row first.
    answerAfter.ms = 4500;
    frames = await sendAndWatch(`And the calendar (${device})?`, 5500, undefined, undefined, 'cos-poll', [3600]);
    judge('Chief of Staff, a poll first', frames);
    check(`${device} · Chief of Staff: the box is empty`, (await page.inputValue('#agentChatText')) === '');

    // 2. A refused send: said, and the words are back to be sent again.
    refuse.next = true;
    await page.fill('#agentChatText', 'Please deploy it now.');
    await press('#agentChatSend');
    await page.waitForTimeout(1200);
    const refused = await page.evaluate(() => ({
      box: (document.getElementById('agentChatText') as HTMLTextAreaElement).value,
      said: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent ?? '').join(' | '),
      bubbles: [...document.querySelectorAll('#recapChatLog .chatmsg.owner')].filter((node) => node.textContent?.includes('Please deploy it now.')).length,
    }));
    check(`${device} · Chief of Staff: a refused send says so and puts the words back to send again`, refused.box === 'Please deploy it now.' && /could not take that/.test(refused.said) && refused.bubbles === 0, JSON.stringify(refused));
    await shot('cos-refused');
    await page.fill('#agentChatText', '');

    // 3. A room agent's chat.
    await page.goto(`${ORIGIN}/chat/felix`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#agentChatLog .chatmsg', { timeout: 20_000 });
    await page.waitForTimeout(2500);
    frames = await sendAndWatch(`Ship the checkout page when the checks pass (${device}).`, 3500, undefined, undefined, 'agent');
    judge('agent chat', frames);
    await shot('agent-answered');

    // 4. A message to a person in the workplace.
    const seed = await workspaceWebAuth.startEnrollment(`mira_${device}`);
    const mira = await workspaceWebAuth.finishEnrollment({ enrollmentToken: seed.enrollmentToken, code: generateTotpCode(seed.secret) });
    await userStorage.updateProfile(mira.userId, { person: { firstName: 'Mira', lastName: 'Chen' } } as never);
    await orgStorage.addMember({ orgId: org.orgId, userId: mira.userId, role: 'member' });
    for (let n = 0; n < 40; n += 1) {
      const [from, to] = n % 2 ? [mira.userId, owner.userId] : [owner.userId, mira.userId];
      await directMessageStorage.send(org.orgId, from, to, `Note ${n + 1} about the launch: the copy, the pictures and the timing.`, `seed-${device}-${n}`);
    }
    await page.goto(`${ORIGIN}/messages/${mira.userId}?org=${org.orgId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#screenDirectMessage textarea:not([disabled])', { timeout: 20_000 });
    await page.waitForSelector('#screenDirectMessage .chatlog .chatmsg');
    await page.waitForTimeout(1500);
    frames = await sendAndWatch(`See you at the launch (${device}).`, 3000, '#screenDirectMessage textarea', '#directMessageForm button[type="submit"]', 'person');
    judge('message to a person', frames);
    check(`${device} · message to a person: the box is empty`, (await page.inputValue('#screenDirectMessage textarea')) === '');
    await shot('person-answered');

    check(`${device} · no page errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
