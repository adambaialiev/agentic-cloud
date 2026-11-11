/**
 * The public pages a crawler can read without running scripts (note #1153,
 * Adam, 11 Nov 2026: the larger fixes of the search report, note #1144).
 *
 * The app catalogue (`/apps`), a public repository (`/acme/site`) and a
 * person's page (`/adam`) are drawn by the Workspace shell in the browser.
 * Until this note every crawler that runs no scripts (GPTBot, ClaudeBot,
 * Bingbot's first pass, a link preview) read the same 668-byte empty page
 * titled "Your workspace". Here the server writes, into that same shell:
 *
 *  - the page's real title (the one the app sets, so nothing changes when
 *    the scripts run), a description, the canonical address, and share tags;
 *  - the page's readable text inside `#root`, from the same public answers
 *    a stranger's browser reads (`api/public/apps`, `api/public/addresses`,
 *    the repository door): nothing that needs a sign-in, nothing a stranger
 *    could not already read.
 *
 * The browser keeps today's behaviour exactly. The text is hidden from any
 * browser that runs scripts (`@media (scripting: enabled)`), and React's
 * `createRoot` replaces everything inside `#root` on its first render, so a
 * visitor sees the shell come up as before. A signed-in person gets the
 * shell unchanged: no reads, no text, the same bytes as before.
 *
 * And an address that is nobody's answers 404 (finding 3): a one-word
 * address no person holds (and, to anyone outside it, a workplace's word,
 * which has no public page), or a repository address nobody may read. The
 * shell is still sent, so the browser still says "Nothing at this address".
 *
 * Everything written here is escaped; a README is rendered by a small
 * markdown reader that builds every element itself and turns raw HTML in
 * the source into text, so nothing a repository holds becomes markup.
 */

import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type {
  WorkspaceAppCatalogueEntry,
  WorkspacePublicPersonAnswer,
} from '../shared/workspace-api.js';
import { parseWorkspaceRoute } from '../shared/workspace-routes.js';
import { isReservedHandle } from '../shared/handles.js';

/** The longest description a search result shows whole (landing-copy-rules,
 *  Search: never over 160). */
export const DESCRIPTION_MAX = 160;

/** What the head of a public page says. */
export interface PublicPageHead {
  title: string;
  description?: string;
  /** The page's own address, absolute, without a query. */
  canonical?: string;
  /** og:type: a person's page is a profile. */
  type?: 'website' | 'profile';
  /** The share picture, absolute, and its words. */
  image?: { url: string; alt: string };
}

/** What the server sends at a public address. `head` and `body` are absent
 *  for a signed-in person, who gets the shell unchanged. */
export interface PublicPage {
  status: 200 | 404;
  head?: PublicPageHead;
  /** The readable text, as HTML, already escaped. */
  body?: string;
}

/** A public repository, as its page shows it to a stranger. */
export interface PublicRepoPageData {
  name: string;
  /** `/acme/site`: the handle and the name. */
  handle: string;
  cloneUrl: string;
  branch: string | null;
  /** The README's first paragraph, as the About strip shows it. */
  description?: string;
  license?: string | null;
  /** The top of the tree, folders first, as names only. */
  entries: Array<{ name: string; type: string }>;
  /** The README's source, when there is one. */
  readme?: { name: string; content: string };
  latest?: { subject: string; at: string; authorName: string };
}

/** What a repository address is to this reader: public (with its page
 *  when asked for), a member's own repository, or nothing. */
export type PublicRepoRead = { kind: 'public'; page?: PublicRepoPageData } | { kind: 'member' } | null;

/**
 * The reads, from the same public doors the browser uses
 * (routes/workspace.ts builds them), so this file never knows storage.
 */
export interface PublicPageReads {
  /** Whether the request carries a live session. */
  signedIn(req: Request): Promise<boolean>;
  /** The catalogue as a stranger reads it; null where it is not public (a
   *  company's own Agentic Cloud, note #1014). */
  apps(): Promise<WorkspaceAppCatalogueEntry[] | null>;
  /** One word: a person, a workplace for one of its own members, or null. */
  address(handle: string, req: Request): Promise<{ kind: 'person'; person: WorkspacePublicPersonAnswer } | { kind: 'workplace' } | null>;
  /** A repository address; `withPage` reads its tree and README too. */
  repo(handle: string, name: string, req: Request, withPage: boolean): Promise<PublicRepoRead>;
}

