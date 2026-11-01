/**
 * Which stored files a BROWSER is allowed to open rather than save.
 *
 * Shared between the backend routes that sign a read URL and the React shell
 * that decides what to draw, because they are two halves of one rule: the
 * shell frames a document only if the backend signed it `inline`, and the
 * backend signs it `inline` only for what the shell is willing to frame. Written
 * twice, they drift — a file that renders in the chat and downloads on a note
 * is exactly the bug this module exists to make impossible.
 *
 * Pure functions, no runtime dependencies, importable from Node and the
 * browser alike (the rule `workspace-api.ts` states for the types beside it).
 */

/** `application/pdf; charset=x` and `APPLICATION/PDF` are the same claim. */
const bareType = (contentType: string | undefined): string => (
  (contentType ?? '').split(';')[0]!.trim().toLowerCase()
);

/** The header a raw-bytes upload sends because it has nothing truer to say;
 *  the name is the better witness when this is all we were told. */
const GENERIC = 'application/octet-stream';

const extensionOf = (fileName: string | undefined): string => {
  const name = (fileName ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
};

/**
 * Whether a picture can be shown inline. SVG is deliberately excluded: it is
 * a document that can carry script, not a picture.
 */
export function isInlineImageFile(contentType: string | undefined): boolean {
  const type = bareType(contentType);
  return type.startsWith('image/') && type !== 'image/svg+xml';
}

/**
 * Whether a file is a PDF the Workspace will open in its full-screen viewer.
 *
 * The stored content type decides it. The NAME is consulted only when nothing
 * was claimed about the bytes — a `.pdf` attached before this platform
 * recorded types, or one whose uploader sent the generic header — which is
 * the same deference `inferContentType` makes for a picture, and safe for the
 * same reason: the browser obeys the `Content-Type` it is served, so a file
 * that is not really a PDF fails to draw rather than becoming something else.
 */
export function isPdfFile(contentType: string | undefined, fileName?: string): boolean {
  const type = bareType(contentType);
  if (type === 'application/pdf' || type === 'application/x-pdf') return true;
  return (!type || type === GENERIC) && extensionOf(fileName) === 'pdf';
}

/**
 * Whether a file is an HTML page the Workspace will open in its full-screen
 * viewer (note #557) — a report an agent wrote as a page rather than a PDF,
 * which is the shape a table-heavy write-up naturally takes.
 *
 * The same deference to the name as a PDF's, for the same reason: an agent's
 * `attach` sends the generic header, and `inferContentType` already reads
 * `.html` as `text/html` on the way in. What it is NOT is a licence to run:
 * the shell frames a page under a `sandbox` that gives it no origin, and a
 * read URL signed inline points at the media host, never at the Workspace's
 * own origin — the two facts that make opening one safe at all.
 */
export function isHtmlFile(contentType: string | undefined, fileName?: string): boolean {
  const type = bareType(contentType);
  if (type === 'text/html' || type === 'application/xhtml+xml') return true;
  const extension = extensionOf(fileName);
  return (!type || type === GENERIC) && (extension === 'html' || extension === 'htm');
}

/** The names a recording goes by when nothing was claimed about its bytes:
 *  the containers a browser's own player opens. An `.avi` or `.mkv` with no
 *  type stays a download — no player here would open it anyway. */
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac']);

/**
 * Whether a file is a video the chat plays where it was said (note #693) —
 * the clip an agent renders and hands over, which was a name and a download
 * arrow until now. By its stored type, and by its name only when nothing was
 * claimed, as for a PDF.
 */
export function isVideoFile(contentType: string | undefined, fileName?: string): boolean {
  const type = bareType(contentType);
  if (type.startsWith('video/')) return true;
  return (!type || type === GENERIC) && VIDEO_EXTENSIONS.has(extensionOf(fileName));
}

/** Whether a file is a recording the chat plays where it was said (note
 *  #693). The same rule as a video's. */
export function isAudioFile(contentType: string | undefined, fileName?: string): boolean {
  const type = bareType(contentType);
  if (type.startsWith('audio/')) return true;
  return (!type || type === GENERIC) && AUDIO_EXTENSIONS.has(extensionOf(fileName));
}

/**
 * Whether a stored file may be signed for the browser to RENDER — a read URL
 * with an inline disposition — rather than to save.
 *
 * Five kinds and no more: a picture a row draws, a PDF the viewer frames, an
 * HTML page the same viewer frames sandboxed, and a video or a recording a
 * player plays (note #693). Media is the safe end of that list — a browser's
 * only reading of an `audio/` or `video/` body is its own player, which runs
 * nothing, and Drive has signed its previews this way since it shipped.
 * Everything else keeps the save-as disposition it has always had, because
 * this flag is the single place that decides whether a browser is asked to
 * OPEN one of these objects, and a list that grows by accident is how an
 * uploaded document ends up being interpreted instead of downloaded.
 */
export function canServeInline(contentType: string | undefined, fileName?: string): boolean {
  return isInlineImageFile(contentType) || isPdfFile(contentType, fileName) || isHtmlFile(contentType, fileName)
    || isVideoFile(contentType, fileName) || isAudioFile(contentType, fileName);
}

/** The names a Markdown file goes by. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);

/**
 * Whether a file is Markdown the Workspace reads and draws itself (note
 * #677) — the write-up, plan or draft an agent hands over more often than
 * any other document.
 *
 * NOT one of the kinds above, and deliberately absent from `canServeInline`:
 * nothing asks a browser to interpret these bytes. The backend reads the
 * text and hands it over as data, and the shell rebuilds it through its own
 * Markdown renderer, which makes React elements and never assigns markup.
 * So a stored type that says otherwise can only make a file look wrong,
 * never run — and the name is trusted a little further than for a PDF: a
 * `.md` that arrived as `text/plain` is how several phones label one.
 */
export function isMarkdownFile(contentType: string | undefined, fileName?: string): boolean {
  const type = bareType(contentType);
  if (type === 'text/markdown' || type === 'text/x-markdown') return true;
  return (!type || type === GENERIC || type === 'text/plain') && MARKDOWN_EXTENSIONS.has(extensionOf(fileName));
}
