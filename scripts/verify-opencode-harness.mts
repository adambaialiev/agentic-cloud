// Note #780 in the real Workspace shell: OpenCode as the third harness.
// New agent offers it beside Claude Code and Codex; the Subscriptions picker
// offers OpenCode, whose own page is two steps — make a key in the OpenCode
// console, paste it — and the key lands as a subscription whose usage card
// says honestly that OpenCode keeps usage in its own console; an OpenCode
// agent's screen and model picker carry the Go models with OpenCode's own
// effort levels (none for Kimi K3); and its chat reads as any agent's does.
// Phone and desktop pictures of each.
//
// It serves the BUILT workspace-ui against stub reads (the harness, the key
// check and the routes have unit tests).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-opencode-harness.mts
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';
import { TELEGRAM_OPENCODE_MODEL_CATALOG } from '../backend/src/shared/model-catalog.js';
import { OPENCODE_USAGE_NOTICE } from '../backend/src/shared/harness-clis.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n780/shots');
mkdirSync(OUT, { recursive: true });
const UI = path.join(REPO, 'backend/dist/workspace-ui');
const PORT = Number(process.env.PORT || 4203);
const ORIGIN = `http://127.0.0.1:${PORT}`;

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().pop();
  if (!build) throw new Error(`no Chrome under ${root}`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const claudeSeat = {
  seatId: 's-max', provider: 'claude', label: 'Claude · 30 Sept 2026', planText: 'Max 20x', selected: true,
  windows: [
    { usedPercent: 12, percentText: '12', trackText: '5 hours' },
    { usedPercent: 31, percentText: '31', trackText: 'this week' },
  ],
};
const opencodeSeat = {
  seatId: 's-oc', provider: 'opencode', label: 'OpenCode · 20 Oct 2026', selected: true, windows: [],
};
let opencodeAdded = false;
const seats = () => (opencodeAdded ? [claudeSeat, opencodeSeat] : [claudeSeat]);
let runtime = { model: 'glm-5.3', effort: 'high' };
const created: string[] = [];
const keysPasted: string[] = [];
let signin: { provider: string; startedAt: string; state: Record<string, unknown> } | null = null;

const agentRow = (id: string, name: string, cli: string, model: string, effort?: string) => ({
  id, name, cli, status: 'ready', model, ...(effort ? { effort } : {}),
  recap: id === 'ada' ? 'Fixed the flaky checkout test and pushed branch fix-checkout; waiting for CI.' : undefined,
  recapAt: new Date(Date.now() - 4 * 60_000).toISOString(),
});
const state = () => ({
  org: {
    orgId: 'o1', name: 'ACC', role: 'admin', members: 1, seats: seats().length,
    seatProviders: opencodeAdded ? ['claude', 'opencode'] : ['claude'],
    seatUsage: seats().map((seat) => ({ ...seat, status: 'active', ...(seat.provider === 'opencode' ? { usageNotice: OPENCODE_USAGE_NOTICE } : {}) })),
  },
  organizations: [{ orgId: 'o1', name: 'ACC', role: 'admin', active: true, members: 1, agents: 2 }],
  canCreateOrg: true,
  user: {
    name: 'Adam',
    profile: { firstName: 'Adam', lastName: '', incomplete: false },
    account: { browserLogin: { enabled: true, username: 'adam' } },
  },
  agents: [
    agentRow('ada', 'Ada', 'opencode', runtime.model, runtime.effort || undefined),
    agentRow('isaac', 'Isaac', 'claude', 'opus', 'high'),
  ],
  prs: [], knowledgeProposals: [],
  secrets: null, repos: null, sites: null, knowledge: null, notes: null,
  notesArchived: 0, noteFiles: false,
});
const catalog = () => TELEGRAM_OPENCODE_MODEL_CATALOG.map((entry) => ({
  value: entry.value, label: entry.label,
  efforts: entry.efforts.map((effort) => ({ value: effort.value, label: effort.label, ...(effort.heavy ? { heavy: true } : {}) })),
}));

const app = express();
app.use(express.json());
app.get('/workspace/auth/session', (_req, res) => res.json({
  authenticated: true, username: 'adam', displayName: 'Adam', activeOrgId: 'o1',
  session: { sessionId: 's1', createdAt: 't', lastSeenAt: 't', absoluteExpiresAt: 't' },
}));
app.get('/workspace/api/state', (_req, res) => res.json(state()));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [], jobs: [] }));
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
app.get('/workspace/api/agents/:id/version', (req, res) => res.json(req.params.id === 'ada'
  ? {
    cliLabel: 'OpenCode', installed: '1.19.3', pinned: '1.19.3', cliUpdateAvailable: false, busy: false, workedMs: 41 * 60_000, turnCount: 9,
    model: runtime.model, ...(runtime.effort ? { effort: runtime.effort } : {}), docs: { file: 'AGENTS.md', version: 178, latest: 178, current: true },
  }
  : {
    cliLabel: 'Claude Code', cliUpdateAvailable: false, busy: false, workedMs: 0, turnCount: 12,
    model: 'opus', effort: 'high', docs: { file: 'CLAUDE.md', version: 178, latest: 178, current: true },
  }));
