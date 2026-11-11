import { Fragment, useState } from 'react';
import type { WorkspaceChatMessage } from '../../backend/src/shared/workspace-api';
import { chatDayLabel } from '../../backend/workspace-ui/src/screens/chat/chat-notice';
import { ChatMessageRow } from '../../backend/workspace-ui/src/screens/chat/ChatMessageRow';
import { agentRuntimeLine } from '../../backend/workspace-ui/src/screens/home/agent-words';
import { AgentFace } from '../../backend/workspace-ui/src/ui/AgentFace';
import { AgentName } from '../../backend/workspace-ui/src/ui/AgentName';
import { ContextRing } from '../../backend/workspace-ui/src/ui/ContextRing';
import type { HomeAgent } from '../../backend/workspace-ui/src/workspace/live';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { FACES, FLEET, HOUR, MINUTE, ago, useHydrated } from './live/fixture';
import { PanelTitle } from './live/PanelTitle';

/**
 * A conversation with an agent, live: the app's own `ChatMessageRow` for
 * every bubble, and the typing bubble the app shows while a turn runs. The
 * head and the pane are the chat screen's own markup, minus its Back and
 * Home buttons, since the screen itself owns polling, a session and a route.
 *
 * The rows are drawn only after hydration. A bubble carries its clock time,
 * and a clock is local: the build machine's "08:04" is the reader's "10:04",
 * which is precisely the kind of mismatch a prerender must not contain. The
 * frame — face, name, runtime, the typing bubble — is in the HTML; the words
 * follow a frame later.
 *
 * Two conversations use it: Ruby's, where a brief becomes a live service,
 * a benchmark and a proposal card, and Milo's, where another agent's
 * question lands in his own conversation and is answered there.
 */

export const RUBY = FLEET[0]!;
const MILO = FLEET[1]!;

export const RUBY_ROWS = (): WorkspaceChatMessage[] => [
  {
    seq: 1,
    role: 'owner',
    at: ago(2 * HOUR + 40 * MINUTE),
    text: 'Build the batch route optimiser. Monday’s 2,000-stop sample is in Drive. I want a full day’s routes for all 40 vans in under a minute, and a benchmark page I can show Harbour Freight.',
  },
  {
    seq: 2,
    role: 'agent',
    at: ago(2 * HOUR + 31 * MINUTE),
    text: 'Done — the optimiser is live behind the routing service, and the benchmark page is at https://routing.agents.northstar.com/bench.\n\n2,000 stops, 40 vans: **38 seconds**, and 11% fewer kilometres than the routes the dispatchers drew by hand.\n\nOne thing to decide: the two pharmacy accounts’ time windows. I used 30 minutes as a placeholder and flagged it in the proposal.',
  },
  {
    seq: 3,
    role: 'platform',
    at: ago(1 * HOUR + 50 * MINUTE),
    text: 'PR #41 ("Batch route optimiser for the routing service") in northstar-routing awaits your decision: batch-optimiser → main. 14 files, +1,240 −86 · checks passed. Nothing lands on your protected branch until you approve it.',
    open: { pr: 'pr_41' },
  },
  {
    seq: 4,
    role: 'owner',
    at: ago(6 * MINUTE),
    text: 'Next: the driver app has to keep working with no signal. Note #58 has what the pilot drivers said. Queue the GPS pings and sync when the phone is back.',
  },
  {
    seq: 5,
    role: 'agent',
    at: ago(5 * MINUTE),
    text: 'On it — reading note #58 now. I’ll branch off main, build the queue and the sync, run it against the tunnel recordings in Drive, and open a proposal when it passes on both phone platforms.',
  },
];

