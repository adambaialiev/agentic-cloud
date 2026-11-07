import type { ReactNode } from 'react';
import { NEW_TAB, useNewTab } from '../lib/new-tab';

/* What a code-reading agent on the home page writes, drawn: its Markdown,
   read strictly, and the files it read, linked to the public code. Shared by
   the guest's own agent (GuestAgent, note #1039) and, until it goes, the
   public guide Hugo (AskTheCode, note #1010), where it was first written. */

/* The public repository's own file view: ?path=<path>&file=1 (the licence
   link of note #959 used the same shape). */
export const ASK_REPO_URL = 'https://agenticcloudcomputer.com/acc/agentic-cloud';
export function repoFileUrl(path: string): string {
  return `${ASK_REPO_URL}?path=${path.split('/').map(encodeURIComponent).join('/')}&file=1`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** An ISO time as the visitor's own HH:MM. */
export function localTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/* ── The answer's Markdown, read strictly ────────────────────────────────
   What a chat agent writes: paragraphs (a single line break stays a line
   break), headings, bulleted and numbered lists nested by indent, pipe
   tables, fenced code, quotes and rules; inline `code`, **bold**, *italic*,
   ~~struck~~ and links to our own address only (note #1051 — until then a
   table or a list written without blank lines ran together into one line).
   The block rules follow the Workspace chat's own renderer
   (backend/workspace-ui/src/render/Markdown.tsx); its HTML runs, pictures and
   links to anywhere are left out on purpose, because a guest's agent writes
   to a stranger's page. Nothing an agent writes becomes markup: every byte is
   a text node or an element built here, and the only href is our own. */
const SAFE_LINK = /^https:\/\/agenticcloudcomputer\.com(\/|$)/;

const INLINE = /\\([\\`*_{}[\]()#+\-.!|~>])|`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\s](?:[^*]*[^*\s])?)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string, newTab: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = new RegExp(INLINE.source, 'g');
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const [, escaped, code, bold, boldUnder, struck, italic, label, href] = match;
    if (escaped !== undefined) {
      out.push(escaped);
    } else if (code !== undefined) {
      out.push(<code key={key++} className="break-words rounded bg-panel-soft px-1 py-px font-mono text-[0.88em]">{code}</code>);
    } else if (bold !== undefined || boldUnder !== undefined) {
      out.push(<strong key={key++} className="font-semibold">{inline(bold ?? boldUnder!, newTab)}</strong>);
    } else if (struck !== undefined) {
      out.push(<s key={key++}>{inline(struck, newTab)}</s>);
    } else if (italic !== undefined) {
      out.push(<em key={key++}>{inline(italic, newTab)}</em>);
    } else if (SAFE_LINK.test(href!)) {
      out.push(
        <a key={key++} href={href} {...(newTab ? NEW_TAB : {})} className="underline decoration-white/35 underline-offset-2 hover:decoration-white">
          {label}
        </a>,
      );
    } else {
      out.push(label!);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Lines of one block, a line break between them (a chat agent means the
 *  breaks it writes). */
function lines(text: string[], newTab: boolean): ReactNode[] {
  return text.flatMap((line, at) => (at ? [<br key={`br${at}`} />, ...inline(line.trim(), newTab)] : inline(line.trim(), newTab)));
}

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const HEADING = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A row's cells: split on every pipe that is not escaped (no lookbehind:
 *  older Safari cannot parse one, and the whole page would go with it). */
function cells(row: string): string[] {
  const out: string[] = [];
  let cell = '';
  const text = row.trim();
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === '\\' && text[at + 1] === '|') { cell += '|'; at += 1; continue; }
    if (char === '|') { out.push(cell); cell = ''; continue; }
    cell += char;
  }
  out.push(cell);
  if (text.startsWith('|')) out.shift();
  if (text.length > 1 && text.endsWith('|') && !text.endsWith('\\|')) out.pop();
  return out.map((part) => part.trim());
}