export interface PublicPageOptions {
  /** `https://agenticcloudcomputer.com`, for the canonical address. */
  origin?: string;
  /** The host the app prints in "nobody at …" (PUBLIC_ADDRESS_HOST). */
  host: string;
  /** The share picture, absolute, and its words; absent on a private copy. */
  image?: { url: string; alt: string };
  /** The product's name, which closes a title and opens the header. */
  brand?: string;
  /** How long a stranger's page is kept, in ms (a crawl comes in bursts). */
  memoMs?: number;
}

// ── Escaping ──

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** One line of text, at most `max` characters, cut at a word with "…". */
export function clip(text: string, max = DESCRIPTION_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

// ── A README, as HTML a crawler reads ──

const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;

/** Inline markdown: code, links (http(s) only; anything else stays its
 *  text), pictures (their words), strong and emphasis. Raw HTML is text. */
export function inlineMarkdown(source: string): string {
  const out: string[] = [];
  let rest = source;
  const pattern = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|<\/?[a-z][^>]*>|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/i;
  while (rest) {
    const match = pattern.exec(rest);
    if (!match) { out.push(emphasis(escapeHtml(rest))); break; }
    if (match.index > 0) out.push(emphasis(escapeHtml(rest.slice(0, match.index))));
    const [whole, , code, alt, , text, href, angle, bare] = match;
    if (code !== undefined) out.push(`<code>${escapeHtml(code.trim())}</code>`);
    else if (alt !== undefined) out.push(alt ? escapeHtml(alt) : '');
    else if (text !== undefined) {
      const inner = inlineMarkdown(text);
      out.push(href && SAFE_URL.test(href) ? `<a href="${escapeHtml(href)}" rel="nofollow">${inner}</a>` : inner);
    } else if (angle || bare) {
      const url = (angle ?? bare)!;
      out.push(`<a href="${escapeHtml(url)}" rel="nofollow">${escapeHtml(url)}</a>`);
    }
    // a raw HTML tag: dropped, its text (outside the tag) stays
    rest = rest.slice(match.index + whole.length);
  }
  return out.join('');
}

/** **strong** and *emphasis*, on text already escaped. */
function emphasis(escaped: string): string {
  return escaped
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1<em>$2</em>');
}

const tableCells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());

/**
 * A markdown document as plain semantic HTML: headings, paragraphs, lists,
 * quotes, tables, code blocks and rules. Enough for a README to be read; not
 * a second renderer of the app's (render/Markdown.tsx draws it there).
 * Headings start at h2: the page's h1 is the repository's name.
 */
