import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  WorkspaceAgentJobsAnswer,
  WorkspaceManagedJob,
  WorkspaceSettledJob,
} from '../../../../src/shared/workspace-api.js';
import { useSession } from '../../session/useSession.js';

export const MANAGED_JOB_POLL_MS = 5000;

const sameJobs = (a: WorkspaceManagedJob[], b: WorkspaceManagedJob[]): boolean =>
  a.length === b.length && a.every((job, index) => {
    const other = b[index];
    return job.id === other?.id && job.label === other.label && job.startedAt === other.startedAt;
  });

const sameSettled = (a: WorkspaceSettledJob[], b: WorkspaceSettledJob[]): boolean =>
  sameJobs(a, b) && a.every((job, index) => job.status === b[index]?.status && job.finishedAt === b[index]?.finishedAt);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The one live read shared by the chat's compact door and the full job list.
 * It asks once on entry, then keeps polling only while a turn could create a
 * job or a visible job still needs its terminal edge. Hidden tabs stop and
 * catch up once when shown again.
 */
export function useManagedJobs({ agentId, active, working }: {
  agentId: string;
  active: boolean;
  working: boolean;
}): {
  jobs: WorkspaceManagedJob[];
  /** The newest few outcomes (note #564) — the details page draws them; the
   *  chat's strip counts running work only and never reads this. */
  recent: WorkspaceSettledJob[];
  answered: boolean;
  failed: string;
  refresh: () => Promise<WorkspaceManagedJob[]>;
} {
  const { api } = useSession();
  const [jobs, setJobs] = useState<WorkspaceManagedJob[]>([]);
  const [recent, setRecent] = useState<WorkspaceSettledJob[]>([]);
  const [answered, setAnswered] = useState(false);
  const [failed, setFailed] = useState('');
  const jobsRef = useRef(jobs);
  const workingRef = useRef(working);
  const alive = useRef(true);
  const poll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    jobsRef.current = jobs;
    workingRef.current = working;
  });
  useEffect(() => () => {
    alive.current = false;
    clearTimeout(poll.current);
  }, []);

  const refresh = useCallback(async (): Promise<WorkspaceManagedJob[]> => {
    try {
      const answer = await api.api<WorkspaceAgentJobsAnswer>(
        `api/agents/${encodeURIComponent(agentId)}/jobs`,
      );
      if (!alive.current) return jobsRef.current;
      const next = answer.jobs ?? [];
      setJobs((held) => (sameJobs(held, next) ? held : next));
      const settled = answer.recent ?? [];
      setRecent((held) => (sameSettled(held, settled) ? held : settled));
      setAnswered(true);
      setFailed('');
      return next;
    } catch (error) {
      if (alive.current) {
        setAnswered(true);
        if (!jobsRef.current.length) setFailed(errorMessage(error));
      }
      return jobsRef.current;
    }
  }, [agentId, api]);

  useEffect(() => {
    clearTimeout(poll.current);
    if (!active) return;
    let cancelled = false;
    let reading = false;
    const tick = async () => {
      if (cancelled || document.hidden || reading) return;
      reading = true;
      const next = await refresh();
      reading = false;
      if (cancelled || !alive.current) return;
      if (workingRef.current || next.length) {
        poll.current = setTimeout(() => { void tick(); }, MANAGED_JOB_POLL_MS);
      }
    };
    const onVisibility = () => {
      clearTimeout(poll.current);
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(poll.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, agentId, refresh, working]);

  return { jobs, recent, answered, failed, refresh };
}
