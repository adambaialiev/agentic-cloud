// Drives the React Workspace's join journey against the built client: signed
// out context, every signed-in applicant state, account switching, admin
// decisions, link copying/manual fallback, creation, and revoke confirmation.
// Screenshots land in ~/mini-preview/join-ui-*.png.

import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot } from './browser-settle.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.join(REPO, 'backend/dist/workspace-ui');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const PORT = Number(process.env.PORT || 4182);
const ORIGIN = `http://127.0.0.1:${PORT}`;

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(cache).filter((name) => name.startsWith('linux-')).sort();
  const newest = builds[builds.length - 1];
  if (!newest) throw new Error(`no Chrome under ${cache} — npx puppeteer browsers install chrome`);
  return path.join(cache, newest, 'chrome-linux64/chrome');
}

type JoinStatus = 'available' | 'pending' | 'member' | 'rejected' | 'used' | 'removed';
const LONG_ORG = 'Harbor Studio and International Research Cooperative';
const now = () => new Date().toISOString();
const inSixDays = () => new Date(Date.now() + 6 * 86_400_000).toISOString();

let signedOut = true;
let authInviteStatus: 'available' | 'used' = 'available';
let authInviteFailure = false;
let joinStatus: JoinStatus = 'available';
let joinFailure = 0;
let joinDelay = 0;
let requestHits = 0;
let invites = [{
  token: 'share-one',
  link: `${ORIGIN}/invite/share-one-with-a-deliberately-long-token-for-the-field`,
  createdAt: now(),
}];
let requests = [
  { requestId: 'jr-long', userId: 'u2', name: 'Alexandria Catherine Montgomery-Smythe', username: 'alexandria.catherine.montgomery', requestedAt: now() },
  { requestId: 'jr-two', userId: 'u3', name: 'Theo Williams', username: 'theow', requestedAt: now() },
];

const session = {
  authenticated: true,
  username: 'mirac',
  displayName: 'Mira Chen',
  session: { sessionId: 's1', createdAt: now(), lastSeenAt: now(), absoluteExpiresAt: inSixDays() },
};

const state = () => ({
  org: { orgId: 'o1', name: 'Harbor Studio', role: 'admin', members: 1, seats: 0, seatProviders: [] },
  organizations: [{ orgId: 'o1', name: 'Harbor Studio', role: 'admin', active: true, members: 1, agents: 0 }],
  canCreateOrg: true,
  user: { name: 'Mira Chen', profile: { firstName: 'Mira', lastName: 'Chen', incomplete: false }, account: { browserLogin: { enabled: true, username: 'mirac' } } },
  agents: [], prs: [], knowledgeProposals: [], secrets: null, repos: null, sites: null,
  knowledge: null, notes: null, notesArchived: 0, noteFiles: false,
});

const workplace = () => ({
  orgId: 'o1', name: 'Harbor Studio', role: 'admin',
  members: [{ userId: 'u1', name: 'Mira Chen', you: true, role: 'admin', joinedAt: now(), agents: 0 }],
  joinRequests: requests,
  invites,
  canDelete: false,
  blocked: 'Harbor Studio still has one agent.',
  fly: { connected: true, orgSlug: 'harbor-studio', peer: 'up' },
});

