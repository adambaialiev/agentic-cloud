/**
 * The agent behind a face is mid-turn, as ONE MARK beside it (note #369).
 *
 * It is `livedot` — the same 6px accent disc, breathing the same breath, that
 * says "a turn is running" on the fleet's own rows and on a subscription
 * (note #326). A proposal's row draws its agent as a 16px picture and says
 * nothing else about it; whether that agent is at work right now is the one
 * fact a reader deciding on the change can act on — an agent mid-turn may
 * still be pushing to the branch under it — and it was previously reachable
 * only by pointing at the face on a desktop (note #295) or by opening the
 * agent.
 *
 * Nothing when the agent is idle: the mark is the whole message, so its
 * absence has to mean the other half of it. A teammate's agent wears it too
 * (2026-09-23): the live tick says which of theirs are mid-turn, so the
 * reader deciding on a change learns it the same way whoever's agent it is.
 */

import { useWorkspace } from '../workspace/useWorkspace.js';

export function AgentWorkingDot({ id }: { id?: string }) {
  const { agents, state } = useWorkspace();
  const agent = id
    ? agents?.find((row) => row.id === id) ?? state?.teamAgents?.find((row) => row.id === id) ?? null
    : null;
  if (!agent?.working) return null;
  return (
    <>
      {/* Decoration, so `aria-hidden`: the sentence beside it is what a reader
          who cannot see the colour gets, and it names the agent the picture
          it stands next to carries no alt text for. */}
      <span className="livedot facedot" aria-hidden="true" />
      <span className="sr-only">{agent.name} is working now</span>
    </>
  );
}
