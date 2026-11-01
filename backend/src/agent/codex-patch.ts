export type CodexPatchLineKind = 'context' | 'add' | 'remove';

export interface CodexPatchLine {
  kind: CodexPatchLineKind;
  text: string;
}

export interface CodexPatchChunk {
  header?: string;
  lines: CodexPatchLine[];
  endOfFile: boolean;
}

export type CodexPatchOperation =
  | {
    kind: 'add';
    path: string;
    lines: string[];
  }
  | {
    kind: 'delete';
    path: string;
  }
  | {
    kind: 'update';
    path: string;
    moveTo?: string;
    chunks: CodexPatchChunk[];
  };

export interface CodexPatchFileSnapshot {
  kind: 'missing' | 'file' | 'directory' | 'other';
  content?: string;
  mode?: number;
}

export interface CodexPatchFileWrite {
  path: string;
  content: string;
  mode?: number;
}

export interface CodexPatchFilePlan {
  writes: CodexPatchFileWrite[];
  deletes: string[];
}

const DEFAULT_FILE_MODE = 0o644;
const PATCH_BEGIN = '*** Begin Patch';
const PATCH_END = '*** End Patch';
const PATCH_UPDATE = '*** Update File: ';
const PATCH_ADD = '*** Add File: ';
const PATCH_DELETE = '*** Delete File: ';
const PATCH_MOVE = '*** Move to: ';
const PATCH_EOF = '*** End of File';

function normalizeLineEndings(value: string): string {
  return value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function unwrapOptionalMarkdownFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) {
    return value;
  }

  const lines = trimmed.split('\n');
  if (lines.length < 3) {
    return value;
  }

  const openingFence = lines[0]?.trim() ?? '';
  const closingFence = lines[lines.length - 1]?.trim() ?? '';
  if (!openingFence.startsWith('```') || closingFence !== '```') {
    return value;
  }

  return lines.slice(1, -1).join('\n');
}

function isIgnorableUnifiedDiffMetadataLine(line: string): boolean {
  return (
    line.startsWith('diff --git ')
    || line.startsWith('index ')
    || line.startsWith('--- ')
    || line.startsWith('+++ ')
  );
}

function isFileHeader(line: string): boolean {
  return (
    line.startsWith(PATCH_UPDATE)
    || line.startsWith(PATCH_ADD)
    || line.startsWith(PATCH_DELETE)
  );
}

function isPatchBoundary(line: string): boolean {
  return line === PATCH_END || isFileHeader(line);
}

function readPath(line: string, prefix: string): string {
  const path = line.slice(prefix.length).trim();
  if (!path) {
    throw new Error(`Invalid patch: missing path after "${prefix.trim()}".`);
  }
  return path;
}

