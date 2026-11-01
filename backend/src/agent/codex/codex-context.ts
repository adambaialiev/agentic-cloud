import type { WorkspaceRuntimeClient } from '../../services/sandbox-client.js';
import type { CodexTokenTotal } from '../turn-tokens.js';

/**
 * How full a Codex agent's context window is — read from the CLI's own rollout
 * file, because the JSONL stream a turn produces cannot answer the question.
 *
 * WHY NOT `turn.completed`: its `usage` is a RUNNING TOTAL for the whole
 * thread, not this turn and not this request. Verified against codex-cli
 * 0.148.0 (2026-08-19): a turn that made two model requests of 1,000 and 2,000
 * prompt tokens reported `input_tokens: 3000`, and the next turn on the same
 * thread — one request of 1,000 — reported `4000`. Drawing a window fill from
 * that number would show a comfortable conversation as bursting, and would do
 * it more the longer the chat ran, which is the exact opposite of what the
 * measurement is for.
 *
 * The rollout file has the honest number. Codex writes one `token_count` event
 * per model request, carrying `last_token_usage` (that request alone),
 * `total_token_usage` (the running total above), and `model_context_window`.
 * The LAST such event in the file is the most recent prompt — what "how full is
 * it now" means, and the same choice the Claude harness makes when it reads the
 * last `assistant` event instead of the summed `result`.
 */

/** The path Codex keeps its rollout files under, relative to the CLI user's home. */
const SESSIONS_DIR = '$HOME/.codex/sessions';

/**
 * Only the tail of the file is searched. A `token_count` is always near the
 * end — one is written after every model request, so at most a final message
 * and the turn's closing events follow the last one — and a thread that has
 * been running for weeks should not cost a full-file read every turn. Generous
 * enough to sit behind even a turn that dumped a large command output into the
 * rollout after its last request.
 */
const ROLLOUT_TAIL_BYTES = 4_000_000;

/** Thread ids are CLI-generated UUIDs; anything else never reaches a shell. */
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * The shell that finds this thread's rollout and prints its last `token_count`
 * line, or nothing at all. `find` rather than a glob because the date-based
 * directory layout is Codex's business and may change; the file name carries
 * the thread id, which is the part we were given.
 */
export function buildCodexContextCommand(threadId: string): string | null {
  if (!THREAD_ID_PATTERN.test(threadId)) return null;
  return [
    `f=$(find ${SESSIONS_DIR} -maxdepth 5 -type f -name "rollout-*-${threadId}.jsonl" 2>/dev/null | head -n 1);`,
    'if [ -n "$f" ]; then',
    `tail -c ${ROLLOUT_TAIL_BYTES} "$f" | grep '"type":"token_count"' | tail -n 1;`,
    'fi',
  ].join(' ');
}

/** What a turn measured: the last prompt's size, and the window it went into. */
export interface CodexContextReading {
  tokens: number;
  /**
   * The window Codex itself enforces for the running model — smaller than the
   * catalog figure (258,400 against gpt-5.6-terra's 272,000), because the CLI
   * holds back room for the reply. Reported rather than looked up, so the
   * percentage a user reads is a percentage of the window their agent actually
   * has, and cannot drift as OpenAI ships models this backend has never heard
   * of.
   */
  window?: number;
  /**
   * The thread's running total (`total_token_usage`) — the wrong answer to
   * "how full", and exactly the right input to "what did this turn spend",
   * which the token ledger takes as the difference from the last one
   * (agent/turn-tokens.ts).
   */
  total?: CodexTokenTotal;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function readTotal(value: unknown): CodexTokenTotal | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const usage = value as Record<string, unknown>;
  const total = {
    input: nonNegativeInteger(usage.input_tokens),
    cachedInput: nonNegativeInteger(usage.cached_input_tokens),
    output: nonNegativeInteger(usage.output_tokens),
    reasoning: nonNegativeInteger(usage.reasoning_output_tokens),
  };
  return total.input > 0 || total.output > 0 ? total : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

/**
 * The reading in a rollout's `token_count` line, or null when the line says
 * nothing usable.
 *
 * `last_token_usage.input_tokens` is the whole prompt: OpenAI counts cached
 * reads inside `input_tokens` (`cached_input_tokens` is a subset, reported for
 * billing), and Codex passes the provider's numbers through untouched —
 * verified by feeding it known usage and reading back the same figures. There
 * is deliberately no fallback to `total_token_usage`: that is the thread's
 * running total, and answering with it would be answering a different question
 * in the same shape.
 */
export function parseCodexContextOutput(stdout: string): CodexContextReading | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    // Rollout lines wrap the event (`{timestamp, type: 'event_msg', payload}`);
    // tolerate a bare payload too, so a future flatter shape still reads.
    const envelope = parsed as { payload?: unknown; type?: unknown };
    const payload = (typeof envelope.payload === 'object' && envelope.payload !== null)
      ? envelope.payload as Record<string, unknown>
      : envelope as Record<string, unknown>;
    if (payload.type !== 'token_count') continue;
    const info = payload.info;
    if (typeof info !== 'object' || info === null) continue;
    const infoValue = info as Record<string, unknown>;
    const last = infoValue.last_token_usage;
    if (typeof last !== 'object' || last === null) continue;
    const tokens = positiveInteger((last as Record<string, unknown>).input_tokens);
    if (tokens === undefined) continue;
    const window = positiveInteger(infoValue.model_context_window);
    const total = readTotal(infoValue.total_token_usage);
    return { tokens, ...(window !== undefined ? { window } : {}), ...(total ? { total } : {}) };
  }
  return null;
}

/**
 * Read the fill for one thread from the machine it ran on, or null.
 *
 * Called after the turn's text has already been delivered, so its cost is off
 * the path the user waits on, and every failure — no rollout, no match, a
 * flaky SSH read — degrades to "no measurement this turn" rather than to a
 * failed turn. The record keeps its previous reading in that case, which is
 * stale by one turn rather than wrong.
 */
export async function readCodexContextUsage(args: {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  sshUser: string;
  threadId: string;
}): Promise<CodexContextReading | null> {
  const command = buildCodexContextCommand(args.threadId);
  if (!command) return null;
  const result = await args.sandboxClient.execSync(
    args.sandboxId,
    command,
    undefined,
    { timeoutMs: 15_000, sshUser: args.sshUser },
  );
  return parseCodexContextOutput(result.stdout);
}
