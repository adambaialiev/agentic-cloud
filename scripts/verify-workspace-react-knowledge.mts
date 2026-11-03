// Drives the React Workspace shell's KNOWLEDGE screens in real Chrome against
// a real backend router: Home's glimpse card and its door, the Knowledge
// screen behind it, one page rendered with its own picture, the row of agents
// the page can be handed to and the Send that opens from it, and the margin.
// Then it opens THE SAME PAGE in both shells and compares what each says AND
// where each part sits — the stylesheet is shared, so a box in a different
// place means a node the CSS was not expecting.
// Screenshots land in ~/mini-preview/n256-knowledge-*.png.
// Since note #715 Home (`/`) is the Chief of Staff's conversation, and the
// knowledge card stands in the Workplace window its header's door opens.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-react-knowledge.mts
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot, tap } from './browser-settle.mjs';
import { openWorkplaceWindow } from './workspace-harness-home.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { GitHostClient } from '../backend/src/services/git-host-client.js';
import { InMemoryKnowledgePageCommentStorage } from '../backend/src/services/knowledge-page-comments.js';
import { InMemoryKnowledgeProposalStorage } from '../backend/src/services/knowledge-storage.js';
import { OrgGitService } from '../backend/src/services/org-git.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });

/** Whichever Chrome this machine actually has: the cache directory is named
 *  for the build, and pinning one version here is how a harness stops
 *  launching the day the browser is upgraded. */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(cache).filter((name) => name.startsWith('linux-')).sort();
  const newest = builds[builds.length - 1];
  if (!newest) throw new Error(`no Chrome under ${cache} — npx puppeteer browsers install chrome`);
  return path.join(cache, newest, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4177);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const sha1 = (content: string) => createHash('sha1').update(content).digest('hex');

/** One page's source, in the shape an agent proposes: front matter the meta
 *  reader takes its title and description from, then the document. */
const pageSource = (title: string, description: string, body: string) =>
  `<!doctype html><title>${title}</title><meta name="description" content="${description}">`
  + `<h1>${title}</h1>${body}`;

const knowledgeFiles = new Map<string, string>();
const PAGES: Array<{ name: string; title: string; description: string; body: string }> = [
  { name: 'how-a-change-reaches-production', title: 'How a change reaches production', description: 'What runs when a change lands on main, and how to tell whether it arrived.', body: '<p>The deploy lane starts at the merge.</p><table><tr><th>Job</th><th>Machine</th></tr><tr><td>ci/checks</td><td>throwaway</td></tr></table>' },
  { name: 'miniapp-navigation', title: 'One browser stack, contextual roots', description: 'How the route registry, scopes, history and Back fit together.', body: '<p>Twenty-seven destinations, one history stack.</p>' },
  { name: 'miniapp-screenshots', title: 'Looking at a change on an agent machine', description: 'Getting a browser, driving the page, and the traps.', body: '<p>Drive the page with no Telegram launch.</p><img src="files/plan.png" alt="the wiring">' },
  { name: 'org-layer-design', title: 'The multi-workplace contract', description: 'Memberships, ownership, shared resources and lifecycle rules.', body: '<p>Ownership is immutable.</p>' },
  { name: 'posting-in-public', title: 'Posting in public', description: 'Where to post and which claims must stay precise.', body: '<p>One question to settle first.</p>' },
  { name: 'probing-a-cli-harness', title: 'Probing a CLI harness', description: 'Make an agent CLI tell you what its event stream contains.', body: '<p>A stub model provider is enough.</p>' },
  { name: 'running-a-cli-over-ssh', title: 'Running a CLI over SSH', description: 'Why a CLI that reads stdin hangs, and how to measure it.', body: '<p>Close stdin.</p>' },
];

/** The derived listing the service reads: what puts a TIME and a FACE on each
 *  row, which is half of what the row says. One page is landed by a TEAMMATE's
 *  agent (note #640): one shelf holds the whole workplace, so a mixed card is
 *  the ordinary case rather than an edge of it. */