const MILO_ROWS = (): WorkspaceChatMessage[] => [
  {
    seq: 1,
    role: 'owner',
    at: ago(3 * HOUR + 10 * MINUTE),
    text: 'Hi Milo — you own billing. Read the architecture page first, then move invoicing to usage: per stop completed, metered in Stripe. Keep the old flat plans working until the pilot ends.',
  },
  {
    seq: 2,
    role: 'agent',
    at: ago(2 * HOUR + 57 * MINUTE),
    text: 'Done. Invoicing now meters completed stops per account from the pipeline’s daily totals and pushes them to Stripe every night.\n\n- The old flat plans stay on until the pilot ends\n- A dry-run invoice for every account is in Drive\n- Proposal #44 has the migration and its rollback',
  },
  {
    seq: 3,
    // A peer's message is stored as a platform row that names its sender;
    // the row draws it as an incoming bubble with Ruby's face on it.
    role: 'platform',
    at: ago(2 * HOUR + 3 * MINUTE),
    text: 'Message from agent Ruby: the batch optimiser changes how a van’s day ends — every route now finishes with the leg back to the depot. Should billing count the return leg, or only the stops?',
    fromAvatarUrl: FACES.ruby,
  },
  {
    seq: 4,
    role: 'agent',
    at: ago(2 * HOUR + 1 * MINUTE),
    text: 'Checked the pilot contract in Drive: billing is per stop completed, and the depot is not a stop — the return leg is never charged. The new routes change nothing on the invoice. Telling Ruby now.',
  },
];

function Conversation({ agent, rows: build, activity, says, className }: {
  agent: HomeAgent;
  rows: () => WorkspaceChatMessage[];
  activity?: string;
  says: string;
  className: string;
}) {
  const hydrated = useHydrated();
  const [rows] = useState(build);
  let lastDay = '';
  return (
    <LivePanel size="compact" className={className} says={says}>
      <LiveWorkspace>
        <div className="screen" id="screenAgentChat">
          <div className="chathead">
            <div className="chatface" id="agentChatFace">
              <ContextRing context={agent.context}><AgentFace agent={agent} /></ContextRing>
            </div>
            <div className="chatwho">
              <PanelTitle id="agentChatTitle"><AgentName agent={agent} /></PanelTitle>
              <div className="sub chatruntime" id="agentChatStatus"><span>{agentRuntimeLine(agent)}</span></div>
            </div>
          </div>
          <div className="chatpane" id="agentChatScroll">
            <div id="agentChatLog">
              {hydrated
                ? rows.map((row) => {
                  const day = new Date(row.at).toDateString();
                  const divider = day !== lastDay ? chatDayLabel(row.at) : '';
                  lastDay = day;
                  return (
                    <Fragment key={row.seq}>
                      {divider ? <div className="chatday">{divider}</div> : null}
                      <ChatMessageRow
                        row={row}
                        agentId={agent.id}
                        onOpenProposal={() => {}}
                        onOpenFile={() => {}}
                        onPictureLoaded={() => {}}
                      />
                    </Fragment>
                  );
                })
                : null}
            </div>
            {activity ? (
              <div className="chatlive" id="agentChatLive">
                <div className="chatmsg agent">
                  <span className="tdots"><i /><i /><i /></span>
                  <span className="activity" id="agentChatActivity">{activity}</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}

export default function LiveChat({ className = '' }: { className?: string }) {
  return (
    <Conversation
      agent={RUBY}
      rows={RUBY_ROWS}
      activity="Bash: npm test -- offline-queue"
      className={className}
      says="A conversation with Ruby: a plain-language brief for the batch route optimiser, her reply with the live benchmark and its numbers, the proposal card the Workspace wrote when she proposed the change, the next brief, and her acknowledgement while she works on it."
    />
  );
}

export function LivePeerChat({ className = '' }: { className?: string }) {
  return (
    <Conversation
      agent={MILO}
      rows={MILO_ROWS}
      className={className}
      says="Milo’s conversation: the brief to move invoicing to usage, his report, then a message from Ruby asking whether billing should count a van’s return leg, and his answer."
    />
  );
}
