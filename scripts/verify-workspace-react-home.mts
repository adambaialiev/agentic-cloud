// Drives the React Workspace shell's HOME in real Chrome against a real
// backend router with an in-memory auth service and a seeded fleet: create
// access, land on Home, read the agent rows (state line, runtime, recap, the
// setup meter), open an agent from its row, come Back through the persistent
// header, and hand the New agent door to the classic Workspace. Screenshots
// land in ~/mini-preview/n256-home-*.png.
// Since 2026-10-10 Home (`/`) is the Chief of Staff's conversation (note
// #715), and /overview redirects to it. This fixture has no workplace, and
// without one `/` still draws the one-column overview (`#screenOverview`).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-react-home.mts
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
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessMailService, harnessSignedIn } from './workspace-harness-auth.mjs';
import {
  InMemoryWorkspaceNotificationStorage,
  WorkspaceNotificationService,
} from '../backend/src/services/workspace-notifications.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
// express lives in backend/node_modules; puppeteer-core in the root's.
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
/** Whichever Chrome puppeteer last installed here; the build number moves. */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4174);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const userStorage = new InMemoryUserStorage();
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
/** Moved before each seeded reply, so the unread card can be read at a
 *  KNOWN order and known ages: the service stamps `createdAt` from this. */
let ringingAt = new Date();
const workspaceNotifications = new WorkspaceNotificationService(
  new InMemoryWorkspaceNotificationStorage(), () => ringingAt,
);
/** The unread card reads an agent's newest words from the state answer's
 *  `lastReply`, which the route asks the lifecycle for. This fixture wires
 *  nothing else of the lifecycle on purpose — every other call is optional-
 *  chained or checks its own method, so the agent screen's reads keep
 *  answering 503 exactly as the walk below expects. */
const chatReplies: Record<string, { text: string; at: string }> = {};
const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceNotifications,
  agentLifecycle: { agentChatReplySeeds: async () => chatReplies },
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
} as RouteDeps;

const app = express();
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
// The shell itself answers at the root of the domain (public-addresses).
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

/** The one header, measured (note #282) — see the repositories harness for
 *  what each part of the string means. */
