// Note #778: a bucket opens its own page, and Delete lives there — driven in
// real Chrome against the real Workspace routes, with the object store faked
// at its one seam (`ObjectStorageService`'s Fly, secrets and S3 hands).
//
// The owner's report (2026-10-19): the Workplace sheet listed a bucket with a
// red "Delete this bucket" right on the row, and no page for the bucket at
// all. So: the list shows no delete; a row is a door; the page says what a
// bucket is to someone who did not make it (public or private and what that
// means, where a public one is read from, who made it and when, what it
// holds, which secrets hold its keys); and the delete stands at its foot,
// behind the same type-the-name question as before.
//
// Screenshots land in OUT_DIR (~/n778-proof by default).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-bucket-page.mts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { ObjectStorageService } from '../backend/src/services/object-storage.js';
import { InMemoryStorageBucketStorage } from '../backend/src/services/storage-bucket-storage.js';
import { bucketSecretNames } from '../backend/src/types/storage-bucket.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import {
  harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace,
} from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n778-proof');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4199);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const userStorage = new InMemoryUserStorage();
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(),
  mailbox.config,
  mailbox.mailboxes,
);
const orgStorage = new InMemoryOrgStorage();
harnessEstablishedWorkplace(orgStorage);

// The object store: records in memory, the four secrets in a map, and the
// bucket's own listing answered from a number — what the page reads.
const bucketStorage = new InMemoryStorageBucketStorage();
const secrets = new Map<string, string>();
const destroyed: string[] = [];
const objectStorage = new ObjectStorageService({
  storage: bucketStorage,
  resolveHostingContext: async () => ({ source: 'platform', orgSlug: 'harness', apiToken: 'tok' }),
  makeFlyClient: () => ({
    resolveOrganizationId: async () => 'org',
    createTigrisBucket: async () => { throw new Error('not in this harness'); },
    deleteAddOn: async (name: string) => { destroyed.push(name); },
  }) as never,
  secrets: {
    save: async (ns, name, value) => { secrets.set(`${ns}/${name}`, value); },
    remove: async (ns, name) => { secrets.delete(`${ns}/${name}`); },
    read: async (ns, name) => secrets.get(`${ns}/${name}`) ?? null,
  },
  makeObjects: (args) => ({
    usage: async () => (args.bucket === 'iabkt-547027dcc674'
      ? { bytes: 327_680_000, objects: 1204, truncated: false }
      : { bytes: 0, objects: 0, truncated: false }),
    empty: async () => undefined,
    setCors: async () => undefined,
  }),
  caps: { hostedBucketLimit: 3, hostedBucketGb: 10 },
  log: () => undefined,
});

const agentLifecycle = {
  agentChatMessages: async () => [],
  isAgentWorking: () => false,
  agentActivity: () => null,
  listManagedJobs: async () => ({ jobs: [], recent: [] }),
} as unknown as RouteDeps['agentLifecycle'];

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  orgStorage,
  objectStorage,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  agentLifecycle,
} as RouteDeps;

