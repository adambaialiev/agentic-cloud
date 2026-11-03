/**
 * The Workplace window's shelves on screens of their own (note #960): the
 * window became an index, and Repositories, Sites, Storage and the Chief of
 * Staff's own settings — which it drew inline — each open here, as Notes,
 * Drive, Knowledge and Secrets already did. The lists are the very rows the
 * window held (`Repositories`, `Sites`, `Storage`, `WorkspaceAgentCards`),
 * so a row means the same thing wherever it is drawn.
 */

import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { bytes } from '../../ui/file-kind.js';
import { CHIEF_OF_STAFF } from '../../ui/chief-of-staff.js';
import { AgentFace } from '../../ui/AgentFace.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { Repositories } from '../home/Repositories.js';
import { Sites } from '../home/Sites.js';
import { Storage } from '../home/Storage.js';
import { WorkspaceAgentCards } from '../home/WorkspaceAgentCards.js';
import { useWorkspaceAgentDetails } from '../home/workspace-agent-details.js';
import { counted, sitesLine, storageLine } from '../home/workplace-index-words.js';
import { sitesOf } from '../sites/site-words.js';
import { bucketsOf } from '../storage/bucket-words.js';

export function RepositoriesScreen() {
  const { state } = useWorkspace();
  const repos = state?.repos ?? null;
  const quota = state?.quota;
  const sub = repos
    ? `${counted(repos.length, 'repository', 'repositories')}${quota ? ` · ${bytes(quota.userUsedBytes)} of ${bytes(quota.userMaxBytes)} used` : ''}`
    : '';
  return (
    <div className="screen" id="screenRepositories">
      <ScreenTitle title="Repositories" sub={sub} subId="repositoriesSub" />
      <Repositories screen />
    </div>
  );
}

export function SitesScreen() {
  const { state } = useWorkspace();
  const sites = sitesOf(state);
  return (
    <div className="screen" id="screenSites">
      <ScreenTitle title="Sites" sub={state ? sitesLine(sites.map((site) => site.url ?? '')) : ''} subId="sitesSub" />
      <Sites screen />
    </div>
  );
}

export function StorageScreen() {
  const { state } = useWorkspace();
  const buckets = bucketsOf(state);
  return (
    <div className="screen" id="screenStorage">
      <ScreenTitle title="Storage" sub={state && buckets.length ? storageLine(buckets) : ''} subId="storageSub" />
      <Storage screen />
    </div>
  );
}

export function ChiefOfStaffScreen() {
  const { state } = useWorkspace();
  const orgId = state?.org?.orgId ?? null;
  const details = useWorkspaceAgentDetails(orgId, false);
  return (
    <div className="screen" id="screenChiefOfStaff">
      {/* Its face beside its name, from the same source as Home's header. */}
      <ScreenTitle
        mark={<AgentFace agent={{ avatarUrl: state?.org?.workspaceAgentAvatarUrl ?? details.data?.agent.avatarUrl }} />}
        markId="chiefOfStaffFace"
        title={CHIEF_OF_STAFF}
      />
      {/* Not before its first read (or a copy of the last one) is in hand:
          the cards would claim a machine is "not reserved yet" for the
          length of the read. */}
      {orgId && (details.data || details.error)
        ? <WorkspaceAgentCards orgId={orgId} details={details} />
        : <div className="card" aria-busy="true"><div className="empty">Loading…</div></div>}
    </div>
  );
}
