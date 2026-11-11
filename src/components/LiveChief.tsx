import { Fragment, useState } from 'react';
import type { WorkspaceProposalRow } from '../../backend/src/shared/workspace-api';
import type { RecapRowView } from '../../backend/src/shared/recap-chat-rows';
import { chatDayLabel } from '../../backend/workspace-ui/src/screens/chat/chat-notice';
import { ChatMessageRow } from '../../backend/workspace-ui/src/screens/chat/ChatMessageRow';
import type { TranscriptRow } from '../../backend/workspace-ui/src/screens/chat/transcript';
import { DidLine, NoticedLine } from '../../backend/workspace-ui/src/screens/home/RecapRows';
import { CHIEF_OF_STAFF } from '../../backend/workspace-ui/src/ui/chief-of-staff';
import { AgentFace } from '../../backend/workspace-ui/src/ui/AgentFace';
import { ContextRing } from '../../backend/workspace-ui/src/ui/ContextRing';
import { Svg } from '../../backend/workspace-ui/src/ui/icons';
import { RoomFaces } from '../../backend/workspace-ui/src/ui/RoomFaces';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { FACES, HERO_FLEET, HOUR, MINUTE, ago, useHydrated } from './live/fixture';
import { PanelTitle } from './live/PanelTitle';

/**
 * Home, live: the Chief of Staff's conversation (note #715), drawn with the
 * screen's own pieces — `ChatMessageRow` for the words and the forwarded
 * proposal cards (note #724), `DidLine` for what it did on James's behalf,
 * `NoticedLine` for what the platform noticed and it spoke up about (note
 * #716). One ask from James, the fleet put to work, two decisions brought
 * back as cards, and one thing done on its own: the whole pitch of the
 * section beside it, in one screen.
 *
 * The rows wait for hydration like every chat on the page (a bubble carries
 * a local clock); the head and the composer are in the HTML.
 */

/** The face the product gives every Chief of Staff by default (workspace-agent.jpg). */
const CHIEF = { avatarUrl: '/agent-avatars/workspace-agent.jpg' };
const CONTEXT = { usedPercent: 21, tokens: 42_000, window: 200_000, at: '2026-09-06T08:40:00.000Z' };

/** Two of Home's own queue, as the Chief of Staff forwarded them: the proposal
 *  row every other list draws, under a label. */
const VAN_MAP: WorkspaceProposalRow = {
  id: 'pr_43',
  number: 43,
  repoName: 'northstar-dispatch',
  title: 'Live van map with ETAs on the dispatcher screen',
  body: null,
  from: 'live-van-map',
  to: 'main',
  diffStat: { insertions: 498, deletions: 57 },
  status: 'open',
  createdAt: ago(55 * MINUTE),
  decidedAt: null,
  agentName: 'Ada',
  agentAvatarUrl: FACES.ada,
  agentId: 'agent_ada',
  userName: 'James',
  canDecide: true,
  checks: { total: 2, failing: 0, pending: 0, worst: 'success' },
};

type Line =
  | { seq: number; at: string; row: TranscriptRow }
  | { seq: number; at: string; did: Extract<RecapRowView, { form: 'did' }> }
  | { seq: number; at: string; noticed: string };

