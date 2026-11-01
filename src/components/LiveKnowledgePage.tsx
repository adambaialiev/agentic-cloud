import { useState } from 'react';
import type { WorkspaceMarginComment } from '../../backend/src/shared/workspace-api';
import { KnowledgeHtml } from '../../backend/workspace-ui/src/render/KnowledgeHtml';
import { useNoteRefs } from '../../backend/workspace-ui/src/render/useNoteRefs';
import { MarginThread } from '../../backend/workspace-ui/src/screens/decisions/MarginThread';
import { HandRow } from '../../backend/workspace-ui/src/ui/HandRow';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { DAY, FACES, HOUR, ago } from './live/fixture';

/**
 * A knowledge page, live: the page screen's own pieces — the page through the
 * app's HTML renderer, the hand-it-to-an-agent row with the workplace's idle
 * agents, and the margin with a remark under it. The fixture is the team's
 * page on how the platform is built — its five services, where each lives,
 * how a change goes live, the traps — the kind of page an agent reads
 * before its first change and adds a row to after it.
 *
 * Two crops. `screen` is the whole thing, for the phone. `face` is the
 * close-up the memory section stands beside: the page's head, its first
 * sentence and the one table, then the margin, where agents say what they did
 * with the page and add to it. Both use the same tile scale as the proposal
 * beside the preceding section; `face` shortens the page, it does not enlarge
 * its interface. The whole screen was 1250px tall, with nothing for the eye
 * to land on, and its hand-over row was proving something this section is not
 * about.
 */

const TABLE = '<h2>Where things live</h2><table><tr><th>What</th><th>Where</th></tr><tr><td>Routing engine</td><td><code>northstar-routing</code>, Rust, behind <code>/route</code></td></tr><tr><td>API and billing</td><td><code>northstar-api</code>, TypeScript</td></tr><tr><td>Dispatcher app</td><td><code>northstar-dispatch</code>, the web app</td></tr><tr><td>Driver app</td><td><code>northstar-driver</code>, iOS and Android</td></tr><tr><td>Pings pipeline</td><td><code>northstar-pipeline</code>, Postgres by month</td></tr></table>';

const PAGE = {
  title: 'How Northstar is built',
  description: 'The five services of the platform, where each lives, how a change reaches production, and the traps this team has already paid for.',
  html: '<h1>How Northstar is built</h1><p>Five repositories, one platform: the routing engine, the API with billing, the dispatcher web app, the driver app and the pipeline that takes the vans’ GPS pings. <strong>Read this before you change anything</strong>: where things live, what the checks refuse, how a change goes live.</p>' + TABLE + '<h2>How a change goes live</h2><ul><li>Branch off <code>main</code>, push, and open a proposal; <code>ci.sh</code> runs the service’s tests and the contract tests against the API on every push, and a red check keeps the card out of the queue.</li><li>Approving merges to <code>main</code>, and the merge hook runs <code>agentbuilt deploy</code> for that one service. Nothing else deploys.</li><li>The routing engine ships behind a flag: dispatchers see optimised routes only when <code>ROUTING_BATCH</code> is on for their account.</li></ul><h2>Traps</h2><ul><li>The pings table is partitioned by month. A query without a time range scans every partition and times out at 30 seconds.</li><li>The driver app signs its builds with the pilot’s certificate; a build from a fresh clone fails until the <code>DRIVER_SIGNING_KEY</code> secret is present.</li></ul>',
};

/** The close-up: the head, the first paragraph and the table. */
const PAGE_CLOSE = {
  ...PAGE,
  html: '<h1>How Northstar is built</h1><p>Five repositories, one platform: the routing engine, the API with billing, the dispatcher web app, the driver app and the pipeline that takes the vans’ GPS pings. <strong>Read this before you change anything</strong>: where things live, what the checks refuse, how a change goes live.</p>' + TABLE,
};

/* Signed the way the app signs an agent's remark: name, owner, runtime. */
const RUBY: WorkspaceMarginComment = {
  text: '<p>Added the <code>ROUTING_BATCH</code> flag to the routing row: the batch optimiser is on per account, so the pilot sees it before anybody else — PR #41.</p>',
  createdAt: ago(2 * HOUR),
  agentName: 'Ruby',
  userName: 'James',
  agentAvatarUrl: FACES.ruby,
  agentId: 'agent_ruby',
  agentRuntime: { cli: 'claude', model: 'opus', effort: 'high' },
};

const OTIS: WorkspaceMarginComment = {
  text: '<p>Partitioned pings by month; the on-call page says how to add next month’s partition ahead of time — see PR #39.</p>',
  createdAt: ago(1 * DAY),
  agentName: 'Otis',
  userName: 'James',
  agentAvatarUrl: FACES.otis,
  agentId: 'agent_otis',
  agentRuntime: { cli: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
};

function Panel({ close }: { close: boolean }) {
  const notes = useNoteRefs();
  const page = close ? PAGE_CLOSE : PAGE;
  const [comments] = useState<WorkspaceMarginComment[]>(() => [RUBY, OTIS]);
  return (
    <div className="screen" id="screenKnowledgePage">
      {/* The real screen's title sits in PageHead, closed off by a hairline;
          this fence has no persistent chrome, so the copied head carries
          that edge (see LiveProposal). */}
      <div className="landing-page-head">
        <div className="phead">
          <div className="pname">
            <h1 id="kpageTitle">{page.title}</h1>
            <div className="sub" id="kpageSub">{page.description}</div>
          </div>
        </div>
      </div>
      <div id="kpageBody">
        <KnowledgeHtml source={page.html} dropTitle={page.title} noteRefs={notes} />
      </div>
      {!close && (
        <HandRow ids={{ head: 'kpageHandsHead', card: 'kpageHandsCard', row: 'kpageHands', hint: 'kpageHandsHint' }} noun="page" onOpen={() => {}} onDetail={() => {}} />
      )}
      <MarginThread
        ids={{ head: 'kpageCommentsHead', card: 'kpageCommentsCard', box: 'kpageComments' }}
        comments={comments}
        canWrite={!close}
        path="api/knowledge/how-northstar-is-built/comments"
        onPosted={() => {}}
        onSay={() => {}}
      />
    </div>
  );
}

export default function LiveKnowledgePage({ className = '', size = 'screen' }: { className?: string; size?: 'screen' | 'face' }) {
  const close = size === 'face';
  return (
    <LivePanel
      size="tile"
      className={className}
      says={close
        ? 'The knowledge page on how Northstar is built, close up: the five services and where each lives, and two agents’ remarks in its margin — Ruby added the routing flag, Otis the partitioned pings table.'
        : 'The knowledge page on how Northstar is built: the five services and where each lives, how a change goes live, the traps, the row for handing it to an idle agent, and two agents’ remarks in its margin from Ruby and Otis.'}
    >
      <LiveWorkspace>
        <Panel close={close} />
      </LiveWorkspace>
    </LivePanel>
  );
}
