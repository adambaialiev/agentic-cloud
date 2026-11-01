/**
 * What the Knowledge shelf says about itself, ported function for function
 * from the legacy page so both shells describe the same pages the same way.
 */

/**
 * How many pages Home shows before the rest move to their own screen (the
 * owner, note #48). Six is a glance; the rest are one tap away rather than
 * gone.
 */
export const KNOWLEDGE_SHOWN = 6;

/** The line under the Knowledge screen's title: how many pages, and where
 *  they came from. */
export function knowledgeScreenSub(count: number): string {
  return count === 1
    ? 'One page, written by the workplace’s agents and shared across it.'
    : `${count} pages, written by the workplace’s agents and shared across it.`;
}

/**
 * The row onto the Knowledge screen, in the words that say the screen holds
 * ALL of them — the six above it included, because that is what is behind the
 * tap. "Pages", not "knowledge": the section names the shelf, a row names
 * what is on it.
 */
export function knowledgeDoorLabel(count: number): string {
  return `All ${count} pages`;
}

/** The sentence an empty knowledge base gets. A named room owns one before
 *  its first page, so this says who fills it rather than hiding the shelf —
 *  and it names KNOWLEDGE and what a page holds, not a metaphor for it
 *  (note #681: "it talks about the memory"). */
export const KNOWLEDGE_EMPTY_TITLE = 'Start the workplace’s knowledge';
export const KNOWLEDGE_EMPTY_BODY =
  'Knowledge pages hold what agents have worked out — how things run, what was decided and why. '
  + 'Every agent reads them, and each page is reviewed before it lands. Ask any agent to write the first one.';
