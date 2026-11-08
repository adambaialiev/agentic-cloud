// Note #636: on a proposal's row the proposing agent's face is the only thing
// that says who proposed it, so it is drawn at 24px — bigger than the 16px a
// face gets beside a name — and the line grows to hold it without clipping.
// The real shell runs against a scripted API; nothing is sent.
// npm --prefix backend run build:workspace-ui
// backend/node_modules/.bin/tsx scripts/verify-workspace-proposal-faces.mts
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { agent, emptyState, signedIn } from '../backend/workspace-ui/src/test/fixtures.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const out = process.env.OUT_DIR || path.join(process.env.HOME!, 'mini-preview');
mkdirSync(out, { recursive: true });
const cache = path.join(process.env.HOME!, '.cache/puppeteer/chrome');
const chrome = process.env.CHROME || path.join(cache, readdirSync(cache).sort().at(-1)!, 'chrome-linux64/chrome');
const shellArg = process.argv.indexOf('--shell');
const shell = shellArg > 0 ? path.resolve(process.argv[shellArg + 1]!) : path.join(root, 'backend/dist/workspace-ui');
const shot = process.argv.includes('--name') ? process.argv[process.argv.indexOf('--name') + 1]! : 'proposal-faces';
const at = new Date().toISOString();
const face = (name: string) => `/avatars/${name}.jpg`;
const state = emptyState({
  org: { orgId: 'o1', name: 'Studio', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] },
  notes: [], noteFiles: true,
  agents: [
    agent({ id: 'gus', name: 'Gus', model: 'opus', effort: 'xhigh', avatarUrl: face('gus'),
      recap: 'Mail conversation grouping and design-page update await owner approval.' }),
  ],
  knowledgeProposals: [{ id: 'k1', number: 290, title: 'Update "Email service design"', status: 'open',
    pages: ['email-service-design'], createdAt: at, agentName: 'Gus', agentAvatarUrl: face('gus'), agentId: 'gus',
    canDecide: true }],
  prs: [{ id: 'p1', number: 1131, repoName: 'infinite-agents',
    title: 'Mail: conversations — one row per thread, read on one screen (slice 8)', body: null,
    from: 'mail-slice-8', to: 'main', diffStat: { insertions: 3503, deletions: 921 }, status: 'open',
    createdAt: at, decidedAt: null, agentName: 'Gus', agentAvatarUrl: face('gus'), agentId: 'gus', canDecide: true,
    checks: { worst: 'success' } as never }],
});
const errors: string[] = [];
const app = express();
app.get('/workspace/auth/session', (_req, res) => res.json(signedIn()));
app.get('/workspace/api/state', (_req, res) => res.json(state));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
// The agents picker reads the whole queue for itself (note #721).
app.get('/workspace/api/decisions', (_req, res) => res.json({ prs: state.prs, knowledgeProposals: state.knowledgeProposals }));
app.use('/avatars', express.static(path.join(root, 'backend/assets/agent-avatars')));
app.use(['/api', '/auth'], (req, res) => {
  // Home's other cards ask for more than this check scripts; their answers
  // do not touch the proposal rows.
  if (!/\/(recap|briefing|seats|usage|org\/)/.test(req.originalUrl)) errors.push(`Unscripted ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Unscripted request' });
});
app.use('/workspace/app/assets', express.static(path.join(shell, 'assets')));
app.get('*', (_req, res) => res.sendFile(path.join(shell, 'index.html')));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewport({ width: 390, height: 520, deviceScaleFactor: 3 });
  // The owner met these rows on a room's page; since rooms left the product
  // (note #843) the queue stands over the cards in the agents picker, which
  // the overview's old address opens.
  await page.goto(`http://127.0.0.1:${port}/overview?org=o1&half=agents`);
  await page.waitForSelector('#agentSwitchSheet #agentSwitchDecisions .crow .cline .face');
  await page.waitForFunction('[...document.querySelectorAll("#agentSwitchDecisions .crow .cline .face")].every((img) => img.complete && img.naturalWidth > 0)');
  const rows = await page.$$eval('#agentSwitchDecisions .crow .cline .face', (faces) => faces.map((img) => {
    const face = img.getBoundingClientRect();
    const line = img.closest('.cline')!.getBoundingClientRect();
    return { width: face.width, height: face.height, top: face.top - line.top, bottom: line.bottom - face.bottom };
  }));
  await page.screenshot({ path: path.join(out, `${shot}.png`) });
  if (!process.argv.includes('--shot-only')) {
    assert.equal(rows.length, 2, 'one face on the knowledge row, one on the change row');
    for (const row of rows) {
      // Whole pixels: the sheet can still be finishing its slide (23.99997 px, note #1073 CI).
      assert.equal(Math.round(row.width), 24); assert.equal(Math.round(row.height), 24);
      assert.ok(row.top >= 0 && row.bottom >= 0, `face sits inside its line (${JSON.stringify(row)})`);
    }
    console.log('PASS proposal faces are 24px and fit their line');
  }
  assert.deepEqual(errors, []);
  console.log(`Screenshot: ${path.join(out, `${shot}.png`)}`);
} finally {
  await browser.close();
  server.close();
}
