/**
 * The small words for numbers and moments the administration screens share,
 * ported from the legacy page so both shells say the same thing.
 */

/** "2 Sep 2026, 10:31" in the reader's locale, or '' for a bad time. */
export function absolute(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** "24 Sep 2026" in the reader's locale, or '' for a bad time. */
export function dayWords(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Copy text that still has to be FETCHED, inside the tap that asked for it.
 * Safari only honours a clipboard write that starts synchronously in the
 * gesture, so the promise goes into the ClipboardItem and the fetch happens
 * behind it; older webviews reject that shape and fall through to the plain
 * write once the text is in hand.
 */
export async function copyFromTap(load: () => Promise<string>): Promise<void> {
  // A loader may CREATE the link. Retain its one result across copy methods.
  const loaded = load();
  if (navigator.clipboard && 'ClipboardItem' in window) {
    try {
      const blob = loaded.then((text) => new Blob([text], { type: 'text/plain' }));
      // Some browsers reject write before consuming the promised Blob.
      void blob.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return;
    } catch { /* fall through */ }
  }
  const value = await loaded;
  if (!navigator.clipboard?.writeText) throw new Error('Copying is unavailable. Select and copy the link below.');
  await navigator.clipboard.writeText(value);
}

export function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener');
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
