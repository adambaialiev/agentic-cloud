// Drives the React Workspace in real Chrome against a real backend router to
// check what the agents picker shows of the agents OTHER members drive
// (2026-09-23, the owner: "those agents should not be hidden from other
// humans … even there, we should make some compact UI showing avatars of
// other humans' agents existing and working in the room").
//
// The picker's cards stay the reader's own fleet, and below them stands one
// compact strip: every teammate's agent in the workplace, under the person
// who drives them, the ones mid-turn wearing the live disc, each face a door
// to that agent's read-only page. The live tick moves the disc without a
// full read. A member's own page names every agent they drive here.
//
// It was a ROOM's strip — the teammates' agents in that room, another room
// showing its own, a room with none showing nothing, the rooms list naming
// each room's agents and a member's page the room each agent works in —
// until rooms left the product (note #843): one strip holds all of them.
// Screenshots land in ~/mini-preview/room-teammates-*.png. The Workplace
// pulse stands in Home's Workplace window (note #715).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-room-teammates.mts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot, tap } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import {
  harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace,
} from './workspace-harness-auth.mjs';
import { openAgentsPicker, openWorkplaceWindow } from './workspace-harness-home.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(cache).filter((name) => name.startsWith('linux-')).sort();
  const newest = builds[builds.length - 1];
  if (!newest) throw new Error(`no Chrome under ${cache} — npx puppeteer browsers install chrome`);
  return path.join(cache, newest, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4181);
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** A stand-in for a member's profile picture: a real drawn square, so a face
 *  that fails to draw is told apart from one that did. */
const PERSON_PHOTO = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c9785b"/>'
  + '<circle cx="32" cy="26" r="12" fill="#f3d9c6"/><rect x="14" y="42" width="36" height="22" rx="11" fill="#f3d9c6"/></svg>',
).toString('base64');

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

/** Which agents are mid-turn, as `ownerUserId:agentId` — the registry the
 *  router reads for the reader's own rows and, now, for teammates' too. */
const working = new Set<string>();

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  orgStorage,
  mediaStorage: {
    createReadAccess: async () => ({ url: PERSON_PHOTO, expiresAt: new Date(Date.now() + 900_000).toISOString() }),
  },
  agentLifecycle: {
    isAgentWorking: (userId: string, agentId: string) => working.has(`${userId}:${agentId}`),
  },
} as unknown as RouteDeps;

