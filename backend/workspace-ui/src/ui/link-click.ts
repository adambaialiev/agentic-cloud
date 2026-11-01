/**
 * Whether a click on a link is this app's to answer.
 *
 * Everything in the Workspace that leads somewhere carries a REAL address, so
 * the browser can copy it, open it in another tab and long-press it. Only the
 * plain left-click belongs to the shell — a modifier or a middle button is the
 * reader asking the BROWSER for something, and taking that click away is how
 * an app quietly loses "open in a new tab".
 */
export function plainClick(event: MouseEvent): boolean {
  return !event.defaultPrevented && event.button === 0
    && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
