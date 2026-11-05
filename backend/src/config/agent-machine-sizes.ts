/**
 * The machine shapes an agent may run on, and the words for them (note #268).
 *
 * ONE ladder, read by everything that has an opinion about an agent's
 * machine: the size new machines are built at, the size the details screen
 * names, and the size the owner may move an existing machine to. Before this
 * the shape lived only as `DEFAULT_FLY_GUEST` and nothing could offer a
 * second one.
 *
 * WHY THE SHARED HALF IS OFFERED AND WARNED ABOUT IN THE SAME BREATH
 * (knowledge page "agent-machine-size"): the whole fleet moved OFF shared
 * vCPUs on 2026-08-17 because they throttle exactly the load a coding agent
 * makes — measured on one agent's machine under a sustained test run, 91–94%
 * steal, with two busy workers getting 7.5% of a single core between them,
 * and the same suite taking 740 s there against 39 s on an unthrottled box.
 * Every agent on one was reading that as a bug in its own code. It is still
 * on the ladder because it is a tenth of the price and an agent that mostly
 * waits genuinely does not need dedicated cores at all — but the screen says
 * what it costs, in that measurement's own words, rather than presenting the
 * two halves as an even choice.
 *
 * Cost follows AWAKE hours, not calendar time: a stopped machine is billed no
 * CPU and no memory, only its volume. That is why the ladder is priced per
 * awake hour rather than per month — a month of an agent nobody messaged is
 * the volume alone whichever rung it sits on.
 */

import { estimateGuestHourlyUsd } from './fly-cost-estimates.js';

export type AgentCpuKind = 'shared' | 'performance';

export interface AgentMachineSize {
  /** Fly's own name for the shape, and this catalog's key. */
  id: string;
  cpuKind: AgentCpuKind;
  cpus: number;
  memoryMb: number;
}

/**
 * Fly's stock shapes, smallest first within each kind. Memory is the amount
 * Fly pairs with that many cores by default (a shared core tops out at 2 GB,
 * a dedicated one includes 2 GB), so every rung here is a combination Fly
 * accepts — a catalog that can offer a size the API then refuses is worse
 * than a shorter one.
 */
