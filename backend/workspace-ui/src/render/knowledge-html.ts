/**
 * A knowledge page (and a quick note, and a margin remark — the same HTML by
 * the same rules) turned into elements this app is willing to show.
 *
 * A page arrives as HTML SOURCE and is NEVER handed to innerHTML. Every node
 * on screen is built here from an allowlist that mirrors the one the backend
 * enforces at propose time — belt and braces on purpose: the server refusal is
 * what teaches the agent, and this is what makes a hole in it harmless. The
 * page cannot carry script, cannot carry style, and cannot reach the Workspace
 * session it renders inside.
 *
 * DOM rather than React elements, deliberately. The source names its own tags
 * and attributes, and React's element factory renames a good half of SVG's
 * (`stroke-width`, `viewBox`, `clip-path`) — a translation table between the
 * allowlist and the renderer is one more place for the two to disagree about
 * what is allowed. Built as DOM, an allowed attribute is set under the name it
 * arrived with, in the namespace it belongs to, and the allowlist is the only
 * thing deciding anything. `KnowledgeHtml` mounts what this returns.
 */

import { plainClick } from '../ui/link-click.js';
import { splitNoteRefs, type NoteRefs } from './note-refs.js';

/** Exported so the one place that embeds this markup in something else — a
 *  write-up's HTML runs (`html-runs.ts`) — is held to naming tags this walker
 *  will actually build, rather than growing a second list beside it. */
export const KNOWLEDGE_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup', 'mark', 'abbr',
  'code', 'pre', 'kbd', 'samp', 'var', 'blockquote', 'q', 'cite', 'time',
  'section', 'article', 'aside', 'nav', 'header', 'footer', 'main', 'figure',
  'figcaption', 'div', 'span', 'details', 'summary', 'img',
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'use', 'symbol', 'marker', 'desc',
  'lineargradient', 'radialgradient', 'stop', 'clippath',
]);

const KNOWLEDGE_ATTRS = new Set([
  'lang', 'dir', 'title', 'alt', 'href', 'src', 'width', 'height',
  'colspan', 'rowspan', 'span', 'scope', 'headers', 'datetime', 'cite', 'start',
  'reversed', 'open', 'loading',
  'viewbox', 'xmlns', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity',
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points',
  'transform', 'text-anchor', 'dominant-baseline', 'font-size', 'font-weight',
  'preserveaspectratio', 'offset', 'stop-color', 'stop-opacity', 'gradientunits',
  'clip-path', 'marker-end', 'marker-start', 'refx', 'refy', 'orient',
  'markerwidth', 'markerheight', 'patternunits',
]);

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Where a note reference must stay ink: inside another link, inside code,
 *  and anywhere in a drawing. */
const NO_REFS = new Set(['a', 'code', 'pre', 'kbd', 'samp']);

/** A link this app will follow. Anything else — `javascript:` above all — is
 *  dropped and the text stays: a page never becomes a live target. */
export function knowledgeUrlOk(attr: string, value: string): boolean {
  const url = String(value || '').trim().replace(/\s+/g, '').toLowerCase();
  if (!url) return false;
  if (url.charAt(0) === '#' || url.charAt(0) === '/' || url.slice(0, 2) === './' || url.slice(0, 3) === '../') return true;
  if (url.slice(0, 8) === 'https://' || url.slice(0, 7) === 'http://' || url.slice(0, 7) === 'mailto:') return true;
  return attr === 'src' && /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/.test(url);
}

/**
 * The file a page's own `src` names — `files/chart.png` → `chart.png` — or
 * null for anything else (notes #10/#18).
 *
 * ONE shape and no other. No traversal, no folders, no query: the name
 * addresses a file ON this page, and a `src` that does not resolve to one of
 * those is not turned into a request — it is dropped, exactly as every other
 * unrecognised URL here already is.
 */
export function knowledgeFileRef(value: string): string | null {
  const raw = String(value || '').trim();
  if (raw.slice(0, 6) !== 'files/') return null;
  const name = raw.slice(6);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : null;
}

