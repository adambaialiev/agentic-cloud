const DEFAULT_ERROR_MESSAGE = 'Something went wrong';
const MAX_ERROR_MESSAGE_LENGTH = 1000;

function truncateMessage(value: string): string {
  if (value.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...[truncated]`;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? truncateMessage(trimmed) : undefined;
}

function normalizePrimitive(value: unknown): string | undefined {
  if (
    typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
    || typeof value === 'symbol'
  ) {
    return String(value);
  }

  return undefined;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized === '{}' || serialized === '[]') {
      return undefined;
    }

    return truncateMessage(serialized);
  } catch {
    return undefined;
  }
}

function extractArrayMessage(values: unknown[], seen: Set<unknown>): string | undefined {
  const parts = values
    .map((value) => resolveErrorMessage(value, seen))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  if (parts.length === 0) {
    return undefined;
  }

  return truncateMessage(parts.join('; '));
}

function resolveErrorMessage(error: unknown, seen = new Set<unknown>()): string | undefined {
  const direct = normalizeString(error);
  if (direct) {
    return direct;
  }

  const primitive = normalizePrimitive(error);
  if (primitive) {
    return primitive;
  }

  if (error instanceof Error) {
    const message = normalizeString(error.message);
    if (message) {
      return message;
    }
  }

  if (Array.isArray(error)) {
    return extractArrayMessage(error, seen);
  }

  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  if (seen.has(error)) {
    return undefined;
  }
  seen.add(error);

  const record = error as Record<string, unknown>;

  for (const key of ['message', 'errorMessage', 'error_description']) {
    const message = resolveErrorMessage(record[key], seen);
    if (message) {
      return message;
    }
  }

  for (const key of ['error', 'cause', 'detail', 'details', 'reason']) {
    const message = resolveErrorMessage(record[key], seen);
    if (message) {
      return message;
    }
  }

  for (const key of ['issues', 'errors']) {
    if (!Array.isArray(record[key])) {
      continue;
    }

    const message = extractArrayMessage(record[key], seen);
    if (message) {
      return message;
    }
  }

  return safeJsonStringify(error);
}

export function getOptionalErrorMessage(error: unknown): string | undefined {
  return resolveErrorMessage(error);
}

export function getErrorMessage(error: unknown, fallback = DEFAULT_ERROR_MESSAGE): string {
  return resolveErrorMessage(error) ?? fallback;
}
