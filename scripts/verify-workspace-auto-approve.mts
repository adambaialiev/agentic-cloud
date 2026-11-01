/**
 * Note #944, in real Chrome: auto-merge, each person's own.
 *
 * The reader turns their OWN switch on (asked once more) in the Workplace
 * window, and the Chief of Staff's header says "Auto-merge on" in yellow;
 * their agent's `agentbuilt pr ready` — the REAL CLI route,
 * with the agent's own token — then merges a green proposal at once through
 * the real `AgentService.autoApprovePullRequest`, and every surface says it
 * was automatic: the proposal's screen, the Chief of Staff's card and the
 * outcome row in the agent's own chat. A proposal whose merge conflicts falls
 * back to the ordinary ask, with the reason on its screen. Turned off, the
 * header line goes and `pr ready` asks as it always has.
 *
 * Only the git host is a stand-in (its merge answers merged, then conflict).
 *
 *   npm --prefix backend run build:workspace-ui
 *   OUT_DIR=/tmp/shots backend/node_modules/.bin/tsx scripts/verify-workspace-auto-approve.mts
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';
import { agentCliRoutes } from '../backend/src/routes/agent-cli.js';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { AgentService } from '../backend/src/services/agent-service.js';
import { AgentEventEmitter } from '../backend/src/agent/agent-event-emitter.js';
import { InMemoryAgentChatStorage } from '../backend/src/services/agent-chat-storage.js';
import { InMemorySessionStorage } from '../backend/src/services/session-storage.js';
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
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'auto-approve-proof');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().at(-1);
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4199);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const userStorage = new InMemoryUserStorage();
const orgStorage = new InMemoryOrgStorage();
harnessEstablishedWorkplace(orgStorage);
const orgGit = new OrgGitService({ orgStorage });
const gitRepoStorage = new InMemoryGitRepoStorage();
const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
const knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
const agentChatStorage = new InMemoryAgentChatStorage();
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(),
  mailbox.config,
  mailbox.mailboxes,
);

/** Each proposal's branch tip, by branch — what compare answers. */
const heads: Record<string, string> = {};
/** What the host's merge answers next: merged first, then a conflict. */
const mergeAnswers: Array<Record<string, unknown>> = [];
const merges: Array<{ head: string; message: string }> = [];
const gitHostClient = {
  cloneUrl: (userId: string, name: string) => `https://git.harness.test/${userId}/${name}.git`,
  tree: async () => ({ entries: [] }),
  file: async () => null,
  contributors: async () => [],
  compare: async (_userId: string, _name: string, _base: string, head: string) => ({
    headSha: heads[head] ?? 'f'.repeat(40), baseSha: 'a'.repeat(40), baseExists: true,
    diffStat: { files: 1, insertions: 1, deletions: 0 },
    commits: [{ sha: heads[head] ?? 'f'.repeat(40), subject: 'A one-line change' }],
    patch: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # scratch\n+A line added by Ada.\n',
    patchTruncated: false,
  }),
  merge: async (_userId: string, _name: string, args: { head: string; message: string }) => {
    merges.push({ head: args.head, message: args.message });
    return mergeAnswers.shift() ?? { status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40) };
  },
};
const statuses = {
  listBySha: async (repoId: string, sha: string) => [{
    id: `st-${sha.slice(0, 6)}`, userId: 'x', repoId, sha, context: 'ci/checks', state: 'success',
    description: 'Passed', startedAt: new Date(Date.now() - 600_000).toISOString(), completedAt: new Date().toISOString(),
  }],
  listByShas: async () => [],
  listRecentByRepo: async () => [],
};
const backgroundRunner = {
  isRunning: () => false,
  startAgent: () => ({ status: 'started' }),
  queueMessage: () => ({ status: 'queued', queuePosition: 1 }),
  subscribe: () => undefined,
};
const service = new AgentService({
  sessionStorage: new InMemorySessionStorage(),
  secretStorage: {} as never,
  userStorage,
  sessionManager: { getSandboxClient: () => ({}) } as never,
  eventEmitter: new AgentEventEmitter(),
  backgroundRunner: backgroundRunner as never,
  reminderScheduler: {} as never,
  userSandboxManager: { ensureDefaultSandboxForUser: () => undefined } as never,
  managedServerService: { buildRuntimeContext: () => undefined } as never,
  gitPullRequestStorage,
  gitRepoStorage,
  gitHostClient: gitHostClient as never,
  gitCommitStatusStorage: statuses as never,
  orgGit,
  aiModel: 'openai/gpt-5.4-mini',
  agentChatStorage,
  notifyWorkspace: async () => undefined,
} as never);

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
  gitCommitStatusStorage: statuses,
  gitHostClient,
  requestPullRequestApproval: (args: Parameters<AgentService['requestPullRequestApproval']>[0]) => service.requestPullRequestApproval(args),
  autoApprovePullRequest: (args: Parameters<AgentService['autoApprovePullRequest']>[0]) => service.autoApprovePullRequest(args),
  orgGit,
  agentLifecycle: {
    agentChatMessages: (userId: string, agentId: string, after: number) => agentChatStorage.getAfter(userId, agentId, after),
    isAgentWorking: () => false,
  },
} as unknown as RouteDeps;
const app = express();
app.use(express.json());
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
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, name) as `${string}.png` });
const text = (page: Page, selector: string) => page.$eval(selector, (node) => node.textContent?.trim() ?? '').catch(() => '');

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
  page.on('response', (response) => {
    // The Workplace window's Chief of Staff cards ask its machine for its
    // software versions; this harness runs no machines, and the card says so.
    if (response.status() === 503 && /\/api\/agents\/[^/]+\/version/.test(response.url())) return;
    if (response.status() >= 500) consoleErrors.push(`${response.status()} ${response.url()}`);
  });

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'adam@example.com', { firstName: 'Adam', lastName: 'B' });
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Scratch' });
  const [owner] = await userStorage.getAllUsers();
  if (!owner) throw new Error('the browser setup created no owner');
  const at = new Date(Date.now() - 2 * 60_000).toISOString();
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
    workspaceRecapChat: { messages: [], receipts: [], pending: [] },
  } as never);

  // The throwaway repository, and Ada's quiet proposals on it.
  const repo = await gitRepoStorage.create({
    userId: org.orgId, name: 'auto-approve-scratch', createdByAgentId: 'ada', defaultBranch: 'main', sizeBytes: 1024, protectDefaultBranch: true,
  } as never);
  const propose = async (branch: string, title: string, head: string) => {
    heads[branch] = head;
    return gitPullRequestStorage.create({
      repoId: repo.id, userId: org.orgId, createdByUserId: owner.userId, createdByAgentId: 'ada',
      sourceBranch: branch, targetBranch: 'main', headSha: head,
      diffStat: { files: 1, insertions: 1, deletions: 0 },
      title, commitSubjects: ['A one-line change'], status: 'open', draft: true,
    } as never);
  };
  const ready = async (number: number) => {
    const response = await fetch(`${ORIGIN}/api/agent-cli/repos/${encodeURIComponent(repo.name)}/prs/${number}/ready`, {
      method: 'POST', headers: { authorization: `Bearer ${ada.token}`, 'content-type': 'application/json' }, body: '{}',
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> & { message?: string } };
  };

  /** Home, with the Workplace window open and its auto-merge switch in view. */
  const openWindow = async () => {
    await page.goto(`${ORIGIN}/`);
    await page.waitForSelector('#homeWorkplaceDoor', { timeout: 15_000 });
    await page.click('#homeWorkplaceDoor');
    await page.waitForSelector('#homeAutoMergeSwitch', { timeout: 15_000 });
    // The sections above it arrive on their own reads; let them settle first.
    await pause(1_200);
    await page.$eval('#homeAutoMerge', (node) => node.scrollIntoView({ block: 'center' }));
    await pause(400);
  };
  const closeWindow = async () => {
    await page.click('#homeSheetClose');
    await page.waitForFunction(() => !document.getElementById('homeSheet'), { timeout: 5_000 });
    await pause(400);
  };

  // ── 1. The switch, the reader's own, off by default, in its own words ───
  await openWindow();
  check('the switch is off by default', await page.$eval('#homeAutoMergeSwitch', (node) => node.getAttribute('aria-checked')) === 'false');
  check('it says what it does', (await text(page, '#homeAutoMergeSwitch')).includes('Every code proposal your agents make ready is merged without asking you. Checks must still pass.'));
  await shot(page, 'n944-1-setting-off.png');
  await closeWindow();
  check('off, the Chief of Staff header says nothing about it', !(await page.$('#recapAutoMerge')));

  // ── 2. Turning it on is asked once more ─────────────────────────────────
  await openWindow();
  await page.click('#homeAutoMergeSwitch');
  await page.waitForFunction(() => document.body.textContent?.includes('Turn on auto-merge?'), { timeout: 5_000 });
  await pause(300);
  await shot(page, 'n944-2-turn-on-asked.png');
  const turnOn = await page.$$('button');
  for (const button of turnOn) {
    if ((await button.evaluate((node) => node.textContent?.trim())) === 'Turn on') { await button.click(); break; }
  }
  await page.waitForFunction(() => document.getElementById('homeAutoMergeSwitch')?.getAttribute('aria-checked') === 'true', { timeout: 5_000 });
  await pause(500);
  check('on, it says since when', (await text(page, '#homeAutoMergeState')).startsWith('On · turned on'), await text(page, '#homeAutoMergeState'));
  const stored = (await orgStorage.getMembership(org.orgId, owner.userId))!.autoApprove;
  check('the flip is on the reader\'s own record: who and when', Boolean(stored?.on && stored.changedByUserId === owner.userId && stored.history?.length === 1), JSON.stringify(stored));
  await page.$eval('#homeAutoMerge', (node) => node.scrollIntoView({ block: 'center' }));
  await pause(300);
  await shot(page, 'n944-3-setting-on.png');
  await closeWindow();
  // The header as the reader sees it once the toast is read and dismissed.
  await page.click('#banner .toastdismiss').catch(() => undefined);
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause(600);
  const header = await page.$eval('#recapAutoMerge', (node) => ({ text: node.textContent?.trim(), color: getComputedStyle(node).color }))
    .catch(() => null);
  check('the Chief of Staff header says Auto-merge on, in yellow', header?.text === 'Auto-merge on' && header.color === 'rgb(176, 120, 0)', JSON.stringify(header));
  await shot(page, 'n944-3b-header-auto-merge-on.png');

  // ── 3. Ada's `pr ready` on a green proposal: merged at once ─────────────
  const green = await propose('note-944-hello', 'Say hello in the README', '1'.repeat(40));
  const first = await ready(green.number);
  console.log(`      pr ready answered: ${first.body.message}`);
  check('`pr ready` merged it automatically and told the agent so', first.status === 200 && first.body.autoApproved === true
    && Boolean(first.body.message?.includes('approved AUTOMATICALLY')), JSON.stringify(first.body));
  const merged = (await gitPullRequestStorage.get(green.id))!;
  check('the proposal is merged, decided by no person', merged.status === 'merged' && !merged.decidedBy && merged.autoApproved?.modeOnByUserId === owner.userId, JSON.stringify({ status: merged.status, decidedBy: merged.decidedBy, autoApproved: merged.autoApproved }));
  check('the merge commit says it was automatic', merges[0]?.message.includes('approved automatically (auto-merge, turned on by Adam') ?? false, merges[0]?.message);

  // The Chief of Staff's card, on Home.
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('#recapChatLog .chatmsg.forwarded', { timeout: 20_000 });
  await pause(700);
  const card = await page.$eval('#recapChatLog .chatmsg.forwarded', (node) => ({
    status: node.querySelector('.chatnoticestatus')?.textContent?.trim(),
    door: node.querySelector('.forwardeddoor')?.textContent?.trim(),
  }));
  check('the Chief of Staff card says Merged automatically', card.status === 'Merged automatically' && card.door === 'See what changed', JSON.stringify(card));
  await shot(page, 'n944-4-chief-of-staff-card.png');

  // The proposal's own screen: the mode stands where a decider's name would.
  await page.click('#recapChatLog .chatmsg.forwarded .forwardeddoor');
  await page.waitForSelector('#prAutoApproved', { timeout: 10_000 });
  await pause(600);
  check('the proposal screen names the mode, not a person', (await text(page, '#prAutoApproved')).startsWith('Approved automatically (auto-merge on, turned on by Adam'), await text(page, '#prAutoApproved'));
  check('…and its pill says Merged automatically', (await text(page, '#prPills .pill')).startsWith('Merged automatically'), await text(page, '#prPills .pill'));
  await shot(page, 'n944-5-proposal-approved-automatically.png');
  await page.$eval('#prAutoApproved', (node) => node.scrollIntoView({ block: 'center' }));
  await pause(300);
  await shot(page, 'n944-5b-proposal-approved-automatically-line.png');

  // Ada's own chat: the outcome she was woken with, drawn as its card.
  const adaRows = await agentChatStorage.getAfter(owner.userId, 'ada', 0);
  const outcome = adaRows.at(-1)?.text ?? '';
  console.log(`      Ada was told: ${outcome.split('\n')[0]}`);
  check('Ada\'s outcome message says it was approved automatically, never by her user', outcome.includes('was APPROVED AUTOMATICALLY') && outcome.includes('never that your user approved it'));
  check('no "awaits your decision" ask was written for it', !adaRows.some((row) => row.text.includes('awaits your decision')));
  await page.goto(`${ORIGIN}/chat/ada`);
  await page.waitForFunction(() => document.body.textContent?.includes('Merged automatically'), { timeout: 15_000 });
  await pause(600);
  await shot(page, 'n944-6-agent-outcome.png');

  // ── 4. A merge that conflicts: back to the ordinary ask, with the reason ─
  mergeAnswers.push({ status: 'conflict' });
  const clash = await propose('note-944-clash', 'Rename the README heading', '2'.repeat(40));
  const second = await ready(clash.number);
  console.log(`      pr ready answered: ${second.body.message}`);
  check('`pr ready` fell back to asking, and said why', second.status === 200 && second.body.askedUser === true
    && Boolean(second.body.message?.includes('NOT merged automatically: note-944-clash conflicts with main')), JSON.stringify(second.body));
  const waiting = (await gitPullRequestStorage.get(clash.id))!;
  check('it stays open, awaiting its owner — not a dead conflict', waiting.status === 'open' && !waiting.draft && waiting.autoApproveFallback?.reason === 'note-944-clash conflicts with main', JSON.stringify(waiting.autoApproveFallback));
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => document.querySelectorAll('#recapChatLog .chatmsg.forwarded').length === 2, { timeout: 20_000 });
  const clashDoor = await page.$$('#recapChatLog .chatmsg.forwarded .forwardeddoor');
  await clashDoor.at(-1)!.click();
  await page.waitForSelector('#prAutoFallback', { timeout: 10_000 });
  await pause(600);
  check('its screen says auto-merge did not merge it, and why', (await text(page, '#prAutoFallback')) === 'Auto-merge is on, but this was not merged automatically: note-944-clash conflicts with main. It waits for your decision.', await text(page, '#prAutoFallback'));
  check('…and the decision bar is there for the reader', Boolean(await page.$('#prDecide')));
  await page.$eval('#prAutoFallback', (node) => node.scrollIntoView({ block: 'center' }));
  await pause(300);
  await shot(page, 'n944-7-fallback-waits-for-you.png');

  // ── 5. Off again: the record keeps both flips, and pr ready asks as before
  await openWindow();
  await page.click('#homeAutoMergeSwitch');
  await page.waitForFunction(() => document.getElementById('homeAutoMergeSwitch')?.getAttribute('aria-checked') === 'false', { timeout: 5_000 });
  await pause(500);
  check('off, it says since when, and that proposals wait for the reader', /^Off · turned off .* · every proposal waits for you$/.test(await text(page, '#homeAutoMergeState')), await text(page, '#homeAutoMergeState'));
  check('both flips are on the record', (await orgStorage.getMembership(org.orgId, owner.userId))!.autoApprove?.history?.length === 2);
  await page.$eval('#homeAutoMerge', (node) => node.scrollIntoView({ block: 'center' }));
  await pause(300);
  await shot(page, 'n944-8-setting-off-again.png');
  await closeWindow();
  check('off again, the header line is gone', !(await page.$('#recapAutoMerge')));
  const plain = await propose('note-944-plain', 'Fix a typo in the README', '3'.repeat(40));
  const mergesBefore = merges.length;
  const third = await ready(plain.number);
  check('off, `pr ready` asks exactly as it always has', third.status === 200 && third.body.askedUser === true && !third.body.autoApproved
    && !String(third.body.message).includes('uto-merge') && merges.length === mergesBefore, JSON.stringify(third.body));

  check('the browser stayed clean', consoleErrors.length === 0, consoleErrors.join(' | '));
  if (failures.length) throw new Error(failures.join('; '));
  console.log(`\nAll checks passed. Pictures in ${OUT}`);
} finally {
  await browser.close();
  server.close();
}
