import type { AgentRecord } from '../types/user.js';
import {
  hasTokens,
  tokenDayKey,
  type AgentTokenLedger,
  type TokenCounts,
  type TokenProvider,
} from '../services/agent-token-ledger.js';

/**
 * What one agent turn spent, in the token ledger's normalized counts
 * (agent-token-ledger.ts), per model — and the one place a turn credits it.
 */
export type TurnTokens = Map<string, TokenCounts>;

function count(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Where a Claude Code conversation's per-model running total stood after the
 * last turn the ledger credited.
 */
export interface ClaudeTokenBase {
  sessionId: string;
  models: Record<string, TokenCounts>;
}

/**
 * A Claude Code turn's spend, read off the `result` event that ends its run.
 * Three things about that event, each measured on 2026-10-10 against a real
 * turn of this platform (claude-code 2.1.293) and its own transcript:
 *
 * - `modelUsage` is a RUNNING TOTAL for the conversation, carried across
 *   `--resume`: it equalled the sum of the whole session's transcript to the
 *   token (130,160 output), while the run itself had written 72,949. Crediting
 *   it as it stands would count the entire conversation again every turn. So,
 *   as with Codex, a turn's spend is the total now less the last one — and
 *   that difference matched the run's own `usage` on all four counts.
 * - It is the only place the helper agents a turn starts (Task/Agent tool)
 *   are counted: a Haiku helper's 25.9k tokens were under its model there and
 *   nowhere in the parent stream, whose `assistant` events are the main
 *   thread's alone.
 * - Those `assistant` events cannot stand in for it. They carry each
 *   request's usage as it STARTED: input and cache are right, output is not
 *   (1,244 summed, against 72,949 written).
 *
 * So a run that never writes `result` — stopped, or killed — is credited
 * nothing here, and is not lost: its requests are in the conversation's total
 * the next turn reads, and the difference spans them.
 */
export class ClaudeTurnTokens {
  private cumulative: TurnTokens | null = null;
  private run: TokenCounts | null = null;

  observe(event: { type?: unknown; [key: string]: unknown }): void {
    if (event.type !== 'result') return;
    if (typeof event.modelUsage === 'object' && event.modelUsage) {
      const perModel: TurnTokens = new Map();
      for (const [model, raw] of Object.entries(event.modelUsage as Record<string, unknown>)) {
        if (typeof raw !== 'object' || !raw) continue;
        const usage = raw as Record<string, unknown>;
        const counts: TokenCounts = {
          input: count(usage, 'inputTokens'),
          output: count(usage, 'outputTokens'),
          cacheRead: count(usage, 'cacheReadInputTokens'),
          cacheWrite: count(usage, 'cacheCreationInputTokens'),
          reasoning: 0,
        };
        if (hasTokens(counts)) perModel.set(model, counts);
      }
      if (perModel.size > 0) this.cumulative = perModel;
    }
    if (typeof event.usage === 'object' && event.usage) {
      const usage = event.usage as Record<string, unknown>;
      const counts: TokenCounts = {
        input: count(usage, 'input_tokens'),
        output: count(usage, 'output_tokens'),
        cacheRead: count(usage, 'cache_read_input_tokens'),
        cacheWrite: count(usage, 'cache_creation_input_tokens'),
        reasoning: 0,
      };
      if (hasTokens(counts)) this.run = counts;
    }
  }

  /**
   * What to credit for this run, and the base to keep for the next — or null
   * when the run wrote no result.
   *
   * - The conversation the base belongs to: the difference, per model. A
   *   model whose total went DOWN cannot be a difference and counts from zero.
   * - A conversation this run started: its whole total, which is this run.
   * - A conversation resumed with no base for it (older than the ledger, or
   *   one whose id moved): the run's own `usage` under its main model — exact
   *   for the main thread, without this one turn's helpers — and the base set
   *   now makes every later turn whole.
   * - A CLI that reports no `modelUsage`: the run's own `usage`, no base.
   */
  settle(args: {
    sessionId: string | undefined;
    startedSession: boolean;
    base?: ClaudeTokenBase;
    model: string | undefined;
  }): { perModel: TurnTokens; base?: ClaudeTokenBase } | null {
    const runOnly = (): TurnTokens => new Map(this.run ? [[args.model ?? 'unknown', this.run]] : []);
    if (!this.cumulative || !args.sessionId) {
      return this.run ? { perModel: runOnly() } : null;
    }
    const base: ClaudeTokenBase = { sessionId: args.sessionId, models: Object.fromEntries(this.cumulative) };
    if (args.base?.sessionId === args.sessionId) {
      const perModel: TurnTokens = new Map();
      for (const [model, now] of this.cumulative) {
        const before = args.base.models[model];
        const went: TokenCounts = {
          input: now.input - (before?.input ?? 0),
          output: now.output - (before?.output ?? 0),
          cacheRead: now.cacheRead - (before?.cacheRead ?? 0),
          cacheWrite: now.cacheWrite - (before?.cacheWrite ?? 0),
          reasoning: 0,
        };
        perModel.set(model, Object.values(went).some((value) => value < 0) ? now : went);
      }
      return { perModel, base };
    }
    return { perModel: args.startedSession ? this.cumulative : runOnly(), base };
  }
}

/**
 * A Codex thread's running total, as its rollout's `token_count` reports it
 * (`total_token_usage`) — OpenAI's own counts, cached input INSIDE input and
 * reasoning INSIDE output.
 */
export interface CodexTokenTotal {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

/** The running total a thread stood at after the last turn we credited. */
export interface CodexTokenBase extends CodexTokenTotal {
  threadId: string;
}

/**
 * One Codex turn's spend: the thread's running total now, less where it
 * stood after the last credited turn. Codex has no per-turn figure — every
 * number it reports for a thread is cumulative (codex-context.ts).
 *
 * - Same thread as the base: the difference. A turn whose reading failed is
 *   not lost, because the next difference spans it.
 * - A thread this turn started: all of it, from zero.
 * - A thread resumed with no base for it (a conversation older than the
 *   ledger, or one whose base was lost): nothing — its history would land on
 *   today as one enormous turn. The base set now makes the next turn count.
 * - A total that went DOWN on the same thread cannot be a difference; it is
 *   treated as a fresh start, like a new thread.
 */
export function codexTurnTokens(args: {
  total: CodexTokenTotal;
  threadId: string;
  startedThisTurn: boolean;
  base?: CodexTokenBase;
}): TokenCounts | null {
  const { total, base } = args;
  let spent: CodexTokenTotal;
  if (base && base.threadId === args.threadId) {
    const went = {
      input: total.input - base.input,
      cachedInput: total.cachedInput - base.cachedInput,
      output: total.output - base.output,
      reasoning: total.reasoning - base.reasoning,
    };
    spent = Object.values(went).some((value) => value < 0) ? total : went;
  } else if (args.startedThisTurn) {
    spent = total;
  } else {
    return null;
  }
  return {
    input: Math.max(0, spent.input - spent.cachedInput),
    output: spent.output,
    cacheRead: spent.cachedInput,
    cacheWrite: 0,
    reasoning: spent.reasoning,
  };
}

/**
 * One OpenCode turn's spend (note #780): the sum of its steps. OpenCode's
 * `step_finish` figures are ONE request each — not a running total, within
 * a turn or across a resumed session (measured with a stub provider against
 * opencode 1.19.3, 2026-10-20) — so there is no base to keep and nothing to
 * subtract, and a stopped turn still counts every request that finished.
 *
 * Its counts are already split the ledger's way: `input` leaves the cache
 * reads out, and `output` leaves the reasoning out, so reasoning is added
 * back into output (the ledger's output is everything the model wrote) and
 * kept as its own subset too.
 *
 * What it cannot see: a helper agent's requests (the `task` tool) run in a
 * child session whose lines `opencode run` does not print.
 */
export class OpenCodeTurnTokens {
  private counts: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

  observe(tokens: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: unknown } | null | undefined): void {
    if (!tokens) return;
    const cache = (typeof tokens.cache === 'object' && tokens.cache ? tokens.cache : {}) as Record<string, unknown>;
    const reasoning = count(tokens as Record<string, unknown>, 'reasoning');
    this.counts = {
      input: this.counts.input + count(tokens as Record<string, unknown>, 'input'),
      output: this.counts.output + count(tokens as Record<string, unknown>, 'output') + reasoning,
      cacheRead: this.counts.cacheRead + count(cache, 'read'),
      cacheWrite: this.counts.cacheWrite + count(cache, 'write'),
      reasoning: this.counts.reasoning + reasoning,
    };
  }

  /** What the turn spent so far, or null when no step has finished. */
  spent(): TokenCounts | null {
    return hasTokens(this.counts) ? { ...this.counts } : null;
  }
}

/**
 * Credit one turn to its agent's owner. Never throws: a ledger write is
 * bookkeeping, and a turn that worked must not fail on it.
 */
export function creditTurnTokens(args: {
  ledger: AgentTokenLedger | undefined;
  userId: string;
  agent: Pick<AgentRecord, 'id' | 'name' | 'orgId'> | undefined;
  provider: TokenProvider;
  perModel: TurnTokens;
  atMs?: number;
}): void {
  const { ledger, agent } = args;
  if (!ledger || !agent?.id) return;
  const day = tokenDayKey(args.atMs ?? Date.now());
  for (const [model, counts] of args.perModel) {
    if (!hasTokens(counts)) continue;
    try {
      ledger.credit({
        userId: args.userId,
        agentId: agent.id,
        orgId: agent.orgId ?? null,
        agentName: agent.name ?? agent.id,
        day,
        provider: args.provider,
        model: model || 'unknown',
        ...counts,
      });
    } catch (error) {
      console.warn(`[turn-tokens] Could not credit ${args.provider} tokens for agent ${agent.id}:`, error);
    }
  }
}
