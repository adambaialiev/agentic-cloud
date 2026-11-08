// Drives the React Workspace shell's NOTES screens in real Chrome against a
// real backend router: home's glimpse, the notes screen, the archive, the
// search across both, one note whole (its words, the row of agents it can be
// handed to, its margin, its files) and the composer — then opens the SAME
// note in the classic Workspace and compares what each shell says and where
// each part sits, because the stylesheet is shared and a box in a different
// place means a node the CSS was not expecting.
// Screenshots land in ~/mini-preview/n256-notes-*.png.
// The account here is a personal one, with no workplace: its Home (`/`) is
// still the one-column overview (`#screenOverview`) with every shelf drawn,
// where a workplace's Home is the Chief of Staff's conversation (note #715).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-react-notes.mts
//   … --shell <dir>   run against a different built shell (production's own)
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot, tap } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessMailService, harnessSignedIn } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });

/** Whichever Chrome this machine actually has: the cache directory is named
 *  for the build, and pinning one version here is how a harness stops working
 *  after the next upgrade. */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(cache).filter((name) => name.startsWith('linux-')).sort();
  const newest = builds[builds.length - 1];
  if (!newest) throw new Error(`no Chrome under ${cache} — npx puppeteer browsers install chrome`);
  return path.join(cache, newest, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4177);
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** `--shell <dir>` is this shell's `--page`: point the SAME probe at a
 *  different build — production's own bytes, say — instead of the one this
 *  checkout just made. */
const shellArg = process.argv.indexOf('--shell');
const SHELL_DIR = shellArg > 0 ? process.argv[shellArg + 1]! : path.join(REPO, 'backend/dist/workspace-ui');

const userStorage = new InMemoryUserStorage();
// Signing up has needed a confirmed address since 2026-09-11. This is the
// harness's own mailbox: it keeps the link the router mints so the browser
// can follow it, exactly as a person follows the one in their mail.
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(),
  mailbox.config,
  mailbox.mailboxes,
);
const quickNoteStorage = new InMemoryQuickNoteStorage();

/** Files live in memory too, so a photograph on a note is a real round trip:
 *  the note asks for a signed URL and this hands one back that resolves. */
