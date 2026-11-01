// Note #652: the teammates' agents card at the foot of the agents picker
// puts one person per line and, under each, the OPEN PROPOSALS that
// person's agents have made ready — the ones the reader cannot decide, drawn
// with the queue's own rows and each a door to the proposal. The reader's
// own proposals stay in the picker's queue, over the cards, and out of the
// card. It stood on a room's Agents tab, with that room's proposals, until
// rooms left the product (note #843). The real shell runs against a
// scripted API; nothing is sent.
// npm --prefix backend run build:workspace-ui
// backend/node_modules/.bin/tsx scripts/verify-workspace-team-proposals.mts
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
const shot = process.argv.includes('--name') ? process.argv[process.argv.indexOf('--name') + 1]! : 'team-proposals';
const at = new Date().toISOString();
const face = (name: string) => `/avatars/${name}.jpg`;
const dana = { userId: 'dana', name: 'Dana Ives' };
const ben = { userId: 'ben', name: 'Ben Ortiz' };
const cleo = { userId: 'cleo', name: 'Cleo Park' };
const state = emptyState({
  org: { orgId: 'o1', name: 'Studio', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] },
  notes: [], noteFiles: true,
  agents: [agent({ id: 'gus', name: 'Gus', model: 'opus', effort: 'xhigh', avatarUrl: face('gus') })],
  teamAgents: [
    { id: 'leo', name: 'Leo', avatarUrl: face('leo'), status: 'ready', working: true, owner: dana },
    { id: 'nora', name: 'Nora', avatarUrl: face('nora'), status: 'ready', owner: dana },
    { id: 'otis', name: 'Otis', avatarUrl: face('otis'), status: 'ready', owner: ben },
    { id: 'milo', name: 'Milo', avatarUrl: face('milo'), status: 'ready', owner: cleo },
    { id: 'ivy', name: 'Ivy', avatarUrl: face('ivy'), status: 'setting-up', owner: cleo },
  ],
  knowledgeProposals: [
    { id: 'k1', number: 290, title: 'Update "Email service design"', status: 'open', pages: ['email-service-design'],
      createdAt: at, agentName: 'Gus', agentAvatarUrl: face('gus'), agentId: 'gus', canDecide: true },
    { id: 'k2', number: 291, title: 'How a card is drawn', status: 'open', pages: ['how-a-card-is-drawn'],
      createdAt: at, agentName: 'Otis', agentAvatarUrl: face('otis'), agentId: 'otis', canDecide: false },
  ],
  prs: [
    { id: 'p1', number: 1131, repoName: 'infinite-agents', title: 'Mail: conversations on one screen', body: null,
      from: 'mail-slice-8', to: 'main', diffStat: { insertions: 3503, deletions: 921 }, status: 'open', createdAt: at,
      decidedAt: null, agentName: 'Gus', agentAvatarUrl: face('gus'), agentId: 'gus', canDecide: true,
      checks: { total: 1, failing: 0, pending: 0, worst: 'success' } },
    { id: 'p2', number: 1140, repoName: 'infinite-agents', title: 'Teammates’ proposals on the Agents tab', body: null,
      from: 'team-proposals', to: 'main', diffStat: { insertions: 118, deletions: 9 }, status: 'open', createdAt: at,
      decidedAt: null, agentName: 'Leo', agentAvatarUrl: face('leo'), agentId: 'leo', canDecide: false,
      checks: { total: 1, failing: 0, pending: 1, worst: 'pending' } },
  ],
});
const errors: string[] = [];
const app = express();
app.get('/workspace/auth/session', (_req, res) => res.json(signedIn()));
app.get('/workspace/api/state', (_req, res) => res.json(state));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [], teamWorking: ['leo'] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
// The picker reads the reader's own queue for itself (note #721): what they
// can decide.
app.get('/workspace/api/decisions', (_req, res) => res.json({
  prs: state.prs.filter((pr) => pr.canDecide !== false),
  knowledgeProposals: state.knowledgeProposals.filter((proposal) => proposal.canDecide !== false),
}));
app.use('/avatars', express.static(path.join(root, 'backend/assets/agent-avatars')));
app.use(['/api', '/auth'], (req, res) => {
  if (!/\/(recap|briefing|seats|usage|org\/|prs\/)/.test(req.originalUrl)) errors.push(`Unscripted ${req.method} ${req.originalUrl}`);
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
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
  // The overview's address opens Home with the agents picker standing.
  await page.goto(`http://127.0.0.1:${port}/overview?half=agents&org=o1`);
  await page.waitForSelector('#agentSwitchSheet #teamAgents .teamproposals .crow .cline .face');
  await page.waitForFunction('[...document.querySelectorAll("#teamAgents img")].every((img) => img.complete && img.naturalWidth > 0)');
  const texts = (selector: string) => page.$$eval(selector, (nodes) => nodes.map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
  const strip = await page.$eval('#teamAgents', (node) => {
    const card = node.getBoundingClientRect();
    return [...node.querySelectorAll('.teamgroup')].map((group) => {
      const line = group.querySelector('.teamline')!.getBoundingClientRect();
      const list = group.querySelector('.teamproposals')?.getBoundingClientRect();
      return {
        owner: group.querySelector('.ownername')!.textContent,
        lineAbove: list ? line.bottom <= list.top : true,
        flush: list ? Math.abs(list.left - card.left) <= 1.5 && Math.abs(list.right - card.right) <= 1.5 : true,
        oneLine: line.height < 60,
        rows: group.querySelectorAll('.teamproposals .crow').length,
      };
    });
  });
  await page.evaluate('document.getElementById("teamAgents").scrollIntoView({ block: "end" })');
  const box = await page.$eval('#teamAgents', (node) => {
    const r = node.getBoundingClientRect();
    return { x: 0, y: Math.max(0, Math.floor(r.top) - 12), width: 390, height: Math.ceil(r.height) + 24 };
  });
  await page.screenshot({ path: path.join(out, `${shot}.png`), clip: box });
  if (!process.argv.includes('--shot-only')) {
    assert.deepEqual(await texts('#teamAgents .teamgroup:nth-child(1) .teamproposals .crow .name'), ['Teammates’ proposals on the Agents tab'], 'Dana’s under Dana');
    assert.deepEqual(await texts('#teamAgents .teamgroup:nth-child(2) .teamproposals .crow .name'), ['How a card is drawn'], 'Ben’s under Ben');
    assert.deepEqual(await texts('#teamAgents .teamcount'), ['5 agents · 1 working · 2 proposals']);
    await page.waitForSelector('#agentSwitchDecisions .crow', { timeout: 10_000 });
    assert.deepEqual(await texts('#agentSwitchDecisions .crow .name'), ['Mail: conversations on one screen', 'Update "Email service design"'],
      'the reader’s own stay in the queue');
    assert.equal((await page.$$('#teamAgents .teamproposals .crow .facedot')).length, 1, 'the live disc on Leo’s row');
    assert.deepEqual(strip.map((g) => [g.owner, g.rows]), [['Dana Ives', 1], ['Ben Ortiz', 1], ['Cleo Park', 0]], 'one person per line, with or without proposals');
    for (const group of strip) {
      assert.ok(group.oneLine, `${group.owner}’s line is one line`);
      assert.ok(group.lineAbove, `${group.owner}’s line stands above their proposals`);
      assert.ok(group.flush, `${group.owner}’s rows run to the card’s edges`);
    }
    // It opens inside the agents picker, as a page over its cards (note
    // #722): the page on top names the address it draws.
    await page.click('#teamAgents .teamgroup:nth-child(1) .teamproposals .crow');
    await page.waitForFunction(
      'document.querySelector("#agentSwitchSheet .windowpage:not([hidden])")?.dataset.address === "/decisions/pr/p2"',
      { timeout: 10_000 },
    );
    assert.equal(await page.evaluate('location.pathname'), '/', 'the address stays the conversation’s');
    console.log('PASS each teammate’s proposals stand under that person, and each opens the proposal');
  }
  assert.deepEqual(errors, []);
  console.log(`Screenshot: ${path.join(out, `${shot}.png`)}`);
} finally {
  await browser.close();
  server.close();
}
