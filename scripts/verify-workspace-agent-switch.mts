// Notes #581, #713 and #721: the stack of agent faces in the chat composer,
// and the launcher it opens — a search field, what waits on the reader, and
// every agent as one card in one list — driven in real Chrome against a
// real workplace.
//
// The sheet had the rooms as tabs over its cards — All, then a tab per room
// that was the room's whole view — until rooms left the product (note
// #843); its promise is "every agent you could switch to". jsdom cannot see
// the rest of it: that the stack is to the LEFT of the box and the same
// height as Send; that on a phone the
// sheet is ALMOST full screen — anchored to the bottom edge the button is
// on, and short of the top so the conversation is still there above it —
// while at a desk it stands in the middle like the launcher; and how many
// cards fit across.
//
// The fleet is the owner's own (2026-10-10): nine agents with their real
// faces, Oscar and Clara mid-turn — so the working-first order (note #775)
// has busy agents to lift over more recently active idle ones.
//
// It also measured the counted stack's `+N` disc on the rooms screen; the
// rooms screen went with rooms, and the disc is measured where a counted
// stack still stands: the People door on the workplace's page.
//
// Screenshots land in OUT_DIR (~/n581-proof by default).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-agent-switch.mts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { OrgGitService } from '../backend/src/services/org-git.js';
import { InMemoryGitRepoStorage } from '../backend/src/services/git-repo-storage.js';
import { InMemoryGitPullRequestStorage } from '../backend/src/services/git-pr-storage.js';
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

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n581-proof');
mkdirSync(OUT, { recursive: true });

/** The Chrome puppeteer downloaded, whichever build it is — resolved rather
 *  than pinned, so a machine rebuild does not strand this script. */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4198);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
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
const gitRepoStorage = new InMemoryGitRepoStorage();
const gitPullRequestStorage = new InMemoryGitPullRequestStorage();

/** A stand-in for a member's profile picture: a real drawn square, so the
 *  counted stack on the People door has a picture under its `+N` disc. */
const PERSON_PHOTO = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c9785b"/>'
  + '<circle cx="32" cy="26" r="12" fill="#f3d9c6"/><rect x="14" y="42" width="36" height="22" rx="11" fill="#f3d9c6"/></svg>',
).toString('base64');

/** Chat is scenery here: the switcher is drawn on a conversation, not by one.
 *  Every conversation in this fixture is empty, and only the agents named
 *  here are working — the faces that should wear the live dot. Step 8 moves
 *  it to watch the cards hold still under a finger (note #775). */
