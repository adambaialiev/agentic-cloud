import { describe, expect, it } from 'vitest';
import { ClaudeTurnTokens, codexTurnTokens, creditTurnTokens } from '../../agent/turn-tokens.js';
import { InMemoryAgentTokenLedger } from '../../services/agent-token-ledger.js';

/**
 * The `result` event of a real turn on this platform (claude-code 2.1.293,
 * 2026-10-10), cut to the fields that matter. `usage` is what THAT RUN wrote;
 * `modelUsage` is the conversation's running total, which equalled the sum of
 * the whole session transcript to the token — and holds the Haiku helper the
 * turn started, which the parent stream never showed.
 */
const REAL_RESULT = {
  type: 'result',
  subtype: 'success',
  usage: { input_tokens: 208, output_tokens: 72_949, cache_read_input_tokens: 28_729_960, cache_creation_input_tokens: 166_574 },
  modelUsage: {
    'claude-opus-5-5': { inputTokens: 394, outputTokens: 130_160, cacheReadInputTokens: 39_093_327, cacheCreationInputTokens: 501_738 },
    'claude-haiku-5-5': { inputTokens: 42_235, outputTokens: 2_161, cacheReadInputTokens: 0, cacheCreationInputTokens: 25_923 },
  },
};
/** Where that conversation's total stood when the turn began (from its transcript). */
const BASE_BEFORE = {
  sessionId: 'sess-1',
  models: {
    'claude-opus-5-5': { input: 186, output: 57_211, cacheRead: 10_363_367, cacheWrite: 335_164, reasoning: 0 },
    'claude-haiku-5-5': { input: 42_235, output: 2_100, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  },
};

describe('a Claude Code turn’s tokens: the conversation’s running total, less the last one', () => {
  const settled = (args: Partial<Parameters<ClaudeTurnTokens['settle']>[0]>, ...events: object[]) => {
    const turn = new ClaudeTurnTokens();
    for (const event of events) turn.observe(event);
    const result = turn.settle({ sessionId: 'sess-1', startedSession: false, model: 'claude-opus-5-5', ...args });
    return result && { ...result, perModel: Object.fromEntries(result.perModel) };
  };

  it('credits the difference, which is the run’s own usage plus the helper agent it started', () => {
    const result = settled({ base: BASE_BEFORE }, REAL_RESULT);
    expect(result?.perModel).toEqual({
      // Exactly the run's own `usage`: 72,949 written, not the 130,160 total.
      'claude-opus-5-5': { input: 208, output: 72_949, cacheRead: 28_729_960, cacheWrite: 166_574, reasoning: 0 },
      // The helper, under its own model.
      'claude-haiku-5-5': { input: 0, output: 61, cacheRead: 0, cacheWrite: 25_923, reasoning: 0 },
    });
    expect(result?.base).toEqual({
      sessionId: 'sess-1',
      models: {
        'claude-opus-5-5': { input: 394, output: 130_160, cacheRead: 39_093_327, cacheWrite: 501_738, reasoning: 0 },
        'claude-haiku-5-5': { input: 42_235, output: 2_161, cacheRead: 0, cacheWrite: 25_923, reasoning: 0 },
      },
    });
  });

  // claude-code 2.1.316 (the fleet pin since 2026-10-31, note #929) also
  // splits each model's cache writes by lifetime. The total beside them is
  // still the sum (1,200 = 400 + 800, read against a stub provider), so the
  // split must never be counted on top of it.
  it('counts cache writes once when the CLI also reports them by lifetime', () => {
    const result = settled({ startedSession: true }, {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 2_015, output_tokens: 150, cache_read_input_tokens: 100, cache_creation_input_tokens: 600 },
      modelUsage: {
        'claude-sonnet-5-5': {
          inputTokens: 4_026, outputTokens: 260, thinkingTokens: 0, cacheReadInputTokens: 200,
          cacheCreationInputTokens: 1_200, cacheCreationEphemeral5mInputTokens: 400, cacheCreationEphemeral1hInputTokens: 800,
        },
      },
    });
    expect(result?.perModel).toEqual({
      'claude-sonnet-5-5': { input: 4_026, output: 260, cacheRead: 200, cacheWrite: 1_200, reasoning: 0 },
    });
  });

  it('counts a conversation the run started from zero', () => {
    expect(settled({ startedSession: true, base: { ...BASE_BEFORE, sessionId: 'another' } }, REAL_RESULT)?.perModel)
      .toMatchObject({ 'claude-opus-5-5': { output: 130_160 }, 'claude-haiku-5-5': { output: 2_161 } });
  });

  it('on a conversation older than the ledger, credits the run’s own usage and sets the base', () => {
    const result = settled({}, REAL_RESULT);
    // Never the whole conversation's 130,160 landing on one day.
    expect(result?.perModel).toEqual({
      'claude-opus-5-5': { input: 208, output: 72_949, cacheRead: 28_729_960, cacheWrite: 166_574, reasoning: 0 },
    });
    expect(result?.base?.models['claude-opus-5-5']?.output).toBe(130_160);
  });

  it('never takes its figures from assistant events, whose output is the request’s first token count', () => {
    // What the stream showed for that same turn: 1,244 output, summed.
    const assistant = {
      type: 'assistant',
      message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 208, output_tokens: 1_244 } },
    };
    // A stopped run: nothing to credit now, and no base moved — the next
    // turn's total spans it.
    expect(settled({ base: BASE_BEFORE }, assistant)).toBeNull();
  });

  it('counts a model whose total went down from zero, never as a negative', () => {
    const result = settled({
      base: { sessionId: 'sess-1', models: { 'claude-opus-5-5': { input: 1, output: 999_999, cacheRead: 1, cacheWrite: 1, reasoning: 0 } } },
    }, REAL_RESULT);
    expect(result?.perModel['claude-opus-5-5']?.output).toBe(130_160);
  });

  it('falls back to the run’s own usage when the CLI reports no per-model total', () => {
    const result = settled({ base: BASE_BEFORE }, { type: 'result', usage: REAL_RESULT.usage });
    expect(result).toEqual({
      perModel: { 'claude-opus-5-5': { input: 208, output: 72_949, cacheRead: 28_729_960, cacheWrite: 166_574, reasoning: 0 } },
    });
  });
});

