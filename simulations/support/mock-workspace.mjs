import { routesToBackend } from '../../functions/[[path]].js';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createServer as createViteServer } from 'vite';
import { createTeamWorld } from './team-world.mjs';

/**
 * The paths the asset server answers BEFORE the edge Function is invoked:
 * public/_routes.json's excludes (exact paths and `/dir/*` prefixes), plus
 * what only exists in a Vite dev server — its client (`/@vite/client`,
 * `/@react-refresh`, `/@fs/…`), pre-bundled dependencies, and every source
 * module it serves straight off the repository (`/src/…`, and the Workspace
 * components the landing page renders from `/backend/workspace-ui/…`), which
 * is any path that names a file under the repository root. Read once; the
 * file and the tree are the truth.
 */
const ASSET_ROUTES = JSON.parse(readFileSync(new URL('../../public/_routes.json', import.meta.url), 'utf8'));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
function staysOnAssetServer(pathname) {
  if (pathname.startsWith('/@') || pathname.startsWith('/node_modules/')) return true;
  if (ASSET_ROUTES.exclude.some((rule) => (
    rule.endsWith('/*') ? pathname === rule.slice(0, -2) || pathname.startsWith(rule.slice(0, -1)) : pathname === rule
  ))) return true;
  if (pathname.startsWith('/workspace/')) return false;
  try {
    const file = path.join(REPO_ROOT, decodeURIComponent(pathname));
    return file.startsWith(REPO_ROOT) && existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
}

function json(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

function html(res, body) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/**
 * The body, read the way `express.json()` reads it — CONTENT TYPE AND ALL.
 *
 * Parsing whatever arrives would be friendlier and is exactly the lie that
 * cost us the mail reply form: the screen posted a JSON string with the
 * browser's default `text/plain`, this mock happily parsed it, the browser
 * scenario went green, and in production the route received `{}` and told
 * the person to write something first (2026-09-15). A mock that is kinder
 * than the server proves nothing.
 */
async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  const type = String(req.headers['content-type'] || '').toLowerCase();
  // A letter with files (mail slice 12) is bytes, not text: the world reads
  // the envelope the way the backend does, so it gets the Buffer whole.
  if (type.includes('application/vnd.agentbuilt.mail-files')) return Buffer.concat(chunks);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!type.includes('application/json')) return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function cookieValue(req, name) {
  const prefix = `${name}=`;
  const pair = String(req.headers.cookie || '')
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  if (!pair) return '';
  try { return decodeURIComponent(pair.slice(prefix.length)); } catch { return ''; }
}

/** The picture committed for a fixture person: `samira_owner` → samira.svg. */
const personFace = (username) => `/workspace/faces/${username.split('_')[0]}.svg`;

const normalizeTotp = (value) => String(value || '').replace(/\D/g, '');
const normalizeRecovery = (value) => String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');

/**
 * The road after the first room (note #132): the first agent, the
 * subscription sign-in and the first job, as the fixture server
 * holds them. Every field is advanced by ONE user action or, where the real
 * thing happens on the agent's machine or the provider's page, by the reads
 * the UI makes while it waits — the `reads`/`polls` counters below, which is
 * the fixture's stand-in for time passing out of the browser's sight.
 */
function freshJourney() {
  return {
    cloudConnected: false,
    agent: null,       // { status, readsUntilMachine, worked }
    seat: null,        // one WorkspaceSeatRecord once the sign-in lands
    signin: null,      // the ceremony the sign-in screen mirrors
    signinAttempts: 0,
    // The first-day road accepts the account's first-name-based default once
    // a subscription is in (the cloud is ours since note #664; a lived-in
    // team fixture still stands on a cloud of its own, connected before).
    // Lived-in team fixtures keep the explicit organization.name instead.
    workplaceName: null,
    chat: [],          // the agent's transcript
    // The Chief of Staff's conversation — Home (note #726): the platform's
    // greeting row the first time Home opens, the person's first words and
    // the sign-in ask under them, the plan's receipt, and then the first
    // turn's receipts and reply. `turn` is the first run in flight, advanced
    // by the chat's own polls (the fixture's clock for the agent's work).
    recap: { messages: [], greeted: false, awaitingSeat: false, turn: null },
    // The team the Chief of Staff brings in on its first turn (note #726):
    // one room named after the work, two agents planned in it, their
    // computers coming up on the state reads. Nothing is furnished at
    // founding any more — the workplace has no room and no agent before.
    team: null,        // { rooms: [{ roomId, name }], agents: [{ id, name, roomId, status, readsUntilBuilding, readsUntilReady, worked }] }
  };
}

/** The agents the Chief of Staff brought in, as `api/state` rows: planned, then setting up, then ready. */
function teamAgentRows(fixture, journey) {
  if (!journey.team) return [];
  return journey.team.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    cli: journey.seat ? fixture.agent.cli : 'claude',
    ...(journey.seat ? { model: fixture.agent.model, effort: fixture.agent.effort } : {}),
    status: agent.status,
    avatarUrl: `/workspace/avatars/${agent.name.toLowerCase()}`,
    roomId: agent.roomId,
    createdAt: '2026-09-06T08:00:00.000Z',
    ...(agent.worked
      ? { lastActiveAt: '2026-09-06T08:05:00.000Z', lastReply: { text: fixture.firstJob.reply, at: '2026-09-06T08:05:00.000Z' } }
      : {}),
  }));
}

function agentRow(fixture, journey) {
  const { agent } = journey;
  if (!agent) return [];
  return [{
    id: fixture.agent.id,
    name: fixture.agent.name,
    cli: fixture.agent.cli,
    model: fixture.agent.model,
    effort: fixture.agent.effort,
    status: agent.status,
    avatarUrl: `/workspace/avatars/${fixture.agent.name.toLowerCase()}`,
    roomId: fixture.room.roomId,
    createdAt: '2026-09-06T08:00:00.000Z',
    ...(agent.worked
      ? { lastActiveAt: '2026-09-06T08:05:00.000Z', lastReply: { text: fixture.firstJob.reply, at: '2026-09-06T08:05:00.000Z' } }
      : {}),
  }];
}

