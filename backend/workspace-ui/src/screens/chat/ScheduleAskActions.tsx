import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceAgentScheduleAnswer, WorkspaceScheduleView } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage } from '../../ui/format.js';

const POLL_MS = 5000;

/**
 * Approve and Reject on the schedule ask card in the agent's chat (note
 * #779; the owner, 20 Oct 2026: "approve and reject buttons should be also
 * in the card in chat screen"). One schedule per agent, so the card follows
 * the agent's current schedule: the two answers stand while it is still
 * proposed, then the card says what was decided. The screen's own card
 * keeps pause, resume and remove.
 */
export function ScheduleAskActions({ agentId }: { agentId: string }) {
  const { api } = useSession();
  const [schedule, setSchedule] = useState<WorkspaceScheduleView | null | undefined>(undefined);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [said, setSaid] = useState('');

  const read = useCallback(async () => {
    const answer = await api.api<WorkspaceAgentScheduleAnswer>(`api/agents/${encodeURIComponent(agentId)}/schedule`);
    setSchedule(answer.schedule);
  }, [api, agentId]);

  useEffect(() => { void read().catch(() => setSchedule(null)); }, [read]);

  // Decided on the agent's screen, or in another tab: the card follows.
  useEffect(() => {
    if (schedule?.status !== 'proposed') return;
    const timer = window.setInterval(() => { void read().catch(() => {}); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [schedule?.status, read]);

  const decide = async (decision: 'approve' | 'reject') => {
    if (busy || schedule?.status !== 'proposed') return;
    setBusy(decision); setSaid('');
    try {
      const answer = await api.api<WorkspaceAgentScheduleAnswer>(
        `api/agents/${encodeURIComponent(agentId)}/schedule/decision`, jsonBody({ decision }),
      );
      setSchedule(answer.schedule ?? { ...schedule, status: 'rejected' });
    } catch (error) {
      setSaid(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  if (schedule === undefined) return null;
  if (schedule?.status === 'proposed') {
    return (
      <div className="scheduleaskactions">
        <button className="btn primary bare" type="button" disabled={busy !== null} onClick={() => { void decide('approve'); }}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button className="btn danger bare" type="button" disabled={busy !== null} onClick={() => { void decide('reject'); }}>
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        {said ? <div className="scheduleaskerror">{said}</div> : null}
      </div>
    );
  }
  const word = !schedule || schedule.status === 'rejected' ? 'Rejected' : schedule.status === 'active' ? 'Approved' : `Approved, now ${schedule.pause?.text ?? schedule.status}`;
  return <div className="scheduleaskanswer">{word}</div>;
}
