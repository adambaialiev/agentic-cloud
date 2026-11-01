// Drives the React Workspace shell's sign-in flows in real Chrome against a
// real backend router with an in-memory auth service: create access by email
// and password,
// opt into an authenticator second factor (a TOTP computed from the secret the
// page shows), save recovery codes, land on Home, sign out, sign back in with
// both factors, then recover. Screenshots land in
// ~/mini-preview/n256-*.png.
// Since 2026-10-10 Home (`/`) is the Chief of Staff's conversation (note
// #715); only an account with no workplace still draws the one-column
// overview (`#screenOverview`) there.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-react-auth.mts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { generateTotpCode } from '../backend/src/utils/totp.js';
import type { WorkspaceVerificationEmail } from '../backend/src/services/workspace-verification-email.js';
import { MailboxService } from '../backend/src/services/mailbox-service.js';
import { SqliteMailboxStorage } from '../backend/src/services/sqlite/sqlite-mailbox-storage.js';
import { openSqliteDb } from '../backend/src/services/sqlite/sqlite-db.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
// express lives in backend/node_modules; puppeteer-core in the root's.
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
/** Whichever Chrome puppeteer last installed here; the build number moves. */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'harness-password-47';
const MAILBOX = 'saddam';
const ADDRESS = `${MAILBOX}@agenticcloudcomputer.com`;


