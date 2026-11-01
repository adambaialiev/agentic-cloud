import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import { H3, LEAD } from '../components/landing-kit';
import { FOOTER_PITCH } from '../lib/product-copy';
import { CHAPTERS, DOCS_PATH, chapterBySlug, chapterPath } from '../docs/chapters';
import type { DocChapter } from '../docs/model';

/**
 * The documentation: /docs is the contents, /docs/<chapter> is one chapter.
 *
 * It stands on the landing's ground exactly as the legal pages do — the
 * `landing-page` class on <main> maps every colour token to the Workspace's
 * paper palette, and the header and footer take the same `tone="dark"` —
 * so a reader following the footer from the front page to a chapter never
 * wonders whose site they are on (see pages/LegalLayout.tsx for how the
 * legal pages drifted three times before that rule).
 *
 * The shape: a chapter list on the left at desk width, the chapter as a
 * prose column beside it, and the same list folded into a <details> above
 * the words on a phone. Every chapter ends with its reference and a door to
 * the next one, so a reader who starts at the beginning reaches the end
 * without touching the sidebar.
 */

const ROLE_BODY = LEAD; // the landing's 16px body grey, the reading voice

function ChapterList({ current }: { current?: string }) {
  return (
    <ol className="space-y-1">
      {CHAPTERS.map((chapter, index) => {
        const here = chapter.slug === current;
        return (
          <li key={chapter.slug}>
            <a
              href={chapterPath(chapter)}
              aria-current={here ? 'page' : undefined}
              className={`flex gap-3 rounded-lg px-3 py-1.5 type-sm transition-colors ${
                here ? 'bg-panel-soft text-white' : 'text-hint hover:text-white'
              }`}
            >
              <span className="w-5 shrink-0 tabular-nums text-faint">{index + 1}</span>
              <span>{chapter.title}</span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}

function Frame({ current, children }: { current?: string; children: ReactNode }) {
  return (
    <main className="landing-page min-h-dvh bg-panel text-white" style={{ fontFamily: 'var(--font-ui)' }}>
      <SiteHeader ctaTarget="none" tone="dark" />
      <div className="mx-auto w-full max-w-6xl px-5 pb-24 pt-10 sm:px-8 sm:pt-14 lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-14">
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <details className="docs-contents lg:hidden">
            <summary className="flex cursor-pointer list-none items-center gap-2 type-sm font-semibold text-white">
              Contents
              <span aria-hidden="true" className="docs-contents-mark type-xs text-hint">▾</span>
            </summary>
            <nav aria-label="Chapters" className="mt-3"><ChapterList current={current} /></nav>
          </details>
          <nav aria-label="Chapters" className="hidden lg:block">
            <a href={DOCS_PATH} className="mb-3 block px-3 type-sm font-semibold text-white">Documentation</a>
            <ChapterList current={current} />
          </nav>
        </aside>
        <div className="mt-8 min-w-0 lg:mt-0">{children}</div>
      </div>
      <SiteFooter pitch={FOOTER_PITCH} tone="dark" />
    </main>
  );
}

export function DocsIndex() {
  return (
    <Frame>
      <article className="docs-prose max-w-[720px]">
        <h1 className="type-lg text-white sm:type-xl">Documentation</h1>
        <p className={`mt-6 ${ROLE_BODY}`}>
          Everything the Workspace does, chapter by chapter. Each one shows you the screen and
          says what to do on it, then ends with a short reference of the limits. Start at the
          beginning if the workplace is new; jump to a chapter if you already have one.
        </p>
        {/* The whole item is the door (the owner, 2026-09-24: on a phone the
            title alone was a small target, and a thumb lands on the words
            under it). One link per chapter still, so the test's door list
            reads the same. */}
        <ol className="docs-plain mt-8 space-y-2">
          {CHAPTERS.map((chapter, index) => (
            <li key={chapter.slug}>
              <a
                href={chapterPath(chapter)}
                className="-mx-3 grid grid-cols-[2rem_1fr] gap-x-2 rounded-2xl px-3 py-3 transition-colors hover:bg-panel-soft active:bg-panel-soft"
              >
                <span className="type-md-sm tabular-nums text-faint">{index + 1}</span>
                <span className="block">
                  <h2 className={H3}>{chapter.title}</h2>
                  <p className="mt-1 type-sm text-hint">{chapter.description}</p>
                </span>
              </a>
            </li>
          ))}
        </ol>
      </article>
    </Frame>
  );
}

export function Chapter({ chapter }: { chapter: DocChapter }) {
  const index = CHAPTERS.indexOf(chapter);
  const previous = CHAPTERS[index - 1];
  const next = CHAPTERS[index + 1];
  return (
    <Frame current={chapter.slug}>
      <article className="docs-prose max-w-[760px]">
        <p className="type-sm text-faint">Chapter {index + 1} of {CHAPTERS.length}</p>
        <h1 className="mt-2 type-lg text-white sm:type-xl">{chapter.title}</h1>
        <p className={`mt-6 ${ROLE_BODY}`}>{chapter.lead}</p>

        <nav aria-label="On this page" className="mt-8 rounded-2xl bg-panel-soft px-5 py-4">
          <p className="type-xs font-semibold uppercase tracking-[0.08em] text-faint">On this page</p>
          <ol className="mt-2 columns-1 gap-8 sm:columns-2">
            {chapter.sections.map((section) => (
              <li key={section.id} className="type-sm">
                <a href={`#${section.id}`} className="text-hint hover:text-white">{section.heading}</a>
              </li>
            ))}
            <li className="type-sm"><a href="#reference" className="text-hint hover:text-white">Reference</a></li>
          </ol>
        </nav>

        {chapter.sections.map((section) => (
          <section key={section.id} id={section.id} className="mt-12 scroll-mt-24">
            {/* A step below the chapter's h1 rather than the landing's H2: a
                chapter has eight of these on one page, and at poster size
                each read as a new page beginning. */}
            <h2 className="type-md-lg text-white">{section.heading}</h2>
            <div className={`mt-5 space-y-4 ${ROLE_BODY}`}>{section.body}</div>
            {section.panel}
          </section>
        ))}

        <section id="reference" className="mt-14 scroll-mt-24">
          <h2 className="type-md-lg text-white">Reference</h2>
          <dl className="mt-6 divide-y divide-hint/16">
            {chapter.reference.map((entry) => (
              <div key={entry.term} className="grid gap-1 py-4 sm:grid-cols-[220px_1fr] sm:gap-6">
                <dt className="type-sm font-semibold text-white">{entry.term}</dt>
                <dd className="type-sm text-hint">{entry.text}</dd>
              </div>
            ))}
          </dl>
        </section>

        <nav aria-label="Chapters, previous and next" className="mt-14 flex flex-wrap justify-between gap-6 border-t border-hint/16 pt-8">
          <div>
            {previous ? (
              <a href={chapterPath(previous)} className="group inline-flex items-center gap-2 type-base font-medium text-white">
                <span aria-hidden="true" className="transition-transform group-hover:-translate-x-0.5">←</span>
                {previous.title}
              </a>
            ) : (
              <a href={DOCS_PATH} className="group inline-flex items-center gap-2 type-base font-medium text-white">
                <span aria-hidden="true">←</span>Documentation
              </a>
            )}
          </div>
          <div>
            {next ? (
              <a href={chapterPath(next)} className="group inline-flex items-center gap-2 type-base font-medium text-white">
                {next.title}
                <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
              </a>
            ) : null}
          </div>
        </nav>
      </article>
    </Frame>
  );
}

/** The router's leaf: a known slug is its chapter, an unknown one goes to the contents. */
export default function DocsChapterRoute() {
  const { slug } = useParams();
  const chapter = chapterBySlug(slug);
  if (!chapter) return <Navigate to={DOCS_PATH} replace />;
  return <Chapter chapter={chapter} />;
}
