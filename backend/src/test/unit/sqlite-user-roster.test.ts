import { describe, expect, it } from 'vitest';
import { openSqliteDb, serializeDoc, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { readUserRoster } from '../../services/sqlite/sqlite-user-roster.js';

/**
 * The roster both `scripts/list-users.mjs` and the ops bot's /users read. The
 * stage is the LAST step reached, so each fixture below is one person stopped
 * at one step — the question the roster exists to answer is "where".
 */

const at = (iso: string) => new Date(iso);

function seed(): SqliteDb {
  const db = openSqliteDb(':memory:');
  const user = (userId: string, doc: Record<string, unknown>) => db
    .prepare('INSERT INTO users (user_id, doc) VALUES (?, ?)')
    .run(userId, serializeDoc({ userId, ...doc }));
  const identity = (userId: string, email: string, doc: Record<string, unknown> = {}) => db
    .prepare('INSERT INTO workspace_email_identities (user_id, email_canonical, doc) VALUES (?, ?, ?)')
    .run(userId, email, serializeDoc({ userId, email, emailCanonical: email, ...doc }));
  const member = (orgId: string, userId: string, doc: Record<string, unknown> = {}) => db
    .prepare('INSERT INTO org_members (org_id, user_id, doc) VALUES (?, ?, ?)')
    .run(orgId, userId, serializeDoc({ orgId, userId, role: 'admin', ...doc }));

  db.prepare('INSERT INTO orgs (org_id, doc) VALUES (?, ?)')
    .run('org_a', serializeDoc({ orgId: 'org_a', name: 'Acme', createdByUserId: 'u_workplace' }));

  // Signed up by email and never confirmed it.
  user('u_unconfirmed', { authType: 'email', createdAt: at('2026-09-11T10:00:00Z'), firstVisit: { from: 't.co', page: '/', at: '2026-09-11T09:58:00.000Z' } });
  identity('u_unconfirmed', 'likodic@example.com', { verificationStatus: 'pending' });

  // Confirmed, and no further.
  user('u_confirmed', { authType: 'email', createdAt: at('2026-09-12T10:00:00Z') });
  identity('u_confirmed', 'conf@example.com', { emailVerifiedAt: at('2026-09-12T10:05:00Z') });

  // Someone from outside with an address HERE — which every account made
  // since 2026-09-14 has. Not one of ours for that.
  user('u_mailbox', { authType: 'email', createdAt: at('2026-09-27T14:46:00Z'), firstVisit: { from: '', page: '/workspace', at: '2026-09-27T14:40:00.000Z' } });
  identity('u_mailbox', 'zxc@agenticcloudcomputer.com', { verificationStatus: 'verified' });

  // A workplace, and no further. (It has a cloud — ours when not its own, since
  // note #664 — so there is no separate cloud step to stop at any more.)
  user('u_workplace', { authType: 'email', createdAt: at('2026-09-13T10:00:00Z') });
  identity('u_workplace', 'jem@example.com', { verificationStatus: 'verified' });
  // The Chief of Staff's fixed greeting (note #726) is the platform's row,
  // not theirs: it does not make them "told".
  member('org_a', 'u_workplace', {
    joinedAt: at('2026-09-13T10:02:00Z'), lastSeenAt: at('2026-09-14T08:00:00Z'),
    workspaceRecapChat: { messages: [{ id: 'g', role: 'assistant', kind: 'greeting', text: 'Hi jem, I\'m your Chief of Staff.', at: '2026-09-13T10:02:30.000Z' }] },
  });

  // Told the Chief of Staff what they are working on (note #726) — wrote in
  // its chat, which since then comes BEFORE any plan is signed in — and no
  // further. The stage stamp is their first message, not the greeting over it.
  user('u_told', { authType: 'email', createdAt: at('2026-09-13T12:00:00Z') });
  identity('u_told', 'told@example.com', { verificationStatus: 'verified' });
  member('org_a', 'u_told', {
    joinedAt: at('2026-09-13T12:01:00Z'),
    workspaceRecapChat: { messages: [
      { id: 'g', role: 'assistant', kind: 'greeting', text: 'Hi, I\'m your Chief of Staff.', at: '2026-09-13T12:01:10.000Z' },
      { id: 'o1', role: 'owner', text: 'A waitlist page for my app.', at: '2026-09-13T12:03:00.000Z' },
      { id: 'a1', role: 'assistant', kind: 'signin-ask', text: 'Got it. Sign in your plan below.', at: '2026-09-13T12:03:01.000Z' },
      { id: 'o2', role: 'owner', text: 'And a logo.', at: '2026-09-13T12:04:00.000Z' },
    ] },
  });

  // A seat signed in; a DEAD seat beside it on another person counts for nothing.
  user('u_seat', { authType: 'email', createdAt: at('2026-09-14T10:00:00Z') });
  identity('u_seat', 'seat@example.com', { verificationStatus: 'verified' });
  member('org_a', 'u_seat');
  db.prepare('INSERT INTO org_seats (seat_id, org_id, user_id, doc) VALUES (?, ?, ?, ?)')
    .run('s1', 'org_a', 'u_seat', serializeDoc({ provider: 'claude', status: 'active', createdAt: at('2026-09-15T00:00:00Z') }));
  user('u_dead_seat', { authType: 'email', createdAt: at('2026-09-15T10:00:00Z') });
  identity('u_dead_seat', 'dead@example.com', { verificationStatus: 'verified' });
  member('org_a', 'u_dead_seat');
  db.prepare('INSERT INTO org_seats (seat_id, org_id, user_id, doc) VALUES (?, ?, ?, ?)')
    .run('s2', 'org_a', 'u_dead_seat', serializeDoc({ provider: 'claude', status: 'dead' }));

  // An agent, never written to — and an anonymous signup, which needs no email.
  user('u_agent', {
    authType: 'anonymous_totp',
    displayName: 'Ada L',
    createdAt: at('2026-08-01T10:00:00Z'),
    telegram: {
      username: 'ada',
      agents: { a1: { id: 'a1', name: 'Leo', cli: 'claude', createdAt: '2026-08-01T11:00:00.000Z', connectedAt: '2026-08-02T00:00:00Z' } },
      lastUserActivityAt: '2026-09-20T12:00:00Z',
      // The platform TALKING to someone — a recycle warning — is not them
      // showing up, so this must never be read as last seen.
      lastActivityAt: '2026-10-02T12:00:00Z',
    },
  });
  // Their agent's own activity stamp is presence, and fresher.
  db.prepare('INSERT INTO telegram_agent_activity (user_id, agent_id, last_active_at_ms) VALUES (?, ?, ?)')
    .run('u_agent', 'a1', Date.parse('2026-09-25T09:00:00Z'));

  // Has written to an agent: the last step there is. And marked as one of
  // the team's own, so it is internal, not someone from outside.
  user('u_talked', { authType: 'email', createdAt: at('2026-09-20T10:00:00Z'), displayName: 'Jon Jones', roles: { internal: true } });
  identity('u_talked', 'testjon@agenticcloudcomputer.com', { verificationStatus: 'verified' });
  member('org_a', 'u_talked');
  db.prepare('INSERT INTO agent_chat_messages (user_id, agent_id, seq, doc) VALUES (?, ?, ?, ?)')
    .run('u_talked', 'a9', 1, JSON.stringify({ role: 'owner', at: '2026-10-03T11:00:00.000Z', text: 'hi' }));
  db.prepare('INSERT INTO agent_chat_messages (user_id, agent_id, seq, doc) VALUES (?, ?, ?, ?)')
    .run('u_talked', 'a9', 2, JSON.stringify({ role: 'agent', at: '2026-10-03T11:01:00.000Z', text: 'hello' }));

  // An agent that WORKED and was then deleted: no agent on the profile, no
  // chat rows (they go with the agent), but the work ledger outlives both.
  user('u_worked', { authType: 'email', createdAt: at('2026-09-25T10:00:00Z') });
  identity('u_worked', 'worked@example.com', { verificationStatus: 'verified' });
  member('org_a', 'u_worked');
  db.prepare('INSERT INTO agent_work_ledger (user_id, agent_id, month, org_id, agent_name, working_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run('u_worked', 'gone', '2026-09', 'org_a', 'Gone', 2 * 60_000);

  // Holds only what the platform made FOR them — the Workspace Agent and the
  // Recap machine — and has made nothing. Until 2026-10-04 those two put
  // people at "agent", with nothing of theirs on the books.
  const workspaceRecords = {
    'workspace-0123456789abcdef0123456789abcdef': { id: 'workspace-0123456789abcdef0123456789abcdef', name: 'Workspace Agent', purpose: 'workspace-recap' },
    'briefing-0123456789abcdef0123456789abcdef': { id: 'briefing-0123456789abcdef0123456789abcdef', name: 'Workspace Recap', purpose: 'workspace-briefing' },
  };
  user('u_helpers_only', { authType: 'email', createdAt: at('2026-09-26T10:00:00Z'), telegram: { agents: workspaceRecords } });
  identity('u_helpers_only', 'helpers@example.com', { verificationStatus: 'verified' });
  member('org_a', 'u_helpers_only');

  // Made four: keeps one, deleted three. The ledger remembers two of the
  // deleted (one under two months, counted once), the chat history the third;
  // the Workspace Agent's own work and chat are neither kept nor deleted.
  user('u_maker', {
    authType: 'email',
    createdAt: at('2026-09-27T10:00:00Z'),
    telegram: { agents: { ...workspaceRecords, kept: { id: 'kept', name: 'Ivy', cli: 'codex' } } },
  });
  identity('u_maker', 'maker@example.com', { verificationStatus: 'verified' });
  member('org_a', 'u_maker');
  const ledger = (agentId: string, month: string, name: string) => db
    .prepare('INSERT INTO agent_work_ledger (user_id, agent_id, month, org_id, agent_name, working_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run('u_maker', agentId, month, 'org_a', name, 60_000);
  ledger('kept', '2026-09', 'Ivy');
  ledger('felix', '2026-09', 'Felix');
  ledger('felix', '2026-10', 'Felix');
  ledger('rosa', '2026-10', 'Rosa');
  ledger('workspace-0123456789abcdef0123456789abcdef', '2026-10', 'Workspace Agent');
  ledger('workspace-ffffffffffffffffffffffffffffffff', '2026-09', 'Workspace Agent');
  db.prepare('INSERT INTO agent_chat_messages (user_id, agent_id, seq, doc) VALUES (?, ?, ?, ?)')
    .run('u_maker', 'early', 1, JSON.stringify({ role: 'owner', at: '2026-09-28T09:00:00.000Z', text: 'hi' }));
  db.prepare('INSERT INTO agent_chat_messages (user_id, agent_id, seq, doc) VALUES (?, ?, ?, ?)')
    .run('u_maker', 'felix', 1, JSON.stringify({ role: 'owner', at: '2026-09-28T10:00:00.000Z', text: 'hi' }));

  // The admin, whatever their address — and an older document whose date is
  // stored in the Timestamp form, which a careless reader shows as blank.
  db.prepare('INSERT INTO users (user_id, doc) VALUES (?, ?)').run('u_admin', JSON.stringify({
    userId: 'u_admin', authType: 'email', roles: { admin: true },
    createdAt: { __sqlite_ts__: '2026-07-27T09:00:00.000Z' },
  }));
  identity('u_admin', 'adam@example.com', { verificationStatus: 'legacy' });
  return db;
}

describe('readUserRoster', () => {
  const roster = readUserRoster(seed());
  const who = (userId: string) => {
    const person = roster.find((entry) => entry.userId === userId);
    if (!person) throw new Error(`${userId} is not on the roster`);
    return person;
  };

  it('puts each person at the LAST step they reached', () => {
    expect(who('u_unconfirmed').stage).toBe('signed_up');
    expect(who('u_confirmed').stage).toBe('confirmed');
    expect(who('u_workplace').stage).toBe('workplace');
    expect(who('u_told').stage).toBe('told');
    expect(who('u_seat').stage).toBe('seat');
    expect(who('u_agent').stage).toBe('agent');
    expect(who('u_talked').stage).toBe('talked');
  });

  it('counts a person as "told" by their own row in the Chief of Staff\'s chat, never by the greeting written for them (note #726)', () => {
    // u_workplace holds only the platform's greeting: a workplace, no more.
    expect(who('u_workplace')).toMatchObject({ stage: 'workplace', messagesToAgents: 0 });
    // Writing to the Chief of Staff is not writing to an agent of theirs.
    expect(who('u_told')).toMatchObject({ stage: 'told', agents: 0, messagesToAgents: 0 });
  });

  it('counts an agent that has worked as talked, even after it was deleted', () => {
    // The chat history alone would put this person back at "workplace".
    expect(who('u_worked')).toMatchObject({ stage: 'talked', agents: 0, agentsDeleted: 1, messagesToAgents: 0, agentMinutes: 2 });
  });

  it('counts the agents a person made, and not the two made for them', () => {
    expect(who('u_helpers_only')).toMatchObject({ stage: 'workplace', agents: 0, agentsDeleted: 0 });
    expect(who('u_agent')).toMatchObject({ agents: 1, agentsDeleted: 0 });
  });

  it('remembers deleted agents by what they left behind: work, or a chat', () => {
    const maker = who('u_maker');
    expect(maker).toMatchObject({ agents: 1, agentsDeleted: 3 });
    expect(maker.detail.agents).toEqual(['Ivy (codex)', 'Felix (deleted)', 'Rosa (deleted)', 'early (deleted)']);
    // A deleted agent counts as made, so it is the agent step at least.
    expect(who('u_worked')).toMatchObject({ agents: 0, agentsDeleted: 1 });
  });

  it('does not count a dead seat as a step', () => {
    expect(who('u_dead_seat').stage).toBe('workplace');
  });

  it('counts an anonymous signup as confirmed without any email', () => {
    expect(who('u_agent')).toMatchObject({ via: 'anonymous_totp', telegram: '@ada', name: 'Ada L', email: '' });
  });

  it('tells the team\'s own accounts from people outside by the mark, never by the address', () => {
    expect(who('u_talked').kind).toBe('internal');
    expect(who('u_admin').kind).toBe('admin');
    expect(who('u_workplace').kind).toBe('');
    // On our own domain, unmarked: a person from outside.
    expect(who('u_mailbox').kind).toBe('');
  });

  it('names a web signup by its email when it gave no name — never by its id', () => {
    expect(who('u_workplace').name).toBe('jem');
    expect(who('u_talked').name).toBe('Jon Jones');
  });

  it('reads both stored date forms', () => {
    expect(who('u_admin').joined).toBe('2026-07-27');
    expect(who('u_workplace').joined).toBe('2026-09-13');
  });

  it('sees a person at the latest thing THEY did', () => {
    // The owner's own message, not the agent's reply a minute later.
    expect(who('u_talked').lastSeenAt).toBe('2026-10-03T11:00:00.000Z');
    expect(who('u_workplace').lastSeen).toBe('2026-09-14');
    // The agent's activity beats the account stamp, and the platform's own
    // message to them (a day later still) is not presence at all.
    expect(who('u_agent').lastSeenAt).toBe('2026-09-25T09:00:00.000Z');
    expect(who('u_confirmed').lastSeenAt).toBeUndefined();
    expect(who('u_confirmed').lastSeen).toBe('-');
  });

  it('says when each person reached the step they stand on', () => {
    expect(who('u_unconfirmed').stageAt).toBe('2026-09-11T10:00:00.000Z');
    // The confirmation's own stamp, not the account's.
    expect(who('u_confirmed').stageAt).toBe('2026-09-12T10:05:00.000Z');
    expect(who('u_workplace').stageAt).toBe('2026-09-13T10:02:00.000Z');
    // Their FIRST message to the Chief of Staff, not the greeting and not the second.
    expect(who('u_told').stageAt).toBe('2026-09-13T12:03:00.000Z');
    // Their seat signed in on the 15th; the account is from the 14th.
    expect(who('u_seat').stageAt).toBe('2026-09-15T00:00:00.000Z');
    expect(who('u_agent').stageAt).toBe('2026-08-01T11:00:00.000Z');
    // The FIRST message they wrote, not the last.
    expect(who('u_maker').stageAt).toBe('2026-09-28T09:00:00.000Z');
    // Talked by work alone: the ledger keeps a month, which is not a time.
    expect(who('u_worked').stageAt).toBeUndefined();
    expect(who('u_admin').joinedAt).toBe('2026-07-27T09:00:00.000Z');
  });

  it('says where each browser first came from, and tells "no site named" from "no record"', () => {
    expect(who('u_unconfirmed')).toMatchObject({ from: 't.co', firstPage: '/' });
    expect(who('u_mailbox')).toMatchObject({ from: 'direct', firstPage: '/workspace' });
    expect(who('u_confirmed')).toMatchObject({ from: '', firstPage: '' });
  });

  it('gives every account the same short code every time, and a different one per account', () => {
    expect(who('u_workplace').code).toMatch(/^[0-9a-f]{5}$/);
    expect(readUserRoster(seed()).find((person) => person.userId === 'u_workplace')!.code).toBe(who('u_workplace').code);
    expect(new Set(roster.map((person) => person.code)).size).toBe(roster.length);
  });

  it('lists oldest account first, as the script prints it', () => {
    expect(roster[0]!.userId).toBe('u_admin');
    expect(roster.map((person) => person.joined)).toEqual([...roster.map((person) => person.joined)].sort());
  });
});
