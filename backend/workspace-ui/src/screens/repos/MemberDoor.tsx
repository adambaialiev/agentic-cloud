/**
 * Where a MEMBER goes from a public page (the owner's screenshot, 2026-09-27).
 *
 * A public address belongs to no workplace, but the screen it sends a member
 * on to does — and an ordinary read in this shell asks as the workplace the
 * TAB stands in (workspace/standing-workplace.ts), not as the `?org=` in the
 * address. A tab standing in one workplace, sent to another's repository
 * with a soft navigation, therefore read the repository as "not here". So:
 * when the tab already stands in that workplace, a soft replace; otherwise a
 * fresh document at the address, which stands where its `?org=` says before
 * its first read (`standInAddressedWorkplace`). The hop costs a reload, and
 * only across workplaces, which is what it is.
 */

import { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { standingWorkplace } from '../../workspace/standing-workplace.js';
import { addressedIn } from './public-repo.js';
import { PublicLoading } from './PublicRepoScreen.js';

export function MemberDoor({ orgId, to }: { orgId: string; to: string }) {
  const here = standingWorkplace() === orgId;
  const address = addressedIn(to, orgId);
  useEffect(() => {
    if (!here) window.location.replace(address);
  }, [here, address]);
  if (here) return <Navigate to={address} replace />;
  return <PublicLoading />;
}
