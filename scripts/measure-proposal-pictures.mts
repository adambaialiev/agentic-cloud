// The proposal sheet's pictures, measured and photographed at phone size
// (note #825): how long the reader waits for the first picture and for all
// of them, how many reads the screen makes to get there, and what the sheet
// looks like while it waits.
//
// The shell under test is whichever build SHELL_DIR names — the live
// Workspace's own bundle (curl its index.html and the two assets it names
// into a directory) for a "before", backend/dist/workspace-ui for an
// "after" — served from a bare fixture server that answers the Workspace API
// from the component tests' own fixtures. The proposal is #1451's: its five
// real pictures, read from FILES_DIR (agentbuilt pr fetch 1451 <name>), and
// their bytes come from the REAL store: each picture's signed URL is minted
// through the agent's own CLI route at start, so the image leg is Tigris
// itself, not a local file. Chrome is throttled to puppeteer's "Fast 4G"
// (165 ms added latency, ~8 Mbit/s), and every API answer is held API_DELAY_MS
// (default 250 — the Workspace front door's measured time-to-first-byte from
// an agent machine in ams, which is the hop a phone also pays) so the
// waterfall has the shape a phone sees rather than localhost's.
//
// Two passes per width. TIMING: no interception, Chrome's own fetches, and
// the numbers come from the Resource Timing API plus a 16 ms poll of which
// <img> has decoded. LOOK: the image requests are held HOLD_MS so the sheet
// can be photographed while it is still waiting, then once more when every
// picture is in. The fixture carries the sizes and the preview URLs the
// after-build reads (the before-build ignores fields it does not know), so
// one fixture serves both runs and the only variable is the shell.
//
//   SHELL_DIR=~/n825/prod-shell LABEL=before OUT_DIR=~/n825/shots \
//     backend/node_modules/.bin/tsx scripts/measure-proposal-pictures.mts
import { createServer } from 'node:http';
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
const API_DELAY_MS = Number(process.env.API_DELAY_MS ?? 250);
const HOLD_MS = Number(process.env.HOLD_MS ?? 4000);
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(HOME, '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((n) => n.startsWith('linux-')).sort().pop()!;
  return path.join(root, build, 'chrome-linux64/chrome');
}

/** The five pictures of #1451, as the detail record would describe them. */
const names = ['1-home-desk.png', '1-home-phone.png', '2-product-subscriptions-phone.png', '3-product-close-phone.png', '4-entry-phone.png'];
const files = names.map((fileName, at) => {
  const data = readFileSync(path.join(FILES, fileName));
  const size = imageDimensions(data);
  return { id: `f${at + 1}`, fileName, contentType: 'image/png', sizeBytes: data.byteLength, addedAt: '2026-10-28T06:00:00Z', ...(size ?? {}) };
});

/** A real signed URL per picture, off the agent's own CLI door — the token
 *  never leaves this process. Falls back to serving the local bytes (behind
 *  the same API delay) when the machine holds no token. */