function startsTable(all: string[], at: number): boolean {
  const next = all[at + 1];
  return all[at]!.includes('|') && next !== undefined && next.includes('-') && TABLE_SEPARATOR.test(next)
    && cells(next).length === cells(all[at]!).length;
}

interface ListEntry { indent: number; ordered: boolean; number: number; text: string[] }

function listEntry(line: string): ListEntry | null {
  const item = LIST_ITEM.exec(line);
  if (!item) return null;
  return {
    indent: item[1]!.replace(/\t/g, '    ').length,
    ordered: /\d/.test(item[2]!),
    number: Number.parseInt(item[2]!, 10),
    text: [item[3] ?? ''],
  };
}

/** Item lines → lists, nested by indent, as the Workspace chat draws them
 *  (note #565): a deeper line belongs to the item above it; a change of kind
 *  at the same level starts a new list that keeps its first number. */
function listBlocks(entries: ListEntry[], newTab: boolean, keyFrom: string, nested = false): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  while (at < entries.length) {
    const first = entries[at]!;
    const items: { text: string[]; children: ListEntry[] }[] = [];
    while (at < entries.length) {
      const entry = entries[at]!;
      if (entry.indent > first.indent && items.length) items[items.length - 1]!.children.push(entry);
      else if (entry.ordered === first.ordered) items.push({ text: entry.text, children: [] });
      else break;
      at += 1;
    }
    const List = first.ordered ? 'ol' : 'ul';
    out.push(
      <List
        key={`${keyFrom}.${out.length}`}
        {...(first.ordered && first.number !== 1 ? { start: first.number } : {})}
        className={`${first.ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5 ${nested ? 'mt-1' : ''}`}
      >
        {items.map((item, itemAt) => (
          <li key={itemAt} className="pl-0.5">
            {lines(item.text, newTab)}
            {item.children.length ? listBlocks(item.children, newTab, `${keyFrom}.${itemAt}`, true) : null}
          </li>
        ))}
      </List>,
    );
  }
  return out;
}

type Align = 'left' | 'right' | 'center' | undefined;

