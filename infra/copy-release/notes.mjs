/**
 * A release's "What's new" (note #1006): one plain-language file per
 * release, infra/copy-release/notes/<version>.md, written for a company's
 * admin — what they will see or can do, never file names or proposal
 * numbers. Its shape:
 *
 *   # <one-line title: the release's summary in /releases>
 *   ## What's new
 *   ## Fixed
 *   ## Needs you        (anything the admin must do after the upgrade)
 *
 * build.sh refuses to cut a release whose notes are missing or out of shape
 * (`node infra/copy-release/notes.mjs check <version>`), and packs the file
 * into the release image as notes.md. The update service reads it from
 * there, or, for releases cut before notes existed, from its own deploy.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const NOTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notes');
export const NOTES_SECTIONS = ["What's new", 'Fixed', 'Needs you'];
const VERSION = /^\d{4}\.\d{2}\.\d{2}\.\d{1,3}$/;

/** Why the notes text is out of shape, or null when it is right. */
export function notesProblem(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const first = lines.find((line) => line.trim()) ?? '';
  if (!/^# \S/.test(first)) return 'the first line must be the title: "# <what this release brings, in one line>"';
  if (first.length > 160) return 'the title line is longer than 160 characters';
  const heads = lines.filter((line) => /^## /.test(line)).map((line) => line.slice(3).trim());
  if (heads.join('|') !== NOTES_SECTIONS.join('|')) {
    return `the sections must be exactly ${NOTES_SECTIONS.map((name) => `"## ${name}"`).join(', ')}, in that order (found ${heads.length ? heads.map((h) => `"## ${h}"`).join(', ') : 'none'})`;
  }
  for (const name of NOTES_SECTIONS) {
    const at = lines.findIndex((line) => line.trim() === `## ${name}`);
    const next = lines.findIndex((line, i) => i > at && /^## /.test(line));
    const body = lines.slice(at + 1, next < 0 ? undefined : next).join('\n').trim();
    if (!body) return `"## ${name}" is empty: write "- Nothing." when there is nothing`;
  }
  return null;
}

/** The title line: the release's one-line summary. */
export function notesTitle(text) {
  const first = String(text).split('\n').find((line) => line.trim()) ?? '';
  return first.replace(/^#\s+/, '').trim();
}

/** The notes file for `version` in `dir`, checked: { file, text, title } or
 *  { problem } in words. */
export function readNotes(version, dir = NOTES_DIR) {
  if (!VERSION.test(String(version))) return { problem: `"${version}" is not a release version (2026.11.03.0)` };
  const file = path.join(dir, `${version}.md`);
  if (!existsSync(file)) {
    return { problem: `no release notes for ${version}: write infra/copy-release/notes/${version}.md (a title line, then "## What's new", "## Fixed", "## Needs you") in the same proposal that changes VERSION` };
  }
  const text = readFileSync(file, 'utf8');
  const problem = notesProblem(text);
  if (problem) return { problem: `infra/copy-release/notes/${version}.md: ${problem}` };
  return { file, text, title: notesTitle(text) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, version, dir] = process.argv.slice(2);
  if (command !== 'check' || !version) {
    console.error('usage: node infra/copy-release/notes.mjs check <version> [notes-dir]');
    process.exit(2);
  }
  const notes = readNotes(version, dir || NOTES_DIR);
  if (notes.problem) {
    console.error(`refusing to cut ${version}: ${notes.problem}`);
    process.exit(1);
  }
  console.log(notes.file);
}