export function parseCodexPatch(patch: string): CodexPatchOperation[] {
  const normalized = normalizeLineEndings(unwrapOptionalMarkdownFence(patch)).trim();
  if (!normalized) {
    throw new Error('Invalid patch: patch text is required.');
  }

  const lines = normalized.split('\n');
  if (lines[0] !== PATCH_BEGIN) {
    throw new Error(`Invalid patch: expected "${PATCH_BEGIN}".`);
  }

  const operations: CodexPatchOperation[] = [];
  let index = 1;

  while (index < lines.length) {
    const line = lines[index];

    if (line === PATCH_END) {
      if (index !== lines.length - 1) {
        throw new Error('Invalid patch: unexpected content after "*** End Patch".');
      }
      if (operations.length === 0) {
        throw new Error('Invalid patch: no file operations were provided.');
      }
      return operations;
    }

    if (line.startsWith(PATCH_ADD)) {
      const path = readPath(line, PATCH_ADD);
      index += 1;
      const fileLines: string[] = [];
      while (index < lines.length && !isPatchBoundary(lines[index])) {
        const nextLine = lines[index];
        if (!nextLine.startsWith('+')) {
          throw new Error(`Invalid add-file patch for "${path}": expected "+" lines only. Prefix each file-content line with "+", for example +print("hello").`);
        }
        fileLines.push(nextLine.slice(1));
        index += 1;
      }
      if (fileLines.length === 0) {
        throw new Error(`Invalid add-file patch for "${path}": file content is required.`);
      }
      operations.push({
        kind: 'add',
        path,
        lines: fileLines,
      });
      continue;
    }

    if (line.startsWith(PATCH_DELETE)) {
      operations.push({
        kind: 'delete',
        path: readPath(line, PATCH_DELETE),
      });
      index += 1;
      continue;
    }

    if (line.startsWith(PATCH_UPDATE)) {
      const path = readPath(line, PATCH_UPDATE);
      index += 1;

      let moveTo: string | undefined;
      if (index < lines.length && lines[index].startsWith(PATCH_MOVE)) {
        moveTo = readPath(lines[index], PATCH_MOVE);
        index += 1;
      }

      while (index < lines.length && isIgnorableUnifiedDiffMetadataLine(lines[index] ?? '')) {
        index += 1;
      }

      const chunks: CodexPatchChunk[] = [];
      while (index < lines.length && !isPatchBoundary(lines[index])) {
        let chunkHeader = lines[index];
        if (!chunkHeader.startsWith('@@')) {
          throw new Error(`Invalid update patch for "${path}": expected "@@" chunk header.`);
        }

        // Some models emit a redundant bare "@@" line immediately before a
        // unified-diff hunk header like "@@ -2,7 +2,7 @@". Treat that as one
        // chunk header instead of rejecting it as an empty chunk.
        while (
          chunkHeader === '@@'
          && index + 1 < lines.length
          && lines[index + 1].startsWith('@@')
        ) {
          index += 1;
          chunkHeader = lines[index];
        }

        index += 1;

        const chunkLines: CodexPatchLine[] = [];
        let endOfFile = false;

        while (index < lines.length && !lines[index].startsWith('@@') && !isPatchBoundary(lines[index])) {
          const chunkLine = lines[index];
          if (chunkLine === PATCH_EOF) {
            endOfFile = true;
            index += 1;
            break;
          }

          if (chunkLine === '\\ No newline at end of file') {
            endOfFile = true;
            index += 1;
            continue;
          }

          if (chunkLine === '') {
            chunkLines.push({
              kind: 'context',
              text: '',
            });
            index += 1;
            continue;
          }

          const prefix = chunkLine[0];
          if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
            throw new Error(`Invalid update patch for "${path}": unexpected line "${chunkLine}".`);
          }

          chunkLines.push({
            kind: prefix === ' ' ? 'context' : prefix === '+' ? 'add' : 'remove',
            text: chunkLine.slice(1),
          });
          index += 1;
        }

        if (chunkLines.length === 0) {
          throw new Error(`Invalid update patch for "${path}": empty chunk.`);
        }

        chunks.push({
          header: chunkHeader === '@@' ? undefined : chunkHeader.slice(2).trimStart(),
          lines: chunkLines,
          endOfFile,
        });
      }

      if (!moveTo && chunks.length === 0) {
        throw new Error(`Invalid update patch for "${path}": expected changes or a move target.`);
      }

      operations.push({
        kind: 'update',
        path,
        moveTo,
        chunks,
      });
      continue;
    }

    throw new Error(`Invalid patch: unexpected line "${line}".`);
  }

  throw new Error(`Invalid patch: missing "${PATCH_END}".`);
}

export function listCodexPatchPaths(operations: CodexPatchOperation[]): string[] {
  const paths = new Set<string>();
  for (const operation of operations) {
    paths.add(operation.path);
    if (operation.kind === 'update' && operation.moveTo) {
      paths.add(operation.moveTo);
    }
  }
  return [...paths].sort();
}

interface TextDocument {
  lines: string[];
  endsWithNewline: boolean;
}

function splitDocument(text: string): TextDocument {
  const normalized = normalizeLineEndings(text);
  if (!normalized) {
    return {
      lines: [],
      endsWithNewline: false,
    };
  }

  const endsWithNewline = normalized.endsWith('\n');
  const body = endsWithNewline ? normalized.slice(0, -1) : normalized;
  return {
    lines: body ? body.split('\n') : [],
    endsWithNewline,
  };
}

function renderDocument(document: TextDocument): string {
  if (document.lines.length === 0) {
    return document.endsWithNewline ? '\n' : '';
  }

  return `${document.lines.join('\n')}${document.endsWithNewline ? '\n' : ''}`;
}

function findMatchIndexes(
  haystack: string[],
  needle: string[],
  startIndex: number,
  requireEndOfFile: boolean,
): number[] {
  if (needle.length === 0) {
    return [Math.min(Math.max(startIndex, 0), haystack.length)];
  }

  const matches: number[] = [];
  const maxStart = haystack.length - needle.length;
  for (let index = Math.max(startIndex, 0); index <= maxStart; index += 1) {
    if (requireEndOfFile && index + needle.length !== haystack.length) {
      continue;
    }

    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      matches.push(index);
    }
  }

  return matches;
}