app.get('/workspace/api/agents/:id/runtime', (_req, res) => res.json({ cli: 'opencode', ...runtime, models: catalog() }));
app.post('/workspace/api/agents/:id/runtime', (req, res) => {
  const entry = TELEGRAM_OPENCODE_MODEL_CATALOG.find((option) => option.value === (req.body?.model ?? runtime.model))!;
  const effort = req.body?.effort ?? (entry.efforts.some((option) => option.value === runtime.effort) ? runtime.effort : (entry.efforts.find((option) => option.value === 'high') ?? entry.efforts[0])?.value ?? '');
  runtime = { model: entry.value, effort };
  res.json({ ok: true, cli: 'opencode', ...runtime, models: catalog() });
});
app.get('/workspace/api/agents/:id/chat/latest', (_req, res) => res.json({ message: null }));
app.get('/workspace/api/agents/:id/prs', (_req, res) => res.json({ prs: [], knowledgeProposals: [] }));
app.get('/workspace/api/agents/:id/chat', (_req, res) => res.json({
  messages: [
    { seq: 1, role: 'owner', at: new Date(Date.now() - 9 * 60_000).toISOString(), text: 'The checkout test keeps failing on CI — can you find out why and fix it?' },
    { seq: 2, role: 'agent', at: new Date(Date.now() - 6 * 60_000).toISOString(), text: 'Found it: the test waited a fixed 200 ms for the payment iframe, and CI is slower than a laptop. I replaced the sleep with a wait for the iframe’s ready event, ran the suite five times in a row (all green), and pushed it to branch fix-checkout.' },
    { seq: 3, role: 'agent', at: new Date(Date.now() - 5 * 60_000).toISOString(), text: 'CI is running on it now — I’ll propose it once the checks are green.' },
  ],
  working: false,
}));
app.post('/workspace/api/agents', (req, res) => { created.push(String(req.body?.cli)); res.status(201).json({ ok: true }); });
app.get('/workspace/api/org/signin', (_req, res) => res.json({ signin }));
app.post('/workspace/api/org/signin', (req, res) => {
  signin = { provider: String(req.body?.provider), startedAt: new Date().toISOString(), state: { phase: 'awaiting_code', url: 'https://opencode.ai/auth' } };
  res.json({ signin });
});
app.post('/workspace/api/org/signin/code', (req, res) => {
  keysPasted.push(String(req.body?.code));
  opencodeAdded = true;
  signin = { ...signin!, state: { phase: 'done', seatId: 's-oc', label: opencodeSeat.label } };
  res.json({ signin });
});
app.delete('/workspace/api/org/signin', (_req, res) => { signin = null; res.json({ ok: true }); });
app.get('/workspace/api/org/seats', (_req, res) => res.json({
  seats: seats().map((seat) => ({
    ...seat, status: 'active', createdAt: '2026-10-20T00:00:00Z',
    ...(seat.provider === 'opencode' ? { usageNotice: OPENCODE_USAGE_NOTICE } : {}),
  })),
  available: [],
}));
app.get('/workspace/api/org/tokens', (_req, res) => res.json({
  since: '2026-09-28',
  weeks: [{ start: '2026-10-19', providers: [
    { provider: 'claude', input: 120_000, output: 61_000, cacheRead: 4_100_000, cacheWrite: 210_000, reasoning: 0, models: ['opus'] },
    { provider: 'opencode', input: 88_000, output: 23_400, cacheRead: 1_900_000, cacheWrite: 0, reasoning: 6_100, models: ['glm-5.3'] },
  ] }],
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

/** The agents list's door, on Home's agents half (one list of every agent since note #843). */
async function openAgentsList(page: Page): Promise<boolean> {
  for (const address of ['/overview?org=o1&half=agents', '/?org=o1&half=agents']) {
    await page.goto(`${ORIGIN}${address}`, { waitUntil: 'networkidle0' });
    if (await page.$('#newAgentBtn')) return true;
  }
  return false;
}

const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  for (const [label, width, height] of [['phone', 390, 844], ['desktop', 1280, 860]] as const) {
    opencodeAdded = false;
    signin = null;
    runtime = { model: 'glm-5.3', effort: 'high' };
    const page = await browser.newPage();
    page.on('pageerror', (error) => check(`${label}: no page error`, false, `${String(error)} @ ${page.url()} ${(error as Error).stack?.split('\n').slice(1, 4).join(' | ') ?? ''}`));
    await page.setViewport({ width, height, deviceScaleFactor: 2 });

    // 1. New agent: OpenCode beside Claude Code and Codex.
    check(`${label}: the agents list has its New agent door`, await openAgentsList(page));
    await page.click('#newAgentBtn');
    await page.waitForSelector('.choices .choice', { timeout: 5_000 });
    const choices = await page.$$eval('.choices .choice', (nodes) => nodes.map((node) => (node as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
    check(`${label}: New agent offers three harnesses`, JSON.stringify(choices) === JSON.stringify([
      'Claude Code Runs on your Claude subscription', 'Codex Runs on your ChatGPT subscription', 'OpenCode Runs on your OpenCode Go subscription',
    ]), JSON.stringify(choices));
    await shoot(page, `${label}-1-new-agent`);
    // No OpenCode subscription yet: the pick walks to Subscriptions rather than into a refusal.
    await page.click('.choices .choice:nth-child(3)');
    await page.waitForSelector('#screenSeats', { timeout: 5_000 });
    check(`${label}: an OpenCode pick with no key goes to Subscriptions, creating nothing`, created.length === 0);

    // 2. The Subscriptions picker, then OpenCode's own page.
    await page.goto(`${ORIGIN}/seats/sign-in?org=o1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#seatSignInBody .crow', { timeout: 5_000 });
    const rows = await page.$$eval('#seatSignInBody .crow', (nodes) => nodes.map((node) => (node as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
    check(`${label}: the picker offers OpenCode`, rows.at(-1) === 'OpenCode OpenCode Go subscription, with its API key', JSON.stringify(rows));
    await shoot(page, `${label}-2-subscription-picker`);
    await page.click('#seatSignInBody .crow:nth-child(3)');
    await page.waitForSelector('input[aria-label="Paste your OpenCode API key"]', { timeout: 5_000 });
    check(`${label}: OpenCode's page is titled for it`, await text(page, '#seatSignInTitle') === 'Sign in to OpenCode');
    const steps = await page.$$eval('.signinstep .stepk', (nodes) => nodes.map((node) => (node as HTMLElement).innerText.replace(/\s+/g, ' ').trim().toLowerCase()));
    check(`${label}: two steps, the key as the code`, JSON.stringify(steps) === JSON.stringify(['1 make a key in opencode', '2 paste your key']), JSON.stringify(steps));
    check(`${label}: the key box is masked`, await page.$eval('input[aria-label="Paste your OpenCode API key"]', (node) => (node as HTMLInputElement).type) === 'password');
    check(`${label}: Add key waits for a key`, await page.$eval('#seatSignInFinish', (node) => (node as HTMLButtonElement).disabled));
    await shoot(page, `${label}-3-opencode-key-page`);
    await page.type('input[aria-label="Paste your OpenCode API key"]', 'sk-test-opencode-key-0001');
    await page.click('#seatSignInFinish');
    await page.waitForSelector('#screenSeats', { timeout: 5_000 });
    check(`${label}: the pasted key was sent as the code`, keysPasted.at(-1) === 'sk-test-opencode-key-0001');
    await page.waitForFunction('document.querySelector("#screenSeats")?.innerText.includes("OpenCode")', { timeout: 5_000 });
    await shoot(page, `${label}-3b-subscriptions-with-opencode`);

    // 3. The subscription, with its honest usage card.
    await page.goto(`${ORIGIN}/seats/s-oc?org=o1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#screenSeat', { timeout: 5_000 });
    const seatPage = await text(page, '#screenSeat');
    check(`${label}: the seat page names OpenCode`, await text(page, '#seatSub') === 'OpenCode subscription', await text(page, '#seatSub'));
    check(`${label}: the seat page says where its usage lives`, seatPage.includes('OpenCode keeps this subscription’s usage in its own console'));
    await shoot(page, `${label}-4-opencode-subscription`);

    // 4. The OpenCode agent: its screen, its model picker, its chat.
    await page.goto(`${ORIGIN}/agents/ada?org=o1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.runtimevalue', { timeout: 5_000 });
    const runtimeLine = await text(page, '.runtimevalue');
    check(`${label}: the agent thinks with glm-5.3 · high`, runtimeLine === 'glm-5.3 · high', runtimeLine);
    await shoot(page, `${label}-5-opencode-agent`);
    await page.click('.runtimevalue');
    await page.waitForSelector('.effortsteps', { timeout: 5_000 });
    const pickerText = await page.$eval('.screen', (node) => (node as HTMLElement).innerText);
    check(`${label}: the picker lists the Go models by name`, ['GLM-5.3', 'Kimi K3', 'DeepSeek V4 Pro', 'Qwen3.8 Max', 'MiMo V2.6 Pro'].every((name) => pickerText.includes(name)));
    await shoot(page, `${label}-6-opencode-model-picker`);
    const kimi = await page.evaluateHandle(`[...document.querySelectorAll('button')].find((node) => node.innerText.trim().startsWith('Kimi K3'))`);
    await (kimi as unknown as { click: () => Promise<void> }).click();
    await page.waitForFunction('document.body.innerText.includes("This model has no effort setting.")', { timeout: 5_000 });
    check(`${label}: Kimi K3 has no effort setting`, runtime.model === 'kimi-k3' && runtime.effort === '');
    await shoot(page, `${label}-7-kimi-no-effort`);

    runtime = { model: 'glm-5.3', effort: 'high' };
    await page.goto(`${ORIGIN}/chat/ada?org=o1`, { waitUntil: 'networkidle0' });
    await page.waitForFunction('document.body.innerText.includes("pushed it to branch fix-checkout")', { timeout: 10_000 });
    await shoot(page, `${label}-8-opencode-chat`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
