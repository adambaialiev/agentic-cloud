/**
 * A room's agents as one stack of overlapping faces — the room row's mark,
 * where the folder glyph used to be (note #96).
 *
 * The faces are decorative (`alt=''`) because the line under the name says
 * the same thing in words; a reader who cannot see them loses nothing. An
 * agent from before the avatars still counts towards the mark: a stack that
 * quietly skipped it would say two where the line says three.
 */

import type { WorkspaceAgentRow } from '../../../src/shared/workspace-api.js';
import { Icon } from './icons.js';
import { roomFaceParts } from './room-faces.js';

export function RoomFaces({ agents, counted = true }: {
  agents: Array<Pick<WorkspaceAgentRow, 'id' | 'name' | 'avatarUrl'>>;
  /** Whether the stack says how many it could not draw — see `roomFaceParts`.
   *  A stack that stands for a ROOM counts; one that is a door does not. */
  counted?: boolean;
}) {
  if (!agents.length) return <span className="faces"><span className="face dot none" /></span>;
  const { shown, rest } = roomFaceParts(agents, counted);
  return (
    <span className="faces">
      {shown.map((agent) => (agent.avatarUrl
        ? <img className="face" key={agent.id} src={agent.avatarUrl} alt="" />
        : <span className="face dot" key={agent.id}><Icon name="user" size={11} /></span>))}
      {rest ? <span className="face dot more">+{rest}</span> : null}
    </span>
  );
}
