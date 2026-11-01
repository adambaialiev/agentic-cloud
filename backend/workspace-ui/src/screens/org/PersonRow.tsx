/**
 * One person's card (note #328), redesigned on note #833 (Adam, 2026-10-29:
 * "all UI elements should be less sloppy … just redesign this").
 *
 * The HEAD is one row: the face (their picture, or their initials on the
 * accent's soft tint — never the grey outline of a person), then the name
 * with "You" and "Admin" as quiet words beside it, and under the name their
 * presence — "Here now" with the live dot, else "Active 4m ago", else when
 * they joined — in the same face and size as everything else on the card.
 * At the head's far end, level with the name, the way to message them
 * (PR #1476): a round send mark with its tooltip. Nothing is in monospace:
 * a person's role is not a machine spec, which is what the agents' plates
 * keep that face for. "No agents" is not said at all; an empty fact reads
 * as an error. The card stands on the plates' own grey, as the agents' do
 * (Adam: "let's not make cards white").
 *
 * Under the head, the last thing they did and when; then what their agents
 * did here this week (note #925) — agent hours, changes merged, tokens
 * written per provider and the latest change's title (`PersonContribution`);
 * then their agents — one line each, face, name, the blue dot when it is
 * working (no word since 31 Oct 2026) or "Idle", and the agent's recap
 * (2026-10-28), working ones first, three and then "+N more agents".
 * Everything under the head stands at the card's own left edge, as the
 * agents do (Adam, 31 Oct 2026, of the 46px indent under the name: "the
 * main thing that I don't like is left big margin").
 *
 * The plate is a door to the person; each agent line a door to its agent
 * (`data-agent-door`) and the send mark a door to the conversation
 * (`data-row-door`), both read by the pressable row, so the markup keeps one
 * tab stop and one name.
 *
 * The card stands on Home's Workplace window and on the People page, so it
 * lives here rather than inside either of them. The public front page's
 * moving row keeps the card as it was (`PersonFacesPlate`).
 */

import type { WorkspaceOrgMember } from '../../../../src/shared/workspace-api.js';
import { PersonFace } from '../../ui/PersonFace.js';
import { AGENT_DOOR_ATTR, ROW_DOOR_ATTR } from '../../ui/FaceDoor.js';
import { Icon, Svg } from '../../ui/icons.js';
import { PressableRow } from '../home/PressableRow.js';
import { PersonContribution } from './Contribution.js';
import { personAgentsInOrder, personAgentStateLine, personRecapAgo, personStatusLine } from './people-words.js';

/** Agents on a plate before the rest become a count: three lines with a
 *  recap each keep a card a glance, not a page. */
export const PERSON_AGENTS_SHOWN = 3;

export function PersonRow({ person, now, onOpen, showRole = true, messageTo }: {
  person: WorkspaceOrgMember;
  now: number;
  onOpen: () => void;
  /** The address of a conversation with this person, when the workplace
   *  offers messages and the plate is somebody else's. */
  messageTo?: string | null;
  /** False in a workplace of one nobody can join (note #205): no role is named. */
  showRole?: boolean;
}) {
  const here = Boolean(person.here);
  // WHEN the latest line happened (note #385), after it on the same line.
  const ago = personRecapAgo(person, now);
  const agents = personAgentsInOrder(person.agentFaces ?? []);
  const shown = agents.slice(0, PERSON_AGENTS_SHOWN);
  const more = agents.length - shown.length;
  const admin = showRole && person.role === 'admin';
  return (
    <PressableRow className="crow open personplate" data-person={person.userId} onPress={onOpen}>
      <div className="personhead">
        <PersonFace photoUrl={person.photoUrl} name={person.name} />
        <div className="personwho">
          <div className="personname">
            <span className="name plain">{person.name}</span>
            {person.you ? <span className="badge mut">You</span> : null}
            {admin ? <span className="badge mut">Admin</span> : null}
          </div>
          <div className={here ? 'cline personstate here' : 'cline personstate'}>
            {here ? <span className="livedot" /> : null}
            <span className="ctext">{personStatusLine(person, now)}</span>
          </div>
        </div>
        {messageTo
          ? (
            <span className="iconbox cmsgdoor" title={`Message ${person.name}`} aria-hidden="true" {...{ [ROW_DOOR_ATTR]: messageTo }}>
              <Svg name="send" size={15} />
            </span>
          )
          : null}
      </div>
      {person.recap
        ? (
          <div className="personlatest">
            {/* The stamp rides the last word (a no-break space before the
                dot), so it never opens a line of its own. */}
            <span className="cabout">{person.recap}</span>
            {ago ? <><span className="csep" aria-hidden="true">{'\u00a0·\u00a0'}</span><span className="cago">{ago.replace(/ /g, '\u00a0')}</span></> : null}
          </div>
        )
        : null}
      {person.contribution ? <PersonContribution contribution={person.contribution} now={now} /> : null}
      {shown.length
        ? (
          <ul className="cagents" aria-label={`${person.you ? 'Your' : `${person.name}’s`} agents`}>
            {shown.map((agent) => (
              <li className="cagent" key={agent.id} data-agent={agent.id} {...{ [AGENT_DOOR_ATTR]: agent.id }}>
                <span className="cagenthead">
                  {agent.avatarUrl
                    ? <img className="face" src={agent.avatarUrl} alt="" />
                    : <span className="face dot"><Icon name="bot" size={11} /></span>}
                  <span className="caname">{agent.name}</span>
                  {/* Working is the blue dot alone (Adam, 31 Oct 2026: "Blue
                      dot is enough"); Idle keeps its word. The dot carries
                      the word for a screen reader and a resting mouse. */}
                  <span className={agent.working ? 'castate busy' : 'castate'}>
                    {agent.working
                      ? <span className="livedot" role="img" aria-label={personAgentStateLine(agent)} title={personAgentStateLine(agent)} />
                      : personAgentStateLine(agent)}
                  </span>
                </span>
                {agent.recap ? <span className="carecap">{agent.recap}</span> : null}
              </li>
            ))}
            {more ? <li className="cagentmore">+{more} more {more === 1 ? 'agent' : 'agents'}</li> : null}
          </ul>
        )
        : null}
    </PressableRow>
  );
}
