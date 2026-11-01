/**
 * The workplace switch's own menu (note #609).
 *
 * Tapping the switch used to navigate to the picker screen (`/workplaces`),
 * so trying another workplace cost a whole page and a Back. It now drops a
 * small menu under the switch instead: every workplace this account is in,
 * the active one ticked, any other one tap from becoming active — then, for
 * an admin, an invitation into the active workplace (note #620: it used to
 * be a plate at the end of Home's people deck), its settings and, for
 * whoever may found one, a new workplace. The picker screen keeps its
 * address for links and for the founder's form.
 *
 * The floating, the dismissal and the keyboard are `HeaderMenu`, which the
 * reader's own account menu shares (note #634).
 */

import type { RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { Svg } from '../../ui/icons.js';
import { organizationFacts, workplaceHasTeam } from '../org/org-words.js';
import { useActivateOrganization } from '../org/useActivateOrganization.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { HeaderMenu } from './HeaderMenu.js';

export function WorkplaceMenu({ anchor, onClose }: {
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const { state } = useWorkspace();
  const { switching, activate } = useActivateOrganization();
  const navigate = useNavigate();
  const organizations = state?.organizations ?? [];
  const active = organizations.find((organization) => organization.active);
  const canCreate = state?.canCreateOrg === true;

  const busy = switching !== null;
  const choose = async (orgId: string) => {
    const organization = organizations.find((row) => row.orgId === orgId);
    if (!organization || busy) return;
    if (organization.active) { onClose(); return; }
    if (await activate(organization)) onClose();
  };

  return (
    <HeaderMenu id="workplaceMenu" label="Workplaces" anchor={anchor} onClose={onClose}>
      <div className="orgmenulist" role="group" aria-label="Switch workplace">
        {organizations.map((organization) => {
          // No role and no head count in a workplace of one that nobody can
          // join (workplaceHasTeam; notes #205, #805): each row says its own.
          const team = workplaceHasTeam(organization);
          const facts = organizationFacts(organization, { people: team });
          return (
            <button
              className={`orgmenurow${organization.active ? ' current' : ''}`} key={organization.orgId}
              type="button" role="menuitemradio" aria-checked={organization.active}
              disabled={busy && switching !== organization.orgId}
              onClick={() => { void choose(organization.orgId); }}
            >
              <span className="orgmenumain">
                <span className="orgmenuname">
                  <span className="orgmenunametext">{organization.name}</span>
                  {organization.role === 'admin' && team ? <span className="badge mut">Admin</span> : null}
                  {/* Grey, like Admin beside it (note #654): a fact about that
                      workplace, not an alarm. Red is for something waiting on
                      the reader, and nothing here is — a deleting workplace is
                      still one they may open, and its own lock screen says
                      what can be done about it. */}
                  {organization.deletingAt ? <span className="badge mut">Being deleted</span> : null}
                </span>
                {facts ? <span className="orgmenufacts">{facts}</span> : null}
              </span>
              {switching === organization.orgId
                ? <span className="spinner" />
                : organization.active ? <span className="orgmenutick"><Svg name="tick" size={18} /></span> : null}
            </button>
          );
        })}
      </div>
      <div className="orgmenulist orgmenuactions" role="group">
        {/* Admins only: the server refuses anyone else, and a door that
            refuses is worse than no door. It opens the invite page, where
            the link stands ready to copy — a person is asked, not made.
            Gone altogether while invites are switched off (state.invitesClosed). */}
        {active?.role === 'admin' && !state?.invitesClosed
          ? (
            <button
              className="orgmenurow" id="workplaceMenuInvite" type="button" role="menuitem" disabled={busy}
              onClick={() => { onClose(); navigate(toFor({ kind: 'organizationInvite', orgId: active.orgId })!); }}
            >
              <span className="orgmenumain"><span className="orgmenuname">Invite to this workplace</span></span>
              <span className="orgmenutick"><Svg name="userplus" size={16} /></span>
            </button>
          )
          : null}
        {active
          ? (
            <button
              className="orgmenurow" id="workplaceMenuSettings" type="button" role="menuitem" disabled={busy}
              onClick={() => { onClose(); navigate(toFor({ kind: 'organization', orgId: active.orgId })!); }}
            >
              <span className="orgmenumain"><span className="orgmenuname">Workplace settings</span></span>
              <span className="orgmenutick"><Svg name="settings" size={16} /></span>
            </button>
          )
          : null}
        {canCreate
          ? (
            <button
              className="orgmenurow" id="workplaceMenuNew" type="button" role="menuitem" disabled={busy}
              onClick={() => { onClose(); navigate(toFor({ kind: 'organizations' })!, { state: { create: true } }); }}
            >
              <span className="orgmenumain"><span className="orgmenuname">New workplace</span></span>
              <span className="orgmenutick"><Svg name="plus" size={16} /></span>
            </button>
          )
          : null}
      </div>
    </HeaderMenu>
  );
}
