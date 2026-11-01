// Note #773 in the real Workspace shell: "Primary" (grey) on the list row of
// the sign-in turns use first — and NOT on Home's compact plates, the
// owner's call — and an agent given its own subscription — the picker
// behind its Subscription row, the header line that names the choice, and
// the way back to the workplace default. Phone and desktop pictures of each.
//
// It serves the BUILT workspace-ui against stub reads (the pin route and the
// lease order have unit tests); the state below is shaped like the owner's
// own workplace on 2026-10-18: a Max 20x sign-in that is primary and a
// second Claude sign-in beside it.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-agent-subscription.mts
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n773');
mkdirSync(OUT, { recursive: true });
const UI = path.join(REPO, 'backend/dist/workspace-ui');
const PORT = Number(process.env.PORT || 4197);
const ORIGIN = `http://127.0.0.1:${PORT}`;

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().pop();
  if (!build) throw new Error(`no Chrome under ${root}`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const seats = [
  {
    seatId: 's-max', provider: 'claude', label: 'Claude · 30 Sept 2026', planText: 'Max 20x', selected: true,
    windows: [
      { usedPercent: 0, percentText: '0', trackText: '5 hours' },
      { usedPercent: 0, percentText: '0', trackText: 'other models' },
      { usedPercent: 0, percentText: '0', trackText: 'Fable' },
    ],
  },
  {
    seatId: 's-ai', provider: 'claude', label: 'Claude · 17 Oct 2026', planText: 'Ai', selected: false,
    windows: [
      { usedPercent: 72, percentText: '72', trackText: '5 hours' },
      { usedPercent: 22, percentText: '22', trackText: 'this week' },
    ],
  },
];
const pins: Record<string, string | undefined> = { isaac: undefined };
const written: Array<{ agent: string; seatId: string }> = [];

const agentRow = (id: string, name: string) => ({
  id, name, cli: 'claude', status: 'ready', model: 'opus', effort: 'high',
  ...(pins[id] ? { seatId: pins[id] } : {}),
});
const state = () => ({
  org: {
    orgId: 'o1', name: 'ACC', role: 'admin', members: 1, seats: 2, seatProviders: ['claude'], seatUsage: seats,
  },
  organizations: [{ orgId: 'o1', name: 'ACC', role: 'admin', active: true, members: 1, agents: 2 }],
  canCreateOrg: true,
  user: {
    name: 'Adam',
    profile: { firstName: 'Adam', lastName: '', incomplete: false },
    account: { browserLogin: { enabled: true, username: 'adam' } },
  },
  agents: [agentRow('isaac', 'Isaac'), agentRow('sadie', 'Sadie')],
  prs: [], knowledgeProposals: [],
  secrets: null, repos: null, sites: null, knowledge: null, notes: null,
  notesArchived: 0, noteFiles: false,
});

const app = express();
app.use(express.json());
app.get('/workspace/auth/session', (_req, res) => res.json({
  authenticated: true, username: 'adam', displayName: 'Adam', activeOrgId: 'o1',
  session: { sessionId: 's1', createdAt: 't', lastSeenAt: 't', absoluteExpiresAt: 't' },
}));
app.get('/workspace/api/state', (_req, res) => res.json(state()));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [], jobs: [] }));
// The Chief of Staff's reads, answered as an idle one would.
app.get('/workspace/api/recap', (_req, res) => res.json({
  orgId: 'o1', enabled: true,
  agent: { name: 'Workspace Agent', started: true, working: false, waiting: [] },
  summary: null, sources: [], updating: false, stale: false, incomplete: false,
  since: new Date().toISOString(), checkedAt: new Date().toISOString(),
}));
app.get('/workspace/api/recap/chat', (_req, res) => res.json({ orgId: 'o1', messages: [], working: false, waiting: [] }));
app.get('/workspace/api/recap/agent/settings', (_req, res) => res.json({ orgId: 'o1', settings: null, models: [] }));
app.get('/workspace/api/recap/settings', (_req, res) => res.json({ orgId: 'o1', settings: null, models: [] }));
app.get('/workspace/api/recap/agent', (_req, res) => res.json({
  orgId: 'o1', agent: { name: 'Workspace Agent', started: true, working: false, waiting: [] }, settings: null,
}));
app.get('/workspace/api/recap/agent/proactive', (_req, res) => res.json({ settings: { events: false }, recent: [] }));
app.get('/workspace/api/org/join-requests', (_req, res) => res.json({ joinRequests: [] }));
app.get('/workspace/api/profile/x', (_req, res) => res.json({}));
app.get('/workspace/api/agents/:id/version', (_req, res) => res.json({
  cliLabel: 'Claude Code', cliUpdateAvailable: false, busy: false, workedMs: 0, turnCount: 12,
  model: 'opus', effort: 'high', docs: { file: 'CLAUDE.md', version: 4, latest: 4, current: true },
}));
app.get('/workspace/api/agents/:id/chat/latest', (_req, res) => res.json({ message: null }));
app.get('/workspace/api/agents/:id/prs', (_req, res) => res.json({ prs: [], knowledgeProposals: [] }));
app.post('/workspace/api/agents/:id/seat', (req, res) => {
  const seatId = String(req.body?.seatId ?? '');
  written.push({ agent: req.params.id, seatId });
  pins[req.params.id] = seatId || undefined;
  res.json({ ok: true, seatId: seatId || null });
});
app.get('/workspace/api/org/seats', (_req, res) => res.json({
  seats: seats.map((seat) => ({ ...seat, status: 'active', createdAt: '2026-09-30T00:00:00Z' })),
  available: [],
}));
app.get('/workspace/api/notifications', (_req, res) => res.json({
  notifications: [], unread: 0, push: { available: false, subscriptions: 0 },
}));
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
const text = (page: Page, selector: string) => page.$eval(selector, (node) => (node as HTMLElement).innerText.trim());
const shoot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png`, fullPage: false });

const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  for (const [label, width, height] of [['phone', 390, 844], ['desktop', 1280, 860]] as const) {
    pins.isaac = undefined;
    const page = await browser.newPage();
    page.on('pageerror', (error) => check(`${label}: no page error`, false, String(error)));
    await page.setViewport({ width, height, deviceScaleFactor: 2 });

    // 1. The sign-ins, as Home draws them: no "Primary" on a compact plate.
    await page.goto(`${ORIGIN}/overview?org=o1&half=workplace`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.seatcard', { timeout: 10_000 });
    const plates = await page.$$eval('.seatcard', (cards) => cards.map((card) => (card as HTMLElement).innerText));
    check(`${label}: no plate says Primary`, plates.length === 2 && plates.every((plate) => !plate.includes('Primary')));
    await page.evaluate('document.querySelector(".seatcard").scrollIntoView({ block: "center" })');
    await shoot(page, `${label}-1-plates`);

    // 1b. "Your subscriptions": the primary's row says so, in grey.
    await page.goto(`${ORIGIN}/seats?org=o1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#seatsList .crow', { timeout: 10_000 });
    const marks = await page.$$eval('#seatsList .crow', (rows) => rows.map((row) => [...row.querySelectorAll('.badge')]
      .map((badge) => `${badge.textContent}:${getComputedStyle(badge).color}`)));
    // The accent as a computed colour, so the two compare like for like.
    const accent = await page.evaluate(`(() => { const probe = document.createElement('span'); probe.style.color = 'var(--accent)';
      document.body.appendChild(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })()`);
    console.log(`list marks (${label}): ${JSON.stringify(marks)} accent=${accent}`);
    check(`${label}: the list marks the Max 20x alone`, marks.length === 2 && marks[0]!.length === 1 && marks[0]![0]!.startsWith('Primary:') && marks[1]!.length === 0);
    check(`${label}: and not in the accent`, marks[0]![0] !== `Primary:${accent}`, `accent ${accent}`);
    await shoot(page, `${label}-1-list`);

    // 2. Isaac on the default: the row says so, the header says nothing.
    await page.goto(`${ORIGIN}/agents/isaac?org=o1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#agentFacts', { timeout: 10_000 });
    const subscriptionRow = async () => page.$$eval('#agentFacts .drow', (rows) => {
      const row = rows.find((candidate) => candidate.querySelector('.k')?.textContent === 'Subscription');
      return (row?.querySelector('.v') as HTMLElement | null)?.innerText.trim() ?? null;
    });
    check(`${label}: the row reads Workplace default`, await subscriptionRow() === 'Workplace default');
    check(`${label}: no header line for the default`, (await page.$('#agentInfoSeat')) === null);

    // 3. The picker.
    await page.click('button[aria-label^="Choose the subscription"]');
    await page.waitForSelector('#screenSeatPicker #seatPickerList', { timeout: 10_000 });
    const rows = await page.$$eval('#seatPickerList .crow', (nodes) => nodes.map((node) => (node as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
    console.log(`--- picker (${label}) ---\n${rows.join('\n')}\n---`);
    check(`${label}: the default leads and is current`, /^Workplace default Follows your primary — now Claude Max 20x current$/.test(rows[0] ?? ''), rows[0]);
    check(`${label}: then the Claude sign-ins, none repeating the primary`, rows.length === 3
      && rows[1]!.startsWith('Claude Max 20x') && !rows.slice(1).some((row) => row.includes('Primary')) && rows[2]!.startsWith('Claude Ai'));
    await shoot(page, `${label}-2-picker`);

    // 4. Choose the second sign-in: the badge moves, nothing pops up.
    await page.click('#seatPickerList [data-seat-id="s-ai"]');
    await page.waitForFunction('document.querySelector(\'#seatPickerList [data-seat-id="s-ai"]\')?.classList.contains("current")', { timeout: 5_000 });
    check(`${label}: the write named the sign-in`, written.at(-1)?.seatId === 's-ai');
    check(`${label}: no toast repeats the badge`, (await page.$('#banner')) === null);
    await shoot(page, `${label}-3-picked`);

    // 5. Back on Isaac: the header names the choice, and so does the row.
    await page.evaluate(`[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.textContent || '').trim() === 'Back').click()`);
    await page.waitForSelector('#agentInfoSeat', { timeout: 5_000 });
    check(`${label}: the header line names the chosen sign-in`, await text(page, '#agentInfoSeat') === 'on Claude Ai');
    check(`${label}: the row names it too`, await subscriptionRow() === 'Claude Ai');
    await page.evaluate('window.scrollTo(0, 0)');
    await shoot(page, `${label}-4-agent`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed');
console.log(`pictures in ${OUT}`);
process.exit(failures.length ? 1 : 0);