function findChunkStart(
  lines: string[],
  beforeLines: string[],
  cursor: number,
  requireEndOfFile: boolean,
): number {
  if (beforeLines.length === 0) {
    return requireEndOfFile ? lines.length : Math.min(Math.max(cursor, 0), lines.length);
  }

  const fromCursor = findMatchIndexes(lines, beforeLines, cursor, requireEndOfFile);
  if (fromCursor.length > 0) {
    return fromCursor[0];
  }

  const fromStart = findMatchIndexes(lines, beforeLines, 0, requireEndOfFile);
  if (fromStart.length === 1) {
    return fromStart[0];
  }

  return -1;
}

function formatChunkLabel(chunk: CodexPatchChunk): string {
  return chunk.header ? ` (${chunk.header})` : '';
}

function formatLineForError(value: string | undefined): string {
  return JSON.stringify(value ?? '[missing]');
}

function findClosestChunkWindow(
  lines: string[],
  beforeLines: string[],
  cursor: number,
): { startIndex: number; matchedLines: number } | null {
  if (beforeLines.length === 0 || lines.length === 0) {
    return null;
  }

  let bestStartIndex = -1;
  let bestMatchedLines = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  const maxStart = Math.max(lines.length - 1, 0);

  for (let startIndex = 0; startIndex <= maxStart; startIndex += 1) {
    let matchedLines = 0;
    for (let offset = 0; offset < beforeLines.length; offset += 1) {
      if (lines[startIndex + offset] === beforeLines[offset]) {
        matchedLines += 1;
      }
    }

    const distance = Math.abs(startIndex - cursor);
    if (
      matchedLines > bestMatchedLines
      || (matchedLines === bestMatchedLines && distance < bestDistance)
    ) {
      bestStartIndex = startIndex;
      bestMatchedLines = matchedLines;
      bestDistance = distance;
    }
  }

  if (bestStartIndex < 0 || bestMatchedLines <= 0) {
    return null;
  }

  return {
    startIndex: bestStartIndex,
    matchedLines: bestMatchedLines,
  };
}

function buildChunkMismatchDetails(
  lines: string[],
  beforeLines: string[],
  cursor: number,
): string {
  const closestWindow = findClosestChunkWindow(lines, beforeLines, cursor);
  if (!closestWindow) {
    const preview = beforeLines
      .slice(0, 3)
      .map((line) => `  ${formatLineForError(line)}`)
      .join('\n');
    return ` Expected exact lines:\n${preview}`;
  }

  const { startIndex, matchedLines } = closestWindow;
  let firstDifferingOffset = 0;
  while (
    firstDifferingOffset < beforeLines.length
    && lines[startIndex + firstDifferingOffset] === beforeLines[firstDifferingOffset]
  ) {
    firstDifferingOffset += 1;
  }

  const snippetLength = Math.min(
    Math.max(beforeLines.length, 1),
    Math.max(lines.length - startIndex, 0),
  );
  const nearbyLines = lines
    .slice(startIndex, startIndex + snippetLength)
    .map((line, offset) => `  ${startIndex + offset + 1} | ${line}`)
    .join('\n');

  const expectedLine = beforeLines[firstDifferingOffset];
  const actualLine = lines[startIndex + firstDifferingOffset];

  return [
    ` Closest match starts at line ${startIndex + 1} with ${matchedLines}/${beforeLines.length} exact lines matched.`,
    ` First differing line expected ${formatLineForError(expectedLine)} but found ${formatLineForError(actualLine)}.`,
    ' Nearby file lines:',
    nearbyLines || '  [no nearby lines available]',
  ].join('\n');
}

export function applyCodexPatchToText(
  currentText: string,
  chunks: CodexPatchChunk[],
): string {
  const document = splitDocument(currentText);
  let lines = [...document.lines];
  let cursor = 0;

  for (const chunk of chunks) {
    const beforeLines = chunk.lines
      .filter((line) => line.kind !== 'add')
      .map((line) => line.text);
    const afterLines = chunk.lines
      .filter((line) => line.kind !== 'remove')
      .map((line) => line.text);

    const startIndex = findChunkStart(lines, beforeLines, cursor, chunk.endOfFile);
    if (startIndex < 0) {
      throw new Error(
        `Failed to locate patch chunk${formatChunkLabel(chunk)} in target file.${buildChunkMismatchDetails(lines, beforeLines, cursor)}`,
      );
    }

    lines = [
      ...lines.slice(0, startIndex),
      ...afterLines,
      ...lines.slice(startIndex + beforeLines.length),
    ];
    cursor = startIndex + afterLines.length;
  }

  return renderDocument({
    lines,
    endsWithNewline: document.endsWithNewline,
  });
}

