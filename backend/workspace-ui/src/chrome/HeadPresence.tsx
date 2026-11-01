/**
 * Whether the agent whose screen this is, is working right now (note #240).
 *
 * It rides the PERSISTENT header because the header is the one thing that
 * stays: the agent screen is long — the recap, the last reply, the facts, the
 * version card, the proposals — and "Working" is written a card and a half
 * down it, where a reader who came to ask exactly that question has to go
 * looking for the answer and scroll back up to leave. Sticky, this answers on
 * every line of the screen.
 *
 * In the navigation row rather than beside the name in the block under it
 * (note #282): the row's middle is otherwise empty and is where the reader of
 * a phone screen already looks for the state of the thing they are on, while
 * a mark beside the name competes with a long name for the same line.
 *
 * It reads the fleet row, not the version read: `working` is the field the
 * live tick patches, so the indicator turns over the moment a turn starts or
 * ends, without this screen reading anything of its own.
 *
 * Absent everywhere else. The header matches its own address to decide, the
 * same way it decides whether to stand aside for Home and the chat, so no
 * screen has to hand it anything.
 */

import { matchPath, useLocation } from 'react-router-dom';
import { routerPathFor } from '../routes.js';
import { agentPresence } from '../screens/home/agent-words.js';
import { useWorkspace } from '../workspace/useWorkspace.js';

export function HeadPresence() {
  const location = useLocation();
  const { agents } = useWorkspace();
  const id = matchPath(routerPathFor('agent'), location.pathname)?.params.id;
  // Nothing at all until the fleet has landed: a dot that says "Idle" while
  // the state read is still in flight is a claim, not a reading.
  const agent = id && agents ? agents.find((row) => row.id === id) : null;
  if (!agent) return null;
  const presence = agentPresence(agent);
  return (
    <span
      className={`headstate ${presence.tone}`}
      id="agentHeadState"
      // A live region, because this is the one thing on the screen that
      // changes without the reader touching anything. The label carries the
      // agent's name: read on its own, out of the header, "Active" names
      // nobody.
      role="status"
      aria-label={`${agent.name} is ${presence.label.toLowerCase()}`}
    >
      <span className="statedot" />
      <span className="statetext">{presence.label}</span>
    </span>
  );
}
