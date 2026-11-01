/**
 * The person plate as the app drew it until note #833 (2026-10-29), its
 * agents as a row of faces alone — kept for ONE place: the public front
 * page's moving row (`LiveMarquee`), whose one person drives eighteen agents.
 * The front page's look is decided on a picture first (note #503), so the
 * Workspace's redesigned card (`PersonRow`) did not change it; when the front
 * page takes the new card, this file goes.
 */

import type { WorkspaceOrgMember } from '../../../../src/shared/workspace-api.js';
import { PersonFace } from '../../ui/PersonFace.js';
import { AGENT_DOOR_ATTR, RowFace } from '../../ui/FaceDoor.js';
import { Icon } from '../../ui/icons.js';
import { PressableRow } from '../home/PressableRow.js';
import { personFactsLine, personRecapAgo, personStatusLine } from './people-words.js';

/** Six faces at 20px fit a half-phone plate with room for the count. */
const PERSON_FACES_SHOWN = 6;

export function PersonFacesPlate({ person, now, showRole = true }: {
  person: WorkspaceOrgMember;
  now: number;
  showRole?: boolean;
}) {
  const here = Boolean(person.here);
  const ago = personRecapAgo(person, now);
  const faces = person.agentFaces ?? [];
  return (
    <PressableRow className="crow open" data-person={person.userId} onPress={() => {}}>
      <div className="agenthead">
        <PersonFace photoUrl={person.photoUrl} />
        <div className="agentidentity">
          <div className="name plain">{person.name}{person.you ? ' (you)' : ''}</div>
          <div className="cruntime">{personFactsLine(person, { role: showRole })}</div>
        </div>
      </div>
      <div className="main">
        <div className="cline">
          {here ? <span className="livedot" /> : null}
          <span className={here ? 'ctext keep' : 'ctext'}>{personStatusLine(person, now)}</span>
        </div>
        {person.recap ? <div className="cabout">{person.recap}</div> : null}
        {ago ? <div className="cago">{ago}</div> : null}
        {faces.length
          ? (
            <div className="cfaces" aria-label={`Agents: ${faces.map((agent) => agent.name).join(', ')}`}>
              {faces.slice(0, PERSON_FACES_SHOWN).map((agent) => (agent.avatarUrl
                ? <RowFace key={agent.id} agentId={agent.id} avatarUrl={agent.avatarUrl} />
                : <span className="face dot" key={agent.id} {...{ [AGENT_DOOR_ATTR]: agent.id }}><Icon name="bot" size={11} /></span>))}
              {faces.length > PERSON_FACES_SHOWN ? <span className="face dot more">+{faces.length - PERSON_FACES_SHOWN}</span> : null}
            </div>
          )
          : null}
      </div>
    </PressableRow>
  );
}
