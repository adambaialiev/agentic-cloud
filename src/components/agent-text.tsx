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
   Paragraphs, "- " lists, `code`, **bold** and links to our own address
   only. No raw HTML ever reaches the page: everything is text nodes. */
const SAFE_LINK = /^https:\/\/agenticcloudcomputer\.com(\/|$)/;

function inline(text: string, newTab: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      out.push(<code key={key++} className="rounded bg-panel-soft px-1 py-px font-mono text-[0.88em]">{match[1]}</code>);
    } else if (match[2] !== undefined) {
      out.push(<strong key={key++} className="font-semibold">{match[2]}</strong>);
    } else if (SAFE_LINK.test(match[4])) {
      out.push(
        <a key={key++} href={match[4]} {...(newTab ? NEW_TAB : {})} className="underline decoration-white/35 underline-offset-2 hover:decoration-white">
          {match[3]}
        </a>,
      );
    } else {
      out.push(match[3]);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AnswerText({ text }: { text: string }) {
  const newTab = useNewTab();
  const blocks = text.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, index) => {
        const lines = block.split('\n');
        if (lines.every((line) => /^\s*[-*] /.test(line))) {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {lines.map((line, i) => <li key={i}>{inline(line.replace(/^\s*[-*] /, ''), newTab)}</li>)}
            </ul>
          );
        }
        return <p key={index}>{inline(lines.join(' ').replace(/^#+\s*/, ''), newTab)}</p>;
      })}
    </>
  );
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
