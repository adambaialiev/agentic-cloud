import { describe, expect, it } from 'vitest';
import {
  copyConditions, copyHealth, copyRow, parseCopyPulse, releasesBehind, sortCopies,
  type CopyPulseRecord,
} from '../../shared/copy-pulse.js';
import { fixtureCopies, fixtureHistory, fixturePulse } from '../../shared/copy-pulse-fixtures.js';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const OFFERED = ['2026.11.01.1', '2026.11.03.0', '2026.11.05.0', '2026.11.06.0'];
const record = (over: Parameters<typeof fixturePulse>[0] = {}, seen = { first: '2026-10-20T06:00:00.000Z', last: '2026-11-07T06:00:00.000Z' }): CopyPulseRecord => ({
  copyId: over.copyId ?? 'fixture-acme-0001', firstSeenAt: seen.first, lastSeenAt: seen.last,
  pulse: { ...fixturePulse(over), receivedAt: seen.last },
});
const conditions = (r: CopyPulseRecord, offered: string[] | null = OFFERED) => copyConditions(r, offered, NOW).holding.map((a) => a.condition).sort();

describe('the pulse shape (note #1057)', () => {
  it('takes a pulse exactly as the contract writes it', () => {
    const parsed = parseCopyPulse(fixturePulse());
    expect(parsed).toEqual({ ok: true, pulse: fixturePulse() });
  });

  it('keeps only the contract\'s fields, so nothing a copy adds is stored', () => {
    const parsed = parseCopyPulse({ ...fixturePulse(), messages: ['secret'], health: { ...fixturePulse().health, logs: 'x' } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.pulse).not.toHaveProperty('messages');
    expect(parsed.pulse.health).toEqual({ backupAgeHours: 5, diskFreePercent: 64, state: 'ok' });
  });

  it.each([
    ['no copy id', { copyId: '' }, 'copyId'],
    ['a domain that is not one', { domain: 'not a domain' }, 'domain'],
    ['no contact email', { contactEmail: 'nobody' }, 'contactEmail'],
    ['a reason outside the three', { reason: 'weekly' }, 'reason'],
    ['a release that is not a version', { release: 'latest' }, 'release'],
    ['a pulse switch that is not a boolean', { pulseEnabled: 'yes' }, 'pulseEnabled'],
    ['a negative count', { people: -1 }, 'people'],
    ['counts that are not counts', { agentsByCli: { claude: 'six' } }, 'agentsByCli'],
    ['a disk over a hundred percent', { health: { backupAgeHours: 1, diskFreePercent: 140, state: 'ok' } }, 'diskFreePercent'],
  ])('refuses %s', (_name, over, field) => {
    const parsed = parseCopyPulse({ ...fixturePulse(), ...over });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(field);
  });

  it('reads a missing CLI as none and an unknown release as null', () => {
    const parsed = parseCopyPulse({ ...fixturePulse(), release: null, agentsByCli: { claude: 2 } });
    expect(parsed.ok && parsed.pulse.release).toBeNull();
    expect(parsed.ok && parsed.pulse.agentsByCli).toEqual({ claude: 2, codex: 0, opencode: 0 });
  });
});

describe('a copy\'s row', () => {
  it('counts releases behind against what we offer, and says so only when it can', () => {
    expect(releasesBehind('2026.11.06.0', OFFERED)).toBe(0);
    expect(releasesBehind('2026.11.03.0', OFFERED)).toBe(2);
    expect(releasesBehind('2026.11.03.0', null)).toBeNull();
    expect(releasesBehind(null, OFFERED)).toBeNull();
  });

  it('totals agents and turns across the CLIs, and stands live while heard from', () => {
    const row = copyRow(record(), OFFERED, NOW);
    expect(row).toMatchObject({ agents: 8, turns24h: 171, standing: 'live', releasesBehind: 0, health: { state: 'ok', problems: [] } });
  });

  it('is silent after three days and opted out when its admin turned the pulse off', () => {
    expect(copyRow(record({}, { first: '2026-10-01T00:00:00Z', last: '2026-11-04T11:00:00.000Z' }), OFFERED, NOW).standing).toBe('silent');
    expect(copyRow(record({ pulseEnabled: false }, { first: '2026-10-01T00:00:00Z', last: '2026-11-01T00:00:00.000Z' }), OFFERED, NOW).standing).toBe('opted-out');
  });

  it('names what is wrong with its health', () => {
    expect(copyHealth({ health: { backupAgeHours: 72, diskFreePercent: 6, state: 'ok' } })).toEqual({
      state: 'trouble', problems: ['backup 3 days old', 'disk 6% free'], backupAgeHours: 72, diskFreePercent: 6,
    });
    expect(copyHealth({ health: { backupAgeHours: null, diskFreePercent: null, state: 'unknown' } }).state).toBe('unknown');
    expect(copyHealth({ health: { backupAgeHours: 1, diskFreePercent: 50, state: 'degraded' } }).problems).toEqual(['says degraded']);
  });

  it('sorts the copy heard from most recently first', () => {
    const rows = fixtureCopies(NOW).map(({ pulse, receivedAt }) => copyRow({ copyId: pulse.copyId, firstSeenAt: receivedAt[0]!, lastSeenAt: receivedAt.at(-1)!, pulse: { ...pulse, receivedAt: receivedAt.at(-1)! } }, OFFERED, NOW));
    expect(sortCopies(rows).map((row) => row.copyId)).toEqual(['fixture-acme-0001', 'fixture-northwind-02', 'fixture-initech-04', 'fixture-globex-03']);
  });

  it('draws its history from fixtures with a shape, ending on the newest pulse', () => {
    const history = fixtureHistory(fixturePulse(), ['2026-11-05T06:00:00.000Z', '2026-11-06T06:00:00.000Z', '2026-11-07T06:00:00.000Z']);
    expect(history.at(-1)!.pulse.turnsLast24hByCli).toEqual(fixturePulse().turnsLast24hByCli);
    expect(new Set(history.map((day) => day.pulse.turnsLast24hByCli.claude)).size).toBe(3);
  });
});

describe('the alert conditions (note #1058)', () => {
  it('says nothing about a copy that is well, current, and not new', () => {
    expect(conditions(record())).toEqual([]);
  });

  it('a new copy\'s first pulse, for three days', () => {
    const fresh = record({}, { first: '2026-11-07T06:00:00.000Z', last: '2026-11-07T06:00:00.000Z' });
    expect(conditions(fresh)).toEqual(['first-pulse']);
    expect(copyConditions(fresh, OFFERED, NOW).holding[0]!.text).toBe(
      'A new private copy sent its first pulse: agents.acme.example, run by Dana Field <dana@acme.example>, release 2026.11.06.0, 12 people, 8 agents.',
    );
    expect(conditions(record({}, { first: '2026-11-03T06:00:00.000Z', last: '2026-11-07T06:00:00.000Z' }))).toEqual([]);
  });

  it('a copy silent for three days, not before', () => {
    expect(conditions(record({}, { first: '2026-10-01T00:00:00Z', last: '2026-11-04T13:00:00.000Z' }))).toEqual([]);
    const silent = record({}, { first: '2026-10-01T00:00:00Z', last: '2026-11-04T12:00:00.000Z' });
    expect(conditions(silent)).toEqual(['silent']);
    expect(copyConditions(silent, OFFERED, NOW).holding[0]!.text).toContain('silent for 3 days');
  });

  it('two releases behind, not one, and unknown with no release list', () => {
    expect(conditions(record({ release: '2026.11.05.0' }))).toEqual([]);
    expect(conditions(record({ release: '2026.11.03.0' }))).toEqual(['behind']);
    expect(copyConditions(record({ release: '2026.11.03.0' }), OFFERED, NOW).holding[0]!.text).toBe(
      'The private copy at agents.acme.example runs 2026.11.03.0, 2 releases behind the latest 2026.11.06.0. Contact: Dana Field <dana@acme.example>.',
    );
    expect(copyConditions(record({ release: '2026.11.03.0' }), null, NOW)).toEqual({ holding: [], unknown: ['behind'] });
  });

  it('a backup older than two days, a disk under ten percent', () => {
    expect(conditions(record({ health: { backupAgeHours: 48, diskFreePercent: 10, state: 'ok' } }))).toEqual([]);
    expect(conditions(record({ health: { backupAgeHours: 49, diskFreePercent: 9, state: 'ok' } }))).toEqual(['backup', 'disk']);
  });

  it('a copy that opted out, and never "silent" for it', () => {
    const out = record({ pulseEnabled: false }, { first: '2026-10-01T00:00:00Z', last: '2026-11-01T00:00:00.000Z' });
    expect(conditions(out)).toEqual(['opted-out']);
  });
});
