import { buildClaudeRecapCommand, buildCodexRecapCommand } from './agent-recap.js';
import type { WorkspaceRecapSettings } from '../shared/workspace-recap.js';
import {
  getClaudeContextTokens,
  getClaudeModel,
  getClaudeSessionId,
  getToolUseSummaries,
  parseClaudeStreamEventLine,
} from '../agent/claude/claude-exec-events.js';
import {
  getCompletedItem,
  getStartedItemSummary,
  isAgentMessageItem,
  parseCodexExecEventLine,
} from '../agent/codex/codex-exec-events.js';
import { buildTurnEnvExports } from '../agent/harness-turn-output.js';
import { quoteShellArg } from '../utils/shell-quote.js';

/**
 * The Home briefing's summarizer run on the Workspace Agent's machine: native
 * tools are disabled, because a briefing is written from the sources in the
 * prompt and nothing else. Verified against a real CLI request by
 * verify-workspace-recap-runtime.mjs.
 * Config reference: https://developers.openai.com/codex/config-reference/
 */
export function buildWorkspaceAssistantCommand(prompt: string, settings: WorkspaceRecapSettings, claudeToken?: string): string {
  if (settings.cli === 'claude') return buildClaudeRecapCommand(prompt, claudeToken, settings).replace(' --disallowed-tools', " --tools '' --disallowed-tools");
  const controls = [
    'features.shell_tool=false', 'features.unified_exec=false', 'features.apply_patch_freeform=false',
    'features.multi_agent=false', 'features.js_repl=false', 'features.apps=false',
    'features.view_image=false', 'web_search="disabled"', 'project_doc_max_bytes=0',
  ].map(value => `-c '${value}'`).join(' ');
  return buildCodexRecapCommand(prompt, settings).replace('codex exec ', `codex exec ${controls} `);
}

/**
 * What the acting CLI's structured stream says about one turn. The reply is
 * still the only text the conversation keeps; the rest is the small amount
 * of run metadata needed to measure the Workspace Agent by the same rules as
 * a room agent.
 */
export interface WorkspaceAgentRunOutput {
  text?: string;
  /** Claude reports the last request's prompt size in the stream itself. */
  context?: { tokens: number; model?: string; window?: number };
  /** Native continuity id: the same conversation pointer a room agent keeps. */
  claudeSessionId?: string;
  /** Codex reports the honest prompt size in this thread's rollout file. */
  codexThreadId?: string;
}

/**
 * Recover the final reply and the last real prompt measurement from the
 * acting CLI's stream. Both CLIs may make several model requests in a
 * tool-using turn; the LAST request is the current context fill. Claude puts
 * it on each assistant event. Codex's stream only names the thread, so its
 * rollout is read by the service after this parser returns.
 *
 * Plain text remains a compatibility fallback for a machine running an older
 * command during a rolling deploy. Once any structured event has appeared,
 * however, an absent result is an absent reply — never JSONL shown to a user.
 */
export function parseWorkspaceAgentRunOutput(stdout: string, cli: WorkspaceRecapSettings['cli']): WorkspaceAgentRunOutput {
  let structured = false;
  let text: string | undefined;
  if (cli === 'claude') {
    let tokens: number | undefined;
    let model: string | undefined;
    let claudeSessionId: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const event = parseClaudeStreamEventLine(line);
      if (!event) continue;
      structured = true;
      claudeSessionId = getClaudeSessionId(event) ?? claudeSessionId;
      model = getClaudeModel(event) ?? model;
      tokens = getClaudeContextTokens(event) ?? tokens;
      if (
        event.type === 'result'
        && event.is_error !== true
        && typeof event.result === 'string'
        && event.result.trim()
      ) {
        text = event.result.trim();
      }
    }
    if (!structured) return stdout.trim() ? { text: stdout.trim() } : {};
    return {
      ...(text ? { text } : {}),
      ...(tokens ? { context: { tokens, ...(model ? { model } : {}) } } : {}),
      ...(claudeSessionId ? { claudeSessionId } : {}),
    };
  }

  let codexThreadId: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseCodexExecEventLine(line);
    if (!event) continue;
    structured = true;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) {
      codexThreadId = event.thread_id;
    }
    const item = getCompletedItem(event);
    if (item && isAgentMessageItem(item) && item.text.trim()) text = item.text.trim();
  }
  if (!structured) return stdout.trim() ? { text: stdout.trim() } : {};
  return { ...(text ? { text } : {}), ...(codexThreadId ? { codexThreadId } : {}) };
}