const app = express();
app.use(express.json());
app.get('/workspace/auth/session', (_req, res) => {
  if (signedOut) res.status(401).json({ authenticated: false, error: 'authentication required' });
  else res.json(session);
});
app.get('/workspace/auth/invite/:token', async (_req, res) => {
  if (joinDelay) await new Promise((resolve) => setTimeout(resolve, joinDelay));
  if (authInviteFailure) { res.status(503).json({ error: 'The link service is temporarily unavailable.' }); return; }
  res.json({ status: authInviteStatus });
});
app.post('/workspace/auth/logout', (_req, res) => { signedOut = true; res.json({ loggedOut: true }); });
app.get('/workspace/api/state', (_req, res) => res.json(state()));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/org/invites/:token', async (_req, res) => {
  if (joinDelay) await new Promise((resolve) => setTimeout(resolve, joinDelay));
  if (joinFailure) { res.status(joinFailure).json({ error: joinFailure >= 500 ? 'The join service is temporarily unavailable.' : 'This invite link is unavailable.' }); return; }
  res.json({ status: joinStatus, orgId: 'o2', name: LONG_ORG,
    ...(['pending', 'member', 'rejected', 'removed'].includes(joinStatus) ? { requestId: 'jr-status' } : {}) });
});
app.get('/workspace/api/org/join-requests/:id', async (_req, res) => {
  if (joinDelay) await new Promise((resolve) => setTimeout(resolve, joinDelay));
  if (joinFailure) { res.status(joinFailure).json({ error: 'The join service is temporarily unavailable.' }); return; }
  res.json({ status: joinStatus, requestId: 'jr-status', orgId: 'o2', name: LONG_ORG });
});
app.post('/workspace/api/org/invites/:token/redeem', (_req, res) => {
  requestHits += 1;
  joinStatus = 'pending';
  res.json({ ok: true, status: 'pending', requestId: 'jr-status', orgId: 'o2', name: LONG_ORG });
});
app.post('/workspace/api/org/active', (_req, res) => res.json({ ok: true }));
app.get('/workspace/api/org', (_req, res) => { res.json({ org: workplace() }); });
app.post('/workspace/api/org/join-requests/:id/decision', (req, res) => {
  requests = requests.filter((row) => row.requestId !== req.params.id);
  res.json({ ok: true, status: req.body?.decision === 'approve' ? 'approved' : 'rejected' });
});
app.post('/workspace/api/org/invites', (_req, res) => {
  // One per workplace, as the route does: asking again hands back the one
  // that exists rather than minting beside it.
  if (invites[0]) { res.json({ ok: true, invite: invites[0] }); return; }
  const invite = { token: 'share-1', link: `${ORIGIN}/invite/share-1`, createdAt: now() };
  invites = [invite];
  res.json({ ok: true, invite });
});
app.delete('/workspace/api/org/invites/:token', (req, res) => {
  invites = invites.filter((invite) => invite.token !== req.params.token);
  res.json({ ok: true });
});
app.use('/workspace/app', express.static(DIST, { index: false }));
app.use('/', express.static(DIST, { index: false }));
app.use('/', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));

