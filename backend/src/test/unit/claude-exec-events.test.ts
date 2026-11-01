import { describe, expect, it } from 'vitest';
import {
  getAssistantTextBlocks,
  getClaudeApiErrorMessage,
  getToolUseSummaries,
  getClaudeContextTokens,
  getClaudeModel,
  getClaudeRateLimitResetAt,
  getClaudeSessionId,
  getClaudeUsageWindows,
  getResultInfo,
  parseClaudeStreamEventLine,
} from '../../agent/claude/claude-exec-events.js';
import { HARNESS_ACTIVITY_ARG_MAX_CHARS } from '../../agent/harness-activity.js';

// Real lines captured from `claude -p --output-format stream-json` (v2.1.205).
const SYSTEM_INIT = '{"type":"system","subtype":"init","session_id":"02f545d2-f37f-46c1-bd93-bd720ce07ccd","tools":["Bash"],"mcp_servers":[{"name":"platform","status":"connected"}]}';
const ASSISTANT_TEXT = '{"type":"assistant","message":{"content":[{"type":"text","text":"Output: claude-mcp-test"}]},"session_id":"02f545d2-f37f-46c1-bd93-bd720ce07ccd"}';
const ASSISTANT_TOOL_USE = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"echo x"}}]},"session_id":"02f545d2-f37f-46c1-bd93-bd720ce07ccd"}';
const RESULT_SUCCESS = '{"type":"result","subtype":"success","is_error":false,"result":"Output: claude-mcp-test","session_id":"02f545d2-f37f-46c1-bd93-bd720ce07ccd"}';
const RESULT_ERROR = '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"00000000-0000-0000-0000-000000000000"}';
// Real terminal-auth shape captured from Claude Code 2.1.251. This is local
// diagnostic output, despite riding in an assistant envelope.
const ASSISTANT_API_ERROR = JSON.stringify({
  type: 'assistant',
  message: {
    model: '<synthetic>',
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [{
      type: 'text',
      text: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    }],
  },
  session_id: '02f545d2-f37f-46c1-bd93-bd720ce07ccd',
  error: 'authentication_failed',
  is_api_error_message: true,
});

describe('parseClaudeStreamEventLine', () => {
  it('parses the system init event and its session id', () => {
    const event = parseClaudeStreamEventLine(SYSTEM_INIT);
    expect(event?.type).toBe('system');
    expect(getClaudeSessionId(event!)).toBe('02f545d2-f37f-46c1-bd93-bd720ce07ccd');
  });

  it('extracts text blocks from assistant events, ignoring tool_use', () => {
    expect(getAssistantTextBlocks(parseClaudeStreamEventLine(ASSISTANT_TEXT)!)).toEqual(['Output: claude-mcp-test']);
    expect(getAssistantTextBlocks(parseClaudeStreamEventLine(ASSISTANT_TOOL_USE)!)).toEqual([]);
  });

  it('extracts a concrete model when Claude includes one', () => {
    const event = parseClaudeStreamEventLine(
      '{"type":"assistant","message":{"model":"claude-sonnet-5","content":[]}}',
    );
    expect(getClaudeModel(event!)).toBe('claude-sonnet-5');
  });

  it('classifies a synthetic API failure as diagnostics, not assistant output', () => {
    const event = parseClaudeStreamEventLine(ASSISTANT_API_ERROR)!;
    expect(getClaudeApiErrorMessage(event)).toBe(
      'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    );
    expect(getClaudeModel(event)).toBeUndefined();
    // The low-level block reader remains lossless; the harness uses the API
    // error classifier to decide this text must not be delivered.
    expect(getAssistantTextBlocks(event)).toEqual([
      'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    ]);
  });

  it('does not classify ordinary assistant text as an API failure', () => {
    expect(getClaudeApiErrorMessage(parseClaudeStreamEventLine(ASSISTANT_TEXT)!)).toBeUndefined();
  });

  it('reads success and error result info', () => {
    expect(getResultInfo(parseClaudeStreamEventLine(RESULT_SUCCESS)!)).toEqual({
      isError: false,
      text: 'Output: claude-mcp-test',
      subtype: 'success',
    });
    expect(getResultInfo(parseClaudeStreamEventLine(RESULT_ERROR)!)).toMatchObject({
      isError: true,
      subtype: 'error_during_execution',
    });
  });

  it('tolerates carriage returns and returns null for noise', () => {
    expect(parseClaudeStreamEventLine(`${SYSTEM_INIT}\r`)?.type).toBe('system');
    expect(parseClaudeStreamEventLine('No conversation found with session ID: 00000000')).toBeNull();
    expect(parseClaudeStreamEventLine('')).toBeNull();
    expect(parseClaudeStreamEventLine('{"no_type":1}')).toBeNull();
  });

  it('normalizes sparse rate-limit events to percentage windows', () => {
    const event = parseClaudeStreamEventLine(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        rate_limit_type: 'five_hour',
        utilization: 0.235,
        resets_at: 1_738_425_600,
      },
    }));
    expect(getClaudeUsageWindows(event!)).toEqual([{
      id: 'five_hour',
      usedPercent: 23.5,
      resetsAt: 1_738_425_600,
    }]);
  });

  it('reads resets_at from a utilization-less rate_limit_event that yields no window', () => {
    // The common shape (anthropic/claude-code#50518): no utilization, so
    // getClaudeUsageWindows drops it — but the reset moment must survive for
    // the platform pool's cooldown sizing.
    const event = parseClaudeStreamEventLine(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resets_at: 1_754_514_000 },
    }));
    expect(getClaudeUsageWindows(event!)).toEqual([]);
    expect(getClaudeRateLimitResetAt(event!)).toBe(1_754_514_000);
  });

  it('accepts camelCase and ISO-string resets_at, and ignores other events', () => {
    const camel = parseClaudeStreamEventLine(JSON.stringify({
      type: 'rate_limit_event',
      rateLimitInfo: { resetsAt: '2026-08-08T21:00:00.000Z' },
    }));
    expect(getClaudeRateLimitResetAt(camel!)).toBe(Math.round(Date.parse('2026-08-08T21:00:00.000Z') / 1000));
    expect(getClaudeRateLimitResetAt(parseClaudeStreamEventLine(SYSTEM_INIT)!)).toBeUndefined();
    const empty = parseClaudeStreamEventLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}');
    expect(getClaudeRateLimitResetAt(empty!)).toBeUndefined();
  });

  it('reads full status-line-style rate limit snapshots', () => {
    const event = parseClaudeStreamEventLine(JSON.stringify({
      type: 'system',
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: 100 },
        seven_day: { used_percentage: 41.2, resets_at: 200 },
      },
    }));
    expect(getClaudeUsageWindows(event!)).toEqual([
      { id: 'five_hour', usedPercent: 12, resetsAt: 100 },
      { id: 'seven_day', usedPercent: 41.2, resetsAt: 200 },
    ]);
  });
});


