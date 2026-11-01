import { createHash, randomUUID } from 'node:crypto';
import { posix as pathPosix } from 'node:path';
import ssh2, {
  type Client as Ssh2Client,
  type ClientChannel,
  type ConnectConfig,
  type SFTPWrapper,
} from 'ssh2';
import { quoteShellArg } from '../utils/shell-quote.js';
import type {
  TerminalSessionChangedRow,
  TerminalSessionInputEvent,
  TerminalSessionResult,
  TerminalSessionScreen,
  TerminalSessionSnapshotOptions,
  TerminalSessionStartOptions as TerminalSessionStartSnapshotOptions,
} from './sandbox-types.js';
/** Remote OS an SSH command targets. Managed cloud servers are Linux; the
 * other shapes remain for hosts reached by explicit host/user parameters. */
type RemoteMachineOs = 'linux' | 'macos' | 'windows';

const { Client } = ssh2;

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_INITIAL_READ_DELAY_MS = 150;
const DEFAULT_INPUT_READ_TIMEOUT_MS = 1_500;
const DEFAULT_TMUX_CLEANUP_TIMEOUT_MS = 1_500;
const TMUX_DEAD_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const TMUX_STALE_AUTO_CLEANUP_MS = 30 * 60 * 1000;
// How long a preserved tmux session (an OAuth sign-in waiting on the user)
// keeps its host counted as active for the idle reaper. Long enough for a slow
// sign-in; bounded so an abandoned one can't hold a machine hot forever.
const PRESERVED_TMUX_HOT_MS = 45 * 60 * 1000;
const INPUT_READ_POLL_INTERVAL_MS = 25;
const TERMINAL_SESSION_COLUMNS = 240;
const DEFAULT_TERMINAL_COLS = TERMINAL_SESSION_COLUMNS;
const DEFAULT_TERMINAL_ROWS = 30;
const DEFAULT_REPAINT_TIMEOUT_MS = 5_000;
const DEFAULT_TMUX_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_INPUT_EVENT_DELAY_MS = 50;
const TMUX_INPUT_COMMAND_DELAY_SECONDS = (DEFAULT_INPUT_EVENT_DELAY_MS / 1000).toFixed(2);
const TMUX_LITERAL_INPUT_CHUNK_CHARS = 512;
const MAX_OUTPUT_CHARS = 120_000;
const MAX_OUTPUT_LINES = 400;
const MAX_TERMINAL_RESPONSE_TAIL_CHARS = 32;
const TMUX_SNAPSHOT_SCROLLBACK_LINES = 2_000;
const TMUX_READ_TIMEOUT_WARNING = 'tmux read timed out; returning the last captured snapshot. The remote host may be overloaded.';
const TMUX_EXISTING_SESSION_MARKER_PREFIX = '__IA_TMUX_EXISTING_SESSION=';
const TMUX_CREATED_SESSION_MARKER_PREFIX = '__IA_TMUX_CREATED_SESSION=';
const CURSOR_POSITION_REQUEST_PATTERN = /\x1b\[(?:\?)?6n/g;
const CODING_AGENT_CLOSE_INTERRUPT_DELAY_MS = 150;

const KEY_BYTES: Record<string, string> = {
  enter: '\r',
  return: '\r',
  'shift+enter': '\x1b[13;2u',
  'shift-enter': '\x1b[13;2u',
  shift_enter: '\x1b[13;2u',
  tab: '\t',
  backspace: '\x7f',
  escape: '\x1b',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  delete: '\x1b[3~',
  del: '\x1b[3~',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  insert: '\x1b[2~',
};

const TMUX_KEY_NAMES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  backspace: 'BSpace',
  escape: 'Escape',
  esc: 'Escape',
  up: 'Up',
  down: 'Down',
  right: 'Right',
  left: 'Left',
  delete: 'DC',
  del: 'DC',
  home: 'Home',
  end: 'End',
  pageup: 'PPage',
  pagedown: 'NPage',
  insert: 'IC',
};

export interface SshExecConnectionConfig {
  host: string;
  port?: number;
  username: string;
  privateKey: string | Buffer;
  passphrase?: string;
  readyTimeoutMs?: number;
  expectedHostKey?: string;
  os?: RemoteMachineOs;
}

export interface SshTerminalSessionStartOptions extends TerminalSessionStartSnapshotOptions {
  cwd?: string;
  command?: string;
  cols?: number;
  rows?: number;
  initialReadDelayMs?: number;
  autoCleanup?: boolean;
  ownerTag?: string;
}

export interface SshExecOptions {
  timeoutMs?: number;
}

export interface SshUploadFile {
  path: string;
  content: Buffer | Uint8Array | ArrayBuffer;
  mode?: number;
}

interface TmuxSnapshotState {
  revision: number;
  lastRows?: string[];
  lastScrollbackRows?: string[];
  lastActivityMs?: number;
  lastActivityAt?: number;
  stableSinceMs?: number;
  rows?: number;
  cols?: number;
  lastResult?: TerminalSessionResult;
}

interface TerminalRendererState {
  cols: number;
  rows: number;
  altBuffer: boolean;
  cursorRow: number;
  cursorCol: number;
  savedCursorRow: number;
  savedCursorCol: number;
  scrollTop: number;
  scrollBottom: number;
  buffer: string[][];
  pendingInput: string;
}

interface ManagedSshSession {
  sessionId: string;
  conn: Ssh2Client;
  channel: ClientChannel;
  host: string;
  port: number;
  username: string;
  cols: number;
  rows: number;
  revision: number;
  status: TerminalSessionResult['status'];
  exitCode: number | null;
  signal?: string;
  forced?: boolean;
  rawOutput: string;
  renderer: TerminalRendererState;
  lastActivityAt: number;
  lastOutputAt: number;
  outputRevision: number;
  lastDeliveredRows?: string[];
  lastDeliveredRawLength: number;
  terminalResponseTail: string;
  externalCodingAgent: boolean;
}

function stripInternalTmuxStartMarkers(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => (
      !line.startsWith(TMUX_EXISTING_SESSION_MARKER_PREFIX)
      && !line.startsWith(TMUX_CREATED_SESSION_MARKER_PREFIX)
    ))
    .join('\n')
    .trim();
}

function tmuxStartOutputHasMarker(output: string, prefix: string, value: string): boolean {
  return output
    .split(/\r?\n/)
    .some((line) => line.trim() === `${prefix}${value}`);
}

function tmuxStartOutputReportsCreated(output: string): boolean {
  return tmuxStartOutputHasMarker(output, TMUX_CREATED_SESSION_MARKER_PREFIX, '1')
    || tmuxStartOutputHasMarker(output, TMUX_EXISTING_SESSION_MARKER_PREFIX, '0');
}

function tmuxStartOutputReportsExisting(output: string): boolean {
  return tmuxStartOutputHasMarker(output, TMUX_EXISTING_SESSION_MARKER_PREFIX, '1');
}

class TmuxCommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;

  constructor(
    message: string,
    result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean },
  ) {
    super(message);
    this.name = 'TmuxCommandError';
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
    this.timedOut = result.timedOut;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createBlankBuffer(rows: number, cols: number): string[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '));
}

function createTerminalRenderer(rows: number, cols: number): TerminalRendererState {
  const normalizedRows = normalizeTerminalDimension(rows, DEFAULT_TERMINAL_ROWS);
  const normalizedCols = normalizeTerminalDimension(cols, DEFAULT_TERMINAL_COLS);
  return {
    cols: normalizedCols,
    rows: normalizedRows,
    altBuffer: false,
    cursorRow: 0,
    cursorCol: 0,
    savedCursorRow: 0,
    savedCursorCol: 0,
    scrollTop: 0,
    scrollBottom: normalizedRows - 1,
    buffer: createBlankBuffer(normalizedRows, normalizedCols),
    pendingInput: '',
  };
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getCsiParams(sequence: string): { privatePrefix: string; values: number[] } {
  const privatePrefixMatch = sequence.match(/^[?=>!]*/);
  const privatePrefix = privatePrefixMatch?.[0] ?? '';
  const body = sequence.slice(privatePrefix.length);
  const values = body
    .split(/[;:]/)
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  return {
    privatePrefix,
    values,
  };
}

function getCsiValue(values: number[], index: number, fallback: number): number {
  const value = values[index];
  return value && value > 0 ? value : fallback;
}

function setCursorPosition(renderer: TerminalRendererState, row: number, col: number): void {
  renderer.cursorRow = clampValue(row, 0, renderer.rows - 1);
  renderer.cursorCol = clampValue(col, 0, renderer.cols - 1);
}

function clearRow(renderer: TerminalRendererState, row: number): void {
  renderer.buffer[row] = Array.from({ length: renderer.cols }, () => ' ');
}

function clearScreen(renderer: TerminalRendererState): void {
  renderer.buffer = createBlankBuffer(renderer.rows, renderer.cols);
  setCursorPosition(renderer, 0, 0);
}

function scrollUp(renderer: TerminalRendererState, count: number = 1): void {
  const amount = Math.max(1, count);
  for (let i = 0; i < amount; i += 1) {
    renderer.buffer.splice(renderer.scrollTop, 1);
    renderer.buffer.splice(renderer.scrollBottom, 0, Array.from({ length: renderer.cols }, () => ' '));
  }
}

function scrollDown(renderer: TerminalRendererState, count: number = 1): void {
  const amount = Math.max(1, count);
  for (let i = 0; i < amount; i += 1) {
    renderer.buffer.splice(renderer.scrollBottom, 1);
    renderer.buffer.splice(renderer.scrollTop, 0, Array.from({ length: renderer.cols }, () => ' '));
  }
}

function lineFeed(renderer: TerminalRendererState): void {
  if (renderer.cursorRow === renderer.scrollBottom) {
    scrollUp(renderer);
    return;
  }
  renderer.cursorRow = clampValue(renderer.cursorRow + 1, 0, renderer.rows - 1);
}

function reverseLineFeed(renderer: TerminalRendererState): void {
  if (renderer.cursorRow === renderer.scrollTop) {
    scrollDown(renderer);
    return;
  }
  renderer.cursorRow = clampValue(renderer.cursorRow - 1, 0, renderer.rows - 1);
}

function eraseDisplay(renderer: TerminalRendererState, mode: number): void {
  if (mode === 2 || mode === 3) {
    clearScreen(renderer);
    return;
  }

  if (mode === 1) {
    for (let row = 0; row < renderer.cursorRow; row += 1) {
      clearRow(renderer, row);
    }
    renderer.buffer[renderer.cursorRow].fill(' ', 0, renderer.cursorCol + 1);
    return;
  }

  renderer.buffer[renderer.cursorRow].fill(' ', renderer.cursorCol);
  for (let row = renderer.cursorRow + 1; row < renderer.rows; row += 1) {
    clearRow(renderer, row);
  }
}

function eraseLine(renderer: TerminalRendererState, mode: number): void {
  if (mode === 2) {
    clearRow(renderer, renderer.cursorRow);
    return;
  }

  if (mode === 1) {
    renderer.buffer[renderer.cursorRow].fill(' ', 0, renderer.cursorCol + 1);
    return;
  }

  renderer.buffer[renderer.cursorRow].fill(' ', renderer.cursorCol);
}

function insertLines(renderer: TerminalRendererState, count: number): void {
  const amount = Math.max(1, count);
  const end = renderer.scrollBottom;
  for (let i = 0; i < amount; i += 1) {
    renderer.buffer.splice(renderer.cursorRow, 0, Array.from({ length: renderer.cols }, () => ' '));
    renderer.buffer.splice(end + 1, 1);
  }
}

function deleteLines(renderer: TerminalRendererState, count: number): void {
  const amount = Math.max(1, count);
  const end = renderer.scrollBottom;
  for (let i = 0; i < amount; i += 1) {
    renderer.buffer.splice(renderer.cursorRow, 1);
    renderer.buffer.splice(end, 0, Array.from({ length: renderer.cols }, () => ' '));
  }
}

function insertBlankChars(renderer: TerminalRendererState, count: number): void {
  const row = renderer.buffer[renderer.cursorRow];
  const amount = Math.max(1, count);
  row.splice(renderer.cursorCol, 0, ...Array.from({ length: amount }, () => ' '));
  row.length = renderer.cols;
}

function deleteChars(renderer: TerminalRendererState, count: number): void {
  const row = renderer.buffer[renderer.cursorRow];
  const amount = Math.max(1, count);
  row.splice(renderer.cursorCol, amount);
  while (row.length < renderer.cols) {
    row.push(' ');
  }
}

function writePrintable(renderer: TerminalRendererState, char: string): void {
  renderer.buffer[renderer.cursorRow][renderer.cursorCol] = char;
  renderer.cursorCol += 1;
  if (renderer.cursorCol >= renderer.cols) {
    renderer.cursorCol = 0;
    lineFeed(renderer);
  }
}

function handleCsi(renderer: TerminalRendererState, paramsText: string, finalByte: string): void {
  const { privatePrefix, values } = getCsiParams(paramsText);
  const count = getCsiValue(values, 0, 1);

  switch (finalByte) {
    case 'A':
      setCursorPosition(renderer, renderer.cursorRow - count, renderer.cursorCol);
      break;
    case 'B':
      setCursorPosition(renderer, renderer.cursorRow + count, renderer.cursorCol);
      break;
    case 'C':
      setCursorPosition(renderer, renderer.cursorRow, renderer.cursorCol + count);
      break;
    case 'D':
      setCursorPosition(renderer, renderer.cursorRow, renderer.cursorCol - count);
      break;
    case 'E':
      setCursorPosition(renderer, renderer.cursorRow + count, 0);
      break;
    case 'F':
      setCursorPosition(renderer, renderer.cursorRow - count, 0);
      break;
    case 'G':
      setCursorPosition(renderer, renderer.cursorRow, count - 1);
      break;
    case 'H':
    case 'f':
      setCursorPosition(
        renderer,
        getCsiValue(values, 0, 1) - 1,
        getCsiValue(values, 1, 1) - 1,
      );
      break;
    case 'J':
      eraseDisplay(renderer, values[0] ?? 0);
      break;
    case 'K':
      eraseLine(renderer, values[0] ?? 0);
      break;
    case 'L':
      insertLines(renderer, count);
      break;
    case 'M':
      deleteLines(renderer, count);
      break;
    case '@':
      insertBlankChars(renderer, count);
      break;
    case 'P':
      deleteChars(renderer, count);
      break;
    case 'X':
      renderer.buffer[renderer.cursorRow].fill(
        ' ',
        renderer.cursorCol,
        Math.min(renderer.cols, renderer.cursorCol + count),
      );
      break;
    case 'S':
      scrollUp(renderer, count);
      break;
    case 'T':
      scrollDown(renderer, count);
      break;
    case 'd':
      setCursorPosition(renderer, count - 1, renderer.cursorCol);
      break;
    case 'r': {
      const top = getCsiValue(values, 0, 1) - 1;
      const bottom = getCsiValue(values, 1, renderer.rows) - 1;
      renderer.scrollTop = clampValue(top, 0, renderer.rows - 1);
      renderer.scrollBottom = clampValue(bottom, renderer.scrollTop, renderer.rows - 1);
      setCursorPosition(renderer, 0, 0);
      break;
    }
    case 's':
      renderer.savedCursorRow = renderer.cursorRow;
      renderer.savedCursorCol = renderer.cursorCol;
      break;
    case 'u':
      setCursorPosition(renderer, renderer.savedCursorRow, renderer.savedCursorCol);
      break;
    case 'h':
      if (privatePrefix.includes('?') && values.some((value) => value === 47 || value === 1047 || value === 1049)) {
        renderer.altBuffer = true;
        renderer.scrollTop = 0;
        renderer.scrollBottom = renderer.rows - 1;
        clearScreen(renderer);
      }
      break;
    case 'l':
      if (privatePrefix.includes('?') && values.some((value) => value === 47 || value === 1047 || value === 1049)) {
        renderer.altBuffer = false;
        renderer.scrollTop = 0;
        renderer.scrollBottom = renderer.rows - 1;
        clearScreen(renderer);
      }
      break;
    default:
      break;
  }
}

function findStringTerminator(input: string, startIndex: number): { endIndex: number; terminatorLength: number } | null {
  for (let index = startIndex; index < input.length; index += 1) {
    if (input[index] === '\x07') {
      return { endIndex: index, terminatorLength: 1 };
    }
    if (input[index] === '\x1b' && input[index + 1] === '\\') {
      return { endIndex: index, terminatorLength: 2 };
    }
  }
  return null;
}

function writeTerminalRenderer(renderer: TerminalRendererState, chunk: string): void {
  const input = `${renderer.pendingInput}${chunk}`;
  renderer.pendingInput = '';

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (char === '\x1b') {
      if (index + 1 >= input.length) {
        renderer.pendingInput = input.slice(index);
        break;
      }

      const next = input[index + 1];
      if (next === '[') {
        let endIndex = index + 2;
        while (endIndex < input.length) {
          const code = input.charCodeAt(endIndex);
          if (code >= 0x40 && code <= 0x7e) {
            break;
          }
          endIndex += 1;
        }

        if (endIndex >= input.length) {
          renderer.pendingInput = input.slice(index);
          break;
        }

        handleCsi(renderer, input.slice(index + 2, endIndex), input[endIndex]);
        index = endIndex;
        continue;
      }

      if (next === ']' || next === 'P' || next === '^' || next === '_') {
        const terminator = findStringTerminator(input, index + 2);
        if (!terminator) {
          renderer.pendingInput = input.slice(index);
          break;
        }
        index = terminator.endIndex + terminator.terminatorLength - 1;
        continue;
      }

      if (next === '7') {
        renderer.savedCursorRow = renderer.cursorRow;
        renderer.savedCursorCol = renderer.cursorCol;
        index += 1;
        continue;
      }
      if (next === '8') {
        setCursorPosition(renderer, renderer.savedCursorRow, renderer.savedCursorCol);
        index += 1;
        continue;
      }
      if (next === 'c') {
        clearScreen(renderer);
        renderer.altBuffer = false;
        renderer.scrollTop = 0;
        renderer.scrollBottom = renderer.rows - 1;
        index += 1;
        continue;
      }
      if (next === 'D') {
        lineFeed(renderer);
        index += 1;
        continue;
      }
      if (next === 'M') {
        reverseLineFeed(renderer);
        index += 1;
        continue;
      }
      if (next === 'E') {
        lineFeed(renderer);
        renderer.cursorCol = 0;
        index += 1;
        continue;
      }
      if (next === '(' || next === ')' || next === '*' || next === '+') {
        if (index + 2 >= input.length) {
          renderer.pendingInput = input.slice(index);
          break;
        }
        index += 2;
        continue;
      }

      index += 1;
      continue;
    }

    if (char === '\n' || char === '\x0b' || char === '\x0c') {
      lineFeed(renderer);
      continue;
    }
    if (char === '\r') {
      renderer.cursorCol = 0;
      continue;
    }
    if (char === '\b') {
      renderer.cursorCol = Math.max(0, renderer.cursorCol - 1);
      continue;
    }
    if (char === '\t') {
      setCursorPosition(renderer, renderer.cursorRow, Math.min(renderer.cols - 1, renderer.cursorCol + (8 - (renderer.cursorCol % 8))));
      continue;
    }
    if (char < ' ' || char === '\x7f') {
      continue;
    }

    writePrintable(renderer, char);
  }
}

function getRenderedOutput(renderer: TerminalRendererState): string[] {
  return renderer.buffer.map((row) => row.join('').replace(/\s+$/u, ''));
}

function getChangedRows(previousRows: string[] | undefined, rows: string[]): TerminalSessionChangedRow[] {
  return rows
    .map((text, index) => ({ row: index + 1, text }))
    .filter((row) => row.text !== (previousRows?.[row.row - 1] ?? ''));
}

function getScrollbackDeltaRows(
  previousRows: string[] | undefined,
  rows: string[],
): TerminalSessionChangedRow[] | undefined {
  if (!previousRows) {
    return undefined;
  }

  if (rowsEqual(previousRows, rows)) {
    return [];
  }

  const previousIsPrefix = previousRows.length <= rows.length
    && previousRows.every((line, index) => rows[index] === line);
  if (previousIsPrefix) {
    return rows.slice(previousRows.length).map((text, index) => ({
      row: previousRows.length + index + 1,
      text,
    }));
  }

  const maxOverlap = Math.min(previousRows.length, rows.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const previousTailStart = previousRows.length - overlap;
    const tailMatches = previousRows.slice(previousTailStart).every((line, index) => rows[index] === line);
    if (tailMatches) {
      return rows.slice(overlap).map((text, index) => ({
        row: overlap + index + 1,
        text,
      }));
    }
  }

  return getChangedRows(previousRows, rows);
}

export function renderTerminalOutputForSnapshot(
  rawOutput: string,
  options: {
    rows?: number;
    cols?: number;
  } = {},
): TerminalSessionScreen {
  const renderer = createTerminalRenderer(
    options.rows ?? DEFAULT_TERMINAL_ROWS,
    options.cols ?? DEFAULT_TERMINAL_COLS,
  );
  writeTerminalRenderer(renderer, rawOutput);
  return {
    cols: renderer.cols,
    rows: renderer.rows,
    altBuffer: renderer.altBuffer,
    cursor: {
      row: renderer.cursorRow + 1,
      col: renderer.cursorCol + 1,
    },
    output: getRenderedOutput(renderer),
  };
}

function encodeCtrlKey(key: string): string {
  const normalized = key.trim().toUpperCase();
  if (!/^[A-Z]$/.test(normalized)) {
    throw new Error(`Unsupported ctrl key: ${key}`);
  }

  return String.fromCharCode(normalized.charCodeAt(0) - 64);
}

function startsExternalCodingAgentCli(command: string | undefined): boolean {
  if (typeof command !== 'string') {
    return false;
  }

  return /(^|[\n;&|]\s*)(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:command\s+)?(?:npx\s+)?(?:codex|claude|opencode)(?:\s|$)/.test(command.trim());
}

function inputEventsStartExternalCodingAgent(events: TerminalSessionInputEvent[]): boolean {
  const commandText = events
    .map((event) => {
      if (event.type === 'text') {
        return event.text;
      }
      if (event.type === 'raw') {
        return event.data;
      }
      if (event.type === 'key' && ['enter', 'return'].includes(event.key.trim().toLowerCase())) {
        return '\n';
      }
      return '';
    })
    .join('');

  return startsExternalCodingAgentCli(commandText);
}

function terminalOutputLooksLikeExternalCodingAgent(output: string[] | undefined): boolean {
  const text = (output ?? []).join('\n');
  return /\b(?:codex|claude)(?:\s+code)?\b/i.test(text);
}

function eventToBytes(event: TerminalSessionInputEvent): string {
  switch (event.type) {
    case 'text':
      return event.multiline ? event.text.replace(/\n/g, KEY_BYTES['shift+enter']) : event.text;
    case 'raw':
      return event.data;
    case 'key': {
      const mapped = KEY_BYTES[event.key.trim().toLowerCase()];
      if (!mapped) {
        throw new Error(`Unsupported key event: ${event.key}`);
      }
      return mapped;
    }
    case 'ctrl':
      return encodeCtrlKey(event.key);
    default:
      return '';
  }
}

function getLastNonEmptyLine(lines: string[] | undefined): string {
  if (!Array.isArray(lines)) {
    return '';
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trimEnd();
    if (line?.trim()) {
      return line;
    }
  }
  return '';
}

function hasTerminalBusyIndicator(output: string[] | undefined): boolean {
  const lines = output ?? [];
  const text = lines.join('\n');

  return lines.some((line) => {
    const trimmed = line.trim();
    return /(?:[\u2022\u273d\u2736\u273b\u2722\u25cf\u25cb\u25d0-\u25d3\u2800-\u28ff]\s*)?(?:working|thinking|processing|running|executing|editing|applying|searching|reading|writing|building|compiling|testing)\s*(?:\(|\.{3}|\u2026|$)/i.test(trimmed)
      || /\b\d+\s+background terminals?\s+(?:running|active)\b/i.test(trimmed)
      || /\bbackground terminals?:?.*\b(?:running|active)\b/i.test(trimmed)
      || /\b(?:esc|escape)\s+to\s+(?:interrupt|cancel)\b/i.test(trimmed)
      || /(?:\[[=\-#\u2588\u2593\u2592\u2591> ]{3,}\]|\b(?:[1-9]?\d)%\b).*\b(?:building|compiling|installing|downloading|testing|running|processing)?/i.test(trimmed);
  }) || /\b(?:working|thinking|processing|running)\s*\(\d+m?(?:\s*\d+s?)?\)/i.test(text);
}

function inferTerminalProcessState(
  status: TerminalSessionResult['status'],
  output: string[] | undefined,
  lastOutputAt: number,
  now = Date.now(),
): NonNullable<TerminalSessionResult['processState']> {
  if (status !== 'running') {
    return 'exited';
  }

  const text = (output ?? []).join('\n');
  const lowerText = text.toLowerCase();
  const lastLine = getLastNonEmptyLine(output);
  const quietForMs = lastOutputAt > 0 ? now - lastOutputAt : Number.POSITIVE_INFINITY;
  if (hasTerminalBusyIndicator(output)) {
    return 'running';
  }

  const looksLikePrompt = /(?:^|\s)(?:[$#>]\s*|\u276f\s*)$/.test(lastLine)
    || /[~\w./:@-][$#>]\s*$/.test(lastLine)
    || /(?:continue|confirm|proceed|password|passphrase|one-time code|device code).{0,80}[:?]\s*$/i.test(lastLine)
    || lowerText.includes('press enter')
    || lowerText.includes('press any key')
    || lowerText.includes('what can i help')
    || lowerText.includes('ask codex')
    || lowerText.includes('describe a task')
    || lowerText.includes('\u2570\u2500');

  return looksLikePrompt && quietForMs >= 250 ? 'waiting_for_input' : 'running';
}

function normalizeOutput(rawOutput: string): string[] {
  const normalized = rawOutput
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  return lines.length > MAX_OUTPUT_LINES
    ? lines.slice(-MAX_OUTPUT_LINES)
    : lines;
}

function normalizeTmuxCaptureOutput(rawOutput: string): string[] {
  return rawOutput
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
}

function normalizeTerminalDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

function rowsEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((line, index) => line === right[index]);
}

function buildCursorPositionResponse(rows: number, cols: number): string {
  const row = normalizeTerminalDimension(rows, DEFAULT_TERMINAL_ROWS);
  const col = normalizeTerminalDimension(cols, DEFAULT_TERMINAL_COLS);
  return `\x1b[${row};${col}R`;
}

export function collectTerminalDeviceResponseBytes(
  chunk: string,
  previousTail: string,
  rows: number,
  cols: number,
): { responseBytes: string; nextTail: string } {
  const combined = `${previousTail}${chunk}`;
  const previousTailLength = previousTail.length;
  const responses: string[] = [];

  for (const match of combined.matchAll(CURSOR_POSITION_REQUEST_PATTERN)) {
    const matchEnd = (match.index ?? 0) + match[0].length;
    if (matchEnd > previousTailLength) {
      responses.push(buildCursorPositionResponse(rows, cols));
    }
  }

  return {
    responseBytes: responses.join(''),
    nextTail: combined.slice(-MAX_TERMINAL_RESPONSE_TAIL_CHARS),
  };
}

function buildSnapshot(
  session: ManagedSshSession,
  options: TerminalSessionSnapshotOptions = {},
): TerminalSessionResult {
  const outputMode = options.outputMode ?? 'screen';
  const readMode = options.readMode ?? 'delta';
  const isDelta = readMode === 'delta';
  let output: string[];
  let changedRows: TerminalSessionChangedRow[] | undefined;

  if (outputMode === 'raw') {
    const rawOutput = isDelta
      ? session.rawOutput.slice(session.lastDeliveredRawLength)
      : session.rawOutput;
    output = normalizeOutput(rawOutput);
    session.lastDeliveredRawLength = session.rawOutput.length;
  } else {
    const renderedRows = getRenderedOutput(session.renderer);
    if (isDelta) {
      changedRows = getChangedRows(session.lastDeliveredRows, renderedRows);
    }
    output = renderedRows;
    session.lastDeliveredRows = renderedRows;
    session.lastDeliveredRawLength = session.rawOutput.length;
  }

  const now = Date.now();
  const stableForMs = Math.max(0, now - (session.lastOutputAt || session.lastActivityAt));
  const processState = inferTerminalProcessState(session.status, output, session.lastOutputAt, now);
  return {
    sessionId: session.sessionId,
    revision: session.revision,
    status: session.status,
    processState,
    stableForMs,
    exitCode: session.exitCode,
    lastActivityMs: Math.max(0, now - session.lastActivityAt),
    forced: session.forced,
    signal: session.signal,
    screen: {
      cols: session.cols,
      rows: session.rows,
      altBuffer: session.renderer.altBuffer,
      cursor: {
        row: session.renderer.cursorRow + 1,
        col: session.renderer.cursorCol + 1,
      },
      output,
      changedRows,
    },
  };
}

function appendOutput(session: ManagedSshSession, chunk: Buffer | string): void {
  const chunkText = chunk.toString();
  const terminalResponses = collectTerminalDeviceResponseBytes(
    chunkText,
    session.terminalResponseTail,
    session.rows,
    session.cols,
  );
  session.terminalResponseTail = terminalResponses.nextTail;

  if (terminalResponses.responseBytes) {
    try {
      session.channel.write(terminalResponses.responseBytes);
    } catch {
      // Best-effort terminal device response.
    }
  }

  session.rawOutput += chunkText;
  writeTerminalRenderer(session.renderer, chunkText);
  if (session.rawOutput.length > MAX_OUTPUT_CHARS) {
    session.rawOutput = session.rawOutput.slice(-MAX_OUTPUT_CHARS);
    session.lastDeliveredRawLength = Math.min(session.lastDeliveredRawLength, session.rawOutput.length);
  }
  const now = Date.now();
  session.lastActivityAt = now;
  session.lastOutputAt = now;
  session.outputRevision += 1;
  session.revision += 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFingerprint(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function formatMd5Fingerprint(key: Buffer): string {
  return createHash('md5')
    .update(key)
    .digest('hex')
    .match(/.{1,2}/g)!
    .join(':');
}

function buildHostKeyFingerprintCandidates(key: Buffer): Set<string> {
  const sha256Base64 = createHash('sha256')
    .update(key)
    .digest('base64')
    .replace(/=+$/g, '');
  const sha256Hex = createHash('sha256').update(key).digest('hex');
  const md5Hex = createHash('md5').update(key).digest('hex');
  const md5Colon = formatMd5Fingerprint(key);

  return new Set([
    normalizeFingerprint(`SHA256:${sha256Base64}`),
    normalizeFingerprint(sha256Base64),
    normalizeFingerprint(`SHA256:${sha256Hex}`),
    normalizeFingerprint(sha256Hex),
    normalizeFingerprint(`MD5:${md5Colon}`),
    normalizeFingerprint(md5Colon),
    normalizeFingerprint(`MD5:${md5Hex}`),
    normalizeFingerprint(md5Hex),
  ]);
}

function createHostKeyVerifier(connection: SshExecConnectionConfig): {
  hostVerifier?: NonNullable<ConnectConfig['hostVerifier']>;
  getError: () => Error | undefined;
} {
  const expectedHostKey = typeof connection.expectedHostKey === 'string'
    ? connection.expectedHostKey.trim()
    : '';
  if (!expectedHostKey) {
    return { getError: () => undefined };
  }

  const expected = normalizeFingerprint(expectedHostKey);
  let verificationError: Error | undefined;
  return {
    hostVerifier: (key: Buffer): boolean => {
      if (buildHostKeyFingerprintCandidates(key).has(expected)) {
        return true;
      }

      verificationError = new Error(
        `SSH host key verification failed for ${connection.host}:${connection.port ?? 22}. Expected ${expectedHostKey}; the server presented a different host key.`,
      );
      return false;
    },
    getError: () => verificationError,
  };
}

function buildSshConnectConfig(
  connection: SshExecConnectionConfig,
  port: number,
  hostKeyVerifier: ReturnType<typeof createHostKeyVerifier>,
): ConnectConfig {
  return {
    host: connection.host,
    port,
    username: connection.username,
    privateKey: connection.privateKey,
    passphrase: connection.passphrase,
    readyTimeout: connection.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    ...(hostKeyVerifier.hostVerifier ? { hostVerifier: hostKeyVerifier.hostVerifier } : {}),
  };
}

async function waitForSessionRevisionAfter(
  session: ManagedSshSession,
  revision: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (session.status === 'running' && session.revision <= revision) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return;
    }

    await sleep(Math.min(INPUT_READ_POLL_INTERVAL_MS, remainingMs));
  }
}

async function waitForSessionQuiet(
  session: ManagedSshSession,
  options: TerminalSessionSnapshotOptions,
  outputRevisionToPass?: number,
): Promise<void> {
  const quietForMs = options.quietForMs;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPAINT_TIMEOUT_MS;
  if (typeof quietForMs !== 'number' || quietForMs <= 0 || timeoutMs <= 0) {
    return;
  }

  const deadline = Date.now() + timeoutMs;

  if (outputRevisionToPass !== undefined) {
    while (session.status === 'running' && session.outputRevision <= outputRevisionToPass) {
      const remainingTimeout = deadline - Date.now();
      if (remainingTimeout <= 0) {
        return;
      }

      await sleep(Math.min(INPUT_READ_POLL_INTERVAL_MS, remainingTimeout));
    }
  }

  while (session.status === 'running') {
    const now = Date.now();
    const lastTerminalOutputAt = session.lastOutputAt || session.lastActivityAt;
    const quietElapsed = now - lastTerminalOutputAt;
    if (quietElapsed >= quietForMs) {
      return;
    }

    const remainingTimeout = deadline - now;
    if (remainingTimeout <= 0) {
      return;
    }

    await sleep(Math.min(INPUT_READ_POLL_INTERVAL_MS, quietForMs - quietElapsed, remainingTimeout));
  }
}

function normalizeSnapshotOptions(options: TerminalSessionSnapshotOptions = {}): TerminalSessionSnapshotOptions {
  return {
    outputMode: options.outputMode === 'raw' ? 'raw' : 'screen',
    readMode: options.readMode === 'full' ? 'full' : 'delta',
    quietForMs: typeof options.quietForMs === 'number'
      ? Math.max(0, Math.floor(options.quietForMs))
      : undefined,
    timeoutMs: typeof options.timeoutMs === 'number'
      ? Math.max(0, Math.floor(options.timeoutMs))
      : undefined,
    waitForChange: options.waitForChange === true,
  };
}

function getTmuxCommandTimeoutMs(options: TerminalSessionSnapshotOptions = {}): number {
  const requestedTimeoutMs = typeof options.timeoutMs === 'number'
    ? Math.max(0, Math.floor(options.timeoutMs))
    : 0;
  return Math.max(requestedTimeoutMs, DEFAULT_TMUX_COMMAND_TIMEOUT_MS);
}

function getTmuxSnapshotCaptureStart(): string {
  return `-${TMUX_SNAPSHOT_SCROLLBACK_LINES}`;
}

function isTmuxCommandTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === 'tmux command timed out.';
}

function buildTmuxRuntimeSetupScript(): string {
  return [
    '__ia_tmux_bin="$(command -v tmux 2>/dev/null || true)"',
    'if [ -z "$__ia_tmux_bin" ]; then',
    '  echo "tmux is required for durable remote terminal sessions. Install tmux on this server and retry." >&2',
    '  exit 127',
    'fi',
    '__ia_tmux_uid="$(id -u 2>/dev/null || printf unknown)"',
    '__ia_tmux_base="${TMUX_TMPDIR:-/tmp}"',
    '__ia_tmux_default_dir="${__ia_tmux_base%/}/tmux-${__ia_tmux_uid}"',
    'if [ ! -d "$__ia_tmux_default_dir" ]; then',
    '  mkdir -m 700 "$__ia_tmux_default_dir" 2>/dev/null || true',
    'fi',
    'if [ -d "$__ia_tmux_default_dir" ] && [ -O "$__ia_tmux_default_dir" ] && [ -w "$__ia_tmux_default_dir" ]; then',
    '  chmod 700 "$__ia_tmux_default_dir" 2>/dev/null || true',
    'else',
    '  __ia_tmux_home="${HOME:-}"',
    '  if [ -z "$__ia_tmux_home" ] || [ ! -d "$__ia_tmux_home" ]; then',
    '    __ia_tmux_home="$(getent passwd "$__ia_tmux_uid" 2>/dev/null | cut -d: -f6 || true)"',
    '  fi',
    '  if [ -n "$__ia_tmux_home" ] && [ -d "$__ia_tmux_home" ] && [ -w "$__ia_tmux_home" ]; then',
    '    __ia_tmux_fallback_base="$__ia_tmux_home/.cache/infinite-agents/tmux"',
    '  else',
    '    __ia_tmux_fallback_base="/tmp/infinite-agents-tmux-${__ia_tmux_uid}"',
    '  fi',
    '  mkdir -p "$__ia_tmux_fallback_base"',
    '  chmod 700 "$__ia_tmux_fallback_base" 2>/dev/null || true',
    '  export TMUX_TMPDIR="$__ia_tmux_fallback_base"',
    'fi',
  ].join('\n');
}

function buildInitialInput(options: SshTerminalSessionStartOptions): string {
  const commands: string[] = [];
  if (typeof options.cwd === 'string' && options.cwd.trim()) {
    commands.push(`cd ${quoteShellArg(options.cwd.trim())}`);
  }
  if (typeof options.command === 'string' && options.command.trim()) {
    commands.push(options.command.trim());
  }
  if (commands.length === 0) {
    return '';
  }
  return `${commands.join('\n')}\n`;
}

export class SshClient {
  private sessions = new Map<string, ManagedSshSession>();
  private tmuxSnapshots = new Map<string, TmuxSnapshotState>();
  private finalizedTmuxSessions = new Map<string, TerminalSessionResult>();
  private lastTmuxDeadCleanupByConnection = new Map<string, number>();
  private externalCodingAgentTmuxSessions = new Set<string>();
  // Preserved tmux sessions (auto-cleanup disabled — OAuth sign-ins waiting on
  // the user) keyed by session id. Tmux sessions hold no SSH connection between
  // commands, so without this the idle reaper can't see that a machine has a
  // sign-in in progress and stops it — killing the waiting `claude setup-token`
  // (observed live 2026-07-26, forcing users through a second OAuth link).
  private preservedTmuxSessionHosts = new Map<string, { host: string; preservedAt: number }>();

  private async sftpStat(sftp: SFTPWrapper, path: string): Promise<boolean> {
    return new Promise((resolve) => {
      sftp.stat(path, (error) => {
        resolve(!error);
      });
    });
  }

  private async sftpMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.mkdir(path, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async ensureSftpDirectory(sftp: SFTPWrapper, directoryPath: string): Promise<void> {
    const normalized = pathPosix.normalize(directoryPath);
    if (!normalized || normalized === '.' || normalized === '/') {
      return;
    }

    const parts = normalized.split('/').filter(Boolean);
    let current = normalized.startsWith('/') ? '/' : '';
    for (const part of parts) {
      current = current === '/'
        ? `/${part}`
        : current
          ? `${current}/${part}`
          : part;

      if (await this.sftpStat(sftp, current)) {
        continue;
      }

      try {
        await this.sftpMkdir(sftp, current);
      } catch (error) {
        if (!(await this.sftpStat(sftp, current))) {
          throw error;
        }
      }
    }
  }

  private async sftpWriteFile(sftp: SFTPWrapper, file: SshUploadFile): Promise<void> {
    const buffer = Buffer.from(
      file.content instanceof ArrayBuffer
        ? new Uint8Array(file.content)
        : file.content,
    );
    await this.ensureSftpDirectory(sftp, pathPosix.dirname(file.path));
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(file.path, buffer, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (typeof file.mode === 'number') {
      await new Promise<void>((resolve, reject) => {
        sftp.chmod(file.path, file.mode!, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }

  async uploadFiles(
    connection: SshExecConnectionConfig,
    files: SshUploadFile[],
  ): Promise<void> {
    if (files.length === 0) {
      return;
    }

    const conn = new Client();
    const port = connection.port ?? 22;
    const hostKeyVerifier = createHostKeyVerifier(connection);

    return new Promise((resolve, reject) => {
      let settled = false;
      let sftp: SFTPWrapper | null = null;

      const cleanup = () => {
        try {
          sftp?.end();
        } catch {
          // Best-effort cleanup.
        }
        try {
          conn.end();
        } catch {
          // Best-effort cleanup.
        }
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };

      conn
        .on('ready', () => {
          conn.sftp((error, wrapper) => {
            if (error) {
              fail(new Error(`SSH SFTP failed: ${error.message}`));
              return;
            }
            sftp = wrapper;
            void (async () => {
              for (const file of files) {
                await this.sftpWriteFile(wrapper, file);
              }
            })().then(finish, fail);
          });
        })
        .on('error', (error: Error) => {
          fail(hostKeyVerifier.getError() ?? new Error(`SSH connection failed: ${error.message}`));
        })
        .connect(buildSshConnectConfig(connection, port, hostKeyVerifier));
    });
  }

  async execCommand(
    connection: SshExecConnectionConfig,
    command: string,
    options: SshExecOptions = {},
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
  }> {
    const conn = new Client();
    const port = connection.port ?? 22;
    const hostKeyVerifier = createHostKeyVerifier(connection);

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeoutMs = options.timeoutMs;
      const timeoutHandle = timeoutMs
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            timedOut = true;
            settled = true;
            cleanup();
            try {
              conn.end();
            } catch {
              // Best-effort shutdown.
            }
            resolve({
              stdout,
              stderr,
              exitCode: 124,
              timedOut: true,
            });
          }, timeoutMs)
        : undefined;

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        try {
          conn.end();
        } catch {
          // Best-effort cleanup.
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      conn
        .on('ready', () => {
          conn.exec(command, (error, channel) => {
            if (error) {
              fail(new Error(`SSH exec failed: ${error.message}`));
              return;
            }

            channel.on('data', (chunk: Buffer | string) => {
              stdout += chunk.toString();
            });
            if (typeof (channel as { stderr?: { on?: Function } }).stderr?.on === 'function') {
              (channel as { stderr: { on: (event: string, handler: (chunk: Buffer | string) => void) => void } }).stderr.on('data', (chunk) => {
                stderr += chunk.toString();
              });
            }
            // Half-close immediately: this API collects output and has no way
            // to SEND anything (SshExecOptions carries a timeout and nothing
            // else), so the remote command's stdin is a pipe nobody will ever
            // fill. Without the EOF, a command that reads stdin blocks until
            // the caller's timeout and reports as a timeout rather than as
            // what it is — measured at exactly that against a real ssh2
            // server. Commands that ignore stdin are unaffected.
            if (typeof (channel as { end?: unknown }).end === 'function') {
              channel.end();
            }
            channel.on('close', (code?: number) => {
              if (settled) {
                return;
              }
              settled = true;
              cleanup();
              try {
                conn.end();
              } catch {
                // Best-effort cleanup.
              }
              resolve({
                stdout,
                stderr,
                exitCode: typeof code === 'number' ? code : 0,
                timedOut,
              });
            });
          });
        })
        .on('error', (error: Error) => {
          fail(hostKeyVerifier.getError() ?? new Error(`SSH connection failed: ${error.message}`));
        })
        .connect(buildSshConnectConfig(connection, port, hostKeyVerifier));
    });
  }

  async startSession(
    connection: SshExecConnectionConfig,
    options: SshTerminalSessionStartOptions = {},
  ): Promise<TerminalSessionResult> {
    const snapshotOptions = normalizeSnapshotOptions(options);
    const sessionId = `ssh_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const conn = new Client();
    const cols = options.cols ?? DEFAULT_TERMINAL_COLS;
    const rows = options.rows ?? DEFAULT_TERMINAL_ROWS;
    const port = connection.port ?? 22;
    const hostKeyVerifier = createHostKeyVerifier(connection);

    return new Promise<TerminalSessionResult>((resolve, reject) => {
      let settled = false;
      let readyDelayHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error(`SSH connection timed out after ${connection.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms`));
      }, connection.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (readyDelayHandle) {
          clearTimeout(readyDelayHandle);
        }
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        try {
          conn.end();
        } catch {
          // Best-effort cleanup.
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      conn
        .on('ready', () => {
          conn.shell({
            term: 'xterm-256color',
            cols,
            rows,
            env: {
              COLUMNS: String(TERMINAL_SESSION_COLUMNS),
            },
          } as any, (error: Error | undefined, channel: ClientChannel) => {
            if (error) {
              fail(new Error(`SSH shell failed: ${error.message}`));
              return;
            }

            const session: ManagedSshSession = {
              sessionId,
              conn,
              channel,
              host: connection.host,
              port,
              username: connection.username,
              cols,
              rows,
              revision: 1,
              status: 'running',
              exitCode: null,
              rawOutput: '',
              renderer: createTerminalRenderer(rows, cols),
              lastActivityAt: Date.now(),
              lastOutputAt: 0,
              outputRevision: 0,
              lastDeliveredRawLength: 0,
              terminalResponseTail: '',
              externalCodingAgent: startsExternalCodingAgentCli(options.command),
            };

            channel.on('data', (chunk: Buffer | string) => {
              appendOutput(session, chunk);
            });

            if (typeof (channel as { stderr?: { on?: Function } }).stderr?.on === 'function') {
              (channel as { stderr: { on: (event: string, handler: (chunk: Buffer | string) => void) => void } }).stderr.on('data', (chunk) => {
                appendOutput(session, chunk);
              });
            }

            channel.on('close', (code?: number, signal?: string) => {
              session.status = session.forced ? 'closed' : 'exited';
              session.exitCode = typeof code === 'number' ? code : null;
              session.signal = signal;
              session.lastActivityAt = Date.now();
              session.revision += 1;
            });

            channel.on('end', () => {
              if (session.status === 'running') {
                session.status = 'closed';
                session.lastActivityAt = Date.now();
                session.revision += 1;
              }
            });

            conn.on('close', () => {
              if (session.status === 'running') {
                session.status = session.forced ? 'closed' : 'exited';
                session.lastActivityAt = Date.now();
                session.revision += 1;
              }
            });

            conn.on('error', (connError: Error) => {
              appendOutput(session, `\n[SSH connection error] ${connError.message}\n`);
              if (session.status === 'running') {
                session.status = 'closed';
                session.forced = true;
                session.lastActivityAt = Date.now();
                session.revision += 1;
              }
            });

            this.sessions.set(sessionId, session);
            const initialInput = buildInitialInput(options);
            if (initialInput) {
              channel.write(initialInput);
              session.revision += 1;
            }

            readyDelayHandle = setTimeout(() => {
              if (settled) {
                return;
              }
              settled = true;
              cleanup();
              void waitForSessionQuiet(session, snapshotOptions).then(() => {
                resolve(buildSnapshot(session, snapshotOptions));
              });
            }, options.initialReadDelayMs ?? DEFAULT_INITIAL_READ_DELAY_MS);
          });
        })
        .on('error', (error: Error) => {
          fail(hostKeyVerifier.getError() ?? new Error(`SSH connection failed: ${error.message}`));
        })
        .connect(buildSshConnectConfig(connection, port, hostKeyVerifier));
    });
  }

  private buildTmuxPasteCommand(sessionId: string, payload: string): string {
    const bufferName = `${sessionId}_input`;
    const payloadBase64 = Buffer.from(payload, 'utf8').toString('base64');
    return [
      `printf %s ${quoteShellArg(payloadBase64)} | base64 -d | tmux load-buffer -b ${quoteShellArg(bufferName)} -`,
      `tmux paste-buffer -b ${quoteShellArg(bufferName)} -t ${quoteShellArg(sessionId)}`,
      `tmux delete-buffer -b ${quoteShellArg(bufferName)} >/dev/null 2>&1 || true`,
    ].join('\n');
  }

  private buildTmuxSendKeyCommand(sessionId: string, key: string): string | null {
    const tmuxKey = TMUX_KEY_NAMES[key.trim().toLowerCase()];
    if (!tmuxKey) {
      return null;
    }

    return `tmux send-keys -t ${quoteShellArg(sessionId)} ${quoteShellArg(tmuxKey)}`;
  }

  private buildTmuxSendCtrlCommand(sessionId: string, key: string): string {
    const normalized = key.trim().toLowerCase();
    if (!/^[a-z]$/.test(normalized)) {
      throw new Error(`Unsupported ctrl key: ${key}`);
    }

    return `tmux send-keys -t ${quoteShellArg(sessionId)} ${quoteShellArg(`C-${normalized}`)}`;
  }

  private buildTmuxLiteralInputCommands(sessionId: string, payload: string): string[] {
    const chunks: string[] = [];
    let chunk = '';
    for (const char of payload) {
      if (chunk.length > 0 && chunk.length + char.length > TMUX_LITERAL_INPUT_CHUNK_CHARS) {
        chunks.push(chunk);
        chunk = '';
      }
      chunk += char;
    }
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    return chunks.map((text) => (
      `tmux send-keys -l -t ${quoteShellArg(sessionId)} -- ${quoteShellArg(text)}`
    ));
  }

  private buildTmuxInputCommands(sessionId: string, events: TerminalSessionInputEvent[]): string[] {
    const commands: string[] = [];
    const pushInputCommand = (command: string) => {
      if (commands.length > 0) {
        commands.push(`sleep ${TMUX_INPUT_COMMAND_DELAY_SECONDS}`);
      }
      commands.push(command);
    };
    const pushLiteralInput = (payload: string) => {
      for (const command of this.buildTmuxLiteralInputCommands(sessionId, payload)) {
        pushInputCommand(command);
      }
    };

    for (const event of events) {
      if (event.type === 'text') {
        const payload = eventToBytes(event);
        if (payload) {
          pushLiteralInput(payload);
        }
        continue;
      }

      if (event.type === 'raw') {
        if (event.data) {
          pushLiteralInput(event.data);
        }
        continue;
      }

      if (event.type === 'ctrl') {
        pushInputCommand(this.buildTmuxSendCtrlCommand(sessionId, event.key));
        continue;
      }

      if (event.type === 'key') {
        const sendKeyCommand = this.buildTmuxSendKeyCommand(sessionId, event.key);
        if (sendKeyCommand) {
          pushInputCommand(sendKeyCommand);
          continue;
        }

        pushLiteralInput(eventToBytes(event));
      }
    }

    return commands;
  }

  private async execTmuxScript(
    connection: SshExecConnectionConfig,
    script: string,
    options: { timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    const result = await this.execCommand(
      connection,
      `bash -lc ${quoteShellArg(`${buildTmuxRuntimeSetupScript()}\n${script}`)}`,
      options,
    );
    if (result.timedOut) {
      throw new TmuxCommandError('tmux command timed out.', result);
    }
    if (result.exitCode !== 0) {
      if (tmuxStartOutputReportsCreated(result.stdout)) {
        return result;
      }
      const stdout = stripInternalTmuxStartMarkers(result.stdout);
      const detail = [result.stderr.trim(), stdout].filter(Boolean).join('\n').trim();
      throw new TmuxCommandError(detail || `tmux command exited with code ${result.exitCode}.`, result);
    }
    return result;
  }

  private buildTmuxReadTimeoutFallback(
    sessionId: string,
    snapshotOptions: TerminalSessionSnapshotOptions,
  ): TerminalSessionResult | undefined {
    const prior = this.tmuxSnapshots.get(sessionId);
    const cached = prior?.lastResult;
    if (!cached) {
      return undefined;
    }

    const now = Date.now();
    const screen: TerminalSessionScreen = {
      cols: cached.screen.cols,
      rows: cached.screen.rows,
      altBuffer: cached.screen.altBuffer,
      cursor: cached.screen.cursor,
      output: cached.screen.output,
    };
    if (snapshotOptions.readMode === 'delta') {
      screen.changedRows = [];
    }
    const lastActivityMs = typeof prior.lastActivityAt === 'number'
      ? Math.max(0, now - prior.lastActivityAt)
      : cached.lastActivityMs;

    return {
      ...cached,
      stableForMs: Math.max(cached.stableForMs ?? 0, now - (prior.stableSinceMs ?? now)),
      lastActivityMs,
      timedOut: true,
      warning: TMUX_READ_TIMEOUT_WARNING,
      screen,
    };
  }

  private getTmuxCleanupConnectionKey(connection: SshExecConnectionConfig): string {
    return `${connection.username}@${connection.host}:${connection.port ?? 22}`;
  }

  async startTmuxSession(
    connection: SshExecConnectionConfig,
    options: SshTerminalSessionStartOptions = {},
    sessionId = `ssh_tmux_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
  ): Promise<TerminalSessionResult> {
    if (connection.os === 'windows') {
      return this.startSession(connection, options);
    }
    this.finalizedTmuxSessions.delete(sessionId);
    // A (re)start resets preservation; the caller re-marks via
    // setTmuxSessionAutoCleanup if this session should be preserved.
    this.preservedTmuxSessionHosts.delete(sessionId);
    if (startsExternalCodingAgentCli(options.command)) {
      this.externalCodingAgentTmuxSessions.add(sessionId);
    }
    await this.cleanupDeadTmuxSessions(connection, {
      staleAutoCleanupMs: TMUX_STALE_AUTO_CLEANUP_MS,
    });
    const cols = normalizeTerminalDimension(options.cols ?? DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_COLS);
    const rows = normalizeTerminalDimension(options.rows ?? DEFAULT_TERMINAL_ROWS, DEFAULT_TERMINAL_ROWS);
    const newSessionCommand = [
      'tmux new-session -d',
      `-s ${quoteShellArg(sessionId)}`,
      `-x ${cols}`,
      `-y ${rows}`,
      `-e COLUMNS=${quoteShellArg(String(TERMINAL_SESSION_COLUMNS))}`,
      options.cwd?.trim() ? `-c ${quoteShellArg(options.cwd.trim())}` : '',
    ].filter(Boolean).join(' ');
    const commands = [
      'command -v tmux >/dev/null 2>&1 || { echo "tmux is required for durable remote terminal sessions. Install tmux on this server and retry." >&2; exit 127; }',
      'set -e',
      '__ia_created_session=0',
      `trap 'status=$?; if [ "$status" -ne 0 ] && [ "\${__ia_created_session:-0}" = "1" ]; then tmux kill-session -t ${quoteShellArg(sessionId)} >/dev/null 2>&1 || true; fi; exit "$status"' EXIT`,
      `if tmux has-session -t ${quoteShellArg(sessionId)} 2>/dev/null; then`,
      '  __ia_existing_session=1',
      '  printf "__IA_TMUX_EXISTING_SESSION=1\\n"',
      'else',
      `  __ia_target_cwd=${quoteShellArg(options.cwd?.trim() || '(login shell default)')}`,
      `  if __ia_new_session_err="$(${newSessionCommand} 2>&1)"; then`,
      '    __ia_existing_session=0',
      '    __ia_created_session=1',
      '    printf "__IA_TMUX_CREATED_SESSION=1\\n"',
      '  else',
      '    __ia_new_session_status=$?',
      `    echo "tmux new-session failed (exit \${__ia_new_session_status}) for user $(id -un 2>/dev/null || echo '?') with cwd \${__ia_target_cwd}: \${__ia_new_session_err:-no output from tmux; the login shell or tmux server may be misconfigured for this user}" >&2`,
      '    exit "$__ia_new_session_status"',
      '  fi',
      'fi',
      `tmux set-window-option -t ${quoteShellArg(sessionId)} remain-on-exit on >/dev/null 2>&1 || true`,
      `tmux set-option -t ${quoteShellArg(sessionId)} status off >/dev/null 2>&1 || true`,
      'if [ "${__ia_existing_session:-0}" != "1" ]; then',
      `  tmux set-option -q -t ${quoteShellArg(sessionId)} @ia_auto_cleanup ${quoteShellArg(options.autoCleanup === true ? '1' : '0')} >/dev/null 2>&1 || true`,
      options.ownerTag?.trim()
        ? `  tmux set-option -q -t ${quoteShellArg(sessionId)} @ia_owner_tag ${quoteShellArg(options.ownerTag.trim())} >/dev/null 2>&1 || true`
        : '',
      'fi',
    ].filter(Boolean);
    if (typeof options.command === 'string' && options.command.trim()) {
      commands.push('if [ "${__ia_existing_session:-0}" != "1" ]; then');
      commands.push(`  tmux has-session -t ${quoteShellArg(sessionId)} 2>/dev/null || { echo "tmux session exited before command could be sent: ${sessionId}" >&2; exit 1; }`);
      commands.push(this.buildTmuxPasteCommand(sessionId, `${options.command.trim()}\r`));
      commands.push('fi');
    }
    commands.push('printf "__IA_TMUX_EXISTING_SESSION=%s\\n" "$__ia_existing_session"');

    let createdNewSession = false;
    let reportedExistingSession = false;
    let startFailed = false;
    let startCommandCompleted = false;
    try {
      const startResult = await this.execTmuxScript(connection, commands.join('\n'), {
        timeoutMs: connection.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      });
      startCommandCompleted = true;
      reportedExistingSession = tmuxStartOutputReportsExisting(startResult.stdout);
      createdNewSession = tmuxStartOutputReportsCreated(startResult.stdout) || !reportedExistingSession;
      await sleep(options.initialReadDelayMs ?? DEFAULT_INITIAL_READ_DELAY_MS);
      try {
        return await this.readTmuxSession(connection, sessionId, options);
      } catch (error) {
        throw new Error(`tmux session ${sessionId} started but initial read failed: ${getErrorMessage(error)}`);
      }
    } catch (error) {
      startFailed = true;
      if (error instanceof TmuxCommandError) {
        reportedExistingSession = reportedExistingSession || tmuxStartOutputReportsExisting(error.stdout);
        createdNewSession = createdNewSession || tmuxStartOutputReportsCreated(error.stdout);
      }
      throw error;
    } finally {
      const shouldCleanupFailedStart = createdNewSession
        || (!startCommandCompleted && !reportedExistingSession);
      if (startFailed && shouldCleanupFailedStart) {
        await this.cleanupTmuxSession(connection, sessionId);
      } else if (startFailed) {
        this.externalCodingAgentTmuxSessions.delete(sessionId);
      }
    }
  }

  async setTmuxSessionAutoCleanup(
    connection: SshExecConnectionConfig,
    sessionId: string,
    autoCleanup: boolean,
  ): Promise<void> {
    // In-memory first: the host must count as active even if the best-effort
    // remote metadata write below fails.
    if (autoCleanup) {
      this.preservedTmuxSessionHosts.delete(sessionId);
    } else if (connection.host) {
      this.preservedTmuxSessionHosts.set(sessionId, { host: connection.host, preservedAt: Date.now() });
    }
    try {
      await this.execTmuxScript(connection, [
        `tmux has-session -t ${quoteShellArg(sessionId)} 2>/dev/null || exit 0`,
        `tmux set-option -q -t ${quoteShellArg(sessionId)} @ia_auto_cleanup ${quoteShellArg(autoCleanup ? '1' : '0')} >/dev/null 2>&1 || true`,
      ].join('\n'), { timeoutMs: DEFAULT_TMUX_CLEANUP_TIMEOUT_MS });
    } catch {
      // Best-effort metadata update; explicit cleanup paths still kill by session id.
    }
  }

  async sendTmuxInput(
    connection: SshExecConnectionConfig,
    sessionId: string,
    events: TerminalSessionInputEvent[],
    options: TerminalSessionSnapshotOptions = {},
  ): Promise<TerminalSessionResult> {
    const finalized = this.finalizedTmuxSessions.get(sessionId);
    if (finalized) {
      throw new Error(`tmux session ${sessionId} is not running.`);
    }

    const snapshotOptions = normalizeSnapshotOptions(options);
    if (inputEventsStartExternalCodingAgent(events)) {
      this.externalCodingAgentTmuxSessions.add(sessionId);
    }
    const inputCommands = this.buildTmuxInputCommands(sessionId, events);
    if (inputCommands.length > 0) {
      await this.execTmuxScript(connection, [
        'set -e',
        `tmux has-session -t ${quoteShellArg(sessionId)} 2>/dev/null || { echo "tmux session not found: ${sessionId}" >&2; exit 1; }`,
        ...inputCommands,
      ].join('\n'), { timeoutMs: getTmuxCommandTimeoutMs(snapshotOptions) });
      await sleep(snapshotOptions.quietForMs ?? DEFAULT_INITIAL_READ_DELAY_MS);
    }

    return this.readTmuxSession(connection, sessionId, snapshotOptions);
  }

  async readTmuxSession(
    connection: SshExecConnectionConfig,
    sessionId: string,
    options: TerminalSessionSnapshotOptions = {},
  ): Promise<TerminalSessionResult> {
    const finalized = this.finalizedTmuxSessions.get(sessionId);
    if (finalized) {
      return finalized;
    }

    const snapshotOptions = normalizeSnapshotOptions(options);
    const prior = this.tmuxSnapshots.get(sessionId);
    const requestedRows = normalizeTerminalDimension((options as { rows?: number }).rows ?? prior?.rows ?? DEFAULT_TERMINAL_ROWS, DEFAULT_TERMINAL_ROWS);
    const requestedCols = normalizeTerminalDimension((options as { cols?: number }).cols ?? prior?.cols ?? DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_COLS);
    if (snapshotOptions.quietForMs !== undefined) {
      await sleep(snapshotOptions.quietForMs);
    }
    const waitDeadline = Date.now() + (
      snapshotOptions.waitForChange
        ? snapshotOptions.timeoutMs ?? DEFAULT_REPAINT_TIMEOUT_MS
        : snapshotOptions.timeoutMs ?? DEFAULT_REPAINT_TIMEOUT_MS
    );

    while (true) {
      const marker = `__IA_TMUX_META_${randomUUID().replace(/-/g, '')}__`;
      const captureStart = getTmuxSnapshotCaptureStart();
      const script = [
        `tmux has-session -t ${quoteShellArg(sessionId)} 2>/dev/null || { echo "tmux session not found: ${sessionId}" >&2; exit 1; }`,
        `tmux capture-pane -t ${quoteShellArg(sessionId)} -p -S ${captureStart}`,
        `printf '\\n${marker}\\n'`,
        `tmux display-message -p -t ${quoteShellArg(sessionId)} 'dead=#{pane_dead};dead_status=#{pane_dead_status};width=#{pane_width};height=#{pane_height};cursor_x=#{cursor_x};cursor_y=#{cursor_y};alt=#{alternate_on};activity=#{session_activity};current_command=#{pane_current_command}'`,
      ].join('\n');
      let result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
      try {
        result = await this.execTmuxScript(connection, script, { timeoutMs: getTmuxCommandTimeoutMs(snapshotOptions) });
      } catch (error) {
        if (isTmuxCommandTimeoutError(error)) {
          const fallback = this.buildTmuxReadTimeoutFallback(sessionId, snapshotOptions);
          if (fallback) {
            return fallback;
          }
        }
        throw error;
      }
      const markerIndex = result.stdout.lastIndexOf(`\n${marker}\n`);
      const outputText = markerIndex >= 0 ? result.stdout.slice(0, markerIndex) : result.stdout;
      const metadataText = markerIndex >= 0 ? result.stdout.slice(markerIndex + marker.length + 2).trim() : '';
      const metadata = Object.fromEntries(metadataText.split(';').map((part) => {
        const [key, ...rest] = part.split('=');
        return [key, rest.join('=')];
      }));
      const rows = Math.max(1, Number(metadata.height) || requestedRows);
      const cols = Math.max(1, Number(metadata.width) || requestedCols);
      const scrollbackOutput = normalizeTmuxCaptureOutput(outputText.replace(/\n$/, ''));
      const output = scrollbackOutput.slice(-Math.min(scrollbackOutput.length, rows));
      const paneDead = metadata.dead === '1';
      const comparisonRows = snapshotOptions.readMode === 'delta'
        ? scrollbackOutput
        : output;
      const priorComparisonRows = snapshotOptions.readMode === 'delta'
        ? prior?.lastScrollbackRows
        : prior?.lastRows;
      const shouldKeepWaiting = snapshotOptions.waitForChange
        && priorComparisonRows
        && rowsEqual(priorComparisonRows, comparisonRows)
        && !paneDead
        && Date.now() < waitDeadline;
      if (shouldKeepWaiting) {
        await sleep(Math.min(INPUT_READ_POLL_INTERVAL_MS, Math.max(0, waitDeadline - Date.now())));
        continue;
      }

      const outputUnchanged = rowsEqual(prior?.lastRows, output);
      const scrollbackUnchanged = rowsEqual(prior?.lastScrollbackRows, scrollbackOutput);
      const snapshotUnchanged = outputUnchanged && scrollbackUnchanged;
      const revision = (prior?.revision ?? 0) + (snapshotUnchanged ? 0 : 1);
      const changedRows = snapshotOptions.readMode === 'delta'
        ? getScrollbackDeltaRows(prior?.lastScrollbackRows, scrollbackOutput)
        : undefined;
      const activitySeconds = Number(metadata.activity);
      const now = Date.now();
      const lastActivityAt = Number.isFinite(activitySeconds)
        ? activitySeconds * 1000
        : prior?.lastActivityAt;
      const lastActivityMs = typeof lastActivityAt === 'number'
        ? Math.max(0, now - lastActivityAt)
        : prior?.lastActivityMs;
      const stableSinceMs = snapshotUnchanged
        ? prior?.stableSinceMs ?? now
        : now;
      const stableForMs = Math.max(0, now - stableSinceMs);

      const deadStatus = Number(metadata.dead_status);
      const status = paneDead ? 'exited' : 'running';
      const processState = inferTerminalProcessState(
        status,
        output,
        typeof lastActivityMs === 'number' ? now - lastActivityMs : 0,
        now,
      );
      const terminalResult: TerminalSessionResult = {
        sessionId,
        revision,
        status,
        currentCommand: typeof metadata.current_command === 'string' && metadata.current_command.trim()
          ? metadata.current_command.trim()
          : undefined,
        processState,
        stableForMs,
        exitCode: paneDead && Number.isFinite(deadStatus) ? deadStatus : null,
        lastActivityMs,
        screen: {
          cols,
          rows,
          altBuffer: metadata.alt === '1',
          cursor: {
            row: Math.max(1, (Number(metadata.cursor_y) || 0) + 1),
            col: Math.max(1, (Number(metadata.cursor_x) || 0) + 1),
          },
          output,
          ...(changedRows ? { changedRows } : {}),
        },
      };
      this.tmuxSnapshots.set(sessionId, {
        revision,
        lastRows: output,
        lastScrollbackRows: scrollbackOutput,
        lastActivityMs,
        lastActivityAt,
        stableSinceMs,
        rows,
        cols,
        lastResult: terminalResult,
      });
      if (paneDead) {
        await this.cleanupTmuxSession(connection, sessionId);
        this.tmuxSnapshots.set(sessionId, {
          revision,
          lastRows: output,
          lastScrollbackRows: scrollbackOutput,
          lastActivityMs,
          lastActivityAt,
          stableSinceMs,
          rows,
          cols,
          lastResult: terminalResult,
        });
        this.finalizedTmuxSessions.set(sessionId, terminalResult);
      }

      return terminalResult;
    }
  }

  async closeTmuxSession(
    connection: SshExecConnectionConfig,
    sessionId: string,
    options: TerminalSessionSnapshotOptions = {},
  ): Promise<TerminalSessionResult> {
    let snapshot: TerminalSessionResult;
    const snapshotOptions = normalizeSnapshotOptions(options);
    const finalized = this.finalizedTmuxSessions.get(sessionId);
    if (finalized) {
      this.finalizedTmuxSessions.delete(sessionId);
      this.tmuxSnapshots.delete(sessionId);
      this.externalCodingAgentTmuxSessions.delete(sessionId);
      this.preservedTmuxSessionHosts.delete(sessionId);
      return this.buildClosedTmuxResult(finalized);
    }

    try {
      snapshot = await this.readTmuxSession(connection, sessionId, snapshotOptions);
    } catch {
      this.tmuxSnapshots.delete(sessionId);
      this.externalCodingAgentTmuxSessions.delete(sessionId);
      this.preservedTmuxSessionHosts.delete(sessionId);
      throw new Error(`tmux session not found: ${sessionId}`);
    }

    const shouldInterruptCodingAgent = snapshot.status === 'running'
      && (
        this.externalCodingAgentTmuxSessions.has(sessionId)
        || terminalOutputLooksLikeExternalCodingAgent(snapshot.screen.output)
      );
    if (shouldInterruptCodingAgent) {
      try {
        snapshot = await this.sendTmuxInput(connection, sessionId, [{ type: 'ctrl', key: 'c' }], {
          ...snapshotOptions,
          quietForMs: snapshotOptions.quietForMs ?? CODING_AGENT_CLOSE_INTERRUPT_DELAY_MS,
          timeoutMs: snapshotOptions.timeoutMs ?? DEFAULT_REPAINT_TIMEOUT_MS,
        });
      } catch {
        // Best-effort graceful exit before force-closing the tmux session.
      }
    }

    await this.cleanupTmuxSession(connection, sessionId);
    this.tmuxSnapshots.delete(sessionId);
    this.finalizedTmuxSessions.delete(sessionId);
    this.externalCodingAgentTmuxSessions.delete(sessionId);
    return this.buildClosedTmuxResult(snapshot);
  }

  private buildClosedTmuxResult(result: TerminalSessionResult): TerminalSessionResult {
    return {
      ...result,
      status: 'closed',
      processState: 'exited',
      forced: true,
    };
  }

  private async cleanupTmuxSession(
    connection: SshExecConnectionConfig,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.execTmuxScript(connection, [
        `tmux kill-session -t ${quoteShellArg(sessionId)} >/dev/null 2>&1 || true`,
      ].join('\n'), { timeoutMs: DEFAULT_TMUX_CLEANUP_TIMEOUT_MS });
    } catch {
      // Best-effort cleanup. The final snapshot is already available.
    } finally {
      this.tmuxSnapshots.delete(sessionId);
      this.finalizedTmuxSessions.delete(sessionId);
      this.externalCodingAgentTmuxSessions.delete(sessionId);
      this.preservedTmuxSessionHosts.delete(sessionId);
    }
  }

  async cleanupTmuxSessions(
    connection: SshExecConnectionConfig,
    sessionIds: Iterable<string>,
  ): Promise<void> {
    if (connection.os === 'windows') {
      return;
    }
    await Promise.all([...sessionIds].map(async (sessionId) => {
      if (this.externalCodingAgentTmuxSessions.has(sessionId)) {
        await this.closeTmuxSession(connection, sessionId)
          .catch(() => this.cleanupTmuxSession(connection, sessionId));
      } else {
        await this.cleanupTmuxSession(connection, sessionId);
      }
    }));
  }

  async cleanupDeadTmuxSessions(
    connection: SshExecConnectionConfig,
    options: { force?: boolean; staleAutoCleanupMs?: number; ownerTag?: string } = {},
  ): Promise<void> {
    if (connection.os === 'windows') {
      return;
    }
    const now = Date.now();
    const connectionKey = this.getTmuxCleanupConnectionKey(connection);
    if (!options.force) {
      const lastCleanup = this.lastTmuxDeadCleanupByConnection.get(connectionKey) ?? 0;
      if (now - lastCleanup < TMUX_DEAD_CLEANUP_INTERVAL_MS) {
        return;
      }
    }
    this.lastTmuxDeadCleanupByConnection.set(connectionKey, now);

    const staleAutoCleanupSeconds = typeof options.staleAutoCleanupMs === 'number' && options.staleAutoCleanupMs > 0
      ? Math.floor(options.staleAutoCleanupMs / 1000)
      : 0;
    const ownerTag = typeof options.ownerTag === 'string' ? options.ownerTag.trim() : '';
    const nowSeconds = Math.floor(now / 1000);
    const script = [
      'if command -v tmux >/dev/null 2>&1; then',
      `  tmux list-sessions -F ${quoteShellArg('#{session_name}\t#{pane_dead}\t#{session_created}\t#{session_activity}\t#{@ia_auto_cleanup}\t#{@ia_owner_tag}')} 2>/dev/null | while IFS="$(printf '\\t')" read -r name dead created activity auto_cleanup owner_tag; do`,
      '    case "$name" in',
      '      ssh_tmux_*)',
      '        if [ "$dead" = "1" ]; then',
      '          tmux kill-session -t "$name" >/dev/null 2>&1 || true',
      `        elif [ -n ${quoteShellArg(ownerTag)} ] && [ "$auto_cleanup" = "1" ] && [ "$owner_tag" = ${quoteShellArg(ownerTag)} ]; then`,
      '          tmux kill-session -t "$name" >/dev/null 2>&1 || true',
      `        elif [ ${staleAutoCleanupSeconds} -gt 0 ] && [ "$auto_cleanup" = "1" ]; then`,
      '          case "$created" in',
      '            ""|*[!0-9]*) created=0 ;;',
      '          esac',
      '          case "$activity" in',
      '            ""|*[!0-9]*) activity=0 ;;',
      '          esac',
      '          reference="$activity"',
      '          if [ "$reference" -le 0 ]; then reference="$created"; fi',
      `          if [ "$reference" -gt 0 ] && [ $(( ${nowSeconds} - reference )) -ge ${staleAutoCleanupSeconds} ]; then`,
      '            tmux kill-session -t "$name" >/dev/null 2>&1 || true',
      '          fi',
      '        fi',
      '        ;;',
      '    esac',
      '  done',
      'fi',
    ].join('\n');

    try {
      await this.execTmuxScript(connection, script, { timeoutMs: DEFAULT_TMUX_CLEANUP_TIMEOUT_MS });
    } catch {
      // Best-effort cleanup before starting a new durable terminal session.
    }
  }

  async sendInput(
    sessionId: string,
    events: TerminalSessionInputEvent[],
    options: TerminalSessionSnapshotOptions = {},
  ): Promise<TerminalSessionResult> {
    const snapshotOptions = normalizeSnapshotOptions(options);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`SSH session not found: ${sessionId}`);
    }
    if (session.status !== 'running') {
      throw new Error(`SSH session ${sessionId} is not running.`);
    }

    if (inputEventsStartExternalCodingAgent(events)) {
      session.externalCodingAgent = true;
    }
    const payloads = events
      .map((event) => eventToBytes(event))
      .filter((payload) => payload.length > 0);
    if (payloads.length > 0) {
      const outputRevisionBeforeInput = session.outputRevision;
      for (let index = 0; index < payloads.length; index += 1) {
        session.channel.write(payloads[index]);
        if (index < payloads.length - 1) {
          await sleep(DEFAULT_INPUT_EVENT_DELAY_MS);
        }
      }
      session.lastActivityAt = Date.now();
      session.revision += 1;
      if (snapshotOptions.quietForMs !== undefined) {
        await waitForSessionQuiet(session, snapshotOptions, outputRevisionBeforeInput);
      } else {
        await waitForSessionRevisionAfter(session, session.revision, DEFAULT_INPUT_READ_TIMEOUT_MS);
      }
    }

    return buildSnapshot(session, snapshotOptions);
  }

  async readSession(
    sessionId: string,
    options: TerminalSessionSnapshotOptions = {},
  ): Promise<TerminalSessionResult> {
    const snapshotOptions = normalizeSnapshotOptions(options);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`SSH session not found: ${sessionId}`);
    }
    if (snapshotOptions.waitForChange) {
      await waitForSessionRevisionAfter(
        session,
        session.revision,
        snapshotOptions.timeoutMs ?? DEFAULT_REPAINT_TIMEOUT_MS,
      );
    }
    await waitForSessionQuiet(session, snapshotOptions);
    return buildSnapshot(session, snapshotOptions);
  }

  async closeSession(
    sessionId: string,
    options: TerminalSessionSnapshotOptions = {},
  ): Promise<TerminalSessionResult> {
    const snapshotOptions = normalizeSnapshotOptions(options);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`SSH session not found: ${sessionId}`);
    }

    if (session.status === 'running') {
      const shouldInterruptCodingAgent = session.externalCodingAgent
        || terminalOutputLooksLikeExternalCodingAgent(getRenderedOutput(session.renderer));
      if (shouldInterruptCodingAgent) {
        try {
          session.channel.write(encodeCtrlKey('c'));
          await sleep(CODING_AGENT_CLOSE_INTERRUPT_DELAY_MS);
        } catch {
          // Best-effort graceful exit before closing the SSH channel.
        }
      }
      session.forced = true;
      session.status = 'closed';
      session.lastActivityAt = Date.now();
      session.revision += 1;
      try {
        session.channel.end('exit\n');
      } catch {
        // Best-effort close.
      }
      try {
        session.conn.end();
      } catch {
        // Best-effort close.
      }
    }

    this.sessions.delete(sessionId);
    return buildSnapshot(session, snapshotOptions);
  }

  /**
   * Hosts (SSH target addresses) with at least one currently-open, running
   * session. Consulted by the Fly idle reaper: stopping a machine kills tmux, so
   * a machine whose private IP appears here has a live terminal session and
   * must not be stopped.
   *
   * Two sources: open PTY sessions, and preserved tmux sessions (OAuth
   * sign-ins). The latter hold no SSH connection between commands — the tmux
   * lives detached on the machine — so they're tracked separately, with a TTL
   * so an abandoned sign-in eventually lets the machine sleep.
   */
  getActiveSessionHosts(): Set<string> {
    const hosts = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.status === 'running' && session.host) {
        hosts.add(session.host);
      }
    }
    const now = Date.now();
    for (const [sessionId, preserved] of this.preservedTmuxSessionHosts) {
      if (now - preserved.preservedAt > PRESERVED_TMUX_HOT_MS) {
        this.preservedTmuxSessionHosts.delete(sessionId);
        continue;
      }
      hosts.add(preserved.host);
    }
    return hosts;
  }
}

/**
 * Process-wide SSH client, so all terminal sessions (harness turns + the setup
 * agent's preserved sign-ins + the sandbox clients' exec) live in ONE session
 * registry. The Fly idle reaper queries {@link SshClient.getActiveSessionHosts}
 * on this instance to know which machines have a live terminal session.
 */
export const globalSshClient = new SshClient();