function cloneSnapshot(snapshot: CodexPatchFileSnapshot | undefined): CodexPatchFileSnapshot {
  if (!snapshot) {
    return { kind: 'missing' };
  }

  if (snapshot.kind === 'file') {
    return {
      kind: 'file',
      content: snapshot.content ?? '',
      mode: snapshot.mode,
    };
  }

  return { kind: snapshot.kind };
}

function getSnapshot(
  state: Map<string, CodexPatchFileSnapshot>,
  path: string,
): CodexPatchFileSnapshot {
  return cloneSnapshot(state.get(path));
}

function requireFileSnapshot(snapshot: CodexPatchFileSnapshot, path: string, verb: string): {
  content: string;
  mode: number;
} {
  if (snapshot.kind === 'missing') {
    throw new Error(`Cannot ${verb} "${path}": path does not exist.`);
  }
  if (snapshot.kind !== 'file') {
    throw new Error(`Cannot ${verb} "${path}": expected a file, found ${snapshot.kind}.`);
  }

  return {
    content: snapshot.content ?? '',
    mode: typeof snapshot.mode === 'number' ? snapshot.mode : DEFAULT_FILE_MODE,
  };
}

function ensureMissing(snapshot: CodexPatchFileSnapshot, path: string, verb: string): void {
  if (snapshot.kind === 'missing') {
    return;
  }

  throw new Error(`Cannot ${verb} "${path}": path already exists as ${snapshot.kind}.`);
}

function renderAddedFile(lines: string[]): string {
  return renderDocument({
    lines,
    endsWithNewline: true,
  });
}

export function planCodexPatchApplication(
  operations: CodexPatchOperation[],
  snapshots: Record<string, CodexPatchFileSnapshot>,
): CodexPatchFilePlan {
  const state = new Map<string, CodexPatchFileSnapshot>();
  for (const [path, snapshot] of Object.entries(snapshots)) {
    state.set(path, cloneSnapshot(snapshot));
  }

  for (const path of listCodexPatchPaths(operations)) {
    if (!state.has(path)) {
      state.set(path, { kind: 'missing' });
    }
  }

  for (const operation of operations) {
    switch (operation.kind) {
      case 'add': {
        ensureMissing(getSnapshot(state, operation.path), operation.path, 'add');
        state.set(operation.path, {
          kind: 'file',
          content: renderAddedFile(operation.lines),
          mode: DEFAULT_FILE_MODE,
        });
        break;
      }
      case 'delete': {
        requireFileSnapshot(getSnapshot(state, operation.path), operation.path, 'delete');
        state.set(operation.path, { kind: 'missing' });
        break;
      }
      case 'update': {
        const sourceSnapshot = getSnapshot(state, operation.path);
        const { content, mode } = requireFileSnapshot(sourceSnapshot, operation.path, 'update');
        const nextContent = operation.chunks.length > 0
          ? applyCodexPatchToText(content, operation.chunks)
          : content;

        if (operation.moveTo && operation.moveTo !== operation.path) {
          ensureMissing(getSnapshot(state, operation.moveTo), operation.moveTo, `move "${operation.path}" to`);
          state.set(operation.moveTo, {
            kind: 'file',
            content: nextContent,
            mode,
          });
          state.set(operation.path, { kind: 'missing' });
          break;
        }

        state.set(operation.path, {
          kind: 'file',
          content: nextContent,
          mode,
        });
        break;
      }
      default:
        break;
    }
  }

  const allPaths = new Set<string>([
    ...Object.keys(snapshots),
    ...state.keys(),
  ]);

  const writes: CodexPatchFileWrite[] = [];
  const deletes: string[] = [];

  for (const path of [...allPaths].sort()) {
    const initial = snapshots[path] ?? { kind: 'missing' } satisfies CodexPatchFileSnapshot;
    const next = state.get(path) ?? { kind: 'missing' } satisfies CodexPatchFileSnapshot;

    if (next.kind === 'file') {
      const initialContent = initial.kind === 'file' ? initial.content ?? '' : undefined;
      const initialMode = initial.kind === 'file' ? initial.mode : undefined;
      if (
        initial.kind !== 'file'
        || initialContent !== (next.content ?? '')
        || initialMode !== next.mode
      ) {
        writes.push({
          path,
          content: next.content ?? '',
          mode: next.mode,
        });
      }
      continue;
    }

    if (next.kind === 'missing' && initial.kind !== 'missing') {
      deletes.push(path);
    }
  }

  return {
    writes,
    deletes,
  };
}
