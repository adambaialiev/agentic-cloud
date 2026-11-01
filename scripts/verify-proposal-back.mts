/**
 * Note #742, in a real browser at phone size: Back on a proposal page always
 * goes somewhere — where the reader came from when there is such a place,
 * Home when there is not — before and after the decision, on change and
 * knowledge proposals alike.
 *
 * The owner tapped Back on a proposal page on his iPhone and nothing
 * happened; Safari's own back arrow was grey, so the tab had nothing under
 * the page. Back trusted the router's own count of entries under a page
 * (`history.state.idx`) and stepped back into nothing. The cases marked
 * "note #742" stand on exactly that: the tab's first page, its state
 * counting entries the browser does not have. The rest are every other way
 * in — the Chief of Staff's forwarded cards, a tab of its own (a direct link,
 * a new tab), the diff and back — so the fix is held to all of them.
 *
 *   npm --prefix backend run build:workspace-ui
 *   OUT_DIR=/tmp/shots backend/node_modules/.bin/tsx scripts/verify-proposal-back.mts
 *
 * ENGINE=webkit runs the same in WebKit, Safari's engine, as an iPhone 13
 * (Playwright's build: `npm i playwright && npx playwright install --with-deps
 * webkit` in a scratch directory, PLAYWRIGHT_DIR pointing at it). LABEL names
 * the screenshots — run it on the old build with LABEL=before.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { GitHostClient } from '../backend/src/services/git-host-client.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { OrgGitService } from '../backend/src/services/org-git.js';
import { InMemoryGitRepoStorage } from '../backend/src/services/git-repo-storage.js';
import { InMemoryGitPullRequestStorage } from '../backend/src/services/git-pr-storage.js';
import { InMemoryKnowledgeProposalStorage } from '../backend/src/services/knowledge-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { workspaceCookieNames } from '../backend/src/services/workspace-web-session.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'proposal-back-proof');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().at(-1);
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PATCH = [
  'diff --git a/src/checkout.ts b/src/checkout.ts',
  '--- a/src/checkout.ts',
  '+++ b/src/checkout.ts',
  '@@ -1,3 +1,3 @@',
  ' export function checkout() {',
  '-  return legacyCheckout();',
  '+  return reactCheckout();',
  ' }',
].join('\n');
const fetchImpl = (async (url: string | URL) => {
  const route = String(url).replace('http://host', '');
  const answer = (payload: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(payload) });
  if (route === '/internal/repos/compare') {
    return answer({
      patch: PATCH, patchTruncated: false,
      commits: [{ sha: 'a'.repeat(40), subject: 'Move the checkout', at: new Date().toISOString() }],
      diffStat: { files: 1, insertions: 1, deletions: 1 }, headSha: 'b'.repeat(40),
    });
  }
  if (route === '/internal/knowledge/list') return answer({ pages: [], index: null });
  return answer({ error: 'no such control route' }, 404);
}) as unknown as typeof fetch;

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
  new InMemoryWorkspaceWebAuthStorage(), userStorage, new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(), mailbox.config, mailbox.mailboxes,
);
const deps = {
  userStorage, orgStorage, workspaceWebAuth, mailboxes: mailbox.mailboxes, workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  gitRepoStorage, gitPullRequestStorage, knowledgeProposalStorage,
  gitHostClient: new GitHostClient({ baseUrl: 'http://host', controlUrl: 'http://host', secret: 's', fetchImpl }),
  gitCommitStatusStorage: {
    listBySha: async (repoId: string, sha: string) => [{
      id: 'st1', userId: 'x', repoId, sha, context: 'ci/checks', state: 'success',
      description: 'Passed', startedAt: new Date(Date.now() - 600_000).toISOString(), completedAt: new Date().toISOString(),
    }],
    listByShas: async () => [],
    listRecentByRepo: async () => [],
  },
  decidePullRequest: async (args: unknown) => {
    const { pullRequestId, decision } = args as { pullRequestId: string; decision: string };
    await gitPullRequestStorage.update(pullRequestId, {
      status: decision === 'approve' ? 'merged' : 'rejected', decidedAt: new Date().toISOString(), mergeCommitSha: 'c'.repeat(40),
    } as never);
    return { status: decision === 'approve' ? 'merged' : 'rejected', note: null };
  },
  decideKnowledgeProposal: async (args: unknown) => {
    const { proposalId, decision } = args as { proposalId: string; decision: string };
    await knowledgeProposalStorage.update(proposalId, { status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: new Date().toISOString() } as never);
    return { status: decision === 'approve' ? 'approved' : 'rejected', note: null };
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

const ENGINE = process.env.ENGINE === 'webkit' ? 'webkit' : 'chrome';
const playwright = ENGINE === 'webkit'
  ? createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(process.env.HOME || '/home/agent', 'n742/pw'), 'package.json'))('playwright') as typeof import('playwright')
  : null;
const browser = playwright
  ? await playwright.webkit.launch()
  : await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
let webkitContext: import('playwright').BrowserContext | null = null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const LABEL = process.env.LABEL || 'after';
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
try {
  let account: { userId: string };
  if (playwright) {
    const created = await workspaceWebAuth.registerMailbox({ mailbox: 'back-owner', password: 'harness-password-47', firstName: 'Harness', lastName: 'Person', userAgent: 'workspace-harness' } as never);
    account = { userId: created.userId };
    webkitContext = await (browser as import('playwright').Browser).newContext({ ...playwright.devices['iPhone 13'] });
    const names = workspaceCookieNames(ORIGIN);
    await webkitContext.addCookies([
      { name: names.session, value: created.session.token, url: ORIGIN, httpOnly: true, sameSite: 'Lax' },
      { name: names.csrf, value: created.session.csrfToken, url: ORIGIN, sameSite: 'Strict' },
    ]);
  } else {
    const first = await (browser as import('puppeteer-core').Browser).newPage();
    account = await harnessSignedIn(first, workspaceWebAuth, ORIGIN, 'back-owner@example.com');
  }
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'ACC' });
  const [owner] = await userStorage.getAllUsers();
  if (!owner) throw new Error('no owner');
  const at = new Date(Date.now() - 2 * 60_000).toISOString();
  await userStorage.updateProfile(owner.userId, {
    telegram: { ...(owner.telegram ?? {}), agents: { oscar: {
      id: 'oscar', name: 'Oscar', cli: 'claude', model: 'opus', effort: 'high',
      orgId: org.orgId, serverId: 'fly_ia-oscar.machine', connectedAt: at, createdAt: at, lastActivityAt: at,
    } } },
  });
  const workspaceAgent = await userStorage.reserveWorkspaceAssistant(owner.userId, org.orgId);
  if (!workspaceAgent) throw new Error('no Workspace Agent');
  await userStorage.updateAgentFields(owner.userId, workspaceAgent.id, { cli: 'claude', model: 'opus', effort: 'high', serverId: 'fly_ia-workspace.machine', connectedAt: at });
  const repo = await gitRepoStorage.create({ userId: org.orgId, name: 'infinite-agents', createdByAgentId: 'oscar', defaultBranch: 'main', sizeBytes: 4096 } as never);

  const fresh = async () => {
    const pr = await gitPullRequestStorage.create({
      repoId: repo.id, userId: org.orgId, createdByUserId: owner.userId, createdByAgentId: 'oscar',
      sourceBranch: 'note-207-film', targetBranch: 'main', headSha: 'b'.repeat(40), diffStat: { files: 1, insertions: 1, deletions: 1 },
      title: 'Front-page film', commitSubjects: ['Film'], status: 'open', readyAt: at,
    } as never);
    const kp = await knowledgeProposalStorage.create({
      userId: org.orgId, createdByUserId: owner.userId, createdByAgentId: 'oscar', title: 'Models and effort',
      changes: [{ page: 'models-and-effort', action: 'create', title: 'Models and effort', html: '<!doctype html><title>Models</title><meta name="description" content="x"><h1>Models</h1><p>x</p>' }],
      status: 'open',
    } as never);
    await orgStorage.touchMember(org.orgId, owner.userId, {
      workspaceAgentSettings: { cli: 'claude', model: 'opus', effort: 'high' },
      workspaceRecapChat: { messages: [{ id: `f${pr.number}`, role: 'action', at, text: 'Forwarded', proposals: [{ kind: 'pr', id: pr.id }, { kind: 'knowledge', id: kp.id }] }], receipts: [], pending: [] },
    } as never);
    return { pr, kp };
  };

  const where = async (page: Page) => page.evaluate(() => ({
    path: location.pathname,
    entries: history.length,
    idx: (history.state as { idx?: number } | null)?.idx ?? null,
    title: document.querySelector('h1')?.textContent?.trim() ?? '',
  }));
  const shot = async (page: Page, name: string) => {
    await page.screenshot({ path: path.join(OUT, `${LABEL}-${ENGINE}-${name}.png`) as `${string}.png` });
  };
  /** Tap the header's Back and say where it took the reader. */
  const back = async (page: Page, label: string, expected: { path: string; spent?: boolean }, picture?: string) => {
    const before = await where(page);
    await page.click('#pageBack');
    const deadline = Date.now() + 2500;
    let after = await where(page);
    while (after.path !== expected.path && Date.now() < deadline) {
      await sleep(100);
      after = await where(page).catch(() => after);
    }
    // Long enough for a late fallback to show itself if one were coming.
    await sleep(900);
    after = await where(page);
    if (picture) await shot(page, picture);
    const spentOk = expected.spent === undefined
      || (expected.spent ? after.idx !== null && before.idx !== null && after.idx === before.idx - 1 : after.entries === before.entries);
    check(label, after.path === expected.path && spentOk,
      `${before.path} [idx ${before.idx}, ${before.entries} entries] → ${after.path} [idx ${after.idx}, ${after.entries} entries]`);
  };
  const decide = async (page: Page, which: 'approve' | 'reject') => {
    await page.waitForSelector('.decidebar .save.go', { timeout: 10_000 });
    await page.click(which === 'approve' ? '.decidebar .save.go' : '.decidebar button:not(.go)');
    const confirmed = await page.waitForSelector('#confirmCard .danger, #confirmCard .save, .confirmcard button.danger', { timeout: 1500 }).catch(() => null);
    if (confirmed) await confirmed.click();
    await page.waitForFunction(() => !document.querySelector('.decidebar .save.go'), { timeout: 10_000 });
    await sleep(600);
  };
  const newTab = async (): Promise<Page> => {
    if (webkitContext) return await webkitContext.newPage() as unknown as Page;
    const page = await (browser as import('puppeteer-core').Browser).newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
    return page;
  };
  /** Home — the Chief of Staff's conversation — and a forwarded card's door. */
  const viaCard = async (kind: 'pr' | 'knowledge', id: string): Promise<Page> => {
    const page = await newTab();
    await page.goto(`${ORIGIN}/`);
    const door = `#recapChatLog .chatmsg.forwarded[data-forwarded="${kind}:${id}"] .forwardeddoor`;
    await page.waitForSelector(door, { timeout: 15_000 });
    await page.click(door);
    await page.waitForSelector('#pageBack', { timeout: 10_000 });
    await page.waitForSelector('.decidebar .save.go', { timeout: 10_000 });
    return page;
  };
  /** A tab of its own whose FIRST page is this one (opened as a new tab is:
   *  nothing of the Workspace under it). `counted`: that first entry carries
   *  router state counting pages under it — what Back stood on in the
   *  owner's report. `oldSafari`: a browser with no Navigation API. */
  const tabAt = async (address: string, how: { counted?: boolean; oldSafari?: boolean } = {}): Promise<Page> => {
    const opener = await newTab();
    await opener.goto(`${ORIGIN}/`);
    const opened = webkitContext
      ? webkitContext.waitForEvent('page') as unknown as Promise<Page>
      : (browser as import('puppeteer-core').Browser).waitForTarget((target) => target.url().includes(address)).then((target) => target.page() as Promise<Page>);
    await opener.evaluate((to) => { window.open(to, '_blank', 'noopener'); }, `${ORIGIN}${address}`);
    const page = await opened;
    if (!webkitContext) await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
    await opener.close();
    await page.waitForSelector('#pageBack', { timeout: 15_000 });
    if (how.oldSafari) {
      const hide = () => { Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }); };
      if (webkitContext) await (page as unknown as import('playwright').Page).addInitScript(hide);
      else await page.evaluateOnNewDocument(hide);
    }
    if (how.counted || how.oldSafari) {
      if (how.counted) await page.evaluate(() => history.replaceState({ usr: null, key: 'counted', idx: 3 }, ''));
      await page.reload();
      await page.waitForSelector('#pageBack', { timeout: 15_000 });
    }
    await page.waitForSelector('.decidebar .save.go', { timeout: 10_000 });
    if (how.oldSafari) check('…that browser really has no Navigation API', await page.evaluate(() => (window as unknown as { navigation?: unknown }).navigation === undefined));
    return page;
  };

  console.log(`— ${ENGINE}, ${LABEL} build`);
  // The Chief of Staff's card: Back is where the reader came from, by
  // spending the entry, before and after deciding.
  {
    const { pr } = await fresh();
    const page = await viaCard('pr', pr.id);
    await shot(page, 'proposal-from-card');
    await back(page, 'card → proposal → Back: the Chief of Staff’s chat', { path: '/', spent: true });
    await page.close();
  }
  {
    const { pr } = await fresh();
    const page = await viaCard('pr', pr.id);
    await decide(page, 'approve');
    await back(page, 'card → proposal → approve → Back: the chat', { path: '/', spent: true });
    await page.close();
  }
  {
    const { pr } = await fresh();
    const page = await viaCard('pr', pr.id);
    await decide(page, 'reject');
    await back(page, 'card → proposal → reject → Back: the chat', { path: '/', spent: true });
    await page.close();
  }
  {
    const { kp } = await fresh();
    const page = await viaCard('knowledge', kp.id);
    await back(page, 'card → knowledge proposal → Back: the chat', { path: '/', spent: true });
    await page.close();
  }
  {
    const { kp } = await fresh();
    const page = await viaCard('knowledge', kp.id);
    await decide(page, 'approve');
    await back(page, 'card → knowledge proposal → approve → Back: the chat', { path: '/', spent: true });
    await page.close();
  }
  // A tab of its own (a direct link, a new tab): Home, in this page's place.
  {
    const { pr } = await fresh();
    const page = await tabAt(`/decisions/pr/${pr.id}`);
    await back(page, 'own tab → proposal → Back: Home, replacing it', { path: '/', spent: false });
    await page.close();
  }
  {
    const { pr } = await fresh();
    const page = await tabAt(`/decisions/pr/${pr.id}`);
    await decide(page, 'approve');
    await back(page, 'own tab → proposal → approve → Back: Home', { path: '/', spent: false });
    await page.close();
  }
  {
    const { pr } = await fresh();
    const page = await tabAt(`/decisions/pr/${pr.id}`);
    await page.click('#prSummary > :first-child');
    await page.waitForSelector('#screenPrDiff', { timeout: 10_000 });
    await back(page, 'own tab → diff → Back: the proposal', { path: `/decisions/pr/${pr.id}`, spent: true });
    await decide(page, 'approve');
    await back(page, '…then approve → Back: Home', { path: '/', spent: false });
    await page.close();
  }
  {
    const { pr } = await fresh();
    const page = await tabAt(`/decisions/pr/${pr.id}`);
    await page.click('#prSummary > :first-child');
    await page.waitForSelector('#screenPrDiff', { timeout: 10_000 });
    await page.goBack();
    await page.waitForSelector('#prSummary', { timeout: 10_000 });
    await decide(page, 'approve');
    await back(page, 'own tab → diff → the browser’s back → approve → Back: Home', { path: '/', spent: false });
    await page.close();
  }
  {
    const { kp } = await fresh();
    const page = await tabAt(`/decisions/knowledge/${kp.id}`);
    await decide(page, 'approve');
    await back(page, 'own tab → knowledge proposal → approve → Back: Home', { path: '/', spent: false });
    await page.close();
  }
  // Note #742: the first page of the tab, its router state counting pages
  // under it that the browser does not have.
  {
    const { pr } = await fresh();
    const page = await tabAt(`/decisions/pr/${pr.id}`, { counted: true });
    await shot(page, 'counted-before-back');
    await back(page, 'note #742: first page, counted entries → Back: Home', { path: '/' }, 'counted-after-back');
    await page.close();
  }
  {
    const { pr } = await fresh();
    const page = await tabAt(`/decisions/pr/${pr.id}`, { counted: true });
    await decide(page, 'approve');
    await shot(page, 'counted-approved');
    await back(page, 'note #742: first page, counted entries → approve → Back: Home', { path: '/' }, 'counted-approved-after-back');
    await page.close();
  }
  {
    const { kp } = await fresh();
    const page = await tabAt(`/decisions/knowledge/${kp.id}`, { counted: true });
    await back(page, 'note #742: knowledge proposal, counted entries → Back: Home', { path: '/' });
    await page.close();
  }
  // The same on a browser that cannot say what is under a page (Safari
  // before 26.2): only the landing check stands between Back and nothing.
  {
    const { pr } = await fresh();
    const page = await tabAt(`/decisions/pr/${pr.id}`, { counted: true, oldSafari: true });
    await back(page, 'note #742, no Navigation API: counted entries → Back: Home', { path: '/' });
    await page.close();
  }
  {
    const { pr } = await fresh();
    const page = await tabAt(`/decisions/pr/${pr.id}`, { counted: true, oldSafari: true });
    await decide(page, 'approve');
    await back(page, 'note #742, no Navigation API: → approve → Back: Home', { path: '/' });
    await page.close();
  }
  {
    // And the step back it does take there still lands where it should,
    // with no late fallback replacing it.
    const { pr } = await fresh();
    const page = await tabAt(`/decisions/pr/${pr.id}`, { oldSafari: true });
    await page.click('#prSummary > :first-child');
    await page.waitForSelector('#screenPrDiff', { timeout: 10_000 });
    await back(page, 'no Navigation API: diff → Back: the proposal, and stays', { path: `/decisions/pr/${pr.id}`, spent: true });
    await page.close();
  }
  if (failures.length) throw new Error(`${failures.length} failed: ${failures.join('; ')}`);
} finally {
  await browser.close();
  server.close();
}