export function markdownToHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const fence = /^(```|~~~)/.exec(trimmed);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i += 1; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i += 1) code.push(lines[i]!);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!trimmed) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed);
    if (heading) {
      flush();
      const level = Math.min(6, heading[1]!.length + 1);
      out.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`);
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) { flush(); out.push('<hr>'); continue; }
    if (/^\|/.test(trimmed) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1]!.trim())) {
      flush();
      const head = tableCells(trimmed);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\|/.test(lines[i]!.trim()); i += 1) rows.push(tableCells(lines[i]!));
      i -= 1;
      out.push(`<table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`);
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]!);
      const items: string[] = [];
      let current = [item[2]!];
      for (i += 1; i < lines.length; i += 1) {
        const next = lines[i]!;
        const another = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(next);
        if (another) { items.push(current.join(' ')); current = [another[2]!]; continue; }
        if (next.trim() && /^\s+/.test(next)) { current.push(next.trim()); continue; }
        break;
      }
      items.push(current.join(' '));
      i -= 1;
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((text) => `<li>${inlineMarkdown(text)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^>/.test(trimmed)) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i += 1) quote.push(lines[i]!.trim().replace(/^>\s?/, ''));
      i -= 1;
      out.push(`<blockquote>${markdownToHtml(quote.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^<!--/.test(trimmed)) {
      flush();
      while (i < lines.length && !lines[i]!.includes('-->')) i += 1;
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return out.join('\n');
}

/** Folders first, then files, each alphabetical: the app's own order
 *  (repo-nav.ts orderedEntries), on a copy. */
export function orderedTreeEntries<T extends { name: string; type: string }>(entries: readonly T[]): T[] {
  const rank = (type: string) => (type === 'dir' ? 0 : type === 'submodule' ? 1 : 2);
  return [...entries].sort((a, b) => (rank(a.type) - rank(b.type)) || a.name.localeCompare(b.name));
}

// ── The pages ──

const dateWords = (iso: string | undefined): string => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The header every public page wears, as text: the product, and its doors. */
function header(brand: string, withApps: boolean): string {
  return `<header><nav aria-label="Main"><a href="/">${escapeHtml(brand)}</a>${withApps ? ' · <a href="/apps">Apps</a>' : ''}</nav></header>`;
}

export function appsPage(apps: WorkspaceAppCatalogueEntry[], brand: string): { head: PublicPageHead; body: string } {
  const count = apps.length;
  const sub = `Built and launched here, newest first${count ? ` · ${plural(count, 'app')}` : ''}`;
  const cards = apps.map((app) => {
    let host = app.url;
    try { host = new URL(app.url).host; } catch { /* the url as it is */ }
    const when = dateWords(app.publishedAt);
    const builder = app.builder.handle
      ? `<a href="/${escapeHtml(app.builder.handle)}">${escapeHtml(app.builder.name)}</a>`
      : escapeHtml(app.builder.name);
    return `<article><h2><a href="${escapeHtml(app.url)}">${escapeHtml(app.name)}</a></h2>`
      + `${app.line ? `<p>${escapeHtml(app.line)}</p>` : ''}`
      + `<p>Built by ${builder}${when ? ` · updated ${escapeHtml(when)}` : ''} · <a href="${escapeHtml(app.url)}">${escapeHtml(host)}</a></p></article>`;
  }).join('\n');
  return {
    head: {
      title: `Apps — ${brand}`,
      description: clip(`${count ? `${plural(count, 'app')} built` : 'Apps built'} and launched on ${brand} by people and their agents, newest first: what each one does, who built it, and its link.`),
      type: 'website',
    },
    body: `<main><h1>Apps</h1><p>${escapeHtml(sub)}</p>\n${count ? cards : '<p>Nothing is listed yet. The first app deployed here appears at the top.</p>'}</main>`,
  };
}

export function repoPage(page: PublicRepoPageData, brand: string): { head: PublicPageHead; body: string } {
  const facts = [
    page.license ? `Licence: ${page.license}` : '',
    page.branch ? `Branch: ${page.branch}` : '',
    page.latest ? `Latest commit: ${page.latest.subject}${page.latest.at ? ` (${dateWords(page.latest.at)})` : ''}` : '',
  ].filter(Boolean);
  const entries = page.entries.length
    ? `<h2>Files</h2><ul>${page.entries.map((entry) => `<li>${escapeHtml(entry.name)}${entry.type === 'dir' ? '/' : ''}</li>`).join('')}</ul>`
    : '';
  const readme = page.readme
    ? `<section aria-label="${escapeHtml(page.readme.name)}">${
      /\.(md|markdown|mdown|mkd)$/i.test(page.readme.name) ? markdownToHtml(page.readme.content) : `<pre>${escapeHtml(page.readme.content)}</pre>`
    }</section>`
    : '';
  const fallback = `A public repository on ${brand}: its files, its history and its proposals, readable by anyone. Clone it with git.`;
  return {
    head: {
      title: `${page.name} · Public repository`,
      description: clip(page.description ? `${page.name}: ${page.description}` : fallback),
      type: 'website',
    },
    body: `<main><h1>${escapeHtml(page.name)}</h1>`
      + `<p>Public repository · ${escapeHtml(page.handle)}/${escapeHtml(page.name)}</p>`
      + `${page.description ? `<p>${escapeHtml(page.description)}</p>` : ''}`
      + `${facts.length ? `<ul>${facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join('')}</ul>` : ''}`
      + `<p>Clone: <code>git clone ${escapeHtml(page.cloneUrl)}</code></p>`
      + `<p><a href="/${escapeHtml(page.handle)}/${escapeHtml(page.name)}/commits">History</a> · <a href="/${escapeHtml(page.handle)}/${escapeHtml(page.name)}/proposals">Proposals</a></p>`
      + `${entries}\n${readme}</main>`,
  };
}

/** The app's own short forms (workspace-ui screens/people/board-words.ts). */
function formatHours(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60) return `${Math.round(ms / 3_600_000)}h`;
  return minutes > 0 ? `${minutes}min` : '0h';
}
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return String(Math.round(count));
}

