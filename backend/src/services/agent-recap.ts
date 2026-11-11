import type { WorkspaceRuntimeClient } from './sandbox-client.js';
import type { AgentCli } from '../types/user.js';
import { quoteShellArg } from '../utils/shell-quote.js';
import { buildOpenCodeRunCommand, OPENCODE_API_KEY_ENV, OPENCODE_TURN_ENV, OPENCODE_TURN_ENV_DEFAULTS } from '../agent/opencode/opencode-command.js';
import { openCodeText, parseOpenCodeEventLine } from '../agent/opencode/opencode-events.js';

/**
 * The agent-row recap (agent-row-recap-design): two short sentences of plain
 * text under an agent's name in the Workspace, written by summarizer calls during and
 * after a turn (note #143) and never by the agent itself. This module is the
 * summarizer — the prompt, the command that runs it on the agent's own
 * machine, and the parsing of what comes back. The service wires it to the
 * turn lifecycle; all this module knows is whether the conversation it is
 * folding in is finished or still running.
 *
 * Every failure path returns undefined rather than throwing where a caller
 * might surface it: the contract is failure = silence, because a stale recap
 * beats a broken row and nothing about a row line is worth an error message
 * in anyone's chat.
 */

/**
 * Two short latest-work sentences — what happened, then where it stands —
 * short enough to scan beside the other agents in a room (owner, 2026-09-24:
 * one sentence was too short to carry both). This is what the summarizer is ASKED for; the larger
 * store cap below is only a safety net for a model that misses the brief.
 */
export const TELEGRAM_AGENT_RECAP_MAX_LENGTH = 240;

/**
 * Where the recap is actually CUT — a safety net for a model that overran its
 * brief, not a second design size (note #67, Owner 2026-08-27).
 *
 * These were one number, and storing at the row's size meant the row's size
 * was all that ever existed: the agent screen's "recap, whole" had nothing
 * whole to show, because the tail was thrown away before it was ever written
 * down. Worse, the cut lands at the END, so the clause with something for a
 * human to do is the first one over the edge. The screenshot on the note ends
 * "Waiting on…", which is the bug stating itself.
 *
 * Generous enough that a recap two sentences over its brief survives intact,
 * bounded so a model that ignores the brief entirely cannot write a page into
 * every row.
 */
export const TELEGRAM_AGENT_RECAP_STORE_MAX_LENGTH = 600;

/** One chat-level message of the turn being recapped. */
export interface AgentRecapTurnMessage {
  role: 'owner' | 'agent' | 'platform';
  text: string;
}

/**
 * Caps for the summarizer's input. The tail keeps the FIRST message (the
 * request — the one message that always matters) and the newest replies; a
 * long turn's middle is the part a recap can afford to lose.
 */
const RECAP_INPUT_MAX_MESSAGES = 6;
const RECAP_INPUT_MAX_MESSAGE_CHARS = 3000;

export function capAgentRecapMessages(messages: AgentRecapTurnMessage[]): AgentRecapTurnMessage[] {
  const capped = messages.map((m) => ({
    role: m.role,
    text: m.text.length > RECAP_INPUT_MAX_MESSAGE_CHARS
      ? `${m.text.slice(0, RECAP_INPUT_MAX_MESSAGE_CHARS)}…`
      : m.text,
  }));
  if (capped.length <= RECAP_INPUT_MAX_MESSAGES) {
    return capped;
  }
  return [capped[0]!, ...capped.slice(capped.length - (RECAP_INPUT_MAX_MESSAGES - 1))];
}

/**
 * Normalize what the model returned into a row-safe line: control characters
 * out, whitespace collapsed, hard-capped at a word boundary with an ellipsis
 * (same shape the old task-line summarizer used — mid-word truncation reads
 * as corruption). Undefined when nothing usable is left.
 *
 * The cap here is the STORE cap, not the row's: what gets written down is what
 * the agent's own screen can show whole.
 */
