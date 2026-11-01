import { describe, expect, it, vi } from 'vitest';
import {
  OpsBotService,
  formatFleetReport,
  formatUsersReport,
  summarizeRoster,
} from '../../services/ops-bot-service.js';
import type { RosterPerson } from '../../services/sqlite/sqlite-user-roster.js';
import type { UserProfileDocument } from '../../types/user.js';
import { TELEGRAM_AGENT_IDENTITY_VERSION as CURRENT } from '../../services/agent-service.js';

const NOW = new Date('2026-08-15T14:00:00.000Z');
const OPS_CHAT = '4242';

describe('/fleet says which teaching has actually landed', () => {
  const agent = (over: {
    name: string;
    version?: number | null;
    ranMinutesAgo?: number;
    connected?: boolean;
  }) => ({
    id: `a_${over.name}`,
    name: over.name,
    cli: 'claude',
    ...(over.connected === false ? {} : { connectedAt: '2026-08-01T00:00:00.000Z' }),
    ...(over.version === undefined ? {} : { identityVersion: over.version }),
    ...(over.ranMinutesAgo === undefined
      ? {}
      : { lastActivityAt: new Date(NOW.getTime() - over.ranMinutesAgo * 60_000).toISOString() }),
  });
  const fleet = (...agents: ReturnType<typeof agent>[]): UserProfileDocument[] => ([{
    userId: 'tg_owner',
    telegram: { agents: Object.fromEntries(agents.map((a) => [a.id, a])) },
  } as unknown as UserProfileDocument]);

  it('counts what is current and names what is behind, most recent first', () => {
    const text = formatFleetReport(fleet(
      agent({ name: 'Alex', version: CURRENT, ranMinutesAgo: 2 }),
      agent({ name: 'Stella', version: CURRENT, ranMinutesAgo: 30 }),
      // Behind by one and ran ten minutes ago: the write is failing, and this
      // is the line that has to be readable first.
      agent({ name: 'Ruby', version: CURRENT - 1, ranMinutesAgo: 10 }),
      // Behind by nine and idle for days: the mechanism working as designed.
      agent({ name: 'Felix', version: CURRENT - 9, ranMinutesAgo: 3 * 24 * 60 }),
    ), NOW);

    expect(text).toContain(`<b>FLEET</b> · 2 of 4 on v${CURRENT}`);
    expect(text).toContain(`<code>Ruby v${CURRENT - 1} · 10m ago</code>`);
    // Days past two of them: "72h ago" is a number a reader has to convert,
    // which the roster made obvious and this report shares.
    expect(text).toContain(`<code>Felix v${CURRENT - 9} · 3d ago</code>`);
    // Idle time is what tells "nobody spoke to it" from "the write is broken",
    // so the recent straggler is never buried under the ancient ones.
    expect(text.indexOf('Ruby')).toBeLessThan(text.indexOf('Felix'));
  });

  it('is one line when the whole fleet is current', () => {
    const text = formatFleetReport(fleet(
      agent({ name: 'Alex', version: CURRENT, ranMinutesAgo: 2 }),
      agent({ name: 'Stella', version: CURRENT, ranMinutesAgo: 90 }),
    ), NOW);
    expect(text).toContain(`<b>FLEET</b> · 2 of 2 on v${CURRENT}`);
    expect(text).not.toContain('more behind');
  });

  it('does not count agents that never finished sign-in', () => {
    // No machine of its own means no CLAUDE.md to be behind on. Counting it
    // would leave the fleet permanently, and wrongly, stale.
    const text = formatFleetReport(fleet(
      agent({ name: 'Alex', version: CURRENT, ranMinutesAgo: 2 }),
      agent({ name: 'Half', connected: false }),
    ), NOW);
    expect(text).toContain(`<b>FLEET</b> · 1 of 1 on v${CURRENT}`);
  });

  it('caps the list rather than scrolling a phone through the whole fleet', () => {
    const behind = Array.from({ length: 7 }, (_, i) => agent({
      name: `old${i}`, version: CURRENT - 1, ranMinutesAgo: 60 + i,
    }));
    const text = formatFleetReport(fleet(...behind), NOW);
    expect(text).toContain(`<b>FLEET</b> · 0 of 7 on v${CURRENT}`);
    expect(text).toContain('<i>+3 more behind</i>');
  });

  it('says so when an agent has a machine but has never run', () => {
    const text = formatFleetReport(fleet(agent({ name: 'Fresh' })), NOW);
    expect(text).toContain('<code>Fresh v? · never ran</code>');
  });

  it('says so in words when nobody owns an agent', () => {
    const text = formatFleetReport([], NOW);
    expect(text).toContain('No agent has a machine yet');
    expect(text).not.toContain('FLEET');
  });
});

