import { describe, expect, it } from 'vitest';
import { HEAVY_EFFORT_MARK, effortLine, effortList, effortName, heavyEffortNote, modelName } from './runtime-words.js';

describe('what a heavy effort level is called in words (note #482)', () => {
  it('names only the levels handed to it, and agrees with itself on number', () => {
    expect(effortList(['xhigh', 'max', 'ultra'])).toBe('xhigh, max and ultra');
    expect(effortList(['xhigh', 'max'])).toBe('xhigh and max');
    expect(effortList(['xhigh'])).toBe('xhigh');

    expect(heavyEffortNote(['xhigh', 'max', 'ultra'])).toContain('xhigh, max and ultra think for');
    // A model that stops at xhigh (gpt-5.5) is warned about xhigh alone,
    // in the singular — never about levels it cannot run.
    const one = heavyEffortNote(['xhigh'])!;
    expect(one).toContain('xhigh thinks for');
    expect(one).not.toContain('max');
    expect(one).not.toContain('think for');
  });

  it('says what the cost IS: longer turns, a subscription window going faster', () => {
    const note = heavyEffortNote(['xhigh', 'max', 'ultra'])!;
    expect(note).toContain('much longer before answering');
    expect(note).toContain('usage much faster');
    expect(note).toContain('drain a window');
    // No invented multiplier: the direction is measured, a number would not be.
    expect(note).not.toMatch(/\d/);
  });

  it('warns about nothing when a model offers no heavy level', () => {
    expect(heavyEffortNote([])).toBeNull();
    expect(HEAVY_EFFORT_MARK).toBe('Much more compute');
  });
});

describe('a model and an effort as a person reads them (2026-09-29)', () => {
  it('names models without the command line, and adds no version to an alias', () => {
    expect(modelName('opus')).toBe('Opus');
    expect(modelName('fable')).toBe('Fable');
    expect(modelName('Opus')).toBe('Opus');
    expect(modelName('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(modelName('gpt-5.6-luna')).toBe('GPT-5.6 Luna');
    expect(modelName('gpt-5.5')).toBe('GPT-5.5');
  });

  it('names effort levels in words, keeping an unknown one', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effortName))
      .toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max', 'Ultra']);
    expect(effortName('turbo')).toBe('Turbo');
  });

  it('says one line about the chosen step, and the cost on a heavy one', () => {
    expect(effortLine({ value: 'low' })).toContain('least thinking');
    expect(effortLine({ value: 'xhigh', heavy: true })).toContain(HEAVY_EFFORT_MARK);
    // The flag decides, never the spelling.
    expect(effortLine({ value: 'xhigh' })).toBe('');
    expect(effortLine({ value: 'turbo' })).toBe('');
  });
});

describe('an OpenCode model by its own name (note #780)', () => {
  it('reads the names the catalog gives, where the id does not spell them', () => {
    expect(modelName('glm-5.3')).toBe('GLM-5.3');
    expect(modelName('kimi-k3')).toBe('Kimi K3');
    expect(modelName('mimo-v2.6-pro')).toBe('MiMo V2.6 Pro');
    expect(modelName('deepseek-v4.1-flash')).toBe('DeepSeek V4.1 Flash');
    // The other harnesses' names are unchanged.
    expect(modelName('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(modelName('opus')).toBe('Opus');
  });
});
