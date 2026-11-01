/* eslint-disable react-refresh/only-export-components -- the server entry:
   it exports the route table and the render function, and is never hot
   reloaded. */
import { StrictMode } from 'react';
import { prerender } from 'react-dom/static';
import { StaticRouter } from 'react-router-dom';
import App from './App';
import { CHAPTERS, DOCS_PATH, chapterPath } from './docs/chapters';

// The server half of the site. Vite builds this into dist-ssr/, and
// scripts/prerender.mjs runs it at build time to turn every public route into
// real HTML — see that file for why.
//
// prerenderToNodeStream (React 19), not renderToString: the legal pages are
// lazy() imports, and renderToString would happily emit the Suspense fallback
// instead of waiting for them. The whole point is that a crawler with no
// JavaScript sees the text, so a prerender that stops at the fallback is worse
// than none — it would look like it worked.

export interface RouteMeta {
  /** URL path, and the directory the HTML is written to. */
  path: string;
  title: string;
  description: string;
  /**
   * What the page declares itself to be, when that is not its own URL. Only
   * for a second address serving one page — it points search engines at the
   * real one instead of letting the two compete. Defaults to `path`.
   */
  canonicalPath?: string;
  /** Left out of sitemaps and search results. */
  noindex?: boolean;
  /** A plain-text guide for AI agents about this page's subject, linked from
   *  its <head> as <link rel="alternate" type="text/markdown"> (note #829). */
  agentGuide?: string;
}

