/**
 * The reader's own auto-merge switch (note #944), for the two places that
 * show it: the switch in the Workplace window and the yellow "Auto-merge on"
 * in the Chief of Staff's header (Adam, 1 Nov 2026).
 *
 * Read off the workspace state Home already holds (`org.autoMerge`), so
 * neither place makes a request of its own; a flip writes, then re-reads
 * that state, and both redraw from the one answer.
 */

import { useCallback } from 'react';
import { jsonBody } from '../api/client.js';
import { useSession } from '../session/useSession.js';
import { useWorkspace } from './useWorkspace.js';

export function useAutoMerge(): {
  /** Null while no workplace is open. Never touched reads as off. */
  autoMerge: { on: boolean; changedAt?: string } | null;
  set: (on: boolean) => Promise<void>;
} {
  const { api } = useSession();
  const { state, reload } = useWorkspace();
  const orgId = state?.org?.orgId ?? null;
  const set = useCallback(async (on: boolean) => {
    if (!orgId) throw new Error('No workplace is open.');
    await api.api('api/org/auto-approve', jsonBody({ on }, 'PUT'), { org: orgId });
    await reload();
  }, [api, orgId, reload]);
  return { autoMerge: orgId ? state?.org?.autoMerge ?? { on: false } : null, set };
}