function writeIndex(agentId: string, byPage: Record<string, string> = {}) {
  const pages: Record<string, unknown> = {};
  PAGES.forEach((page, at) => {
    const content = pageSource(page.title, page.description, page.body);
    knowledgeFiles.set(`pages/${page.name}.html`, content);
    pages[page.name] = {
      title: page.title,
      description: page.description,
      // Most recently landed first is what the state sorts by, so give them
      // distinct stamps rather than one shared instant.
      updatedAt: new Date(Date.now() - (at + 1) * 3600_000).toISOString(),
      bytes: Buffer.byteLength(content, 'utf8'),
      updatedByAgentId: byPage[page.name] ?? agentId,
      ...(page.name === 'miniapp-screenshots'
        ? {
          attachments: [{
            id: 'f1',
            fileName: 'plan.png',
            contentType: 'image/png',
            sizeBytes: 68,
            storagePath: 'users/u/knowledge/miniapp-screenshots/f1/plan.png',
            addedByAgentId: agentId,
            addedAt: new Date().toISOString(),
          }],
        }
        : {}),
    };
  });
  knowledgeFiles.set('index.json', JSON.stringify({ pages }));
}

/** The git host, in memory, behind the REAL client — so the whole wire shape
 *  is exercised rather than mocked at the seam. */
