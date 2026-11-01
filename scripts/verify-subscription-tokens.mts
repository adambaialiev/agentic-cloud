// Opens the real Workspace shell on "Your subscriptions" and reads back the
// token section (the owner via Clara, 2026-10-10): the tokens the reader's own
// agents spent, week by week, Claude Code and Codex on separate lines, output
// first — and the empty state a reader sees before any turn has been counted.
//
// It serves the BUILT workspace-ui against stub reads, because what is under
// test is the screen: the route and the ledger have unit tests, and the
// answer below is the exact shape `GET api/org/tokens` produces.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-subscription-tokens.mts
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import type { WorkspaceSeatRecord, WorkspaceTokenUsageAnswer } from '../backend/src/shared/workspace-api.js';
import { tokenWeekStart, tokenWeeksSince } from '../backend/src/services/agent-token-ledger.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
const UI = path.join(REPO, 'backend/dist/workspace-ui');
const PORT = Number(process.env.PORT || 4194);
const ORIGIN = `http://127.0.0.1:${PORT}`;

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().pop();
  if (!build) throw new Error(`no Chrome under ${root}`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const weekBack = (weeks: number): string => {
  const at = new Date(`${tokenWeekStart(new Date().toISOString().slice(0, 10))}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 7 * weeks);
  return at.toISOString().slice(0, 10);
};

const seat: WorkspaceSeatRecord = {
  seatId: 'seat-1', provider: 'claude', label: 'Claude · Max', planText: 'Max 20x', status: 'active',
  selected: true, createdAt: '2026-09-01T00:00:00Z',
};
const spent: WorkspaceTokenUsageAnswer = {
  since: tokenWeeksSince(Date.now()),
  weeks: [
    {
      start: weekBack(0),
      providers: [
        { provider: 'claude', input: 342_000, output: 1_240_000, cacheRead: 1_480_000_000, cacheWrite: 21_000_000, reasoning: 0, models: ['claude-opus-5-5', 'claude-haiku-4-5'] },
        { provider: 'codex', input: 1_130_000, output: 812_000, cacheRead: 9_400_000, cacheWrite: 0, reasoning: 214_000, models: ['gpt-6-sol'] },
      ],
    },
    {
      start: weekBack(1),
      providers: [
        { provider: 'claude', input: 518_000, output: 2_070_000, cacheRead: 2_310_000_000, cacheWrite: 34_000_000, reasoning: 0, models: ['claude-opus-5-5'] },
      ],
    },
    {
      start: weekBack(3),
      providers: [
        { provider: 'codex', input: 96_000, output: 41_000, cacheRead: 610_000, cacheWrite: 0, reasoning: 12_000, models: ['gpt-6-sol'] },
      ],
    },
  ],
};
let tokens: WorkspaceTokenUsageAnswer = spent;

const state = () => ({
  org: {
    orgId: 'o1', name: 'Org #0', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'],
    seatUsage: [{ seatId: seat.seatId, label: seat.label, provider: 'claude', planText: seat.planText, selected: true }],
  },
  organizations: [{ orgId: 'o1', name: 'Org #0', role: 'admin', active: true, members: 1, agents: 2 }],
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
app.get('/workspace/api/org/seats', (_req, res) => res.json({ seats: [seat], available: [] }));
app.get('/workspace/api/org/tokens', (_req, res) => res.json(tokens));
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
  page.on('pageerror', (error) => check('no page error', false, String(error)));

  const open = async (width: number, shot: string): Promise<string> => {
    await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
    await page.goto(`${ORIGIN}/seats?org=o1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#screenSeats #seatsTokens', { timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, `${shot}.png`) as `${string}.png`, fullPage: true });
    return page.$eval('#seatsTokens', (node) => (node as HTMLElement).innerText);
  };

  // 1. A reader whose agents have been working: three weeks with spend.
  const phone = await open(420, 'tokens-subscriptions-phone');
  console.log(`--- section as read on a phone ---\n${phone}\n---`);
  const lines = phone.replace(/\u00a0/g, ' ').split('\n').map((line) => line.trim()).filter(Boolean);
  // The heading is drawn in capitals by CSS; innerText reads it as shown.
  check('the section is titled for what it is', lines[0]?.toLowerCase() === 'tokens your agents used');
  check('this week comes first, then last week, then an older one by its date',
    lines.includes('This week') && lines.includes('Last week') && lines.some((line) => /^Week of /.test(line))
      && lines.indexOf('This week') < lines.indexOf('Last week'));
  check('Claude Code leads with output, and the cache is one figure',
    lines.includes('Claude Code · 1.2M output · 342k input · 1.5B cache'));
  check('Codex shows its reasoning as part of output, on its own line',
    lines.includes('Codex · 812k output (214k reasoning) · 1.1M input · 9.4M cache'));
  // This week's Claude 1.24M + Codex 812k would read 2.1M — which only last
  // week's Claude line (2.07M) may say.
  check('the two providers are never added into one number, nor share a line',
    lines.filter((line) => line.includes('2.1M output')).length === 1
      && lines.filter((line) => line.includes(' output')).every((line) => !(line.includes('Claude Code') && line.includes('Codex'))));
  check('the hint says whose and that it is private', phone.includes('Every agent of yours') && phone.includes('Only you see this.'));
  // A phone wraps a long line rather than cutting it off: every figure is
  // drawn whole inside the row, nothing hidden behind an ellipsis.
  check('no figure is cut off on a phone', await page.$$eval('#seatsTokensList .ctext',
    (nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth + 1)));
  check('the section sits under the subscriptions it was spent on',
    await page.$eval('#screenSeats', (screen) => {
      const list = screen.querySelector('#seatsList');
      const section = screen.querySelector('#seatsTokens');
      return Boolean(list && section && (list.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING));
    }));
  await open(1280, 'tokens-subscriptions-desktop');

  // 2. Before any turn has been counted.
  tokens = { since: spent.since, weeks: [] };
  const empty = await open(420, 'tokens-subscriptions-empty');
  check('an empty ledger says so plainly', empty.includes('Nothing counted yet.'));
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll checks passed. Shots in ${OUT}`);
