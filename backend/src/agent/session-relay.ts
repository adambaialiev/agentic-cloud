export const SESSION_RELAY_TOOL_NAME = 'session-relay';

export function formatSessionRelaySourceLabel(sessionId: string, title?: string): string {
  const trimmedTitle = title?.trim();
  if (!trimmedTitle || trimmedTitle === sessionId) {
    return sessionId;
  }

  return `${trimmedTitle} (${sessionId})`;
}

export function normalizeSessionRelayContent(content: string, sessionId?: string, title?: string): string {
  const trimmedContent = content.trim();
  const trimmedSessionId = sessionId?.trim();
  if (!trimmedSessionId) {
    return trimmedContent;
  }

  const legacyPrefixes = new Set([
    `Relayed reply from session ${formatSessionRelaySourceLabel(trimmedSessionId, title)}:`,
    `Relayed reply from session ${trimmedSessionId}:`,
  ]);
  for (const legacyPrefix of legacyPrefixes) {
    if (trimmedContent === legacyPrefix) {
      return '';
    }
    if (trimmedContent.startsWith(`${legacyPrefix}\n`)) {
      return trimmedContent.slice(legacyPrefix.length).trim();
    }
  }

  return trimmedContent;
}

// Source attribution travels in relay metadata/title so the model-facing text stays as child output.
export function buildSessionRelayText(sessionId: string, title: string | undefined, content: string): string {
  return normalizeSessionRelayContent(content, sessionId, title);
}

export function buildSessionRelayTitle(sessionId: string, title?: string): string {
  return `Relay from ${formatSessionRelaySourceLabel(sessionId, title)}`;
}
