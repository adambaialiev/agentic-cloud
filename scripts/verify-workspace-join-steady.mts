// Note #639: pressing the request button on an invitation must not blank the
// page it is already looking at. Adopting the request id the server just
// handed back re-keyed the reader, which wiped the answer and redrew the
// header and the card through the "Opening invitation" state — a visible
// flick on the way to a page whose words barely changed.
//
// This harness records what the header and the card actually DO across that
// press, with a delay on the read so any blank window is wide open, and fails
// if the workplace's name ever leaves the header — or if a monogram appears
// beside it, which the owner asked for off the invitation entirely.

import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.join(REPO, 'backend/dist/workspace-ui');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const PORT = Number(process.env.PORT || 4193);
const ORIGIN = `http://127.0.0.1:${PORT}`;

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(cache).filter((name) => name.startsWith('linux-')).sort();
  const newest = builds[builds.length - 1];
  if (!newest) throw new Error(`no Chrome under ${cache} — npx puppeteer browsers install chrome`);
  return path.join(cache, newest, 'chrome-linux64/chrome');
}

const ORG = 'ACC';
const now = () => new Date().toISOString();
const inSixDays = () => new Date(Date.now() + 6 * 86_400_000).toISOString();

let joinStatus: 'available' | 'pending' | 'member' = 'available';
// The read is slow on purpose: a refetch that blanks the page holds the empty
// state for this long, which is exactly what a person sees on a real network.
let readDelay = 0;
let reads = 0;
let redeems = 0;

const session = {
  authenticated: true, username: 'jon', displayName: 'Jon Jones',
  session: { sessionId: 's1', createdAt: now(), lastSeenAt: now(), absoluteExpiresAt: inSixDays() },
};
const state = () => ({
  org: { orgId: 'o1', name: 'Harbor Studio', role: 'member', members: 1, seats: 0, seatProviders: [] },
  organizations: [{ orgId: 'o1', name: 'Harbor Studio', role: 'member', active: true, members: 1, agents: 0 }],
  canCreateOrg: true,
  user: { name: 'Jon Jones', profile: { firstName: 'Jon', lastName: 'Jones', incomplete: false }, account: { browserLogin: { enabled: true, username: 'jon' } } },
  agents: [], prs: [], knowledgeProposals: [], secrets: null, repos: null, sites: null,
  knowledge: null, notes: null, notesArchived: 0, noteFiles: false,
});

