// The SUBSCRIPTION (seat) screen's way out, in real Chrome against a real
// backend router with in-memory stores (note #400: "when I opened a
// subscription details page, in the header back button and home button, they
// stopped working"). Home has since left the header (note #426); JSDOM cannot
// prove browser history, so this drives the
// real shell and asks, of every way a reader reaches that page:
//
//   A-D  the list, a pasted address, and the absence of a redundant Home
//   E-G  nothing is left claimed behind it, and the next screen still works
//   H    the door on Home, which is the one a reader actually uses
//   I    every state the page has: paused, needing a sign-in, resting, ready
//   J    the sticky header, from the foot of the page, on a phone
//   K    a transient leaf (the note composer) that claims Back while keeping
//        Save in its form, left by Back and by saving
//   L-M  a tap that lands twice
//   N-O  a read that never answers, its own and the whole Workspace's
//   P    a MUTATION on the page — the one that was broken: acting on a
//        subscription replaced its address with the list that was already the
//        entry underneath, so Back spent the duplicate and repainted the same
//        screen, and the way out cost two taps
//   Q    the page and the list opened COLD, before their own read lands
//        (note #625): the name, not "Seat"; the facts the state read already
//        holds, and its reading drawn whole (note #697); bars only for what
//        it does not; nothing moving when it lands
//   R    the page opened WARM after Home moved on (note #697): it draws the
//        reading on the plate just tapped, never the one it held from an
//        earlier visit
//
// Since 2026-10-10 Home (`/`) is the Chief of Staff's conversation, and the
// fallback Back of a pasted address lands there. What the overview's two tabs
// held now opens over it: the Workplace window and the agents picker (note
// #715). The picker had the rooms as its tabs, and the note composer was a
// page of a room's Notes shelf, until rooms left the product (note #843):
// the composer opens from the Workplace window's Notes card now.
//
// Every check reads what is under the control's own centre, not merely that
// it exists: a tap that never reaches the button and a handler that runs and
// moves nothing look identical from outside.
//
//   mkdir -p ~/mini-preview
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-react-seat.mts
//
// WORKSPACE_UI_DIR re-points it at another bundle — production's, fetched to
// disk — so the same journeys can be driven against what is actually live.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
import { InMemorySecretStorage } from '../backend/src/services/secret-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, signUpWorkspaceByEmail } from './workspace-harness-auth.mjs';
import { closeHomeWindow } from './workspace-harness-home.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
// express lives in backend/node_modules; puppeteer-core in the root's.
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
/** Whichever Chrome puppeteer last installed here; the build number moves. */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4175);
const ORIGIN = `http://127.0.0.1:${PORT}`;

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
const orgStorage = new InMemoryOrgStorage();
// The workplace this harness founds is one already past its setup gate — its
// cloud is connected and one subscription is signed in — so the Workspace
// opens instead of holding on "Connect your Fly cloud".
//
// That subscription is the fixture's own, and it is a SECOND one beside the
// subject below, which is the whole reason it has to exist. The lock is
// derived from live seats on every state read, and section I deliberately
// walks its subject through past_due, dead and cooldown — with only one
// subscription in the workplace, the first of those locks the entire
// Workspace and the seats screen this harness came to read is not reachable
// at all. (That is the product's own rule, not a fixture problem: a reader
// whose only subscription has stopped is sent to sign one in. It does mean
// the states below are unreachable in a one-subscription workplace, which is
// worth knowing and is not this harness's to decide.)
harnessEstablishedWorkplace(orgStorage, {
  seat: { provider: 'claude', token: 'gate-seat-token', label: 'Claude · the live one' },
});
const quickNoteStorage = new InMemoryQuickNoteStorage();
const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  orgStorage,
  secretStorage: new InMemorySecretStorage(),
  quickNoteStorage,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: process.env.WORKSPACE_UI_DIR || path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  agentLifecycle: { isAgentWorking: (_userId: string, agentId: string) => workingNow.has(agentId) },
  orgSpend: {
    report: async () => {
      // Held mutable so one section can make this read SLOW and LONG without
      // disturbing the fixture every other check above reads (note #314's
      // wait, and the line the screen opens on, need a read still in flight
      // and a list tall enough to scroll).
      spendReads += 1;
      if (spendDelayMs) await new Promise((resolve) => { setTimeout(resolve, spendDelayMs); });
      // A cloud that has been REPLACED (note #372) is a different account, so
      // it holds none of the machines this platform put in the last one —
      // which is the whole reason the screen throws its held list away rather
      // than refreshing underneath it.
      const machines = cloudSlug === SEEDED_SLUG
        ? spendMachines().filter((row) => !removedApps.has(row.app))
        : [];
      // The same rows, at the shape the totals below are counted from.
      const rows: Array<{ state: string; totalMonthlyUsd?: number }> = machines;
      return {
        orgSlug: cloudSlug,
        // What the rows below add up to, counted FROM those rows — the
        // month's total, what it leaves out, and how many machines are up
        // (notes #342, #336) — so the line over the card cannot disagree
        // with the list under it whichever fixture is up. The server always
        // sends these (PR #671); without `spentThisMonthUsd` here the
        // summary line dies on `undefined.toFixed`, which the harness
        // reports as a page error rather than a failed check — a whole
        // screen missing behind a green run.
        totals: {
          estimatedMonthlyUsd: 126.84,
          runningMonthlyUsd: 126.84,
          spentThisMonthUsd: Math.round(rows.reduce((sum, row) => sum + (row.totalMonthlyUsd ?? 0), 0) * 100) / 100,
          unmeasured: rows.filter((row) => row.totalMonthlyUsd === undefined).length,
          running: rows.filter((row) => row.state === 'started').length,
          stopped: rows.filter((row) => row.state === 'stopped').length,
        },
        machines,
        // The records behind those names were read, which is what lets the
        // screen offer to remove a machine nobody is on (note #375).
        namesRead: true,
        disclaimer: 'Estimates from Fly’s published prices — the Fly dashboard is the authority.',
      };
    },
    // The real one destroys the app in the workplace's own Fly account
    // after checking that no agent record names it; here it is the same
    // promise kept in memory, so the read AFTER a removal answers without
    // the row and the screen's own arithmetic can be checked against it.
    removeLeftoverMachine: async (_orgId: string, app: string) => {
      const gone = spendMachines().filter((row) => row.app === app);
      removedApps.add(app);
      return { app, machines: gone.length };
    },
  },
  /**
   * Connecting the workplace's own Fly account (note #372).
   *
   * The real service asks FLY whose token this is, which is the one fact that
   * cannot be known before the paste is sent; here the token says so itself —
   * anything carrying "else" belongs to `other-co`, everything else to the
   * account already connected. That is enough to drive both acts the screen
   * has to tell apart, and the refusal below is the real one: a token for
   * another org commits NOTHING until it comes back carrying `replace`.
   */
  orgFly: {
    connectOrgFly: async (args: { orgId: string; token: string; replace?: string }) => {
      const toSlug = args.token.includes('else') ? 'other-co' : cloudSlug;
      if (toSlug !== cloudSlug && !args.replace) {
        return {
          connected: false as const,
          move: {
            fromSlug: cloudSlug,
            toSlug,
            appCount: 4,
            // This workplace keeps its repositories, their backups and its
            // files in the account a move would leave — the common shape, and
            // the half of the warning nobody has on screen to count.
            leaves: { gitHost: true, gitBackup: true, media: true },
          },
        };
      }
      if (toSlug !== cloudSlug && args.replace !== toSlug) {
        throw new Error(`that token now points at Fly org "${toSlug}", not the "${args.replace}" you agreed to move to`);
      }
      const previousSlug = cloudSlug;
      cloudSlug = toSlug;
      return {
        connected: true as const, orgSlug: toSlug, appCount: 4, previousSlug, moved: toSlug !== previousSlug,
      };
    },
  },
  /** Which converge the route chose — the rotation must not flap a live one. */
  orgWireGuard: {
    ensureOrgWireGuard: async () => {
      tunnel.push('full');
      return { status: 'up' as const, interfaceName: 'iaorg-x', peerIp: 'fdaa::2' };
    },
    ensureUpIfMissing: async () => {
      tunnel.push('if-missing');
      return { status: 'up' as const, interfaceName: 'iaorg-x', peerIp: 'fdaa::2' };
    },
  },
} as RouteDeps;

