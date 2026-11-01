/**
 * Resolve the public backend origin written into every agent's
 * `~/.agentbuilt/config.json`.
 *
 * `TELEGRAM_WEBHOOK_URL` is a compatibility fallback only. The customer
 * Telegram flow was retired before every deployed host had copied its origin
 * into the dedicated variable; dropping the fallback at the same time left
 * newly created machines without the CLI while older machines kept their
 * already-written config.
 */
export function resolveAgentbuiltApiUrl(
  agentbuiltApiUrl: string | undefined,
  legacyTelegramWebhookUrl: string | undefined,
): string {
  const configured = agentbuiltApiUrl?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  const legacy = legacyTelegramWebhookUrl?.trim();
  if (!legacy) return '';
  try {
    return new URL(legacy).origin;
  } catch {
    return '';
  }
}
