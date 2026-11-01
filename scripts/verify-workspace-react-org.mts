// Drives the React Workspace shell's ADMINISTRATION screens in real Chrome
// against a real backend router with in-memory stores: create access, found
// a workplace through the founder door, add a secret and read it back, open
// the workplace and the profile, and read a seeded seat. Screenshots land in
// ~/mini-preview/n256-org-*.png.
// Since 2026-10-10 Home (`/`) is the Chief of Staff's conversation; what the
// overview's two tabs held opens over it — the Workplace window and the
// agents picker (note #715) — and /overview redirects to Home with the one
// it names.
// It also read the first room back as the picker's tab and measured a
// room's actions page, until rooms left the product (note #843).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-react-org.mts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { closeHomeWindow } from './workspace-harness-home.mjs';
import { settleAfterShot, tap } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemorySecretStorage } from '../backend/src/services/secret-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, signUpWorkspaceByEmail } from './workspace-harness-auth.mjs';

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
/** The Fly org this workplace points at, and the one it starts on. Declared
 *  up here because the setup fixture below stamps it on the workplace as it
 *  is created: the slug the LOCK reads and the slug this harness's cloud
 *  answers with have to be one slug, or the workplace screen argues with
 *  itself. */
const SEEDED_SLUG = 'nomad-trading';
// The workplace this harness founds is one already past its setup gate — its
// cloud is connected and one subscription is signed in — so the Workspace
// opens instead of holding on "Connect your Fly cloud". That subscription is
// this harness's OWN, because the checks below count them.
harnessEstablishedWorkplace(orgStorage, {
  flyOrgSlug: SEEDED_SLUG,
  seat: { provider: 'claude', token: 'seat-token', label: 'Claude · signed in today' },
});
const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  orgStorage,
  secretStorage: new InMemorySecretStorage(),
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
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
        machinesElsewhere: spendElsewhere,
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
/** Note #635: machines another workplace runs in this same account, which
 *  the real report counts and does not list. Nothing but its own section
 *  turns it up, so every other check reads the three rows it always did. */
