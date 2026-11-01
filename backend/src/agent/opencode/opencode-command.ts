/**
 * The command an OpenCode turn runs (note #780), and the one file the
 * platform puts beside it: a plugin that ends a turn at a usage limit.
 *
 * Measured against opencode 1.19.3 with a stub provider (2026-10-20):
 *
 *  - `opencode run` RE-JOINS its message arguments, and wraps any argument
 *    that contains a space in double quotes (escaping the quotes inside). A
 *    prompt passed as one argument therefore reaches the model as `"…"`, with
 *    its own quotes backslashed. Split on single spaces, no piece contains
 *    one, and the join gives back the prompt byte for byte — tabs, newlines,
 *    double spaces, quotes and leading dashes included (after `--`).
 *  - Without `--title`, every new session spends a SECOND model request on
 *    writing itself a title. The title is the platform's to give.
 *  - At a usage limit OpenCode retries, and it waits as long as the
 *    provider's `retry-after` says: a Go window answers with hours, and the
 *    JSON stream prints nothing while it waits — the turn would sit silent
 *    until the stall timer killed it, and the member would read a stall. The
 *    plugin below watches the session's status, and on a retry that is a
 *    usage limit (or a wait longer than five minutes) writes one
 *    `platform_limit` line into the same stream and aborts the session, so
 *    the turn ends at once with OpenCode's own words for the limit.
 */

import { opencodeModelRef } from '../../shared/model-catalog.js';
import { quoteShellArg } from '../../utils/shell-quote.js';

/** The env var OpenCode reads its key from — Go and Zen alike (models.dev). */
export const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY';

/** Set on platform turns only: the plugin acts on nothing else (a person's own `opencode` on the machine is left alone). */
export const OPENCODE_TURN_ENV = 'AGENTBUILT_OPENCODE_TURN';

/**
 * Every turn's environment beside the key. The fleet pins OpenCode's version,
 * so it must never update itself; a language server it would download mid-turn
 * is minutes of silence; and `~/.claude/CLAUDE.md` is another harness's file,
 * which OpenCode reads unless told not to.
 */
export const OPENCODE_TURN_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
  [OPENCODE_TURN_ENV]: '1',
};

/** Where the plugin lives on the machine; OpenCode loads every file in it. */
export const OPENCODE_PLUGIN_DIR = '$HOME/.config/opencode/plugins';
export const OPENCODE_LIMIT_PLUGIN_FILE = 'agentbuilt-limit-stop.js';

export const OPENCODE_LIMIT_PLUGIN_SOURCE = `// Written by the platform before every OpenCode turn (note #780); edits are overwritten.
// At a usage limit OpenCode waits out the reset in silence, for hours. This ends
// the turn instead, with OpenCode's own words for the limit.
const LIMIT_REASONS = new Set(['account_rate_limit', 'free_tier_limit']);
const LONG_WAIT_MS = 5 * 60 * 1000;
export const AgentbuiltLimitStop = async ({ client }) => {
  const stopped = new Set();
  return {
    event: async ({ event }) => {
      if (process.env.${OPENCODE_TURN_ENV} !== '1') return;
      if (!event || event.type !== 'session.status') return;
      const props = event.properties || {};
      const status = props.status || {};
      if (status.type !== 'retry' || stopped.has(props.sessionID)) return;
      const action = status.action || {};
      const waitMs = typeof status.next === 'number' ? status.next - Date.now() : 0;
      if (!LIMIT_REASONS.has(action.reason) && waitMs < LONG_WAIT_MS) return;
      stopped.add(props.sessionID);
      try {
        process.stdout.write(JSON.stringify({
          type: 'platform_limit',
          timestamp: Date.now(),
          sessionID: props.sessionID,
          reason: action.reason || 'long_retry',
          provider: action.provider,
          message: action.message || status.message,
          retryAt: status.next,
        }) + '\\n');
      } catch {}
      try { await client.session.abort({ path: { id: props.sessionID } }); } catch {}
    },
  };
};
`;

/** One shell line that (re)writes the plugin. Best-effort: a turn without it still runs, it only waits a limit out. */
export function buildOpenCodePluginInstall(): string {
  const encoded = Buffer.from(OPENCODE_LIMIT_PLUGIN_SOURCE, 'utf8').toString('base64');
  return `{ mkdir -p "${OPENCODE_PLUGIN_DIR}" && printf '%s' '${encoded}' | base64 -d > "${OPENCODE_PLUGIN_DIR}/${OPENCODE_LIMIT_PLUGIN_FILE}"; } 2>/dev/null`;
}

export function buildOpenCodeRunCommand(args: {
  prompt: string;
  resumeSessionId?: string;
  /** A catalog value (`glm-5.3`); the Go provider is added here. */
  model?: string;
  /** OpenCode's `--variant`; empty for a model with no effort setting. */
  effort?: string;
  /** The session's title on a first turn. */
  title?: string;
  /** False for a run that is not a turn (the recap): the bare command, no plugin write in front. */
  withPlugin?: boolean;
}): string {
  const parts = [
    'opencode run',
    '--format json',
    // Approves the permissions nothing explicitly denies — the bypass mode
    // the other two harnesses run in.
    '--auto',
  ];
  if (args.model) parts.push('--model', quoteShellArg(opencodeModelRef(args.model)));
  if (args.effort) parts.push('--variant', quoteShellArg(args.effort));
  if (args.resumeSessionId) {
    parts.push('--session', quoteShellArg(args.resumeSessionId));
  } else {
    parts.push('--title', quoteShellArg(args.title?.trim() || 'Agent chat'));
  }
  parts.push('--', ...args.prompt.split(' ').map((piece) => quoteShellArg(piece)));
  return args.withPlugin === false ? parts.join(' ') : `${buildOpenCodePluginInstall()}; ${parts.join(' ')}`;
}