export interface KnowledgeRenderOptions {
  /** The page's own attachments as name → short-lived URL, for
   *  `<img src="files/chart.png">`. */
  files?: Record<string, string> | null;
  /** Keep non-text media out of a list-row preview before it loads. */
  compact?: boolean;
  /**
   * WHAT TO DO WITH ONE `<img>` SOMEBODY ELSE WROTE (note #509, slice 10).
   *
   * Given the source element — attributes and all, the `style` this walker is
   * about to refuse included — it answers the URL to draw, or null to drop
   * the picture and everything about it. Mail is what asks: a picture that
   * travelled inside the message becomes a read of our own storage, a remote
   * one is drawn only when its reader has asked for it and only through our
   * proxy, and a tracking pixel is refused whichever it is.
   *
   * Asked BEFORE any attribute is copied, for the reason `compact` skips
   * images before copying `src`: a detached `<img>` can start downloading the
   * moment that attribute lands, even if the element is dropped afterwards.
   */
  image?: (element: Element) => string | null;
  /** What a picture the page carries does when tapped. Absent leaves it a
   *  plain image, which is what a margin remark's picture is. */
  onImage?: (url: string, name: string) => void;
  /** A page nearly always opens with an `<h1>` of its own title, and the
   *  screen showing it is already titled with that; printed twice it reads as
   *  a rendering fault. Only an exact match, and only the first node — a page
   *  whose first heading says something else is saying something else. */
  dropTitle?: string;
  /**
   * A NOTE's title IS its own first line, so the repeat to drop may be a bare
   * paragraph: a note typed in the Workspace has no headings at all
   * (`textToSafeHtml` makes plain paragraphs), and so does an agent's
   * `note add "Call the plumber back"`. Both printed their title twice while
   * this looked at headings alone.
   *
   * The exactness is still the guard. A long title is CUT (it ends in an
   * ellipsis), so anything short of an exact match means the heading is not
   * showing the reader that line, and dropping it would hide written words.
   */
  titleIsFirstLine?: boolean;
  /** Given by a screen that wants "note #284" inside these words to be a door
   *  to note 284 (notes #263/#284). The words themselves are untouched: the
   *  run is split, and the piece that names a note becomes an anchor around
   *  exactly the characters that were written. */
  noteRefs?: NoteRefs;
}

/** One text run, with the notes it names turned into real links. */
function appendWords(into: Element, text: string, notes: NoteRefs): void {
  for (const part of splitNoteRefs(text)) {
    const at = part.number === undefined ? null : notes.link(part.number);
    if (!at) { into.append(part.text); continue; }
    const number = part.number!;
    const link = document.createElement('a');
    link.className = 'noteref';
    link.setAttribute('href', at.href);
    link.textContent = part.text;
    // A real address, followed in-app: the browser keeps copy, long-press and
    // open-in-a-new-tab, and a plain tap moves the shell rather than
    // reloading the whole Workspace to land two screens away.
    link.addEventListener('click', (event) => {
      if (!plainClick(event)) return;
      event.preventDefault();
      notes.open(number);
    });
    into.append(link);
  }
}

/**
 * `refs` is what the words in THIS branch may become. It travels down rather
 * than being read off the immediate parent: the emphasis inside a link is
 * still inside that link, and an anchor within an anchor is not a thing.
 */
