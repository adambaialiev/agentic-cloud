import type { WorkspaceScheduleView } from '../../../../src/shared/workspace-api.js';
import { countdown } from '../../ui/time.js';

/** The words the schedule card reads (note #779), kept pure so they are tested without a screen. */
export function scheduleLines(schedule: WorkspaceScheduleView, now: number): { state: string; today: string; next: string; cost: string } {
  const state = schedule.status === 'proposed'
    ? 'Awaiting your approval'
    : schedule.status === 'active'
      ? (schedule.ticking ? 'Running a scheduled turn' : schedule.awake ? 'Active' : 'Active, outside its window')
      : schedule.status === 'paused'
        ? `Paused${schedule.pause ? ` — ${schedule.pause.text.replace(/^paused(?:: | )?/, '')}` : ''}`
        : 'Rejected';
  const day = schedule.day;
  const turns = schedule.capTurns !== undefined ? `${day.turns} of ${schedule.capTurns} turns` : `${day.turns} turn${day.turns === 1 ? '' : 's'}`;
  const tokens = schedule.capTokens !== undefined ? `, ${day.tokens.toLocaleString('en-US')} of ${schedule.capTokens.toLocaleString('en-US')} tokens` : '';
  const extras = [`${day.skipped} skipped`, `${day.failed} failed`, ...(day.resets ? [`${day.resets} reset${day.resets === 1 ? '' : 's'}`] : [])];
  const today = `${turns}${tokens} · ${extras.join(' · ')}`;
  const next = schedule.status === 'active' && schedule.nextTickAt
    ? `Next tick ${countdown(schedule.nextTickAt, now) || 'any moment'}`
    : schedule.status === 'paused' && schedule.pause?.until
      ? `Resumes ${countdown(schedule.pause.until, now) || 'any moment'}`
      : '';
  const cost = schedule.status === 'active'
    ? `While it is active, ${schedule.windowFrom}–${schedule.windowTo} ${schedule.timeZone}, this schedule keeps ${schedule.agentName}'s machine awake: every tick is a turn on your subscription. A tick that lands while ${schedule.agentName} is working is skipped, never queued.`
    : schedule.status === 'proposed'
      ? `Approving spends your subscription while nobody is watching: a turn ${schedule.summary.split(',')[0]}, and ${schedule.agentName}'s machine stays awake for the whole window.`
      : `Nothing ticks while it is ${schedule.status}. ${schedule.agentName} still answers you as usual.`;
  return { state, today, next, cost };
}
