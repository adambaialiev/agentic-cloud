import { describe, expect, it } from 'vitest';
import {
  buildCodexContextCommand,
  parseCodexContextOutput,
  readCodexContextUsage,
} from '../../agent/codex/codex-context.js';
import { FakeWorkspaceRuntimeClient, makeExecSyncResult } from '../mocks/fake-workspace-runtime-client.js';

const THREAD_ID = '01a01a5a-5298-78a0-bfb9-d30c77e83318';

/**
 * A verbatim line from a codex-cli 0.148.0 rollout file, captured by running a
 * real turn against a stub model provider (2026-08-19). The two usage blocks
 * are the whole point of this parser: `total_token_usage` had accumulated over
 * three model requests across two turns, while `last_token_usage` is the one
 * request that just happened — 1,000 tokens against a 258,400 window.
 */
const REAL_TOKEN_COUNT_LINE = JSON.stringify({
  timestamp: '2026-08-19T14:10:15.260Z',
  ordinal: 24,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: 4000,
        cached_input_tokens: 400,
        cache_write_input_tokens: 0,
        output_tokens: 21,
        reasoning_output_tokens: 9,
        total_tokens: 4021,
      },
      last_token_usage: {
        input_tokens: 1000,
        cached_input_tokens: 100,
        cache_write_input_tokens: 0,
        output_tokens: 7,
        reasoning_output_tokens: 3,
        total_tokens: 1007,
      },
      model_context_window: 258400,
    },
    rate_limits: { limit_id: 'codex', primary: null, secondary: null },
  },
});

function tokenCountLine(last: number, total: number, window?: number): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: total, total_tokens: total },
        last_token_usage: { input_tokens: last, total_tokens: last },
        ...(window !== undefined ? { model_context_window: window } : {}),
      },
    },
  });
}

describe('parseCodexContextOutput', () => {
  it('reads the last request, not the thread total, from a real rollout line', () => {
    expect(parseCodexContextOutput(REAL_TOKEN_COUNT_LINE)).toEqual({
      tokens: 1000,
      window: 258400,
      // The thread total rides along for the token ledger, in OpenAI's own
      // shape: total_tokens 4021 = input 4000 + output 21, so reasoning (9) is
      // INSIDE output and cached input (400) inside input.
      total: { input: 4000, cachedInput: 400, output: 21, reasoning: 9 },
    });
  });

  it('takes the most recent token_count when several are printed', () => {
    const stdout = [
      tokenCountLine(1000, 1000, 258400),
      tokenCountLine(2000, 3000, 258400),
    ].join('\n');
    expect(parseCodexContextOutput(stdout)).toEqual({
      tokens: 2000, window: 258400, total: { input: 3000, cachedInput: 0, output: 0, reasoning: 0 },
    });
  });

  it('survives shell noise around the line', () => {
    const stdout = `warning: something on stderr got merged\n${tokenCountLine(42, 99, 1000)}\n\n`;
    expect(parseCodexContextOutput(stdout)).toMatchObject({ tokens: 42, window: 1000 });
  });

  it('reports tokens without a window when the CLI states none', () => {
    expect(parseCodexContextOutput(tokenCountLine(500, 500))).toEqual({
      tokens: 500, total: { input: 500, cachedInput: 0, output: 0, reasoning: 0 },
    });
  });

  it('refuses everything it cannot read as a measurement', () => {
    expect(parseCodexContextOutput('')).toBeNull();
    expect(parseCodexContextOutput('no rollout here')).toBeNull();
    expect(parseCodexContextOutput('{"type":"event_msg","payload":{"type":"task_complete"}}')).toBeNull();
    // A turn whose last request reported nothing is not a measurement of zero.
    expect(parseCodexContextOutput(tokenCountLine(0, 1000, 258400))).toBeNull();
    // The thread total alone must never stand in for the last request.
    expect(parseCodexContextOutput(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 9000 }, model_context_window: 258400 } },
    }))).toBeNull();
  });
});

describe('buildCodexContextCommand', () => {
  it('looks the rollout up by thread id and prints only its last token_count', () => {
    const command = buildCodexContextCommand(THREAD_ID)!;
    expect(command).toContain(`rollout-*-${THREAD_ID}.jsonl`);
    expect(command).toContain('$HOME/.codex/sessions');
    expect(command).toContain('"type":"token_count"');
    expect(command).toContain('tail -n 1');
  });

  it('refuses a thread id that is not one, rather than putting it in a shell', () => {
    expect(buildCodexContextCommand('id"; rm -rf ~; echo "')).toBeNull();
    expect(buildCodexContextCommand('../../etc/passwd')).toBeNull();
    expect(buildCodexContextCommand('$(whoami)')).toBeNull();
    expect(buildCodexContextCommand('')).toBeNull();
  });
});

describe('readCodexContextUsage', () => {
  it('runs on the machine as the CLI user and returns the reading', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = (command) => (command.includes('token_count')
      ? makeExecSyncResult({ stdout: REAL_TOKEN_COUNT_LINE })
      : makeExecSyncResult());

    const reading = await readCodexContextUsage({
      sandboxClient: client,
      sandboxId: 'sb-1',
      sshUser: 'agent',
      threadId: THREAD_ID,
    });

    expect(reading).toMatchObject({ tokens: 1000, window: 258400 });
    expect(client.execSyncCalls.at(-1)?.sshUser).toBe('agent');
  });

  it('returns null when the rollout is gone, so the turn keeps its old reading', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ stdout: '' });

    await expect(readCodexContextUsage({
      sandboxClient: client,
      sandboxId: 'sb-1',
      sshUser: 'agent',
      threadId: THREAD_ID,
    })).resolves.toBeNull();
  });
});
