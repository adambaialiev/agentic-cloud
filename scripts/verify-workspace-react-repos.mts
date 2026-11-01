// Drives the React Workspace shell's REPOSITORY screens in real Chrome
// against a real backend router: Home's card and its quota line, the
// repository's two tabs, the tree and the crumb, one file (numbered code, a
// markdown toggle and an image), the history, one commit's diff, the
// contributors, who can reach it and the type-the-name delete. Then it opens
// THE SAME repository in both shells and compares what each says AND where
// each part sits.
// Screenshots land in ~/mini-preview/n256-repos-*.png.
// Since note #715 Home (`/`) is the Chief of Staff's conversation, and the
// repositories card stands in the Workplace window its header's door opens.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-react-repos.mts
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { openWorkplaceWindow } from './workspace-harness-home.mjs';
import { settleAfterShot, tap } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { GitHostClient } from '../backend/src/services/git-host-client.js';
import { InMemoryGitRepoStorage } from '../backend/src/services/git-repo-storage.js';
import { InMemoryGitPullRequestStorage } from '../backend/src/services/git-pr-storage.js';
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

/** Whichever Chrome this machine actually has. */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(cache).filter((name) => name.startsWith('linux-')).sort();
  const newest = builds[builds.length - 1];
  if (!newest) throw new Error(`no Chrome under ${cache} — npx puppeteer browsers install chrome`);
  return path.join(cache, newest, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4178);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SHA = 'a'.repeat(40);
const PARENT = 'c'.repeat(40);

const README = '# infinite-agents\n\nThe Workspace and everything under it.\n';
const SOURCE = 'export function checkout() {\n  return reactCheckout();\n}\n';
/** A WIDE picture (640x160, wider than the stage) of square tiles around a circle, not the 1x1
 *  pixel this fixture used to carry. The viewer's job is to keep a picture's
 *  shape, and a square source cannot tell a viewer that keeps it from one
 *  that stretches it — which is exactly how the full-screen viewer shipped
 *  drawing every picture at the stage's height (the owner, note #274). */
