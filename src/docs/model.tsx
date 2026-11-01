import type { ReactNode } from 'react';
import { LivePanel } from '../components/live/LiveWorkspace';
import { H3 } from '../components/landing-kit';

/**
 * The public documentation at /docs: one chapter per area of the product,
 * each a guide first and a reference last (the owner, 2026-09-24: "/docs",
 * guide-style but with references, all at once).
 *
 * A chapter is data, not a page: the layout in pages/Docs.tsx draws every
 * chapter the same way, the route table in entry-server.tsx is generated
 * from this list, and the sidebar, the previous/next doors and the sitemap
 * all read the one array in ./chapters.ts. A chapter cannot be reachable
 * from one of those and missing from another.
 *
 * The words follow the same rules as everything else a customer reads —
 * knowledge pages "claims-we-never-make" and "the-product": no price, no
 * Telegram, agents not coworkers, "about three quiet minutes" for sleep,
 * the storage split only by linking /privacy. The FAQ answers in
 * lib/product-copy.ts stay the one copy of each answer; a chapter that makes
 * one of those claims links to the question rather than restating it.
 */
export interface DocSection {
  /** The anchor: /docs/<chapter>#<id>. */
  id: string;
  heading: string;
  body: ReactNode;
  /** A fenced live panel shown after the words (see `Panel`). */
  panel?: ReactNode;
}

export interface DocReference {
  term: string;
  text: ReactNode;
}

export interface DocChapter {
  slug: string;
  /** The h1, and the sidebar label. */
  title: string;
  /** The <title> and meta description: one sentence for a search result. */
  description: string;
  /** One paragraph under the headline. */
  lead: ReactNode;
  sections: DocSection[];
  /** The reference at the end: terms, limits and controls, exact and short. */
  reference: DocReference[];
}

/**
 * A live panel inside a chapter: the Workspace's own component with fixture
 * data, fenced exactly as the landing fences its panels (inert, aria-hidden,
 * a spoken sentence before it). `wide` is the panel's natural width in the
 * prose column; `compact` is the chat-sized reading scale.
 */
export function Panel({ says, size = 'wide', children }: { says: string; size?: 'wide' | 'compact' | 'phone'; children: ReactNode }) {
  return (
    <LivePanel size={size} className="docs-panel mt-6 overflow-hidden rounded-2xl bg-panel-soft p-3 sm:p-4" says={says}>
      {children}
    </LivePanel>
  );
}

/** A door to another chapter, a section, or a page of the site. */
export function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="text-accent-bright underline decoration-accent-bright/40 underline-offset-2 hover:decoration-accent-bright">
      {children}
    </a>
  );
}

/** One screen inside a reference section: its name as the app shows it. */
export function Screen({ children }: { children: ReactNode }) {
  return <h3 className={H3}>{children}</h3>;
}

/** A control's label or a thing typed, set apart from the sentence. */
export function Ui({ children }: { children: ReactNode }) {
  return <span className="text-white font-medium">{children}</span>;
}
