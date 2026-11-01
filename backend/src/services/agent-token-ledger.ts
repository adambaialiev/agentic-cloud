/**
 * The ledger of the tokens each agent's turns spent (the owner, via Clara,
 * 2026-10-10): what Claude Code and Codex report for every turn, credited per
 * owner, agent, UTC day, provider and model, and kept for life.
 *
 * Shaped like the working-time ledger (AgentWorkLedger) and for the same
 * reason kept beside the agent record rather than on it: the record is hard
 * deleted with the agent, and a deleted agent's spend still happened.
 *
 * Every agent turn runs on its owner's OWN subscription, so these are the
 * owner's numbers and only the owner reads them (the Subscriptions screen).
 * The platform's own model calls — recaps, transcription — are not an agent
 * turn and never reach this ledger.
 *
 * The two providers count differently, so every row says which, and the
 * counts are normalized to one meaning before they land:
 * - `input`      fresh input, cache EXCLUDED. Claude reports it that way;
 *                OpenAI counts cached reads inside its input, so Codex's is
 *                `input_tokens - cached_input_tokens`.
 * - `output`     everything the model wrote, thinking/reasoning included
 *                (both providers count it there).
 * - `cacheRead`  input served from the prompt cache.
 * - `cacheWrite` input written to the prompt cache (Claude only).
 * - `reasoning`  the part of `output` Codex reports as reasoning (Codex
 *                only; Claude does not report thinking separately).
 */
export type TokenProvider = 'claude' | 'codex' | 'opencode';

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface AgentTokenCredit extends TokenCounts {
  userId: string;
  agentId: string;
  /** The agent's workplace; `null` for a legacy record with no `orgId`. */
  orgId: string | null;
  /** The agent's name at the time of the credit, kept past its deletion. */
  agentName: string;
  /** UTC day bucket, `YYYY-MM-DD`. */
  day: string;
  provider: TokenProvider;
  /** As the CLI reported it; `unknown` when it reported none. */
  model: string;
}

/** One owner's spend for one day, provider and model, every agent summed. */
export interface TokenDayTotal extends TokenCounts {
  day: string;
  provider: TokenProvider;
  model: string;
}

/** One owner's output tokens on one provider and UTC day, every agent and
 *  model summed. */
export interface TokenOutputDay {
  userId: string;
  day: string;
  provider: TokenProvider;
  output: number;
}

/**
 * One owner's spend for one day, provider, model AND agent — the row as it
 * is stored, for the read that keeps the agents apart (`agentbuilt usage`,
 * note #719). `agentName` is the name the last credit carried, which is how
 * a deleted agent still has one.
 */
export interface TokenAgentDayTotal extends TokenDayTotal {
  agentId: string;
  agentName: string;
  orgId: string | null;
}

/**
 * One agent's OUTPUT on one provider (note #925): every day the ledger holds
 * (`total`) and from the asked day on (`since`), for a workplace's people
 * cards — the agents kept apart, and the workplace the rows were credited
 * under, so a person's work in another workplace never shows here.
 */
export interface TokenAgentOutput {
  userId: string;
  agentId: string;
  orgId: string | null;
  provider: TokenProvider;
  total: number;
  since: number;
}

export interface AgentTokenLedger {
  credit(entry: AgentTokenCredit): void;
  /** This owner's spend from `sinceDay` (inclusive) on, summed across agents. */
  userDays(userId: string, sinceDay: string): TokenDayTotal[];
  /** The same rows with the agents kept apart. */
  userAgentDays(userId: string, sinceDay: string): TokenAgentDayTotal[];
  /**
   * Every owner's OUTPUT from `sinceDay` on, per provider and day — the one
   * count the Leaderboard shows (shared/leaderboard.ts), for its week and
   * each square of a builder's grid, and only for the people on it; the
   * caller filters.
   */
  outputDaysSince(sinceDay: string): TokenOutputDay[];
  /** These owners' OUTPUT per agent and provider, for life and from
   *  `sinceDay` on — one read for a whole workplace's cards (note #925). */
  agentOutput(userIds: readonly string[], sinceDay: string): TokenAgentOutput[];
}

export const TOKEN_COUNT_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;

export function emptyTokenCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

export function hasTokens(counts: TokenCounts): boolean {
  return TOKEN_COUNT_KEYS.some((key) => counts[key] > 0);
}