function seatRecord(fixture) {
  return {
    seatId: 'seat_fixture_codex',
    provider: fixture.agent.cli,
    label: fixture.signin.seatLabel,
    planText: 'Plus',
    status: 'active',
    selected: true,
    createdAt: '2026-09-06T08:03:00.000Z',
    windows: [],
  };
}

function workspaceState(fixture, workspaceStage, journey, account) {
  const hasOrganization = workspaceStage === 'workplace-created' || workspaceStage === 'named' || workspaceStage === 'room-created';
  const hasRoom = workspaceStage === 'room-created';
  // The workplace is made WITH the account. `workplace-created` is the spare,
  // still-unnamed workplace the account came with; a subscription accepts
  // its first-name-based default and moves it to `named` automatically —
  // with no room and no agent in it (note #726), until the Chief of Staff
  // opens one. (`room-created` is the older first-room road's lived-in
  // workplace, which the returning-sign-in scenarios still start on.)
  const unnamed = workspaceStage === 'workplace-created';
  const organization = hasOrganization
    ? {
        id: fixture.organization.id,
        orgId: fixture.organization.id,
        name: unnamed ? fixture.organization.defaultName : journey.workplaceName ?? fixture.organization.name,
        ...(unnamed ? { unnamed: true } : {}),
        role: 'admin',
        members: 1,
        seats: journey.seat ? 1 : 0,
        seatProviders: journey.seat ? [journey.seat.provider] : [],
        paymentRequiredSeatProviders: [],
        seatUsage: journey.seat
          ? [{ seatId: journey.seat.seatId, provider: journey.seat.provider, label: journey.seat.label, planText: journey.seat.planText, selected: true, windows: [] }]
          : [],
      }
    : null;

  // No gate stands in front of any workplace since note #726: the real
  // backend answers `setupRequired: false` on every read, so nothing of the
  // kind is written here either — no `arriving`, no `founded`.
  const team = journey.team;
  return {
    agents: team ? teamAgentRows(fixture, journey) : hasRoom ? agentRow(fixture, journey) : [],
    user: {
      name: account.displayName,
      profile: { firstName: account.firstName ?? account.displayName, lastName: account.lastName ?? '', incomplete: false, photoUrl: personFace(account.username) },
      account: { browserLogin: { enabled: true, username: account.username } },
    },
    // `organization` is the variable above; the three lines below said
    // `workplace` — the product's word for the same thing, but not a name
    // that exists here. In a module that is a ReferenceError, thrown while
    // answering `api/state`, so every scenario on this fixture met "Your
    // workspace could not be read — workplace is not defined" instead of Home.
    org: organization,
    organizations: organization
      ? [{ orgId: organization.orgId, name: organization.name, role: organization.role, active: true, members: 1, agents: hasRoom ? agentRow(fixture, journey).length : 0 }]
      : [],
    canCreateOrg: !organization,
    rooms: team ? team.rooms : hasRoom ? [fixture.room] : [],
    room: team ? team.rooms[0].roomId : hasRoom ? fixture.room.roomId : null,
    secrets: [],
    prs: [],
    knowledgeProposals: [],
    repos: [],
    sites: [],
    knowledge: [],
    notes: [],
    notesArchived: 0,
    noteFiles: true,
    quota: { userUsedBytes: 0, userMaxBytes: 5_000_000_000 },
  };
}

function cloneFailurePlan(plan) {
  return new Map(Object.entries(plan || {}).map(([action, failures]) => [
    action,
    (Array.isArray(failures) ? failures : [failures]).map((failure) => ({
      status: failure.status || 503,
      error: failure.error || 'The fixture asked this request to fail.',
    })),
  ]));
}

/** A port the kernel has just confirmed is free, for Vite's own websocket. */
async function freeLocalPort() {
  const probe = createHttpServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('the port probe received no TCP address')));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/**
 * Runs the real landing application and the real, built Workspace shell against a
 * stateful, fixture-only HTTP boundary. Authentication and Workspace setup
 * are separate state machines: a browser session can disappear without also
 * erasing the existing workplace, room, identity, or spent recovery codes.
 * Nothing under /workspace can fall through to Vite or a live backend.
 *
 * Two people can hold sessions at once: the owner from `onboarding.json`, and
 * — with `world: 'team'` — the member from `team.json`. Each has their own
 * cookie and CSRF token, so a request says who made it and the fixture can
 * answer as an admin or as a member.
 */
/** Names this fixture treats as already handed out. */
const TAKEN_MAIL_LOCALS = new Set(['adam', 'samira', 'leo']);

