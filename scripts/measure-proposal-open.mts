// How long a proposal takes to OPEN, three ways a person opens one, and what
// it waits on (follow-up to note #825): the time until its words show, until
// its first picture shows, and every request made before the words arrived.
//
//   cold    a link opened in a fresh browser: nothing cached
//   reload  the same link opened again (a phone reloading a tab it evicted,
//           a notification tapped): the script and stylesheet come from the
//           browser's cache, the page and every read do not
//   in-app  the Workspace already open on another screen, then the proposal
//           opened inside it, the way a card in the chat opens it
//
// Served the way production serves it — the script and stylesheet brotli-
// compressed and cacheable for a year, the page never cached — from a bare
// fixture server answering the Workspace API from the component tests' own
// fixtures. Every read is held FRONT_DOOR_MS (default 250: the Workspace front
// door's measured time to first byte from an agent machine in Amsterdam), and
// the proposal's own read COMPARE_MS more (default 150: the git host's compare
// for #1451, timed from the production machine at 110–230 ms). The pictures
// are #1451's five real ones, signed by the real store, so the picture leg
// is Tigris itself. Chrome at 390px, 3x, puppeteer's "Fast 4G" throttle.
//
//   SHELL_DIR=~/n825/live-shell LABEL=before OUT_DIR=~/n825/boot \
//     backend/node_modules/.bin/tsx scripts/measure-proposal-open.mts
import { createServer } from 'node:http';
import { brotliCompressSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { PredefinedNetworkConditions, type Page } from 'puppeteer-core';
import { emptyState, workspaceScript, type Answer } from '../backend/workspace-ui/src/test/fixtures.js';
import { imageDimensions } from '../backend/src/utils/image-dimensions.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.HOME || '/home/agent';
const SHELL = process.env.SHELL_DIR || path.join(REPO, 'backend/dist/workspace-ui');
const FILES = process.env.FILES_DIR || path.join(HOME, 'n825/files');
const OUT = process.env.OUT_DIR || path.join(HOME, 'mini-preview');
const LABEL = process.env.LABEL || 'run';
const FRONT_DOOR_MS = Number(process.env.FRONT_DOOR_MS ?? 250);
const COMPARE_MS = Number(process.env.COMPARE_MS ?? 150);
const RUNS = Number(process.env.RUNS ?? 3);
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(HOME, '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((n) => n.startsWith('linux-')).sort().pop()!;
  return path.join(root, build, 'chrome-linux64/chrome');
}

const names = ['1-home-desk.png', '1-home-phone.png', '2-product-subscriptions-phone.png', '3-product-close-phone.png', '4-entry-phone.png'];
const files = names.map((fileName, at) => {
  const data = readFileSync(path.join(FILES, fileName));
  return { id: `f${at + 1}`, fileName, contentType: 'image/png', sizeBytes: data.byteLength, addedAt: '2026-10-28T06:00:00Z', ...(imageDimensions(data) ?? {}) };
});

/** Real signed URLs off the agent's own CLI door; the token never leaves
 *  this process. */
async function signedUrls(): Promise<Record<string, string>> {
  const config = JSON.parse(readFileSync(path.join(HOME, '.agentbuilt/config.json'), 'utf8')) as { apiUrl: string; token: string };
  const out: Record<string, string> = {};
  for (const file of files) {
    const res = await fetch(`${config.apiUrl.replace(/\/$/, '')}/api/agent-cli/repos/infinite-agents/prs/1451/files/${encodeURIComponent(file.fileName)}`, { headers: { authorization: `Bearer ${config.token}` } });
    if (!res.ok) throw new Error(`mint ${file.fileName}: ${res.status}`);
    out[file.id] = (await res.json() as { url: string }).url;
  }
  return out;
}

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] };
const later = () => new Date(Date.now() + 14 * 60_000).toISOString();

function detail(urls: Record<string, string>) {
  return {
    pr: {
      id: 'p1', number: 1451, repoName: 'infinite-agents',
      title: 'Only the private copy in public words: no hosted version, no sign-up door',
      body: 'Your decision this morning, put into the site\'s words: only the private copy is offered, and nothing public offers our hosted version.\n\n**What a visitor sees now**\n- **Home:** "Get your own copy" is the only button.\n- **The header on every page:** Sign in and **Get a copy**.\n\nThe pictures show the home page on desk and phone.',
      from: 'note-822-private-copy-only', to: 'main', diffStat: { insertions: 267, deletions: 208 }, status: 'open',
      createdAt: new Date(Date.now() - 50 * 60_000).toISOString(), decidedAt: null,
      agentName: 'Ada', agentId: 'ada', userName: 'Adam', agentRuntime: { cli: 'claude', model: 'Fable', effort: 'medium' },
      canDecide: true, comments: [], quickNotes: [{ number: 822, title: 'Only the private copy: no hosted version in public words' }],
      attachments: files.map((file) => ({ ...file, preview: { url: urls[file.id], expiresAt: later() } })),
    },
    checks: [{ context: 'ci/checks', state: 'success', description: 'passed' }], patch: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n', patchTruncated: false,
    commits: [{ sha: 'abc1234def', subject: 'Only the private copy', at: new Date(Date.now() - 60 * 60_000).toISOString() }],
    diffStat: { files: 26, insertions: 267, deletions: 208 }, headSha: 'abc1234def', requireChecks: true,
  };
}

