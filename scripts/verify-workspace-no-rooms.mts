// Note #843, stages 2 and 3: rooms leave the Workspace's screens, then its
// data. The owner, Adam:
// "Let's remove rooms." One flat list of every agent, notes the workplace's
// own, secrets with no "only in these rooms", a knowledge shelf with no room
// grouping or label — and an old link that still carries `&room=` opens the
// same screen with the word dropped.
//
// Driven in real Chrome against a real workplace with six agents, notes, a
// knowledge shelf and secrets — one of them a key limited to a room before
// stage 3, which still carries that stale limit in storage and must reach
// every agent all the same. It drove a workplace the backend still filed
// under TWO rooms until stage 3 dropped rooms from the data (note #923).
//
// At a desk (1440px) and on a phone (390px), on Home with the agents picker
// open, the notes list, one note, the secrets screen and the knowledge list,
// it asserts that no room word, tab, chip or picker is visible; that the
// picker lists every agent in one list; that the old room-limited key
// reaches every agent; that no request the Workspace makes names a room;
// that an old note
// link with `&room=` opens the note; and that the retired `/rooms` addresses
// land on Home.
//
// Screenshots land in OUT_DIR (~/n843-proof by default).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-no-rooms.mts
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';
import { settleAfterShot } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { GitHostClient } from '../backend/src/services/git-host-client.js';
import { InMemoryKnowledgePageCommentStorage } from '../backend/src/services/knowledge-page-comments.js';
import { InMemoryKnowledgeProposalStorage } from '../backend/src/services/knowledge-storage.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { OrgGitService, orgKnowledgeShelfNamespace } from '../backend/src/services/org-git.js';
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
import { InMemorySecretStorage } from '../backend/src/services/secret-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import {
  harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace,
} from './workspace-harness-auth.mjs';
import { closeHomeWindow, openAgentsPicker, pickerAgentIds } from './workspace-harness-home.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n843-proof');
mkdirSync(OUT, { recursive: true });

/** The Chrome puppeteer downloaded, whichever build it is. */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4843);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

// ---- The knowledge shelf, behind the real git host client ------------------
const sha1 = (content: string) => createHash('sha1').update(content).digest('hex');
const pageSource = (title: string, description: string, body: string) =>
  `<!doctype html><title>${title}</title><meta name="description" content="${description}">`
  + `<h1>${title}</h1>${body}`;
const knowledgeFiles = new Map<string, string>();
const PAGES = [
  { name: 'how-a-change-reaches-production', title: 'How a change reaches production', description: 'What runs when a change lands on main, and how to tell it arrived.' },
  { name: 'landing-page-rules', title: 'Landing page rules', description: 'What the front page may promise, and the pictures it uses.' },
  { name: 'running-the-ledger', title: 'Running the token ledger', description: 'How the subscription counts are read and checked.' },
];
{
  const pages: Record<string, unknown> = {};
  PAGES.forEach((page, at) => {
    const content = pageSource(page.title, page.description, `<p>${page.description}</p>`);
    knowledgeFiles.set(`pages/${page.name}.html`, content);
    pages[page.name] = {
      title: page.title, description: page.description,
      updatedAt: iso((at + 1) * 60), bytes: Buffer.byteLength(content, 'utf8'), updatedByAgentId: at === 1 ? 'noah' : 'oscar',
    };
  });
  knowledgeFiles.set('index.json', JSON.stringify({ pages }));
}
const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
  const route = String(url).replace('http://host', '');
  const body = JSON.parse(init?.body ?? '{}') as { page?: string };
  const answer = (payload: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(payload) });
  if (route === '/internal/knowledge/list') {
    return answer({
      pages: [...knowledgeFiles.entries()].filter(([file]) => file.startsWith('pages/')).map(([file, content]) => ({
        name: file.slice('pages/'.length, -'.html'.length), sha: sha1(content), sizeBytes: Buffer.byteLength(content, 'utf8'),
      })),
      index: knowledgeFiles.get('index.json') ?? null,
    });
  }
  if (route === '/internal/knowledge/read') {
    const content = knowledgeFiles.get(`pages/${body.page}.html`);
    if (content === undefined) return answer({ error: 'no such page' }, 409);
    return answer({ content, sha: sha1(content), sizeBytes: content.length });
  }
  return answer({ error: 'no such control route' }, 404);
}) as unknown as typeof fetch;

// ---- The backend ------------------------------------------------------------
const userStorage = new InMemoryUserStorage();
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(),
  mailbox.config,
  mailbox.mailboxes,
);
const orgStorage = new InMemoryOrgStorage();
harnessEstablishedWorkplace(orgStorage);
const quickNoteStorage = new InMemoryQuickNoteStorage();
const secretStorage = new InMemorySecretStorage();

