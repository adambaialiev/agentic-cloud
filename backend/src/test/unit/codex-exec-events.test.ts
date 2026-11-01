import { describe, expect, it } from 'vitest';
import {
  getCompletedItem,
  getStartedItemSummary,
  isAgentMessageItem,
  parseCodexExecEventLine,
  stripAnsiEscapes,
} from '../../agent/codex/codex-exec-events.js';
import { HARNESS_ACTIVITY_ARG_MAX_CHARS } from '../../agent/harness-activity.js';

// Real lines captured from `codex exec --json` (codex-cli 0.142.5).
const THREAD_STARTED_LINE = '{"type":"thread.started","thread_id":"019f4bb8-9cb1-77a1-87ba-32fde8cd5d6b"}';
const AGENT_MESSAGE_LINE = '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"test123"}}';
const COMMAND_ITEM_LINE = '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \'echo test123\'","aggregated_output":"test123\\n","exit_code":0,"status":"completed"}}';
const TURN_COMPLETED_LINE = '{"type":"turn.completed","usage":{"input_tokens":37976,"cached_input_tokens":32896,"output_tokens":109,"reasoning_output_tokens":13}}';

describe('parseCodexExecEventLine', () => {
  it('parses thread.started with the thread id', () => {
    const event = parseCodexExecEventLine(THREAD_STARTED_LINE);
    expect(event).toMatchObject({
      type: 'thread.started',
      thread_id: '019f4bb8-9cb1-77a1-87ba-32fde8cd5d6b',
    });
  });

  it('parses completed agent messages', () => {
    const event = parseCodexExecEventLine(AGENT_MESSAGE_LINE);
    expect(event).not.toBeNull();
    const item = getCompletedItem(event!);
    expect(item).not.toBeNull();
    expect(isAgentMessageItem(item!)).toBe(true);
    expect(item).toMatchObject({ type: 'agent_message', text: 'test123' });
  });

  it('parses command execution items without treating them as agent messages', () => {
    const event = parseCodexExecEventLine(COMMAND_ITEM_LINE);
    const item = getCompletedItem(event!);
    expect(item).toMatchObject({ type: 'command_execution', exit_code: 0 });
    expect(isAgentMessageItem(item!)).toBe(false);
  });

  it('parses turn.completed usage', () => {
    expect(parseCodexExecEventLine(TURN_COMPLETED_LINE)).toMatchObject({
      type: 'turn.completed',
      usage: { output_tokens: 109 },
    });
  });

  it('tolerates trailing carriage returns from the PTY', () => {
    expect(parseCodexExecEventLine(`${THREAD_STARTED_LINE}\r`)).toMatchObject({
      type: 'thread.started',
    });
  });

  it('returns null for non-JSON noise lines', () => {
    expect(parseCodexExecEventLine('Welcome to Codex [v0.142.5]')).toBeNull();
    expect(parseCodexExecEventLine('')).toBeNull();
    expect(parseCodexExecEventLine('{ broken json')).toBeNull();
    expect(parseCodexExecEventLine('{"no_type_field":true}')).toBeNull();
  });

  it('does not corrupt JSON containing bracketed arrays', () => {
    const line = '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"list: [first, 4m items]"}}';
    const item = getCompletedItem(parseCodexExecEventLine(line)!);
    expect(item).toMatchObject({ text: 'list: [first, 4m items]' });
  });
});

describe('stripAnsiEscapes', () => {
  it('removes color escape sequences as emitted by the codex CLI', () => {
    const colored = 'Welcome to Codex [v\x1b[90m0.142.5\x1b[0m]';
    expect(stripAnsiEscapes(colored)).toBe('Welcome to Codex [v0.142.5]');
  });

  it('leaves plain bracketed text alone', () => {
    expect(stripAnsiEscapes('keep [90m literal without escape')).toBe('keep [90m literal without escape');
  });
});


describe('getStartedItemSummary', () => {
  it('summarizes started items for the live status', () => {
    expect(getStartedItemSummary({ type: 'item.started', item: { type: 'command_execution', command: 'vite  build' } } as never))
      .toBe('$ vite build');
    expect(getStartedItemSummary({ type: 'item.started', item: { type: 'file_change' } } as never))
      .toBe('editing files');
    expect(getStartedItemSummary({ type: 'item.started', item: { type: 'reasoning' } } as never))
      .toBeNull();
    expect(getStartedItemSummary({ type: 'item.completed', item: { type: 'command_execution', command: 'x' } } as never))
      .toBeNull();
  });

  // The same cut Claude's summaries carried, and the same fix (note #47):
  // both harnesses feed one status line, so they bound it identically.
  it('keeps a real command whole, and marks a runaway one', () => {
    const command = 'agentbuilt agent list | grep -A1 "Alex ()"';
    expect(getStartedItemSummary({ type: 'item.started', item: { type: 'command_execution', command } } as never))
      .toBe(`$ ${command}`);
    expect(getStartedItemSummary({ type: 'item.started', item: { type: 'command_execution', command: 'y'.repeat(500) } } as never))
      .toBe(`$ ${'y'.repeat(HARNESS_ACTIVITY_ARG_MAX_CHARS - 1)}…`);
  });
});