export function normalizeAgentRecapText(raw: string): string | undefined {
  const line = raw.replace(/[\u0000-\u001F\u007F]/g, ` `).replace(/\s+/g, ' ').trim();
  if (!line) {
    return undefined;
  }
  if (line.length <= TELEGRAM_AGENT_RECAP_STORE_MAX_LENGTH) {
    return line;
  }
  const cut = line.slice(0, TELEGRAM_AGENT_RECAP_STORE_MAX_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > TELEGRAM_AGENT_RECAP_STORE_MAX_LENGTH * 0.6
    ? cut.slice(0, lastSpace)
    : cut;
  return `${kept.replace(/[\s,;:.!?-]+$/, '')}…`;
}

/**
 * The seed for an agent that has no recap yet: the last legacy task line the
 * agent wrote for itself. The old `about` description is deliberately ignored
 * now that the room supplies the standing context (note #109). Kept as a
 * function of the record so the Workspace and the summarizer's "previous
 * recap" input agree on what the row currently says.
 */
export function composeSeedAgentRecap(agent: {
  about?: string;
  tasks?: { text: string; byAgent?: boolean }[];
}): string | undefined {
  const lastOwnTask = agent.tasks?.find((task) => task.byAgent)?.text;
  if (!lastOwnTask) {
    return undefined;
  }
  return normalizeAgentRecapText(lastOwnTask);
}

/**
 * The whole contract, addressed to a model that is NOT the agent: one brief
 * latest-work update, with a real blocker or owner action only when one
 * exists. The room already supplies the agent's standing context, so the
 * recap never repeats its role, purpose or tools (note #109).
 */
export function buildAgentRecapPrompt(args: {
  previousRecap: string | undefined;
  messages: AgentRecapTurnMessage[];
  /**
   * True for a mid-turn checkpoint (note #143): the transcript below is a
   * turn still running, so the recap must read as work in progress — a
   * summarizer that sees half a turn and writes "Shipped X." puts a claim on
   * the row that the turn may yet walk back.
   */
  turnInProgress?: boolean;
  /**
   * This turn ended in a fresh chat (`agentbuilt chat new`), note #367.
   *
   * WHY THE SUMMARIZER HAS TO BE TOLD. A reset turn's transcript is almost
   * always the ceremony and nothing else — "reset chat" in, "starting us a
   * fresh chat" out — and the rules above tell the model to replace the
   * previous recap whenever this turn has a newer useful state. It reads the
   * reset as one. So the row of every freshly-reset agent lost the work it
   * had been reporting and said "Reset the chat at owner's request" instead:
   * from the outside, indistinguishable from no recap being written at all.
   *
   * The transcript cannot carry this. The reset boundary is a divider in the
   * chat record, deliberately kept out of the recap buffer because it marks
   * the space BETWEEN turns rather than anything anybody said — so the flag
   * is the channel, and what it buys is a different instruction, not a
   * different transcript.
   */
  chatReset?: boolean;
  /**
   * The owner's own Chief of Staff (note #1146). Its recap is read by one
   * person only, under its reply in their private conversation, and may be
   * read ALOUD to them — so it is written to them, in the agent's voice
   * ("I proposed …; it's waiting on you to …"), never about them ("Proposed
   * … for Adam"). Always, not only while their speaker is on: the recap is
   * written at the turn's end, before any page could say whether it will be
   * heard, and the second person reads as well as it sounds.
   */
  addressOwner?: boolean;
}): string {
  const transcript = capAgentRecapMessages(args.messages)
    .map((m) => `[${m.role}] ${m.text}`)
    .join('\n\n');
  return [
    'You maintain the short recap shown under an AI agent\'s name in its owner\'s workspace, beside its siblings\' rows. You are a neutral summarizer, not the agent. Do not use any tools. Reply with STRICT JSON on a single line — {"recap":"...","finished":false} — and nothing else.',
    '',
    'Rules for the recap text:',
    `- Write exactly two short, direct sentences: normally 30 words or fewer in all, always at most ${TELEGRAM_AGENT_RECAP_MAX_LENGTH} characters. Plain text only; no markdown, bullets or surrounding quotes.`,
    '- The first sentence says what happened: the concrete work and its outcome. The second says where it stands now: what is still open or blocked, or what the owner must do next — or, when nothing is waiting, the most useful detail of the result, such as where it lives or how it was checked.',
    '- Make it self-contained for a reader who did not see the conversation: name the concrete page, feature, bug, decision, or deliverable and say what happened to it.',
    '- Say only the latest useful work state: what was finished, what remains blocked, or what the owner must do next.',
    '- Keep it about this agent\'s work. Mention another agent only when that person\'s response blocks this result.',
    '- Do NOT describe the agent\'s standing role, purpose, skills, room, harness, model, or tools. Never begin with "Works on", "Builds", "Maintains", or an equivalent role description.',
    '- Outcomes over ceremony: "Shipped the pricing page." is useful; "Worked on the task." is not.',
    '- Workflow bookkeeping is not the work. "The PR merged", "the note is complete", "pushed the branch", and "tests passed" are not recaps by themselves. State what changed; add an ID or verification only if space remains.',
    '- A number alone tells a person nothing. Never let a PR, note, or knowledge-page number stand for the work: whenever you cite one, put what it is about in parentheses right after it — "PR #1015 (last-reply age on agent screens) merged", "note #555 (answer the Workspace Agent only when asked) done" — or leave the number out and name the thing itself.',
    '- Avoid vague references such as "it", "this", "the task", "the fix", or "the change" unless the concrete subject appears in the same sentence.',
    '- Mention an approval, decision, reply, or blocker only when it is actually waiting. Never say that nothing is waiting.',
    '- Write in the language the owner writes in.',
    ...(args.addressOwner
      ? [
        '- THIS AGENT IS THE OWNER\'S OWN CHIEF OF STAFF. Its recap is shown under its reply in their private conversation and may be READ ALOUD to them, so write it TO the owner, in the agent\'s voice: "I" for the agent, "you" for the owner. "I proposed the pricing page; it\'s waiting on you to approve it." is right. Never write about the owner in the third person: "Proposed the pricing page for Adam." and "The owner must approve it." are wrong. Other people and agents are still named.',
        '- It is heard as well as read: plain words that sound natural spoken aloud. No URLs, file paths, code or symbols.',
      ]
      : []),
    '- The previous recap is context, not a prefix. Replace it when this turn has a newer useful state. If nothing meaningful changed, return the previous recap, tightened if needed so it follows every rule above.',
    ...(args.turnInProgress
      ? ['- This turn is STILL RUNNING. Say what the agent is doing or has done so far, true as of right now; never present unfinished work as finished.']
      : []),
    ...(args.chatReset
      ? [
        '- THE CONVERSATION WAS CLEARED at the end of this turn: the agent starts fresh and remembers none of it. Clearing a conversation is housekeeping, not work — never let it become the whole recap.',
        '- So carry the WORK forward: keep what the previous recap said the agent had done or was waiting on, and add that its conversation was cleared. "Shipped the pricing page. Its conversation was then cleared." is right; "Reset the chat as asked." is not, because it tells the owner nothing about the work.',
        '- If the previous recap is empty and this turn did no other work, say only that the conversation was cleared.',
      ]
      : []),
    '',
    'Rules for "finished" (true or false). It decides whether the owner is offered a fresh chat for this agent, and a fresh chat makes the agent forget this conversation:',
    '- true ONLY when the work your recap describes is done and nothing about it is still waiting: no approval, review, decision, check, build, deploy or background job; no reply owed by or to the owner or anyone else; no step the agent said it would still take; no question it asked that has not been answered.',
    '- false in every other case, and false whenever you are unsure. A wrong false costs the owner one more press later; a wrong true throws away a conversation the work still needs.',
    ...(args.turnInProgress
      ? ['- This turn is STILL RUNNING, so "finished" is false.']
      : []),
    '',
    `Previous recap: ${args.previousRecap ? JSON.stringify(args.previousRecap) : '(none yet)'}`,
    '',
    args.turnInProgress
      ? 'The conversation turn to fold in (still in progress — the agent is working right now):'
      : args.chatReset
        ? 'The conversation turn to fold in (the last one before the chat was cleared):'
        : 'The conversation turn to fold in:',
    transcript || '(no messages were captured for this turn)',
  ].join('\n');
}

/**
 * One summarizer answer: the row's text, and whether the work it describes is
 * FINISHED — done, with nothing waiting on anyone (note #707). The second half
 * is what lets a room offer a fresh chat to exactly the agents that are safe
 * to reset, without a person reading every row to decide.
 */
export interface AgentRecapResult {
  text: string;
  /**
   * Only a literal JSON `true` counts. A model that leaves the key out, writes
   * "yes", or is cut off mid-object has not said the work is finished, and an
   * agent is never offered a reset on a guess.
   */
  finished: boolean;
}

/**
 * Fish the recap out of whatever the CLI printed. Models wrap JSON in prose
 * and fences often enough that "parse stdout" is not a plan; "parse the last
 * {...} that has a recap key" is.
 */
export function parseAgentRecapResult(stdout: string): AgentRecapResult | undefined {
  const matches = stdout.match(/\{[^{}]*"recap"[^{}]*\}/g);
  if (!matches) {
    return undefined;
  }
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(matches[i]!) as { recap?: unknown; finished?: unknown };
      if (typeof parsed.recap === 'string') {
        const text = normalizeAgentRecapText(parsed.recap);
        return text ? { text, finished: parsed.finished === true } : undefined;
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** The row's text alone — see `parseAgentRecapResult`. */
export function parseAgentRecapOutput(stdout: string): string | undefined {
  return parseAgentRecapResult(stdout)?.text;
}

/**
 * The model/effort pairs are HARD-REQUIRED by the design: Sonnet at xhigh for
 * Claude agents and GPT-5.6-Terra at xhigh for Codex agents (owner, note #559
 * follow-up 2026-09-18; both were high before), with no fallback.
 * A seat that cannot run them produces silence, not a worse recap. An agent
 * on a retired harness is skipped entirely by its callers.
 */
export const CLAUDE_RECAP_MODEL = 'sonnet';
export const CODEX_RECAP_MODEL = 'gpt-5.6-terra';
export const CLAUDE_RECAP_EFFORT = 'xhigh';
export const CODEX_RECAP_EFFORT = 'xhigh';
/**
 * OpenCode agents' recap (note #780): Go's fast model, which Go allows several
 * times the usage of the flagships — a recap after every turn must not be what
 * empties the member's window.
 */
export const OPENCODE_RECAP_MODEL = 'glm-5.3-flash';
export const OPENCODE_RECAP_EFFORT = 'high';

export function buildClaudeRecapCommand(prompt: string, oauthToken?: string, runtime = { model: CLAUDE_RECAP_MODEL, effort: CLAUDE_RECAP_EFFORT }): string {
  const tokenPrefix = oauthToken ? `CLAUDE_CODE_OAUTH_TOKEN=${quoteShellArg(oauthToken)} ` : '';
  return `${tokenPrefix}claude -p ${quoteShellArg(prompt)} --output-format text`
    + ` --model ${quoteShellArg(runtime.model)} --effort ${quoteShellArg(runtime.effort)}`
    + ' --disallowed-tools ' + quoteShellArg('*')
    + ' < /dev/null';
}

export function buildCodexRecapCommand(prompt: string, runtime = { model: CODEX_RECAP_MODEL, effort: CODEX_RECAP_EFFORT }): string {
  // --output-last-message is the one channel where codex exec prints ONLY the
  // final message: stdout carries event logs, and parsing those would couple
  // this to the CLI's log format.
  //
  // `< /dev/null` is load-bearing, exactly as in the Claude command above:
  // `codex exec` takes the prompt as an argument AND still appends piped
  // stdin as a <stdin> block, so with stdin not a terminal it reads to EOF
  // before doing anything at all. Its absence cost every Codex agent its
  // recap — the call blocked until the 180s timeout, and "failure = silence"
  // meant the row simply never changed.
  //
  // `STATUS=$?` and the closing `exit` are equally load-bearing. This used to
  // end on `cat "$OUT"; rm -f -- "$OUT"`, so the command's status was `rm`'s —
  // always 0. A codex that had failed outright (it exits 1 on an unusable
  // model, an expired credential or a usage limit) was reported to the caller
  // as a SUCCESS with empty output, indistinguishable from a model whose
  // answer failed to parse. Its diagnostics went to `2>&1` /dev/null, so
  // nothing anywhere recorded which had happened. Keep the status, and keep
  // codex's own words on stderr where ExecSyncResult carries them.
  return 'OUT=$(mktemp); ERR=$(mktemp); codex exec --skip-git-repo-check --sandbox read-only -C /home/agent'
    + ` --model ${quoteShellArg(runtime.model)} -c ${quoteShellArg(`model_reasoning_effort=${runtime.effort}`)}`
    + ` --output-last-message "$OUT" ${quoteShellArg(prompt)} < /dev/null >/dev/null 2>"$ERR"; STATUS=$?;`
    + ' cat "$OUT"; tail -c 2000 "$ERR" >&2; rm -f -- "$OUT" "$ERR"; exit "$STATUS"';
}

/**
 * OpenCode has no "print only the answer" mode, so its JSON stream is kept
 * and the answer is read out of its `text` lines (agentRecapTextOfOpenCode).
 * Every tool is denied, so the summarizer reads only what it is given; the
 * session `opencode run` had to open for it is deleted afterwards, so the
 * agent's own session list never fills with recaps. The status is the run's,
 * for the same reason as Codex's above.
 */
export function buildOpenCodeRecapCommand(prompt: string, apiKey?: string, runtime = { model: OPENCODE_RECAP_MODEL, effort: OPENCODE_RECAP_EFFORT }): string {
  const env = {
    ...OPENCODE_TURN_ENV_DEFAULTS,
    // The limit plugin is for turns; a recap that meets a limit simply fails.
    [OPENCODE_TURN_ENV]: '0',
    OPENCODE_PERMISSION: '{"*":"deny"}',
    ...(apiKey ? { [OPENCODE_API_KEY_ENV]: apiKey } : {}),
  };
  const prefix = Object.entries(env).map(([name, value]) => `${name}=${quoteShellArg(value)}`).join(' ');
  const run = buildOpenCodeRunCommand({ prompt, model: runtime.model, effort: runtime.effort, title: 'Recap', withPlugin: false });
  return `OUT=$(mktemp); ERR=$(mktemp); ${prefix} ${run} < /dev/null > "$OUT" 2>"$ERR"; STATUS=$?;`
    + ' cat "$OUT";'
    + ` SID=$(grep -o '"sessionID":"ses_[A-Za-z0-9]*"' "$OUT" | head -1 | cut -d'"' -f4);`
    + ' if [ -n "$SID" ]; then opencode session delete "$SID" >/dev/null 2>&1 < /dev/null; fi;'
    + ' tail -c 2000 "$ERR" >&2; rm -f -- "$OUT" "$ERR"; exit "$STATUS"';
}

/** The answer an OpenCode recap run wrote: its `text` lines, joined. */
export function agentRecapTextOfOpenCode(stdout: string): string {
  return stdout.split('\n')
    .map((line) => parseOpenCodeEventLine(line))
    .map((event) => (event ? openCodeText(event) : null))
    .filter((text): text is string => Boolean(text?.trim()))
    .join('\n');
}

/** Generous for one brief recap; the machine is awake from the turn. */
const RECAP_EXEC_TIMEOUT_MS = 180_000;

/**
 * Run the summarizer on the agent's machine and return the new recap text
 * and its finished judgement. Undefined on every failure — bad JSON, empty
 * output, exec error, timeout. The CALLER resolves the credential (the lease
 * dance is turn machinery, not summarizer machinery) and decides whether the
 * result is worth writing. A turn still running is never finished, whatever
 * the model said.
 */
export async function runAgentRecapSummarizer(args: {
  sandboxClient: Pick<WorkspaceRuntimeClient, 'execSync'>;
  sandboxId: string;
  sshUser: string;
  cli: AgentCli;
  previousRecap: string | undefined;
  messages: AgentRecapTurnMessage[];
  turnInProgress?: boolean;
  /** This turn ended in a fresh chat — see `buildAgentRecapPrompt`. */
  chatReset?: boolean;
  /** The owner's Chief of Staff: written to them — see `buildAgentRecapPrompt`. */
  addressOwner?: boolean;
  claudeOauthToken?: string;
  /** An OpenCode agent's seat key, for its own summarizer run. */
  opencodeApiKey?: string;
}): Promise<AgentRecapResult | undefined> {
  if (args.cli !== 'claude' && args.cli !== 'codex' && args.cli !== 'opencode') {
    return undefined;
  }
  const prompt = buildAgentRecapPrompt({
    previousRecap: args.previousRecap,
    messages: args.messages,
    ...(args.turnInProgress ? { turnInProgress: true } : {}),
    ...(args.chatReset ? { chatReset: true } : {}),
    ...(args.addressOwner ? { addressOwner: true } : {}),
  });
  const command = args.cli === 'claude'
    ? buildClaudeRecapCommand(prompt, args.claudeOauthToken)
    : args.cli === 'opencode'
      ? buildOpenCodeRecapCommand(prompt, args.opencodeApiKey)
      : buildCodexRecapCommand(prompt);
  try {
    const result = await args.sandboxClient.execSync(args.sandboxId, command, undefined, {
      timeoutMs: RECAP_EXEC_TIMEOUT_MS,
      sshUser: args.sshUser,
    });
    if (result.timedOut || result.exitCode !== 0) {
      return undefined;
    }
    const parsed = parseAgentRecapResult(args.cli === 'opencode' ? agentRecapTextOfOpenCode(result.stdout) : result.stdout);
    return parsed && args.turnInProgress ? { ...parsed, finished: false } : parsed;
  } catch {
    return undefined;
  }
}
