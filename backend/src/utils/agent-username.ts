export function normalizeAgentUsername(value: string): string {
  return value.trim().replace(/^@+/, '').toLowerCase();
}
