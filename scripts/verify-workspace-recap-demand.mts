// Note #607, the owner: "AI generation should happen only on demand. On
// button click." Drives the real recap routes and the built Workspace in
// Chrome. Nothing writes a recap by itself — not opening Home, the agents
// picker or the Workplace window, not an agent's turn ending, not a reload —
// while the activity underneath keeps being collected; and an explicit write
// starts exactly one run over the week as it stands, and nothing retries a
// run that failed.
//
// The press was the button on a room's briefing card, and this check drove
// that card — its words while writing, its row at 320px, its place above a
// room's shelf tabs, its words standing through a room switch — until rooms
// left the product (note #843): the card went with the room view and is
// drawn nowhere now, which this proves along with the Workspace never asking
// for a briefing to be written. The write is made through the route the
// card used. A briefing was each room's alone (note #688) until stage 3 of
// note #843 made it one per workplace: an address that still names a room
// reads that one briefing.
// The screenshot lands in ~/mini-preview/n843-recap-nowhere.png.
//
//   npm --prefix backend run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-recap-demand.mts
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
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { InMemoryWorkspaceWebAuthStorage, WorkspaceWebAuthService } from '../backend/src/services/workspace-web-auth.js';
import type { WorkspaceRecapAnswer, WorkspaceRecapRun } from '../backend/src/shared/workspace-recap.js';
import { harnessMailService, harnessEstablishedWorkplace, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';
import { openAgentsPicker, openWorkplaceWindow } from './workspace-harness-home.mjs';

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

const PORT = Number(process.env.PORT || 4191);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const userStorage = new InMemoryUserStorage();
const orgStorage = new InMemoryOrgStorage();
// The workplace this harness founds is one that is already set up: its
// cloud is connected and a subscription is signed in, so the Workspace
// opens instead of holding on the first-run setup steps.
harnessEstablishedWorkplace(orgStorage);
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(), userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(), mailbox.config, mailbox.mailboxes,
);