const LINES = (): Line[] => [
  {
    seq: 1, at: ago(3 * HOUR + 20 * MINUTE),
    row: {
      seq: 1, role: 'owner', at: ago(3 * HOUR + 20 * MINUTE),
      text: 'Harbour Freight’s pilot starts Friday. Get us ready: on-call alerts, the live van map and a rollback rehearsal.',
    },
  },
  {
    seq: 2, at: ago(3 * HOUR + 18 * MINUTE),
    did: { form: 'did', parts: ['Sent to ', { agent: 'Otis' }], body: 'Before Friday’s pilot: alerts on the pings pipeline (lag, dropped pings, a stalled partition job) and an on-call page in knowledge saying what each one means and what to do.' },
  },
  {
    seq: 3, at: ago(3 * HOUR + 18 * MINUTE),
    did: { form: 'did', parts: ['Sent to ', { agent: 'Ada' }], body: 'The dispatcher screen needs the live van map with ETAs for Friday’s pilot. Note #58 has what the drivers said about signal. Open a proposal against northstar-dispatch when it passes.' },
  },
  {
    seq: 4, at: ago(3 * HOUR + 16 * MINUTE),
    row: {
      seq: 4, role: 'agent', at: ago(3 * HOUR + 16 * MINUTE),
      text: 'Otis has the alerts, Ada the van map. I brought Theo in for the rollback. I’ll bring you what needs a decision.',
    },
  },
  {
    seq: 5, at: ago(48 * MINUTE),
    row: {
      seq: 5, role: 'platform', at: ago(48 * MINUTE),
      text: 'Forwarded PR #43 in northstar-dispatch.',
      forwarded: [
        { kind: 'pr', id: 'pr_43', pr: VAN_MAP },
      ],
    },
  },
  {
    seq: 6, at: ago(47 * MINUTE),
    row: {
      seq: 6, role: 'agent', at: ago(47 * MINUTE),
      text: 'One for you, checks green. Otis’s on-call page is live in knowledge, and Theo’s rollback rehearsal passed in 48 seconds.',
    },
  },
  {
    seq: 7, at: ago(9 * MINUTE),
    noticed: 'Note #59 has waited two days with nobody on it.',
  },
  {
    seq: 8, at: ago(9 * MINUTE),
    did: { form: 'did', own: true, parts: ['Handed note #59 to ', { agent: 'Otis' }] },
  },
];

function Screen() {
  const hydrated = useHydrated();
  const [lines] = useState(LINES);
  let lastDay = '';
  return (
    <div className="screen" id="screenHome">
      <div className="chathead">
        <span className="chatface chatagent" id="recapChatFace" aria-hidden="true">
          <ContextRing context={CONTEXT}><AgentFace agent={CHIEF} /></ContextRing>
        </span>
        <div className="chatwho">
          <PanelTitle id="recapChatTitle">{CHIEF_OF_STAFF}</PanelTitle>
          <div className="sub chatruntime" id="recapChatRuntime"><span>opus · high</span></div>
        </div>
      </div>
      <div className="chatpane" id="recapChatScroll">
        <div id="recapChatLog" className="chatlog">
          {hydrated
            ? lines.map((line) => {
              const day = new Date(line.at).toDateString();
              const divider = day !== lastDay ? chatDayLabel(line.at) : '';
              lastDay = day;
              return (
                <Fragment key={line.seq}>
                  {divider ? <div className="chatday">{divider}</div> : null}
                  {'did' in line
                    ? <DidLine view={line.did} at={line.at} />
                    : 'noticed' in line
                      ? <NoticedLine text={line.noticed} at={line.at} />
                      : (
                        <ChatMessageRow
                          row={line.row}
                          agentId="workspace-agent"
                          workspaceLinks
                          onOpenProposal={() => {}}
                          onOpenFile={() => {}}
                          onPictureLoaded={() => {}}
                        />
                      )}
                </Fragment>
              );
            })
            : null}
        </div>
      </div>
      <form className="chatbar" onSubmit={(event) => event.preventDefault()}>
        <div className="row">
          <button className="chatagents" type="button" tabIndex={-1} aria-label="Your agents">
            <RoomFaces agents={HERO_FLEET.slice(0, 3)} counted={false} />
          </button>
          <div className="chatinput">
            <button className="chatattach" type="button" tabIndex={-1} aria-label="Attach files"><Svg name="attach" size={20} /></button>
            <div className="voicefield">
              <textarea id="recapChatText" rows={1} placeholder="Message" readOnly value="" />
              <button className="voicebtn" type="button" tabIndex={-1} aria-label="Dictate"><Svg name="mic" size={18} /></button>
            </div>
          </div>
          <button className="chatsend" type="submit" aria-label="Send" disabled><Svg name="send" size={19} /></button>
        </div>
      </form>
    </div>
  );
}

export default function LiveChief({ className = '' }: { className?: string }) {
  return (
    <LivePanel
      size="compact"
      className={className}
      says="The Chief of Staff’s conversation, the first screen of the Workspace: James asks for the platform to be ready for Friday’s pilot; the Chief of Staff sends the work to Otis and Ada and brings Theo in for the rollback, later forwards Ada’s proposal as a card for James to decide and says Otis’s on-call page is live in knowledge, and on its own hands an unclaimed note to Otis."
    >
      <LiveWorkspace><Screen /></LiveWorkspace>
    </LivePanel>
  );
}
