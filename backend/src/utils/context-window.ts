import type { TokenUsageData } from '../types/agent.js';
import { MODEL_PRICING, getContextWindow } from '../config/pricing.js';

/**
 * Context windows for the models the FLEET actually runs, which is not the same
 * list as the models this backend prices.
 *
 * `MODEL_PRICING` exists to bill: an entry there is a claim about money, and
 * the harness models are billed to the user's own Claude plan rather than
 * metered here, so they are legitimately absent from it. Adding them there to
 * borrow the `contextWindow` field would mean inventing per-million prices for
 * models nobody prices — a wrong number in the one place wrong numbers cost
 * real money.
 *
 * So: a separate map, because a context window and a price are different
 * facts about a model and only one of them is dangerous to guess.
 *
 * The 1M figure is this repository's own, from the `anthropic/claude-sonnet-5`
 * entry in `MODEL_PRICING`. If a plan ever runs one of these at the shorter
 * 200k window, this constant is the one place to correct — and the percentage
 * would be the thing that told you, by reading impossibly low.
 *
 * Found by verifying #141 in production rather than by reasoning: the fleet
 * reported `claude-opus-5`, which was in neither list, so the row this was all
 * built for could never once have appeared (2026-08-17).
 */
const HARNESS_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-opus-5': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4.5': 200_000,
};

/**
 * The context window for a model id as a HARNESS reported it, which is not the
 * id the catalogue is keyed by: the catalogue says `anthropic/claude-sonnet-5`
 * and the stream says `claude-sonnet-5-20260320`. Exact lookup first, then a
 * family match on a normalised key (case, provider prefix, dots and dashes all
 * flattened away, so `claude-haiku-4.5` and `claude-haiku-4-5-20251001` become
 * the same string plus a date).
 *
 * The LONGEST matching family wins, so a future `…-5-mini` cannot be answered
 * by the entry for `…-5`.
 *
 * Returns null for anything unrecognised, and that matters more than the
 * matching does: the caller draws a percentage, and a percentage of a guessed
 * denominator looks exactly as authoritative as a real one. No answer is the
 * correct answer for a model we do not know the shape of.
 */