function walk(source: Node, into: Element, svg: boolean, options: KnowledgeRenderOptions, refs: NoteRefs | null): void {
  for (const node of Array.from(source.childNodes)) {
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? '';
      if (refs) appendWords(into, text, refs);
      else into.append(text);
      continue;
    }
    if (node.nodeType !== 1) continue;              // comments and the rest: gone
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (!KNOWLEDGE_TAGS.has(tag)) continue;         // and so is everything in it
    // A list-row preview is words, not a gallery. Do this BEFORE copying src:
    // a detached <img> can start downloading the moment that attribute lands,
    // even if the empty element is removed before the row is attached.
    if (options.compact && (tag === 'svg' || (tag === 'img' && !options.image))) continue;
    // And when a caller decides pictures one by one, the decision is made
    // here — before `src`, for the same reason. `null` drops the element.
    const decided = tag === 'img' && options.image ? options.image(element) : undefined;
    if (decided === null) continue;
    const inSvg = svg || tag === 'svg';
    // SVG must be created in its own namespace or the browser lays out an
    // unknown inline element and draws nothing at all.
    const built = inSvg
      ? document.createElementNS(SVG_NS, element.tagName)
      : document.createElement(tag);
    let imageUrl = '';
    let imageName = '';
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      // `on*` and `style` are refused by name before the list is consulted:
      // they are the two that matter, and naming them here says so.
      if (name.slice(0, 2) === 'on' || name === 'style') continue;
      const key = name === 'xlink:href' ? 'href' : name;
      if (!KNOWLEDGE_ATTRS.has(key)) continue;
      if (key === 'src' && decided !== undefined) {
        // The decider's answer, and never the source's own address: an `img`
        // it allowed is drawn from the URL IT named.
        built.setAttribute(attr.name, decided);
        continue;
      }
      if (key === 'src') {
        // A page pointing at its own file: swapped for the short-lived URL the
        // page arrived with. Unresolvable — no such file, or a backend with no
        // file store — and the attribute is dropped rather than left as a
        // relative path, which the browser would resolve against this app and
        // fetch something that is not a picture.
        const ref = knowledgeFileRef(attr.value);
        if (ref) {
          const url = options.files?.[ref];
          if (!url) continue;
          built.setAttribute(attr.name, url);
          if (tag === 'img') { imageUrl = url; imageName = ref; }
          continue;
        }
      }
      if ((key === 'href' || key === 'src') && !knowledgeUrlOk(key, attr.value)) continue;
      built.setAttribute(attr.name, attr.value);
    }
    // Every link leaves this app, so it opens outside it rather than replacing
    // the Workspace with someone's website and no way back.
    if (tag === 'a' && built.getAttribute('href')) {
      built.setAttribute('target', '_blank');
      built.setAttribute('rel', 'noopener noreferrer');
    }
    // A page's own attached image is not decorative chrome: it is the page's
    // evidence, and a tap opens it at full size.
    if (imageUrl && options.onImage) {
      const open = options.onImage;
      const url = imageUrl;
      const named = imageName || 'Image';
      built.classList.add('openimage');
      built.setAttribute('role', 'button');
      built.setAttribute('tabindex', '0');
      built.setAttribute('aria-label', `Open ${named}`);
      built.addEventListener('click', () => open(url, named));
      built.addEventListener('keydown', (event) => {
        const key = (event as KeyboardEvent).key;
        if (key !== 'Enter' && key !== ' ') return;
        event.preventDefault();
        open(url, named);
      });
    }
    walk(element, built, inSvg, options, inSvg || NO_REFS.has(tag) ? null : refs);
    into.append(built);
  }
}

/** The allowlisted markup of `source`, built into `box`. */
function buildInto(box: HTMLElement, source: string, options: KnowledgeRenderOptions): void {
  const parsed = new DOMParser().parseFromString(String(source || ''), 'text/html');
  walk(parsed.body, box, false, options, options.noteRefs ?? null);
  // Every table gets the same sideways scroller a README's tables get —
  // written by a page author who was not thinking about a 390px screen.
  for (const table of Array.from(box.querySelectorAll('table'))) {
    const wrap = document.createElement('div');
    wrap.className = 'tablewrap';
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

/**
 * The same markup with no page around it, for a run of HTML found inside a
 * write-up (note #317). Nodes rather than a `.kpage` box: those words belong
 * to the markdown container they were written in, and are dressed by it.
 */
export function buildSafeHtmlNodes(source: string, options: KnowledgeRenderOptions = {}): DocumentFragment {
  const box = document.createElement('div');
  buildInto(box, source, options);
  const fragment = document.createDocumentFragment();
  fragment.append(...Array.from(box.childNodes));
  return fragment;
}

/**
 * One page's source, as a detached `.kpage` element. `empty` is the sentence
 * to stand in for a page with nothing in it — the caller's to give, because
 * quick notes are rendered by this same function and are not pages.
 */
export function buildKnowledgeHtml(
  source: string,
  empty?: string,
  options: KnowledgeRenderOptions = {},
): HTMLElement {
  const box = document.createElement('div');
  box.className = 'kpage';
  buildInto(box, source, options);
  const first = box.firstElementChild;
  const repeatable = options.titleIsFirstLine ? /^(H[1-6]|P)$/ : /^H1$/;
  const repeated = Boolean(options.dropTitle) && Boolean(first) && repeatable.test(first!.tagName)
    && (first!.textContent ?? '').trim() === options.dropTitle!.trim();
  if (repeated) first!.remove();
  // A document that was ONLY its own title is not empty — the screen's
  // heading is showing every word of it, which is why the repeat came out.
  // "This note is empty." under a one-line note would be a second, wrong
  // answer to a question the title already answered.
  if (!box.childNodes.length && !repeated) {
    const line = document.createElement('div');
    line.className = 'empty';
    line.textContent = empty || 'This page is empty.';
    box.append(line);
  }
  return box;
}