const userStorage = new InMemoryUserStorage();
const sentVerificationEmails: WorkspaceVerificationEmail[] = [];
// The links the door mails out for a recovery address and a forgotten
// password; the harness follows them in the same browser.
const sentAuthLinks: string[] = [];
const RECOVERY_EMAIL = 'saddam.recovery@example.com';
const NEW_PASSWORD = 'harness-password-48-reset';
const mailboxStorage = new SqliteMailboxStorage(openSqliteDb(':memory:'));
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  undefined,
  {
    workspaceUrl: `${ORIGIN}/`,
    sender: {
      sendVerification: async (message) => { sentVerificationEmails.push(message); },
      sendPasswordReset: async (message) => { sentAuthLinks.push(message.resetUrl); },
      sendRecoveryConfirmation: async (message) => { sentAuthLinks.push(message.confirmUrl); },
    },
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
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `n256-${name}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  };
  const heading = async () => page.$eval('#webMain h2, #webMain h1', (node) => node.textContent?.trim() ?? '').catch(() => '');
  const waitHeading = async (text: string) => {
    await page.waitForFunction(
      (want: string) => [...document.querySelectorAll('#webMain h2')].some((node) => node.textContent?.trim() === want),
      { timeout: 10_000 },
      text,
    ).catch(() => {});
    return (await page.$$eval('#webMain h2', (nodes) => nodes.map((node) => node.textContent?.trim())))
      .includes(text);
  };
  // Home is the Chief of Staff's conversation (`#screenHome`, since
  // 2026-10-10) — but this harness has no workplace store, and without a
  // workplace `/` draws the one-column overview (`#screenOverview`, HomeScreen.tsx),
  // whose fleet heading is the sign it opened. "Home" for a brand-new
  // account may also be the Workspace opened on its setup gate (note #144).
  // Any of these roots proves the session opened the Workspace.
  const waitHome = async () => {
    await page.waitForSelector('#screenOverview #agentsSection, #screenHome, #requiredSetup', { timeout: 10_000 }).catch(() => {});
    return Boolean(await page.$('#screenOverview #agentsSection, #screenHome, #requiredSetup'));
  };

  // 1. Create the account the only way there is (note #509): a name on our
  // own mail domain and a password. Nothing is emailed and nobody waits —
  // the address IS the account, so the session opens on the answer.
  await page.goto(`${ORIGIN}/signup`, { waitUntil: 'networkidle0' });
  check('signup opens on account creation', await waitHeading('Create your account'), await heading());
  // The account screens carry no card since 2026-09-18: a field is a plate
  // of its own, 16px round, which only the Workspace stylesheet gives it.
  check('the Workspace stylesheet is applied', await page.$eval('.authplates .authfield', (node) => getComputedStyle(node).borderTopLeftRadius) !== '0px');
  check('no outside email is asked for', (await page.$('#authEmail')) === null);
  // The mark leads home to the landing page (the owner, 2026-09-29).
  check('the signup mark links home', await page.$eval('#authGate .setuphead #authHome', (node) => node.getAttribute('href')).catch(() => null) === '/');
  await shot('signup');
  // Their own name comes first on the card (note #144).
  await page.type('#authFirstName', 'Saddam');
  await page.type('#authLastName', 'Baialiev');
  await page.type('#authMailbox', MAILBOX);
  await page.type('#authPassword', PASSWORD);
  await page.type('#authPasswordConfirm', PASSWORD);
  await page.waitForFunction(
    () => !(document.querySelector('#authEmailButton') as HTMLButtonElement | null)?.disabled,
    { timeout: 10_000 },
  ).catch(() => {});
  check('the address reads as free', (await page.$eval('#authMailboxNote', (node) => node.textContent ?? '')).includes('is yours'));
  // Note #663: the typed name stays in the code face, but the masked fields
  // do not — a monospace dot fills its whole cell and the dots ran together.
  const faces = await page.$$eval('#authMailbox, #authPassword, #authPasswordConfirm', (nodes) => nodes.map((node) => getComputedStyle(node).fontFamily));
  const pageFace = await page.$eval('body', (node) => getComputedStyle(node).fontFamily);
  check('the address is set in the code face', /monospace/.test(faces[0] ?? ''), faces[0]);
  check('the password fields keep the page face, so their dots do not touch',
    faces.slice(1).every((face) => !/monospace/.test(face) && face === pageFace), faces.slice(1).join(' | '));
  await shot('signup-address');
  await page.click('#authEmailButton');
  check('creating the account opens the Workspace at once', await waitHome());
  check('nothing was emailed', sentVerificationEmails.length === 0, String(sentVerificationEmails.length));
  check('body carries browser-authenticated', await page.$eval('body', (node) => node.classList.contains('browser-authenticated')));
  await shot('overview');

  // 2. Settings shows the address as the account's own, and authenticator
  // security is an explicit opt-in there.
  await page.goto(`${ORIGIN}/profile`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#profileMailCard', { timeout: 10_000 }).catch(() => {});
  check('Settings names the address this account was created with',
    (await page.$eval('#profileMailCard', (node) => node.textContent ?? '').catch(() => '')).includes(ADDRESS));
  check('there is no outside email ownership row to confirm',
    !(await page.$eval('#profileAccessCard', (node) => node.textContent ?? '').catch(() => '')).includes('Email ownership'));
  await page.waitForFunction(() => [...document.querySelectorAll('#profileAccessCard button')]
    .some((node) => node.textContent?.includes('Authenticator security')));
  const accessButtons = await page.$$('#profileAccessCard button');
  for (const button of accessButtons) {
    if ((await button.evaluate((node) => node.textContent ?? '')).includes('Authenticator security')) {
      await button.click(); break;
    }
  }
  check('authenticator setup appears', await waitHeading('Add authenticator security'));
  const secret = await page.$eval('.authsecret', (node) => node.textContent?.trim() ?? '');
  check('a setup key is shown', secret.length > 10);
  check('a QR is shown', (await page.$eval('#profileTotpSetup .authqr', (img) => (img as HTMLImageElement).src)).startsWith('data:image/png'));
  await shot('setup');
  await page.type('#profileTotpSetup .authotp', generateTotpCode(secret));
  await page.click('#profileTotpSetup .formcommit');
  check('recovery codes appear', await waitHeading('Save your recovery codes'));
  const codes = await page.$$eval('#profileTotpCodes .recoverygrid > div', (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''));
  check('ten recovery codes', codes.length === 10, String(codes.length));
  await shot('codes');
  await page.click('#profileTotpCodes .btn.primary');

  // 2b. A recovery email is the ONE way back after a forgotten password, and
  // it counts only once its owner opens our link. Until then Settings says
  // there is none.
  await page.goto(`${ORIGIN}/profile`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#profileAccessCard .recoveryrow', { timeout: 10_000 });
  check('Settings says there is no recovery email yet',
    (await page.$eval('#profileAccessCard .recoveryrow', (node) => node.textContent ?? '')).includes('None'));
  await page.click('#profileAccessCard .recoveryrow');
  check('the recovery email form opens', await waitHeading('Add a recovery email'));
  await page.type('#profileRecoveryEmail', RECOVERY_EMAIL);
  await page.click('#profileRecoverySend');
  await page.waitForFunction(() => document.querySelector('#profileAccessCard .recoveryrow')?.textContent?.includes('not confirmed yet'), { timeout: 10_000 }).catch(() => {});
  check('the row says the address is waiting on its link',
    (await page.$eval('#profileAccessCard .recoveryrow', (node) => node.textContent ?? '')).includes('not confirmed yet'));
  check('one confirmation link was mailed', sentAuthLinks.length === 1, String(sentAuthLinks.length));
  await shot('recovery-pending');
  await page.goto(sentAuthLinks[0]!, { waitUntil: 'networkidle0' });
  check('the link confirms the recovery email', await waitHeading('Recovery email confirmed'));
  check('the confirmation names the address',
    (await page.$eval('#authRecoveryConfirm', (node) => node.textContent ?? '')).includes(RECOVERY_EMAIL));
  await shot('recovery-confirmed');
  await page.goto(`${ORIGIN}/profile`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#profileAccessCard .recoveryrow', { timeout: 10_000 });
  const recoveryRow = await page.$eval('#profileAccessCard .recoveryrow', (node) => node.textContent ?? '');
  check('Settings now shows the confirmed recovery email',
    recoveryRow.includes(RECOVERY_EMAIL) && !recoveryRow.includes('not confirmed'), recoveryRow);

  // 3. A named route opens its own screen; an old ?ui= link is cleaned.
  await page.goto(`${ORIGIN}/repositories/infinite-agents?org=o1`, { waitUntil: 'networkidle0' });
  // Since note #282 the screen does not draw its own heading: it fills the
  // one header's slot. So the SCREEN is what `#screenRepo` proves, and the
  // name is read where the reader actually sees it — up in `#pageId`.
  await page.waitForSelector('#screenRepo', { timeout: 10_000 }).catch(() => {});
  check('a named route opens its own screen, named in the one header',
    Boolean(await page.$('#screenRepo'))
    && (await page.$eval('#pageId #repoTitle', (node) => node.textContent?.trim() ?? '').catch(() => '')) === 'infinite-agents',
    await page.$eval('#pageId', (node) => node.textContent?.trim() ?? '').catch(() => 'no header slot'));
  await shot('named-route');
  await page.goto(`${ORIGIN}/?ui=react`, { waitUntil: 'networkidle0' });
  check('a retired ui= link lands on the clean address', page.url() === `${ORIGIN}/` && Boolean(await page.$('#root')), page.url());
  check('the session carried across the redirect', await waitHome());
  consoleErrors.length = 0;

  // 4. Sign out, then sign back in: the address and password first, and the
  // optional second factor after them.
  const signOutFromProfile = async () => {
    await page.goto(`${ORIGIN}/profile`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#profileAccessCard button', { timeout: 10_000 });
    const buttons = await page.$$('#profileAccessCard button');
    // A DOM click, not a pointer one: Settings is still filling in its rows
    // above the access card when this runs, and a pointer click aimed at
    // "Sign out" landed on "Disable" one row up about half the time — the
    // authenticator panel opened and the door never closed (2026-09-23).
    for (const button of buttons) {
      if (/Sign out$/.test(await button.evaluate((node) => node.textContent ?? ''))) {
        await button.evaluate((node) => (node as HTMLButtonElement).click());
        return;
      }
    }
    throw new Error('no sign-out on the profile');
  };
  await signOutFromProfile();
  check('sign out closes the door', await waitHeading('Sign in'));
  check('the sign-in field is the name, with the domain shown beside it',
    (await page.$eval('#authEmailDomain', (node) => node.textContent ?? '').catch(() => '')) === '@agenticcloudcomputer.com');
  check('the sign-in mark links home', await page.$eval('#authGate .setuphead #authHome', (node) => node.getAttribute('href')).catch(() => null) === '/');
  await shot('sign-in');
  // The door closed on the profile's address; the next sign-in should land on Home.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await shot('signin');
  await page.type('#authEmail', MAILBOX);
  await page.type('#authPassword', PASSWORD);
  await page.click('#authEmailButton');
  check('a valid password asks for the enabled authenticator', await waitHeading('Extra security check'));
  await page.type('#authSecondFactorCode', '000000');
  await page.click('#authSecondFactorButton');
  await page.waitForSelector('#authSecondFactorError', { timeout: 10_000 }).catch(() => {});
  check('a wrong code is refused with the server sentence',
    (await page.$eval('#authSecondFactorError', (node) => node.textContent ?? '').catch(() => '')).includes('not valid'));
  // A controlled input: select and retype so React sees the change.
  await page.focus('#authSecondFactorCode');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  // Enrollment just consumed the current 30-second step, and steps are fenced
  // against replay; the next step's code is inside the verifier's drift window.
  await page.type('#authSecondFactorCode', generateTotpCode(secret, Date.now() + 30_000));
  check('the code field holds only the new code', /^\d{6}$/.test(await page.$eval('#authSecondFactorCode', (input) => (input as HTMLInputElement).value)), await page.$eval('#authSecondFactorCode', (input) => (input as HTMLInputElement).value));
  await page.click('#authSecondFactorButton');
  check('the right code opens Home', await waitHome(),
    await page.$eval('#authSecondFactorError', (node) => node.textContent ?? '').catch(() => ''));
  await signOutFromProfile();
  await waitHeading('Sign in');
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.type('#authEmail', MAILBOX);
  await page.type('#authPassword', PASSWORD);
  await page.click('#authEmailButton');
  await page.waitForSelector('#authSecondFactorPanel');
  const factorLinks = await page.$$('#authSecondFactorPanel .authlink');
  await factorLinks[0]!.click();
  check('recovery follows a verified password', await waitHeading('Use a recovery code'));
  await page.type('#authSecondFactorCode', codes[0]!);
  await page.click('#authSecondFactorButton');
  check('a recovery code opens Home', await waitHome());

  // 5. Forgot the password: the name alone, a link to the recovery email, a
  // new password, and the door again — the authenticator still stands.
  await signOutFromProfile();
  check('signed out for the reset', await waitHeading('Sign in'));
  // Note #605: the rescue shares the commit's row — left edge, pill on the right.
  const row = await page.evaluate(() => {
    const forgot = document.getElementById('authForgotLink')!.getBoundingClientRect();
    const commit = document.getElementById('authEmailButton')!.getBoundingClientRect();
    return { dy: Math.abs((forgot.top + forgot.bottom) / 2 - (commit.top + commit.bottom) / 2), leftOf: forgot.right <= commit.left };
  });
  check('forgot sits on the Sign in row', row.dy <= 2 && row.leftOf, JSON.stringify(row));
  await shot('signin');
  await page.click('#authForgotLink');
  check('forgot opens its own panel', await waitHeading('Reset your password'));
  await page.$eval('#authForgotName', (input) => { (input as HTMLInputElement).value = ''; });
  await page.type('#authForgotName', MAILBOX);
  const linksBefore = sentAuthLinks.length;
  await page.click('#authForgotButton');
  await page.waitForSelector('#authForgotSent', { timeout: 10_000 }).catch(() => {});
  check('the answer promises nothing about the account', Boolean(await page.$('#authForgotSent')));
  check('one reset link was mailed', sentAuthLinks.length === linksBefore + 1, String(sentAuthLinks.length - linksBefore));
  await shot('forgot');
  await page.goto(sentAuthLinks.at(-1)!, { waitUntil: 'networkidle0' });
  check('the link opens the new-password form', await waitHeading('New password'));
  check('the new-password mark links home', await page.$eval('#authGate .setuphead #authHome', (node) => node.getAttribute('href')).catch(() => null) === '/');
  check('the key left the address bar', !page.url().includes('token='), page.url());
  await page.type('#authResetPassword', NEW_PASSWORD);
  await page.type('#authResetConfirm', NEW_PASSWORD);
  await page.click('#authResetButton');
  await page.waitForSelector('#authResetDone', { timeout: 10_000 }).catch(() => {});
  check('the password is changed and every browser signed out', Boolean(await page.$('#authResetDone')));
  await shot('reset-done');
  await page.click('#authResetContinue');
  await page.waitForSelector('#authEmail', { timeout: 10_000 });
  await page.type('#authEmail', MAILBOX);
  await page.type('#authPassword', PASSWORD);
  await page.click('#authEmailButton');
  await page.waitForSelector('#authEmailError', { timeout: 10_000 }).catch(() => {});
  check('the old password is refused',
    (await page.$eval('#authEmailError', (node) => node.textContent ?? '').catch(() => '')).includes('Invalid name or password'));
  await page.$eval('#authPassword', (input) => { (input as HTMLInputElement).value = ''; });
  await page.type('#authPassword', NEW_PASSWORD);
  await page.click('#authEmailButton');
  await page.waitForSelector('#authSecondFactorPanel', { timeout: 10_000 });
  check('the new password still meets the authenticator', Boolean(await page.$('#authSecondFactorPanel')));
  // The second recovery code, not another authenticator code: the one step
  // of clock drift the server allows was spent by the sign-in a moment ago,
  // and the next step may not have arrived yet.
  for (const link of await page.$$('#authSecondFactorPanel .authlink')) {
    if ((await link.evaluate((node) => node.textContent ?? '')).includes('recovery code')) { await link.click(); break; }
  }
  await page.type('#authSecondFactorCode', codes[1]!);
  await page.click('#authSecondFactorButton');
  check('the new password opens Home', await waitHome());

  // A signed-out session read is a 401 by design, and the refused wrong code
  // a 400; anything else the shell logged is a real complaint.
  const unexpected = consoleErrors.filter((text) => !/status of (400|401)/.test(text));
  check('no unexpected console errors', unexpected.length === 0, unexpected.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
