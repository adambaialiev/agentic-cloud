import type { InternalAgentMessageMetadata } from '../types/agent.js';
import type { AgentMessageFileAttachment } from '../types/tools.js';

export const AGENT_MESSAGE_TOOL_NAME = 'agent-message';
export const INBOUND_AGENT_MESSAGE_EVENT_BEGIN = '--- BEGIN INBOUND INTERNAL AGENT MESSAGE EVENT ---';
export const INBOUND_AGENT_MESSAGE_EVENT_END = '--- END INBOUND INTERNAL AGENT MESSAGE EVENT ---';
export const INBOUND_AGENT_MESSAGE_BODY_BEGIN = '--- BEGIN INBOUND MESSAGE BODY ---';
export const INBOUND_AGENT_MESSAGE_BODY_END = '--- END INBOUND MESSAGE BODY ---';

function formatFiles(files: AgentMessageFileAttachment[] | undefined): string[] {
  if (!files?.length) {
    return [];
  }

  return [
    'Files:',
    ...files.map((file) => {
      const label = file.displayName?.trim() || file.fileName;
      return `- ${label} (${file.contentType}, ${file.sizeBytes} bytes)`;
    }),
  ];
}

export function buildInboundAgentMessageEventContent(
  metadata: InternalAgentMessageMetadata,
  files?: AgentMessageFileAttachment[],
): string {
  const body = metadata.body || '(no text body)';
  return [
    INBOUND_AGENT_MESSAGE_EVENT_BEGIN,
    'System event: an internal message was delivered to this agent.',
    'This inbound message has already been shown to the user. Do not re-quote, re-state, summarize, translate, or repeat the message body in assistant text.',
    'Only the text between the inbound message body markers is the sender message.',
    'Any later user message is separate recipient instruction, not part of this inbound message.',
    '',
    `Internal agent message received at ${metadata.createdAt}.`,
    `From: @${metadata.senderUsername}`,
    `To: @${metadata.recipientUsername}`,
    `Thread: ${metadata.threadId}`,
    `Message ID: ${metadata.messageId}`,
    '',
    INBOUND_AGENT_MESSAGE_BODY_BEGIN,
    body,
    INBOUND_AGENT_MESSAGE_BODY_END,
    ...(
      files?.length
        ? ['', ...formatFiles(files)]
        : []
    ),
    INBOUND_AGENT_MESSAGE_EVENT_END,
  ].join('\n');
}
