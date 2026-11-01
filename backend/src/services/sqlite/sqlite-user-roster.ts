/**
 * Everyone who has an account, and how far each got — the WORKPLACE funnel
 * (email, workplace, seat, agent, talked).
 *
 * ONE derivation, two readers. `scripts/list-users.mjs` prints it on the host
 * from a read-only handle; the ops bot's /users and its Mini App show it on a
 * phone from the backend's own handle. Until 2026-10-03 the bot counted the
 * older Telegram funnel from `profile.telegram.agents` instead, filed every
 * web signup as "unknown", and the two carried a comment saying they no
 * longer agreed. Sharing the code is what keeps them agreeing.
 *
 * Reads tables directly rather than through the storage classes, because the
 * script must not run the schema migrations `openSqliteDb` runs: it is meant
 * to be safe against production. Every statement here is a SELECT.
 *
 * Cost: whole-table reads, synchronous. Measured on production 2026-10-03
 * (21 accounts, ~4.2k chat messages) the whole script ran in 0.18 s including
 * Node's start, so an on-demand read for one operator is fine. A per-request
 * read for every visitor would not be.
 */

import { createHash } from 'node:crypto';
import { deserializeDoc, type SqliteDb } from './sqlite-db.js';

/**
 * There was a `cloud` stage between workplace and seat, from when a workplace
 * had to connect a cloud account before its agents could run. Since note #664
 * every workplace without one runs on ours, so joining a workplace WAS
 * reaching it, `workplace` could never be shown, and "cloud" read as a step
 * the person had taken. Merged 2026-10-03.
 */
export const ROSTER_STAGES = ['signed_up', 'confirmed', 'workplace', 'told', 'seat', 'agent', 'talked'] as const;
export type RosterStage = (typeof ROSTER_STAGES)[number];

export const ROSTER_STAGE_MEANING: Record<RosterStage, string> = {
  signed_up: 'account exists, email not confirmed',
  confirmed: 'email confirmed (anonymous sign-ins count as confirmed)',
  workplace: 'belongs to a workplace (each has a cloud: its own, or ours since note #664)',
  told: 'told the Chief of Staff what they are working on (wrote in its chat; since note #726 that comes before the plan)',
  seat: 'has signed in a live Claude or ChatGPT subscription',
  agent: 'has made at least one agent (the Workspace Agent is made for them, and does not count)',
  talked: 'has written to an agent, or an agent of theirs has worked',
};

/**
 * The Workspace Agent and the Recap machine (`workspaceAssistantId` and
 * `workspaceBriefingId` in types/user.ts): the platform makes one of each per
 * person and workplace, and nobody asks for them. On a profile they carry a
 * `purpose`; a work-ledger row keeps only the id, and its prefix says the same.
 */
const isWorkspaceRecordId = (agentId: string): boolean => /^(workspace|briefing)-[0-9a-f]{32}$/.test(agentId);

/**
 * Five hex characters standing for an account where its name must not go:
 * Growth's sign-up numbers are read by every member of the workplace, so they
 * carry this instead of a name or an email (`agentbuilt signups`, Platform's
 * quick note #706). Derived from the id, so the same person keeps the same
 * code from week to week, and `list-users.mjs --user <code>` says who it is.
 */
export function rosterCode(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 5);
}

export interface RosterPlace {
  name: string;
  role?: string;
  founder: boolean;
  /** False is hosted on ours (note #664) — a cloud all the same. */
  ownCloud: boolean;
  beingDeleted: boolean;
  joined: string;
  lastSeen?: string;
}