describe('a Codex turn’s tokens: the thread’s running total, less the last one', () => {
  const total = { input: 10_000, cachedInput: 8_000, output: 300, reasoning: 120 };

  it('takes the difference on the same thread, cache out of input, reasoning kept as part of output', () => {
    expect(codexTurnTokens({
      total,
      threadId: 'th-1',
      startedThisTurn: false,
      base: { threadId: 'th-1', input: 4_000, cachedInput: 3_500, output: 100, reasoning: 20 },
    })).toEqual({ input: 1_500, output: 200, cacheRead: 4_500, cacheWrite: 0, reasoning: 100 });
  });

  it('counts a thread this turn started from zero', () => {
    expect(codexTurnTokens({ total, threadId: 'th-2', startedThisTurn: true, base: { threadId: 'th-1', ...total } }))
      .toEqual({ input: 2_000, output: 300, cacheRead: 8_000, cacheWrite: 0, reasoning: 120 });
  });

  it('credits nothing for a thread older than the ledger, instead of landing its whole history on today', () => {
    expect(codexTurnTokens({ total, threadId: 'th-1', startedThisTurn: false })).toBeNull();
  });

  it('treats a total that went down as a fresh start, never a negative spend', () => {
    expect(codexTurnTokens({
      total,
      threadId: 'th-1',
      startedThisTurn: false,
      base: { threadId: 'th-1', input: 50_000, cachedInput: 1, output: 1, reasoning: 1 },
    })).toEqual({ input: 2_000, output: 300, cacheRead: 8_000, cacheWrite: 0, reasoning: 120 });
  });
});

describe('crediting a turn', () => {
  it('lands on the owner’s day under the agent, and never throws on a failing ledger', () => {
    const ledger = new InMemoryAgentTokenLedger();
    creditTurnTokens({
      ledger,
      userId: 'dana',
      agent: { id: 'agent-1', name: 'Ruby', orgId: 'org-1' },
      provider: 'claude',
      perModel: new Map([['claude-opus-5-5', { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 0 }]]),
      atMs: Date.parse('2026-10-10T23:59:00Z'),
    });
    expect(ledger.userDays('dana', '2026-10-10')).toEqual([
      { day: '2026-10-10', provider: 'claude', model: 'claude-opus-5-5', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 0 },
    ]);
    expect(() => creditTurnTokens({
      ledger: { credit: () => { throw new Error('disk full'); }, userDays: () => [] },
      userId: 'dana',
      agent: { id: 'agent-1', name: 'Ruby' },
      provider: 'codex',
      perModel: new Map([['gpt-6-sol', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }]]),
    })).not.toThrow();
  });
});
