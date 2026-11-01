import { describe, expect, it, vi } from 'vitest';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryQuickNoteStorage } from '../../services/quick-note-storage.js';
import { InMemoryGitPullRequestStorage } from '../../services/git-pr-storage.js';
import { InMemoryGitCommitStatusStorage } from '../../services/git-commit-status-storage.js';
import { InMemoryKnowledgeProposalStorage } from '../../services/knowledge-storage.js';
import { WorkspaceAgentEventSweep, eventsDue, recordInLedger, FAILED_TURN_PREFIX, EVENT_NUDGE_DEBOUNCE_MS, type LatestChatRow } from '../../services/workspace-agent-events.js';
import { DEFAULT_WORKSPACE_AGENT_PROACTIVE, applyWorkspaceAgentProactiveChange, inQuietHours, resolveWorkspaceAgentProactive, type WorkspaceAgentEvent } from '../../shared/workspace-agent-proactive.js';
import { QUICK_NOTE_AUTHOR_USER } from '../../types/quick-note.js';
import { workspaceAssistantId } from '../../types/user.js';

/**
 * Event turns (note #716): what the platform notices for one person's Chief
 * of Staff, and the rules that decide what reaches it — the person's own
 * agents and notes only, once per cause per day, quiet hours, nothing for an
 * agent never started.
 */
const HOUR = 3_600_000;
const NOON_BISHKEK = new Date('2026-10-11T06:00:00.000Z'); // 12:00 in UTC+6

/** One workplace with no rooms (note #923): its notes and proposals stand at
 *  the workplace's own namespace; `formerNamespaces` are its old rooms'
 *  namespaces, recorded on it when they were merged (note #843). */