const working = new Set(['oscar', 'clara']);
const agentLifecycle = {
  agentChatMessages: async () => [],
  isAgentWorking: (_userId: string, agentId: string) => working.has(agentId),
  agentActivity: () => null,
  listManagedJobs: async () => ({ jobs: [], recent: [] }),
} as unknown as RouteDeps['agentLifecycle'];

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  orgStorage,
  orgGit: new OrgGitService({ orgStorage }),
  gitRepoStorage,
  gitPullRequestStorage,
  secretStorage: new InMemorySecretStorage(),
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  agentLifecycle,
  mediaStorage: {
    createReadAccess: async () => ({ url: PERSON_PHOTO, expiresAt: new Date(Date.now() + 900_000).toISOString() }),
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
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    const expected = (response.status() === 401 && url.pathname === '/workspace/auth/session')
      || (response.status() === 404 && url.pathname === '/favicon.ico');
    if (response.status() >= 400 && !expected) consoleErrors.push(`${response.status()} ${response.url()}`);
  });
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png` });
  /** The sheet and its dim have finished arriving: geometry read before then
   *  is a frame of the slide, not where the sheet stands. */
  const settled = () => page.waitForFunction(() => {
    const sheet = document.getElementById('agentSwitchSheet');
    return Boolean(sheet) && sheet!.getAnimations().length === 0 && sheet!.parentElement!.getAnimations().length === 0;
  }, { timeout: 10_000 });
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  /** How dark the dim is right now — the alpha of the scrim's own colour. */
  const dimAlpha = () => page.$eval('#agentSwitchSheet', (node) => {
    const colour = getComputedStyle(node.parentElement!).backgroundColor;
    const parts = colour.match(/[\d.]+/g) ?? [];
    return parts.length >= 4 ? Number(parts[3]) : colour === 'transparent' ? 0 : 1;
  });
  const box = (selector: string) => page.$eval(selector, (node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: Math.round(rect.left), right: Math.round(rect.right),
      top: Math.round(rect.top), bottom: Math.round(rect.bottom),
      width: Math.round(rect.width), height: Math.round(rect.height),
    };
  });

  // 1. A workplace, and the owner's nine agents in it. Every name is in
  //    the avatar pool, so every face is a
  //    real picture rather than the fallback glyph — the faces are what this
  //    sheet is made of.
  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Nomad Trading' });
  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  const seed = (id: string, name: string, minutesAgo: number, recap: string, over: Record<string, unknown> = {}) => [id, {
    id, name, cli: 'claude', createdAt: iso(60 * 24 * 4), serverId: `m-${id}`,
    connectedAt: iso(60 * 24 * 4), model: 'opus', effort: 'xhigh',
    lastActivityAt: iso(minutesAgo),
    recap: { text: recap, at: iso(minutesAgo) },
    // A dedicated machine, so a plate WOULD say "2 dedicated cores · 4 GB" —
    // which is exactly what a face must not (note #713).
    machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
    ...over,
  }] as const;
  const used = (fraction: number) => ({ contextUsage: { tokens: Math.round(fraction * 1_000_000), window: 1_000_000, at: iso(5) } });
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(me.telegram ?? {}),
      agents: Object.fromEntries([
        seed('alex', 'Alex', 2, 'Building the redesigned agents picker from note #713.', used(0.22)),
        seed('ada', 'Ada', 16, 'Finished and verified the diet of the agent instruction file; the laptop proposal button and a later prose trim are saved in notes as open ideas.', { model: 'fable', effort: 'medium' }),
        seed('oscar', 'Oscar', 62, 'Token ledger on Subscriptions counts Claude turns exactly, and knowledge page #345 (agent token ledger) is approved and live. Codex counting is still unproven.', { effort: 'high', ...used(0.41) }),
        seed('iris', 'Iris', 60 * 26, 'Dropped the workplace Delete/Leave subscription-gate fix at the owner’s call and noted the gap on the ‘Deleting a workplace’ knowledge page.', used(0.17)),
        seed('ben', 'Ben', 60 * 27, 'Shipped the ‘Reset N finished agents’ button on the room screen; the approved knowledge page on how an agent is judged finished is live.', used(0.33)),
        seed('noah', 'Noah', 34, 'Mocked storyboard pictures 3 to 12 on the new landing page, dropping 1 and 2 and ending with the clay Ruby.'),
        seed('rosa', 'Rosa', 75, 'Confirmed admins without a live subscription can’t reach Delete this workplace; the test account stays until its 12 Oct purge.'),
        seed('clara', 'Clara', 11, 'Built per-day working-time counting for the Leaderboard and the second proposal’s board service, routes, and tests.', used(0.58)),
        seed('willow', 'Willow', 60 * 3, 'Adam approved proposal #38 (product page ‘What the product is’), so the vision is now live in the knowledge pages.'),
      ]) as never,
    },
  });

  // 2. Alex's conversation — where the switcher lives.
  await page.goto(`${ORIGIN}/chat/alex`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#agentChatText', { timeout: 10_000 });
  await page.waitForSelector('#agentChatSwitch', { timeout: 10_000 });
  await shot('agent-switch-composer');
  // The bar on its own, for the eye: the whole screen is mostly empty
  // transcript, and the change is 60 pixels of it.
  await page.screenshot({
    path: path.join(OUT, 'agent-switch-bar.png') as `${string}.png`,
    clip: { x: 0, y: 844 - 72, width: 390, height: 72 },
  });

  const stack = await box('#agentChatSwitch');
  const field = await box('#agentChatText');
  const send = await box('#agentChatSend');
  check('the stack stands to the LEFT of the box, inside the composer bar',
    stack.right <= field.left && stack.left < field.left, JSON.stringify({ stack, field }));
  check('…at the height of Send on the other side, so the row lines up',
    stack.height === send.height, `${stack.height} vs ${send.height}`);
  const stackFaces = await page.$$eval('#agentChatSwitch .face', (nodes) => nodes.map((node) => ({
    tag: node.tagName, src: node.getAttribute('src') ?? '', text: node.textContent?.trim() ?? '',
  })));
  check('it wears the OTHER agents’ faces, and none is Alex',
    stackFaces.length === 3 && stackFaces.every((face) => face.tag === 'IMG' && /\/avatars\//.test(face.src))
      && !stackFaces.some((face) => /alex/.test(face.src)),
    JSON.stringify(stackFaces));
  // The owner, 2026-09-20: a grey disc with a number in it reads as a broken
  // portrait, and this button is a DOOR — the list behind it states the count
  // properly. Eight agents to switch to here, and not a digit on the button.
  check('…and no count, however many it could not draw',
    !(await page.$('#agentChatSwitch .face.more')), JSON.stringify(stackFaces));
  // It promised "your agents and rooms" until rooms left the product (note
  // #843).
  check('and it says in words what the pictures say',
    (await page.$eval('#agentChatSwitch', (node) => node.getAttribute('aria-label'))) === 'Your agents',
    String(await page.$eval('#agentChatSwitch', (node) => node.getAttribute('aria-label'))));

  // 3. The sheet on a phone: almost the whole screen, from the bottom edge.
  const tiles = () => page.$$eval('#agentSwitchGrid .crow[data-agent]', (nodes) => nodes.map((node) => ({
    agent: node.getAttribute('data-agent') ?? '',
    role: node.getAttribute('role') ?? '',
    name: node.querySelector('.name')?.textContent?.trim() ?? '',
    line: node.querySelector('.ctext')?.textContent?.trim() ?? '',
    recap: node.querySelector('.cabout')?.textContent?.trim() ?? '',
    words: node.textContent ?? '',
    live: Boolean(node.querySelector('.livedot')),
    ring: Boolean(node.querySelector('.ctxring')),
    left: Math.round(node.getBoundingClientRect().left),
    top: Math.round(node.getBoundingClientRect().top),
  })));
  // A proposal of Noah's, while the reader is in Alex's conversation: the
  // queue is the workplace's one queue (notes #721, #843).
  // Seeded only now, after the button's own checks, because a decision
  // waiting puts the attention mark on it.
  const landingRepo = await gitRepoStorage.create({
    userId: org.orgId, orgId: org.orgId, name: 'landing', createdByAgentId: 'noah',
    defaultBranch: 'main', sizeBytes: 0, protectDefaultBranch: true,
  } as never);
  await gitPullRequestStorage.create({
    userId: org.orgId, repoId: landingRepo.id, title: 'Storyboard pictures 3 to 12 on the landing page', body: '',
    sourceBranch: 'storyboard', targetBranch: 'main', createdByAgentId: 'noah', createdByUserId: account.userId, status: 'open',
    headSha: 'a'.repeat(40), commitSubjects: ['Storyboard pictures'], diffStat: { files: 3, insertions: 120, deletions: 14 },
  } as never);
  await page.click('#agentChatSwitch');
  await page.waitForSelector('#agentSwitchSheet', { timeout: 10_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#agentSwitchGrid .crow[data-agent]').length === 8,
    { timeout: 10_000 },
  );
  await page.waitForSelector('#agentSwitchDecisions .crow', { timeout: 10_000 }).catch(() => null);
  await settled();
  // The pictures, not their grey placeholders, in the proof.
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLImageElement>('#agentSwitchGrid img')].every((img) => img.complete && img.naturalWidth > 0),
    { timeout: 10_000 },
  );
  await shot('agent-switch-sheet');
  const sheet = await box('#agentSwitchSheet');
  const view = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  check('the sheet is anchored to the bottom edge the button is on',
    sheet.bottom === view.height && sheet.width === view.width, JSON.stringify({ sheet, view }));
  check('…and stops short of the top, so the conversation is still there above it',
    sheet.top > 24 && sheet.height > view.height * 0.8 && sheet.height < view.height,
    JSON.stringify({ top: sheet.top, height: sheet.height, view: view.height }));
  check('the search and the way out stay put while the cards under them move',
    (await box('#agentSwitchClose')).top < (await box('#agentSwitchList')).top
      && (await box('#agentSwitchSearch')).top < (await box('#agentSwitchList')).top);

  check('the queue lists another agent’s proposal, above the cards (note #721)',
    (await page.$$eval('#agentSwitchDecisions .crow .name', (nodes) => nodes.map((node) => node.textContent?.trim()))).join('|')
      === 'Storyboard pictures 3 to 12 on the landing page'
      && (await box('#agentSwitchDecisions')).bottom < (await box('#agentSwitchGrid')).top);

  // 4. The agents the button promised, in one list — and never this
  //    conversation. The working agents lead (note #775), each half in the
  //    sheet's order. The rooms were tabs over the list until rooms left the
  //    product (note #843): no tab of any kind is left.
  check('no tabs over the cards: one list',
    !(await page.$('#agentSwitchTabs')) && !(await page.$('#agentSwitchSheet [role="tab"]')),
    await page.$eval('#agentSwitchSheet', (node) => node.textContent?.slice(0, 200) ?? ''));
  const phone = await tiles();
  // The two working agents first, then the idle ones, each half most
  // recently used first — no room grouping under either (note #843).
  check('the cards are every agent there is to switch to — Alex is not in its own list',
    phone.map((tile) => tile.agent).join('|') === 'clara|oscar|ada|noah|rosa|willow|iris|ben',
    JSON.stringify(phone.map((tile) => tile.agent)));
  check('two cards across on a phone',
    new Set(phone.filter((tile) => tile.top === phone[0]!.top).map((tile) => tile.left)).size === 2,
    JSON.stringify(phone.map((tile) => [tile.left, tile.top])));
  check('each card wears its ring, its name, its state line and its latest-work recap (note #721)',
    phone.every((tile) => tile.ring && tile.name && tile.line && tile.recap) && /^Active 1[67]m ago$/.test(phone.find((tile) => tile.agent === 'ada')!.line),
    JSON.stringify(phone.map((tile) => [tile.name, tile.line, tile.recap.slice(0, 20)])));
  check('…the live dot on the two agents mid-turn, and only there',
    phone.filter((tile) => tile.live).map((tile) => tile.agent).join('|') === 'clara|oscar',
    JSON.stringify(phone.map((tile) => [tile.agent, tile.live, tile.line])));
  check('…and the recap is the agent’s own',
    phone.find((tile) => tile.agent === 'oscar')!.recap.includes('Token ledger on Subscriptions'),
    phone.find((tile) => tile.agent === 'oscar')!.recap);
  check('and every card is a door, because none of them leads nowhere',
    phone.every((tile) => tile.role === 'button'), JSON.stringify(phone.map((tile) => tile.role)));

  // 5. The search narrows the cards by name as it goes.
  await page.waitForSelector('#agentSwitchSearch', { timeout: 5_000 });
  await page.type('#agentSwitchSearch', 'os');
  await page.waitForFunction(() => document.querySelectorAll('#agentSwitchGrid .crow[data-agent]').length === 2, { timeout: 5_000 });
  check('typing filters the cards by name as it goes',
    (await tiles()).map((tile) => tile.agent).join('|') === 'oscar|rosa');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('#agentSwitchGrid .crow[data-agent]').length === 8, { timeout: 5_000 });
  check('Escape empties the search before it closes anything', Boolean(await page.$('#agentSwitchSheet')));

  // 6. A card opens that conversation, and the sheet stands down: the chat
  //    is the same route with a different id, so nothing unmounts the sheet
  //    for us.
  await page.click('#agentSwitchGrid [data-agent="noah"]');
  await page.waitForFunction(
    () => document.getElementById('agentChatTitle')?.textContent?.trim() === 'Noah',
    { timeout: 10_000 },
  );
  check('a card opens that agent’s conversation at its own address',
    page.url() === `${ORIGIN}/chat/noah`, page.url());
  await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout: 5_000 });
  check('…and the sheet stood down behind it', !(await page.$('#agentSwitchSheet')));

  // 7. Close and Back are the same answer, and neither costs the conversation.
  await page.type('#agentChatText', 'half a thought');
  await page.click('#agentChatSwitch');
  await page.waitForSelector('#agentSwitchSheet', { timeout: 10_000 });
  await settled();
  await page.click('#agentSwitchClose');
  await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout: 5_000 });
  check('Close puts the sheet away', !(await page.$('#agentSwitchSheet')));
  await page.click('#agentChatSwitch');
  await page.waitForSelector('#agentSwitchSheet', { timeout: 10_000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout: 5_000 });
  check('Escape is the same answer', !(await page.$('#agentSwitchSheet')));
  check('and the unsent draft stood behind it the whole time',
    (await page.$eval('#agentChatText', (node) => (node as HTMLTextAreaElement).value)) === 'half a thought');

  // 7b. The way in and the way out (the owner, 2026-10-10). Chrome plays
  //     every animation at a tenth of its speed here, so a frame of each can
  //     be caught in flight rather than raced: the sheet slides up from the
  //     bottom while the dim darkens, and every way out — Escape, a tap on
  //     the dim — slides it back down and lightens the dim BEFORE it goes.
  const cdp = await page.createCDPSession();
  await cdp.send('Animation.enable');
  const slow = (rate: number) => cdp.send('Animation.setPlaybackRate', { playbackRate: rate });
  const rested = sheet.top;
  await slow(0.1);
  await page.click('#agentChatSwitch');
  await page.waitForSelector('#agentSwitchSheet', { timeout: 10_000 });
  await pause(700);
  const rising = await box('#agentSwitchSheet');
  const dimming = await dimAlpha();
  check('it slides UP from the bottom edge on the way in…',
    rising.top > rested + 40 && rising.top < view.height, JSON.stringify({ midway: rising.top, rested }));
  // At rest the dim is 58% black (`.scrim`).
  check('…while the dim behind it fades in', dimming > 0.02 && dimming < 0.56, String(dimming));
  await settled();
  check('…and comes to rest where it stands', (await box('#agentSwitchSheet')).top === rested);
  await page.keyboard.press('Escape');
  await pause(1000);
  const sinking = await page.$eval('#agentSwitchSheet', (node) => ({
    top: Math.round(node.getBoundingClientRect().top),
    leaving: node.parentElement!.classList.contains('leaving'),
    name: getComputedStyle(node).animationName,
  })).catch(() => null);
  const lightening = await dimAlpha().catch(() => -1);
  check('Escape slides it back DOWN before it goes — not gone at once',
    Boolean(sinking?.leaving) && sinking!.name === 'agentsheetdown' && sinking!.top > rested + 40, JSON.stringify(sinking));
  check('…the dim fading out with it', lightening > 0.02 && lightening < 0.56, String(lightening));
  await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout: 10_000 });
  check('…and then it is gone', !(await page.$('#agentSwitchSheet')));
  await slow(1);
  await page.click('#agentChatSwitch');
  await page.waitForSelector('#agentSwitchSheet', { timeout: 10_000 });
  await settled();
  await slow(0.1);
  await page.mouse.click(195, 40);
  await pause(300);
  const tapped = await page.$eval('#agentSwitchSheet', (node) => node.parentElement!.classList.contains('leaving')).catch(() => false);
  check('a tap on the dim plays the same way out', tapped);
  await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout: 10_000 });
  await slow(1);

  // 7c. Asked for less movement: nothing moves, either way, and a way out is
  //     immediate — no exit phase to wait through.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.click('#agentChatSwitch');
  await page.waitForSelector('#agentSwitchSheet', { timeout: 10_000 });
  const still = await page.$eval('#agentSwitchSheet', (node) => [
    getComputedStyle(node).animationName, getComputedStyle(node.parentElement!).animationName,
  ]);
  check('with reduced motion the sheet and the dim do not animate in', still.join('|') === 'none|none', still.join('|'));
  await page.evaluate(() => {
    const scrim = document.getElementById('agentSwitchSheet')!.parentElement!;
    (window as unknown as { sawLeaving: boolean }).sawLeaving = false;
    new MutationObserver(() => {
      if (scrim.classList.contains('leaving')) (window as unknown as { sawLeaving: boolean }).sawLeaving = true;
    }).observe(scrim, { attributes: true, attributeFilter: ['class'] });
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout: 2_000 });
  check('…and Escape closes it at once, with no exit played',
    !(await page.evaluate(() => (window as unknown as { sawLeaving: boolean }).sawLeaving)));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  // 8. On a touch screen: no keyboard over the cards, and a tap on one is
  //    the switch. A touch screen is a different page to Chrome, so this
  //    one reloads.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await page.goto(`${ORIGIN}/chat/alex`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#agentChatSwitch', { timeout: 10_000 });
  await page.tap('#agentChatSwitch');
  await page.waitForFunction(() => document.querySelectorAll('#agentSwitchGrid .crow[data-agent]').length === 8, { timeout: 10_000 });
  await settled();
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLImageElement>('#agentSwitchGrid img')].every((img) => img.complete && img.naturalWidth > 0),
    { timeout: 10_000 },
  );
  await shot('agent-switch-phone');
  check('on a touch screen the search does not take the focus — no keyboard over the cards',
    (await page.evaluate(() => document.activeElement?.id ?? '')) === 'agentSwitchSheet');

  // The cards hold still under a finger (note #775). Scrolled down into
  // the list, Clara stops and Willow starts: the dots move, the places do
  // not. Back at the top, the new order is drawn.
  const order = async () => (await tiles()).map((tile) => tile.agent).join('|');
  const lit = (id: string, on: boolean) => page.waitForFunction(
    (agent, want) => Boolean(document.querySelector(`#agentSwitchGrid [data-agent="${agent}"] .livedot`)) === want,
    { timeout: 15_000 }, id, on,
  );
  const drawn = await order();
  await page.$eval('#agentSwitchList', (node) => { node.scrollTop = 400; });
  await pause(200);
  working.delete('clara');
  working.add('willow');
  await lit('willow', true);
  await lit('clara', false);
  check('scrolled down, a turn starting and ending moves the dots and not the cards',
    (await order()) === drawn, JSON.stringify([drawn, await order()]));
  await page.$eval('#agentSwitchList', (node) => { node.scrollTop = 0; });
  await page.waitForFunction(
    () => document.querySelectorAll('#agentSwitchGrid .crow[data-agent]')[1]?.getAttribute('data-agent') === 'willow',
    { timeout: 5_000 },
  ).catch(() => null);
  // The idle half re-reads in the sheet's order too: Clara, used a moment
  // ago, now leads the idle agents.
  const resorted = await order();
  check('…and back at the top the working agents lead again',
    /^oscar\|willow\|clara\|ada\|/.test(resorted) && !resorted.endsWith('|willow'), resorted);
  // A finger resting on the list at its top holds it just the same. It
  // drags a little before it lifts, so Chrome does not read it as a tap on
  // whatever card is nearest.
  const ada = await box('#agentSwitchGrid [data-agent="ada"]');
  const finger = await page.touchscreen.touchStart(ada.left + 40, ada.top + 40);
  working.delete('willow');
  working.add('clara');
  await lit('clara', true);
  await lit('willow', false);
  check('a finger on the list holds the cards where they are',
    (await order()) === resorted, JSON.stringify([resorted, await order()]));
  await finger.move(ada.left + 40, ada.top + 90);
  await finger.end();
  await page.waitForFunction(
    () => document.querySelectorAll('#agentSwitchGrid .crow[data-agent]')[0]?.getAttribute('data-agent') === 'clara',
    { timeout: 5_000 },
  ).catch(() => null);
  check('…and lifting it draws the new order',
    /^clara\|oscar\|ada\|/.test(await order()), await order());
  await pause(600);

  // Oscar's card is in the first row, on the screen without a scroll.
  const oscar = await box('#agentSwitchGrid [data-agent="oscar"]');
  await page.touchscreen.tap(oscar.left + oscar.width / 2, oscar.top + 30);
  await page.waitForFunction(() => document.getElementById('agentChatTitle')?.textContent?.trim() === 'Oscar', { timeout: 10_000 }).catch(() => null);
  check('a tap on a card opens that agent', page.url() === `${ORIGIN}/chat/oscar`, page.url());

  // 9. At a desk: the launcher in the middle of the screen, two cards
  //    across, and the search ready to type into.
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(`${ORIGIN}/chat/alex`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#agentChatSwitch', { timeout: 10_000 });
  // The desk's way in and out: no edge to slide from, so a quick fade and a
  // slight scale where it stands, the workplace menu's own (`orgmenuin`).
  const deskCdp = await page.createCDPSession();
  await deskCdp.send('Animation.enable');
  await deskCdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
  await page.click('#agentChatSwitch');
  await page.waitForSelector('#agentSwitchSheet', { timeout: 10_000 });
  await pause(500);
  const popping = await page.$eval('#agentSwitchSheet', (node) => ({
    name: getComputedStyle(node).animationName, opacity: Number(getComputedStyle(node).opacity),
  }));
  check('at a desk it fades and scales in where it stands, rather than sliding',
    popping.name === 'agentsheetpop' && popping.opacity > 0 && popping.opacity < 1, JSON.stringify(popping));
  await settled();
  await page.keyboard.press('Escape');
  await pause(300);
  const fading = await page.$eval('#agentSwitchSheet', (node) => ({
    name: getComputedStyle(node).animationName, opacity: Number(getComputedStyle(node).opacity),
  })).catch(() => null);
  check('…and fades out the same way before it goes',
    fading?.name === 'agentsheetpopout' && fading.opacity < 1, JSON.stringify(fading));
  await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout: 10_000 });
  await deskCdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  await page.click('#agentChatSwitch');
  await page.waitForFunction(() => document.querySelectorAll('#agentSwitchGrid .crow[data-agent]').length === 8, { timeout: 10_000 });
  await settled();
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLImageElement>('#agentSwitchGrid img')].every((img) => img.complete && img.naturalWidth > 0),
    { timeout: 10_000 },
  );
  const desk = await box('#agentSwitchSheet');
  const deskView = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const deskTiles = await tiles();
  check('at a desk the sheet hangs centred near the top of the screen',
    Math.abs(desk.left - (deskView.width - desk.right)) <= 1 && desk.top >= 48 && desk.top <= deskView.height * 0.2,
    JSON.stringify({ desk, deskView }));
  check('…and stops short of the bottom of the window, the cards scrolling inside it',
    desk.bottom <= deskView.height - 24, JSON.stringify({ desk, deskView }));
  check('two cards across at a desk',
    new Set(deskTiles.filter((tile) => tile.top === deskTiles[0]!.top).map((tile) => tile.left)).size === 2,
    JSON.stringify(deskTiles.map((tile) => [tile.left, tile.top])));
  check('…and the search takes the focus, ready to type a name',
    (await page.evaluate(() => document.activeElement?.id ?? '')) === 'agentSwitchSearch');
  await shot('agent-switch-desk');
  await page.type('#agentSwitchSearch', 'wil');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('agentChatTitle')?.textContent?.trim() === 'Willow', { timeout: 10_000 }).catch(() => null);
  check('typing a name and Enter opens that agent', page.url() === `${ORIGIN}/chat/willow`, page.url());
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  // 10. The COUNTER still exists where a stack is a census rather than a door
  //    — the People door on the workplace's page, which stacks the members'
  //    faces the way a room's mark on the rooms screen stacked its agents'
  //    until rooms left the product (note #843) — and there it must be
  //    opaque.
  //
  //    The owner's report (2026-09-20) was a "+12" with a dog's ear showing
  //    through its digits: the disc overlaps the face beside it, so a
  //    translucent fill is a window. Measured by taking the SAME pixel twice,
  //    once with the face behind it hidden and once with it showing. Not off
  //    the computed value — Chrome writes `rgb()`, `rgba()` or `color(srgb …)`
  //    depending on how the colour was arrived at — and not by comparing two
  //    points on the disc, because `+3` reaches within a couple of pixels of
  //    both its edges. Hiding the neighbour changes nothing about the disc
  //    except what is UNDER it, so an opaque fill cannot tell the two apart.
  //    Four teammates join, each with a picture: five people, so the door's
  //    stack draws two faces and a `+3`.
  for (const [id, first, last] of [['dana', 'Dana', 'Ives'], ['ben', 'Ben', 'Ortiz'], ['cara', 'Cara', 'Diaz'], ['eli', 'Eli', 'Moss']] as const) {
    await userStorage.createProfile(id, { email: `${id}@example.com`, displayName: `${first} ${last}` } as never);
    await userStorage.updateProfile(id, { person: { firstName: first, lastName: last, photo: { storagePath: `people/${id}.png` } } } as never);
    await orgStorage.addMember({ orgId: org.orgId, userId: id, role: 'member' } as never);
  }
  await page.goto(`${ORIGIN}/workplace?org=${org.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgPeopleDoor .face.more', { timeout: 10_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLImageElement>('#orgPeopleDoor img.face')].every((img) => img.complete && img.naturalWidth > 0),
    { timeout: 10_000 },
  ).catch(() => null);
  const census = await page.$eval('#orgPeopleDoor', (row) => ({
    faces: row.querySelectorAll('.faces .face').length,
    more: row.querySelector('.face.more')?.textContent?.trim() ?? '',
  }));
  check('a counted stack still counts the faces it had no room for',
    JSON.stringify(census) === JSON.stringify({ faces: 3, more: '+3' }),
    JSON.stringify(census));
  const discPixel = async () => {
    const disc = await page.$('#orgPeopleDoor .face.more');
    if (!disc) throw new Error('the People door drew no counter disc');
    const shot = await disc.screenshot({ encoding: 'base64' });
    return page.evaluate(async (data: string) => {
      const img = new Image();
      await new Promise((done, fail) => { img.onload = done; img.onerror = fail; img.src = `data:image/png;base64,${data}`; });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      // Mid-height, a fifth of the way in: under the face overlapping this
      // disc's leading third, and well inside its own circle. Written without
      // a named helper on purpose — tsx compiles one into a `__name(...)` call
      // that does not exist in the page, and the evaluate dies on a
      // ReferenceError rather than on anything real.
      const start = (Math.round(canvas.height / 2) * canvas.width + Math.round(canvas.width * 0.2)) * 4;
      return [pixels[start]!, pixels[start + 1]!, pixels[start + 2]!];
    }, shot);
  };
  const behindShowing = await discPixel();
  await page.$eval('#orgPeopleDoor .face:nth-child(2)', (node) => { (node as HTMLElement).style.visibility = 'hidden'; });
  const behindHidden = await discPixel();
  await page.$eval('#orgPeopleDoor .face:nth-child(2)', (node) => { (node as HTMLElement).style.visibility = ''; });
  const bleed = Math.max(
    Math.abs(behindShowing[0]! - behindHidden[0]!),
    Math.abs(behindShowing[1]! - behindHidden[1]!),
    Math.abs(behindShowing[2]! - behindHidden[2]!),
  );
  check('…on a disc nothing reads through', bleed === 0,
    JSON.stringify({ behindShowing, behindHidden, bleed }));
  const door = await box('#orgPeopleDoor');
  await page.screenshot({ path: path.join(OUT, 'people-census.png') as `${string}.png`, clip: { x: 0, y: Math.max(0, door.top - 8), width: 390, height: door.height + 16 } });

  check('nothing went wrong in the console', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '));
  console.log(`\nscreenshots in ${OUT}`);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
