/**
 * Home's chrome: the workplace switch at the far edge (note #420) and the
 * reader's own picture after it (note #634).
 *
 * The switch names the active workplace beside a small down chevron, so the
 * reader does not have to open the picker to learn where they are; since
 * note #609 the picker is a menu dropped under it (`WorkplaceMenu`), and it
 * is also the way into the active workplace's details, so it stays for a
 * one-workplace account. Before there is a workplace at all, the same
 * control is the founder's door and opens the create form. The picture drops
 * the account menu: the People page and Settings.
 *
 * This file used to draw the line between Home's two halves (note #404);
 * since note #715 those are two windows opened from the doors in the Chief of
 * Staff's header (`RecapChatScreen`), and the tabs are gone.
 */

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { Svg } from '../../ui/icons.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { WorkplaceMenu } from './WorkplaceMenu.js';
import { AccountButton } from './AccountMenu.js';
import { RadioButton } from '../../radio/RadioButton.js';

/**
 * The workplace switch and the reader's own picture (notes #420, #634): the
 * two controls that stand at the far edge of the overview's tab row, and —
 * since the Workspace Agent's conversation became Home (2026-10-10) — at the
 * far edge of that conversation's header too, because they are what makes a
 * screen the front door rather than one more chat.
 */
export function HomeChrome() {
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const hasOrganization = Boolean(state?.org);
  const canOpenOrganizations = hasOrganization || state?.canCreateOrg === true;
  const [menuOpen, setMenuOpen] = useState(false);
  const swap = useRef<HTMLButtonElement>(null);
  const openOrganizations = () => {
    if (hasOrganization) setMenuOpen((open) => !open);
    else navigate(toFor({ kind: 'organizations' })!, { state: { create: true } });
  };
  return (
    <>
      <RadioButton />
      {canOpenOrganizations
        ? (
          <button
            className="orgswap" id="homeOrganizations" type="button" onClick={openOrganizations} ref={swap}
            aria-haspopup={hasOrganization ? 'menu' : undefined}
            aria-expanded={hasOrganization ? menuOpen : undefined}
            aria-label={hasOrganization ? 'Switch workplace' : 'Create workplace'}
            title={hasOrganization ? 'Switch workplace' : 'Create workplace'}
          >
            <span className="orgswapbody">
              {state?.org ? <span className="orgswapname">{state.org.name}</span> : null}
              <Svg name={hasOrganization ? 'chevdown' : 'plus'} size={hasOrganization ? 12 : 16} />
            </span>
          </button>
        )
        : null}
      {menuOpen && hasOrganization ? <WorkplaceMenu anchor={swap} onClose={() => setMenuOpen(false)} /> : null}
      <AccountButton />
    </>
  );
}

/**
 * A personal workspace's one row over its column: the founder's door (or the
 * workplace switch) and the reader's picture. A workplace's Home carries the
 * same two controls at the far edge of the conversation's header instead,
 * beside its Workplace and Rooms doors (note #715).
 */
export function HomeTabs() {
  const { state } = useWorkspace();
  const canOpenOrganizations = Boolean(state?.org) || state?.canCreateOrg === true;
  // The reader's own picture closes the row in every account, a personal one
  // included: it is Home's one door into their settings (note #634).
  const signedIn = Boolean(state?.user);
  return (
    <div className="homenav" id="homeTabs" hidden={!canOpenOrganizations && !signedIn}>
      <HomeChrome />
    </div>
  );
}
