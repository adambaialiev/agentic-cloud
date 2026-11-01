import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../workspace/useWorkspace.js';

/**
 * The way out of an unfinished workplace (note #653): a person who belongs
 * to several arrives at the setup gate the moment they switch into one
 * still being set up, and the gate hides Home's switch. So the setup screens
 * carry their own — grey words on the commit's row, before it, the sign-in
 * foot's quiet Cancel (the owner, 2026-09-23) — opening the picker, which
 * the gate lets through. Only when there IS somewhere else to go: for the
 * founder of their one workplace the road runs forward, and a "New
 * workplace" door here would be a second founding offered mid-founding.
 *
 * It stood on the cloud step until note #664 took that step away; the
 * subscription step is the first screen now, so it carries the way out.
 */
export function SetupWayOut() {
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const orgId = state?.org?.orgId;
  const elsewhere = (state?.organizations ?? []).some((organization) => organization.orgId !== orgId);
  if (!elsewhere) return null;
  return <button className="btn bare setupwayout" id="setupWayOut" type="button" onClick={() => navigate('/workplaces')}>Switch workplace</button>;
}
