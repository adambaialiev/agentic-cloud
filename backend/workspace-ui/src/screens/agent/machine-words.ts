/**
 * The words the machine screen says (note #268). Pure functions over what the
 * read answered; the component draws them — the same split `agent-facts.ts`
 * keeps for the screen above it.
 */

import { memory } from '../../ui/file-kind.js';
import { processorWords } from './agent-facts.js';

/** A machine shape, loosely: what a read reports, or what a rung offers. */
export interface MachineShape { cpuKind?: string; cpus?: number; memoryMb?: number }

/**
 * "4 dedicated cores · 8 GB" — one whole machine shape, in one line.
 *
 * BOTH HALVES OR NEITHER: a rung with cores and no memory is not a size
 * anybody can compare, and a machine we could not read reports neither. It
 * takes the loose shape rather than a size row on purpose, so the facts card
 * (which describes a machine that may not be on the ladder at all) and the
 * ladder rows are worded by one function and cannot drift.
 */
export function machineSizeWords(shape: MachineShape): string {
  return machineSizeParts(shape).join(' · ');
}

/**
 * The same shape, as the two facts it is made of rather than as one string:
 * for a place too narrow to promise the line fits, which needs to know where
 * it may fold. The words are the same words — the line above is these,
 * joined — so a folded shape and a whole one cannot describe one machine two
 * ways.
 */
export function machineSizeParts(shape: MachineShape): string[] {
  return [
    processorWords(shape.cpuKind, shape.cpus),
    shape.memoryMb ? memory(shape.memoryMb) : '',
  ].filter(Boolean);
}

/**
 * What a rung costs, and what the standard one is.
 *
 * PER AWAKE HOUR, never per month. A machine sleeps after fifteen idle
 * minutes and is billed no processor and no memory while it does, so a
 * monthly figure would be several times what any real agent costs — the
 * expensive direction to be wrong in on a screen whose whole purpose is
 * choosing how much to spend.
 */
export function machinePriceWords(size: { hourlyUsd: number; standard?: boolean }): string {
  const price = `about $${size.hourlyUsd.toFixed(2)} an hour awake`;
  return size.standard ? `${price} · standard` : price;
}

/**
 * A size change this screen asked for and Fly has not yet confirmed: what the
 * machine is moving to, and whether it was awake when asked — which is the
 * difference between a reboot and a machine that simply wakes up different.
 */
export interface MachineMove { to: MachineShape; restarted: boolean }

/**
 * Awake, asleep or mid-change — and the answer to the question that value
 * raises on THIS screen, which is what a size change costs right now.
 *
 * Three states, not two, and the third is worded from what THIS screen knows
 * rather than from Fly's flag alone. For a second or two after any resize —
 * a sleeping machine's as much as a running one's — Fly reports the machine
 * neither started nor stopped, and calling that "Restarting" of a machine
 * that was asleep and stays asleep is the sentence a reader cannot square
 * with the "Saved, it wakes up different" they were promised. So a move this
 * screen made says which of the two it is; a change it only found under way
 * says only that.
 */
export function machineStateWords(
  machine: { awake: boolean; restarting?: boolean },
  move?: MachineMove | null,
): { state: string; note: string } {
  if (move) {
    return move.restarted
      ? { state: 'Restarting', note: `It comes back on its own on ${machineSizeWords(move.to)} — usually within a minute.` }
      : { state: 'Changing size', note: `A few seconds. It stays asleep, and wakes up on ${machineSizeWords(move.to)}.` };
  }
  if (machine.restarting) {
    return { state: 'Changing size', note: 'A few seconds — the sizes below come back on their own.' };
  }
  if (machine.awake) {
    return {
      state: 'Awake',
      note: 'A size change restarts it — anything it is running stops for about a minute.',
    };
  }
  return {
    state: 'Asleep',
    note: 'A size change costs nothing and interrupts nobody: it wakes up on the new size.',
  };
}

/**
 * What just happened, said once Fly has confirmed it and where the badge
 * cannot say it. Three outcomes, and the reader can tell them apart: a
 * machine that restarted under them, one that will simply wake up different,
 * and a tap that spent nothing because it asked for the size the machine
 * already had.
 */
export function resizeOutcome(changed: boolean, restarted: boolean, size: MachineShape): string {
  if (!changed) return 'It was already this size — nothing restarted.';
  if (restarted) return `Restarted on ${machineSizeWords(size)}. Its files are kept.`;
  return `Saved. It wakes up on ${machineSizeWords(size)}.`;
}

/**
 * The change was accepted but the machine has not reported the new shape in
 * the time this screen is willing to keep asking. Said as what it is — not
 * confirmed — rather than as either a success or a failure, because at that
 * point it is neither.
 */
export function resizeUnconfirmed(size: MachineShape): string {
  return `The change was accepted, but the machine has not reported ${machineSizeWords(size)} yet. Reopen this screen in a minute to check.`;
}

/**
 * What choosing a workplace's default answered (note #355).
 *
 * It says what the choice did AND what it did not do, in one line, because
 * the second half is the question a reader asks straight after tapping: a
 * fleet of machines is running right now, and nothing here restarted any of
 * them. That is the whole difference between this ladder and the one on an
 * agent's own screen, so it is said where the tap lands rather than left to
 * a hint further down the page.
 */
export function newAgentSizeOutcome(changed: boolean, size: MachineShape): string {
  return changed
    ? `Saved. New agents are built on ${machineSizeWords(size)}. Machines already running keep their size.`
    : `New agents were already built on ${machineSizeWords(size)}.`;
}
