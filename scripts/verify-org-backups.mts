// Opens the real Workspace shell on the workplace screen and reads back what
// note #357 changed: the pending count, the Refresh button and the Reusable
// badge are gone, and a Backups block says who holds a copy of the org. It also
// guards the clean foot of the sole-admin page: no creation shortcut or long
// deletion-blocker inventory lives there now.
//
// It serves the BUILT workspace-ui against a stub `api/org` rather than a whole
// backend, because what is under test is the screen: the route's own half has
// unit tests, and the two org shapes below are the exact payloads it produces
// for an org on the platform's git host and for one hosting its own.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-org-backups.mts
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import type { WorkspaceOrgDetail } from '../backend/src/shared/workspace-api.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
const UI = path.join(REPO, 'backend/dist/workspace-ui');
const PORT = Number(process.env.PORT || 4188);
const ORIGIN = `http://127.0.0.1:${PORT}`;

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().pop();
  if (!build) throw new Error(`no Chrome under ${root}`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const me = { userId: 'u1', name: 'Saddam', you: true, role: 'admin' as const, joinedAt: '2026-08-01T00:00:00Z', agents: 2 };
const invite = {
  token: 'FwxG404kQ2', link: `${ORIGIN}/invite/FwxG404kQ2`,
  createdAt: hoursAgo(13), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
};

/** The reporter's own org, as production answers for it: a git namespace on the
 *  platform's central host, no host of its own, so its backups are the
 *  platform's nightly ones. This screen used to say nothing about backups. */
const onPlatform: WorkspaceOrgDetail = {
  orgId: 'o1', name: 'Org #0', role: 'admin', members: [me], invites: [invite], joinRequests: [],
  canDelete: false, blocked: 'Org #0 still has 2 agents and 7 repositories.',
  fly: { connected: true, orgSlug: 'infinite-agents', peer: 'pending' },
  git: { repoCount: 7, totalSizeBytes: 41 * 1024 * 1024 },
  platformBackup: { code: { at: hoursAgo(4), ok: true }, workspace: { at: hoursAgo(4), ok: true } },
};

/** An org hosting its own git: its code's copies are its own, in its bucket. */
const ownHost: WorkspaceOrgDetail = {
  orgId: 'o2', name: 'Nomad Trading', role: 'admin', members: [me], invites: [invite], joinRequests: [],
  canDelete: true,
  fly: { connected: true, orgSlug: 'nomad-trading', peer: 'up' },
  git: {
    repoCount: 3, totalSizeBytes: 12 * 1024 * 1024,
    host: {
      app: 'iagit-x', health: 'ok', diskUsedPercent: 34, volumeSizeGb: 10, snapshotRetentionDays: 5,
      growByGb: 10, growMonthlyUsd: 1.5, repoMaxBytes: 8 * 1024 ** 3, repoMaxBytesAfterGrow: 16 * 1024 ** 3,
    },
    backup: { bucket: 'iagit-x-bk', everyHours: 6, last: { at: hoursAgo(2), ok: true } },
  },
  platformBackup: { workspace: { at: hoursAgo(4), ok: true } },
};

let current: WorkspaceOrgDetail = onPlatform;

const state = () => ({
  org: { orgId: current.orgId, name: current.name, role: 'admin', members: 1, seats: 0, seatProviders: [] },
  organizations: [{ orgId: current.orgId, name: current.name, role: 'admin', active: true, members: 1, agents: 2 }],
  canCreateOrg: true,
  user: {
    name: 'Saddam',
    profile: { firstName: 'Saddam', lastName: '', incomplete: false },
    account: { browserLogin: { enabled: true, username: 'saddam' } },
  },
  agents: [], prs: [], knowledgeProposals: [],
  secrets: null, repos: null, sites: null, knowledge: null, notes: null,
  notesArchived: 0, noteFiles: false,
});

const app = express();
app.use(express.json());
app.get('/workspace/auth/session', (_req, res) => res.json({
  authenticated: true, username: 'saddam', displayName: 'Saddam',
  session: { sessionId: 's1', createdAt: 't', lastSeenAt: 't', absoluteExpiresAt: 't' },
}));
app.get('/workspace/api/state', (_req, res) => res.json(state()));
app.get('/workspace/api/org', (_req, res) => res.json({ org: current }));
app.get('/workspace/api/org/join-requests', (_req, res) => res.json({ joinRequests: current.joinRequests ?? [] }));
app.get('/workspace/api/org/cloud', (_req, res) => res.json({
  orgId: current.orgId, role: 'admin', fly: { connected: true, orgSlug: 'test-cloud', peer: 'up' }, machines: null,
}));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({
  notifications: [], unread: 0, push: { available: false, subscriptions: 0 },
}));
// Everything else the shell asks for on open: empty, so nothing hangs.
app.get('/workspace/api/*', (_req, res) => res.json({}));
app.use('/workspace/app/assets', express.static(path.join(UI, 'assets')));
app.get('*', (_req, res) => res.sendFile(path.join(UI, 'index.html')));
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
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));

  const openOrg = async (which: WorkspaceOrgDetail, shot: string) => {
    current = which;
    await page.goto(`${ORIGIN}/workplace?org=${which.orgId}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#screenOrg #orgPeopleDoor', { timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, `${shot}.png`) as `${string}.png`, fullPage: true });
    return page.$eval('#screenOrg', (node) => node.textContent ?? '');
  };

  // 1. The org the request came from: on the platform's host.
  const platformText = await openOrg(onPlatform, 'n357-org-on-platform');
  check('the pending count is gone', !/\d+ pending/.test(platformText));
  check('the Refresh requests button is gone', !platformText.includes('Refresh requests'));
  check('the Reusable badge is gone', !platformText.includes('Reusable'));
  check('the sole-admin footer omits the creation shortcut and blocker inventory',
    !platformText.includes('Create another workplace')
    && !platformText.includes('still has 2 agents')
    && !(await page.$('#orgActions'))
    && !(await page.$('#orgDangerHint')));
  check('the join requests block is still there', platformText.includes('No pending requests.'));
  const detailGlyphs = await page.$$eval([
    '#orgJoinRequests .roomemptymark',
    '#orgInvites .orgjoin-link > .crow > .icon',
    '#orgCloudCard .crow > .icon',
    '#orgGitCard .crow > .icon',
    '#orgBackups .crow > .icon',
  ].join(','), (nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    const svg = node.querySelector('svg')?.getBoundingClientRect();
    return {
      box: `${Math.round(box.width)}x${Math.round(box.height)}`,
      glyph: svg ? `${Math.round(svg.width)}x${Math.round(svg.height)}` : '',
      background: getComputedStyle(node).backgroundColor,
    };
  }));
  check('every detail glyph uses the same flat style and size',
    detailGlyphs.length >= 5
    && detailGlyphs.every((mark) => mark.box === '28x28' && mark.glyph === '20x20'
      && mark.background === 'rgba(0, 0, 0, 0)'),
    JSON.stringify(detailGlyphs));
  check('a Backups block appears', Boolean(await page.$('#orgBackups')));
  const backups = await page.$eval('#orgBackups', (node) => node.textContent ?? '');
  check('it says who backs up the code', /Your code.*nightly, by the platform/s.test(backups), backups.slice(0, 200));
  check('it says who backs up the chats', /Chats, notes and proposals.*nightly, by the platform/s.test(backups));
  check('the footnote under the rows is gone', !backups.includes('Connect a cloud account of your own') && !(await page.$('#orgBackupsHint')));

  // 2. An org hosting its own git: the same block, answered from its own bucket.
  const ownText = await openOrg(ownHost, 'n357-org-own-host');
  const ownBackups = await page.$eval('#orgBackups', (node) => node.textContent ?? '');
  check('its code reads off its own vault', /Backed up 2h ago · every 6 hours/.test(ownBackups), ownBackups.slice(0, 200));
  check('its vault is named', ownBackups.includes('iagit-x-bk · in your cloud'));
  check('its disk snapshots are shown', ownBackups.includes('Daily, kept 5 days'));
  check('its chats are still the platform’s to keep', /Chats, notes and proposals.*nightly/s.test(ownBackups));
  check('the platform is not credited with its code', (ownBackups.match(/nightly, by the platform/g) ?? []).length === 1);
  check('the Reusable badge is gone here too', !ownText.includes('Reusable'));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
