/**
 * Making another workplace the active one, from wherever the reader asked:
 * the picker screen (`/workplaces`) and Home's switch menu (note #609) both
 * land on Home in the new workplace. Arriving there is the confirmation, so a
 * switch that worked says nothing (note #616); only a failure is told.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceOrgActivateAnswer, WorkspaceOrganizationRow } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage } from '../../ui/format.js';
import { useSeats } from '../../workspace/useSeats.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';

export function useActivateOrganization(): {
  switching: string | null;
  activate: (organization: WorkspaceOrganizationRow) => Promise<boolean>;
} {
  const { api } = useSession();
  const { switchWorkplace } = useWorkspace();
  const seats = useSeats();
  const banner = useBanner();
  const navigate = useNavigate();
  const [switching, setSwitching] = useState<string | null>(null);

  const activate = async (organization: WorkspaceOrganizationRow): Promise<boolean> => {
    setSwitching(organization.orgId);
    try {
      // Asked AS the target workplace, not as the one this tab stands in:
      // a membership just removed elsewhere would otherwise refuse the
      // switch away from it (note #628).
      const answer = await api.api<WorkspaceOrgActivateAnswer>('api/org/active', jsonBody({ orgId: organization.orgId }), { org: organization.orgId });
      // The whole Workspace follows. Its last good copy is restored before
      // Home mounts; current truth is fetched silently underneath it.
      seats.invalidate();
      const refresh = switchWorkplace(answer.orgId);
      navigate('/', { replace: true });
      await refresh;
      setSwitching(null);
      return true;
    } catch (error) {
      banner.show(errorMessage(error));
      setSwitching(null);
      return false;
    }
  };

  return { switching, activate };
}
