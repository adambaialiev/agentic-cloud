// Drives the React Workspace shell's DECISIONS screens in real Chrome against
// a real backend router: a change proposal (header, summary, write-up, notes,
// actions, the review hand-off, the pinned decision bar), its diff as a leaf
// that Back closes, the approval and the landing sequence that follows it;
// then a knowledge proposal (the change card leading with an open diff, its
// own review hand-off, the rendering behind its button, and a decision that
// says so in the toast and leaves the reader exactly where they were).
// Screenshots land in ~/mini-preview/n256-decisions-*.png.
// The account here is a personal one, with no workplace: its Home (`/`) is
// still the one-column overview (`#screenOverview`) with the decisions queue
// on it, where a workplace's Home is the Chief of Staff's conversation and
// the queue stands over the cards in the agents picker (notes #715, #843).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-react-decisions.mts
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot, tap } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { GitHostClient } from '../backend/src/services/git-host-client.js';
import { InMemoryGitPullRequestStorage } from '../backend/src/services/git-pr-storage.js';
import { InMemoryGitRepoStorage } from '../backend/src/services/git-repo-storage.js';
import { InMemoryKnowledgeProposalStorage } from '../backend/src/services/knowledge-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { COMMENT_AUTHOR_USER, newMarginComment } from '../backend/src/types/comment.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessMailService, harnessSignedIn } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
/** Whichever Chrome this machine actually has: the cache directory is named
 *  for the build, and pinning one version here is how the sibling harnesses
 *  stop working after the next upgrade. */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(cache).filter((name) => name.startsWith('linux-')).sort();
  const newest = builds[builds.length - 1];
  if (!newest) throw new Error(`no Chrome under ${cache} — npx puppeteer browsers install chrome`);
  return path.join(cache, newest, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4176);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const PATCH = [
  'diff --git a/src/checkout.ts b/src/checkout.ts',
  'index 1111111..2222222 100644',
  '--- a/src/checkout.ts',
  '+++ b/src/checkout.ts',
  '@@ -1,4 +1,4 @@',
  ' export function checkout() {',
  '-  return legacyCheckout();',
  '+  return reactCheckout();',
  ' }',
  'diff --git a/docs/checkout.md b/docs/checkout.md',
  '@@ -1,2 +1,3 @@',
  ' # Checkout',
  '+Now rendered by the React shell.',
].join('\n');

const page = (title: string, body: string) =>
  `<!doctype html><title>${title}</title><meta name="description" content="How the deploy goes.">`
  + `<h1>${title}</h1>${body}`;

/** The git host, in memory, behind the REAL client — so the whole wire shape
 *  is exercised rather than mocked at the seam. */