describe('OpsBotService', () => {
  const owner = {
    userId: 'tg_owner',
    telegram: {
      agents: { a1: { id: 'a1', name: 'Alex', cli: 'claude', connectedAt: '2026-08-01T00:00:00.000Z', identityVersion: CURRENT } },
    },
  } as unknown as UserProfileDocument;

  function harness(over: { profiles?: UserProfileDocument[]; usersFail?: Error } = {}) {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      sent.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const service = new OpsBotService({
      botToken: 'BOT:TOKEN',
      chatId: OPS_CHAT,
      users: {
        getAllUsers: async () => {
          if (over.usersFail) throw over.usersFail;
          return over.profiles ?? [owner];
        },
      },
      webhookBaseUrl: 'https://api.example.com/api/webhooks',
      webhookSecret: 'shh',
      fetchImpl,
      now: () => NOW,
    });
    return { service, sent };
  }

  const message = (text: string, chatId: string | number = OPS_CHAT) => ({
    message: { text, chat: { id: chatId } },
  });

  it('answers /fleet in the ops chat', async () => {
    const { service, sent } = harness();
    expect(await service.handleUpdate(message('/fleet'))).toBe('answered');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/sendMessage');
    expect(sent[0].body.chat_id).toBe(OPS_CHAT);
    expect(String(sent[0].body.text)).toContain(`<b>FLEET</b> · 1 of 1 on v${CURRENT}`);
    expect(sent[0].body.parse_mode).toBe('HTML');
  });

  it('handles the group form /fleet@ACCOps_bot', async () => {
    const { service, sent } = harness();
    expect(await service.handleUpdate(message('/fleet@ACCOps_bot'))).toBe('answered');
    expect(String(sent[0].body.text)).toContain('<b>FLEET</b>');
  });

  it('says where /pool went rather than going quiet on a command the operator remembers', async () => {
    const { service, sent } = harness();
    expect(await service.handleUpdate(message('/pool'))).toBe('answered');
    expect(String(sent[0].body.text)).toContain('/fleet');
    expect(String(sent[0].body.text)).toContain('/users');
  });

  it('ignores every other chat in silence — no reply at all', async () => {
    const { service, sent } = harness();
    expect(await service.handleUpdate(message('/fleet', '999'))).toBe('ignored');
    expect(await service.handleUpdate(message('/pool', '999'))).toBe('ignored');
    expect(sent).toHaveLength(0);
  });

  it('ignores chatter that is not a command', async () => {
    const { service, sent } = harness();
    expect(await service.handleUpdate(message('how is the fleet?'))).toBe('ignored');
    expect(sent).toHaveLength(0);
  });

  it('no longer answers /own, /disown or /limbo — nothing here changes routing', async () => {
    const { service, sent } = harness();
    for (const command of ['/own max-1 tg_owner', '/disown max-1', '/limbo']) {
      expect(await service.handleUpdate(message(command))).toBe('ignored');
    }
    expect(sent).toHaveLength(0);
  });

  it('ignores a tap on an old switcher button still sitting in the chat', async () => {
    const { service, sent } = harness();
    const tap = { callback_query: { id: 'cb', data: 'pin:auto', message: { message_id: 5, chat: { id: OPS_CHAT } } } };
    expect(await service.handleUpdate(tap as never)).toBe('ignored');
    expect(sent).toHaveLength(0);
  });

  it('answers /help and /start with the command list — only what it answers', async () => {
    const { service, sent } = harness();
    await service.handleUpdate(message('/start'));
    const text = String(sent[0].body.text);
    expect(text).toContain('/users');
    expect(text).toContain('/fleet');
    for (const gone of ['/pool', '/own', '/disown', '/limbo']) expect(text).not.toContain(gone);
  });

  it('reports a storage failure rather than going quiet', async () => {
    const { service, sent } = harness({ usersFail: new Error('sqlite is locked') });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await service.handleUpdate(message('/fleet'))).toBe('answered');
    expect(String(sent[0].body.text)).toBe('/fleet failed: sqlite is locked');
    spy.mockRestore();
  });

  it('points Telegram at /telegram-ops with the secret token', async () => {
    const { service, sent } = harness();
    await service.syncWebhook();
    expect(sent[0].url).toContain('/setWebhook');
    expect(sent[0].body.url).toBe('https://api.example.com/api/webhooks/telegram-ops');
    expect(sent[0].body.secret_token).toBe('shh');
    // Messages only: there are no buttons left to tap.
    expect(sent[0].body.allowed_updates).toEqual(['message']);
    // ...and publishes the commands in the chat's menu — only ones it answers:
    // a menu entry the bot ignores is a button that does nothing (/limbo was).
    expect(sent[1].url).toContain('/setMyCommands');
    const menu = (sent[1].body.commands as Array<{ command: string }>).map((entry) => entry.command);
    expect(menu).toEqual(['users', 'fleet']);
  });

  it('says whether Telegram took the / menu, and logs a refusal', async () => {
    const { service } = harness();
    expect(await service.syncWebhook()).toEqual({ configured: true, menu: true });

    // The webhook is accepted, the menu is not: still configured — commands
    // arrive — but the refusal is reported rather than read past.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refusing = new OpsBotService({
      botToken: 'BOT:TOKEN',
      chatId: OPS_CHAT,
      users: { getAllUsers: async () => [] },
      webhookBaseUrl: 'https://api.example.com/api/webhooks',
      fetchImpl: (async (url: string) => (String(url).endsWith('/setMyCommands')
        ? { ok: false, status: 400, json: async () => ({ description: 'Bad Request: command is invalid' }) }
        : { ok: true, status: 200 }) as Response) as unknown as typeof fetch,
    });
    expect(await refusing.syncWebhook()).toEqual({ configured: true, menu: false });
    expect(String(warn.mock.calls[0]?.[0])).toContain('command is invalid');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('BOT:TOKEN');
    warn.mockRestore();
  });

  it('does not claim to be configured without a webhook base', async () => {
    const service = new OpsBotService({
      botToken: 'BOT:TOKEN',
      chatId: OPS_CHAT,
      users: { getAllUsers: async () => [] },
      fetchImpl: (async () => ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch,
    });
    expect(await service.syncWebhook()).toEqual({ configured: false });
  });
});

