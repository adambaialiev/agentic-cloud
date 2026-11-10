import type { CSSProperties } from 'react';
import { SHARE_HEADLINE, SHARE_LINE } from '../lib/share-card';

// Fixed 1200x630 composition for the og:image (public/og-image.png, shot at
// deviceScaleFactor 2 to 2400x1260 by scripts/shoot-og-image.mjs; bump
// SHARE_IMAGE_VERSION and the ?v= in index.html with every new shot, or every
// cache keeps serving the old picture).
//
// This is the most-seen picture we publish: the whole distribution motion is
// a forwarded link, and this is the card. Since note #1004 (the owner, 5 Nov
// 2026: variant A of the mock-up, words only) it is the masthead of the home
// page's first screen (note #1003: the wave and the name), the film's closing
// words as the one big line, and the problem we solve under it. Until then it
// was "Everything an agent needs to finish the job." beside the hero's fleet
// of eight agents, whose dog avatars nobody could read at preview size.
//
// Rules it keeps: words only, legible where X, Slack and iMessage draw it
// (about 270 to 516 px wide); the bottom-left 100 px is left clear, because X
// lays its title label over that corner; the background is the film's own
// (#fcfcf9) and the ink and grey are the home page's.
//
// SQUARE-SAFE since note #1137 (Adam, 10 Nov 2026, 15:33 UTC, "Fix all"):
// WhatsApp and iMessage often draw only the centre square of the card, which
// is x 285..915 of 1200. Everything now stands in one column inside that
// square (SQUARE_SAFE), the headline set one sentence a line, so the crop
// shows the whole card rather than chopped words. scripts/shoot-og-image.mjs
// refuses to write the picture if any text leaves the square.
function BrandMark({ className, style }: { className?: string; style?: CSSProperties }) {
  const mask: CSSProperties = {
    backgroundColor: '#1f1e1d',
    maskImage: 'url(/logo-bw.png)',
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
    maskSize: 'contain',
    WebkitMaskImage: 'url(/logo-bw.png)',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    WebkitMaskSize: 'contain',
    ...style,
  };
  return <span className={`inline-block ${className ?? ''}`} style={mask} aria-hidden="true" />;
}

/** The centre square of the 1200x630 card, and the column inside it. */
export const SQUARE_SAFE = { left: 285, right: 915, column: 540 } as const;

export default function OgPreview() {
  const lines = SHARE_HEADLINE.split(/(?<=\.) /);
  return (
    <main className="landing-page flex min-h-dvh items-center justify-center bg-canvas-soft">
      <div
        id="og-canvas"
        className="relative flex h-[630px] w-[1200px] shrink-0 items-center justify-center overflow-hidden"
        style={{ background: '#fcfcf9', color: '#1f1e1d', boxSizing: 'border-box', fontFamily: 'var(--font-ui)' }}
      >
        <div data-og-column style={{ width: SQUARE_SAFE.column }}>
          <div data-og-masthead className="flex items-center" style={{ gap: 10, fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em', marginLeft: -4 }}>
            <BrandMark style={{ width: 38, height: 38 }} />
            Agentic Cloud Computer
          </div>
          <h1 style={{ margin: '34px 0 0', fontSize: 76, fontWeight: 700, letterSpacing: '-0.04em', lineHeight: 0.98 }}>
            {lines.map((line, index) => (
              <span key={line}>
                {index > 0 && <br />}
                {line}
              </span>
            ))}
          </h1>
          <p style={{ margin: '28px 0 0', fontSize: 27, lineHeight: 1.25, fontWeight: 500, letterSpacing: '-0.01em', color: '#686762' }}>
            {/* "Claude Code" never splits across two lines. */}
            {SHARE_LINE.replace('Claude Code', 'Claude\u00a0Code')}
          </p>
        </div>
      </div>
    </main>
  );
}
