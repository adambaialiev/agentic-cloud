import type { ReactNode } from 'react';
import { FACES } from './live/fixture';

/**
 * The drawings on /private-copy (note #827, the owner, 2026-10-28: "It should
 * be visually appealing, not slop. It should have illustrations.").
 *
 * They are drawn for this page, in its own palette and type, and every box,
 * line and label in them is something real on the knowledge page
 * private-copy: the five apps and two buckets the installer makes, the three
 * things that stay with us, the one download that crosses, the installer's
 * steps in its own order and the upgrade's way back. Nothing is decorative.
 * When the installer changes what it makes, change the drawing with it.
 *
 * Each drawing is set twice, wide for a desk and tall for a phone, because a
 * wide diagram shrunk onto a phone takes its labels down to unreadable. The
 * chapter's own words say everything a drawing shows, so a screen reader
 * gets one sentence for each picture (aria-label), not its boxes one by one.
 *
 * The page has one moment of motion, and it is the page's point: as the
 * first drawing scrolls in, the release draws itself from our update service
 * into your registry, the one line that crosses. It is drawn by default; only
 * a browser with scroll-driven animations, for a reader who has not asked for
 * less motion, starts it empty (index.css, .copy-art-draw).
 */

type Tone = 'ink' | 'hint' | 'accent' | 'ok';

const STROKE: Record<Tone, string> = {
  ink: 'stroke-white',
  hint: 'stroke-hint',
  accent: 'stroke-accent',
  ok: 'stroke-ok',
};

const FILL: Record<Tone, string> = {
  ink: 'fill-white',
  hint: 'fill-hint',
  accent: 'fill-accent',
  ok: 'fill-ok',
};

/* ── The pictograms ────────────────────────────────────────────────────────
   One 24-unit grid, one stroke weight, round ends: drawn together so they
   read as one set. */

export type IconName =
  | 'workspace'
  | 'database'
  | 'machine'
  | 'globe'
  | 'branch'
  | 'check'
  | 'mail'
  | 'bucket'
  | 'layers'
  | 'key'
  | 'package'
  | 'code'
  | 'support'
  | 'download'
  | 'terminal'
  | 'shield'
  | 'camera'
  | 'records'
  | 'link'
  | 'heart';

const PATHS: Record<IconName, ReactNode> = {
  workspace: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M3 9h18M8.5 9v10.5" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.6" />
      <path d="M5 6v12c0 1.45 3.13 2.6 7 2.6s7-1.15 7-2.6V6" />
      <path d="M5 12c0 1.45 3.13 2.6 7 2.6s7-1.15 7-2.6" />
    </>
  ),
  machine: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2.2" />
      <path d="M8.5 21h7M12 17v4M7.5 8.5l2.5 2.2-2.5 2.2M12 13h4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <ellipse cx="12" cy="12" rx="3.6" ry="8.5" />
      <path d="M3.5 12h17" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="5.5" r="2" />
      <circle cx="7" cy="18.5" r="2" />
      <circle cx="17" cy="8" r="2" />
      <path d="M7 7.5v9M17 10c0 4-5.5 3.8-9 7" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.4 12.2l2.5 2.5 4.8-5.1" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.2" />
      <path d="M3.6 7l8.4 6.2L20.4 7" />
    </>
  ),
  bucket: (
    <>
      <path d="M4 8.5h16l-1.7 10.6a2 2 0 0 1-2 1.7H7.7a2 2 0 0 1-2-1.7z" />
      <path d="M7.2 8.5a4.8 4.8 0 0 1 9.6 0" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3.5l8.5 4.3L12 12.1 3.5 7.8z" />
      <path d="M3.5 12l8.5 4.3 8.5-4.3M3.5 16.2l8.5 4.3 8.5-4.3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h8.5M17.5 12v3M15 12v2.2" />
    </>
  ),
  package: (
    <>
      <path d="M12 3l8 4v10l-8 4-8-4V7z" />
      <path d="M4.3 7.2L12 11l7.7-3.8M12 11v9.6" />
    </>
  ),
  code: <path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.4 5.5l-2.8 13" />,
  support: (
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z" />
  ),
  download: (
    <>
      <path d="M7 17.5a4.2 4.2 0 0 1-.4-8.4 5.6 5.6 0 0 1 10.9-1 4 4 0 0 1 .3 9.4" />
      <path d="M12 11v9M9 17l3 3 3-3" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M7.2 9.5l3 2.5-3 2.5M12.3 15h4.5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.2l7.5 2.9v5.5c0 4.5-3.2 7.9-7.5 9.3-4.3-1.4-7.5-4.8-7.5-9.3V6.1z" />
      <path d="M8.7 12l2.3 2.3 4.3-4.5" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8.5A2 2 0 0 1 6 6.5h2l1.5-2h5l1.5 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="13" r="3.4" />
    </>
  ),
  records: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2.4" />
      <path d="M7.5 9h9M7.5 12h9M7.5 15h5.5" />
    </>
  ),
  link: (
    <>
      <path d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1.3 1.3" />
      <path d="M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1.3-1.3" />
    </>
  ),
  heart: (
    <path d="M3.5 12h4l2-4.5 4 9 2-4.5h5" />
  ),
};