describe('formatting can never silence the bot', () => {
  it('resends the report unformatted when Telegram rejects the HTML', async () => {
    // Telegram refuses the whole message on malformed HTML.
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      sent.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
      return sent.length === 1
        ? { ok: false, status: 400, json: async () => ({ description: 'Bad Request: unclosed tag' }) } as unknown as Response
        : { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const service = new OpsBotService({
      botToken: 'BOT:TOKEN',
      chatId: OPS_CHAT,
      users: {
        getAllUsers: async () => [{
          userId: 'tg_owner',
          telegram: { agents: { a1: { id: 'a1', name: 'Alex', cli: 'claude', connectedAt: '2026-08-01T00:00:00.000Z', identityVersion: CURRENT } } },
        } as unknown as UserProfileDocument],
      },
      fetchImpl,
      now: () => NOW,
    });
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await service.handleUpdate({ message: { text: '/fleet', chat: { id: OPS_CHAT } } });
    spy.mockRestore();

    expect(sent).toHaveLength(2);
    expect(sent[1].body.parse_mode).toBeUndefined();
    const plain = String(sent[1].body.text);
    expect(plain).toContain(`FLEET · 1 of 1 on v${CURRENT}`);
    expect(plain).not.toContain('<b>');
  });
});

/** One roster entry, as `readUserRoster` returns it: only what a test sets. */
function rp(over: Partial<RosterPerson> & { userId: string; minutesAgo?: number }): RosterPerson {
  const { minutesAgo, ...rest } = over;
  const lastSeenAt = minutesAgo === undefined ? undefined : new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  return {
    code: over.userId.slice(0, 5),
    name: over.userId,
    via: 'email',
    email: `${over.userId}@example.com`,
    telegram: '',
    kind: '',
    joined: '2026-09-01',
    lastSeen: lastSeenAt?.slice(0, 10) ?? '-',
    ...(lastSeenAt ? { lastSeenAt } : {}),
    stage: 'workplace',
    seatAt: '-',
    workplaces: [],
    webLogins: 0,
    agents: 0,
    agentsDeleted: 0,
    messagesToAgents: 0,
    agentMinutes: 0,
    liveSites: [],
    repos: 0,
    notes: 0,
    detail: { places: [], devices: [], agentTime: [], agents: [], seats: [] },
    ...rest,
  };
}

describe('the /users roster', () => {
  /** The table itself. Telegram HTML has no <table>, so it is a markdown one
   *  in a <pre> block: the pipes only line up because every cell is padded. */
  const table = (text: string): string[] => {
    const block = /<pre>([\s\S]*?)<\/pre>/.exec(text);
    if (!block) throw new Error(`no table in:\n${text}`);
    return block[1]!.split('\n');
  };

  const PLATFORM = [
    rp({ userId: 'adam', name: 'Adam', kind: 'admin', stage: 'talked', minutesAgo: 1 }),
    rp({ userId: 'test1', name: 'test1', kind: 'internal', stage: 'seat', minutesAgo: 2 }),
    rp({ userId: 'jem', name: 'jem', stage: 'workplace', minutesAgo: 19 * 24 * 60 }),
    rp({ userId: 'emma', name: 'emma', stage: 'talked', agents: 4, agentsDeleted: 2, minutesAgo: 60 }),
    rp({ userId: 'liko', name: 'liko', stage: 'signed_up' }),
  ];

  it('leads with who is from outside, and where they stand', () => {
    const text = formatUsersReport(PLATFORM, NOW);
    expect(text).toContain('<b>USERS</b> · 5 · 3 from outside');
    // Funnel order, counted where each one STANDS — the question is who
    // stalled where.
    expect(text).toContain('<code>1 signed up · 1 workplace · 1 talked</code>');
  });

  it('is a markdown table of the people from outside: heading, rule, one line each', () => {
    const rows = table(formatUsersReport(PLATFORM, NOW));
    // Written out in full: the padding IS the feature, so an expected string
    // that computes its own spacing can agree with a bug.
    expect(rows).toEqual([
      '|USER|STAGE    |AG| LAST|',
      '|----|---------|--|-----|',
      // Most recently seen first; never-seen last, in words. Agents made in
      // all: the four emma has and the two deleted.
      '|emma|talked   | 6|  60m|',
      '|jem |workplace| 0|  19d|',
      '|liko|signed up| 0|never|',
    ]);
  });

  it('keeps the team\'s own accounts out of the table, and says how many there are', () => {
    const text = formatUsersReport(PLATFORM, NOW);
    expect(table(text).join('\n')).not.toMatch(/Adam|test1/);
    expect(text).toContain('<i>+2 admin/internal — in the table</i>');
  });

  it('says what the stage and agent columns mean, once, under the table', () => {
    expect(formatUsersReport(PLATFORM, NOW))
      .toContain('<i>stage = the last step reached · ag = agents made, deleted ones too</i>');
  });

  it('reads an idle month in days, not in hours', () => {
    const rows = table(formatUsersReport([rp({ userId: 'ghost', minutesAgo: 34 * 24 * 60 })], NOW));
    expect(rows[2]).toContain('34d');
    expect(rows[2]).not.toMatch(/\d+h/);
  });

  it('clips one long name rather than letting it set the table width', () => {
    const rows = table(formatUsersReport([
      rp({ userId: 'u1', name: 'agentic_cloud_computer_support', minutesAgo: 1 }),
      rp({ userId: 'u2', name: 'ada', minutesAgo: 2 }),
    ], NOW));
    expect(rows[2]).toContain('agentic_clou…');
    // And every other cell is padded to the SAME width, or nothing lines up.
    const pipes = (line: string) => [...line].flatMap((c, i) => (c === '|' ? [i] : []));
    for (const line of rows) expect(pipes(line), line).toEqual(pipes(rows[0]!));
  });

  it('keeps the whole table inside the width a phone shows without scrolling', () => {
    // The widest each column can get: a capped name, the longest stage, a
    // two-digit agent count, the longest age.
    const rows = table(formatUsersReport([
      rp({ userId: 'u1', name: 'agentic_cloud_computer_support', stage: 'signed_up', minutesAgo: 3 * 24 * 60 }),
      rp({ userId: 'u2', name: 'ada', stage: 'talked', agents: 9, agentsDeleted: 13 }),
    ], NOW));
    for (const line of rows) expect(line.length, line).toBeLessThanOrEqual(34);
  });

  it('escapes a name, because Telegram HTML rejects the whole message', () => {
    const text = formatUsersReport([rp({ userId: 'u1', name: '<b>Rick</b>', minutesAgo: 1 })], NOW);
    expect(text).toContain('&lt;b&gt;Rick&lt;/b&gt;');
    expect(text).not.toContain('<b>Rick');
  });

  it('stops at a screenful and says how many it did not name', () => {
    const many = Array.from({ length: 27 }, (_, index) => rp({ userId: `p${index}`, minutesAgo: index }));
    const text = formatUsersReport(many, NOW);
    expect(table(text)).toHaveLength(2 + 25);
    expect(text).toContain('<i>+2 more — list-users.mjs on the host</i>');
  });

  it('says so in words when there is nobody from outside, or nobody at all', () => {
    const inside = formatUsersReport([rp({ userId: 'adam', kind: 'admin' })], NOW);
    expect(inside).toContain('<i>Nobody from outside yet.</i>');
    expect(inside).toContain('<i>1 admin/internal — in the table</i>');
    expect(inside).not.toContain('<pre>');
    expect(formatUsersReport([], NOW)).toContain('<i>Nobody has an account yet.</i>');
  });
});

describe('summarizeRoster', () => {
  it('counts outside people only, in funnel order, skipping empty stages', () => {
    expect(summarizeRoster([
      rp({ userId: 'a', stage: 'talked' }),
      rp({ userId: 'b', stage: 'signed_up' }),
      rp({ userId: 'c', stage: 'signed_up' }),
      rp({ userId: 'd', stage: 'agent', kind: 'internal' }),
    ])).toEqual({ total: 4, outside: 3, standing: '2 signed up · 1 talked' });
  });
  it('places "told" between the workplace and the plan (note #726)', () => {
    expect(summarizeRoster([
      rp({ userId: 'a', stage: 'seat' }),
      rp({ userId: 'b', stage: 'told' }),
      rp({ userId: 'c', stage: 'workplace' }),
    ])).toEqual({ total: 3, outside: 3, standing: '1 workplace · 1 told · 1 seat' });
    const report = formatUsersReport([rp({ userId: 'b', name: 'b', stage: 'told', minutesAgo: 3 })], NOW);
    expect(/<pre>([\s\S]*?)<\/pre>/.exec(report)?.[1]?.split('\n')).toEqual([
      '|USER|STAGE|AG|LAST|',
      '|----|-----|--|----|',
      '|b   |told | 0|  3m|',
    ]);
  });
});

describe('the ops bot answers /users', () => {
  const roster = [rp({ userId: 'jem', name: 'jem', stage: 'workplace', minutesAgo: 5 })];

  /** What actually went to Telegram: which call, the words, and the keyboard
   *  under them. */
  type Sent = { method: string; text: string; markup?: unknown };

  function bot(sent: Sent[], options: {
    roster?: (() => Promise<RosterPerson[]>) | null;
    miniAppUrl?: string;
  } = {}) {
    return new OpsBotService({
      botToken: 't',
      chatId: OPS_CHAT,
      users: { getAllUsers: async () => [] },
      ...(options.roster === null ? {} : { roster: options.roster ?? (async () => roster) }),
      now: () => NOW,
      ...(options.miniAppUrl ? { miniAppUrl: options.miniAppUrl } : {}),
      fetchImpl: (async (url: string, init?: { body?: string }) => {
        const json = JSON.parse(init?.body ?? '{}') as { text?: string; reply_markup?: unknown };
        if (json.text) {
          sent.push({
            method: String(url).split('/').pop() ?? '',
            text: json.text,
            ...(json.reply_markup ? { markup: json.reply_markup } : {}),
          });
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }) as unknown as typeof fetch,
    });
  }

  it('answers /users in the ops chat, from the shared roster', async () => {
    const sent: Sent[] = [];
    const answered = await bot(sent).handleUpdate({ message: { text: '/users', chat: { id: OPS_CHAT } } });
    expect(answered).toBe('answered');
    expect(sent[0]!.text).toContain('<b>USERS</b> · 1 · 1 from outside');
    expect(sent[0]!.text).toContain('|jem |workplace| 0|  5m|');
  });

  it('puts a button to the real table under the answer', async () => {
    const sent: Sent[] = [];
    await bot(sent, { miniAppUrl: 'https://api.example.com/ops' })
      .handleUpdate({ message: { text: '/users', chat: { id: OPS_CHAT } } });
    expect(sent[0]!.markup).toEqual({
      inline_keyboard: [[{ text: '\u{1F4CA} Open as a table', web_app: { url: 'https://api.example.com/ops' } }]],
    });
  });

  it('sends no button without an https page to open', async () => {
    const sent: Sent[] = [];
    await bot(sent, { miniAppUrl: 'http://localhost:3001/ops' })
      .handleUpdate({ message: { text: '/users', chat: { id: OPS_CHAT } } });
    expect(sent[0]!.markup).toBeUndefined();
  });

  it('answers /users@ACCOps_bot too, which is what a group sends', async () => {
    const sent: Sent[] = [];
    expect(await bot(sent).handleUpdate({ message: { text: '/users@ACCOps_bot', chat: { id: OPS_CHAT } } }))
      .toBe('answered');
    expect(sent[0]!.text).toContain('<b>USERS</b>');
  });

  it('ignores /users from any other chat, in silence', async () => {
    const sent: Sent[] = [];
    expect(await bot(sent).handleUpdate({ message: { text: '/users', chat: { id: '999' } } })).toBe('ignored');
    expect(sent).toEqual([]);
  });

  it('says plainly when this backend has no database to read the roster from', async () => {
    const sent: Sent[] = [];
    await bot(sent, { roster: null }).handleUpdate({ message: { text: '/users', chat: { id: OPS_CHAT } } });
    expect(sent[0]!.text).toContain('needs the SQLite database');
  });

  it('says what broke rather than going quiet', async () => {
    const sent: Sent[] = [];
    const service = bot(sent, { roster: async () => { throw new Error('sqlite is locked'); } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await service.handleUpdate({ message: { text: '/users', chat: { id: OPS_CHAT } } });
    spy.mockRestore();
    expect(sent[0]!.text).toBe('/users failed: sqlite is locked');
  });
});
