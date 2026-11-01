/**
 * The one definition of "HTML this platform will display": semantic markup, no
 * author CSS, no JavaScript. Two formats are written in it — knowledge pages
 * (docs/agent-knowledge-pages.md) and quick notes (docs/agent-quick-notes.md)
 * — and they share this file rather than each carrying a list, because two
 * allowlists that are meant to be the same are two allowlists that drift.
 *
 * The Workspace styles both with its own typography, in the reader's colour
 * scheme, so anything carrying its own colours reads as broken the moment the
 * reader is in dark mode; and source that is mostly `<style>` is source every
 * agent pays for on every read.
 *
 * This REFUSES rather than strips. A silent sanitiser teaches an agent nothing
 * and lands something subtly unlike what it wrote; an error names the tag and
 * the rule, and the agent fixes it before the owner ever sees it.
 *
 * It is NOT the security boundary. Rendering is sandboxed regardless (the Mini
 * App rebuilds every node from its own allowlist), because a defence that rests
 * on agents following a convention is not one.
 */

/** How one format names itself inside a refusal, so the error reads as prose. */
export interface SafeHtmlLabels {
  /** "a knowledge page" / "a quick note" — mid-sentence, indefinite. */
  one: string;
  /** "Knowledge pages" / "Quick notes" — sentence-initial, plural. */
  many: string;
  /** "page" / "note" — the bare noun. */
  thing: string;
}

/** Exported for the one place that needs to know whether a tag is markup this
 *  platform renders rather than a `<Component>` somebody named in a sentence
 *  — a card quoting a write-up in plain text (note #317). */
export const ALLOWED_TAGS = new Set([
  'html', 'head', 'body', 'title', 'meta',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup', 'mark', 'abbr',
  'code', 'pre', 'kbd', 'samp', 'var', 'blockquote', 'q', 'cite', 'time',
  'section', 'article', 'aside', 'nav', 'header', 'footer', 'main', 'figure',
  'figcaption', 'div', 'span', 'details', 'summary', 'img',
  // Inline SVG: a document may carry a diagram or a chart without JavaScript.
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'use', 'symbol', 'marker', 'desc',
  'lineargradient', 'radialgradient', 'stop', 'clippath',
]);

/** Named because the error for these says something more useful than "not allowed". */
const EXPLAINED_TAGS = new Map<string, (l: SafeHtmlLabels) => string>([
  ['script', (l) => `${l.many} carry no JavaScript — the ${l.thing} is a document, and the Workspace renders it sandboxed.`],
  ['style', (l) => `${l.many} carry no CSS — the Workspace styles them, so they match the app and work in dark mode.`],
  ['link', (l) => `${l.many} load no external stylesheets or resources.`],
  ['iframe', (l) => `${l.many} cannot embed other pages.`],
  ['object', (l) => `${l.many} cannot embed plugins or external objects.`],
  ['embed', (l) => `${l.many} cannot embed plugins or external objects.`],
  ['base', (l) => `${l.many} cannot set a document base URL.`],
  ['form', (l) => `${l.many} are documents — they carry no forms or inputs.`],
  ['input', (l) => `${l.many} are documents — they carry no forms or inputs.`],
  ['button', (l) => `${l.many} are documents — they carry no forms or inputs.`],
  ['canvas', (l) => `${l.many} draw with inline SVG rather than canvas, which needs JavaScript.`],
]);

const ALLOWED_ATTRS = new Set([
  'lang', 'dir', 'id', 'class', 'title', 'alt', 'href', 'src', 'width', 'height',
  'colspan', 'rowspan', 'span', 'scope', 'headers', 'datetime', 'cite', 'start',
  'reversed', 'type', 'value', 'open', 'loading', 'charset', 'name', 'content',
  // SVG geometry and presentation. Presentation attributes are how SVG draws;
  // they style ONE shape and cannot reach the page around it, which is the
  // line the no-CSS rule is actually drawing.
  'viewbox', 'xmlns', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity',
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points',
  'transform', 'text-anchor', 'dominant-baseline', 'font-size', 'font-weight',
  'preserveaspectratio', 'offset', 'stop-color', 'stop-opacity', 'gradientunits',
  'clip-path', 'marker-end', 'marker-start', 'refx', 'refy', 'orient',
  'markerwidth', 'markerheight', 'patternunits',
]);

const URL_ATTRS = new Set(['href', 'src']);

/** A tag, a comment, or a doctype — anything else starting with `<` is not HTML. */
const TAG_RE = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'`=<>]+))?/g;