/** UTC day bucket key, e.g. `"2026-10-10"`. */
export function tokenDayKey(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/** Tests and the no-SQLite development path. */
export class InMemoryAgentTokenLedger implements AgentTokenLedger {
  private readonly rows = new Map<string, AgentTokenCredit>();

  credit(entry: AgentTokenCredit): void {
    if (!hasTokens(entry)) return;
    const key = `${entry.userId}/${entry.agentId}/${entry.day}/${entry.provider}/${entry.model}`;
    const existing = this.rows.get(key);
    if (!existing) {
      this.rows.set(key, { ...entry });
      return;
    }
    for (const count of TOKEN_COUNT_KEYS) existing[count] += entry[count];
    existing.agentName = entry.agentName;
    existing.orgId = entry.orgId ?? existing.orgId;
  }

  outputDaysSince(sinceDay: string): TokenOutputDay[] {
    const byOwnerDay = new Map<string, TokenOutputDay>();
    for (const row of this.rows.values()) {
      if (row.day < sinceDay || !(row.output > 0)) continue;
      const key = `${row.userId}/${row.day}/${row.provider}`;
      const total = byOwnerDay.get(key) ?? { userId: row.userId, day: row.day, provider: row.provider, output: 0 };
      total.output += row.output;
      byOwnerDay.set(key, total);
    }
    return [...byOwnerDay.values()];
  }

  agentOutput(userIds: readonly string[], sinceDay: string): TokenAgentOutput[] {
    const owners = new Set(userIds);
    const byAgent = new Map<string, TokenAgentOutput>();
    for (const row of this.rows.values()) {
      if (!owners.has(row.userId) || !(row.output > 0)) continue;
      const key = `${row.userId}/${row.agentId}/${row.provider}`;
      const total = byAgent.get(key)
        ?? { userId: row.userId, agentId: row.agentId, orgId: null, provider: row.provider, total: 0, since: 0 };
      total.orgId = row.orgId ?? total.orgId;
      total.total += row.output;
      if (row.day >= sinceDay) total.since += row.output;
      byAgent.set(key, total);
    }
    return [...byAgent.values()];
  }

  userDays(userId: string, sinceDay: string): TokenDayTotal[] {
    const byDay = new Map<string, TokenDayTotal>();
    for (const row of this.rows.values()) {
      if (row.userId !== userId || row.day < sinceDay) continue;
      const key = `${row.day}/${row.provider}/${row.model}`;
      const total = byDay.get(key) ?? { day: row.day, provider: row.provider, model: row.model, ...emptyTokenCounts() };
      for (const count of TOKEN_COUNT_KEYS) total[count] += row[count];
      byDay.set(key, total);
    }
    return [...byDay.values()];
  }

  userAgentDays(userId: string, sinceDay: string): TokenAgentDayTotal[] {
    const rows: TokenAgentDayTotal[] = [];
    for (const row of this.rows.values()) {
      if (row.userId !== userId || row.day < sinceDay) continue;
      const { userId: _owner, ...rest } = row;
      rows.push({ ...rest });
    }
    return rows;
  }
}

/** The Monday (UTC) of the week a day falls in, as `YYYY-MM-DD`. */
export function tokenWeekStart(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
  return at.toISOString().slice(0, 10);
}

/** One provider's spend in one week, every model and agent summed. */
export interface TokenWeekProvider extends TokenCounts {
  provider: TokenProvider;
  /** The models that spent it, most output first. */
  models: string[];
}

export interface TokenWeek {
  /** Monday, UTC, `YYYY-MM-DD`. */
  start: string;
  providers: TokenWeekProvider[];
}

/** How many weeks the owner's view reaches back, this one included. */
export const TOKEN_WEEKS_SHOWN = 8;

/** The first day the owner's view reads from, for a given now. */
export function tokenWeeksSince(nowMs: number, weeks = TOKEN_WEEKS_SHOWN): string {
  const start = new Date(`${tokenWeekStart(tokenDayKey(nowMs))}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 7 * (weeks - 1));
  return start.toISOString().slice(0, 10);
}

/**
 * Day rows folded into weeks, newest first — Claude before Codex inside a
 * week, and only weeks and providers that spent anything. The two providers
 * are never added together: they count tokens differently.
 */
export function tokenWeeks(days: TokenDayTotal[]): TokenWeek[] {
  const weeks = new Map<string, Map<TokenProvider, TokenWeekProvider & { byModel: Map<string, number> }>>();
  for (const row of days) {
    const start = tokenWeekStart(row.day);
    const providers = weeks.get(start) ?? new Map();
    const entry = providers.get(row.provider) ?? { provider: row.provider, models: [], byModel: new Map(), ...emptyTokenCounts() };
    for (const key of TOKEN_COUNT_KEYS) entry[key] += Number(row[key]) || 0;
    entry.byModel.set(row.model, (entry.byModel.get(row.model) ?? 0) + (Number(row.output) || 0));
    providers.set(row.provider, entry);
    weeks.set(start, providers);
  }
  const order: TokenProvider[] = ['claude', 'codex', 'opencode'];
  return [...weeks.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([start, providers]) => ({
      start,
      providers: [...providers.values()]
        .filter((entry) => hasTokens(entry))
        .sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider))
        .map(({ byModel, ...entry }) => ({
          ...entry,
          models: [...byModel.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model]) => model),
        })),
    }))
    .filter((week) => week.providers.length > 0);
}

/** One agent's share of a model's week (`agentbuilt usage`, note #719). */
export interface TokenWeekAgent extends TokenCounts {
  agentId: string;
  /** The name the ledger last saw; the route swaps in the live one where the agent still exists. */
  name: string;
  orgId: string | null;
}

export interface TokenWeekModel extends TokenCounts {
  model: string;
  /** Most output first. */
  agents: TokenWeekAgent[];
}

export interface TokenWeekProviderByAgent extends TokenCounts {
  provider: TokenProvider;
  /** Most output first. */
  models: TokenWeekModel[];
}

export interface TokenWeekByAgent {
  /** Monday, UTC, `YYYY-MM-DD`. */
  start: string;
  providers: TokenWeekProviderByAgent[];
}

/**
 * The agent-keeping fold: the same weeks `tokenWeeks` makes, newest first
 * and Claude before Codex, but each provider opens into its models and each
 * model into the agents that spent it, most output first at every level.
 * The two providers are still never added together.
 */
export function tokenWeeksByAgent(rows: TokenAgentDayTotal[]): TokenWeekByAgent[] {
  type AgentAcc = TokenWeekAgent;
  type ModelAcc = TokenCounts & { model: string; agents: Map<string, AgentAcc> };
  type ProviderAcc = TokenCounts & { provider: TokenProvider; models: Map<string, ModelAcc> };
  const weeks = new Map<string, Map<TokenProvider, ProviderAcc>>();
  for (const row of rows) {
    const start = tokenWeekStart(row.day);
    const providers = weeks.get(start) ?? new Map<TokenProvider, ProviderAcc>();
    const provider = providers.get(row.provider) ?? { provider: row.provider, models: new Map(), ...emptyTokenCounts() };
    const model = provider.models.get(row.model) ?? { model: row.model, agents: new Map(), ...emptyTokenCounts() };
    const agent = model.agents.get(row.agentId)
      ?? { agentId: row.agentId, name: row.agentName, orgId: row.orgId, ...emptyTokenCounts() };
    for (const key of TOKEN_COUNT_KEYS) {
      const count = Number(row[key]) || 0;
      provider[key] += count;
      model[key] += count;
      agent[key] += count;
    }
    agent.name = row.agentName || agent.name;
    agent.orgId = row.orgId ?? agent.orgId;
    model.agents.set(row.agentId, agent);
    provider.models.set(row.model, model);
    providers.set(row.provider, provider);
    weeks.set(start, providers);
  }
  const order: TokenProvider[] = ['claude', 'codex', 'opencode'];
  const byOutput = <T extends TokenCounts>(a: T, b: T, name: (entry: T) => string) =>
    b.output - a.output || name(a).localeCompare(name(b));
  return [...weeks.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([start, providers]) => ({
      start,
      providers: [...providers.values()]
        .filter((entry) => hasTokens(entry))
        .sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider))
        .map(({ models, ...provider }) => ({
          ...provider,
          models: [...models.values()]
            .sort((a, b) => byOutput(a, b, (entry) => entry.model))
            .map(({ agents, ...model }) => ({
              ...model,
              agents: [...agents.values()].sort((a, b) => byOutput(a, b, (entry) => entry.name)),
            })),
        })),
    }))
    .filter((week) => week.providers.length > 0);
}
