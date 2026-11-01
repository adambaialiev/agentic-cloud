import { describe, expect, it } from 'vitest';
import { contextHeat, contextHue, contextPercent } from './context-heat.js';

describe('context heat', () => {
  it('keeps the warning thresholds shared by the ring and detail bar', () => {
    expect(contextHeat(66)).toBe('');
    expect(contextHeat(67)).toBe('warn');
    expect(contextHeat(89)).toBe('warn');
    expect(contextHeat(90)).toBe('hot');
  });

  it('turns the ring continuously from green toward red as it fills', () => {
    expect(contextHue(-1)).toBe(140);
    expect(contextHue(0)).toBe(140);
    expect(contextHue(50)).toBe(70);
    expect(contextHue(71)).toBe(41);
    expect(contextHue(100)).toBe(0);
    expect(contextHue(101)).toBe(0);
  });

  it('clamps a measured percentage and preserves an absent reading', () => {
    expect(contextPercent(undefined)).toBeNull();
    expect(contextPercent({})).toBeNull();
    expect(contextPercent({ usedPercent: -1 })).toBe(0);
    expect(contextPercent({ usedPercent: 101 })).toBe(100);
  });
});
