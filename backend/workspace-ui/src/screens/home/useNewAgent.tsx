/**
 * The one way an agent gets made from Home, whichever door asks for it. It
 * used to be the New agent plate's private handler; a second door with its
 * own copy of these rules would be a second copy to keep honest.
 *
 * The rules, unchanged from the plate:
 *
 *  - Creating is cheap to confirm and annoying to undo — a machine starts
 *    setting up behind it — so the harness chooser doubles as the confirm,
 *    and the pick is kept for the agent's life.
 *  - A member without the matching subscription cannot create this agent,
 *    and the server refuses too. This walks them to the sign-in instead of
 *    bouncing them off that refusal.
 *  - Repeat taps while a create runs are ignored rather than turning the
 *    door into a busy control: the pending plate IS the progress state.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBanner } from '../../chrome/useBanner.js';
import { NewAgentFlow } from '../../cloud/NewAgentFlow.js';
import { toFor } from '../../routes.js';
import { useFleet } from '../../workspace/useFleet.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { missingSeatRefusal } from './agent-words.js';

export function useNewAgent(): {
  /** Open the harness chooser — or do nothing while a create is running. */
  ask: () => void;
  /** A create is in flight. */
  pending: boolean;
  /** The chooser while it is up. Render it wherever the door stands. */
  flow: ReactNode;
} {
  const { state } = useWorkspace();
  const { createAgent, pendingCreates } = useFleet();
  const banner = useBanner();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const org = state?.org ?? null;

  const answer = useCallback((cli: string | null) => {
    setAsking(false);
    if (!cli) return;
    if (pendingCreates > 0) return;
    const refusal = missingSeatRefusal(cli, org);
    if (refusal && org) {
      banner.show(refusal);
      navigate(toFor({ kind: 'seats', orgId: org.orgId })!);
      return;
    }
    void createAgent(cli);
  }, [banner, createAgent, navigate, org, pendingCreates]);

  const ask = useCallback(() => {
    if (pendingCreates > 0) return;
    setAsking(true);
  }, [pendingCreates]);

  return {
    ask,
    pending: pendingCreates > 0,
    flow: asking ? <NewAgentFlow onAnswer={answer} /> : null,
  };
}
