/**
 * The landscape beside the documentation section: a road running out across
 * a valley toward mountains, the sun just up.
 *
 * Hand-drawn vector rather than a generated picture (the owner, 2026-09-25:
 * art, not a dog, an inspiring landscape; drawn here rather than generated).
 * Flat layered shapes in a warm, quiet palette that sits on the page's
 * paper background — nothing saturated, no outlines, no people. The road is
 * the point: the whole way ahead, visible at once, which is what the docs
 * are. Scales to its box; the 3:2 frame matches the other landing scenes.
 */
export default function DawnRoad({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 900 600"
      role="img"
      aria-label="A road running through a wide valley toward distant mountains at dawn, the sun just above the peaks."
      className={className}
    >
      <defs>
        <linearGradient id="dawn-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#dfe4ea" />
          <stop offset="0.55" stopColor="#f3e3d3" />
          <stop offset="1" stopColor="#f8d9bd" />
        </linearGradient>
        <radialGradient id="dawn-glow" cx="0.5" cy="0.55" r="0.5">
          <stop offset="0" stopColor="#ffd6a0" stopOpacity="0.95" />
          <stop offset="0.6" stopColor="#ffd9a8" stopOpacity="0.45" />
          <stop offset="1" stopColor="#ffd9a8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="dawn-valley" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c9c2a3" />
          <stop offset="1" stopColor="#b8b08c" />
        </linearGradient>
        <clipPath id="dawn-frame">
          <rect x="0" y="0" width="900" height="600" rx="24" />
        </clipPath>
      </defs>

      <g clipPath="url(#dawn-frame)">
        {/* Sky, and the warmth low on the horizon */}
        <rect width="900" height="600" fill="url(#dawn-sky)" />
        <ellipse cx="560" cy="270" rx="460" ry="200" fill="url(#dawn-glow)" />

        {/* The sun, just clear of the far ridge */}
        <circle cx="560" cy="212" r="34" fill="#fbe7c2" />
        <circle cx="560" cy="212" r="24" fill="#fff5df" />

        {/* Far mountains: the palest, half in haze */}
        <path
          d="M0 340 L70 300 L140 322 L210 268 L280 296 L340 252 L410 290 L470 262 L520 284 L600 240 L660 276 L720 250 L790 288 L850 262 L900 290 L900 420 L0 420 Z"
          fill="#bfc6d0"
        />
        <path
          d="M340 252 L360 268 L320 270 Z M600 240 L622 258 L586 262 Z M720 250 L740 266 L702 266 Z M210 268 L226 282 L194 284 Z"
          fill="#e6eaf0"
        />

        {/* Nearer ridge, a shade deeper */}
        <path
          d="M0 372 L60 348 L130 366 L200 330 L270 356 L350 322 L430 352 L510 328 L590 350 L660 318 L740 348 L820 330 L900 356 L900 440 L0 440 Z"
          fill="#a7b0b8"
        />

        {/* The valley floor: warm fields, rolling to the front */}
        <path d="M0 380 C 200 350, 400 372, 900 366 L900 600 L0 600 Z" fill="url(#dawn-valley)" />
        <path d="M0 430 C 180 400, 320 430, 520 412 C 700 396, 800 420, 900 404 L900 600 L0 600 Z" fill="#b3ad86" />
        <path d="M0 500 C 150 470, 330 500, 520 486 C 720 470, 820 500, 900 478 L900 600 L0 600 Z" fill="#a8a27a" />

        {/* A few trees along the hedge lines, small and far */}
        <g fill="#8c8a66">
          <ellipse cx="120" cy="440" rx="10" ry="16" />
          <ellipse cx="146" cy="446" rx="8" ry="13" />
          <ellipse cx="690" cy="424" rx="9" ry="14" />
          <ellipse cx="712" cy="428" rx="7" ry="11" />
          <ellipse cx="820" cy="470" rx="12" ry="18" />
          <ellipse cx="848" cy="476" rx="9" ry="14" />
        </g>

        {/* The road, running out from the foot of the frame to the pass */}
        <path d="M300 600 C 360 520, 470 470, 552 380 L566 380 C 520 470, 480 540, 470 600 Z" fill="#e8e2cc" />
        <path d="M382 600 C 420 540, 480 470, 556 382 L560 382 C 500 470, 450 540, 428 600 Z" fill="#f5f0dd" />
      </g>
    </svg>
  );
}
