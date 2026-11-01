import { useState } from 'react';
import type { WorkspaceOrgMember } from '../../backend/src/shared/workspace-api';
import { PersonRow } from '../../backend/workspace-ui/src/screens/org/PersonRow';
import { useNow } from '../../backend/workspace-ui/src/ui/time';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { FACES, HOUR, MINUTE, ago, useHydrated } from './live/fixture';

/**
 * The team view, live (note #840, the owner, 30 Oct 2026, 13:30 UTC): the
 * People page's own cards (`PersonRow`) for two teammates on the Northstar
 * fixture. Until then this was a picture shot from the Workspace (note #833),
 * whose left card was "You" and "Admin" with no line of its own, and whose
 * right card wore the grey outline of a person. Here they are two teammates,
 * neither "You" nor an admin, each with a presence line and their latest
 * action, and both wear initials (`PersonFace` draws them when there is no
 * picture). On a desk the two stand side by side at one height; on a phone
 * one above the other (index.css, .landing-people).
 *
 * Since note #926 (the owner, 31 Oct 2026, 15:16 UTC: "people see each
 * other's contribution made by their agent … we should pitch it
 * agressively, because it's a hook") each card carries the product's own
 * "This week" block (note #925, `PersonContribution`): agent hours, changes
 * merged, tokens written per provider and the latest merged change. The
 * figures differ, as the owner said they will ("some people will have
 * bigger contribution, some less"), and follow the fixture: Lena drives Ruby
 * and Milo, both on Claude Code, and Ruby's route optimiser is the change
 * James approved six minutes ago; James drives Otis and Ada, both on Codex.
 * About 60K tokens written an hour, as the product's own example on
 * proposal #1498 (182K in 3h).
 *
 * Demo only: the product's own cards are not changed by this.
 */
export default function LivePeople({ className = '' }: { className?: string }) {
  const hydrated = useHydrated();
  const now = useNow(hydrated);
  const [people] = useState<WorkspaceOrgMember[]>(() => [
    {
      userId: 'user_lena',
      name: 'Lena Fischer',
      you: false,
      role: 'member',
      joinedAt: ago(40 * 24 * 60 * MINUTE),
      agents: 2,
      workedMs: 0,
      here: true,
      recap: 'Handed Ruby the batch route optimiser',
      recapAt: ago(40 * MINUTE),
      contribution: {
        week: { workingMs: 34 * HOUR, merged: 11, tokens: { claude: 2_100_000 } },
        latest: { id: 'pr_route_optimiser', title: 'Route optimiser, first cut', at: ago(6 * MINUTE), number: 51, repo: 'northstar-routing', agentName: 'Ruby' },
      },
      agentFaces: [
        { id: 'agent_ruby', name: 'Ruby', avatarUrl: FACES.ruby, working: true, recap: 'Building the batch route optimiser; tests passing so far.' },
        { id: 'agent_milo', name: 'Milo', avatarUrl: FACES.milo, recap: 'Moved invoicing to usage; proposal waiting on your yes.' },
      ],
    },
    {
      userId: 'user_james',
      name: 'James Okafor',
      you: false,
      role: 'member',
      joinedAt: ago(38 * 24 * 60 * MINUTE),
      agents: 2,
      workedMs: 0,
      lastSeenAt: ago(6 * MINUTE),
      recap: 'Approved Ruby’s proposal: route optimiser, first cut',
      recapAt: ago(6 * MINUTE),
      contribution: {
        week: { workingMs: 19 * HOUR, merged: 6, tokens: { codex: 860_000 } },
        latest: { id: 'pr_ping_retries', title: 'Retries for dropped pings', at: ago(26 * HOUR), number: 38, repo: 'northstar-pings', agentName: 'Otis' },
      },
      agentFaces: [
        { id: 'agent_otis', name: 'Otis', avatarUrl: FACES.otis, working: true, recap: 'Partitioning the GPS pings table; checks running.' },
        { id: 'agent_ada', name: 'Ada', avatarUrl: FACES.ada, recap: 'Compared six dispatcher interviews; summary in the notes.' },
      ],
    },
  ]);
  return (
    <LivePanel
      size="tile"
      className={`landing-people ${className}`}
      says="The People page of a workplace called Northstar, each person's agents under their name. Lena Fischer, here now, who handed Ruby the batch route optimiser 40 minutes ago; this week her agents worked 34 hours, merged 11 changes and wrote 2.1 million tokens on Claude Code, the latest the route optimiser's first cut, 6 minutes ago; her agents are Ruby (Working, building the batch route optimiser) and Milo (Idle, invoicing proposal waiting for a yes). James Okafor, active 6 minutes ago, who approved Ruby's proposal 6 minutes ago; this week his agents worked 19 hours, merged 6 changes and wrote 860 thousand tokens on Codex, the latest retries for dropped pings, a day ago; his agents are Otis (Working, partitioning the GPS pings table) and Ada (Idle, dispatcher interviews summarised in the notes)."
    >
      <LiveWorkspace>
        <div className="plates peopleplates">
          {people.map((person) => (
            <PersonRow key={person.userId} person={person} now={now} onOpen={() => undefined} />
          ))}
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}
