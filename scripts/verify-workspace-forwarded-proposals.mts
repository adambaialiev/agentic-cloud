/**
 * Note #724, in real Chrome: proposals the Chief of Staff forwarded appear in
 * its conversation as cards — the decision queue's own rows, with the
 * author's face, the checks and the state — and a card follows the
 * proposal: merge it, and the next read says Merged without the row's words
 * changing. The card opens the proposal's own screen, where the decision is.
 * Each card's label named the proposal's room after its kind ("Change
 * proposal · Platform") until rooms left the product (note #843): the
 * label names none.
 *
 *   npm --prefix backend run build:workspace-ui
 *   OUT_DIR=/tmp/shots backend/node_modules/.bin/tsx scripts/verify-workspace-forwarded-proposals.mts
 */
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
import { InMemoryKnowledgeProposalStorage } from '../backend/src/services/knowledge-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'forwarded-proposals-proof');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().at(-1);
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4197);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const userStorage = new InMemoryUserStorage();
const orgStorage = new InMemoryOrgStorage();
harnessEstablishedWorkplace(orgStorage);
const gitRepoStorage = new InMemoryGitRepoStorage();
const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
const knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(),
  mailbox.config,
  mailbox.mailboxes,
);
const deps = {
  userStorage,
  orgStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  gitRepoStorage,
  gitPullRequestStorage,
  knowledgeProposalStorage,
  gitCommitStatusStorage: {
    listBySha: async (repoId: string, sha: string) => [{
      id: 'st1', userId: 'x', repoId, sha, context: 'ci/checks', state: 'success',
      description: 'Passed', startedAt: new Date(Date.now() - 600_000).toISOString(), completedAt: new Date().toISOString(),
    }],
    listByShas: async () => [],
    listRecentByRepo: async () => [],
  },
  // The product's own: a member stands in the workplace's one namespace
  // (note #843), where its repositories and proposals live.
  orgGit: new OrgGitService({ orgStorage }),
  agentLifecycle: {},
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
  page.on('response', (response) => { if (response.status() >= 500) consoleErrors.push(`${response.status()} ${response.url()}`); });

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'forward-owner@example.com');
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'ACC' });
  const [owner] = await userStorage.getAllUsers();
  if (!owner) throw new Error('the browser setup created no owner');
  const at = new Date(Date.now() - 2 * 60_000).toISOString();
  await userStorage.updateProfile(owner.userId, {
    telegram: {
      ...(owner.telegram ?? {}),
      agents: {
        oscar: {
          id: 'oscar', name: 'Oscar', cli: 'claude', model: 'opus', effort: 'high',
          orgId: org.orgId, serverId: 'fly_ia-oscar.machine', connectedAt: at, createdAt: at, lastActivityAt: at,
        },
      },
    },
  });
  const workspaceAgent = await userStorage.reserveWorkspaceAssistant(owner.userId, org.orgId);
  if (!workspaceAgent) throw new Error('the Workspace Agent was not reserved');
  await userStorage.updateAgentFields(owner.userId, workspaceAgent.id, {
    cli: 'claude', model: 'opus', effort: 'high', serverId: 'fly_ia-workspace.machine', connectedAt: at,
  });

  const repo = await gitRepoStorage.create({
    userId: org.orgId, name: 'infinite-agents', createdByAgentId: 'oscar', defaultBranch: 'main', sizeBytes: 4096,
  } as never);
  const pr = await gitPullRequestStorage.create({
    repoId: repo.id, userId: org.orgId,
    createdByUserId: owner.userId, createdByAgentId: 'oscar',
    sourceBranch: 'note-718-skeleton-pickers', targetBranch: 'main', headSha: 'b'.repeat(40),
    diffStat: { files: 12, insertions: 758, deletions: 151 },
    title: 'Home’s wait is the Chief of Staff’s chat; pickers show choices at once',
    commitSubjects: ['Skeleton pickers'], status: 'open',
  } as never);
  const kp = await knowledgeProposalStorage.create({
    userId: org.orgId, createdByUserId: owner.userId, createdByAgentId: 'oscar',
    title: 'Models and effort: the pickers show their choices at once',
    changes: [{ page: 'models-and-effort', action: 'edit', title: 'Models and effort', html: '<p>x</p>' }],
    status: 'open',
  } as never);

  const messages = [
    { id: 'o1', role: 'owner' as const, text: 'Where is Oscar with the loading screen?', at },
    {
      id: 'f1', role: 'action' as const, at,
      text: `Forwarded PR #${pr.number} in infinite-agents — ${pr.title}; knowledge proposal #${kp.number} — ${kp.title}`,
      proposals: [{ kind: 'pr' as const, id: pr.id }, { kind: 'knowledge' as const, id: kp.id }],
    },
    { id: 'a1', role: 'assistant' as const, at, text: 'Oscar has finished the loading-screen work, and all its checks pass. The matching update to the models-and-effort page goes with it.' },
  ];
  await orgStorage.touchMember(org.orgId, owner.userId, {
    workspaceAgentSettings: { cli: 'claude', model: 'opus', effort: 'high' },
    workspaceRecapChat: { messages, receipts: [], pending: [] },
  } as never);
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('#screenHome #recapChatLog .chatmsg.forwarded', { timeout: 15_000 });

  const cards = await page.$$eval('#recapChatLog .chatmsg.forwarded', (nodes) => nodes.map((node) => ({
    label: node.querySelector('.chatnoticelabel')?.textContent?.trim(),
    status: node.querySelector('.chatnoticestatus')?.textContent?.trim(),
    title: node.querySelector('.crow .name')?.textContent?.trim(),
    face: Boolean(node.querySelector('.crow img, .crow .avatar, .crow [class*="face"]')),
    pip: Boolean(node.querySelector('.crow .pip, .crow [class*="pip"]')),
    door: node.querySelector('.forwardeddoor')?.textContent?.trim(),
  })));
  check('two cards, a change and a page, each labelled by its kind alone', cards.length === 2
    && cards[0]?.label === 'Change proposal' && cards[1]?.label === 'Knowledge proposal', JSON.stringify(cards));
  check('each says it awaits the reader’s approval, behind a Review and decide door', cards.every((card) => card.status === 'Awaiting approval' && card.door === 'Review and decide'), JSON.stringify(cards));
  check('the change card is the queue’s row: title, face and check pip', cards[0]?.title === pr.title && cards[0]?.face === true && cards[0]?.pip === true, JSON.stringify(cards[0]));
  const log = await page.$eval('#recapChatLog', (node) => node.textContent ?? '');
  check('the stored words are not drawn twice under the cards', !log.includes('Forwarded PR #'), log.slice(0, 200));
  check('nothing overflows the phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(OUT, 'forwarded-awaiting-phone.png') as `${string}.png` });

  // Merged an hour later: the next read says so, though the row never changed.
  await gitPullRequestStorage.update(pr.id, { status: 'merged', decidedAt: new Date().toISOString() } as never);
  await page.waitForFunction(() => document.querySelector('#recapChatLog .chatmsg.forwarded .chatnoticestatus')?.textContent?.trim() === 'Merged', { timeout: 12_000 });
  const after = await page.$$eval('#recapChatLog .chatmsg.forwarded', (nodes) => nodes.map((node) => node.querySelector('.chatnoticestatus')?.textContent?.trim()));
  const mergedDoor = await page.$eval('#recapChatLog .chatmsg.forwarded .forwardeddoor', (node) => node.textContent?.trim());
  check('…and its door now reads the outcome rather than asking for a decision', mergedDoor === 'See what changed', String(mergedDoor));
  check('a merged proposal’s card says Merged, and the page beside it still waits', after[0] === 'Merged' && after[1] === 'Awaiting approval', JSON.stringify(after));
  await page.screenshot({ path: path.join(OUT, 'forwarded-merged-phone.png') as `${string}.png` });

  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.screenshot({ path: path.join(OUT, 'forwarded-desk.png') as `${string}.png` });

  // Everything up to here is the conversation's. The proposal screens the
  // doors open need a git host this fixture does not run, so their reads are
  // not this feature's to answer for.
  check('the browser stayed clean', consoleErrors.length === 0, consoleErrors.join(' | '));

  // The card is the door to the decision.
  await page.click('#recapChatLog .chatmsg.forwarded[data-forwarded^="knowledge:"] .crow');
  await page.waitForFunction(() => location.pathname.includes('/knowledge'), { timeout: 10_000 });
  check('the page card opens the knowledge proposal', true, await page.evaluate(() => location.pathname));
  await page.goBack();
  await page.waitForSelector('#recapChatLog .chatmsg.forwarded[data-forwarded^="pr:"] .crow', { timeout: 10_000 });
  await page.click('#recapChatLog .chatmsg.forwarded[data-forwarded^="pr:"] .forwardeddoor');
  await page.waitForSelector('#screenPr', { timeout: 10_000 });
  check('the change card opens the proposal’s own screen', true);
  if (failures.length) throw new Error(failures.join('; '));
} finally {
  await browser.close();
  server.close();
}