describe('getToolUseSummaries', () => {
  it('summarizes tool_use blocks: Bash commands, file basenames, bare names', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm   run build' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/home/agent/site/index.html' } },
          { type: 'tool_use', name: 'TodoWrite', input: {} },
        ],
      },
    } as never;
    expect(getToolUseSummaries(event)).toEqual([
      'Bash: npm run build',
      'Edit: index.html',
      'TodoWrite',
    ]);
  });

  // Note #47: the old 40-character cut landed inside the quote of the very
  // command Owner was reading — `grep -A1 "Alex (` — and a command cut before
  // its closing paren reads as one that went wrong, not one that went long.
  it('keeps a real command whole past the old 40-character cut', () => {
    const command = 'agentbuilt agent list | grep -A1 "Alex ()"';
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
    } as never;
    expect(getToolUseSummaries(event)).toEqual([`Bash: ${command}`]);
  });

  it('bounds a runaway command and marks the cut', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(500) } }] },
    } as never;
    const [summary] = getToolUseSummaries(event);
    expect(summary).toBe(`Bash: ${'x'.repeat(HARNESS_ACTIVITY_ARG_MAX_CHARS - 1)}…`);
    expect(summary.endsWith('…')).toBe(true);
  });
});

/**
 * How full the window is. The numbers come off the same stream the harness
 * already reads; the care is in WHICH event and WHICH fields.
 */
describe('context fill, from the stream', () => {
  const assistant = (usage: unknown) => ({ type: 'assistant', message: { usage } } as never);

  it('adds every input count, because every one of them was sent', () => {
    // A cache read still occupies the window — it was merely cheaper to send.
    // Counting only `input_tokens` is the easy version of this that reads
    // near-zero on exactly the long conversations the number warns about.
    expect(getClaudeContextTokens(assistant({
      input_tokens: 12_000,
      cache_read_input_tokens: 380_000,
      cache_creation_input_tokens: 8_000,
      output_tokens: 900,
    }))).toBe(400_000);
  });

  it('ignores output tokens — they are not in the prompt', () => {
    expect(getClaudeContextTokens(assistant({ input_tokens: 1_000, output_tokens: 50_000 }))).toBe(1_000);
  });

  it('reads nothing from a result event, whose usage is the whole turn summed', () => {
    // A turn makes many API calls. Summing their input counts would report ten
    // round trips of a 40k conversation as 400k and show a window bursting
    // when it is comfortable.
    expect(getClaudeContextTokens({
      type: 'result', usage: { input_tokens: 400_000 },
    } as never)).toBeUndefined();
  });

  it('treats an all-zero usage as no measurement, not an empty window', () => {
    // What a synthetic answer reports when no API call was made. Storing it as
    // zero would redraw a nearly-full window as empty.
    expect(getClaudeContextTokens(assistant({
      input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }))).toBeUndefined();
  });

  it('survives a stream that carries no usage at all', () => {
    expect(getClaudeContextTokens(assistant(undefined))).toBeUndefined();
    expect(getClaudeContextTokens({ type: 'assistant' } as never)).toBeUndefined();
    expect(getClaudeContextTokens({ type: 'system', subtype: 'init' } as never)).toBeUndefined();
    expect(getClaudeContextTokens(assistant({ input_tokens: 'lots' }))).toBeUndefined();
  });
});