export const AGENT_MACHINE_SIZES: readonly AgentMachineSize[] = [
  { id: 'shared-1x', cpuKind: 'shared', cpus: 1, memoryMb: 2048 },
  { id: 'shared-2x', cpuKind: 'shared', cpus: 2, memoryMb: 4096 },
  { id: 'shared-4x', cpuKind: 'shared', cpus: 4, memoryMb: 8192 },
  { id: 'performance-1x', cpuKind: 'performance', cpus: 1, memoryMb: 2048 },
  { id: 'performance-2x', cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
  { id: 'performance-4x', cpuKind: 'performance', cpus: 4, memoryMb: 8192 },
  { id: 'performance-8x', cpuKind: 'performance', cpus: 8, memoryMb: 16384 },
];

/**
 * What a new agent machine is built at where nobody has said otherwise — the
 * PLATFORM's default, under a workplace's own choice
 * (`OrgDocument.agentMachineSizeId`, note #355), which every reader resolves
 * through `effectiveAgentMachineSize`. The provisioning default is derived
 * from this id rather than written a second time, so "what new machines get"
 * and "what the screen calls standard" cannot drift apart.
 *
 * TWO DEDICATED CORES since 2026-09-06 (Owner's call), down from four, at
 * half the awake-hour price. Measured on this platform's own agent before and
 * after the move, same test suite and same commit: 3,573 tests in 101 s on
 * `performance-4x`, 253 s on `performance-2x` — 2.5x on the heaviest thing an
 * agent does, and indistinguishable on everything else it spends its day on,
 * since editing, searching and git are latency and not throughput. Steal
 * stayed at 0.6%, which is the number that actually matters: this is half as
 * many cores, not shared ones (see the ladder note above for what shared did).
 * 4 GB held the same suite with room to spare and nothing swapped — there is
 * no swap on these machines, so memory is a wall rather than a slope, and
 * that is the figure to re-measure if this ever moves again.
 *
 * Existing machines are NOT touched by this: it decides what a new one is
 * built at, and every owner can move any machine along the ladder afterwards.
 */
export const DEFAULT_AGENT_MACHINE_SIZE_ID = 'performance-2x';

export function agentMachineSizeById(id: string | undefined): AgentMachineSize | undefined {
  return AGENT_MACHINE_SIZES.find((size) => size.id === id);
}

export const DEFAULT_AGENT_MACHINE_SIZE = agentMachineSizeById(DEFAULT_AGENT_MACHINE_SIZE_ID)!;

/**
 * The shape of the member's tool-free briefing summarizer (note #437).
 * Workspace Agent became a full coding machine in note #493 and now follows
 * the ordinary workplace default; only Workspace Recap stays on this cheap
 * shared rung. Held here so its creation and convergence paths agree.
 */
export const WORKSPACE_MACHINE_SIZE_ID = 'shared-1x';
export const WORKSPACE_MACHINE_SIZE = agentMachineSizeById(WORKSPACE_MACHINE_SIZE_ID)!;

/**
 * A sealed public guide's machine (note #1010; Adam, 5 Nov 2026: shared
 * cores, since it only answers questions). Two shared cores and 4 GB: one
 * Claude Code turn at a time with the owner's own chat beside it.
 */
export const SEALED_AGENT_MACHINE_SIZE_ID = 'shared-2x';
export const SEALED_AGENT_MACHINE_SIZE = agentMachineSizeById(SEALED_AGENT_MACHINE_SIZE_ID)!;

/**
 * Which rung a machine is standing on, by its actual shape — never by a
 * stored label. A machine resized by hand (or created before this ladder
 * existed) reports whatever Fly says it is, and an off-ladder shape answers
 * `undefined` so the screen can say what it has rather than claiming the
 * nearest rung.
 */
export function agentMachineSizeOf(
  guest: { cpuKind?: string; cpus?: number; memoryMb?: number } | undefined,
): AgentMachineSize | undefined {
  if (!guest) return undefined;
  return AGENT_MACHINE_SIZES.find((size) => size.cpuKind === guest.cpuKind
    && size.cpus === guest.cpus
    && size.memoryMb === guest.memoryMb);
}

/**
 * What a workplace builds NEW agents at: the rung its admins chose on the
 * cloud screen (note #355), or the platform's own default where they have
 * chosen none — and where the choice names a rung this catalog no longer
 * offers, which reads the same way an absent one does rather than failing to
 * provision a machine over a stale id.
 */
export function effectiveAgentMachineSize(chosenId: string | undefined): AgentMachineSize {
  return agentMachineSizeById(chosenId) ?? DEFAULT_AGENT_MACHINE_SIZE;
}

/**
 * The one thing about its own shape a machine CANNOT see from inside: whether
 * its cores are dedicated or shared (note #393).
 *
 * Fly throttles shared vCPUs on the host, so `/proc` inside the guest reads
 * identically on both halves of the ladder — while the difference is the one
 * that changes how an agent should work (91-94% steal under sustained load on
 * the shared half; see the ladder note above). Cores and memory ARE visible,
 * and the image reads those from the guest itself rather than from anything we
 * inject, so the only thing that travels is the word — and there is nothing
 * for a stale copy of the numbers to disagree with.
 *
 * Set wherever the backend writes a machine's guest: at creation, at a resize,
 * and on an image roll (which is what carries it to machines that existed
 * before this shipped). Absent, the image leaves the kind off the facts line
 * rather than guessing it.
 */
export const MACHINE_CPU_KIND_ENV = 'CPU_KIND';

export function machineCpuKindEnv(cpuKind: string | undefined): Record<string, string> {
  return cpuKind ? { [MACHINE_CPU_KIND_ENV]: cpuKind } : {};
}

/** A rung with its price, and whether it is the standard one for this reader. */
export interface PricedAgentMachineSize extends AgentMachineSize {
  hourlyUsd: number;
  standard?: true;
}

/**
 * The ladder, priced per AWAKE hour, in the shape every screen that offers a
 * choice of machine draws — the agent's own picker and the workplace's
 * default alike, so the two cannot come to offer different rungs or different
 * prices.
 *
 * `standardId` is what the rows call standard, and it is the caller's
 * question rather than a constant: on an agent's screen the standard rung is
 * what this WORKPLACE builds new agents on, and on the workplace's own
 * picker nothing is marked at all — there the badge on the chosen row already
 * says it, and a second word for the same fact reads as a second fact.
 */
export function pricedAgentMachineSizes(standardId?: string): PricedAgentMachineSize[] {
  return AGENT_MACHINE_SIZES.map((size) => ({
    ...size,
    hourlyUsd: estimateGuestHourlyUsd({
      cpu_kind: size.cpuKind, cpus: size.cpus, memory_mb: size.memoryMb,
    }),
    ...(standardId && size.id === standardId ? { standard: true as const } : {}),
  }));
}
