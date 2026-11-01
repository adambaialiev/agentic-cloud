import { describe, expect, it } from 'vitest';
import express from 'express';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { opsMiniAppRoutes, type OpsMiniAppDeps } from '../../routes/ops-miniapp.js';
import type { UserProfileDocument } from '../../types/user.js';
import type { RosterPerson } from '../../services/sqlite/sqlite-user-roster.js';

/**
 * The ops Mini App — the roster as a real table, which a Telegram message
 * cannot draw.
 *
 * Most of what is worth testing here is the DOOR, not the table: this page
 * shows every account on the platform, so "who may open it" is the whole
 * security of the feature. A valid Telegram signature is not enough on its
 * own — anyone can sign a payload with their own bot's token — so the tests
 * below spend their time on the ways in that must not work.
 */

const OPS_TOKEN = '4242:ops-bot-token';
const OTHER_TOKEN = '9999:someone-elses-bot';
const OPERATOR = 63_000_001;
const NOW = new Date('2026-08-17T09:00:00.000Z');

/** A launch payload exactly as Telegram signs one. */
function initData(over: { token?: string; userId?: number; at?: Date } = {}): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor((over.at ?? NOW).getTime() / 1000)),
    query_id: 'AAF',
    user: JSON.stringify({ id: over.userId ?? OPERATOR, first_name: 'Owner' }),
  });
  const check = [...params.entries()]
    .sort(([l], [r]) => (l < r ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(over.token ?? OPS_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

/** A profile, for the group-chat door: only the admin flag matters there. */
const profile = (over: { id: string; admin?: boolean }): UserProfileDocument => ({
  userId: over.id,
  ...(over.admin ? { roles: { admin: true } } : {}),
} as unknown as UserProfileDocument);

/** One roster entry, as `readUserRoster` returns it. */
const person = (over: Partial<RosterPerson> & { userId: string; minutesAgo?: number }): RosterPerson => {
  const { minutesAgo, ...rest } = over;
  const lastSeenAt = minutesAgo === undefined ? undefined : new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  return {
    code: over.userId.slice(0, 5), name: over.userId, via: 'email', email: '', telegram: '', kind: '', joined: '2026-08-01',
    lastSeen: lastSeenAt?.slice(0, 10) ?? '-', ...(lastSeenAt ? { lastSeenAt } : {}),
    stage: 'workplace', seatAt: '-', workplaces: [], webLogins: 0, agents: 0, agentsDeleted: 0, messagesToAgents: 0,
    agentMinutes: 0, liveSites: [], repos: 0, notes: 0,
    detail: { places: [], devices: [], agentTime: [], agents: [], seats: [] },
    ...rest,
  };
};

const ROSTER = [
  person({ userId: 'u1', name: 'Adam', telegram: '@owner', email: 'owner@example.com', kind: 'admin', stage: 'talked', minutesAgo: 5 }),
  person({ userId: 'u2', name: 'jem', email: 'jem@example.com', stage: 'agent', agents: 4, agentsDeleted: 2, minutesAgo: 90 }),
  person({ userId: 'u3', name: 'liko', stage: 'signed_up' }),
];

/** The router on a real socket, so the test exercises Express as it ships. */
async function serve(over: Partial<OpsMiniAppDeps> = {}) {
  const app = express();
  app.use('/ops', opsMiniAppRoutes({
    opsBotToken: OPS_TOKEN,
    opsChatId: String(OPERATOR),
    roster: async () => ROSTER,
    now: () => NOW,
    ...over,
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ops`;
  return {
    base,
    roster: (auth?: string) => fetch(`${base}/api/roster`, {
      headers: auth === undefined ? {} : { authorization: `tma ${auth}` },
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('who can open the ops roster', () => {
  it('lets the operator in', async () => {
    const app = await serve();
    const response = await app.roster(initData());
    expect(response.status).toBe(200);
    const body = await response.json() as { headline: { total: number; outside: number } };
    expect(body.headline).toEqual({ total: 3, outside: 2 });
    await app.close();
  });

  it('refuses a payload signed by somebody else\'s bot', async () => {
    // The whole point of checking the signature: a valid-LOOKING launch from
    // a bot the attacker owns must not read this platform's roster.
    const app = await serve();
    expect((await app.roster(initData({ token: OTHER_TOKEN }))).status).toBe(401);
    await app.close();
  });

  it('refuses a real Telegram user who is not the operator', async () => {
    // Signed by the ops bot, genuinely from Telegram, wrong person: the ops
    // chat is private, so its id IS the one account allowed through.
    const app = await serve();
    expect((await app.roster(initData({ userId: OPERATOR + 1 }))).status).toBe(401);
    await app.close();
  });

  it('refuses a stale launch, and one with no payload at all', async () => {
    const app = await serve();
    const old = initData({ at: new Date(NOW.getTime() - 7 * 60 * 60 * 1000) });
    expect((await app.roster(old)).status).toBe(401);
    expect((await app.roster('')).status).toBe(401);
    expect((await app.roster()).status).toBe(401);
    await app.close();
  });

  it('refuses everyone when the ops bot is not configured', async () => {
    // No token means nothing can be verified, which must fail CLOSED.
    const app = await serve({ opsBotToken: '' });
    expect((await app.roster(initData())).status).toBe(503);
    await app.close();
  });

  it('says it is not configured on a backend with no roster to read', async () => {
    const app = await serve({ roster: undefined });
    expect((await app.roster(initData())).status).toBe(503);
    await app.close();
  });

  describe('when the ops chat is a group instead of one person', () => {
    // A negative id is a group: there is no single account to match, so the
    // platform's own admin flag becomes the gate.
    const asGroup = (profile: UserProfileDocument | null) => ({
      opsChatId: '-1002',
      findUserByTelegramUserId: async () => profile,
    });

    it('lets a platform admin in', async () => {
      const app = await serve(asGroup(profile({ id: 'u1', admin: true })));
      expect((await app.roster(initData())).status).toBe(200);
      await app.close();
    });

    it('refuses a member of that group who is not an admin', async () => {
      const app = await serve(asGroup(profile({ id: 'u2' })));
      expect((await app.roster(initData())).status).toBe(401);
      await app.close();
    });

    it('refuses when no profile can be found at all', async () => {
      const app = await serve(asGroup(null));
      expect((await app.roster(initData())).status).toBe(401);
      await app.close();
    });
  });
});

describe('what the ops roster serves', () => {
  it('carries what a table needs and a monospace block cannot have', async () => {
    const app = await serve();
    const body = await (await app.roster(initData())).json() as {
      headline: { total: number; outside: number };
      people: Array<Record<string, unknown>>;
      tally: string;
    };

    // The same summary the chat leads with: outside people, where they stand.
    expect(body.tally).toBe('1 signed up · 1 agent');
    const [first] = body.people;
    // The handle on its own, so the page can link to that person's chat; the
    // email and id under the name; the kind, so the page can quiet the team's
    // own accounts rather than leave them out.
    expect(first).toEqual({
      userId: 'u1', name: 'Adam', email: 'owner@example.com', username: 'owner',
      kind: 'admin', stage: 'talked', stageRank: 6, agents: 0, last: '5m', lastSeenMs: NOW.getTime() - 5 * 60_000,
    });
    // Agents made in all, the deleted ones said beside the total (and, above,
    // no "0 deleted" for someone who never deleted one).
    expect(body.people[1]).toMatchObject({ agents: 6, agentsDeleted: 2 });
    // The stage as a funnel position, so sorting the column reads as the
    // funnel does rather than alphabetically (seven steps since note #726
    // put "told" between the workplace and the plan: talked is 6).
    expect(body.people.map((entry) => entry.stageRank)).toEqual([6, 5, 0]);
    // Someone who has never been seen sorts last and says so.
    expect(body.people[2]).toMatchObject({ last: 'never', lastSeenMs: 0 });
    // No handle, no link; no email, no empty string to draw.
    expect(body.people[2]!.username).toBeUndefined();
    expect(body.people[2]!.email).toBeUndefined();
    await app.close();
  });

  it('serves the page itself to anyone, because the page holds no data', async () => {
    // Same rule as the Workspace app next door: the HTML is inert, and every
    // fact on it arrives through the call that carries the signature.
    const app = await serve();
    const response = await fetch(app.base);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('<table>');
    expect(html).not.toContain('@owner');
    await app.close();
  });
});
