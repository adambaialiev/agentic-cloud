/**
 * The workplace picker (`/workplaces`, notes #59/#93): every workplace
 * this account is in, the active one marked and a door to its details, any
 * other a tap away from becoming active. Founding a new one lives here too
 * (note #89), as a transient leaf. The active row became the details door
 * when note #420 removed that door from Home's old identity header.
 */

import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { hasEntryBeneath } from '../../chrome/history.js';
import { toFor } from '../../routes.js';
import { Icon } from '../../ui/icons.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { OrgCreateForm } from './OrgCreateForm.js';
import { organizationFacts, workplaceHasTeam } from './org-words.js';
import { useActivateOrganization } from './useActivateOrganization.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

export function OrganizationsScreen() {
  const { state } = useWorkspace();
  const { switching, activate } = useActivateOrganization();
  const navigate = useNavigate();
  const location = useLocation();
  // Arriving WITH the form up (the founder door, or founding after a
  // delete) means the screen beneath is where Back belongs; closing the
  // form then spends that entry rather than revealing a picker nobody
  // asked for.
  const arrivedToCreate = Boolean((location.state as { create?: boolean } | null)?.create);
  const [creating, setCreating] = useState(arrivedToCreate);
  const organizations = state?.organizations ?? [];
  const canCreate = state?.canCreateOrg === true;

  if (creating) {
    return (
      <OrgCreateForm onClose={() => {
        if (arrivedToCreate && hasEntryBeneath(location)) navigate(-1);
        else setCreating(false);
      }} />
    );
  }

  return (
    <div className="screen" id="screenOrgPicker">
      <ScreenTitle title="Switch workplace" />
      <div className="sub">The whole Workspace follows: agents, repositories, notes and knowledge are the workplace’s own.</div>
      <div className="card" id="orgPickerList">
        {organizations.map((organization) => {
          // No role and no head count in a workplace of one that nobody can
          // join (workplaceHasTeam; notes #205, #805): each row says its own.
          const team = workplaceHasTeam(organization);
          const facts = organizationFacts(organization, { people: team });
          const body = (
            <>
              <div className="main">
                <div className="name plain">
                  {organization.name}
                  {organization.role === 'admin' && team ? <> <span className="badge mut">Admin</span></> : null}
                  {/* Switching into it opens its lock screen (2026-09-22); say so first. */}
                  {/* Grey, not red, as in Home's switcher (note #654). */}
                  {organization.deletingAt ? <> <span className="badge mut">Being deleted</span></> : null}
                </div>
                {facts ? <div className="cline"><span className="ctext">{facts}</span></div> : null}
              </div>
            </>
          );
          return organization.active
            ? (
              <Link
                className="crow orgrow open current" key={organization.orgId}
                to={toFor({ kind: 'organization', orgId: organization.orgId })!}
                aria-current="true" aria-disabled={switching !== null || undefined}
                onClick={switching !== null ? (event) => event.preventDefault() : undefined}
              >
                {body}
                <Icon name="tick" size={20} className="icon orgtick" />
              </Link>
            )
            : (
              <button className="crow orgrow open" key={organization.orgId} type="button" disabled={switching !== null} onClick={() => { void activate(organization); }}>
                {body}
                {switching === organization.orgId ? <span className="spinner" /> : null}
              </button>
            );
        })}
        {organizations.length < 2 ? <div className="empty">This is your only workplace.</div> : null}
      </div>
      {canCreate
        ? (
          <button className="addrow" id="orgNewDoor" type="button" onClick={() => setCreating(true)}>
            <span>New workplace</span>
          </button>
        )
        : null}
    </div>
  );
}
