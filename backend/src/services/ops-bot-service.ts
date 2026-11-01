/**
 * The ops bot's inbound half.
 *
 * @ACCOps_bot began send-only: the backup monitor pushes alerts at it
 * (`createOpsNotifier`) and nothing listened. This adds the listening half —
 * one webhook, three commands — so the platform can be asked about instead of
 * SSH'd into: /users (who is on it), /fleet (which identity version the
 * agents are on), /help.
 *
 * Two deliberate limits:
 *
 *  - **Only the ops chat is answered.** Every other chat is ignored in
 *    silence, not refused: a reply would confirm the bot exists to whoever
 *    found it, and the platform's state is the shape of the business.
 *  - **Read-only.** Until 2026-10-03 it could also pin turns to a shared
 *    credential and dedicate one to a user (/pool, /own, /disown). The shared
 *    pool is empty in production — org seats carry the turns and the bot never
 *    showed them — so those went, buttons and all. A command that changes
 *    routing or takes capacity away from a phone is a different review.
 */

import type { UserProfileDocument } from '../types/user.js';
import { ROSTER_STAGES, type RosterPerson, type RosterStage } from './sqlite/sqlite-user-roster.js';
import { TELEGRAM_AGENT_IDENTITY_VERSION } from './agent-service.js';

export interface OpsBotUpdate {
  message?: {
    text?: string;
    chat?: { id?: number | string };
  };
}

