/**
 * HTML-escapes text spliced into a decision message. The Telegram formatter
 * that once lived here (sanitizers, splitters, table rendering) left with the
 * customer bot; only this escape is still read.
 */
export function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
