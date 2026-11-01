import { HostedCloudCard, type HostedCloud } from '../../backend/workspace-ui/src/cloud/HostedCloudCard';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';

/**
 * The workplace's cloud, live: the Cloud card of Workplace settings as a
 * workplace on OUR cloud sees it (the app's own `HostedCloudCard`).
 *
 * Until note #664 (the owner, 2026-09-25) this panel was the connected-Fly
 * `CloudCard` — the customer's own Fly organization, its tunnel, machines
 * awake and asleep and the door to cloud details — with the details screen's
 * machine rows copied under it. Every new workplace now runs on the
 * platform's cloud, free, with nothing to connect: the card names our cloud,
 * says it is free, and counts what the workplace uses of its allowance (20
 * agents, 30 sites across everyone in it). There is no details screen behind
 * it and no bill, so the machine rows and their "awake this month" went with
 * the old card; a hosted workplace has no screen that shows them.
 *
 * The counts are the fixture's own: James drives 18 agents (JAMES), and the
 * Sites section lists three.
 */
const CLOUD: HostedCloud = {
  connected: false,
  hosted: true,
  agents: { used: 18, limit: 20 },
  sites: { used: 3, limit: 30 },
};

export default function LiveCloud({ className = '' }: { className?: string }) {
  return (
    <LivePanel
      size="tile"
      className={`landing-cloud ${className}`}
      says="The workplace’s Cloud card: Agentic Cloud Computer, free, with nothing to connect; 18 of its 20 agents and 3 of its 30 sites in use."
    >
      <LiveWorkspace>
        <HostedCloudCard fly={CLOUD} />
      </LiveWorkspace>
    </LivePanel>
  );
}
