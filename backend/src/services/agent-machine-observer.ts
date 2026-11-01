/**
 * What an agent's machine is made of, stamped on the record from wherever
 * something already looked (note #356).
 *
 * WHY A RECORD AND NOT A READ. The fleet list wants to say what each agent
 * runs on, and it is built by `api/state` — the one payload whose standing
 * rule is that it costs no machine reads (see `agentVersionSeeds`). A Fly
 * control-plane call per agent, on a read that fires on every Workspace open
 * and every turn boundary, would put the whole fleet's latency behind
 * somebody else's API on a screen that is mostly scrolled past.
 *
 * A machine's shape is also the rarest fact about it: it is decided when the
 * machine is built and changes only when an owner moves it up or down the
 * ladder. So the honest arrangement is to write it down when something looks
 * anyway, and read it from the record forever after.
 *
 * WHO LOOKS ANYWAY. The idle reaper's sweep lists every claimed app's
 * machines every few minutes and that listing already carries each machine's
 * guest — the same "it is free, because the listing this sweep already
 * fetched" bargain the image roll makes. The agent's own screen reads its
 * machine when it opens. A resize is told what Fly accepted. None of those
 * exist for this; all three can pay for it with nothing.
 *
 * DIFF-ONLY. An observation that agrees with the record writes nothing, so a
 * fleet nobody is resizing costs zero writes per sweep, and the stamp means
 * "when this changed" rather than "when a sweep last ran".
 */

import type { AgentRecord } from '../types/user.js';
import type { UserStorage } from './user-storage.js';

/** One look at one machine: whose it is, and what it was made of. */
export interface AgentMachineObservation {
  userId: string;
  agentId: string;
  cpuKind: string;
  cpus: number;
  memoryMb: number;
}

/** The three fields that make a shape, or nothing. */
export type AgentMachineShape = NonNullable<AgentRecord['machineSize']>;

/**
 * A shape worth recording, or undefined.
 *
 * ALL THREE OR NONE, the same rule the words follow: cores without memory is
 * not a size anybody can compare, and half a shape on a row is worse than no
 * row — the reader cannot tell a small machine from a partly-read one.
 */
export function agentMachineShapeOf(
  guest: { cpu_kind?: string; cpus?: number; memory_mb?: number } | undefined,
): AgentMachineShape | undefined {
  const cpuKind = guest?.cpu_kind?.trim();
  const cpus = guest?.cpus;
  const memoryMb = guest?.memory_mb;
  if (!cpuKind || !Number.isFinite(cpus) || !Number.isFinite(memoryMb)) return undefined;
  if (!cpus || !memoryMb) return undefined;
  return { cpuKind: cpuKind.slice(0, 32), cpus: cpus!, memoryMb: memoryMb! };
}

/** Whether the record already says exactly this. */
export function agentMachineShapeMatches(
  recorded: AgentRecord['machineSize'],
  observed: AgentMachineShape,
): boolean {
  return Boolean(recorded)
    && recorded!.cpuKind === observed.cpuKind
    && recorded!.cpus === observed.cpus
    && recorded!.memoryMb === observed.memoryMb;
}

/**
 * Fold a batch of observations into `telegram.agents.<id>.machineSize`.
 *
 * Grouped by user so a fleet of twenty machines under one owner costs one
 * read, exactly as the runtime meter does it, and contained per user for the
 * same reason: this is bookkeeping riding a sweep whose real job is stopping
 * idle machines, and it must never be the thing that breaks it. An agent
 * whose record vanished mid-sweep is dropped — its machine is going anyway.
 */
export async function recordAgentMachineShapes(
  userStorage: Pick<UserStorage, 'getProfile' | 'updateAgentFields'>,
  observations: readonly AgentMachineObservation[],
  at: Date,
): Promise<void> {
  const byUser = new Map<string, AgentMachineObservation[]>();
  for (const observation of observations) {
    const list = byUser.get(observation.userId);
    if (list) list.push(observation);
    else byUser.set(observation.userId, [observation]);
  }
  for (const [userId, seen] of byUser) {
    try {
      const profile = await userStorage.getProfile(userId);
      for (const observation of seen) {
        const agent = profile?.telegram?.agents?.[observation.agentId];
        if (!agent) continue;
        const shape: AgentMachineShape = {
          cpuKind: observation.cpuKind,
          cpus: observation.cpus,
          memoryMb: observation.memoryMb,
        };
        if (agentMachineShapeMatches(agent.machineSize, shape)) continue;
        await userStorage.updateAgentFields(userId, observation.agentId, {
          machineSize: shape,
          machineSizeAt: at.toISOString(),
        });
      }
    } catch (error) {
      console.warn(`[MachineShapes] failed to record shapes for user ${userId}`, error);
    }
  }
}
