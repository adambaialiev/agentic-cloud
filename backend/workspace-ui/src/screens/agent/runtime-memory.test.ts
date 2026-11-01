import { describe, expect, it } from 'vitest';
import { forgetRememberedRuntimes, forgetRuntimesOf, recalledRuntime, rememberRuntime } from './runtime-memory.js';

describe('the private runtimes\' pairs kept across visits (note #735)', () => {
  it('keeps one pair per runtime and workplace, and drops it when a read says nothing is chosen', () => {
    rememberRuntime('o1', 'agent', { cli: 'claude', model: 'opus', effort: 'high' });
    rememberRuntime('o1', 'recap', { cli: 'codex', model: 'gpt-6-luna', effort: 'low' });
    rememberRuntime('o2', 'agent', { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(recalledRuntime('o1', 'agent')).toEqual({ cli: 'claude', model: 'opus', effort: 'high' });
    expect(recalledRuntime('o1', 'recap')).toEqual({ cli: 'codex', model: 'gpt-6-luna', effort: 'low' });
    rememberRuntime('o1', 'agent', null);
    expect(recalledRuntime('o1', 'agent')).toBeNull();
    expect(recalledRuntime('o2', 'agent')).toEqual({ cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  });

  it('forgets a workplace the reader lost, and everything on sign-out', () => {
    rememberRuntime('o1', 'agent', { cli: 'claude', model: 'opus', effort: 'high' });
    rememberRuntime('o2', 'agent', { cli: 'claude', model: 'sonnet', effort: 'low' });
    forgetRuntimesOf('o1');
    expect(recalledRuntime('o1', 'agent')).toBeNull();
    expect(recalledRuntime('o2', 'agent')).not.toBeNull();
    forgetRememberedRuntimes();
    expect(recalledRuntime('o2', 'agent')).toBeNull();
    expect(localStorage.getItem('agentbuilt.privateRuntimes')).toBeNull();
  });

  it('reads nothing from storage it cannot trust', () => {
    localStorage.setItem('agentbuilt.privateRuntimes', '{not json');
    expect(recalledRuntime('o1', 'agent')).toBeNull();
    localStorage.setItem('agentbuilt.privateRuntimes', JSON.stringify({ 'agent:o1': { cli: 'gemini', model: 'x', effort: 'y' } }));
    expect(recalledRuntime('o1', 'agent')).toBeNull();
  });
});
