import { describe, expect, it } from 'vitest';
import { InMemoryAgentTokenLedger } from '../../services/agent-token-ledger.js';
import { agentUsageReport, usageWeeksRequested } from '../../services/agent-usage-report.js';
import type { OrgSeatDocument } from '../../types/org.js';

/**
 * `agentbuilt usage` (note #719): the projection the route answers with.
 * The one property that matters most is the one a reader cannot see in the
 * output — that a seat's credential never rides along — so it is asserted
 * on the serialized answer, not on a field.
 */

const NOW = Date.parse('2026-10-11T09:00:00Z');

function seat(overrides: Partial<OrgSeatDocument> = {}): OrgSeatDocument {
  return {
    seatId: 'seat-1', orgId: 'org-1', userId: 'dana', provider: 'claude', token: 'sk-ant-oat01-SECRET',
    label: 'my Max account', status: 'active', selected: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-11T08:50:00Z',
    usageRefreshedAt: '2026-10-11T08:57:00Z',
    usage: {
      capturedAt: '2026-10-11T08:57:00Z',
      planType: 'max_20x',
      windows: {
        five_hour: { id: 'five_hour', usedPercent: 12, windowDurationMins: 300, resetsAt: 1_791_727_200 },
        seven_day: { id: 'seven_day', usedPercent: 61.4, windowDurationMins: 10_080, resetsAt: 1_791_968_400 },
        overage: { id: 'overage', usedPercent: 15 },
      },
      spend: { usedMinor: 1200, limitMinor: 8000, currency: 'USD', exponent: 2 },
    },
    modelWindows: { seven_day_fable: { id: 'seven_day_fable', usedPercent: 80, windowDurationMins: 10_080, resetsAt: 1_791_968_400 } },
    ...overrides,
  };
}

function world() {
  const ledger = new InMemoryAgentTokenLedger();
  const base = { userId: 'dana', orgId: 'org-1', provider: 'claude' as const, model: 'claude-opus-5-5', input: 100, cacheRead: 1000, cacheWrite: 50, reasoning: 0 };
  ledger.credit({ ...base, agentId: 'a1', agentName: 'Alex', day: '2026-10-09', output: 4000 });
  ledger.credit({ ...base, agentId: 'a2', agentName: 'Theo', day: '2026-10-10', output: 900 });
  ledger.credit({ ...base, agentId: 'a3', agentName: 'Nora', orgId: 'org-2', day: '2026-10-10', output: 300 });
  ledger.credit({ ...base, agentId: 'a4', agentName: 'Gus', provider: 'codex', model: 'gpt-6-sol', day: '2026-10-11', output: 70, cacheWrite: 0, reasoning: 9 });
  ledger.credit({ ...base, agentId: 'a1', agentName: 'Alex', day: '2026-08-01', output: 123_456 });
  ledger.credit({ ...base, userId: 'sam', agentId: 'z1', agentName: 'Zed', day: '2026-10-10', output: 999 });
  return ledger;
}

describe('agentUsageReport', () => {
  it('splits the weeks by provider, model and agent, naming live agents by name and the rest by what happened to them', () => {
    const answer = agentUsageReport({
      ledger: world(), userId: 'dana', orgId: 'org-1',
      seatsHere: [], seatsAll: [],
      agents: { a1: { name: 'Alex', orgId: 'org-1' }, a3: { name: 'Nora', orgId: 'org-2' }, a4: { name: 'Gus', orgId: 'org-1' } },
      weeks: 4, now: NOW,
    });
    expect(answer.since).toBe('2026-09-14');
    expect(answer.weeks.map((week) => week.start)).toEqual(['2026-10-05']);
    const [week] = answer.weeks;
    expect(week!.providers.map((p) => [p.provider, p.output])).toEqual([['claude', 5200], ['codex', 70]]);
    expect(week!.providers[0]!.models[0]!.agents).toEqual([
      { agentId: 'a1', name: 'Alex', input: 100, output: 4000, cacheRead: 1000, cacheWrite: 50, reasoning: 0 },
      { agentId: 'a2', name: 'Theo', deleted: true, input: 100, output: 900, cacheRead: 1000, cacheWrite: 50, reasoning: 0 },
      { agentId: 'a3', name: 'Nora', elsewhere: true, input: 100, output: 300, cacheRead: 1000, cacheWrite: 50, reasoning: 0 },
    ]);
    expect(week!.providers[1]!.models[0]!.agents[0]).toMatchObject({ name: 'Gus', reasoning: 9 });
    // Sam's agent is not Dana's answer, and the August row is past the reach.
    expect(JSON.stringify(answer)).not.toContain('Zed');
    expect(JSON.stringify(answer)).not.toContain('123456');
  });

  it('describes each plan with its windows, resets and spend cap, and never the credential', () => {
    const elsewhere = seat({ seatId: 'seat-2', orgId: 'org-2', provider: 'codex', label: 'work ChatGPT', usage: undefined, usageRefreshedAt: undefined, token: 'eyJhbGciOi-ALSO-SECRET' });
    const answer = agentUsageReport({
      ledger: undefined, userId: 'dana', orgId: 'org-1',
      seatsHere: [seat()], seatsAll: [seat({ selected: false }), elsewhere],
      agents: {}, weeks: 4, now: NOW,
    });
    expect(answer.weeks).toEqual([]);
    expect(answer.plans).toEqual([
      {
        provider: 'claude', label: 'my Max account', planText: 'Max 20x', status: 'active', inThisWorkplace: true, primary: true,
        usageRefreshedAt: '2026-10-11T08:57:00Z',
        windows: [
          { label: '5 hours', usedPercent: 12, percentText: '12', resetAt: '2026-10-11T14:00:00.000Z', resetsText: 'Oct 11, 14:00 UTC' },
          { label: '7 days · other models', usedPercent: 61.4, percentText: '61.4', resetAt: '2026-10-14T09:00:00.000Z', resetsText: 'Oct 14, 09:00 UTC' },
          { label: '7 days · Fable', usedPercent: 80, percentText: '80', resetAt: '2026-10-14T09:00:00.000Z', resetsText: 'Oct 14, 09:00 UTC' },
          { label: 'Extra usage', usedPercent: 15, percentText: '15', spend: true, detailText: '$12.00 of $80.00' },
        ],
      },
      {
        provider: 'codex', label: 'work ChatGPT', status: 'active', inThisWorkplace: false, primary: false, windows: [],
        usageNotice: 'Usage appears after this subscription completes its first message.',
      },
    ]);
    const wire = JSON.stringify(answer);
    expect(wire).not.toContain('SECRET');
    expect(wire).not.toContain('seatId');
    expect(wire).not.toContain('token');
  });

  it('reads --weeks as a whole number from 1 to the screen\'s eight, four unasked', () => {
    expect(usageWeeksRequested(undefined)).toBe(4);
    expect(usageWeeksRequested('abc')).toBe(4);
    expect(usageWeeksRequested('0')).toBe(1);
    expect(usageWeeksRequested('2')).toBe(2);
    expect(usageWeeksRequested('80')).toBe(8);
  });
});
