import { useState } from 'react';
import type { WorkspaceCheckRow } from '../../backend/src/shared/workspace-api';
import { Markdown } from '../../backend/workspace-ui/src/render/Markdown';
import { useNoteRefs } from '../../backend/workspace-ui/src/render/useNoteRefs';
import { ChecksRow, SummaryRow } from '../../backend/workspace-ui/src/screens/decisions/Checks';
import { DecideBar } from '../../backend/workspace-ui/src/screens/decisions/DecideBar';
import { FoldLong } from '../../backend/workspace-ui/src/screens/decisions/FoldLong';
import { ChatDoor, ProposalEyebrow, ProposalPills, ProposalWho } from '../../backend/workspace-ui/src/screens/decisions/ProposalHead';
import { agentSignature, approveHint, runtimeLine, statusPill } from '../../backend/workspace-ui/src/screens/decisions/proposal-words';
import { relative, useNow } from '../../backend/workspace-ui/src/ui/time';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { FACES, HOUR, MINUTE, ago, useHydrated } from './live/fixture';

/**
 * A proposal, live: the top of the proposal screen as the app draws it —
 * title and eyebrow, the status pill and branches, who proposed it and with
 * what, the door to their chat, the write-up in the app's own Markdown, the
 * summary card with the files, commits and checks, the hint under it, and
 * the Approve / Reject bar. Every piece is the screen's own component; the
 * lines the screen composes inline (the title row, the file count and diff
 * stat) are copied here in its own classes.
 *
 * The decide bar is fixed to the viewport in the app — it is the bottom of
 * the phone. Inside the fence it stands at the foot of the card instead
 * (index.css), which is where it is on the screen it belongs to.
 */

const PR = {
  id: 'pr_41',
  number: 41,
  repoName: 'northstar-routing',
  title: 'Batch route optimiser for the routing service',
  from: 'batch-optimiser',
  to: 'main',
  status: 'open',
  draft: undefined,
  decidedAt: null,
  agentName: 'Ruby',
  agentId: 'agent_ruby',
  agentAvatarUrl: FACES.ruby,
  userName: 'James',
  agentRuntime: { cli: 'claude', model: 'opus', effort: 'high' },
  files: 14,
  diffStat: { insertions: 1240, deletions: 86 },
  commits: 6,
  body: 'Implements note #57.\n\n**What changed**\n\nA batch optimiser in the routing service: give it a day’s stops and the vans on shift, and it returns every van’s route in one call. Time windows, van capacity and driver breaks are hard constraints; kilometres are what it minimises.\n\nBenchmark on Monday’s 2,000-stop sample: **38 seconds for 40 vans**, 11% fewer kilometres than the routes the dispatchers drew by hand. The benchmark page is at `/bench` and reruns on every push.\n\n**Still to decide:** the time window for the two pharmacy accounts is a 30-minute placeholder; the contract may say 15.',
};

function Panel() {
  const hydrated = useHydrated();
  const now = useNow(false);
  const [createdAt] = useState(() => ago(1 * HOUR + 50 * MINUTE));
  const [checks] = useState<WorkspaceCheckRow[]>(() => [{
    context: 'ci',
    state: 'success',
    description: 'Build, clippy and 212 tests passed',
    startedAt: ago(1 * HOUR + 49 * MINUTE),
    completedAt: ago(1 * HOUR + 48 * MINUTE),
  }]);
  const notes = useNoteRefs();
  const pill = statusPill(PR, false, '');
  const signed = agentSignature(PR.agentName, PR.userName);
  const authored = relative(createdAt, now);
  return (
    <div className="screen" id="screenPr">
      {/* The real screen portals this block into PageHead, whose bottom
          hairline closes the title and eyebrow off from the proposal. This
          landing fence has no persistent chrome, so it draws that same end
          edge around the copied head instead. */}
      <div className="landing-page-head">
        <div className="phead">
          <div className="pname">
            <h1 id="prTitle">{PR.title}</h1>
            <ProposalEyebrow repoName={PR.repoName} repoTo={null} number={PR.number} notes={[{ number: 57 }]} />
          </div>
        </div>
      </div>
      <ProposalPills pill={pill} to={PR.to} from={PR.from} />
      <ProposalWho
        id="prWho"
        avatarUrl={PR.agentAvatarUrl}
        agentId={PR.agentId}
        agentName={PR.agentName}
        line={`${signed} proposed this${authored ? ` · ${authored}` : ''}`}
        runtime={runtimeLine(PR.agentRuntime)}
      />
      <ChatDoor id="prChat" onPress={() => {}} />
      <div id="prBody">
        {/* The write-up folds past 340px after a measurement in an effect; the
            server has no layout to measure, so it renders open on both sides
            and folds on the client once hydrated, the way the app does. */}
        {hydrated
          ? <FoldLong contentKey={PR.body}><Markdown source={PR.body} notes={notes} /></FoldLong>
          : <div className="mdwrap"><Markdown source={PR.body} notes={notes} /></div>}
        <div className="card" id="prSummary">
          <SummaryRow
            glyph="filecode"
            name={`${PR.files} files changed`}
            side={<span className="stat"><span className="plus">+{PR.diffStat.insertions}</span><span className="minus">−{PR.diffStat.deletions}</span></span>}
            opens
          />
          <SummaryRow glyph="commit" name={`${PR.commits} commits`} opens />
          <ChecksRow checks={checks} />
        </div>
        <div className="hintline" id="prHint">{approveHint({ from: PR.from, to: PR.to, requireChecks: true }, checks)}</div>
      </div>
      <DecideBar approveLabel="Approve & merge" onDecide={() => {}} />
    </div>
  );
}

export default function LiveProposal({ className = '' }: { className?: string }) {
  return (
    <LivePanel
      size="tile"
      className={className}
      says="Proposal #41 in northstar-routing, waiting for you: Ruby proposed it from branch batch-optimiser into main; her write-up with the benchmark, fourteen files changed, six commits, checks passed, and the Approve and Reject buttons."
    >
      <LiveWorkspace>
        <Panel />
      </LiveWorkspace>
    </LivePanel>
  );
}