function AnswerTable({ head, align, body, newTab }: { head: string[]; align: Align[]; body: string[][]; newTab: boolean }) {
  // The table scrolls inside its own box, never the page: a phone reads a
  // wide one by dragging it (note #1051). Focusable, so a keyboard can too.
  // No column is crushed below a few words, and a long path in a cell breaks
  // rather than starving its neighbours.
  return (
    <div data-answer-table role="region" aria-label="Table" tabIndex={0} className="w-fit max-w-full overflow-x-auto rounded-lg border border-hint/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      <table className="border-collapse type-sm leading-snug">
        <thead>
          <tr className="bg-panel-soft">
            {head.map((cell, at) => (
              <th key={at} scope="col" style={align[at] ? { textAlign: align[at] } : undefined} className="min-w-[7.5em] px-3 py-2 text-left align-bottom font-semibold">
                {inline(cell, newTab)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowAt) => (
            <tr key={rowAt} className="border-t border-hint/15">
              {head.map((_, at) => (
                <td key={at} style={align[at] ? { textAlign: align[at] } : undefined} className="min-w-[7.5em] px-3 py-2 align-top tabular-nums [&_code]:[overflow-wrap:anywhere]">
                  {inline(row[at] ?? '', newTab)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AnswerText({ text }: { text: string }) {
  const newTab = useNewTab();
  const all = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < all.length) {
    const line = all[index]!;
    const key = blocks.length;
    if (!line.trim()) { index += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      // An unclosed fence runs to the end: a half-written answer still
      // shows its code as code.
      const close = fence[1]!;
      index += 1;
      const code: string[] = [];
      while (index < all.length && !(all[index]!.trimStart().startsWith(close) && !all[index]!.trim().slice(close.length).trim())) {
        code.push(all[index]!);
        index += 1;
      }
      index += 1;
      const lang = fence[2]!.trim().split(/\s+/)[0]!.toLowerCase();
      blocks.push(
        <pre key={key} data-answer-code className="max-w-full overflow-x-auto rounded-lg bg-panel-soft px-3.5 py-2.5 font-mono type-sm leading-snug">
          <code {...(lang ? { 'data-lang': lang } : {})}>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (RULE.test(line)) {
      blocks.push(<hr key={key} className="border-hint/20" />);
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const words = inline(heading[2] ?? '', newTab);
      blocks.push(heading[1]!.length <= 2
        ? <h3 key={key} className="pt-1 type-md-sm font-semibold text-white">{words}</h3>
        : <h4 key={key} className="pt-1 type-base font-semibold text-white">{words}</h4>);
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < all.length && QUOTE.test(all[index]!)) {
        quoted.push(all[index]!.replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={key} className="border-l-2 border-hint/30 pl-3 text-hint">{lines(quoted, newTab)}</blockquote>);
      continue;
    }

    if (startsTable(all, index)) {
      const head = cells(line);
      const align: Align[] = cells(all[index + 1]!).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : undefined;
      });
      index += 2;
      const body: string[][] = [];
      while (index < all.length && all[index]!.includes('|') && all[index]!.trim()) {
        body.push(cells(all[index]!));
        index += 1;
      }
      blocks.push(<AnswerTable key={key} head={head} align={align} body={body} newTab={newTab} />);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      // The list runs on through its sub-items and their wrapped lines; a
      // blank line ends it unless another item of it follows.
      const entries: ListEntry[] = [];
      while (index < all.length) {
        const current = all[index]!;
        const next = listEntry(current);
        if (next) { entries.push(next); index += 1; continue; }
        if (current.trim() && /^\s{2,}\S/.test(current) && !FENCE.test(current)) {
          entries[entries.length - 1]!.text.push(current);
          index += 1;
          continue;
        }
        let ahead = index;
        while (ahead < all.length && !all[ahead]!.trim()) ahead += 1;
        const after = ahead > index && ahead < all.length ? listEntry(all[ahead]!) : null;
        // A blank line between items of one list ("1. a", "", "2. b") is
        // still that list, as it is in any Markdown reader.
        const sameList = after && after.indent === entries[0]!.indent && after.ordered === entries[0]!.ordered;
        if (!after || (after.indent < entries[0]!.indent) || (after.indent === entries[0]!.indent && !sameList)) break;
        index = ahead;
      }
      blocks.push(...listBlocks(entries, newTab, String(key)));
      continue;
    }

    // A paragraph runs until a blank line or the start of any other block.
    const paragraph: string[] = [];
    while (index < all.length) {
      const current = all[index]!;
      if (!current.trim() || FENCE.test(current) || HEADING.test(current) || QUOTE.test(current) || LIST_ITEM.test(current) || RULE.test(current) || startsTable(all, index)) break;
      paragraph.push(current);
      index += 1;
    }
    blocks.push(<p key={key}>{lines(paragraph, newTab)}</p>);
  }
  return <>{blocks}</>;
}

export function FileList({ files, reading = false }: { files: string[]; reading?: boolean }) {
  const newTab = useNewTab();
  return (
    <ol className="grid gap-2.5">
      {files.map((path, index) => {
        const slash = path.lastIndexOf('/');
        const name = path.slice(slash + 1);
        const folder = slash >= 0 ? path.slice(0, slash + 1) : '';
        const now = reading && index === files.length - 1;
        return (
          <li key={path} className="grid grid-cols-[18px_minmax(0,1fr)] items-baseline gap-1.5">
            <span className="type-xs tabular-nums text-hint/70">{index + 1}</span>
            <span className="min-w-0">
              <a
                href={repoFileUrl(path)}
                {...(newTab ? NEW_TAB : {})}
                className={`break-words font-mono type-sm leading-snug underline underline-offset-[3px] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${now ? 'text-hint no-underline' : 'text-white decoration-white/25 hover:decoration-white'}`}
              >
                {name}
                {newTab ? <span className="sr-only"> in {folder || 'the repository'} (opens in a new tab)</span> : null}
              </a>
              {folder ? <span aria-hidden="true" className="block break-words font-mono type-xs leading-snug text-hint/80">{folder}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
