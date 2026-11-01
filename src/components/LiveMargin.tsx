import { useState } from 'react';
import type { WorkspaceMarginComment } from '../../backend/src/shared/workspace-api';
import { KnowledgeHtml } from '../../backend/workspace-ui/src/render/KnowledgeHtml';
import { useNoteRefs } from '../../backend/workspace-ui/src/render/useNoteRefs';
import { MarginThread } from '../../backend/workspace-ui/src/screens/decisions/MarginThread';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { FACES, HOUR, MINUTE, ago } from './live/fixture';

/**
 * A page's margin, live, with people in it: the knowledge page on how a
 * route is billed, cropped to its head and first paragraph, and under it the
 * app's own `MarginThread` carrying a question from Leo, Priya's answer, and
 * Milo writing the answer into the page. It stands beside the section that
 * says the team decides inside the brain — a thread between two humans and
 * an agent, on the thing it is about, is that claim drawn.
 *
 * The page is the one the billing question from Ruby's peer chat lands on
 * (LiveChat): whether the batch optimiser's leg back to the depot is
 * metered. Milo answers it there from the contract; here people confirm it
 * with the customer and write it into the page. The two must agree, and so
 * must every other billing line on the page (Milo's recap, proposal #44,
 * note #56, the Stripe secret): per stop, never per kilometre. Until
 * 2026-10-03 the chat said kilometres, return leg included, and the page
 * argued with itself. Landing.test pins it. Every id is its
 * own (`bpage…`): the memory section's page carries `kpage…`, and the
 * landing test resolves an id to one element per page.
 */

const PAGE = {
  title: 'How Northstar bills a route',
  description: 'What a customer pays for a van’s day: per stop, never per kilometre, and what the invoice line says.',
  html: '<h1>How Northstar bills a route</h1><p>A route is billed <strong>per stop completed</strong>, at the account’s rate, on the day the van returns. Kilometres are reported for fleet planning and never metered. <strong>The leg back to the depot is not a stop</strong> and is never charged, however the optimiser routes it.</p>',
};

const LEO: WorkspaceMarginComment = {
  text: '<p>Does the batch optimiser’s leg back to the depot get metered? Harbour Freight’s contract reads per stop to me, and their invoice for Monday would jump if it did.</p>',
  createdAt: ago(3 * HOUR),
  byPerson: true,
  userName: 'Leo',
  authorUserId: 'user_leo',
  userPhotoUrl: FACES.leoPerson,
};

const PRIYA: WorkspaceMarginComment = {
  text: '<p>Per stop. The way back is theirs, not ours — I checked with their ops lead this morning. Same for every account on the pilot contract.</p>',
  createdAt: ago(2 * HOUR + 20 * MINUTE),
  byPerson: true,
  userName: 'Priya',
  authorUserId: 'user_priya',
  userPhotoUrl: FACES.priyaPerson,
};

/* Signed the way the app signs an agent's remark: name, owner, runtime. */
const MILO: WorkspaceMarginComment = {
  text: '<p>Written into the page above: the return leg is never a stop and never charged. Usage invoicing (PR #44) counts stops only; the engine still reports the leg for planning.</p>',
  createdAt: ago(1 * HOUR),
  agentName: 'Milo',
  userName: 'Leo',
  agentAvatarUrl: FACES.milo,
  agentId: 'agent_milo',
  agentRuntime: { cli: 'claude', model: 'opus', effort: 'high' },
};

function Panel() {
  const notes = useNoteRefs();
  const [comments] = useState<WorkspaceMarginComment[]>(() => [LEO, PRIYA, MILO]);
  return (
    <div className="screen" id="screenBillingPage">
      <div className="landing-page-head">
        <div className="phead">
          <div className="pname">
            <h1 id="bpageTitle">{PAGE.title}</h1>
            <div className="sub" id="bpageSub">{PAGE.description}</div>
          </div>
        </div>
      </div>
      <div id="bpageBody">
        <KnowledgeHtml source={PAGE.html} dropTitle={PAGE.title} noteRefs={notes} />
      </div>
      <MarginThread
        ids={{ head: 'bpageCommentsHead', card: 'bpageCommentsCard', box: 'bpageComments' }}
        comments={comments}
        canWrite={false}
        path="api/knowledge/how-northstar-bills-a-route/comments"
        onPosted={() => {}}
        onSay={() => {}}
      />
    </div>
  );
}

export default function LiveMargin({ className = '' }: { className?: string }) {
  return (
    <LivePanel
      size="tile"
      className={className}
      says="The knowledge page on how Northstar bills a route, close up, and the thread in its margin: Leo asks whether the leg back to the depot is metered, Priya answers that billing is per stop, and Milo says he has written the answer into the page."
    >
      <LiveWorkspace>
        <Panel />
      </LiveWorkspace>
    </LivePanel>
  );
}
