import { describe, expect, it } from 'vitest';
import { LANDING_FIRST_SEGMENTS, PLATFORM_FIRST_SEGMENTS, RESERVED_HANDLES, isReservedHandle, workspaceFirstSegments } from '../../shared/handles.js';
import { WORKSPACE_ENTRY_PATTERNS, WORKSPACE_RETIRED_PATTERNS, WORKSPACE_ROUTE_DEFS } from '../../shared/workspace-routes.js';
import { mailLocalProblem } from '../../shared/workspace-mail.js';

describe('reserved handles: the one namespace at the root of the domain', () => {
  it('keeps the first word of every Workspace destination and entry door', () => {
    for (const definition of Object.values(WORKSPACE_ROUTE_DEFS)) {
      const first = definition.pattern[0]!;
      // A public address's own pattern (`/:handle`) is the one first
      // segment that is not a word: it reserves nothing.
      if (first.startsWith(':')) continue;
      expect(isReservedHandle(first), first).toBe(true);
    }
    for (const pattern of WORKSPACE_ENTRY_PATTERNS) {
      const first = pattern[0];
      if (first) expect(isReservedHandle(first), first).toBe(true);
    }
    expect(workspaceFirstSegments()).toContain('notes');
    expect(workspaceFirstSegments()).toContain('invite');
    // A retired place keeps its word (note #843): the shell still answers
    // `/rooms`, so nobody may be addressed by it.
    for (const pattern of WORKSPACE_RETIRED_PATTERNS) expect(isReservedHandle(pattern[0]!), pattern[0]).toBe(true);
    expect(workspaceFirstSegments()).toContain('rooms');
  });

  it('keeps every landing page and every platform word', () => {
    for (const word of [...LANDING_FIRST_SEGMENTS, ...PLATFORM_FIRST_SEGMENTS]) {
      expect(RESERVED_HANDLES.has(word), word).toBe(true);
    }
    expect(isReservedHandle('docs')).toBe(true);
    expect(isReservedHandle('workspace')).toBe(true);
    expect(isReservedHandle('adam')).toBe(false);
    expect(isReservedHandle('acme')).toBe(false);
  });

  it('is what the signup name is checked against, so a person cannot take a page', () => {
    expect(mailLocalProblem('docs')).toBe('reserved');
    expect(mailLocalProblem('chat')).toBe('reserved');
    expect(mailLocalProblem('terms')).toBe('reserved');
    expect(mailLocalProblem('signup')).toBe('reserved');
    expect(mailLocalProblem('adam')).toBeNull();
    expect(mailLocalProblem('acme-trading')).toBeNull();
  });
});

describe('the handle grammar', () => {
  it('reads a pasted address as its word and names the one reason a word is refused', async () => {
    const { normalizeHandle, handleProblem } = await import('../../shared/handles.js');
    expect(normalizeHandle('  Acme  ')).toBe('acme');
    expect(normalizeHandle('https://agenticcloudcomputer.com/acme/')).toBe('acme');
    expect(handleProblem('acme')).toBeNull();
    expect(handleProblem('acme-trading.eu')).toBeNull();
    expect(handleProblem('')).toBe('empty');
    expect(handleProblem('ab')).toBe('too-short');
    expect(handleProblem('a'.repeat(33))).toBe('too-long');
    expect(handleProblem('Acme')).toBe('shape');
    expect(handleProblem('acme_trading')).toBe('shape');
    expect(handleProblem('docs')).toBe('reserved');
    expect(handleProblem('support')).toBe('reserved');
  });

  it('derives a valid, unreserved word from any display name', async () => {
    const { deriveHandle, handleProblem } = await import('../../shared/handles.js');
    expect(deriveHandle('Acme Trading')).toBe('acme-trading');
    expect(deriveHandle('Adam’s workplace')).toBe('adams-workplace');
    expect(deriveHandle("Dana's Shop")).toBe('danas-shop');
    expect(deriveHandle('Acme Trading', 2)).toBe('acme-trading-2');
    expect(deriveHandle('Docs')).toBe('docs-workplace');
    expect(deriveHandle('北京')).toBe('my-workplace');
    expect(deriveHandle('Ab')).toBe('ab-workplace');
    for (const name of ['Acme Trading', 'A very long workplace name that goes on and on and on', '!!!', 'Workspace', 'Chat']) {
      for (const suffix of [1, 2, 37]) expect(handleProblem(deriveHandle(name, suffix)), `${name} #${suffix}`).toBeNull();
    }
    expect(deriveHandle('A very long workplace name that goes on and on and on', 12).length).toBeLessThanOrEqual(32);
  });
});