const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
  const route = String(url).replace('http://host', '');
  const body = JSON.parse(init?.body ?? '{}') as { page?: string };
  const answer = (payload: unknown, status = 200) => ({
    ok: status < 400, status, text: async () => JSON.stringify(payload),
  });
  if (route === '/internal/knowledge/list') {
    return answer({
      pages: [...knowledgeFiles.entries()].filter(([f]) => f.startsWith('pages/')).map(([f, content]) => ({
        name: f.slice('pages/'.length, -'.html'.length),
        sha: sha1(content),
        sizeBytes: Buffer.byteLength(content, 'utf8'),
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
const knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
const knowledgePageCommentStorage = new InMemoryKnowledgePageCommentStorage();
// A real workplace: a workplace-less account would never exercise
// the `?org=` addresses this slice writes — nor the creation plate at the
// end of the hand row.
const orgStorage = new InMemoryOrgStorage();
// Past the setup gate, or none of the Workspace is mounted: the workplace
// this harness seeds directly would otherwise read as incomplete on every
// state read and hold the whole shell on "Connect your Fly cloud".
harnessEstablishedWorkplace(orgStorage);
/** A one-pixel PNG, so the page's own `files/plan.png` resolves to something
 *  a browser will actually paint. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** A stand-in for a MEMBER's profile picture, so the face beside "Driven by"
 *  on a teammate's agent is a real drawn picture rather than a transparent
 *  pixel nobody can tell from a missing one (note #640). */
const PERSON_PHOTO = 'data:image/png;base64,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';
const sent: Array<{ agentId: string; message: string }> = [];

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  knowledgeProposalStorage,
  knowledgePageCommentStorage,
  orgStorage,
  orgGit: new OrgGitService({ orgStorage }),
  mediaStorage: {
    createReadAccess: async ({ storagePath }: { storagePath?: string } = {}) => ({
      url: storagePath?.includes('people/') ? PERSON_PHOTO : PIXEL,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }),
  },
  gitHostClient: new GitHostClient({
    baseUrl: 'http://host', controlUrl: 'http://host', secret: 's', fetchImpl,
  }),
  agentLifecycle: {
    sendUserMessage: async (_userId: string, agentId: string, message: string) => {
      sent.push({ agentId, message });
      return { ok: true as const, recipient: { id: agentId, name: 'Felix' } };
    },
  },
} as unknown as RouteDeps;

const app = express();
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
// The shell itself answers at the root of the domain (public-addresses).
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

/** Read in BOTH shells and compared: the shared stylesheet should put every
 *  one of these in the same place. */
const PARITY_BOXES = [
  '#kpageTitle', '#kpageSub', '#kpageBody', '#kpageBody .kpage', '#kpageBody p',
  '#kpageHandsHead', '#kpageHandsCard', '#kpageHands .hand', '#kpageHandsHint',
  '#kpageCommentsHead', '#kpageCommentsCard',
];
/**
 * Home's card is measured RELATIVE to its own heading, not against the top of
 * the page. Three sections that stand above Knowledge in the legacy page —
 * Notes, Repositories and Sites — arrive with slices 5, 7 and 8, so the whole
 * card sits higher in the React shell until they do. What must match today is
 * the card's own shape: where its rows sit under its heading.
 */
const HOME_BOXES = ['#knowledgeList', '#knowledgeList .crow', '#knowledgeList .crow:last-child'];

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
  const page$ = await browser.newPage();
  await page$.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  page$.on('pageerror', (error) => check('no page error', false, String(error)));
  const consoleErrors: string[] = [];
  page$.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page$.on('response', (response) => { if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`); });
  await page$.evaluateOnNewDocument((boxes: string[]) => {
    (globalThis as unknown as { PARITY_BOXES: string[] }).PARITY_BOXES = boxes;
  }, PARITY_BOXES);
  const shot = async (name: string) => {
    await page$.screenshot({
      path: path.join(OUT, `n256-knowledge-${name}.png`) as `${string}.png`, fullPage: true,
    });
    await settleAfterShot(page$);
  };
  const text = (selector: string) => page$.$eval(selector, (node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  const texts = (selector: string) => page$.$$eval(selector, (nodes) => nodes.map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
  const boxes = (which: string[]) => page$.evaluate((list: string[]) => list
    .map((selector) => {
      const node = document.querySelector(selector);
      return `${selector}=${node ? Math.round(node.getBoundingClientRect().top) : 'absent'}`;
    })
    .join(' '), which);
  /** The same boxes, measured from the first one — the shape of a section
   *  rather than its place on a page that is still half-migrated. */
  const shape = (which: string[]) => page$.evaluate((list: string[]) => {
    const first = document.querySelector(list[0]!);
    return list
      .map((selector) => {
        const node = document.querySelector(selector);
        return `${selector}=${node && first
          ? Math.round(node.getBoundingClientRect().top - first.getBoundingClientRect().top)
          : 'absent'}`;
      })
      .join(' ');
  }, which);

  // 1. Create access, then seed the account this Workspace reads.
  await harnessSignedIn(page$, workspaceWebAuth, ORIGIN, 'saddam@example.com');

  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  const org = await orgStorage.createOrg({ name: 'Nomad Trading', createdByUserId: me.userId } as never);
  await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
  await orgStorage.addMember({ orgId: org.orgId, userId: me.userId, role: 'admin' });
  // A live subscription, or every agent is `needs-seat` and none is offered
  // the page: idle means READY and not mid-turn.
  await orgStorage.addSeat({
    orgId: org.orgId, userId: me.userId, provider: 'claude', token: 't',
    label: 'my Claude', status: 'active',
  } as never);
  const now = new Date().toISOString();
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(me.telegram ?? {}),
      agents: {
        felix: {
          id: 'felix', name: 'Felix', cli: 'claude', model: 'Opus 5', effort: 'high',
          createdAt: now, serverId: 'm1', connectedAt: now, lastActivityAt: now,
          latestWorkRecap: 'Wrote the deploy runbook',
        },
        // The row offered only the agents of the room the reader stood in
        // (the room wall, note #85) until rooms left the product (note
        // #843): every idle agent is offered now.
        ruby: {
          id: 'ruby', name: 'Ruby', cli: 'codex', createdAt: now,
          serverId: 'm2', connectedAt: now, lastActivityAt: now,
        },
      } as never,
    },
  });
  // A TEAMMATE, with an agent of their own (note #640). One shelf holds the
  // workplace's pages, so on a real screen most rows were landed by somebody
  // else's agent — and until the state read resolved them across the whole
  // workplace those rows came up faceless while the reader's own wore names.
  const dana = await userStorage.createProfile('dana', {
    email: 'dana@example.com', displayName: 'Dana Ives',
  } as never);
  await userStorage.updateProfile(dana.userId ?? 'dana', {
    // Their profile picture, which the card beside "Driven by" draws — set
    // through an update because `createProfile` keeps only the fields a
    // sign-up carries.
    person: { firstName: 'Dana', photo: { storagePath: 'people/dana.png' } },
    telegram: {
      chatId: '2', linkedAt: now, telegramUserId: '43',
      agents: {
        leo: {
          id: 'leo', name: 'Leo', cli: 'codex', createdAt: now,
          serverId: 'm3', connectedAt: now, lastActivityAt: now,
          orgId: org.orgId,
          recap: { text: 'Wrote the launch checklist', at: now },
        },
      },
    } as never,
  });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'dana', role: 'member' } as never);
  writeIndex('felix', { 'miniapp-navigation': 'leo' });
  // Workplace-scoped since note #566: these belong to the workplace, as Drive
  // does, so their addresses name it and no room.
  const scoped = `org=${encodeURIComponent(org.orgId)}`;

  // 2. Home's Workplace window: Knowledge is one row of its index (note
  //    #960), saying how many pages, onto the Knowledge screen. Knowledge
  //    belongs to the workplace (note #566), beside Drive.
  await openWorkplaceWindow(page$, ORIGIN);
  await page$.waitForSelector('#homeSheet #indexKnowledge', { timeout: 10_000 });
  check('the window’s Knowledge row says how many pages there are',
    (await text('#indexKnowledge')) === 'Knowledge7 pages', await text('#indexKnowledge'));
  await tap(page$, '#indexKnowledge');
  // Thirty, not ten: this wait covers a route change AND the screen's own
  // read, and CI runs four checks at a time (2026-09-20).
  await page$.waitForSelector('#screenKnowledge #knowledgeList .crow', { timeout: 30_000 });
  check('the row opens the list at the workplace-scoped address it would copy',
    page$.url() === `${ORIGIN}/knowledge?${scoped}`, page$.url());
  const homeRows = await texts('#knowledgeList .crow .name');
  check('the screen lists every page', homeRows.length === 7, homeRows.join(' | '));
  check('a row says what the page is FOR, under the agent that landed it',
    (await text('#knowledgeList .crow .cline'))
      === 'Felix·What runs when a change lands on main, and how to tell whether it arrived.',
    await text('#knowledgeList .crow .cline'));
  // Note #640: the reader's own agent and a TEAMMATE's are signed the same
  // way. A row that names one and not the other reads as the pages being
  // different rather than whose agent landed them.
  const faces = await page$.$$eval('#knowledgeList .crow .cline .keep', (nodes) => nodes.map((node) => node.textContent));
  check('a teammate’s agent signs its page exactly as the reader’s own does',
    faces[0] === 'Felix' && faces[1] === 'Leo'
    && (await page$.$$('#knowledgeList .crow .cline img.face')).length === 7,
    `${faces.join(' | ')} / ${(await page$.$$('#knowledgeList .crow .cline img.face')).length} faces`);
  check('the rows stay icon-free',
    (await page$.$$('#knowledgeList .crow .icon')).length === 0);
  const homeReact = await shape(HOME_BOXES);
  await shot('home');

  // 2b. Note #640: the face on a row is a DOOR. A teammate's agent has a
  // read-only page of its own now, and the press must open the agent rather
  // than the page the rest of the row opens.
  // Home's other reads (the recap card, the settings) can still be landing
  // and growing the window above this card, and a 16px face near the edge of
  // the window is a small target: under load the press twice landed on
  // nothing that opens anything (2026-09-23). Let the page go quiet, stand
  // the face in the middle of the window, and ask the page what a thumb
  // there would actually touch before pressing it for real.
  await page$.waitForNetworkIdle({ idleTime: 400, timeout: 10_000 }).catch(() => {});
  const underThumb = await page$.evaluate(() => {
    const face = document.querySelector('#knowledgeList .crow:nth-child(2) .cline img.face') as HTMLElement | null;
    if (!face) return 'no face';
    face.scrollIntoView({ block: 'center' });
    const box = face.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit?.closest('[data-agent-door]')?.getAttribute('data-agent-door') ?? `${hit?.tagName}.${hit?.className}`;
  });
  check('the teammate’s face is what a thumb lands on', underThumb === 'leo', underThumb);
  await page$.click('#knowledgeList .crow:nth-child(2) .cline img.face');
  await page$.waitForSelector('#screenOtherAgent #otherAgentFacts', { timeout: 30_000 })
    .catch((error: unknown) => { throw new Error(`the face opened ${page$.url()} instead of its agent — ${String(error)}`); });
  check('a teammate\u2019s face opens that agent, not the page under it',
    (await text('#otherAgentTitle')) === 'Leo'
    && page$.url() === `${ORIGIN}/agents/leo`,
    `${await text('#otherAgentTitle')} / ${page$.url()}`);
  // Their face BESIDE their name, not on the text baseline with no air: the
  // button rule for a fact row is more specific than the person rule, so the
  // gap is worth measuring rather than assuming (note #640).
  const owner = await page$.$eval('#otherAgentOwner', (node) => {
    const image = node.querySelector('img');
    const name = node.querySelector('span');
    const gap = image && name
      ? Math.round(name.getBoundingClientRect().left - image.getBoundingClientRect().right)
      : -1;
    return { text: node.textContent ?? '', face: Boolean(image), gap };
  });
  check('the member who drives it wears their own face beside their name',
    owner.text.includes('Dana') && owner.face && owner.gap >= 6 && owner.gap <= 12,
    `${owner.text} / ${owner.face ? 'face' : 'no face'} / gap ${owner.gap}px`);
  // It said which room it worked in too, until rooms left the product
  // (note #843): the page names no room.
  check('it says whose it is, what it runs and what it last did, and no room',
    (await text('#otherAgentAbout')).startsWith('Dana\u2019s agent.')
    && (await text('#otherAgentRuntime')).startsWith('Codex')
    && !/\broom/i.test(await text('#otherAgentFacts'))
    && (await text('#otherAgentFacts')).includes('Driven byDana')
    && (await text('#otherAgentWork')).includes('Wrote the launch checklist'),
    `${await text('#otherAgentAbout')} | ${await text('#otherAgentRuntime')} | ${await text('#otherAgentFacts')} | ${await text('#otherAgentWork')}`);
  // Read-only means read-only: the only control on the page is the door to
  // the member who drives it.
  const otherButtons = await page$.$$eval('#screenOtherAgent button', (nodes) => nodes.map((node) => node.textContent));
  check('and it offers nothing to press but the person behind it',
    otherButtons.length === 1 && otherButtons[0] === 'Dana', otherButtons.join(' | '));
  await shot('agent');
  await page$.goBack();
  await page$.waitForSelector('#knowledgeList .crow', { timeout: 30_000 });

  // 3. The Knowledge screen, back from the agent: every page, and how many.
  check('the screen leaves nothing off, and says how many that is',
    (await page$.$$('#knowledgeList .crow')).length === 7
    && (await text('#knowledgeSub')) === '7 pages, written by the workplace’s agents and shared across it.',
    `${(await page$.$$('#knowledgeList .crow')).length} rows / ${await text('#knowledgeSub')}`);
  check('the persistent header stands over the destination', Boolean(await page$.$('#pageHead')));
  await shot('list');

  // 4. One page: the words, the picture it carries, the hands and the margin.
  await page$.click('#knowledgeList .crow:nth-child(3)');
  await page$.waitForSelector('#screenKnowledgePage #kpageBody p', { timeout: 10_000 });
  check('a row opens the page at its registered address',
    page$.url() === `${ORIGIN}/knowledge/miniapp-screenshots?${scoped}`, page$.url());
  check('the page is titled with what it is and what it is for',
    (await text('#kpageTitle')) === 'Looking at a change on an agent machine'
    && (await text('#kpageSub')) === 'Getting a browser, driving the page, and the traps.',
    `${await text('#kpageTitle')} / ${await text('#kpageSub')}`);
  check('the knowledge page body is one product step above compact chrome',
    (await page$.$eval('#kpageBody .kpage', (node) => getComputedStyle(node).fontSize)) === '14px',
    await page$.$eval('#kpageBody .kpage', (node) => getComputedStyle(node).fontSize));
  check('its own <h1> is not printed twice under the screen’s title',
    (await page$.$$('#kpageBody h1')).length === 0);
  check('the page’s own picture resolves to the file it carries',
    (await page$.$eval('#kpageBody img', (node) => node.getAttribute('src') ?? '')).startsWith('data:image/png'),
    await page$.$eval('#kpageBody img', (node) => (node.getAttribute('src') ?? '').slice(0, 24)));
  check('…and is something the reader can open',
    (await page$.$eval('#kpageBody img', (node) => node.className)).includes('openimage'));
  check('every idle agent is offered the page, then the create plate',
    (await texts('#kpageHands .hand .hname')).join(' | ') === 'Felix | Ruby | Create agent',
    (await texts('#kpageHands .hand .hname')).join(' | '));
  check('the hint says PAGE, where a note’s says note',
    (await text('#kpageHandsHint')).includes('hand over this page'), await text('#kpageHandsHint'));
  // What the page SAYS, then who could act on it, then what has been said
  // about it. Read as three tops rather than with a helper: a `const` arrow
  // inside `evaluate` is compiled with tsx's keepNames shim, which is not
  // defined in the page.
  const tops = await page$.evaluate(() => [
    document.getElementById('kpageBody')!.getBoundingClientRect().top,
    document.getElementById('kpageHandsHead')!.getBoundingClientRect().top,
    document.getElementById('kpageCommentsHead')!.getBoundingClientRect().top,
  ]);
  check('the hand row sits under the words and above the margin',
    tops[0]! < tops[1]! && tops[1]! < tops[2]!, tops.join(' < '));
  await shot('page');

  // 5. A remark in the page's margin — a person's, on a document only a
  //    proposal may change.
  await page$.click('#kpageCommentsCard .addrow, #kpageCommentsCard .cmtadd');
  await page$.waitForSelector('#kpageCommentsCard textarea', { timeout: 10_000 });
  await page$.type('#kpageCommentsCard textarea', 'Still true after the deploy lane moved.');
  await page$.click('#kpageCommentsCard .cmtsend');
  await page$.waitForFunction(
    () => Boolean(document.querySelector('#kpageComments .ncmt')), { timeout: 10_000 },
  );
  check('the remark lands in the page’s own margin',
    (await text('#kpageComments .ncmt .ctext')) === 'Still true after the deploy lane moved.',
    await text('#kpageComments .ncmt .ctext'));
  await shot('margin');

  // 6. The Send: a transient leaf that keeps the page's address underneath it.
  const before = await page$.evaluate(() => history.length);
  await page$.click('#kpageHands .hand .handpick');
  await page$.waitForSelector('#screenNoteSend', { timeout: 10_000 });
  check('the Send opens prefilled with the page’s title AND its canonical ID',
    (await page$.$eval('#noteSendText', (node) => (node as HTMLTextAreaElement).value))
      === 'read the knowledge page “Looking at a change on an agent machine” (ID: miniapp-screenshots)',
    await page$.$eval('#noteSendText', (node) => (node as HTMLTextAreaElement).value));
  check('it keeps the page’s address — it is a leaf, not a place',
    page$.url() === `${ORIGIN}/knowledge/miniapp-screenshots?${scoped}`, page$.url());
  check('…and spends no history entry to stand there',
    (await page$.evaluate(() => history.length)) === before,
    `${await page$.evaluate(() => history.length)} vs ${before}`);
  await shot('send');
  await page$.click('#pageBack');
  await page$.waitForSelector('#screenKnowledgePage', { timeout: 10_000 });
  check('Back closes the Send and lands back on the page', Boolean(await page$.$('#kpageBody')));

  // 7. THE SAME PAGE in the classic Workspace: the port is only finished if
  //    both shells say the same things about it, in the same places.
  const reactSays = {
    title: await text('#kpageTitle'),
    sub: await text('#kpageSub'),
    body: (await texts('#kpageBody p')).join(' | '),
    hands: (await texts('#kpageHands .hand .hname')).join(' | '),
    harness: await text('#kpageHands .hand .hharness'),
    hint: await text('#kpageHandsHint'),
    label: await page$.$eval('#kpageHands .handpick', (node) => node.getAttribute('aria-label') ?? ''),
    margin: await text('#kpageComments .ncmt .ctext'),
    boxes: await boxes(PARITY_BOXES),
  };
  check('the page screen says what it should', Object.values(reactSays).every(Boolean), JSON.stringify(reactSays));

  check('the Knowledge screen lists the pages and keeps its shape', homeRows.length > 0 && Boolean(homeReact), `${homeRows.join(' | ')} / ${homeReact}`);

  // A signed-out session read is a 401 by design and Chrome asks for a favicon
  // nobody serves; anything else is a real complaint.
  const unexpected = consoleErrors.filter((line) => !/status of (400|401|404)|\b401 .*auth\/session|favicon\.ico/.test(line));
  check('no unexpected console errors', unexpected.length === 0, unexpected.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
