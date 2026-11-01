import { describe, expect, it } from 'vitest';
import {
  EMIT_REASONING_TOOL_NAME,
  normalizeAgentReasoningInput,
  parseAgentReasoningInput,
} from '../../agent/agent-reasoning.js';

describe('agent reasoning protocol', () => {
  it('uses emit_reasoning as the internal reasoning tool name', () => {
    expect(EMIT_REASONING_TOOL_NAME).toBe('emit_reasoning');
  });

  it('normalizes a single text field', () => {
    expect(normalizeAgentReasoningInput({ text: '  inspect before editing  ' })).toEqual({
      text: 'inspect before editing',
    });
  });

  it('parses non-empty reasoning text', () => {
    expect(parseAgentReasoningInput({ text: 'Read the failing test first.' })).toEqual({
      reasoning: { text: 'Read the failing test first.' },
    });
  });

  it('rejects missing text without accepting legacy aliases', () => {
    expect(parseAgentReasoningInput({ thinking: 'legacy', next_phase: 'run' })).toEqual({
      invalidReason: 'the emit_reasoning call included unsupported field(s): thinking, next_phase; use only text',
    });
  });

  it('rejects extra fields even when text is present', () => {
    expect(parseAgentReasoningInput({ text: 'Inspect first.', title: 'Regroup' })).toEqual({
      invalidReason: 'the emit_reasoning call included unsupported field(s): title; use only text',
    });
  });
});