export async function startMockWorkspace(repoRoot, options = {}) {
  const fixtureDir = path.join(repoRoot, 'simulations', 'fixtures');
  const fixture = JSON.parse(readFileSync(path.join(fixtureDir, 'onboarding.json'), 'utf8'));
  const team = options.world === 'team' ? JSON.parse(readFileSync(path.join(fixtureDir, 'team.json'), 'utf8')) : null;
  if (options.world && options.world !== 'team') throw new Error(`Unknown fixture world: ${options.world}`);
  // The React Workspace shell as `npm run build` (in backend/) leaves it:
  // one index.html served at every Workspace address, hashed assets beside it.
  const shellDir = path.join(repoRoot, 'backend', 'dist', 'workspace-ui');
  const workspaceHtml = readFileSync(path.join(shellDir, 'index.html'), 'utf8');

  // The faces. Agents wear the PRODUCT'S OWN avatars — the same jpgs a real
  // agent gets, served at the address the real backend serves them at — and
  // the fixture's people and workplace wear pictures committed beside the
  // fixture. Nothing here is a placeholder: every surface that draws a face
  // in the shipped app draws one of these, so a screenshot never shows the
  // grey fallback glyph.
  const avatarDir = path.join(repoRoot, 'backend', 'assets', 'agent-avatars');
  const faceDir = path.join(fixtureDir, 'faces');

  const requests = [];
  const faults = [];
  const failurePlan = cloneFailurePlan(options.transientFailures);
  const consumedRecoveryCodes = new Set(
    (options.consumedRecoveryCodes || []).map(normalizeRecovery),
  );

  // ── People ──
  // Every account this fixture knows: whether it exists yet, and the cookie
  // and token that name it on a request.
  const makeAccount = (spec, security, extra) => ({
    username: spec.username,
    displayName: spec.displayName,
    firstName: spec.firstName,
    lastName: spec.lastName,
    totpCode: spec.totpCode,
    mailbox: spec.mailbox,
    password: spec.password,
    userId: extra.userId,
    sessionCookie: security.sessionCookie,
    csrfToken: security.csrfToken,
    sessionId: `session_${spec.username}`,
    exists: extra.exists,
  });
  const owner = makeAccount(fixture.account, fixture.security, {
    userId: team?.owner.userId ?? 'user_fixture',
    exists: options.existingIdentity === true || Boolean(team),
  });
  const accounts = [owner];
  if (team) {
    const joiner = makeAccount(team.member, team.member.security, {
      userId: team.member.userId,
      exists: (options.stage || 'joined') !== 'invite',
    });
    // A person who already has an account when the link reaches them
    // (`invite-known`) wears the name they signed up with.
    if (options.stage === 'invite-known') joiner.displayName = `${team.member.firstName} ${team.member.lastName}`;
    accounts.push(joiner);
  }
  const accountByUsername = (username) => accounts.find((account) => account.username === username) ?? null;
  const sessionAccount = (req) => {
    const cookie = cookieValue(req, 'acc_session') || cookieValue(req, '__Host-acc_session');
    const account = accounts.find((row) => row.sessionCookie === cookie);
    return account && account.exists ? account : null;
  };

  let workspaceStage = team ? 'room-created' : (options.workspaceStage || 'empty');
  const journey = freshJourney();
  if (team) {
    journey.cloudConnected = true;
    journey.agent = { status: 'ready', readsUntilMachine: 0, worked: true };
    journey.seat = seatRecord(fixture);
  }
  const world = team ? createTeamWorld({ fixture, team, stage: options.stage || 'joined' }) : null;
  // The subscription landing accepts the account's first-name-based default
  // as the workplace's name — and founds NOTHING else (note #726): no room,
  // no agent. The team is the Chief of Staff's to bring in, on its first
  // turn, for the work the person named.
  const foundFirstWorkplace = (name) => {
    if (workspaceStage !== 'workplace-created') return;
    workspaceStage = 'named';
    journey.workplaceName = name;
  };
  /** The Chief of Staff opening its room and bringing its agents in, one receipt per chat poll. */
  const firstRun = fixture.firstRun;
  const openTeamRoom = () => {
    journey.team = { rooms: [{ roomId: firstRun.room.roomId, name: firstRun.room.name }], agents: [] };
  };
  const bringIn = (agent, index) => {
    journey.team.agents.push({
      id: agent.id, name: agent.name, roomId: firstRun.room.roomId, status: 'planned',
      // Planned on the read that first lists it (the read decrements before
      // it answers, so two), then its computer being built, then ready —
      // staggered so the card is seen moving.
      readsUntilBuilding: 2, readsUntilReady: 2 + index, worked: false,
    });
  };
  // The Chief of Staff's conversation, as the real route answers it.
  const recapAnswer = () => ({
    orgId: fixture.organization.id,
    messages: journey.recap.messages,
    working: Boolean(journey.recap.turn),
    ...(journey.recap.turn ? { phase: 'Thinking…' } : {}),
    waiting: [],
    ...(journey.recap.awaitingSeat ? { awaitingSeat: true } : {}),
    avatarUrl: '/workspace/avatars/workspace-agent',
  });
  const recapRow = (role, text, extra = {}) => {
    journey.recap.messages.push({ id: `recap_${journey.recap.messages.length + 1}`, role, text, at: new Date().toISOString(), ...extra });
  };

  if (!['empty', 'workplace-created', 'named', 'room-created'].includes(workspaceStage)) {
    throw new Error(`Unknown fixture Workspace stage: ${workspaceStage}`);
  }

  const fault = (message) => {
    throw new Error(message);
  };
  const expectWorkspaceStage = (expected, action) => {
    if (workspaceStage !== expected) {
      fault(`${action} arrived during Workspace ${workspaceStage}, expected ${expected}`);
    }
  };
  const expectJson = (actual, expected, action) => {
    if (!isDeepStrictEqual(actual, expected)) {
      fault(`${action} sent ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  };
  // Account creation carries where the browser first came from
  // (shared/first-visit.ts). The harness opens pages directly, so no site is
  // named; the rest of the body is checked exactly, as before.
  const withoutFirstVisit = (body, action) => {
    const { firstVisit, ...rest } = body ?? {};
    if (!firstVisit || firstVisit.from !== '' || !String(firstVisit.page).startsWith('/') || Number.isNaN(Date.parse(firstVisit.at))) {
      fault(`${action} sent first visit ${JSON.stringify(firstVisit)}, expected one naming no site`);
    }
    return rest;
  };
  const expectSession = (req, respondJson) => {
    const account = sessionAccount(req);
    if (account) return account;
    respondJson(401, { error: 'Browser authentication required.' });
    return null;
  };
  const expectCsrf = (req, action) => {
    const account = sessionAccount(req);
    if (!account || req.headers['x-csrf-token'] !== account.csrfToken) {
      fault(`${action} did not carry the fixture CSRF token`);
    }
  };
  const sessionHeaders = (account) => ({
    'Set-Cookie': [
      `acc_session=${account.sessionCookie}; HttpOnly; Path=/; SameSite=Lax`,
      `acc_csrf=${account.csrfToken}; Path=/; SameSite=Strict`,
    ],
  });
  const sessionAnswer = (account) => ({
    authenticated: true,
    username: account.username,
    displayName: account.displayName,
    session: {
      sessionId: account.sessionId,
      createdAt: '2026-09-06T09:00:00.000Z',
      lastSeenAt: new Date().toISOString(),
      absoluteExpiresAt: '2026-10-06T09:00:00.000Z',
    },
  });
  const failAsPlanned = (action, respondJson) => {
    const pending = failurePlan.get(action) || [];
    const next = pending.shift();
    if (!next) return false;
    respondJson(next.status, { error: next.error });
    return true;
  };

  const handleWorkspace = async (req, res, url) => {
    // What the edge sends to the backend (functions/[[path]].js, the rule
    // that ships): since public-addresses slice 5, everything but the
    // landing site's own pages — and the root itself only for a signed-in
    // browser. What never reaches the Function in production is what
    // public/_routes.json excludes (the landing site's files), so that list
    // is read here too; in this dev server Vite's own module paths are the
    // asset server's as well.
    if (staysOnAssetServer(url.pathname)) return false;
    if (!routesToBackend(url.pathname, req.headers.cookie || '', url.search)) return false;
    const body = await requestBody(req);
    const record = {
      method: req.method,
      path: url.pathname,
      search: url.search,
      body,
      csrf: req.headers['x-csrf-token'] || null,
      session: Boolean(sessionAccount(req)),
      user: sessionAccount(req)?.username ?? null,
      status: null,
    };
    requests.push(record);
    const respondJson = (status, responseBody, headers) => {
      record.status = status;
      json(res, status, responseBody, headers);
    };
    const respondHtml = (responseBody) => {
      record.status = 200;
      html(res, responseBody);
    };

    /**
     * BYTES, not JSON: a world answering with a picture (mail's inline and
     * proxied images, note #509 slice 10). The same record is kept, so a
     * scenario can still assert what was asked for and what was not.
     */
    const respondBytes = (status, contentType, buffer, headers = {}) => {
      record.status = status;
      res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...headers });
      res.end(buffer);
    };

    const sendFile = (file, type) => {
      if (!existsSync(file)) {
        record.status = 404;
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('No such file');
        return true;
      }
      record.status = 200;
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(readFileSync(file));
      return true;
    };

    // `/workspace/avatars/<slug>` is the real route, answering from the real
    // pool: a name with no dog is a 404 here exactly as it is in production.
    if (req.method === 'GET' && url.pathname.startsWith('/workspace/avatars/')) {
      const slug = path.basename(decodeURIComponent(url.pathname));
      // Letters only, plus the Workspace Agent's one reserved hyphenated slug (note #434).
      if (!/^[a-z]+$/.test(slug) && slug !== 'workspace-agent') fault(`an avatar was asked for by a name the pool cannot hold: ${slug}`);
      return sendFile(path.join(avatarDir, `${slug}.jpg`), 'image/jpeg');
    }

    if (req.method === 'GET' && url.pathname.startsWith('/workspace/faces/')) {
      const name = path.basename(decodeURIComponent(url.pathname));
      if (!/^[a-z-]+\.svg$/.test(name)) fault(`a fixture face was asked for by an odd name: ${name}`);
      return sendFile(path.join(faceDir, name), 'image/svg+xml');
    }

    if (req.method === 'GET' && (
      ['/workspace', '/workspace/', '/workspace/signup'].includes(url.pathname)
      || url.pathname.startsWith('/workspace/invite/')
      // Every Workspace screen has its own address; a full reload of any of
      // them is served the same shell, exactly as the backend does.
      || (!url.pathname.startsWith('/workspace/api/') && !url.pathname.startsWith('/workspace/auth/') && !url.pathname.startsWith('/workspace/app/'))
    )) {
      respondHtml(workspaceHtml);
      return true;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/workspace/app/assets/')) {
      const name = path.basename(url.pathname);
      const file = path.join(shellDir, 'assets', name);
      if (!existsSync(file)) {
        record.status = 404;
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('No such asset');
        return true;
      }
      record.status = 200;
      const type = name.endsWith('.css') ? 'text/css; charset=utf-8'
        : name.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(readFileSync(file));
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/workspace/auth/session') {
      const account = sessionAccount(req);
      if (!account) respondJson(401, { authenticated: false });
      else respondJson(200, sessionAnswer(account));
      return true;
    }

    // Choosing your own address (note #509): the signup field asks whether a
    // name is free while it is typed. The fixture keeps a couple of names
    // taken so a scenario can picture both answers.
    if (req.method === 'GET' && url.pathname === '/workspace/auth/email/address') {
      const local = String(url.searchParams.get('local') || '').trim().toLowerCase();
      respondJson(200, {
        local,
        address: `${local}@agenticcloudcomputer.com`,
        available: !TAKEN_MAIL_LOCALS.has(local),
      });
      return true;
    }

    // Creating an account (note #509, then #144): the name they chose here,
    // a password, and — first — their own name. The session opens on the
    // answer itself; there is nothing to confirm.
    if (req.method === 'POST' && url.pathname === '/workspace/auth/email/register') {
      // A second person arriving through an invite link (the team world's
      // `invite` stage) makes an account the same way — and, exactly as the
      // real route does, gets an unnamed workplace of their own with it,
      // whether or not they came to join somebody else's.
      const joiner = accounts[1];
      if (world && joiner && !joiner.exists && body?.mailbox === team.member.mailbox) {
        expectJson(withoutFirstVisit(body, 'the joiner’s account creation'), {
          mailbox: team.member.mailbox,
          password: team.member.password,
          firstName: team.member.firstName,
          lastName: team.member.lastName,
        }, 'the joiner’s account creation');
        joiner.exists = true;
        joiner.displayName = `${team.member.firstName} ${team.member.lastName}`;
        world.registered(joiner);
        respondJson(201, { authenticated: true, address: `${team.member.mailbox}@agenticcloudcomputer.com` }, sessionHeaders(joiner));
        return true;
      }
      if (owner.exists) fault('an account was created twice');
      expectJson(withoutFirstVisit(body, 'account creation'), {
        mailbox: fixture.account.mailbox,
        password: fixture.account.password,
        firstName: fixture.account.firstName,
        lastName: fixture.account.lastName,
      }, 'account creation');
      owner.exists = true;
      owner.displayName = `${fixture.account.firstName} ${fixture.account.lastName}`;
      // The spare workplace is made with the account; its default becomes the
      // real name only if this person connects its cloud and subscription.
      if (workspaceStage === 'empty') workspaceStage = 'workplace-created';
      respondJson(201, { authenticated: true, address: `${fixture.account.mailbox}@agenticcloudcomputer.com` }, sessionHeaders(owner));
      return true;
    }

    // Signing in with the address here and a password (PR #854): the name
    // before the @, matched against the account that chose it.
    if (req.method === 'POST' && url.pathname === '/workspace/auth/email/login') {
      const account = accounts.find((row) => row.mailbox === String(body?.email ?? '').toLowerCase());
      if (!account || !account.exists || body?.password !== account.password) {
        respondJson(400, { error: 'That name and password do not match.', code: 'invalid_credentials' });
        return true;
      }
      respondJson(200, { authenticated: true }, sessionHeaders(account));
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/workspace/auth/login') {
      const account = accountByUsername(body?.username);
      if (!account || !account.exists || normalizeTotp(body?.code) !== normalizeTotp(account.totpCode)) {
        respondJson(400, { error: 'Invalid username or one-time code.', code: 'invalid_credentials' });
        return true;
      }
      respondJson(200, { authenticated: true }, sessionHeaders(account));
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/workspace/auth/recovery') {
      const normalizedCode = normalizeRecovery(body?.recoveryCode);
      const knownCodes = fixture.recoveryCodes.map(normalizeRecovery);
      if (!owner.exists
        || body?.username !== owner.username
        || !knownCodes.includes(normalizedCode)
        || consumedRecoveryCodes.has(normalizedCode)) {
        respondJson(400, { error: 'Invalid username or recovery code.', code: 'invalid_credentials' });
        return true;
      }
      consumedRecoveryCodes.add(normalizedCode);
      respondJson(200, { authenticated: true, usedRecoveryCode: true }, sessionHeaders(owner));
      return true;
    }

    // The lived-in Workspace answers what it knows first — its own people,
    // notes, chats and decisions — and lets the first-day handlers below
    // serve the rest (the cloud read, the seat sign-in).
    if (world && world.handle({ req, url, body, account: sessionAccount(req), respondJson, respondBytes, expectCsrf, expectJson, fault })) {
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/workspace/api/state') {
      const account = expectSession(req, respondJson);
      if (!account) return true;
      // A state read is the only clock the agent's machine has: the second
      // read after the create finds the machine ready and the row paused on
      // its sign-in, the way the real row comes up a minute or two later.
      if (journey.agent && journey.agent.status === 'setting-up') {
        journey.agent.readsUntilMachine -= 1;
        if (journey.agent.readsUntilMachine <= 0) journey.agent.status = 'needs-seat';
      }
      // The agents the Chief of Staff brought in (note #726): planned on the
      // read that first lists them, their computers being built on the next,
      // ready a read or two later — each on its own clock, so the card at
      // the foot of Home's log is seen moving.
      if (journey.team && journey.seat) {
        for (const agent of journey.team.agents) {
          if (agent.status === 'ready') continue;
          if (agent.status === 'planned') {
            agent.readsUntilBuilding -= 1;
            if (agent.readsUntilBuilding <= 0) agent.status = 'setting-up';
            continue;
          }
          agent.readsUntilReady -= 1;
          if (agent.readsUntilReady <= 0) agent.status = 'ready';
        }
      }
      respondJson(200, world ? world.state(account, journey) : workspaceState(fixture, workspaceStage, journey, account));
      return true;
    }

    // The workplace's decision queue, for the agents picker (note #721; it
    // was every room's, for the picker's All tab, until rooms left the
    // product — note #843). These worlds keep their proposals on the state read, so
    // the same rows answer here — without the state read's clock ticking.
    if (req.method === 'GET' && url.pathname === '/workspace/api/decisions') {
      const account = expectSession(req, respondJson);
      if (!account) return true;
      const now = world ? world.state(account, journey) : workspaceState(fixture, workspaceStage, journey, account);
      // Only what still waits on this reader, as the real route answers
      // (`pullRequestAwaitsDecision`, `proposalOwnedByViewer`): the state's
      // lists also carry what was decided, and a merged change drawn in the
      // picker's queue is a decision that cannot be taken.
      const waiting = (rows) => (rows ?? []).filter((row) => row.status === 'open' && row.canDecide !== false);
      respondJson(200, { prs: waiting(now.prs), knowledgeProposals: waiting(now.knowledgeProposals) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/workspace/api/recap') {
      const account = expectSession(req, respondJson);
      if (!account) return true;
      const now = new Date().toISOString();
      // The answer still carries the Workspace Agent's state, as the real
      // route's does, but on the first day it is the state of an agent
      // nobody started (note #656): no machine, no turn, nothing said. The
      // briefing card draws none of it; the face is the reserved one
      // production hands out (note #434).
      const agent = {
        name: 'Workspace Agent', started: false, working: false, waiting: [],
        avatarUrl: '/workspace/avatars/workspace-agent',
      };
      // A briefing is one room's (note #688): the answer names the room it
      // was asked about, or the one the state stands in, as the real route's
      // does — the card takes no answer for another room.
      const roomId = url.searchParams.get('room') ?? workspaceState(fixture, workspaceStage, journey, account).room;
      respondJson(200, { orgId: fixture.organization.id, roomId, agent, summary: null, updating: false, stale: false, sources: [], since: now, checkedAt: now, incomplete: false });
      return true;
    }

    // The Chief of Staff's conversation — Home since 2026-10-10, and where
    // the first ten minutes happen since note #726. The first read of a
    // brand-new workplace writes the platform's greeting row, once; while a
    // turn runs, each read is the clock for the agent's work: one receipt
    // per poll (the room opened, each agent brought in), then its reply.
    // The lived-in world answers this address with its own transcript first.
    if (req.method === 'GET' && url.pathname === '/workspace/api/recap/chat' && !world) {
      if (!expectSession(req, respondJson)) return true;
      const fresh = workspaceStage === 'workplace-created' || workspaceStage === 'named';
      if (fresh && !journey.recap.greeted && journey.recap.messages.length === 0) {
        journey.recap.greeted = true;
        recapRow('assistant', firstRun.greeting, { kind: 'greeting' });
      }
      const turn = journey.recap.turn;
      if (turn) {
        turn.polls += 1;
        // The agents' unseen home room; no "Opened the room" since note #843.
        if (turn.polls === 1) openTeamRoom();
        else if (turn.polls <= 1 + firstRun.agents.length) {
          const agent = firstRun.agents[turn.polls - 2];
          bringIn(agent, turn.polls - 2);
          recapRow('action', `Brought in ${agent.name}.`);
        } else {
          journey.recap.turn = null;
          recapRow('assistant', firstRun.plan);
        }
      }
      respondJson(200, recapAnswer());
      return true;
    }

    // The person's message to the Chief of Staff (note #726). With no plan
    // signed in there is nothing to think with: the words are kept as the
    // first real request and answered in the agent's voice with the
    // sign-in ask — the first time; after that, that the card is above. No
    // turn starts; the plan landing starts one (the sign-in below).
    if (req.method === 'POST' && url.pathname === '/workspace/api/recap/chat' && !world) {
      if (!expectSession(req, respondJson)) return true;
      expectCsrf(req, 'a message to the Chief of Staff');
      if (typeof body?.text !== 'string' || !body.text.trim() || typeof body?.clientId !== 'string' || !body.clientId) {
        fault(`a message to the Chief of Staff sent ${JSON.stringify(body)}, expected { clientId, text }`);
      }
      if (journey.seat || journey.recap.turn) fault('this road writes to the Chief of Staff only before its plan is signed in');
      recapRow('owner', body.text);
      recapRow('assistant', journey.recap.awaitingSeat ? firstRun.askAgain : firstRun.ask, { kind: 'signin-ask' });
      journey.recap.awaitingSeat = true;
      respondJson(202, recapAnswer());
      return true;
    }

    // The model the briefing is written with, read by the control under it.
    // Unanswered, this faulted every scenario that stayed on the tabbed
    // screen long enough for the card to mount — which the queue and tour
    // scenarios do. The Workspace Agent's own settings are read by its
    // conversation — which is Home since 2026-10-10, so every visit to `/`
    // asks for them.
    if (req.method === 'GET' && (url.pathname === '/workspace/api/recap/settings' || url.pathname === '/workspace/api/recap/agent/settings')) {
      if (!expectSession(req, respondJson)) return true;
      respondJson(200, { orgId: fixture.organization.id, settings: null, models: [] });
      return true;
    }

    // The Chief of Staff on its own (note #716), read by its cards in the
    // Workplace window: off, as every member starts, with nothing noticed.
    if (req.method === 'GET' && url.pathname === '/workspace/api/recap/agent/proactive') {
      if (!expectSession(req, respondJson)) return true;
      respondJson(200, {
        orgId: fixture.organization.id,
        settings: {
          events: false,
          thresholds: { proposalHours: 24, reportHours: 24, noteHours: 48 },
          quietFrom: 23, quietTo: 8, timeZone: 'UTC',
          permissions: { 'reset-finished-agent': false, 'hand-unclaimed-note': false, 'ask-silent-agent': false, 'archive-finished-note': false },
        },
        recent: [],
      });
      return true;
    }

    // The Workspace Agent's own details, read by its cards at the foot of
    // Home's Workplace window (note #715).
    // On the first day it is an agent nobody started (note #656): no record,
    // no machine, no model picked. The lived-in world answers this address
    // itself first.
    if (req.method === 'GET' && url.pathname === '/workspace/api/recap/agent' && !world) {
      if (!expectSession(req, respondJson)) return true;
      respondJson(200, {
        orgId: fixture.organization.id,
        agent: { name: 'Workspace Agent', started: false, working: false, waiting: [], avatarUrl: '/workspace/avatars/workspace-agent' },
        settings: null,
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/workspace/api/notifications') {
      if (!expectSession(req, respondJson)) return true;
      respondJson(200, {
        notifications: [],
        unread: 0,
        push: { available: false, subscriptions: 0 },
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/workspace/api/notifications/read') {
      if (!expectSession(req, respondJson)) return true;
      expectCsrf(req, 'notification read');
      respondJson(200, { marked: 0 });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/workspace/api/agents/live') {
      if (!expectSession(req, respondJson)) return true;
      respondJson(200, { agents: [], recaps: [], sessionLimits: [] });
      return true;
    }

    // Home asks admins who is waiting before it draws the briefing.
    // The first-day worlds have only their founder, so the honest answer is
    // empty; the lived-in team world handles this route above with its live
    // request list.
    if (req.method === 'GET' && url.pathname === '/workspace/api/org/join-requests') {
      if (!expectSession(req, respondJson)) return true;
      respondJson(200, { joinRequests: [] });
      return true;
    }

    // A member's contribution here (note #925): a first-day world has none yet.
    if (req.method === 'GET' && /^\/workspace\/api\/org\/members\/[^/]+\/contribution$/.test(url.pathname)) {
      if (!expectSession(req, respondJson)) return true;
      respondJson(200, {
        weekStart: '2026-10-26', tokensFrom: '2026-10-10',
        week: { workingMs: 0, merged: 0, tokens: {} }, allTime: { workingMs: 0, merged: 0, tokens: {} }, merged: [],
      });
      return true;
    }
    if (req.method === 'GET' && (url.pathname === '/workspace/api/org/people' || url.pathname === '/workspace/api/org/people/live')) {
      const account = expectSession(req, respondJson);
      if (!account) return true;
      const me = {
        userId: account.userId, name: account.displayName, photoUrl: personFace(account.username),
        you: true, role: 'admin', joinedAt: '2026-09-06T07:00:00.000Z', agents: journey.team ? journey.team.agents.length : journey.agent ? 1 : 0,
      };
      respondJson(200, url.pathname.endsWith('/live')
        ? { people: [] }
        : { org: { orgId: fixture.organization.id, name: fixture.organization.name, role: 'admin' }, people: [me] });
      return true;
    }

    // ── The road after the first room (note #132) ─────────────────────────
    if (req.method === 'GET' && url.pathname === '/workspace/api/org/cloud') {
      if (!expectSession(req, respondJson)) return true;
      respondJson(200, {
        orgId: fixture.organization.id,
        role: 'admin',
        // Hosted on ours unless the lived-in team connected its own before
        // note #664; a hosted workplace's machines are never counted here.
        fly: journey.cloudConnected
          ? { connected: true, orgSlug: fixture.cloud.orgSlug, peer: 'up' }
          : {
            connected: false, hosted: true,
            agents: { used: journey.team ? journey.team.agents.length : journey.agent ? 1 : 0, limit: 20 },
            sites: { used: 0, limit: 10 },
          },
        machines: journey.cloudConnected
          ? { active: journey.team ? journey.team.agents.filter((agent) => agent.status !== 'planned').length : journey.agent ? (world ? 2 : 1) : 0, sleeping: 0, checkedAt: new Date().toISOString() }
          : null,
      });
      return true;
    }

    // Nothing on any road connects a cloud any more (note #664): the real
    // backend refuses it for a hosted workplace, and a UI that asks is a bug.
    if (req.method === 'POST' && url.pathname === '/workspace/api/org/fly') {
      if (!expectSession(req, respondJson)) return true;
      fault('the UI asked to connect a cloud, and there is none to connect (note #664)');
      respondJson(409, { error: 'This workplace runs on our cloud, so there is no cloud account to connect.' });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/workspace/api/agents') {
      if (!expectSession(req, respondJson)) return true;
      expectWorkspaceStage('room-created', 'agent creation');
      expectCsrf(req, 'agent creation');
      if (journey.agent) fault('a second agent was created during the first journey');
      // The CLI alone: the create named the room it stood in too, until
      // rooms left the Workspace (note #843) and an agent became the
      // workplace's.
      expectJson(body, { cli: fixture.agent.cli }, 'agent creation');
      journey.agent = { status: 'setting-up', readsUntilMachine: 2, worked: false };
      respondJson(201, { ok: true });
      return true;
    }

    if (url.pathname === '/workspace/api/org/signin') {
      if (!expectSession(req, respondJson)) return true;
      if (req.method === 'POST') {
        expectCsrf(req, 'subscription sign-in');
        // Either provider may be asked for (the Claude ceremony has its own
        // screen, pictured by `_claude-signin-shot.mjs`); the journeys still
        // pin which one THEY sent through `assertRequestCount`. Neither needs
        // a machine: the backend asks both providers itself (2026-09-22).
        const asked = body?.provider === 'claude' ? 'claude' : fixture.agent.cli;
        expectJson(body, { provider: asked }, 'subscription sign-in');
        journey.signinAttempts += 1;
        // The provider the screen asked for: Claude's ceremony pastes a code
        // back (awaiting_code); ChatGPT's shows one to approve with.
        journey.signin = {
          provider: asked,
          startedAt: new Date().toISOString(),
          polls: 0,
          state: asked === 'claude'
            ? { phase: 'awaiting_code', url: fixture.signin.claudeUrl ?? fixture.signin.url }
            : { phase: 'awaiting_approval', url: fixture.signin.url, userCode: fixture.signin.userCode },
        };
      } else if (req.method === 'DELETE') {
        expectCsrf(req, 'subscription sign-in cancel');
        journey.signin = null;
        respondJson(200, { ok: true });
        return true;
      } else if (req.method === 'GET' && journey.signin && journey.signin.state.phase === 'awaiting_approval') {
        // The approval happens on the provider's page, out of the browser's
        // sight; the screen's polls are the clock. The first attempt expires
        // (the failure Emma's live test hit twice), the second lands.
        journey.signin.polls += 1;
        if (journey.signin.polls >= 2) {
          if (journey.signinAttempts === 1 && workspaceStage !== 'workplace-created' && !journey.recap.awaitingSeat) {
            journey.signin.state = { phase: 'failed', reason: fixture.signin.failure };
          } else {
            journey.seat = seatRecord(fixture);
            if (journey.agent) journey.agent.status = 'ready';
            if (workspaceStage === 'workplace-created') {
              foundFirstWorkplace(fixture.organization.defaultName);
            }
            // The plan landed (note #726): the receipt row in the Chief of
            // Staff's chat and — when the person wrote while no plan was in
            // — their words become the first real request now, as a turn
            // that starts by itself: the FIRST RUN, which opens one room
            // and brings a team in on the chat's next polls.
            if (journey.recap.awaitingSeat) {
              journey.recap.awaitingSeat = false;
              recapRow('action', journey.seat.provider === 'claude' ? 'Your Claude plan is signed in.' : 'Your ChatGPT plan is signed in.');
              journey.recap.turn = { polls: 0 };
            }
            journey.signin.state = { phase: 'done', seatId: journey.seat.seatId, label: journey.seat.label };
          }
        }
      }
      const { polls: _polls, ...signin } = journey.signin || {};
      respondJson(200, { signin: journey.signin ? signin : null });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/workspace/api/org/seats') {
      if (!expectSession(req, respondJson)) return true;
      respondJson(200, { seats: journey.seat ? [journey.seat] : [], available: [] });
      return true;
    }

    // The public reads the front door makes for a visitor since note #774:
    // the newest apps (and, until note #786, this week's board). Anonymous, like the
    // pages they come from; nobody in these journeys has built anything yet.
    if (req.method === 'GET' && url.pathname === '/workspace/api/public/apps') {
      respondJson(200, { apps: [] });
      return true;
    }
    // The founder's card (note #786) reads the founder's public address. No
    // such person lives in these worlds, so it answers as the real backend
    // does for a word nobody holds, and the card stands down to its door.
    if (req.method === 'GET' && url.pathname.startsWith('/workspace/api/public/addresses/')) {
      respondJson(404, { error: 'Nothing at this address.' });
      return true;
    }
    // Settings → Your builder page (note #824): no X profile added.
    if (req.method === 'GET' && url.pathname === '/workspace/api/profile/x') {
      if (!expectSession(req, respondJson)) return true;
      respondJson(200, {});
      return true;
    }

    // The same screen's second read: the tokens this person's agents spent.
    // Nobody in these journeys has run a turn the ledger counted.
    if (req.method === 'GET' && url.pathname === '/workspace/api/org/tokens') {
      if (!expectSession(req, respondJson)) return true;
      respondJson(200, { since: new Date().toISOString().slice(0, 10), weeks: [] });
      return true;
    }

    // Every agent chat asks once for its optional durable-job subheader. The
    // ordinary journey has none; the dedicated chat harness supplies active
    // rows so it can prove the horizontal strip itself.
    if (req.method === 'GET' && /^\/workspace\/api\/agents\/[^/]+\/jobs$/.test(url.pathname)) {
      if (!expectSession(req, respondJson)) return true;
      respondJson(200, { jobs: [] });
      return true;
    }

    const chatPath = `/workspace/api/agents/${fixture.agent.id}/chat`;
    if (journey.agent && url.pathname === chatPath) {
      if (!expectSession(req, respondJson)) return true;
      if (req.method === 'POST') {
        expectCsrf(req, 'first job');
        expectJson(body, { message: fixture.firstJob.brief }, 'first job');
        const at = new Date().toISOString();
        journey.chat.push({ seq: journey.chat.length + 1, role: 'owner', text: fixture.firstJob.brief, at });
        journey.chat.push({ seq: journey.chat.length + 1, role: 'agent', text: fixture.firstJob.reply, at });
        journey.agent.worked = true;
        respondJson(202, { ok: true, name: fixture.agent.name, steered: false });
        return true;
      }
      const after = Number(url.searchParams.get('after') || 0);
      respondJson(200, { messages: journey.chat.filter((row) => row.seq > after), working: false });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/workspace/api/org') {
      if (!expectSession(req, respondJson)) return true;
      expectWorkspaceStage('empty', 'workplace creation');
      expectCsrf(req, 'workplace creation');
      expectJson(body, { name: fixture.organization.name }, 'workplace creation');
      if (failAsPlanned('organization', respondJson)) return true;
      workspaceStage = 'room-created';
      // The reply carries no rooms (note #726): a new workplace has none
      // until the Chief of Staff opens one.
      respondJson(200, { ok: true, orgId: fixture.organization.id, name: fixture.organization.name });
      return true;
    }

    // Compatibility for an older page that still carries the retired naming
    // form. The current first-day road founds on the subscription and
    // accepts the account's default without calling this endpoint.
    if (req.method === 'POST' && url.pathname === '/workspace/api/org/name') {
      if (!expectSession(req, respondJson)) return true;
      expectWorkspaceStage('workplace-created', 'naming the workplace');
      expectCsrf(req, 'naming the workplace');
      expectJson(body, { name: fixture.organization.name }, 'naming the workplace');
      if (!journey.seat) fault('the workplace was named before its subscription was in');
      foundFirstWorkplace(fixture.organization.name);
      respondJson(200, { ok: true, orgId: fixture.organization.id, name: fixture.organization.name });
      return true;
    }

    // Compatibility for an older page whose Continue on the retired arriving
    // screen (note #726) still calls this: nothing to step into any more, so
    // it answers ok and changes nothing, however often it is pressed. The
    // current road never sends it (the onboarding scenario counts zero).
    if (req.method === 'POST' && url.pathname === '/workspace/api/org/arrived') {
      if (!expectSession(req, respondJson)) return true;
      expectCsrf(req, 'stepping into the workplace');
      respondJson(200, { ok: true, orgId: fixture.organization.id });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/workspace/api/rooms') {
      if (!expectSession(req, respondJson)) return true;
      expectWorkspaceStage('workplace-created', 'room creation');
      expectCsrf(req, 'room creation');
      expectJson(body, { name: fixture.room.name }, 'room creation');
      if (failAsPlanned('room', respondJson)) return true;
      workspaceStage = 'room-created';
      respondJson(201, { ok: true, room: { ...fixture.room, createdAt: new Date().toISOString() } });
      return true;
    }

    fault(`unhandled Workspace request: ${req.method} ${url.pathname}${url.search}`);
    return true;
  };

  // A SOCKET OF ITS OWN, on a port the kernel just said was free.
  //
  // In middleware mode Vite cannot hang its websocket off our HTTP server, so
  // it opens its own — on a FIXED port, 24678, and it does so even with HMR
  // off. Two scenarios started at once therefore fight over one port: the
  // loser prints "Port 24678 is already in use", the page it is serving then
  // reports "WebSocket closed without opened", and `assertIsolated` fails the
  // run on a page error that has nothing to do with the journey. That is
  // exactly what took the tour down the first time CI ran these in parallel
  // (note #533).
  //
  // Turning the socket off instead (`ws: false`) fails the same way and does
  // it ALONE: the client Vite injects into the landing page still tries to
  // connect, and now nothing ever answers. So the socket has to exist — it
  // just must not be the same one for everybody.
  const hmrPort = await freeLocalPort();
  const vite = await createViteServer({
    root: repoRoot,
    appType: 'spa',
    logLevel: 'error',
    server: { middlewareMode: true, hmr: { host: '127.0.0.1', port: hmrPort } },
  });

  const server = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (await handleWorkspace(req, res, url)) return;
      vite.middlewares(req, res, (error) => {
        if (error) faults.push(`Vite failed ${req.method} ${url.pathname}: ${error.message}`);
        if (!res.headersSent) res.writeHead(error ? 500 : 404, { 'Content-Type': 'text/plain' });
        if (!res.writableEnded) res.end(error ? 'Vite request failed' : 'Unhandled local request');
      });
    })().catch((error) => {
      faults.push(error.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not receive a TCP address');
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    fixture,
    team,
    world,
    origin,
    requests,
    faults,
    workspaceStage: () => workspaceStage,
    journey: () => ({
      cloudConnected: journey.cloudConnected,
      workplaceName: journey.workplaceName,
      agentStatus: journey.agent?.status ?? null,
      seat: Boolean(journey.seat),
      signinAttempts: journey.signinAttempts,
      chatRows: journey.chat.length,
    }),
    identityExists: () => owner.exists,
    memberExists: () => accounts[1]?.exists ?? false,
    consumedRecoveryCodes: () => [...consumedRecoveryCodes],
    remainingFailures: () => Object.fromEntries(
      [...failurePlan].map(([action, failures]) => [action, failures.length]),
    ),
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await vite.close();
    },
  };
}