const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  const shot = async (name: string, fullPage = true) => {
    await page.screenshot({
      path: path.join(OUT, `join-ui-${name}.png`) as `${string}.png`, fullPage,
    });
    await settleAfterShot(page);
  };
  const text = (selector: string) => page.$eval(selector, (node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const invite = (token: string) => `${ORIGIN}/invite/${token}`;

  // Signed out: invitation context is one standard auth notice; sign-in stays
  // the exact card the ordinary door uses — which is the email panel. The
  // authenticator card is the LEGACY door now, reached only from its own link,
  // so an invited visitor must never be asked for a username and a code.
  signedOut = true;
  authInviteStatus = 'available';
  authInviteFailure = false;
  await page.goto(invite('signed-out'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('#authEmailPanel');
  check('signed-out join context uses the standard auth notice and panel',
    Boolean(await page.$('#authInvite.authinvite')) && Boolean(await page.$('#authGate.authplates #authEmailPanel.authpanel')) && !(await page.$('#authEmailPanel.card'))
    && !(await page.$('#authLoginPanel')) && !(await page.$('.join-entry-steps')));
  check('signed-out phone layout fits', await fits());
  await shot('signed-out');

  authInviteStatus = 'used';
  await page.goto(invite('used-out'), { waitUntil: 'networkidle0' });
  check('signed-out inactive link stays honest without blocking ordinary sign-in',
    (await text('#authInvite strong')) === 'This link is no longer active' && Boolean(await page.$('#authEmailButton')));
  authInviteStatus = 'available';

  authInviteFailure = true;
  await page.goto(invite('error-out'), { waitUntil: 'networkidle0' });
  check('signed-out preview error is readable and sign-in remains available',
    (await text('#authInvite')).includes('temporarily unavailable') && Boolean(await page.$('#authEmailButton')));

  // Signed in: the workplace is the shared header identity and each server
  // state maps to the card's bare status word, icon, copy and action.
  signedOut = false;
  authInviteFailure = false;
  const statuses: Array<[JoinStatus, string, string]> = [
    ['available', 'Invitation ready', 'open'],
    ['pending', 'Request sent', 'running'],
    ['member', 'Approved', 'merged'],
    ['rejected', 'Declined', 'rejected'],
    ['used', 'Inactive', 'quiet'],
    ['removed', 'Access ended', 'quiet'],
  ];
  for (const [status, label, tone] of statuses) {
    joinStatus = status;
    joinFailure = 0;
    const suffix = status === 'removed' ? '?request=jr-status' : '';
    await page.goto(`${invite(`status-${status}`)}${suffix}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#inviteTitle');
    await page.evaluate('window.scrollTo(0, 0)');
    check(`${status} uses the shared status vocabulary`,
      (await text('.join-status')) === label
      && (await page.$eval('.join-status', (node, wanted) => node.classList.contains(wanted), tone)),
    );
    check(`${status} keeps workplace and account context`,
      (await text('#inviteTitle')) === LONG_ORG
      && (await text('.join-account .name')) === 'Mira Chen'
      && (await text('.join-account .meta')) === '@mirac');
    await shot(`status-${status}`, false);
  }

  joinStatus = 'available';
  await page.goto(invite('available'), { waitUntil: 'networkidle0' });
  await page.evaluate('window.scrollTo(0, 0)');
  check('the available state has one primary request action',
    (await page.$$('.join-actions .formcommit')).length === 1 && (await text('.join-actions')) === 'Request to join');
  check('the account switch is a standard row action', Boolean(await page.$('.join-account .row > .act')));
  await shot('available');

  await page.click('.join-actions .formcommit');
  await page.waitForFunction(() => document.querySelector('.join-status')?.textContent === 'Request sent');
  check('requesting moves to waiting without granting access', requestHits === 1 && !(await page.$('.join-actions .formcommit')));
  await page.evaluate('window.scrollTo(0, 0)');
  await shot('pending');
  check('waiting offers no button to check by hand', !(await page.$('.join-actions button')) && Boolean(await page.$('.join-watching')));
  joinStatus = 'member';
  await page.waitForFunction(() => document.querySelector('.join-status')?.textContent === 'Approved', { timeout: 10_000 });
  check('an approval arrives on the waiting page by itself', Boolean(await page.$('.join-actions .formcommit')));

  // Initial wait and both failure branches.
  joinDelay = 1500;
  joinStatus = 'available';
  await page.goto(invite('slow'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inviteTitle');
  await page.evaluate('window.scrollTo(0, 0)');
  check('loading has a named state in the shared header', (await text('#inviteTitle')) === 'Opening invitation');
  await shot('loading', false);
  joinDelay = 0;

  joinFailure = 503;
  await page.goto(invite('retry'), { waitUntil: 'networkidle0' });
  check('temporary failure offers retry', Boolean(await page.$('.join-actions .btn.ghost')) && (await text('#inviteTitle')) === 'Try the invite again');
  joinFailure = 0;
  await page.click('.join-actions .btn.ghost');
  await page.waitForSelector('.join-actions .formcommit');
  check('retry recovers without submitting a request', requestHits === 1);

  joinFailure = 404;
  await page.goto(invite('unavailable'), { waitUntil: 'networkidle0' });
  check('non-retryable failure offers no false action',
    (await text('#inviteTitle')) === 'Invite unavailable' && !(await page.$('.join-actions button')));
  joinFailure = 0;

  // Admin: long people are compact standard rows, actions keep the normal
  // hierarchy, links keep a selectable field, and all widths stay inside a
  // 320px phone as well as the desktop reading column.
  await page.setViewport({ width: 320, height: 760, deviceScaleFactor: 2 });
  await page.goto(`${ORIGIN}/workplace?org=o1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgJoinRequests .orgjoin-request');
  check('pending people use standard rows with a primary approve and quiet decline',
    (await page.$$('#orgJoinRequests .orgjoin-request > .crow')).length === 2
    && Boolean(await page.$('#orgJoinRequests .orgjoin-decisions .join-approve'))
    && Boolean(await page.$('#orgJoinRequests .orgjoin-decisions .join-decline')));
  check('invite links use a standard row and a selectable field',
    Boolean(await page.$('#orgInvites .orgjoin-link > .crow'))
    && Boolean(await page.$('#orgInvites input[aria-label="Shareable invite link"]')));
  check('the invite link uses the compact flat glyph shared by detail rows',
    Boolean(await page.$('#orgInvites .orgjoin-link > .crow > .icon.ft'))
    && !(await page.$('#orgInvites .orgjoin-link > .crow > .iconbox')));
  const revokeGeometry = await page.$eval('#orgInvites .orgjoin-revoke', (button) => {
    const control = button.getBoundingClientRect();
    const link = button.closest('.orgjoin-link')!.getBoundingClientRect();
    const glyph = button.querySelector('svg')!.getBoundingClientRect();
    // Whole pixels: a measured box can read 27.99997 while it settles (note #1075).
    return {
      width: Math.round(control.width), height: Math.round(control.height),
      glyphWidth: Math.round(glyph.width), glyphHeight: Math.round(glyph.height),
      top: Math.round(control.top - link.top), right: Math.round(link.right - control.right),
    };
  });
  check('revoke is a small control in the link’s top-right corner',
    revokeGeometry.width === 28 && revokeGeometry.height === 28
    && revokeGeometry.glyphWidth === 14 && revokeGeometry.glyphHeight === 14
    && revokeGeometry.top === 7 && revokeGeometry.right === 8,
    JSON.stringify(revokeGeometry));
  const revokeRest = await page.$eval('#orgInvites .orgjoin-revoke', (button) => getComputedStyle(button).color);
  await page.hover('#orgInvites .orgjoin-revoke');
  await new Promise((resolve) => setTimeout(resolve, 160));
  const revokeHover = await page.$eval('#orgInvites .orgjoin-revoke', (button) => getComputedStyle(button).color);
  const revokeBox = await page.$eval('#orgInvites .orgjoin-revoke', (button) => {
    const box = button.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  await page.mouse.move(revokeBox.x, revokeBox.y);
  await page.mouse.down();
  await new Promise((resolve) => setTimeout(resolve, 160));
  const revokePressed = await page.$eval('#orgInvites .orgjoin-revoke', (button) => getComputedStyle(button).color);
  // Leave the target before releasing: this probe must not open the revoke
  // confirmation whose real tap is exercised below.
  await page.mouse.move(revokeBox.x + 48, revokeBox.y + 48);
  await page.mouse.up();
  await new Promise((resolve) => setTimeout(resolve, 160));
  check('revoke becomes heavier on hover and press',
    revokeRest !== revokeHover && revokeHover !== revokePressed,
    `${revokeRest} → ${revokeHover} → ${revokePressed}`);
  check('the sole-admin page has no extra workplace action or blocker footer',
    !(await page.$('#orgActions'))
    && !(await page.$('#orgDangerHint'))
    && !(await text('#screenOrg')).includes('Create another workplace'));
  check('long-name 320px admin layout fits', await fits());
  await shot('admin-phone');

  // Manual-copy fallback is a real browser focus/selection check.
  await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    write: function () { return Promise.reject(new Error('denied')); },
    writeText: function () { return Promise.reject(new Error('denied')); }
  } })`);
  await page.click('#orgInvites .orgjoin-copy');
  await page.waitForSelector('#orgInvites .orgjoin-inline-error');
  const selected = await page.$eval('#orgInvites input', (node) => {
    const input = node as HTMLInputElement;
    return document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length;
  });
  check('failed copy selects the whole link for manual copying', selected);
  await shot('manual-copy');

  // One link per workplace: while one stands there is nothing to create, so
  // the door is not drawn at all — and the link it would have made is the one
  // already on the screen.
  check('a workplace holding a link offers no second one, under a singular heading',
    !(await page.$('#orgInviteBtn'))
    && (await text('#orgInviteLinksTitle')) === 'Invite link'
    && (await page.$$('#orgInvites .orgjoin-link')).length === 1);
  check('the standing link promises no expiry',
    (await text('#orgInvites .orgjoin-link .cline')).includes('Works until you revoke it')
    && !(await text('#orgInvites')).toLowerCase().includes('expire'));

  await page.click('#orgInvites .orgjoin-revoke');
  await page.waitForSelector('.ask');
  check('revoke uses the shared confirmation dialog and danger action',
    Boolean(await page.$('.ask .btn.danger')) && (await text('.ask .btn.danger')) === 'Revoke'
    && (await text('.ask h3')) === 'Revoke this invite link?');
  await shot('revoke-dialog', false);
  await page.click('.ask .btn.ghost');

  // The join-requests card has no control of its own, and has not had one
  // since "Refine organization join and approval screens" (f0868c1a) took
  // its add row off — the SAME DAY this harness was written, which is how a
  // check asking for `#orgJoinRequests .addrow` was born stale and stayed
  // that way: it threw where `finally` then closed the browser, and Node
  // died on "Page closed!" rather than on the missing element. Requests
  // arrive with the screen's own read; the in-card action belongs to the
  // invite LINKS card, and is checked with the empty states below.
  check('the join-requests card carries no control of its own',
    !(await page.$('#orgJoinRequests .addrow')) && Boolean(await page.$('#orgJoinRequests')));

  await page.setViewport({ width: 1120, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${ORIGIN}/workplace?org=o1`, { waitUntil: 'networkidle0' });
  check('desktop keeps the one Workspace reading column', await page.$eval('#webMain', (node) => node.getBoundingClientRect().width <= 720));
  check('desktop admin layout fits', await fits());
  await shot('admin-desktop');

  // Empty request/link states use the same shared EmptyState component as
  // every shelf on Home, with the add/refresh rows still available.
  requests = [];
  invites = [];
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  await page.goto(`${ORIGIN}/workplace?org=o1`, { waitUntil: 'networkidle0' });
  check('both admin empty states use the shared empty-state component',
    (await page.$$('#orgJoinRequests .roomempty')).length === 1
    && (await page.$$('#orgInvites .roomempty')).length === 1);
  check('the empty invite-link card is where the create action lives',
    Boolean(await page.$('#orgInvites .addrow')));
  await shot('admin-empty');
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

if (failures.length) {
  console.error(`\n${failures.length} FAILED: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nall passed');
}