/** The Fly org this workplace points at, and the one it starts on. */
const SEEDED_SLUG = 'nomad-trading';
let cloudSlug = SEEDED_SLUG;
const tunnel: string[] = [];

/** Apps the reader has removed (note #375) — the stub's whole memory of it. */
const removedApps = new Set<string>();

/** The two knobs the note #314 section turns; every check before it reads the
 *  three machines the spend screen is verified against — in the order
 *  `org-spend.ts` now answers in, biggest spender first (note #336), each row
 *  keyed on the figure it shows: $2.55, $2.09, $0.75. */
/** Long enough that a wait would be on the screen by now: `WAIT_QUIET_MS` in
 *  `ui/wait.ts` is 250, and this is that with room for the frame after it. */
const WAIT_QUIET_WINDOW_MS = 700;
let spendDelayMs = 0;
/** How many times the account has actually been walked — what note #368's
 *  section asks, since the whole point of a cache is the read that does not
 *  happen. Declared before `deps` reads it: `let` is hoisted into the module
 *  scope and the closure above only runs once a request arrives. */
let spendReads = 0;
const SEEDED_MACHINES = [{
  app: 'ia-agent00000001', machineId: 'abc1', kind: 'agent' as const, state: 'started',
  size: 'performance-4x 8GB', estimatedMonthlyUsd: 124.75, runningMonthlyUsd: 124.75,
  hourlyUsd: 0.1722, agent: { id: 'ada', name: 'Ada', driver: 'saddam' },
  activeMs: 10 * 3_600_000 + 27 * 60_000,
  totalMonthlyUsd: 2.55,
}, {
  app: 'iapp-site0000001', machineId: 'abc2', kind: 'site' as const, state: 'started',
  size: 'shared-1x 0.3GB', estimatedMonthlyUsd: 2.09, runningMonthlyUsd: 2.09,
  hourlyUsd: 0.0027,
}, {
  // Asleep, and nobody's agent: the row that proves the state mark says
  // something rather than being painted on every machine alike.
  app: 'ia-agent00000002', machineId: 'abc3', kind: 'agent' as const, state: 'stopped',
  size: 'performance-4x 8GB', estimatedMonthlyUsd: 0.75, runningMonthlyUsd: 124.75,
  hourlyUsd: 0.1722,
}];
/** Note #326: which seeded agents are mid-turn. The state read asks this
 *  per agent, exactly as the real lifecycle service is asked. */
const workingNow = new Set<string>();

/** A list long enough that the screen has somewhere else it could open. */
const MANY_MACHINES = Array.from({ length: 12 }, (_, n) => ({
  ...SEEDED_MACHINES[0]!, machineId: `many${n}`, agent: { id: `a${n}`, name: `Agent ${n}` },
}));
let spendMachines: () => typeof SEEDED_MACHINES = () => SEEDED_MACHINES;

const app = express();
app.use(express.json());
// A read that NEVER ANSWERS, switchable mid-run (knowledge page
// "workspace-read-that-never-answers"): `fetch()` has no timeout of its own,
// so a screen with no bound of its own cannot tell "coming" from "never".
const hang = new Set<string>();
// A read that answers LATE, which is a different thing to look at: long
// enough for the wait to be drawn and photographed, and then it lands, so
// what stood in for it can be measured against what replaced it (note #625).
const slow = new Map<string, number>();
app.get('/control', (req, res) => {
  const path = String(req.query.path ?? '');
  if (req.query.slow !== undefined) {
    const ms = Number(req.query.slow);
    if (ms > 0) slow.set(path, ms); else slow.delete(path);
  } else if (req.query.on === '1') hang.add(path); else hang.delete(path);
  res.json({ hanging: [...hang], slow: [...slow.keys()] });
});
app.use('/', (req, _res, next) => {
  for (const path of hang) if (req.path.includes(path)) return; // never answers
  for (const [path, ms] of slow) if (req.path.includes(path)) { setTimeout(next, ms); return; }
  next();
});
app.use('/workspace', workspaceRoutes(deps));
// The shell itself answers at the root of the domain (public-addresses).
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

