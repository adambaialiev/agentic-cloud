import type { UserStorage } from './user-storage.js';

/** One sweep's observation: this agent's machine was running for ~`ms`. */
export interface AgentRuntimeSample {
  userId: string;
  agentId: string;
  /** Milliseconds of observed runtime to credit. */
  ms: number;
}

/** UTC month bucket key for `machineRuntimeMs`, e.g. `"2026-07"`. */
export function runtimeMonthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Fold one sweep's runtime samples into `telegram.agents.<id>.machineRuntimeMs`
 * (see the field's doc in types/user.ts for why sampling, and why monthly
 * buckets). Samples are grouped so each user costs one read regardless of how
 * many of their machines were running. A sample whose agent record has vanished
 * (deleted mid-sweep) is dropped — its machine is being destroyed anyway.
 *
 * Failures are contained per user and logged: metering must never break the
 * sweep that feeds it, and a lost sample only under-counts by one interval.
 */
export async function recordAgentRuntimeSamples(
  userStorage: Pick<UserStorage, 'getProfile' | 'updateAgentFields'>,
  samples: AgentRuntimeSample[],
  at: Date,
): Promise<void> {
  const monthKey = runtimeMonthKey(at);
  const byUser = new Map<string, AgentRuntimeSample[]>();
  for (const sample of samples) {
    if (sample.ms <= 0) continue;
    const list = byUser.get(sample.userId);
    if (list) list.push(sample);
    else byUser.set(sample.userId, [sample]);
  }
  for (const [userId, userSamples] of byUser) {
    try {
      const profile = await userStorage.getProfile(userId);
      for (const sample of userSamples) {
        const agent = profile?.telegram?.agents?.[sample.agentId];
        if (!agent) continue;
        const runtime = { ...agent.machineRuntimeMs };
        runtime[monthKey] = (runtime[monthKey] ?? 0) + sample.ms;
        await userStorage.updateAgentFields(userId, sample.agentId, {
          machineRuntimeMs: runtime,
        });
      }
    } catch (error) {
      console.warn(`[RuntimeMeter] failed to record samples for user ${userId}`, error);
    }
  }
}
