/**
 * A unified patch, parsed — the reading half of the legacy `renderDiff`.
 *
 * Pure and separate from the component so the parse is testable on its own
 * and so nothing here ever needs a DOM. The rules are the legacy ones, line
 * for line: `---`/`+++`/`index` are headers only BEFORE the first `@@` of a
 * file, because inside a hunk a removed markdown rule is a `---…` line and
 * must stay a removal rather than vanish as a header. A `diff --git` line
 * always starts the next file — hunk content is always prefixed, so the
 * marker cannot occur mid-hunk.
 */

/** Enough for any reviewable change; a 512 KiB patch would otherwise build
 *  tens of thousands of nodes and hang the browser. */
export const DIFF_LINE_CAP = 4000;

export type DiffLineKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta';

export interface DiffLine { kind: DiffLineKind; text: string }

export interface DiffFile {
  path: string;
  lines: DiffLine[];
  /** Counted as the lines stream past, so a file that hits the cap says how
   *  much of it was rendered rather than claiming a total it never counted. */
  added: number;
  removed: number;
}

export interface ParsedDiff {
  files: DiffFile[];
  /** The cap was reached: the rest of the patch is not on the screen. */
  capped: boolean;
}

export function parseDiff(patch: string): ParsedDiff {
  const files: DiffFile[] = [];
  const lines = patch.replace(/\n$/, '').split('\n');
  let current: DiffFile | null = null;
  let inHunk = false;
  let rendered = 0;
  const startFile = (path: string) => {
    current = { path, lines: [], added: 0, removed: 0 };
    files.push(current);
    inHunk = false;
  };
  for (const line of lines) {
    if (rendered >= DIFF_LINE_CAP) return { files, capped: true };
    if (line.startsWith('diff --git ')) {
      // The b/ side names the file as it will exist after the merge.
      const at = line.lastIndexOf(' b/');
      startFile(at >= 0 ? line.slice(at + 3) : line.slice('diff --git '.length));
      continue;
    }
    if (!current) startFile('');
    const file = current!;
    let kind: DiffLineKind;
    if (!inHunk) {
      if (line.startsWith('@@')) { kind = 'hunk'; inHunk = true; }
      else if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
      else kind = 'meta'; // new/deleted file mode, rename, Binary files differ…
    } else {
      kind = line.startsWith('@@') ? 'hunk'
        : line.startsWith('+') ? 'add'
          : line.startsWith('-') ? 'del'
            : line.startsWith('\\') ? 'meta'
              : 'ctx';
    }
    if (kind === 'add') file.added += 1;
    else if (kind === 'del') file.removed += 1;
    // An empty line still needs a box to stand in, or the row collapses.
    file.lines.push({ kind, text: line === '' ? ' ' : line });
    rendered += 1;
  }
  return { files, capped: false };
}