export function Icon({ name, x = 0, y = 0, size = 24, tone = 'ink' }: { name: IconName; x?: number; y?: number; size?: number; tone?: Tone }) {
  return (
    <g
      transform={`translate(${x} ${y}) scale(${size / 24})`}
      className={STROKE[tone]}
      fill="none"
      strokeWidth={1.5 * (24 / size) > 2 ? 2 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </g>
  );
}

/* A pictogram on its own, as HTML, for the places that are not one drawing. */
export function Glyph({ name, className = 'h-6 w-6' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} shrink-0 stroke-white`} fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/* ── The pieces a drawing is made of ───────────────────────────────────── */

/* A thing that runs: a card on the page colour, a pictogram, a name and one
   line of what it is. Since note #1096 (Adam, 9 Nov 2026: "fonts should be
   larger") its type is set at the drawing's reading size: a 17-unit title
   and 14.5-unit lines, which the wide plan renders at about 17 and 15 px on
   a 1440 desk (13 and 11 px before). */
const CARD_TITLE = 17;
const CARD_LINE = 14.5;
const CARD_H = 70;

function Node({
  x,
  y,
  w,
  h = CARD_H,
  icon,
  title,
  lines = [],
  tone = 'ink',
}: {
  x: number;
  y: number;
  w: number;
  h?: number;
  icon: IconName;
  title: string;
  lines?: string[];
  tone?: Tone;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={14} className="fill-panel stroke-white/12" strokeWidth={1} />
      <Icon name={icon} x={x + 16} y={y + 16} tone={tone} />
      <text x={x + 54} y={y + 30} fontSize={CARD_TITLE} fontWeight={600} className="fill-white">
        {title}
      </text>
      {lines.map((line, i) => (
        <text key={line} x={x + 54} y={y + 52 + i * 20} fontSize={CARD_LINE} className="fill-hint">
          {line}
        </text>
      ))}
    </g>
  );
}

function Label({ x, y, children, anchor = 'start', tone = 'hint', size = 12.5, weight = 400 }: { x: number; y: number; children: string; anchor?: 'start' | 'middle' | 'end'; tone?: Tone; size?: number; weight?: number }) {
  return (
    <text x={x} y={y} fontSize={size} fontWeight={weight} textAnchor={anchor} className={FILL[tone]}>
      {children}
    </text>
  );
}

/* An arrowhead at (x, y), pointing along angle (degrees, 0 = right). */
function Head({ x, y, angle, tone = 'ink' }: { x: number; y: number; angle: number; tone?: Tone }) {
  return (
    <path
      d="M-7 -4.5L0 0L-7 4.5"
      transform={`translate(${x} ${y}) rotate(${angle})`}
      className={STROKE[tone]}
      fill="none"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function Line({ d, tone = 'hint', dashed = false, draw = false, width = 1.5 }: { d: string; tone?: Tone; dashed?: boolean; draw?: boolean; width?: number }) {
  return (
    <path
      d={d}
      className={`${STROKE[tone]} ${draw ? 'copy-art-draw' : ''}`}
      fill="none"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={dashed ? '2 5' : undefined}
      pathLength={draw ? 1 : undefined}
    />
  );
}

/* The machines your Workspace makes: agents, sites and CI, a few of each,
   spread across the width they are given. */
function Machines({ x, y, width = 300 }: { x: number; y: number; width?: number }) {
  const kinds: { icon: IconName; label: string; count: number }[] = [
    { icon: 'machine', label: 'agents', count: 3 },
    { icon: 'globe', label: 'sites', count: 2 },
    { icon: 'check', label: 'CI', count: 2 },
  ];
  const step = 40;
  const widths = kinds.map((kind) => kind.count * step - 8);
  const used = widths.reduce((a, b) => a + b, 0);
  const gap = Math.min(56, Math.max(26, (width - used) / (kinds.length - 1)));
  let cx = x;
  return (
    <g>
      {kinds.map((kind, k) => {
        const start = cx;
        cx += widths[k] + gap;
        return (
          <g key={kind.label}>
            {Array.from({ length: kind.count }, (_, i) => (
              <g key={i}>
                <rect x={start + i * step} y={y} width={32} height={32} rx={9} className="fill-panel-soft" />
                <Icon name={kind.icon} x={start + i * step + 6} y={y + 6} size={20} tone="ink" />
              </g>
            ))}
            <Label x={start + widths[k] / 2} y={y + 50} anchor="middle" size={12}>
              {kind.label}
            </Label>
          </g>
        );
      })}
    </g>
  );
}

/* ── 1. Everything runs on your side ─────────────────────────────────────
   Your Fly organization holds everything the installer makes; three things
   stay with us; two arrows cross between them: the release download in,
   and out the daily report of counts and, only on purpose, diagnostics
   (note #1059). No data of theirs crosses. */

function SidesWide() {
  /* Since note #1096 (Adam, 9 Nov 2026, 14:53 UTC: "drawing should be
     larger ... fonts should be larger. more optimized") the same things in
     less room, so the type can grow while the drawing still fits the
     page's column: your organization's cards in two columns, not three
     (the registry beside the sites, so the release arrow runs straight from
     the update service); the gap between the sides only as wide as
     "Releases," over "free to download"; the dashed line's label the
     phone's own short words; the pills 30 units under their cards, not 62.
     At 1440x900 it is 1,067 px wide, the column's width, at 1.02 px a unit
     (0.93 before). Until #1096: three columns, viewBox 1150 x 540, 14-unit
     titles. */
  const PAD = 20;
  const GAP = 12;
  const A = PAD;
  const WA = 292; /* wide enough for the machines' seven pictograms */
  const B = A + WA + GAP;
  const WB = 286; /* "a mail receiver of your own," */
  const SIDE = B + WB + PAD; /* your organization's width */
  const MIDGAP = 140; /* "free to download" on its own line */
  const OURS = SIDE + MIDGAP + 16; /* the left edge of our cards */
  const OW = 252; /* "calls, and what you send" */
  const WIDTH = OURS + OW + 16;
  const LINE = 80; /* the dashed line from the Workspace to us */
  const R1 = 94;
  const R2 = R1 + CARD_H + GAP;
  const R3 = R2 + CARD_H + GAP;
  const R4 = R3 + CARD_H + GAP;
  const H4 = 124;
  const BOTTOM = R4 + H4 + PAD;
  const OURS_BOTTOM = R3 + CARD_H + PAD;
  const MID = SIDE + MIDGAP / 2;
  const PILLS = R4 + H4 + 30;
  return (
    <svg viewBox={`0 0 ${WIDTH} ${PILLS + 40}`} className="block h-auto w-full" role="img" aria-label="Your Fly organization holds the Workspace and its database, the code host with CI, previews and sites, your own registry, files and backups buckets, every agent, site and CI machine, and email. With us stay support, the update service and the source code with the releases. Releases come in from the update service, free to download. A daily report of counts goes out, which your admin sees and can turn off, and a diagnostics bundle only if your admin sends it.">
      {/* Your side */}
      <rect x={0} y={0} width={SIDE} height={BOTTOM} rx={24} className="fill-panel-soft" />
      <Label x={PAD + 4} y={36} tone="ink" size={19} weight={600}>
        Your Fly organization
      </Label>
      <Label x={PAD + 220} y={36} size={15}>
        on agents.yourcompany.com
      </Label>

      <Node x={A} y={R1} w={WA} icon="workspace" title="Workspace" lines={['its database, always on']} />
      <Node x={B} y={R1} w={WB} icon="branch" title="Code host" lines={['with CI in your account']} />
      <Node x={A} y={R2} w={WA} icon="globe" title="Previews and sites" lines={['on names under your domain']} />
      <Node x={B} y={R2} w={WB} icon="layers" title="Your registry" lines={['every image it runs']} tone="accent" />
      <Node x={A} y={R3} w={WA} icon="bucket" title="Files" lines={['a bucket of yours']} />
      <Node x={B} y={R3} w={WB} icon="bucket" title="Backups" lines={['a bucket of yours, daily']} />

      <g>
        <rect x={A} y={R4} width={WA} height={H4} rx={14} className="fill-panel stroke-white/12" strokeWidth={1} />
        <Label x={A + 16} y={R4 + 30} tone="ink" size={CARD_TITLE} weight={600}>
          Agent, site and CI machines
        </Label>
        <Label x={A + 16} y={R4 + 52} size={CARD_LINE}>
          made by your Workspace, as on ours
        </Label>
        <WideMachines x={A + 16} y={R4 + 64} width={WA - 32} />
      </g>
      <Node x={B} y={R4} w={WB} h={H4} icon="mail" title="Email" lines={['addresses on your domain,', 'a mail receiver of your own,', 'mail out via your provider']} />

      {/* Out of your organization, to your own providers, never to us */}
      <Outside x={A + 66} y={R4 + H4} to={PILLS} label="Your people’s own AI subscriptions" width={290} anchor="start" left={A} />
      <Outside x={B + WB / 2} y={R4 + H4} to={PILLS} label="Your mail provider" width={170} />

      {/* Ours */}
      <rect x={OURS - 15.5} y={0.5} width={OW + 31} height={OURS_BOTTOM - 1} rx={24} fill="none" className="stroke-white/15" strokeWidth={1} />
      <Label x={OURS + 4} y={36} tone="ink" size={19} weight={600}>
        With us
      </Label>
      <Node x={OURS} y={R1} w={OW} icon="support" title="Support" lines={['calls, and what you send']} />
      <Node x={OURS} y={R2} w={OW} icon="download" title="Update service" lines={['releases, no sign-in']} />
      <Node x={OURS} y={R3} w={OW} icon="code" title="Our source code" lines={['and the releases']} />
      <Line d={`M ${OURS + OW / 2} ${R3} V ${R2 + CARD_H + 2}`} />
      <Head x={OURS + OW / 2} y={R2 + CARD_H + 2} angle={-90} tone="hint" />

      {/* The one download: a release, into your registry */}
      <Line d={`M ${OURS - 4} ${R2 + CARD_H / 2} H ${B + WB + 6}`} tone="accent" draw width={2} />
      <g className="copy-art-arrive">
        <Head x={B + WB + 6} y={R2 + CARD_H / 2} angle={180} tone="accent" />
      </g>
      <Label x={MID + 8} y={R2 + CARD_H / 2 - 30} anchor="middle" tone="accent" size={CARD_LINE}>
        Releases,
      </Label>
      <Label x={MID + 8} y={R2 + CARD_H / 2 - 11} anchor="middle" tone="accent" size={CARD_LINE}>
        free to download
      </Label>

      {/* What goes the other way: the daily report of counts (note #1059,
          the pulse of note #1057, which the admin sees and can turn off),
          and a diagnostics bundle only on purpose. No data of theirs. Since
          note #1096 it says it in the phone drawing's own words, on one
          line ("A daily report of counts, which your admin sees / A
          diagnostics bundle, only if your admin sends it" until then); the
          screen-reader sentence keeps the whole of it. */}
      <Line d={`M ${A + 120} ${R1} V ${LINE} H ${OURS + OW / 2} V ${R1 - 4}`} dashed />
      <Head x={OURS + OW / 2} y={R1 - 4} angle={90} tone="hint" />
      <Label x={A + 134} y={LINE - 12} size={CARD_LINE}>
        Daily counts, and diagnostics if your admin sends them
      </Label>
    </svg>
  );
}

/* The machines in the wide plan (note #1096): the same three kinds as
   Machines, at the plan's larger type. */
function WideMachines({ x, y, width }: { x: number; y: number; width: number }) {
  const kinds: { icon: IconName; label: string; count: number }[] = [
    { icon: 'machine', label: 'agents', count: 3 },
    { icon: 'globe', label: 'sites', count: 2 },
    { icon: 'check', label: 'CI', count: 2 },
  ];
  const step = 36;
  const widths = kinds.map((kind) => kind.count * step - 6);
  const used = widths.reduce((a, b) => a + b, 0);
  const gap = (width - used) / (kinds.length - 1);
  let cx = x;
  return (
    <g>
      {kinds.map((kind, k) => {
        const start = cx;
        cx += widths[k] + gap;
        return (
          <g key={kind.label}>
            {Array.from({ length: kind.count }, (_, i) => (
              <g key={i}>
                <rect x={start + i * step} y={y} width={30} height={30} rx={8} className="fill-panel-soft" />
                <Icon name={kind.icon} x={start + i * step + 5} y={y + 5} size={20} tone="ink" />
              </g>
            ))}
            <Label x={start + widths[k] / 2} y={y + 49} anchor="middle" size={14}>
              {kind.label}
            </Label>
          </g>
        );
      })}
    </g>
  );
}

/* Somewhere your machines talk to that is neither yours nor ours: a dashed
   drop from the card it hangs from to a pill (30 units since note #1096,
   62 before). */
function Outside({ x, y, to, label, width, anchor = 'middle', left }: { x: number; y: number; to: number; label: string; width: number; anchor?: 'middle' | 'start'; left?: number }) {
  const px = anchor === 'start' && left !== undefined ? left : x - width / 2;
  return (
    <g>
      <Line d={`M ${x} ${y} V ${to - 6}`} dashed />
      <Head x={x} y={to - 6} angle={90} tone="hint" />
      <rect x={px} y={to} width={width} height={36} rx={18} fill="none" className="stroke-white/20" strokeWidth={1} strokeDasharray="3 4" />
      <Label x={px + width / 2} y={to + 23.5} anchor="middle" size={CARD_LINE}>
        {label}
      </Label>
    </g>
  );
}

function SidesTall() {
  const L = 16;
  const R = 183;
  const W = 151;
  const H = 68;
  const top = 0;
  const r0 = 66;
  const r1 = r0 + 108;
  const r2 = r1 + H + 12;
  const r3 = r2 + 90;
  const r4 = r3 + H + 12;
  const end = r4 + H + 16;
  const ours = end + 76;
  const o1 = ours + 50;
  const o2 = o1 + H + 40;
  return (
    <svg viewBox={`0 0 350 ${o2 + H + 18}`} className="block h-auto w-full" role="img" aria-label="Your Fly organization holds every agent, site and CI machine, the code host, previews and sites, email, files and backups buckets, the Workspace and your own registry. With us stay support, the update service and the source code. Releases come in from the update service, free to download. A daily report of counts goes out, which your admin sees and can turn off, and diagnostics only if your admin sends them.">
      <rect x={0} y={top} width={350} height={end} rx={22} className="fill-panel-soft" />
      <Label x={L} y={30} tone="ink" size={15} weight={600}>
        Your Fly organization
      </Label>
      <Label x={L} y={50} size={12.5}>
        on agents.yourcompany.com
      </Label>

      <g>
        <rect x={L} y={r0} width={318} height={96} rx={14} className="fill-panel stroke-white/12" strokeWidth={1} />
        <Label x={L + 14} y={r0 + 25} tone="ink" size={13.5} weight={600}>
          Agent, site and CI machines
        </Label>
        <g transform={`translate(${L + 14} ${r0 + 38}) scale(0.82)`}>
          <Machines x={0} y={0} width={354} />
        </g>
      </g>
      <SmallNode x={L} y={r1} w={W} icon="branch" title="Code host" line="CI in your account" />
      <SmallNode x={R} y={r1} w={W} icon="globe" title="Previews, sites" line="under your domain" />
      <SmallNode x={L} y={r2} w={318} h={78} icon="mail" title="Email" line="addresses on your domain," line2="a mail receiver of your own" />
      <SmallNode x={L} y={r3} w={W} icon="bucket" title="Files" line="a bucket of yours" />
      <SmallNode x={R} y={r3} w={W} icon="bucket" title="Backups" line="a bucket, daily" />
      <SmallNode x={L} y={r4} w={W} icon="workspace" title="Workspace" line="and its database" />
      <SmallNode x={R} y={r4} w={W} icon="layers" title="Your registry" line="every image it runs" tone="accent" />

      {/* The two crossings, straight up and down between the halves */}
      <Line d={`M ${R + W / 2} ${o1 - 4} V ${r4 + H + 6}`} tone="accent" draw width={2} />
      <g className="copy-art-arrive">
        <Head x={R + W / 2} y={r4 + H + 6} angle={-90} tone="accent" />
      </g>
      {['Releases,', 'free to', 'download'].map((line, i) => (
        <Label key={line} x={R + W / 2 + 10} y={end + 26 + i * 15} tone="accent" size={12.5}>
          {line}
        </Label>
      ))}
      <Line d={`M ${L + W / 2} ${r4 + H + 2} V ${o1 - 6}`} dashed />
      <Head x={L + W / 2} y={o1 - 6} angle={90} tone="hint" />
      {/* Four lines where diagnostics had three, so they start higher and
          the last clears the "With us" box (note #1059). */}
      {['Daily counts,', 'and diagnostics', 'if your admin', 'sends them'].map((line, i) => (
        <Label key={line} x={L + W / 2 + 10} y={end + 16 + i * 15} size={12.5}>
          {line}
        </Label>
      ))}

      <rect x={0} y={ours} width={350} height={o2 + H + 16 - ours} rx={22} fill="none" className="stroke-white/15" strokeWidth={1} />
      <Label x={L} y={ours + 32} tone="ink" size={15} weight={600}>
        With us
      </Label>
      <SmallNode x={L} y={o1} w={W} icon="support" title="Support" line="calls, what you send" />
      <SmallNode x={R} y={o1} w={W} icon="download" title="Update service" line="releases, no sign-in" />
      <SmallNode x={L} y={o2} w={318} icon="code" title="Our source code" line="and the releases" />
      <Line d={`M ${R + W / 2} ${o2} V ${o1 + H + 4}`} />
      <Head x={R + W / 2} y={o1 + H + 4} angle={-90} tone="hint" />
    </svg>
  );
}

/* The phone's card: pictogram above, so a name gets the whole width. */
function SmallNode({ x, y, w, h = 68, icon, title, line, line2, tone = 'ink' }: { x: number; y: number; w: number; h?: number; icon: IconName; title: string; line: string; line2?: string; tone?: Tone }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={14} className="fill-panel stroke-white/12" strokeWidth={1} />
      <Icon name={icon} x={x + 12} y={y + 12} size={20} tone={tone} />
      <text x={x + 40} y={y + 27} fontSize={13.5} fontWeight={600} className="fill-white">
        {title}
      </text>
      <text x={x + 12} y={y + 51} fontSize={12.5} className="fill-hint">
        {line}
      </text>
      {line2 ? (
        <text x={x + 12} y={y + 67} fontSize={12.5} className="fill-hint">
          {line2}
        </text>
      ) : null}
    </g>
  );
}

export function SidesArt() {
  return (
    <figure className="copy-art copy-art-sides mt-10">
      <div className="hidden lg:block">
        <SidesWide />
      </div>
      <div className="mx-auto max-w-[440px] lg:hidden">
        <SidesTall />
      </div>
    </figure>
  );
}

/* ── The hero: the six things the first paragraph names, on your side ────
   The Workspace, the agents, the code, the sites, the files and the email,
   inside your organization, on your domain, put there by one command. */

/* One of the six things, drawn at a size it can be recognised, standing on
   the organization's floor with its name under it. No card around it: the
   boundary is the one container in the picture. */
function Thing({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-3">
      <div className="flex h-14 w-full items-end justify-center sm:h-[72px] lg:h-[88px]">{children}</div>
      <p className="type-sm font-semibold text-white lg:type-base">{label}</p>
    </div>
  );
}

/* The six small pictures, each the thing itself at thumbnail size. */
function MiniWorkspace() {
  return (
    <svg viewBox="0 0 64 48" className="h-full w-auto" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="62" height="46" rx="7" className="fill-panel-soft" />
      <rect x="1" y="1" width="16" height="46" rx="7" className="fill-white/8" />
      <circle cx="9" cy="10" r="3" className="fill-white/40" />
      <circle cx="9" cy="19" r="3" className="fill-white/25" />
      <circle cx="9" cy="28" r="3" className="fill-white/25" />
      <rect x="23" y="9" width="26" height="6" rx="3" className="fill-white/20" />
      <rect x="31" y="19" width="26" height="6" rx="3" className="fill-white" />
      <rect x="23" y="29" width="20" height="6" rx="3" className="fill-white/20" />
    </svg>
  );
}

function MiniAgents() {
  return (
    <div className="flex items-center -space-x-2.5">
      {[FACES.ada, FACES.ruby, FACES.otis].map((src) => (
        <img key={src} src={src} alt="" width={40} height={40} className="h-9 w-9 rounded-full border-2 border-panel object-cover sm:h-10 sm:w-10 lg:h-12 lg:w-12" />
      ))}
    </div>
  );
}

function MiniCode() {
  return (
    <svg viewBox="0 0 64 48" className="h-full w-auto" fill="none" aria-hidden="true">
      <path d="M4 36h56" className="stroke-white" strokeWidth="2" strokeLinecap="round" />
      <path d="M18 36c0-14 4-20 13-20h12c7 0 9 6 9 20" className="stroke-accent" strokeWidth="2" strokeLinecap="round" />
      {[8, 18, 52].map((x) => (
        <circle key={x} cx={x} cy="36" r="3.6" className="fill-panel stroke-white" strokeWidth="2" />
      ))}
      {[31, 43].map((x) => (
        <circle key={x} cx={x} cy="16" r="3.6" className="fill-panel stroke-accent" strokeWidth="2" />
      ))}
    </svg>
  );
}

function MiniSite() {
  return (
    <svg viewBox="0 0 64 48" className="h-full w-auto" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="62" height="46" rx="7" className="fill-panel-soft" />
      <circle cx="8" cy="8" r="2" className="fill-white/30" />
      <circle cx="14" cy="8" r="2" className="fill-white/30" />
      <rect x="20" y="5.5" width="36" height="5" rx="2.5" className="fill-panel" />
      <rect x="8" y="18" width="30" height="5" rx="2.5" className="fill-white" />
      <rect x="8" y="27" width="22" height="4" rx="2" className="fill-white/25" />
      <rect x="8" y="36" width="14" height="5" rx="2.5" className="fill-accent" />
      <rect x="42" y="18" width="14" height="23" rx="3" className="fill-white/10" />
    </svg>
  );
}

function MiniFiles() {
  return (
    <svg viewBox="0 0 64 48" className="h-full w-auto" fill="none" aria-hidden="true">
      <rect x="10" y="12" width="26" height="34" rx="3" className="fill-panel-soft stroke-white" strokeWidth="1.6" />
      <rect x="19" y="8" width="26" height="34" rx="3" className="fill-panel-soft stroke-white" strokeWidth="1.6" />
      <path d="M28 7a3 3 0 0 1 3-3h15l8 8v23a3 3 0 0 1-3 3H31a3 3 0 0 1-3-3z" className="fill-panel stroke-white" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M46 4v8h8" className="stroke-white" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M33 20h16M33 26h16M33 32h10" className="stroke-white/40" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function MiniMail() {
  return (
    <svg viewBox="0 0 64 48" className="h-full w-auto" fill="none" aria-hidden="true">
      <rect x="6" y="6" width="52" height="36" rx="6" className="fill-panel-soft stroke-white" strokeWidth="1.6" />
      <path d="M8 9l24 18L56 9" className="stroke-white" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="52" cy="10" r="7" className="fill-accent" />
      <text x="52" y="13.6" fontSize="10" fontWeight="700" textAnchor="middle" className="fill-panel">
        @
      </text>
    </svg>
  );
}

export function HeroArt() {
  return (
    <figure
      className="copy-art relative mt-12 rounded-[28px] border-[1.5px] border-white px-4 pb-4 pt-9 sm:mt-14 sm:px-8 sm:pb-6 sm:pt-12"
      role="img"
      aria-label="On agents.yourcompany.com, inside your Fly organization: the Workspace, the agents, the code, the sites, the files and the email, put there by one install command."
    >
      {/* The boundary's name sits in a gap cut into its own line */}
      <p className="absolute -top-[11px] left-5 flex items-center gap-1.5 bg-panel px-2 type-sm font-semibold text-white sm:left-7">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 stroke-white" fill="none" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
        agents.yourcompany.com
      </p>
      <p className="absolute -top-[11px] right-5 hidden bg-panel px-2 type-sm text-hint sm:right-7 sm:block">Your Fly organization</p>
      <div className="grid grid-cols-3 gap-x-3 gap-y-7 sm:grid-cols-6 sm:gap-x-6">
        <Thing label="Workspace">
          <MiniWorkspace />
        </Thing>
        <Thing label="Agents">
          <MiniAgents />
        </Thing>
        <Thing label="Code">
          <MiniCode />
        </Thing>
        <Thing label="Sites">
          <MiniSite />
        </Thing>
        <Thing label="Files">
          <MiniFiles />
        </Thing>
        <Thing label="Email">
          <MiniMail />
        </Thing>
      </div>
      <p className="mt-5 text-center type-sm text-hint sm:hidden">Your Fly organization</p>
      <div className="mt-5 flex items-center gap-3 border-t border-hint/16 pt-4 sm:mt-9 sm:pt-5">
        <span className="font-mono type-xs text-hint sm:type-sm" aria-hidden="true">$</span>
        <code className="min-w-0 flex-1 truncate font-mono type-xs text-white sm:type-sm">node install.mjs install</code>
        <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 stroke-ok" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8.4 12.2l2.5 2.5 4.8-5.1" />
        </svg>
      </div>
    </figure>
  );
}

/* ── 2. The install and the upgrade, as a line of stations ─────────────────
   The stations are the installer's own steps in its own order (install.mjs,
   and the ordered list under the drawing). A station is a ring with its
   pictogram, a name, and at most two short lines. */

type Station = { icon: IconName; title: string; lines: string[]; tone?: Tone };

export const INSTALL_STEPS: Station[] = [
  { icon: 'shield', title: 'Checks', lines: ['billing, the key,', 'the release'] },
  { icon: 'layers', title: 'Five apps', lines: ['and the release, into', 'your registry'] },
  { icon: 'key', title: 'Buckets, keys', lines: ['and addresses'] },
  { icon: 'machine', title: 'Deploys', lines: ['four apps, and asks', 'for certificates'] },
  { icon: 'records', title: 'DNS records', lines: ['checked every', '15 seconds'] },
  { icon: 'check', title: 'Smoke test', lines: ['Workspace, code,', 'previews'] },
  { icon: 'link', title: 'One-time link', lines: ['and the master key,', 'shown once'], tone: 'ok' },
];

function Ring({ cx, cy, icon, tone = 'ink', r = 23 }: { cx: number; cy: number; icon: IconName; tone?: Tone; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} className={`fill-panel ${tone === 'ok' ? 'stroke-ok' : tone === 'accent' ? 'stroke-accent' : 'stroke-white/25'}`} strokeWidth={1.5} />
      <Icon name={icon} x={cx - 11} y={cy - 11} size={22} tone={tone} />
    </g>
  );
}

function StationText({ x, y, s, anchor = 'middle' }: { x: number; y: number; s: Station; anchor?: 'start' | 'middle' }) {
  return (
    <g>
      <Label x={x} y={y} anchor={anchor} tone={s.tone === 'ok' ? 'ok' : 'ink'} size={14} weight={600}>
        {s.title}
      </Label>
      {s.lines.map((line, i) => (
        <Label key={line} x={x} y={y + 19 + i * 16} anchor={anchor} size={12}>
          {line}
        </Label>
      ))}
    </g>
  );
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function InstallWide() {
  const x0 = 76;
  const step = 161;
  const cy = 58;
  const last = x0 + step * (INSTALL_STEPS.length - 1);
  return (
    <svg viewBox="0 0 1120 236" className="block h-auto w-full" role="img" aria-label={INSTALL_SENTENCE}>
      <Line d={`M ${x0} ${cy} H ${last}`} tone="ink" width={1.5} />
      {INSTALL_STEPS.map((s, i) => (
        <g key={s.title}>
          <Ring cx={x0 + i * step} cy={cy} icon={s.icon} tone={s.tone} />
          <StationText x={x0 + i * step} y={cy + 50} s={s} />
        </g>
      ))}
      {/* The state file runs under every step */}
      <path d={`M ${x0 - 40} 172 V 184 H ${last + 40} V 172`} fill="none" className="stroke-white/20" strokeWidth={1} />
      <Icon name="records" x={x0 - 40} y={198} size={18} tone="hint" />
      <text x={x0 - 14} y={212} fontSize={12.5} className="fill-hint">
        <tspan className="fill-white" fontWeight={600} fontFamily={MONO} fontSize={12}>
          &lt;name&gt;-copy.json
        </tspan>
        <tspan dx={8}>every step is written here as it finishes. Run the same command again and it carries on from the first unfinished one.</tspan>
      </text>
    </svg>
  );
}

const INSTALL_SENTENCE =
  'The install, in order: checks billing, the key and the release; creates five apps and copies the release into your registry; makes buckets, keys and addresses; deploys four apps and asks for certificates; checks the DNS records every 15 seconds; runs a smoke test; prints the one-time link and the master key, once. Every step is written to a state file, so running it again carries on.';

function InstallTall() {
  const x = 30;
  const y0 = 30;
  const step = 74;
  const last = y0 + step * (INSTALL_STEPS.length - 1);
  return (
    <svg viewBox={`0 0 350 ${last + 128}`} className="block h-auto w-full" role="img" aria-label={INSTALL_SENTENCE}>
      <Line d={`M ${x} ${y0} V ${last}`} tone="ink" />
      {INSTALL_STEPS.map((s, i) => (
        <g key={s.title}>
          <Ring cx={x} cy={y0 + i * step} icon={s.icon} tone={s.tone} r={21} />
          <Label x={x + 38} y={y0 + i * step - 4} tone={s.tone === 'ok' ? 'ok' : 'ink'} size={14} weight={600}>
            {s.title}
          </Label>
          <Label x={x + 38} y={y0 + i * step + 14} size={12}>
            {s.lines.join(' ')}
          </Label>
        </g>
      ))}
      <path d={`M 4 ${last + 44} H 346`} fill="none" className="stroke-white/20" strokeWidth={1} />
      <text x={4} y={last + 70} fontSize={12} fontWeight={600} fontFamily={MONO} className="fill-white">
        &lt;name&gt;-copy.json
      </text>
      <Label x={4} y={last + 90} size={12}>
        Every step is written here as it finishes. Run
      </Label>
      <Label x={4} y={last + 106} size={12}>
        the same command again and it carries on.
      </Label>
    </svg>
  );
}

export function InstallArt() {
  return (
    <figure className="copy-art mt-10">
      <div className="hidden lg:block">
        <InstallWide />
      </div>
      <div className="mx-auto max-w-[440px] lg:hidden">
        <InstallTall />
      </div>
    </figure>
  );
}

/* The upgrade: the same kind of line, and the way back under it. */
const UPGRADE_STEPS: Station[] = [
  { icon: 'layers', title: 'Copies the release', lines: ['into your registry'] },
  { icon: 'camera', title: 'Snapshots', lines: ['the database', 'and the disks'] },
  { icon: 'machine', title: 'Rolls four apps', lines: ['one at a time,', 'each healthy first'] },
  { icon: 'check', title: 'Smoke test', lines: ['the same as', 'the install’s'] },
];

const UPGRADE_SENTENCE =
  'The upgrade, in order: copies the release into your registry, snapshots the database and the disks, rolls the four apps one at a time waiting for each to be healthy, and runs the smoke test. If anything fails, it puts the old release back on all four and the database back as it was. The drill rehearses exactly that.';

/* The four apps the upgrade rolls, in the installer's ROLL_ORDER, each with
   the health light it waits for. */
export const ROLLED_APPS = ['backend', 'git', 'router', 'mx'];
const CHIP_WIDTH: Record<string, number> = { backend: 66, git: 38, router: 58, mx: 36 };

function AppChips({ cx, y }: { cx: number; y: number }) {
  const apps = ROLLED_APPS.map((name) => ({ name, w: CHIP_WIDTH[name] ?? 60 }));
  const gap = 6;
  const total = apps.reduce((sum, app) => sum + app.w, 0) + gap * (apps.length - 1);
  let x = cx - total / 2;
  return (
    <g>
      {apps.map((app) => {
        const left = x;
        x += app.w + gap;
        return (
          <g key={app.name}>
            <rect x={left} y={y} width={app.w} height={20} rx={10} className="fill-panel-soft" />
            <circle cx={left + 10} cy={y + 10} r={2.5} className="fill-ok" />
            <text x={left + 17} y={y + 14} fontSize={10.5} fontFamily={MONO} className="fill-hint">
              {app.name}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function UpgradeWide() {
  const start = 70;
  const x0 = 250;
  const step = 190;
  const cy = 66;
  const end = x0 + step * UPGRADE_STEPS.length;
  return (
    <svg viewBox="0 0 1120 300" className="block h-auto w-full" role="img" aria-label={UPGRADE_SENTENCE}>
      <Line d={`M ${start} ${cy} H ${end}`} tone="ink" />
      <Ring cx={start} cy={cy} icon="package" r={25} />
      <StationText x={start} y={cy + 52} s={{ icon: 'package', title: 'Your release', lines: ['as it runs today'] }} />
      {UPGRADE_STEPS.map((s, i) => (
        <g key={s.title}>
          <Ring cx={x0 + i * step} cy={cy} icon={s.icon} />
          <StationText x={x0 + i * step} y={cy + 50} s={s} />
        </g>
      ))}
      <AppChips cx={x0 + 2 * step} y={cy + 92} />
      <Ring cx={end} cy={cy} icon="package" tone="ok" r={25} />
      <StationText x={end} y={cy + 52} s={{ icon: 'package', title: 'The new release', lines: ['running'], tone: 'ok' }} />

      {/* The way back */}
      <path
        d={`M ${x0 + 3 * step} ${cy + 104} V ${cy + 160} a 18 18 0 0 1 -18 18 H ${start + 18} a 18 18 0 0 1 -18 -18 V ${cy + 96}`}
        fill="none"
        className="stroke-white"
        strokeWidth={1.5}
        strokeDasharray="5 5"
        strokeLinecap="round"
      />
      <Head x={start} y={cy + 94} angle={-90} />
      <Label x={(start + x0 + 3 * step) / 2} y={cy + 170} anchor="middle" tone="ink" size={13} weight={600}>
        If anything fails: the old release on all four, and the database as it was.
      </Label>
      <Label x={(start + x0 + 3 * step) / 2} y={cy + 206} anchor="middle" size={12}>
        --drill rehearses exactly that: it upgrades, fails on purpose, and comes back.
      </Label>
    </svg>
  );
}

function UpgradeTall() {
  const x = 52;
  const y0 = 34;
  const step = 84;
  const steps: Station[] = [{ icon: 'package', title: 'Your release', lines: ['as it runs today'] }, ...UPGRADE_STEPS, { icon: 'package', title: 'The new release', lines: ['running'], tone: 'ok' }];
  const last = y0 + step * (steps.length - 1);
  return (
    <svg viewBox={`0 0 350 ${last + 96}`} className="block h-auto w-full" role="img" aria-label={UPGRADE_SENTENCE}>
      <Line d={`M ${x} ${y0} V ${last}`} tone="ink" />
      {steps.map((s, i) => (
        <g key={s.title}>
          <Ring cx={x} cy={y0 + i * step} icon={s.icon} tone={s.tone} r={21} />
          <Label x={x + 36} y={y0 + i * step - 4} tone={s.tone === 'ok' ? 'ok' : 'ink'} size={14} weight={600}>
            {s.title}
          </Label>
          <Label x={x + 36} y={y0 + i * step + 14} size={12}>
            {s.lines.join(' ')}
          </Label>
        </g>
      ))}
      {/* The way back runs up the left side, from the smoke test to the start */}
      <path d={`M ${x - 21} ${y0 + 4 * step} H 18 a 8 8 0 0 1 -8 -8 V ${y0 + 8} a 8 8 0 0 1 8 -8 H ${x - 24}`} fill="none" className="stroke-white" strokeWidth={1.5} strokeDasharray="5 5" strokeLinecap="round" />
      <Head x={x - 24} y={y0} angle={0} />
      <Label x={4} y={last + 44} tone="ink" size={13} weight={600}>
        If anything fails: the old release on all four,
      </Label>
      <Label x={4} y={last + 62} tone="ink" size={13} weight={600}>
        and the database as it was.
      </Label>
      <Label x={4} y={last + 84} size={12}>
        --drill rehearses exactly that.
      </Label>
    </svg>
  );
}

export function UpgradeArt() {
  return (
    <figure className="copy-art mt-10">
      <div className="hidden lg:block">
        <UpgradeWide />
      </div>
      <div className="mx-auto max-w-[440px] lg:hidden">
        <UpgradeTall />
      </div>
    </figure>
  );
}

/* ── One agent's computer, through a day (/why-fly, note #838) ─────────────
   The page's one drawing and its point: asleep when nobody needs it, awake by
   itself when a link is opened or a message arrives, asleep again after. A
   real sequence, so it reads left to right along one track; no times on it
   (the owner, 30 Oct: no wake time on the page). Drawn at a phone's width so
   its 12.5 px labels stay 12.5 px there; a desk draws it a little larger. */
export function AgentDayArt() {
  const Y = 132; /* the track */
  const spans: { from: number; to: number; awake: boolean }[] = [
    { from: 20, to: 92, awake: false },
    { from: 92, to: 168, awake: true },
    { from: 168, to: 232, awake: false },
    { from: 232, to: 308, awake: true },
    { from: 308, to: 340, awake: false },
  ];
  const events: { x: number; icon: IconName; label: string }[] = [
    { x: 92, icon: 'globe', label: 'A link is opened' },
    { x: 232, icon: 'mail', label: 'A message arrives' },
  ];
  return (
    <figure className="copy-art copy-art-day m-0">
      <svg
        viewBox="0 0 360 184"
        className="block h-auto w-full"
        role="img"
        aria-label="One agent’s computer through a day: asleep, then awake by itself when a link is opened, asleep again when nobody needs it, then awake by itself when a message arrives, and asleep again."
      >
        <rect x={0} y={0} width={360} height={184} rx={20} className="fill-panel-soft" />
        {events.map((event) => (
          <g key={event.label}>
            <Label x={event.x} y={30} anchor="middle" tone="ink" weight={600}>{event.label}</Label>
            <Icon name={event.icon} x={event.x - 10} y={44} size={20} tone="ink" />
            <Line d={`M ${event.x} 74 V ${Y - 12}`} tone="ink" />
            <Head x={event.x} y={Y - 12} angle={90} tone="ink" />
          </g>
        ))}
        {spans.map((span) => (span.awake ? (
          <line key={span.from} x1={span.from + 3} x2={span.to - 3} y1={Y} y2={Y} className="stroke-white" strokeWidth={8} strokeLinecap="round" />
        ) : (
          <line key={span.from} x1={span.from + 3} x2={span.to - 3} y1={Y} y2={Y} className="stroke-hint" strokeWidth={1.5} strokeLinecap="round" strokeDasharray="2 5" />
        )))}
        {spans.filter((span) => span.to - span.from > 50).map((span) => (
          <Label key={span.from} x={(span.from + span.to) / 2} y={Y + 30} anchor="middle" tone={span.awake ? 'ink' : 'hint'}>
            {span.awake ? 'awake' : 'asleep'}
          </Label>
        ))}
      </svg>
    </figure>
  );
}
