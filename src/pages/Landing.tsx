import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
/* The questions and their answers live in one module so the entry pages can
   quote them rather than paraphrase them (see lib/product-copy.ts). */
import { FOOTER_PITCH } from '../lib/product-copy';
/* The pitch itself, one copy the home page renders too (note #789). */
import ProductPitch from '../components/ProductPitch';
import { ChapterDivider, H2, LEAD, PrimaryLink } from '../components/landing-kit';
import { PRIVATE_COPY_DOOR, PRIVATE_COPY_URL } from '../lib/workspace-link';
/**
 * The front page.
 *
 * Its one job is to show the product. The version this replaced described the
 * Workspace in six blocks of prose and illustrated it with four whole desktop
 * captures shrunk to ~470px wide — too small to read a word of, and taken from
 * a build of the app that no longer exists (a left rail we removed, grey
 * placeholder faces where the real avatars now are). A reader could not tell
 * from that page what they would be looking at after signing up, which is the
 * one question a front page has to answer.
 *
 * Now every claim is next to the screen that proves it — and since 2026-09-07
 * that screen is not a picture at all: the page mounts the Workspace's own
 * components with fixture data (see components/live/ and the knowledge page
 * `landing-live-panels`). When the product changes, the page changes with it,
 * because it is the product.
 *
 * And the page stands on the product's own ground. It was a light editorial
 * page with the app's colours on it, and the two still read as different
 * moods: glows, shadows, 40px corners and 78px headlines on one side, a flat
 * dark column of 16px-cornered cards on the other. So this is the Workspace
 * at poster size — its background, its card, its hairline, its button — and a
 * capture sits on it with no frame to speak of, because it is the same surface.
 */

export default function Landing() {
  return (
    <main
      className="landing-page min-h-dvh overflow-hidden bg-panel text-white"
      style={{ fontFamily: 'var(--font-ui)' }}
    >
      <SiteHeader ctaTarget="none" tone="dark" />

      <ProductPitch on="product" />

      {/* ── A private copy ───────────────────────────────────────────────── */}
      {/* The door to /private-copy (note #818, the owner, 2026-10-28), on
          this page only: whether it joins the home pitch is still his call,
          so it lives here rather than in ProductPitch. Since note #822 (the
          owner, 2026-10-28: "we should not host yet ... Only on-premise") it
          is the only offer, so it closes the page as the way to get
          everything above. The cloud provider is left to the page it opens. */}
      <section id="private-copy" className="mx-auto w-full max-w-6xl px-5 pb-16 sm:px-8 sm:pb-24">
        <ChapterDivider />
        <div className="max-w-[640px]">
          <h2 className={H2}>Your own Agentic Cloud.</h2>
          <p className={`mt-5 [text-wrap:pretty] ${LEAD}`}>
            Everything on this page runs in your company’s own cloud account, on a domain of yours.
            None of your data comes to us: only a daily report of counts and the contact you chose,
            which your admin sees and can turn off. One command installs it, one upgrades it. Send
            this to your engineer.
          </p>
          <div className="mt-6">
            <PrimaryLink href={PRIVATE_COPY_URL}>{PRIVATE_COPY_DOOR}</PrimaryLink>
          </div>
        </div>
      </section>

      <SiteFooter pitch={FOOTER_PITCH} tone="dark" />
    </main>
  );
}