async function serve(urls: Record<string, string>) {
  const script: Record<string, Answer> = {
    ...workspaceScript(() => emptyState({ org } as never)),
    'GET api/prs/p1': () => detail(urls),
  };
  const packed = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/workspace/app/assets/')) {
      const file = path.join(SHELL, url.pathname.slice('/workspace/app/'.length));
      if (existsSync(file)) {
        if (!packed.has(file)) packed.set(file, brotliCompressSync(readFileSync(file)));
        res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'image/png');
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        res.setHeader('content-encoding', 'br');
        res.end(packed.get(file));
        return;
      }
    }
    if (url.pathname.startsWith('/workspace/api/') || url.pathname.startsWith('/workspace/auth/')) {
      for (const scope of ['room', 'org']) url.searchParams.delete(scope);
      const query = url.searchParams.toString();
      const key = `${req.method} ${url.pathname.slice('/workspace/'.length)}${query ? `?${query}` : ''}`;
      const handler = script[key];
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      setTimeout(() => {
        if (!handler) { res.statusCode = 404; res.end(JSON.stringify({ error: `unscripted ${key}` })); return; }
        res.end(JSON.stringify(handler({ path: key, scoped: true } as never) ?? {}));
      }, FRONT_DOOR_MS + (key === 'GET api/prs/p1' ? COMPARE_MS : 0));
      return;
    }
    if (url.pathname === '/favicon.ico') { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'text/html');
    res.setHeader('cache-control', 'no-store');
    setTimeout(() => res.end(readFileSync(path.join(SHELL, 'index.html'))), FRONT_DOOR_MS);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port };
}

/** Polls, from inside the page, for the two moments that matter, against a
 *  start the caller sets: the words (the proposal's summary card, drawn only
 *  from its own answer) and the first picture painted. */