let spendElsewhere = 0;
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
  // Home holds the workplace's own shelves in its Workplace window (note
  // #715, opened by the Chief of Staff's name) and the fleet in the agents
  // picker — which was a room's tab until rooms left the product (note
  // #843). Only the one standing is drawn, so measuring the other means
  // opening it. Opened in the page by Home's own controls; one already
  // standing is used as it is.
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
  // Landing on Home opens the picker by default: the fleet it holds is what
  // most of this harness reads there.
  const waitHome = async (half: 'workplace' | 'agents' = 'agents') => {
    await page.waitForSelector('#screenHome #homeWorkplaceDoor', { timeout: 10_000 }).catch(() => {});
    await openHalf(half).catch(() => {});
    return Boolean(await page.$('#screenHome')) && Boolean(await page.$(halfShown(half)));
  };
  // Home with no window over it: what the header's own controls (the
  // workplace switch, the reader's picture) are tapped on.
  const homeBare = async () => {
    await page.waitForSelector('#screenHome #homeOrganizations', { timeout: 10_000 }).catch(() => {});
    await closeHomeWindow(page);
    return Boolean(await page.$('#screenHome #homeOrganizations')) && !(await page.$('#homeSheet'));
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
      if (want.test(t)) { await handle.click(); return true; }
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
  // first, and a room's page held its actions (note #585), until rooms left
  // the product (note #843): no tab.
  check('the picker lists no tabs', !(await page.$('#agentSwitchTabs')) && !(await page.$('#agentSwitchSheet [role="tab"]')),
    await text('#agentSwitchSheet'));
  check('…and is titled for the agents', await waitHome() && (await text('#agentSwitchTitle')) === 'Your agents', await text('#agentSwitchTitle'));
  check('Home has no reader or workplace identity header', !(await page.$('#orgSection')));
  const orgForActionShot = (await orgStorage.listOrgs())[0]!;
  await page.goto(`${ORIGIN}/?org=${orgForActionShot.orgId}`, { waitUntil: 'networkidle0' });
  await homeBare();
  // Note #597 names the workplace inside its target, and the owner's final
  // alignment puts its visible right edge on the card directly below it —
  // the reading column's edge, not the persistent header's full-bleed edge.
  // Since note #634 the reader's own picture holds that edge, and the switch
  // stands just before it.
  const homeSwitch = await page.$eval('#homeOrganizations', (node) => {
    const box = node.getBoundingClientRect();
    // Under Home's header is the conversation now (note #715).
    const following = document.querySelector('#recapChatLog')!.getBoundingClientRect();
    return {
      right: Math.round(box.right), width: Math.round(box.width), height: Math.round(box.height),
      name: node.querySelector('.orgswapname')?.textContent?.trim() ?? '',
      followingRight: Math.round(following.right),
      faceLeft: Math.round(document.querySelector('#homeAccount .accountface')!.getBoundingClientRect().left),
      faceRight: Math.round(document.querySelector('#homeAccount .accountface')!.getBoundingClientRect().right),
    };
  });
  check('Home’s named workplace switch stands before the reader’s picture, which aligns with the conversation’s column below',
    homeSwitch.faceRight === homeSwitch.followingRight && homeSwitch.right < homeSwitch.faceLeft
      && homeSwitch.width >= 44 && homeSwitch.height === 44
      && homeSwitch.name === orgForActionShot.name,
    `switch ${homeSwitch.right}px/${homeSwitch.width}×${homeSwitch.height} “${homeSwitch.name}” · face ${homeSwitch.faceLeft}–${homeSwitch.faceRight}px · column ${homeSwitch.followingRight}px`);
  // Note #609: the switch drops a menu over Home rather than leaving it.
  const homeAddress = page.url();
  await page.click('#homeOrganizations');
  await page.waitForSelector('#workplaceMenu', { visible: true, timeout: 10_000 });
  const menuShape = await page.$eval('#workplaceMenu', (node) => {
    const box = node.getBoundingClientRect();
    const toggle = document.getElementById('homeOrganizations')!.getBoundingClientRect();
    return {
      below: box.top >= toggle.bottom, rightDelta: Math.abs(box.right - toggle.right),
      rows: node.querySelectorAll('[role="menuitemradio"]').length,
      checked: node.querySelector('[aria-checked="true"] .orgmenunametext')?.textContent ?? '',
      actions: [...node.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? ''),
      iconless: [...node.querySelectorAll('[role="menuitem"]')].filter((item) => !item.querySelector('.orgmenutick svg')).length,
    };
  });
  check('the switch drops its menu under itself without leaving Home',
    page.url() === homeAddress && menuShape.below && menuShape.rightDelta < 1 && menuShape.rows >= 1
      && menuShape.checked === orgForActionShot.name,
    `${page.url()} ${JSON.stringify(menuShape)}`);
  check('…and invites a person into the active workplace, above its settings (note #620)',
    menuShape.actions[0] === 'Invite to this workplace' && menuShape.actions[1] === 'Workplace settings',
    JSON.stringify(menuShape.actions));
  check('…every one of those actions carries its icon, as New workplace does (note #622)',
    menuShape.iconless === 0, JSON.stringify(menuShape));
  await shotOrg('workplace-menu');
  await page.click('#workplaceMenuInvite');
  await page.waitForSelector('#screenInvite', { timeout: 10_000 });
  await page.waitForSelector('#inviteTitle', { timeout: 10_000 });
  check('that door opens the invite page', (await text('#inviteTitle')) === 'Invite to this workplace', await text('#inviteTitle'));
  await page.goto(homeAddress, { waitUntil: 'networkidle0' });
  await page.click('#homeOrganizations');
  await page.waitForSelector('#workplaceMenu', { visible: true, timeout: 10_000 });
  await page.click('#workplaceMenuSettings');
  // ScreenTitle is portalled into the persistent page header, so the title
  // and the screen are siblings rather than one containing the other.
  await page.waitForSelector('#screenOrg', { timeout: 10_000 });
  await page.waitForSelector('#orgTitle', { timeout: 10_000 });
  check('that door opens the workplace details', (await text('#orgTitle')) === 'saddam’s workplace', await text('#orgTitle'));
  const renamePosition = await page.$eval('#orgNameActions', (node) => {
    const button = node.getBoundingClientRect();
    const cloud = document.getElementById('orgCloud')!.getBoundingClientRect();
    const rename = node.querySelector('#orgRenameBtn');
    return {
      afterCloud: button.top >= cloud.bottom,
      last: node === document.getElementById('screenOrg')!.lastElementChild,
      // A secondary text action at the page's right edge (owner, 2026-09-22).
      secondary: Boolean(rename?.classList.contains('ghost')) && !rename?.classList.contains('formcommit'),
      rightEdge: Math.abs(rename!.getBoundingClientRect().right - (node.getBoundingClientRect().right - 8)) <= 2,
    };
  });
  check('rename sits at the bottom right as a secondary action',
    renamePosition.afterCloud && renamePosition.last && renamePosition.secondary && renamePosition.rightEdge, JSON.stringify(renamePosition));
  const detailAddress = page.url();
  await page.click('#orgNameActions button');
  await page.waitForSelector('#screenOrgName', { timeout: 10_000 });
  check('rename is a transient screen over the workplace address', page.url() === detailAddress, page.url());
  check('the rename field starts with the current name', await page.$eval('#orgName', (node) => (node as HTMLInputElement).value) === 'saddam’s workplace');
  check('an unchanged name cannot be saved', await page.$eval('#orgNameSave', (node) => (node as HTMLButtonElement).disabled));
  check('Save uses the onboarding flow’s primary action', await page.$eval('#orgNameSave', (node) => node.classList.contains('formcommit')));
  check('the rename form carries no extra footer copy', !(await text('#screenOrgName')).includes('Everyone in this workplace'));
  check('the focused name field keeps its tint with no coloured left border', await page.$eval('#screenOrgName .frow', (node) => {
    const style = getComputedStyle(node);
    return style.borderLeftWidth === '0px' && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
  }));
  await shotOrg('rename-phone');
  await page.click('#pageBack');
  await page.waitForSelector('#screenOrg', { timeout: 10_000 });
  check('Back closes rename without moving or changing the workplace',
    page.url() === detailAddress && (await text('#orgTitle')) === 'saddam’s workplace',
    `${page.url()} · ${await text('#orgTitle')}`);
  await page.click('#orgNameActions button');
  await page.waitForSelector('#screenOrgName', { timeout: 10_000 });
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  const desktopRename = await page.$eval('#screenOrgName', (node) => ({
    pageWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    formWidth: Math.round(node.getBoundingClientRect().width),
  }));
  check('the rename form stays in the reading column on desktop',
    desktopRename.pageWidth <= desktopRename.viewportWidth && desktopRename.formWidth <= 720,
    JSON.stringify(desktopRename));
  await shotOrg('rename-desktop');
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  await page.click('#orgName');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.type('#orgName', '  Northstar   Studio  ');
  check('the name field holds the edit exactly as typed',
    await page.$eval('#orgName', (node) => (node as HTMLInputElement).value) === '  Northstar   Studio  ',
    await page.$eval('#orgName', (node) => (node as HTMLInputElement).value));
  check('a changed name makes Save available', !(await page.$eval('#orgNameSave', (node) => (node as HTMLButtonElement).disabled)));
  await page.click('#orgNameSave');
  await page.waitForFunction(() => document.querySelector('#orgTitle')?.textContent === 'Northstar Studio', { timeout: 10_000 });
  check('the workplace title changes without moving its address', page.url() === detailAddress, page.url());
  check('the shared workplace record carries the normalized name', (await orgStorage.listOrgs())[0]!.name === 'Northstar Studio');
  await page.click('#pageBack');
  await homeBare();
  await page.click('#homeOrganizations');
  await page.waitForSelector('#workplaceMenu', { visible: true, timeout: 10_000 });
  check('the workplace menu carries the new name', (await text('#workplaceMenu [aria-checked="true"] .orgmenunametext')) === 'Northstar Studio', await text('#workplaceMenu [aria-checked="true"] .orgmenunametext'));
  await page.click('#workplaceMenuNew');
  await page.waitForSelector('#orgCreateBtn', { timeout: 10_000 });
  const workplaceCommit = await page.$eval('#orgCreateBtn', (node) => {
    const button = node as HTMLButtonElement;
    const box = button.getBoundingClientRect();
    const form = document.getElementById('orgCreateForm')!.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      className: button.className,
      afterField: box.top >= document.getElementById('orgCreateName')!.getBoundingClientRect().bottom,
      rightDelta: Math.abs(box.right - form.right),
      height: box.height,
      width: box.width,
      formWidth: form.width,
      radius: style.borderRadius,
      background: style.backgroundColor,
    };
  });
  check('New workplace uses the compact form commit below its field',
    workplaceCommit.className === 'formcommit' && workplaceCommit.afterField
      && workplaceCommit.rightDelta < 1 && workplaceCommit.height === 40
      && workplaceCommit.width < workplaceCommit.formWidth / 2
      && workplaceCommit.radius === '999px' && workplaceCommit.background !== 'rgba(0, 0, 0, 0)',
    JSON.stringify(workplaceCommit));
  check('New workplace ends at its Create workplace action',
    !(await text('#screenOrgCreate')).includes('Your company or team’s name is the usual choice'));
  await shotOrg('new-workplace');
  await page.click('#pageBack');
  await waitHome();
  check('the menu closed behind the form', !(await page.$('#workplaceMenu')));
  check('Home carries the new workplace name', (await text('#homeOrganizations .orgswapname')) === 'Northstar Studio', await text('#homeOrganizations .orgswapname'));
  await shotOrg('home');

  // 3. Add a secret from Home, read it back, describe it. Secrets are the
  //    Workplace window's (note #783 — one set per workplace, like
  //    repositories): Add goes to the secrets screen with its form up, and a
  //    secret's address carries the workplace and no room.
  await waitHome('workplace');
  await page.waitForSelector('#homeSheet #homeWorkplace #secrets', { timeout: 10_000 });
  // The card sits low in the window's scroll: click it where it stands.
  await page.$eval('#homeSheet #homeWorkplace #addBtn', (node) => (node as HTMLButtonElement).click());
  await page.waitForSelector('#secretName');
  await page.click('#secretName');
  check('the shared secret fields lost the same left focus border',
    await page.$eval('#screenAdd .frow', (node) => getComputedStyle(node).borderLeftWidth === '0px'));
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

  // 3b. Deleting it asks with the APP's card, not the browser's box (owner,
  //     2026-09-23). Ten questions were still `window.confirm`, and this is
  //     one of them — which is also why this check bites on the old code:
  //     puppeteer dismisses a native dialog on sight, so there is no `.ask`
  //     to find and nothing is ever deleted.
  await clickText('#screenSecret .btn.danger', /^Delete this secret$/);
  await page.waitForSelector('.ask', { timeout: 5_000 }).catch(() => {});
  const secretAsk = await page.evaluate(`(() => {
    var card = document.querySelector('.ask');
    if (!card) return null;
    var danger = card.querySelector('.btn.danger');
    return {
      words: (card.textContent || '').replace(/\\s+/g, ' ').trim(),
      onTop: card.contains(document.elementFromPoint(window.innerWidth / 2, card.getBoundingClientRect().top + 8)),
      verb: danger ? (danger.textContent || '').trim() : null,
      filled: danger ? getComputedStyle(danger).backgroundColor : null,
    };
  })()`) as { words: string; onTop: boolean; verb: string | null; filled: string | null } | null;
  check('deleting a secret asks on the app\u2019s own card, naming what it costs',
    Boolean(secretAsk) && secretAsk!.words.includes('Delete GH_TOKEN?')
    && secretAsk!.words.includes('the value is gone for good') && secretAsk!.onTop === true,
    JSON.stringify(secretAsk));
  check('\u2026with the red WORD as its answer, no slab behind it (note #624)',
    secretAsk?.verb === 'Delete' && secretAsk?.filled === 'rgba(0, 0, 0, 0)', JSON.stringify(secretAsk));
  await shotOrg('secret-delete-ask');
  await clickText('.ask .btn', /^Cancel$/);
  check('\u2026and Cancel leaves the secret exactly where it was',
    !(await page.$('.ask')) && Boolean(await page.$('#secretCard')) && page.url().includes('/secrets/GH_TOKEN'),
    page.url());

  // 4. The workplace screen and the seats.
  const [me] = await userStorage.getAllUsers();
  const [orgDoc] = await orgStorage.listOrgs();
  if (!me || !orgDoc) throw new Error('no user or workplace after founding');
  // The one the setup fixture already joined this member with (see
  // `harnessEstablishedWorkplace`): the lock needs a live seat to exist
  // BEFORE the founding flow can land anywhere, and a second one added here
  // would be a third subscription under the checks below that count two.
  const [seeded] = await orgStorage.listSeatsByMember(orgDoc.orgId, me.userId);
  if (!seeded) throw new Error('the setup fixture joined this member with no seat');
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
  await page.goto(`${ORIGIN}/workplace?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgPeopleDoor', { timeout: 10_000 }).catch(() => {});
  check('the workplace screen names its people', (await text('#orgSub')) === 'One person · you’re an admin', await text('#orgSub'));
  check('…and wears one door onto them (note #328)', (await text('#orgPeopleDoor')) === 'PeopleJust you', await text('#orgPeopleDoor'));
  check('the invites block stands for an admin', Boolean(await page.$('#orgInvites')));
  check('the sole admin has no extra membership or blocker footer',
    !(await page.$('#orgActions')) && !(await page.$('#orgDangerHint')));
  heads.organization = await headShape(page);
  await shotOrg('organization');

  // 4a. NOTE #328: the People page, drawn like the fleet. A second member
  //     who was here two hours ago and last approved a proposal; the founder
  //     — this browser — is here now, which the page learns from its own
  //     requests and the tick, not from anything seeded.
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000 - 60_000).toISOString();
  await userStorage.createProfile('user-mira', { email: 'mira@example.com', displayName: 'Mira Chen' });
  await orgStorage.addMember({ orgId: orgDoc.orgId, userId: 'user-mira', role: 'member', invitedByUserId: me.userId });
  // A fleet of her own, so "how many" is a number worth printing and the
  // names below are names that really exist to be leaked (note #346).
  await userStorage.updateProfile('user-mira', {
    telegram: {
      chatId: '9', linkedAt: new Date().toISOString(), notificationsEnabled: true, telegramUserId: '99',
      agents: Object.fromEntries(['Nan', 'Otto', 'Pim'].map((name, index) => [name.toLowerCase(), {
        id: name.toLowerCase(), name, cli: 'claude', orgId: orgDoc.orgId,
        createdAt: new Date(Date.now() - (index + 1) * 86_400_000).toISOString(),
        recap: { text: `${name} is mid-way through the pricing rewrite.`, at: twoHoursAgo },
      }])),
    } as never,
  });
  await orgStorage.touchMember(orgDoc.orgId, 'user-mira', {
    lastSeenAt: twoHoursAgo, recap: { text: 'Approved proposal #12: Pricing page redesign', at: twoHoursAgo },
  });
  // Her own address on the mail domain — what the admin reads on her
  // screen as where to reach her (note #626).
  await mailbox.mailboxes.claim('user-mira', 'mira');
  await page.click('#orgPeopleDoor');
  await page.waitForSelector('#people .crow', { timeout: 10_000 });
  check('the door opens the People page at its own address', page.url() === `${ORIGIN}/workplace/people?org=${orgDoc.orgId}`, page.url());
  check('the page counts its people and who is here', (await text('#peopleSub')) === 'Northstar Studio · 2 people · 1 here now', await text('#peopleSub'));
  const plates = await page.$$eval('#people .crow', (nodes) => nodes.map((node) => ({
    name: node.querySelector('.name')?.textContent ?? '',
    facts: node.querySelector('.personname')?.textContent ?? '',
    agentLines: node.querySelectorAll('.cagent').length,
    state: node.querySelector('.cline .ctext')?.textContent ?? '',
    live: Boolean(node.querySelector('.livedot')),
    recap: node.querySelector('.cabout')?.textContent ?? '',
    width: Math.round(node.getBoundingClientRect().width),
  })));
  check('the reader leads, here now, with a live dot', plates[0]?.name === 'saddam Harness' && plates[0]?.facts === 'saddam HarnessYouAdmin' && plates[0]?.state === 'Here now' && plates[0]?.live === true, JSON.stringify(plates[0]));
  check('the teammate says when she was last here and what she last drove',
    plates[1]?.name === 'Mira Chen' && plates[1]?.facts === 'Mira Chen' && plates[1]?.agentLines === 3 && plates[1]?.state === 'Active 2h ago'
    && plates[1]?.recap === 'Approved proposal #12: Pricing page redesign', JSON.stringify(plates[1]));
  // One column on a phone since note #833: a person's card carries their
  // agents' recaps, which wrapped every two words at half a phone.
  check('on a phone each person\u2019s card takes the whole width', plates.length === 2 && plates[0]!.width === plates[1]!.width && plates[0]!.width > 300, JSON.stringify(plates.map((plate) => plate.width)));
  heads.people = await headShape(page);
  await shotOrg('people');
  // Her name, not the plate's middle: since 2026-10-28 the middle holds her
  // agents' lines, and each of those opens its agent.
  await page.click('#people .crow:nth-child(2) .name');
  await page.waitForSelector('#orgMemberCard', { timeout: 10_000 });
  check('a plate opens the member, who says when she was seen and her latest line',
    (await text('#orgMemberCard')).includes('SeenActive 2h ago') && (await text('#orgMemberCard')).includes('LatestApproved proposal #12'), await text('#orgMemberCard'));
  // NOTE #346 took off a second card naming every agent she drives with its
  // latest-work line; the owner's rule of 2026-09-23 (a person's agents are
  // never hidden from the rest of the workplace) put back which agents —
  // name and face, in the Agents row — and Adam's of 2026-10-28 what each is
  // doing: Working or Idle, and its recap, still in that one row.
  check('…and how many agents she drives', (await text('#orgMemberAgents .v')) === '3 agents', await text('#orgMemberAgents'));
  const miraAgents = await page.$$eval('#orgMemberAgents .memberagent .mname', (nodes) => nodes.map((node) => node.textContent ?? ''));
  check('…and which, each by name and face',
    [...miraAgents].sort().join('|') === 'Nan|Otto|Pim'
    && (await page.$$('#orgMemberAgents .memberagent .avatar, #orgMemberAgents .memberagent .icon')).length === 3,
    miraAgents.join('|'));
  check('…and what each is doing, in that row and in no card of its own',
    /pricing rewrite/.test(await text('#orgMemberAgents')) && !(await page.$('#orgMemberAgentsCard'))
    && (await page.$$('#orgMemberAgents .memberagent .mstate')).length === 3,
    await text('#orgMemberAgents'));
  // The line under her name already says which workplace she belongs to; the card
  // no longer repeats it as a row of its own.
  check('…and no Role row repeating the header', !(await text('#orgMemberCard')).includes('Role'), await text('#orgMemberCard'));
  const miraEmail = await text('#orgMemberEmail');
  check('…and, to the admin reading it, her email — a door, not a mailto: link (note #626)',
    /^Emailmira@/.test(miraEmail) && !(await page.$('#orgMemberEmail a')) && Boolean(await page.$('#orgMemberEmail button.v.act')),
    miraEmail);
  await shotOrg('people-member');
  // Removing her asked with the BROWSER's box until 2026-09-23 — a question
  // no stylesheet reached and, because a native dialog blocks the renderer,
  // one no check here could even click. It is the app's card now, red where
  // the act retires her agents, and Cancel is still the safe direction.
  await clickText('#screenOrgMember .btn.danger', /^Remove from workplace$/);
  await page.waitForSelector('.ask', { timeout: 5_000 }).catch(() => {});
  const removeAsk = await page.evaluate(`(() => {
    var card = document.querySelector('.ask');
    if (!card) return null;
    var danger = card.querySelector('.btn.danger');
    return { words: (card.textContent || '').replace(/\\s+/g, ' ').trim(), verb: danger ? (danger.textContent || '').trim() : null };
  })()`) as { words: string; verb: string | null } | null;
  check('removing a member asks on the app\u2019s card, saying what becomes of her agents',
    Boolean(removeAsk) && removeAsk!.words.includes('Remove Mira Chen from')
    && removeAsk!.words.includes('permanently retired') && removeAsk!.verb === 'Remove',
    JSON.stringify(removeAsk));
  await shotOrg('people-member-remove-ask');
  await clickText('.ask .btn', /^Cancel$/);
  await page.waitForSelector('#orgMemberCard', { timeout: 10_000 });
  check('\u2026and Cancel leaves her in the workplace',
    !(await page.$('.ask')) && Boolean(await page.$('#orgMemberCard'))
    && (await text('#screenOrgMember .btn.danger')) === 'Remove from workplace',
    `${page.url()} \u00b7 ${await text('#screenOrgMember .btn.danger')}`);
  const memberUrl = page.url();
  // Into the middle of the screen first: since the contribution card (note
  // #925) made the screen taller, the scroll back from Remove stopped with
  // this row under the sticky title, where a click lands on the title.
  await page.$eval('#orgMemberEmail button.v.act', (node) => node.scrollIntoView({ block: 'center' }));
  await page.click('#orgMemberEmail button.v.act');
  await page.waitForSelector('#screenMailCompose', { timeout: 10_000 });
  const writingTo = await page.$eval('#mailToField', (node) => (node as HTMLInputElement).value);
  check('…which opens the Workspace\'s own composer, written to her', /^mira@/.test(writingTo), writingTo);
  await shotOrg('people-member-write');
  await page.click('#pageBack');
  await page.waitForSelector('#orgMemberCard', { timeout: 10_000 });
  check('…and Back from it returns to her screen', page.url() === memberUrl, page.url());
  // The presence branch, which Mira (here two hours ago) cannot render: the
  // reader's own screen wears the plate's breathing disc beside "Here now".
  // Sizing on this page is by CONTEXT, so a disc nobody named renders at no
  // size at all — which is why this is measured and not just asserted.
  await page.goto(`${ORIGIN}/workplace/members/${me.userId}?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgMemberCard', { timeout: 10_000 });
  const seen = await page.$eval('#orgMemberCard .livevalue', (node) => {
    const dot = node.querySelector('.livedot');
    const box = dot?.getBoundingClientRect();
    return {
      said: node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      size: box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'no dot',
      breathes: dot ? getComputedStyle(dot).animationName : '',
    };
  });
  check('the reader\'s own screen marks "Here now" with the plate\'s breathing disc',
    seen.said === 'Here now' && seen.size === '6x6' && seen.breathes === 'breathe', JSON.stringify(seen));
  // Nothing came with the workplace (note #726): the founder's agents are
  // the Chief of Staff's to bring in, and this road never asked it to.
  check('…and counts no agents yet — founding brought none', (await text('#orgMemberAgents .v')) === 'No agents yet', await text('#orgMemberAgents'));
  check('…and the reader\'s own email', /^Emailsaddam@/.test(await text('#orgMemberEmail')), await text('#orgMemberEmail'));
  await shotOrg('people-member-you');
  await page.goto(`${ORIGIN}/workplace?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgPeopleDoor', { timeout: 10_000 }).catch(() => {});
  check('the door now counts two, one here', (await text('#orgPeopleDoor')) === 'People2 people · 1 here now', await text('#orgPeopleDoor'));
  await orgStorage.removeMember(orgDoc.orgId, 'user-mira');
  // The address this screen had until note #355 renamed it, asked for as a
  // browser would ask — a bookmark, or a link pasted into a note.
  await page.goto(`${ORIGIN}/organization/spending?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgSpendList .spendrow', { timeout: 10_000 });
  check('the screen\u2019s old address still arrives, workplace and all',
    page.url() === `${ORIGIN}/workplace/cloud?org=${orgDoc.orgId}`, page.url());
  await page.goto(`${ORIGIN}/workplace/cloud?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgSpendList .spendrow', { timeout: 10_000 });
  // The name now carries the human the agent works for (note #336): an
  // workplace runs a machine per agent, and "whose is this one?" is the
  // question a bill-payer asks of every row.
  check('the spend row names its agent, and whose agent it is', (await text('#orgSpendList .spendrow .name')) === 'Ada (saddam)', await text('#orgSpendList .spendrow .name'));
  check('the spend row shows accumulated awake time', (await text('#orgSpendList .spendrow .spendfacts')).includes('10h 27m awake this month'), await text('#orgSpendList .spendrow .spendfacts'));
  check('the spend row shows its hourly rate and what the month has cost', (await text('#orgSpendList .spendrow .spendfacts')).includes('$0.172/hour awake') && (await text('#orgSpendList .spendrow .spendtotal')) === '~$2.55so far this month', await text('#orgSpendList .spendrow'));
  // Every row's state as a reader meets it: the word, and the mark in front
  // of it (note #336). No named inner function — esbuild's keepNames wraps
  // one in `__name`, which does not exist in the page.
  const states = await page.$$eval('#orgSpendList .spendrow', (rows) => rows.map((row) => {
    const dot = row.querySelector('.cline .statedot');
    const box = dot?.getBoundingClientRect();
    return {
      line: row.querySelector('.cline')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      size: box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '',
      fill: dot ? getComputedStyle(dot).backgroundColor : '',
      hidden: dot?.getAttribute('aria-hidden') ?? '',
      // WHERE the mark sits, measured against the state word itself — the
      // text node the disc is glued to. A range around that text is the only
      // way to ask where a bare word is, and the two numbers say the mark
      // leads its own word by its own margin (5px) and shares the word's
      // line rather than floating above or below it.
      ...(() => {
        const word = dot?.nextSibling;
        if (!dot || !box || !word) return { gap: -1, onItsLine: false };
        const range = document.createRange();
        range.selectNode(word);
        const wordBox = range.getBoundingClientRect();
        return {
          gap: Math.round(wordBox.left - box.right),
          onItsLine: box.top >= wordBox.top && box.bottom <= wordBox.bottom,
        };
      })(),
    };
  }));
  check('an awake machine is marked in the fleet’s own live blue, and still says the word',
    states[0]?.line === 'Agent machine · running · performance-4x 8GB'
    // Royal blue since 2026-09-09 (f5157be4), which is the accent the fleet
    // marks a live machine with.
    && states[0]?.size === '6x6' && states[0]?.fill === 'rgb(26, 104, 216)'
    && states[0]?.gap === 5 && states[0]?.onItsLine === true, JSON.stringify(states[0]));
  check('…an asleep one wears the same disc in grey, and still says that word too',
    states[2]?.line === 'ia-agent00000002 · asleep · performance-4x 8GB'
    && states[2]?.size === '6x6' && states[2]?.fill !== states[0]?.fill, JSON.stringify(states[2]));
  check('…and neither mark is read out, because the word beside it already is',
    states.every((state) => state.hidden === 'true'), JSON.stringify(states.map((state) => state.hidden)));
  // NOTE #375: that asleep row belongs to no agent, and was called "Agent
  // machine" — which reads as an agent whose name failed to load rather than
  // as a fact. It is named for what it is now, and MEASURED here because
  // `.card` clips its overflow in silence: a name too wide for the column is
  // not a wrapped name, it is a missing one. No named inner function — see
  // the states read above.
  const leftover = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#orgSpendList .spendrow')]
      .find((node) => (node.querySelector('.nametext')?.textContent ?? '').includes('Leftover'));
    if (!row) return { found: false };
    const name = row.querySelector('.nametext') as HTMLElement;
    const card = row.closest('.card') as HTMLElement;
    return {
      found: true,
      name: name.textContent ?? '',
      whole: name.scrollWidth <= name.clientWidth + 1
        && Math.round(name.getBoundingClientRect().right) <= Math.round(card.getBoundingClientRect().right),
      // Nowhere to go and nobody to picture: the kind's glyph, and no door.
      glyph: Boolean(row.querySelector('.spendname .icon svg')),
      door: Boolean(row.querySelector('.facebtn')),
    };
  });
  check('a machine no agent claims is named for what it is, whole and inside its card',
    leftover.found === true && leftover.name === 'Leftover machine'
    && leftover.whole === true && leftover.glyph === true && leftover.door === false,
    JSON.stringify(leftover));
  check('…and the hint under the list says how one of those comes to exist, and what it costs',
    (await text('#orgSpendHint')).includes(
      'One machine here belongs to no agent — left over from a setup that never finished, '
      + 'or from an agent that is gone. Nothing runs on it, and asleep it costs only its storage.',
    ),
    await text('#orgSpendHint'));
  // NOTE #635: what another workplace runs in this same account is the
  // server's to leave out and this screen's to COUNT — one row at the foot of
  // the list, whole inside its card on a phone, with a glyph and no door and
  // no money. Measured for the reason the leftover's name is: `.card` clips
  // its overflow in silence. Put back afterwards, so every check below reads
  // the page it always did.
  spendElsewhere = 3;
  await page.goto(`${ORIGIN}/workplace/cloud?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgSpendElsewhere', { timeout: 10_000 }).catch(() => {});
  const elsewhere = await page.evaluate(() => {
    const row = document.getElementById('orgSpendElsewhere');
    const list = document.getElementById('orgSpendList');
    if (!row || !list) return { found: false };
    const name = row.querySelector('.nametext') as HTMLElement;
    const card = row.closest('.card') as HTMLElement;
    return {
      found: true,
      last: list.lastElementChild === row,
      rows: list.querySelectorAll('.spendrow').length,
      name: name.textContent ?? '',
      line: row.querySelector('.cline')?.textContent ?? '',
      whole: name.scrollWidth <= name.clientWidth + 1
        && Math.round(row.getBoundingClientRect().right) <= Math.round(card.getBoundingClientRect().right),
      glyph: Boolean(row.querySelector('.spendname .icon svg')),
      door: Boolean(row.querySelector('.facebtn, a, button')),
      money: Boolean(row.querySelector('.spendtotal')),
    };
  });
  check('machines of other workplaces are one counted row at the foot of the list, whole inside its card',
    elsewhere.found === true && elsewhere.last === true && elsewhere.rows === 4
    && elsewhere.name === '3 machines outside this workplace'
    && elsewhere.line === 'In this cloud account too · not listed here or in the total'
    && elsewhere.whole === true && elsewhere.glyph === true && elsewhere.door === false && elsewhere.money === false,
    JSON.stringify(elsewhere));
  check('…and the hint says whose they are, and that the total at the top leaves them out',
    (await text('#orgSpendHint')).includes(
      'The 3 machines outside this workplace run in this cloud account but belong to other workplaces, so they are only counted: '
      + 'they are not in the total at the top, though this account’s bill includes them.',
    ),
    await text('#orgSpendHint'));
  await shotOrg('cloud-elsewhere');
  spendElsewhere = 0;
  await page.goto(`${ORIGIN}/workplace/cloud?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgSpendList .spendrow', { timeout: 10_000 });
  // 4a-2. NOTE #355: the screen is the CLOUD's screen, not a bill — so the
  //       one thing a reader can decide stands above the machines, and
  //       deciding it writes the workplace's own record.
  check('the screen is named for the cloud, and the machines are a section of it',
    (await page.$eval('#pageId', (node) => node.textContent?.trim() ?? '')) === 'Cloud'
    && (await page.$$eval('#screenOrgCloud h2', (nodes) => nodes.map((node) => node.textContent?.trim())))
      .join('|') === 'New agents|Machines',
    await text('#pageId'));
  check('…and it says what a new agent is built on, above the machines',
    (await text('#orgNewAgentCard')) === '2 dedicated cores · 4 GBabout $0.09 an hour awake · standard'
    && await page.evaluate(() => {
      const card = document.getElementById('orgNewAgentCard');
      const list = document.getElementById('orgSpendList');
      return Boolean(card && list
        && (card.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    }),
    await text('#orgNewAgentCard'));
  heads.cloud = await headShape(page);
  await shotOrg('cloud');
  await page.click('#orgNewAgentRow');
  await page.waitForSelector('#orgMachineDedicated [data-size]', { timeout: 10_000 });
  const rungs = await page.$$eval('#screenOrgMachine [data-size]', (nodes) => nodes.map((node) => ({
    id: node.getAttribute('data-size') ?? '',
    tag: node.tagName,
    badge: node.querySelector('.badge')?.textContent?.trim() ?? '',
  })));
  check('the ladder marks the rung in force and offers the rest',
    rungs.length === 7
    && rungs.filter((rung) => rung.badge === 'current').length === 1
    && rungs.find((rung) => rung.id === 'performance-2x')?.badge === 'current'
    && rungs.find((rung) => rung.id === 'performance-2x')?.tag === 'DIV'
    && rungs.find((rung) => rung.id === 'performance-4x')?.tag === 'BUTTON',
    JSON.stringify(rungs));
  await shotOrg('new-agent-machine');
  await page.click('[data-size="performance-4x"]');
  await page.waitForSelector('#orgMachineDone', { timeout: 10_000 });
  check('choosing one says so where the thumb is, and moves the badge',
    (await text('#orgMachineDone')).startsWith('Saved. New agents are built on 4 dedicated cores · 8 GB.')
    && (await page.$eval('[data-size="performance-4x"] .badge', (node) => node.textContent?.trim())) === 'current',
    await text('#orgMachineDone'));
  // The whole point of the screen, checked at the far end of it: the
  // workplace's own record now says what its new agents are built on, and
  // that is the field `resolveAgentMachineSize` reads at provisioning time.
  check('…and the workplace record itself carries the choice',
    (await orgStorage.getOrg(orgDoc.orgId))?.agentMachineSizeId === 'performance-4x',
    String((await orgStorage.getOrg(orgDoc.orgId))?.agentMachineSizeId));
  await page.click('#pageBack');
  await page.waitForSelector('#orgNewAgentCard', { timeout: 10_000 });
  check('…and Back leaves the row saying what was chosen',
    (await text('#orgNewAgentCard')) === '4 dedicated cores · 8 GBabout $0.17 an hour awake',
    await text('#orgNewAgentCard'));
  await shotOrg('cloud-chosen');
  // Put it back, so the section below measures the wait against the same
  // fixture every other check here reads.
  await orgStorage.updateOrg(orgDoc.orgId, { agentMachineSizeId: undefined } as never);
  // 4b. NOTE #314, both halves. The screen waits in the SHAPE of the list
  //     that is coming rather than behind the word "Loading", and it opens at
  //     its own top however far down the workplace screen the reader was.
  //
  //     The two are one section on purpose. Until this wait existed the spend
  //     screen was one short box while its read was out, so the document was
  //     never tall enough to hold ANY offset and the browser clamped it to
  //     zero for free — "it opens at its top" was true by accident and could
  //     not fail. A wait with a shape is what makes the placement in
  //     `chrome/place-scroll.ts` load-bearing here, so it is what makes this
  //     check mean something. (That file's own harness is
  //     verify-workspace-react-scroll.mts; the fixture for these two screens
  //     lives here.)
  {
    // A window a phone's height would hide the whole question: at 860 neither
    // screen is tall enough to scroll and every landing line is zero.
    await page.setViewport({ width: 420, height: 420, deviceScaleFactor: 2 });
    spendDelayMs = 1500;
    spendMachines = () => MANY_MACHINES;
    // The door only stands on the workplace screen when a cloud account is
    // connected, and it is the door the reader actually taps.
    await orgStorage.updateOrg(orgDoc.orgId, {
      fly: { orgSlug: 'nomad-trading', wireguard: { peerName: 'p', peerIp: 'fdaa::1', endpoint: 'ams.gw', gatewayPubkey: 'k' } },
    } as never);
    const where = () => page.evaluate(() => ({
      y: Math.round(window.scrollY),
      reach: Math.round(document.documentElement.scrollHeight - window.innerHeight),
    }));
    /** The first machine row: how tall it is, and where it sits INSIDE the
     *  card, plus where the card itself starts. No named inner function:
     *  esbuild's keepNames wraps one in `__name`, which does not exist in the
     *  page. */
    const firstRow = () => page.evaluate(() => {
      const row = document.querySelector('#orgSpendList .spendrow');
      // The MACHINES' card, which is no longer the first one on the screen:
      // what new agents are built on stands above it (note #355).
      const card = document.querySelector('#orgSpendList')?.closest('.card');
      if (!row || !card) return null;
      const rowBox = row.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      return {
        h: Math.round(rowBox.height),
        inCard: Math.round(rowBox.top - cardBox.top),
        cardTop: Math.round(cardBox.top + window.scrollY),
      };
    });
    const settle = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

    await page.goto(`${ORIGIN}/workplace?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#orgCloudCard', { timeout: 10_000 });
    await settle(400);
    const orgScrollTarget = await page.evaluate(() => Math.min(
      400,
      document.documentElement.scrollHeight - window.innerHeight,
    ));
    // The flick comes first: since note #405 a screen holds its line for the
    // beat after it lands and gives it up the instant a reader asks for the
    // page, so a bare `scrollTo` here would be modelling something a reader
    // cannot do — move the page leaving no sign that they touched it.
    await page.evaluate((target) => {
      window.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
      window.scrollTo(0, target);
    }, orgScrollTarget);
    await settle(250);
    const onOrg = await where();
    check('the reader is a long way down the workplace screen',
      orgScrollTarget >= 200 && onOrg.y === orgScrollTarget, JSON.stringify(onOrg));

    // Tapped, not `goto`: a reload resets the scroll by itself and would
    // prove nothing about what the shell does on a navigation.
    await page.evaluate(() => {
      const door = [...document.querySelectorAll('button.addrow')]
        .find((node) => /See cloud details/.test(node.textContent ?? ''));
      (door as HTMLElement).click();
    });
    await page.waitForSelector('#screenOrgCloud', { timeout: 10_000 });
    await page.waitForSelector('#orgSpendList .skel', { timeout: 10_000 });

    check('the wait is the shape of the list, not the word “Loading”',
      (await page.$$eval('#orgSpendList .spendrow', (nodes) => nodes.length)) === 3
      && !(await page.$eval('#screenOrgCloud', (node) => node.textContent ?? '')).includes('Loading…'),
      await text('#orgSpendList'));
    check('…and it says so once, for a reader who cannot see it',
      (await page.$eval('#screenOrgCloud', (node) => node.getAttribute('aria-busy'))) === 'true'
      && (await page.$eval('#screenOrgCloud .sr-only', (node) => node.textContent ?? '')) === 'Loading the cloud account…');

    const held = await where();
    check('the cloud screen opens at its own top', held.y === 0, JSON.stringify(held));
    check('…and its wait was tall enough to have opened somewhere else',
      held.reach > 0, JSON.stringify(held));
    const heldRow = await firstRow();
    await shotOrg('cloud-wait');

    // The wait's whole promise: the answer lands in the boxes the wait was
    // holding, so nothing moves under a reader who has already started
    // reading. Measured, because "it looks about right" is how a wait drifts.
    await page.waitForFunction(() => document.querySelector('#orgSpendList .skel') === null, { timeout: 10_000 });
    await settle(300);
    const answeredRow = await firstRow();
    // NEVER TALLER, rather than exactly equal. The promise this guards is
    // that nothing moves UP under a reader — and only over-drawing does that.
    // Demanding the two heights MATCH asks the hold to predict how the words
    // will wrap, which depends on the font the machine happens to have: the
    // same row measures 84px here, 100px under Noto Sans, and 117px on a box
    // with no proper sans at all. This check passed for months because CI's
    // font made the answer wrap exactly where the hold did, and went red the
    // moment a font was installed — the assertion catching the machine, not
    // the screen. A hold that comes up SHORT grows downward when the answer
    // lands, which `place-scroll` already waits out; that is the direction
    // `CloudWait` says to err in, so it is the direction this allows.
    check('the machine row never lands in a box smaller than its wait was holding',
      Boolean(heldRow && answeredRow) && heldRow!.h <= answeredRow!.h && heldRow!.inCard === answeredRow!.inCard,
      `held ${JSON.stringify(heldRow)} · answered ${JSON.stringify(answeredRow)}`);
    // The card can still start slightly lower than it was held, and only
    // lower: the summary line above it is one line here and wraps to two when
    // the money is long, and that height cannot be known before the read.
    // Held SHORT on purpose (see `CloudWait` in OrgCloudScreen.tsx) — a wait
    // that over-draws pulls the page UP when the answer lands, which is both
    // the worse direction to move a reader and the one `place-scroll.ts`
    // cannot wait out.
    const settled = answeredRow!.cardTop - heldRow!.cardTop;
    check('…and the card settles downward by at most the summary line, never up',
      settled >= 0 && settled <= 24, `moved ${settled}px`);
    const answered = await where();
    check('…and the reader is still at the top once it has',
      answered.y === 0 && answered.reach > 0, JSON.stringify(answered));

    // The other direction is the half that must NOT be reset: Back owes the
    // workplace screen the line the reader left it on.
    await page.click('#pageBack');
    await page.waitForSelector('#orgCloudCard', { timeout: 10_000 });
    await settle(900);
    const backOnOrg = await where();
    check('Back hands the workplace screen the line it was on',
      backOnOrg.y === orgScrollTarget, JSON.stringify(backOnOrg));

    spendDelayMs = 0;
    spendMachines = () => SEEDED_MACHINES;
    await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  }

  await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#seatsList .crow') !== null, { timeout: 10_000 }).catch(() => {});
  check('the seeded seat is listed', (await text('#seatsList .crow .name')).startsWith('Claude · signed in today'), await text('#seatsList .crow .name'));
  await page.click('#seatsList .crow');
  await page.waitForSelector('#seatCard', { timeout: 10_000 });
  check('a seat opens at its own address', /\/seats\/[^/?]+\?org=/.test(page.url()), page.url());
  // The pace of every window, against the even spend its own length implies:
  // a tick on the meter and the sentence that reads it (notes #279, #341).
  const paces = await page.$$eval('#seatUsageCard .usage-pace', (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''));
  check('the fast session window forecasts in its own hours, not a week\u2019s', /^\d+% ahead of an even pace · gone in 1h \d+m$/.test(paces[0] ?? ''), paces[0]);
  check('the under-pace week says how far under without forecasting its end', /^\d+% under an even pace$/.test(paces[1] ?? ''), paces[1]);
  check('the fast week says how far ahead, and when it is gone', /^\d+% ahead of an even pace · gone in .+$/.test(paces[2] ?? ''), paces[2]);
  check('only the fast ones are coloured', (await page.$$eval('#seatUsageCard .usage-pace.warn', (nodes) => nodes.length)) === 2);
  check('every window on the card is paced', paces.length === 3, String(paces.length));
  // The tick sits where an even spend would be, not where the fill ends —
  // a quarter into the session, three sevenths into the week.
  const marks = await page.$$eval('#seatUsageCard .meter-pace', (nodes) => nodes.map((node) => Number.parseFloat((node as HTMLElement).style.left)));
  check('each meter carries the even-pace tick', marks.length === 3 && marks[0]! > 26 && marks[0]! < 28
    && marks.slice(1).every((left) => left > 42 && left < 44), marks.join(' | '));
  heads.seat = await headShape(page);
  await shotOrg('seat');

  // 4d. NOTE #326: the subscription item says whether agents are ON it.
  //     One dot, the fleet's own. The words there used to be drawn from
  //     `selected` plus a current reading, which is a fact about ASSIGNMENT
  //     — they claimed use on a primary nobody had touched and said nothing
  //     at all on a fallback an agent was pinned to. A second sign-in and a
  //     two-agent fleet make the difference visible: one seat is primary,
  //     the other is only worked.
  const fallbackSeat = await orgStorage.addSeat({ orgId: orgDoc.orgId, userId: me.userId, provider: 'claude', token: 'seat-token-2', label: 'Claude · the older one', status: 'active' } as never);
  // A new seat is selected on arrival, so hand primary back to the seeded
  // one: the case under test needs a fallback that is genuinely not primary.
  await orgStorage.selectSeat(seeded.seatId, orgDoc.orgId);
  await orgStorage.updateSeat(fallbackSeat.seatId, {
    usage: {
      capturedAt: new Date().toISOString(),
      planType: 'max_5x',
      windows: { five_hour: { id: 'five_hour', usedPercent: 12, windowDurationMins: 300, resetsAt: Math.round(Date.now() / 1000) + 51 * 60 } },
    },
    usageRefreshedAt: new Date().toISOString(),
  });
  const [meNow] = await userStorage.getAllUsers();
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(meNow?.telegram ?? {}),
      agents: {
        // Unpinned: it leases whichever Claude seat is primary.
        ada: {
          id: 'ada', name: 'Ada', cli: 'claude', orgId: orgDoc.orgId,
          createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), serverId: 'm1',
          connectedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          // A runtime and a recap of its own (note #359): the card its face
          // raises on the cloud screen can then be checked against facts the
          // machine row does not carry, which is the whole claim — that the
          // card is read off the live fleet and not off the row.
          model: 'opus', effort: 'high',
          recap: { text: 'Rebased slice 4 on main and re-ran the checks.', at: new Date(Date.now() - 30 * 60_000).toISOString() },
        },
        // PINNED to the fallback (note #129): the seat its turns really spend.
        bo: {
          id: 'bo', name: 'Bo', cli: 'claude', orgId: orgDoc.orgId,
          seatId: fallbackSeat.seatId,
          createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), serverId: 'm2',
          connectedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          lastActivityAt: new Date(Date.now() - 90 * 60_000).toISOString(),
        },
      } as never,
    },
  });

  /** One subscription item on Home, found by the plan that names it. */
  const subMark = async (plan: string) => page.evaluate((want: string) => {
    const card = [...document.querySelectorAll('#seatsHome .seatcard')]
      .find((node) => node.querySelector('.plan')?.textContent?.trim() === want);
    if (!card) return null;
    const name = card.querySelector('.seathead .name')!.getBoundingClientRect();
    const plate = card.querySelector('.plan')?.getBoundingClientRect() ?? null;
    const dot = card.querySelector('.seatdot');
    const box = dot?.getBoundingClientRect() ?? null;
    return {
      height: Math.round(card.getBoundingClientRect().height),
      // What a reader who cannot see the colour is told instead.
      said: card.querySelector('.seathead .sr-only')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      hidden: dot?.getAttribute('aria-hidden') ?? '',
      size: box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '',
      fill: dot ? getComputedStyle(dot).backgroundColor : '',
      breathes: dot ? getComputedStyle(dot).animationName : '',
      // It stands at the END of the title, past the plan: leading it would
      // indent the name by its own width on exactly the items that are live.
      afterThePlan: Boolean(box) && Boolean(plate) && box!.left >= plate!.right,
      // …and on the title's own line, so the compact card stays two lines.
      onTheLine: Boolean(box) && box!.top >= name.top - 0.5 && box!.bottom <= name.bottom + 0.5,
    };
  }, plan);

  // The sign-ins belong to the workplace, so they are in the WORKPLACE
  // window (note #715). Every measurement below would read nothing in the
  // agents picker — and worse, the "nothing is marked" checks would PASS on
  // it for the wrong reason.
  await page.goto(`${ORIGIN}/?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  check('Home’s Workplace window stands with both sign-ins on it', await waitHome('workplace') && (await page.$$('#seatsHome .seatcard')).length === 2, String((await page.$$('#seatsHome .seatcard')).length));

  // NOTE #471: Home must not ask for a sideways gesture. The subscriptions
  // wrap inside its reading column, and every plate — including the door —
  // is reachable in the page's one vertical flow. The same shared strip on
  // a note remains sideways; these measurements name Home's instance.
  await page.setViewport({ width: 390, height: 860, deviceScaleFactor: 2 });
  const strip = await page.evaluate(() => {
    const row = document.getElementById('seatsHome')!;
    const plates = [...row.children] as HTMLElement[];
    const tops = new Set(plates.map((node) => Math.round(node.getBoundingClientRect().top)));
    const heights = new Set(plates.map((node) => Math.round(node.getBoundingClientRect().height)));
    const box = row.getBoundingClientRect();
    return {
      wrapped: tops.size > 1,
      // Equal height: a plate is a plate whether it carries three readings
      // or none, so the wrapped set cannot look ragged.
      levelled: heights.size === 1,
      noSideways: row.scrollWidth <= row.clientWidth + 1,
      // Home's strip stays inside the reading column rather than pulling
      // itself to the phone edges.
      bounded: box.left > 0 && box.right < window.innerWidth,
      // Neither the strip nor its children can widen the page.
      pageStill: document.documentElement.scrollWidth <= window.innerWidth + 1,
      allVisible: plates.every((node) => {
        const plate = node.getBoundingClientRect();
        return plate.left >= box.left - 1 && plate.right <= box.right + 1;
      }),
      lastIsTheDoor: plates[plates.length - 1].classList.contains('seatadd'),
      doorHasNoIcon: plates[plates.length - 1].querySelector('.icon') === null,
      // The plan that tells two Claude sign-ins apart (#142) is never the
      // thing a narrow plate drops.
      whole: [...row.querySelectorAll('.seathead .name .label, .seathead .name .plan')]
        .every((node) => node.scrollWidth <= node.clientWidth + 1),
    };
  });
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  check('Home wraps the sign-ins as level plates with no sideways strip',
    strip.wrapped && strip.levelled && strip.noSideways && strip.lastIsTheDoor, JSON.stringify(strip));
  check('…inside its reading column without giving the page horizontal scroll',
    strip.bounded && strip.pageStill && strip.allVisible, JSON.stringify(strip));
  check('…with the Add sub door wholly visible and no title clipped',
    strip.allVisible && strip.whole && strip.doorHasNoIcon, JSON.stringify(strip));

  const quietPrimary = await subMark('Max 20x');
  const quietFallback = await subMark('Max 5x');
  check('with nobody mid-turn NEITHER sign-in is marked — primary is not used',
    quietPrimary?.size === '' && quietFallback?.size === '',
    `${JSON.stringify(quietPrimary)} | ${JSON.stringify(quietFallback)}`);
  check('…and nothing is claimed to a reader who cannot see the colour',
    quietPrimary?.said === '' && quietFallback?.said === '',
    `${quietPrimary?.said} | ${quietFallback?.said}`);
  await shotOrg('subs-quiet');

  // Now a turn on each: one through the pin, one through the primary.
  workingNow.add('bo');
  await page.goto(`${ORIGIN}/?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await waitHome('workplace');
  await page.waitForFunction(() => document.querySelector('#seatsHome .seatdot') !== null, { timeout: 10_000 }).catch(() => {});
  const workedFallback = await subMark('Max 5x');
  check('a FALLBACK an agent is pinned to and running on wears the dot',
    workedFallback?.size === '6x6' && workedFallback?.breathes === 'breathe', JSON.stringify(workedFallback));
  check('…which is decoration, with the count given in words beside it',
    workedFallback?.hidden === 'true' && workedFallback?.said === 'In use — one agent is working on it now',
    `${workedFallback?.hidden} · ${workedFallback?.said}`);
  check('…while the primary, still untouched, wears nothing',
    (await subMark('Max 20x'))?.size === '', JSON.stringify(await subMark('Max 20x')));
  // The whole point of reusing `livedot`: this mark is the SAME blue the
  // fleet's own live dot is, read off the page itself — in the agents
  // picker, where the fleet stands (notes #715, #843).
  await openHalf('agents');
  const fleetBlue = await page.$eval('#agentSwitchGrid .livedot', (node) => getComputedStyle(node).backgroundColor).catch(() => '');
  check('the subscription\u2019s mark is the fleet\u2019s own live blue',
    Boolean(fleetBlue) && workedFallback?.fill === fleetBlue, `${fleetBlue} vs ${workedFallback?.fill}`);
  check('…and it stands past the plan, on the title\u2019s line, card unopened',
    workedFallback?.afterThePlan === true && workedFallback?.onTheLine === true
      && workedFallback?.height === quietFallback?.height,
    `${workedFallback?.height} vs ${quietFallback?.height}`);

  // The people on HOME (note #328, extended at the owner's ask): drawn as
  // the fleet beside them is drawn. Mira comes back for it — a deck of
  // PEOPLE needs more than the reader in it to be worth reading, and she is
  // the one who is NOT here right now.
  await orgStorage.addMember({ orgId: orgDoc.orgId, userId: 'user-mira', role: 'member', invitedByUserId: me.userId });
  await orgStorage.touchMember(orgDoc.orgId, 'user-mira', {
    lastSeenAt: twoHoursAgo, recap: { text: 'Approved proposal #12: Pricing page redesign', at: twoHoursAgo },
  });
  workingNow.add('ada');
  await page.goto(`${ORIGIN}/?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await waitHome('workplace');
  await page.waitForFunction(() => document.querySelectorAll('#seatsHome .seatdot').length === 2, { timeout: 10_000 }).catch(() => {});
  const workedPrimary = await subMark('Max 20x');
  check('an unpinned agent lights the seat it actually leases — the primary',
    workedPrimary?.size === '6x6' && workedPrimary?.fill === fleetBlue, JSON.stringify(workedPrimary));
  await shotOrg('subs-live');

  // NOTE #667: a ChatGPT plate is named like a Claude one — by the product.
  // The stored label is what a sign-in writes ("ChatGPT · 25 Sep 2026"); its
  // date belongs to the seat's own screen and was squeezing the plan out.
  const chatgptSeat = await orgStorage.addSeat({ orgId: orgDoc.orgId, userId: me.userId, provider: 'codex', token: 'seat-token-codex', label: 'ChatGPT · 25 Sep 2026', status: 'active' } as never);
  // With a reading, as a real sign-in has one: the plan stands beside the
  // name, which is exactly what the dated label was pushing out.
  await orgStorage.updateSeat(chatgptSeat.seatId, {
    usage: {
      capturedAt: new Date().toISOString(),
      planType: 'prolite',
      windows: { primary: { id: 'primary', usedPercent: 86, windowDurationMins: 10_080, resetsAt: Math.round(Date.now() / 1000) + 3 * 86_400 } },
    },
    usageRefreshedAt: new Date().toISOString(),
  });
  await page.goto(`${ORIGIN}/?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await waitHome('workplace');
  await page.waitForFunction(() => document.querySelectorAll('#seatsHome .seatcard').length === 3, { timeout: 10_000 }).catch(() => {});
  const plateNames = await page.$$eval('#seatsHome .seathead .label', (nodes) => nodes.map((node) => node.textContent ?? ''));
  check('a ChatGPT plate is named ChatGPT, with no date, as Claude is Claude',
    plateNames.includes('ChatGPT') && plateNames.every((name) => name === 'Claude' || name === 'ChatGPT'), plateNames.join(' | '));
  const chatgptHead = await page.$$eval('#seatsHome .seathead .name', (nodes) => {
    const head = nodes.find((node) => node.querySelector('.label')?.textContent === 'ChatGPT');
    const plan = head?.querySelector('.plan') as HTMLElement | null;
    return { plan: plan?.textContent ?? '', uncut: Boolean(plan) && plan!.scrollWidth <= plan!.clientWidth };
  });
  check('…and its plan stands beside that name, uncut', chatgptHead.plan === 'Prolite' && chatgptHead.uncut, JSON.stringify(chatgptHead));
  await shotOrg('subs-chatgpt');
  await orgStorage.removeSeat(chatgptSeat.seatId);
  await orgStorage.selectSeat(seeded.seatId, orgDoc.orgId);

  // The people are a deck in Home's Workplace window again (2026-10-28,
  // Adam: "let's bring back the team UI"), after the agent counts; the
  // Settings card stays gone (note #634). The reader's own picture closes
  // the header row and drops the account menu, whose People row opens the
  // People page. The window is read open, and the picture tapped with it
  // closed.
  await waitHome('workplace');
  await page.waitForSelector('#homeSheet #homePeople .crow[data-person="user-mira"]', { timeout: 10_000 }).catch(() => {});
  const header = await page.evaluate(() => ({
    deck: Boolean(document.querySelector('#homeSheet #peopleSection #homePeople .crow[data-person="user-mira"]')),
    afterCounts: Boolean((document.querySelector('#agentActivity')?.compareDocumentPosition(document.querySelector('#peopleSection')!) ?? 0)
      & Node.DOCUMENT_POSITION_FOLLOWING),
    settingsCard: Boolean(document.querySelector('#settingsCard')),
    last: document.querySelector('#screenHome > .chathead')?.lastElementChild?.id ?? '',
    face: (() => {
      const box = document.querySelector('#homeAccount .accountface')?.getBoundingClientRect();
      return box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'none';
    })(),
  }));
  check('Home\u2019s Workplace window has the people deck after the counts, and no settings card',
    header.deck && header.afterCounts && !header.settingsCard, JSON.stringify(header));
  await shotOrg('home-people-deck');
  check('…the reader\u2019s picture closes the header row, at 32px', header.last === 'homeAccount' && header.face === '32x32', JSON.stringify(header));
  await homeBare();
  await page.click('#homeAccount');
  await page.waitForSelector('#accountMenu', { visible: true, timeout: 5_000 });
  const menuRows = await page.$$eval('#accountMenu [role=menuitem]:not(#accountMenuSelf) .orgmenuname', (rows) => rows.map((row) => row.textContent ?? ''));
  // The Leaderboard row went with the board (note #824).
  check('…and opens a menu of People, Apps and Settings', menuRows.join(' | ') === 'People | Apps | Settings', menuRows.join(' | '));
  await shotOrg('home-account-menu');
  await page.click('#accountMenuPeople');
  await page.waitForSelector('#people .crow', { timeout: 10_000 });
  const people = await page.$$eval('#people .crow', (rows) => rows.map((node) => node.querySelector('.name')?.textContent ?? ''));
  check('…whose People row opens everyone in the workplace',
    people.join(' | ') === 'saddam Harness | Mira Chen', people.join(' | '));
  await shotOrg('home-people');
  await page.goBack();
  await waitHome();

  // The same item on the seats screen, where a subscription is a list row.
  await page.goto(`${ORIGIN}/seats?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('#seatsList .crow').length === 2, { timeout: 10_000 }).catch(() => {});
  // MEASURED, not merely found: a `.seatdot` outside a flex line is an inline
  // span, and width/height do not apply to one — it renders at zero size with
  // its colour intact, which reads as present to every check but the box.
  const listMarks = await page.$$eval('#seatsList .crow', (rows) => rows.map((row) => {
    const dot = row.querySelector('.seatdot');
    const box = dot?.getBoundingClientRect();
    const words = row.querySelector('.name')?.getBoundingClientRect();
    return [
      row.querySelector('.name')?.firstChild?.textContent?.trim() ?? '',
      box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'no dot',
      dot ? getComputedStyle(dot).backgroundColor : '-',
      // On the words' own line, and after them.
      box && words && box.left >= words.left && box.top >= words.top - 0.5 && box.bottom <= words.bottom + 0.5 ? 'placed' : 'adrift',
    ].join('=');
  }));
  check('the seats screen marks the same two subscriptions the same way',
    listMarks.length === 2 && listMarks.every((entry) => entry.endsWith(`=6x6=${fleetBlue}=placed`)), listMarks.join(' | '));
  await shotOrg('subs-list');

  // 4e. NOTE #359: on the cloud screen, an agent's face is the way IN to that
  //     agent, and a pointer resting on it raises the same card the decision
  //     queue and the chat raise.
  //
  //     Checked HERE rather than beside the rest of the cloud screen above,
  //     because the card is only worth reading once the fleet holds these
  //     agents — they are seeded with the subscriptions, a few sections down.
  //     Everything below is Chrome's to answer: jsdom has no pointer, no
  //     stylesheet and no hit testing, so the raised card, the target grown
  //     around a 20px picture, and the tap landing on the door rather than on
  //     the box that RAISES the card are all invisible to the unit tests.
  await page.goto(`${ORIGIN}/workplace/cloud?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgSpendList .spendrow', { timeout: 10_000 });
  check('nothing is raised on the cloud screen until a pointer arrives', !(await page.$('.agentcard')));
  await page.hover('#orgSpendList .spendrow .spendname .facehover');
  check('hovering a machine\u2019s face raises the agent whose machine it is',
    await page.waitForSelector('.agentcard', { timeout: 5_000 }).then(() => true, () => false));
  // The row knows a name, a face and a driver. Everything else on the card
  // can only have come from the live fleet, which is the point of asking it.
  check('\u2026with its runtime, its state and what it last did \u2014 read off the live fleet, not off the row',
    (await text('.agentcard .name')) === 'Ada'
    && (await text('.agentcard .cruntime')) === 'Claude Code \u00b7 opus \u00b7 high'
    && (await text('.agentcard .statetext')) === 'Active'
    && (await text('.agentcard .cabout')) === 'Rebased slice 4 on main and re-ran the checks.',
    [await text('.agentcard .name'), await text('.agentcard .cruntime'),
      await text('.agentcard .statetext'), await text('.agentcard .cabout')].join(' | '));
  check('\u2026floating over the list, inside the window, catching nothing',
    await page.evaluate(() => {
      const card = document.querySelector('.agentcard');
      const face = document.querySelector('#orgSpendList .spendrow .spendname .facehover');
      if (!card || !face) return 'no card';
      const box = card.getBoundingClientRect();
      const on = face.getBoundingClientRect();
      const style = getComputedStyle(card);
      return [
        `position=${style.position}`,
        `pointer-events=${style.pointerEvents}`,
        `clear=${box.bottom <= on.top || box.top >= on.bottom}`,
        `inside=${box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight}`,
      ].join(' ');
    }) === 'position=fixed pointer-events=none clear=true inside=true',
    String(await page.evaluate(() => {
      const card = document.querySelector('.agentcard');
      return card ? JSON.stringify(card.getBoundingClientRect()) : 'no card';
    })));
  await shotOrg('cloud-agent-card');
  await page.mouse.move(2, 2);
  check('\u2026and it goes when the pointer does',
    await page.waitForFunction(() => !document.querySelector('.agentcard'), { timeout: 5_000 })
      .then(() => true, () => false));

  // The other half: the face is the way TO that agent, and it is the ONLY
  // door on the row — the name beside it stays words (note #339), and a site
  // or the check lane has nowhere to go at all.
  const cloudDoor = await page.$eval('#orgSpendList .spendrow .spendname a.facebtn', (node) => ({
    href: node.getAttribute('href'),
    label: node.getAttribute('aria-label'),
    wraps: Boolean(node.querySelector('.avatar, .icon')),
  })).catch(() => null);
  check('an agent\u2019s face on its machine is a door onto that agent, at the registered address',
    cloudDoor?.href === '/agents/ada' && cloudDoor.label === 'Open Ada' && cloudDoor.wraps === true,
    JSON.stringify(cloudDoor));
  check('\u2026and it is the only door in the list: the name is text, and the other machines have nowhere to go',
    await page.evaluate(() => {
      const doors = document.querySelectorAll('#orgSpendList a.facebtn').length;
      const named = document.querySelector('#orgSpendList .spendrow .nametext');
      return `doors=${doors} name=${named?.closest('a') === null}`;
    }) === 'doors=1 name=true');
  // A 20px picture is nothing to aim at, so the target grows around it. Asked
  // of the browser the way a thumb asks: what is under this point? The middle
  // of the picture is the tap that MUST work — that is the one `.facehover`'s
  // own slop used to swallow (notes #295, #353) — and the ring around it is
  // what makes the door thumb-sized. No named function inside `evaluate`:
  // esbuild wraps one in `__name`, which the page does not have.
  check('\u2026on a target bigger than the picture, and reachable at its middle',
    await page.evaluate(() => {
      const link = document.querySelector('#orgSpendList .spendrow .spendname a.facebtn') as HTMLElement;
      const row = link?.closest('.spendrow');
      if (!link || !row) return 'nothing to measure';
      const box = link.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const hits = [
        [box.left + box.width / 2, box.top + box.height / 2],
        [box.left - 7, box.top + box.height / 2],
        [box.left + box.width / 2, box.top - 7],
      ].map((point) => link.contains(document.elementFromPoint(point[0]!, point[1]!)));
      return [
        `middle=${hits[0]}`,
        `grown=${hits[1] && hits[2]}`,
        `picture=${Math.round(box.width)}x${Math.round(box.height)}`,
        // …and the grown target stays inside the row it belongs to, so it
        // cannot reach into the machine above or below.
        `inRow=${box.top - 10 >= rowBox.top && box.bottom + 10 <= rowBox.bottom}`,
      ].join(' ');
    }) === 'middle=true grown=true picture=20x20 inRow=true',
    await page.evaluate(() => {
      const link = document.querySelector('#orgSpendList .spendrow .spendname a.facebtn') as HTMLElement;
      return link ? JSON.stringify(link.getBoundingClientRect()) : 'no door';
    }));
  // THE NEGATIVE CONTROL, and the reason this check exists at all: take the
  // layer away and the middle of the picture stops reaching the door, because
  // `.facehover::after` is a pseudo-element of the WRAPPER — painted after
  // the wrapper's children, and hit testing follows paint order. That is the
  // bug note #353 found in two places that had shipped, and this is what
  // proves the stylesheet's `z-index` is what stands between it and here.
  check('\u2026and the hover slop would swallow that tap without the door\u2019s own layer',
    await page.evaluate(() => {
      const link = document.querySelector('#orgSpendList .spendrow .spendname a.facebtn') as HTMLElement;
      if (!link) return 'no door';
      const box = link.getBoundingClientRect();
      link.style.zIndex = 'auto';
      const under = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      link.style.zIndex = '';
      return `${link.contains(under)} ${under?.className}`;
    }) === 'false facehover');
  // And it really opens: a click where a reader would put one, through the
  // hover box that stands over this picture to raise the card.
  await page.click('#orgSpendList .spendrow .spendname a.facebtn');
  await page.waitForSelector('#agentInfoTitle', { timeout: 10_000 }).catch(() => {});
  check('tapping it opens that agent\u2019s own screen',
    page.url() === `${ORIGIN}/agents/ada` && (await text('#agentInfoTitle')) === 'Ada',
    `${page.url()} / ${await text('#agentInfoTitle')}`);
  await shotOrg('cloud-agent');

  // 4f. NOTE #368: "Cloud details page data should be cached and refetch
  //     silently." The trip is the one the tap above just made — out of a
  //     machine's row into its agent — and this is the way BACK.
  //
  //     Only a browser can settle it. The screen is a route, so Back REBUILDS
  //     it, and what is being checked is that the machines are in the DOM
  //     that rebuild produced rather than a wait drawn over them.
  //
  //     Two things make the check mean something. The trip is made FRESH from
  //     a reload, so the time between the read landing and the way back is a
  //     couple of seconds rather than however long the hover checks above
  //     took — the floor is fifteen. And the read is made slow before Back:
  //     against the fast fixture a screen that re-read from nothing would
  //     look identical, and this would pass on a cache that was not there.
  await page.goto(`${ORIGIN}/workplace/cloud?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgSpendList .spendrow', { timeout: 10_000 });
  await page.click('#orgSpendList .spendrow .spendname a.facebtn');
  await page.waitForSelector('#agentInfoTitle', { timeout: 10_000 });
  spendDelayMs = 4000;
  const spendReadsBefore = spendReads;
  await page.click('#pageBack');
  await page.waitForSelector('#screenOrgCloud', { timeout: 10_000 });
  const backAtOnce = await page.evaluate(() => document.querySelectorAll('#orgSpendList .spendrow').length);
  // Past the quiet window a wait would have been drawn in, and nowhere near
  // the four seconds this read now takes: a screen rebuilt from nothing is
  // holding three grey rows at this moment, and this one is not.
  await new Promise((resolve) => { setTimeout(resolve, WAIT_QUIET_WINDOW_MS); });
  check('coming back to the cloud screen puts the machines straight back up, with no wait over them',
    backAtOnce === 3 && await page.evaluate(() => {
      const rows = document.querySelectorAll('#orgSpendList .spendrow').length;
      const held = document.querySelectorAll('#screenOrgCloud .skel').length;
      const busy = document.getElementById('screenOrgCloud')?.getAttribute('aria-busy');
      const money = document.querySelector('#orgSpendList .spendrow .spendtotal strong')?.textContent;
      return `rows=${rows} skel=${held} busy=${busy} money=${money}`;
    }) === 'rows=3 skel=0 busy=null money=~$2.55',
    `at once ${backAtOnce} rows · ${await page.evaluate(() => document.getElementById('screenOrgCloud')?.textContent?.slice(0, 200) ?? 'no screen')}`);
  // …and what a held answer wears instead of that wait: its own age.
  check('…and it says when those figures were read',
    /^Checked at \d{1,2}:\d{2}( ?[AP]M)? · read again each visit$/.test(await text('#orgSpendRead')),
    await text('#orgSpendRead'));
  // A trip this short costs no read at all: the walk behind these figures is
  // the whole Fly account, and nothing on it can have moved in two seconds.
  check('…without walking the cloud account again for it',
    spendReads === spendReadsBefore, `${spendReadsBefore} -> ${spendReads}`);
  spendDelayMs = 0;

  // NOTE #375, the other half: the row that belongs to nobody is the one row
  // here a reader can DO something about. Chrome answers what jsdom cannot —
  // that the button is sized by its word instead of claiming the name column
  // (`.btn` is a page button, `width: 100%`), that it is inside the card that
  // clips its own overflow, and that a tap really lands on it.
  await page.goto(`${ORIGIN}/workplace/cloud?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgSpendList .spendrow', { timeout: 10_000 });
  const removeBtn = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('#orgSpendList .spendremove')] as HTMLElement[];
    const button = buttons[0];
    if (!button) return { count: buttons.length };
    // Brought into the window before anything is measured: `elementFromPoint`
    // answers about the VIEWPORT, so a button below the fold reads as "a tap
    // does not land on it" when the truth is that nobody has scrolled to it
    // yet. What sits above this row on the screen is not this check's
    // business — the account card arrived over it in note #372 — and every
    // geometry below is relative to the row either way.
    button.scrollIntoView({ block: 'center' });
    const row = button.closest('.spendrow') as HTMLElement;
    const card = button.closest('.card') as HTMLElement;
    const box = button.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    return {
      count: buttons.length,
      word: button.textContent?.trim() ?? '',
      // On the leftover, and under its own facts rather than in the money's
      // column: the name column keeps its width.
      onTheLeftover: (row.querySelector('.nametext')?.textContent ?? '').includes('Leftover'),
      sizedByItsWord: box.width < rowBox.width / 2,
      below: box.top >= (row.querySelector('.spendfacts') as HTMLElement).getBoundingClientRect().bottom,
      // Its WORD starts where the row's own facts start: the padding that
      // makes it thumb-sized is pulled back out, so nothing on the row is
      // indented past the rest of it.
      aligned: Math.round(box.left + Number.parseFloat(getComputedStyle(button).paddingLeft))
        === Math.round((row.querySelector('.spendfacts') as HTMLElement).getBoundingClientRect().left),
      inside: Math.round(box.right) <= Math.round(card.getBoundingClientRect().right),
      // A thumb's worth of height, and the tap lands on the button itself.
      tall: Math.round(box.height) >= 28,
      hit: button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
    };
  });
  check('the leftover machine carries the only button in the list, sized by its word',
    removeBtn.count === 1 && removeBtn.word === 'Remove' && removeBtn.onTheLeftover === true
    && removeBtn.sizedByItsWord === true && removeBtn.below === true && removeBtn.inside === true
    && removeBtn.aligned === true && removeBtn.tall === true && removeBtn.hit === true,
    JSON.stringify(removeBtn));
  // Asking is not doing: the card names the machine, and Cancel leaves the
  // account exactly as it was.
  await page.click('#orgSpendList .spendremove');
  await page.waitForSelector('.ask', { timeout: 5_000 }).catch(() => {});
  check('…and it asks first, naming the machine it would destroy',
    (await text('.ask')).includes('ia-agent00000002 and everything on it are destroyed, for good.'),
    await text('.ask'));
  await shotOrg('cloud-remove-ask');
  await clickText('.ask .btn', /^Cancel$/);
  check('…and Cancel leaves every machine where it was',
    !(await page.$('.ask')) && (await page.$$('#orgSpendList .spendrow')).length === 3
    && removedApps.size === 0, String((await page.$$('#orgSpendList .spendrow')).length));

  await page.click('#orgSpendList .spendremove');
  await page.waitForSelector('.ask', { timeout: 5_000 }).catch(() => {});
  await clickText('.ask .btn.danger', /^Remove$/);
  await page.waitForFunction(() => document.querySelectorAll('#orgSpendList .spendrow').length === 2, { timeout: 10_000 })
    .catch(() => {});
  check('confirming removes it from the account, and from the list without a second read',
    [...removedApps].join() === 'ia-agent00000002'
    && (await page.$$('#orgSpendList .spendrow')).length === 2
    && !(await text('#orgSpendList')).includes('Leftover machine'),
    `${[...removedApps].join()} · ${(await page.$$('#orgSpendList .spendrow')).length}`);
  // The receipt for something that has already happened goes in the shell's
  // banner: the row it would otherwise be reported on is gone.
  check('…and says so where a removed row cannot',
    (await text('#banner')).includes('Machine removed.')
    && (await page.$eval('#banner', (node) => node.className)).includes('ok'),
    await text('#banner'));
  // The figures over the list are recounted from what is left rather than
  // left saying what the account held a moment ago.
  check('…and the line above the list counts what is left',
    (await text('#orgSpendSub')) === '~$2.55 total so far this month · 2 running, 0 asleep',
    await text('#orgSpendSub'));
  // The copy this TAB holds lost the row too (note #368's cache): leaving the
  // screen and coming back to it draws what is held, and a removal that only
  // touched the screen's own state would put the machine back on the glass.
  // Out through the door on the row above it and back with Back — the same
  // trip note #368 holds this cache for, made without a reload.
  await page.click('#orgSpendList .spendrow .spendname a.facebtn');
  await page.waitForSelector('#agentInfoTitle', { timeout: 10_000 });
  await page.click('#pageBack');
  await page.waitForSelector('#orgSpendList .spendrow', { timeout: 10_000 });
  check('…and coming back to the screen does not put it back on the glass',
    (await page.$$('#orgSpendList .spendrow')).length === 2
    && !(await text('#orgSpendList')).includes('Leftover machine'),
    await text('#orgSpendList'));

  // And it is really gone: the next read of the account comes back without
  // it, which is the difference between a row hidden and a machine removed.
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgSpendList .spendrow', { timeout: 10_000 });
  check('…and it is gone when the account is read again',
    (await page.$$('#orgSpendList .spendrow')).length === 2
    && !(await text('#orgSpendList')).includes('Leftover machine'),
    await text('#orgSpendList'));
  await shotOrg('cloud-removed');

  // 4g. NOTE #372: "I should be able to replace my cloud. In my cloud details
  //     screen, I should be able to replace with different ones, so replace
  //     the fly token key."
  //
  //     Two acts behind one button, and the whole of this section is that the
  //     screen never confuses them: a fresh token for the SAME Fly org is a
  //     credential swap nothing else notices, and a token for a DIFFERENT one
  //     is a move that leaves every machine on this screen behind in an
  //     account this platform can no longer reach.
  check('the screen names the account every figure on it was read from',
    (await text('#orgCloudAccount .name')) === 'nomad-trading'
    && (await text('#orgCloudAccount .cline')) === 'Your team’s cloud · everything below runs here'
    && await page.evaluate(() => {
      const account = document.getElementById('orgCloudAccount');
      const list = document.getElementById('orgSpendList');
      return Boolean(account && list
        && (account.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    }),
    await text('#orgCloudAccount'));
  // A working cloud and a bill on the glass: a token box left open over them
  // invites the paste it should be waiting for.
  check('…and asks for no token until somebody asks it to',
    (await page.$('#replaceCloudToken')) === null);
  await page.click('#orgCloudReplace');
  await page.waitForSelector('#replaceCloudToken', { timeout: 10_000 });
  await shotOrg('cloud-replace-form');
  const tunnelBefore = tunnel.length;
  await page.type('#replaceCloudToken', 'fo1_same_account');
  await page.click('#replaceCloudConnect');
  await page.waitForFunction(() => document.getElementById('banner')?.textContent?.includes('token replaced'), { timeout: 10_000 });
  check('a fresh token for the same account rotates the key and moves nothing',
    (await text('#banner')) === 'Cloud token replaced. nomad-trading is still your cloud.'
    && (await page.$('.scrim')) === null
    && (await text('#orgCloudAccount .name')) === 'nomad-trading'
    && (await page.$$('#orgSpendList .spendrow')).length === 2,
    `${await text('#banner')} · ${(await page.$$('#orgSpendList .spendrow')).length} rows`);
  // Same account, same network, same key: a full converge is a down-then-up,
  // and every SSH session on that tunnel would pay for a swap that did not
  // touch it.
  check('…and converges the tunnel only if it is missing, rather than flapping a live one',
    tunnel.slice(tunnelBefore).join('|') === 'if-missing', tunnel.join('|'));

  await page.click('#orgCloudReplace');
  await page.waitForSelector('#replaceCloudToken', { timeout: 10_000 });
  await page.type('#replaceCloudToken', 'fo1_somewhere_else');
  await page.click('#replaceCloudConnect');
  await page.waitForSelector('#replaceCloudMove', { timeout: 10_000 });
  const asked = await text('#replaceCloudMove');
  check('a token for another account is a question, naming where Fly says it points',
    asked.includes('That token is for other-co, not nomad-trading')
    && asked.includes('The 2 machines on this screen are what stays behind.')
    && asked.includes('Keep nomad-trading') && asked.includes('Move to other-co'),
    asked);
  // Oscar's review of PR #735. The machines are the visible half; the
  // repositories, their backups and the files are the half nobody has on
  // screen, and they are in that account too. And what happens to an agent is
  // not promised either way — which one depends on how Fly answers for an app
  // the new token cannot see.
  check('…and names what stays behind that is not on the screen, and what becomes of an agent',
    asked.includes('That includes your repositories and their backups, and every file on a note, '
      + 'page or chat, which live in nomad-trading too.')
    && asked.includes('Its next turn either fails or builds it a fresh, empty computer in other-co')
    && asked.includes('keeps billing in nomad-trading until you remove it in Fly'),
    asked);
  await shotOrg('cloud-replace-move-ask');
  await page.click('#replaceCloudKeep');
  await page.waitForFunction(() => document.querySelector('.scrim') === null, { timeout: 10_000 });
  check('…and answering no leaves the account exactly where it was',
    (await text('#orgCloudAccount .name')) === 'nomad-trading'
    && (await page.$$('#orgSpendList .spendrow')).length === 2,
    await text('#orgCloudAccount'));

  await page.click('#orgCloudReplace');
  await page.waitForSelector('#replaceCloudToken', { timeout: 10_000 });
  await page.type('#replaceCloudToken', 'fo1_somewhere_else');
  await page.click('#replaceCloudConnect');
  await page.waitForSelector('#replaceCloudMoveGo', { timeout: 10_000 });
  // The yes names the org the question named — the stub above throws on
  // anything else, exactly as the service does.
  await page.click('#replaceCloudMoveGo');
  await page.waitForFunction(() => document.getElementById('banner')?.textContent?.includes('Your cloud is now'), { timeout: 10_000 });
  // The machines held here were a reading of an account this workplace has
  // just left. They go rather than standing while a fresh walk is out — the
  // old account's machines under the new account's name is the one kind of
  // stale a money screen must not be.
  await page.waitForFunction(() => document.querySelector('#orgCloudAccount .name')?.textContent === 'other-co', { timeout: 10_000 });
  check('a confirmed move takes the cloud, and the old account’s machines off the screen',
    (await text('#banner')) === 'Your cloud is now other-co. Everything in nomad-trading is still there, on that account\u2019s bill.'
    && (await page.$$('#orgSpendList .spendrow')).length === 0
    && (await text('#orgSpendList')).includes('Nothing runs in the cloud account yet'),
    `${await text('#banner')} · ${await text('#orgSpendList')}`);
  // Note #737: the toast is as wide as what it says, so a sentence this long
  // is the case that must still behave — it wraps inside the screen, 12px
  // clear of either edge, rather than growing past it on one line.
  const longToast = await page.$eval('#banner', (node) => {
    const box = node.getBoundingClientRect();
    const words = document.createRange();
    words.selectNodeContents(node.querySelector('.toastmessage') ?? node);
    return {
      left: Math.round(box.left), right: Math.round(window.innerWidth - box.right),
      lines: words.getClientRects().length,
    };
  });
  check('…and its long sentence wraps inside the screen, 12px clear of each edge',
    longToast.left === 12 && longToast.right === 12 && longToast.lines >= 2,
    JSON.stringify(longToast));
  check('…and a move mints a peer into the new account, which a rotation never does',
    tunnel.slice(tunnelBefore).join('|') === 'if-missing|full', tunnel.join('|'));
  await shotOrg('cloud-replaced');

  workingNow.clear();

  // 4b. A second workplace, founded from inside the first (note #670). The
  //     server makes it the account's active one; THIS TAB has to follow
  //     too, because it stands in its own workplace (note #628) — and until
  //     2026-09-26 the form re-read as the old one, so the founder simply
  //     stayed where they were. The new workplace's first read is also what
  //     carries their subscription in. Since note #726 it founds nothing:
  //     no rooms, no agents — Home opens on the Chief of Staff's greeting.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await homeBare();
  const firstOrgId = orgDoc.orgId;
  // The setup fixture stamps every workplace it sees created as already
  // founded and seats each member (harnessEstablishedWorkplace) — right for
  // the first one, and exactly what would hide this step's subject. From
  // here a workplace is created as production creates one: founding owed,
  // and the founder's subscription carried in by its first read.
  orgStorage.createOrg = InMemoryOrgStorage.prototype.createOrg.bind(orgStorage);
  orgStorage.addMember = InMemoryOrgStorage.prototype.addMember.bind(orgStorage);
  await page.click('#homeOrganizations');
  await page.waitForSelector('#workplaceMenu', { visible: true, timeout: 10_000 });
  await page.click('#workplaceMenuNew');
  await page.waitForSelector('#orgCreateName', { timeout: 10_000 });
  await page.type('#orgCreateName', 'Second Shop');
  await shotOrg('second-workplace-named');
  await page.click('#orgCreateBtn');
  await page.waitForSelector('#screenHome #firstRunStarters .chatstarter', { timeout: 15_000 }).catch(() => {});
  const secondOrg = (await orgStorage.listOrgs()).find((row) => row.name === 'Second Shop');
  if (!secondOrg) throw new Error('Create workplace made no workplace');
  const standing = () => page.evaluate(() => sessionStorage.getItem('acc.standingWorkplace'));
  check('creating a workplace makes it the account’s active one',
    (await orgStorage.getMembershipByUser(me.userId))?.orgId === secondOrg.orgId);
  check('…and moves THIS tab into it, not only the account (note #670)',
    (await standing()) === secondOrg.orgId, `${await standing()} · first ${firstOrgId}`);
  check('…where Home opens on the Chief of Staff’s greeting and starters, with no gate and no arriving team (note #726)',
    Boolean(await page.$('#screenHome')) && !(await page.$('#requiredSetup')) && !(await page.$('#teamArriving'))
      && (await text('#homeOrganizations .orgswapname')) === 'Second Shop'
      && (await page.$$('#firstRunStarters .chatstarter')).length === 3,
    `${page.url()} · ${await text('#homeOrganizations .orgswapname')} · ${await text('#recapChatLog')}`);
  check('…because the subscription came along, and founding furnished nothing',
    (await orgStorage.listSeatsByMember(secondOrg.orgId, me.userId)).length > 0
      && Object.values((await userStorage.getProfile(me.userId))?.telegram?.agents ?? {})
        .every((agent) => agent.orgId !== secondOrg.orgId || Boolean(agent.purpose)));
  await shotOrg('second-workplace-home');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome #homeOrganizations', { timeout: 10_000 }).catch(() => {});
  check('a reload keeps the tab in the new workplace',
    (await text('#homeOrganizations .orgswapname')) === 'Second Shop' && (await standing()) === secondOrg.orgId, page.url());
  // And back: the picker, and the first workplace opens exactly as it was
  // left.
  await page.goto(`${ORIGIN}/workplaces`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgPickerList', { timeout: 10_000 });
  check('the picker lists both, with the new one current',
    (await text('#orgPickerList .orgrow.current')).includes('Second Shop')
      && (await text('#orgPickerList')).includes('Northstar Studio'),
    await text('#orgPickerList'));
  await clickText('#orgPickerList button.orgrow', /Northstar Studio/);
  // Switching lands on Home — the conversation, whose header carries the switch too.
  await page.waitForSelector('#screenHome #homeOrganizations', { timeout: 10_000 }).catch(() => {});
  check('switching back opens the first workplace’s Home',
    (await text('#homeOrganizations .orgswapname')) === 'Northstar Studio' && (await standing()) === firstOrgId,
    `${await text('#homeOrganizations .orgswapname')} · ${await standing()}`);

  // 5. The profile carries sign out.
  await page.goto(`${ORIGIN}/profile`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#profileAccessCard .row', { timeout: 10_000 });
  // This account signs in by ADDRESS, so the address is what its access card
  // names; `@username` belongs to the legacy authenticator accounts. The
  // address is on OUR domain since note #509: the harness names its account
  // `saddam@example.com` for its own fixtures, but only the local part is
  // ever typed into signup, and what the account actually holds is
  // `saddam@` the mail domain — which is what the card must say.
  check('the profile names the address this account signs in with',
    /saddam@[\w.-]+/.test(await text('#profileAccessCard')),
    await text('#profileAccessCard'));
  heads.profile = await headShape(page);
  // A mark, a mono name, a sub line or none of them: the block they fill is
  // the same block, and it ends in the same rule.
  check('every one of these screens wears the SAME header, closed with one rule',
    Object.values(heads).every((shape) => shape === ONE_HEADER), JSON.stringify(heads));
  await shotOrg('profile');
  // The rows above the access card (the address, who mail wakes) are still
  // landing when this runs; a pointer click aimed at "Sign out" before they
  // settle lands on "Disable", one row up (2026-09-23). Let the page go quiet.
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 10_000 }).catch(() => {});
  // And TAPPED, not clicked: the button sits under the fold, and for three
  // seconds after a screen lands the shell takes back every scroll no reader
  // made — Puppeteer's own scroll to reach it among them — so on a loaded
  // machine the press landed where the button WAS and nothing signed out.
  // Both of CI's attempts went that way on 2026-09-27 (note #666's branch,
  // which touches no part of this screen), and one on 2026-09-25. `tap`
  // scrolls with the wheel and waits for the button's own box to stop.
  const signOut = await page.$$eval('#profileAccessCard button', (buttons) => {
    const found = buttons.find((button) => /Sign out$/.test(button.textContent ?? ''));
    found?.setAttribute('data-harness', 'sign-out');
    return Boolean(found);
  });
  check('sign out lives on the profile', signOut);
  if (signOut) await tap(page, '#profileAccessCard button[data-harness="sign-out"]');
  // Signing out returns to the ordinary door, which is the email panel.
  await page.waitForSelector('#authEmail', { timeout: 10_000 }).catch(() => {});
  check('…and closes the door', Boolean(await page.$('#authEmail')));

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
