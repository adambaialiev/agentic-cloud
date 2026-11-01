import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenCodeRunCommand,
  OPENCODE_LIMIT_PLUGIN_FILE,
  OPENCODE_LIMIT_PLUGIN_SOURCE,
  OPENCODE_TURN_ENV,
} from '../../agent/opencode/opencode-command.js';

/**
 * What `opencode run` does with its message arguments (opencode 1.19.3,
 * read out of the binary on 2026-10-20): any argument holding a space is
 * wrapped in quotes, inner quotes backslashed, and all are joined by spaces.
 */
function opencodeJoin(args: string[]): string {
  return args.map((arg) => (arg.includes(' ') ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ');
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run a built command under bash, with a stand-in `opencode` that records its argv. */
function runWithStub(command: string): { argv: string[]; home: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'opencode-cmd-'));
  scratch.push(dir);
  const bin = path.join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const stub = path.join(bin, 'opencode');
  writeFileSync(stub, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(path.join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(stub, 0o755);
  execFileSync('bash', ['-c', command], { env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}` } });
  return { argv: JSON.parse(readFileSync(path.join(dir, 'argv.json'), 'utf8')) as string[], home: dir };
}

describe('buildOpenCodeRunCommand', () => {
  it('reaches OpenCode with the prompt byte for byte, whatever it holds', () => {
    const prompt = '  Leading spaces, "double quotes", \'single\', back\\slash $HOME `tick`\n\tTabbed  line\n-dash --flag=1\n\nLast line  ';
    const { argv } = runWithStub(buildOpenCodeRunCommand({ prompt, model: 'glm-5.3', effort: 'high', title: 'Ada' }));
    const message = argv.slice(argv.indexOf('--') + 1);
    // No piece holds a space, so OpenCode's own join gives the prompt back.
    expect(message.some((piece) => piece.includes(' '))).toBe(false);
    expect(opencodeJoin(message)).toBe(prompt);
    // The naive one-argument form is what this guards against.
    expect(opencodeJoin([prompt])).not.toBe(prompt);
  });

  it('runs the Go provider model, its variant, and a title on a first turn', () => {
    const { argv } = runWithStub(buildOpenCodeRunCommand({ prompt: 'hi', model: 'kimi-k3', effort: 'max', title: 'Ada' }));
    expect(argv.slice(0, argv.indexOf('--'))).toEqual([
      'run', '--format', 'json', '--auto', '--model', 'opencode-go/kimi-k3', '--variant', 'max', '--title', 'Ada',
    ]);
  });

  it('resumes by session id, without a title and without a variant for a model with none', () => {
    const { argv } = runWithStub(buildOpenCodeRunCommand({ prompt: 'again', model: 'mimo-v2.6-pro', resumeSessionId: 'ses_abc123' }));
    expect(argv.slice(0, argv.indexOf('--'))).toEqual([
      'run', '--format', 'json', '--auto', '--model', 'opencode-go/mimo-v2.6-pro', '--session', 'ses_abc123',
    ]);
  });

  it('writes the limit plugin before a turn, and leaves it out of a bare run', () => {
    const { home } = runWithStub(buildOpenCodeRunCommand({ prompt: 'hi', model: 'glm-5.3' }));
    const written = readFileSync(path.join(home, '.config/opencode/plugins', OPENCODE_LIMIT_PLUGIN_FILE), 'utf8');
    expect(written).toBe(OPENCODE_LIMIT_PLUGIN_SOURCE);
    expect(buildOpenCodeRunCommand({ prompt: 'hi', model: 'glm-5.3', withPlugin: false })).not.toContain('plugins');
  });
});

describe('the limit plugin', () => {
  async function loadPlugin() {
    const dir = mkdtempSync(path.join(tmpdir(), 'opencode-plugin-'));
    scratch.push(dir);
    const file = path.join(dir, OPENCODE_LIMIT_PLUGIN_FILE.replace(/\.js$/, '.mjs'));
    writeFileSync(file, OPENCODE_LIMIT_PLUGIN_SOURCE);
    const module = await import(pathToFileURL(file).href) as { AgentbuiltLimitStop: (input: { client: unknown }) => Promise<{ event: (input: { event: unknown }) => Promise<void> }> };
    const abort = vi.fn().mockResolvedValue(undefined);
    const hooks = await module.AgentbuiltLimitStop({ client: { session: { abort } } });
    return { hooks, abort };
  }

  const goRetry = (next: number) => ({
    type: 'session.status',
    properties: {
      sessionID: 'ses_one',
      status: {
        type: 'retry',
        attempt: 1,
        message: '5-hour usage limit reached. It will reset in 2 hours 13 minutes. … - https://opencode.ai/workspace/wrk_x/go',
        action: { reason: 'account_rate_limit', provider: 'opencode-go', message: '5-hour usage limit reached. It will reset in 2 hours 13 minutes.' },
        next,
      },
    },
  });

  afterEach(() => {
    delete process.env[OPENCODE_TURN_ENV];
    vi.restoreAllMocks();
  });

  it('ends a turn at a Go limit with OpenCode\'s own words, once', async () => {
    process.env[OPENCODE_TURN_ENV] = '1';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { hooks, abort } = await loadPlugin();
    const next = Date.now() + 8_000_000;
    await hooks.event({ event: goRetry(next) });
    await hooks.event({ event: goRetry(next) });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_one' } });
    const lines = write.mock.calls.map(([chunk]) => String(chunk)).filter((chunk) => chunk.includes('platform_limit'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'platform_limit',
      sessionID: 'ses_one',
      reason: 'account_rate_limit',
      provider: 'opencode-go',
      message: '5-hour usage limit reached. It will reset in 2 hours 13 minutes.',
      retryAt: next,
    });
  });

  it('lets an ordinary short retry run its course, and does nothing outside a platform turn', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { hooks, abort } = await loadPlugin();
    await hooks.event({ event: goRetry(Date.now() + 8_000_000) });
    process.env[OPENCODE_TURN_ENV] = '1';
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_one', status: { type: 'retry', attempt: 2, message: 'Provider is overloaded', next: Date.now() + 4_000 } } } });
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_one', status: { type: 'busy' } } } });
    expect(abort).not.toHaveBeenCalled();
    expect(write.mock.calls.some(([chunk]) => String(chunk).includes('platform_limit'))).toBe(false);
  });

  it('stops a retry that would wait longer than five minutes, whatever it is', async () => {
    process.env[OPENCODE_TURN_ENV] = '1';
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { hooks, abort } = await loadPlugin();
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_two', status: { type: 'retry', attempt: 1, message: 'Too Many Requests', next: Date.now() + 3_600_000 } } } });
    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_two' } });
  });
});
