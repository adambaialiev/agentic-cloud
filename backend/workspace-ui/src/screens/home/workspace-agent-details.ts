/**
 * The read behind the overview's agent header and its cards (2026-10-10):
 * one read, so the two can never disagree about what the Workspace Agent
 * thinks with. Opened on what this tab last read of it (note #630) and
 * refreshed silently; it polls only while a request is running, as the
 * agent's old screen did — context is measured at the end of a turn, and
 * without the last read the screen would stay one turn behind. `paused`
 * holds the poll while a picker stands over the screen, and the read runs
 * again when it closes.
 */

import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceAgentDetailsAnswer } from '../../../../src/shared/workspace-recap.js';
import { useSession } from '../../session/useSession.js';
import { readOrSayWhy } from '../../ui/read.js';
import { heldWorkspaceAgent, holdWorkspaceAgent } from '../agent/agent-cache.js';

export interface WorkspaceAgentDetails {
  data: WorkspaceAgentDetailsAnswer | null;
  error: boolean;
  read: () => Promise<WorkspaceAgentDetailsAnswer | null>;
  resetAsked: boolean;
  setResetAsked: (asked: boolean) => void;
  setData: (update: (current: WorkspaceAgentDetailsAnswer | null) => WorkspaceAgentDetailsAnswer | null) => void;
}

export function useWorkspaceAgentDetails(orgId: string | null, paused: boolean): WorkspaceAgentDetails {
  const { api } = useSession();
  const [fresh, setFresh] = useState<WorkspaceAgentDetailsAnswer | null>(null);
  // The overview mounts before the state read says which workplace it is
  // in, so the held copy is often not knowable at the first render. Until
  // this visit's own read lands, what this tab last read stands in for it,
  // from the first frame the workplace is known — a second visit opens on
  // that (note #630) rather than on "Model & effort" for a read's length.
  const held = orgId ? heldWorkspaceAgent(orgId).details ?? null : null;
  const data = fresh ?? held;
  const setData = useCallback((update: (current: WorkspaceAgentDetailsAnswer | null) => WorkspaceAgentDetailsAnswer | null) => {
    setFresh((current) => update(current ?? held));
  }, [held]);
  const [error, setError] = useState(false);
  const [resetAsked, setResetAsked] = useState(false);
  const read = useCallback(async (): Promise<WorkspaceAgentDetailsAnswer | null> => {
    if (!orgId) return null;
    try {
      const next = await readOrSayWhy((init) => api.api<WorkspaceAgentDetailsAnswer>('api/recap/agent', init, { org: orgId }));
      holdWorkspaceAgent(orgId, { details: next });
      setFresh(next); setError(false);
      if (!next.agent.context) setResetAsked(false);
      return next;
    } catch { setError(true); return null; }
  }, [api, orgId]);
  useEffect(() => {
    if (paused) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const next = await read();
      if (alive && next?.agent.working) timer = setTimeout(() => { void poll(); }, 4_000);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [read, paused]);
  return { data, error, read, resetAsked, setResetAsked, setData };
}

