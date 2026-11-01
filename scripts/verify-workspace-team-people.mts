// Drives the React Workspace in real Chrome against a real backend router to
// check the team view (Adam, 2026-10-28: "let's bring back the team UI where
// I can see my teammates and their statuses and what their agents cooking").
//
// Home's Workplace window stands a People deck right after the agent counts:
// one plate per person — here now, or when they were last — and under each
// person the agents they drive, Working or Idle, with the same one-line
// recap the agent's own row carries. Each agent's line opens that agent; the
// rest of the plate opens the person. The People page draws the same plates,
// and a member's own screen lists every agent the same way. The people tick
// moves an agent's state and recap with no full read. A workplace of one
// that nobody can join draws none of it and makes no people read.
//
// Note #925 (Adam, 2026-10-31: "people see each other's contribution made
// by their agent"): every card says what that person's agents did here this
// week — agent hours, changes merged, tokens written per provider, and the
// latest merged change's title — read from the real ledgers and proposals,
// zero said as zero; the tick moves it; the member's screen adds all time
// and the list of this week's merged changes, each a door to the proposal.
// Screenshots land in ~/mini-preview/team-people-*.png, desk and phone.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-team-people.mts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot, tap } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemoryAgentWorkLedger } from '../backend/src/services/agent-work-ledger.js';
import { InMemoryAgentTokenLedger, tokenDayKey } from '../backend/src/services/agent-token-ledger.js';
import { InMemoryGitPullRequestStorage } from '../backend/src/services/git-pr-storage.js';
import { InMemoryGitRepoStorage } from '../backend/src/services/git-repo-storage.js';
import { openSqliteDb } from '../backend/src/services/sqlite/sqlite-db.js';
import { SqliteDirectMessageStorage } from '../backend/src/services/sqlite/sqlite-direct-message-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import {
  harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace,
} from './workspace-harness-auth.mjs';
import { closeHomeWindow, openWorkplaceWindow } from './workspace-harness-home.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(cache).filter((name) => name.startsWith('linux-')).sort();
  const newest = builds[builds.length - 1];
  if (!newest) throw new Error(`no Chrome under ${cache} — npx puppeteer browsers install chrome`);
  return path.join(cache, newest, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4187);
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** A stand-in for a member's profile picture: a real drawn square. */
const PERSON_PHOTO = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c9785b"/>'
  + '<circle cx="32" cy="26" r="12" fill="#f3d9c6"/><rect x="14" y="42" width="36" height="22" rx="11" fill="#f3d9c6"/></svg>',
).toString('base64');

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

/** The ledgers and proposals a contribution is read from (note #925). */
const agentWorkLedger = new InMemoryAgentWorkLedger();
const agentTokenLedger = new InMemoryAgentTokenLedger();
const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
const gitRepoStorage = new InMemoryGitRepoStorage();

/** Which agents are mid-turn, as `ownerUserId:agentId`. */
const working = new Set<string>();

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  orgStorage,
  directMessageStorage: new SqliteDirectMessageStorage(openSqliteDb(':memory:')),
  mediaStorage: {
    createReadAccess: async () => ({ url: PERSON_PHOTO, expiresAt: new Date(Date.now() + 900_000).toISOString() }),
  },
  agentLifecycle: {
    isAgentWorking: (userId: string, agentId: string) => working.has(`${userId}:${agentId}`),
  },
  agentWorkLedger,
  agentTokenLedger,
  gitPullRequestStorage,
  gitRepoStorage,
} as unknown as RouteDeps;

