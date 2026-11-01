import { describe, expect, it } from 'vitest';
import { scheduleLines } from './schedule-words.js';
import type { WorkspaceScheduleView } from '../../../../src/shared/workspace-api.js';

const now = Date.parse('2026-10-19T15:00:00Z');
const base: WorkspaceScheduleView = {
  id: 'sch_1', agentId: 'producer', agentName: 'Producer', status: 'active', message: 'Take the next beat.',
  everyMinutes: 8, windowFrom: '07:00', windowTo: '23:00', timeZone: 'America/Los_Angeles', capTurns: 120,
  summary: 'every 8 minutes, 07:00–23:00 America/Los_Angeles, at most 120 turns a day',
  day: { date: '2026-10-19', turns: 37, tokens: 0, skipped: 2, failed: 1, resets: 0 }, failStreak: 0,
  nextTickAt: '2026-10-19T15:05:00Z', ticking: false, awake: true, proposedBy: { agentId: 'producer', name: 'Producer' }, createdAt: '2026-10-19T14:00:00Z',
};

describe('the schedule card words (note #779)', () => {
  it('reads an active schedule: count against the cap, the next tick, the cost', () => {
    const lines = scheduleLines(base, now);
    expect(lines.state).toBe('Active');
    expect(lines.today).toBe('37 of 120 turns · 2 skipped · 1 failed');
    expect(lines.next).toBe('Next tick in 5m');
    expect(lines.cost).toContain("keeps Producer's machine awake");
  });
  it('says a tick is imminent, a turn is running, and the window is closed', () => {
    expect(scheduleLines({ ...base, nextTickAt: '2026-10-19T14:59:50Z' }, now).next).toBe('Next tick any moment');
    expect(scheduleLines({ ...base, ticking: true }, now).state).toBe('Running a scheduled turn');
    expect(scheduleLines({ ...base, awake: false }, now).state).toBe('Active, outside its window');
  });
  it('reads a cap pause and a proposal', () => {
    const paused = scheduleLines({ ...base, status: 'paused', nextTickAt: undefined, pause: { reason: 'cap', at: '2026-10-19T15:00:00Z', until: '2026-10-20T07:00:00Z', text: 'paused: daily cap reached, resumes at midnight' } }, now);
    expect(paused.state).toBe('Paused — daily cap reached, resumes at midnight');
    expect(paused.next).toBe('Resumes in 16h');
    const proposed = scheduleLines({ ...base, status: 'proposed', awake: false }, now);
    expect(proposed.state).toBe('Awaiting your approval');
    expect(proposed.cost).toContain('a turn every 8 minutes');
  });
});