const RUN_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

export function personPage(person: WorkspacePublicPersonAnswer, host: string, brand: string): { head: PublicPageHead; body: string } {
  const repos = person.repos.map((repo) => (
    `<li><a href="${escapeHtml(repo.publicUrl)}">${repo.workplace ? `${escapeHtml(repo.workplace)} / ` : ''}${escapeHtml(repo.name)}</a> · ${plural(repo.commits, 'commit')}</li>`
  )).join('');
  const board = person.board;
  const runs = board?.runs.map((run) => RUN_NAMES[run] ?? run) ?? [];
  const tokens = (numbers: { claude?: number; codex?: number }) => [
    numbers.claude != null ? `<li>Claude Code: ${formatTokens(numbers.claude)} tokens written</li>` : '',
    numbers.codex != null ? `<li>Codex: ${formatTokens(numbers.codex)} tokens written</li>` : '',
  ].join('');
  const week = board
    ? `<h2>This week</h2><p>${escapeHtml(plural(board.agents, 'agent'))}${runs.length ? ` · ${escapeHtml(runs.join(' and '))}` : ''}</p>`
      + `<ul><li>${formatHours(board.week.workingMs)} agent hours</li><li>${escapeHtml(plural(board.week.merged, 'change'))} merged</li>${tokens(board.week)}</ul>`
      + `<h2>All time</h2><ul><li>${formatHours(board.allTime.workingMs)} agent hours</li>${tokens(board.allTime)}</ul>`
    : '';
  const repoNames = person.repos.map((repo) => repo.name);
  const description = [
    `${person.name} builds with AI agents on ${brand}.`,
    board ? `${plural(board.agents, 'agent')}${runs.length ? ` on ${runs.join(' and ')}` : ''}.` : '',
    repoNames.length ? `Public repositories: ${repoNames.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  return {
    head: { title: `${person.name} (${person.handle})`, description: clip(description), type: 'profile' },
    body: `<main><h1>${escapeHtml(person.name)}</h1><p>${escapeHtml(host)}/${escapeHtml(person.handle)}</p>`
      + `${person.x ? `<p><a href="https://x.com/${encodeURIComponent(person.x)}" rel="nofollow">@${escapeHtml(person.x)} on X</a></p>` : ''}`
      + week
      + `${board && !repos ? '' : `<h2>Public repositories</h2>${repos ? `<ul>${repos}</ul>` : '<p>No public repositories yet.</p>'}`}</main>`,
  };
}

export function nothingHerePage(pathname: string, host: string): { head: PublicPageHead; body: string } {
  const where = `${host}${pathname}`;
  return {
    head: { title: where },
    body: `<main><h1>Nothing at this address</h1><p>There is nobody at ${escapeHtml(where)}.</p></main>`,
  };
}

// ── Into the shell ──

/** Hides the crawler's text from any browser that runs the app; React
 *  replaces it on its first render anyway. A browser without scripts reads
 *  it, held to a readable width. */
const CRAWL_STYLE = '<style>#root>[data-public-text]{max-width:760px;margin:32px auto;padding:0 20px;font:16px/1.55 system-ui,sans-serif}'
  + '#root>[data-public-text] pre{white-space:pre-wrap}@media (scripting:enabled){#root>[data-public-text]{display:none}}</style>';

const SHELL_TITLE = /<title>[^<]*<\/title>/i;
const SHELL_ROOT = /<div id="root"><\/div>/i;

/** Whether this shell has the two places a public page is written into. */
export function shellTakesPublicPage(html: string): boolean {
  return SHELL_TITLE.test(html) && SHELL_ROOT.test(html);
}

/** The shell with the page's head and text written in. */
export function injectPublicPage(html: string, page: PublicPage): string {
  if (!page.head || !shellTakesPublicPage(html)) return html;
  const { title, description, canonical, type, image } = page.head;
  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    description ? `<meta name="description" content="${escapeHtml(description)}">` : '',
    canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : '',
  ];
  if (page.status === 200) {
    tags.push(
      `<meta property="og:type" content="${type ?? 'website'}">`,
      `<meta property="og:title" content="${escapeHtml(title)}">`,
      description ? `<meta property="og:description" content="${escapeHtml(description)}">` : '',
      canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}">` : '',
      image ? `<meta property="og:image" content="${escapeHtml(image.url)}">` : '',
      image ? `<meta property="og:image:alt" content="${escapeHtml(image.alt)}">` : '',
      `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
      `<meta name="twitter:title" content="${escapeHtml(title)}">`,
      description ? `<meta name="twitter:description" content="${escapeHtml(description)}">` : '',
      image ? `<meta name="twitter:image" content="${escapeHtml(image.url)}">` : '',
    );
  }
  tags.push(CRAWL_STYLE);
  const head = tags.filter(Boolean).join('\n');
  const body = `<div id="root"><div data-public-text>${page.body ?? ''}</div></div>`;
  // Functions as replacements: a `$` in a README must stay a `$`.
  return html.replace(SHELL_TITLE, () => head).replace(SHELL_ROOT, () => body);
}

export function shellEtag(html: string): string {
  return `"${createHash('sha256').update(html).digest('base64url').slice(0, 27)}"`;
}

// ── Which page, for which address ──

/**
 * What the server sends at `pathname`: null for an address this file does
 * not write (every signed-in screen, the doors, a repository's inner
 * pages), so the shell goes out as before.
 */
export function publicPages(reads: PublicPageReads, options: PublicPageOptions) {
  const brand = options.brand ?? 'Agentic Cloud Computer';
  const memoMs = options.memoMs ?? 60_000;
  const memo = new Map<string, { at: number; page: PublicPage }>();
  const canonicalOf = (pathname: string) => (options.origin ? `${options.origin.replace(/\/+$/, '')}${pathname}` : undefined);
  const remember = (key: string, page: PublicPage): PublicPage => {
    if (memo.size > 500) memo.clear();
    memo.set(key, { at: Date.now(), page });
    return page;
  };

  const build = async (pathname: string, req: Request, signedIn: boolean, plainQuery: boolean): Promise<PublicPage | null> => {
    const route = parseWorkspaceRoute(pathname);
    if (!route) return null;
    if (route.kind === 'apps') {
      if (signedIn) return null;
      const apps = await reads.apps();
      if (!apps) return null;
      const page = appsPage(apps, brand);
      return { status: 200, head: { ...page.head, canonical: canonicalOf(pathname) }, body: page.body };
    }
    if (route.kind === 'person') {
      const handle = route.handle ?? '';
      if (isReservedHandle(handle)) return null;
      const found = await reads.address(handle, req);
      if (!found) {
        const page = nothingHerePage(pathname, options.host);
        return signedIn ? { status: 404 } : { status: 404, ...page };
      }
      if (signedIn || found.kind !== 'person') return { status: 200 };
      // The address the person is known by; `/Adam` and `/adam` are one page.
      const page = personPage(found.person, options.host, brand);
      return { status: 200, head: { ...page.head, canonical: canonicalOf(`/${found.person.handle}`) }, body: page.body };
    }
    if (route.kind === 'workplaceRepo') {
      const handle = route.handle ?? '';
      const name = route.repo ?? '';
      if (isReservedHandle(handle)) return null;
      const withPage = !signedIn && plainQuery;
      const found = await reads.repo(handle, name, req, withPage);
      if (!found) {
        const page = nothingHerePage(pathname, options.host);
        return signedIn ? { status: 404 } : { status: 404, ...page };
      }
      if (found.kind !== 'public' || !found.page) return { status: 200 };
      const page = repoPage(found.page, brand);
      return { status: 200, head: { ...page.head, canonical: canonicalOf(`/${found.page.handle}/${found.page.name}`) }, body: page.body };
    }
    return null;
  };

  return async (pathname: string, query: string, req: Request): Promise<PublicPage | null> => {
    const signedIn = await reads.signedIn(req).catch(() => false);
    const plainQuery = !new URLSearchParams(query).has('path');
    if (signedIn) return build(pathname, req, true, plainQuery);
    const key = `${pathname}?${plainQuery ? '' : 'path'}`;
    const kept = memo.get(key);
    if (kept && Date.now() - kept.at < memoMs) return kept.page;
    const built = await build(pathname, req, false, plainQuery);
    if (!built) return null;
    const page = built.head && built.status === 200 && options.image ? { ...built, head: { ...built.head, image: options.image } } : built;
    return remember(key, page);
  };
}