/** Telegram HTML mode: exactly three characters need escaping. */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The same report with the markup removed — the plain-text fallback. */
function stripTags(html: string): string {
  return html
    .replace(/<\/?(?:b|i|code|pre|u|s)>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Telegram's own words for why it refused, for the log line. */
async function describeFailure(response: Response): Promise<string> {
  try {
    const body = await response.json() as { description?: string };
    return body?.description ?? '';
  } catch {
    return '';
  }
}

/** Right-aligned in a monospace run, so columns line up across accounts. */
function col(value: string, width: number): string {
  return value.padStart(width, ' ');
}

/**
 * The /users answer: who from outside is on the platform, and where each one
 * stopped.
 *
 * The facts come from `readUserRoster` — the same derivation
 * `scripts/list-users.mjs` prints on the host — so the phone and the script
 * cannot disagree. Until 2026-10-03 this counted the older Telegram funnel on
 * its own and filed every web signup as "unknown", which was most of them.
 *
 * Outside people only, in the table. The admin and the team's test accounts
 * outnumber them (14 to 7 on that day) and would bury the answer; they are
 * one line here and rows in the Mini App, which has room.
 *
 * Shape rules, learned from reading it on a phone: HTML with every
 * interpolated value escaped (a name certainly can carry a <), short lines so
 * nothing wraps, monospace where a column should line up, and bold only on
 * the thing you scan FOR.
 *
 * Most recently seen first. The question behind this is "who is here, and who
 * stalled", and a roster sorted by signup buries the answer under whoever
 * joined first.
 */
export function formatUsersReport(
  people: RosterPerson[],
  now = new Date(),
): string {
  const summary = summarizeRoster(people);
  const outside = byLastSeen(people.filter((person) => !person.kind));

  const lines: string[] = [];
  lines.push(`<b>USERS</b> · ${summary.total} · ${summary.outside} from outside`);
  if (summary.standing) lines.push(`<code>${esc(summary.standing)}</code>`);
  if (outside.length === 0) {
    lines.push('');
    lines.push(summary.total === 0 ? '<i>Nobody has an account yet.</i>' : '<i>Nobody from outside yet.</i>');
    if (summary.total > 0) lines.push(`<i>${summary.total} admin/internal — in the table</i>`);
    return lines.join('\n');
  }

  const shown = outside.slice(0, USERS_SHOWN).map((person) => ({
    name: person.name,
    stage: STAGE_LABEL[person.stage],
    agents: String(agentsMade(person)),
    last: lastSeenWords(person, now),
  }));
  // Each column is as wide as its own contents, and the name column is capped:
  // one very long name should cost its own row an ellipsis rather than push
  // every other column off the side of the phone.
  const widths = COLUMNS.map((column) => Math.min(
    column.max ?? Infinity,
    Math.max(column.head.length, ...shown.map((entry) => column.of(entry).length)),
  ));

  // A <pre> block, because Telegram HTML has no <table> and pipes only line up
  // in monospace. A code block scrolls sideways on its own rather than
  // wrapping, which is what makes a table survive a long name.
  const table = [
    row(COLUMNS.map((column) => column.head), COLUMNS, widths),
    // The rule under the heading, as a markdown table is written: it is what
    // makes the block read as a table at a glance rather than as text that
    // happens to line up.
    `|${widths.map((width) => '-'.repeat(width)).join('|')}|`,
    ...shown.map((entry) => row(
      COLUMNS.map((column, index) => clip(column.of(entry), widths[index]!)),
      COLUMNS,
      widths,
    )),
  ];
  lines.push(`<pre>${esc(table.join('\n'))}</pre>`);
  if (outside.length > USERS_SHOWN) {
    lines.push(`<i>+${outside.length - USERS_SHOWN} more — list-users.mjs on the host</i>`);
  }
  const inside = summary.total - summary.outside;
  if (inside > 0) lines.push(`<i>+${inside} admin/internal — in the table</i>`);
  lines.push('<i>stage = the last step reached · ag = agents made, deleted ones too</i>');
  return lines.join('\n');
}

/**
 * Every agent the person made that the database still remembers: the ones
 * they have, and the ones they deleted. "How many did they make" is the
 * question; the ones they kept are only part of the answer.
 */
export function agentsMade(person: RosterPerson): number {
  return person.agents + person.agentsDeleted;
}

/** A stage as a person reads it: the ids are the script's, the words are short
 *  enough for the phone's STAGE column. */
export const STAGE_LABEL: Record<RosterStage, string> = {
  signed_up: 'signed up',
  confirmed: 'confirmed',
  workplace: 'workplace',
  told: 'told',
  seat: 'seat',
  agent: 'agent',
  talked: 'talked',
};

/**
 * The headline both views lead with: how many accounts, how many of them are
 * from outside, and where those stand — "2 signed up · 4 workplace · 1 talked",
 * in funnel order. Where they STAND rather than the script's "reached at
 * least": on a phone the question is who stalled where, and that is it.
 */
export function summarizeRoster(people: RosterPerson[]): { total: number; outside: number; standing: string } {
  const outside = people.filter((person) => !person.kind);
  const standing = ROSTER_STAGES
    .map((stage) => [stage, outside.filter((person) => person.stage === stage).length] as const)
    .filter(([, count]) => count > 0)
    .map(([stage, count]) => `${count} ${STAGE_LABEL[stage]}`)
    .join(' · ');
  return { total: people.length, outside: outside.length, standing };
}

/** "5m", "3h", "19d" — or "never". */
export function lastSeenWords(person: RosterPerson, now: Date): string {
  return person.lastSeenAt ? ageMinutes(person.lastSeenAt, now).replace(' ago', '') : 'never';
}

/** The same instant as a number, because a table sorts on it. 0 = never. */
export function lastSeenMs(person: RosterPerson): number {
  return person.lastSeenAt ? Date.parse(person.lastSeenAt) || 0 : 0;
}

function byLastSeen(people: RosterPerson[]): RosterPerson[] {
  return [...people].sort((a, b) => lastSeenMs(b) - lastSeenMs(a));
}

/**
 * The columns of the roster, in the order they are read.
 *
 * A `max` is a cap on how wide the column may grow, not a fixed width: only
 * the name column has one, because it is the only column whose contents a
 * user chooses. Words read left, ages read right — a column of ages is only
 * scannable if they line up on their last character.
 */
type UserRow = { name: string; stage: string; agents: string; last: string };
const COLUMNS: Array<{
  head: string;
  of: (row: UserRow) => string;
  right?: true;
  max?: number;
}> = [
  // Wide enough for the names people actually have, narrow enough that one
  // outlier does not decide the table's width for everybody: 13 + "signed up"
  // + "AG" + "never" and the five pipes is 34, the width a phone shows.
  { head: 'USER', of: (entry) => entry.name, max: 13 },
  { head: 'STAGE', of: (entry) => entry.stage },
  // Two letters, spelled out in the line under the table: "AGENTS" would
  // cost four more characters of every name.
  { head: 'AG', of: (entry) => entry.agents, right: true },
  { head: 'LAST', of: (entry) => entry.last, right: true },
];

/**
 * One row of a markdown table, every cell padded to its column so the pipes
 * stand in a line down the block.
 *
 * The cells are NOT spaced off the pipes, which is the roomier way to write
 * markdown and the way that does not fit: a phone shows about 34 characters
 * of a code block before it has to be scrolled sideways, and a space either
 * side of the columns costs six of them. Rendered against the real roster,
 * that is the difference between a table you read and a table whose last
 * column sits off the edge of the screen.
 */
function row(
  cells: string[],
  columns: Array<{ right?: true }>,
  widths: number[],
): string {
  const padded = cells.map((cell, index) => (columns[index]?.right
    ? col(cell, widths[index]!)
    : cell.padEnd(widths[index]!)));
  return `|${padded.join('|')}|`;
}

/** Names are the one column a user controls the width of. */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** How many people the message names before it stops. A phone scrolls, but a
 *  roster longer than this is a question for the script, not the chat. */
const USERS_SHOWN = 25;

/**
 * Which template the fleet is ACTUALLY running.
 *
 * An agent's CLAUDE.md is rewritten at the start of its next turn once
 * `TELEGRAM_AGENT_IDENTITY_VERSION` moves, so a bump is never fleet-wide the
 * moment it ships: it arrives agent by agent, as each one is spoken to. That
 * is by design, and it is also completely invisible — the only record is a
 * number on each agent's record in the database, which took an SSH session and
 * a hand-written SQLite query to read the first time it was ever asked
 * (2026-08-15, "are my agents on 35?"). This bot exists so the platform can be
 * asked instead of SSH'd into; the fleet's teaching is the same kind of
 * question.
 *
 * Idle time is printed beside each straggler because it is what tells the two
 * cases apart, and they need different reactions: an agent behind by four
 * versions that has not run in three days is the mechanism working (nobody has
 * spoken to it), while an agent behind by one that ran ten minutes ago means
 * the write is failing — go read the backend log, where the three attempts and
 * their errors are.
 */
function fleetIdentityLines(profiles: UserProfileDocument[], now: Date): string[] {
  // Only agents with a machine of their own: an agent that never finished
  // sign-in has no CLAUDE.md to be behind on, and counting it would make the
  // fleet look permanently stale.
  const agents = profiles
    .flatMap((profile) => Object.values(profile.telegram?.agents ?? {}))
    .filter((agent) => Boolean(agent.connectedAt));
  if (agents.length === 0) return [];

  const behind = agents.filter((agent) => agent.identityVersion !== TELEGRAM_AGENT_IDENTITY_VERSION);
  const lines = [
    `<b>FLEET</b> · ${agents.length - behind.length} of ${agents.length}`
    + ` on v${TELEGRAM_AGENT_IDENTITY_VERSION}`,
  ];
  if (behind.length === 0) return lines;

  // Most recently active first: the straggler that just ran is the one that
  // should NOT be a straggler, and it has to be readable without scrolling
  // past a week of idle machines.
  const stamp = (agent: { lastActivityAt?: string }) => Date.parse(agent.lastActivityAt ?? '') || 0;
  const worst = [...behind].sort((a, b) => stamp(b) - stamp(a));
  for (const agent of worst.slice(0, 4)) {
    lines.push(
      `<code>${esc(agent.name)} v${agent.identityVersion ?? '?'}`
      + ` · ${agent.lastActivityAt ? ageMinutes(agent.lastActivityAt, now) : 'never ran'}</code>`,
    );
  }
  if (worst.length > 4) lines.push(`<i>+${worst.length - 4} more behind</i>`);
  return lines;
}

/**
 * How long ago, at the resolution the answer is read at. Days past two of
 * them: the roster spans a month, and "816h ago" is a number nobody converts
 * — it was the first thing wrong with /users when it was pointed at real
 * profiles. The fleet report gains the same, for the same reason.
 */
function ageMinutes(iso: string, now: Date): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return 'never';
  const mins = Math.round((now.getTime() - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 90) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The /fleet answer: which identity template the agents are actually on.
 * Nothing else — the whole report is the one section `/pool` used to end with.
 */
export function formatFleetReport(profiles: UserProfileDocument[], now = new Date()): string {
  const lines = fleetIdentityLines(profiles, now);
  return lines.length > 0 ? lines.join('\n') : '<i>No agent has a machine yet.</i>';
}

const HELP = [
  'ACC ops bot. Commands:',
  '/users — everyone on the platform: how far each got, how many',
  '        agents each made, and when they were last active,',
  '        with a button to the same list as a real table',
  '/fleet — which identity version the agents are on, and who is behind',
  '/help — this',
].join('\n');

/** What this bot answers. Everything else is ignored in silence — a reply
 *  would confirm the bot exists to whoever found it. `/pool` is answered only
 *  to say where it went: the operator's thumbs remember it. */
const ANSWERED_COMMANDS = new Set(['/users', '/fleet', '/pool', '/start', '/help']);

export interface OpsBotDeps {
  botToken: string;
  /** The one chat that gets answers. Anything else is ignored in silence. */
  chatId: string;
  /** Profiles, for /fleet: the identity version lives on each agent record. */
  users: { getAllUsers(): Promise<UserProfileDocument[]> };
  /**
   * Everyone and how far each got, for /users — `readUserRoster` on the
   * backend's database. Absent on a backend without SQLite, where /users says
   * so instead of guessing from profiles.
   */
  roster?: () => Promise<RosterPerson[]>;
  /** HTTPS page the roster button opens. Without it the button is omitted. */
  miniAppUrl?: string;
  /** Public base for setWebhook, e.g. https://api.example.com/api/webhooks. */
  webhookBaseUrl?: string;
  webhookSecret?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class OpsBotService {
  private readonly fetchImpl: typeof fetch;

  private readonly now: () => Date;

  constructor(private readonly deps: OpsBotDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Answer one update. Returns what it did, so the route can log a rejection
   * without the caller having to guess.
   */
  async handleUpdate(update: OpsBotUpdate): Promise<'answered' | 'ignored'> {
    const message = update?.message;
    const chatId = message?.chat?.id;
    if (chatId === undefined || String(chatId) !== String(this.deps.chatId)) return 'ignored';

    // `/users@ACCOps_bot` is what Telegram sends in a group — same command.
    const text = (message?.text ?? '').trim();
    const command = text.split(/\s+/)[0]?.split('@')[0]?.toLowerCase() ?? '';
    if (!ANSWERED_COMMANDS.has(command)) return 'ignored';

    if (command === '/start' || command === '/help') {
      await this.send(HELP);
      return 'answered';
    }
    if (command === '/pool') {
      await this.send('/pool is gone — the shared pool is empty. /fleet shows which version the agents are on; /users shows who is on the platform.');
      return 'answered';
    }

    try {
      if (command === '/users') {
        if (!this.deps.roster) {
          await this.send('/users needs the SQLite database, and this backend runs without one.');
          return 'answered';
        }
        // The table in the chat, and the button to the one Telegram can
        // actually draw. The text stays because it is the glance: it is
        // searchable, copyable, and already there when the message arrives.
        await this.send(formatUsersReport(await this.deps.roster(), this.now()), this.rosterButton());
      } else {
        await this.send(formatFleetReport(await this.deps.users.getAllUsers(), this.now()));
      }
    } catch (error) {
      // The operator asked a question; silence would read as a dead bot, and
      // this is the chat where "the backend is broken" is the useful answer.
      console.error(`[ops-bot] ${command} failed:`, error);
      await this.send(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 'answered';
  }

  /**
   * Point the ops bot at our webhook. Idempotent — Telegram treats a repeat
   * setWebhook with the same URL as a no-op, so this runs on every boot.
   *
   * `menu` says whether Telegram took the "/" menu. A refusal is logged, not
   * thrown — the webhook is the part that carries commands — but it is never
   * ignored: until 2026-10-03 the answer went unread, and nothing noticed the
   * menu go unrefreshed — it offered /limbo six weeks after /limbo was gone.
   */
  async syncWebhook(): Promise<{ configured: boolean; menu?: boolean }> {
    if (!this.deps.webhookBaseUrl) return { configured: false };
    const url = `${this.deps.webhookBaseUrl.replace(/\/$/, '')}/telegram-ops`;
    const payload: Record<string, unknown> = { url, allowed_updates: ['message'] };
    if (this.deps.webhookSecret) payload.secret_token = this.deps.webhookSecret;
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.deps.botToken}/setWebhook`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
    );
    if (!response.ok) {
      // Status only, never the URL: the token is in it (backup-monitor.ts).
      throw new Error(`Telegram rejected setWebhook (HTTP ${response.status})`);
    }
    // So the command is discoverable from the chat's "/" menu instead of
    // being something you have to remember exists.
    const menu = await this.callApi('setMyCommands', {
      commands: [
        { command: 'users', description: 'Everyone on the platform, most recently active first' },
        { command: 'fleet', description: 'Which identity version the agents are on' },
      ],
    });
    if (!menu.ok) {
      console.warn(`[ops-bot] Telegram refused the / menu (HTTP ${menu.status}: ${await describeFailure(menu)})`);
    }
    return { configured: true, menu: menu.ok };
  }

  private async callApi(method: string, payload: Record<string, unknown>): Promise<Response> {
    return this.fetchImpl(`https://api.telegram.org/bot${this.deps.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * The button under the roster: it opens the ops Mini App, which is the only
   * place a real table can be drawn — a Telegram message is text plus a list
   * of ranges (bold from here to here), and there is no table among them.
   *
   * No URL configured, no button. A web_app button needs an HTTPS URL and
   * Telegram refuses the whole message otherwise, so a dev backend answers
   * with the text alone rather than not at all.
   */
  private rosterButton(): unknown {
    const url = this.deps.miniAppUrl;
    if (!url || !url.startsWith('https://')) return undefined;
    return { inline_keyboard: [[{ text: '\u{1F4CA} Open as a table', web_app: { url } }]] };
  }

  private async send(text: string, replyMarkup?: unknown): Promise<void> {
    const response = await this.callApi('sendMessage', {
      chat_id: this.deps.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    if (response.ok) return;
    // Telegram rejects the WHOLE message on malformed HTML, which would make
    // a formatting slip look like a dead bot at the worst possible moment.
    // The facts matter more than the bold: resend them unformatted.
    console.warn(`[ops-bot] HTML reply rejected (HTTP ${response.status}) — resending as plain text`);
    const plain = await this.callApi('sendMessage', {
      chat_id: this.deps.chatId,
      text: stripTags(text),
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    if (!plain.ok) console.warn(`[ops-bot] Telegram rejected the reply (HTTP ${plain.status})`);
  }
}
