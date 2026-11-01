import type { WorkspaceOrgDetail } from '../../../src/shared/workspace-api.js';
import { TypeIcon } from '../ui/icons.js';

/** A workplace with no cloud of its own: it runs on ours (note #664). */
export type HostedCloud = Extract<WorkspaceOrgDetail['fly'], { hosted: true }>;

/**
 * The cloud of a HOSTED workplace (note #664, the owner, 2026-09-25: "we
 * should not require fly cloud token. we should run user's cloud on our fly
 * account"). There is no account of the workplace's own to name, no tunnel
 * to report and no bill to open, so the card says the two things that are
 * true instead: it is ours and free, and how much of the allowance the
 * workplace uses — 20 agents and 30 sites across everyone in it (note #771).
 *
 * The public docs use this component as a live product illustration. It is
 * deliberately not rendered on the workplace settings screen (note #668).
 */
export function HostedCloudCard({ fly }: { fly: HostedCloud }) {
  return (
    <div className="card" id="orgCloudCard" data-hosted="true">
      <div className="crow">
        <TypeIcon glyph="globe" />
        <div className="main">
          <div className="name plain">Agentic Cloud Computer</div>
          <div className="cline"><span className="ctext">Free · nothing to connect</span></div>
        </div>
      </div>
      <div className="cloudcounts" role="status">
        <span><strong>{fly.agents.used}</strong> of {fly.agents.limit} agents</span>
        <span><strong>{fly.sites.used}</strong> of {fly.sites.limit} sites</span>
      </div>
    </div>
  );
}