const app = express();
app.use(express.json());
app.get('/workspace/auth/session', (_req, res) => res.json(session));
app.get('/workspace/api/state', (_req, res) => res.json(state()));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/org/invites/:token', async (_req, res) => {
  reads += 1;
  if (readDelay) await new Promise((resolve) => setTimeout(resolve, readDelay));
  res.json({ status: joinStatus, orgId: 'o2', name: ORG, ...(joinStatus === 'available' ? {} : { requestId: 'jr-1' }) });
});
app.get('/workspace/api/org/join-requests/:id', async (_req, res) => {
  reads += 1;
  if (readDelay) await new Promise((resolve) => setTimeout(resolve, readDelay));
  res.json({ status: joinStatus, requestId: 'jr-1', orgId: 'o2', name: ORG });
});
app.post('/workspace/api/org/invites/:token/redeem', (_req, res) => {
  redeems += 1;
  joinStatus = 'pending';
  res.json({ ok: true, status: 'pending', requestId: 'jr-1', orgId: 'o2', name: ORG });
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

type Frame = { at: number; title: string; sub: string; mark: string; status: string; height: number };

const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 860, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));

  // A read that is plainly late holds the card's SHAPE — three grey lines,
  // no glyph and no state word. The old build drew a whole state here: an
  // icon box, "Checking invite", and a sentence about it.
  await page.evaluateOnNewDocument(`(() => {
    globalThis.__sawWait = false;
    const watch = () => { if (document.getElementById('inviteWait')) globalThis.__sawWait = true; };
    new MutationObserver(watch).observe(document, { subtree: true, childList: true });
    watch();
  })()`);
  readDelay = 700;
  await page.goto(`${ORIGIN}/invite/share-one`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inviteWait .skel', { timeout: 10_000 });
  check('a late read holds the card’s shape rather than naming a state',
    (await page.$$('#inviteWait .skel')).length === 3
    && !(await page.$('#inviteWait .iconbox'))
    && !(await page.$('#inviteWait .join-status'))
    && !(await page.evaluate(() => document.body.textContent?.includes('Checking invite') ?? false)));
  await page.screenshot({ path: path.join(OUT, 'join-steady-opening.png') as `${string}.png`, fullPage: false });
  await page.waitForFunction(() => document.querySelector('.join-status')?.textContent === 'Invitation ready');
  check('the invitation opens on the workplace it is for', (await page.$eval('#inviteTitle', (n) => n.textContent)) === ORG);
  check('the watcher that must stay silent below does see this one',
    (await page.evaluate('globalThis.__sawWait')) === true);

  // And an answer that arrives at once draws no wait at all — the flash the
  // shared wait vocabulary exists to prevent (`ui/wait.ts`, note #287). The
  // watcher is armed from the document's first byte and reset by each
  // navigation, and it is asked about BOTH loads: a watcher that never sees
  // the wait on the slow one is a watcher whose silence proves nothing.
  readDelay = 0;
  await page.goto(`${ORIGIN}/invite/share-one`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.join-status')?.textContent === 'Invitation ready');
  await new Promise((resolve) => setTimeout(resolve, 400));
  check('an answer that arrives at once draws no wait at all',
    (await page.evaluate('globalThis.__sawWait')) === false);
  readDelay = 700;

  // Record every commit the header or the card makes, and the header's own
  // height with it: furniture appearing or leaving is a jump, not only a word
  // change.
  // The string form is deliberate: the TypeScript runner decorates nested
  // functions with its `__name` helper, which does not exist inside Chrome's
  // isolated world (the same trap `verify-workspace-react-decisions` names).
  await page.evaluate(`(() => {
    const frames = [];
    const read = () => {
      const head = document.querySelector('#pageHead');
      const frame = {
        at: Math.round(performance.now()),
        title: document.querySelector('#inviteTitle')?.textContent ?? '(none)',
        sub: document.querySelector('#inviteSub')?.textContent ?? '(none)',
        mark: document.querySelector('#pageHead .pmark')?.textContent ?? '(none)',
        status: document.querySelector('.join-status')?.textContent ?? '(none)',
        height: Math.round(head?.getBoundingClientRect().height ?? 0),
      };
      const last = frames[frames.length - 1];
      if (last && last.title === frame.title && last.sub === frame.sub && last.mark === frame.mark
        && last.status === frame.status && last.height === frame.height) return;
      frames.push(frame);
    };
    globalThis.__frames = frames;
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  })()`);

  const readsBefore = reads;
  await page.click('.join-actions .formcommit');
  await page.waitForFunction(() => document.querySelector('.join-status')?.textContent === 'Request sent');
  // The picture of the moment in question: taken as the answer lands, which
  // on the old build is inside the 700ms the re-read held the page blank.
  await page.screenshot({ path: path.join(OUT, 'join-steady-onpress.png') as `${string}.png`, fullPage: false });
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  const frames = await page.evaluate("globalThis.__frames") as Frame[];
  const distinct = <K extends keyof Frame>(key: K) => [...new Set(frames.map((frame) => String(frame[key])))];
  console.log(`  frames: ${frames.map((frame) => `${frame.at}ms ${frame.title}/${frame.sub}/${frame.mark}`).join(' | ')}`);

  check('the request goes out once', redeems === 1, `${redeems}`);
  check('the header keeps the workplace’s name throughout',
    distinct('title').join(' → ') === ORG, distinct('title').join(' → '));
  check('the header carries no monogram for the workplace',
    distinct('mark').join(' → ') === '(none)', distinct('mark').join(' → '));
  check('the header never falls back to the loading name',
    !frames.some((frame) => frame.title === 'Opening invitation' || frame.sub === 'Workplace invitation'),
    distinct('sub').join(' → '));
  check('the header never changes height',
    distinct('height').length === 1, distinct('height').join(' → '));
  check('the card goes straight from sending to waiting',
    distinct('status').join(' → ') === 'Invitation ready → Request sent', distinct('status').join(' → '));
  check('the answer the request handed back is not read again',
    reads === readsBefore, `${reads - readsBefore} extra read(s)`);

  await page.screenshot({ path: path.join(OUT, 'join-steady-settled.png') as `${string}.png`, fullPage: false });

  // The address is still adopted, so a reload lands on the durable request
  // rather than on the bearer link, and the poll keeps watching it.
  check('the request keeps an address of its own',
    new URL(page.url()).searchParams.get('request') === 'jr-1', page.url());
  joinStatus = 'member';
  await page.waitForFunction(() => document.querySelector('.join-status')?.textContent === 'Approved', { timeout: 15_000 });
  check('an approval still arrives on the waiting page by itself', true);
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