// Every page used to inherit the landing's <title> and, worse, its canonical
// URL — which told search engines the rest of the site was a duplicate of the
// homepage and should not be indexed separately.
export const ROUTES: RouteMeta[] = [
  {
    path: '/',
    title: 'Claude Code and Codex agents with git, hosting, storage and email built in — Agentic Cloud Computer',
    description:
      'Everything an agent needs to finish the job. Git with CI/CD, hosting, storage, email, Drive, notes and memory, built in for Claude Code, Codex and OpenCode agents. In your own cloud account, on the plan you already pay for.',
    // Since note #832 the one home page carries the own-cloud offer and its
    // line for an agent, so the guide's alternate link is here.
    agentGuide: '/own-cloud.md',
  },
  {
    // The pitch itself since note #774 (2026-10-18): what stood at / until
    // then, unchanged; / is now the apps and the builders, then a door here.
    path: '/product',
    title: 'Product: Claude Code and Codex agents with git, hosting, storage and email built in — Agentic Cloud Computer',
    description:
      'The whole product. Everything an agent needs to finish the job: git, hosting, storage, email, Drive, notes and memory, built in for Claude Code, Codex and OpenCode agents. In your own cloud account, on the plan you already pay for.',
  },
  {
    // The pitch's old address, kept as a real page rather than a redirect.
    //
    // It was a redirect for about an hour on 2026-08-29, and that taught the
    // lesson: with no file at this path the build stopped emitting one, and
    // the CDN went on serving the LAST one it had — the pre-change page,
    // dead self-serve door and all, for up to the week its cache header
    // allows. A path that has been forwarded into group chats is a path that
    // must keep answering, and the reliable way to replace what a cache holds
    // is to publish something at the same address rather than nothing.
    //
    // Serving the page also beats bouncing: a founder who taps a forwarded
    // link gets the pitch immediately, with no redirect flash and no need for
    // JavaScript. noindex + a canonical pointing home keep the two addresses
    // from competing for the same search result.
    path: '/teams',
    canonicalPath: '/product',
    noindex: true,
    title: 'For teams — run a team of AI agents | Agentic Cloud Computer',
    description:
      'The team pitch now lives on the front page. This address still answers, because the link has been shared.',
  },
  {
    path: '/terms',
    title: 'Terms of Service — Agentic Cloud Computer',
    description:
      'Terms for the shared Workspace: what your organisation brings, what the platform stores, provider costs, acceptable use, human review, and how to leave.',
  },
  {
    path: '/privacy',
    title: 'Privacy Policy — Agentic Cloud Computer',
    description:
      'The precise data split: where agent machines and sites run, platform Workspace records, recent chat retention, encrypted credentials, browser notifications, and deletion.',
  },
  // The entry pages. Each answers one question a search brings someone in
  // with, using the front page's own claims — see src/pages/EntryPages.tsx for
  // why these three and not the twelve retired guides.
  {
    path: '/claude-code-in-the-cloud',
    title: 'Run Claude Code in the cloud — Agentic Cloud Computer',
    description:
      'Run Claude Code with git, hosting, storage, email, notes and memory built in, in your own cloud account, on the Claude plan you already have. What it finishes goes live, and you approve what ships.',
  },
  {
    path: '/codex-in-the-cloud',
    title: 'Run Codex in the cloud — Agentic Cloud Computer',
    description:
      'Run Codex agents with git, hosting, storage, email, notes and memory built in, in your own cloud account, on the ChatGPT plan you already have, in the same Workspace and repositories as your Claude Code agents.',
  },
  {
    path: '/ai-agents-for-your-team',
    title: 'AI agents for your team — Agentic Cloud Computer',
    description:
      'Named agents, one company memory they read before every job, and an approval card in front of every protected change. You run the whole team from one conversation, on your own Claude or ChatGPT plan.',
  },
  // The four phases of AI at work: a section of the front page from
  // 2026-10-04 until note #199 moved it here and told each phase at length.
  {
    path: '/four-phases',
    title: 'The four phases of AI at work — Agentic Cloud Computer',
    description:
      'Chat, connected chat, agents with a computer, and a team of agents working with you. The first three phases made one person faster; the fourth gives that person a team. In your own cloud account, on your own Claude or ChatGPT plan.',
  },
  // Why your own Agentic Cloud runs on Fly, not AWS, Google Cloud or Vercel (note
  // #838), linked from the home page's own-cloud chapter.
  {
    path: '/why-fly',
    title: 'Why your Agentic Cloud runs on Fly, not AWS, Google Cloud or Vercel — Agentic Cloud Computer',
    description:
      'Every agent gets a computer of its own that sleeps when idle and wakes when work arrives. On Fly that comes built in, in one account of yours with one bill. What AWS, Google Cloud and Vercel offer for each need, with sources, and the questions your team will ask.',
  },
  // /own-cloud (note #829) is part of the home page since note #832, and
  // answers with a permanent redirect to / (public/_redirects).
  // The documentation: the contents page and one route per chapter, read
  // off the one chapter list so a chapter cannot exist without an address,
  // a <title>, a description and a sitemap line.
  {
    path: DOCS_PATH,
    title: 'Documentation — Agentic Cloud Computer',
    description:
      'How the Workspace works, chapter by chapter: agents and their machines, notes and knowledge, repositories and proposals, sites, secrets, email, your workplace, the cloud your agents run on and the subscriptions you bring.',
  },
  ...CHAPTERS.map((chapter) => ({
    path: chapterPath(chapter),
    title: `${chapter.title} — Documentation — Agentic Cloud Computer`,
    description: chapter.description,
  })),
  // An internal preview of the social card, not a page anyone should find in
  // search results.
  {
    path: '/og-preview',
    title: 'Social card preview — Agentic Cloud Computer',
    description: 'Internal preview of the Open Graph image.',
    noindex: true,
  },
];

/** The chapters, for llms.txt: slug, title and description only. */
export const DOCS = CHAPTERS.map(({ slug, title, description }) => ({ slug, title, description }));

export async function render(url: string): Promise<string> {
  const { prelude } = await prerender(
    <StrictMode>
      <StaticRouter location={url}>
        <App />
      </StaticRouter>
    </StrictMode>,
  );

  // The web-stream variant, read through a reader rather than the Node-stream
  // variant read with for-await: this file is compiled by the browser-facing
  // tsconfig, which has no @types/node, and Node has had web streams as
  // globals since 18. Same output either way.
  const reader = prelude.getReader();
  const decoder = new TextDecoder();
  let html = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}
