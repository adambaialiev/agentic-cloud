import { statfs } from 'node:fs/promises';
import type { SqliteDb } from './sqlite/sqlite-db.js';
import { deserializeDoc } from './sqlite/sqlite-db.js';
import { COPY_CLIS, type CopyCli, type CopyCounts } from '../shared/copy-pulse.js';
import type { CopyPulseFacts } from './copy-pulse-sender.js';

/**
 * The counts in a copy's pulse (note #1057), read from the copy's own
 * database. Counts only: no names, no messages, no addresses.
 *
 *   people            members of a workplace, and people waiting to join one
 *   agentsByCli       agents per CLI: the people's agents, as the roster
 *                     lists them, so never a workplace-wide record such as
 *                     the Chief of Staff (note #1082)
 *   turnsLast24hByCli those agents' replies in chats over the last 24 hours,
 *                     per CLI
 *   machineHours24h   hours agents spent working in turns over the last 24
 *                     hours (the work ledger keeps UTC days: today's whole,
 *                     yesterday's in proportion to the part inside the window)
 *   sitesLive         sites serving now
 *   lastActivityAt    the newest moment any agent was used
 *   health            backup age, free disk, and the health page's verdict
 */
export interface CopyPulseFactsDeps {
  db: SqliteDb;
  countPeople: () => Promise<number>;
  /** When the database was last backed up well, if it was. */
  lastBackupAt?: () => string | null;
  /** The directory the database lives in, for free disk. */
  dataDir?: string;
  /**
   * The health page's report, read once per pulse: its parts (every one ok →
   * "ok", else "trouble") and the release check's state (current, behind,
   * unknown or off).
   */
  healthReport?: () => Promise<{ parts: Array<{ ok: boolean }>; updates: { state: string } }>;
  now?: () => Date;
}

const zero = (): CopyCounts => ({ claude: 0, codex: 0, opencode: 0 });
const cliOf = (value: unknown): CopyCli | null => (COPY_CLIS.includes(value as CopyCli) ? value as CopyCli : null);

interface AgentDoc { cli?: unknown; purpose?: unknown; deletedAt?: unknown; removedAt?: unknown }

export async function collectCopyPulseFacts(deps: CopyPulseFactsDeps): Promise<CopyPulseFacts> {
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - 86_400_000);

  // Agents, and which CLI each one runs.
  const agentsByCli = zero();
  const cliByAgent = new Map<string, CopyCli>();
  // The Chief of Staff (purpose workspace-recap) and the briefing machine
  // are no one's agents: the roster leaves out every record with a purpose,
  // and so does the count. A copy's first pulse said claude: 1 before any
  // agent existed (note #1082).
  const workplaceRecords = new Set<string>();
  for (const row of deps.db.prepare('SELECT user_id, doc FROM users').iterate() as IterableIterator<{ user_id: string; doc: string }>) {
    const profile = deserializeDoc<{ telegram?: { agents?: Record<string, AgentDoc> } }>(row.doc);
    for (const [agentId, agent] of Object.entries(profile.telegram?.agents ?? {})) {
      if (!agent) continue;
      if (agent.purpose) { workplaceRecords.add(`${row.user_id}/${agentId}`); continue; }
      if (agent.deletedAt || agent.removedAt) continue;
      const cli = cliOf(agent.cli) ?? 'claude';
      agentsByCli[cli] += 1;
      cliByAgent.set(`${row.user_id}/${agentId}`, cli);
    }
  }

  // Turns: the agent's replies in its chat.
  const turnsLast24hByCli = zero();
  const turns = deps.db.prepare(
    "SELECT user_id, agent_id, COUNT(*) AS n FROM agent_chat_messages"
    + " WHERE json_extract(doc, '$.role') = 'agent' AND json_extract(doc, '$.at') >= ?"
    + ' GROUP BY user_id, agent_id',
  ).all(since.toISOString()) as Array<{ user_id: string; agent_id: string; n: number }>;
  for (const row of turns) if (!workplaceRecords.has(`${row.user_id}/${row.agent_id}`)) turnsLast24hByCli[cliByAgent.get(`${row.user_id}/${row.agent_id}`) ?? 'claude'] += row.n;

  // Working time: today's row whole, yesterday's in proportion.
  const today = now.toISOString().slice(0, 10);
  const yesterday = since.toISOString().slice(0, 10);
  const dayMs = (day: string) => (deps.db.prepare('SELECT COALESCE(SUM(working_ms), 0) AS ms FROM agent_work_days WHERE day = ?').get(day) as { ms: number }).ms;
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yesterdayShare = yesterday === today ? 0 : (midnight - since.getTime()) / 86_400_000;
  const workingMs = dayMs(today) + (yesterdayShare > 0 ? dayMs(yesterday) * yesterdayShare : 0);
  const machineHours24h = Math.round((workingMs / 3_600_000) * 10) / 10;

  const sitesLive = (deps.db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE json_extract(doc, '$.status') = 'live'").get() as { n: number }).n;

  const lastActiveMs = (deps.db.prepare('SELECT MAX(last_active_at_ms) AS ms FROM telegram_agent_activity').get() as { ms: number | null }).ms;
  const lastActivityAt = lastActiveMs ? new Date(lastActiveMs).toISOString() : null;

  const backupAt = deps.lastBackupAt?.() ?? null;
  const backupAgeHours = backupAt ? Math.max(0, Math.round(((now.getTime() - new Date(backupAt).getTime()) / 3_600_000) * 10) / 10) : null;

  let diskFreePercent: number | null = null;
  if (deps.dataDir) {
    try {
      const s = await statfs(deps.dataDir);
      diskFreePercent = s.blocks ? Math.round((s.bavail / s.blocks) * 100) : null;
    } catch { /* not measured */ }
  }

  const report = await deps.healthReport?.().catch(() => null) ?? null;
  const state = report ? (report.parts.every((part) => part.ok) ? 'ok' : 'trouble') : 'unknown';

  return {
    people: await deps.countPeople(),
    agentsByCli,
    turnsLast24hByCli,
    machineHours24h,
    sitesLive,
    lastActivityAt,
    health: { backupAgeHours, diskFreePercent, state },
    updatesState: report?.updates.state ?? 'unknown',
  };
}
