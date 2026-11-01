import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceAgentScheduleAnswer, WorkspaceScheduleDecision, WorkspaceScheduleView } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { relative } from '../../ui/time.js';
import { scheduleLines } from './schedule-words.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The schedule on an agent's screen (note #779): what a room agent
 * proposed, as its owner reads it — cadence, window, next tick, today's
 * turns against the cap, skipped and failed — and the owner's own hands on
 * it: approve or reject a proposal, pause and resume an approved one,
 * remove it. Absent when the agent has no schedule.
 */
export function ScheduleCard({ agentId, now }: { agentId: string; now: number }) {
  const { api } = useSession();
  const banner = useBanner();
  const [schedule, setSchedule] = useState<WorkspaceScheduleView | null | undefined>(undefined);
  const [busy, setBusy] = useState<WorkspaceScheduleDecision | null>(null);

  const read = useCallback(async () => {
    try {
      const answer = await api.api<WorkspaceAgentScheduleAnswer>(`api/agents/${encodeURIComponent(agentId)}/schedule`);
      setSchedule(answer.schedule);
    } catch {
      /* no schedule section beats a wrong one */
    }
  }, [api, agentId]);

  useEffect(() => {
    void read();
    const timer = setInterval(() => { void read(); }, 30_000);
    return () => clearInterval(timer);
  }, [read]);

  const decide = async (decision: WorkspaceScheduleDecision) => {
    setBusy(decision);
    try {
      const answer = await api.api<WorkspaceAgentScheduleAnswer>(
        `api/agents/${encodeURIComponent(agentId)}/schedule/decision`, jsonBody({ decision }),
      );
      setSchedule(answer.schedule);
      banner.show(decision === 'approve' ? 'Schedule approved.' : decision === 'reject' ? 'Schedule rejected.' : decision === 'pause' ? 'Schedule paused.' : decision === 'resume' ? 'Schedule resumed.' : 'Schedule removed.', true);
    } catch (error) {
      banner.show(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  if (!schedule) return null;
  const lines = scheduleLines(schedule, now);
  const proposed = schedule.status === 'proposed';
  const paused = schedule.status === 'paused';
  return (
    <div className="card" id="agentSchedule" data-status={schedule.status}>
      <div className="drow">
        <div className="k">Schedule</div>
        <div className="v" id="agentScheduleState">{lines.state}</div>
        <div className="v dim">{schedule.summary}</div>
      </div>
      <div className="drow">
        <div className="k">Each tick says</div>
        <div className="v">{schedule.message}</div>
        <div className="v dim">{`Proposed by ${schedule.proposedBy.name} ${relative(schedule.createdAt, now)}`}</div>
      </div>
      {!proposed
        ? (
          <div className="drow">
            <div className="k">Today</div>
            <div className="v" id="agentScheduleToday">{lines.today}</div>
            {lines.next ? <div className="v dim" id="agentScheduleNext">{lines.next}</div> : null}
          </div>
        )
        : null}
      {schedule.pause?.detail ? <div className="hintblock" id="agentScheduleWhy">{schedule.pause.detail}</div> : null}
      <div className="danger-actions" id="agentScheduleActions">
        {proposed
          ? (
            <>
              <button className="btn primary bare" type="button" disabled={busy !== null} onClick={() => { void decide('approve'); }}>{busy === 'approve' ? 'Approving…' : 'Approve'}</button>
              <button className="btn ghost bare" type="button" disabled={busy !== null} onClick={() => { void decide('reject'); }}>Reject</button>
            </>
          )
          : (
            <>
              {paused
                ? <button className="btn primary bare" type="button" disabled={busy !== null} onClick={() => { void decide('resume'); }}>{busy === 'resume' ? 'Resuming…' : 'Resume'}</button>
                : <button className="btn ghost bare" type="button" disabled={busy !== null} onClick={() => { void decide('pause'); }}>{busy === 'pause' ? 'Pausing…' : 'Pause'}</button>}
              <button className="btn danger bare" type="button" disabled={busy !== null} onClick={() => { void decide('remove'); }}>Remove</button>
            </>
          )}
      </div>
      <div className="hintblock" id="agentScheduleHint">{lines.cost}</div>
    </div>
  );
}
