import type { AgentSchedule } from '../types/agent-schedule.js';

/** Durable schedules (note #779): one doc per schedule, read back by agent, by org, or all active for the sweep. */
export interface AgentScheduleStorage {
  get(id: string): Promise<AgentSchedule | null>;
  put(schedule: AgentSchedule): Promise<void>;
  delete(id: string): Promise<void>;
  listByAgent(agentId: string): Promise<AgentSchedule[]>;
  listByOrg(orgId: string): Promise<AgentSchedule[]>;
  /** Every schedule the sweep must look at: active, or paused for a reason that lifts by itself. */
  listLive(): Promise<AgentSchedule[]>;
}

export class InMemoryAgentScheduleStorage implements AgentScheduleStorage {
  private readonly docs = new Map<string, AgentSchedule>();

  async get(id: string): Promise<AgentSchedule | null> {
    const doc = this.docs.get(id);
    return doc ? structuredClone(doc) : null;
  }

  async put(schedule: AgentSchedule): Promise<void> {
    this.docs.set(schedule.id, structuredClone(schedule));
  }

  async delete(id: string): Promise<void> {
    this.docs.delete(id);
  }

  async listByAgent(agentId: string): Promise<AgentSchedule[]> {
    return [...this.docs.values()].filter((doc) => doc.agentId === agentId).map((doc) => structuredClone(doc));
  }

  async listByOrg(orgId: string): Promise<AgentSchedule[]> {
    return [...this.docs.values()].filter((doc) => doc.orgId === orgId).map((doc) => structuredClone(doc));
  }

  async listLive(): Promise<AgentSchedule[]> {
    return [...this.docs.values()].filter(isLive).map((doc) => structuredClone(doc));
  }
}

export function isLive(doc: AgentSchedule): boolean {
  return doc.status === 'active' || (doc.status === 'paused' && doc.pause?.reason === 'cap');
}
