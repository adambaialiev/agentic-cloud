/**
 * The agent's own face, by the shared rule: its picture when it has one, the
 * bot glyph when it has none or the picture fails to load. The error handler
 * is wired before the source, as the legacy page insists, so a picture
 * already known to be broken still tells us.
 *
 * ONE copy, for the same reason `contextHeat` is one copy: the fallback is
 * the load-bearing half. An agent from before the avatars has to read as the
 * same KIND of thing as the ones beside it, and a hand-rolled version of that
 * rule per screen is how one of them ends up drawing an empty disc where a
 * face goes. The fleet row, the agent's own header, the chat's pinned
 * header and the Workspace Agent's plate on Home all draw this — the last
 * has no fleet status, so status is optional here and only ever dims.
 */

import { useState } from 'react';
import type { WorkspaceAgentRow } from '../../../src/shared/workspace-api.js';
import { TypeIcon } from './icons.js';

export function AgentFace({ agent }: { agent: Pick<WorkspaceAgentRow, 'avatarUrl'> & Partial<Pick<WorkspaceAgentRow, 'status'>> }) {
  const [broken, setBroken] = useState(false);
  if (!agent.avatarUrl || broken) return <TypeIcon glyph="bot" />;
  return (
    <img
      className={agent.status === 'retired' ? 'avatar dim' : 'avatar'}
      onError={() => setBroken(true)}
      src={agent.avatarUrl}
      alt=""
    />
  );
}