async function signedUrls(origin: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let config: { apiUrl?: string; token?: string } = {};
  try { config = JSON.parse(readFileSync(path.join(HOME, '.agentbuilt/config.json'), 'utf8')); } catch { /* none */ }
  const apiUrl = process.env.AGENTBUILT_API_URL || config.apiUrl;
  const token = process.env.AGENTBUILT_TOKEN || config.token;
  const repo = process.env.PR_REPO || 'infinite-agents';
  const number = process.env.PR_NUMBER || '1451';
  for (const file of files) {
    if (apiUrl && token && !process.env.LOCAL_PICTURES) {
      const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/agent-cli/repos/${repo}/prs/${number}/files/${encodeURIComponent(file.fileName)}`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) { out[file.id] = (await res.json() as { url: string }).url; continue; }
      console.log(`  (mint for ${file.fileName} answered ${res.status}; serving local bytes)`);
    }
    out[file.id] = `${origin}/pictures/${file.fileName}`;
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
      body: 'Your decision this morning, put into the site\'s words: only the private copy is offered, and nothing public offers our hosted version. Closing sign-up itself is Ben\'s separate note (#823). Workplaces that already exist are not touched.\n\n**What a visitor sees now**\n- **Home:** "Want to try it first? Sign up and use it on our cloud." is gone. "Get your own copy" (to the engineer\'s page) is the only button.\n- **The header on every page:** Sign in and **Get a copy**. Sign up is gone. Sign in stays for people who already have accounts. The Workspace\'s public pages (a person\'s page such as /adam, a public repository, the Leaderboard) get the same header door on our platform; a private copy keeps its own.\n- **Product page:** the top line ends "In your own cloud account, on the plan you already pay for."\n\nThe pictures show the home page on desk and phone, and the product page\'s subscriptions and closing sections and the Claude Code page on a phone.',
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
    ...Object.fromEntries(files.map((file) => [
      `GET api/prs/p1/files/${file.id}?preview=1`,
      () => ({ url: urls[file.id], fileName: file.fileName, expiresAt: later() }),
    ])),
  };
  const apiHits: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/workspace/app/assets/')) {
      const file = path.join(SHELL, url.pathname.slice('/workspace/app/'.length));
      if (existsSync(file)) {
        res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'image/png');
        res.end(readFileSync(file));
        return;
      }
    }
    if (url.pathname.startsWith('/pictures/')) {
      const file = path.join(FILES, path.basename(url.pathname));
      res.setHeader('content-type', 'image/png');
      setTimeout(() => res.end(readFileSync(file)), API_DELAY_MS);
      return;
    }
    if (url.pathname.startsWith('/workspace/api/') || url.pathname.startsWith('/workspace/auth/')) {
      for (const scope of ['room', 'org']) url.searchParams.delete(scope);
      const query = url.searchParams.toString();
      const key = `${req.method} ${url.pathname.slice('/workspace/'.length)}${query ? `?${query}` : ''}`;
      apiHits.push(key);
      const handler = script[key];
      res.setHeader('content-type', 'application/json');
      setTimeout(() => {
        if (!handler) { res.statusCode = 404; res.end(JSON.stringify({ error: `unscripted ${key}` })); return; }
        res.end(JSON.stringify(handler({ path: key, scoped: true } as never) ?? {}));
      }, API_DELAY_MS);
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(readFileSync(path.join(SHELL, 'index.html')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port, apiHits };
}

const isPicture = (url: string) => /fly\.storage\.tigris\.dev|\/pictures\//.test(url);

/** Watch the files card from inside the page: when each picture decoded, and
 *  how tall the card was while it waited and once it was done. */
const WATCH = `(() => {
  const t0 = performance.now();
  const w = { firstPicture: null, allPictures: null, cardLoadingHeight: null, frames: null, imgs: 0, detailAt: null };
  window.__watch = w;
  const tick = () => {
    const card = document.getElementById('prFiles');
    if (card) {
      if (w.detailAt === null) w.detailAt = Math.round(performance.now() - t0);
      const imgs = [...card.querySelectorAll('.notephoto img')];
      w.imgs = Math.max(w.imgs, imgs.length);
      const done = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
      if (done > 0 && w.firstPicture === null) w.firstPicture = Math.round(performance.now() - t0);
      if (done === 5 && w.allPictures === null) w.allPictures = Math.round(performance.now() - t0);
      if (w.frames === null && card.querySelectorAll('.notephoto').length === 5) {
        w.frames = [...card.querySelectorAll('.notephoto')].map((n) => Math.round(n.getBoundingClientRect().height));
        w.cardLoadingHeight = Math.round(card.getBoundingClientRect().height);
      }
    }
    if (w.allPictures === null) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

async function timing(page: Page, origin: string, width: number, scale: number) {
  await page.setViewport({ width, height: width < 600 ? 844 : 900, deviceScaleFactor: scale });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const net = PredefinedNetworkConditions['Fast 4G'];
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: net.latency, downloadThroughput: net.download, uploadThroughput: net.upload });
  await page.evaluateOnNewDocument(WATCH);
  await page.goto(`${origin}/workspace/decisions/pr/p1?org=o1`, { waitUntil: 'domcontentloaded' });
  // Until every picture has painted, or — with the rest loading lazily, the
  // ones below the fold never will without a scroll — until a second and a
  // half has passed since the first one did.
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const w = await page.evaluate('window.__watch || {}') as { allPictures: number | null; firstPicture: number | null };
    if (w.allPictures !== null) break;
    if (w.firstPicture !== null && Date.now() - start > w.firstPicture + 1500) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300));
  const watch = await page.evaluate('window.__watch') as Record<string, unknown>;
  const entries = await page.evaluate(`performance.getEntriesByType('resource').map((e) => ({ name: e.name, start: Math.round(e.startTime), end: Math.round(e.responseEnd), bytes: e.transferSize }))`) as { name: string; start: number; end: number; bytes: number }[];
  const nav = await page.evaluate(`performance.getEntriesByType('navigation')[0].responseEnd`) as number;
  const detail = entries.find((e) => e.name.includes('/api/prs/p1?') || e.name.endsWith('/api/prs/p1'));
  const mints = entries.filter((e) => e.name.includes('/api/prs/p1/files/'));
  const pictures = entries.filter((e) => isPicture(e.name));
  const cardTop = await page.evaluate(`(() => { const c = document.getElementById('prFiles'); return c ? Math.round(c.getBoundingClientRect().top + scrollY) : null; })()`);
  const loaded = await page.evaluate(`[...document.querySelectorAll('#prFiles .notephoto')].map((n) => Math.round(n.getBoundingClientRect().height))`);
  // The chain: every request the page made up to the moment the proposal's
  // words arrived, in the order it started — script, stylesheet, each read.
  const words = detail ? detail.end : Infinity;
  const chain = entries
    .filter((e) => e.start <= words)
    .sort((a, b) => a.start - b.start)
    .map((e) => {
      const u = new URL(e.name);
      return `${String(e.start).padStart(5)} → ${String(e.end).padStart(5)}  ${u.pathname.replace('/workspace/', '')}${u.search ? u.search.replace(/([?&])(org|room)=[^&]*/g, '').replace(/^&/, '?') : ''}`;
    });
  return {
    chain,
    requestsBeforeWords: entries.filter((e) => e.end <= words && e !== detail).length,
    width, navResponseEnd: Math.round(nav),
    detailAnswered: detail ? detail.end : null,
    mints: mints.length, mintsAnswered: mints.length ? Math.max(...mints.map((m) => m.end)) : null,
    pictureRequests: pictures.length,
    firstPictureStarted: pictures.length ? Math.min(...pictures.map((p) => p.start)) : null,
    firstPictureDone: pictures.length ? Math.min(...pictures.map((p) => p.end)) : null,
    lastPictureDone: pictures.length ? Math.max(...pictures.map((p) => p.end)) : null,
    firstPicturePainted: watch.firstPicture, allPicturesPainted: watch.allPictures,
    framesWhileLoading: watch.frames, framesLoaded: loaded, cardTop,
    loadingAttrs: await page.evaluate(`[...document.querySelectorAll('#prFiles .notephoto img')].map((i) => (i.getAttribute('loading') || 'eager'))`),
  };
}

async function look(page: Page, origin: string, name: string, width: number, scale: number) {
  await page.setViewport({ width, height: width < 600 ? 844 : 900, deviceScaleFactor: scale });
  await page.setRequestInterception(true);
  let holding = true;
  page.on('request', (req) => {
    if (holding && isPicture(req.url())) setTimeout(() => { void req.continue(); }, HOLD_MS);
    else void req.continue();
  });
  await page.goto(`${origin}/workspace/decisions/pr/p1?org=o1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#prFiles .notephoto', { timeout: 20_000 });
  await new Promise((r) => setTimeout(r, 400));
  // Scroll the way a thumb does — a wheel gesture — so the fixed decision
  // bar sits where it sits on a phone; a scripted scrollTo is undone by the
  // shell. The card is photographed by its rectangle in page coordinates
  // either way, so the waiting and the loaded shot share one frame.
  const want = await page.evaluate(`(() => { const c = document.getElementById('prFiles').getBoundingClientRect(); return Math.max(0, c.top + scrollY - ${width < 600 ? 140 : 120}); })()`) as number;
  await page.mouse.move(width / 2, 300);
  await page.mouse.wheel({ deltaY: want });
  await new Promise((r) => setTimeout(r, 500));
  const scrolled = await page.evaluate('scrollY') as number;
  const frame = { x: 0, y: want, width, height: width < 600 ? 844 : 900 };
  console.log(`  ${name}: wheel scrolled to ${Math.round(scrolled)} (wanted ${Math.round(want)})`);
  await page.screenshot({ path: path.join(OUT, `${LABEL}-${name}-loading.png`), clip: frame, captureBeyondViewport: true });
  const loadingHeights = await page.evaluate(`[...document.querySelectorAll('#prFiles .notephoto')].map((n) => Math.round(n.getBoundingClientRect().height))`);
  holding = false;
  await page.waitForFunction(`[...document.querySelectorAll('#prFiles .notephoto img')].filter((i) => i.complete && i.naturalWidth > 0).length >= 2`, { timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(OUT, `${LABEL}-${name}-loaded.png`), clip: frame, captureBeyondViewport: true });
  const loadedHeights = await page.evaluate(`[...document.querySelectorAll('#prFiles .notephoto')].map((n) => Math.round(n.getBoundingClientRect().height))`);
  const caption = await page.evaluate(`(() => { const c = document.querySelector('#prFiles .caprow .ctext'); return c ? c.textContent : null; })()`);
  return { loadingHeights, loadedHeights, caption };
}

if (process.env.SERVE_ONLY) { const { port } = await serve(await signedUrls('http://127.0.0.1:1')); console.log('PORT=' + port); await new Promise(() => {}); }
const browser = await puppeteer.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const results: Record<string, unknown> = { label: LABEL, shell: SHELL, apiDelayMs: API_DELAY_MS, network: 'Fast 4G (puppeteer)' };
try {
  const { server, port, apiHits } = await serve({});
  const origin = `http://127.0.0.1:${port}`;
  server.close();
  const urls = await signedUrls(origin);
  const live = await serve(urls);
  const base = `http://127.0.0.1:${live.port}`;
  results.pictureSource = Object.values(urls)[0]?.includes('tigris') ? 'fly.storage.tigris.dev (real store)' : 'local bytes';
  for (const [name, width, scale] of [['phone', 390, 3], ['desk', 1440, 1]] as const) {
    const page = await browser.newPage();
    results[`timing-${name}`] = await timing(page, base, width, scale);
    await page.close();
    const page2 = await browser.newPage();
    results[`look-${name}`] = await look(page2, base, name, width, scale);
    await page2.close();
  }
  results.apiHitsFirstTimingRun = live.apiHits.filter((k) => k.startsWith('GET api/prs/')).length;
  live.server.close();
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
writeFileSync(path.join(OUT, `${LABEL}-numbers.json`), JSON.stringify(results, null, 2));
