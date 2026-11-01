/**
 * Note #752, in real Chrome: an agent's `agentbuilt pr ready` puts the
 * proposal's card in its owner's Chief of Staff chat AT ONCE — the same card
 * `agentbuilt forward` draws (note #724), landed by the platform with no
 * model turn, whoever asked for the work — and a second `pr ready` of the
 * same proposal adds no second card.
 *
 * Adam, 2026-10-14: he asked Ada for note #750 himself, her PR #1378 became
 * ready, and nothing reached the chat he reads proposals in. This drives the
 * REAL CLI route (`POST /api/agent-cli/repos/:name/prs/:number/ready`) with a
 * agent's token against the conversation the Workspace routes own, then
 * watches the card arrive on a phone.
 *
 *   npm --prefix backend run build:workspace-ui
 *   OUT_DIR=/tmp/shots backend/node_modules/.bin/tsx scripts/verify-workspace-proposal-ready-card.mts
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { agentCliRoutes } from '../backend/src/routes/agent-cli.js';
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
import { mintAgentbuiltToken } from '../backend/src/services/agentbuilt-token.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'proposal-ready-card-proof');
mkdirSync(OUT, { recursive: true });

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
const HEAD = 'b'.repeat(40);
/** The agent-chat card `pr ready` has always sent: counted, not drawn here. */
const chatCards: string[] = [];
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
  // The git host the ready route re-pins against: the branch as it stands,
  // one commit ahead of main. The Workspace's own repository reads want an
  // address and an empty tree from it, nothing more.
  gitHostClient: {
    cloneUrl: (userId: string, name: string) => `https://git.harness.test/${userId}/${name}.git`,
    tree: async () => ({ entries: [] }),
    file: async () => null,
    contributors: async () => [],
    compare: async () => ({
      headSha: HEAD, baseSha: 'a'.repeat(40), baseExists: true,
      diffStat: { files: 12, insertions: 758, deletions: 151 },
      commits: [{ sha: HEAD, subject: 'Room page: the agents are the room' }], patch: '', patchTruncated: false,
    }),
  },
  requestPullRequestApproval: async (args: { pullRequestId: string }) => { chatCards.push(args.pullRequestId); return true; },
  // The product's own: a member stands in the workplace's one namespace
  // (note #843), where its repositories and proposals live.
  orgGit: new OrgGitService({ orgStorage }),
  agentLifecycle: {},
} as unknown as RouteDeps;
const app = express();
app.use(express.json());
// The CLI router only ever sees the shared deps object; the Workspace router
// puts the conversation on it (RouteDeps.workspaceAgent) as production does.
app.use('/api/agent-cli', agentCliRoutes(deps));
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

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'ready-owner@example.com', { firstName: 'Adam', lastName: 'Owner' });
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'ACC' });
  const [owner] = await userStorage.getAllUsers();
  if (!owner) throw new Error('the browser setup created no owner');
  const at = new Date(Date.now() - 2 * 60_000).toISOString();
  // Ada: an agent of the owner's, with the CLI credential her machine
  // would hold — what `agentbuilt pr ready` presents.
  const ada = mintAgentbuiltToken(owner.userId, 'ada');
  await userStorage.updateProfile(owner.userId, {
    telegram: {
      ...(owner.telegram ?? {}),
      agents: {
        ada: {
          id: 'ada', name: 'Ada', cli: 'claude', model: 'opus', effort: 'high',
          orgId: org.orgId, serverId: 'fly_ia-ada.machine', connectedAt: at, createdAt: at, lastActivityAt: at,
          agentbuiltTokenHash: ada.tokenHash,
        },
      },
    },
  });
  const workspaceAgent = await userStorage.reserveWorkspaceAssistant(owner.userId, org.orgId);
  if (!workspaceAgent) throw new Error('the Workspace Agent was not reserved');
  await userStorage.updateAgentFields(owner.userId, workspaceAgent.id, {
    cli: 'claude', model: 'opus', effort: 'high', serverId: 'fly_ia-workspace.machine', connectedAt: at,
  });
  await orgStorage.touchMember(org.orgId, owner.userId, {
    workspaceAgentSettings: { cli: 'claude', model: 'opus', effort: 'high' },
    // What the chat held before: the person's question and the reply —
    // nothing about Ada's proposal, which Adam asked her for directly.
    workspaceRecapChat: {
      messages: [
        { id: 'o1', role: 'owner', text: 'How is the Room page going?', at },
        { id: 'a1', role: 'assistant', text: 'Ada is on it — her checks are running now, and she will propose when they pass.', at },
      ],
      receipts: [], pending: [],
    },
  } as never);

  const repo = await gitRepoStorage.create({
    userId: org.orgId, name: 'infinite-agents', createdByAgentId: 'ada', defaultBranch: 'main', sizeBytes: 4096, protectDefaultBranch: true,
  } as never);
  // Quiet (note #293): recorded, not yet with the person. `pr ready` is the step under test.
  const pr = await gitPullRequestStorage.create({
    repoId: repo.id, userId: org.orgId,
    createdByUserId: owner.userId, createdByAgentId: 'ada',
    sourceBranch: 'note-750-room-page', targetBranch: 'main', headSha: HEAD,
    diffStat: { files: 12, insertions: 758, deletions: 151 },
    title: 'Room page: the agents are the room, and the notes stand beside them',
    commitSubjects: ['Room page: the agents are the room'], status: 'open', draft: true,
  } as never);

  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('#screenHome #recapChatLog', { timeout: 15_000 });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const before = await page.$$eval('#recapChatLog .chatmsg.forwarded', (nodes) => nodes.length);
  check('before `pr ready`, the Chief of Staff chat shows no card for the quiet proposal', before === 0, String(before));

  // Ada's machine: `agentbuilt pr ready`, through the real CLI route.
  const ready = async () => {
    const response = await fetch(`${ORIGIN}/api/agent-cli/repos/${encodeURIComponent(repo.name)}/prs/${pr.number}/ready`, {
      method: 'POST', headers: { authorization: `Bearer ${ada.token}`, 'content-type': 'application/json' }, body: '{}',
    });
    return { status: response.status, body: await response.json() as { message?: string; error?: string } };
  };
  const first = await ready();
  check('`pr ready` is accepted and tells the agent the card is in the Chief of Staff chat too', first.status === 200 && Boolean(first.body.message?.includes('its card is in their Chief of Staff chat too')), JSON.stringify(first.body));
  check('the agent chat card went out as it always has', chatCards.length === 1, String(chatCards.length));

  // The open phone picks it up on its next read: nobody wrote, nobody tapped.
  await page.waitForSelector('#recapChatLog .chatmsg.forwarded', { timeout: 20_000 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  const cards = await page.$$eval('#recapChatLog .chatmsg.forwarded', (nodes) => nodes.map((node) => ({
    label: node.querySelector('.chatnoticelabel')?.textContent?.trim(),
    status: node.querySelector('.chatnoticestatus')?.textContent?.trim(),
    title: node.querySelector('.crow .name')?.textContent?.trim(),
    face: Boolean(node.querySelector('.crow img, .crow .avatar, .crow [class*="face"]')),
    pip: Boolean(node.querySelector('.crow .pip, .crow [class*="pip"]')),
    door: node.querySelector('.forwardeddoor')?.textContent?.trim(),
  })));
  // The label named the proposal's room after its kind ("Change proposal ·
  // Platform") until rooms left the product (note #843).
  check('one card arrives in the Chief of Staff chat, naming its kind and no room', cards.length === 1 && cards[0]?.label === 'Change proposal', JSON.stringify(cards));
  check('it awaits the reader’s approval, behind a Review and decide door', cards[0]?.status === 'Awaiting approval' && cards[0]?.door === 'Review and decide', JSON.stringify(cards[0]));
  check('it is the queue’s own row: title, face and check pip', cards[0]?.title === pr.title && cards[0]?.face === true && cards[0]?.pip === true, JSON.stringify(cards[0]));
  const log = await page.$eval('#recapChatLog', (node) => node.textContent ?? '');
  check('the row’s stored words are for the agent, not drawn under the card', !log.includes('is ready for the person'), log.slice(-200));
  const order = await page.$$eval('#recapChatLog .chatmsg', (nodes) => nodes.map((node) => node.className.includes('forwarded') ? 'card' : 'row'));
  check('the card lands after the conversation so far, where a new message would', order.at(-1) === 'card', JSON.stringify(order));
  check('nothing overflows the phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(OUT, 'n752-ready-card-phone.png') as `${string}.png` });

  // What the Chief of Staff reads on its next turn: the pointer row, in words.
  const stored = (await orgStorage.getMembership(org.orgId, owner.userId))?.workspaceRecapChat?.messages ?? [];
  const rows = stored.filter((row) => row.proposals?.length);
  check('the conversation holds one pointer row, worded for the agent’s next turn', rows.length === 1
    && rows[0]?.text === `Ada's PR #${pr.number} in infinite-agents — ${pr.title} — is ready for the person's decision; its card is in this conversation.`
    && JSON.stringify(rows[0]?.proposals) === JSON.stringify([{ kind: 'pr', id: pr.id }]), JSON.stringify(rows.map((row) => row.text)));

  // Never twice: the CLI retrying after a timeout, or the agent running it again.
  const again = await ready();
  check('a second `pr ready` is answered as already with the person', again.status === 200 && Boolean(again.body.message?.includes('already with your user')), JSON.stringify(again.body));
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const afterRows = ((await orgStorage.getMembership(org.orgId, owner.userId))?.workspaceRecapChat?.messages ?? []).filter((row) => row.proposals?.length);
  const afterCards = await page.$$eval('#recapChatLog .chatmsg.forwarded', (nodes) => nodes.length);
  check('…and the chat still shows exactly one card', afterRows.length === 1 && afterCards === 1, `${afterRows.length} rows, ${afterCards} cards`);
  check('the agent chat was not asked twice either', chatCards.length === 1, String(chatCards.length));

  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.screenshot({ path: path.join(OUT, 'n752-ready-card-desk.png') as `${string}.png` });

  check('the browser stayed clean', consoleErrors.length === 0, consoleErrors.join(' | '));

  // The card is the door to the decision.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.click('#recapChatLog .chatmsg.forwarded .forwardeddoor');
  await page.waitForSelector('#screenPr', { timeout: 10_000 });
  check('the card opens the proposal’s own screen, where the decision is', true);
  if (failures.length) throw new Error(failures.join('; '));
} finally {
  await browser.close();
  server.close();
}
