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
 * Under the head, the last thing THEY did and when (`personLatestLine`, the
 * one rule the member's screen uses too, note #1009); then what their agents
 * did here this week (note #925) — agent hours, changes merged, tokens
 * written per provider (`PersonContribution`); then their agents as a row of
 * faces and names, the blue dot on the ones working, working ones first,
 * every one of them and no recaps (note #1009, Adam, 5 Nov 2026: the recaps
 * are the owner's words and made the window an agent log; the member's
 * screen keeps one line each).
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
import { personAgentsInOrder, personAgentStateLine, personLatestLine, personStatusLine } from './people-words.js';

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
  // ONE latest rule (note #1009): their own last action, as their screen says.
  const latest = personLatestLine(person, now);
  const agents = personAgentsInOrder(person.agentFaces ?? []);
  const admin = showRole && person.role === 'admin';
  return (
    <PressableRow className="crow open personplate" data-person={person.userId} onPress={onOpen}>
      <div className="personhead">
        <PersonFace photoUrl={person.photoUrl} name={person.name} />
        <div className="personwho">
          <div className="personname">
            <span className="name plain">{person.name}</span>
            {/* One quiet label, "You · Admin", where two grey tags side by
                side read as one word (note #960). */}
            {person.you || admin
              ? <span className="personrole">{[person.you ? 'You' : '', admin ? 'Admin' : ''].filter(Boolean).join(' · ')}</span>
              : null}
          </div>
          <div className={here ? 'cline personstate here' : 'cline personstate'}>
            {here ? <span className="livedot" /> : null}
            <span className="ctext">{personStatusLine(person, now)}</span>
          </div>
        </div>
        {messageTo
          ? (
            // Says what it opens (note #960): the mark alone gave no hint.
            <span className="cmsgdoor" title={`Message ${person.name}`} aria-hidden="true" {...{ [ROW_DOOR_ATTR]: messageTo }}>
              <Svg name="send" size={14} /><span>Message</span>
            </span>
          )
          : null}
      </div>
      {latest
        ? (
          <div className="personlatest">
            {/* The stamp rides the last word (a no-break space before the
                dot), so it never opens a line of its own. */}
            <span className="cabout">{latest.text}</span>
            {latest.ago ? <><span className="csep" aria-hidden="true">{'\u00a0·\u00a0'}</span><span className="cago">{latest.ago.replace(/ /g, '\u00a0')}</span></> : null}
          </div>
        )
        : null}
      {person.contribution ? <PersonContribution contribution={person.contribution} /> : null}
      {agents.length
        ? (
          // Faces with names, the blue dot alone saying which work (no word,
          // Adam: "Blue dot is enough"); each opens its agent.
          <ul className="cagents" aria-label={`${person.you ? 'Your' : `${person.name}’s`} agents`}>
            {agents.map((agent) => (
              <li
                className={agent.working ? 'cagent busy' : 'cagent'}
                key={agent.id}
                data-agent={agent.id}
                title={`${agent.name}, ${personAgentStateLine(agent).toLowerCase()}`}
                {...{ [AGENT_DOOR_ATTR]: agent.id }}
              >
                {agent.avatarUrl
                  ? <img className="face" src={agent.avatarUrl} alt="" />
                  : <span className="face dot"><Icon name="bot" size={11} /></span>}
                <span className="caname">{agent.name}</span>
                {agent.working
                  ? <span className="livedot" role="img" aria-label={personAgentStateLine(agent)} />
                  : <span className="sr-only">{personAgentStateLine(agent)}</span>}
              </li>
            ))}
          </ul>
        )
        : null}
    </PressableRow>
  );
}