export interface RosterPerson {
  userId: string;
  /** `rosterCode(userId)`: who this is, for a reader who must not see a name. */
  code: string;
  name: string;
  via: string;
  email: string;
  /** `@handle`, or '' for anyone who never came through Telegram. */
  telegram: string;
  /** The admin and the team's test accounts; '' is someone from outside. */
  kind: 'admin' | 'internal' | '';
  /** `2026-09-11`, or `-`. */
  joined: string;
  /** The same instant as an ISO string, for a reader that counts by week. */
  joinedAt?: string;
  /** `2026-10-03`, or `-`. */
  lastSeen: string;
  /** The same instant as an ISO string, for a reader that wants an age. */
  lastSeenAt?: string;
  /**
   * Where their browser first came from (shared/first-visit.ts): the
   * referring site's host, `direct` when it named none, or '' for an account
   * that brought no record — made before 2026-10-09, or storage kept nothing.
   */
  from: string;
  /** The first page that browser opened, or ''. */
  firstPage: string;
  /** The LAST step reached; the next one is where they stopped. */
  stage: RosterStage;
  /**
   * When they reached it, as near as the records say: the first message they
   * wrote to an agent, the first agent made, the first live seat, the first
   * workplace joined, the email confirmed, the account made. Absent when
   * nothing kept the time — someone counted as talked by work-ledger rows
   * alone, which keep a month and no more.
   */
  stageAt?: string;
  seatAt: string;
  workplaces: string[];
  webLogins: number;
  /** Agents they have now. The Workspace Agent and Recap machine are not theirs to make, so not counted. */
  agents: number;
  /**
   * Agents they made and later deleted — the ones the database still
   * remembers, so a floor. Made in all is `agents + agentsDeleted`.
   */
  agentsDeleted: number;
  messagesToAgents: number;
  agentMinutes: number;
  liveSites: string[];
  repos: number;
  notes: number;
  detail: {
    places: RosterPlace[];
    devices: string[];
    agentTime: string[];
    agents: string[];
    seats: string[];
  };
}

/** Documents are read loosely: this is a report, and a missing field is a blank. */
type Doc = Record<string, any>;

/** ISO string from a revived Timestamp, Date, epoch-ms number or string. */
function iso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate(): Date }).toDate().toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return String(value);
}
const day = (value: unknown): string => iso(value)?.slice(0, 10) ?? '-';
const latest = (...values: unknown[]): string | undefined => values
  .map(iso)
  .filter((value): value is string => Boolean(value))
  .sort()
  .at(-1);
const earliest = (...values: unknown[]): string | undefined => values
  .map(iso)
  .filter((value): value is string => Boolean(value))
  .sort()[0];

/**
 * The whole roster, oldest account first.
 *
 * Dates: documents store two tagged forms, `{"__sqlite_ts__": iso}` (older
 * accounts, from Timestamps) and `{"__sqlite_date__": iso}` (newer, from
 * Dates). `deserializeDoc` revives both; a hand-written sqlite3 query that
 * reads only one of them shows blank join dates for the other half.
 */
