export const EMIT_REASONING_TOOL_NAME = 'emit_reasoning';

function sanitizeReasoningText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function normalizeAgentReasoningInput(input: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...input };
  const normalizedText = sanitizeReasoningText(input.text);

  if (normalizedText) {
    normalized.text = normalizedText;
  }

  return normalized;
}

export function parseAgentReasoningInput(
  input: Record<string, unknown>,
  sourceLabel = `the ${EMIT_REASONING_TOOL_NAME} call`,
): {
  reasoning?: { text: string };
  invalidReason?: string;
} {
  const unsupportedFields = Object.keys(input).filter((key) => key !== 'text');
  if (unsupportedFields.length > 0) {
    return {
      invalidReason: `${sourceLabel} included unsupported field(s): ${unsupportedFields.join(', ')}; use only text`,
    };
  }

  const text = sanitizeReasoningText(normalizeAgentReasoningInput(input).text);
  if (!text) {
    return {
      invalidReason: `${sourceLabel} did not include a non-empty text field`,
    };
  }

  return {
    reasoning: { text },
  };
}