const app = express();
app.use(express.json());
let peopleReads = 0;
let stateReads = 0;
app.use((req, _res, next) => {
  if (/\/api\/org\/people$/.test(req.path)) peopleReads += 1;
  if (/\/api\/state$/.test(req.path)) stateReads += 1;
  next();
});
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
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `team-people-${name}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  };
  /** The Workplace window's scroller, photographed whole: the sheet scrolls
   *  inside itself, so a full-page shot would show only its first screen. */
  const shotWindow = async (name: string) => {
    // From the agent counts down: the deck stands right under them.
    await page.evaluate(() => document.getElementById('agentActivity')?.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(OUT, `team-people-${name}.png`) as `${string}.png` });
    await settleAfterShot(page);
  };
  const texts = (selector: string) => page.$$eval(selector, (nodes) => nodes.map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
  const attrs = (selector: string, name: string) => page.$$eval(selector, (nodes, attr) => nodes.map((n) => n.getAttribute(attr as string) ?? ''), name);

  // 1. The reader, alone in a workplace nobody can join: no deck, no read.
  const me = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com', { firstName: 'Saddam', lastName: 'B' });
  const { org } = await harnessWorkplace(orgStorage, { userId: me.userId, name: 'Nomad Trading' });
  await orgStorage.addSeat({
    orgId: org.orgId, userId: me.userId, provider: 'claude', token: 't', label: 'my Claude', status: 'active',
  } as never);
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 3 * 3600_000).toISOString();
  const mine = await userStorage.getProfile(me.userId);
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(mine?.telegram ?? {}),
      agents: {
        felix: {
          id: 'felix', name: 'Felix', cli: 'claude', createdAt: earlier, serverId: 'm1', connectedAt: earlier,
          lastActivityAt: earlier, orgId: org.orgId,
          recap: { text: 'Wrote the onboarding email series; waiting on your review.', at: earlier },
        },
      },
    } as never,
  });
  deps.invitesClosed = true;
  peopleReads = 0;
  await openWorkplaceWindow(page, ORIGIN);
  await page.waitForSelector('#homeSheet #agentActivity', { timeout: 10_000 }).catch(() => {});
  check('a workplace of one that nobody can join has no people deck', !(await page.$('#peopleSection')));
  check('…and makes no people read for it', peopleReads === 0, `${peopleReads} reads`);
  await closeHomeWindow(page);
  await page.click('#homeAccount');
  await page.waitForSelector('#accountMenu', { visible: true, timeout: 5_000 });
  check('…and its account menu has no People row', !(await page.$('#accountMenuPeople')));
  await page.keyboard.press('Escape');

  // 2. Dana joins. She was here four minutes ago and drives two agents: Leo,
  // mid-turn, and Nora, idle. Another workplace's agent of hers never shows.
  await userStorage.createProfile('dana', { email: 'dana@example.com', displayName: 'Dana Ives' } as never);
  await userStorage.updateProfile('dana', {
    person: { firstName: 'Dana', lastName: 'Ives', photo: { storagePath: 'people/dana.png' } },
    telegram: {
      chatId: '2', linkedAt: now, telegramUserId: '43',
      agents: {
        nora: {
          id: 'nora', name: 'Nora', cli: 'claude', createdAt: earlier, serverId: 'm3', connectedAt: earlier,
          lastActivityAt: earlier, orgId: org.orgId,
          recap: { text: 'Drafted the pricing page copy; two options ready for Dana.', at: earlier },
        },
        leo: {
          id: 'leo', name: 'Leo', cli: 'codex', createdAt: now, serverId: 'm4', connectedAt: now,
          lastActivityAt: now, orgId: org.orgId,
          recap: { text: 'Fixing the footer on the landing page; checks running.', at: now },
        },
        elsewhere: {
          id: 'elsewhere', name: 'Rex', cli: 'claude', createdAt: earlier, serverId: 'm6', connectedAt: earlier,
          orgId: 'some-other-workplace',
          recap: { text: 'Secret work for another workplace', at: now },
        },
      },
    } as never,
  });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'dana', role: 'member', invitedByUserId: me.userId } as never);
  const fourMinutesAgo = new Date(Date.now() - 4 * 60_000).toISOString();
  await orgStorage.touchMember(org.orgId, 'dana', {
    lastSeenAt: fourMinutesAgo, recap: { text: 'Approved proposal #12: Pricing page redesign', at: fourMinutesAgo },
  });
  working.add('dana:leo');

  // Her week here (note #925): Leo and Nora worked 2h 40m between them and
  // wrote tokens on two providers; two of Leo's changes were merged in the
  // workplace's repository. Rex's hours, tokens and change in another
  // workplace never count here.
  const today = tokenDayKey(Date.now());
  const credit = (agentId: string, orgId: string, ms: number) => agentWorkLedger.credit({
    userId: 'dana', agentId, orgId, agentName: agentId, month: today.slice(0, 7), day: today, ms,
  });
  credit('leo', org.orgId, 100 * 60_000);
  credit('nora', org.orgId, 60 * 60_000);
  credit('elsewhere', 'some-other-workplace', 9 * 3_600_000);
  const wrote = (agentId: string, orgId: string, provider: 'claude' | 'codex', output: number) => agentTokenLedger.credit({
    userId: 'dana', agentId, orgId, agentName: agentId, day: today, provider, model: 'm',
    input: 10, output, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  });
  wrote('leo', org.orgId, 'codex', 41_000);
  wrote('nora', org.orgId, 'claude', 182_000);
  wrote('elsewhere', 'some-other-workplace', 'claude', 5_000_000);
  const repo = await gitRepoStorage.create({
    userId: org.orgId, orgId: org.orgId, name: 'dispatch', createdByAgentId: 'leo',
    defaultBranch: 'main', sizeBytes: 1, protectDefaultBranch: true,
  } as never);
  const merge = (title: string, minutesAgo: number, namespace = org.orgId, agentId = 'leo') => gitPullRequestStorage.create({
    repoId: repo.id, userId: namespace, title, body: 'B', sourceBranch: 'f', targetBranch: 'main', headSha: 'h',
    diffStat: { files: 1, insertions: 1, deletions: 0 }, commitSubjects: ['S'], createdByAgentId: agentId,
    createdByUserId: 'dana', status: 'merged', decidedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  } as never);
  await merge('Footer links point at the new pricing page', 300);
  await merge('Live van map with ETAs on the dispatcher screen', 120);
  await merge('Secret change in another workplace', 5, 'some-other-namespace', 'elsewhere');

  // 3. The deck in the Workplace window, after the counts.
  const openDeck = async () => {
    await openWorkplaceWindow(page, ORIGIN);
    await page.waitForSelector('#homeSheet #homePeople .crow[data-person="dana"] .cagent', { timeout: 10_000 }).catch(() => {});
  };
  await openDeck();
  check('a workplace of two stands the people deck even with invites shut', Boolean(await page.$('#homeSheet #peopleSection')));
  check('…right after the agent counts',
    await page.evaluate(() => Boolean(((document.getElementById('agentActivity')?.compareDocumentPosition(document.getElementById('peopleSection')!) ?? 0)
      & Node.DOCUMENT_POSITION_FOLLOWING) && ((document.getElementById('peopleSection')!.compareDocumentPosition(document.getElementById('humanMessagesCard') ?? document.body)
      & Node.DOCUMENT_POSITION_FOLLOWING) || !document.getElementById('humanMessagesCard')))));
  check('the heading counts the people and who is here', (await texts('#peopleCounts'))[0] === '2 total · 1 here', (await texts('#peopleCounts'))[0]);
  check('the reader is here now; Dana was active four minutes ago',
    (await texts('#homePeople .crow .cline .ctext')).join('|') === 'Here now|Active 4m ago', (await texts('#homePeople .crow .cline .ctext')).join('|'));
  const danaLines = await attrs('#homePeople .crow[data-person="dana"] .cagent', 'data-agent-door');
  check('Dana’s working agent leads her agents, and another workplace’s agent is not there',
    danaLines.join('|') === 'leo|nora', danaLines.join('|'));
  // Working is the blue dot alone since Adam's 31 Oct ask; Idle keeps its word.
  check('a working agent wears the dot alone, an idle one says Idle',
    (await texts('#homePeople .crow[data-person="dana"] .cagent .castate')).join('|') === '|Idle'
    && (await attrs('#homePeople .crow[data-person="dana"] .cagent .castate .livedot', 'aria-label')).join('|') === 'Working',
    (await texts('#homePeople .crow[data-person="dana"] .cagent .castate')).join('|'));
  check('only the working one wears the live disc',
    (await page.$$('#homePeople .crow[data-person="dana"] .cagent .castate .livedot')).length === 1
    && Boolean(await page.$('#homePeople .cagent[data-agent="leo"] .livedot')));
  check('each carries its recap line',
    (await texts('#homePeople .crow[data-person="dana"] .cagent .carecap')).join('|')
      === 'Fixing the footer on the landing page; checks running.|Drafted the pricing page copy; two options ready for Dana.',
    (await texts('#homePeople .crow[data-person="dana"] .cagent .carecap')).join('|'));
  check('the reader’s own plate lists their agent too',
    (await texts('#homePeople .crow[data-person="' + me.userId + '"] .cagent .caname')).join('|') === 'Felix');
  check('another workplace’s recap is nowhere on the page',
    !(await page.evaluate(() => document.body.textContent?.includes('Secret work'))));
  const faceDrawn = await page.$$eval('#homePeople .cagent img.face', (nodes) => nodes.length > 0 && nodes.every((node) => (node as HTMLImageElement).naturalWidth > 0));
  check('the agents’ faces are drawn pictures', faceDrawn);
  const lineBox = await page.$eval('#homePeople .cagent[data-agent="leo"]', (node) => {
    const head = node.querySelector('.cagenthead')!.getBoundingClientRect();
    const state = node.querySelector('.castate')!.getBoundingClientRect();
    const plate = node.closest('.crow')!.getBoundingClientRect();
    return { stateInside: state.right <= plate.right + 0.5, oneLine: head.height <= 20 };
  });
  check('an agent’s head line fits its plate on a phone', lineBox.stateInside && lineBox.oneLine, JSON.stringify(lineBox));
  // Note #833's card (Adam: "just redesign this"): one head row, no monospace,
  // initials where there is no picture, the send mark level with the name,
  // the agents' own grey card (not white: Adam, 2026-10-29), one column on a phone.
  const card = await page.evaluate((meId) => {
    const me = document.querySelector(`#homePeople .crow[data-person="${meId}"]`)!;
    const dana = document.querySelector('#homePeople .crow[data-person="dana"]')!;
    const door = dana.querySelector('.personhead > .cmsgdoor');
    const name = dana.querySelector('.personname .name')!.getBoundingClientRect();
    const doorBox = door?.getBoundingClientRect();
    const mono = [...document.querySelectorAll('#homePeople .crow *')].filter((node) => /mono/i.test(getComputedStyle(node).fontFamily)).length;
    return {
      initials: me.querySelector('.personhead .avatar.initials')?.textContent ?? '',
      badges: [...me.querySelectorAll('.personname .badge')].map((badge) => badge.textContent).join('|'),
      doorTitle: door?.getAttribute('title') ?? '',
      doorLevel: doorBox ? Math.abs((doorBox.top + doorBox.bottom) / 2 - (name.top + name.bottom) / 2) < 14 : false,
      noDoorOnOwn: !me.querySelector('[data-row-door]'),
      mono,
      surface: getComputedStyle(dana).backgroundColor,
      cardGrey: (() => { const probe = document.createElement('div'); probe.style.background = 'var(--card)'; document.body.append(probe); const colour = getComputedStyle(probe).backgroundColor; probe.remove(); return colour; })(),
      columns: new Set([...document.querySelectorAll('#homePeople .crow')].map((node) => Math.round(node.getBoundingClientRect().left))).size,
    };
  }, me.userId);
  check('a person with no picture wears their initials', card.initials === 'SB', card.initials);
  check('“You” and “Admin” stand beside the name as quiet words', card.badges === 'You|Admin', card.badges);
  check('a teammate’s send mark stands level with their name, with its tooltip', card.doorLevel && card.doorTitle === 'Message Dana Ives', JSON.stringify(card));
  check('…and the reader’s own card has none', card.noDoorOnOwn);
  check('nothing on a person’s card is in monospace', card.mono === 0, `${card.mono} nodes`);
  check('the card stands on the agents’ own grey, not white', card.surface === card.cardGrey && card.surface !== 'rgb(255, 255, 255)', `${card.surface} vs ${card.cardGrey}`);
  check('on a phone the cards stand in one column', card.columns === 1, `${card.columns} columns`);
  // Note #925: what her agents did here this week, under her latest line
  // and before her agents; the reader's own card says zeros, not nothing.
  const statsOf = (userId: string) => page.$eval(`#homePeople .crow[data-person="${userId}"] .pcontrib`, (block) => [
    ...block.querySelectorAll('.pcstats > div')].map((node) => `${node.querySelector('b')?.textContent} ${node.querySelector('span')?.textContent?.replace(/\u00a0/g, ' ')}`).join('|'));
  check('Dana’s card says her week here: hours, merges, tokens per provider',
    await statsOf('dana') === '3h agent hours|2 changes merged|182K tokens · Claude Code|41K tokens · Codex', await statsOf('dana'));
  check('…and the title of the latest change merged',
    (await texts('#homePeople .crow[data-person="dana"] .pclatest'))[0] === 'Merged: Live van map with ETAs on the dispatcher screen · 2h ago',
    (await texts('#homePeople .crow[data-person="dana"] .pclatest'))[0]);
  check('another workplace’s hours, tokens and change are not counted',
    !(await page.evaluate(() => document.body.textContent?.includes('Secret change'))));
  check('the reader’s own card says zero as zero',
    await statsOf(me.userId) === '0h agent hours|0 changes merged|0 tokens written', await statsOf(me.userId));
  const block = await page.$eval('#homePeople .crow[data-person="dana"]', (plate) => {
    const order = [...plate.children].map((child) => child.className.split(' ')[0]);
    const box = plate.getBoundingClientRect();
    // Note #928: everything in the block on the name's left edge, the
    // figures equal cells of one grid, two to a row, no label cut or wrapped.
    // Since Adam's follow-up (31 Oct: "left big margin … why do we have
    // it?") the edge is the card's own, where the face and agents stand.
    const nameLeft = Math.round(plate.querySelector('.personhead > :first-child')!.getBoundingClientRect().left);
    const cells = [...plate.querySelectorAll('.pcstats > div')] as HTMLElement[];
    const lefts = [...plate.querySelectorAll('.pchead, .pclatest, .personlatest')].map((n) => Math.round(n.getBoundingClientRect().left));
    const inside = cells.every((stat) => {
      const r = stat.getBoundingClientRect();
      return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
    });
    const widths = new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().width))).size;
    const columns = [...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().left)))].sort((a, b) => a - b);
    const labelsWhole = cells.every((cell) => { const label = cell.querySelector('span')!; return label.scrollWidth <= label.clientWidth + 0.5; });
    const sizes = new Set(cells.map((cell) => getComputedStyle(cell.querySelector('b')!).fontSize)).size;
    return { order: order.join('|'), inside, nameLeft, lefts, columns, widths, labelsWhole, sizes };
  });
  check('the block stands between the latest line and the agents', block.order === 'personhead|personlatest|pcontrib|cagents', block.order);
  check('…every line of it on the card’s own left edge, with the face (note #928, no indent)',
    block.lefts.every((left) => left === block.nameLeft) && block.columns[0] === block.nameLeft, JSON.stringify(block));
  check('…its figures equal cells, two to a row, one size, no label cut, inside the card on a phone',
    block.inside && block.widths === 1 && block.columns.length === 2 && block.labelsWhole && block.sizes === 1, JSON.stringify(block));
  await shotWindow('home-deck-phone');

  // 4. The tick moves an agent with no full read behind it.
  stateReads = 0;
  peopleReads = 0;
  working.add('dana:nora');
  await userStorage.updateAgentFields('dana', 'nora', { recap: { text: 'Rewriting the pricing table for annual plans.', at: new Date().toISOString() } } as never);
  const moved = await page.waitForFunction(
    () => document.querySelector('#homePeople .cagent[data-agent="nora"] .castate .livedot')?.getAttribute('aria-label') === 'Working'
      && document.querySelector('#homePeople .cagent[data-agent="nora"] .carecap')?.textContent === 'Rewriting the pricing table for annual plans.',
    { timeout: 12_000 },
  ).then(() => true).catch(() => false);
  check('the people tick moves an agent to Working and brings its new recap', moved,
    (await texts('#homePeople .cagent[data-agent="nora"]')).join('|'));
  check('…without a full people read or a state read', peopleReads === 0 && stateReads === 0, `${peopleReads} people, ${stateReads} state`);
  working.delete('dana:nora');

  // The same tick brings a change merged while the reader looks (note #925);
  // the workplace's numbers are read at most every ten seconds, so this can
  // take a tick and a half.
  await merge('Driver ETAs in the customer text', 0);
  const landed = await page.waitForFunction(
    () => document.querySelector('#homePeople .crow[data-person="dana"] .pctitle')?.textContent === 'Driver ETAs in the customer text'
      && document.querySelector('#homePeople .crow[data-person="dana"] [data-stat="merged"] b')?.textContent === '3',
    { timeout: 25_000 },
  ).then(() => true).catch(() => false);
  check('a change merged while the reader looks lands on the card by the tick', landed,
    (await texts('#homePeople .crow[data-person="dana"] .pcontrib')).join('|'));
  check('…still without a full people read', peopleReads === 0, `${peopleReads} people reads`);

  // 5. A press on an agent's line opens that agent; elsewhere, the person.
  await tap(page, '#homePeople .cagent[data-agent="leo"] .carecap');
  await page.waitForFunction(() => /\/agents\/leo\b/.test(location.pathname)
    || [...document.querySelectorAll<HTMLElement>('.windowpage:not([hidden])')].some((node) => node.dataset.address === '/agents/leo'), { timeout: 10_000 }).catch(() => {});
  const atLeo = await page.evaluate(() => /\/agents\/leo\b/.test(location.pathname)
    || [...document.querySelectorAll<HTMLElement>('.windowpage:not([hidden])')].some((node) => node.dataset.address === '/agents/leo'));
  check('an agent’s line opens that agent', atLeo, await page.evaluate(() => location.pathname));
  await page.waitForFunction(() => document.body.textContent?.includes('Dana Ives'), { timeout: 10_000 }).catch(() => {});
  check('…whose page says who drives it', Boolean(await page.evaluate(() => document.body.textContent?.includes('Dana Ives'))));

  // 6. The People page, from the account menu: the same plates.
  await page.goto(`${ORIGIN}/?org=${org.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome #homeAccount', { timeout: 10_000 });
  await closeHomeWindow(page).catch(() => {});
  await page.click('#homeAccount');
  await page.waitForSelector('#accountMenuPeople', { visible: true, timeout: 5_000 }).catch(() => {});
  check('the account menu has its People row again', (await texts('#accountMenuPeople .orgmenufacts'))[0] === '2 people in Nomad Trading',
    (await texts('#accountMenuPeople .orgmenufacts'))[0]);
  await page.click('#accountMenuPeople');
  await page.waitForSelector('#people .crow[data-person="dana"] .cagent', { timeout: 10_000 }).catch(() => {});
  check('the People page draws the same plates',
    (await attrs('#people .crow[data-person="dana"] .cagent', 'data-agent-door')).join('|') === 'leo|nora'
    && (await texts('#people .crow[data-person="dana"] .personname'))[0] === 'Dana Ives',
    `${(await attrs('#people .crow[data-person="dana"] .cagent', 'data-agent-door')).join('|')} · ${(await texts('#people .crow[data-person="dana"] .personname'))[0]}`);
  check('…under a title naming the head count', ((await texts('#peopleSub'))[0] ?? '').startsWith('Nomad Trading · 2 people · 1 here now'), (await texts('#peopleSub'))[0]);
  await shot('people-page-phone');

  // 7. Dana's own screen lists every agent with its state and recap.
  await tap(page, '#people .crow[data-person="dana"] .name');
  await page.waitForSelector('#orgMemberAgents .memberagent', { timeout: 10_000 }).catch(() => {});
  check('her screen names her role again', ((await texts('#orgMemberSub'))[0] ?? '') === 'Member of Nomad Trading', (await texts('#orgMemberSub'))[0]);
  check('…and lists her agents with their state and recap, the working one first',
    (await texts('#orgMemberAgents .memberagent .mstate')).join('|') === 'Working|Idle'
    && (await texts('#orgMemberAgents .memberagent .mrecap'))[0] === 'Fixing the footer on the landing page; checks running.',
    `${(await texts('#orgMemberAgents .memberagent .mstate')).join('|')} · ${(await texts('#orgMemberAgents .memberagent .mrecap')).join('|')}`);
  // Note #925: her screen's whole contribution — this week, all time, and
  // each change merged this week with the agent that made it, newest first.
  await page.waitForSelector('#orgMemberMerged .memberchange', { timeout: 10_000 }).catch(() => {});
  const memberStats = (selector: string) => page.$eval(selector, (block) => [
    ...block.querySelectorAll('.pcstats > div')].map((node) => `${node.querySelector('b')?.textContent} ${node.querySelector('span')?.textContent?.replace(/\u00a0/g, ' ')}`).join('|'));
  check('her screen says this week',
    await memberStats('#orgMemberWeek') === '3h agent hours|3 changes merged|182K tokens · Claude Code|41K tokens · Codex', await memberStats('#orgMemberWeek'));
  check('…and all time',
    await memberStats('#orgMemberWorked') === '3h agent hours|3 changes merged|182K tokens · Claude Code|41K tokens · Codex', await memberStats('#orgMemberWorked'));
  const changes = await texts('#orgMemberMerged .memberchange .mctitle');
  check('…and lists this week’s merged changes, newest first',
    changes.join('|') === 'Driver ETAs in the customer text|Live van map with ETAs on the dispatcher screen|Footer links point at the new pricing page', changes.join('|'));
  check('…each naming the agent and the repository',
    (await texts('#orgMemberMerged .memberchange .mcfacts'))[0] === 'leo · dispatch #4' || (await texts('#orgMemberMerged .memberchange .mcfacts'))[0] === 'Leo · dispatch #4',
    (await texts('#orgMemberMerged .memberchange .mcfacts'))[0]);
  await shot('member-phone');

  // 8. The same on a desk.
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${ORIGIN}/workplace/people?org=${org.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#people .crow[data-person="dana"] .cagent', { timeout: 10_000 }).catch(() => {});
  const columns = await page.$$eval('#people .crow', (rows) => new Set(rows.map((row) => Math.round(row.getBoundingClientRect().top))).size);
  check('on a desk the two plates stand side by side', columns === 1, `${columns} rows of plates`);
  await shot('people-page-desk');
  await page.goto(`${ORIGIN}/?org=${org.orgId}`, { waitUntil: 'networkidle0' });
  await openDeck();
  await shotWindow('home-deck-desk');
  await page.goto(`${ORIGIN}/workplace/members/dana?org=${org.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgMemberMerged .memberchange', { timeout: 10_000 }).catch(() => {});
  await shot('member-desk');

  // A merged change is a door to its proposal.
  await page.click('#orgMemberMerged .memberchange');
  const opened = await page.waitForFunction(() => /\/decisions\/pr\//.test(location.pathname)
    || [...document.querySelectorAll<HTMLElement>('.windowpage:not([hidden])')].some((node) => /\/decisions\/pr\//.test(node.dataset.address ?? '')),
  { timeout: 10_000 }).then(() => true).catch(() => false);
  check('a merged change opens its proposal', opened, await page.evaluate(() => location.pathname));
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
