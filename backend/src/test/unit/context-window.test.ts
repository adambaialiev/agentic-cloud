import { describe, expect, it } from 'vitest';
import {
  buildContextUsageNote,
  contextWindowForReportedModel,
  resolveContextUsage,
} from '../../utils/context-window.js';
import { MODEL_PRICING } from '../../config/pricing.js';

/**
 * The bridge between two spellings of one model. The catalogue is keyed
 * `anthropic/claude-sonnet-5`; the harness stream reports whatever concretely
 * ran, `claude-sonnet-5-20260320`. Nothing normalised between them, so the
 * agent detail screen's context bar depends entirely on this — and its failure
 * mode is silence, which looks exactly like "no turns yet" rather than like a
 * bug.
 */
describe('the context window for a model the harness named', () => {
  it('takes a catalogue id as it stands', () => {
    expect(contextWindowForReportedModel('anthropic/claude-sonnet-5')).toBe(1_000_000);
  });

  it('matches the concrete id a stream actually reports', () => {
    // The whole reason this exists: a dated build id is what comes back, and
    // an exact-match lookup answers null for every real turn.
    expect(contextWindowForReportedModel('claude-sonnet-5-20260320')).toBe(1_000_000);
    expect(contextWindowForReportedModel('anthropic/claude-sonnet-5-20260320')).toBe(1_000_000);
    // Dots in the catalogue, dashes in the stream, either way round.
    expect(contextWindowForReportedModel('CLAUDE-SONNET-5')).toBe(1_000_000);
  });

  /**
   * The regression this file exists for now. #141 shipped, deployed green, and
   * could never have drawn a single bar: the fleet reported `claude-opus-5`,
   * which was in neither the pricing catalogue nor anywhere else, so every
   * lookup answered null and the row was silently absent — indistinguishable
   * from "no turns yet". Found by reading production, not by reasoning.
   */
  it('answers for the models the fleet actually runs', () => {
    expect(contextWindowForReportedModel('claude-opus-5')).toBe(1_000_000);
    expect(contextWindowForReportedModel('claude-fable-5')).toBe(1_000_000);
    // Dated builds of the same families, which is what a stream reports once
    // Anthropic pins a version.
    expect(contextWindowForReportedModel('claude-opus-5-20260817')).toBe(1_000_000);
    // A genuinely shorter window is not rounded up to the convenient number.
    expect(contextWindowForReportedModel('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('keeps context windows out of the pricing catalogue', () => {
    // Prices meter real money and these models are billed to the user's own
    // plan, so they are legitimately unpriced. Borrowing MODEL_PRICING's
    // contextWindow field would have meant inventing per-million rates.
    expect(MODEL_PRICING['anthropic/claude-opus-5']).toBeUndefined();
    expect(contextWindowForReportedModel('claude-opus-5')).toBe(1_000_000);
  });

  it('answers null for a model it does not know, rather than guessing', () => {
    // Every entry in today's catalogue happens to be 1M, which makes "just
    // assume 1M" tempting and wrong: the number is drawn as a percentage, and
    // a 200k model reported against a 1M denominator would show a window that
    // is 100% full as comfortable.
    expect(contextWindowForReportedModel('some/model-nobody-priced')).toBeNull();
    expect(contextWindowForReportedModel('<synthetic>')).toBeNull();
    expect(contextWindowForReportedModel('')).toBeNull();
    expect(contextWindowForReportedModel(null)).toBeNull();
    expect(contextWindowForReportedModel(undefined)).toBeNull();
  });

  it('does not let a shorter family answer for a longer one', () => {
    // `claude-sonnet-5` must not claim `claude-sonnet-5-mini` if such a thing
    // ships with a different window — the longest matching family wins.
    const key = 'anthropic/claude-sonnet-5-mini';
    expect(MODEL_PRICING[key]).toBeUndefined();
    try {
      MODEL_PRICING[key] = { inputPerMillion: 1, outputPerMillion: 1, contextWindow: 200_000 };
      expect(contextWindowForReportedModel('claude-sonnet-5-mini-20260320')).toBe(200_000);
      // …and the plain family still answers for itself.
      expect(contextWindowForReportedModel('claude-sonnet-5-20260320')).toBe(1_000_000);
    } finally {
      delete MODEL_PRICING[key];
    }
  });

  it('never answers for a partial family name', () => {
    // "claude" alone is not a model, and matching it would hand every future
    // Anthropic id whatever window the first entry happened to carry.
    expect(contextWindowForReportedModel('claude')).toBeNull();
    expect(contextWindowForReportedModel('claude-sonnet')).toBeNull();
  });
});

/**
 * The fill itself, and the sentence the agent is handed about its own window.
 *
 * Both refuse in the same cases the bar does, and for the same reason: the
 * number is read as authoritative wherever it appears, so "no measurement" has
 * to stay visibly different from "empty".
 */
describe('resolveContextUsage', () => {
  it('turns a stored measurement into a percentage', () => {
    expect(resolveContextUsage({ tokens: 400_000, model: 'claude-opus-5', at: 'T' }))
      .toEqual({ usedPercent: 40, tokens: 400_000, window: 1_000_000, at: 'T' });
  });

  it('resolves the id the STREAM reports, not the catalogue key', () => {
    // The whole reason #141 shipped invisible: production says
    // `claude-opus-5`, the catalogue says `anthropic/claude-sonnet-5`.
    expect(resolveContextUsage({ tokens: 100_000, model: 'claude-sonnet-5-20260320', at: 'T' })?.usedPercent)
      .toBe(10);
  });

  it('refuses rather than inventing a denominator', () => {
    // No measurement, a zero measurement, and an unknown model are three ways
    // of having nothing to say — none of them is an empty window.
    expect(resolveContextUsage(null)).toBeNull();
    expect(resolveContextUsage(undefined)).toBeNull();
    expect(resolveContextUsage({ tokens: 0, model: 'claude-opus-5', at: 'T' })).toBeNull();
    expect(resolveContextUsage({ tokens: 500_000, model: 'who/knows', at: 'T' })).toBeNull();
    expect(resolveContextUsage({ tokens: 500_000, at: 'T' })).toBeNull();
  });

  it('prefers the window the CLI stated over anything looked up here', () => {
    // Codex reports its own effective window — 258,400 for a model whose
    // catalog entry says 272,000, because the CLI reserves room for the reply.
    // A percentage drawn against the catalog figure would read comfortably
    // below what the CLI itself is about to compact.
    expect(resolveContextUsage({ tokens: 129_200, window: 258_400, model: 'gpt-5.6-terra', at: 'T' }))
      .toEqual({ usedPercent: 50, tokens: 129_200, window: 258_400, at: 'T' });
    // With no model to fall back on either — Codex readings need no entry in
    // any table here.
    expect(resolveContextUsage({ tokens: 64_600, window: 258_400, at: 'T' })?.usedPercent).toBe(25);
    // A stated window that is not one falls back to the model.
    expect(resolveContextUsage({ tokens: 400_000, window: 0, model: 'claude-opus-5', at: 'T' })?.window)
      .toBe(1_000_000);
  });

  it('caps an over-filled window at 100 rather than reporting past the end', () => {
    expect(resolveContextUsage({ tokens: 1_400_000, model: 'claude-opus-5', at: 'T' })?.usedPercent)
      .toBe(100);
  });

  it('reads a short-window model against its OWN window', () => {
    // The case that makes capping and refusing worth it: 150k is comfortable
    // in 1M and nearly fatal in 200k.
    expect(resolveContextUsage({ tokens: 150_000, model: 'claude-haiku-4-5-20251001', at: 'T' })?.usedPercent)
      .toBe(75);
  });
});

describe('buildContextUsageNote', () => {
  it('states the percentage and both raw numbers', () => {
    const note = buildContextUsageNote({ tokens: 402_000, model: 'claude-opus-5', at: 'T' });
    expect(note).toContain('about 40% full');
    expect(note).toContain('402k of 1M tokens');
    // Says WHEN it was true: the field is written at the end of a turn, so a
    // sentence in the present tense would be claiming to be live.
    expect(note).toContain('as of your last turn');
  });

  it('says nothing at all when there is nothing true to say', () => {
    // Silence is the correct output for a fresh chat — the field is cleared on
    // reset, and "0% full" stated to an agent is a lie it would act on.
    expect(buildContextUsageNote(null)).toBeNull();
    expect(buildContextUsageNote({ tokens: 0, model: 'claude-opus-5', at: 'T' })).toBeNull();
    expect(buildContextUsageNote({ tokens: 9_000, model: 'unknown/model', at: 'T' })).toBeNull();
  });

  it('agrees with the percentage the Mini App bar draws', () => {
    // One arithmetic, two renderings. Two copies is how the screen and the
    // sentence start disagreeing about one agent.
    const usage = { tokens: 731_000, model: 'claude-opus-5', at: 'T' };
    expect(buildContextUsageNote(usage)).toContain(`about ${resolveContextUsage(usage)!.usedPercent}% full`);
  });

  it('keeps a sub-1k count honest instead of rounding it to 1k', () => {
    expect(buildContextUsageNote({ tokens: 840, model: 'claude-opus-5', at: 'T' }))
      .toContain('840 of 1M tokens');
  });
});
