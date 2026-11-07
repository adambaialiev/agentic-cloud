import type { CopyPulse } from './copy-pulse.js';

/**
 * Fixture pulses in the exact shape of note #1057, so the Copies screen
 * (note #1058) can be built, tested and looked at before the first real copy
 * sends one. Used by the tests on both sides of the glass and by
 * scripts/copy-pulse-fixtures.mjs's live look. Every fixture copy's id
 * starts `fixture-` and its domain ends `.example`, so none can be taken
 * for a real one.
 */
export function fixturePulse(over: Partial<CopyPulse> = {}): CopyPulse {
  return {
    copyId: 'fixture-acme-0001',
    domain: 'agents.acme.example',
    contactName: 'Dana Field',
    contactEmail: 'dana@acme.example',
    sentAt: '2026-11-07T06:00:00.000Z',
    reason: 'daily',
    release: '2026.11.06.0',
    updatesState: 'current',
    pulseEnabled: true,
    people: 12,
    agentsByCli: { claude: 6, codex: 2, opencode: 0 },
    turnsLast24hByCli: { claude: 140, codex: 31, opencode: 0 },
    machineHours24h: 41.5,
    sitesLive: 3,
    lastActivityAt: '2026-11-07T05:40:00.000Z',
    health: { backupAgeHours: 5, diskFreePercent: 64, state: 'ok' },
    ...over,
  };
}

/** A copy's days, oldest first: its newest pulse, with turns that rise and
 *  fall from day to day (a steady wave, so a chart has a shape), each sent
 *  and received a day apart. */
export function fixtureHistory(newest: CopyPulse, receivedAt: string[]): Array<{ pulse: CopyPulse; receivedAt: string }> {
  return receivedAt.map((at, i) => {
    const last = i === receivedAt.length - 1;
    const scale = last ? 1 : 0.55 + 0.45 * Math.abs(Math.sin((i + 1) * 0.9));
    const turns = Object.fromEntries(Object.entries(newest.turnsLast24hByCli).map(([cli, n]) => [cli, Math.round(n * scale)])) as CopyPulse['turnsLast24hByCli'];
    return { pulse: { ...newest, sentAt: at, turnsLast24hByCli: turns, ...(last ? {} : { pulseEnabled: true }) }, receivedAt: at };
  });
}

/** Four copies, one of each kind the screen draws: live and well, behind with
 *  disk trouble, silent, and opted out. Times are relative to `now`. */
export function fixtureCopies(now: Date): Array<{ pulse: CopyPulse; receivedAt: string[] }> {
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
  const daily = (hoursAgo: number, days: number) => Array.from({ length: days }, (_, i) => at(hoursAgo + (days - 1 - i) * 24));
  return [
    { pulse: fixturePulse({ sentAt: at(2), lastActivityAt: at(2.5) }), receivedAt: daily(2, 21) },
    {
      pulse: fixturePulse({
        copyId: 'fixture-northwind-02', domain: 'cloud.northwind.example', contactName: 'Ravi Patel', contactEmail: 'ravi@northwind.example',
        sentAt: at(9), release: '2026.11.01.1', updatesState: 'behind', people: 4,
        agentsByCli: { claude: 2, codex: 1, opencode: 1 }, turnsLast24hByCli: { claude: 22, codex: 4, opencode: 9 },
        machineHours24h: 11, sitesLive: 1, lastActivityAt: at(10), health: { backupAgeHours: 7, diskFreePercent: 6, state: 'ok' },
      }),
      receivedAt: daily(9, 9),
    },
    {
      pulse: fixturePulse({
        copyId: 'fixture-globex-03', domain: 'ai.globex.example', contactName: 'Mei Chen', contactEmail: 'mei@globex.example',
        sentAt: at(100), people: 30, agentsByCli: { claude: 14, codex: 6, opencode: 0 }, turnsLast24hByCli: { claude: 402, codex: 77, opencode: 0 },
        machineHours24h: 96, sitesLive: 8, lastActivityAt: at(101), health: { backupAgeHours: 60, diskFreePercent: 40, state: 'ok' },
      }),
      receivedAt: daily(100, 30),
    },
    {
      pulse: fixturePulse({
        copyId: 'fixture-initech-04', domain: 'agents.initech.example', contactName: 'Sam Ortiz', contactEmail: 'it@initech.example',
        sentAt: at(30), pulseEnabled: false, people: 2, agentsByCli: { claude: 1, codex: 0, opencode: 0 }, turnsLast24hByCli: { claude: 3, codex: 0, opencode: 0 },
        machineHours24h: 1.5, sitesLive: 0, lastActivityAt: at(40),
      }),
      receivedAt: daily(30, 5),
    },
  ];
}
