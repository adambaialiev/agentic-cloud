/**
 * Model and effort (note #148): one leaf reached from both places that
 * already name them — the chat's pinned header and the agent's own facts.
 *
 * Transient on purpose (knowledge page "miniapp-navigation"): it keeps the
 * stable route underneath it and never becomes an address, so the screen that
 * opened it stays mounted behind it — which is what lets the chat come back
 * to its own transcript and its unsent draft rather than refetching both.
 *
 * The backend supplies the curated, per-CLI catalog, and effort comes from
 * the SELECTED model's own entry — never from a CLI-wide list that could
 * offer a level the command will reject.
 *
 * It raises NO toast (note #237). The toast is for answers with nowhere else
 * to land, and this leaf is not that case: it stays on screen after the
 * write, so the `current` badge arriving on the row that was just tapped IS
 * the confirmation. A toast on top of that says the same thing a second time
 * and then covers the foot of the very list it is confirming. The room
 * picker keeps its toast for the opposite reason — it closes on success, so
 * nothing is left behind to do the saying. A REFUSAL still has to be seen,
 * and it is said under the card whose row was tapped, where the reader is
 * already looking and where nothing has moved.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  WorkspaceAgentRuntimeAnswer,
  WorkspaceAgentRuntimeWritten,
} from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { errorMessage } from '../../ui/format.js';
import { useSession } from '../../session/useSession.js';
import { RuntimeChoices } from '../../ui/RuntimeChoices.js';
import { heldRuntime, holdRuntime } from './agent-cache.js';
import { knownAgentRuntime } from './known-runtime.js';

export function RuntimePicker({ agent, onClose, onWritten }: {
  agent: { id: string; name: string; cli: string; model?: string; effort?: string };
  onClose: () => void;
  /** Called only after a WRITE — opening the picker changes nothing, and a
   *  full state read to confirm that would cost a dozen storage reads. Every
   *  already-painted copy of the runtime follows this answer: the fleet row,
   *  the agent header and facts, the pinned chat header. */
  onWritten: (result: WorkspaceAgentRuntimeAnswer) => void;
}) {
  const { api } = useSession();
  // Opened on the choices this tab last read for this agent (note #630), else
  // on the catalog its row already names (note #718); the read below
  // refreshes them silently, and a failed one leaves them standing.
  const [settings, setSettings] = useState<WorkspaceAgentRuntimeAnswer | null>(() => heldRuntime(agent.id) ?? knownAgentRuntime(agent));
  const [failure, setFailure] = useState('');
  /** A write that was refused, and which of the two cards asked for it — the
   *  message belongs under that card, not under both. */
  const [refused, setRefused] = useState<{ kind: 'model' | 'effort'; text: string } | null>(null);
  const [writing, setWriting] = useState(false);
  // A tap that lands before the opening read answers: that read is older than
  // the write, and must not paint the old pair back over the new one.
  const written = useRef(false);

  useBackClaim(onClose);

  useEffect(() => {
    let alive = true;
    void api.api<WorkspaceAgentRuntimeAnswer>(`api/agents/${encodeURIComponent(agent.id)}/runtime`)
      .then((result) => {
        if (written.current) return;
        holdRuntime(agent.id, result);
        if (alive) setSettings(result);
      })
      .catch((error: unknown) => { if (alive) setFailure(errorMessage(error)); });
    return () => { alive = false; };
  }, [agent.id, api]);

  const choose = useCallback(async (kind: 'model' | 'effort', value: string) => {
    setWriting(true);
    // Clear the last refusal as the next attempt starts: a retry that works
    // must not leave the reader reading why the previous one did not.
    setRefused(null);
    try {
      const result = await api.api<WorkspaceAgentRuntimeWritten>(
        `api/agents/${encodeURIComponent(agent.id)}/runtime`,
        jsonBody({ [kind]: value }),
      );
      written.current = true;
      holdRuntime(agent.id, result);
      setSettings(result);
      onWritten(result);
    } catch (error) {
      setRefused({ kind, text: errorMessage(error) });
    } finally {
      setWriting(false);
    }
  }, [agent.id, api, onWritten]);

  return <RuntimeChoices screenId="screenAgentRuntime" prefix="agentRuntime"
    title={<>How {agent.name} thinks</>}
    sub={`Choose the model and effort ${agent.name} uses from its next turn.`}
    settings={settings} failure={failure} refused={refused} writing={writing} choose={choose} />;
}