/**
 * Makes sure the CLI the turn is about to call is on the machine. The install
 * script is parked in ~/.boot.d by `writeWorkspaceAgentCredential`; a machine
 * rebuilt from the image has the boot hook but not the binary until it runs.
 */
const ENSURE_AGENTBUILT = '[ -x /usr/local/bin/agentbuilt ] || "$HOME/.boot.d/20-agentbuilt.sh" >/dev/null 2>&1 || true;';

/** The harness user's home on the machine, where the inbox and the pid file live. */
export const WORKSPACE_AGENT_HOME = '/home/agent';
/** Where a file sent with a message lands — the room agents' inbox, same layout (`~/inbox/<date>/<name>`). */
export const WORKSPACE_AGENT_INBOX = 'inbox';
/**
 * Where the running turn's process group is recorded, so Stop can end it.
 * One turn runs at a time per machine (converseWorkspaceRecap serialises
 * them), so one file is the whole registry.
 */
const TURN_PID_FILE = `${WORKSPACE_AGENT_HOME}/.workspace-agent-turn.pid`;
/**
 * Where the acting turn's structured stream is written WHILE it runs (note
 * #452), so what the agent is thinking can be read off the machine before
 * the turn ends. The summarizer keeps a temp file: nobody watches it. One
 * turn per machine at a time, so one path is the whole registry, and the
 * turn empties it as it starts so a poll never reads the previous turn.
 */
const TURN_STREAM_FILE = `${WORKSPACE_AGENT_HOME}/.workspace-agent-turn.stream`;
/** Full/delta model input is staged here so it is not bounded by Linux's one-argument ceiling. */
export const TURN_PROMPT_FILE = `${WORKSPACE_AGENT_HOME}/.workspace-agent-turn.prompt`;
/** Per-turn secrets staged mode 0600, never placed in the remote command line. */
export const TURN_ENV_FILE = `${WORKSPACE_AGENT_HOME}/.workspace-agent-turn.env`;

/**
 * The turn as an ENDABLE thing (note #423): the CLI runs in its own session
 * and process group, the group id is written where Stop can find it, and the
 * wrapper's exit status is the CLI's. A room agent's turn is a process the
 * harness can signal; this is the same idea for a one-shot `claude -p` /
 * `codex exec` behind an SSH exec that has no handle of its own.
 */
export function buildKillableTurnCommand(command: string): string {
  return `setsid bash -c ${quoteShellArg(command)} & __wa_pid=$!; echo "$__wa_pid" > ${quoteShellArg(TURN_PID_FILE)};`
    + ' wait "$__wa_pid"; __wa_status=$?;'
    + ` rm -f -- ${quoteShellArg(TURN_PID_FILE)}; exit "$__wa_status"`;
}

/**
 * What Stop (or a steer) runs on the machine: TERM to the turn's whole
 * process group, then KILL for anything still standing. Waits briefly for
 * the pid file, because the stop can land while the turn's wrapper is still
 * being started. Exits 0 when a turn was signalled and 1 when none was
 * running — which the caller reads as "the turn had already ended".
 */
export function buildKillTurnCommand(): string {
  return `for i in 1 2 3 4 5 6 7 8 9 10; do [ -s ${quoteShellArg(TURN_PID_FILE)} ] && break; sleep 0.5; done;`
    + ` __wa_pid=$(cat ${quoteShellArg(TURN_PID_FILE)} 2>/dev/null); [ -n "$__wa_pid" ] || exit 1;`
    + ' kill -TERM -- "-$__wa_pid" 2>/dev/null; for i in 1 2 3 4 5 6; do kill -0 -- "-$__wa_pid" 2>/dev/null || exit 0; sleep 0.5; done;'
    + ' kill -KILL -- "-$__wa_pid" 2>/dev/null; exit 0';
}