/** Conversations are scenery; Oscar and Clara are mid-turn. */
const agentLifecycle = {
  agentChatMessages: async () => [],
  isAgentWorking: (_userId: string, agentId: string) => agentId === 'oscar' || agentId === 'clara',
  agentActivity: () => null,
  listManagedJobs: async () => ({ jobs: [], recent: [] }),
} as unknown as RouteDeps['agentLifecycle'];

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  orgStorage,
  orgGit: new OrgGitService({ orgStorage }),
  quickNoteStorage,
  secretStorage,
  knowledgeProposalStorage: new InMemoryKnowledgeProposalStorage(),
  knowledgePageCommentStorage: new InMemoryKnowledgePageCommentStorage(),
  gitHostClient: new GitHostClient({ baseUrl: 'http://host', controlUrl: 'http://host', secret: 's', fetchImpl }),
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  agentLifecycle,
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

/** A room word as a reader meets it. "Room" in "room to spare" would be a
 *  false alarm, but none of these screens says that, and a strict word is
 *  what makes this check worth having. */
const ROOM_WORD = /\brooms?\b/i;

/** What a reader can see or hear of the page: its rendered text, and every
 *  visible control's accessible name and title. */
async function readable(page: Page): Promise<string> {
  return page.evaluate(() => {
    const seen = (node: Element) => {
      const element = node as HTMLElement;
      if (element.closest('[hidden], [aria-hidden="true"]')) return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const labels = [...document.querySelectorAll('[aria-label], [title], [placeholder]')]
      .filter(seen)
      .map((node) => [node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('placeholder')].filter(Boolean).join(' '));
    return `${document.body.innerText}\n${labels.join('\n')}`;
  });
}

/** The room controls the Workspace used to draw, by the ids and classes that
 *  drew them. None may be in the page at all. */
const ROOM_CONTROLS = [
  '#agentSwitchTabs', '[role="tab"][data-room-id]', '#agentSwitchRoom', '#agentSwitchNoRooms', '#agentChatRoom', '.chatroom',
  '#roomChips', '.roomchip', '#roomSection', '#roomContentTabs', '#homeManageRooms', '#homeNameExistingWork',
  '#secretRooms', '#secretRoomPicks', '#secretRenamed', '#noteRoomSub', '#recapAgentRoom', '.kgroup', '.mroom',
  '#screenRoomPicker', '#screenRoomDetail', '#workspaceRecap',
];

async function noRooms(page: Page, where: string): Promise<void> {
  const words = await readable(page);
  const hit = words.split('\n').find((line) => ROOM_WORD.test(line));
  check(`${where}: no room word anywhere a reader can see or hear`, !hit, hit ?? '');
  const controls = await page.evaluate((selectors: string[]) => selectors.filter((selector) => document.querySelector(selector)), ROOM_CONTROLS);
  check(`${where}: no room tab, chip, picker or label in the page`, controls.length === 0, controls.join(' '));
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  // tsx compiles a named helper inside an evaluated function into a
  // `__name(...)` call the page does not have; every document gets one.
  await page.evaluateOnNewDocument('window.__name = (fn) => fn');
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const consoleErrors: string[] = [];
  const roomRequests: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    // Every call the Workspace makes, page-initiated: none may name a room.
    if (url.origin === ORIGIN && url.pathname.startsWith('/workspace/api/') && url.searchParams.has('room')) roomRequests.push(request.url());
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    const expected = (response.status() === 401 && url.pathname === '/workspace/auth/session')
      || (response.status() === 404 && url.pathname === '/favicon.ico')
      || (response.status() === 503 && url.pathname === '/workspace/api/drive');
    if (response.status() >= 400 && !expected) consoleErrors.push(`${response.status()} ${response.url()}`);
  });
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png` });
    await settleAfterShot(page);
  };
  const sheetSettled = () => page.waitForFunction(() => {
    const sheet = document.getElementById('agentSwitchSheet');
    return Boolean(sheet) && sheet!.getAnimations().length === 0 && sheet!.parentElement!.getAnimations().length === 0;
  }, { timeout: 10_000 });

  // 1. A workplace with six agents, notes on the workplace's shelf, a
  //    knowledge shelf and keys.
  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Nomad Trading' });
  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  const seed = (id: string, name: string, minutesAgo: number, recap: string) => [id, {
    id, name, cli: 'claude', createdAt: iso(60 * 24 * 4), serverId: `m-${id}`,
    connectedAt: iso(60 * 24 * 4), model: 'opus', effort: 'high', orgId: org.orgId,
    lastActivityAt: iso(minutesAgo), recap: { text: recap, at: iso(minutesAgo) },
  }] as const;
  const AGENTS = [
    seed('alex', 'Alex', 2, 'Made the agents picker one flat list.'),
    seed('oscar', 'Oscar', 30, 'Token ledger on Subscriptions counts Claude turns exactly.'),
    seed('ada', 'Ada', 90, 'Trimmed the agent instruction file.'),
    seed('noah', 'Noah', 12, 'Mocked storyboard pictures for the landing page.'),
    seed('clara', 'Clara', 5, 'Built per-day working-time counting for the Leaderboard.'),
    seed('rosa', 'Rosa', 300, 'Checked who may delete a workplace.'),
  ];
  await userStorage.updateProfile(me.userId, {
    telegram: { ...(me.telegram ?? {}), agents: Object.fromEntries(AGENTS) as never },
  });
  const shelf = orgKnowledgeShelfNamespace(org);
  const first = await quickNoteStorage.create({
    userId: shelf, html: '<h2>Landing page storyboard</h2><p>Pictures 3 to 12, the clay Ruby last.</p>',
    createdByAgentId: 'noah', updatedByAgentId: 'noah',
  });
  await quickNoteStorage.create({
    userId: shelf, html: '<h2>Token ledger follow-ups</h2><p>Codex counting is still unproven.</p>',
    createdByAgentId: 'oscar', updatedByAgentId: 'oscar',
  });
  await quickNoteStorage.create({
    userId: shelf, html: '<h2>Ask Adam about the infra keys</h2><p>Which of them every agent should be handed.</p>',
    createdByAgentId: 'user', createdByUserId: account.userId, updatedByAgentId: 'user',
  } as never);

  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome #agentChatSwitch', { timeout: 15_000 });
  // Two keys, through the Workspace's own routes: one for every agent, and
  // one limited to a Platform room before stage 3 — the row that used to
  // say "Only in Platform". Nobody can set that limit any more (the route
  // answers 410 since stage 2) and nothing reads it since stage 3, but a key
  // limited before then may still carry the stale field in its stored
  // document; it is put there by hand (the in-memory store hands back its
  // own record), naming a room that no longer exists anywhere.
  const keys = await page.evaluate(async () => {
    const csrf = document.cookie.split(';').map((pair) => pair.trim()).find((pair) => /^(__Host-)?acc_csrf=/.test(pair))?.split('=')[1] ?? '';
    const send = (path: string, method: string, body: unknown) => fetch(`/workspace/${path}`, {
      method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, body: JSON.stringify(body),
    }).then((answer) => answer.status);
    return [
      await send('api/secrets', 'POST', { name: 'OPENAI_API_KEY', value: 'sk-harness-one' }),
      await send('api/secrets', 'POST', { name: 'FLY_API_TOKEN', value: 'fly-harness-two' }),
    ];
  });
  const limited = await secretStorage.getSecretByKey(shelf, 'user-env:FLY_API_TOKEN');
  if (limited) Object.assign(limited, { rooms: ['room_platform'] });
  const stale = await secretStorage.getSecretByKey(shelf, 'user-env:FLY_API_TOKEN');
  check('the fixture keys were saved, one still carrying a stale room limit in storage',
    keys.join('|') === '200|200' && JSON.stringify((stale as { rooms?: string[] } | null)?.rooms) === '["room_platform"]',
    `${keys.join('|')} ${stale ? JSON.stringify((stale as { rooms?: string[] }).rooms ?? null) : 'not found on the shelf'}`);

  for (const [width, height, label] of [[1440, 900, 'desk'], [390, 844, 'phone']] as const) {
    await page.setViewport({ width, height, deviceScaleFactor: label === 'phone' ? 2 : 1 });

    // 2. Home, with the agents picker open: one list of every agent.
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
    await closeHomeWindow(page);
    await openAgentsPicker(page, ORIGIN);
    await page.waitForFunction((count: number) => document.querySelectorAll('#agentSwitchGrid .crow[data-agent]').length === count, { timeout: 10_000 }, AGENTS.length);
    await sheetSettled();
    await page.waitForFunction(
      () => [...document.querySelectorAll<HTMLImageElement>('#agentSwitchSheet img')].every((img) => img.complete),
      { timeout: 10_000 },
    ).catch(() => null);
    const ids = await pickerAgentIds(page);
    check(`${label}: the agents picker lists every agent in the workplace`,
      [...ids].sort().join('|') === AGENTS.map(([id]) => id).sort().join('|'), ids.join('|'));
    check(`${label}: …in ONE list — one grid, no tab row over it`,
      (await page.$$('#agentSwitchSheet .plates')).length === 1 && !(await page.$('#agentSwitchSheet [role="tablist"]')));
    check(`${label}: …working agents first`,
      ids.slice(0, 2).sort().join('|') === 'clara|oscar', ids.join('|'));
    check(`${label}: …and the way to make another agent stands in it`, Boolean(await page.$('#agentSwitchGrid #newAgentBtn')));
    check(`${label}: the button says what it opens without a room in it`,
      !ROOM_WORD.test(await page.$eval('#agentChatSwitch', (node) => node.getAttribute('aria-label') ?? '')));
    await noRooms(page, `${label} Home with the agents picker`);
    await shot(`no-rooms-home-picker-${label}`);
    await closeHomeWindow(page);
    await noRooms(page, `${label} Home`);

    // 3. The notes: one list, the workplace's.
    await page.goto(`${ORIGIN}/notes?org=${encodeURIComponent(org.orgId)}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#screenNotes #notesList .crow', { timeout: 10_000 });
    const notes = await page.$$eval('#notesList .crow .name', (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''));
    check(`${label}: the notes list is the workplace's one list`,
      notes.length === 3 && notes.includes('Landing page storyboard'), notes.join('|'));
    await noRooms(page, `${label} notes list`);
    await shot(`no-rooms-notes-${label}`);

    // 4. One note: no "in <room>" under its title, no Move note.
    await page.goto(`${ORIGIN}/notes/${first.number}?org=${encodeURIComponent(org.orgId)}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('noteTitle')?.textContent?.includes('Landing page storyboard'), { timeout: 10_000 });
    await page.waitForSelector('#noteBody .kpage, #noteBody p', { timeout: 10_000 }).catch(() => null);
    check(`${label}: a note offers no Move note`,
      !(await page.$$eval('#noteActions button', (nodes) => nodes.some((node) => /move/i.test(node.textContent ?? '')))));
    await noRooms(page, `${label} a note`);
    await shot(`no-rooms-note-${label}`);

    // 5. The secrets: no "only in these rooms", even for the key stored
    //    with a stale room limit — which reaches every agent.
    await page.goto(`${ORIGIN}/secrets?org=${encodeURIComponent(org.orgId)}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelectorAll('#screenSecrets .crow').length >= 2, { timeout: 10_000 });
    await noRooms(page, `${label} secrets screen`);
    await shot(`no-rooms-secrets-${label}`);
    await page.goto(`${ORIGIN}/secrets/FLY_API_TOKEN?org=${encodeURIComponent(org.orgId)}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#secretCard .drow', { timeout: 10_000 });
    const audience = await page.$eval('#secretAudience', (node) => (node as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).catch(() => '(no audience row)');
    // All six are the admin's own, so the key reaches each of them whatever
    // its audience; the stale limit narrows nothing.
    check(`${label}: the key once limited to a room reaches every agent in the workplace`,
      audience.includes('Reaches Ada, Alex, Clara, Noah, Oscar and Rosa'), audience);
    await noRooms(page, `${label} the once room-limited key's own screen`);

    // 6. The knowledge shelf: one list, no room grouping, no room label.
    await page.goto(`${ORIGIN}/knowledge?org=${encodeURIComponent(org.orgId)}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction((count: number) => document.querySelectorAll('#knowledgeList .crow').length === count, { timeout: 10_000 }, PAGES.length);
    check(`${label}: the knowledge shelf is one list, not grouped`, !(await page.$('#knowledgeList section')));
    await noRooms(page, `${label} knowledge list`);
    await shot(`no-rooms-knowledge-${label}`);
  }

  // 7. An old note link, still carrying the room it was copied from, opens
  //    the note — the word dropped, the note the same.
  await page.goto(`${ORIGIN}/notes/${first.number}?org=${encodeURIComponent(org.orgId)}&room=room_growth`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.getElementById('noteTitle')?.textContent?.includes('Landing page storyboard'), { timeout: 10_000 }).catch(() => null);
  check('an old link /notes/N?org=…&room=… opens the note',
    (await page.$eval('#noteTitle', (node) => node.textContent ?? '').catch(() => '')).includes('Landing page storyboard'),
    await page.$eval('#screenNote', (node) => node.textContent?.slice(0, 160) ?? '').catch(() => 'no note screen'));
  await noRooms(page, 'an old note link');

  // 8. The retired addresses: the rooms list and a room's screen open Home.
  for (const address of ['/rooms', `/rooms/room_growth?org=${encodeURIComponent(org.orgId)}`]) {
    await page.goto(`${ORIGIN}${address}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#screenHome', { timeout: 10_000 }).catch(() => null);
    check(`${address.split('?')[0]} lands on Home`, new URL(page.url()).pathname === '/' && Boolean(await page.$('#screenHome')), page.url());
  }

  check('no request the Workspace made named a room', roomRequests.length === 0, roomRequests.slice(0, 3).join(' | '));
  check('no unexpected browser errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (failures.length) {
  console.error(`\n${failures.length} FAILED: ${failures.join(' | ')}`);
  process.exitCode = 1;
} else {
  console.log('\nNo-rooms browser verification passed.');
}
