/**
 * An agent's face, and the door behind it (note #640, the owner: "when user
 * presses on not own agent's avatar, it should open agent's detail page").
 *
 * TWO SHAPES, because a face stands in two kinds of place:
 *
 *  - `FaceDoor` is a real button, for a face that stands on a SCREEN — a
 *    note's signature, a remark in a margin, a site's deployer. It is
 *    focusable, it announces itself, and it is the shape every face door in
 *    this app already had.
 *
 *  - `RowFace` is a plain picture wearing `data-agent-door`, for a face
 *    inside a row that is ITSELF a door. A button nested in a link or in a
 *    `role="button"` row is invalid markup and — by ARIA's presentational
 *    children rule — invisible to a screen reader anyway, so the row reads
 *    the mark instead and opens the agent when the tap landed on the face
 *    (`PressableRow`). One tab stop, one accessible name, and the pointer
 *    still gets the two destinations the note asked for.
 *
 * Either way the id comes from the server exactly when there is a screen
 * behind the picture, so an agent the workplace has forgotten wears its face
 * and offers no door: a tap that leads nowhere is worse than a picture never
 * offered as one.
 */

import { useNavigate } from 'react-router-dom';
import { toFor } from '../routes.js';

/** The mark a row looks for on the element a press landed in. */
export const AGENT_DOOR_ATTR = 'data-agent-door';

/** The same idea for any other second door on a row: the mark carries the
 *  address it opens (a person's plate, its Message mark — 29 Oct 2026). */
export const ROW_DOOR_ATTR = 'data-row-door';

export function RowFace({ agentId, avatarUrl }: { agentId?: string; avatarUrl: string }) {
  return <img className="face" src={avatarUrl} alt="" {...(agentId ? { [AGENT_DOOR_ATTR]: agentId } : {})} />;
}

export function FaceDoor({ agentId, agentName, avatarUrl, className = 'face' }: {
  agentId?: string;
  agentName?: string | null;
  avatarUrl: string;
  /** The picture's own class where a screen dresses it differently — a
   *  contributor's row wears `aface small`. */
  className?: string;
}) {
  const navigate = useNavigate();
  const to = agentId ? toFor({ kind: 'agent', id: agentId }) : null;
  const picture = <img className={className} src={avatarUrl} alt="" />;
  if (!to) return picture;
  return (
    <button
      className="facebtn"
      type="button"
      aria-label={agentName ? `Open ${agentName}` : 'Open this agent'}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        navigate(to);
      }}
    >
      {picture}
    </button>
  );
}
