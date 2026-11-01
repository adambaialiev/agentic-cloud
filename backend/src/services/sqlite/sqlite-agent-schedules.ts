import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import type { AgentSchedule } from '../../types/agent-schedule.js';
import { isLive, type AgentScheduleStorage } from '../agent-schedule-storage.js';

/** Schedules (note #779) in SQLite: one doc per row, keyed for the three reads the service makes. */
export class SqliteAgentScheduleStorage implements AgentScheduleStorage {
  constructor(private readonly db: SqliteDb) {}

  async get(id: string): Promise<AgentSchedule | null> {
    const row = this.db.prepare('SELECT doc FROM agent_schedules WHERE schedule_id = ?').get(id) as { doc: string } | undefined;
    return row ? deserializeDoc<AgentSchedule>(row.doc) : null;
  }

  async put(schedule: AgentSchedule): Promise<void> {
    this.db.prepare(
      'INSERT INTO agent_schedules (schedule_id, org_id, agent_id, live, doc) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT(schedule_id) DO UPDATE SET org_id = excluded.org_id, agent_id = excluded.agent_id, live = excluded.live, doc = excluded.doc',
    ).run(schedule.id, schedule.orgId, schedule.agentId, isLive(schedule) ? 1 : 0, serializeDoc(schedule));
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM agent_schedules WHERE schedule_id = ?').run(id);
  }

  async listByAgent(agentId: string): Promise<AgentSchedule[]> {
    const rows = this.db.prepare('SELECT doc FROM agent_schedules WHERE agent_id = ?').all(agentId) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<AgentSchedule>(row.doc));
  }

  async listByOrg(orgId: string): Promise<AgentSchedule[]> {
    const rows = this.db.prepare('SELECT doc FROM agent_schedules WHERE org_id = ?').all(orgId) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<AgentSchedule>(row.doc));
  }

  async listLive(): Promise<AgentSchedule[]> {
    const rows = this.db.prepare('SELECT doc FROM agent_schedules WHERE live = 1').all() as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<AgentSchedule>(row.doc));
  }
}
