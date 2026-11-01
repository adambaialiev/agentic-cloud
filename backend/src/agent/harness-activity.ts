/**
 * The one-liner a running turn carries about what it is doing this second —
 * "Bash: npm run build", "$ git push origin HEAD" — read off each harness's
 * own event stream and shown, unprettified, by every surface that reports a
 * live turn: the Workspace agent screen's WORKING row, the fleet row's tail,
 * and the label on the newest chat message.
 *
 * Both harnesses build that line, so the cut belongs here rather than twice:
 * two vocabularies for one fact is how the surfaces start disagreeing.
 */

/**
 * How much of the tool's ARGUMENT survives into that line.
 *
 * It was 40 characters, and 40 cut nearly every real command mid-word: the
 * agent screen showed `Bash: agentbuilt agent list | grep -A1 "Alex (` and
 * simply stopped (Owner, note #47). A command cut before its closing quote
 * does not read as shortened, it reads as BROKEN — the reader's first thought
 * is that the agent ran something malformed, which is the one impression a
 * status line must never give.
 *
 * So the cut comes off the data, and the surfaces that need one make their
 * own: the fleet row ellipsises in CSS because it is one fixed-height line,
 * the agent screen wraps and shows the whole thing, and a chat button label
 * cuts to the width of a button. This cap is only the backstop — the string
 * is persisted with the turn's progress and re-sent on every poll for every
 * agent, so a heredoc pasted into Bash must not become the payload. At 200 it
 * holds every command these agents are given in practice and wraps to about
 * three lines on a phone, which is the same "wrap, never cut" the recap line
 * directly above it already follows.
 *
 * And when it does bite, it SAYS so. The silent cut is what made the old
 * value misleading; the ellipsis is the whole difference between a long
 * command and a broken one.
 */
export const HARNESS_ACTIVITY_ARG_MAX_CHARS = 200;

/**
 * Collapse a tool argument to one line and bound it. Whitespace goes first —
 * a multi-line command is still one status line, and a raw \n would break the
 * row it lands in.
 */
export function clipHarnessActivityArgument(argument: string): string {
  const clean = argument.replace(/\s+/g, ' ').trim();
  return clean.length > HARNESS_ACTIVITY_ARG_MAX_CHARS
    ? `${clean.slice(0, HARNESS_ACTIVITY_ARG_MAX_CHARS - 1)}…`
    : clean;
}
