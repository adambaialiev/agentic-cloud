// Note #779 in the real Workspace shell: the Schedule card on an agent's
// screen — a proposal awaiting the owner, the approve that starts the clock,
// an active schedule's row (cadence, window, next tick, today's turns against
// the cap, skipped, failed), Pause/Resume, and a cap pause with its reason.
// Phone and desktop pictures of each. It serves the BUILT workspace-ui
// against stub reads; the service and routes have unit tests.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-agent-schedule.mts
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n779/shots');
mkdirSync(OUT, { recursive: true });
const UI = path.join(REPO, 'backend/dist/workspace-ui');
const PORT = Number(process.env.PORT || 4199);
const ORIGIN = `http://127.0.0.1:${PORT}`;

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().pop();
  if (!build) throw new Error(`no Chrome under ${root}`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const base = {
  id: 'sch_7f3a9c1e2b4d', agentId: 'producer', agentName: 'Producer', message: 'Take the next beat.',
  everyMinutes: 8, windowFrom: '07:00', windowTo: '23:00', timeZone: 'America/Los_Angeles', capTurns: 120,
  summary: 'every 8 minutes, 07:00–23:00 America/Los_Angeles, at most 120 turns a day',
  failStreak: 0, ticking: false, proposedBy: { agentId: 'producer', name: 'Producer' },
  createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
};
const views = {
  proposed: { ...base, status: 'proposed', awake: false, day: { date: '2026-10-19', turns: 0, tokens: 0, skipped: 0, failed: 0, resets: 0 } },
  active: {
    ...base, status: 'active', awake: true, decidedAt: new Date().toISOString(),
    day: { date: '2026-10-19', turns: 37, tokens: 412_000, skipped: 2, failed: 1, resets: 1 },
    nextTickAt: new Date(Date.now() + 5 * 60_000).toISOString(), lastTickAt: new Date(Date.now() - 3 * 60_000).toISOString(), lastOutcome: 'ran',
  },
  paused: {
    ...base, status: 'paused', awake: false, decidedAt: new Date().toISOString(),
    pause: { reason: 'cap', at: new Date().toISOString(), until: new Date(Date.now() + 70 * 60_000).toISOString(), text: 'paused: daily cap reached, resumes at midnight' },
    day: { date: '2026-10-19', turns: 120, tokens: 1_290_000, skipped: 4, failed: 1, resets: 2 },
    lastTickAt: new Date(Date.now() - 60_000).toISOString(), lastOutcome: 'ran',
  },
};
let current: keyof typeof views = 'proposed';
const decisions: string[] = [];

const agentRow = (id: string, name: string) => ({ id, name, cli: 'claude', status: 'ready', model: 'fable', effort: 'medium' });
const state = () => ({
  org: { orgId: 'o1', name: 'Demonstrations', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'], seatUsage: [] },
  organizations: [{ orgId: 'o1', name: 'Demonstrations', role: 'admin', active: true, members: 1, agents: 2 }],
  canCreateOrg: true,
  user: { name: 'Adam', profile: { firstName: 'Adam', lastName: '', incomplete: false }, account: { browserLogin: { enabled: true, username: 'adam' } } },
  agents: [agentRow('producer', 'Producer'), agentRow('truman', 'Truman')],
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
app.get('/workspace/api/agents/:id/version', (_req, res) => res.json({
  cliLabel: 'Claude Code', cliUpdateAvailable: false, busy: false, workedMs: 0, turnCount: 37,
  model: 'fable', effort: 'medium', docs: { file: 'CLAUDE.md', version: 4, latest: 4, current: true },
}));
app.get('/workspace/api/agents/:id/chat/latest', (_req, res) => res.json({ message: null }));
app.get('/workspace/api/agents/:id/prs', (_req, res) => res.json({ prs: [], knowledgeProposals: [] }));
app.get('/workspace/api/agents/:id/schedule', (_req, res) => res.json({ schedule: views[current] }));
app.get('/workspace/api/agents/:id/chat', (_req, res) => res.json({
  messages: [{ seq: 1, role: 'platform', at: new Date(Date.now() - 60_000).toISOString(),
    text: 'Producer asked for a schedule: "Take the next beat." every 8 minutes, 07:00–23:00 America/Los_Angeles, at most 120 turns a day. Approve or reject it under Schedule on this screen.' }],
  working: false,
}));
app.post('/workspace/api/agents/:id/schedule/decision', (req, res) => {
  const decision = String(req.body?.decision ?? '');
  decisions.push(decision);
  current = decision === 'approve' || decision === 'resume' ? 'active' : decision === 'pause' ? 'paused' : current;
  if (decision === 'pause') views.paused.pause = { reason: 'owner', at: new Date().toISOString(), text: 'paused by you' } as never;
  res.json({ schedule: decision === 'remove' || decision === 'reject' ? null : views[current] });
});
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
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
const shoot = async (page: Page, name: string) => {
  await page.evaluate('document.querySelector("#agentSchedule")?.scrollIntoView({ block: "center" })');
  await page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png`, fullPage: false });
};
const shootChat = async (page: Page, name: string) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png`, fullPage: false }); };
const buttons = (page: Page) => page.$$eval('#agentScheduleActions button', (nodes) => nodes.map((node) => (node as HTMLElement).innerText.trim()));

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
try {
  for (const [label, width, height] of [['phone', 390, 844], ['desktop', 1280, 860]] as const) {
    current = 'proposed';
    views.paused.pause = { reason: 'cap', at: new Date().toISOString(), until: new Date(Date.now() + 70 * 60_000).toISOString(), text: 'paused: daily cap reached, resumes at midnight' } as never;
    const page = await browser.newPage();
    page.on('pageerror', (error) => check(`${label}: no page error`, false, String(error)));
    await page.setViewport({ width, height, deviceScaleFactor: 2 });

    // 0. The ask card in the agent's chat carries Approve and Reject itself
    //    (Adam, 20 Oct: "approve and reject buttons should be also in the card").
    await page.goto(`${ORIGIN}/chat/producer?org=o1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.scheduleaskactions', { timeout: 10_000 });
    const askButtons = await page.$$eval('.scheduleaskactions button', (nodes) => nodes.map((node) => (node as HTMLElement).innerText.trim()));
    check(`${label}: the chat card offers Approve and Reject`, JSON.stringify(askButtons) === JSON.stringify(['Approve', 'Reject']), JSON.stringify(askButtons));
    await shootChat(page, `${label}-0-chat-ask`);
    await page.click('.scheduleaskactions .btn.primary');
    await page.waitForSelector('.scheduleaskanswer', { timeout: 5_000 });
    check(`${label}: approved from the chat card`, decisions.at(-1) === 'approve' && await text(page, '.scheduleaskanswer') === 'Approved');
    await shootChat(page, `${label}-0-chat-approved`);
    current = 'proposed';
    decisions.length = 0;

    // 1. The proposal, awaiting the owner.
    await page.goto(`${ORIGIN}/agents/producer?org=o1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#agentSchedule', { timeout: 10_000 });
    check(`${label}: the card says it awaits approval`, await text(page, '#agentScheduleState') === 'Awaiting your approval');
    check(`${label}: Approve and Reject`, JSON.stringify(await buttons(page)) === JSON.stringify(['Approve', 'Reject']));
    check(`${label}: the cost is said`, (await text(page, '#agentScheduleHint')).includes('machine stays awake for the whole window'));
    await shoot(page, `${label}-1-proposed`);

    // 2. Approve: the clock starts, the row shows today's count against the cap.
    await page.click('#agentScheduleActions .btn.primary');
    await page.waitForFunction('document.querySelector("#agentScheduleToday") !== null', { timeout: 5_000 });
    check(`${label}: approve was written`, decisions.at(-1) === 'approve');
    check(`${label}: active`, await text(page, '#agentScheduleState') === 'Active');
    const today = await text(page, '#agentScheduleToday');
    check(`${label}: today's count against the cap`, today === '37 of 120 turns · 2 skipped · 1 failed · 1 reset', today);
    check(`${label}: the next tick`, /^Next tick in \d+m$/.test(await text(page, '#agentScheduleNext')), await text(page, '#agentScheduleNext'));
    check(`${label}: Pause and Remove`, JSON.stringify(await buttons(page)) === JSON.stringify(['Pause', 'Remove']));
    check(`${label}: the awake cost`, (await text(page, '#agentScheduleHint')).includes("keeps Producer's machine awake"));
    await shoot(page, `${label}-2-active`);

    // 3. Pause by hand, then resume.
    await page.click('#agentScheduleActions .btn.ghost');
    await page.waitForFunction('document.querySelector("#agentSchedule")?.getAttribute("data-status") === "paused"', { timeout: 5_000 });
    check(`${label}: paused by you`, await text(page, '#agentScheduleState') === 'Paused — by you');
    check(`${label}: Resume and Remove`, JSON.stringify(await buttons(page)) === JSON.stringify(['Resume', 'Remove']));
    await shoot(page, `${label}-3-paused-by-owner`);
    await page.click('#agentScheduleActions .btn.primary');
    await page.waitForFunction('document.querySelector("#agentSchedule")?.getAttribute("data-status") === "active"', { timeout: 5_000 });
    check(`${label}: resumed`, decisions.at(-1) === 'resume');

    // 4. The cap pause, as the sweep leaves it.
    current = 'paused';
    views.paused.pause = { reason: 'cap', at: new Date().toISOString(), until: new Date(Date.now() + 70 * 60_000).toISOString(), text: 'paused: daily cap reached, resumes at midnight' } as never;
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#agentSchedule[data-status="paused"]', { timeout: 10_000 });
    check(`${label}: the cap pause names itself`, await text(page, '#agentScheduleState') === 'Paused — daily cap reached, resumes at midnight');
    check(`${label}: 120 of 120`, (await text(page, '#agentScheduleToday')).startsWith('120 of 120 turns'));
    check(`${label}: resumes in about an hour`, await text(page, '#agentScheduleNext') === 'Resumes in 1h', await text(page, '#agentScheduleNext'));
    await shoot(page, `${label}-4-cap`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed');
console.log(`pictures in ${OUT}`);
process.exit(failures.length ? 1 : 0);