const headShape = async (page: import('puppeteer-core').Page) => page.evaluate(() => {
  const head = document.getElementById('pageHead');
  if (!head) return 'no header at all';
  const slot = document.getElementById('pageId');
  const title = head.querySelector('h1');
  if (!slot || !title) return 'the screen keeps its own heading';
  const style = getComputedStyle(head);
  const inset = Math.round(slot.getBoundingClientRect().top - head.getBoundingClientRect().top);
  return `rule=${style.borderBottomWidth} ${style.borderBottomStyle} · name ${inset}px in`;
});

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`); });
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `n256-${name}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  };
  const heading = async () => page.$eval('#webMain h2, #webMain h1', (node) => node.textContent?.trim() ?? '').catch(() => '');
  const waitHeading = async (text: string) => {
    await page.waitForFunction(
      (want: string) => [...document.querySelectorAll('#webMain h2')].some((node) => node.textContent?.trim() === want),
      { timeout: 10_000 },
      text,
    ).catch(() => {});
    return (await page.$$eval('#webMain h2', (nodes) => nodes.map((node) => node.textContent?.trim())))
      .includes(text);
  };
  // The overview has no title (the sections name themselves); its fleet heading is the sign it opened.
  const waitHome = async () => {
    await page.waitForSelector('#screenOverview #agentsSection', { timeout: 10_000 }).catch(() => {});
    return Boolean(await page.$('#screenOverview #agentsSection'));
  };

  const shotHome = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `n256-home-${name}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  };
  const rowTexts = async (selector: string) => page.$$eval(selector, (nodes) => nodes.map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''));

  // 1. Create access, land on an empty Home.
  await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  check('the overview opens after enrollment', await waitHome());
  check('an empty fleet gets the empty card with the creation door on it',
    Boolean(await page.$('.agentemptycard #newAgentBtn')));
  check('the counts describe the fleet being shown',
    (await page.$eval('#agentCounts', (node) => node.getAttribute('aria-label'))) === '0 agents total, 0 active, 0 idle');
  await shotHome('empty');

  // 2. Seed a fleet straight into the profile and reload.
  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  const now = new Date();
  const iso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(me.telegram ?? {}),
      agents: {
        felix: {
          // Fable, the Claude flagship, so this fleet carries a crown (note #296).
          id: 'felix', name: 'Felix', cli: 'claude', model: 'fable', createdAt: iso(60 * 24 * 3), serverId: 'm1', connectedAt: iso(60 * 24 * 3),
          lastActivityAt: iso(5), recap: { text: 'Built the landing page and proposed #12 for the checkout flow.', at: iso(5) },
          tasks: [{ text: 'Ship the checkout page', at: iso(6) }],
          // A comfortably open window: its ring should read green.
          contextUsage: { tokens: 40_000, window: 200_000, at: iso(6) },
          // The TOP rung, which is the longest machine line the ladder can
          // produce — the plate has to hold that one whole (note #396).
          machineSize: { cpuKind: 'performance', cpus: 8, memoryMb: 16384 },
        },
        mira: {
          // GPT-6 Astra, the Codex flagship, so this fleet carries the OTHER
          // crown (note #324) — one per harness, drawn by the same component.
          id: 'mira', name: 'Mira', cli: 'codex', model: 'gpt-6-astra', createdAt: iso(60 * 24 * 2), serverId: 'm2', connectedAt: iso(60 * 24 * 2),
          // A stamp alone is not use (PR #541): a task proves this agent has run.
          lastActivityAt: iso(60 * 26), tasks: [{ text: 'Tidy the inbox', at: iso(60 * 26) }],
          // Nearly full: the same ring has to arrive at red, not keep the
          // fleet's ordinary blue whatever the reading says (note #438).
          contextUsage: { tokens: 188_000, window: 200_000, at: iso(60 * 26) },
          machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
        },
        // No model of its own, so the server resolves the Claude default —
        // `opus`, deliberately a rung below the flagship, hence uncrowned.
        nova: { id: 'nova', name: 'Nova', cli: 'claude', createdAt: iso(1), serverId: 'm3' },
      } as never,
    },
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  check('the overview lists the seeded fleet', await waitHome() && (await page.$$('#agents .crow')).length === 3, String((await page.$$('#agents .crow')).length));
  // Note #412: no harness tabs over the grid — the fleet is read whole.
  check('nothing narrows the fleet above the grid',
    !(await page.$('#agentFilters')) && (await page.$$('#agentsSection .chip')).length === 0,
    String((await page.$$('#agentsSection .chip')).length));
  const names = await rowTexts('#agents .crow .name');
  check('most recently used first, the never-used last', names.join(',') === 'Felix,Mira,Nova', names.join(','));
  const rings = await page.$$eval('#agents .ctxring[role="img"]', (nodes) => nodes.map((node) => ({
    label: node.getAttribute('aria-label'),
    hue: (node as HTMLElement).style.getPropertyValue('--ctx-hue'),
    hot: node.classList.contains('hot'),
    paint: getComputedStyle(node, '::before').backgroundImage,
    fallbackMask: node.querySelector('.icon')
      ? getComputedStyle(node.querySelector('.icon')!).backgroundColor
      : null,
  })));
  check('context rings move from vivid green toward red as they fill',
    rings.length === 2
      && rings[0]?.label === 'Context window 20% full' && rings[0].hue === '112' && !rings[0].hot
      && rings[1]?.label === 'Context window 94% full' && rings[1].hue === '8' && rings[1].hot
      && rings.every((ring) => ring.paint.startsWith('conic-gradient(')
        && (ring.fallbackMask === null || !ring.fallbackMask.includes(' / '))),
    JSON.stringify(rings));
  const lines = await rowTexts('#agents .crow .cline');
  // Note #574: an age, not a calendar day. Felix worked 5 minutes before the
  // harness seeded it (and the page takes a while to get here), Mira 26 hours.
  check('state lines: active minutes ago, active a day ago, setting up', /Active \d+m ago/.test(lines[0] ?? '') && /Active 1d ago/.test(lines[1] ?? '') && /Setting up/.test(lines[2] ?? ''), lines.join(' | '));
  check('the runtime line names the model this agent thinks with',
    (await rowTexts('#agents .crow .cruntime'))[0]?.startsWith('fable') === true,
    (await rowTexts('#agents .crow .cruntime'))[0]);
  check('the recap sits under the state', (await rowTexts('#agents .crow .cabout'))[0]?.startsWith('Built the landing page') === true);
  check('the setup meter stands on the agent being made', Boolean(await page.$('#agents .crow:nth-child(3) .steps')));
  check('the counts describe the fleet', (await page.$eval('#agentCounts', (node) => node.getAttribute('aria-label'))) === '3 agents total, 0 active, 3 idle');
  // The overview is Home now (`/`): no persistent header stands over it.
  check('no persistent header over the overview, which is Home', !(await page.$('#pageHead')) && page.url() === `${ORIGIN}/`, page.url());
  // This fixture has no workplace store, so there is no workplace for an
  // agent to belong to: the door waits for one. It waited for a ROOM ("Create
  // a room first") until rooms left the product (note #843).
  check('with no workplace the creation door waits',
    (await page.$eval('#newAgentBtn', (node) => `${node.tagName}:${(node as HTMLButtonElement).disabled}:${node.textContent?.trim()}`)) === 'BUTTON:true:Create a workplace first');
  // Note #396: the harness is gone from the plate's runtime line. The model
  // beside it already names it, and it was 40% of a line too narrow to hold
  // the model and the effort. (It once also stood in a tab above this grid;
  // note #412 removed that, and the line stays as note #396 left it.)
  // `high`, not `xhigh`: on 2026-09-11 (9a22b56c) a new agent stopped starting
  // life in the heavy band, and Claude's preferred rung became `high`.
  check('the runtime line names the model the server resolved, and its effort',
    (await rowTexts('#agents .crow .cruntime'))[0] === 'fable · high', (await rowTexts('#agents .crow .cruntime'))[0]);
  check('…without spending that room on the harness the model already names',
    (await rowTexts('#agents .crow .cruntime')).every((line) => !/Claude Code|Codex/.test(line)),
    (await rowTexts('#agents .crow .cruntime')).join(' | '));
  check('and the machine it runs on sits under it, at the plate\u2019s full width',
    (await rowTexts('#agents .crow .cmachine'))[0] === '8 dedicated cores · 16 GB'
      && (await page.$$('#agents .crow .agentidentity .cruntime')).length === 0,
    (await rowTexts('#agents .crow .cmachine')).join(' | '));
  // Notes #296 and #324: the crown rides the NAME, and only for the flagship
  // of each CLI. Measured, not just found: it has to sit on the name's own
  // line rather than under it, and the face it used to live on has to be
  // clean again.
  check('a Fable agent wears the crown beside its name',
    Boolean(await page.$('#agents .crow:nth-child(1) .name > svg.crown')));
  check('…on the same line as the name, not below it', await page.$eval(
    '#agents .crow:nth-child(1) .name',
    (node) => {
      const name = node.querySelector('.nametext')!.getBoundingClientRect();
      const crown = node.querySelector('.crown')!.getBoundingClientRect();
      return crown.left >= name.right - 1 && crown.top < name.bottom && crown.bottom > name.top;
    },
  ));
  check('nothing is drawn on the face any more',
    !(await page.$('#agents .ctxring .crown')) && !(await page.$('#agents .avatar.crowned')));
  // What this once asserted was "exactly one crown in the fleet", which said
  // Fable. Now that each CLI has a flagship, a bare count cannot tell a
  // correct second crown from a wrongly-crowned agent — so read the fleet row
  // by row instead: Felix on Fable and Mira on GPT-6 Astra are marked, Nova
  // on the resolved Claude default is not.
  const crownedRows = await page.$$eval('#agents .crow', (nodes) => {
    const marks: string[] = [];
    for (const node of nodes) marks.push(node.querySelector('.name > svg.crown') ? 'crown' : 'bare');
    return marks.join(',');
  });
  check('each CLI flagship is crowned, and a model below one is not',
    crownedRows === 'crown,crown,bare', crownedRows);
  check('and no crown is drawn anywhere else on the fleet',
    (await page.$$('#agents .crown')).length === 2, String((await page.$$('#agents .crown')).length));
  // Both harnesses stand in the one grid, in the server's order, with the
  // counts describing all of them (note #412).
  check('every agent stands in the grid, whatever it runs',
    (await rowTexts('#agents .crow .name')).join(',') === 'Felix,Mira,Nova'
      && (await page.$eval('#agentCounts', (node) => node.getAttribute('aria-label'))) === '3 agents total, 0 active, 3 idle',
    `${(await rowTexts('#agents .crow .name')).join(',')} · ${await page.$eval('#agentCounts', (node) => node.getAttribute('aria-label'))}`);
  await shotHome('fleet');

  // 3. Unread replies (note #271): the row's mark is a DOT, and the number the
  // "new" pill used to carry moved onto the line of facts beside the time.
  chatReplies.felix = {
    // Long on purpose: the count must survive a preview that cannot fit, which
    // is exactly what `.ctext.keep` is for. A number that ellipsises away is
    // not a number.
    text: 'Pushed the branch and waited for the checks before proposing, so the card in your chat is safe to tap.',
    at: iso(4),
  };
  chatReplies.mira = { text: 'Inbox is tidy.', at: iso(30) };
  // The rows are ordered by their newest reply, so the stamps have to be real
  // ones: the service takes its clock from the constructor, and left at the
  // wall clock every seeding lands in the same millisecond and the order is
  // whatever the store happened to return.
  for (const [agentId, minutesAgo] of [['felix', 9], ['nova', 50], ['mira', 30], ['felix', 4]] as const) {
    ringingAt = new Date(now.getTime() - minutesAgo * 60_000);
    await workspaceNotifications.notify({
      userId: me.userId, kind: 'agent_completed', title: 'Reply', body: 'x',
      url: `/chat/${agentId}`, source: 'direct_agent_chat', dedupeKey: `${agentId}-${minutesAgo}`,
    });
  }
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await waitHome();
  await page.waitForSelector('#unreadMessages .crow', { timeout: 10_000 }).catch(() => {});
  // One read of the whole card, row by row. No named inner function: under tsx
  // esbuild's keepNames wraps one in a `__name` call the page does not have.
  const unread = await page.$$eval('#unreadMessages .crow', (nodes) => nodes.map((node) => {
    const preview = node.querySelector('.ctext');
    const counted = node.querySelector('.ctext.keep');
    const dot = node.querySelector(':scope > .unreaddot');
    const style = dot ? getComputedStyle(dot) : null;
    const box = dot ? dot.getBoundingClientRect() : null;
    const row = node.getBoundingClientRect();
    const words = node.querySelector('.main')!.getBoundingClientRect();
    return {
      name: node.querySelector('.name')?.textContent?.trim() ?? null,
      line: node.querySelector('.cline')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      count: counted?.textContent?.trim() ?? null,
      reader: node.querySelector('.sr-only')?.textContent?.trim() ?? null,
      badges: node.querySelectorAll('.badge').length,
      // Ellipsis is what the line does under pressure; the count must be the
      // part that never gives way.
      previewClipped: preview ? preview.scrollWidth > Math.ceil(preview.getBoundingClientRect().width) : null,
      countWhole: counted ? counted.scrollWidth <= Math.ceil(counted.getBoundingClientRect().width) : null,
      dot: style && box ? {
        size: `${Math.round(box.width)}x${Math.round(box.height)}`,
        round: parseFloat(style.borderRadius) >= box.width / 2,
        colour: style.backgroundColor,
        afterTheWords: Math.round(box.left - words.right) >= 0,
        centred: Math.abs((box.top + box.bottom) / 2 - (row.top + row.bottom) / 2) <= 1,
        still: style.animationName === 'none',
      } : null,
    };
  }));
  const accent = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--accent)';
    document.body.append(probe);
    const read = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return read;
  });
  check('unread replies get one door per agent, newest conversation first',
    unread.length === 3 && unread.map((row) => row.name).join(',') === 'Felix,Mira,Nova',
    `${unread.length} rows: ${unread.map((row) => row.name).join(',')}`);
  check('the "new" pill is gone from every one of them',
    unread.every((row) => row.badges === 0));
  check('…and every row wears the dot instead, in the row’s own right column',
    unread.every((row) => row.dot?.afterTheWords && row.dot.centred), JSON.stringify(unread.map((row) => row.dot)));
  // Drawn, not merely present: 6px, actually round, actually the accent — the
  // same disc a row already wears for `livedot`.
  check('the dot is the 6px accent disc a row already uses',
    unread.every((row) => row.dot?.size === '6x6' && row.dot.round && row.dot.colour === accent),
    `${accent} · ${JSON.stringify(unread[0]?.dot)}`);
  // A reply that ARRIVED is not a reply arriving: `livedot` breathes because
  // its turn is still running, and this one must not borrow that promise.
  check('…and it does not breathe, the way the working dot does',
    unread.every((row) => row.dot?.still));
  // The dot says nothing out loud, so the word the pill gave a screen reader
  // has to come from somewhere.
  check('the pill’s word survives for a screen reader',
    unread.every((row) => row.reader === 'Unread'), unread.map((row) => row.reader).join(','));
  check('two behind one door keep their number, beside the words and the time',
    /^Pushed the branch .*·\s*2 replies·\s*4m ago$/.test(unread[0]?.line ?? ''), unread[0]?.line ?? '');
  check('one waiting reply says no number at all — the dot is “one”',
    unread[1]?.line === 'Inbox is tidy.· 30m ago' && unread[1]?.count === null, unread[1]?.line ?? '');
  check('a reply with no words of its own says what waits, and says it once',
    unread[2]?.line === 'New reply· 50m ago' && unread[2]?.count === null, unread[2]?.line ?? '');
  // The real risk in moving a number onto that line: the line ellipsises. The
  // preview is what gives way; the count keeps its width (`.ctext.keep`).
  check('the preview gives way under a long reply and the count never does',
    unread[0]?.previewClipped === true && unread[0]?.countWhole === true && unread[0]?.count === '· 2 replies',
    JSON.stringify(unread[0]));
  await shotHome('unread');

  // 4. A row opens its agent's conversation (note #573), the conversation's
  //    name opens the agent, and Back through each header spends an entry.
  await page.click('#agents .crow');
  await page.waitForFunction(() => location.pathname === '/chat/felix', { timeout: 10_000 }).catch(() => {});
  check('a row opens its agent’s conversation at the registered address (note #573)',
    page.url() === `${ORIGIN}/chat/felix`, page.url());
  await page.waitForSelector('#agentChatTitle', { timeout: 10_000 });
  await page.click('.chathead .chatnamedoor');
  await page.waitForFunction(() => location.pathname === '/agents/felix', { timeout: 10_000 }).catch(() => {});
  check('…and its name there opens the agent at the registered address', page.url() === `${ORIGIN}/agents/felix`, page.url());
  // The address is written when the tap is handled; the screen it names is
  // drawn on the commit after that, so the header has to be WAITED for — this
  // check has been reading the outgoing Home ever since it was written.
  await page.waitForSelector('#screenAgent', { timeout: 10_000 });
  check('the persistent header stands over the destination', Boolean(await page.$('#pageHead')));
  check('…carrying the agent’s own name, closed with one rule',
    // 48px in, not 50: `.pagehead` gave up its 2px of top padding on
    // 2026-09-11 (c21c5d9b) because `.pagenav` below it IS the 48px row.
    (await headShape(page)) === 'rule=1px solid · name 48px in'
      && (await page.$eval('#pageHead #agentInfoTitle', (node) => node.textContent)) === 'Felix',
    await headShape(page));
  // …and the face in it is the size that header's own comment documents.
  // It was not: the rule sizing it named `.aface`, a PERSON's photo class,
  // so it matched nothing and the agent drew a 34px face under a 6px ring.
  // A dead selector reads as correct in the file, which is why this is
  // measured in the browser (fixed 2026-09-07).
  const headFace = await page.evaluate(
    '(() => { const ring = document.querySelector("#agentInfoHead .ctxring");'
    + 'if (!ring) return null; const face = ring.querySelector("img, .icon");'
    + 'const r = ring.getBoundingClientRect(), f = face.getBoundingClientRect();'
    + 'return { slot: Math.round(r.width), face: Math.round(f.width),'
    + '  ring: Math.round((r.width - f.width) / 2) }; })()',
  ) as { slot: number; face: number; ring: number } | null;
  check('…and its face fills the 46px mark on a 3px ring, as this header documents',
    headFace?.slot === 46 && headFace.face === 40 && headFace.ring === 3,
    JSON.stringify(headFace));
  await shotHome('agent');
  // Measured as a DELTA around this one Back, not as an absolute count: how
  // many entries the signup itself spends is not what this check is about.
  const entriesBeforeBack = await page.evaluate(() => history.length);
  await page.click('#pageBack');
  await page.waitForSelector('#agentChatTitle', { timeout: 10_000 }).catch(() => {});
  check('Back returns to the conversation', page.url() === `${ORIGIN}/chat/felix`, page.url());
  await page.click('.chathead .back');
  check('…and Back again returns to the overview, at Home’s address', await waitHome() && page.url() === `${ORIGIN}/`, page.url());
  check('…each by spending an entry, not pushing over it',
    (await page.evaluate(() => history.length)) === entriesBeforeBack,
    `${entriesBeforeBack} → ${await page.evaluate(() => history.length)}`);

  // 5. A pasted address with nothing beneath it: Back replaces it with Home.
  //    This fixture has no workplace, and without one `/` draws the overview
  //    (HomeScreen.tsx) rather than the Chief of Staff's conversation — so
  //    the fleet heading is still the sign that Home opened.
  await page.goto(`${ORIGIN}/notes/12?org=o1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#pageBack');
  const before = await page.evaluate(() => history.length);
  await page.click('#pageBack');
  check('Back on a pasted address lands on Home', await waitHome() && page.url() === `${ORIGIN}/`, page.url());
  check('no header over Home', !(await page.$('#pageHead')));
  check('…without adding an entry', (await page.evaluate(() => history.length)) === before);

  // 6. Note #396, the measurement the redesign exists for: on the widths a
  // phone actually has, EVERY fact line on EVERY plate has to say its whole
  // words. Before this change all of them were ellipsised at all of them —
  // `Claude Code · opus…`, with the effort never drawn and the memory cut
  // off — and under 350px the machine line was hidden outright.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await waitHome();
  // One read per width. No named inner function: under tsx esbuild's
  // keepNames wraps one in a `__name` call the page does not have.
  const readFacts = '(() => [...document.querySelectorAll("#agents .crow")].map((row) => {'
    + 'const out = { name: row.querySelector(".name").textContent.trim(), lines: [] };'
    + 'for (const sel of [".cruntime", ".cmachine"]) {'
    + '  const el = row.querySelector(sel); if (!el) continue;'
    + '  const style = getComputedStyle(el); const box = el.getBoundingClientRect();'
    + '  let spill = 0;'
    + '  for (const part of el.querySelectorAll(".fact")) spill = Math.max(spill, part.getBoundingClientRect().right - box.right);'
    + '  out.lines.push({ which: sel, text: el.textContent, hidden: style.display === "none",'
    + '    rows: Math.round(box.height / parseFloat(style.lineHeight)), spill: Math.round(spill) });'
    + '} return out; }))()';
  // 320 is the narrowest phone the shell supports; 430 is the one this was
  // reported from. Nothing in between may lose a word either.
  for (const width of [320, 360, 390, 430]) {
    await page.setViewport({ width, height: 860, deviceScaleFactor: 2 });
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
    await waitHome();
    const read = await page.evaluate(readFacts) as Array<{ name: string; lines: Array<{ which: string; text: string; hidden: boolean; rows: number; spill: number }> }>;
    const said = read.flatMap((row) => row.lines);
    check(`at ${width}px every plate still says both facts`,
      read.length === 3 && read.every((row) => row.lines.length === (row.name === 'Nova' ? 1 : 2))
        && said.every((line) => !line.hidden),
      read.map((row) => `${row.name}:${row.lines.map((line) => `${line.text}${line.hidden ? ' HIDDEN' : ''}`).join('|')}`).join(' · '));
    check(`…and not one word of them runs off the plate at ${width}px`,
      said.every((line) => line.spill <= 0),
      said.map((line) => `${line.text} +${line.spill}`).join(' · '));
    // The folding is the fallback, not the look: on the two widths most
    // phones actually have, each line is still one line.
    if (width >= 390) {
      check(`…each on ONE line at ${width}px, the way a spec line should read`,
        said.every((line) => line.rows === 1),
        said.map((line) => `${line.text} = ${line.rows} rows`).join(' · '));
    }
  }
  // The portrait itself, at the width this was reported from: 52px of slot
  // with a 3px ring round a 46px face, and the fleet's names still whole
  // beside it. The two move together — a bigger face is spent out of the
  // name's column — so they are measured in one breath (the owner, 2026-09-07).
  await page.setViewport({ width: 430, height: 860, deviceScaleFactor: 2 });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await waitHome();
  const portrait = await page.evaluate(
    '(() => { const row = document.querySelector("#agents .crow");'
    + 'const mark = row.querySelector(".agenthead > .ctxring, .agenthead > .working");'
    + 'const face = mark.querySelector("img, .icon");'
    + 'const m = mark.getBoundingClientRect(), f = face.getBoundingClientRect();'
    + 'const names = [...document.querySelectorAll("#agents .crow .name")];'
    + 'const noFace = document.querySelector("#agents .crow .agenthead .icon > svg");'
    + 'return { slot: Math.round(m.width), face: Math.round(f.width),'
    + '  ring: Math.round((m.width - f.width) / 2),'
    + '  glyph: noFace ? Math.round(noFace.getBoundingClientRect().width) : null,'
    + '  cut: names.filter((n) => n.scrollWidth > Math.ceil(n.getBoundingClientRect().width))'
    + '    .map((n) => n.textContent.trim()) }; })()',
  ) as { slot: number; face: number; ring: number; glyph: number | null; cut: string[] };
  check('the plate\u2019s portrait is 52px, on a 3px ring, with every name still whole beside it',
    portrait.slot === 52 && portrait.face === 46 && portrait.ring === 3 && portrait.cut.length === 0,
    JSON.stringify(portrait));
  // And the agent with no picture keeps its share of that bigger disc: the
  // glyph ships at a fixed 20px, which in a 46px circle reads as a small
  // mark adrift rather than as the same kind of thing as the faces beside it.
  check('…and an agent with no picture fills it with the glyph, not a 20px mark in a circle',
    portrait.glyph === 27, JSON.stringify(portrait.glyph));

  // The negative control: a model slug longer than anything this catalog
  // offers, with nowhere to fold. It must WRAP and stay whole — the one
  // thing it may not do is what the old line did and disappear off the edge.
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(me.telegram ?? {}),
      agents: {
        ...((me.telegram?.agents ?? {}) as Record<string, unknown>),
        nova: {
          id: 'nova', name: 'Nova', cli: 'claude', createdAt: iso(1), serverId: 'm3',
          model: 'claude-opus-5-20260401-experimental-preview',
        },
      } as never,
    },
  });
  await page.setViewport({ width: 320, height: 860, deviceScaleFactor: 2 });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await waitHome();
  const stress = (await page.evaluate(readFacts) as Array<{ name: string; lines: Array<{ text: string; rows: number; spill: number }> }>)
    .find((row) => row.name === 'Nova')?.lines[0];
  check('an impossibly long model slug folds and stays whole, on the narrowest phone',
    stress?.text === 'claude-opus-5-20260401-experimental-preview · high'
      && (stress?.rows ?? 0) > 1 && (stress?.spill ?? 1) <= 0,
    JSON.stringify(stress));
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });

  // A signed-out session read is a 401 by design and Chrome asks for a
  // favicon nobody serves; anything else is a real complaint.
  // …and this fixture wires no agent lifecycle and no note storage, so the
  // agent screen's own reads (version, last reply, proposals) and the note
  // screen's answer 503 by design. The pasted address above is a real note
  // address on purpose: what Back does with one is the thing under test.
  const unexpected = consoleErrors.filter((text) => !/status of (400|401|404|503)|\b401 .*auth\/session|favicon\.ico|\b503 .*\/api\/(agents|notes)\//.test(text));
  check('no unexpected console errors', unexpected.length === 0, unexpected.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
