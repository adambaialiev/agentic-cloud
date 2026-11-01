export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function formatUserLocalTimestamp(value: unknown, timeZone: unknown): string | null {
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  if (!normalizedTimeZone) {
    return null;
  }

  const timestampMs = typeof value === 'string' || typeof value === 'number'
    ? Date.parse(String(value))
    : value instanceof Date
      ? value.getTime()
      : Number.NaN;
  if (!Number.isFinite(timestampMs)) {
    return null;
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizedTimeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(timestampMs));

  const part = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find((candidate) => candidate.type === type)?.value ?? ''
  );

  return `${part('month')} ${part('day')}, ${part('year')}, ${part('hour')}:${part('minute')} ${normalizedTimeZone}`;
}

const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/g;

export function localizeIsoTimestampsInText(value: string, timeZone: unknown): string {
  if (!normalizeTimeZone(timeZone)) {
    return value;
  }

  return value.replace(ISO_TIMESTAMP_PATTERN, (timestamp) => (
    formatUserLocalTimestamp(timestamp, timeZone) ?? timestamp
  ));
}
