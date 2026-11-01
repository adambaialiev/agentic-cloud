/**
 * The lock screen of a workplace an admin asked to delete (owner,
 * 2026-09-22). While the deletion stands it replaces the whole Workspace for
 * every member, the way the setup gate does: who asked, when it goes for
 * good, and that its agents are stopped. An admin can keep it from here —
 * one tap, because keeping loses nothing — and everyone has a way out to
 * their other workplaces, or to a new one, so the lock is never a dead end.
 *
 * Account places (settings, mail, the workplace picker, an invite) stay
 * reachable behind it; `RequiredSetup` lets those through.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceOrgDeletion } from '../../../src/shared/workspace-api.js';
import { useBanner } from '../chrome/useBanner.js';
import { useSession } from '../session/useSession.js';
import { absolute, errorMessage } from '../ui/format.js';
import { useWorkspace } from '../workspace/useWorkspace.js';
import { SetupHead } from './SetupHead.js';

export function WorkplaceDeleting({ orgId, name, deletion }: {
  orgId: string;
  name: string;
  deletion: WorkspaceOrgDeletion;
}) {
  const { api } = useSession();
  const { state, reload } = useWorkspace();
  const banner = useBanner();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const elsewhere = (state?.organizations ?? []).some((organization) => organization.orgId !== orgId);

  const keep = async () => {
    setBusy(true);
    try {
      await api.api('api/org/deletion', { method: 'DELETE' }, { org: orgId });
      banner.show(`${name} will not be deleted.`, true);
      await reload();
    } catch (err) {
      banner.show(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div id="workplaceDeleting" className="requiredsetup">
      <SetupHead />
      <div className="authhero">
        <h1>{name} is being deleted</h1>
        <p>
          {deletion.requestedByName} asked to delete it on {absolute(deletion.requestedAt)}.
          {' '}{Date.parse(deletion.purgeAt) > Date.now()
            ? `It will be deleted for good on ${absolute(deletion.purgeAt)}.`
            : 'Its three days are up, and it is being deleted now.'}
        </p>
      </div>
      <div className="card authpanel" id="workplaceDeletingWhat">
        Its agents are stopped and nothing new can start here. Everyone in it has been emailed.
        {Date.parse(deletion.purgeAt) <= Date.now()
          ? ''
          : deletion.canKeep ? ' Until then any admin can keep it, exactly as it was.' : ' Until then any of its admins can still keep it.'}
      </div>
      {deletion.canKeep
        ? (
          <button className="formcommit" id="workplaceKeep" type="button" disabled={busy} onClick={() => { void keep(); }}>
            {busy ? 'Keeping…' : 'Keep this workplace'}
          </button>
        )
        : null}
      {/* The way out, full width under everything like the setup gate's own
          buttons: a person locked out of one workplace still has the others,
          or can found one. */}
      {elsewhere
        ? <button className="btn ghost" id="workplaceDeletingWayOut" type="button" onClick={() => navigate('/workplaces')}>Switch workplace</button>
        : <button className="btn ghost" id="workplaceDeletingWayOut" type="button" onClick={() => navigate('/workplaces', { state: { create: true } })}>New workplace</button>}
    </div>
  );
}