/** The one header, measured (note #282). Every detail screen fills the same
 *  block — Back and an optional action, then the screen's own name below —
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
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`); });
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `n256-${name}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  };
  const heading = async () => page.$eval('#webMain h2, #webMain h1', (node) => node.textContent?.trim() ?? '').catch(() => '');
  const waitHeading = async (text: string) => {
    await page.waitForFunction(
      (want: string) => [...document.querySelectorAll('#webMain h2')].some((node) => node.textContent?.trim() === want),
      { timeout: 10_000 },
      text,
    ).catch(() => {});
    return (await page.$$eval('#webMain h2', (nodes) => nodes.map((node) => node.textContent?.trim())))
      .includes(text);
  };
  // Home opens two things over the conversation (note #715): the Workplace
  // window (the subscription plates and the notes live there) and the agents
  // picker. Opened in the page, by Home's own controls — never by loading an
  // address, because a reload empties the seats cache that section R is
  // about. One already standing (Back restores the level it was left at) is
  // used as it is. The picker was a room's tab, its shelves under it, until
  // rooms left the product (note #843).
  const halfShown = (half: 'workplace' | 'agents') => half === 'agents' ? '#agentSwitchSheet #agentSwitchGrid' : '#homeSheet #homeWorkplace';
  const openHalf = async (half: 'workplace' | 'agents') => {
    if (await page.$(halfShown(half))) return;
    await page.waitForSelector('#screenHome #homeWorkplaceDoor', { timeout: 10_000 });
    if (half === 'workplace') {
      await closeHomeWindow(page);
      await page.click('#homeWorkplaceDoor');
      await page.waitForSelector('#homeSheet #homeWorkplace', { timeout: 10_000 });
      return;
    }
    if (!(await page.$('#agentSwitchSheet'))) {
      await closeHomeWindow(page);
      await page.click('#agentChatSwitch');
    }
    await page.waitForSelector(halfShown('agents'), { timeout: 10_000 });
  };
  // Landing on Home opens the picker by default.
  const waitHome = async (half: 'workplace' | 'agents' = 'agents') => {
    await page.waitForSelector('#screenHome #homeWorkplaceDoor', { timeout: 10_000 }).catch(() => {});
    await openHalf(half).catch(() => {});
    return Boolean(await page.$('#screenHome')) && Boolean(await page.$(halfShown(half)));
  };
  // Home itself — the Chief of Staff's conversation — is where the fallback
  // Back of a pasted address lands.
  const waitChatHome = async () => {
    await page.waitForSelector('#screenHome', { timeout: 10_000 }).catch(() => {});
    return Boolean(await page.$('#screenHome'));
  };

  const shotHome = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `n256-home-${name}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  };
  const shotOrg = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `n256-org-${name}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  };
  const text = async (selector: string) => page.$eval(selector, (node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '').catch(() => '');
  const clickText = async (selector: string, want: RegExp) => {
    const handles = await page.$$(selector);
    for (const handle of handles) {
      const t = await handle.evaluate((node) => node.textContent ?? '');
      // A plate stands low in the window (note #960): pressed where it is.
      if (want.test(t)) { await handle.evaluate((node) => (node as HTMLElement).click()); return true; }
    }
    return false;
  };

  // 1. Create access; an account that can found a workplace keeps that
  // door in Home's navigation row after the identity header is removed.
  await page.goto(`${ORIGIN}/signup`, { waitUntil: 'networkidle0' });
  await signUpWorkspaceByEmail(page, 'saddam@example.com');
  // The workplace comes with the account, and since note #726 there is no
  // gate and nothing furnished in front of it: signing up lands on Home —
  // the Chief of Staff's conversation — with the platform's greeting and
  // the three starters under it, and NO room and NO agent made for the
  // founder. (This fixture stamps a seat at creation, so the sign-in card
  // would not stand here: the first run's ask is the chat's own test.)
  await page.waitForSelector('#screenHome', { timeout: 10_000 });
  await page.waitForSelector('#firstRunStarters .chatstarter', { timeout: 10_000 }).catch(() => {});
  check('a brand-new account skips naming and lands on Home at once (note #726)',
    Boolean(await page.$('#screenHome')) && !(await page.$('#nameWorkplaceForm')) && !(await page.$('#requiredSetup')) && !(await page.$('#teamArriving')));
  check('…on the Chief of Staff\u2019s greeting, with the three starters under it',
    (await page.$$('#firstRunStarters .chatstarter')).length === 3 && (await text('#recapChatTitle')) === 'Chief of Staff',
    await text('#recapChatLog'));
  // It also counted the rooms founding made, until rooms left the product
  // (note #843); an agent is what founding could still furnish.
  check('…and founding made no agent', (await Promise.all((await userStorage.getAllUsers()).map(async (person) =>
    Object.values(person.telegram?.agents ?? {}).filter((agent) => !agent.purpose).length))).every((count) => count === 0));
  check('…at Home', page.url().startsWith(`${ORIGIN}/?`) || page.url() === `${ORIGIN}/`, page.url());
  check('…wearing the account default', (await orgStorage.listOrgs())[0]!.name === 'saddam’s workplace');
  check('the identity header is gone', !(await page.$('#orgSection')));
  await shotOrg('founder');
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome #agentChatSwitch', { timeout: 10_000 });
  await closeHomeWindow(page);
  await page.click('#agentChatSwitch');
  await page.waitForSelector('#agentSwitchSheet #agentSwitchGrid', { timeout: 10_000 });
  // The picker had the rooms as its tabs, the room the workplace stood in
  // first, until rooms left the product (note #843).
  check('the picker lists no tabs', !(await page.$('#agentSwitchTabs')) && !(await page.$('#agentSwitchSheet [role="tab"]')),
    await text('#agentSwitchSheet'));
  check('…and is titled for the agents', await waitHome() && (await text('#agentSwitchTitle')) === 'Your agents', await text('#agentSwitchTitle'));
  check('Home has no reader or workplace identity header', !(await page.$('#orgSection')));
  check('the workplace switch stands in Home’s header', Boolean(await page.$('#screenHome .chathead #homeOrganizations')));

  // 3. Add a secret from Home, read it back, describe it. Secrets are the
  //    Workplace window's (note #783 — one set per workplace, like
  //    repositories): Add goes to the secrets screen with its form up, and a
  //    secret's address carries the workplace and no room.
  await waitHome('workplace');
  // A row of the window's index since note #960: it opens the secrets
  // screen, whose Add a secret puts the form up.
  await page.waitForSelector('#homeSheet #homeWorkplace #indexSecrets', { timeout: 10_000 });
  await page.$eval('#homeSheet #homeWorkplace #indexSecrets', (node) => (node as HTMLElement).click());
  await page.waitForSelector('#screenSecrets #secretsAddBtn', { timeout: 10_000 });
  await page.$eval('#screenSecrets #secretsAddBtn', (node) => (node as HTMLButtonElement).click());
  await page.waitForSelector('#secretName');
  await page.click('#secretName');
  await page.type('#secretName', 'GH_TOKEN');
  await page.type('#secretValue', 'ghp_example_value_1234');
  check('the value counts its characters', (await text('#valueCount')) === '22 characters', await text('#valueCount'));
  await page.click('#saveBtn');
  await page.waitForSelector('#screenSecrets #secretsList', { timeout: 10_000 });
  check('saving lands on the workplace\'s secrets list', new URL(page.url()).pathname === '/secrets' && !new URL(page.url()).searchParams.has('room'), page.url());
  await page.waitForFunction(() => [...document.querySelectorAll('#secretsList .crow .name')].some((n) => n.textContent === 'GH_TOKEN'), { timeout: 10_000 }).catch(() => {});
  check('the secret is listed by name', await clickText('#secretsList .crow', /GH_TOKEN/));
  await page.waitForSelector('#secretCard', { timeout: 10_000 });
  check('the secret screen has a masked preview, not the value', !(await page.$eval('#screenSecret', (node) => node.textContent ?? '')).includes('ghp_example_value_1234'));
  check('…and its address carries the workplace, not a room', /\/secrets\/GH_TOKEN\?org=/.test(page.url()) && !/[?&]room=/.test(page.url()), page.url());
  const heads: Record<string, string> = { secret: await headShape(page) };
  await shotOrg('secret');

  // 4. The workplace screen and the seats.
  const [me] = await userStorage.getAllUsers();
  const [orgDoc] = await orgStorage.listOrgs();
  if (!me || !orgDoc) throw new Error('no user or workplace after founding');
  // The SUBJECT: the subscription every section below opens, reads and
  // breaks. The fixture's own seat stands beside it, untouched, holding the
  // setup lock open while this one is dead (see `harnessEstablishedWorkplace`
  // at the top).
  const seeded = await orgStorage.addSeat({ orgId: orgDoc.orgId, userId: me.userId, provider: 'claude', token: 'seat-token', label: 'Claude · signed in today', status: 'active' } as never);
  // The list is drawn in assignment order and the fixture's seat joined
  // FIRST, so put the subject back at the top — every positional
  // `#seatsList .crow` below means "the one this harness is about", and the
  // live one is the fallback standing behind it.
  const behind = (await orgStorage.listSeatsByMember(orgDoc.orgId, me.userId))
    .filter((seat) => seat.seatId !== seeded.seatId)
    .map((seat) => seat.seatId);
  await orgStorage.orderSeats(orgDoc.orgId, me.userId, 'claude', [seeded.seatId, ...behind]);
  // A reading, so the seat's own screen has meters to draw: three days into
  // a seven-day week, with one weekly track comfortably under an even pace
  // and the other spending it early (note #279). The five-hour session
  // window is paced on the same rule (note #341) — 51% spent 80 minutes in,
  // which runs the session dry with well over an hour of it left.
  const weekResetsAt = Math.round(Date.now() / 1000) + 4 * 24 * 3600;
  await orgStorage.updateSeat(seeded.seatId, {
    usage: {
      capturedAt: new Date().toISOString(),
      planType: 'max_20x',
      windows: {
        five_hour: { id: 'five_hour', usedPercent: 51, windowDurationMins: 300, resetsAt: Math.round(Date.now() / 1000) + 220 * 60 },
        seven_day: { id: 'seven_day', usedPercent: 31, windowDurationMins: 10_080, resetsAt: weekResetsAt },
      },
    },
    modelWindows: { fable: { id: 'seven_day_fable', usedPercent: 66, windowDurationMins: 10_080, resetsAt: weekResetsAt } },
    usageRefreshedAt: new Date().toISOString(),
  });

  // ── The subscription details page's Back (notes #400 and #426) ───────────
  const seatUrl = `${ORIGIN}/seats/${seeded.seatId}?org=${orgDoc.orgId}`;

  // What is actually under a control's own centre: a click that never
  // reaches the button and a handler that runs and moves nothing look the
  // same from outside, and only this tells them apart.
  const whatIsOnTop = async (selector: string) => page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'MISSING';
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return 'ZERO-SIZE';
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (!hit) return 'NOTHING (off-viewport)';
    return el.contains(hit) || hit === el ? 'the button itself' : ('BLOCKED by ' + hit.tagName + '.' + hit.className + '#' + hit.id);
  })()`);

  const screenNow = async () => page.evaluate(`(() => {
    const s = document.querySelector('#webMain .screen, #webMain #screenHome');
    return s ? (s.id || 'unnamed') : 'none';
  })()`);

  // A. The ordinary journey: the seats list, then one subscription, then Back.
  await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#seatsList .crow') !== null, { timeout: 10_000 }).catch(() => {});
  await page.click('#seatsList .crow');
  await page.waitForSelector('#seatCard', { timeout: 10_000 });
  check('A · a subscription opens at its own address', /\/seats\/[^/?]+\?org=/.test(page.url()), page.url());
  check('A · the header stands on it with Back and no Home action',
    Boolean(await page.$('#pageHead #pageBack')) && !(await page.$('#pageHead #pageHome')));
  check('A · Back is reachable by a tap', (await whatIsOnTop('#pageBack')) === 'the button itself', String(await whatIsOnTop('#pageBack')));
  await shotOrg('n400-seat');

  const beforeBack = page.url();
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 900));
  check('A · Back leaves the subscription', page.url() !== beforeBack, `still ${page.url()}`);
  check('A · …and lands on the subscriptions list', page.url().includes('/seats?org='), `${page.url()} · screen ${await screenNow()}`);

  // B. The same ordinary journey never grows a redundant Home action.
  await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#seatsList .crow') !== null, { timeout: 10_000 }).catch(() => {});
  await page.click('#seatsList .crow');
  await page.waitForSelector('#seatCard', { timeout: 10_000 });
  check('B · a subscription reached from the list has no Home action', !(await page.$('#pageHome')));
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 900));
  check('B · Back still returns it to the list', page.url().includes('/seats?org='), `${page.url()} · screen ${await screenNow()}`);

  // C. A PASTED or reloaded subscription address — no entry of ours beneath
  //    it, so Back owes the reader an honest root.
  await page.goto(seatUrl, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#seatCard', { timeout: 10_000 });
  check('C · a pasted subscription address opens the seat', Boolean(await page.$('#seatCard')));
  check('C · Back is reachable by a tap', (await whatIsOnTop('#pageBack')) === 'the button itself', String(await whatIsOnTop('#pageBack')));
  const beforePasted = page.url();
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 900));
  check('C · Back from a pasted subscription goes Home', await waitChatHome(), `${beforePasted} → ${page.url()} · screen ${await screenNow()}`);

  // D. The pasted form has the same single way out.
  await page.goto(seatUrl, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#seatCard', { timeout: 10_000 });
  check('D · a pasted subscription has no Home action', !(await page.$('#pageHome')));
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 900));
  check('D · Back from it is Home', await waitChatHome(), `${page.url()} · screen ${await screenNow()}`);

  // E. Does OPENING a subscription leave the header broken behind it? A leaf
  //    that claims Back and never lets go is invisible on the screen it was
  //    opened from — but `back.claimed` is exactly what makes the persistent
  //    header stand on Home, which has its own. So a header on Home is the
  //    tell that something is still holding the way out.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await waitChatHome();
  check('E · Home carries no page header before any of this', !(await page.$('#pageHead')));

  await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#seatsList .crow') !== null, { timeout: 10_000 }).catch(() => {});
  await page.click('#seatsList .crow');
  await page.waitForSelector('#seatCard', { timeout: 10_000 });
  await page.click('#pageBack');
  await page.waitForSelector('#screenSeats', { timeout: 10_000 });
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 900));
  check('E · …and none after a subscription has been opened and left', await waitChatHome() && !(await page.$('#pageHead')),
    `header on Home: ${Boolean(await page.$('#pageHead'))}`);

  // F. The header still works on the NEXT screen after a subscription.
  await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#seatsList .crow') !== null, { timeout: 10_000 }).catch(() => {});
  await page.click('#seatsList .crow');
  await page.waitForSelector('#seatCard', { timeout: 10_000 });
  await page.click('#pageBack');
  await page.waitForSelector('#screenSeats', { timeout: 10_000 });
  await page.click('#pageBack');
  await waitChatHome();
  await page.goto(`${ORIGIN}/workplace?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#pageBack', { timeout: 10_000 });
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 900));
  check('F · Back still works on the screen after a subscription', await waitChatHome(), `${page.url()} · screen ${await screenNow()}`);

  // G. Twice in a row: open, Back, open, Back.
  for (const round of [1, 2]) {
    await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#seatsList .crow') !== null, { timeout: 10_000 }).catch(() => {});
    await page.click('#seatsList .crow');
    await page.waitForSelector('#seatCard', { timeout: 10_000 });
    await page.click('#pageBack');
    await new Promise((r) => setTimeout(r, 800));
    check(`G · round ${round}: Back returns to the list`, page.url().includes('/seats?org='), `${page.url()} · screen ${await screenNow()}`);
  }

  // H. Entry from HOME's own subscription card — the door a reader actually
  //    uses — and every state the page can be in. A recovery card, a resting
  //    seat and a second subscription each change what the screen renders
  //    UNDER the header, and the header is one component shared with them.
  const openFromHome = async () => {
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
    await waitHome('workplace');
    await page.waitForFunction(() => document.querySelector('#seatsHome .seatcard') !== null, { timeout: 10_000 }).catch(() => {});
    if (!(await page.$('#seatsHome .seatcard'))) return false;
    await page.$eval('#seatsHome .seatcard', (node) => (node as HTMLElement).click());
    await page.waitForSelector('#seatCard', { timeout: 10_000 }).catch(() => {});
    return Boolean(await page.$('#seatCard'));
  };

  check('H · Home carries a subscription card', await openFromHome(), page.url());
  check('H · …which opens the subscription at its own address', /\/seats\/[^/?]+\?org=/.test(page.url()), page.url());
  check('H · Back is reachable by a tap', (await whatIsOnTop('#pageBack')) === 'the button itself', String(await whatIsOnTop('#pageBack')));
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 900));
  check('H · Back from a subscription opened on Home is Home', await waitHome('workplace'), `${page.url()} · screen ${await screenNow()}`);

  await openFromHome();
  check('H · the subscription opened on Home has no Home action', !(await page.$('#pageHome')));
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 900));
  check('H · its one Back returns Home', await waitHome('workplace'), `${page.url()} · screen ${await screenNow()}`);

  // I. Every state the subscription page can be in.
  const states: Array<{ name: string; patch: Record<string, unknown> }> = [
    { name: 'paused by the provider', patch: { status: 'payment_required', subscriptionStatus: 'past_due', subscriptionCheckedAt: new Date().toISOString() } },
    { name: 'needing a fresh sign-in', patch: { status: 'dead' } },
    { name: 'resting on its limit', patch: { status: 'cooldown', cooldownUntil: new Date(Date.now() + 90 * 60_000).toISOString() } },
    { name: 'ready again', patch: { status: 'active', subscriptionStatus: undefined, cooldownUntil: undefined } },
  ];
  for (const { name, patch } of states) {
    await orgStorage.updateSeat(seeded.seatId, patch as never);
    await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#seatsList .crow') !== null, { timeout: 10_000 }).catch(() => {});
    await page.click('#seatsList .crow');
    await page.waitForSelector('#seatCard', { timeout: 10_000 });
    const recovery = await text('#seatRecoveryTitle');
    check(`I · a subscription ${name} renders`, Boolean(await page.$('#seatCard')), recovery ? `recovery: ${recovery}` : 'no recovery card');
    check(`I · …Back is reachable by a tap`, (await whatIsOnTop('#pageBack')) === 'the button itself', String(await whatIsOnTop('#pageBack')));
    check(`I · …has no Home action`, !(await page.$('#pageHome')));
    await page.click('#pageBack');
    await new Promise((r) => setTimeout(r, 800));
    check(`I · …and Back leaves a subscription ${name}`, page.url().includes('/seats?org='), `${page.url()} · screen ${await screenNow()}`);
  }

  // J. The header is STICKY, and the subscription page is the longest of
  //    these screens: a status card, a recovery card, usage meters and four
  //    actions. A reader scrolls it. Back has to still be there — and still
  //    be the thing under the tap — after they do.
  await orgStorage.updateSeat(seeded.seatId, { status: 'payment_required', subscriptionStatus: 'past_due', subscriptionCheckedAt: new Date().toISOString() } as never);
  // A phone the height of a real one with its browser chrome up, so the page
  // is genuinely taller than the window.
  await page.setViewport({ width: 390, height: 620, deviceScaleFactor: 2 });
  await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#seatsList .crow') !== null, { timeout: 10_000 }).catch(() => {});
  await page.click('#seatsList .crow');
  await page.waitForSelector('#seatCard', { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 400));

  const pageShape = await page.evaluate(`(() => {
    const head = document.getElementById('pageHead');
    const b = head.getBoundingClientRect();
    return {
      scrollable: document.documentElement.scrollHeight - window.innerHeight,
      headTop: Math.round(b.top),
      headHeight: Math.round(b.height),
      sticky: getComputedStyle(head).position,
    };
  })()`);
  check('J · the subscription page is long enough to scroll on a phone', (pageShape as any).scrollable > 200, JSON.stringify(pageShape));
  check('J · the header is a sticky one', (pageShape as any).sticky === 'sticky', JSON.stringify(pageShape));

  // A real wheel rather than a programmatic scroll: ScrollMemory may still be
  // completing the route's opening placement, while a reader's input is the
  // authority that follows it.
  await page.mouse.wheel({ deltaY: 1200 });
  await new Promise((r) => setTimeout(r, 500));
  const scrolled = await page.evaluate(`(() => {
    const head = document.getElementById('pageHead');
    const b = head.getBoundingClientRect();
    return { y: Math.round(window.scrollY), headTop: Math.round(b.top), headBottom: Math.round(b.bottom) };
  })()`);
  check('J · the reader really moved down the page', (scrolled as any).y > 150, JSON.stringify(scrolled));
  check('J · the header is still pinned at the top of the window', (scrolled as any).headTop === 0, JSON.stringify(scrolled));
  check('J · Back is still reachable by a tap while scrolled', (await whatIsOnTop('#pageBack')) === 'the button itself', String(await whatIsOnTop('#pageBack')));
  check('J · no Home action appears while scrolled', !(await page.$('#pageHome')));
  await shotOrg('n400-seat-scrolled');
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 900));
  check('J · Back works from the foot of the subscription page', page.url().includes('/seats?org='), `${page.url()} · screen ${await screenNow()}`);
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });

  // K. A transient LEAF claims Back while Home's shared header is being
  //    mounted from nothing. If that claim outlives the leaf, the next screen
  //    opened inherits a Back that is swallowed. Save stays in the form and
  //    the header must carry no mutation action at all (note #590).
  const headerState = async () => page.evaluate(`(() => {
    const head = document.getElementById('pageHead');
    if (!head) return { header: false };
    const back = document.getElementById('pageBack');
    return {
      header: true,
      mutationActions: document.querySelectorAll('#pageHead button:not(#pageBack)').length,
      saveInForm: Boolean(document.querySelector('#noteForm #saveNoteBtn')),
      homeAbsent: !document.getElementById('pageHome'),
      backShown: Boolean(back && back.offsetParent !== null),
      titles: document.querySelectorAll('#pageId > *').length,
    };
  })()`);

  const openSeatFromList = async () => {
    await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#seatsList .crow') !== null, { timeout: 10_000 }).catch(() => {});
    await page.click('#seatsList .crow');
    await page.waitForSelector('#seatCard', { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
  };

  // The composer was a page of the agents picker (note #722), from a room's
  // Notes shelf, until rooms left the product (note #843): the Workplace
  // window's "Write a note" opens the notes screen with the composer up, a
  // leaf under the shared header whose claim lives and dies with it.
  for (const exit of ['the page’s Back', 'saving the note']) {
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
    await waitHome('workplace');
    // The notes are a row of the window's index since note #960: it opens
    // the notes screen, whose Write a note puts the composer up.
    await page.waitForSelector('#homeSheet #homeWorkplace #indexNotes', { timeout: 10_000 });
    await page.$eval('#homeSheet #homeWorkplace #indexNotes', (node) => (node as HTMLElement).click());
    await page.waitForSelector('#screenNotes #notesAddBtn', { timeout: 10_000 });
    await page.$eval('#screenNotes #notesAddBtn', (node) => (node as HTMLElement).click());
    await page.waitForSelector('#noteForm', { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 400));
    const inComposer = await headerState();
    check(`K · the composer opens over the notes screen, under the shared header and its Back (${exit})`,
      (inComposer as any).header === true && (inComposer as any).backShown === true && new URL(page.url()).pathname === '/notes',
      `${JSON.stringify(inComposer)} · ${page.url()}`);
    check(`K · …and its Save stays in the form, not the head`,
      (inComposer as any).mutationActions === 0 && (inComposer as any).saveInForm === true,
      JSON.stringify(inComposer));

    if (exit === 'the page’s Back') {
      await page.click('#pageBack');
    } else {
      await page.type('#noteText', 'A jotting from the harness.');
      await page.click('#saveNoteBtn');
    }
    await new Promise((r) => setTimeout(r, 1200));

    // Now the screen the reader opens next.
    await openSeatFromList();
    const onSeat = await headerState();
    check(`K · after the composer was left by ${exit}, the subscription page keeps its own header`,
      (onSeat as any).header === true && (onSeat as any).mutationActions === 0 && (onSeat as any).homeAbsent === true && (onSeat as any).backShown === true,
      JSON.stringify(onSeat));
    check(`K · …Back is reachable by a tap`, (await whatIsOnTop('#pageBack')) === 'the button itself', String(await whatIsOnTop('#pageBack')));
    await page.click('#pageBack');
    await new Promise((r) => setTimeout(r, 900));
    check(`K · …and Back leaves the subscription after a composer left by ${exit}`,
      page.url().includes('/seats?org='), `${page.url()} · screen ${await screenNow()}`);
  }

  // L. A phone tap that lands twice. The row is a button that pushes on every
  //    click and the router does not fold a repeat of the same address, so two
  //    taps stack two identical entries — and one Back then spends the second
  //    one and repaints the very page the reader asked to leave. From outside
  //    that is a Back button that does nothing.
  await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#seatsList .crow') !== null, { timeout: 10_000 }).catch(() => {});
  const row = (await page.$$('#seatsList .crow'))[0]!;
  await row.click();
  await row.click().catch(() => {});
  await page.waitForSelector('#seatCard', { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 600));
  check('L · two taps on the row still show the subscription', /\/seats\/[^/?]+\?org=/.test(page.url()), page.url());
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 900));
  check('L · ONE Back leaves the subscription after a double tap',
    page.url().includes('/seats?org='), `${page.url()} · screen ${await screenNow()}`);

  // M. The same double tap from Home's own subscription card.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await waitHome('workplace');
  await page.waitForFunction(() => document.querySelector('#seatsHome .seatcard') !== null, { timeout: 10_000 }).catch(() => {});
  const card = (await page.$$('#seatsHome .seatcard'))[0]!;
  // Low in the window since note #960: brought to the middle first, so the
  // two real taps land on it.
  await card.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await new Promise((r) => setTimeout(r, 300));
  await card.click();
  await card.click().catch(() => {});
  await page.waitForSelector('#seatCard', { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 600));
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 900));
  check('M · ONE Back from a double-tapped subscription card is Home',
    await waitHome('workplace'), `${page.url()} · screen ${await screenNow()}`);

  // N. The subscription page opened while its own read NEVER ANSWERS
  //    (knowledge page "workspace-read-that-never-answers"). The page may
  //    honestly say it is loading; what it may not do is take Back with it,
  //    because a reader stuck on a bounded-forever read has nothing else left.
  const hang = async (path: string, on: boolean) => page.evaluate(
    `fetch('/control?path=' + encodeURIComponent(${JSON.stringify(path)}) + '&on=' + (${on} ? '1' : '0')).then(r => r.json())`);

  await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#seatsList .crow') !== null, { timeout: 10_000 }).catch(() => {});
  await hang('api/org/seats', true);
  await page.click('#seatsList .crow');
  await new Promise((r) => setTimeout(r, 2500));
  const stuck = await headerState();
  check('N · a subscription whose read never answers still carries the header',
    (stuck as any).header === true && (stuck as any).backShown === true && (stuck as any).homeAbsent === true, JSON.stringify(stuck));
  check('N · …Back is reachable by a tap', (await whatIsOnTop('#pageBack')) === 'the button itself', String(await whatIsOnTop('#pageBack')));
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 1200));
  check('N · …and Back gets the reader out', page.url().includes('/seats?org='), `${page.url()} · screen ${await screenNow()}`);
  await hang('api/org/seats', false);

  // O. The same, but the read that never answers is the whole Workspace
  //    state — the one every screen hangs off.
  await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#seatsList .crow') !== null, { timeout: 10_000 }).catch(() => {});
  await hang('api/state', true);
  await page.click('#seatsList .crow');
  await new Promise((r) => setTimeout(r, 2500));
  const stuck2 = await headerState();
  check('O · a subscription opened while the state read never answers keeps the header',
    (stuck2 as any).header === true && (stuck2 as any).backShown === true && (stuck2 as any).homeAbsent === true, JSON.stringify(stuck2));
  if ((stuck2 as any).header) {
    await page.click('#pageBack');
    await new Promise((r) => setTimeout(r, 1200));
    check('O · …and Back gets the reader out', page.url().includes('/seats?org='), `${page.url()} · screen ${await screenNow()}`);
  }
  await hang('api/state', false);


  // P. Every mutation on a subscription REPLACES its address with the list
  //    ("so Back never reopens a seat the server would refuse"). When the
  //    list is ALREADY the entry underneath, that leaves two identical list
  //    entries stacked — and Back then spends one to repaint the very same
  //    screen at the very same address. Nothing moves, which from outside is
  //    a Back button that has stopped working (note #400).
  await orgStorage.updateSeat(seeded.seatId, { status: 'active', subscriptionStatus: undefined } as never);
  await orgStorage.addSeat({ orgId: orgDoc.orgId, userId: me.userId, provider: 'claude', token: 'seat-token-2', label: 'Claude · the older one', status: 'active' } as never);
  await orgStorage.selectSeat(seeded.seatId, orgDoc.orgId);

  /** Open the fallback subscription from the list and act on it. */
  const actOnFallbackFromList = async () => {
    await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
    // Three: the subject, the fallback this section adds, and the fixture's
    // live one holding the lock open.
    await page.waitForFunction(() => document.querySelectorAll('#seatsList .crow').length === 3, { timeout: 10_000 }).catch(() => {});
    const list = page.url();
    if (!(await clickText('#seatsList .crow', /the older one/))) return null;
    await page.waitForSelector('#seatCard', { timeout: 10_000 });
    if (!(await clickText('#seatActions .btn', /Make primary here|Earlier fallback|Later fallback/))) return null;
    await new Promise((r) => setTimeout(r, 1500));
    return list;
  };

  const listUrl = await actOnFallbackFromList();
  check('P · acting on a subscription returns to the list', listUrl !== null && page.url().includes('/seats?org='),
    `${page.url()} · screen ${await screenNow()}`);

  const before = { url: page.url(), screen: await screenNow() };
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 1200));
  const after = { url: page.url(), screen: await screenNow() };
  check('P · ONE Back after acting on a subscription moves the reader',
    after.screen !== before.screen || after.url !== before.url,
    `before ${before.screen} ${before.url} → after ${after.screen} ${after.url}`);

  // How many taps it really costs to get out.
  let taps = 1;
  while (taps < 5 && (await screenNow()) === 'screenSeats') {
    await page.click('#pageBack').catch(() => {});
    await new Promise((r) => setTimeout(r, 900));
    taps += 1;
  }
  check('P · …and it takes ONE tap, not several', taps === 1, `${taps} taps to leave the subscriptions list · now ${await screenNow()}`);

  // The list reached after the mutation keeps Back as its only way out.
  await actOnFallbackFromList();
  const backBefore = { url: page.url(), screen: await screenNow() };
  check('P · the list has no Home action', !(await page.$('#pageHome')));
  await page.click('#pageBack');
  await new Promise((r) => setTimeout(r, 1200));
  check('P · Back after acting on a subscription is Home',
    await waitChatHome(), `before ${backBefore.screen} → after ${await screenNow()} ${page.url()}`);

  // Q. The page opened COLD (note #625: "When I open a subscription page, and
  //    it doesn't yet has data, it shows poorly designed loading state and it
  //    display text 'Seat'"). Home's plate is drawn from the state read and
  //    never fills the seats cache, so the tap a reader actually makes lands
  //    on a page whose own read is still out — and that page was the bare
  //    word "Seat" over one grey "Loading…" line. The read is held LATE here:
  //    long enough for the wait to be drawn and photographed, then it lands,
  //    and what stood in for it is measured against what replaced it.
  const slowDown = async (path: string, ms: number) => page.evaluate(
    `fetch('/control?path=' + encodeURIComponent(${JSON.stringify(path)}) + '&slow=' + ${ms}).then(r => r.json())`);
  const subject = (await orgStorage.listSeatsByMember(orgDoc.orgId, me.userId)).find((seat) => seat.seatId === seeded.seatId)!;
  const seatGeometry = async () => page.evaluate(`(() => {
    const top = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().top) : null; };
    const screen = document.getElementById('screenSeat');
    const card = screen ? screen.querySelector('.card') : null;
    // What a sighted reader can see: the screen's text without the line
    // that is there only to be read aloud.
    const seen = screen ? [...screen.querySelectorAll('*')].filter((el) => !el.closest('.sr-only') && el.childNodes.length)
      .flatMap((el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent)).join(' ').replace(/\\s+/g, ' ').trim() : '';
    return {
      title: document.getElementById('seatTitle')?.textContent ?? null,
      sub: document.getElementById('seatSub')?.textContent ?? null,
      busy: screen?.getAttribute('aria-busy') ?? null,
      seen,
      bars: screen ? screen.querySelectorAll('.skel').length : 0,
      rows: card ? card.querySelectorAll('.drow').length : 0,
      titleTop: top('#seatTitle'),
      cardTop: card ? Math.round(card.getBoundingClientRect().top) : null,
      usageTop: top('#seatUsageTitle'),
    };
  })()`) as Promise<{ title: string | null; sub: string | null; busy: string | null; seen: string; bars: number; rows: number; titleTop: number | null; cardTop: number | null; usageTop: number | null }>;

  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await waitHome('workplace');
  await page.waitForFunction(() => document.querySelector('#seatsHome .seatcard') !== null, { timeout: 10_000 }).catch(() => {});
  // Four seconds: far past the quarter second before a wait is drawn, and
  // long enough that a slow CI machine still photographs it mid-read.
  // What the plate says, so the page can be held to the same reading.
  const plateWords = async () => page.evaluate(`(() => {
    const plate = [...document.querySelectorAll('#seatsHome .seatcard')].find((node) => /Max 20x/.test(node.textContent));
    return plate ? [...plate.querySelectorAll('.seatstat .pct')].map((node) => node.textContent.trim()) : [];
  })()`) as Promise<string[]>;
  const usageWords = async () => page.evaluate(`[...document.querySelectorAll('#seatUsageCard .usage-pct')].map((node) => node.textContent.trim())`) as Promise<string[]>;
  const sameReading = (plate: string[], usage: string[]) => plate.length > 0
    && plate.every((pct) => usage.includes(`${pct} used`)) && usage.length === plate.length;
  const plateCold = await plateWords();
  await slowDown('api/org/seats', 4000);
  const tapped = await clickText('#seatsHome .seatcard', /Max 20x/);
  await page.waitForFunction(() => document.getElementById('seatCardWait') !== null, { timeout: 3000 }).catch(() => {});
  const waiting = await seatGeometry();
  const usageCold = await usageWords();
  await page.screenshot({ path: path.join(OUT, 'n625-seat-wait.png') as `${string}.png` });
  check('Q · Home’s plate opens a subscription whose read is still out', tapped && waiting.busy === 'true', JSON.stringify(waiting));
  check('Q · …under its own name, never the word "Seat"', waiting.title === subject.label, `title ${JSON.stringify(waiting.title)}`);
  check('Q · …and says whose subscription it is', waiting.sub === 'Claude Code subscription', `sub ${JSON.stringify(waiting.sub)}`);
  check('Q · …with no "Loading…" line on the glass', !/Loading/.test(waiting.seen), waiting.seen);
  // The plate's own reading carries every word a usage row says (note
  // #697), so it is drawn as itself: only the day the subscription was added
  // is not on Home's row, and only that waits as a bar.
  check('Q · …holding the facts card in its own shape, the day it was added as its one bar', waiting.rows >= 3 && waiting.bars === 1 && waiting.usageTop !== null,
    `rows ${waiting.rows} · bars ${waiting.bars} · usage heading ${waiting.usageTop}`);
  check('Q · …and drawing the very reading the plate showed, whole', sameReading(plateCold, usageCold),
    `plate ${JSON.stringify(plateCold)} · page ${JSON.stringify(usageCold)}`);

  await page.waitForFunction(() => document.getElementById('screenSeat')?.getAttribute('aria-busy') !== 'true'
    && document.getElementById('seatActions') !== null, { timeout: 10_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const landed = await seatGeometry();
  await page.screenshot({ path: path.join(OUT, 'n625-seat-landed.png') as `${string}.png` });
  check('Q · the read lands under the same name', landed.title === waiting.title && landed.sub === waiting.sub, `${JSON.stringify(waiting.title)} → ${JSON.stringify(landed.title)}`);
  check('Q · …and nothing above the usage moves when it does',
    landed.titleTop === waiting.titleTop && landed.cardTop === waiting.cardTop && landed.usageTop === waiting.usageTop,
    `title ${waiting.titleTop}→${landed.titleTop} · card ${waiting.cardTop}→${landed.cardTop} · usage ${waiting.usageTop}→${landed.usageTop}`);
  check('Q · …and no bar is left behind', landed.bars === 0 && landed.busy !== 'true', JSON.stringify(landed));

  // The list, reached the same cold way — Home's "Add sub" plate. Every row it
  // draws is already on the state read Home painted from, so it opens whole
  // rather than on a grey "Loading…" box, and the read landing moves nothing.
  const listGeometry = async () => page.evaluate(`(() => {
    const list = document.getElementById('seatsList');
    const door = document.getElementById('seatSignInOpen');
    const seen = list ? list.textContent.replace(/\\s+/g, ' ').trim() : '';
    return {
      busy: list?.getAttribute('aria-busy') ?? null,
      rows: list ? [...list.querySelectorAll('.crow')].map((row) => row.querySelector('.name')?.textContent ?? '') : [],
      sub: document.getElementById('seatsSub')?.textContent ?? '',
      seen,
      doorTop: door ? Math.round(door.getBoundingClientRect().top) : null,
    };
  })()`) as Promise<{ busy: string | null; rows: string[]; sub: string; seen: string; doorTop: number | null }>;
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await waitHome('workplace');
  await page.waitForFunction(() => document.querySelector('#seatsHome .seatadd') !== null, { timeout: 10_000 }).catch(() => {});
  await page.$eval('#seatsHome .seatadd', (node) => (node as HTMLElement).click());
  await page.waitForFunction(() => document.querySelector('#screenSeats #seatsList .crow') !== null, { timeout: 3000 }).catch(() => {});
  const listWaiting = await listGeometry();
  await page.screenshot({ path: path.join(OUT, 'n625-seats-wait.png') as `${string}.png` });
  check('Q · the list opened cold draws its rows before its read lands',
    listWaiting.busy === 'true' && listWaiting.rows.length === 3 && listWaiting.rows.includes(subject.label), JSON.stringify(listWaiting));
  check('Q · …counts them under the title', /^3 private sign-ins assigned to /.test(listWaiting.sub), listWaiting.sub);
  check('Q · …and has no "Loading…" line', !/Loading/.test(listWaiting.seen), listWaiting.seen);
  await page.waitForFunction(() => document.getElementById('seatsList')?.getAttribute('aria-busy') !== 'true', { timeout: 10_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const listLanded = await listGeometry();
  check('Q · …and the read landing moves nothing', listLanded.busy === null && listLanded.doorTop === listWaiting.doorTop
    && JSON.stringify(listLanded.rows) === JSON.stringify(listWaiting.rows) && listLanded.sub === listWaiting.sub,
    `door ${listWaiting.doorTop}→${listLanded.doorTop} · ${JSON.stringify(listWaiting.rows)} → ${JSON.stringify(listLanded.rows)}`);
  await slowDown('api/org/seats', 0);

  // An address for a subscription that is not assigned here (unassigned since
  // the link was copied): the page says so, and still not under "Seat".
  await page.goto(`${ORIGIN}/seats/not-assigned-here?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => /no longer assigned here/.test(document.getElementById('seatCard')?.textContent ?? ''), { timeout: 10_000 }).catch(() => {});
  const gone = await seatGeometry();
  check('Q · a subscription no longer assigned here says so under a real word',
    /no longer assigned here/.test(gone.seen) && gone.title !== null && gone.title !== 'Seat' && gone.busy !== 'true', JSON.stringify(gone));

  // R. The page opened WARM (note #697: "If I open a subscription details
  //    page, I see stale data for a moment and then it updates. … In the home
  //    page, the data was fresh."). The seats cache keeps what an earlier
  //    visit read for as long as the tab lives, while Home's state read is
  //    asked again on every arrival — so by the afternoon the page painted
  //    the morning's percentages under the ones Home had just shown, until
  //    its own read replaced them. The reading moves on between two visits
  //    made INSIDE the app (a reload would empty the cache), and the second
  //    visit's own read is held late.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await waitHome('workplace');
  await page.waitForFunction(() => document.querySelector('#seatsHome .seatcard') !== null, { timeout: 10_000 }).catch(() => {});
  await clickText('#seatsHome .seatcard', /Max 20x/);
  await page.waitForFunction(() => document.getElementById('seatActions') !== null, { timeout: 10_000 }).catch(() => {});
  const morning = await usageWords();
  await orgStorage.updateSeat(seeded.seatId, {
    usage: {
      capturedAt: new Date().toISOString(),
      planType: 'max_20x',
      windows: {
        five_hour: { id: 'five_hour', usedPercent: 87, windowDurationMins: 300, resetsAt: Math.round(Date.now() / 1000) + 200 * 60 },
        seven_day: { id: 'seven_day', usedPercent: 44, windowDurationMins: 10_080, resetsAt: weekResetsAt },
      },
    },
    modelWindows: { fable: { id: 'seven_day_fable', usedPercent: 70, windowDurationMins: 10_080, resetsAt: weekResetsAt } },
    usageRefreshedAt: new Date().toISOString(),
  });
  await page.click('#pageBack');
  await waitHome('workplace');
  await page.waitForFunction(() => [...document.querySelectorAll('#seatsHome .seatcard .pct')].some((node) => node.textContent?.trim() === '87%'), { timeout: 10_000 }).catch(() => {});
  const plateWarm = await plateWords();
  await slowDown('api/org/seats', 4000);
  await clickText('#seatsHome .seatcard', /Max 20x/);
  await page.waitForFunction(() => document.getElementById('seatUsageCard') !== null, { timeout: 3000 }).catch(() => {});
  const usageWarm = await usageWords();
  await page.screenshot({ path: path.join(OUT, 'n697-seat-warm.png') as `${string}.png` });
  check('R · the earlier visit read the earlier reading', morning.length > 0 && !morning.includes('87% used'), JSON.stringify(morning));
  check('R · Home shows the newer reading', plateWarm.includes('87%'), JSON.stringify(plateWarm));
  check('R · the page opened warm draws the plate’s reading, not the one it held, before its read lands',
    sameReading(plateWarm, usageWarm) && !usageWarm.includes(morning[0]!), `plate ${JSON.stringify(plateWarm)} · page ${JSON.stringify(usageWarm)}`);
  check('R · …and the record it held still opens it whole, actions and all', Boolean(await page.$('#seatActions')));
  await page.waitForFunction(() => document.getElementById('screenSeat')?.getAttribute('aria-busy') !== 'true', { timeout: 10_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 4500));
  const usageLanded = await usageWords();
  check('R · …and its own read landing changes nothing', JSON.stringify(usageLanded) === JSON.stringify(usageWarm),
    `${JSON.stringify(usageWarm)} → ${JSON.stringify(usageLanded)}`);
  await slowDown('api/org/seats', 0);

  // A `404 …/api/recap` was allowed here: the room briefing's read, which a
  // workplace with no room refused. The briefing went with the room view
  // (note #843), so nothing makes that read any more.
  const unexpected = consoleErrors.filter((t) => !/status of (400|401|404|503)|\b401 .*auth\/session|favicon\.ico|\b503 .*\/api\/(agents|org\/seats|notifications)\//.test(t));
  check('no unexpected console errors', unexpected.length === 0, unexpected.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
