/**
 * Notes #743 and #745, in a real browser at phone size: a proposal the reader approves
 * or rejects leaves every "waiting for your decision" list at once — the
 * agents sheet's, and the Chief of Staff's forwarded cards say it is
 * decided — however the reader comes back to them: the sheet's own Back,
 * the page's Back, the browser's back, a fresh tab. A room's own queue, in
 * the sheet's room tab, was one of those lists until rooms left the product
 * (note #843).
 *
 * The owner approved a proposal and went back, and the agents sheet still
 * listed it as waiting. A proposal tapped in the sheet opens INSIDE the
 * sheet (note #722); its Back hands the reader the sheet's list as it was
 * read when the sheet opened, before the decision.
 *
 *   npm --prefix backend run build:workspace-ui
 *   OUT_DIR=/tmp/shots backend/node_modules/.bin/tsx scripts/verify-waiting-list-after-decision.mts
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
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'waiting-list-proof');
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

const PORT = Number(process.env.PORT || 4199);
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
let mergeTakes = 0;
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
    // A real merge takes seconds on the host; a check that leaves while it
    // runs asks for that time.
    if (mergeTakes) await new Promise((resolve) => setTimeout(resolve, mergeTakes));
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
// A slow network for the queue read alone (note #745): what the sheet draws
// while it is still out is the point of the check.
let decisionsTake = 0;
app.use((req, _res, next) => {
  if (decisionsTake && req.path.endsWith('/api/decisions')) setTimeout(next, decisionsTake);
  else next();
});
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
  // One workplace (note #843): its proposals all wait at its one namespace,
  // and the sheet's one queue holds them all.
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

  let made = 0;
  const fresh = async () => {
    made += 1;
    const pr = await gitPullRequestStorage.create({
      repoId: repo.id, userId: org.orgId, createdByUserId: owner.userId, createdByAgentId: 'oscar',
      sourceBranch: `note-208-days-${made}`, targetBranch: 'main', headSha: 'b'.repeat(40), diffStat: { files: 1, insertions: 1, deletions: 1 },
      title: `Tap a day ${made}`, commitSubjects: ['Days'], status: 'open', readyAt: at,
    } as never);
    const kp = await knowledgeProposalStorage.create({
      userId: org.orgId, createdByUserId: owner.userId, createdByAgentId: 'oscar', title: `The Leaderboard ${made}`,
      changes: [{ page: `leaderboard-${made}`, action: 'create', title: 'The Leaderboard', html: '<!doctype html><title>Board</title><meta name="description" content="x"><h1>Board</h1><p>x</p>' }],
      status: 'open',
    } as never);
    await orgStorage.touchMember(org.orgId, owner.userId, {
      workspaceAgentSettings: { cli: 'claude', model: 'opus', effort: 'high' },
      workspaceRecapChat: { messages: [{ id: `f${made}`, role: 'action', at, text: 'Forwarded', proposals: [{ kind: 'pr', id: pr.id }, { kind: 'knowledge', id: kp.id }] }], receipts: [], pending: [] },
    } as never);
    return { pr, kp };
  };
  const shot = async (page: Page, name: string) => {
    await page.screenshot({ path: path.join(OUT, `${LABEL}-${ENGINE}-${name}.png`) as `${string}.png` });
  };
  const decide = async (page: Page, which: 'approve' | 'reject') => {
    await page.waitForSelector('.decidebar .save.go', { timeout: 10_000 });
    const button = which === 'approve' ? '.decidebar .save.go' : '.decidebar button:not(.go)';
    // A press that lands while the screen is still settling (browser-settle)
    // is pressed again, as a person would.
    await page.click(button).catch(() => page.evaluate((selector) => document.querySelector<HTMLElement>(selector)?.click(), button));
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
  /** The agents sheet over Home, on its All tab. */
  const openSheet = async (page: Page) => {
    await page.waitForSelector('#agentChatSwitch', { timeout: 15_000 });
    await page.click('#agentChatSwitch');
    await page.waitForSelector('#agentSwitchSheet', { timeout: 10_000 });
    await page.waitForSelector('#agentSwitchGrid', { timeout: 10_000 });
  };
  /** The names the sheet's waiting list holds, once it has had its read. */
  const sheetList = async (page: Page) => {
    await sleep(1500);
    return page.evaluate(() => [...document.querySelectorAll('#agentSwitchDecisions .crow .name')].map((node) => node.textContent?.trim() ?? ''));
  };
  const cardState = async (page: Page, kind: 'pr' | 'knowledge', id: string) => page.evaluate(
    (mark) => document.querySelector(`#recapChatLog .chatmsg.forwarded[data-forwarded="${mark}"] .chatnoticestatus`)?.textContent?.trim() ?? null,
    `${kind}:${id}`,
  );
  /** Tap the row of a list that names this proposal, once it is there. */
  const tapRow = async (page: Page, list: string, title: string): Promise<boolean> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const tapped = await page.evaluate(([where, name]) => {
        const row = [...document.querySelectorAll<HTMLElement>(`${where} .crow`)]
          .find((node) => node.querySelector('.name')?.textContent?.trim() === name);
        row?.click();
        return Boolean(row);
      }, [list, title] as const);
      if (tapped) return true;
      await sleep(200);
    }
    return false;
  };
  const tapInSheet = async (page: Page, title: string) => {
    if (!await tapRow(page, '#agentSwitchDecisions', title)) throw new Error(`${title} is not in the sheet's list`);
    await page.waitForSelector('#windowBack', { timeout: 10_000 });
  };
  const gone = (label: string, names: string[], title: string) => check(label, !names.includes(title), JSON.stringify(names));

  console.log(`— ${ENGINE}, ${LABEL} build`);
  // 1. Adam's trip: the sheet, its row, the decision inside the sheet, the
  //    sheet's own Back.
  for (const which of ['approve', 'reject'] as const) {
    const { pr } = await fresh();
    const page = await newTab();
    await page.goto(`${ORIGIN}/`);
    await openSheet(page);
    check(`the sheet lists ${pr.title} while it waits`, (await sheetList(page)).includes(pr.title));
    await tapInSheet(page, pr.title);
    await decide(page, which);
    await page.click('#windowBack');
    await page.waitForSelector('#agentSwitchDecisions, #agentSwitchGrid', { timeout: 10_000 });
    const names = await sheetList(page);
    if (which === 'approve') await shot(page, 'sheet-after-approve-and-back');
    gone(`sheet → proposal → ${which} → the sheet's Back: the list drops it`, names, pr.title);
    // The Chief of Staff's card under the sheet says so too, without
    // waiting for the conversation's next read.
    await page.click('#agentSwitchClose');
    await sleep(500);
    const card = await cardState(page, 'pr', pr.id);
    check(`…and the Chief of Staff's card under it no longer asks for a decision`, card !== null && card !== 'Awaiting approval', String(card));
    await page.close();
  }
  {
    // Back while the merge is still running: the decision lands after the
    // proposal's screen has gone.
    const { pr } = await fresh();
    const page = await newTab();
    await page.goto(`${ORIGIN}/`);
    await openSheet(page);
    await tapInSheet(page, pr.title);
    await page.waitForSelector('.decidebar .save.go', { timeout: 10_000 });
    await sleep(600);
    mergeTakes = 2500;
    await page.click('.decidebar .save.go').catch(() => page.evaluate(() => document.querySelector<HTMLElement>('.decidebar .save.go')?.click()));
    await sleep(300);
    await page.click('#windowBack');
    await sleep(3500);
    mergeTakes = 0;
    gone('sheet → approve → Back while it merges: the list drops it once it lands', await sheetList(page), pr.title);
    await page.close();
  }
  {
    const { kp } = await fresh();
    const page = await newTab();
    await page.goto(`${ORIGIN}/`);
    await openSheet(page);
    await tapInSheet(page, kp.title);
    await decide(page, 'approve');
    await page.click('#windowBack');
    gone('sheet → knowledge proposal → approve → the sheet’s Back: the list drops it', await sheetList(page), kp.title);
    await page.close();
  }
  // 2. The Chief of Staff's card, the page's Back, then the sheet; the card
  //    itself says Merged.
  {
    const { pr } = await fresh();
    const page = await viaCard('pr', pr.id);
    await decide(page, 'approve');
    await page.click('#pageBack');
    await page.waitForSelector('#recapChatLog', { timeout: 10_000 });
    await sleep(1200);
    check('card → approve → Back: the card says Merged', (await cardState(page, 'pr', pr.id)) === 'Merged', String(await cardState(page, 'pr', pr.id)));
    await openSheet(page);
    gone('card → approve → Back → the sheet: the list drops it', await sheetList(page), pr.title);
    await page.close();
  }
  // 3. The browser's own back.
  {
    const { pr } = await fresh();
    const page = await viaCard('pr', pr.id);
    await decide(page, 'approve');
    await page.goBack();
    await page.waitForSelector('#recapChatLog', { timeout: 10_000 });
    await openSheet(page);
    gone('card → approve → the browser’s back → the sheet: the list drops it', await sheetList(page), pr.title);
    await page.close();
  }
  // 4. A fresh tab.
  {
    const { pr } = await fresh();
    const page = await viaCard('pr', pr.id);
    await decide(page, 'approve');
    const other = await newTab();
    await other.goto(`${ORIGIN}/`);
    await openSheet(other);
    gone('approve in one tab → a fresh tab’s sheet: the list drops it', await sheetList(other), pr.title);
    await other.close();
    await page.close();
  }
  // 5. A room's own queue, in the sheet's room tab, dropped it too until
  //    rooms left the product (note #843): the sheet's one queue, above,
  //    is the workplace's whole queue now.
  // Note #745: the sheet opens again on the list it last read, at once, and
  // the read — held back here, as a slow phone network holds it — replaces
  // it in place without moving anything that did not change.
  const listNow = (page: Page) => page.evaluate(() => [...document.querySelectorAll('#agentSwitchDecisions .crow .name')].map((node) => node.textContent?.trim() ?? ''));
  const gridTop = (page: Page) => page.evaluate(() => Math.round(document.getElementById('agentSwitchGrid')?.getBoundingClientRect().top ?? -1));
  const closeSheet = async (page: Page) => {
    await page.click('#agentSwitchClose');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && await page.evaluate(() => Boolean(document.getElementById('agentSwitchSheet')))) await sleep(100);
    await sleep(200);
  };
  {
    const { pr } = await fresh();
    const page = await newTab();
    await page.goto(`${ORIGIN}/`);
    await openSheet(page);
    const first = await sheetList(page);
    check('note #745: the first opening lists what waits', first.includes(pr.title));
    await closeSheet(page);
    decisionsTake = 2500;
    await openSheet(page);
    await sleep(250);
    const atOnce = await listNow(page);
    const topAtOnce = await gridTop(page);
    await shot(page, 'reopened-at-once');
    check('note #745: reopened, the list is there at once, before the read answers', JSON.stringify(atOnce) === JSON.stringify(first), JSON.stringify(atOnce));
    await sleep(3000);
    check('note #745: …and when the read lands with nothing new, nothing moves',
      JSON.stringify(await listNow(page)) === JSON.stringify(first) && (await gridTop(page)) === topAtOnce,
      `grid ${topAtOnce} → ${await gridTop(page)}`);
    await closeSheet(page);
    // A reload: the tab keeps it.
    decisionsTake = 0;
    await page.reload();
    decisionsTake = 2500;
    await openSheet(page);
    await sleep(250);
    check('note #745: after a reload, the list is there at once too', (await listNow(page)).includes(pr.title), JSON.stringify(await listNow(page)));
    decisionsTake = 0;
    await sleep(2600);
    await page.close();
  }
  {
    // A decided proposal never comes back from memory, reopened or reloaded.
    const { pr } = await fresh();
    const page = await newTab();
    await page.goto(`${ORIGIN}/`);
    await openSheet(page);
    check('note #745: remembered while it waits', (await sheetList(page)).includes(pr.title));
    await tapInSheet(page, pr.title);
    decisionsTake = 2500;
    await decide(page, 'approve');
    await page.click('#windowBack');
    await sleep(300);
    await closeSheet(page);
    await openSheet(page);
    await sleep(250);
    gone('note #745: approved, the sheet reopened at once without it', await listNow(page), pr.title);
    await closeSheet(page);
    decisionsTake = 0;
    await sleep(2600);
    await page.reload();
    decisionsTake = 2500;
    await openSheet(page);
    await sleep(250);
    const reloaded = await listNow(page);
    gone('note #745: …and after a reload, still without it', reloaded, pr.title);
    check('note #745: …while the rest of the remembered list is there at once', reloaded.length > 0, JSON.stringify(reloaded));
    decisionsTake = 0;
    await sleep(2600);
    await page.close();
  }
  // SELF_CLEAR_WAIT=<seconds>: not a check, an answer — whether the sheet's
  // stale list clears by itself while it stands open (asked on note #743).
  const selfClear = Number(process.env.SELF_CLEAR_WAIT || 0);
  if (selfClear > 0) {
    const { pr } = await fresh();
    const page = await newTab();
    await page.goto(`${ORIGIN}/`);
    await openSheet(page);
    await tapInSheet(page, pr.title);
    await decide(page, 'approve');
    await page.click('#windowBack');
    const started = Date.now();
    let names = await sheetList(page);
    while (names.includes(pr.title) && Date.now() - started < selfClear * 1000) {
      await sleep(2000);
      names = await sheetList(page);
    }
    console.log(`NOTE  left standing ${Math.round((Date.now() - started) / 1000)}s: ${names.includes(pr.title) ? 'still listed' : 'cleared'}`);
    await page.close();
  }
  if (failures.length) throw new Error(`${failures.length} failed: ${failures.join('; ')}`);
} finally {
  await browser.close();
  server.close();
}