/**
 * A tool-using structured stream can contain every command and result from a
 * ten-minute turn. Bringing that whole file back over SSH just to keep two
 * events would make a large note read capable of truncating its own final
 * answer. Filter on the agent's machine instead: Claude keeps its last
 * assistant event and successful result; Codex keeps its thread id and last
 * completed agent message. The shared TypeScript parsers still interpret the
 * retained events on the backend.
 */
const COMPACT_AGENT_STREAM = [
  "const fs=require('fs');",
  "const [cli,file]=process.argv.slice(1);",
  "let first,last,result;",
  "for(const line of fs.readFileSync(file,'utf8').split(/\\r?\\n/)){",
  "let event;try{event=JSON.parse(line)}catch{continue}",
  "if(cli==='claude'){",
  "if(event.type==='assistant')last=event;",
  "if(event.type==='result'&&(event.subtype==='success'||event.is_error===false))result=event;",
  "}else{",
  "if(!first&&event.type==='thread.started')first=event;",
  "if(event.type==='item.completed'&&event.item?.type==='agent_message')last=event;",
  "}}",
  "for(const event of [first,last,result])if(event)process.stdout.write(JSON.stringify(event)+'\\n');",
].join('');

function compactStructuredRun(command: string, cli: WorkspaceRecapSettings['cli'], streamFile?: string, cleanupFiles: string[] = []): string {
  return [
    streamFile ? `STREAM=${quoteShellArg(streamFile)}; : >"$STREAM"; ERR=$(mktemp);` : 'STREAM=$(mktemp); ERR=$(mktemp);',
    `${command} >"$STREAM" 2>"$ERR"; STATUS=$?;`,
    `node -e ${quoteShellArg(COMPACT_AGENT_STREAM)} ${quoteShellArg(cli)} "$STREAM"; PARSE_STATUS=$?;`,
    'tail -c 2000 "$ERR" >&2;',
    `rm -f -- "$STREAM" "$ERR"${cleanupFiles.map((file) => ` ${quoteShellArg(file)}`).join('')};`,
    'if [ "$STATUS" -ne 0 ]; then exit "$STATUS"; fi;',
    'exit "$PARSE_STATUS"',
  ].join(' ');
}

/**
 * The Workspace Agent's own turn: one model run with the same machine powers
 * as a room agent. Claude bypasses interactive permission prompts and Codex
 * uses the full-access sandbox; both may read and write the durable home, run
 * arbitrary shell commands and use the machine's outbound network. Platform
 * authority still lives in the agentbuilt credential and every backend route,
 * exactly as it does for a room agent.
 *
 * The whole run is wrapped by buildKillableTurnCommand, so Stop and a steer
 * can end it from the conversation (note #423).
 *
 * Structured output stays inside the backend: it supplies the final reply
 * plus the last request's context measurement, and only the parsed reply is
 * shown in the conversation. An action that leaves a receipt (a message sent,
 * an email to decide) leaves it from the route that served it; note verbs
 * leave none (note #623).
 */