const app = express();
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    const expected = (response.status() === 401 && url.pathname === '/workspace/auth/session')
      || (response.status() === 404 && url.pathname === '/favicon.ico');
    if (response.status() >= 400 && !expected) consoleErrors.push(`${response.status()} ${response.url()}`);
  });
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png` });
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  /** What a reader sees, each element's words apart. */
  const text = (selector: string) => page.$eval(selector, (node) => ((node as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim()).catch(() => '');

  // 1. Adam's Demonstrations workplace, as the report showed it: Caleb's
  //    public bucket, and a private one of Ada's beside it, their keys the
  //    workplace's (notes #783, #843).
  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Demonstrations' });
  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  const seed = (id: string, name: string) => [id, {
    id, name, cli: 'claude', createdAt: iso(60 * 24 * 4), serverId: `m-${id}`,
    connectedAt: iso(60 * 24 * 4), model: 'opus', effort: 'high', lastActivityAt: iso(30),
  }] as const;
  await userStorage.updateProfile(me.userId, {
    telegram: { ...(me.telegram ?? {}), agents: Object.fromEntries([
      seed('caleb', 'Caleb'), seed('ada', 'Ada'),
    ]) as never },
  });
  const make = async (args: { name: string; bucket: string; public: boolean; agentId: string; agentName: string; minutesAgo: number }) => {
    const secretNames = bucketSecretNames(args.name);
    for (const name of Object.values(secretNames)) secrets.set(`${org.orgId}/${name}`, `value-of-${name}`);
    const doc = await bucketStorage.create({
      orgId: org.orgId, userId: me.userId, secretsNamespaceId: org.orgId,
      createdBy: { agentId: args.agentId, agentName: args.agentName },
      name: args.name, addOnName: `addon-${args.name}`, bucket: args.bucket, endpoint: 'https://fly.storage.tigris.dev',
      region: 'auto', public: args.public, secretNames, hostedOn: 'platform', flyOrgSlug: 'harness', status: 'live',
    });
    await bucketStorage.update(doc.id, { createdAt: iso(args.minutesAgo) });
  };
  await make({ name: 'bishkek-3d-tiles', bucket: 'iabkt-547027dcc674', public: true, agentId: 'caleb', agentName: 'Caleb', minutesAgo: 60 * 50 });
  await make({ name: 'demo-files', bucket: 'iabkt-b35c5156de34', public: false, agentId: 'ada', agentName: 'Ada', minutesAgo: 60 * 26 });

  // 2. The Workplace sheet: two rows, each a door, and no delete on either.
  const openList = async () => {
    await page.goto(`${ORIGIN}/overview?org=${org.orgId}&half=workplace`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#homeSheet #storageCard [data-bucket="bishkek-3d-tiles"]', { timeout: 10_000 });
    await page.waitForFunction(() => document.getElementById('homeSheet')!.getAnimations().length === 0, { timeout: 10_000 });
    await page.$eval('#storageCard', (node) => node.scrollIntoView({ block: 'center' }));
    await pause(300);
  };
  await openList();
  const rows = await page.$$eval('#storageCard [data-bucket]', (nodes) => nodes.map((node) => ({
    name: node.getAttribute('data-bucket'), role: node.getAttribute('role') ?? node.tagName, words: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
  })));
  check('the Workplace sheet lists both buckets, newest first', rows.map((row) => row.name).join('|') === 'demo-files|bishkek-3d-tiles', JSON.stringify(rows));
  check('…and no delete stands on the list (the owner, 2026-10-19)',
    !(await text('#homeSheet')).includes('Delete this bucket') && !(await page.$('#storageCard .btn.danger')), await text('#storageCard'));
  check('…each row is a door', rows.every((row) => row.role === 'button' || row.role === 'A'), JSON.stringify(rows.map((row) => row.role)));
  await shot('bucket-list-phone');

  // 3. A row opens the bucket's own page.
  await page.click('#storageCard [data-bucket="bishkek-3d-tiles"]');
  await page.waitForSelector('#screenBucket', { timeout: 10_000 });
  await page.waitForFunction(() => !/Counting/.test(document.getElementById('bucketHolds')?.textContent ?? 'Counting'), { timeout: 10_000 });
  check('a row opens that bucket’s page at its own address',
    new URL(page.url()).pathname === '/storage/bishkek-3d-tiles', page.url());
  check('the page is titled with its name', (await text('#bucketTitle')) === 'bishkek-3d-tiles', await text('#bucketTitle'));
  check('…says it is public and what that means', /^Public: anyone with a file’s address can read it/.test(await text('#bucketSub')), await text('#bucketSub'));
  check('…where its files are read from', (await text('#bucketAddress .name')) === 'iabkt-547027dcc674.fly.storage.tigris.dev/…', await text('#bucketAddress'));
  check('…who made it and when', (await text('#bucketMaker')) === 'Caleb Created it · 2d ago', await text('#bucketMaker'));
  check('…what it holds, read with its keys', (await text('#bucketHolds')) === '1,204 files · 312.5 MB What it holds', await text('#bucketHolds'));
  const keys = await page.$$eval('#bucketKeys code', (nodes) => nodes.map((node) => node.textContent));
  // It said which room they were saved from, "(saved from Bishkek 3D)",
  // until rooms left the product (note #843): the page names none.
  check('…the four secrets that hold its keys, by name, and no room (the keys are the workplace\'s, note #783)',
    keys.join('|') === 'BISHKEK_3D_TILES_S3_ENDPOINT|BISHKEK_3D_TILES_S3_BUCKET|BISHKEK_3D_TILES_S3_ACCESS_KEY_ID|BISHKEK_3D_TILES_S3_SECRET_ACCESS_KEY'
      && (await text('#bucketKeys .name')) === 'Its keys: 4 secrets', JSON.stringify([keys, await text('#bucketKeys')]));
  check('…each key name whole on the card, none running off its edge',
    await page.$$eval('#bucketKeys code', (nodes) => nodes.every((node) => node.getBoundingClientRect().right <= document.getElementById('bucketCard')!.getBoundingClientRect().right)));
  check('…and never a value', !(await page.content()).includes('value-of-'));
  const card = await page.$eval('#bucketCard', (node) => node.getBoundingClientRect().bottom);
  const button = await page.$eval('#bucketDelete', (node) => node.getBoundingClientRect().top);
  check('Delete is at the foot of the page, under the card and apart from it', button >= card + 12, JSON.stringify({ card, button }));
  // The sheet it was opened from has finished leaving.
  await page.waitForFunction(() => !document.getElementById('homeSheet'), { timeout: 5_000 }).catch(() => null);
  await pause(300);
  await shot('bucket-page-phone');
  await page.click('#bucketAddress');
  await page.waitForFunction(() => /Address copied/.test(document.body.innerText), { timeout: 5_000 }).catch(() => null);
  check('…which a tap copies', (await page.evaluate(() => document.body.innerText)).includes('Address copied'));

  // 4. The private one says so, and has no address.
  await page.goto(`${ORIGIN}/storage/demo-files?org=${org.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenBucket #bucketHolds', { timeout: 10_000 });
  await page.waitForFunction(() => !/Counting/.test(document.getElementById('bucketHolds')?.textContent ?? 'Counting'), { timeout: 10_000 });
  check('a private bucket says what private means, with no address', /^Private: only agents and apps holding its keys/.test(await text('#bucketSub')) && !(await page.$('#bucketAddress')), await text('#bucketSub'));
  check('…and an empty one says Empty', (await text('#bucketHolds')).startsWith('Empty'), await text('#bucketHolds'));

  // 5. At a desk: the list and the page.
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await openList();
  await shot('bucket-list-desk');
  await page.click('#storageCard [data-bucket="bishkek-3d-tiles"]');
  await page.waitForSelector('#screenBucket', { timeout: 10_000 });
  await page.waitForFunction(() => !/Counting/.test(document.getElementById('bucketHolds')?.textContent ?? 'Counting'), { timeout: 10_000 });
  await pause(300);
  await shot('bucket-page-desk');

  // 6. Deleting asks the same question as before: type the name.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.click('#bucketDelete');
  await page.waitForSelector('input[aria-label="Type bishkek-3d-tiles to confirm"]', { timeout: 5_000 });
  // The keys were "removed from the room" until rooms left the product
  // (note #843); they are the workplace's.
  check('Delete asks to type the bucket’s name, as before',
    (await page.$eval('body', (node) => node.textContent ?? '')).includes('Every file in it is deleted, and the four secrets holding its keys are removed from the workplace.'));
  await shot('bucket-delete-ask-phone');
  await page.type('input[aria-label="Type bishkek-3d-tiles to confirm"]', 'bishkek-3d-tiles');
  await page.$$eval('.btns .btn.danger', (nodes) => (nodes.at(-1) as HTMLElement | undefined)?.click());
  await page.waitForFunction(() => !document.getElementById('screenBucket'), { timeout: 10_000 }).catch(() => null);
  await page.waitForFunction(() => !document.querySelector('[data-bucket="bishkek-3d-tiles"]') && Boolean(document.querySelector('[data-bucket="demo-files"]')), { timeout: 10_000 }).catch(() => null);
  check('…and once answered the bucket is gone and the reader is back on the Workplace sheet',
    destroyed.includes('addon-bishkek-3d-tiles') && Boolean(await page.$('#homeSheet [data-bucket="demo-files"]'))
      && !(await page.$('[data-bucket="bishkek-3d-tiles"]')),
    JSON.stringify({ destroyed, url: page.url() }));
  await shot('bucket-deleted-phone');

  check('nothing went wrong in the console', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(`\nscreenshots in ${OUT}`);
if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nall passed');
