/**
 * What a file IS, as a glyph and a hue — ported from the legacy page's
 * `fileIcon` / `fileExt` / `bytes` / `safeFileName` so both shells put the
 * same mark on the same file.
 *
 * One vocabulary on purpose: the chat's attachment rows and (when slice 7
 * lands) the repository tree read this module, rather than each hand-rolling
 * a shorter version that eventually disagrees about `.env`.
 */

import { isAudioFile, isHtmlFile, isInlineImageFile, isMarkdownFile, isPdfFile, isVideoFile } from '../../../src/shared/inline-files.js';
import type { IconName, IconTint } from './icons.js';

const MD_EXT = new Set(['md', 'markdown', 'mdown', 'mkd']);
const PROSE_EXT = new Set(['txt', 'text', 'log', 'rst', 'adoc', 'md', 'markdown', 'mdown', 'mkd', 'csv']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'heic', 'tiff']);
const CODE_EXT = new Set([
  'py', 'pyw', 'rb', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'cxx',
  'hpp', 'hh', 'hxx', 'cs', 'fs', 'php', 'swift', 'lua', 'dart', 'scala',
  'pl', 'pm', 'm', 'mm', 'ex', 'exs', 'erl', 'hrl', 'hs', 'clj', 'cljs', 'jl', 'r',
  'vb', 'gd', 'tex', 'proto', 'patch', 'diff', 'tf', 'nix', 'zig', 'sol',
  'gradle', 'cmake', 'gemfile', 'rakefile',
]);
const JS_EXT = new Set(['js', 'mjs', 'cjs', 'jsx']);
const TS_EXT = new Set(['ts', 'tsx', 'mts', 'cts']);
const WEB_EXT = new Set(['html', 'htm', 'vue', 'svelte', 'astro', 'xml', 'plist', 'ejs', 'hbs']);
const STYLE_EXT = new Set(['css', 'scss', 'sass', 'less', 'styl']);
const SHELL_EXT = new Set(['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'makefile', 'justfile', 'procfile']);
const CONFIG_EXT = new Set(['yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env', 'editorconfig']);
const DB_EXT = new Set(['sql', 'db', 'sqlite', 'sqlite3']);
const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar']);
const SECRET_EXT = new Set(['pem', 'key', 'crt', 'cert', 'cer', 'p12', 'pfx', 'keystore']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2', 'eot']);

export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export interface FileKind { glyph: IconName; tint: IconTint }

/** Whole names that outrank their own extension: package-lock.json is a lock
 *  before it is JSON, and .env is a credential before it is a config. */
const NAMED: ReadonlyArray<[RegExp, FileKind]> = [
  [/^\.env(\..+)?$/, { glyph: 'key', tint: 'secret' }],
  [/\.lock$|-lock\.(json|ya?ml)$/, { glyph: 'lock', tint: '' }],
  [/^\.git[a-z]*$/, { glyph: 'git', tint: 'web' }],
  [/^dockerfile(\..+)?$|^\.dockerignore$|^(docker-)?compose\.ya?ml$/, { glyph: 'box', tint: 'ts' }],
];

export function fileIcon(name: string): FileKind {
  const lower = String(name ?? '').toLowerCase();
  for (const [pattern, kind] of NAMED) if (pattern.test(lower)) return kind;
  const key = fileExt(lower) || lower;
  if (IMAGE_EXT.has(key)) return { glyph: 'image', tint: 'media' };
  // A PDF is a DOCUMENT here, not the generic file it used to be: it is the
  // one non-picture the Workspace opens itself (note #403), so the row that
  // names it should not wear the glyph of a thing nobody can look at.
  if (key === 'pdf') return { glyph: 'filetext', tint: 'doc' };
  if (VIDEO_EXT.has(key)) return { glyph: 'video', tint: 'media' };
  if (AUDIO_EXT.has(key)) return { glyph: 'audio', tint: 'media' };
  if (FONT_EXT.has(key)) return { glyph: 'font', tint: 'media' };
  if (SECRET_EXT.has(key)) return { glyph: 'key', tint: 'secret' };
  if (key === 'json' || key === 'jsonc' || key === 'json5') return { glyph: 'filejson', tint: 'js' };
  if (CONFIG_EXT.has(key)) return { glyph: 'sliders', tint: 'doc' };
  if (DB_EXT.has(key)) return { glyph: 'database', tint: 'code' };
  if (ARCHIVE_EXT.has(key)) return { glyph: 'archive', tint: 'doc' };
  if (SHELL_EXT.has(key)) return { glyph: 'terminal', tint: 'shell' };
  if (JS_EXT.has(key)) return { glyph: 'filecode', tint: 'js' };
  if (TS_EXT.has(key)) return { glyph: 'filecode', tint: 'ts' };
  if (WEB_EXT.has(key)) return { glyph: 'filecode', tint: 'web' };
  if (STYLE_EXT.has(key)) return { glyph: 'filecode', tint: 'style' };
  if (MD_EXT.has(key)) return { glyph: 'filetext', tint: 'doc' };
  if (PROSE_EXT.has(key)) return { glyph: 'filetext', tint: '' };
  if (CODE_EXT.has(key)) return { glyph: 'filecode', tint: 'code' };
  return { glyph: 'file', tint: '' };
}

/** "512 B", "4 KB", "1.2 MB" — a file's size the way a person reads it. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** What a draft's chip says under a file's name: how big it is, and what is
 *  about to happen to it. Two verbs, because sending a message and saving a
 *  note are not the same promise — the screen holding the file supplies its
 *  own. */
export const draftChipMeta = (size: number, going: string) => `${bytes(size)} · ${going}`;

/**
 * The name a picked file travels under. The server sanitizes it again; this
 * is here so the draft on screen shows the name the message will really
 * carry rather than one the upload then changes underneath it.
 */
export function safeFileName(raw: string): string {
  const source = String(raw ?? '');
  const dot = source.lastIndexOf('.');
  const stem = dot > 0 ? source.slice(0, dot) : source;
  let ext = dot > 0 ? source.slice(dot).replace(/[^A-Za-z0-9.]/g, '').toLowerCase() : '';
  // An "extension" with no letters in it ("....") is not one.
  if (!/[a-z0-9]/.test(ext)) ext = '';
  const tamed = stem.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.-]+|[_.-]+$/g, '').slice(0, 80);
  return (tamed || 'file') + ext;
}

/**
 * What a browser is allowed to open rather than save, under the names the
 * screens already call them by. The rule itself lives in
 * `src/shared/inline-files.ts`, shared with the backend routes that sign the
 * read URL: the shell frames a PDF only if the backend signed it `inline`,
 * and the backend signs it `inline` only for what the shell will frame.
 */
export {
  isInlineImageFile as isInlineImage, isPdfFile as isInlinePdf, isHtmlFile as isInlineHtml, isMarkdownFile as isMarkdown,
  isVideoFile as isVideo, isAudioFile as isAudio,
};

/**
 * Token counts at the scale a context window lives on: thousands and
 * millions. "1M", not "1.0M"; "1.2M" when the fraction is doing work.
 */
export function compactTokens(n: number): string {
  if (!(n > 0)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  // A week of an agent's cache reads passes a billion; a window never does.
  if (n >= 1_000_000_000) {
    const billions = n / 1_000_000_000;
    return `${billions < 10 && billions % 1 >= 0.05 ? billions.toFixed(1) : Math.round(billions)}B`;
  }
  const millions = n / 1_000_000;
  return `${millions < 10 && millions % 1 >= 0.05 ? millions.toFixed(1) : Math.round(millions)}M`;
}

/** 4096 → "4 GB", 512 → "512 MB". A machine's size, the way it is sold. */
export function memory(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`;
}
