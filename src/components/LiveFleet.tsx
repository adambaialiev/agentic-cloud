import { AgentRow } from '../../backend/workspace-ui/src/screens/home/Agents';
import { useNow } from '../../backend/workspace-ui/src/ui/time';
import type { HomeAgent } from '../../backend/workspace-ui/src/workspace/live';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { FLEET, useHydrated, useRunningFleet } from './live/fixture';

/**
 * The Workspace's fleet, rendered live on the landing (see live/fixture.tsx
 * for the whole idea). The rows are the app's own `AgentRow`. The fleet label
 * and total/active/idle summary are deliberately absent: the hero already
 * introduces what these cards are, so the example can begin with the product.
 * The harness chips that used to stand under it went with the product's (note
 * #412) — a copy of a control the app no longer has is the one thing this panel
 * exists to avoid.
 *
 * From 2026-10-05 to 2026-10-08 it was also the hero's picture, with the
 * four people over the fleet and the rows past the first two fading out;
 * the hero is a moving row of cards now (LiveMarquee, note #185), and only
 * the social card still draws the fleet at poster size.
 *
 * Each running clock is attached only after hydration: a clock in
 * prerendered HTML is a mismatch waiting to happen, and a turn that started
 * at build time would be days old.
 */

export default function LiveFleet({ className = '', size = 'poster', fleet = FLEET, says }: {
  className?: string;
  size?: 'poster' | 'tile';
  fleet?: HomeAgent[];
  says?: string;
}) {
  const hydrated = useHydrated();
  const agents = useRunningFleet(fleet);
  const now = useNow(hydrated);
  return (
    <LivePanel
      className={className}
      size={size}
      says={says ?? "The Workspace’s fleet: Ruby and Milo, both on Claude Code, are mid-job; Otis, on Codex, is ready. Each has its own cloud machine."}
    >
      <LiveWorkspace agents={agents}>
        <div id="agentsSection">
          <div className="agentdeck">
            <div className="plates">
              {agents.map((agent) => <AgentRow key={agent.id} agent={agent} now={now} />)}
            </div>
          </div>
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}
