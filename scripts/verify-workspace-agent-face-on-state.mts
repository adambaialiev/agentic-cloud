// Opens the real Workspace shell on Home with the recap reads STALLED, and
// reads back what note #627 changed: the Workspace Agent's face is drawn
// from api/state, not the bot glyph until api/recap lands.
//
// Since note #656 the agent is hidden. Since 2026-10-10 its conversation is
// Home itself, at /. Since note #715 it is the Chief of Staff's, and since
// the owner's follow-up its face is back in the header as the door to the
// Workplace window. The gate's "Your team is arriving" screen is gone (note
// #726): the team the Chief of Staff brings in is a card at the foot of
// Home's log, `#firstRunTeam`, drawn off the state read while any agent is
// planned or setting up — so that card is where the six agents' faces are
// read, before the chat read answers and after. It was a card per room,
// under the room's name, until rooms left the product (note #843): the six
// arrive under one heading.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-agent-face-on-state.mts
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
const UI = path.join(REPO, 'backend/dist/workspace-ui');
const AVATARS = path.join(REPO, 'backend/assets/agent-avatars');
const PORT = Number(process.env.PORT || 4197);
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** How long the recap reads stay out: long enough to look at the screen without them. */
const RECAP_DELAY_MS = 8_000;

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().pop();
  if (!build) throw new Error(`no Chrome under ${root}`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const team = ['Milo', 'Mia', 'Rowan', 'Ivy', 'Ben', 'Clara'] as const;
const faces = ['milo', 'mia', 'rowan', 'ivy', 'ben', 'clara'];
let arriving = true;
const state = () => ({
  org: {
    orgId: 'o1', name: 'Sam’s workplace', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'], founded: true,
    // The face rides the state (note #627), the same URL api/recap resolves.
    workspaceAgentAvatarUrl: '/workspace/avatars/workspace-agent',
  },
  organizations: [{ orgId: 'o1', name: 'Sam’s workplace', role: 'admin', active: true, members: 1, agents: 6 }],
  canCreateOrg: true,
  user: {
    name: 'Saddam',
    profile: { firstName: 'Saddam', lastName: '', incomplete: false },
    account: { browserLogin: { enabled: true, username: 'saddam' } },
  },
  // Being brought in (note #726): two still planned, the rest with their
  // computers being built; all ready once `arriving` drops.
  agents: team.map((name, index) => ({
    id: `a${index}`, name, cli: 'claude', status: !arriving ? 'ready' : index === 0 || index === 4 ? 'planned' : 'setting-up',
    avatarUrl: `/workspace/avatars/${faces[index]}`,
  })),
  prs: [], knowledgeProposals: [],
  secrets: null, repos: null, sites: null, knowledge: null, notes: null,
  notesArchived: 0, noteFiles: false,
});
const recap = () => ({
  orgId: 'o1', enabled: true,
  agent: { name: 'Workspace Agent', avatarUrl: '/workspace/avatars/workspace-agent', started: true, working: true, phase: 'Preparing its computer…', waiting: [] },
  summary: null, sources: [], updating: false, stale: false, incomplete: false,
  since: new Date().toISOString(), checkedAt: new Date().toISOString(),
});
const later = <T,>(value: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(value()), RECAP_DELAY_MS));