const WATCH = `(() => {
  const w = { t0: 0, words: null, picture: null };
  window.__watch = w;
  const tick = () => {
    if (w.words === null && document.querySelector('#screenPr #prSummary')) w.words = Math.round(performance.now() - w.t0);
    if (w.picture === null && [...document.querySelectorAll('#prFiles .notephoto img')].some((i) => i.complete && i.naturalWidth > 0)) w.picture = Math.round(performance.now() - w.t0);
    if (w.words === null || w.picture === null) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

async function throttle(page: Page) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const net = PredefinedNetworkConditions['Fast 4G'];
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: net.latency, downloadThroughput: net.download, uploadThroughput: net.upload });
}

async function settle(page: Page) {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const w = await page.evaluate('window.__watch') as { words: number | null; picture: number | null } | undefined;
    if (w && w.words !== null && w.picture !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 200));
}

async function readout(page: Page) {
  const w = await page.evaluate('window.__watch') as { t0: number; words: number | null; picture: number | null };
  const entries = await page.evaluate(`performance.getEntriesByType('resource').map((e) => ({ name: e.name, start: Math.round(e.startTime), end: Math.round(e.responseEnd), cached: e.transferSize === 0 && e.decodedBodySize > 0 }))`) as { name: string; start: number; end: number; cached: boolean }[];
  const t0 = Math.round(w.t0);
  const rel = entries.map((e) => ({ ...e, start: e.start - t0, end: e.end - t0 })).filter((e) => e.end >= 0);
  const detailEntry = rel.find((e) => /\/api\/prs\/p1(\?|$)/.test(e.name));
  const words = detailEntry ? detailEntry.end : Infinity;
  const short = (name: string) => { const u = new URL(name); return u.pathname.replace('/workspace/', '') + (u.search ? u.search.replace(/([?&])(org|room)=[^&]*/g, '$1').replace(/[?&]+$/, '').replace(/\?&/, '?') : ''); };
  const before = rel.filter((e) => e.start < words && e !== detailEntry && !/tigris|favicon/.test(e.name));
  return {
    wordsShown: w.words, firstPictureShown: w.picture,
    proposalAsked: detailEntry?.start ?? null, proposalAnswered: detailEntry?.end ?? null,
    requestsBeforeProposalAsked: before.filter((e) => detailEntry && e.start < detailEntry.start).length,
    chain: rel.filter((e) => e.start <= words && !/favicon/.test(e.name)).sort((a, b) => a.start - b.start)
      .map((e) => `${String(e.start).padStart(5)} → ${String(e.end).padStart(5)}  ${short(e.name)}${e.cached ? '  (cache)' : ''}`),
  };
}

// Production's own form of the address: at the root, no /workspace prefix
// (the prefixed form still opens the screen, and hid a miss once).
const PROPOSAL = '/decisions/pr/p1?org=o1';

async function cold(context: Awaited<ReturnType<typeof browser.createBrowserContext>>, base: string) {
  const page = await context.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
  await throttle(page);
  await page.evaluateOnNewDocument(WATCH);
  await page.goto(`${base}${PROPOSAL}`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  const out = await readout(page);
  return { page, out };
}

async function inApp(base: string) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
  await throttle(page);
  // The Workspace open on another screen, settled — on a phone that has
  // opened a proposal with pictures before, so it knows where they come from
  // (a build that does not read this ignores it).
  await page.goto(`${base}/notes?org=o1`, { waitUntil: 'networkidle0', timeout: 30_000 });
  await page.evaluate(`localStorage.setItem('acc.mediaOrigin', 'https://fly.storage.tigris.dev')`);
  await page.evaluate(WATCH);
  // Opened the way a card inside it opens it: the router moves, the page does not.
  await page.evaluate(`(() => { window.__watch.t0 = performance.now(); history.pushState({}, '', ${JSON.stringify(PROPOSAL)}); dispatchEvent(new PopStateEvent('popstate', { state: {} })); })()`);
  await settle(page);
  const out = await readout(page);
  await page.screenshot({ path: path.join(OUT, `${LABEL}-in-app.png`) });
  await context.close();
  return out;
}

const browser = await puppeteer.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const results: Record<string, unknown> = { label: LABEL, shell: SHELL, frontDoorMs: FRONT_DOOR_MS, compareMs: COMPARE_MS, network: 'Fast 4G (puppeteer), 390px @3x' };
try {
  const { server, port } = await serve(await signedUrls());
  const base = `http://127.0.0.1:${port}`;
  const runs: Record<string, Array<Awaited<ReturnType<typeof readout>>>> = { cold: [], reload: [], 'in-app': [] };
  for (let i = 0; i < RUNS; i++) {
    const context = await browser.createBrowserContext();
    const first = await cold(context, base);
    runs.cold!.push(first.out);
    if (i === 0) await first.page.screenshot({ path: path.join(OUT, `${LABEL}-cold.png`) });
    await first.page.close();
    // Same browser, script and stylesheet now in its cache; a fresh tab.
    const again = await cold(context, base);
    runs.reload!.push(again.out);
    if (i === 0) await again.page.screenshot({ path: path.join(OUT, `${LABEL}-reload.png`) });
    await context.close();
    runs['in-app']!.push(await inApp(base));
  }
  // The same moment on both builds: a proposal link opened again (script
  // cached), photographed SHOT_AT_MS after the page started.
  for (const at of String(process.env.SHOT_AT_MS ?? '800').split(',').map(Number)) {
    const context = await browser.createBrowserContext();
    const warm = await cold(context, base);
    await warm.page.close();
    const page = await context.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
    await throttle(page);
    await page.goto(`${base}${PROPOSAL}`, { waitUntil: 'domcontentloaded' });
    const left = at - (await page.evaluate('performance.now()') as number);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    const took = Math.round(await page.evaluate('performance.now()') as number);
    await page.screenshot({ path: path.join(OUT, `${LABEL}-reload-at-${at}ms.png`) });
    console.log(`  shot ${LABEL}-reload-at-${at}ms.png at ${took} ms`);
    await context.close();
  }
  const median = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : null; };
  for (const [name, list] of Object.entries(runs)) {
    results[name] = {
      wordsShown: median(list.map((r) => r.wordsShown)),
      firstPictureShown: median(list.map((r) => r.firstPictureShown)),
      proposalAsked: median(list.map((r) => r.proposalAsked)),
      requestsBeforeProposalAsked: median(list.map((r) => r.requestsBeforeProposalAsked)),
      every: list.map((r) => [r.wordsShown, r.firstPictureShown]),
      chain: list[0]!.chain,
    };
  }
  server.close();
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
writeFileSync(path.join(OUT, `${LABEL}-open.json`), JSON.stringify(results, null, 2));
