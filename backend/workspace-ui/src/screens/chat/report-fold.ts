/**
 * An agent's report in the Chief of Staff's chat, folded (note #744).
 *
 * Adam, 2026-10-12, with a phone screenshot of Willow's report filling the
 * screen and running on: "In Chief of Staff screen, I think message from
 * another agent should be compact." A report there is written FOR the Chief
 * of Staff, which answers him with its own short version straight after, so
 * the long one is the same news twice. It stands folded — the sender, then
 * two lines of what it says — and opens in place at a tap.
 *
 * The two lines are the report's own words as plain text: Markdown drawn
 * inside a two-line clamp cuts a list or a heading mid-shape, while one run
 * of text cuts cleanly at the end of the second line.
 */

/** Below this many characters of plain text a report already fits in about
 *  two lines on a phone, and a fold would hide nothing. */
export const REPORT_FOLD_CHARS = 160;

/** The words a reader sees, without the Markdown that draws them. */
export function reportPreview(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(?:(?:#{1,6}|>|[-*+]|\d+[.)])(?:\s+|$))+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether a report is long enough to stand folded. */
export function foldsReport(markdown: string): boolean {
  return reportPreview(markdown).length > REPORT_FOLD_CHARS || /\n\s*\n/.test(markdown.trim());
}
