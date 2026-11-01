/**
 * The one line under a row's title when the thing on it was last touched by
 * an AGENT: its face, its name, then what the row is about — the legacy
 * `agentLineNodes(item, tail)`.
 *
 * The name wears `.keep` and the tail does not, deliberately: a truncated
 * "Al…" identifies nobody, where a cut description still reads as far as it
 * goes. Both halves are optional — a page landed before attribution existed
 * keeps its words and simply wears no face.
 *
 * THE FACE IS A DOOR (note #640, the owner). It opens the agent that landed
 * the thing — its own screen for one of the reader's, the read-only card for
 * a teammate's — and the rest of the row still opens the row's own subject.
 * Two destinations in one line is exactly what these rows used to refuse; the
 * face is now the one place where the second one is worth the ambiguity,
 * because "who wrote this?" is otherwise a question with nowhere to go. The
 * row itself answers that press (`PressableRow`), off the mark `RowFace`
 * leaves — `agentId` arrives from the server exactly when there is a screen
 * behind the picture, so an agent the workplace has forgotten keeps its face
 * and offers no door.
 */

import { RowFace } from './FaceDoor.js';
import { personName } from './chief-of-staff.js';

export interface AgentLineSubject {
  agentName?: string;
  agentAvatarUrl?: string;
  /** Sent exactly when the face has a screen to open. */
  agentId?: string;
}

export function AgentLine({ subject, tail }: { subject: AgentLineSubject; tail?: string }) {
  return (
    <>
      {subject.agentAvatarUrl
        ? <RowFace agentId={subject.agentId} avatarUrl={subject.agentAvatarUrl} />
        : null}
      {subject.agentName ? <span className="ctext keep">{personName(subject.agentName)}</span> : null}
      {subject.agentName && tail ? <span className="csep">·</span> : null}
      {tail ? <span className="ctext">{tail}</span> : null}
    </>
  );
}
