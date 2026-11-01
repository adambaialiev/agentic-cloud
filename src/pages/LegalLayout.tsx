import { type ReactNode } from 'react';
import SiteHeader from '../components/SiteHeader';
import SiteFooter, { CONTACT_EMAIL } from '../components/SiteFooter';
import { FOOTER_PITCH } from '../lib/product-copy';
/* The same four voices the landing and the entry pages are set in. A legal
   page has no cards, doors or dividers, so it takes the type roles and
   nothing else (see components/landing-kit). */
import { H3, LEAD } from '../components/landing-kit';

export { CONTACT_EMAIL };

// The public contact route is the shared product email. The service is free
// and does not collect payment details, so the legal pages do not publish a
// private person's name, home location or personal profile.

// Shared frame for /terms and /privacy: the landing's own surface,
// a narrow prose column, and cross-links between the documents.
//
// These pages are the Workspace's ground, exactly as the landing is — its
// background, its greys, its one blue. Nothing here picks a colour of its own:
// the `landing-page` class on <main> is what maps every token to the app's
// own palette, and the header and footer are handed the same `tone="dark"`
// the front page hands them. Miss that one class and these pages render
// against the old dark stage while the front page is paper-light, which is
// exactly how they drifted after the landing moved (2026-09-14).
//
// The rule this obeys, learned the hard way three times: a customer following
// the footer from one page to another must not be able to wonder whose site
// they landed on. These pages were near-black with an amber accent from a
// landing that no longer existed, then light and cool while the product was
// dark, then dark while the landing went paper-light. The fix each time was
// the same — follow the front page rather than keeping a palette of one's
// own — so when the landing moves, these move with it.

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      {/* The landing's card title, which is the role a section heading plays
          in long-form too: one step over 16px body copy, and the only place
          on these pages weight is used to make a hierarchy. */}
      <h2 className={H3}>{title}</h2>
      {/* `LEAD` is the landing's 16px body grey — the app's own secondary
          text. Emphasis inside a paragraph steps up to white, the same
          two-step the landing uses inside a card. */}
      <div className={`mt-3 space-y-3 ${LEAD}`}>{children}</div>
    </section>
  );
}



export function ContactLines() {
  return (
    <>
      <p>
        Email{' '}
        <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent-bright underline decoration-accent-bright/40 underline-offset-2 hover:decoration-accent-bright">
          {CONTACT_EMAIL}
        </a>
        . We aim to reply within one business day.
      </p>
    </>
  );
}

export default function LegalLayout({
  title,
  effectiveDate,
  dateLabel = 'Effective',
  navPlacement,
  lede,
  closing,
  children,
}: {
  title: string;
  effectiveDate: string;
  /** "Effective" for the legal documents. */
  dateLabel?: string;
  /**
   * Campaign name for the nav CTA. Defaults to the title.
   */
  navPlacement?: string;
  /** One paragraph under the headline, before the body. */
  lede?: ReactNode;
  /** Closing call to action. Legal pages deliberately have none. */
  closing?: ReactNode;
  children: ReactNode;
}) {

  return (
    // The landing's own <main>, class for class: `landing-page` remaps every
    // colour token to the Workspace's paper palette, and the roles below then
    // resolve to the same values the front page renders.
    <main
      className="landing-page min-h-dvh overflow-hidden bg-panel text-white"
      style={{ fontFamily: 'var(--font-ui)' }}
    >
      {/* Derived from the title when a page does not name itself, so a new page
          under this shell is still distinguishable in a report.
          `sanitizeValue` handles the spaces. Articles and legal documents send
          readers to the product page before asking for a conversation. */}
      <SiteHeader
        ctaPlacement={navPlacement ?? `${title.toLowerCase()}_nav`}
        ctaTarget="product"
        tone="dark"
      />

      {/* A prose measure inside the landing's own gutters: the front page's
          `px-5 sm:px-8`, with the column narrowed from `max-w-6xl` because
          this page is 700 words of reading rather than panels. */}
      <article className="mx-auto w-full max-w-[720px] px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
        {/* No eyebrow. The landing opens on a bare headline, and the mono
            caps line that used to sit here — "agentic cloud computer", in a
            monospace face the site does not otherwise use — was the last
            surviving furniture of the design before it. */}
        <h1 className="type-lg text-white sm:type-xl">{title}</h1>
        <p className="mt-3 type-sm text-hint">{dateLabel} {effectiveDate}</p>
        {lede ? (
          <p className={`mt-6 ${LEAD}`}>{lede}</p>
        ) : null}
        {children}
        {closing}
      </article>

      {/* The pitch is spelled out here and NOT in the landing page's own
          footer, where it would be the third telling: that page's h1 says it at
          the top and the closing CTA says it again just above. On an article
          reached from a search result this is the only place it is said at
          all — that reader has never seen the landing page. */}
      {/* The footer under every article and legal page. It carried the retired
          consumer tagline ("Hire an engineer by sending a text") until
          2026-08-29 — on every page of the site, including this one. */}
      {/* The site's one pitch, from the module the landing reads it out of:
          this said "Persistent AI coworkers, working in parallel from one
          shared workspace" while the front page had been saying Claude Code
          and Codex for a week. */}
      <SiteFooter pitch={FOOTER_PITCH} tone="dark" />
    </main>
  );
}
