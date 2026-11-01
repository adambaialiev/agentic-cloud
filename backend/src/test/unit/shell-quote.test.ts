import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { quoteShellArg } from '../../utils/shell-quote.js';

const run = promisify(execFile);

/** What a real POSIX shell makes of the quoted value, byte for byte. */
async function throughSh(quotedCommand: string): Promise<string> {
  const { stdout } = await run('/bin/sh', ['-c', quotedCommand], { encoding: 'utf8' });
  return stdout;
}

const HOSTILE_VALUES = [
  'plain',
  '',
  'two words',
  "it's",
  "'",
  "'''",
  '$HOME',
  '$(echo pwned)',
  '`echo pwned`',
  'a;b',
  'a && b',
  'a|b',
  '*',
  '~',
  'a\nb',
  'a\tb',
  'back\\slash',
  '\\',
  '"double"',
  '--flag',
  '#comment',
  'émoji 🎉',
];

describe('quoteShellArg', () => {
  it('wraps a plain value in single quotes', () => {
    expect(quoteShellArg('plain')).toBe("'plain'");
  });

  it('leaves and re-enters the quoted run around an embedded quote', () => {
    expect(quoteShellArg("it's")).toBe(`'it'"'"'s'`);
  });

  it('keeps an empty value as a real empty argument', () => {
    expect(quoteShellArg('')).toBe("''");
  });

  it.each(HOSTILE_VALUES)('survives a real shell unchanged: %j', async (value) => {
    expect(await throughSh(`printf %s ${quoteShellArg(value)}`)).toBe(value);
  });

  it('keeps each value a separate argument', async () => {
    const parts = ['a b', 'c', '', "d'e"].map(quoteShellArg).join(' ');
    expect(await throughSh(`printf '[%s]' ${parts}`)).toBe("[a b][c][][d'e]");
  });

  it('does not let a value run commands of its own', async () => {
    expect(await throughSh(`printf %s ${quoteShellArg('$(echo pwned) `echo pwned`')}`))
      .toBe('$(echo pwned) `echo pwned`');
  });
});