const LOGO_WIDTH = 640;
const LOGO_HEIGHT = 160;
const LOGO = 'iVBORw0KGgoAAAANSUhEUgAAAoAAAACgCAIAAAATnEprAAAHjUlEQVR42u3VsXFbQRBEQYYhQ7YCYaCKTwZNBiBXJQsf+IWbne2qy2DubX/8+fpe9X78/LXq2de+9rWvfTPfh4EFbF/72te+9gWwgQVsX/va174ANrCA7Wtf+9rXvgA2sIDt+9/7/v1pX/3aF8AGFrB9b8b1rmdf/doXwAYWsH3fIW6rx/rVL4ANLGD7DkO3A2P96hfABhawfWe7O1Ri/eoXwAYWsH1L3J0lsX71C2ADC9i+hfTmM6xf/QLYwAK2by29yQzrV78ANrCA7VtObybD+tUvgA0sYPuuoDeNYf3qF8AGFrB9F9Gbw7B+9QtgAwvYvuvoTWBYv/oFsIEFbN+9+h40WL/6BbCBBWzfvfQeZFi/+gWwgQVsX/oeMFi/+gWwgQW8fV/uHmFYv/oFsIEFvHpf3J4yWL/6BbCBBbx3X9AeNFi/+gWwgQW8cV++HmdYv/oFsIEFvG5frCYYrF/9AtjAAt61L1BDDNavfgFsYAEv2helOQbrV78ANrCAt+wL0SiD9atfABtYwCv2xWeawfrVL4ANLOD+fcEZaLB+9QtgAwu4fF9kZhqsX/0C2MACbt4XlrEG61e/ADawgGv3xWSywfrVL4ANLGAAewDWr/sMYAML+KZ9ARlusH71C2ADC7hwXzTmG6xf/QLYwAJu2xeKIwzWr34BbGABA9gDsH7dZwAbWMCv7YvDKQbrV78ANrCAe/YF4SCD9atfABtYwAD2AKxf9xnABhbws/sicJbB+tUvgA0s4IZ94TfOYP3qF8AGFjCAPQDr130GsIEFfH1f7E00WL/6BbCBBQxgD8D6dZ8BbGABX9wXeEMN1q9+AWxgAQPYA7B+3WcAG1jAV/ZF3VyD9atfABtYwAD2AKxf9xnABhbww/tCbrTB+nWfAWxgAQPYA7B+3WcAG1jAj+2Lt+kG69d9BrCBBQxgD8D6dZ8BbGABP7Av2AoM1q/7DGADCxjAHoD16z4D2MACBjCA9es+A9jAAg7cF2kdBuvXfQawgQUMYA/A+nWfAWxgAQMYwPp1nwFsYAGn7QuzGoP16z4D2MACBrAHYP26zwA2sIABDGD9us8ANrCAAewBWL/uM4AFvH1fjDUZrF/3GcAGFjCAPQDr130GsIEFDGAA69d9BrCBBQxgD8D6dZ8BDGAAYwzA+nWfAWxgAb93X4CVGaxf9xnABhYwgD0A69d9BrCBBQxgAOvXfQawgQUMYA/A+nWfAQxgAHsA1q/7DGADCxjAHoD16z4DWMAA9gCsX/cZwAYWMIA9AOsXwAYWMIA9AOvXfQawgQUMYADr130GsIEFDGAPwPp1nwFsYAEDGMD6dZ8nAuxD+9Ct+6Kr5unXfa58ABZw877oatJXv+4zgA0sYAB7ANav+wxgAwsYwADWr/sMYAMLGMAegPXrPgPYwAAGGID16z4D2MACBrAHYP26zwAWMIA9AOvXfQawgQUMYA/A+gWwgQUMYA/A+nWfAWxgAQMYwPp1nwFsYAED2AOwft1nABtYwAAGsH7dZwAbWMCB+wKsRl/9us8ANrCAAewBWL/uM4ANLGAAA1i/7jOADSxgAHsA1q/7DGADCxjAANav+wxgAwv40L4Y69BXv+4zgA0sYAB7ANav+wxgAwsYwADWr/sMYAMLGMAegPXrPgPYwAJmcI+++nWfAWxgAQPYA7B+3WcAG1jAAAawft1nABtYwLH7Im26vvp1nwFsYAED2AOwft1nABtYwAAGsH7dZwAbWMDJ+4JttL76dZ8BbGABA9gDsH7dZwAbWMBX9sXbXH31q18AG1jAAPYArF/3GcAGFvDFfSE3VF/96hfABhYwgD0A69d9BrCBBXx9X9RN1Fe/+gWwgQUMYA/A+nWfAWxgAT+1L/DG6atf/QLYwAIGsAdg/brPADawgJ/dF3uz9NWvfgFsYAED2AOwft1nABtYwC/sC79B+upXvwA2sICr9kXgFH31q18AG1jAAPYArF/3GcAGFvDL+4JwhL761S+ADSzgwn1xmK+vfvULYAMLGMAegPXrPgPYwAK+aV8ohuurX/0C2MACrt0Xjcn66le/ADawgJv3BWSsvvrVL4ANLGAAewDWr/sMYAML+O59MZmpr371C2ADC7h/X1gG6qtf/QLYwAJesS8y0/TVr34BbGABb9kXnFH66le/ADawgBfti88cffWrXwAbWMC79oVoiL761S+ADSzgdfuiNEFf/eoXwAYW8MZ9gXpcX/3qF8AGFvDSfbF6Vl/96hfABhbw6n35eoRe/eoXwAYWsH0ZfEZf/eoXwAYWsH0ZfEBf/eoXwAYWsH0x/G569atfABtYwPZl8Bl99atfABtYwPbF8Kd+9WtfABtYwBH70le/+rUvgA0sYAy30atf/QLYwAK271KG7atf+wLYwAKesS969atf+wJYwPbF8Gx69atfABtYwPZdwbB99WtfABtYwD37ole/+rUvgAVsXxKPcVe/+gWwgQVs3zaJ7atf+wLYwALevi909atfABtYwPat8ti++rUvgA0sYPvejLR99WtfABtYwPa1r33ta18AG1jA9rWvfe0LYAML2L72ta997fvv+wtJaD6qQDQD5AAAAABJRU5ErkJggg==';
const PATCH = [
  'diff --git a/src/checkout.ts b/src/checkout.ts',
  'index 1111111..2222222 100644',
  '--- a/src/checkout.ts',
  '+++ b/src/checkout.ts',
  '@@ -1,3 +1,3 @@',
  ' export function checkout() {',
  '-  return legacyCheckout();',
  '+  return reactCheckout();',
  ' }',
].join('\n');

/** The tree, keyed by folder path — the shape the host answers with. */
const TREES: Record<string, unknown> = {
  '': {
    branch: 'main',
    entries: [
      { name: 'src', type: 'dir' },
      { name: 'LICENSE', type: 'file', sizeBytes: 1072 },
      { name: 'README.md', type: 'file', sizeBytes: README.length },
      { name: 'logo.png', type: 'file', sizeBytes: 1990 },
      { name: 'notes.txt', type: 'file', sizeBytes: 2048 },
    ],
  },
  src: { branch: 'main', entries: [{ name: 'checkout.ts', type: 'file', sizeBytes: SOURCE.length }] },
};
const FILES: Record<string, unknown> = {
  LICENSE: { branch: 'main', sizeBytes: 1072, content: 'MIT License\n\nPermission is hereby granted...\n' },
  'README.md': { branch: 'main', sizeBytes: README.length, content: README },
  'notes.txt': { branch: 'main', sizeBytes: 2048, content: 'one\ntwo\nthree\n' },
  'logo.png': { branch: 'main', sizeBytes: 1990, image: { mime: 'image/png', base64: LOGO } },
  'src/checkout.ts': { branch: 'main', sizeBytes: SOURCE.length, content: SOURCE },
};

/** The git host, in memory, behind the REAL client — so the whole wire shape
 *  is exercised rather than mocked at the seam. */
