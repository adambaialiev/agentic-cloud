import type { ReactNode } from 'react';
import { NEW_TAB, useNewTab } from '../lib/new-tab';
/**
 * The landing page's design language, in one module.
 *
 * The front page is the Workspace at poster size: its background, its card,
 * its hairline, its text-link doors. The entry pages are the same surface with
 * a narrower job, so they take these from here rather than keeping a second
 * set of numbers that drifts. When the landing moves, they move with it.
 */

/* The page's four voices, each one role off the scale in index.css and nothing
   hand-set beside it. A section heading is set in REGULAR: at 36px and 52px the
   weight is not what makes it a heading, the size is, and semibold at that size
   is the difference between a poster and a shout. Weight comes back for H3,
   which is a card title sitting two inches from its own body copy. */
export const H2 = 'type-lg text-white sm:type-xl';
export const H3 = 'type-md-sm font-semibold text-white';
export const LEAD = 'type-base text-hint';
export const BODY = 'type-sm text-hint';
/* The app's card: its --card colour, 16px corners, no border, no shadow. */
export const CARD = 'min-w-0 rounded-2xl bg-panel-deep p-5 sm:p-7';
export const SECTION = 'mx-auto w-full max-w-6xl px-5 sm:px-8';
/* The home page's sections since note #977 (the owner, 4 Nov 2026, 12:43
   UTC: "in the landing page all content should be end to end wide"): the
   whole width of the window, with the page's side padding and nothing else.
   Every other page keeps SECTION's centred column. */
export const HOME_SECTION = 'w-full px-5 sm:px-8 lg:px-12';

/* Since note #978 (the owner, 4 Nov 2026, 13:23 UTC: "we should think in
   terms of sections. Each section should take the whole space horizontally
   and vertically. For extra large displays, we should have max width and max
   height") every home section is one screen: the whole width and at least
   the whole height of the window (svh, the height with a phone's bars
   showing), its content centred inside it, a hairline between screens.
   Inside, the content has ONE pair of caps for the whole page:
   SCREEN_MAX_WIDTH (1280 px) and SCREEN_MAX_HEIGHT (900 px). Beyond them it
   is centred with even space around it, so a 2940 px display shows a large
   laptop's composition. The height cap sizes what can be sized (the film);
   a screen whose words and panels genuinely need more than the window
   grows, never clips. No scroll snapping. */
/* One column for the whole home page (note #1088; Adam, 9 Nov 2026, 08:50
   UTC: keep the film's width and put every section below it, the footer
   too, on that same column). From sm up the column is the film's own width
   rule: as wide as the content box allows, unless that makes the 16:9 film
   taller than min(screen, 900 px) leaves after the 300 px kept for the
   masthead, the timeline and its link. It follows the window's height, so
   it is a rule and never a number: 1,067 px at 1440x900, 889 px at
   1440x800. The film, the masthead, every Screen's content and the home
   footer read this one class; a phone keeps the full width (the film has
   its own tall rule there). */
export const HOME_COLUMN = 'sm:w-[min(100%,calc((min(100svh,900px)_-_300px)*16/9))]';
/* The same width as a CSS value, for a drawing that is placed by it rather
   than sized to it (WorkplaceArt, note #1088). 100% is the content box. */
export const HOME_COLUMN_WIDTH = 'min(100%, calc((min(100svh, 900px) - 300px) * 16 / 9))';

export const SCREEN_MAX_WIDTH = 1280;
export const SCREEN_MAX_HEIGHT = 900;
export function Screen({
  id,
  label,
  first = false,
  pad = 'py-12 sm:py-16',
  column = true,
  className = '',
  children,
}: {
  id: string;
  label?: string;
  /** The page's first screen draws no hairline above it. */
  first?: boolean;
  pad?: string;
  /** Content on the page's one column (HOME_COLUMN, note #1088). Off only
      for a screen that places its own content by the column, the
      workplace drawing. */
  column?: boolean;
  /** Classes for the content box (a grid, its gaps). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      data-screen
      className={`flex min-h-[100svh] w-full flex-col justify-center px-5 sm:px-8 lg:px-12 ${pad} ${first ? '' : 'border-t border-hint/16'}`}
    >
      <div data-screen-content className={`mx-auto w-full max-w-[1280px] ${column ? HOME_COLUMN : ''} ${className}`}>{children}</div>
    </section>
  );
}

/* The page carries a lot of the product at full reading size. Whitespace alone
   lets those interfaces run together, so every substantial section after the
   hero begins with the same quiet hairline. The rules create boundaries
   without putting every example in another box. */
export function ChapterDivider({ tight = false }: { tight?: boolean }) {
  /* The home page sets its sections closer (note #924: it told its story
     twice, at 7,400 px on a desk); every other page keeps the open rhythm. */
  return (
    <div
      className={`landing-chapter-divider relative left-1/2 w-screen -translate-x-1/2 border-t border-hint/16 ${tight ? 'mb-8 sm:mb-12' : 'mb-14 sm:mb-16'}`}
      aria-hidden="true"
    />
  );
}

/* A home page section's own padding under its content, to the next hairline
   (note #924). */
export const HOME_SECTION_END = 'pb-4 sm:pb-6';

export function Arrow() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4" fill="none">
      <path d="M4 10h11M11 6l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* The door is words, not a box. A filled button was the one coloured object
   on a page that is otherwise grey and white, and it read as a sticker; the
   owner chose this over a white fill, an outline and a grey card (2026-09-07).
   The primary is white with an arrow, the secondary the app's hint grey; a
   hairline under each is all the affordance they carry. */
export function PrimaryLink({ href, children }: { href: string; children: string }) {
  const newTab = useNewTab();
  return (
    <a
      href={href}
      {...(newTab ? NEW_TAB : {})}
      className="group inline-flex items-center gap-2 border-b border-white/35 pb-1 type-base font-semibold text-white transition-colors hover:border-white"
    >
      {children}
      {newTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
      <span className="transition-transform duration-200 group-hover:translate-x-0.5">
        <Arrow />
      </span>
    </a>
  );
}

export function SecondaryLink({ href, children }: { href: string; children: string }) {
  const newTab = useNewTab();
  return (
    <a
      href={href}
      {...(newTab ? NEW_TAB : {})}
      className="inline-flex items-center border-b border-white/15 pb-1 type-base font-semibold text-hint transition-colors hover:border-white/40 hover:text-white"
    >
      {children}
      {newTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
    </a>
  );
}