export function readUserRoster(db: SqliteDb): RosterPerson[] {
  const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
  const byUser = <T extends { user_id: string }>(sql: string): Map<string, T[]> => {
    const map = new Map<string, T[]>();
    for (const row of all<T>(sql)) map.set(row.user_id, [...(map.get(row.user_id) ?? []), row]);
    return map;
  };

  const orgs = new Map(all<{ org_id: string; doc: string }>('SELECT org_id, doc FROM orgs')
    .map((row) => [row.org_id, deserializeDoc<Doc>(row.doc)]));
  const identities = new Map(all<{ user_id: string; doc: string }>('SELECT user_id, doc FROM workspace_email_identities')
    .map((row) => [row.user_id, deserializeDoc<Doc>(row.doc)]));
  const memberships = byUser<{ user_id: string; org_id: string; doc: string }>('SELECT user_id, org_id, doc FROM org_members');
  const webSessions = byUser<{ user_id: string; doc: string }>('SELECT user_id, doc FROM workspace_web_sessions');
  const chats = byUser<{ user_id: string; agent_id: string; role: string; n: number; first: string; last: string }>(`SELECT user_id, agent_id, json_extract(doc, '$.role') AS role,
    count(*) AS n, min(json_extract(doc, '$.at')) AS first, max(json_extract(doc, '$.at')) AS last FROM agent_chat_messages GROUP BY 1, 2, 3`);
  const work = byUser<{ user_id: string; agent_id: string; agent_name: string; month: string; working_ms: number }>(
    'SELECT user_id, agent_id, agent_name, month, working_ms FROM agent_work_ledger',
  );
  const telegramActivity = byUser<{ user_id: string; last: number }>(
    'SELECT user_id, max(last_active_at_ms) AS last FROM telegram_agent_activity GROUP BY 1',
  );
  const sites = byUser<{ user_id: string; name: string }>(
    `SELECT user_id, name FROM deployments WHERE json_extract(doc, '$.status') = 'live'`,
  );
  const repos = byUser<{ user_id: string }>('SELECT user_id, name FROM git_repos');
  const notes = byUser<{ user_id: string; n: number }>('SELECT user_id, count(*) AS n FROM quick_notes GROUP BY 1');
  // A seat is a member's own Claude or ChatGPT subscription signed in (org.ts);
  // dead and disabled ones no longer carry a turn and do not count as a step.
  const seats = byUser<{ user_id: string; doc: string }>('SELECT user_id, doc FROM org_seats');

  const person = (userId: string, profile: Doc): RosterPerson => {
    const identity = identities.get(userId);
    const telegram: Doc = profile.telegram ?? {};
    const email: string | undefined = identity?.emailCanonical ?? identity?.email ?? profile.email;
    const via: string = profile.authType ?? (identity ? 'email' : 'unknown');
    const confirmed = via !== 'email'
      || Boolean(identity?.emailVerifiedAt)
      || ['verified', 'legacy'].includes(identity?.verificationStatus);

    const memberDocs = (memberships.get(userId) ?? []).map((row) => ({ row, member: deserializeDoc<Doc>(row.doc) }));
    const places: RosterPlace[] = memberDocs.map(({ row, member }) => {
      const org = orgs.get(row.org_id) ?? {};
      return {
        name: org.name ?? row.org_id,
        role: member.role,
        founder: org.createdByUserId === userId,
        ownCloud: Boolean(org.fly?.orgSlug),
        beingDeleted: Boolean(org.deletion),
        joined: day(member.joinedAt),
        lastSeen: iso(member.lastSeenAt),
      };
    });
    const logins = (webSessions.get(userId) ?? []).map((row) => deserializeDoc<Doc>(row.doc));
    const chatRows = chats.get(userId) ?? [];
    const records: Record<string, Doc> = telegram.agents ?? {};
    const agents = Object.values(records).filter((agent) => !agent.purpose);
    const ownerMessages = chatRows.filter((row) => row.role === 'owner');
    const workRows = work.get(userId) ?? [];

    // A deleted agent's record is hard deleted, but two things it left behind
    // are not: its work-ledger rows (never deleted; kept since 2026-09-23) and,
    // sometimes, its chat history. Either one proves the agent existed. An
    // agent deleted before it ever worked, or before the ledger began, left
    // neither — so this is a floor, not a full count.
    const deleted = new Map<string, string>();
    for (const row of [...workRows, ...chatRows]) {
      if (Object.hasOwn(records, row.agent_id) || isWorkspaceRecordId(row.agent_id)) continue;
      const name = 'agent_name' in row ? row.agent_name : '';
      if (!deleted.get(row.agent_id)) deleted.set(row.agent_id, name);
    }

    const seatRows = (seats.get(userId) ?? []).map((row) => deserializeDoc<Doc>(row.doc));
    const liveSeats = seatRows.filter((seat) => !['dead', 'disabled'].includes(seat.status));
    const seatAt = seatRows.map((seat) => iso(seat.createdAt)).filter(Boolean).sort()[0];

    // Written to an agent — or an agent of theirs has WORKED. The chat history
    // alone misses people: it starts 2026-08-29, keeps 500 rows per agent and
    // is deleted with the agent, while the work ledger outlives all three.
    // Work is not a weaker proof: nothing starts an agent by itself (checked
    // on production 2026-10-03 — every agent owner who never wrote had 0
    // minutes), so an agent that worked is one somebody set going.
    const workMs = workRows.reduce((sum, row) => sum + row.working_ms, 0);
    const talked = ownerMessages.length > 0 || workMs > 0;
    // Told the Chief of Staff (note #726): an owner row in the private
    // conversation on any membership — the first thing a new account does
    // now, before any plan is signed in.
    const toldRows = memberDocs.flatMap(({ member }) => ((member.workspaceRecapChat?.messages ?? []) as Array<{ role?: string; at: string }>).filter((row) => row.role === 'owner'));
    const stage: RosterStage = talked ? 'talked'
      : agents.length + deleted.size > 0 ? 'agent'
        : liveSeats.length > 0 ? 'seat'
          : toldRows.length > 0 ? 'told'
            : places.length > 0 ? 'workplace'
              : confirmed ? 'confirmed'
                : 'signed_up';
    const joinedAt = iso(profile.createdAt);
    const stageAt = {
      talked: () => earliest(...ownerMessages.map((row) => row.first)),
      agent: () => earliest(
        ...agents.map((agent) => agent.createdAt),
        ...chatRows.filter((row) => deleted.has(row.agent_id)).map((row) => row.first),
      ),
      seat: () => earliest(...liveSeats.map((seat) => seat.createdAt)),
      told: () => earliest(...toldRows.map((row) => row.at)),
      workplace: () => earliest(...memberDocs.map(({ member }) => member.joinedAt)),
      confirmed: () => (via === 'email' ? iso(identity?.emailVerifiedAt) : undefined) ?? joinedAt,
      signed_up: () => joinedAt,
    }[stage]();

    const lastSeenAt = latest(
      ...logins.map((login) => login.lastSeenAt ?? login.createdAt),
      ...places.map((place) => place.lastSeen),
      ...ownerMessages.map((row) => row.last),
      telegramActivity.get(userId)?.[0]?.last,
      telegram.lastUserActivityAt,
    );
    return {
      userId,
      code: rosterCode(userId),
      name: profile.displayName
        || profile.username || email?.split('@')[0] || userId,
      via,
      email: email ?? '',
      telegram: telegram.username ? `@${telegram.username}` : '',
      // The team's own accounts are MARKED (`roles.internal`). Until
      // 2026-10-08 any address on our own domain counted as the team's — and
      // since 2026-09-14 every new account gets one (it picks its own address
      // at agenticcloudcomputer.com), so every real sign-up from that day on
      // was filed as ours and Growth read "nobody since 13 Sep" while five
      // people had come. An address no longer says who someone is.
      kind: profile.roles?.admin ? 'admin' : profile.roles?.internal ? 'internal' : '',
      joined: day(profile.createdAt),
      ...(joinedAt ? { joinedAt } : {}),
      from: profile.firstVisit ? profile.firstVisit.from || 'direct' : '',
      firstPage: profile.firstVisit?.page ?? '',
      lastSeen: day(lastSeenAt),
      ...(lastSeenAt ? { lastSeenAt } : {}),
      stage,
      ...(stageAt ? { stageAt } : {}),
      seatAt: day(seatAt),
      workplaces: places.map((place) => place.name),
      webLogins: logins.length,
      agents: agents.length,
      agentsDeleted: deleted.size,
      messagesToAgents: ownerMessages.reduce((sum, row) => sum + row.n, 0),
      agentMinutes: Math.round(workMs / 60000),
      liveSites: (sites.get(userId) ?? []).map((row) => row.name),
      repos: (repos.get(userId) ?? []).length,
      notes: notes.get(userId)?.[0]?.n ?? 0,
      detail: {
        places,
        devices: [...new Set(logins.map((login) => login.userAgent).filter(Boolean) as string[])],
        agentTime: workRows.map((row) => `${row.agent_name} ${row.month}: ${Math.round(row.working_ms / 60000)} min`),
        agents: [
          ...agents.map((agent) => `${agent.name} (${agent.cli ?? '?'}${agent.connectedAt ? ', signed in' : ''})`),
          ...[...deleted].map(([id, name]) => `${name || id} (deleted)`),
        ],
        seats: seatRows.map((seat) => `${seat.provider} ${seat.status}${seat.subscriptionStatus ? `, ${seat.subscriptionStatus}` : ''}, signed in ${day(seat.createdAt)}`),
      },
    };
  };

  return all<{ user_id: string; doc: string }>('SELECT user_id, doc FROM users')
    .map((row) => person(row.user_id, deserializeDoc<Doc>(row.doc)))
    .sort((a, b) => a.joined.localeCompare(b.joined));
}