const app = express();
app.use(express.json());
app.get('/workspace/auth/session', (_req, res) => res.json({
  authenticated: true, username: 'saddam', displayName: 'Saddam', activeOrgId: 'o1',
  session: { sessionId: 's1', createdAt: 't', lastSeenAt: 't', absoluteExpiresAt: 't' },
}));
app.get('/workspace/api/state', (_req, res) => res.json(state()));
app.get('/workspace/api/org/cloud', (_req, res) => res.json({
  orgId: 'o1', role: 'admin', fly: { connected: true, orgSlug: 'nomad', peer: 'up' }, machines: null,
}));
// The two reads that used to carry the face alone, a beat behind the state.
app.get('/workspace/api/recap', (_req, res) => { void later(recap).then((answer) => res.json(answer)); });
app.get('/workspace/api/recap/chat', (_req, res) => {
  // `orgId` as the real route carries it: the screen keeps only an answer
  // for the workplace it stands in, so without it the read never "lands".
  void later(() => ({ orgId: 'o1', messages: [], working: false, waiting: [], avatarUrl: '/workspace/avatars/workspace-agent' })).then((answer) => res.json(answer));
});
app.get('/workspace/api/recap/agent/settings', (_req, res) => res.json({ orgId: 'o1', settings: null, models: [] }));
app.get('/workspace/api/recap/settings', (_req, res) => res.json({ orgId: 'o1', settings: null, models: [] }));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [], jobs: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0 }));
app.get('/workspace/api/*', (_req, res) => res.json({}));
app.get('/workspace/avatars/:slug', (req, res) => res.sendFile(path.join(AVATARS, `${req.params.slug}.jpg`)));
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

  // 1. Home, with the team being brought in and the chat read still out:
  // the progress card at the foot of the log, six agents under one heading,
  // each in its own dog off the state read, and no Chief of Staff row (note
  // #656) — neither while the chat read is out nor once it has answered.
  await page.goto(`${ORIGIN}/?org=o1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => [...document.querySelectorAll('#firstRunTeam .arrivingroom img.avatar')].length === 6
    && [...document.querySelectorAll<HTMLImageElement>('#firstRunTeam img.avatar')].every((img) => img.complete), { timeout: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.screenshot({ path: path.join(OUT, 'n627-arriving.png') as `${string}.png`, fullPage: true });
  const cardShape = await page.evaluate(() => ({
    inLog: Boolean(document.querySelector('#recapChatLog #firstRunTeam')),
    heads: [...document.querySelectorAll('#firstRunTeam .arrivinghead')].map((node) => node.textContent?.trim()),
    lines: [...document.querySelectorAll('#firstRunTeam .crow[data-agent] .ctext')].map((node) => node.textContent?.trim()),
    loading: [...document.querySelectorAll('#recapChatLog [role="status"]')].some((node) => node.textContent === 'Loading conversation…'),
  }));
  check('the team card stands at the foot of Home’s log before the chat read answers, one card for every agent',
    cardShape.inLog && cardShape.loading && JSON.stringify(cardShape.heads) === JSON.stringify(['Arriving']), JSON.stringify(cardShape));
  check('…saying Starting… for a planned agent and Computer being built… for one setting up',
    JSON.stringify(cardShape.lines) === JSON.stringify(['Starting…', 'Computer being built…', 'Computer being built…', 'Computer being built…', 'Starting…', 'Computer being built…']), JSON.stringify(cardShape.lines));
  const roomFaces = await page.$$eval('#firstRunTeam .crow[data-agent]', (rows) => rows.map((row) => row.querySelector('img.avatar')?.getAttribute('src') ?? null));
  check('the six agents wear their dogs off the state read',
    JSON.stringify(roomFaces) === JSON.stringify(faces.map((face) => `/workspace/avatars/${face}`)), JSON.stringify(roomFaces));
  check('no Chief of Staff row while the chat read is out', !(await page.$('#workspaceAgentArriving')) && !(await page.$('#firstRunTeam .crow[data-agent="workspace-agent"]')));
  await new Promise((resolve) => setTimeout(resolve, RECAP_DELAY_MS + 1_000));
  const afterRead = await page.evaluate(() => ({
    chiefRow: Boolean(document.querySelector('#workspaceAgentArriving')),
    rows: document.querySelectorAll('#firstRunTeam .crow[data-agent]').length,
    loading: [...document.querySelectorAll('#recapChatLog [role="status"]')].some((node) => node.textContent === 'Loading conversation…'),
    empty: Boolean(document.querySelector('#recapChatLog .chatempty')),
  }));
  check('…nor once it has answered', !afterRead.chiefRow && afterRead.rows === 6 && !afterRead.loading, JSON.stringify(afterRead));

  // 2. Its conversation header, with the chat read still out: its own dog
  //    from the state read, so no glyph flashes in before it. Every agent
  //    ready now, so the team card is gone from the log.
  arriving = false;
  await page.goto(`${ORIGIN}/?org=o1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screenHome #recapChatTitle', { timeout: 10_000 });
  check('once every agent is ready the team card is gone', !(await page.$('#firstRunTeam')));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.screenshot({ path: path.join(OUT, 'n627-chat-header.png') as `${string}.png` });
  // The face rides api/state (note #627): the workplace's own picture is
  // there before the chat read answers, so the header never flashes the bot
  // glyph — and since the owner's follow-up to note #715 the face is back
  // in the header, as the door to Workplace.
  const header = () => page.$eval('#screenHome .chathead', (node) => ({
    title: document.getElementById('recapChatTitle')?.textContent?.trim() ?? '',
    face: Boolean(document.getElementById('recapChatFace')),
    img: node.querySelectorAll('#recapChatFace img.avatar').length,
    glyph: node.querySelectorAll('#recapChatFace .icon').length,
  }));
  const early = await header();
  check('the header is titled Chief of Staff before its own read answers', early.title === 'Chief of Staff', JSON.stringify(early));
  check('…and wears its own dog off the state read — no bot glyph — while the read is out',
    early.face && early.img === 1 && early.glyph === 0, JSON.stringify(early));
  await new Promise((resolve) => setTimeout(resolve, RECAP_DELAY_MS + 1_000));
  const settled = await header();
  check('…and still once it has answered', settled.title === 'Chief of Staff' && settled.face && settled.img === 1 && settled.glyph === 0, JSON.stringify(settled));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