async function world(options: { formerNamespaces?: string[] } = {}) {
  const orgStorage = new InMemoryOrgStorage();
  const userStorage = new InMemoryUserStorage();
  const notes = new InMemoryQuickNoteStorage();
  const prs = new InMemoryGitPullRequestStorage();
  const statuses = new InMemoryGitCommitStatusStorage();
  const kps = new InMemoryKnowledgeProposalStorage();
  await userStorage.createProfile('u1', { email: 'adam@example.com' });
  const org = await orgStorage.createOrg({ name: 'Studio', createdByUserId: 'u1' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'u1', role: 'admin' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'u2', role: 'member' });
  if (options.formerNamespaces) await orgStorage.updateOrg(org.orgId, { roomsMerged: { mergedAt: org.createdAt, namespaces: options.formerNamespaces } });
  // The workplace's own namespace: no git namespace yet, so its founder's.
  const workplace = 'u1';
  const waId = workspaceAssistantId('u1', org.orgId);
  await userStorage.updateProfile('u1', { telegram: { chatId: '1', linkedAt: 't', notificationsEnabled: true, agents: {
    a1: { id: 'a1', name: 'Theo', cli: 'codex', orgId: org.orgId, connectedAt: 't', createdAt: 't' } as never,
    [waId]: { id: waId, name: 'Workspace Agent', cli: 'claude', orgId: org.orgId, purpose: 'workspace-recap', connectedAt: 't', createdAt: 't' } as never,
  } } });
  const clock = { now: NOON_BISHKEK };
  const rows = new Map<string, LatestChatRow>();
  const working = new Set<string>();
  let wakeAgent: string | null = null;
  const receiveEvents = vi.fn(async (_args: { userId: string; orgId: string; events: WorkspaceAgentEvent[] }) => true);
  const sweep = new WorkspaceAgentEventSweep({
    orgStorage, userStorage, quickNoteStorage: notes, gitPullRequestStorage: prs, gitCommitStatusStorage: statuses, knowledgeProposalStorage: kps,
    latestChatRow: async (_u, agentId) => rows.get(agentId) ?? null,
    isAgentWorking: (_u, agentId) => working.has(agentId),
    mailHolderOf: async (address) => address === 'adam@mail.test' ? 'u1' : null,
    mailWakeAgentOf: async () => wakeAgent,
    receiveEvents,
    now: () => clock.now,
  });
  const turnOn = (change: Record<string, unknown> = {}) => orgStorage.touchMember(org.orgId, 'u1', {
    workspaceAgentProactive: { ...DEFAULT_WORKSPACE_AGENT_PROACTIVE, events: true, timeZone: 'Asia/Bishkek', ...change },
  });
  const proposal = async (fields: { by?: string; userId?: string; title?: string; readyHoursAgo?: number; draft?: boolean; sha?: string; at?: string } = {}) => {
    const doc = await prs.create({
      repoId: 'repo-1', userId: fields.at ?? workplace, title: fields.title ?? 'Booking page', sourceBranch: 'b', targetBranch: 'main',
      headSha: fields.sha ?? 'a'.repeat(40), diffStat: { files: 1, insertions: 1, deletions: 0 }, commitSubjects: ['x'],
      createdByAgentId: fields.by ?? 'a1', createdByUserId: fields.userId ?? 'u1', status: 'open', ...(fields.draft ? { draft: true as const } : {}),
    });
    const readyAt = new Date(clock.now.getTime() - (fields.readyHoursAgo ?? 1) * HOUR).toISOString();
    await prs.update(doc.id, { readyAt });
    return (await prs.get(doc.id))!;
  };
  const red = (sha = 'a'.repeat(40), context = 'ci/checks') => statuses.upsert({
    userId: workplace, repoId: 'repo-1', sha, context, state: 'failure', description: 'tests failed',
    startedAt: new Date(clock.now.getTime() - HOUR).toISOString(), completedAt: new Date(clock.now.getTime() - HOUR / 2).toISOString(),
  });
  const note = async (fields: { by?: string; userId?: string; hoursAgo?: number; html?: string } = {}) => {
    const doc = await notes.create({ userId: workplace, html: fields.html ?? '<p>Make the booking page faster</p>', createdByAgentId: fields.by ?? QUICK_NOTE_AUTHOR_USER, createdByUserId: fields.userId ?? 'u1', updatedByAgentId: fields.by ?? QUICK_NOTE_AUTHOR_USER });
    await notes.update(doc.id, { createdAt: new Date(clock.now.getTime() - (fields.hoursAgo ?? 50) * HOUR).toISOString() });
    return doc;
  };
  const handed = () => receiveEvents.mock.calls.map(([args]) => args.events.map((e) => e.kind));
  return { orgStorage, userStorage, notes, prs, statuses, kps, org: org.orgId, waId, clock, rows, working, receiveEvents, sweep, turnOn, proposal, red, note, handed, setWake: (id: string | null) => { wakeAgent = id; } };
}

