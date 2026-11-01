// Drives note #526 in real Chrome: the public site's root address, served the
// way Cloudflare Pages serves it, in front of a real Workspace router with an
// in-memory auth service — so the cookies the front page reads are cookies a
// genuine sign-in set, not a jar written by the test.
//
// It checks the whole rule: signed out the landing page is served untouched;
// signed in the root address lands on the Workspace instead; `?stay` and every
// other public address are left alone; and a session revoked from elsewhere
// heals itself on the first bounce rather than locking its owner out of the
// public page. Screenshots land in ~/mini-preview/n526-*.png.
// Since 2026-10-10 Home (/) is the Chief of Staff's conversation (note #715);
// only an account with no workplace still draws the one-column overview at /,
// so the setup gate, Home or that overview all count as the Workspace opening.
//
//   npm run build && (cd backend && npm run build:workspace-ui)
//   backend/node_modules/.bin/tsx scripts/verify-front-page-redirect.mts
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import { routesToBackend } from '../functions/[[path]].js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { MailboxService } from '../backend/src/services/mailbox-service.js';
import { SqliteMailboxStorage } from '../backend/src/services/sqlite/sqlite-mailbox-storage.js';
import { openSqliteDb } from '../backend/src/services/sqlite/sqlite-db.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const DIST = path.join(REPO, 'dist');
if (!existsSync(path.join(DIST, 'index.html'))) throw new Error('run `npm run build` first — dist/index.html is missing');
const PORT = Number(process.env.PORT || 4179);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MAILBOX = 'front-page-harness';
const PASSWORD = 'harness-password-47';

const userStorage = new InMemoryUserStorage();
const mailboxStorage = new SqliteMailboxStorage(openSqliteDb(':memory:'));
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  undefined,
  {
    workspaceUrl: `${ORIGIN}/`,
    sender: { sendVerification: async () => { /* nothing is emailed by account creation */ } },
  },
  new MailboxService(mailboxStorage),
);
const deps = {
  userStorage,
  mailboxes: new MailboxService(mailboxStorage),
  workspaceWebAuth,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
} as RouteDeps;