export function buildWorkspaceAgentCommand(
  prompt: string,
  settings: WorkspaceRecapSettings,
  claudeToken?: string,
  continuity?: { claudeSessionId?: string; codexThreadId?: string },
  promptFile?: string,
  env?: Record<string, string>,
  envFile?: string,
): string {
  const envExports = buildTurnEnvExports(env);
  const withEnv = (command: string) => envFile
    ? `. ${quoteShellArg(envFile)}; ${command}`
    : envExports.length ? `${envExports.join('; ')}; ${command}` : command;
  const cleanupFiles = [promptFile, envFile].filter((file): file is string => Boolean(file));
  if (settings.cli === 'claude') {
    const tokenPrefix = claudeToken ? `CLAUDE_CODE_OAUTH_TOKEN=${quoteShellArg(claudeToken)} ` : '';
    const command = `${tokenPrefix}claude -p${promptFile ? '' : ` ${quoteShellArg(prompt)}`} --output-format stream-json --verbose`
      + ` --model ${quoteShellArg(settings.model)} --effort ${quoteShellArg(settings.effort)}`
      + (continuity?.claudeSessionId ? ` --resume ${quoteShellArg(continuity.claudeSessionId)}` : '')
      + ' --permission-mode bypassPermissions'
      + (promptFile ? ` < ${quoteShellArg(promptFile)}` : ' < /dev/null');
    return buildKillableTurnCommand(`${ENSURE_AGENTBUILT} cd /home/agent && ${withEnv(compactStructuredRun(command, settings.cli, TURN_STREAM_FILE, cleanupFiles))}`);
  }
  // Keep this base byte-for-byte aligned with the room Codex harness. Machine
  // defaults supply the platform hooks and large project-doc/context limits;
  // no feature is disabled here, so new standard tools arrive without a
  // second Workspace-Agent-only allowlist drifting behind them.
  const command = 'codex exec --skip-git-repo-check --sandbox danger-full-access -C /home/agent'
    + ` --model ${quoteShellArg(settings.model)} -c ${quoteShellArg(`model_reasoning_effort=${settings.effort}`)}`
    // Parent flags precede the resume subcommand, exactly as in the room
    // harness. The CLI owns compaction when its native window fills.
    + (continuity?.codexThreadId
      ? ` --json resume ${quoteShellArg(continuity.codexThreadId)} ${promptFile ? '-' : quoteShellArg(prompt)}${promptFile ? ` < ${quoteShellArg(promptFile)}` : ' < /dev/null'}`
      : ` --json ${promptFile ? '-' : quoteShellArg(prompt)}${promptFile ? ` < ${quoteShellArg(promptFile)}` : ' < /dev/null'}`);
  return buildKillableTurnCommand(`${ENSURE_AGENTBUILT} ${withEnv(compactStructuredRun(command, settings.cli, TURN_STREAM_FILE, cleanupFiles))}`);
}

/**
 * What the agent is thinking RIGHT NOW (note #452): the newest event in the
 * running turn's stream that says so. Read on the machine by the same
 * device as the compaction above — the whole file stays there, one line
 * comes back — and interpreted by the shared parsers on the backend. Claude
 * keeps its last assistant event (a text or thinking block, or the tool
 * call it is making); Codex its last reasoning, interim message or command.
 * Prints nothing when no turn has written anything yet.
 */
const LATEST_AGENT_ACTIVITY = [
  "const fs=require('fs');",
  "const [cli,file]=process.argv.slice(1);",
  "let text='';try{text=fs.readFileSync(file,'utf8')}catch{process.exit(0)}",
  "let last;",
  "for(const line of text.split(/\\r?\\n/)){",
  "let event;try{event=JSON.parse(line)}catch{continue}",
  "if(cli==='claude'){if(event.type==='assistant')last=line;continue}",
  "const kind=event.item&&event.item.type;",
  "if(event.type==='item.started'&&kind==='command_execution')last=line;",
  "if(event.type==='item.completed'&&(kind==='reasoning'||kind==='agent_message'||kind==='command_execution'))last=line;",
  "}",
  "if(last)process.stdout.write(last);",
].join('');
export function buildTurnActivityCommand(cli: WorkspaceRecapSettings['cli']): string {
  // The first line is a progress fingerprint for stall detection; the last
  // remains the structured event readWorkspaceAgentActivity parses.
  return `stat -c '%Y:%s' ${quoteShellArg(TURN_STREAM_FILE)} 2>/dev/null || true; node -e ${quoteShellArg(LATEST_AGENT_ACTIVITY)} ${quoteShellArg(cli)} ${quoteShellArg(TURN_STREAM_FILE)}`;
}

/** How much of a thought the plate shows: a status line, not a transcript. */
export const WORKSPACE_AGENT_THOUGHT_MAX = 600;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
function clipThought(text: string): string | undefined {
  const clean = oneLine(text);
  if (!clean) return undefined;
  return clean.length > WORKSPACE_AGENT_THOUGHT_MAX ? `${clean.slice(0, WORKSPACE_AGENT_THOUGHT_MAX - 1).trimEnd()}…` : clean;
}

