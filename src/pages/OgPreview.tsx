import type { CSSProperties } from 'react';
import LiveFleet from '../components/LiveFleet';
import { HERO_FLEET_BEYOND } from '../components/live/fixture';

// Fixed 1200x630 composition for the og:image, mirroring the live landing:
// the landing palette, the same category headline, and — since 2026-09-06 — a
// REAL capture of a Workspace conversation rather than a recreation of one.
//
// The recreation was a careful piece of hand-built markup with a lilac circle
// and an "M" where a face goes, and an agent named Mia who exists nowhere in
// the product. It was the last placeholder on the most-forwarded picture we
// have. It became a crop of a simulation capture on 2026-09-06, and on
// 2026-09-14 it became the component itself — the same move the front page
// made a week earlier. A capture had to be re-shot, re-cropped and committed
// whenever the screen changed, and the one we shipped showed a fixture
// hostname and opened mid-sentence for eight days before anyone looked.
//
// This file IS the most-seen marketing asset we have: the whole distribution
// motion is a forwarded link, and this is the picture on the card. It went
// stale silently for ten days after the 2026-08-20 company pivot — still
// selling "Hire an engineer by sending a text" and "Your first is free", a
// solo product with a freemium hook, neither of which had existed since the
// pivot and the 2026-08-29 no-billing decision. Nothing failed and no test
// caught it, because an image cannot contradict itself.
//
// So the rule this file keeps: the headline here is the LANDING PAGE'S OWN h1,
// word for word, and since 2026-09-14 so is the sentence under it. If they ever
// differ again, this one is wrong.
//
// Removed on 2026-09-14: a "Real capture" badge in the window chrome. It was a
// note to ourselves that the picture is the running product rather than a
// drawing — true, and worth nothing to the stranger it was shown to, who reads
// a green dot and block capitals in the corner of a screenshot as a watermark
// or a debug overlay. The picture makes the point by being legible. Re-shoot with
// scripts/shoot-og-image.mjs and bump the ?v= on og:image / twitter:image in
// index.html, or every cache keeps serving the old picture.
// Screenshot #og-canvas at deviceScaleFactor 2 to produce the 2400x1260 asset
// referenced in index.html (`node scripts/shoot-og-image.mjs`). Everything here
// is a still frame — the landing's blink and conveyor-belt animations are
// deliberately absent so the shot is deterministic.
function BrandMark({ className, tint = '#1f1e1d' }: { className?: string; tint?: string }) {
  const mask: CSSProperties = {
    backgroundColor: tint,
    maskImage: 'url(/logo-bw.png)',
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
    maskSize: 'contain',
    WebkitMaskImage: 'url(/logo-bw.png)',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    WebkitMaskSize: 'contain',
  };
  return <span className={`inline-block ${className ?? ''}`} style={mask} aria-hidden="true" />;
}

export default function OgPreview() {
  return (
    <main className="landing-page flex min-h-dvh items-center justify-center bg-canvas-soft">
      <div
        id="og-canvas"
        className="relative flex h-[630px] w-[1200px] shrink-0 flex-col overflow-hidden bg-canvas text-ink"
      >
        <style>{`
          /* A poster panel is drawn at 1.3 on a wide screen. Here it has a
             fixed 630px-tall frame to live in, and at 1.3 the third card was
             sliced through a line of its own text — a cut that reads as a
             broken picture rather than as a panel continuing. */
          .og-fleet .ws-live { zoom: 1.04; }
          .og-grid {
            background-image:
              linear-gradient(rgba(31, 30, 29, 0.045) 1px, transparent 1px),
              linear-gradient(90deg, rgba(31, 30, 29, 0.045) 1px, transparent 1px);
            background-size: 44px 44px;
            mask-image: radial-gradient(ellipse 90% 90% at 20% 0%, black 40%, transparent 100%);
          }
        `}</style>

        <div className="og-grid absolute inset-0" aria-hidden="true" />
        <div className="relative flex items-center gap-2.5 px-14 pt-11 type-base font-semibold">
          <BrandMark className="h-7 w-9" />
          Agentic Cloud Computer
        </div>

        <div className="relative flex flex-1 items-center gap-12 overflow-hidden px-12 pb-10">
          <div className="w-[452px] shrink-0">
            {/* The headline alone, since 2026-09-14. The landing's lede stood
                under it and was the second thing nobody read at postage-stamp
                size — the picture beside it says what the sentence said, and
                says it in the product's own pixels. */}
            {/* The product page's lead since note #787 (2026-10-25); until
                then "Give Claude Code a team, and a cloud to work in." */}
            <h1 className="type-xl">
              Everything an agent needs
              {' '}<span className="text-accent">to finish the job.</span>
            </h1>
          </div>

          {/* The hero's fleet: the eight agents the front page opened with
              until 2026-10-08 (they pass in its moving row since note #185),
              fading out past the first rows and running off the bottom of
              the card (the owner, 2026-09-16: the card should say the fleet
              keeps going). Same component as the page's panels, so it cannot
              go stale, because it is the app. The fade is the card's own
              (.og-fleet in index.css), sized to the card's edge. */}
          <div className="flex-1 self-start rounded-[22px] bg-panel-deep p-5 shadow-[0_20px_55px_rgba(28,32,40,0.22)]">
            <LiveFleet className="og-fleet" fleet={HERO_FLEET_BEYOND} />
          </div>
        </div>
      </div>
    </main>
  );
}