const objects = new Map<string, { data: Buffer; contentType: string }>();
const mediaStorage = {
  async uploadObject({ storagePath, data, contentType }: { storagePath: string; data: Buffer; contentType: string }) {
    objects.set(storagePath, { data, contentType });
  },
  // A link signed for SAVING says so, the way the real store's does: its
  // answer carries the attachment disposition, which is what keeps the page
  // where it is while the bytes go to the download shelf (note #690).
  async createReadAccess({ storagePath, promptSaveAs }: { storagePath: string; promptSaveAs?: string }) {
    const save = promptSaveAs ? `&save=${encodeURIComponent(promptSaveAs)}` : '';
    return {
      url: `${ORIGIN}/objects/${encodeURIComponent(storagePath)}?sig=${Date.now()}${save}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  },
  async deleteObject({ storagePath }: { storagePath: string }) { objects.delete(storagePath); },
  async deleteObjectsWithPrefix({ prefix }: { prefix: string }) {
    for (const key of [...objects.keys()]) if (key.startsWith(prefix)) objects.delete(key);
  },
};

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: SHELL_DIR,
  workspaceUiDefault: 'react',
  quickNoteStorage,
  mediaStorage,
} as unknown as RouteDeps;

const app = express();
app.use(express.json());
app.get('/objects/:key', (req, res) => {
  const held = objects.get(decodeURIComponent(req.params.key));
  if (!held) return res.status(404).end();
  res.setHeader('content-type', held.contentType);
  res.setHeader('accept-ranges', 'bytes');
  if (typeof req.query.save === 'string') res.attachment(req.query.save);
  // In RANGES when asked, as the real store answers: it is how a player
  // reads a clip, and the only way Safari will play one at all.
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const size = held.data.length;
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return res.status(416).setHeader('content-range', `bytes */${size}`).end();
    res.status(206).setHeader('content-range', `bytes ${start}-${end}/${size}`);
    return res.end(held.data.subarray(start, end + 1));
  }
  return res.end(held.data);
});
/**
 * A note read that is simply never answered — which is not a hypothetical.
 * `/opt/infinite-agents/current` is swung to a new release under a systemd
 * socket, so during a deploy a request is ACCEPTED and then abandoned by a
 * process on its way out: no answer, no failure, nothing to report. Note #308
 * is a screenshot of what that looked like from a phone — the word "Loading…",
 * for as long as the reader was willing to stare at it.
 *
 * Turned on around the two checks that need it and off again afterwards.
 */
let releasing = false;
app.use((req, _res, next) => {
  if (releasing && req.method === 'GET' && /^\/workspace\/api\/notes\/\d+(\?|$)/.test(req.originalUrl)) return;
  return next();
});
app.use('/workspace', workspaceRoutes(deps));
// The shell itself answers at the root of the domain (public-addresses).
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

/** Read in BOTH shells and compared: the shared stylesheet should put every
 *  one of these in the same place. */
const PARITY_BOXES = ['#noteTitle', '#noteSub', '#noteBody', '#noteBody .kpage', '#noteCommentsHead', '#noteComments .ncmt'];

/** The one header, measured (note #282). Every detail screen fills the same
 *  block — Back and live state when there is one, then the screen's own name below —
 *  and one rule closes it off from the words underneath. A screen that still
 *  draws its own heading has no `#pageId` and says so here, which is what
 *  makes this a geometry check and not a spelling one. */
const headShape = async (page: import('puppeteer-core').Page) => page.evaluate(() => {
  const head = document.getElementById('pageHead');
  if (!head) return 'no header at all';
  const slot = document.getElementById('pageId');
  const title = head.querySelector('h1');
  if (!slot || !title) return 'the screen keeps its own heading';
  const style = getComputedStyle(head);
  const inset = Math.round(slot.getBoundingClientRect().top - head.getBoundingClientRect().top);
  return `rule=${style.borderBottomWidth} ${style.borderBottomStyle} · name ${inset}px in`;
});
// The name sits 48px in, not 50: `.pagehead` gave up its 2px of top padding
// on 2026-09-11 (c21c5d9b) because `.pagenav` below it IS the 48px row.
const ONE_HEADER = 'rule=1px solid · name 48px in';

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page$ = await browser.newPage();
  // A picture is decoded when its bytes have ARRIVED, which is later than the
  // <img> appearing and later still on a loaded machine: three checks here
  // asked naturalWidth the instant the element existed and failed 2 runs in 6
  // with three copies running (note #1075). Wait for the state, then read it.
  const decoded = async (selector: string) => {
    await page$.waitForFunction((target: string) => {
      const image = document.querySelector<HTMLImageElement>(target);
      return Boolean(image && image.complete && image.naturalWidth > 0);
    }, { timeout: 15_000 }, selector).catch(() => {});
    return page$.$eval(selector, (node) => (node as HTMLImageElement).naturalWidth > 0).catch(() => false);
  };
  await page$.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  page$.on('pageerror', (error) => check('no page error', false, String(error)));
  const consoleErrors: string[] = [];
  page$.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page$.on('response', (response) => { if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`); });
  await page$.evaluateOnNewDocument((boxes: string[]) => {
    (globalThis as unknown as { PARITY_BOXES: string[] }).PARITY_BOXES = boxes;
  }, PARITY_BOXES);
  const shot = async (name: string) => {
    await page$.screenshot({
      path: path.join(OUT, `n256-notes-${name}.png`) as `${string}.png`, fullPage: true,
    });
    await settleAfterShot(page$);
  };
  const text = (selector: string) => page$.$eval(selector, (node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  const texts = (selector: string) => page$.$$eval(selector, (nodes) => nodes.map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? ''));

  // 1. Create access, then seed the notes this Workspace reads.
  await harnessSignedIn(page$, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  await page$.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenOverview #agentsSection', { timeout: 10_000 });

  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(me.telegram ?? {}),
      agents: {
        kai: {
          id: 'kai', name: 'Kai', cli: 'claude', model: 'Opus', effort: 'high',
          createdAt: new Date().toISOString(), serverId: 'm1',
          connectedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
          // `{ text, at }`, which is the shape the state route reads — a bare
          // string here left every hand card in this harness recap-less, so
          // the clamp that sets the row's height was never once exercised.
          recap: { text: 'Moved the Workspace notes to React, and put the archive behind its own door.', at: new Date().toISOString() },
        },
        // Note #352: a machine still coming up. No `connectedAt`, which is
        // what the state route reads `setting-up` from — and the state this
        // row had no drawing for until the meter came here from home.
        ada: {
          id: 'ada', name: 'Ada', cli: 'codex', model: 'gpt-5.6-sol', effort: 'max',
          createdAt: new Date().toISOString(), serverId: 'm2',
        },
      } as never,
    },
  });

  const seed = async (html: string, byUser: boolean) => quickNoteStorage.create({
    userId: me.userId,
    html,
    createdByAgentId: byUser ? 'user' : 'kai',
    ...(byUser ? { createdByUserId: me.userId, updatedByUserId: me.userId } : {}),
    updatedByAgentId: byUser ? 'user' : 'kai',
  } as never);

  const plumber = await seed('<p>Call the plumber back</p><p>He is closed on Mondays.</p>', true);
  const wifi = await seed('<p>The wifi code is 4417</p>', true);
  await seed('<h2>Deploy runbook</h2><ul><li>push</li><li>wait for checks</li></ul>', false);
  const filler = [];
  for (let n = 0; n < 5; n += 1) filler.push(await seed(`<p>Filler note ${n + 1}</p>`, true));
  // Note #307: the screen can narrow itself to one state, so this list has to
  // be in more than one. A lease and a hand-off are the two an agent takes
  // without a repository — the proposal states need one, and what the chips
  // do with a state is the same whichever state it is.
  const soon = new Date(Date.now() + 2 * 3600_000).toISOString();
  await quickNoteStorage.update(filler[0]!.id, {
    claim: {
      agentId: 'kai', userId: me.userId, agentName: 'Kai',
      claimedAt: new Date().toISOString(), expiresAt: soon, fingerprint: 'x',
    },
  } as never);
  await quickNoteStorage.update(filler[1]!.id, {
    handoff: { agentId: 'kai', agentName: 'Kai', userId: me.userId, handedAt: new Date().toISOString(), expiresAt: soon },
  } as never);
  const filed = await seed('<p>Last month’s jottings</p>', true);
  await quickNoteStorage.update(filed.id, { archivedAt: new Date().toISOString(), archivedByAgentId: 'user' } as never);
  // Notes #263/#284: notes cite each other constantly, and a mention in the
  // words — or in the margin — is a door to the note it names. A proposal's
  // number sits beside one on purpose: it must stay ink.
  await quickNoteStorage.update(plumber.id, {
    html: `<p>Call the plumber back</p><p>He is closed on Mondays.</p>`
      + `<p>The code is on note #${wifi.number}, not in PR #560.</p>`,
    // Oldest first, the order every margin appends in — so the agent's remark
    // is the newest and leads the thread, and the reader's own sits under it.
    comments: [{
      id: 'c0', authorId: 'user', userId: me.userId,
      text: '<p>I will call at nine.</p>',
      createdAt: new Date(Date.now() - 7200_000).toISOString(),
    }, {
      id: 'c1', authorId: 'kai', authorName: 'Kai',
      text: `<p>Called them, <strong>closed Mondays</strong>. Same as note #${wifi.number}.</p>`,
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
    }],
  } as never);

  // 2. Home's glimpse: the recent few, the counts, the door to the rest.
  await page$.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#notesCard .crow', { timeout: 10_000 });
  check('home glimpses the recent few and offers the rest',
    (await texts('#notes .crow .name')).length === 8
    && (await texts('#notes .crow .name')).includes('All 8 notes'),
    (await texts('#notes .crow .name')).join(' | '));
  check('the heading counts what is there and what is idle',
    (await text('#noteCounts')) === '8 total · 6 idle', await text('#noteCounts'));
  check('the archive door says what is behind it',
    (await texts('#notes .crow')).some((row) => row.includes('One note put away')),
    (await texts('#notes .crow')).join(' | '));
  check('a row leads with WHO, then what the note says',
    (await texts('#notes .crow .cline')).some((line) => line.startsWith('Kai·push')),
    (await texts('#notes .crow .cline')).join(' | '));
  check('every row says which note it IS',
    (await texts('#notes .crow .num')).every((n) => /^#\d+$/.test(n)),
    (await texts('#notes .crow .num')).join(' '));
  // Note #284: every note row is a real link, on home and on the list alike,
  // so the browser can open one in a new tab or copy its address — and looks
  // exactly as it did as a div, which is what the pixels below are for.
  const homeRow = await page$.$$eval('#notes .crow.open', (nodes) => nodes.map((node) => ({
    tag: node.tagName,
    href: node.getAttribute('href'),
    draggable: node.getAttribute('draggable'),
    display: getComputedStyle(node).display,
    underline: getComputedStyle(node).textDecorationLine,
    colour: getComputedStyle(node).color,
    plain: getComputedStyle(node.querySelector('.name')!).color,
  })));
  const noteRows = homeRow.filter((row) => /\/notes\/\d+/.test(row.href ?? ''));
  check('every note row on home is a link to that note',
    noteRows.length === 6 && noteRows.every((row) => row.tag === 'A' && row.draggable === 'false'),
    JSON.stringify(noteRows.map((row) => `${row.tag} ${row.href}`)));
  check('…and wears none of what an anchor brings of its own',
    noteRows.every((row) => row.display === 'flex' && row.underline === 'none' && row.colour === row.plain),
    JSON.stringify(noteRows[0]));
  await shot('home');

  // 3. The notes screen, and the archive behind its door.
  await tap(page$, '#notes .crow:nth-last-child(2)');
  await page$.waitForSelector('#screenNotes #notesList .crow', { timeout: 10_000 });
  check('the notes screen leaves nothing off',
    (await page$.$$('#notesList .crow')).length === 8, String((await page$.$$('#notesList .crow')).length));
  check('…at its registered address', page$.url() === `${ORIGIN}/notes`, page$.url());
  await shot('list');

  // Note #307: the chips narrow the list by the state its rows already wear.
  const chipWords = await page$.$$eval('#notesFilter .chip', (nodes) => nodes.map((n) => n.textContent));
  check('the list offers the states it is actually in, and All',
    chipWords.join(' | ') === 'All | Unclaimed | Handed over | Working',
    chipWords.join(' | '));
  // The chip's word and the badge's are the same vocabulary: a badge names
  // one note's state ("Working by Kai"), a chip names what every note under
  // it shares.
  const badges = await page$.$$eval('#notesList .crow .badge', (nodes) => nodes.map((n) => n.textContent));
  check('…in the same words the rows themselves wear',
    badges.includes('Working by Kai') && badges.includes('Handed to Kai'), badges.join(' | '));
  // The row is one more row OF the card: its first word starts where every
  // note's title below it does, and it is a thumb-sized tap.
  const chipBox = await page$.evaluate(() => {
    const first = document.querySelector('#notesFilter .chip')!;
    const box = first.getBoundingClientRect();
    // Where the WORD starts, not where its button does: the chip carries its
    // own padding, and the holder's is set to complete it.
    const word = box.left + parseFloat(getComputedStyle(first).paddingLeft);
    const name = document.querySelector('#notesList .crow .name')!.getBoundingClientRect();
    return { word, name: name.left, tap: box.height };
  });
  check('the chips line up with the notes under them, at a thumb-sized height',
    Math.abs(chipBox.word - chipBox.name) < 1.5 && chipBox.tap >= 44, JSON.stringify(chipBox));
  await shot('filter-all');

  await tap(page$, '#notesFilter .chip[data-filter="working"]');
  await page$.waitForFunction(() => document.querySelectorAll('#notesList .crow').length === 1, { timeout: 10_000 });
  check('a chip narrows the list to that state, and the subtitle counts it',
    (await text('#notesList .crow .name')) === 'Filler note 1'
    && (await text('#notesSub')) === 'One of 8 notes is being worked on.',
    `${await text('#notesList .crow .name')} / ${await text('#notesSub')}`);
  check('…and the state being read wears the mark, not a second loud button',
    (await text('#notesFilter .chip.here')) === 'Working'
    && await page$.$eval('#notesFilter .chip.here', (node) => getComputedStyle(node, '::after').height) === '2px',
    await text('#notesFilter .chip.here'));
  await shot('filter-one');

  // Note #419: the chip is in the list's own address, so the note opened from
  // a narrowed list comes Back to that list — by the header's Back and by the
  // browser's alike — and an address with the state in it opens narrowed.
  check('the chosen state is written into the address',
    new URL(page$.url()).searchParams.get('state') === 'working', page$.url());
  const narrowedBack = async (how: string, back: () => Promise<unknown>) => {
    await tap(page$, '#notesList a.crow[href]');
    await page$.waitForSelector('#screenNote #noteBody', { timeout: 10_000 });
    await back();
    await page$.waitForSelector('#screenNotes #notesFilter', { timeout: 10_000 });
    check(`Back from a note (${how}) returns to the state it was opened from`,
      (await text('#notesFilter .chip.here')) === 'Working'
      && (await texts('#notesList .crow .name')).join('|') === 'Filler note 1'
      && new URL(page$.url()).searchParams.get('state') === 'working',
      `${await text('#notesFilter .chip.here')} / ${page$.url()}`);
  };
  await narrowedBack('header', () => tap(page$, '#pageBack'));
  await narrowedBack('browser', () => page$.goBack());
  await tap(page$, '#notesFilter .chip[data-filter="all"]');
  await page$.waitForFunction(() => document.querySelectorAll('#notesList .crow').length === 8, { timeout: 10_000 });
  check('All gives every note back',
    (await text('#notesSub')) === '8 notes, shared with the workplace and its agents.', await text('#notesSub'));

  const field = await page$.$('#notesSearch input');
  check('a list this long has earned a search field', Boolean(field));
  await page$.type('#notesSearch input', 'wifi');
  await page$.waitForFunction(() => document.querySelectorAll('#notesList .crow').length === 1, { timeout: 10_000 });
  check('a search owns the list, and its count owns the subtitle',
    (await text('#notesList .crow .name')) === 'The wifi code is 4417'
    && (await text('#notesSub')).startsWith('One match'),
    `${await text('#notesList .crow .name')} / ${await text('#notesSub')}`);
  check('…and the archive door keeps its place at the foot',
    Boolean(await page$.$('#notesArchiveDoor')));
  await shot('search');
  check('…while the state chips stand down: a search spans the archive too',
    (await page$.$$('#notesFilter')).length === 0);
  await page$.$eval('#notesSearch input', (node) => { (node as HTMLInputElement).value = ''; });
  await page$.type('#notesSearch input', ' ');
  await page$.keyboard.press('Backspace');
  await page$.waitForFunction(() => document.querySelectorAll('#notesList .crow').length === 8, { timeout: 10_000 });
  check('…and are back with the list they narrow', Boolean(await page$.$('#notesFilter')));

  await tap(page$, '#notesArchiveDoor button');
  await page$.waitForSelector('#screenNoteArchive #noteArchiveList .crow', { timeout: 10_000 });
  check('the archive is its own screen, fetched on the tap',
    page$.url() === `${ORIGIN}/notes/archive`
    && (await text('#noteArchiveList .crow .name')) === 'Last month’s jottings',
    `${page$.url()} / ${await text('#noteArchiveList .crow .name')}`);
  check('…and says what it is for', (await text('#noteArchiveSub')).includes('restore or delete'),
    await text('#noteArchiveSub'));
  const heads: Record<string, string> = { archive: await headShape(page$) };
  await shot('archive');
  await tap(page$, '#pageBack');
  await page$.waitForSelector('#screenNotes', { timeout: 10_000 });

  // Note #284: the row is a link, and a plain tap on it must still belong to
  // the SHELL. A full page load would land on the same note and would be a
  // different app — so a marker planted on the window has to survive the tap.
  await page$.evaluate(() => { (window as unknown as { rowTap?: number }).rowTap = 1; });
  const rowHref = await page$.$eval('#notesList a.crow[href]', (node) => node.getAttribute('href'));
  await tap(page$, '#notesList a.crow[href]');
  await page$.waitForSelector('#screenNote', { timeout: 10_000 });
  check('a tap on a row is followed by the shell, not by a page load',
    page$.url() === `${ORIGIN}${rowHref}`
    && await page$.evaluate(() => (window as unknown as { rowTap?: number }).rowTap === 1),
    `${page$.url()} / ${rowHref}`);
  await tap(page$, '#pageBack');
  await page$.waitForSelector('#screenNotes', { timeout: 10_000 });

  // 4. One note whole: the words, the hands, the margin, the files.
  await page$.goto(`${ORIGIN}/notes/${plumber.number}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenNote #noteBody .kpage', { timeout: 10_000 });
  check('the note is its own words, under a title that is not repeated',
    (await texts('#noteBody p')).join(' | ')
      === `He is closed on Mondays. | The code is on note #${wifi.number}, not in PR #560.`,
    (await texts('#noteBody p')).join(' | '));
  // The chat's reading size (note #731): a note is read the way a message is.
  check('the note body is the size of a chat message',
    (await page$.$eval('#noteBody .kpage', (node) => getComputedStyle(node).fontSize)) === '17px',
    await page$.$eval('#noteBody .kpage', (node) => getComputedStyle(node).fontSize));
  check('a note it names is a door to that note, and a proposal number is not',
    (await page$.$$eval('#noteBody a.noteref', (nodes) => nodes.map((node) => node.getAttribute('href'))))
      .join(' | ') === `/notes/${wifi.number}`,
    (await page$.$$eval('#noteBody a.noteref', (nodes) => nodes.map((node) => node.getAttribute('href')))).join(' | '));
  check('the line under the title names the note and who wrote it',
    (await text('#noteSub')).startsWith(`Note #${plumber.number}`) && (await text('#noteSub')).includes('Written by'),
    await text('#noteSub'));
  check('the row of agents it could be handed to leads with the one idle agent',
    (await text('#noteHands .hand .hname')) === 'Kai', await text('#noteHands .hand .hname'));
  check('…wearing the runtime it will answer with',
    (await text('#noteHands .hand .hharness')) === 'Claude Code'
    && (await text('#noteHands .hand .hmodel')) === 'Opus',
    `${await text('#noteHands .hand .hharness')} / ${await text('#noteHands .hand .hmodel')}`);
  // Note #352: the agent that cannot be handed anything YET is the one the
  // reader is waiting on, and a card that only said "Setting up" gave them no
  // way to tell a machine coming up from one that had died on the way. It now
  // wears what home's plate wears: a turning ring where the context ring goes,
  // and the three-segment meter breathing on the waypoint it is standing on.
  const coming = await page$.evaluate(() => {
    const tile = [...document.querySelectorAll('#noteHands .hand')]
      .find((node) => node.querySelector('.hname')?.textContent?.trim() === 'Ada');
    if (!tile) return null;
    const meter = tile.querySelector('.steps');
    const card = tile.getBoundingClientRect();
    const bar = meter?.getBoundingClientRect();
    return {
      said: tile.querySelector('.habout')?.textContent?.trim() ?? '',
      ring: Boolean(tile.querySelector('.handface .working')),
      stage: meter?.getAttribute('aria-label') ?? '',
      live: Boolean(tile.querySelector('.steps span.now.live')),
      // Drawn, and drawn ACROSS the card: a meter that collapsed to its gaps
      // would still pass every attribute check above and show nothing.
      spans: bar ? Math.round(bar.width) >= Math.round(card.width) - 20 : false,
      inside: bar ? Math.round(card.bottom - bar.bottom) : -1,
    };
  });
  check('an agent still coming up says so with the meter home draws, not a still word',
    coming?.said === 'Setting up' && coming?.ring === true
    && coming?.stage === 'Setup step 1 of 3' && coming?.live === true,
    JSON.stringify(coming));
  check('…and the meter spans the card it belongs to, inside its own foot',
    coming?.spans === true && (coming?.inside ?? -1) >= 0 && (coming?.inside ?? 99) <= 12,
    JSON.stringify(coming));
  check('the margin carries the remark, rendered rather than poured in',
    (await text('#noteComments .ncmt .ctext')) === `Called them, closed Mondays. Same as note #${wifi.number}.`
    && (await page$.$$('#noteComments .ncmt strong')).length === 1,
    await text('#noteComments .ncmt .ctext'));
  check('…and a note named in the margin is a door too',
    (await page$.$$('#noteComments .ncmt a.noteref')).length === 1);
  check('a live note offers the box to answer in',
    (await texts('#noteCommentsCard .addrow')).join('') === 'Write a comment',
    (await texts('#noteCommentsCard .addrow')).join(''));
  // Note #647: the reader's own remark carries Edit, the agent's nothing, and
  // Delete waits inside Edit rather than sitting red on the resting thread.
  const doors = await page$.evaluate(() => [...document.querySelectorAll('#noteComments .ncmt')].map((row) => (
    // The face is a button too, and a silent one — the words are the doors.
    [...row.querySelectorAll('.who button')].map((node) => node.textContent?.trim() ?? '').filter(Boolean).join(' ')
  )));
  check('only the reader’s own remark offers Edit, and no remark shows Delete at rest',
    doors.length === 2 && doors[0] === '' && doors[1] === 'Edit'
      && (await page$.$$('#noteComments .cmtdelete')).length === 0,
    JSON.stringify(doors));
  // Move offered another room where there were rooms, until rooms left the
  // product (note #843).
  check('the reader’s own note offers Edit and Archive',
    (await texts('#noteActions button')).join(' | ') === 'Edit note | Archive note',
    (await texts('#noteActions button')).join(' | '));
  check('the persistent header stands over the destination', Boolean(await page$.$('#pageHead')));
  heads.note = await headShape(page$);
  check('the note wears the one header, and its title is IN it',
    Object.values(heads).every((shape) => shape === ONE_HEADER)
      && Boolean(await page$.$('#pageHead #noteTitle')), JSON.stringify(heads));
  await shot('note');

  // 5. The handoff, as a leaf that keeps the note's address underneath it.
  const beforeSend = await page$.evaluate(() => history.length);
  await tap(page$, '#noteHands .hand .handpick');
  await page$.waitForSelector('#screenNoteSend', { timeout: 10_000 });
  check('the message is written already, and names the note by number',
    (await page$.$eval('#noteSendText', (node) => (node as HTMLTextAreaElement).value))
      === `pick up the note #${plumber.number}`,
    await page$.$eval('#noteSendText', (node) => (node as HTMLTextAreaElement).value));
  check('the send keeps the note’s address — it is a leaf, not a place',
    page$.url() === `${ORIGIN}/notes/${plumber.number}`, page$.url());
  const sendAction = await page$.$eval('#noteSendBtn', (node) => {
    const box = node.getBoundingClientRect();
    const form = document.querySelector('#noteSendForm')!.getBoundingClientRect();
    const field = document.querySelector('#noteSendText')!.getBoundingClientRect();
    return {
      width: box.width,
      inForm: Boolean(node.closest('#noteSendForm')),
      afterField: box.top >= field.bottom,
      rightDelta: Math.abs(box.right - form.right),
      lighterThanForm: box.width < form.width / 2,
      headerActions: document.querySelectorAll('#pageHead button:not(#pageBack)').length,
    };
  });
  check('the handoff Send is a compact form action below the message',
    sendAction.inForm && sendAction.afterField && sendAction.rightDelta < 1
      && sendAction.lighterThanForm && sendAction.headerActions === 0,
    JSON.stringify(sendAction));
  await shot('send');
  await tap(page$, '#pageBack');
  await page$.waitForSelector('#screenNote #noteBody', { timeout: 10_000 });
  check('Back closes the message and lands on the note, spending no entry',
    (await page$.evaluate(() => history.length)) === beforeSend,
    `${await page$.evaluate(() => history.length)} vs ${beforeSend}`);

  // 5b. The way to attach is a paperclip on Copy's own row (note #604), not a
  //     card: with no file yet there is no files card at all.
  const tools = await page$.evaluate(() => {
    const clip = document.getElementById('noteAttachBtn')!.getBoundingClientRect();
    const copy = document.querySelector('#noteBody .notetools button[aria-label="Copy note"]')!.getBoundingClientRect();
    return {
      centreDelta: Math.abs((clip.top + clip.height / 2) - (copy.top + copy.height / 2)),
      beside: clip.right <= copy.left + 0.5,
      card: Boolean(document.getElementById('noteFilesCard')),
    };
  });
  check('the paperclip stands beside Copy, on the same line, with no empty files card',
    tools.centreDelta < 1 && tools.beside && !tools.card, JSON.stringify(tools));

  // 6. A file on the note: picked, sent, and shown AS the picture it is. A
  //    REAL photograph rather than a coloured square — a one-pixel PNG
  //    stretched to the card's width proves the <img> decoded and shows the
  //    reader nothing about what this card looks like.
  await page$.$eval('#noteFileInput', (node) => { (node as HTMLInputElement).removeAttribute('hidden'); });
  const picker = await page$.$('#noteFileInput');
  await picker!.uploadFile(path.join(REPO, 'backend/assets/agent-avatars/kai.jpg'));
  await page$.waitForSelector('#noteFiles .notephoto img', { timeout: 15_000 });
  check('a photograph on a note is shown AS the photograph',
    await decoded('#noteFiles .notephoto img'));
  check('…with the row of facts a plain file row carries under it',
    (await text('#noteFiles .caprow')).includes('kai.jpg'), await text('#noteFiles .caprow'));
  // Hidden again before the shot: the file input is the app's own, and a
  // screenshot showing a browser's "Choose File" control is a picture of the
  // harness rather than of the screen.
  await page$.$eval('#noteFileInput', (node) => { (node as HTMLInputElement).setAttribute('hidden', ''); });
  await shot('files');

  // 6b. Note #690: the picture opened full screen can be KEPT. The viewer's
  //     head carries a Download, and pressing it lands the very bytes that
  //     were attached on the download shelf — while the reader stays on the
  //     picture, because a link signed for saving does not navigate.
  await page$.waitForFunction(
    () => document.querySelector('#noteFiles .notephoto')?.getAttribute('aria-label') === 'Open kai.jpg',
    { timeout: 10_000 },
  );
  await tap(page$, '#noteFiles .notephoto');
  await page$.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('#imageViewerImage');
    return Boolean(img && img.naturalWidth > 0);
  }, { timeout: 10_000 });
  const saveControl = await page$.evaluate(() => {
    const save = document.getElementById('imageViewerSave');
    const close = document.getElementById('imageViewerClose');
    if (!save || !close) return { present: Boolean(save) };
    const a = save.getBoundingClientRect();
    const b = close.getBoundingClientRect();
    return {
      present: true,
      label: save.getAttribute('aria-label'),
      besideClose: a.right <= b.left + 0.5 && Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 1,
    };
  });
  check('a note’s picture opened full screen carries a Download beside Close (note #690)',
    saveControl.present && saveControl.label === 'Download kai.jpg' && Boolean(saveControl.besideClose),
    JSON.stringify(saveControl));
  await shot('viewer-download');
  const shelf = mkdtempSync(path.join(os.tmpdir(), 'n690-shelf-'));
  const cdp = await page$.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: shelf });
  const beforeSave = page$.url();
  await tap(page$, '#imageViewerSave');
  const landed = path.join(shelf, 'kai.jpg');
  const deadline = Date.now() + 10_000;
  while (!existsSync(landed) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const attached = readFileSync(path.join(REPO, 'backend/assets/agent-avatars/kai.jpg'));
  check('…and pressing it saves the very file that was attached, under its own name',
    existsSync(landed) && readFileSync(landed).equals(attached),
    existsSync(landed) ? `${readFileSync(landed).length} vs ${attached.length} bytes` : `nothing in ${shelf}: ${readdirSync(shelf).join(', ')}`);
  check('…leaving the reader on the picture, at the same address',
    Boolean(await page$.$('#imageViewer')) && page$.url() === beforeSave, page$.url());
  await page$.keyboard.press('Escape');
  await page$.waitForFunction(() => !document.querySelector('#imageViewer'), { timeout: 10_000 });

  // 6c. A video and a recording on a note PLAY on their slides (the owner,
  //     2026-10-04, once the chat played them — note #693). Real clips
  //     through a real decoder, attached the way a person attaches them:
  //     whether the first frame is drawn, and whether pressing play moves
  //     it, are things only a browser can say.
  for (const [name, selector] of [
    ['chat-clip.mp4', '#noteFiles .notevideo video'],
    ['chat-voice.mp3', '#noteFiles .noteaudio audio'],
  ] as const) {
    await page$.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#noteAttachBtn')?.disabled, { timeout: 15_000 });
    await page$.$eval('#noteFileInput', (node) => { (node as HTMLInputElement).removeAttribute('hidden'); });
    await (await page$.$('#noteFileInput'))!.uploadFile(path.join(REPO, 'scripts/fixtures', name));
    await page$.waitForSelector(selector, { timeout: 15_000 });
  }
  await page$.$eval('#noteFileInput', (node) => { (node as HTMLInputElement).setAttribute('hidden', ''); });
  await page$.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('#noteFiles .notevideo video');
    const audio = document.querySelector<HTMLAudioElement>('#noteFiles .noteaudio audio');
    return Boolean(video && video.readyState >= 2 && audio && audio.readyState >= 1);
  }, { timeout: 15_000 }).catch(() => {});
  await page$.evaluate(() => document.querySelector('#noteFiles .notevideo')!.scrollIntoView({ block: 'center', inline: 'start' }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const noteClip = await page$.$eval('#noteFiles .notevideo', (frame) => {
    const video = frame.querySelector('video')!;
    const box = frame.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    // The frame the decoder drew, read back off a canvas: the clip is one
    // flat colour, so any pixel of it says whether a picture is there.
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    const context = canvas.getContext('2d')!;
    context.drawImage(video, 0, 0, 8, 8);
    const [red, green, blue] = context.getImageData(4, 4, 1, 1).data;
    const row = frame.nextElementSibling as HTMLElement | null;
    return {
      ready: video.readyState,
      shape: getComputedStyle(frame).getPropertyValue('--video-shape').trim(),
      frame: { width: Math.round(box.width), height: Math.round(box.height) },
      slide: Math.round(frame.closest('.noteattachment')!.getBoundingClientRect().width),
      painted: { width: Math.round(video.videoWidth * scale), height: Math.round(video.videoHeight * scale) },
      pixel: [red ?? 0, green ?? 0, blue ?? 0],
      controls: video.controls,
      inline: video.playsInline,
      caption: row?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      download: Boolean(row?.querySelector('[aria-label="Download chat-clip.mp4"]')),
      remove: Boolean(row?.querySelector('[aria-label="Remove chat-clip.mp4"]')),
    };
  });
  check('a video on a note plays on its slide: first frame drawn, upright in black bars, no taller than a photo',
    noteClip.ready >= 2 && noteClip.shape === '360 / 640'
    && noteClip.frame.height >= 400 && noteClip.frame.height <= 460 && noteClip.frame.width >= noteClip.slide - 2
    && noteClip.painted.height === noteClip.frame.height && noteClip.controls && noteClip.inline
    && Math.abs(noteClip.pixel[0]! - 0x2a) < 24 && Math.abs(noteClip.pixel[1]! - 0x9d) < 24 && Math.abs(noteClip.pixel[2]! - 0x8f) < 24,
    JSON.stringify(noteClip));
  check('…with the facts row a photo has under it, and Download beside the ✕',
    noteClip.caption.includes('chat-clip.mp4 · 10 KB · you attached this') && noteClip.download && noteClip.remove,
    JSON.stringify(noteClip));
  // PLAYING IS A STATE, NOT A SPEED (note #1075). These used to wait up to 10 s
  // for the clock to pass 0.4 s (0.3 s for the recording), which asks how fast a
  // busy machine decodes rather than whether the press played anything: CI
  // read 0.4 and 0.3 on three runs, 5-8 Nov 2026, with no error and nothing
  // over the page. The proof that it plays is the clock leaving zero (or the
  // clip reaching its end), with no media error.
  await tap(page$, '#noteFiles .notevideo video');
  await page$.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('#noteFiles .notevideo video');
    return Boolean(video && (video.currentTime > 0 || video.ended || video.error));
  }, { timeout: 20_000 }).catch(() => {});
  const notePlayed = await page$.$eval('#noteFiles .notevideo video', (node) => {
    const video = node as HTMLVideoElement;
    return { at: Number(video.currentTime.toFixed(2)), started: video.currentTime > 0 || video.ended, error: video.error?.code ?? 0, fullscreen: document.fullscreenElement !== null, viewer: Boolean(document.querySelector('#imageViewer, #pdfViewer')) };
  });
  check('…and pressed, it plays right there, opening nothing over the note',
    notePlayed.started && !notePlayed.error && !notePlayed.fullscreen && !notePlayed.viewer, JSON.stringify(notePlayed));
  await page$.evaluate(() => document.querySelector<HTMLAudioElement>('#noteFiles .noteaudio audio')!.play());
  await page$.waitForFunction(() => {
    const audio = document.querySelector<HTMLAudioElement>('#noteFiles .noteaudio audio');
    return Boolean(audio && (audio.currentTime > 0 || audio.ended || audio.error));
  }, { timeout: 20_000 }).catch(() => {});
  const noteHeard = await page$.$eval('#noteFiles .noteaudio', (node) => {
    const audio = node.querySelector('audio')!;
    return {
      at: Number(audio.currentTime.toFixed(2)),
      started: audio.currentTime > 0 || audio.ended,
      error: audio.error?.code ?? 0,
      duration: Math.round(audio.duration),
      width: Math.round(audio.getBoundingClientRect().width),
      caption: (node.nextElementSibling as HTMLElement | null)?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    };
  });
  check('a recording on a note plays on its slide, as a play bar above its facts',
    noteHeard.started && !noteHeard.error && noteHeard.duration === 3 && noteHeard.width > 200 && noteHeard.caption.includes('chat-voice.mp3'),
    JSON.stringify(noteHeard));
  await page$.evaluate(() => { for (const player of document.querySelectorAll<HTMLMediaElement>('#noteFiles video, #noteFiles audio')) player.pause(); });
  // The card itself, slid to each player in turn: a full-page shot keeps the
  // strip where it stood, on the photograph.
  for (const [selector, name] of [['.notevideo', 'files-video'], ['.noteaudio', 'files-audio']] as const) {
    const card = await page$.evaluate((target) => {
      const strip = document.getElementById('noteFiles')!;
      const slide = strip.querySelector(target)!.closest('.noteattachment') as HTMLElement;
      strip.scrollLeft = slide.offsetLeft - strip.offsetLeft - 12;
      const box = document.getElementById('noteFilesCard')!.getBoundingClientRect();
      return { x: box.left + window.scrollX, y: box.top + window.scrollY, width: box.width, height: box.height };
    }, selector);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // A clip of the viewport rather than the element's own shot, which lays
    // the page out again and puts the strip back on its first slide.
    await page$.screenshot({ path: path.join(OUT, `n256-notes-${name}.png`) as `${string}.png`, clip: card, captureBeyondViewport: false });
  }
  await tap(page$, '#noteFiles [aria-label="Download chat-clip.mp4"]');
  const clipSaved = path.join(shelf, 'chat-clip.mp4');
  for (const until = Date.now() + 10_000; !existsSync(clipSaved) && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 100));
  check('…and its Download saves the very clip that was attached, leaving the note where it was',
    existsSync(clipSaved) && readFileSync(clipSaved).equals(readFileSync(path.join(REPO, 'scripts/fixtures/chat-clip.mp4')))
    && page$.url() === beforeSave,
    existsSync(clipSaved) ? `${readFileSync(clipSaved).length} bytes at ${page$.url()}` : `nothing in ${shelf}: ${readdirSync(shelf).join(', ')}`);

  // 7. Writing one: the composer is transient, and a save lands on the note.
  await page$.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenOverview #newNoteBtn', { timeout: 10_000 });
  const beforeWrite = await page$.evaluate(() => history.length);
  // Home fills in beneath this button after navigation. On a loaded CI host
  // the row moved between Puppeteer resolving it and dispatching the press:
  // one run missed it, and the retry reported it as no longer clickable.
  // `tap` waits for the button's own box to hold still before pressing it.
  await tap(page$, '#newNoteBtn');
  await page$.waitForSelector('#screenNoteNew #noteText', { timeout: 10_000 });
  check('the note creation box is the size the note is read at (note #731)',
    (await page$.$eval('#noteText', (node) => getComputedStyle(node).fontSize)) === '17px',
    await page$.$eval('#noteText', (node) => getComputedStyle(node).fontSize));
  check('the composer keeps Home’s address underneath it',
    page$.url() === `${ORIGIN}/`, page$.url());
  check('…and Home’s overview lends it the header it has none of its own',
    Boolean(await page$.$('#pageHead')));
  check('the composer does not repeat the removed name, sharing, or password warning',
    !(await page$.$eval('#noteForm', (node) => node.textContent ?? '')).includes('The first line becomes its name'));
  const saveWithForm = await page$.evaluate(() => {
    const save = document.querySelector<HTMLButtonElement>('#saveNoteBtn')!;
    const form = document.querySelector<HTMLElement>('#noteForm')!;
    const field = document.querySelector<HTMLElement>('#noteText')!;
    const saveBox = save.getBoundingClientRect();
    const formBox = form.getBoundingClientRect();
    const fieldBox = field.getBoundingClientRect();
    return {
      inForm: Boolean(save.closest('#noteForm')),
      form: save.form?.id,
      homeAbsent: !document.querySelector('#pageHome'),
      afterField: saveBox.top >= fieldBox.bottom,
      width: saveBox.width,
      formWidth: formBox.width,
      rightDelta: Math.abs(saveBox.right - formBox.right),
      headerActions: document.querySelectorAll('#pageHead button:not(#pageBack)').length,
    };
  });
  check('create-note Save stays below the input and out of the app header',
    saveWithForm.inForm && saveWithForm.form === 'noteForm' && saveWithForm.homeAbsent
      && saveWithForm.afterField && saveWithForm.headerActions === 0,
    JSON.stringify(saveWithForm));
  check('create-note Save is compact and aligned to the form’s trailing edge',
    saveWithForm.width < saveWithForm.formWidth / 2 && saveWithForm.rightDelta < 1,
    JSON.stringify(saveWithForm));
  await page$.type('#noteText', 'Bring the drill on Thursday');
  check('the box counts what is in it', (await text('#noteCount')) === '27 characters', await text('#noteCount'));
  const foot = await page$.evaluate(() => {
    const clip = document.getElementById('noteDraftAttachBtn')!.getBoundingClientRect();
    const save = document.getElementById('saveNoteBtn')!.getBoundingClientRect();
    return {
      centreDelta: Math.abs((clip.top + clip.height / 2) - (save.top + save.height / 2)),
      before: clip.right < save.left,
      card: Boolean(document.getElementById('noteDraftFilesCard')),
    };
  });
  check('the composer’s paperclip shares Save’s row, with no empty files card (note #604)',
    foot.centreDelta < 1 && foot.before && !foot.card, JSON.stringify(foot));
  await shot('composer');

  // 7b. Note #318: a photo picked for a note that does not exist YET opens
  //     where every other picture in the Workspace does. Two of them, because
  //     the question the composer had never had to answer is whether the
  //     second one is a swipe away or a close-and-find-it-again — and real
  //     JPEGs, so `naturalWidth` proves the viewer decoded the phone's own
  //     bytes rather than drawing a frame around nothing.
  await page$.$eval('#noteDraftFileInput', (node) => { (node as HTMLInputElement).removeAttribute('hidden'); });
  const draftPicker = await page$.$('#noteDraftFileInput');
  await draftPicker!.uploadFile(path.join(REPO, 'backend/assets/agent-avatars/kai.jpg'));
  await page$.waitForSelector('#noteDraftFiles .notephoto img', { timeout: 15_000 });
  await draftPicker!.uploadFile(path.join(REPO, 'backend/assets/agent-avatars/leo.jpg'));
  await page$.waitForFunction(
    () => document.querySelectorAll('#noteDraftFiles .notephoto img').length === 2, { timeout: 15_000 },
  ).catch(() => {});
  // Hidden again before the shot, for the reason the note's own picker is.
  await page$.$eval('#noteDraftFileInput', (node) => { (node as HTMLInputElement).setAttribute('hidden', ''); });
  const draftLabels = await page$.$$eval('#noteDraftFiles .notephoto',
    (nodes) => nodes.map((node) => node.getAttribute('aria-label')));
  check('a photo picked before the note exists says what its tap will do',
    draftLabels.join(' | ') === 'Preview kai.jpg full screen | Preview leo.jpg full screen',
    draftLabels.join(' | '));
  await shot('composer-files');
  await tap(page$, '#noteDraftFiles .notephoto');
  await page$.waitForSelector('#imageViewer', { timeout: 10_000 });
  check('…and the tap opens the shared viewer on the phone’s own bytes',
    (await text('#imageViewerName')) === 'kai.jpg'
    && await decoded('#imageViewerImage'),
    await text('#imageViewerName'));
  check('…with every picked photo as ONE gallery',
    (await text('#imageViewerCount')) === '1 of 2', await text('#imageViewerCount'));
  await shot('composer-viewer');

  // 7c. Note #288: two fingers on the picture zoom it. Real touch events
  //     through CDP, because that is what a phone sends and the port had
  //     lost exactly this — the buttons worked, the fingers did nothing.
  {
    const cdp = await page$.createCDPSession();
    const box = await page$.$eval('#imageViewerStage', (n) => {
      const r = n.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    const transform = () => page$.$eval('#imageViewerImage', (n) => (n as HTMLElement).style.transform);
    const fingers = (gap: number) => [{ x: box.cx - gap / 2, y: box.cy, id: 1 }, { x: box.cx + gap / 2, y: box.cy, id: 2 }];
    const pinch = async (from: number, to: number) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(from) });
      const step = from < to ? 20 : -20;
      for (let gap = from + step; step > 0 ? gap <= to : gap >= to; gap += step) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(gap) });
      }
      const held = await transform();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      return { held, after: await transform() };
    };
    const spread = await pinch(80, 240);
    check('two fingers spreading zoom the picture in, and it stays zoomed when they lift',
      /scale\(3\)$/.test(spread.after) && Boolean(await page$.$('#imageViewer')),
      `${spread.held} → ${spread.after} · ${await text('#imageZoomReset')}`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.cx, y: box.cy, id: 3 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.cx + 60, y: box.cy + 40, id: 3 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check('…one finger then pans it', (await transform()) === 'translate(60px, 40px) scale(3)', await transform());
    await shot('pinch');
    const closed = await pinch(240, 20);
    check('…and a pinch closed under Fit gives while held, then springs back to Fit',
      /scale\(0\.6\)$/.test(closed.held) && closed.after === 'translate(0px, 0px) scale(1)'
      && Boolean(await page$.$('#imageViewer')),
      `${closed.held} → ${closed.after}`);
    await cdp.detach();
  }
  await tap(page$, '#imageViewerNext');
  await page$.waitForFunction(
    () => document.getElementById('imageViewerName')?.textContent === 'leo.jpg', { timeout: 10_000 },
  ).catch(() => {});
  check('the second pick is one step away, not a close and another tap',
    (await text('#imageViewerName')) === 'leo.jpg'
    && await decoded('#imageViewerImage'),
    await text('#imageViewerName'));
  await page$.keyboard.press('Escape');
  await page$.waitForFunction(() => !document.querySelector('#imageViewer'), { timeout: 10_000 });
  check('Escape gives the half-written note back, words and picks both intact',
    (await page$.$eval('#noteText', (node) => (node as HTMLTextAreaElement).value)) === 'Bring the drill on Thursday'
    && (await page$.$$('#noteDraftFiles .notephoto')).length === 2,
    await page$.$eval('#noteText', (node) => (node as HTMLTextAreaElement).value));
  // The ✕ sits INSIDE a block that now opens: taking a pick back off must not
  // open it on the way past.
  for (let left = 2; left > 0; left -= 1) {
    await tap(page$, '#noteDraftFiles .caprow .chev');
    await page$.waitForFunction(
      (want: number) => document.querySelectorAll('#noteDraftFiles .notephoto').length === want,
      { timeout: 10_000 }, left - 1,
    );
  }
  check('the ✕ takes a picked photo off without opening it',
    !(await page$.$('#imageViewer')) && (await page$.$$('#noteDraftFiles > *')).length === 0,
    `${(await page$.$$('#noteDraftFiles > *')).length} left`);
  await tap(page$, '#saveNoteBtn');
  await page$.waitForSelector('#screenNote #noteBody', { timeout: 10_000 });
  // The body can be drawn a frame before the title is: this read the title
  // once for the verdict and again for the message, and on a loaded machine
  // failed while printing the right words (note #1075). Wait for the words,
  // then judge and report the SAME reading.
  await page$.waitForFunction(
    () => document.getElementById('noteTitle')?.textContent === 'Bring the drill on Thursday', { timeout: 10_000 },
  ).catch(() => {});
  const savedTitle = await text('#noteTitle');
  check('a saved note ends on the note just created', savedTitle === 'Bring the drill on Thursday', savedTitle);
  check('the removed Home action does not return after the composer closes',
    !(await page$.$('#pageHome')));
  await tap(page$, '#pageBack');
  await page$.waitForSelector('#screenOverview', { timeout: 10_000 });
  check('…with Home’s overview still underneath it, one Back away', Boolean(await page$.$('#screenOverview')));

  // 8. Archiving from the note itself puts the reader back on the list they
  //    opened it from — the one place that can show the note is gone — and
  //    spends the note's own entry rather than pushing Home over it (#283).
  await page$.goto(`${ORIGIN}/notes`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenNotes #notesList .crow', { timeout: 10_000 });
  const listed = (await page$.$$('#notesList .crow')).length;
  const doomed = await page$.$$eval('#notesList a.crow[href]', (nodes) => nodes
    .filter((node) => node.querySelector('.name')?.textContent?.trim() === 'Filler note 1')
    .map((node) => node.getAttribute('href'))[0] ?? '');
  await tap(page$, `#notesList a.crow[href="${doomed}"]`);
  await page$.waitForSelector('#screenNote #noteActions', { timeout: 10_000 });
  const onNote = await page$.evaluate(() => history.length);
  await page$.evaluate(() => {
    const button = [...document.querySelectorAll('#noteActions button')]
      .find((node) => node.textContent?.trim() === 'Archive note');
    (button as HTMLButtonElement).click();
  });
  await page$.waitForSelector('#screenNotes #notesList .crow', { timeout: 10_000 });
  check('archiving a note lands back on the list it was opened from',
    page$.url() === `${ORIGIN}/notes`, page$.url());
  check('…with the note gone from it, and no toast to say so',
    !(await texts('#notesList .crow .name')).includes('Filler note 1')
    && (await page$.$$('#notesList .crow')).length === listed - 1
    && !(await page$.$('#banner')),
    (await texts('#notesList .crow .name')).join(' | '));
  check('…having spent the note’s own entry rather than pushing over it',
    (await page$.evaluate(() => history.length)) === onNote,
    `${await page$.evaluate(() => history.length)} vs ${onNote}`);
  check('…and the archive door now says there are two behind it',
    (await text('#notesArchiveDoor')).includes('2 notes'), await text('#notesArchiveDoor'));
  await shot('archived-back');

  // 8b. NOTE #236: a note an agent is WORKING ON says so — and the agent doing
  //     the work wears its face on those words, as the door onto it. Until
  //     this, "Working by Kai" was the one name on the screen with nothing to
  //     tap: the portrait at the head of the line belongs to whoever WROTE the
  //     note, which on a handed note is somebody else entirely.
  await quickNoteStorage.update(plumber.id, { claim: undefined } as never);
  await page$.goto(`${ORIGIN}/notes/${plumber.number}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenNote #noteBody .kpage', { timeout: 10_000 });
  check('the open note begins from the state its first read answered',
    (await text('#noteSub')).includes('Unclaimed'), await text('#noteSub'));
  await quickNoteStorage.claim(plumber.id, {
    agentId: 'kai', userId: me.userId, agentName: 'Kai',
  }, new Date());
  const liveClaims = await page$.evaluate(async () => {
    const response = await fetch('/workspace/api/agents/live');
    return (await response.json()).noteClaims ?? null;
  });
  check('the live endpoint carries the new claim without the note body',
    Array.isArray(liveClaims)
      && liveClaims.some((row: { id?: string }) => row.id === plumber.id)
      && !JSON.stringify(liveClaims).includes('closed on Mondays'),
    JSON.stringify(liveClaims));
  // This wait went red once on CI (6 Nov 2026) and once under load here, and
  // passed every other time (note #1075). The line can only move on the page's
  // own five-second live poll, so if it times out again, say what the polls
  // did rather than only that 20 s ran out: how many there were after the
  // claim, whether they carried it, and whether the tab thought itself hidden.
  const livePolls: { at: number; claimed: boolean }[] = [];
  const claimedAt = Date.now();
  const onLive = async (response: import('puppeteer-core').HTTPResponse) => {
    if (!response.url().includes('/workspace/api/agents/live')) return;
    const body = await response.text().catch(() => '');
    livePolls.push({ at: Date.now() - claimedAt, claimed: body.includes(plumber.id) });
  };
  page$.on('response', onLive);
  await page$.waitForFunction(() => (
    document.getElementById('noteSub')?.textContent?.includes('Working by Kai')
  ), { timeout: 20_000 }).catch(async (error) => {
    const seen = await page$.evaluate(() => ({ line: document.getElementById('noteSub')?.textContent ?? '', hidden: document.hidden }));
    throw new Error(`${String(error)} — the line read "${seen.line}", hidden=${seen.hidden}, live polls since the claim: ${JSON.stringify(livePolls)}`);
  });
  page$.off('response', onLive);
  check('the line follows a claim taken after the note was already open',
    (await text('#noteSub')).includes('Working by Kai'), await text('#noteSub'));
  // The picture is REAL bytes off the avatar route, not a frame around a
  // broken source: a face nobody can recognise is not a door anybody takes.
  await decoded('#noteSub .workface img');
  const workFace = await page$.$eval('#noteSub .workface img', (node) => {
    const image = node as HTMLImageElement;
    const box = image.getBoundingClientRect();
    return { drawn: image.naturalWidth > 0, width: Math.round(box.width), height: Math.round(box.height) };
  }).catch(() => null);
  check('…wearing that agent’s own face, drawn at the size of a second fact',
    Boolean(workFace?.drawn) && workFace?.width === 20 && workFace?.height === 20,
    JSON.stringify(workFace));
  // It stands ON the work words rather than beside the author's portrait at
  // the head of the line: the two faces on this line are two different agents,
  // and only their positions say which is which.
  const facePlaces = await page$.evaluate(() => {
    const line = document.getElementById('noteSub')!;
    const work = line.querySelector('.workface') as HTMLElement | null;
    const lead = line.querySelector(':scope > .facebtn, :scope > .face') as HTMLElement | null;
    if (!work || !lead) return null;
    const after = work.nextSibling?.textContent ?? '';
    const box = work.getBoundingClientRect();
    // What a thumb actually lands on, an inch above the picture's own edge:
    // the target is grown by a pseudo-element, so only a hit test can see it.
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top - 6);
    return {
      after,
      indented: Math.round(box.left - lead.getBoundingClientRect().left),
      aimable: hit === work || work.contains(hit),
    };
  });
  check('…on the work words themselves, not at the head of the line',
    facePlaces?.after.startsWith('Working by Kai') && (facePlaces?.indented ?? 0) > 0,
    JSON.stringify(facePlaces));
  check('…and aimable with a thumb, past the edge of the picture itself',
    facePlaces?.aimable === true, JSON.stringify(facePlaces));
  check('a note an agent already holds is not offered to another one',
    Boolean(await page$.$('#noteHandsCard[hidden]')));
  await shot('working');
  await tap(page$, '#noteSub .workface');
  await page$.waitForSelector('#screenAgent', { timeout: 10_000 });
  check('the face is a door: it opens the agent doing the work',
    (await text('#pageId')).includes('Kai'), await text('#pageId'));
  await tap(page$, '#pageBack');
  await page$.waitForSelector('#screenNote #noteBody', { timeout: 10_000 });
  await quickNoteStorage.update(plumber.id, { claim: undefined } as never);

  // 8c. NOTE #637: a note a TEAMMATE wrote. Every member reads every note in
  //     the workplace, and until then every member could also file one or move
  //     it to another room — the author would find it off their desk with nothing
  //     but a timestamp to say why. The screen now draws no action card at
  //     all on one, and the row in the list has no swipe under the finger.
  const hers = await quickNoteStorage.create({
    userId: me.userId,
    html: '<p>Dana’s own jotting</p>',
    createdByAgentId: 'user', createdByUserId: 'dana',
    updatedByAgentId: 'user', updatedByUserId: 'dana',
  } as never);
  await page$.goto(`${ORIGIN}/notes`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenNotes #notesList .crow', { timeout: 10_000 });
  const rows = await page$.evaluate(() => [...document.querySelectorAll('#notesList .crow')].map((node) => ({
    title: node.querySelector('.name')?.textContent?.trim() ?? '',
    swipe: node.classList.contains('noteswiperow'),
    gesture: node.getAttribute('aria-description') ?? '',
  })));
  const theirRow = rows.find((row) => row.title === 'Dana’s own jotting');
  check('a teammate’s row offers no swipe, while the reader’s own still do',
    theirRow?.swipe === false && theirRow?.gesture === ''
    && rows.filter((row) => row.title !== 'Dana’s own jotting').every((row) => row.swipe),
    JSON.stringify(theirRow));
  await page$.goto(`${ORIGIN}/notes/${hers.number}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenNote #noteActionsCard', { timeout: 10_000 });
  const onTheirs = await page$.evaluate(() => ({
    actions: document.querySelectorAll('#noteActions button').length,
    hint: document.getElementById('noteHint')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    // The margin is what the reader HAS here, so it must not have gone with
    // the buttons — and it is the thing the hint points at.
    margin: Boolean(document.querySelector('#noteCommentsCard .addrow')),
    // Note #647: that sentence's own card. Its divider belongs BETWEEN the
    // buttons and the sentence, and there are no buttons here — only a
    // browser can say whether a rule is actually painted across the top.
    rule: getComputedStyle(document.getElementById('noteHint')!).borderTopWidth,
  }));
  check('a teammate’s note offers nothing to do with it, and says whose it is',
    onTheirs.actions === 0
    && onTheirs.hint.startsWith('Another workplace member wrote this note')
    && onTheirs.hint.includes('comments above')
    && onTheirs.margin,
    JSON.stringify(onTheirs));
  check('and the sentence stands alone in its card, with no rule drawn over nothing',
    onTheirs.rule === '0px', onTheirs.rule);
  await shot('someone-elses');

  // 8d. NOTE #638: the reader's OWN note, kept by an agent they have since
  //     deleted — nearly half the agent-written notes on an account this old.
  //     There is no name left to print, and the card used to answer that with
  //     one sentence about "its owner's agents", which is how a note of your
  //     own comes to read as another account's. The verbs are untouched: it is
  //     their note, so Archive stands where it always did.
  const orphaned = await quickNoteStorage.create({
    userId: me.userId,
    html: '<p>Written by an agent that is no longer here</p>',
    createdByAgentId: 'ghost', updatedByAgentId: 'ghost', updatedByUserId: me.userId,
  } as never);
  await page$.goto(`${ORIGIN}/notes/${orphaned.number}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenNote #noteActionsCard', { timeout: 10_000 });
  const onOrphan = await page$.evaluate(() => ({
    buttons: [...document.querySelectorAll('#noteActions button')].map((node) => node.textContent?.trim() ?? ''),
    hint: document.getElementById('noteHint')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    // Here the sentence DOES follow a row of buttons, which is what the rule
    // is for: dropping it everywhere would have joined the two into one block.
    rule: getComputedStyle(document.getElementById('noteHint')!).borderTopWidth,
  }));
  check('a note whose agent is gone says so, and stays the reader’s own',
    onOrphan.hint.startsWith('The agent that wrote this note is no longer in this workplace')
    && onOrphan.hint.includes('any of your agents can change what it says')
    && !onOrphan.hint.includes('owner’s agents')
    && onOrphan.buttons.includes('Archive note'),
    JSON.stringify(onOrphan));
  check('the rule still divides that sentence from the buttons above it',
    onOrphan.rule === '1px', onOrphan.rule);
  await shot('agent-gone');

  // 9. A RELEASE GOING OUT UNDER THE READER (notes #308 and #306) — the two
  //    halves of a screen that could not tell "no answer yet" from "no answer
  //    ever", driven through the real fetch stack rather than a fake one.
  releasing = true;
  await page$.goto(`${ORIGIN}/notes/${plumber.number}`, { waitUntil: 'domcontentloaded' });
  await page$.waitForSelector('#screenNote #noteWait', { timeout: 10_000 });
  const held = {
    lines: await page$.$$eval('#noteWait .skel', (nodes) => nodes.length),
    // The word is GONE from the page and kept for the screen reader, which is
    // the only reader a held grey line says nothing to.
    said: await text('#screenNote .sr-only'),
    printed: Boolean(await page$.$('#noteBody .empty')),
    busy: await page$.$eval('#screenNote', (node) => node.getAttribute('aria-busy')),
  };
  check('a note still arriving waits in its own shape, not on the word Loading',
    held.lines === 3 && held.said === 'Loading…' && !held.printed && held.busy === 'true',
    JSON.stringify(held));
  await shot('waiting');

  // Past one whole attempt the answer is plainly not on its way, and the
  // screen stops implying that it is. This is the state the screenshot on note
  // #308 was taken in — and it now says something.
  await page$.waitForSelector('#screenNote #noteSlow', { timeout: 20_000 });
  check('…and says so once an attempt has plainly timed out',
    (await text('#noteSlow')) === 'The server is not answering. Trying again…', await text('#noteSlow'));
  await shot('not-answering');

  // The release lands. Nobody taps anything: the read that was already going
  // to be retried finds a backend that answers, and the note arrives on its
  // own — which is the whole of what note #308 asked for.
  releasing = false;
  await page$.waitForSelector('#screenNote #noteBody .kpage', { timeout: 20_000 });
  check('…and the note arrives by itself once the backend is back, with no tap',
    (await text('#noteTitle')) === 'Call the plumber back'
    && !(await page$.$('#noteSlow')), await text('#noteTitle'));

  // Note #306: off to an agent and back, with a backend that will never answer
  // again — so anything on the screen is what the held copy put there, and a
  // screen that had lost the note would sit on the wait instead.
  await tap(page$, '#noteHands .hand .handface');
  await page$.waitForSelector('#screenAgent', { timeout: 10_000 });
  releasing = true;
  await tap(page$, '#pageBack');
  await page$.waitForSelector('#screenNote', { timeout: 10_000 });
  const backOn = {
    title: await text('#noteTitle'),
    body: await text('#noteBody'),
    waiting: Boolean(await page$.$('#noteWait')) || Boolean(await page$.$('#screenNote[aria-busy="true"]')),
  };
  check('Back onto a note already read draws the note, never the wait',
    backOn.title === 'Call the plumber back' && backOn.body.includes('closed on Mondays') && !backOn.waiting,
    JSON.stringify(backOn));
  releasing = false;

  // 10. THE SAME NOTE in the classic Workspace: the port is only finished if
  //    both shells say the same things about the same note, in the same places.
  await page$.goto(`${ORIGIN}/notes/${plumber.number}`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenNote #noteBody .kpage', { timeout: 10_000 });
  await page$.waitForSelector('#noteFiles .notephoto img', { timeout: 15_000 });
  // Shot HERE and not at step 4, so the pair below is the same note in the
  // same state: a side-by-side where one side has a file the other has not is
  // a picture of the harness's ordering, not of the two shells.
  await shot('note-react');
  const reactSays = {
    title: await text('#noteTitle'),
    sub: await text('#noteSub'),
    body: await text('#noteBody'),
    remark: await text('#noteComments .ncmt .ctext'),
    signature: await text('#noteComments .commentby'),
    actions: (await texts('#noteActions button')).join(' | '),
    hands: await text('#noteHands .hand .hname'),
    hint: await text('#noteHandsHint'),
    boxes: await page$.evaluate(() => PARITY_BOXES
      .map((selector) => `${selector}=${Math.round(document.querySelector(selector)!.getBoundingClientRect().top)}`)
      .join(' ')),
  };
  check('the note screen says what it should', Object.values(reactSays).every(Boolean), JSON.stringify(reactSays));

  // A signed-out session read is a 401 by design and Chrome asks for a favicon
  // nobody serves; and step 8 abandons note reads ON PURPOSE, so the aborts it
  // provokes are the harness working. Anything else is a real complaint.
  const unexpected = consoleErrors.filter((line) => (
    !/status of (400|401|404)|\b401 .*auth\/session|favicon\.ico/.test(line)
    && !/ERR_ABORTED.*\/workspace\/api\/notes\//.test(line)
    // This fixture wires the notes half of the backend and nothing else, so
    // the agent screen step 8 walks through to get BACK from reads its own
    // three endpoints and is correctly told they are not available here.
    && !/503|\/workspace\/api\/agents\/kai\//.test(line)
  ));
  check('no unexpected console errors', unexpected.length === 0, unexpected.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
