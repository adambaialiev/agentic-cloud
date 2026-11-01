import BrandMark from './BrandMark';
import { productPageUrl, useInboundCampaign } from '../lib/campaign-link';

/**
 * The one header the whole site wears.
 *
 * It used to be two: a floating pill on the landing page and a plain bar on
 * everything else, and neither carried a single navigation link — brand on the
 * left, one action on the right, nothing in between. A reader who
 * arrived on an article from a search result could reach the product only by
 * scrolling past the whole piece to the footer. Every page now offers the
 * product and the article index in the same place.
 *
 * From 2026-09-16 it carried no navigation link at all (the owner): the
 * one left, "Product", pointed where the mark on the left already goes.
 * From 2026-10-16 it carried two again, Apps and Leaderboard (the owner);
 * since note #791 (2026-10-25) it carries none: the site shows the
 * founder's own system. The two doors on the right are Sign in and Sign up
 * (for a few hours on 2026-10-25 the second was Request access; note #794
 * put sign-up back). Since note #822 (2026-10-28) only the private copy is
 * offered, so the second door leads to the engineer's page: Get a copy, then
 * Build yours since the offer was named "your own Agentic Cloud" (the owner,
 * 2026-10-28, 11:09 UTC). Since note #924 (the owner, 31 Oct 2026, 14:59
 * UTC: "Sign in is not needed, it's only for me. Build yours is also just a
 * redirect to the 'How to start.' section") it carries neither: on every page
 * that showed them the header is the mark and the name, nothing else. The
 * sign-in page still answers at /login. Only the legal pages keep their one
 * link, "See how it works", to /product. The type is the header's own — 15px,
 * tracked like the headlines rather than like small print — because the row
 * sits over every screen of the page and 14px with open tracking read as a
 * form label.
 */

export default function SiteHeader({
  ctaPlacement,
  ctaTarget = 'product',
  tone = 'light',
}: {
  /** `dark` on the pages that stand on the Workspace's own ground. */
  tone?: 'light' | 'dark';
  /** Names this header's CTA in the attribution report. */
  ctaPlacement?: string;
  /**
   * Whether the header carries a door. `product` sends readers from the
   * legal pages to /product; `none` (note #924) is the mark and the name
   * alone, on the home page and every page like it.
   */
  ctaTarget?: 'product' | 'none';
}) {
  const inboundSearch = useInboundCampaign();
  const bare = ctaTarget === 'none';
  const dark = tone === 'dark';

  return (
    // Fixed and translucent: the name, and on a legal page its one door,
    // stay in reach at the bottom of a 2,000-word article. It was
    // `sticky`, which the landing and tour pages silently defeated with the
    // `overflow-hidden` on their <main> — the bar scrolled away with the page.
    // Fixed ignores that; the spacer below keeps the content from starting
    // underneath it. The page's own background tint rather than white, so it
    // does not read as a slab sitting on top of the content.
    <>
    <header
      className={[
        'fixed inset-x-0 top-0 z-40 border-b backdrop-blur-md',
        dark ? 'border-hint/16 bg-panel/90' : bare ? 'border-black/[0.06] bg-canvas/88' : 'border-black/[0.06] bg-canvas/85',
      ].join(' ')}
    >
      <nav
        className={[
          'mx-auto flex h-12 w-full items-center gap-2 px-5 max-[359px]:px-4 sm:h-14 sm:gap-5 sm:px-8',
          bare ? 'max-w-7xl' : 'max-w-6xl',
        ].join(' ')}
        aria-label="Main"
      >
        <a
          href="/"
          className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap type-base font-semibold tracking-[-0.01em] ${dark ? 'text-white' : 'text-ink'}`}
        >
          {/* Ink, not the mark's amber default: the public site keeps the
              symbol typographic rather than introducing a stray accent. */}
          <BrandMark className="h-6 w-8" tint={dark ? 'var(--color-white)' : '#1c2028'} />
          {/* With no door beside it (note #924) the name fits a 320px
              phone, so it shows on every screen; beside a door it is the
              first thing to go on a narrow one. */}
          <span className={bare ? undefined : 'sr-only md:not-sr-only'}>Agentic Cloud Computer</span>
        </a>

        {bare ? null : (
          // On dark this is the landing's own primary: white, an arrow, and a
          // hairline for the whole of its affordance. A filled accent pill is
          // what that page rejected on 2026-09-07 — on this surface it reads
          // as a sticker — so a legal page carrying one would be the one
          // element on the site still arguing for the old design.
          <a
            href={productPageUrl(ctaPlacement ?? 'nav', inboundSearch)}
            className={
              dark
                ? 'group ml-auto inline-flex items-center gap-2 whitespace-nowrap border-b border-white/35 pb-0.5 type-base font-semibold tracking-[-0.005em] text-white transition-colors hover:border-white'
                : 'ml-auto whitespace-nowrap rounded-full bg-accent px-3.5 py-2 type-sm font-semibold text-white shadow-[0_1px_4px_rgba(28,32,40,0.12)] transition-colors hover:bg-accent-deep max-[359px]:px-2.5 sm:px-4'
            }
          >
            <span className="max-[359px]:hidden">See how it works</span>
            <span className="hidden max-[359px]:inline">How it works</span>
            {dark ? (
              <span aria-hidden="true" className="transition-transform duration-200 group-hover:translate-x-0.5 max-[359px]:hidden">→</span>
            ) : null}
          </a>
        )}
      </nav>
    </header>
    <div aria-hidden className="h-12 sm:h-14" />
    </>
  );
}
