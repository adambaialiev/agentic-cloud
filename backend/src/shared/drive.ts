/** Drive's public records never contain object-store paths or author identities. */
/** A Drive file can be up to 1 GB (note #784). Anything bigger than one part
 *  travels in parts (`shared/uploads.ts`). */
export const DRIVE_FILE_MAX_BYTES = 1024 * 1024 * 1024;
/** The one-request upload (`POST …/files`) a CLI from before note #784 still
 *  sends: its body is buffered, so it keeps the old ceiling. */
export const DRIVE_SINGLE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const DRIVE_MAX_ITEMS = 10_000;
/** A document preview is meant to be read on a screen, not to pull a whole
 *  large log or generated data set through the backend and into the DOM. */
export const DRIVE_TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** A folder downloads as one .zip up to this size (note #694). It travels
 *  through the backend rather than straight from storage, so it is bounded. */
export const DRIVE_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export interface DriveItem {
  id: string;
  parentId: string | null;
  kind: 'folder' | 'file';
  name: string;
  sizeBytes: number;
  contentType: string;
  createdAt: string;
  updatedAt: string;
  trashedAt?: string;
}
export interface DriveListing {
  items: DriveItem[];
  folder: DriveItem | null;
  breadcrumbs: DriveItem[];
  totalBytes: number;
  trashCount: number;
  canDeleteForever: boolean;
  maxFileBytes: number;
}
export interface DriveDetail {
  canDeleteForever: boolean;
  item: DriveItem;
  breadcrumbs: DriveItem[];
}
export interface DriveAccess {
  url: string;
  expiresAt: string;
  fileName: string;
  sizeBytes: number;
}

/** What a folder's download will be, asked before the browser is sent for it:
 *  a refusal then is a sentence on the screen, not a failed download. */
export interface DriveArchiveSummary {
  fileName: string;
  sizeBytes: number;
  files: number;
}

export type DrivePreview =
  | { kind: 'image'; url: string; expiresAt: string }
  | { kind: 'pdf'; url: string; expiresAt: string }
  | { kind: 'audio'; url: string; expiresAt: string }
  | { kind: 'video'; url: string; expiresAt: string }
  | { kind: 'markdown'; content: string }
  | { kind: 'text'; content: string }
  | { kind: 'too-large'; maxBytes: number }
  | { kind: 'unsupported' };

export type DrivePreviewKind = Exclude<DrivePreview['kind'], 'too-large'>;

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'heic', 'tif', 'tiff']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'aif', 'aiff']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'ogv']);
/** Formats whose bytes are useful as UTF-8 source even when their MIME type
 *  was unavailable at upload time (the agent upload door sends raw bytes). */
const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'log', 'rst', 'adoc', 'csv', 'tsv',
  'json', 'jsonc', 'json5', 'ndjson', 'xml', 'plist', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env', 'editorconfig',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'vue', 'svelte', 'astro', 'ejs', 'hbs',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'py', 'pyw', 'rb', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx',
  'cs', 'fs', 'php', 'swift', 'lua', 'dart', 'scala', 'pl', 'pm', 'm', 'mm', 'ex', 'exs', 'erl', 'hrl', 'hs', 'clj', 'cljs', 'jl', 'r', 'vb',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'tex', 'proto', 'patch', 'diff', 'tf', 'nix', 'zig', 'sol', 'gradle', 'cmake',
]);
const TEXT_MIME_TYPES = new Set([
  'application/json', 'application/ld+json', 'application/manifest+json',
  'application/javascript', 'application/x-javascript', 'application/xml',
  'application/yaml', 'application/x-yaml', 'application/toml', 'application/sql',
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Decide what the Workspace can show without executing an uploaded
 *  document. HTML and other source formats are text; SVG is only ever put in
 *  an image element. Unknown binaries stay downloads. */
export function drivePreviewKind(item: Pick<DriveItem, 'name' | 'contentType'>): DrivePreviewKind {
  const type = item.contentType.split(';', 1)[0]!.trim().toLowerCase();
  const ext = extensionOf(item.name);
  const lower = item.name.toLowerCase();
  const generic = !type || type === 'application/octet-stream';
  // A known stored type outranks a later rename. Extension fallbacks are for
  // old/generic uploads only; a ZIP renamed to .pdf must remain a download.
  if (type.startsWith('image/') || (generic && IMAGE_EXTENSIONS.has(ext))) return 'image';
  if (type === 'application/pdf' || (generic && ext === 'pdf')) return 'pdf';
  if (type.startsWith('audio/') || (generic && AUDIO_EXTENSIONS.has(ext))) return 'audio';
  if (type.startsWith('video/') || (generic && VIDEO_EXTENSIONS.has(ext))) return 'video';
  if (type === 'text/markdown' || (generic && MARKDOWN_EXTENSIONS.has(ext))) return 'markdown';
  if (type.startsWith('text/') || TEXT_MIME_TYPES.has(type) || (generic && (TEXT_EXTENSIONS.has(ext)
    || /^(dockerfile|makefile|rakefile|gemfile|procfile|justfile)(\..+)?$/.test(lower)))) return 'text';
  return 'unsupported';
}