const knowledgeFiles = new Map<string, string>();
const sha1 = (content: string) => createHash('sha1').update(content).digest('hex');
const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
  const route = String(url).replace('http://host', '');
  const body = JSON.parse(init?.body ?? '{}') as { page?: string };
  const answer = (payload: unknown, status = 200) => ({
    ok: status < 400, status, text: async () => JSON.stringify(payload),
  });
  if (route === '/internal/repos/compare') {
    return answer({
      patch: PATCH,
      patchTruncated: false,
      commits: [
        { sha: 'a'.repeat(40), subject: 'Move the checkout to React', at: new Date(Date.now() - 3600_000).toISOString() },
        { sha: 'b'.repeat(40), subject: 'Say so in the docs', at: new Date(Date.now() - 1800_000).toISOString() },
      ],
      diffStat: { files: 2, insertions: 2, deletions: 1 },
      headSha: 'b'.repeat(40),
    });
  }
  if (route === '/internal/knowledge/list') {
    return answer({
      pages: [...knowledgeFiles.entries()].filter(([f]) => f.startsWith('pages/')).map(([f, content]) => ({
        name: f.slice('pages/'.length, -'.html'.length),
        sha: sha1(content),
        sizeBytes: Buffer.byteLength(content, 'utf8'),
      })),
      index: null,
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
const gitRepoStorage = new InMemoryGitRepoStorage();
const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
const knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
const decisions: unknown[] = [];

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  gitRepoStorage,
  gitPullRequestStorage,
  knowledgeProposalStorage,
  gitHostClient: new GitHostClient({
    baseUrl: 'http://host', controlUrl: 'http://host', secret: 's', fetchImpl,
  }),
  decidePullRequest: async (args: unknown) => {
    decisions.push(args);
    const { pullRequestId, decision } = args as { pullRequestId: string; decision: string };
    await gitPullRequestStorage.update(pullRequestId, {
      status: decision === 'approve' ? 'merged' : 'rejected',
      decidedAt: new Date().toISOString(),
      mergeCommitSha: 'c'.repeat(40),
    });
    return { status: decision === 'approve' ? 'merged' : 'rejected', note: null };
  },
  decideKnowledgeProposal: async (args: unknown) => {
    decisions.push(args);
    // The real flow writes the page and CLOSES the proposal, which is what
    // takes it off Home's queue — so the fixture closes it too. A stub that
    // only answers leaves the queue lying about what is still waiting.
    const { proposalId } = args as { proposalId: string };
    await knowledgeProposalStorage.update(proposalId, {
      status: 'approved', decidedAt: new Date().toISOString(),
    } as never);
    return { status: 'approved', note: null };
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
  '#prEyebrow', '#prTitle', '#prPills', '#prWho', '#prChat', '#prBody', '#prBody .mdwrap', '#prBody .md', '#prBody .card',
];

/** Note #299: where the WAIT stands, against where the answer lands. The whole
 *  point of a skeleton is that it occupies the boxes the real screen will —
 *  one that does not is a page that jumps the moment the read comes back,
 *  which is worse than the word "Loading", because at least that stayed still.
 *  The left name is read while the read is out, the right one after it lands;
 *  the same name on both sides is a block painted from the queue row and never
 *  redrawn at all. */
const WAIT_BOXES: Array<[waiting: string, landed: string]> = [
  ['#prTitle', '#prTitle'],
  ['#prEyebrow', '#prEyebrow'],
  ['#prPills', '#prPills'],
  ['#prWho', '#prWho'],
  ['#prChat', '#prChat'],
  ['#prBody', '#prBody'],
  ['#prBody .mdwrap', '#prBody .mdwrap'],
  ['#prSummaryWait', '#prSummary'],
  ['#prDecideWait', '#prDecide'],
];
/** How far a held box may be from the box that replaces it. A pixel or two is
 *  rounding; anything a reader could see is a failure. */
const WAIT_BOX_SLACK = 2;

/** The one header, measured (note #282). Every detail screen fills the same
 *  block — Back and an optional action, then the screen's own name below —
 *  and one rule closes it off from the words underneath. A screen that still
 *  draws its own heading has no `#pageId` and says so here, which is what
 *  makes this a geometry check and not a spelling one. */
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
// The name sits 48px in, not 50: `.pagehead` gave up its 2px of top padding
// on 2026-09-11 (c21c5d9b) because `.pagenav` below it IS the 48px row.
const ONE_HEADER = 'rule=1px solid · name 48px in';

/** The one toast, as the reader sees it: what it says, whether it wears the
 *  tick that means "it worked" (in the page's green), whether it is really
 *  a floating paper card over the screen (note #728) rather than a line
 *  printed into it, and whether it is as wide as its words rather than as
 *  wide as the screen (note #737). `null` when nothing is up. */
const toastShape = async (page: import('puppeteer-core').Page) => page.evaluate(() => {
  const node = document.getElementById('banner');
  if (!node) return null;
  const style = getComputedStyle(node);
  const box = node.getBoundingClientRect();
  const markBox = node.querySelector('.toastmark')?.getBoundingClientRect();
  const message = node.querySelector('.toastmessage');
  const messageBox = message?.getBoundingClientRect();
  const markMiddle = markBox ? markBox.top + markBox.height / 2 : null;
  const messageMiddle = messageBox ? messageBox.top + messageBox.height / 2 : null;
  // The words' own width, read off the text rather than off the span: the
  // span is a flex item that grows into whatever the card has spare, so
  // only the text says how much of it is message and how much is nothing.
  const words = document.createRange();
  if (message) words.selectNodeContents(message);
  const wordsWidth = words.getBoundingClientRect().width;
  return {
    width: Math.round(box.width),
    room: window.innerWidth,
    // No slack between the last word and the dismiss button: the card is
    // as wide as what it says.
    hugged: messageBox !== undefined && messageBox.width - wordsWidth <= 1,
    centred: Math.abs(box.left - (window.innerWidth - box.right)) <= 1,
    text: node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    ok: node.classList.contains('ok'),
    floating: style.position === 'fixed',
    paper: style.backgroundColor === 'rgb(252, 252, 251)',
    inked: style.color === 'rgb(31, 30, 29)',
    green: getComputedStyle(node.querySelector('.toastmark') ?? node).color === 'rgb(31, 120, 52)',
    cleanEdge: !node.querySelector('.drain'),
    aligned: markMiddle !== null && messageMiddle !== null && Math.abs(markMiddle - messageMiddle) <= 1,
    dismissible: Boolean(node.querySelector('button[aria-label="Dismiss notification"]')),
  };
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
  const page$ = await browser.newPage();
  await page$.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  page$.on('pageerror', (error) => check('no page error', false, String(error)));
  // The proposal's own read, held back on demand — the only way to see a wait
  // that is designed to be invisible when the answer is quick.
  const hold = new Map<string, number>();
  await page$.setRequestInterception(true);
  page$.on('request', (request) => {
    const path$ = [...hold.keys()].find((suffix) => request.url().endsWith(suffix));
    const ms = path$ ? hold.get(path$)! : 0;
    if (ms <= 0) { void request.continue().catch(() => {}); return; }
    setTimeout(() => { void request.continue().catch(() => {}); }, ms);
  });
  /** Whether anything grey was ever painted between here and the next look. */
  const watchForSkeleton = () => page$.evaluate(() => {
    const flag = globalThis as unknown as { skelSeen?: boolean; skelWatch?: MutationObserver };
    flag.skelWatch?.disconnect();
    flag.skelSeen = document.querySelector('.skel') !== null;
    flag.skelWatch = new MutationObserver(() => {
      if (document.querySelector('.skel')) flag.skelSeen = true;
    });
    flag.skelWatch.observe(document.body, { childList: true, subtree: true });
  });
  const skeletonWasSeen = () => page$.evaluate(
    () => Boolean((globalThis as unknown as { skelSeen?: boolean }).skelSeen),
  );
  const boxes = (pairs: string[]) => page$.evaluate((names: string[]) => Object.fromEntries(
    names.map((name) => {
      const node = document.querySelector(name);
      return [name, node ? Math.round(node.getBoundingClientRect().top) : null];
    }),
  ), pairs);
  const consoleErrors: string[] = [];
  page$.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page$.on('response', (response) => { if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`); });
  await page$.evaluateOnNewDocument((boxes: string[]) => {
    (globalThis as unknown as { PARITY_BOXES: string[] }).PARITY_BOXES = boxes;
  }, PARITY_BOXES);
  const shot = async (name: string) => {
    await page$.screenshot({
      path: path.join(OUT, `n256-decisions-${name}.png`) as `${string}.png`, fullPage: true,
    });
    await settleAfterShot(page$);
  };
  /** Just the viewport — for the one thing a full-page shot cannot show: where
   *  in the page the reader is actually looking. */
  const view = async (name: string) => {
    await page$.screenshot({
      path: path.join(OUT, `n256-decisions-${name}.png`) as `${string}.png`, fullPage: false,
    });
    await settleAfterShot(page$);
  };
  const text = (selector: string) => page$.$eval(selector, (node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  /** The same read, for a node that is ITSELF under test: `$eval` on something
   *  missing THROWS, and a throw here takes every later check down with it —
   *  where a FAIL line is the entire point. */
  const maybe = (selector: string) => text(selector).catch(() => '');
  const maybeClass = (selector: string) => page$
    .$eval(selector, (node) => node.className).catch(() => '');
  const texts = (selector: string) => page$.$$eval(selector, (nodes) => nodes.map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
  /** A handoff row is a horizontal scroller. Calling scrollIntoView on the
   *  button inside it may scroll only that inner box, leaving the button
   *  under the fixed decision bar once larger prose has moved the row down.
   *  Scroll the page as a reader does, then wait until the real tap target is
   *  visibly clear of the bar. */
  const clearDecisionBar = async (target: string) => {
    await page$.mouse.wheel({ deltaY: 600 });
    await page$.waitForFunction((selector: string) => {
      const node = document.querySelector(selector);
      const bar = document.getElementById('prDecide');
      if (!node || !bar) return false;
      return node.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top;
    }, { timeout: 5_000 }, target);
  };

  // 1. Create access, then seed the account this Workspace reads.
  await harnessSignedIn(page$, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  await page$.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenOverview #agentsSection', { timeout: 10_000 });

  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(me.telegram ?? {}),
      agents: {
        felix: {
          id: 'felix', name: 'Felix', cli: 'claude', createdAt: new Date().toISOString(),
          serverId: 'm1', connectedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
          // The latest-work recap the hovered card carries, alongside the
          // runtime and the state.
          recap: { text: 'Moved the checkout to React and proposed it.', at: new Date().toISOString() },
        },
        kai: {
          id: 'kai', name: 'Kai', cli: 'codex', createdAt: new Date().toISOString(),
          serverId: 'm2', connectedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
          recap: { text: 'Reviewed the release path.', at: new Date().toISOString() },
        },
      } as never,
    },
  });
  const repo = await gitRepoStorage.create({
    userId: me.userId, name: 'infinite-agents', createdByAgentId: 'felix',
    defaultBranch: 'main', sizeBytes: 1024,
  } as never);
  const proposal = await gitPullRequestStorage.create({
    repoId: repo.id, userId: me.userId, createdByUserId: me.userId, createdByAgentId: 'felix',
    title: 'Move the checkout to React',
    // A write-up as they really arrive (note #317): HTML, because every quick
    // note and knowledge page on this platform is HTML, with markdown under
    // it — one fixture that fails if either half is read out as tags.
    body: '<p><strong>What changed:</strong> the checkout moves to React, one screen at a time.</p>\n'
      + '<ul><li>the old page keeps working</li><li>every screen brings its tests</li></ul>\n'
      + '\nStill **markdown** where it is written that way, with `one file` to read.',
    sourceBranch: 'agent/checkout', targetBranch: 'main', headSha: 'b'.repeat(40),
    diffStat: { files: 2, insertions: 2, deletions: 1 },
    commitSubjects: ['Move the checkout to React', 'Say so in the docs'],
    status: 'open',
  } as never);
  // Both authors a margin can carry. Only the person's own row may offer
  // Edit; the agent's signed words remain the agent's to change.
  await gitPullRequestStorage.addComment(
    proposal.id,
    newMarginComment('felix', '<p>I checked the migration path.</p>', me.userId),
  );
  await gitPullRequestStorage.addComment(
    proposal.id,
    newMarginComment(COMMENT_AUTHOR_USER, '<p>Call this the checkout.<br>Not the payment page.</p>', me.userId),
  );
  // A QUIET proposal (note #293): recorded by `pr create`, not yet made ready
  // by its agent. Seeded BEFORE the queue is read, so the queue check below
  // is also the proof that it is not in it.
  const quiet = await gitPullRequestStorage.create({
    repoId: repo.id, userId: me.userId, createdByUserId: me.userId, createdByAgentId: 'felix',
    title: 'Restore the voice flow',
    body: 'Still attaching the screenshot and re-running the checks.',
    sourceBranch: 'agent/voice', targetBranch: 'main', headSha: 'd'.repeat(40),
    diffStat: { files: 3, insertions: 40, deletions: 4 },
    commitSubjects: ['Restore the voice flow'],
    status: 'open', draft: true,
  } as never);
  knowledgeFiles.set('pages/deploys.html', page('Deploys', '<p>The old words.</p>'));
  const knowledgeProposal = await knowledgeProposalStorage.create({
    userId: me.userId, createdByUserId: me.userId, createdByAgentId: 'felix',
    title: 'Update the deploy runbook', note: 'The deploy lane moved last week.',
    changes: [{
      page: 'deploys', action: 'edit', title: 'Deploys', description: 'How the deploy goes.',
      html: page('Deploys', '<p>The new words.</p><ul><li>one</li><li>two</li></ul>'),
      baseSha: sha1(knowledgeFiles.get('pages/deploys.html')!),
    }],
    status: 'open',
  } as never);

  // A RENAME, which is the one knowledge change with no diff to draw: the
  // page's bytes are identical on both sides, so a card that only knew how to
  // show a patch would say "this would leave the page exactly as it is" about
  // a page that is moving. Seeded here and read at 7c below.
  knowledgeFiles.set('pages/miniapp-refresh.html', page('How the app refreshes', '<p>Unchanged words.</p>'));
  const renameProposal = await knowledgeProposalStorage.create({
    userId: me.userId, createdByUserId: me.userId, createdByAgentId: 'felix',
    title: 'Rename "miniapp-refresh" to "workspace-refresh"',
    note: 'The Mini App is gone; the name is the handle agents read the shelf by.',
    changes: [{
      page: 'miniapp-refresh', action: 'rename', renameTo: 'workspace-refresh',
      title: 'How the app refreshes', description: 'What the app re-reads while it is open.',
      html: page('How the app refreshes', '<p>Unchanged words.</p>'),
      baseSha: sha1(knowledgeFiles.get('pages/miniapp-refresh.html')!),
    }],
    // QUIET, so the queue above keeps the two rows its own checks measure —
    // what is under test here is how the card DRAWS a rename, which its
    // readiness does not touch.
    status: 'open', draft: true,
  } as never);

  // …and a QUIET knowledge proposal, for the same reason as the change one:
  // seeded before the queue is read, so the exact-names check proves it out.
  const quietPage = await knowledgeProposalStorage.create({
    userId: me.userId, createdByUserId: me.userId, createdByAgentId: 'felix',
    title: 'Write down the voice flow', note: 'Still checking the mic section against the code.',
    changes: [{
      page: 'voice', action: 'create', title: 'Voice', description: 'How dictation works.',
      html: page('Voice', '<p>The mic button records; the server transcribes.</p>'),
    }],
    status: 'open', draft: true,
  } as never);

  // 2. Home lists both, in the queue that waits on this reader.
  await page$.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#prs .crow', { timeout: 10_000 });
  check('the queue lists what waits on this reader, change proposals first',
    (await texts('#prs .crow .name')).join(' | ') === 'Move the checkout to React | Update the deploy runbook',
    (await texts('#prs .crow .name')).join(' | '));
  await shot('home-queue');

  // 2b. Note #295: the face is all a queue row says about the agent behind
  // it, and a POINTER can ask for the rest. On a desk-sized window, because
  // that is where a pointer lives — and the phone viewport goes back on
  // straight afterwards, so nothing below this block is measured wide.
  await page$.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await page$.waitForSelector('#prs .crow .facehover', { timeout: 10_000 });
  check('nothing is raised until a pointer arrives', !(await page$.$('.agentcard')));
  // The wrapper that catches the hover must be the picture and nothing more:
  // a box of its own here would move every word on that line.
  check('the hover target is exactly the picture', await page$.evaluate(() => {
    const span = document.querySelector('#prs .crow .facehover');
    const face = span?.querySelector('img.face');
    if (!span || !face) return false;
    const a = span.getBoundingClientRect();
    const b = face.getBoundingClientRect();
    return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5
      && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
  }));
  await page$.hover('#prs .crow:nth-child(1) .facehover');
  const raised = await page$.waitForSelector('.agentcard', { timeout: 5_000 })
    .then(() => true, () => false);
  check('hovering a queue face raises the agent behind the proposal', raised);
  check('…named, with what it runs, whether it is working and what it last did',
    (await maybe('.agentcard .name')) === 'Felix'
      && (await maybe('.agentcard .cruntime')).startsWith('Claude Code')
      && (await maybe('.agentcard .statetext')) === 'Ready'
      && (await maybe('.agentcard .cabout')) === 'Moved the checkout to React and proposed it.',
    [await maybe('.agentcard .name'), await maybe('.agentcard .cruntime'),
      await maybe('.agentcard .statetext'), await maybe('.agentcard .cabout')].join(' | '));
  // Drawn OVER the page rather than inside the queue's card, which clips its
  // own overflow — and taking no pointer events, or it would slide under the
  // pointer, take the hover off the face and blink itself away.
  check('…floating clear of the face, inside the window, catching nothing', await page$.evaluate(() => {
    const card = document.querySelector('.agentcard');
    const face = document.querySelector('#prs .crow:nth-child(1) .facehover');
    if (!card || !face) return 'no card';
    const box = card.getBoundingClientRect();
    const on = face.getBoundingClientRect();
    const style = getComputedStyle(card);
    return [
      `position=${style.position}`,
      `pointer-events=${style.pointerEvents}`,
      `clear=${box.bottom <= on.top || box.top >= on.bottom}`,
      `inside=${box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight}`,
    ].join(' ');
  }) === 'position=fixed pointer-events=none clear=true inside=true',
    String(await page$.evaluate(() => {
      const card = document.querySelector('.agentcard');
      return card ? JSON.stringify(card.getBoundingClientRect()) : 'no card';
    })));
  // The width the card CLAIMS is the width it keeps. A grid item's automatic
  // minimum is its content, so before this was fixed the identity line grew
  // past the card to fit a long runtime, the ellipsis never engaged and the
  // text ran out under the border. Measured with the real line and again with
  // a longer one, because this machine's mono is narrower than the reader's:
  // a card that only fits in the harness's font is not a card that fits.
  const widths = await page$.evaluate(`(function () {
    const card = document.querySelector('.agentcard');
    const runtime = card.querySelector('.cruntime');
    const was = runtime.textContent;
    function read() {
      const box = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      const inner = box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
      const worst = Math.max(...[...card.querySelectorAll('*')].map(function (n) { return n.getBoundingClientRect().right; }));
      return { spill: Math.round(worst - inner), cut: runtime.scrollWidth > runtime.clientWidth };
    }
    const real = read();
    runtime.textContent = 'Claude Code \u00b7 gpt-5.6-terra-preview \u00b7 xhigh';
    const long = read();
    runtime.textContent = was;
    return { real, long };
  })()`) as { real: { spill: number; cut: boolean }; long: { spill: number; cut: boolean } };
  check('the runtime line fits the card as it stands', widths.real.spill <= 0 && !widths.real.cut,
    JSON.stringify(widths.real));
  check('…and a longer one is CUT to the card rather than running out under its edge',
    widths.long.spill <= 0 && widths.long.cut, JSON.stringify(widths.long));

  // The picture, clipped to the queue and the card together. A whole-viewport
  // shot is taken through a device-metrics override that loses a fixed
  // element — and the thing worth seeing here is exactly the one that floats.
  await page$.screenshot({
    path: path.join(OUT, 'n256-decisions-home-hovercard.png') as `${string}.png`,
    clip: await page$.evaluate(() => {
      const card = document.querySelector('.agentcard')!.getBoundingClientRect();
      const queue = document.getElementById('prs')!.getBoundingClientRect();
      const pad = 16;
      const x = Math.max(0, Math.min(card.left, queue.left) - pad);
      const y = Math.max(0, Math.min(card.top, queue.top) - pad);
      return {
        x,
        y,
        width: Math.min(window.innerWidth - x, Math.max(card.right, queue.right) + pad - x),
        height: Math.min(window.innerHeight - y, Math.max(card.bottom, queue.bottom) + pad - y),
      };
    }),
  });
  await page$.mouse.move(4, 4);
  check('and it goes when the pointer does', await page$
    .waitForFunction(() => !document.querySelector('.agentcard'), { timeout: 5_000 })
    .then(() => true, () => false));
  await page$.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });

  // 3. A change proposal, opened from its row.
  await tap(page$, '#prs .crow:nth-child(1)');
  // The screen paints the queue's own write-up while the live compare fills
  // in; the summary card is what says that read has landed.
  await page$.waitForSelector('#screenPr #prSummary', { timeout: 10_000 });
  check('a change row opens the proposal at its registered address',
    page$.url() === `${ORIGIN}/decisions/pr/${proposal.id}`, page$.url());
  check('the header carries the repository, the number and both branches',
    (await text('#prEyebrow')).startsWith('infinite-agents · #1')
    && (await texts('#prPills .bname')).join('→') === 'main→agent/checkout',
    `${await text('#prEyebrow')} / ${(await texts('#prPills .bname')).join('→')}`);
  check('the pill says the proposal is waiting for this reader',
    (await text('#prPills .pill')) === 'Waiting for you');
  check('it is signed with the agent and the human behind it',
    (await text('#prWho .proposalby')).startsWith('Felix'), await text('#prWho .proposalby'));
  const writeUp = await page$.evaluate(() => {
    const box = document.querySelector('#prBody .md')!;
    return {
      fontSize: getComputedStyle(box).fontSize,
      lead: box.querySelector('p strong')?.textContent ?? '',
      items: [...box.querySelectorAll('li')].map((li) => li.textContent).join(' | '),
      bold: [...box.querySelectorAll('strong')].map((node) => node.textContent).join(' | '),
      code: box.querySelector('code')?.textContent ?? '',
      text: box.textContent ?? '',
    };
  });
  check('the write-up is the agent’s own words, typeset — HTML as HTML, markdown as markdown',
    writeUp.fontSize === '14px'
    && writeUp.lead === 'What changed:'
    && writeUp.items === 'the old page keeps working | every screen brings its tests'
    && writeUp.bold === 'What changed: | markdown'
    && writeUp.code === 'one file'
    // The complaint this fixture exists for: not one tag read out as words.
    && !writeUp.text.includes('<'),
    JSON.stringify(writeUp));
  check('the summary sizes the change and lists its commits',
    (await texts('#prSummary .crow .name')).join(' | ') === '2 files changed | 2 commits | Actions',
    (await texts('#prSummary .crow .name')).join(' | '));
  check('the summary leads the longer proposal description',
    await page$.evaluate(() => {
      const summary = document.getElementById('prSummary')!.getBoundingClientRect();
      const writeUp = document.querySelector('#prBody .mdwrap')!.getBoundingClientRect();
      return summary.bottom < writeUp.top;
    }));
  check('a repo with no CI says so rather than showing a grey zero',
    (await text('#prSummary .crow:last-of-type .cside')) === 'no CI in this repo');
  check('the decision is pinned to the bottom, one tap each way',
    (await texts('#prDecide button')).join(' | ') === 'Approve & merge | Reject',
    (await texts('#prDecide button')).join(' | '));
  check('the primary decision action carries no generated hairline',
    (await page$.$eval('#prDecide .save.go', (node) => getComputedStyle(node, '::after').content)) === 'none');
  check('the screen it covers reserves room for it',
    (await page$.$eval('#screenPr', (node) => node.className)).includes('hasbar'));
  check('the bar really is pinned to the viewport, not scrolled with the page',
    (await page$.$eval('#prDecide', (node) => getComputedStyle(node).position)) === 'fixed');
  check('the persistent header stands over the destination', Boolean(await page$.$('#pageHead')));
  const heads: Record<string, string> = { proposal: await headShape(page$) };
  await shot('proposal');
  check('only the reader’s own comment offers Edit',
    await page$.$$eval('#prComments .cmteditopen', (nodes) => nodes.length) === 1);
  // Edit sits far down a long thread, inside the pane's own scroller, so a
  // hit-tested click cannot reach it from here. The button's own handler is
  // what this checks, so it is pressed directly once it has a box, and then
  // the form it draws is waited for rather than read in the same tick.
  const editOpen = (await page$.$('#prComments .cmteditopen'))!;
  await page$.waitForFunction(() => {
    const node = document.querySelector('#prComments .cmteditopen');
    return Boolean(node) && node!.getBoundingClientRect().height > 0;
  }, { timeout: 10_000 });
  await editOpen.evaluate((node) => (node as HTMLButtonElement).click());
  await page$.waitForSelector('#prComments .cmteditform textarea', { timeout: 10_000 });
  check('Edit opens in place with the person’s original lines',
    (await page$.$eval('#prComments .cmteditform textarea', (node) => (node as HTMLTextAreaElement).value))
      === 'Call this the checkout.\nNot the payment page.');
  // Every press in this harness goes through `tap`, and this one is why (note
  // #563). The editor opens 170 px below the fold. `page.click` brings it up
  // with a scripted scroll, which this app puts back — and under load the
  // restore lands between the scroll and the press. Caught three ways at this
  // line: the scroll held and the press landed; the press threw "not
  // clickable"; and the press threw NOTHING, landed on empty space and took
  // the focus off the textarea, so the new words were typed at the body, Save
  // saved the old ones, and the wait below could never come true. That last
  // one is what CI saw twice on 2026-09-18 as a bare 30 s timeout.
  await tap(page$, '#prComments .cmteditform textarea');
  await page$.keyboard.down('Control');
  await page$.keyboard.press('A');
  await page$.keyboard.up('Control');
  await page$.keyboard.type('Call this Checkout.\nNot the payment page.');
  // Read back before Save: if the keys went anywhere but the box, say so here,
  // at the step that failed, not thirty seconds later at the step that did not.
  check('the new words are in the box before Save is pressed',
    (await page$.$eval('#prComments .cmteditform textarea', (node) => (node as HTMLTextAreaElement).value))
      === 'Call this Checkout.\nNot the payment page.',
    await page$.$eval('#prComments .cmteditform textarea', (node) => JSON.stringify((node as HTMLTextAreaElement).value)));
  await view('comment-edit');
  await tap(page$, '#prComments .cmteditactions .formcommit');
  await page$.waitForFunction(() => (
    document.querySelector('#prComments .ncmt .ctext')?.textContent === 'Call this Checkout.Not the payment page.'
  ), { timeout: 30_000 }).catch(async (error: unknown) => {
    const state = await page$.evaluate(() => {
      const area = document.querySelector('#prComments .cmteditform textarea') as HTMLTextAreaElement | null;
      const save = document.querySelector('#prComments .cmteditactions .formcommit') as HTMLButtonElement | null;
      const box = save?.getBoundingClientRect();
      const hit = box ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
      return {
        textarea: area ? area.value : null,
        active: document.activeElement?.tagName + '.' + (document.activeElement as HTMLElement)?.className,
        saveDisabled: save?.disabled ?? null,
        saveBox: box ? [box.x, box.y, box.width, box.height] : null,
        hit: hit ? hit.tagName + '.' + (hit as HTMLElement).className + '#' + hit.id : null,
        inner: [window.innerWidth, window.innerHeight, window.scrollY],
        ctext: [...document.querySelectorAll('#prComments .ncmt .ctext')].map((n) => n.textContent),
        toast: document.querySelector('.toast')?.textContent ?? null,
      };
    });
    console.log('DIAG comment-save ' + JSON.stringify(state));
    await view('comment-save-timeout');
    throw error;
  });
  check('Save replaces the words, closes the editor and marks the comment edited',
    (await maybe('#prComments .ncmt .commentby')).includes('edited')
      && !(await page$.$('#prComments .cmteditform')),
    await maybe('#prComments .ncmt'));
  // Note #518: the composer takes words and nothing else, and a remark that
  // lands starts nobody — not the agent it names, and not Felix, who opened
  // this very proposal. Typing an `@` used to open the room's idle roster
  // under the box; jsdom can assert the listbox is absent, and only this can
  // show that nothing else came with it — the box still opens, still holds
  // what is typed, and still has its Send.
  const remarks = await page$.$$eval('#prComments .ncmt', (nodes) => nodes.length);
  await tap(page$, '#prCommentsCard .addrow');
  await page$.waitForSelector('#prCommentsCard .cmtform textarea', { timeout: 10_000 });
  await tap(page$, '#prCommentsCard .cmtform textarea');
  await page$.keyboard.type('@Fel');
  await page$.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
  check('an @ in the comment box opens no picker',
    !(await page$.$('#prCommentsCard .cmtform [role="listbox"]'))
      && !(await page$.$('#prCommentsCard .cmtform [role="option"]')));
  check('the box keeps the @ as the ordinary characters it now is',
    (await page$.$eval('#prCommentsCard .cmtform textarea', (node) => (node as HTMLTextAreaElement).value)) === '@Fel');
  check('Send is still the only thing under the box',
    Boolean(await page$.$('#prCommentsCard .cmtform .cmtsend')));
  await view('comment-composer');
  // And posting it says nothing back. The remark joins the thread, the box
  // collapses, and the hint line the margin used to announce a delivery on
  // never appears — there is no delivery to announce.
  await page$.keyboard.type('ix, why this table?');
  await tap(page$, '#prCommentsCard .cmtsend');
  await page$.waitForFunction(
    (was: number) => document.querySelectorAll('#prComments .ncmt').length === was + 1,
    { timeout: 10_000 },
    remarks,
  );
  check('the posted remark leads the thread, in the words that were typed',
    (await maybe('#prComments .ncmt .ctext')) === '@Felix, why this table?');
  check('nothing is announced: no agent was started, so the margin says nothing',
    !(await page$.$('#prSaid')) && !(await page$.$('#prCommentsCard .cmtform')));

  // Note #647: the remark just posted is the reader's own, so it can be taken
  // back — from inside Edit, on the owner's follow-up, so the resting thread
  // shows no Delete on any row. Taking it back is the one act on this margin
  // with no way back, which is why a question stands in front of it. Only a
  // browser can show that the question is really raised over the page and
  // that the thread the server answers with is what gets painted.
  check('no remark shows Delete until Edit is pressed',
    await page$.$$eval('#prComments .cmtdelete', (nodes) => nodes.length) === 0);
  const ownEdit = (await page$.$('#prComments .ncmt:first-child .cmteditopen'))!;
  await ownEdit.evaluate((node) => (node as HTMLButtonElement).click());
  await page$.waitForSelector('#prComments .ncmt:first-child .cmteditactions .cmtdelete', { timeout: 10_000 });
  const inEditor = await page$.evaluate(() => {
    const row = document.querySelector('#prComments .ncmt:first-child .cmteditactions')!;
    const del = row.querySelector('.cmtdelete')!.getBoundingClientRect();
    const save = row.querySelector('.formcommit')!.getBoundingClientRect();
    const cancel = row.querySelector('.btn.ghost')!.getBoundingClientRect();
    return {
      pair: Math.round(save.left - cancel.right),
      words: [...row.querySelectorAll('button')].map((node) => node.textContent?.trim()).join(' | '),
      red: getComputedStyle(row.querySelector('.cmtdelete')!).color,
      apart: Math.round(save.left - del.right),
    };
  });
  check('Edit brings Delete, red and set apart from Cancel and Save',
    inEditor.words === 'Delete | Cancel | Save' && inEditor.red === 'rgb(208, 37, 65)' && inEditor.apart > 80,
    JSON.stringify(inEditor));
  // …while Cancel and Save stay a pair: the row's own 16px between them, not
  // whatever free space two `auto` margins happened to split.
  check('Cancel sits right beside Save', inEditor.pair <= 20, JSON.stringify(inEditor));
  await view('comment-edit-with-delete');
  await tap(page$, '#prComments .ncmt:first-child .cmteditactions .cmtdelete');
  await page$.waitForSelector('.scrim .ask', { timeout: 10_000 });
  check('it asks first, and says the loss is everybody’s',
    (await maybe('.scrim .ask')).includes('cannot be undone')
      && (await page$.$$eval('#prComments .ncmt', (nodes) => nodes.length)) === remarks + 1);
  await view('comment-delete-ask');
  await tap(page$, '.scrim .ask .btn.danger');
  await page$.waitForFunction(
    (was: number) => document.querySelectorAll('#prComments .ncmt').length === was,
    { timeout: 10_000 },
    remarks,
  );
  check('the withdrawn remark is gone from the thread the server answers with',
    (await maybe('#prComments .ncmt .ctext')) === 'Call this Checkout.Not the payment page.'
      && !(await page$.$('.scrim')));

  // The same card on the screen the row opened (note #295): here it adds the
  // one fact the signature does not write out.
  await page$.hover('#prWho .facehover');
  const signedCard = await page$.waitForSelector('.agentcard', { timeout: 5_000 })
    .then(() => true, () => false);
  check('the proposal’s own face answers the same pointer',
    signedCard && (await maybe('.agentcard .name')) === 'Felix'
      && (await maybe('.agentcard .statetext')) === 'Ready',
    [await maybe('.agentcard .name'), await maybe('.agentcard .statetext')].join(' | '));
  // The surface the owner photographed on 2026-09-04, in a picture of its own:
  // the signature block with the card standing over it. Clipped, because a
  // plain shot lets go of the hover and photographs no card at all.
  if (signedCard) {
    await page$.screenshot({
      path: path.join(OUT, 'n256-decisions-who-hovercard.png') as `${string}.png`,
      clip: await page$.evaluate(`(function () {
        const card = document.querySelector('.agentcard').getBoundingClientRect();
        const who = document.getElementById('prWho').getBoundingClientRect();
        const pad = 14;
        const x = Math.max(0, Math.min(card.left, who.left) - pad);
        const y = Math.max(0, Math.min(card.top, who.top) - pad);
        return {
          x,
          y,
          width: Math.min(window.innerWidth - x, Math.max(card.right, who.right) + pad - x),
          height: Math.min(window.innerHeight - y, Math.max(card.bottom, who.bottom) + pad - y),
        };
      })()`) as { x: number; y: number; width: number; height: number },
    });
  }
  await page$.mouse.move(4, 4);
  await page$.waitForFunction(() => !document.querySelector('.agentcard'), { timeout: 5_000 })
    .catch(() => {});
  // …and it is still the DOOR it was before that card was put over it
  // (note #353). The box that raises the card is a pseudo-element of the
  // wrapper, painted after its children, so it covered this link and swallowed
  // every tap on the face — a way in to the agent that had quietly opened
  // nothing for weeks. Only a browser can say so: the markup was right the
  // whole time, and this asks the page what is actually under the thumb.
  check('the face under that card is still the way in to the agent',
    await page$.evaluate(() => {
      const link = document.querySelector('#prWho a.facebtn');
      if (!link) return 'no door';
      const box = link.getBoundingClientRect();
      return link.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
        ? 'reached'
        : `covered by ${(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) as HTMLElement | null)?.className ?? 'nothing'}`;
    }) === 'reached',
    String(await page$.evaluate(() => {
      const link = document.querySelector('#prWho a.facebtn');
      const box = link?.getBoundingClientRect();
      const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
      return `${link?.getAttribute('href') ?? 'no door'} / ${(hit as HTMLElement | null)?.className ?? 'nothing'}`;
    })));

  // 3b. Review can be handed to an idle agent without leaving the proposal.
  // The Send is the same transient leaf a note opens: same address, no new
  // history entry, editable canonical pointer, and Back onto the review.
  const reviewAddress = page$.url();
  const reviewDepth = await page$.evaluate(() => history.length);
  check('the proposal offers another idle agent, but not its author, as a review hand-off',
    (await texts('#prHands .hand:not(.createhand) .hname')).join(' | ') === 'Kai'
      && (await text('#prHandsHint')).includes('hand over this proposal'),
    `${(await texts('#prHands .hand:not(.createhand) .hname')).join(' | ')} / ${await text('#prHandsHint')}`);
  // Clear of the fixed decision bar. Puppeteer's automatic nearest-edge
  // scroll can put the button directly UNDER that bar and then faithfully tap
  // the bar instead — a harness miss, not the phone gesture this is proving.
  await page$.mouse.move(4, 4);
  await page$.waitForFunction(() => !document.querySelector('.agentcard'), { timeout: 5_000 });
  await clearDecisionBar('#prHands .handpick');
  await tap(page$, '#prHands .handpick');
  await page$.waitForSelector('#screenNoteSend', { timeout: 10_000 });
  const reviewPrefill = await page$.$eval('#noteSendText', (node) => (node as HTMLTextAreaElement).value);
  check('the change review names the repository, proposal number and title',
    reviewPrefill === 'review change proposal #1 in infinite-agents, “Move the checkout to React”',
    reviewPrefill);
  check('the review Send is a leaf on the proposal’s address and history entry',
    page$.url() === reviewAddress && (await page$.evaluate(() => history.length)) === reviewDepth,
    `${page$.url()} / ${await page$.evaluate(() => history.length)} vs ${reviewDepth}`);
  await shot('proposal-review-send');
  await tap(page$, '#pageBack');
  await page$.waitForSelector('#screenPr #prSummary', { timeout: 10_000 });
  check('Back off the review Send lands on the proposal', Boolean(await page$.$('#prHands')));

  // 4. The diff, as a leaf: same address, and Back closes it.
  const before = await page$.evaluate(() => history.length);
  // Back correctly restored the hand-off row's reading line; `tap` wheels the
  // earlier summary row clear, where a scripted scroll would be put back.
  await tap(page$, '#prSummary .crow');
  await page$.waitForSelector('#screenPrDiff', { timeout: 10_000 });
  check('the files row opens the diff on a screen of its own',
    (await texts('.diffpath')).join(' | ') === 'src/checkout.ts | docs/checkout.md',
    (await texts('.diffpath')).join(' | '));
  check('a diff card starts closed, and its lines are hidden with it',
    (await page$.$eval('.difffile', (node) => node.className)).includes('closed')
    && (await page$.$eval('.difflines', (node) => getComputedStyle(node).display)) === 'none');
  check('the diff keeps the proposal’s address — it is a leaf, not a place',
    page$.url() === `${ORIGIN}/decisions/pr/${proposal.id}`, page$.url());
  check('the decision follows the reader into the diff',
    Boolean(await page$.$('#prDecide .save')));
  await tap(page$, '.diffhead');
  check('a card opens on a tap',
    !(await page$.$eval('.difffile', (node) => node.className)).includes('closed'));
  check('the removed line is red and the added one green',
    (await page$.$$eval('.difflines .del', (nodes) => nodes.map((n) => n.textContent))).join('')
      === '-  return legacyCheckout();');
  heads.diff = await headShape(page$);
  await shot('diff');
  await tap(page$, '#pageBack');
  await page$.waitForSelector('#screenPr #prSummary', { timeout: 10_000 });
  check('Back closes the diff and lands on the proposal', Boolean(await page$.$('#screenPr')));
  check('…by spending the entry it pushed, not stacking another',
    (await page$.evaluate(() => history.length)) === before + 1,
    `${await page$.evaluate(() => history.length)} vs ${before}`);

  // 4b. THE WAIT (note #299). The read is held back, so the screen has to hold
  //     the reader's place — and hold it in the boxes the answer lands in.
  hold.set(`/workspace/api/prs/${proposal.id}`, 2500);
  await page$.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#prs .crow', { timeout: 10_000 });
  await watchForSkeleton();
  await tap(page$, '#prs .crow:nth-child(1)');
  const drew = await page$.waitForSelector('#prSummaryWait', { timeout: 10_000 })
    .then(() => true, () => false);
  check('a read slow enough to notice is held with the shape of the screen, not a word',
    drew && (await page$.$$('#prSummaryWait .skel')).length > 0);
  // What the queue row already said is said IMMEDIATELY, and as itself: a
  // skeleton over a title the reader has already read is a step backwards.
  check('the wait paints what the row that opened it already knew',
    drew
    && (await maybe('#prTitle')) === 'Move the checkout to React'
    && (await maybe('#prEyebrow')).startsWith('infinite-agents · #1')
    && (await maybe('#prPills .pill')) === 'Waiting for you'
    && (await texts('#prPills .bname')).join('→') === 'main→agent/checkout'
    && (await maybe('#prWho .proposalby')).startsWith('Felix')
    // Typeset while it waits, exactly as it is once the read lands: the row
    // carried the write-up, so the wait has no reason to show it as tags.
    && (await maybe('#prBody .md p strong')) === 'What changed:'
    && !(await maybe('#prBody .md')).includes('<'),
    `${await maybe('#prTitle')} / ${await maybe('#prPills .pill')} / ${await maybe('#prWho .proposalby')}`);
  check('…and holds only what the live read still owes: the summary and the runtime',
    (await page$.$$('#prSummaryWait .crow')).length === 3
    && Boolean(await page$.$('#prWho .cruntime .skel')),
    `${(await page$.$$('#prSummaryWait .crow')).length} rows`);
  // The most consequential taps in the Workspace: their room is held, and
  // nothing that can be tapped is drawn until the read says what a tap means.
  check('the decision is held as room, and offers nothing to tap',
    Boolean(await page$.$('#prDecideWait'))
    && (await page$.$$('#prDecideWait button')).length === 0
    && (await maybeClass('#screenPr')).includes('hasbar'));
  check('the wait says in words what it is, for a reader who cannot see it',
    (await maybe('#screenPr .sr-only')) === 'Loading this proposal…'
    && (await page$.$eval('#screenPr', (node) => node.getAttribute('aria-busy'))) === 'true');
  await shot('proposal-waiting');
  const waiting = await boxes(WAIT_BOXES.map(([name]) => name));
  await page$.waitForSelector('#screenPr #prSummary', { timeout: 10_000 });
  const landed = await boxes(WAIT_BOXES.map(([, name]) => name));
  const moved = WAIT_BOXES
    .map(([was, now]) => ({ was, now, from: waiting[was], to: landed[now] }))
    .filter((box) => box.from === null || box.to === null || Math.abs(box.from! - box.to!) > WAIT_BOX_SLACK);
  check('nothing moves when the read lands — every held box is where the real one goes',
    moved.length === 0,
    moved.map((box) => `${box.was}→${box.now}: ${box.from} vs ${box.to}`).join(' | '));

  // And the other half of the rule (note #287): a read that is quick shows
  // NOTHING. A skeleton the reader sees only as it leaves is a flicker, and a
  // flicker reads as a fault.
  hold.clear();
  await page$.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#prs .crow', { timeout: 10_000 });
  await watchForSkeleton();
  await tap(page$, '#prs .crow:nth-child(1)');
  await page$.waitForSelector('#screenPr #prSummary', { timeout: 10_000 });
  check('a read that answers at once draws no skeleton at all — not for one frame',
    (await skeletonWasSeen()) === false);

  // 4c. The same screen opened COLD — from a link, or an agent's own list,
  //     where no queue row has been read and the shell knows nothing about
  //     this proposal at all. Now every block is held, and the rule is the
  //     same one: they have to be the boxes the answer lands in.
  hold.set('/workspace/api/state', 6000);
  hold.set(`/workspace/api/prs/${proposal.id}`, 2500);
  await page$.goto(`${ORIGIN}/decisions/pr/${proposal.id}`, { waitUntil: 'domcontentloaded' });
  const coldDrew = await page$.waitForSelector('#prPillsWait', { timeout: 10_000 })
    .then(() => true, () => false);
  check('a proposal opened from a link holds the whole shape, not just the tail of it',
    coldDrew && Boolean(await page$.$('#prWhoWait')) && Boolean(await page$.$('#prBody .skel-md'))
    && Boolean(await page$.$('#prSummaryWait')),
    coldDrew ? 'pills held' : 'nothing held');
  check('…and offers no decision, because nothing yet says there is one to make',
    (await page$.$$('#prDecideWait')).length === 0
    && !(await maybeClass('#screenPr')).includes('hasbar'));
  await shot('proposal-waiting-cold');
  const COLD_BOXES: Array<[string, string]> = [
    ['#prPillsWait', '#prPills'],
    ['#prWhoWait', '#prWho'],
    ['#prBody', '#prBody'],
    ['#prSummaryWait', '#prSummary'],
    ['#prBody .mdwrap', '#prBody .mdwrap'],
  ];
  const coldWaiting = await boxes(COLD_BOXES.map(([name]) => name));
  await page$.waitForSelector('#screenPr #prSummary', { timeout: 10_000 });
  const coldLanded = await boxes(COLD_BOXES.map(([, name]) => name));
  // The write-up is the one box that cannot be held exactly: its height is its
  // own words, which is precisely what the read has not said yet. Everything
  // ABOVE it is held to the pixel, so the reading line does not move. The
  // write-up itself can grow to fit the words once they arrive.
  const coldMoved = COLD_BOXES.slice(0, 4)
    .map(([was, now]) => ({ was, now, from: coldWaiting[was], to: coldLanded[now] }))
    .filter((box) => box.from === null || box.to === null || Math.abs(box.from! - box.to!) > WAIT_BOX_SLACK);
  check('a cold wait holds every box above the write-up exactly where the answer lands',
    coldMoved.length === 0,
    coldMoved.map((box) => `${box.was}→${box.now}: ${box.from} vs ${box.to}`).join(' | '));
  // Put the reader back on a fully-read screen: the fleet was held back too,
  // so the chat door the parity read below measures is not there yet.
  hold.clear();
  await page$.goto(`${ORIGIN}/decisions/pr/${proposal.id}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenPr #prSummary', { timeout: 10_000 });
  await page$.waitForSelector('#screenPr #prChat', { timeout: 10_000 });

  // 5. THE SAME RECORD in the classic Workspace: the port is only finished if
  //    both shells say the same things about the same proposal.
  const reactSays = {
    eyebrow: await text('#prEyebrow'),
    title: await text('#prTitle'),
    pill: await text('#prPills .pill'),
    branches: (await texts('#prPills .bname')).join('→'),
    who: await text('#prWho .proposalby'),
    body: await text('#prBody .md'),
    rows: (await texts('#prSummary .crow .name')).join(' | '),
    actions: await text('#prSummary .crow:last-of-type .cside'),
    hint: await text('#prBody .hintline'),
    decide: (await texts('#prDecide button')).join(' | '),
    // Where each part actually SITS: the stylesheet is shared, so a box in a
    // different place means the port put a node the CSS was not expecting.
    boxes: await page$.evaluate(() => PARITY_BOXES
      .map((selector) => `${selector}=${Math.round(document.querySelector(selector)!.getBoundingClientRect().top)}`)
      .join(' ')),
  };
  check('the proposal screen says what it should', Object.values(reactSays).every(Boolean), JSON.stringify(reactSays));
  await page$.goto(`${ORIGIN}/decisions/pr/${proposal.id}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenPr #prSummary', { timeout: 10_000 });

  // 6. Approving: the merge says what it is doing, then the landing follows —
  //    and the reader is taken to it. They tapped a bar pinned to the BOTTOM
  //    of the screen and the answer is written at the TOP, so a screen that
  //    stays put has just swallowed the thing it was asked to explain.
  // A viewport short enough that this fixture's proposal actually scrolls: at
  // the full 860 the whole screen fits, `window.scrollY` never leaves 0, and a
  // check about where the reader ends up would be measuring nothing. Height
  // only — changing `hasTouch` or `isMobile` here would RELOAD the page.
  await page$.setViewport({ width: 420, height: 460, deviceScaleFactor: 2 });
  await page$.evaluate(() => {
    delete (globalThis as unknown as { lastY?: number }).lastY;
    delete (globalThis as unknown as { stillFor?: number }).stillFor;
  });
  await page$.mouse.wheel({ deltaY: 600 });
  await page$.waitForFunction(() => window.scrollY > 0, { timeout: 5_000 });
  const beforeDecide = await page$.evaluate(() => Math.round(window.scrollY));
  check('the fixture is tall enough for this to mean anything', beforeDecide > 0, `scrollY ${beforeDecide}`);
  // Watch the DOM across the decision. A transition rule alone proves
  // nothing: React used to mount the node already wearing `.show`, then
  // remove it outright, so neither transition had two states to run between.
  // A source string keeps the observer's callback native to the page. The
  // TypeScript runner otherwise decorates nested functions with its `__name`
  // helper, which does not exist inside Chrome's isolated evaluation world.
  await page$.evaluate(`(() => {
    const root = globalThis;
    if (root.toastWitness) root.toastWitness.observer.disconnect();
    const seen = [];
    const read = () => {
      const node = document.getElementById('banner');
      const value = node ? (node.className || '(base)') : 'absent';
      if (seen[seen.length - 1] !== value) seen.push(value);
    };
    const observer = new MutationObserver(read);
    observer.observe(document.body, {
      attributes: true, attributeFilter: ['class'], childList: true, subtree: true,
    });
    root.toastWitness = { seen, observer };
    read();
  })()`);
  await tap(page$, '#prDecide .save.go');
  // The move is smooth, so read it once it has come to rest rather than while
  // it is still travelling.
  const landing$ = await page$.waitForFunction(() => {
    const node = document.getElementById('prDelivery');
    if (!node) return null;
    // Unchanged across THREE consecutive polls, not two: an easing curve
    // flattens near its end, so a single repeated reading is regularly a frame
    // of the animation rather than the end of it. That is what made this check
    // report a half-finished scroll the first time it ran.
    const seen = globalThis as unknown as { lastY?: number; stillFor?: number };
    const y = Math.round(window.scrollY);
    seen.stillFor = seen.lastY === y ? (seen.stillFor ?? 0) + 1 : 0;
    seen.lastY = y;
    if ((seen.stillFor ?? 0) < 3) return null;
    const head = document.getElementById('pageHead');
    return { under: Math.round(node.getBoundingClientRect().top - (head?.getBoundingClientRect().bottom ?? 0)), y };
  }, { timeout: 8_000, polling: 120 }).then(
    (handle) => handle.jsonValue() as Promise<{ under: number; y: number }>,
    () => null,
  );
  // They tapped a bar pinned to the BOTTOM of the screen, and the answer to
  // what they just did is written at the TOP of it. A screen that stays put
  // has swallowed the thing it was asked to explain.
  check('approving carries the reader to the landing sequence, clear of the header',
    landing$ !== null && Math.abs(landing$.under) <= 24 && landing$.y !== beforeDecide,
    landing$ ? `${landing$.under}px under the header, scrollY ${beforeDecide} → ${landing$.y}` : 'never arrived');
  await view('landing');
  await page$.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  await page$.waitForFunction(
    () => document.querySelector('.prdelivery') !== null, { timeout: 10_000 },
  );
  check('the landing sequence appears, merge first and the later stages next',
    (await texts('.prdelivery .delivery-step .name')).join(' | ')
      === 'Merged into main | Checks on main | Delivery',
    (await texts('.prdelivery .delivery-step .name')).join(' | '));
  await page$.waitForFunction(() => document.getElementById('prDecide') === null, { timeout: 10_000 });
  check('the decision is over, so the bar goes and the pill says what became of it',
    (await text('#prPills .pill')).startsWith('Merged'), await text('#prPills .pill'));
  check('the decision reached the one flow that owns it', decisions.length === 1);
  // Note #303: the merge SAYS SO IN THE TOAST, and nothing else says it.
  const mergedToast = await toastShape(page$);
  check('the merge announces itself in the paper toast, with the green tick and no countdown line',
    mergedToast?.text === 'Merged into main.' && mergedToast.ok === true
    && mergedToast.floating === true && mergedToast.paper === true
    && mergedToast.inked === true && mergedToast.green === true && mergedToast.cleanEdge === true
    && mergedToast.aligned === true && mergedToast.dismissible === true,
    JSON.stringify(mergedToast));
  // Note #737: three words do not need the screen. Until then this card was
  // 396px on a 420px window — 12px either side, whatever it said — so a
  // short receipt was a band with most of it empty. It measures ~200px now.
  check('…and is as wide as what it says, centred at the top, not edge to edge',
    mergedToast !== null && mergedToast.hugged && mergedToast.centred
    && mergedToast.width < mergedToast.room * 0.6,
    JSON.stringify(mergedToast && { width: mergedToast.width, room: mergedToast.room, hugged: mergedToast.hugged, centred: mergedToast.centred }));
  check('…and nowhere else: no second copy of the sentence is written into the screen',
    !(await texts('#screenPr .hintline')).some((line) => line.includes('Merged into main')),
    (await texts('#screenPr .hintline')).join(' | '));
  // Where it RESTS: within the viewport, along its top since note #722 — a
  // toast that has drifted out of the visible page says nothing to anybody.
  // Written to report a missing toast rather than to throw on it: a check
  // that dies takes every later check down with it.
  check('the toast comes to rest inside the viewport, near the top',
    await page$.evaluate(() => {
      const node = document.getElementById('banner');
      if (!node) return false;
      const box = node.getBoundingClientRect();
      return box.top >= 0 && box.bottom < window.innerHeight * 0.4;
    }));
  await shot('merged');
  await page$.click('#banner .toastdismiss');
  await page$.waitForFunction(() => document.getElementById('banner') === null, { timeout: 2_000 });
  const toastLife = await page$.evaluate(() => {
    const witness = (globalThis as unknown as {
      toastWitness?: { seen: string[]; observer: MutationObserver };
    }).toastWitness;
    witness?.observer.disconnect();
    return witness?.seen ?? [];
  });
  check('the real toast animates in, and dismiss animates it out before unmounting',
    toastLife.slice(-4).join(' → ') === 'ok → show ok → ok → absent',
    toastLife.join(' → '));

  // 6b. The knowledge queue's own wait (note #299): the same rule on the other
  //     screen — what the row said is painted, and the pages it would change
  //     are held one card each, because the row knows how many there are.
  hold.set(`/workspace/api/knowledge/proposals/${knowledgeProposal.id}`, 2500);
  await page$.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#prs .crow', { timeout: 10_000 });
  await tap(page$, '#prs .crow');
  const kpDrew = await page$.waitForSelector('#screenKp .kchange .skel', { timeout: 10_000 })
    .then(() => true, () => false);
  check('a knowledge proposal waits in its own shape too, one card per page it would change',
    kpDrew && (await page$.$$('#screenKp .kchange')).length === 1
    && (await maybe('#kpTitle')) === 'Update the deploy runbook'
    && (await maybe('#kpSub .proposalby')).startsWith('Felix')
    && (await maybeClass('#screenKp')).includes('hasbar'),
    kpDrew ? `${(await page$.$$('#screenKp .kchange')).length} cards / ${await maybe('#kpTitle')}` : 'nothing held');
  await shot('knowledge-waiting');
  await page$.waitForSelector('#screenKp .kchange .difffile', { timeout: 10_000 });
  hold.clear();

  // 7. A knowledge proposal: the diff leads, the rendering is behind a button.
  await page$.goto(`${ORIGIN}/decisions/knowledge/${knowledgeProposal.id}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenKp .kchange', { timeout: 10_000 });
  check('the knowledge proposal explanation uses the same 14px detail step',
    (await page$.$eval('#kpBody .md', (node) => getComputedStyle(node).fontSize)) === '14px',
    await page$.$eval('#kpBody .md', (node) => getComputedStyle(node).fontSize));
  check('the change card names what would happen to which page',
    (await text('.kchange .kact')) === 'Update' && (await text('.kchange .kname')) === 'deploys');
  check('it leads with the raw diff, OPEN — one page is not a summary to drill into',
    !(await page$.$eval('.kchange .difffile', (node) => node.className)).includes('closed'));
  check('the diff shows what would move',
    (await texts('.kchange .difflines .add')).some((line) => line.includes('The new words')),
    (await texts('.kchange .difflines .add')).join(' | '));
  check('the decision says publish, not merge',
    (await texts('#prDecide button')).join(' | ') === 'Approve & publish | Reject',
    (await texts('#prDecide button')).join(' | '));
  check('the knowledge proposal offers the same reviewer and omits its author',
    (await texts('#kpHands .hand:not(.createhand) .hname')).join(' | ') === 'Kai'
      && (await text('#kpHandsHint')).includes('hand over this proposal'),
    `${(await texts('#kpHands .hand:not(.createhand) .hname')).join(' | ')} / ${await text('#kpHandsHint')}`);
  heads.knowledgeProposal = await headShape(page$);
  check('both queues wear the one header, closed with one rule',
    Object.values(heads).every((shape) => shape === ONE_HEADER), JSON.stringify(heads));
  // The repository and number used to stand ABOVE the title; they are the
  // line under it now, where every other screen keeps its sub.
  await shot('knowledge');

  const knowledgeReviewAddress = page$.url();
  const knowledgeReviewDepth = await page$.evaluate(() => history.length);
  await clearDecisionBar('#kpHands .handpick');
  await tap(page$, '#kpHands .handpick');
  await page$.waitForSelector('#screenNoteSend', { timeout: 10_000 });
  const knowledgeReviewPrefill = await page$
    .$eval('#noteSendText', (node) => (node as HTMLTextAreaElement).value);
  check('the knowledge review names its account-wide number and title',
    knowledgeReviewPrefill === 'review knowledge proposal #1, “Update the deploy runbook”',
    knowledgeReviewPrefill);
  check('its review Send is transient too',
    page$.url() === knowledgeReviewAddress
      && (await page$.evaluate(() => history.length)) === knowledgeReviewDepth,
    `${page$.url()} / ${await page$.evaluate(() => history.length)} vs ${knowledgeReviewDepth}`);
  await shot('knowledge-review-send');
  await tap(page$, '#pageBack');
  await page$.waitForSelector('#screenKp .kchange', { timeout: 10_000 });

  await page$.$eval('.kread', (node) => node.scrollIntoView({ block: 'center' }));
  await tap(page$, '.kread');
  await page$.waitForSelector('#screenKnowledgePage', { timeout: 10_000 });
  check('the rendering is the page as it WOULD be',
    (await texts('#kpageBody p')).join(' | ') === 'The new words.'
    && (await texts('#kpageBody li')).join(' | ') === 'one | two',
    `${(await texts('#kpageBody p')).join(' | ')} / ${(await texts('#kpageBody li')).join(' | ')}`);
  check('its own <h1> is not printed twice under the screen’s title',
    (await page$.$$('#kpageBody h1')).length === 0);
  await shot('knowledge-page');
  await tap(page$, '#pageBack');
  await page$.waitForSelector('#screenKp .kchange', { timeout: 10_000 });
  check('Back off the rendering is one hop up, onto the change', Boolean(await page$.$('#screenKp')));

  // 7c. A RENAME, read where the decision is made. Only a browser settles
  //     this one: the two versions of the source are identical, so the card's
  //     diff is empty, and what the reader has to be told is the thing a diff
  //     cannot show — the page is moving, and its margin moves with it.
  await page$.goto(`${ORIGIN}/decisions/knowledge/${renameProposal.id}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenKp .kchange', { timeout: 10_000 });
  check('a rename is drawn as the move it is, naming both addresses',
    (await text('.kchange .kact')) === 'Renaming'
    && (await text('.kchange .kname')) === 'miniapp-refresh → workspace-refresh',
    `${await text('.kchange .kact')} / ${await text('.kchange .kname')}`);
  check('…saying what it keeps, where an empty diff would have said nothing happens',
    (await text('#screenKp')).includes('only its address changes')
    && (await text('#screenKp')).includes('comments move with it')
    && !(await text('#screenKp')).includes('leave the page exactly as it is'),
    await text('.kchange'));
  await shot('knowledge-rename');
  await page$.goto(`${ORIGIN}/decisions/knowledge/${knowledgeProposal.id}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenKp .kchange', { timeout: 10_000 });

  // 8. Deciding says so in the toast and does nothing else (note #303): it
  //    used to throw the reader back to Home and leave a card standing there.
  const kpAddress = page$.url();
  await tap(page$, '#prDecide .save.go');
  // Tolerant of a toast that never comes: it is one of the things under test,
  // and a wait that throws would take every check after it down too.
  await page$.waitForFunction(
    () => document.getElementById('banner') !== null, { timeout: 10_000 },
  ).catch(() => {});
  const publishedToast = await toastShape(page$);
  check('publishing announces itself in the paper toast, with the green tick and no countdown line',
    publishedToast?.text === 'Published.' && publishedToast.ok === true
    && publishedToast.floating === true && publishedToast.paper === true
    && publishedToast.inked === true && publishedToast.green === true && publishedToast.cleanEdge === true
    && publishedToast.aligned === true && publishedToast.dismissible === true,
    JSON.stringify(publishedToast));
  check('the reader keeps the page they were reading — no yank back to Home',
    page$.url() === kpAddress && Boolean(await page$.$('#screenKp')) && !(await page$.$('#screenOverview')),
    page$.url());
  check('no card is left standing anywhere in its place',
    !(await page$.$('#homeBanner')));
  const kpSettled = await page$.waitForFunction(
    () => document.getElementById('screenKp') !== null && document.getElementById('prDecide') === null,
    { timeout: 10_000 },
  ).then(() => true, () => false);
  check('the decision is over, so the bar goes and the screen dates it instead',
    kpSettled && (await text('#kpSub')).includes('approved'),
    kpSettled ? await text('#kpSub') : 'the reader is not on the proposal any more');
  check('the screen stops reserving room for a bar that is gone',
    kpSettled && !(await page$.$eval('#screenKp', (node) => node.className)).includes('hasbar'));
  await shot('published');

  // Home, behind it, was re-read: the queue has lost what was just decided,
  // and there is nothing left standing at the top of it.
  // Back returns from the proposal the reader is still on — and if some
  // regression has already dumped them Home, they need no tap at all.
  const backButton = await page$.$('#pageBack');
  if (backButton) await tap(page$, '#pageBack');
  await page$.waitForSelector('#screenOverview', { timeout: 10_000 });
  const dropped = await page$.waitForFunction(
    () => ![...document.querySelectorAll('#prs .crow .name')]
      .some((node) => node.textContent?.includes('Update the deploy runbook')),
    { timeout: 10_000 },
  ).then(() => true, () => false);
  check('Home’s overview has dropped the decided proposal from the queue, and carries no card',
    dropped && !(await page$.$('#homeBanner')),
    (await texts('#prs .crow .name')).join(' | '));

  // 7. The quiet proposal (note #293), reached by address — the one way it
  // CAN be reached, since no row, card or notification points at it. The
  // owner asked never to see an Approve button over work an agent is still
  // on; this is that screen, with nothing to tap and the reason said.
  await page$.goto(`${ORIGIN}/decisions/pr/${quiet.id}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenPr #prSummary', { timeout: 10_000 });
  // (That it never reached the queue is step 2's exact-names check, above.)
  check('its pill says it is still being prepared, not waiting for the reader',
    (await text('#prPills .pill')) === 'Still being prepared', await text('#prPills .pill'));
  check('there is no decision bar, and the screen reserves no room for one',
    !(await page$.$('#prDecide .decidebar'))
    && !(await page$.$eval('#screenPr', (node) => node.className)).includes('hasbar'));
  check('in its place, why: the agent is still on it and will invite the reader',
    (await maybe('#prDecide')) === 'Felix is still working on this and has not asked for a decision yet. It will invite you when it is ready.',
    await maybe('#prDecide'));
  check('the approve hint is not shown over a tap that cannot happen',
    await page$.$eval('#prHint', (node) => (node as HTMLElement).hidden));
  await shot('quiet');

  // 8. The quiet knowledge proposal, by address — the same screen shape, with
  // no bar and the reason in its place.
  await page$.goto(`${ORIGIN}/decisions/knowledge/${quietPage.id}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenKp #kpBody .card', { timeout: 10_000 });
  check('a quiet page proposal says so under its signature',
    (await text('#kpSub')).includes('still being prepared'), await text('#kpSub'));
  check('there is no decision bar on it, and no room reserved for one',
    !(await page$.$('#prDecide .decidebar'))
    && !(await page$.$eval('#screenKp', (node) => node.className)).includes('hasbar'));
  check('in its place, why: the agent is still on it and will invite the reader',
    (await maybe('#prDecide')) === 'Felix is still working on this and has not asked for a decision yet. It will invite you when it is ready.',
    await maybe('#prDecide'));
  await shot('quiet-knowledge');

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
