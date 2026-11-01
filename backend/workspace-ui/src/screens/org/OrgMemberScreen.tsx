/**
 * One member (`/workplace/members/:id`): who they are, what they are
 * driving, and — for an admin — the role change and the removal, which live
 * here rather than on the list row because taking a person out deserves a
 * screen that says who they are first.
 *
 * It is one card of facts (note #346). It used to end in a second card that
 * listed the member's agents by name, face and latest-work line; what each
 * agent is DOING belongs to the person driving it, so that card went. Which
 * agents they drive does not (2026-09-23, the owner: a person's agents are
 * never hidden from the rest of the workplace), so the Agents row says the
 * count and then draws each one — face, name, room — as a door to its page.
 *
 * It opens on what this tab already knows (note #613): the workplace record
 * it last read, or — the usual way in, from a People plate — the people list
 * that plate was drawn from. Either way the read runs underneath and the
 * facts settle without a "Loading…" in between.
 */

import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { WorkspaceOrgRoleAnswer } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useConfirm } from '../../chrome/useConfirm.js';
import { useOrgApi } from './useOrgApi.js';
import { errorMessage } from '../../ui/format.js';
import { relative, useNow } from '../../ui/time.js';
import { toFor } from '../../routes.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { workplaceHasTeam } from './org-words.js';
import { personInitials } from '../../ui/initials.js';
import { contributionChangeAgo, contributionChangeFacts, formerAgentsLine, peopleClockMoves, personAgentCountLine, personAgentsInOrder, personAgentStateLine, personRecapAgo, personStatusLine } from './people-words.js';
import { ContributionStats } from './Contribution.js';
import { useMemberContribution } from './useMemberContribution.js';
import { dayWordsUtc } from '../people/board-words.js';
import { useOrgDetail } from './useOrgDetail.js';
import { heldOrgDetail, holdOrgDetail } from './org-detail-cache.js';
import { heldPeople, holdPeople } from './people-cache.js';
import { Svg } from '../../ui/icons.js';
import { AgentFace } from '../../ui/AgentFace.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