const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
  const route = String(url).replace('http://host', '');
  const body = JSON.parse(init?.body ?? '{}') as { path?: string; sha?: string };
  const answer = (payload: unknown, status = 200) => ({
    ok: status < 400, status, text: async () => JSON.stringify(payload),
  });
  if (route === '/internal/repos/tree') {
    const tree = TREES[body.path ?? ''];
    return tree ? answer(tree) : answer({ error: 'no such folder' }, 409);
  }
  if (route === '/internal/repos/file') {
    const file = FILES[body.path ?? ''];
    return file ? answer(file) : answer({ error: 'no such file' }, 409);
  }
  if (route === '/internal/repos/log') {
    return answer({
      branch: 'main',
      commits: [
        { sha: SHA, authorName: 'Alex', at: new Date(Date.now() - 3600_000).toISOString(), subject: 'Move the checkout to React' },
        { sha: 'b'.repeat(40), authorName: 'Saddam', at: new Date(Date.now() - 7200_000).toISOString(), subject: 'Say so in the docs' },
      ],
    });
  }
  if (route === '/internal/repos/contributors') {
    return answer({
      branch: 'main',
      tipSha: SHA,
      from: null,
      authors: [
        { name: 'Alex', email: 'alex@agents.test', commits: 1204, insertions: 9000, deletions: 400 },
        { name: 'Saddam', email: 'me@example.com', commits: 3, insertions: 12, deletions: 0 },
      ],
    });
  }
  if (route === '/internal/repos/commit') {
    return answer({
      sha: body.sha ?? SHA,
      authorName: 'Alex',
      at: new Date(Date.now() - 3600_000).toISOString(),
      subject: 'Move the checkout to React',
      body: 'The old page goes, one screen at a time.',
      parents: [PARENT],
      diffStat: { files: 1, insertions: 1, deletions: 1 },
      patch: PATCH,
      patchTruncated: false,
    });
  }
  if (route === '/internal/repos/stat') return answer({ sizeBytes: 4096 });
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
const orgStorage = new InMemoryOrgStorage();
// Past the setup gate, or none of the Workspace is mounted: the workplace
// this harness seeds directly would otherwise read as incomplete on every
// state read and hold the whole shell on "Connect your Fly cloud".
harnessEstablishedWorkplace(orgStorage);

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  gitRepoStorage,
  gitPullRequestStorage,
  orgStorage,
  orgGit: new OrgGitService({ orgStorage }),
  gitHostClient: new GitHostClient({
    baseUrl: 'http://host', controlUrl: 'http://host', secret: 's', fetchImpl,
  }),
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
const CONTENT_BOXES = [
  '#repoTitle', '#repoTabs', '#repoCrumb', '#repoBar', '#repoHistory',
  '#repoFilesHead', '#repoTree', '#repoTree .trow',
];
const HOME_BOXES = ['#repos', '#repos .crow', '#repos .crow:last-child', '.repofoot', '#quota'];

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
  const shot = async (name: string) => {
    await page$.screenshot({
      path: path.join(OUT, `n256-repos-${name}.png`) as `${string}.png`, fullPage: true,
    });
    await settleAfterShot(page$);
  };
  const text = (selector: string) => page$.$eval(selector, (node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  const texts = (selector: string) => page$.$$eval(selector, (nodes) => nodes.map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
  /** Boxes measured from the FIRST of them: the shape of a section rather
   *  than its place on a page whose other sections may differ. */
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
  const now = new Date().toISOString();
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(me.telegram ?? {}),
      agents: {
        felix: {
          id: 'felix', name: 'Felix', cli: 'claude', createdAt: now,
          serverId: 'm1', connectedAt: now, lastActivityAt: now,
        },
      } as never,
    },
  });
  const seeded = await gitRepoStorage.create({
    userId: org.orgId,
    name: 'infinite-agents',
    createdByAgentId: 'felix',
    defaultBranch: 'main',
    sizeBytes: 4096,
    lastPushAt: new Date(Date.now() - 1800_000).toISOString(),
    defaultBranchPushAt: new Date(Date.now() - 1800_000).toISOString(),
    contributors: {
      countedAt: now,
      authors: [{ name: 'Felix', email: 'felix@agents.test', commits: 40, insertions: 900, deletions: 40 }],
    },
  } as never);
  // Workplace-scoped since note #566: these belong to the workplace, as Drive
  // does, so their addresses name it and no room.
  const scoped = `org=${encodeURIComponent(org.orgId)}`;

  // 2. Home's Workplace window: the card, the activity line and the storage
  //    the namespace shares. Repositories belong to the workplace (note #566).
  await openWorkplaceWindow(page$, ORIGIN);
  await page$.waitForSelector('#repos .crow', { timeout: 10_000 });
  check('the card lists the repository with what happened lately',
    (await text('#repos .crow .name')) === 'infinite-agents'
    && (await text('#repos .crow .cwhen')).startsWith('· pushed'),
    `${await text('#repos .crow .name')} / ${await text('#repos .crow .cwhen')}`);
  check('the branch is named, because the backend saw a landing on it',
    (await text('#repos .crow .bname')) === 'main');
  check('the storage line says what the whole namespace has used',
    (await text('#quota')).startsWith('Storage: '), await text('#quota'));
  // The key is a line of the card's FOOTER, beside the storage it shares a
  // namespace with — not a row of the list, which is what it used to be
  // (note #360). Two assertions, because the compaction is exactly the
  // difference between them: the list holds repositories and nothing else,
  // and the key sits in the same strip as the storage sentence.
  check('the list holds repositories only — the key is no longer a row of it',
    (await texts('#repos .crow .name')).join(' | ') === 'infinite-agents',
    (await texts('#repos .crow .name')).join(' | '));
  check('the key is a line of the footer, beside what the namespace has used',
    (await text('.repofoot .gitkeytap')) === 'Clone on your computer'
    && (await page$.$eval('.repofoot', (foot) => Boolean(foot.querySelector('#quota')))),
    await text('.repofoot'));
  // The compaction, measured against the thing it used to imitate. The key
  // was a `.crow` — icon column, title, second line — so it stood as tall as
  // a repository. One quiet line is less than half that, and the assertion is
  // written as a RATIO rather than a pixel count so it keeps meaning when the
  // row's own paddings are next tuned.
  const keyVsRow = await page$.evaluate(() => {
    const row = document.querySelector('#repos .crow')!.getBoundingClientRect().height;
    const tap = document.querySelector('.gitkeytap')!.getBoundingClientRect().height;
    return { row: Math.round(row), tap: Math.round(tap) };
  });
  check('…and it is one line, not the two-storey row it replaced',
    keyVsRow.tap * 2 < keyVsRow.row, `key ${keyVsRow.tap}px vs a repository row's ${keyVsRow.row}px`);
  const homeReact = await shape(HOME_BOXES);
  await shot('home');

  // The panel that line opens. It is the same panel it always was; what
  // changed is where it hangs, so the thing worth measuring is that its
  // prose starts on the SAME left edge as the storage sentence above it.
  // Under the old row it was inset by its own 2px against the card's bare
  // edge, which nobody saw because nobody lined the two up before.
  await page$.click('.gitkeytap');
  await page$.waitForFunction(
    () => document.getElementById('gitKeyCard')?.hidden === false, { timeout: 10_000 },
  );
  check('the key line opens the panel it always did, clone line and all',
    (await text('#gitKeyCard .clone')).startsWith('git clone ')
    && (await text('#gitKeyCard .clone')).endsWith('/infinite-agents.git'),
    await text('#gitKeyCard .clone'));
  // No named helper inside `evaluate`: tsx compiles `const left = …` with
  // esbuild's keepNames, which wraps it in a `__name()` that exists in this
  // process and not in the page — a ReferenceError thrown from the browser,
  // pages away from anything the check is about.
  const edges = await page$.evaluate(() => ({
    quota: Math.round(document.querySelector('#quota')!.getBoundingClientRect().left),
    prose: Math.round(document.querySelector('#gitKeyCard .hintline')!.getBoundingClientRect().left),
  }));
  check('…and its prose starts where the storage sentence does',
    edges.quota === edges.prose,
    `#quota at ${edges.quota}, the panel's prose at ${edges.prose}`);
  // The clone address cannot wrap, and a flex item may not be narrower than
  // its own content unless it is told it may. So the panel burst the card
  // and clipped its own prose and button until `min-width: 0` freed it.
  const overflow = await page$.evaluate(() => {
    const foot = document.querySelector('.repofoot') as HTMLElement;
    const line = document.querySelector('#gitKeyCard .clone') as HTMLElement;
    return {
      footGrew: foot.scrollWidth > foot.clientWidth,
      lineScrolls: line.scrollWidth > line.clientWidth,
    };
  });
  check('…and the un-wrappable clone address scrolls itself, never the card',
    !overflow.footGrew && overflow.lineScrolls, JSON.stringify(overflow));
  await shot('home-key');
  // Shut again, so every check below reads the Home this run started from.
  await page$.click('.gitkeytap');
  await page$.waitForFunction(
    () => document.getElementById('gitKeyCard')?.hidden === true, { timeout: 10_000 },
  );

  // 3. The repository: Overview first, then Content behind one tap.
  await page$.click('#repos .crow');
  await page$.waitForSelector('#screenRepo', { timeout: 10_000 });
  check('a row opens the repository at its workplace-scoped address',
    page$.url() === `${ORIGIN}/repositories/infinite-agents?${scoped}`, page$.url());
  check('it opens on Overview, with the code one tap away',
    (await page$.$eval('#repoOverviewTab', (node) => node.getAttribute('aria-selected'))) === 'true'
    && (await page$.$eval('#repoContent', (node) => (node as HTMLElement).hidden)) === true);
  await page$.waitForFunction(() => Boolean(document.querySelector('#repoPeople .crow')), { timeout: 10_000 });
  check('Overview says who has written it, and how many that is',
    (await text('#repoPeople .name')) === '2 contributors', await text('#repoPeople .name'));
  check('…and the delete is here, at the repository, never under a folder',
    (await texts('#repoDanger button')).includes('Delete this repository'),
    (await texts('#repoDanger button')).join(' | '));
  // Publishing is back for admins (note #936): a private repository says so
  // and offers Make public, with the licence rule beside it.
  await page$.waitForFunction(
    () => document.querySelector('#repoPublicAccess .name')?.textContent === 'Private',
    { timeout: 10_000 },
  );
  check('a private repository says private and offers an admin Make public',
    (await texts('.repo-public-actions button')).join(' | ') === 'Make public'
    && (await text('#screenRepo')).includes('non-empty LICENSE file'),
    (await texts('.repo-public-actions button')).join(' | '));
  await shot('overview-private');
  // Publish it in storage, as the server's door does, and read again.
  await gitRepoStorage.update(seeded.id, {
    publicAccess: { id: randomUUID(), publishedAt: new Date().toISOString(), publishedByUserId: me.userId },
  });
  await page$.reload({ waitUntil: 'networkidle0' });
  await page$.waitForFunction(
    () => document.querySelector('#repoPublicAccess .name')?.textContent === 'Public',
    { timeout: 10_000 },
  );
  check('a public repository says public and offers Make private',
    (await texts('.repo-public-actions button')).join(' | ') === 'Make private',
    (await texts('.repo-public-actions button')).join(' | '));
  const publicActionEdge = await page$.evaluate(() => ({
    button: Math.round(document.querySelector('.repo-public-actions button')!.getBoundingClientRect().left),
    card: Math.round(document.querySelector('#repoPublicAccess')!.getBoundingClientRect().left),
  }));
  check('the Make private action starts on the repository column’s left edge',
    Math.abs(publicActionEdge.button - publicActionEdge.card) <= 1,
    JSON.stringify(publicActionEdge));
  const repositoryTextEdges = await page$.evaluate(() => {
    const edges: Record<string, number> = {
      action: Math.round(document.querySelector('.repo-public-actions button')!.getBoundingClientRect().left),
    };
    for (const [name, selector] of [
      ['roomHint', '#repoRoomHint'],
      ['dangerHint', '#repoDanger .hintblock'],
    ]) {
      const root = document.querySelector(selector)!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode();
      while (text && !text.textContent?.trim()) text = walker.nextNode();
      if (!text) { edges[name] = NaN; continue; }
      const start = text.textContent!.search(/\S/);
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + 1);
      edges[name] = Math.round(range.getBoundingClientRect().left);
    }
    return edges;
  });
  check('all repository settings text starts on one left edge',
    Object.values(repositoryTextEdges).every((left) => left === repositoryTextEdges.action),
    JSON.stringify(repositoryTextEdges));
  const publicUrl = await page$.$eval('.repo-public-link a', (node) => (node as HTMLAnchorElement).href);
  check('it hands over its one link',
    /^http:\/\/127\.0\.0\.1:\d+\/public\/repositories\/[0-9a-f-]{36}$/.test(publicUrl),
    publicUrl);
  const heads: Record<string, string> = { repository: await headShape(page$) };
  await shot('overview');

  // The link's other side: no account UI, no private repository facts, just
  // source browsing and the anonymous clone address.
  const publicResponse = await page$.goto(publicUrl, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#publicRepoTree .trow', { timeout: 10_000 });
  check('the link-only page tells search engines not to index or follow it',
    publicResponse?.headers()['x-robots-tag']?.includes('noindex') === true,
    publicResponse?.headers()['x-robots-tag'] ?? 'no header');
  // The heading carries the name and the word "Public" beside it (2026-09-27).
  check('the public link opens without a Workspace gate',
    (await text('#publicRepo h1')).replace(/Public$/, '').trim() === 'infinite-agents'
    && (await text('#publicRepoBadge')) === 'Public'
    && (await page$.$$('#authGate')).length === 0,
    await text('#publicRepo h1'));
  check('the public page carries source, its licence and the anonymous clone URL',
    (await texts('#publicRepoTree .tname')).includes('LICENSE')
    && (await text('.public-repo-clone code')).endsWith('/infinite-agents.git'),
    `${(await texts('#publicRepoTree .tname')).join(' | ')} / ${await text('.public-repo-clone code')}`);
  await shot('n665-public-page');
  await page$.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const publicDesktop = await page$.$eval('#webMain', (node) => {
    const box = node.getBoundingClientRect();
    return { width: Math.round(box.width), left: Math.round(box.left), right: Math.round(innerWidth - box.right) };
  });
  check('the public page stays one centred reading column on a desk',
    publicDesktop.width <= 720 && Math.abs(publicDesktop.left - publicDesktop.right) <= 1,
    JSON.stringify(publicDesktop));
  await shot('n665-public-page-desktop');
  await page$.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });

  // Return to the signed-in repository for the explorer checks below.
  await page$.goto(`${ORIGIN}/repositories/infinite-agents?${scoped}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#repoOverviewTab', { timeout: 10_000 });

  // 4. Content: the tree, the branch bar and the newest commit above it.
  await page$.click('#repoContentTab');
  await page$.waitForSelector('#repoTree .trow', { timeout: 10_000 });
  check('the listing puts folders first, then everything else alphabetically',
    (await texts('#repoTree .tname')).join(' | ') === 'src/ | LICENSE | logo.png | notes.txt | README.md',
    (await texts('#repoTree .tname')).join(' | '));
  check('the toolbar names the branch these files came from',
    (await text('#repoBranch')) === 'main');
  check('the newest commit sits above the files, not in a register of its own',
    (await text('#repoHistory .tname')) === 'Move the checkout to React',
    await text('#repoHistory .tname'));
  check('a tab is not a place: choosing Content spends no history entry',
    page$.url() === `${ORIGIN}/repositories/infinite-agents?${scoped}`, page$.url());
  const contentReact = await shape(CONTENT_BOXES);
  await shot('content');

  // 5. A folder is the same place with a path, and the crumb walks back out.
  await page$.evaluate(() => {
    const rows = [...document.querySelectorAll('#repoTree .trow')];
    (rows.find((row) => row.textContent?.startsWith('src/')) as HTMLElement).click();
  });
  await page$.waitForFunction(
    () => document.querySelector('#repoCrumb .here')?.textContent === 'src', { timeout: 10_000 },
  );
  check('a folder writes its own address and restores Content',
    page$.url() === `${ORIGIN}/repositories/infinite-agents?${scoped}&path=src`
    && (await page$.$eval('#repoContent', (node) => (node as HTMLElement).hidden)) === false,
    page$.url());
  check('the root-only cards do not hang over a folder’s listing',
    (await page$.$$('#repoDanger button')).length === 0);
  await page$.click('#repoCrumb button.seg');
  // TWO things come back here, and not in the same paint: the crumb's label
  // flips the moment the route does, while the root listing is fetched
  // again. Waiting on the label alone landed in the beat where the tree is
  // empty and failed this check about one run in three on a busy machine —
  // a flake that was never about the crumb. Wait for both.
  // The timeout is swallowed ON PURPOSE, and only here: it becomes THIS
  // check's own FAIL, which is the honest report, rather than an exception
  // that takes the rest of the run down with it.
  const walkedBack = await page$
    .waitForFunction(
      () => document.querySelector('#repoCrumb .here')?.textContent === 'infinite-agents'
        && Boolean(document.querySelector('#repoTree .trow')),
      { timeout: 10_000 },
    )
    .then(() => true, () => false);
  check('the crumb walks back out to the repository', walkedBack);

  // 6. One file: numbered code, and the markdown toggle.
  await page$.goto(`${ORIGIN}/repositories/infinite-agents/file?${scoped}&path=src%2Fcheckout.ts`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#fileBody .code', { timeout: 10_000 });
  check('a code file is numbered, line for line',
    (await text('.code .gutter')) === '1 2 3', await text('.code .gutter'));
  check('its crumb keeps every folder above it a tap, and carries the size',
    (await texts('#fileSub button.seg')).join('/') === 'infinite-agents/src'
    && (await text('#fileSub')).includes('B'),
    `${(await texts('#fileSub button.seg')).join('/')} / ${await text('#fileSub')}`);
  heads.file = await headShape(page$);
  // The crumb is this screen's sub line, so it belongs to the header with the
  // name it qualifies — not to the body, above its first card.
  check('…and that crumb is the header’s own line', Boolean(await page$.$('#pageHead #fileSub')));
  await shot('file');

  await page$.goto(`${ORIGIN}/repositories/infinite-agents/file?${scoped}&path=README.md`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#fileBody .md, #fileBody .mdwrap', { timeout: 10_000 });
  check('a markdown file is rendered, and hands back its source on request',
    (await text('.filebar .kind')) === 'Markdown');
  await page$.click('.filebar .act');
  await page$.waitForFunction(
    () => document.querySelector('.filebar .kind')?.textContent === 'Markdown source', { timeout: 10_000 },
  );
  check('…and the raw view is the file, character for character',
    (await text('.code .lines')).includes('# infinite-agents'));

  // 7. An image, and the full-screen viewer this slice finally moved.
  await page$.goto(`${ORIGIN}/repositories/infinite-agents/file?${scoped}&path=logo.png`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#fileBody img', { timeout: 10_000 });
  check('an image is shown as a picture, off the bytes the host decoded',
    (await page$.$eval('#fileBody img', (node) => node.getAttribute('src') ?? '')).startsWith('data:image/png'));
  await page$.click('#fileBody img');
  await page$.waitForSelector('#imageViewer', { timeout: 10_000 });
  check('a tap opens it full screen — the viewer slices 4, 5 and 6 all deferred',
    (await text('#imageViewerName')) === 'logo.png', await text('#imageViewerName'));
  check('a single picture gets no step controls, which leaves the bar its three',
    (await page$.$$('#imageViewerPrev')).length === 0 && (await page$.$$('#imageZoomIn')).length === 1);

  // The picture's SHAPE, measured as PAINTED pixels rather than as the
  // element's box: `object-fit` decides which of the two the reader actually
  // sees, so a check that reads only the box passes a viewer that stretches
  // its contents to fill it — which is the bug this replaced (note #274).
  const picture = () => page$.$eval('#imageViewer img', (node) => {
    const img = node as HTMLImageElement;
    const box = img.getBoundingClientRect();
    const stage = document.querySelector('#imageViewerStage')!.getBoundingClientRect();
    // `contain` letterboxes inside the box; every other value paints the
    // whole box, and is therefore as wrong as the box is.
    const scale = getComputedStyle(img).objectFit === 'contain'
      ? Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight)
      : 0;
    return {
      width: scale ? img.naturalWidth * scale : box.width,
      height: scale ? img.naturalHeight * scale : box.height,
      natural: img.naturalWidth / img.naturalHeight,
      stage: { width: stage.width, height: stage.height },
    };
  });
  const painted = await picture();
  check('the picture keeps its own shape — the viewer never stretches it',
    Math.abs(painted.width / painted.height - painted.natural) < 0.02,
    `drawn ${Math.round(painted.width)}x${Math.round(painted.height)} `
    + `(ratio ${(painted.width / painted.height).toFixed(2)}, the picture's own is ${painted.natural.toFixed(2)})`);
  check('…and is fitted inside the stage rather than overflowing it',
    painted.width <= painted.stage.width + 1 && painted.height <= painted.stage.height + 1,
    `drawn ${Math.round(painted.width)}x${Math.round(painted.height)} `
    + `in a stage of ${Math.round(painted.stage.width)}x${Math.round(painted.stage.height)}`);
  check('…having been scaled DOWN to get there, which is the case that broke',
    painted.width < LOGO_WIDTH, `drawn ${Math.round(painted.width)}px wide from ${LOGO_WIDTH}px`);
  await shot('viewer');

  // Note #561: the name in the head can be selected by hand, although the
  // viewer around it refuses selection (a drag on the stage pans), and the
  // icon beside it copies the whole name in one tap.
  check('the viewer still refuses selection, so a drag on the stage pans',
    (await page$.$eval('#imageViewer', (node) => getComputedStyle(node).userSelect)) === 'none');
  const nameBox = await page$.$eval('#imageViewerName', (node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, y: box.top + box.height / 2 };
  });
  await page$.mouse.move(nameBox.left + 1, nameBox.y);
  await page$.mouse.down();
  await page$.mouse.move(nameBox.right - 1, nameBox.y, { steps: 6 });
  await page$.mouse.up();
  const selected = await page$.evaluate(() => window.getSelection()?.toString() ?? '');
  check('a drag across the file name in the head selects it', selected === 'logo.png', JSON.stringify(selected));
  await page$.evaluate(() => window.getSelection()?.removeAllRanges());
  const copyBox = await page$.$eval('#imageViewerNameCopy', (node) => {
    const box = node.getBoundingClientRect();
    const name = document.querySelector('#imageViewerName')!.getBoundingClientRect();
    return { gap: box.left - name.right, height: box.height };
  });
  check('the copy icon sits right after the name, and is a thumb tall',
    copyBox.gap >= 0 && copyBox.gap <= 4 && copyBox.height >= 44, JSON.stringify(copyBox));
  await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  await page$.evaluate(() => navigator.clipboard.writeText('before'));
  await page$.click('#imageViewerNameCopy');
  await page$.waitForFunction(
    () => document.querySelector('#imageViewerNameCopy')?.getAttribute('aria-label') === 'Copied logo.png', { timeout: 5_000 },
  ).catch(() => {});
  check('a tap on it puts the file name on the clipboard',
    (await page$.evaluate(() => navigator.clipboard.readText())) === 'logo.png');
  check('…and the icon itself says so, above the page a toast would hide under',
    (await page$.$eval('#imageViewerNameCopy', (node) => node.getAttribute('aria-label'))) === 'Copied logo.png');
  // The pointer is still over the icon here, which is exactly when a hover
  // plate would show: the tick stands on nothing (the owner, on #1024).
  check('…standing on no plate, even with the pointer still over it',
    (await page$.$eval('#imageViewerNameCopy', (node) => getComputedStyle(node).backgroundColor)) === 'rgba(0, 0, 0, 0)',
    await page$.$eval('#imageViewerNameCopy', (node) => getComputedStyle(node).backgroundColor));
  await shot('viewer-name-copied');

  // Zoom moves the box the fit produced; it must not reshape it.
  await page$.click('#imageZoomIn');
  await page$.waitForFunction(
    () => document.querySelector('#imageZoomReset')?.textContent !== 'Fit', { timeout: 10_000 },
  );
  const enlarged = await picture();
  check('zooming in enlarges the picture without reshaping it',
    enlarged.width > painted.width
    && Math.abs(enlarged.width / enlarged.height - enlarged.natural) < 0.02,
    `drawn ${Math.round(enlarged.width)}x${Math.round(enlarged.height)} `
    + `(ratio ${(enlarged.width / enlarged.height).toFixed(2)})`);
  await page$.click('#imageZoomReset');
  await page$.waitForFunction(
    () => document.querySelector('#imageZoomReset')?.textContent === 'Fit', { timeout: 10_000 },
  );

  await page$.keyboard.press('Escape');
  await page$.waitForFunction(() => !document.querySelector('#imageViewer'), { timeout: 10_000 });
  check('Escape closes it and gives the screen back', Boolean(await page$.$('#fileBody img')));

  // The space beside the picture is a way out again. It is only reachable
  // now that the fitted picture no longer has a stage-wide rail over it —
  // the tap was landing on that rail and being ignored (note #274).
  await page$.click('#fileBody img');
  await page$.waitForSelector('#imageViewer', { timeout: 10_000 });
  const stage = await page$.$eval('#imageViewerStage', (node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + 24 };
  });
  await page$.mouse.click(stage.x, stage.y);
  check('a tap on the space beside the picture closes it too',
    await page$.waitForFunction(() => !document.querySelector('#imageViewer'), { timeout: 5_000 })
      .then(() => true, () => false));

  // 8. The history and one commit's diff.
  await page$.goto(`${ORIGIN}/repositories/infinite-agents/history?${scoped}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#commitsList .crow', { timeout: 10_000 });
  check('the history lists subject, who, when and the short sha',
    (await text('#commitsList .crow .name')) === 'Move the checkout to React'
    && (await text('#commitsList .crow .cside.sha')) === 'aaaaaaa',
    `${await text('#commitsList .crow .name')} / ${await text('#commitsList .crow .cside.sha')}`);
  await page$.click('#commitsList .crow');
  await page$.waitForSelector('.difffile', { timeout: 10_000 });
  check('a row opens that commit’s own diff, through the shared renderer',
    (await text('.diffpath')) === 'src/checkout.ts', await text('.diffpath'));
  // Read WITHOUT collapsing whitespace: a diff's leading spaces are the
  // thing being checked, and `text()` above squeezes them for comparison.
  const removed = await page$.$$eval('.difflines .del', (nodes) => nodes.map((n) => n.textContent ?? '').join(''));
  check('the removed line is there, byte for byte',
    removed === '-  return legacyCheckout();', JSON.stringify(removed));
  heads.commit = await headShape(page$);
  await shot('commit');

  // 9. Everyone who has written it.
  await page$.goto(`${ORIGIN}/repositories/infinite-agents/contributors?${scoped}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#contributorsList .crow', { timeout: 10_000 });
  check('the list carries the address git knows each of them by',
    (await texts('#contributorsList .bname')).join(' | ') === 'alex@agents.test | me@example.com',
    (await texts('#contributorsList .bname')).join(' | '));
  check('…and the two numbers, thousands separated',
    (await text('#contributorsList .crow .cwhen')) === '1,204 commits',
    await text('#contributorsList .crow .cwhen'));
  heads.contributors = await headShape(page$);
  check('every one of these screens wears the SAME header, closed with one rule',
    Object.values(heads).every((shape) => shape === ONE_HEADER), JSON.stringify(heads));
  await shot('contributors');

  // 9b. A repository that is not this workplace's (note #671): a link to
  // another workplace's private one answers exactly as a name nobody ever
  // used, and the screen says so in words rather than two tabs over nothing.
  await page$.goto(`${ORIGIN}/repositories/someone-elses?${scoped}`, { waitUntil: 'networkidle0' });
  const missingSays = await page$.waitForSelector('#repoMissing', { timeout: 10_000 })
    .then(() => text('#repoMissing'), () => '');
  check('a repository that is not here says so, with where the reader looked',
    missingSays.startsWith('There is no repository called “someone-elses” in '), missingSays);
  check('…and draws no tabs over nothing', !(await page$.$('#repoTabs')));
  await shot('missing');

  // 10. THE SAME REPOSITORY in the classic Workspace.
  await page$.goto(`${ORIGIN}/repositories/infinite-agents?${scoped}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#repoTree .trow, #repoOverviewTab', { timeout: 10_000 });
  await page$.click('#repoContentTab');
  await page$.waitForSelector('#repoTree .trow', { timeout: 10_000 });
  const reactSays = {
    title: await text('#repoTitle'),
    tabs: (await texts('#repoTabs .segtab')).join(' | '),
    crumb: await text('#repoCrumb'),
    branch: await text('#repoBranch'),
    latest: await text('#repoHistory .tname'),
    files: (await texts('#repoTree .tname')).join(' | '),
    sizes: (await texts('#repoTree .tsize')).join(' | '),
    shape: await shape(CONTENT_BOXES),
  };
  check('the Content panel says what it should', Object.values(reactSays).every(Boolean), JSON.stringify(reactSays));
  check('Home’s repository card and the Content panel keep their geometry', Boolean(homeReact) && Boolean(contentReact), `${homeReact} / ${contentReact}`);

  // A signed-out session read is a 401 by design, a missing folder a 404, and
  // `/checks` is a 503 here on purpose: this fixture has no commit-status
  // store, which is exactly the "CI is not available on this backend" state
  // the Actions card is supposed to stay silent about. Step 9b's repository
  // is a 404 on every read, which is the point of it.
  const unexpected = consoleErrors.filter((line) => !/status of (400|401|404|409|503)|\b(401|503) |favicon\.ico|^404 \S*\/api\/repos\/someone-elses\//.test(line));
  check('no unexpected console errors', unexpected.length === 0, unexpected.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
