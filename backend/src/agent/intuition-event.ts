import type { AgentMessage, AgentSyntheticEventMetadata, IntuitionEventMetadata } from '../types/agent.js';

export const INTUITION_EVENT_TOOL_NAME = 'intuition-event';

export function normalizeIntuitionEventText(text: string): string {
  return text.trim();
}

export function buildIntuitionEventMetadata(text: string): IntuitionEventMetadata {
  return {
    kind: 'intuition',
    text: normalizeIntuitionEventText(text),
  };
}

export function getIntuitionEventText(
  event: AgentSyntheticEventMetadata | Pick<AgentMessage, 'content' | 'syntheticEvent'>,
): string {
  if ('kind' in event) {
    return event.kind === 'intuition' ? normalizeIntuitionEventText(event.text) : '';
  }

  return normalizeIntuitionEventText(event.syntheticEvent?.text ?? event.content);
}

export function buildIntuitionEventMessage(
  event: AgentSyntheticEventMetadata | string,
): AgentMessage {
  const metadata = typeof event === 'string'
    ? buildIntuitionEventMetadata(event)
    : event;
  const text = getIntuitionEventText(metadata);

  return {
    role: 'tool',
    content: text,
    toolName: INTUITION_EVENT_TOOL_NAME,
    title: 'Intuition',
    syntheticEvent: {
      kind: 'intuition',
      text,
    },
  };
}