export function OrgMemberScreen() {
  const { id = '' } = useParams();
  const api = useOrgApi();
  const { state, reload } = useWorkspace();
  const banner = useBanner();
  const ask = useConfirm();
  const navigate = useNavigate();
  const { org: read, error, refresh } = useOrgDetail({ cached: true });
  const [search] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const orgId = read?.orgId ?? search.get('org') ?? state?.org?.orgId ?? '';
  // Until the record has ever been read here, the people list stands in: it
  // carries the same rows (one builder makes both) and the workplace's name
  // and the reader's role, which is all this screen draws.
  const people = read ? null : heldPeople(orgId);
  const org = read ?? (people ? { orgId: people.org.orgId, name: people.org.name, role: people.org.role, members: people.people } : null);
  const member = org?.members.find((entry) => entry.userId === id) ?? null;
  // Their whole contribution here (note #925), read beside the record.
  const contribution = useMemberContribution(member ? id : '');
  // Both readings on this card move on their own; one rule says whether.
  const now = useNow(peopleClockMoves(member ? [member] : []) || Boolean(contribution?.merged.length));

  if (!org) {
    return <div className="screen" id="screenOrgMember"><div className="card"><div className="empty">{error || 'Loading…'}</div></div></div>;
  }
  if (!member) {
    return <div className="screen" id="screenOrgMember"><div className="card"><div className="empty">They are not in this workplace any more.</div></div></div>;
  }

  const admins = org.members.filter((entry) => entry.role === 'admin');
  const lastAdmin = member.role === 'admin' && admins.length === 1;
  /** A workplace of one nobody can join (note #205, workplaceHasTeam): the
   *  page names no role and offers no role change. */
  const rolesHidden = !workplaceHasTeam({ members: org.members.length }, state?.invitesClosed);
  const canChangeRole = org.role === 'admin' && !lastAdmin && !rolesHidden;
  const removable = org.role === 'admin' && !member.you && !lastAdmin;
  const nextRole: 'admin' | 'member' = member.role === 'admin' ? 'member' : 'admin';
  const here = Boolean(member.here);
  // Seen only when it says something Joined does not: someone never stamped
  // falls back to "Joined 6h ago", and two rows saying 6h ago is one row
  // read twice (note #613).
  const seenKnown = here || Boolean(member.lastSeenAt);
  const recapAgo = personRecapAgo(member, now);
  const canMessage = !member.you && Boolean(state?.messagesAvailable);
  // Back to the People page, where this screen is opened from (note #328):
  // a replace, so Back never reopens a record the server would now refuse.
  const backToPeople = () => navigate(toFor({ kind: 'organizationPeople', orgId })!, { replace: true });

  const changeRole = async () => {
    const sure = await ask(nextRole === 'admin'
      ? {
        title: `Make ${member.name} an admin?`,
        message: 'An admin can invite and remove people, change roles, and manage the workplace itself.',
        verb: 'Make an admin',
      }
      : {
        title: `Change ${member.name} to a member?`,
        message: 'They keep their agents and their work — only what they can manage changes.',
        verb: 'Change to a member',
      });
    if (!sure) return;
    setBusy(true);
    try {
      await api.api<WorkspaceOrgRoleAnswer>(`api/org/members/${encodeURIComponent(member.userId)}/role`, jsonBody({ role: nextRole }));
      await refresh();
      // The People page opens on its held list; let it open on the new role.
      const heldList = heldPeople(orgId);
      if (heldList) holdPeople(orgId, { ...heldList, people: heldList.people.map((entry) => (entry.userId === member.userId ? { ...entry, role: nextRole } : entry)) });
      await reload();
      banner.show(`${member.name} is now ${nextRole === 'admin' ? 'an admin.' : 'a member.'}`, true);
      backToPeople();
    } catch (err) { banner.show(errorMessage(err)); setBusy(false); }
  };

  const remove = async () => {
    const sure = await ask({
      title: `Remove ${member.name} from ${org.name}?`,
      message: 'Their agents in this workplace are permanently retired. Their private sign-ins stay theirs.',
      verb: 'Remove',
      danger: true,
    });
    if (!sure) return;
    setBusy(true);
    try {
      await api.api(`api/org/members/${encodeURIComponent(member.userId)}`, { method: 'DELETE' });
      // Out of every copy this tab holds, so neither People nor this screen
      // opens on them again while the next read is still on its way.
      const heldRecord = heldOrgDetail(orgId);
      if (heldRecord) holdOrgDetail(orgId, { ...heldRecord, members: heldRecord.members.filter((entry) => entry.userId !== member.userId) });
      const heldList = heldPeople(orgId);
      if (heldList) holdPeople(orgId, { ...heldList, people: heldList.people.filter((entry) => entry.userId !== member.userId) });
      banner.show(`Removed ${member.name} from ${org.name}.`, true);
      await reload();
      backToPeople();
    } catch (err) { banner.show(errorMessage(err)); setBusy(false); }
  };

  return (
    <div className="screen" id="screenOrgMember">
      <ScreenTitle
        // Their picture, else their initials as their card wears them (note #833).
        mark={member.photoUrl
          ? <img className="aface" id="orgMemberFace" alt="" src={member.photoUrl} />
          : personInitials(member.name) ? <span className="aface initials" id="orgMemberFace" aria-hidden="true">{personInitials(member.name)}</span> : null}
        titleId="orgMemberTitle"
        title={member.name}
        subId="orgMemberSub"
        sub={<>{rolesHidden ? org.name : `${member.role === 'admin' ? 'Admin' : 'Member'} of ${org.name}`}{member.you ? ' — this is you' : ''}</>}
      />
      <div className="card" id="orgMemberCard">
        {/* Presence first, and marked the way their plate marks it — the same
            breathing disc, so "here now" is the same fact on both screens.
            No Role row: the line under the name above already says it, and a
            card that repeats its own header is a card nobody reads twice. */}
        {seenKnown
          ? (
            <div className="drow">
              <div className="k">Seen</div>
              <div className="v livevalue">
                {here ? <span className="livedot" /> : null}
                <span>{personStatusLine(member, now)}</span>
              </div>
            </div>
          )
          : null}
        {/* The latest thing they drove, and WHEN — the plate's own pair
            (note #385), so the card a plate opens says no less than it did. */}
        {member.recap
          ? (
            <div className="drow">
              <div className="k">Latest</div>
              <div className="v">{member.recap}</div>
              {recapAgo ? <div className="cago">{recapAgo}</div> : null}
            </div>
          )
          : null}
        {/* Where to reach them (note #626) — sent to everyone in the
            workplace (note #632). A tap writes to them from the Workspace's
            own mail, not from whatever mail app the device happens to have. */}
        {member.email
          ? (
            <div className="drow" id="orgMemberEmail">
              <div className="k">Email</div>
              <button className="v act" type="button" onClick={() => navigate(toFor({ kind: 'mail' })!, { state: { writeTo: member.email } })}>
                {member.email}
              </button>
            </div>
          )
          : null}
        {/* How many, and which (2026-09-23): each agent's face and name, a
            door to its page — theirs read-only, the reader's own its
            control room — and since 2026-10-28 what it is doing: Working or
            Idle, and its latest-work recap. (The room it worked in, until
            rooms left the product — note #843.) */}
        <div className="drow" id="orgMemberAgents">
          <div className="k">Agents</div>
          <div className="v">{personAgentCountLine(member.agents)}</div>
          {member.agentFaces?.length
            ? (
              <ul className="memberagents">
                {personAgentsInOrder(member.agentFaces).map((agent) => (
                  <li key={agent.id}>
                    <button
                      className="memberagent"
                      type="button"
                      data-member-agent={agent.id}
                      aria-label={`Open ${agent.name}, ${personAgentStateLine(agent).toLowerCase()}`}
                      onClick={() => navigate(toFor({ kind: 'agent', id: agent.id })!)}
                    >
                      <AgentFace agent={agent} />
                      <span className="mname">{agent.name}</span>
                      <span className={agent.working ? 'mstate busy' : 'mstate'}>
                        {agent.working ? <span className="livedot" /> : null}
                        {personAgentStateLine(agent)}
                      </span>
                      {agent.recap ? <span className="mrecap">{agent.recap}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )
            : null}
        </div>
        {/* When and by whom, as one fact: they are the same moment. */}
        <div className="drow" id="orgMemberJoined">
          <div className="k">Joined</div>
          <div className="v">
            {relative(member.joinedAt) || 'just now'}
            {member.invitedByName ? <span className="dim"> · invited by {member.invitedByName}</span> : null}
          </div>
        </div>
      </div>
      {/* What their agents did here (note #925): this week, all time, and
          every change merged this week — what it was, which agent made it,
          when — each a door to the proposal. Every member reads every
          member's; nothing of it leaves the workplace. The week stands at
          once from the card's own numbers; the rest settles with the read. */}
      <div className="card" id="orgMemberContribution">
        <div className="drow" id="orgMemberWeek">
          <div className="k">This week</div>
          <ContributionStats numbers={contribution?.week ?? member.contribution?.week ?? { workingMs: 0, merged: 0, tokens: {} }} />
        </div>
        {/* For life (note #644's "Agents worked", whose hours these are):
            deleted agents' hours included, and those agents named under it,
            since this row is the one place their time is still visible. */}
        <div className="drow" id="orgMemberWorked">
          <div className="k">All time</div>
          <ContributionStats numbers={{ ...(contribution?.allTime ?? { merged: 0, tokens: {} }), workingMs: member.workedMs }} />
          {formerAgentsLine(member) ? <div className="cago">{formerAgentsLine(member)}</div> : null}
          {contribution ? <div className="cago">Tokens counted since {dayWordsUtc(contribution.tokensFrom)}.</div> : null}
        </div>
        <div className="drow" id="orgMemberMerged">
          <div className="k">Merged this week</div>
          {contribution?.merged.length
            ? (
              <ul className="memberchanges">
                {contribution.merged.map((change) => (
                  <li key={change.id}>
                    <button
                      className="memberchange"
                      type="button"
                      data-change={change.id}
                      onClick={() => navigate(toFor({ kind: 'pr', id: change.id })!)}
                    >
                      <span className="mctitle">{change.title}</span>
                      <span className="mcfacts">{contributionChangeFacts(change)}</span>
                      <span className="mcago">{contributionChangeAgo(change, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
            : <div className="v dim">{contribution ? 'Nothing merged yet this week.' : '…'}</div>}
        </div>
      </div>
      {/* What you can do WITH them, as rows of one card — the same row the
          message door already was, so a role change is not a loose word
          floating in a box of its own (note #613). */}
      {canMessage || canChangeRole
        ? (
          <div className="card" id="orgMemberActions">
            {canMessage
              ? (
                <button className="addrow cardtop" type="button" onClick={() => navigate(toFor({ kind: 'directMessage', id: member.userId, orgId })!)}>
                  <Svg name="send" size={20} />Message {member.name}
                </button>
              )
              : null}
            {canChangeRole
              ? (
                <button className={`addrow${canMessage ? '' : ' cardtop'}`} type="button" disabled={busy} onClick={() => { void changeRole(); }}>
                  <Svg name="shield" size={20} />{nextRole === 'admin' ? 'Make admin' : 'Make member'}
                </button>
              )
              : null}
          </div>
        )
        : null}
      {/* Taking a person out stands at the foot of the screen, apart from
          everything else, the way deleting an agent or a workplace does. */}
      {removable
        ? (
          <div id="orgMemberDanger">
            <button className="btn danger bare" type="button" disabled={busy} onClick={() => { void remove(); }}>
              Remove from workplace
            </button>
          </div>
        )
        : null}
    </div>
  );
}
