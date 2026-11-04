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
  return (
    <a
      href={href}
      className="group inline-flex items-center gap-2 border-b border-white/35 pb-1 type-base font-semibold text-white transition-colors hover:border-white"
    >
      {children}
      <span className="transition-transform duration-200 group-hover:translate-x-0.5">
        <Arrow />
      </span>
    </a>
  );
}

export function SecondaryLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center border-b border-white/15 pb-1 type-base font-semibold text-hint transition-colors hover:border-white/40 hover:text-white"
    >
      {children}
    </a>
  );
}
