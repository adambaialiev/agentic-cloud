import { WORKSPACE_ENTRY_PATTERNS, WORKSPACE_LEGACY_SEGMENTS, WORKSPACE_ROUTE_DEFS, parseWorkspaceRoute, workspaceRoutePath } from '../../../src/shared/workspace-routes.js';
/**
 * An agent's write-up, rendered — the legacy page's `renderMarkdown` and
 * `mdInline`, block for block and pattern for pattern.
 *
 * SAFETY, and the whole reason this is a parser rather than a template: every
 * byte of the source becomes a React text child, an element built here, or —
 * where the source is HTML (note #317) — a node the knowledge page's own
 * allowlist walker builds, which is the same sandbox every note and page is
 * already read in. Nothing an agent writes becomes live markup by being
 * assigned as a string: there is no `innerHTML` on either path. Link and
 * image URLs are matched by a pattern that accepts `http(s)://…` only, so
 * `javascript:` can never appear as an href at all. Relative links stay plain
 * text unless the caller opts into registered Workspace destinations.
 *
 * A parsed inline run is `ReactNode[]`, so a caller may put it inside a
 * heading, a cell or a paragraph without re-parsing.
 */

import { useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { HTML_BREAK, HTML_INLINE_PAIR, htmlBlockAt, opensHtmlBlock } from './html-runs.js';
import { buildSafeHtmlNodes } from './knowledge-html.js';
import { splitNoteRefs, type NoteRefs } from './note-refs.js';

/**
 * A run of HTML the source wrote, mounted as the DOM the allowlist walker
 * builds from it. A host element rather than the nodes themselves, because
 * React owns this position in the tree — the same shape `KnowledgeHtml` uses,
 * and nothing is written during render, so the same source always draws the
 * same thing.
 */
function HtmlRun({ source, notes, block }: { source: string; notes?: NoteRefs; block?: boolean }) {
  // Filled through the ref rather than an effect: React attaches it in the
  // commit, so the words are there before the paint that would otherwise show
  // an empty box — and before anything measures the write-up's height.
  const mount = useCallback((node: HTMLElement | null) => {
    if (node) node.replaceChildren(buildSafeHtmlNodes(source, notes ? { noteRefs: notes } : {}));
  }, [source, notes]);
  // A block run stands where a paragraph would; an inline one sits inside the
  // line it was written in, so it cannot be a div.
  return block
    ? <div className="htmlrun" ref={mount} />
    : <span className="htmlrun" ref={mount} />;
}

interface InlinePattern {
  re: RegExp;
  /** `notes` rides along so a pattern that re-parses its own contents — bold,
   *  emphasis, a link's label — keeps (or deliberately drops) the mentions
   *  inside it. */
  make: (match: RegExpExecArray, key: number, notes?: NoteRefs, workspaceLinks?: boolean) => ReactNode;
}

/** An external link opens outside this app rather than replacing
 *  the Workspace with someone's website and no way back. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

/**
 * A registered Workspace destination from an agent's Markdown. The ordinary
 * shape is the relative path the CLI printed. The second shape repairs replies
 * already stored with the model-invented `https://workspace` pseudo-origin
 * from note #441; `note` is the singular spelling in that real reply.
 */
function workspaceLinkTo(raw: string): string | null {
  let href = raw;
  if (href.startsWith('https://workspace/')) {
    const url = new URL(href);
    href = `${url.pathname}${url.search}`;
  }
  const split = href.indexOf('?');
  let pathname = split < 0 ? href : href.slice(0, split);
  const search = split < 0 ? '' : href.slice(split);
  pathname = pathname.replace(/^(\/workspace)?\/note\//, '$1/notes/');
  if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(pathname)) return null;
  // The parser reads the old /workspace prefix as nothing (public-addresses),
  // so a link an agent printed before the move lands on the same place.
  const route = parseWorkspaceRoute(pathname, search);
  return route ? workspaceRoutePath(route) : null;
}

/**
 * The first word of every Workspace address, for spotting one in prose: a
 * registered destination's, an entry door's, an old first word's, and the
 * old `/workspace` prefix itself. `note` is the singular the Workspace
 * Agent once wrote (note #441).
 */
const WORKSPACE_LINK_WORDS = [...new Set([
  'workspace', 'note',
  ...Object.keys(WORKSPACE_LEGACY_SEGMENTS),
  ...WORKSPACE_ENTRY_PATTERNS.map((pattern) => pattern[0]).filter((word): word is string => Boolean(word)),
  ...Object.values(WORKSPACE_ROUTE_DEFS).map((definition) => definition.pattern[0]!),
])].sort((a, b) => b.length - a.length).join('|');

/**
 * The rest of a bare address in prose, after its scheme: it runs to a space
 * or a bracket, and never ENDS on punctuation (note #686). "Live at
 * https://x.agentbuilt.app." is a sentence's full stop, not the address's
 * last byte — taking it opened a page that does not exist. The same trailing
 * marks GitHub leaves out of an autolink, plus quotes; inside the address
 * they are kept, so `?q=a.b` and `/a_b` stay whole.
 */
const BARE_URL_REST = String.raw`[^\s<>()]*[^\s<>().,:;!?'"*_~]`;

const PATTERNS: InlinePattern[] = [
  { re: /`([^`]+)`/, make: (m, key) => <code key={key}>{m[1]}</code> },
  // A matched pair of an inline tag is markup; everything else shaped like a
  // tag stays the words it is (`html-runs.ts`). It comes second so a tag
  // inside a code span is still a code span, and the whole pair goes to the
  // walker at once — the emphasis inside a link is inside that link there,
  // which is a thing this parser's own patterns cannot say.
  {
    re: HTML_INLINE_PAIR,
    make: (m, key, notes) => <HtmlRun key={key} source={m[0]} {...(notes ? { notes } : {})} />,
  },
  { re: HTML_BREAK, make: (_m, key) => <br key={key} /> },
  {
    re: /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/,
    make: (m, key) => <img key={key} src={m[2]} alt={m[1]} />,
  },
  {
    // Opt in only where these addresses belong to the product. Registry
    // round-tripping preserves scope and refuses arbitrary relative targets.
    // It comes before the external-link rule so the bogus `workspace` host
    // cannot remain a dead external door in an old stored reply.
    re: new RegExp(`\\[([^\\]]+)\\]\\(((?:\\/(?:${WORKSPACE_LINK_WORDS})(?:[/?#][^\\s)]*)?|https:\\/\\/workspace\\/[^\\s)]+))\\)`),
    make: (m, key, _notes, workspaceLinks) => {
      if (!workspaceLinks) return m[0];
      const to = workspaceLinkTo(m[2]!);
      return to ? <Link key={key} to={to}>{inline(m[1] ?? '')}</Link> : m[0];
    },
  },
  {
    // A link's own label is not linkified further: one anchor cannot sit
    // inside another, and the author already said where these words lead.
    re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/,
    make: (m, key) => <ExternalLink key={key} href={m[2]!}>{inline(m[1] ?? '')}</ExternalLink>,
  },
  {
    // The same old bad reply may have exposed the invented URL as its label
    // instead of wrapping it in Markdown. Repair that stored shape too.
    re: new RegExp(`(https:\\/\\/workspace\\/${BARE_URL_REST})`),
    make: (m, key, _notes, workspaceLinks) => {
      if (!workspaceLinks) return m[0];
      const to = workspaceLinkTo(m[1]!);
      return to ? <Link key={key} to={to}>{m[1]}</Link> : m[0];
    },
  },
  { re: /\*\*([^*]+)\*\*/, make: (m, key, notes, workspaceLinks) => <strong key={key}>{inline(m[1] ?? '', notes, workspaceLinks)}</strong> },
  { re: /__([^_]+)__/, make: (m, key, notes, workspaceLinks) => <strong key={key}>{inline(m[1] ?? '', notes, workspaceLinks)}</strong> },
  { re: /\*([^*\s][^*]*)\*/, make: (m, key, notes, workspaceLinks) => <em key={key}>{inline(m[1] ?? '', notes, workspaceLinks)}</em> },
  {
    re: new RegExp(`(https?:\\/\\/${BARE_URL_REST})`),
    make: (m, key) => <ExternalLink key={key} href={m[1]!}>{m[1]}</ExternalLink>,
  },
];

/**
 * Plain words, with any note they mention turned into a door to it.
 *
 * Only what no pattern claimed reaches here, which is what keeps a mention
 * inside a code span or a URL exactly as written: those were already taken.
 */
function words(text: string, notes: NoteRefs | undefined, nextKey: () => number): ReactNode[] {
  if (!notes || !text) return text ? [text] : [];
  return splitNoteRefs(text).map((part) => {
    const at = part.number === undefined ? null : notes.link(part.number);
    return at ? <Link className="noteref" key={nextKey()} to={at.to}>{part.text}</Link> : part.text;
  });
}

/** Inline markdown → nodes. The earliest match anywhere in the rest wins, so
 *  a code span containing an asterisk stays a code span. */
function inline(text: string, notes?: NoteRefs, workspaceLinks = false): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  const nextKey = () => { key += 1; return key; };
  while (rest) {
    let best: { pattern: InlinePattern; match: RegExpExecArray } | null = null;
    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(rest);
      if (match && (!best || match.index < best.match.index)) best = { pattern, match };
    }
    if (!best) { out.push(...words(rest, notes, nextKey)); break; }
    if (best.match.index > 0) out.push(...words(rest.slice(0, best.match.index), notes, nextKey));
    out.push(best.pattern.make(best.match, nextKey(), notes, workspaceLinks));
    rest = rest.slice(best.match.index + best.match[0].length);
  }
  return out;
}

const splitRow = (row: string): string[] => row
  .replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

interface ListEntry { indent: number; ordered: boolean; number: number; text: string }

function listEntry(line: string): ListEntry | null {
  const item = LIST_ITEM.exec(line);
  if (!item) return null;
  return {
    // A tab indents as far as four spaces, which is how an editor draws it.
    indent: item[1]!.replace(/\t/g, '    ').length,
    ordered: /\d/.test(item[2]!),
    number: Number.parseInt(item[2]!, 10),
    text: item[3] ?? '',
  };
}

/**
 * Item lines → lists, nested by indentation (note #565). The first line sets
 * the level; a line indented deeper belongs to the item above it, and a line
 * back at (or above) the level is the next item. A change of kind at the same
 * level — a numbered section followed by its bullet details — starts a new
 * list, and keeps the number the author put on its first item; otherwise
 * every one-item <ol> restarts at 1.
 */
function listBlocks(entries: ListEntry[], render: (text: string) => ReactNode[], firstKey = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  while (at < entries.length) {
    const first = entries[at]!;
    const items: { text: string; children: ListEntry[] }[] = [];
    while (at < entries.length) {
      const entry = entries[at]!;
      if (entry.indent > first.indent && items.length) {
        items[items.length - 1]!.children.push(entry);
      } else if (entry.ordered === first.ordered) {
        items.push({ text: entry.text, children: [] });
      } else break;
      at += 1;
    }
    const List = first.ordered ? 'ol' : 'ul';
    out.push(
      <List key={firstKey + out.length} {...(first.ordered && first.number !== 1 ? { start: first.number } : {})}>
        {items.map((item, itemAt) => (
          <li key={itemAt}>
            {render(item.text)}
            {item.children.length ? listBlocks(item.children, render) : null}
          </li>
        ))}
      </List>,
    );
  }
  return out;
}

/** Block-level markdown → the `.md` container the legacy stylesheet dresses. */
export function Markdown({ source, className, notes, workspaceLinks = false }: {
  /** Registered internal links stay in the app. Off for repository/document prose. */
  workspaceLinks?: boolean;
  source: string;
  /** An extra class on the `.md` container, for a caller whose stylesheet
   *  keys on one (the chat's bubbles). The container is the only thing it
   *  can reach: nothing inside is built from anything but the source. */
  className?: string;
  /** Given by a screen that wants "note #284" to be a door to note 284
   *  (notes #263/#284). Absent, a mention stays the words it always was —
   *  which is what a repository's own README gets, where a `#` belongs to
   *  whatever that project numbers. */
  notes?: NoteRefs;
}) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  const key = () => blocks.length;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      index += 1;
      const buffer: string[] = [];
      while (index < lines.length && !lines[index]!.trimStart().startsWith(fence[1]!)) {
        buffer.push(lines[index]!);
        index += 1;
      }
      index += 1;
      // The fence's info string ("```ts") names the language; carried as data,
      // which is plain text and never markup.
      const tag = fence[2]!.trim().split(/\s+/)[0]!.toLowerCase();
      blocks.push(
        <pre key={key()}><code {...(tag ? { 'data-lang': tag } : {})}>{buffer.join('\n')}</code></pre>,
      );
      continue;
    }
    if (!line.trim()) { index += 1; continue; }
    // HTML the author wrote as HTML, before any markdown block is looked for
    // — but AFTER the fence above, so a fenced example of markup is still an
    // example of markup.
    const html = htmlBlockAt(lines, index);
    if (html) {
      blocks.push(<HtmlRun key={key()} source={html.html} block {...(notes ? { notes } : {})} />);
      index = html.next;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push(<hr key={key()} />); index += 1; continue; }
    const heading = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = Math.min(4, heading[1]!.length);
      const Tag = (['h1', 'h2', 'h3', 'h4'] as const)[level - 1]!;
      blocks.push(<Tag key={key()}>{inline(heading[2] ?? '', notes, workspaceLinks)}</Tag>);
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buffer: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]!)) {
        buffer.push(lines[index]!.replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={key()}><p>{inline(buffer.join('\n'), notes, workspaceLinks)}</p></blockquote>);
      continue;
    }
    // GFM pipe table: a header row, then a separator of dashes/colons/pipes.
    const separator = lines[index + 1];
    if (line.includes('|') && separator && /-/.test(separator) && /^[\s|:-]+$/.test(separator)) {
      const head = splitRow(line);
      index += 2;
      const body: string[][] = [];
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim()) {
        body.push(splitRow(lines[index]!));
        index += 1;
      }
      // The table travels inside its own sideways scroller: a wide one is read
      // by dragging it, never by crushing its columns to fit the phone.
      blocks.push(
        <div className="tablewrap" key={key()}>
          <table>
            <thead><tr>{head.map((cell, at) => <th key={at}>{inline(cell, notes, workspaceLinks)}</th>)}</tr></thead>
            <tbody>
              {body.map((row, at) => <tr key={at}>{row.map((cell, cellAt) => <td key={cellAt}>{inline(cell, notes, workspaceLinks)}</td>)}</tr>)}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (LIST_ITEM.test(line)) {
      // Every item line of the list, its sub-items included: a blank line
      // ends the list unless what follows it is an item indented under it —
      // "- a", "", "  - b" is still one list with b inside a (note #565).
      const entries: ListEntry[] = [];
      while (index < lines.length) {
        const next = listEntry(lines[index]!);
        if (next) { entries.push(next); index += 1; continue; }
        let ahead = index;
        while (ahead < lines.length && !lines[ahead]!.trim()) ahead += 1;
        const after = ahead > index && ahead < lines.length ? listEntry(lines[ahead]!) : null;
        if (!after || after.indent <= entries[0]!.indent) break;
        index = ahead;
      }
      blocks.push(...listBlocks(entries, (text) => inline(text, notes, workspaceLinks), key()));
      continue;
    }
    // Paragraph: gather until a blank line or the start of another block.
    const buffer: string[] = [];
    while (index < lines.length && lines[index]!.trim()
      && !/^\s*(#{1,6})\s/.test(lines[index]!) && !/^\s*>/.test(lines[index]!)
      && !/^\s*(```|~~~)/.test(lines[index]!) && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[index]!)
      && !opensHtmlBlock(lines[index]!)) {
      buffer.push(lines[index]!);
      index += 1;
    }
    blocks.push(<p key={key()}>{inline(buffer.join('\n'), notes, workspaceLinks)}</p>);
  }
  return <div className={className ? `md ${className}` : 'md'}>{blocks}</div>;
}