function attributeValue(raw: string | undefined): string {
  if (raw === undefined) return '';
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * `data:` is refused everywhere except an image source, where the browser
 * renders it in its secure static mode — the same reasoning the git host's
 * explorer already applies to SVG blobs.
 */
function urlError(attr: string, value: string, labels: SafeHtmlLabels): string | null {
  const url = value.trim().replace(/\s+/g, '').toLowerCase();
  if (!url) return null;
  if (url.startsWith('#') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return null;
  if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('mailto:')) return null;
  if (attr === 'src' && /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/.test(url)) return null;
  if (/^[a-z][a-z0-9+.-]*:/.test(url)) {
    return `"${attr}" points at "${value.slice(0, 40)}" — ${labels.many.toLowerCase()} link with https, mailto or an anchor only.`;
  }
  return null;
}

/**
 * The first thing wrong with this markup, or null. First rather than all: an
 * agent fixes one rule and re-runs, and a wall of errors mostly repeats the
 * same misunderstanding.
 */
export function validateSafeHtml(html: string, labels: SafeHtmlLabels): string | null {
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(html))) {
    const tag = match[1]?.toLowerCase();
    // A comment or doctype: nothing to check inside it.
    if (!tag) continue;
    const explained = EXPLAINED_TAGS.get(tag);
    if (explained) return explained(labels);
    if (!ALLOWED_TAGS.has(tag)) {
      return `<${tag}> is not allowed in ${labels.one} — ${labels.many.toLowerCase()} are semantic HTML (headings, lists, tables, links, images, inline SVG).`;
    }
    const attrs = match[2] ?? '';
    ATTR_RE.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_RE.exec(attrs))) {
      const attr = attrMatch[1]!.toLowerCase();
      if (attr === '/') continue;
      if (attr.startsWith('on')) {
        return `"${attr}" on <${tag}> is an event handler — ${labels.many.toLowerCase()} carry no JavaScript.`;
      }
      if (attr === 'style') {
        return `"style" on <${tag}> is not allowed — the Workspace styles ${labels.many.toLowerCase()}, so they match the app and work in dark mode.`;
      }
      // `xlink:href` is the one namespaced attribute worth having (SVG <use>),
      // and it is a URL, so it goes through the same check as href.
      const normalized = attr === 'xlink:href' ? 'href' : attr;
      if (!ALLOWED_ATTRS.has(normalized)) {
        return `"${attr}" on <${tag}> is not an attribute ${labels.many.toLowerCase()} carry.`;
      }
      if (URL_ATTRS.has(normalized)) {
        const error = urlError(normalized, attributeValue(attrMatch[2]), labels);
        if (error) return error;
      }
      if (tag === 'meta' && attr === 'http-equiv') {
        return `${labels.many} carry no http-equiv meta tags.`;
      }
    }
  }
  return null;
}

const ENTITIES = new Map([
  ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'],
  ['&#39;', "'"], ['&apos;', "'"], ['&nbsp;', ' '],
]);

export function decodeHtmlText(value: string): string {
  return value.replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES.get(entity.toLowerCase()) ?? entity).trim();
}

/** The visible words, with every tag removed. For titles, previews and search. */
export function htmlToText(html: string): string {
  // Script and style never reach here (both are refused), but a stray one must
  // not contribute its SOURCE as if it were prose.
  const stripped = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Block ends become spaces so "a</p><p>b" does not read as "ab".
    .replace(/<[^>]*>/g, ' ');
  return decodeHtmlText(stripped).replace(/\s+/g, ' ').trim();
}

/** Plain text as the safest possible HTML — one paragraph per blank-line block. */
export function textToSafeHtml(text: string): string {
  const escape = (value: string) => value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n{2,}/)
    .map((block) => block.split('\n').map((line) => escape(line.trim())).filter(Boolean).join('<br>'))
    .filter(Boolean)
    .map((block) => `<p>${block}</p>`)
    .join('\n');
}

/**
 * Safe HTML back in the plain-text shape produced by {@link textToSafeHtml}.
 *
 * This is deliberately narrower than a general HTML-to-text renderer. It is
 * the value to put back into a text box when the HTML was originally written
 * by one: paragraphs become blank-line-separated blocks and `<br>` becomes a
 * line break. The extra block tags make legacy or hand-written safe markup
 * readable if it ever reaches an editor, without pretending a textarea can
 * preserve its structure.
 */
export function editableTextFromSafeHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/<\/(?:p|li|h[1-6]|div|tr|blockquote|dt|dd|figcaption|summary|pre)\s*>/i)
    .map((block) => decodeHtmlText(block.replace(/<[^>]*>/g, '')))
    .map((block) => block.split('\n').map((line) => line.trim()).join('\n').trim())
    .filter(Boolean)
    .join('\n\n');
}
