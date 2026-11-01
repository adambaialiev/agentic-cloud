/**
 * What every new agent in this workplace is built on (note #355).
 *
 * The same ladder an agent's own machine screen offers — one component, one
 * set of prices, one shared-core warning (`MachineLadders`) — asking a
 * different question: not "what should THIS machine be" but "what should the
 * next one be built as".
 *
 * WHAT MAKES IT A DIFFERENT SCREEN FROM THE AGENT'S PICKER: a tap here writes
 * one field on the workplace's record and touches no machine at all.
 * Nothing reboots, nothing is interrupted, no turn can be killed — so none of
 * the refusals that screen keeps (never mid-turn, never twice at once, ask
 * before restarting an awake machine) apply, and asking for a confirmation
 * would invent a cost that does not exist. The one thing a reader could
 * reasonably fear IS said, on the row and again in the outcome: the fleet
 * already running keeps the size it is on.
 *
 * Transient, like the pickers on the agent screen: it keeps the cloud
 * screen's address underneath it, so Back lands on the row that opened it.
 */

import { useCallback, useState } from 'react';
import type {
  WorkspaceMachineSize,
  WorkspaceOrgAgentMachineAnswer,
  WorkspaceOrgAgentMachineWritten,
} from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { errorMessage } from '../../ui/format.js';
import { MachineLadders, type MachineRungState } from '../agent/MachineLadders.js';
import { newAgentSizeOutcome } from '../agent/machine-words.js';
import { useOrgApi } from './useOrgApi.js';

export function NewAgentMachine({ info, onClose, onChosen }: {
  /** The answer the cloud screen already holds — the row that opened this
   *  screen is drawn from it, so opening the ladder costs no second read. */
  info: WorkspaceOrgAgentMachineAnswer;
  onClose: () => void;
  /** The server's own answer to the tap, handed back so the row underneath
   *  says the new size at once rather than after another read. */
  onChosen: (answer: WorkspaceOrgAgentMachineAnswer) => void;
}) {
  const api = useOrgApi();
  /** The rung in force, kept HERE as well as handed back: the badge landing
   *  on the tapped row is this screen's own confirmation, and it should not
   *  depend on what the screen underneath does with the answer. */
  const [current, setCurrent] = useState(info.current);
  const [writing, setWriting] = useState(false);
  /** What the last tap answered, and on which ladder — said under THAT card,
   *  where the thumb already is. */
  const [said, setSaid] = useState<{ kind: string; fail?: string; done?: string } | null>(null);

  useBackClaim(onClose);

  const choose = useCallback(async (size: WorkspaceMachineSize) => {
    setWriting(true);
    // Neither a refusal nor an outcome from the last tap may stand under a
    // newer one.
    setSaid(null);
    try {
      const answer = await api.api<WorkspaceOrgAgentMachineWritten>(
        'api/org/agent-machine',
        jsonBody({ size: size.id }),
      );
      setCurrent(answer.current);
      setSaid({ kind: size.cpuKind, done: newAgentSizeOutcome(answer.changed, size) });
      onChosen(answer);
    } catch (error) {
      setSaid({ kind: size.cpuKind, fail: errorMessage(error) });
    } finally {
      setWriting(false);
    }
  }, [api, onChosen]);

  const rungState = (size: WorkspaceMachineSize): MachineRungState => (
    size.id === current ? 'current' : 'open'
  );

  /** What the last tap on THIS ladder answered, or nothing. */
  const answer = (kind: string) => (said?.kind !== kind
    ? null
    : said.fail
      ? <div className="formfail" id="orgMachineFail" role="alert">{said.fail}</div>
      : <div className="formhint" id="orgMachineDone" role="status">{said.done}</div>);

  return (
    <div className="screen" id="screenOrgMachine">
      <ScreenTitle titleId="orgMachineTitle" title="Machine for new agents" />
      <div className="sub" id="orgMachineSub">
        {/* Three sentences, in the order the questions arrive: what this
            decides, what it leaves alone, and the fact that makes every
            price below readable. */}
        What every new agent in this workplace is built on. Machines already running keep the size
        they are on — their owners move those from the agent’s own screen. A machine costs processor
        and memory only while it is awake.
      </div>

      <MachineLadders
        idPrefix="orgMachine"
        sizes={info.sizes}
        rungState={rungState}
        disabled={writing}
        onPick={(size) => { void choose(size); }}
        empty="No machine sizes are offered on this backend."
        answer={answer}
      />

      <div className="formhint" id="orgMachineDisclaimer">{info.disclaimer}</div>
    </div>
  );
}