/**
 * The thought in the line buildTurnActivityCommand printed, or nothing. The
 * LAST block of Claude's assistant event is the current one: its narration
 * or thinking as the words, a tool call as the same summary a room agent's
 * plate shows for it. Codex's items are one thing each.
 */
export function readWorkspaceAgentActivity(stdout: string, cli: WorkspaceRecapSettings['cli']): string | undefined {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) return undefined;
  if (cli === 'claude') {
    const event = parseClaudeStreamEventLine(line);
    if (!event || event.type !== 'assistant') return undefined;
    const content = (event as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return undefined;
    for (const block of [...content].reverse()) {
      if (typeof block !== 'object' || block === null) continue;
      const typed = block as { type?: unknown; text?: unknown; thinking?: unknown };
      if (typed.type === 'tool_use') return clipThought(getToolUseSummaries(event).at(-1) ?? '');
      if (typed.type === 'text' && typeof typed.text === 'string') return clipThought(typed.text);
      if (typed.type === 'thinking' && typeof typed.thinking === 'string') return clipThought(typed.thinking);
    }
    return undefined;
  }
  const event = parseCodexExecEventLine(line);
  if (!event) return undefined;
  const started = getStartedItemSummary(event);
  if (started) return clipThought(started);
  const item = getCompletedItem(event);
  if (!item) return undefined;
  if (item.type === 'command_execution') return clipThought(typeof (item as { command?: unknown }).command === 'string' ? `$ ${(item as { command: string }).command}` : 'ran a command');
  if (item.type === 'reasoning' || item.type === 'agent_message') {
    const text = (item as { text?: unknown }).text;
    return typeof text === 'string' ? clipThought(text) : undefined;
  }
  return undefined;
}

/** How often the running turn's stream is asked what the agent is thinking. */
export const WORKSPACE_AGENT_ACTIVITY_POLL_MS = 4_000;
/** Same quiet-turn bound as both room-agent harnesses. */
export const WORKSPACE_AGENT_STALL_MS = 15 * 60_000;
/**
 * Follow the running turn from outside it (note #452): every interval, run
 * buildTurnActivityCommand on the machine and hand any NEW thought to
 * `onActivity`. Polls one at a time, never overlapping; a failed read is
 * simply the next interval's problem. `stop()` ends it, and a poll already
 * in flight reports nothing afterwards, so a thought can never land on a
 * turn that has finished. Exposed for its own test; the service runs it
 * beside the turn's exec.
 */
export function watchWorkspaceAgentActivity(args: {
  exec: (command: string) => Promise<{ stdout: string }>;
  cli: WorkspaceRecapSettings['cli'];
  onActivity: (activity: string) => Promise<void>;
  onStalled?: () => Promise<void>;
  intervalMs?: number;
  stallMs?: number;
}): { stop: () => void } {
  const interval = args.intervalMs ?? WORKSPACE_AGENT_ACTIVITY_POLL_MS;
  const stallMs = args.stallMs ?? WORKSPACE_AGENT_STALL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: string | undefined;
  let lastProbe: string | undefined;
  let lastProgressAt = Date.now();
  const tick = async () => {
    if (stopped) return;
    try {
      const { stdout } = await args.exec(buildTurnActivityCommand(args.cli));
      if (stdout && stdout !== lastProbe) {
        lastProbe = stdout;
        lastProgressAt = Date.now();
      }
      const activity = readWorkspaceAgentActivity(stdout, args.cli);
      if (!stopped && activity && activity !== last) { last = activity; await args.onActivity(activity); }
    } catch { /* the next interval reads again */ }
    if (!stopped && args.onStalled && Date.now() - lastProgressAt >= stallMs) {
      stopped = true;
      await args.onStalled();
      return;
    }
    if (!stopped) { timer = setTimeout(() => { void tick(); }, interval); timer.unref?.(); }
  };
  timer = setTimeout(() => { void tick(); }, interval); timer.unref?.();
  return { stop: () => { stopped = true; clearTimeout(timer); } };
}