export function contextWindowForReportedModel(model: string | null | undefined): number | null {
  if (!model?.trim()) return null;
  const exact = getContextWindow(model.trim());
  if (exact) return exact;
  const flatten = (value: string): string => value
    .toLowerCase()
    .replace(/^[a-z0-9]+\//, '')
    .replace(/[^a-z0-9]/g, '');
  const reported = flatten(model);
  const families: Array<[string, number]> = [
    ...Object.entries(HARNESS_CONTEXT_WINDOWS),
    ...Object.entries(MODEL_PRICING)
      .filter(([, entry]) => Boolean(entry.contextWindow))
      .map(([key, entry]): [string, number] => [key, entry.contextWindow!]),
  ];
  let best: { key: string; window: number } | null = null;
  for (const [key, window] of families) {
    const candidate = flatten(key);
    if (!candidate || !reported.startsWith(candidate)) continue;
    if (!best || candidate.length > flatten(best.key).length) {
      best = { key, window };
    }
  }
  return best?.window ?? null;
}

/**
 * What the record stores after a turn: the size of the last prompt actually
 * sent, and the model id the STREAM reported (not the catalogue's key).
 *
 * Structural rather than imported from `types/user.ts` so this util stays a
 * leaf — it is reached from a route, the harness and the tests, and none of
 * them should drag the user document in behind it.
 */
export interface StoredContextUsage {
  tokens: number;
  model?: string;
  /**
   * The window the CLI itself reported for that prompt, when it reports one.
   * Codex does (`model_context_window` on every `token_count`), and its figure
   * is the one it enforces — 258,400 for a model whose catalog entry says
   * 272,000, because the CLI reserves room for the reply. Claude's stream says
   * nothing about its window, so those readings still resolve by model.
   *
   * Preferred over the lookup wherever it exists: a number the running CLI
   * stated cannot go stale the way a table in this repository can.
   */
  window?: number;
  at: string;
}

/** A fill that can actually be stated: percentage, and the two raw numbers. */
export interface ContextUsageReading {
  usedPercent: number;
  tokens: number;
  window: number;
  at: string;
}

/**
 * A stored measurement turned into a fill, or `null` when a percentage would
 * be invented: no turn measured yet, or a model this backend holds no window
 * for. Both callers must refuse in the same breath — a number that looks
 * authoritative is worse than a missing one.
 *
 * THE one home for the rule, for the reason `worstCheckState` is: the Mini App
 * bar and the line the agent reads about itself are two renderings of one
 * fact, and two copies of this arithmetic is how they start disagreeing about
 * the same agent on the same screen.
 */
export function resolveContextUsage(usage: StoredContextUsage | null | undefined): ContextUsageReading | null {
  if (!usage?.tokens) return null;
  const window = (usage.window && usage.window > 0)
    ? usage.window
    : contextWindowForReportedModel(usage.model);
  if (!window) return null;
  return {
    // Capped at 100: a window can be over-filled in principle (a request that
    // overflows is refused, not silently truncated), and a bar past its own
    // end reads as a rendering fault rather than as a warning.
    usedPercent: Math.min(100, Math.round((usage.tokens / window) * 100)),
    tokens: usage.tokens,
    window,
    at: usage.at,
  };
}

/** `402k`, `1M`, `840` — a token count at the size a sentence can carry. */
function compactTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${Math.round(count / 100_000) / 10}M`;
}

/**
 * The one line an agent is told about its own context window, appended to the
 * turn's prompt — or null when there is nothing true to say.
 *
 * WHY THE PROMPT AND NOT THE SYSTEM PROMPT: this number changes every turn,
 * and the system prompt is the head of the cache prefix. Injected there
 * (`--append-system-prompt`) it would invalidate the whole prompt cache on
 * every single turn — and since the fill is mostly CACHE READS, the feature
 * that reports the window would be the thing inflating it. Appended after the
 * user's message it sits at the END of the context, where it costs its own
 * ~30 tokens and invalidates nothing.
 *
 * WHY NOT THE IDENTITY BLOCK: ~/CLAUDE.md is rewritten on a version bump, an
 * `about` drift or a boot — never per turn. A percentage written there would
 * be a stale number stated as a current fact, which is worse than silence.
 * (Wiring it to the drift check instead would mean an SSH round trip every
 * turn, on a hot path built to avoid exactly that.)
 */
export function buildContextUsageNote(usage: StoredContextUsage | null | undefined): string | null {
  const reading = resolveContextUsage(usage);
  if (!reading) return null;
  return `[Platform] Context window: about ${reading.usedPercent}% full as of your last turn`
    + ` (${compactTokens(reading.tokens)} of ${compactTokens(reading.window)} tokens).`
    + ' It only grows as this conversation does — starting a fresh chat is what resets it.';
}

export interface ContextRemainingEstimate {
  label: string;
  contextUsed: number;
  contextWindow: number;
  usedPercentage: number;
  remainingPercentage: number;
}

export function getContextRemainingEstimate(args: {
  model?: string | null;
  tokenUsage?: Pick<TokenUsageData, 'lastInputTokens'> | null;
}): ContextRemainingEstimate | null {
  const contextWindow = args.model ? getContextWindow(args.model) : null;
  const contextUsed = args.tokenUsage?.lastInputTokens ?? 0;
  if (!contextWindow || contextUsed <= 0) {
    return null;
  }

  const rawRemainingPercentage = Math.max(((contextWindow - contextUsed) / contextWindow) * 100, 0);
  let label = `${Math.round(rawRemainingPercentage)}%`;
  if (rawRemainingPercentage < 1) {
    label = '<1%';
  } else if (rawRemainingPercentage > 99) {
    label = '>99%';
  }

  const usedPercentage = Math.round((contextUsed / contextWindow) * 100);
  const remainingPercentage = Math.max(Math.round(rawRemainingPercentage), 0);

  return {
    label,
    contextUsed,
    contextWindow,
    usedPercentage,
    remainingPercentage,
  };
}