describe('the settings (note #716)', () => {
  it('defaults to off, keeps every malformed field at its default, and refuses a bad change in words', () => {
    expect(resolveWorkspaceAgentProactive(undefined)).toEqual(DEFAULT_WORKSPACE_AGENT_PROACTIVE);
    expect(resolveWorkspaceAgentProactive({ events: 'yes', quietFrom: 25, timeZone: 'Mars/Olympus', thresholds: { noteHours: 5 }, permissions: { 'ask-silent-agent': true, bogus: true } }))
      .toEqual({ ...DEFAULT_WORKSPACE_AGENT_PROACTIVE, permissions: { ...DEFAULT_WORKSPACE_AGENT_PROACTIVE.permissions, 'ask-silent-agent': true } });
    const current = resolveWorkspaceAgentProactive(undefined);
    expect(applyWorkspaceAgentProactiveChange(current, { events: true, timeZone: 'Asia/Bishkek', thresholds: { noteHours: 72 }, permissions: { 'hand-unclaimed-note': true } }))
      .toEqual({ ok: true, value: { ...current, events: true, timeZone: 'Asia/Bishkek', thresholds: { ...current.thresholds, noteHours: 72 }, permissions: { ...current.permissions, 'hand-unclaimed-note': true } } });
    expect(applyWorkspaceAgentProactiveChange(current, { quietFrom: 24 })).toEqual({ ok: false, error: 'Quiet hours are whole hours from 0 to 23.' });
    expect(applyWorkspaceAgentProactiveChange(current, { thresholds: { noteHours: 5 } })).toMatchObject({ ok: false });
    expect(applyWorkspaceAgentProactiveChange(current, { permissions: { 'send-mail': true } })).toEqual({ ok: false, error: 'There is no permission called send-mail.' });
    expect(applyWorkspaceAgentProactiveChange(current, { timeZone: 'Nowhere/Land' })).toMatchObject({ ok: false });
  });
  it('reads quiet hours in the person\'s own zone, across midnight', () => {
    const settings = { quietFrom: 23, quietTo: 8, timeZone: 'Asia/Bishkek' };
    expect(inQuietHours(settings, new Date('2026-10-11T18:00:00Z'))).toBe(true); // 00:00 there
    expect(inQuietHours(settings, new Date('2026-10-11T01:59:00Z'))).toBe(true); // 07:59
    expect(inQuietHours(settings, new Date('2026-10-11T02:00:00Z'))).toBe(false); // 08:00
    expect(inQuietHours(settings, new Date('2026-10-11T16:59:00Z'))).toBe(false); // 22:59
    expect(inQuietHours({ ...settings, quietFrom: 8 }, new Date('2026-10-11T18:00:00Z'))).toBe(false); // none
  });
});

