/**
 * The pure half of browsing a repository: how a path becomes a crumb, how a
 * listing is ordered, which file is the README, and the key that says two
 * views are looking at the SAME repository.
 */

import type { WorkspaceRepoTreeEntry } from '../../../../src/shared/workspace-api.js';
import { fileExt } from '../../ui/file-kind.js';

/** Markdown, as the file view and the README picker both count it. */
export const MD_EXT = new Set(['md', 'markdown', 'mdown', 'mkd']);

/** Files read as prose rather than code: they wrap, and they are never
 *  coloured. */
export const PROSE_EXT = new Set([
  'txt', 'text', 'log', 'rst', 'adoc', 'md', 'markdown', 'mdown', 'mkd', 'csv',
]);

/**
 * Which repository a cached answer belongs to. Keyed by workplace AND name,
 * because two workplaces may hold same-named repositories and their rendered
 * state must never be shared (knowledge page "miniapp-navigation"). It was
 * keyed by room too, while there were rooms (note #843).
 */
export function repoContextKey(orgId: string | undefined, name: string): string {
  return [orgId ?? '', name].join('\n');
}

export interface CrumbPart { label: string; target: string }

/**
 * The tappable path crumb the tree and the file view share: the repository's
 * name and every folder above become jumps, and `leaf` — where the reader
 * already is — stays plain text. A null leaf means "the last folder in the
 * path", which is then taken out of the jumps.
 */
export function crumbParts(repoName: string, path: string, leaf: string | null): {
  parts: CrumbPart[];
  here: string;
} {
  const parts: CrumbPart[] = [{ label: repoName, target: '' }];
  const dirs = path ? path.split('/') : [];
  dirs.forEach((name, at) => parts.push({ label: name, target: dirs.slice(0, at + 1).join('/') }));
  const here = leaf === null ? parts.pop()!.label : leaf;
  return { parts, here };
}

/** Folders first, then files, each alphabetical — the order a file browser
 *  trains everyone to expect. Sorted on a COPY. */
export function orderedEntries(entries: readonly WorkspaceRepoTreeEntry[]): WorkspaceRepoTreeEntry[] {
  const rank: Record<WorkspaceRepoTreeEntry['type'], number> = { dir: 0, submodule: 1, symlink: 2, file: 2 };
  return [...entries].sort((a, b) => (rank[a.type] - rank[b.type]) || a.name.localeCompare(b.name));
}

/** GitHub's rule, and the one every repository already follows: a README in
 *  THIS folder, markdown preferred over the plain-text spellings of it. */
export function pickReadme(entries: readonly WorkspaceRepoTreeEntry[]): WorkspaceRepoTreeEntry | null {
  const named = entries.filter((entry) => entry.type === 'file'
    && /^readme(\.(md|markdown|mdown|mkd|txt|rst))?$/i.test(entry.name));
  return named.find((entry) => MD_EXT.has(fileExt(entry.name))) ?? named[0] ?? null;
}

/** The right-hand column of a listing row: a size, or the two kinds of entry
 *  that are a POINTER rather than a file. */
export function entrySide(entry: WorkspaceRepoTreeEntry, bytes: (n: number) => string): string {
  if (entry.type === 'dir') return '';
  if (entry.type === 'submodule') return 'Submodule';
  if (entry.type === 'symlink') return 'Link';
  return bytes(entry.sizeBytes ?? 0);
}

/** "1,204" — the thousands separator the contributor numbers read in. */
export function count(n: number): string {
  return String(Math.max(0, Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The path of the folder a file sits in. */
export function folderOf(filePath: string): string {
  return filePath.split('/').slice(0, -1).join('/');
}

/** The name at the end of a path, or a fallback for an empty one. */
export function leafOf(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? 'File';
}

/** An image the host decoded for us, as a data URL — or null when the parts
 *  are not both there, which is not something to render half of. */
export function imageDataUrl(image: { mime?: string; base64?: string } | undefined): string {
  if (!image?.mime || !image.base64) return '';
  return `data:${image.mime};base64,${image.base64}`;
}
