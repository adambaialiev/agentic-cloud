/**
 * SOMEBODY ELSE'S AGENT (note #640).
 *
 * Every face in this workplace is a door now — a knowledge page's row, a
 * note, a remark in a margin, a site — and most of the agents behind those
 * faces belong to a teammate. The reader's own agent opens `AgentScreen`, the
 * control room: runtime, machine, chat, delete. A teammate's opens this.
 *
 * It is a SMALL screen on purpose, the same trade the Workspace Agent's own
 * screen makes: not `AgentScreen` with its controls greyed out, which would
 * be a page of things the reader may not do, but the facts the workplace can
 * already see — what it is, what it runs, who drives it, and what it last
 * did. (Which room it worked in, too, until rooms left the product — note
 * #843.) A greyed-out Delete on a colleague's agent is
 * worse than no Delete at all.
 *
 * What is deliberately NOT here: its machine, its version, its chat, its
 * proposals, and the live narration of a turn in progress. Those belong to
 * the person driving it (note #346) — the reader gets the state, which is
 * what "can I expect an answer from this one today" actually asks.
 *
 * It also stands in for an agent of the reader's OWN that this device's
 * fleet is not carrying — one being deleted, a list read that has not landed
 * — because the route picks the screen off that fleet. It says so in place
 * of the "whose is this" line, and sends them to the fleet for the controls:
 * redirecting would land on the address that chose this screen.
 */

import { overviewTo } from '../home/home-address.js';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { WorkspaceAgentCardAnswer } from '../../../../src/shared/workspace-api.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { AgentFace } from '../../ui/AgentFace.js';
import { errorMessage } from '../../ui/format.js';
import { readOrSayWhy, worthAskingAgain } from '../../ui/read.js';
import { relative, useNow } from '../../ui/time.js';
import { useOrgId } from '../org/useOrgApi.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { agentPresence, agentRuntimeLine } from '../home/agent-words.js';
import { otherAgentAbout, otherAgentOwnerLabel } from './other-agent-words.js';

/** One fact, in the shape the Workspace Agent's own screen uses — a key, a
 *  value, and where the value is a place, the door to it. */
function Fact({ label, value, note, onPress }: {
  label: string;
  value: string;
  note?: string;
  onPress?: () => void;
}) {
  return (
    <div className="drow">
      <div className="k">{label}</div>
      {onPress
        ? <button className="v person act" type="button" onClick={onPress}><span>{value}</span></button>
        : <div className="v">{value}</div>}
      {note ? <div className="v dim">{note}</div> : null}
    </div>
  );
}

export function OtherAgentScreen() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const orgId = useOrgId();
  const [card, setCard] = useState<WorkspaceAgentCardAnswer | null>(null);
  const [failed, setFailed] = useState<{ said: string; retry: boolean } | null>(null);

  const read = useCallback(async () => {
    try {
      const answer = await readOrSayWhy<WorkspaceAgentCardAnswer>(
        (init) => api.api(`api/agents/${encodeURIComponent(id)}/card`, init),
      );
      setCard(answer);
      setFailed(null);
    } catch (failure) {
      setFailed({ said: errorMessage(failure), retry: worthAskingAgain(failure) });
    }
  }, [api, id]);
  useEffect(() => { void read(); }, [read]);

  const agent = card?.agent;
  const now = useNow(false);
  const presence = agent ? agentPresence(agent) : null;
  const recap = agent?.recap ?? '';
  const active = agent?.lastActiveAt ? relative(agent.lastActiveAt, now) : '';
  const made = agent?.createdAt ? relative(agent.createdAt, now) : '';
  const ownerTo = card?.owner.userId && orgId
    ? toFor({ kind: 'organizationMember', id: card.owner.userId, orgId })
    : null;
  const ownerName = card?.owner.name ?? 'A teammate';

  if (failed) {
    return (
      <div className="screen" id="screenOtherAgent">
        <div className="card authpanel" role="alert" id="otherAgentGone">
          <h2>That agent is not here</h2>
          <div className="authsub">{failed.said}</div>
          {failed.retry
            ? <button className="btn primary" type="button" onClick={() => { setFailed(null); void read(); }}>Try again</button>
            : <button className="btn primary" type="button" onClick={() => navigate(overviewTo(state?.org?.orgId, { half: 'agents' }))}>Back to your agents</button>}
        </div>
      </div>
    );
  }
  if (!agent) {
    return <div className="screen" id="screenOtherAgent" aria-busy="true"><div id="loading"><span className="sr-only">Loading…</span></div></div>;
  }
  return (
    <div className="screen" id="screenOtherAgent">
      <ScreenTitle
        markId="otherAgentFace"
        mark={<AgentFace agent={{ avatarUrl: agent.avatarUrl, status: agent.status }} />}
        titleId="otherAgentTitle"
        title={agent.name}
        subId="otherAgentRuntime"
        sub={agentRuntimeLine(agent)}
      />
      {/* WHOSE it is, first and in plain words: the reader is standing on a
          page with no buttons, and the reason is not that something failed. */}
      <div className="asays" id="otherAgentAbout">{otherAgentAbout(card.owner.name, card.yours)}</div>
      <div className="card" id="otherAgentFacts">
        {presence
          ? (
            <div className="drow" id="otherAgentState">
              <div className="k">State</div>
              <div className="v">
                <span className={`headstate ${presence.tone}`}>
                  <span className="statedot" />
                  <span className="statetext">{presence.label}</span>
                </span>
              </div>
            </div>
          )
          : null}
        {/* What it last DID, high on the card: it is the fact that tells one
            face from another (note #295) and the reason a reader opens
            somebody else's agent at all — `Codex · high` names a runtime,
            not an agent. */}
        {recap
          ? (
            <div className="drow" id="otherAgentWork">
              <div className="k">Latest work</div>
              <div className="v">{recap}</div>
              {agent.recapAt ? <div className="v dim">{relative(agent.recapAt, now)}</div> : null}
            </div>
          )
          : null}
        {/* WHO DRIVES IT, their own face beside their name and a door to
            their page — the same row, drawn the same way, as on the reader's
            own agent screen. A member who has set no picture is named alone
            there and is named alone here. */}
        <div className="drow" id="otherAgentOwner">
          <div className="k">{otherAgentOwnerLabel}</div>
          {ownerTo
            ? (
              <button className="v person act" type="button" onClick={() => navigate(ownerTo)}>
                {card.owner.photoUrl ? <img className="aface small" src={card.owner.photoUrl} alt="" /> : null}
                <span>{ownerName}</span>
              </button>
            )
            : (
              <div className="v person">
                {card.owner.photoUrl ? <img className="aface small" src={card.owner.photoUrl} alt="" /> : null}
                <span>{ownerName}</span>
              </div>
            )}
        </div>
        {active ? <Fact label="Last active" value={active} /> : null}
        {made ? <Fact label="Made" value={made} /> : null}
      </div>
    </div>
  );
}
