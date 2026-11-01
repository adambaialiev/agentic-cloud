/**
 * The machine ladder, drawn: Fly's stock shapes split into dedicated and
 * shared cores, priced per awake hour, one row per whole answer.
 *
 * ONE COMPONENT FOR BOTH PICKERS (note #355). It is used by the agent's own
 * machine screen — where a tap resizes that machine — and by the
 * workplace's choice of what new agents are built on, where a tap writes a
 * record and touches nothing. Two ladders would be two lists of rungs, two
 * prices for the same shape, and two versions of the shared-core warning
 * drifting apart; that warning in particular is a measurement, and a
 * measurement said twice is a measurement that will one day disagree with
 * itself.
 *
 * WHAT IS SHARED IS THE CORES, NEVER THE CONSEQUENCE. Both hints below say
 * only what the two kinds of core are, because that is true wherever this is
 * drawn. What a tap costs — a reboot on one screen, nothing at all on the
 * other — is said by the screen that owns the tap, above this.
 *
 * `idPrefix` keeps each screen's own ids (`agentMachineDedicated`,
 * `orgMachineDedicated`), the idiom `CloudConnectForm` already uses: the
 * markup is shared, the handles a test or a harness reaches for stay the
 * screen's own.
 */

import type { ReactNode } from 'react';
import type { WorkspaceMachineSize } from '../../../../src/shared/workspace-api.js';
import { TypeIcon } from '../../ui/icons.js';
import { machineSizeWords, machinePriceWords } from './machine-words.js';

/**
 * What one rung IS to the reader: the shape in force, the one being moved to,
 * or an offer.
 *
 * The rung already in force is a STATE, not a button that would spend a
 * change to change nothing — the same rule the runtime and room pickers keep
 * for the choice already made. `moving` belongs to a machine on its way to a
 * shape and is where the reader's thumb already is; a picker with nothing to
 * wait for never asks for it.
 */
export type MachineRungState = 'current' | 'moving' | 'open';

function SizeRow({ size, state, disabled, onPick }: {
  size: WorkspaceMachineSize;
  state: MachineRungState;
  disabled: boolean;
  onPick: () => void;
}) {
  const body = (
    <>
      <TypeIcon glyph="sliders" />
      <div className="main">
        <div className="name plain">{machineSizeWords(size)}</div>
        <div className="cline wrap"><span className="ctext">{machinePriceWords(size)}</span></div>
      </div>
      {state === 'current' ? <span className="badge">current</span> : null}
      {state === 'moving' ? <span className="badge busy">changing…</span> : null}
    </>
  );
  if (state === 'current') {
    return <div className="crow current" data-size={size.id} aria-current="true">{body}</div>;
  }
  if (state === 'moving') {
    return <div className="crow moving" data-size={size.id} aria-busy="true">{body}</div>;
  }
  return (
    <button className="crow open" type="button" data-size={size.id} disabled={disabled} onClick={onPick}>
      {body}
    </button>
  );
}

export function MachineLadders({ idPrefix, sizes, rungState, disabled, onPick, empty, answer }: {
  idPrefix: string;
  sizes: WorkspaceMachineSize[];
  rungState: (size: WorkspaceMachineSize) => MachineRungState;
  disabled: boolean;
  onPick: (size: WorkspaceMachineSize) => void;
  /** Drawn in place of the rows while there are none: a read still out, or
   *  the reason there will never be any. */
  empty: ReactNode;
  /** What the last tap on THAT ladder answered, or nothing — said under the
   *  card the thumb is already at rather than at the foot of the screen. */
  answer?: (kind: WorkspaceMachineSize['cpuKind']) => ReactNode;
}) {
  const ladder = (id: string, rows: WorkspaceMachineSize[]) => (
    <div className="card" id={id}>
      {sizes.length === 0
        ? <div className="empty">{empty}</div>
        : rows.map((size) => (
          <SizeRow
            key={size.id}
            size={size}
            state={rungState(size)}
            disabled={disabled}
            onPick={() => onPick(size)}
          />
        ))}
    </div>
  );
  return (
    <>
      <h2>Dedicated cores</h2>
      {ladder(`${idPrefix}Dedicated`, sizes.filter((size) => size.cpuKind === 'performance'))}
      <div className="formhint" id={`${idPrefix}DedicatedHint`}>
        Cores of its own, never shared with anyone else.
      </div>
      {answer?.('performance')}

      <h2>Shared cores</h2>
      {ladder(`${idPrefix}Shared`, sizes.filter((size) => size.cpuKind === 'shared'))}
      <div className="formhint" id={`${idPrefix}SharedHint`}>
        A tenth of the price, and throttled under sustained load — measured on one agent’s machine,
        91–94% of its processor time went to other tenants, and a test run that takes 39 seconds on
        dedicated cores took 12 minutes. Fine for an agent that mostly waits.
      </div>
      {answer?.('shared')}
    </>
  );
}