describe('what the sweep notices (note #716)', () => {
  it('hands nothing over while event turns are off, or for a Chief of Staff never started', async () => {
    const x = await world();
    await x.note();
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(0);
    await x.turnOn();
    const profile = (await x.userStorage.getProfile('u1'))!;
    const { [x.waId]: _wa, ...rest } = profile.telegram!.agents!;
    await x.userStorage.updateProfile('u1', { telegram: { ...profile.telegram!, agents: rest } });
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(0);
    expect(x.receiveEvents).not.toHaveBeenCalled();
  });

  it('red checks on the person\'s own proposal, once per red sha — not while its author is still working, never a teammate\'s', async () => {
    const x = await world();
    await x.turnOn();
    const pr = await x.proposal();
    await x.proposal({ by: 'someone-else', userId: 'u2', title: 'Teammate work', sha: 'b'.repeat(40) });
    await x.red();
    await x.red('b'.repeat(40));
    x.working.add('a1');
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(0);
    x.working.delete('a1');
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(1);
    const [event] = x.receiveEvents.mock.calls[0]![0].events;
    expect(event).toEqual({
      kind: 'checks-red', key: `checks-red:${pr.id}:${'a'.repeat(40)}`,
      text: `Checks failed on proposal #${pr.number} "Booking page" by Theo: ci/checks.`, at: expect.any(String), href: `/decisions/pr/${pr.id}`,
    });
    // The same red sha again the same day: nothing. A new push that goes red: a new cause.
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(0);
    await x.prs.update(pr.id, { headSha: 'c'.repeat(40) });
    await x.red('c'.repeat(40));
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(1);
  });

  it('a proposal waiting past the person\'s threshold comes back once a day, a draft never', async () => {
    const x = await world();
    await x.turnOn({ thresholds: { ...DEFAULT_WORKSPACE_AGENT_PROACTIVE.thresholds, proposalHours: 24 } });
    await x.proposal({ readyHoursAgo: 23 });
    await x.proposal({ readyHoursAgo: 50, draft: true, sha: 'd'.repeat(40) });
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(0);
    x.clock.now = new Date(x.clock.now.getTime() + 2 * HOUR);
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(1);
    expect(x.receiveEvents.mock.calls[0]![0].events[0]!.text).toMatch(/^Proposal #\d+ "Booking page" by Theo has waited 25 hours for your decision\.$/);
    x.clock.now = new Date(x.clock.now.getTime() + 3 * HOUR);
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(0);
    x.clock.now = new Date(x.clock.now.getTime() + 24 * HOUR);
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(1);
    expect(x.receiveEvents.mock.calls[1]![0].events[0]!.text).toContain('has waited 2 days');
  });

  it('a note the person wrote that nobody picked up, once, named by no room — not an agent\'s report, not one handed over', async () => {
    const x = await world();
    await x.turnOn();
    const asked = await x.note({ hoursAgo: 50 });
    await x.note({ hoursAgo: 50, by: 'a1', html: '<p>Theo\'s report</p>' });
    await x.note({ hoursAgo: 10, html: '<p>Too new</p>' });
    const given = await x.note({ hoursAgo: 60, html: '<p>Handed</p>' });
    await x.notes.update(given.id, { handoff: { agentId: 'a1', agentName: 'Theo', userId: 'u1', handedAt: x.clock.now.toISOString(), expiresAt: new Date(x.clock.now.getTime() + HOUR).toISOString() } });
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(1);
    expect(x.receiveEvents.mock.calls[0]![0].events).toEqual([expect.objectContaining({
      kind: 'note-unclaimed', key: `note-unclaimed:${asked.id}`,
      text: `Note #${asked.number} "Make the booking page faster" has been unclaimed for 2 days.`,
      href: `/notes/${asked.number}?org=${x.org}`,
    })]);
    // Days later and still unclaimed: it was said once. (The other two have
    // come due by then — the new one aged, the hand-over lapsed.)
    x.clock.now = new Date(x.clock.now.getTime() + 72 * HOUR);
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(2);
    expect(x.receiveEvents.mock.calls[1]![0].events.map((e) => e.key)).not.toContain(`note-unclaimed:${asked.id}`);
  });

  it('a note is read once, from the workplace — a proposal recorded at an old room\'s namespace (note #843) still counts', async () => {
    const x = await world({ formerNamespaces: ['booking-ns', 'growth-ns'] });
    await x.turnOn({ thresholds: { ...DEFAULT_WORKSPACE_AGENT_PROACTIVE.thresholds, proposalHours: 24 } });
    const asked = await x.note({ hoursAgo: 50 });
    // Recorded at the old Booking room's namespace before the merge, and
    // still standing there: the history the workplace keeps.
    const waiting = await x.proposal({ readyHoursAgo: 30, at: 'booking-ns' });
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(2);
    const events = x.receiveEvents.mock.calls[0]![0].events;
    expect(events.filter((event) => event.kind === 'note-unclaimed')).toEqual([expect.objectContaining({
      key: `note-unclaimed:${asked.id}`,
      text: `Note #${asked.number} "Make the booking page faster" has been unclaimed for 2 days.`,
      href: `/notes/${asked.number}?org=${x.org}`,
    })]);
    expect(events.filter((event) => event.kind === 'proposal-waiting').map((event) => event.text))
      .toEqual([`Proposal #${waiting.number} "Booking page" by Theo has waited 30 hours for your decision.`]);
  });

  it('a report the person never answered, a failed turn at once, an agent the Chief of Staff waited for in vain', async () => {
    const x = await world();
    await x.turnOn();
    x.rows.set('a1', { role: 'agent', text: 'Merged and live: the booking page loads in 1.2 s.', at: new Date(x.clock.now.getTime() - 30 * HOUR).toISOString(), seq: 9 });
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(1);
    expect(x.receiveEvents.mock.calls[0]![0].events[0]).toMatchObject({
      kind: 'report-unanswered', key: 'report-unanswered:a1:9',
      text: 'Theo reported "Merged and live: the booking page loads in 1.2 s." 30 hours ago, and you have not answered in its chat.',
    });
    // The person answered: nothing more.
    x.rows.set('a1', { role: 'owner', text: 'Thanks', at: x.clock.now.toISOString(), seq: 10 });
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(0);
    // A turn that failed is an event at once, without waiting a day.
    x.rows.set('a1', { role: 'agent', text: `${FAILED_TURN_PREFIX}\n\nCouldn't start your workspace.`, at: x.clock.now.toISOString(), seq: 11 });
    await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: { messages: [], receipts: [], pending: [], silent: [{ agentId: 'a1', name: 'Theo', at: x.clock.now.toISOString() }] } });
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(2);
    expect(x.receiveEvents.mock.calls[1]![0].events.map((e) => [e.kind, e.text])).toEqual([
      ['turn-failed', 'Theo\'s last turn failed: Couldn\'t start your workspace..'],
      ['no-reply', 'Theo finished without sending back the answer the Chief of Staff was waiting for.'],
    ]);
  });

  it('a wait whose turn was cut short is no "finished" either in the event it raises (note #734)', async () => {
    const x = await world();
    await x.turnOn();
    await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: { messages: [], receipts: [], pending: [], silent: [{ agentId: 'a1', name: 'Theo', at: x.clock.now.toISOString(), cut: true }] } });
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(1);
    expect(x.receiveEvents.mock.calls[0]![0].events.map((e) => [e.kind, e.text])).toEqual([
      ['no-reply', 'Theo stopped working without sending back the answer the Chief of Staff was waiting for; its turn may have been cut short.'],
    ]);
  });

  it('a report the agent also sent the Chief of Staff was read there, and is no event', async () => {
    const x = await world();
    await x.turnOn();
    const at = new Date(x.clock.now.getTime() - 30 * HOUR).toISOString();
    x.rows.set('a1', { role: 'agent', text: 'Done: #12 is live.', at, seq: 4 });
    await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: { messages: [{ id: 'm1', role: 'agent', name: 'Theo', text: 'Done: #12 is live.', at }], receipts: [], pending: [] } });
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(0);
  });

  it('inside quiet hours only red checks and failed turns pass; the rest — a letter included — waits for morning', async () => {
    const x = await world();
    await x.turnOn();
    x.clock.now = new Date('2026-10-11T18:30:00.000Z'); // 00:30 in UTC+6
    await x.note({ hoursAgo: 50 });
    await x.proposal();
    await x.red();
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(1);
    expect(x.handed()).toEqual([['checks-red']]);
    await x.sweep.mailArrived({ id: 'mail-1', address: 'adam@mail.test', subject: 'Invoice for October', receivedAt: x.clock.now.toISOString(), from: 'billing@vendor.test', fromName: 'Vendor' });
    expect(x.handed()).toEqual([['checks-red']]);
    x.clock.now = new Date('2026-10-12T02:05:00.000Z'); // 08:05
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(2);
    expect(x.handed()[1]).toEqual(['mail', 'note-unclaimed']);
    expect(x.receiveEvents.mock.calls[1]![0].events[0]).toMatchObject({ text: 'A letter arrived from Vendor <billing@vendor.test>: "Invoice for October".', href: '/mail/mail-1' });
  });

  it('a letter is handed over at once — unless an agent already wakes for the person\'s mail', async () => {
    const x = await world();
    await x.turnOn();
    x.setWake('a1');
    await x.sweep.mailArrived({ id: 'mail-1', address: 'adam@mail.test', subject: 'Hi', receivedAt: x.clock.now.toISOString(), from: 'a@b.test' });
    expect(x.receiveEvents).not.toHaveBeenCalled();
    x.setWake(null);
    await x.sweep.mailArrived({ id: 'mail-2', address: 'adam@mail.test', subject: 'Hi again', receivedAt: x.clock.now.toISOString(), from: 'a@b.test' }, { suspicious: true });
    expect(x.receiveEvents.mock.calls[0]![0].events).toEqual([expect.objectContaining({ kind: 'mail', key: 'mail:mail-2', text: 'A letter arrived from a@b.test: "Hi again" — the checks marked it suspicious.' })]);
    await x.sweep.mailArrived({ id: 'mail-3', address: 'stranger@mail.test', subject: 'x', receivedAt: x.clock.now.toISOString() });
    expect(x.receiveEvents).toHaveBeenCalledTimes(1);
  });

  it('everything new in one sweep is ONE turn, and the ledger forgets after a month', async () => {
    const x = await world();
    await x.turnOn();
    await x.note({ hoursAgo: 50 });
    await x.proposal({ readyHoursAgo: 30 });
    await x.red();
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(3);
    expect(x.receiveEvents).toHaveBeenCalledTimes(1);
    const ledger = (await x.orgStorage.getMembership(x.org, 'u1'))!.workspaceAgentEventLedger!;
    expect(Object.keys(ledger)).toHaveLength(3);
    const later = new Date(x.clock.now.getTime() + 31 * 24 * HOUR);
    expect(recordInLedger(ledger, [], later)).toEqual({});
    const event: WorkspaceAgentEvent = { kind: 'checks-red', key: 'k', text: 't', at: 'a' };
    expect(eventsDue([event, event], {}, resolveWorkspaceAgentProactive({ events: true }), x.clock.now)).toHaveLength(1);
  });

  it('a cause is said once: the same report or red sha never comes back the next day; a draft\'s red checks are its author\'s business', async () => {
    const x = await world();
    await x.turnOn();
    x.rows.set('a1', { role: 'agent', text: 'Merged and live.', at: new Date(x.clock.now.getTime() - 30 * HOUR).toISOString(), seq: 9 });
    await x.proposal({ draft: true, sha: 'd'.repeat(40) });
    await x.red('d'.repeat(40));
    await x.proposal({ sha: 'e'.repeat(40), title: 'Ready one' });
    await x.red('e'.repeat(40));
    expect(x.handed()).toEqual([]);
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(2);
    expect(x.handed()[0]).toEqual(['checks-red', 'report-unanswered']);
    x.clock.now = new Date(x.clock.now.getTime() + 26 * HOUR);
    await x.sweep.sweepMember('u1', x.org);
    expect(x.handed().slice(1).flat()).not.toContain('checks-red');
    expect(x.handed().slice(1).flat()).not.toContain('report-unanswered');
  });

  it('keeps every letter: one past a turn\'s cap waits for the next sweep', async () => {
    const x = await world();
    await x.turnOn();
    x.clock.now = new Date('2026-10-11T18:30:00.000Z'); // quiet
    for (let i = 1; i <= 10; i++) {
      await x.sweep.mailArrived({ id: `mail-${i}`, address: 'adam@mail.test', subject: `Letter ${i}`, receivedAt: x.clock.now.toISOString(), from: 'a@b.test' });
    }
    expect(x.receiveEvents).not.toHaveBeenCalled();
    x.clock.now = new Date('2026-10-12T02:05:00.000Z');
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(8);
    expect(await x.sweep.sweepMember('u1', x.org)).toBe(2);
    expect(x.receiveEvents.mock.calls.flatMap(([args]) => args.events.map((e) => e.key)).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `mail:mail-${i + 1}`).sort());
  });

  it('a nudge sweeps the person within a minute, once for a burst', async () => {
    vi.useFakeTimers();
    try {
      const x = await world();
      await x.turnOn();
      await x.note({ hoursAgo: 50 });
      const sweep = vi.spyOn(x.sweep, 'sweepMember');
      x.sweep.nudge('u1', x.org);
      x.sweep.nudge('u1', x.org);
      await vi.advanceTimersByTimeAsync(EVENT_NUDGE_DEBOUNCE_MS + 10);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(x.receiveEvents).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