const app = express();
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
// The shell itself answers at the root of the domain (public-addresses), and
// the edge decides who gets it there: the Pages Function's own rule, run here
// in front of the root routes so the harness tests the decision that ships.
const rootRoutes = workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir });
app.use((req, res, next) => (routesToBackend(req.path, req.headers.cookie, new URL(req.originalUrl, ORIGIN).search) ? rootRoutes(req, res, next) : next()));
// Cloudflare Pages, in miniature: a prerendered route is its own directory's
// index.html, an asset is itself, and anything else falls back to the SPA
// shell with a 200 — which is exactly why the inline script tests the path.
app.use(express.static(DIST, { redirect: false }));
app.use((req, res) => {
  const nested = path.join(DIST, req.path, 'index.html');
  res.sendFile(nested.startsWith(DIST) && existsSync(nested) ? nested : path.join(DIST, 'index.html'));
});
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
  await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 2 });
  // The film stands on the front page's first screen since note #199 took
  // the hero off, and it starts playing the moment it is on screen: a
  // streaming video keeps a request open, so 'networkidle0' never came and
  // every open('/') below timed out. This check is about where the browser
  // comes to rest, not the film, so it asks for reduced motion, which keeps
  // the film on its first frame and fetches nothing (LandingFilm).
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  const shot = async (name: string) => {
    // The Workspace shell restores scroll per route; a screenshot wants the
    // top of whichever container is actually holding it.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      for (const node of document.querySelectorAll('*')) if (node.scrollTop) node.scrollTop = 0;
    });
    await page.screenshot({ path: path.join(OUT, `n526-${name}.png`) as `${string}.png` });
  };
  /** Open an address and report where the browser actually came to rest. */
  const open = async (at: string): Promise<string> => {
    await page.goto(`${ORIGIN}${at}`, { waitUntil: 'networkidle0' });
    return new URL(page.url()).pathname + new URL(page.url()).search;
  };
  const landingHeadline = async () => page.$eval('h1', (node) => node.textContent?.trim() ?? '').catch(() => '');

  // 1. Signed out, the front page is the front page. No session, no cookie,
  //    nothing fetched to find that out.
  check('signed out, the root address serves the landing page', await open('/') === '/');
  check('the landing page rendered its headline', (await landingHeadline()).length > 0, await landingHeadline());
  await shot('signed-out-landing');

  // 2. A real sign-in, through the Workspace's own door.
  await page.goto(`${ORIGIN}/signup`, { waitUntil: 'networkidle0' });
  await page.type('#authFirstName', 'Saddam');
  await page.type('#authLastName', 'Baialiev');
  await page.type('#authMailbox', MAILBOX);
  await page.type('#authPassword', PASSWORD);
  await page.type('#authPasswordConfirm', PASSWORD);
  await page.waitForFunction(
    () => !(document.querySelector('#authEmailButton') as HTMLButtonElement | null)?.disabled,
    { timeout: 10_000 },
  );
  await page.click('#authEmailButton');
  // The workplace comes with the account (note #144) and stands behind its
  // setup gate until its cloud is in: the Workspace opened, on that step.
  await page.waitForSelector('#requiredSetup, #screenHome, #screenOverview', { timeout: 15_000 });
  check('the account was created and the Workspace opened', Boolean(await page.$('#requiredSetup, #screenHome, #screenOverview')));
  const jar = await page.cookies();
  check('the browser holds a readable CSRF cookie beside the HttpOnly session',
    jar.some((cookie) => cookie.name === 'acc_csrf' && !cookie.httpOnly)
    && jar.some((cookie) => cookie.name === 'acc_session' && cookie.httpOnly));

  // 3. The rule itself.
  check('signed in, the root address lands on the Workspace', await open('/') === '/');
  check('it is the Workspace that drew, not the landing page', Boolean(await page.$('#requiredSetup, #screenHome, #screenOverview')));
  await shot('signed-in-workspace');
  check('the root address left no history entry to bounce off',
    await page.evaluate(() => location.pathname) === '/');

  // 4. Everything the rule does NOT cover.
  check('?stay opens the front page anyway', await open('/?stay') === '/?stay');
  check('and it really is the landing page', (await landingHeadline()).length > 0);
  await shot('signed-in-stay');
  for (const other of ['/terms', '/privacy', '/teams']) {
    check(`${other} is untouched while signed in`, await open(other) === other);
  }

  // 5. A session revoked from another device leaves the readable cookie
  //    behind. The first bounce must be the last one.
  const sessionToken = (await page.cookies()).find((cookie) => cookie.name === 'acc_session')?.value ?? '';
  const userId = (await workspaceWebAuth.authenticateSession(sessionToken))?.userId ?? '';
  check('the harness found the account it just made', Boolean(userId));
  await workspaceWebAuth.revokeAllSessions(userId);
  check('a revoked session still bounces once', await open('/') === '/');
  await page.waitForFunction(() => !document.cookie.includes('acc_csrf='), { timeout: 10_000 })
    .catch(() => {});
  check('the Workspace took the stale cookies back',
    !(await page.cookies()).some((cookie) => cookie.name === 'acc_csrf' || cookie.name === 'acc_session'));
  check('and the front page is reachable again', await open('/') === '/');
  check('showing the landing page', (await landingHeadline()).length > 0);
  await shot('healed-landing');

  // 6. The same must hold for the half-jar: the CSRF cookie is the one the
  //    front page reads, so a browser that kept it and lost the session is
  //    exactly the browser that would bounce forever.
  await browser.setCookie({ name: 'acc_csrf', value: 'left-behind', domain: '127.0.0.1', path: '/' });
  check('a CSRF cookie with no session behind it bounces once', await open('/') === '/');
  await page.waitForFunction(() => !document.cookie.includes('acc_csrf='), { timeout: 10_000 })
    .catch(() => {});
  check('the Workspace took that one back too',
    !(await page.cookies()).some((cookie) => cookie.name === 'acc_csrf'));
  check('and the front page is reachable after it', await open('/') === '/');
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