/** Every model run this harness sees, each held open until it is released. */
const runs: Array<{ prompt: string; release: (run: WorkspaceRecapRun) => void }> = [];
let messages = [{ seq: 1, role: 'owner' as const, text: 'Keep the launch plan current.', at: new Date().toISOString() }];
// Asserted rather than annotated: the router assigns it from inside a
// callback, which the type checker cannot see, and an annotated `null` is
// narrowed to `never` at the call below.
let activity = null as ((event: { userId: string; agentId: string; kind: string }) => void) | null;
const deps = {
  userStorage, orgStorage, workspaceWebAuth, mailboxes: mailbox.mailboxes, workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'), workspaceUiDefault: 'react',
  agentLifecycle: {
    summarizeWorkspaceRecap: (_userId: string, _orgId: string, prompt: string) => new Promise<WorkspaceRecapRun>((resolve) => {
      runs.push({ prompt, release: resolve });
    }),
    agentChatMessages: async () => messages,
    onWorkspaceActivity: (listener: typeof activity) => { activity = listener; return () => {}; },
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
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BRIEFING = [
  'You have the launch plan drafted and Rosa has published it to the landing page.',
  'The audience decision is the one thread nothing else has moved on, which probably means it is waiting on you rather than on an agent.',
  'I would settle the audience before the next publish, unless you know something the material does not show.',
].join('\n');

const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) browserErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !(
      response.status() === 401 && response.url().includes('/auth/session')
      || response.status() === 404 && response.url().endsWith('/favicon.ico')
    )) browserErrors.push(`${response.status()} ${response.url()}`);
  });
  // Every write the Workspace itself asks of the briefing route. Counted
  // only while the harness makes no request of its own (`asking` below).
  // (Its READ is not counted: the provider still reads the briefing on every
  // Home load, though nothing draws it since note #843.)
  const workspaceAsked: string[] = [];
  let asking = false;
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (!asking && pathname === '/workspace/api/recap/write') {
      workspaceAsked.push(`${request.method()} ${pathname}`);
    }
  });

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'recap-demand@example.com');
  // One workplace, one briefing (note #843).
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Recap studio' });
  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  // Seeded before Home is ever drawn: /api/recap holds a source collection
  // for a minute, and an agent added after the first read would be invisible.
  await userStorage.updateProfile(me.userId, {
    telegram: { ...(me.telegram ?? {}), agents: {
      rosa: {
        id: 'rosa', name: 'Rosa', cli: 'codex', model: 'gpt-5.6-terra', effort: 'medium', orgId: org.orgId,
        createdAt: iso(300), connectedAt: iso(300), serverId: 'fly_ia-rosa.aa11bb22cc33dd',
        lastActivityAt: iso(2), recap: { text: 'Prepared the launch plan.', at: iso(2) },
      },
      ivy: {
        id: 'ivy', name: 'Ivy', cli: 'codex', model: 'gpt-5.6-terra', effort: 'medium', orgId: org.orgId,
        createdAt: iso(300), connectedAt: iso(300), serverId: 'fly_ia-ivy.aa11bb22cc33dd',
        lastActivityAt: iso(3), recap: { text: 'Sorted the annex inventory.', at: iso(3) },
      },
    } as never },
  });
  /** The workplace's briefing route, asked from the page with its session —
   *  the read and the write the card made (note #688) while it stood. An
   *  old address may still name a room in `query`, which nothing reads. */
  const recapRoute = async (route: 'api/recap' | 'api/recap/write', query = '') => {
    asking = true;
    try {
      return await page.evaluate(async (route: string, query: string) => {
        const csrf = document.cookie.split(';').map((pair) => pair.trim()).find((pair) => /^(__Host-)?acc_csrf=/.test(pair))?.split('=')[1] ?? '';
        const write = route.endsWith('/write');
        const answer = await fetch(`/workspace/${route}${query}`, {
          method: write ? 'POST' : 'GET',
          credentials: 'same-origin',
          headers: write ? { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) } : {},
          body: write ? '{}' : undefined,
        });
        return { status: answer.status, body: await answer.json().catch(() => null) };
      }, route, query) as { status: number; body: WorkspaceRecapAnswer | null };
    } finally {
      asking = false;
    }
  };

  // 1. A reader who never asks. Home, the agents picker, the Workplace
  //    window and a reload open, and nothing writes a briefing: there is no
  //    card left to draw one, nor a button to ask for one (note #843).
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome #agentChatSwitch', { timeout: 15_000 });
  const cards: string[] = [];
  const cardHere = async (where: string) => {
    if (await page.$('#workspaceRecap, #recapWrite, #overviewRuntimeControl')) cards.push(where);
  };
  await cardHere('Home');
  await openAgentsPicker(page, ORIGIN);
  await cardHere('the agents picker');
  await page.screenshot({ path: path.join(OUT, 'n843-recap-nowhere.png') as `${string}.png` });
  await settleAfterShot(page);
  await openWorkplaceWindow(page, ORIGIN);
  await page.waitForSelector('#homeSheet #homeWorkplace #indexChiefOfStaff', { timeout: 10_000 });
  await cardHere('the Workplace window');
  await page.reload({ waitUntil: 'networkidle0' });
  await cardHere('Home after a reload');
  await pause(1_500);
  check('no briefing card and no Refresh stand anywhere: Home, the agents picker, the Workplace window, a reload',
    cards.length === 0, cards.join(', '));
  check('the Workspace never asks for a briefing to be written', workspaceAsked.length === 0, workspaceAsked.join(', '));
  check('opening the Workspace wrote nothing', runs.length === 0, `${runs.length} run(s)`);

  // 2. An agent's turn ends: the week is re-read, and still nothing is written.
  messages = [...messages, { seq: 2, role: 'agent' as never, text: 'Published the launch plan to the landing page.', at: new Date().toISOString() }];
  if (!activity) throw new Error('the router registered no activity listener');
  activity({ userId: me.userId, agentId: 'rosa', kind: 'turn-ended' });
  let collected = false;
  for (let i = 0; i < 40 && !collected; i += 1) {
    collected = JSON.stringify((await recapRoute('api/recap')).body?.sources ?? []).includes('Published the launch plan');
    if (!collected) await pause(50);
  }
  check('an agent’s turn ending is collected at once', collected);
  check('…and writes nothing', runs.length === 0, `${runs.length} run(s)`);

  // 3. The write — what the card's button sent — starts exactly one run,
  //    over the week as it stood, including what arrived since Home opened.
  const press = await recapRoute('api/recap/write');
  check('a write is accepted', press.status >= 200 && press.status < 300, `${press.status} ${JSON.stringify(press.body)}`);
  for (let i = 0; i < 40 && runs.length === 0; i += 1) await pause(50);
  check('the write started exactly one run', runs.length === 1, `${runs.length} run(s)`);
  check('…over the week as it stood, including what arrived since Home opened', Boolean(runs[0]?.prompt.includes('Published the launch plan')));

  // 4. The words land, saved as the workplace's one briefing.
  runs[0]?.release({ text: BRIEFING });
  let saved = '';
  for (let i = 0; i < 40 && saved !== BRIEFING; i += 1) {
    saved = (await recapRoute('api/recap')).body?.summary?.text ?? '';
    if (saved !== BRIEFING) await pause(100);
  }
  check('the run’s words are saved whole, all three bullets', saved === BRIEFING, JSON.stringify(saved));
  check('…kept on the reader’s membership of the workplace',
    (await orgStorage.getMembership(org.orgId, me.userId))?.workspaceRecap?.text === BRIEFING);
  // Each room had its own until stage 3 of note #843 (note #688): an old
  // address that still names one reads the workplace's briefing, the same.
  const oldRoomAnswer = await recapRoute('api/recap', '?room=room_annex');
  check('an old address naming a room reads the workplace’s one briefing',
    oldRoomAnswer.status === 200 && oldRoomAnswer.body?.summary?.text === BRIEFING, JSON.stringify(oldRoomAnswer.body?.summary ?? null));

  // 5. A reload reads nothing and writes no other.
  await page.reload({ waitUntil: 'networkidle0' });
  await pause(1_000);
  check('a reload writes no other', runs.length === 1, `${runs.length} run(s)`);

  // 6. A write that fails is not tried again by itself.
  await recapRoute('api/recap/write');
  for (let i = 0; i < 40 && runs.length < 2; i += 1) await pause(50);
  check('a second write starts a second run', runs.length === 2, `${runs.length} run(s)`);
  runs[1]?.release({ failure: 'model' });
  await pause(1_500);
  check('…and when it fails, nothing tries again by itself', runs.length === 2, `${runs.length} run(s)`);
  const kept = (await recapRoute('api/recap')).body?.summary?.text ?? '';
  check('…and the saved briefing stays', kept === BRIEFING, JSON.stringify(kept));
  check('the Workspace still never asked for one to be written', workspaceAsked.length === 0, workspaceAsked.join(', '));
  check('the browser raised no page errors', browserErrors.length === 0, browserErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