const app = express();
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
// The shell itself answers at the root of the domain (public-addresses).
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

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
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `room-teammates-${name}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  };
  const texts = (selector: string) => page.$$eval(selector, (nodes) => nodes.map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
  const attrs = (selector: string, name: string) => page.$$eval(selector, (nodes, attr) => nodes.map((n) => n.getAttribute(attr as string) ?? ''), name);

  // 1. The reader, their workplace, and one agent of theirs.
  const me = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com', { firstName: 'Saddam', lastName: 'B' });
  const { org } = await harnessWorkplace(orgStorage, { userId: me.userId, name: 'Nomad Trading' });
  await orgStorage.addSeat({
    orgId: org.orgId, userId: me.userId, provider: 'claude', token: 't', label: 'my Claude', status: 'active',
  } as never);
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 3 * 3600_000).toISOString();
  const mine = await userStorage.getProfile(me.userId);
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(mine?.telegram ?? {}),
      agents: {
        felix: {
          id: 'felix', name: 'Felix', cli: 'claude', createdAt: now, serverId: 'm1', connectedAt: now,
          lastActivityAt: now, orgId: org.orgId,
        },
      },
    } as never,
  });

  // 2. Two teammates. Dana has a picture and three agents, one mid-turn;
  // Ben has none and one agent, still being set up. Dana also keeps an agent in
  // ANOTHER workplace, which must never show here.
  await userStorage.createProfile('dana', { email: 'dana@example.com', displayName: 'Dana Ives' } as never);
  await userStorage.updateProfile('dana', {
    person: { firstName: 'Dana', lastName: 'Ives', photo: { storagePath: 'people/dana.png' } },
    telegram: {
      chatId: '2', linkedAt: now, telegramUserId: '43',
      agents: {
        nora: {
          id: 'nora', name: 'Nora', cli: 'claude', createdAt: earlier, serverId: 'm3', connectedAt: earlier,
          lastActivityAt: now, orgId: org.orgId,
        },
        leo: {
          id: 'leo', name: 'Leo', cli: 'codex', createdAt: earlier, serverId: 'm4', connectedAt: earlier,
          lastActivityAt: earlier, orgId: org.orgId,
          recap: { text: 'Wrote the launch checklist', at: now },
        },
        mia: {
          id: 'mia', name: 'Mia', cli: 'claude', createdAt: earlier, serverId: 'm5', connectedAt: earlier,
          lastActivityAt: earlier, orgId: org.orgId,
        },
        elsewhere: {
          id: 'elsewhere', name: 'Rex', cli: 'claude', createdAt: earlier, serverId: 'm6', connectedAt: earlier,
          orgId: 'some-other-workplace',
        },
      },
    } as never,
  });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'dana', role: 'member' } as never);
  await userStorage.createProfile('ben', { email: 'ben@example.com', displayName: 'Ben Ortiz' } as never);
  await userStorage.updateProfile('ben', {
    person: { firstName: 'Ben', lastName: 'Ortiz' },
    telegram: {
      chatId: '3', linkedAt: now, telegramUserId: '44',
      agents: {
        otis: {
          id: 'otis', name: 'Otis', cli: 'claude', createdAt: now, serverId: 'm7',
          orgId: org.orgId,
        },
      },
    } as never,
  });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'ben', role: 'member' } as never);
  working.add('dana:leo');

  /** Home with the agents picker freshly open on its own view — from a
   *  blank page, so a page left standing inside the picker goes with it. */
  const openPicker = async () => {
    await page.goto('about:blank');
    await openAgentsPicker(page, ORIGIN);
    await page.waitForSelector('#agentSwitchSheet #agentSwitchGrid .crow[data-agent]', { timeout: 10_000 });
  };

  // 3. The picker: the reader's own card, and below it the strip.
  await openPicker();
  await page.waitForSelector('#teamAgents', { timeout: 10_000 }).catch(() => {});
  check('the picker still lists only the reader’s own agents as cards',
    (await texts('#agentSwitchGrid .crow .name')).join('|') === 'Felix', (await texts('#agentSwitchGrid .crow .name')).join('|'));
  check('a strip of teammates’ agents stands in the picker', Boolean(await page.$('#agentSwitchSheet #teamAgents')));
  check('it stands below the reader’s own cards',
    await page.evaluate(() => {
      const strip = document.getElementById('teamAgents');
      const plates = document.getElementById('agentSwitchGrid');
      return Boolean(strip && plates && plates.getBoundingClientRect().bottom <= strip.getBoundingClientRect().top);
    }));
  check('it counts every teammate’s agent in the workplace, and the ones working',
    (await texts('#teamAgents .teamcount'))[0] === '4 agents · 1 working', (await texts('#teamAgents .teamcount'))[0]);
  check('each group is the person who drives them, the one with a working agent first',
    (await texts('#teamAgents .ownername')).join('|') === 'Dana Ives|Ben Ortiz', (await texts('#teamAgents .ownername')).join('|'));
  check('a person with a picture wears it; one without wears the person glyph',
    (await page.$$('#teamAgents .teamgroup:nth-child(1) .ownerface img.avatar')).length === 1
    && (await page.$$('#teamAgents .teamgroup:nth-child(2) .ownerface .icon')).length === 1);
  const ids = await attrs('#teamAgents .teamface', 'data-team-agent');
  check('Dana’s working agent leads her group, her idle ones follow, and the other workplace’s agent is not here',
    ids.join('|') === 'leo|nora|mia|otis', ids.join('|'));
  check('every face is a drawn picture',
    await page.$$eval('#teamAgents .teamface img.avatar', (nodes) => nodes.every((node) => (node as HTMLImageElement).naturalWidth > 0))
    && (await page.$$('#teamAgents .teamface img.avatar')).length === 4);
  check('only the working agent wears the live disc',
    (await attrs('#teamAgents .teamface:has(.livedot)', 'data-team-agent')).join('|') === 'leo');
  // The owner (2026-09-23): the disc's ring faded with its breath, so the
  // picture's own edge showed through the notch at the bottom of each one.
  // Freeze every animation at its faintest frame and read the ring's pixels
  // off a real screenshot: they must be the card, not the dog behind it.
  const ring = await (async () => {
    // The picker opens from the stack of faces at the foot of the screen,
    // and a short list puts the strip under the pointer that tapped it: a
    // face under the pointer grows (`.teamface:hover`), and the ring would
    // be measured on a face drawn 8% bigger than the one a thumb sees.
    await page.mouse.move(1, 1);
    // The sheet's own way in has played out first: freezing EVERY animation
    // at its start would put the picker back at the foot of the screen, a
    // fraction of a pixel off where the strip was measured. Only the strip's
    // own breath is frozen.
    await page.waitForFunction(() => {
      const sheet = document.getElementById('agentSwitchSheet');
      return Boolean(sheet) && sheet!.getAnimations().length === 0 && sheet!.parentElement!.getAnimations().length === 0;
    }, { timeout: 10_000 });
    await page.evaluate(`document.getElementById('teamAgents').getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; })`);
    const { face: box, dot } = await page.$eval('#teamAgents .teamface[data-team-agent="leo"]', (node) => {
      const r = node.getBoundingClientRect();
      const d = node.querySelector('.livedot')!.getBoundingClientRect();
      return { face: { x: r.left, y: r.top, width: r.width, height: r.height }, dot: { x: d.left + d.width / 2, y: d.top + d.height / 2 } };
    });
    // Whole pixels, so the picture's origin is exactly the clip's.
    const clip = { x: Math.floor(box.x) - 4, y: Math.floor(box.y) - 4, width: Math.ceil(box.width) + 8, height: Math.ceil(box.height) + 8 };
    const png = await page.screenshot({ clip, encoding: 'base64' });
    writeFileSync(path.join(OUT, 'room-teammates-live-dot-faintest.png'), Buffer.from(png as string, 'base64'));
    await page.evaluate(`document.getElementById('teamAgents').getAnimations({ subtree: true }).forEach((a) => a.play())`);
    // The dot's centre — 28px into the 32px face on both axes, read off the
    // dot itself rather than assumed, so a strip standing on a fraction of a
    // pixel does not move the samples onto the fill's edge; the ring is the
    // 2px band 5–7px out from it. Sample it toward the picture's middle,
    // where the picture is — which is where the old ring let it through.
    // A string, not a function: a named helper inside a page function is
    // compiled with a `__name` wrapper the page does not have.
    return page.evaluate(`(async () => {
      const image = new Image();
      image.src = 'data:image/png;base64,${png as string}';
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const scale = image.width / ${clip.width};
      const at = { x: ${dot.x - clip.x}, y: ${dot.y - clip.y} };
      const card = getComputedStyle(document.getElementById('teamAgents')).backgroundColor.match(/\\d+/g).slice(0, 3).map(Number);
      const samples = [[at.x - 6, at.y], [at.x, at.y - 6], [at.x - 4.2, at.y - 4.2]]
        .map(([x, y]) => [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data].slice(0, 3));
      const off = Math.max(...samples.map((rgb) => Math.max(...rgb.map((v, i) => Math.abs(v - card[i])))));
      return { off, samples: JSON.stringify(samples), card: JSON.stringify(card) };
    })()`) as Promise<{ off: number; samples: string; card: string }>;
  })();
  check('the disc’s ring stays solid through the breath, so the picture never shows through it',
    ring.off <= 8, `off by ${ring.off} — ring ${ring.samples} vs card ${ring.card}`);
  check('the face says whose agent it is and that it is working, to a screen reader too',
    (await attrs('#teamAgents .teamface[data-team-agent="leo"]', 'aria-label'))[0] === 'Leo, Dana Ives’s agent, working now. Open',
    (await attrs('#teamAgents .teamface[data-team-agent="leo"]', 'aria-label'))[0]);
  check('an agent still being set up says so and is drawn quieter',
    (await attrs('#teamAgents .teamface.coming', 'data-team-agent')).join('|') === 'otis');
  // One person per line since note #652 (the owner: two people on one line
  // read as one person with everybody's agents once their proposals stood
  // under them), so two people are the head and two lines — still compact.
  const box = await page.$eval('#teamAgents', (node) => Math.round(node.getBoundingClientRect().height));
  check('the strip is compact on a phone: one line per person', box <= 130, `${box}px`);
  check('each person has a line of their own',
    (await page.$$eval('#teamAgents .teamline', (lines) => new Set(lines.map((line) => Math.round(line.getBoundingClientRect().top))).size)) === 2);
  await shot('phone');

  // 4. The live tick moves the disc, with no full read behind it.
  let stateReads = 0;
  page.on('request', (request) => { if (/\/api\/state\b/.test(request.url())) stateReads += 1; });
  working.add('ben:otis');
  working.delete('dana:leo');
  const moved = await page.waitForFunction(
    () => {
      const live = [...document.querySelectorAll('#teamAgents .teamface')].filter((node) => node.querySelector('.livedot'));
      return live.map((node) => node.getAttribute('data-team-agent')).join('|') === 'otis';
    },
    { timeout: 12_000 },
  ).then(() => true).catch(() => false);
  check('the live tick moves the disc from one teammate’s agent to another', moved,
    (await attrs('#teamAgents .teamface:has(.livedot)', 'data-team-agent')).join('|'));
  check('…and Ben’s group now leads', (await texts('#teamAgents .ownername')).join('|') === 'Ben Ortiz|Dana Ives',
    (await texts('#teamAgents .ownername')).join('|'));
  check('…without a full state read', stateReads === 0, `${stateReads} reads`);

  // 5. A face is a door to that agent's read-only page.
  // The person is a door too (the owner, 2026-09-23): their face and name
  // open their page. Both open INSIDE the agents picker, as a page over its
  // cards (note #722): the page on top names the address it draws.
  const pickerPage = () => page.evaluate(() => {
    const pages = [...document.querySelectorAll<HTMLElement>('#agentSwitchSheet .windowpage:not([hidden])')];
    return pages[pages.length - 1]?.dataset.address ?? '';
  });
  await tap(page, '#teamAgents .teamowner.door[data-team-owner-door="dana"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#agentSwitchSheet .windowpage:not([hidden])')?.dataset.address?.startsWith('/workplace/members/dana'), { timeout: 10_000 }).catch(() => {});
  check('a teammate’s face and name open their page', (await pickerPage()).startsWith('/workplace/members/dana'), await pickerPage());
  await openPicker();
  await page.waitForSelector('#teamAgents', { timeout: 10_000 }).catch(() => {});
  await tap(page, '#teamAgents .teamface[data-team-agent="nora"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#agentSwitchSheet .windowpage:not([hidden])')?.dataset.address === '/agents/nora', { timeout: 10_000 }).catch(() => {});
  check('a teammate’s face opens its agent', (await pickerPage()) === '/agents/nora', await pickerPage());
  await page.waitForFunction(() => document.body.textContent?.includes('Dana Ives'), { timeout: 10_000 }).catch(() => {});
  check('…the page says who drives it', Boolean(await page.evaluate(() => document.body.textContent?.includes('Dana Ives'))),
    `${page.url()} :: ${await page.evaluate(() => document.body.textContent?.replace(/\s+/g, ' ').slice(0, 400))}`);

  // 6. The Workplace window's pulse is the READER's agents only (the owner,
  // 2026-09-23: "It should show only information about my agents, not my
  // teammates agents"). With a team it is the reader's own card — their
  // agents' faces, the dot on the working ones — in place of the counts
  // (note #1009). Four teammates' agents here, one mid-turn; none is on it.
  await openWorkplaceWindow(page, ORIGIN);
  await page.waitForSelector('#homeSheet #homePeople .crow .cagent', { timeout: 10_000 }).catch(() => {});
  const pulse = await page.evaluate(() => {
    const own = [...document.querySelectorAll('#homePeople .crow')].find((card) => card.querySelector('.personrole')?.textContent?.startsWith('You'));
    return {
      counts: Boolean(document.getElementById('agentActivity')),
      own: own ? [...own.querySelectorAll('.cagent')].length : -1,
      working: own ? own.querySelectorAll('.cagent .livedot').length : -1,
    };
  });
  check('the workplace pulse is only the reader’s own agents, on their own card', !pulse.counts && pulse.own === 1 && pulse.working === 0, JSON.stringify(pulse));

  // 7. Where a person is described, the agents they drive are named too: a
  // member's own page. (The rooms list named each room's agents, the
  // teammates' among them, until rooms left the product — note #843.)
  await page.goto(`${ORIGIN}/workplace/members/dana`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgMemberAgents .memberagent', { timeout: 10_000 }).catch(() => {});
  const pills = await texts('#orgMemberAgents .memberagent .mname');
  check('a member’s page names every agent they drive here', pills.join('|') === 'Leo|Mia|Nora', pills.join('|'));
  // Each named the room it worked in until rooms left the product (note
  // #843): the page names none.
  const roomsSaid = await texts('#orgMemberAgents .memberagent .mroom');
  const pageWords = await page.$eval('#orgMemberAgents', (node) => node.textContent ?? '');
  check('…and no room any of them works in',
    roomsSaid.length === 0 && !/\broom/i.test(pageWords),
    `${roomsSaid.join('|')} :: ${pageWords}`);
  await shot('member');
  await tap(page, '#orgMemberAgents .memberagent[data-member-agent="mia"]');
  await page.waitForFunction(() => location.pathname.endsWith('/agents/mia'), { timeout: 10_000 }).catch(() => {});
  check('…each a door to its page', new URL(page.url()).pathname === '/agents/mia', page.url());

  // 8. The wide layout.
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });
  await openPicker();
  await page.waitForSelector('#teamAgents', { timeout: 10_000 }).catch(() => {});
  await shot('wide');
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} FAIL`);
  process.exit(1);
}
console.log('\nall checks passed');
