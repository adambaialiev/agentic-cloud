import { FACES } from './live/fixture';
import { Icon, type IconName } from './CopyArt';

/**
 * The workplace around the agents, as one floor plan (note #841, the owner,
 * 30 Oct 2026, 13:31 UTC: "We should have some illustration that illustrated
 * the workplace around agents").
 *
 * The home page's sections each show one part of the workplace as a real
 * screen; this is the whole of it at a glance, before them. It is drawn as an
 * office seen from above because the page already talks in those words: a
 * desk for every agent, a lead at the front desk. Every part on it is a part
 * of the product:
 *
 * - one open floor, every agent at a desk of its own in one row, as the
 *   Workspace lists them (rooms left the product with note #843, and the
 *   owner had the plan redrawn without them, 31 Oct, 08:00 UTC); only
 *   agents sit on it, since the owner took the people off the floor (31 Oct:
 *   "remove people avatars from the illustration"), so the one person drawn
 *   is you, at the door;
 * - each desk is the agent's own computer: lit while it works, dark while
 *   it sleeps (the machine sleeps when idle and wakes when work arrives);
 * - the Chief of Staff at the front desk, where you ask for things;
 * - memory, keys, and code with its checks and the shared tools, on shelves
 *   along the wall that every desk shares. They had walls and doors until
 *   note #924 (the owner, 31 Oct 2026): a door reads as a room, and rooms
 *   left the product, so the plan's one door is the way in;
 * - your yes at the door: what the agents make comes back to a person.
 *
 * The one rule the plan makes visible is its two dashed lines: jobs go out
 * from the front desk in the page's accent and light the screens they reach,
 * and proposals come back to your yes. Both are drawn as they are, never
 * animated in: a still picture of the page showed the jobs line missing
 * (note #924). No customer and no numbers. The names and faces are the
 * page's own agents (Ruby, Milo, Otis, Ada), as on the team view just below
 * it.
 *
 * Set twice, as CopyArt's drawings are: wide for a desk and tall for a phone,
 * because the wide plan shrunk onto a phone takes its labels down to
 * unreadable. A screen reader gets one sentence for the whole plan.
 */

const SAYS =
  'A floor plan of the workplace. You come in at the front desk, where the Chief of Staff takes what you ask for and sends out the jobs. One open floor, with a desk and a computer for every agent in one row: Ruby and Otis are at work, their screens lit by the jobs that reached them, while Milo’s and Ada’s computers sleep. Along the wall, shared by every desk: Memory, where agents read before every job; Keys, added once and used by name; and Code and checks, with sites, Drive and email. Proposals come back to your yes, by the door.';

/* ── The pieces the plan is made of ────────────────────────────────────── */

function Title({ x, y, title, sub }: { x: number; y: number; title: string; sub?: string }) {
  return (
    <g>
      <text x={x} y={y} fontSize={15} fontWeight={600} className="fill-white">
        {title}
      </text>
      {sub ? (
        <text x={x} y={y + 19} fontSize={13} className="fill-hint">
          {sub}
        </text>
      ) : null}
    </g>
  );
}

/* A wall, drawn as its segments around the gaps left for doors. */
function Wall({ from, to, at, horizontal, gaps = [], width = 2.5 }: { from: number; to: number; at: number; horizontal: boolean; gaps?: [number, number][]; width?: number }) {
  const cuts = [...gaps].sort((a, b) => a[0] - b[0]);
  const runs: [number, number][] = [];
  let start = from;
  for (const [a, b] of cuts) {
    runs.push([start, a]);
    start = b;
  }
  runs.push([start, to]);
  return (
    <g className="stroke-white" strokeWidth={width} strokeLinecap="square" fill="none">
      {runs.map(([a, b]) => (
        <path key={a} d={horizontal ? `M${a} ${at}H${b}` : `M${at} ${a}V${b}`} />
      ))}
    </g>
  );
}

/* The open floor: one rug of floor under every desk, no walls on it. */
function Floor({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return <rect x={x} y={y} width={w} height={h} rx={18} className="fill-panel-soft" />;
}

/* A door as a plan draws it: the leaf, open, and the arc it swings through.
   On a horizontal wall at y, the hinge at x, the leaf r long, swinging
   up (dir -1) or down (dir 1) towards the side of `toward`. */
function Door({ x, y, r, dir, toward, vertical = false }: { x: number; y: number; r: number; dir: 1 | -1; toward: 1 | -1; vertical?: boolean }) {
  /* SVG's sweep flag is clockwise on screen: the sign of the turn from the
     gap's far end to the open leaf, both seen from the hinge. */
  const d = vertical
    ? `M${x} ${y}H${x + dir * r}M${x} ${y + toward * r}A${r} ${r} 0 0 ${-toward * dir > 0 ? 1 : 0} ${x + dir * r} ${y}`
    : `M${x} ${y}V${y + dir * r}M${x + toward * r} ${y}A${r} ${r} 0 0 ${toward * dir > 0 ? 1 : 0} ${x} ${y + dir * r}`;
  return <path d={d} className="stroke-hint" strokeWidth={1} fill="none" />;
}

/* A face in a round frame: an agent's own pixel dog, dimmed while its
   computer sleeps. */
function Face({ id, x, y, r, src, dim = false }: { id: string; x: number; y: number; r: number; src: string; dim?: boolean }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} className="fill-panel" />
      <image
        href={src}
        x={x - r}
        y={y - r}
        width={r * 2}
        height={r * 2}
        clipPath={`url(#${id}-round)`}
        preserveAspectRatio="xMidYMid slice"
        opacity={dim ? 0.4 : 1}
      />
      <circle cx={x} cy={y} r={r} className="stroke-white" strokeWidth={1.5} fill="none" />
    </g>
  );
}

/* An agent's desk from above: the desk, its screen (lit while the agent
   works, dark while the computer sleeps), the keyboard, and the agent in
   its chair. */
function Desk({ id, x, y, name, src, working }: { id: string; x: number; y: number; name: string; src: string; working: boolean }) {
  return (
    <g>
      <rect x={x - 42} y={y} width={84} height={28} rx={3} className="fill-panel stroke-white" strokeWidth={1.5} />
      <rect x={x - 20} y={y + 5} width={40} height={6} rx={1.5} className={working ? 'fill-accent' : 'fill-panel stroke-hint'} strokeWidth={1} />
      <rect x={x - 13} y={y + 17} width={26} height={5} rx={1} className="fill-white/20" />
      <Face id={id} x={x} y={y + 50} r={16} src={src} dim={!working} />
      <text x={x} y={y + 86} fontSize={14} fontWeight={600} textAnchor="middle" className="fill-white">
        {name}
      </text>
      <text x={x} y={y + 103} fontSize={13} textAnchor="middle" className={working ? 'fill-accent' : 'fill-hint'}>
        {working ? 'working' : 'asleep'}
      </text>
    </g>
  );
}

/* You, at the door: a person in outline, the one figure not at a desk. */
function You({ x, y, label = 'below' }: { x: number; y: number; label?: 'below' | 'right' }) {
  return (
    <g>
      <circle cx={x} cy={y - 8} r={8} className="fill-panel stroke-white" strokeWidth={1.8} />
      <path d={`M${x - 14} ${y + 16}a14 13 0 0 1 28 0`} className="fill-panel stroke-white" strokeWidth={1.8} />
      <text x={label === 'below' ? x : x + 24} y={label === 'below' ? y + 38 : y + 9} fontSize={15} fontWeight={600} textAnchor={label === 'below' ? 'middle' : 'start'} className="fill-white">
        You
      </text>
    </g>
  );
}

/* The front desk: a curved counter, the Chief of Staff behind it. */
function FrontDesk({ id, x, y }: { id: string; x: number; y: number }) {
  return (
    <g>
      <Face id={id} x={x} y={y - 26} r={17} src="/agent-avatars/workspace-agent.jpg" />
      <path d={`M${x - 50} ${y - 4}Q${x} ${y + 30} ${x + 50} ${y - 4}L${x + 50} ${y + 8}Q${x} ${y + 42} ${x - 50} ${y + 8}Z`} className="fill-panel stroke-white" strokeWidth={1.5} strokeLinejoin="round" />
    </g>
  );
}

/* Your yes: a counter with a proposal on it and the stamp beside it. */
function YesCounter({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x - 50} y={y} width={100} height={26} rx={3} className="fill-panel stroke-white" strokeWidth={1.5} />
      <rect x={x - 30} y={y - 8} width={24} height={30} rx={2} className="fill-panel stroke-white" strokeWidth={1.2} />
      <path d={`M${x - 25} ${y + 1}h14M${x - 25} ${y + 7}h14M${x - 25} ${y + 13}h9`} className="stroke-white/40" strokeWidth={1.2} strokeLinecap="round" />
      <circle cx={x + 18} cy={y + 13} r={12} className="fill-ok" />
      <path d={`M${x + 12.5} ${y + 13.5}l3.6 3.6 7-7.4`} className="stroke-panel" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </g>
  );
}

/* Memory: shelves of pages along the wall, the spines in uneven runs. */
const SPINES: [number, number][] = [[7, 12], [5, 10], [9, 13], [6, 11], [4, 9], [8, 12], [6, 13], [10, 10], [5, 12], [7, 11], [6, 13], [4, 10], [9, 12], [7, 9]];
function Shelf({ x, y, w }: { x: number; y: number; w: number }) {
  let at = x + 5;
  const books: { x: number; w: number; h: number; o: number }[] = [];
  for (let i = 0; at + SPINES[i % SPINES.length]![0] < x + w - 5; i += 1) {
    const [bw, bh] = SPINES[i % SPINES.length]!;
    books.push({ x: at, w: bw, h: bh, o: 0.22 + ((i * 7) % 5) * 0.1 });
    at += bw + (i % 6 === 5 ? 7 : 1.5);
  }
  return (
    <g>
      <rect x={x} y={y} width={w} height={20} rx={2} className="fill-panel stroke-white" strokeWidth={1.5} />
      {books.map((book) => (
        <rect key={book.x} x={book.x} y={y + 17 - book.h} width={book.w} height={book.h} rx={1} className="fill-white" opacity={book.o} />
      ))}
    </g>
  );
}

/* Keys: a cabinet of hooks, a key on each. */
function KeyCabinet({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width={96} height={62} rx={4} className="fill-panel stroke-white" strokeWidth={1.5} />
      {[0, 1].map((row) =>
        [0, 1, 2].map((col) => <Icon key={`${row}${col}`} name="key" x={x + 8 + col * 28} y={y + 8 + row * 24} size={22} tone="ink" />),
      )}
    </g>
  );
}

/* Code and checks, and the shared tools beside them. */
const TOOLS: { icon: IconName; label: string; tone?: 'ok' }[] = [
  { icon: 'branch', label: 'code' },
  { icon: 'check', label: 'checks', tone: 'ok' },
  { icon: 'globe', label: 'sites' },
  { icon: 'records', label: 'Drive' },
  { icon: 'mail', label: 'email' },
];
function Tools({ x, y, step }: { x: number; y: number; step: number }) {
  return (
    <g>
      {TOOLS.map((tool, i) => (
        <g key={tool.label}>
          <rect x={x + i * step} y={y} width={40} height={40} rx={10} className="fill-panel stroke-white/25" strokeWidth={1} />
          <Icon name={tool.icon} x={x + i * step + 8} y={y + 8} size={24} tone={tool.tone ?? 'ink'} />
          <text x={x + i * step + 20} y={y + 60} fontSize={13} textAnchor="middle" className="fill-hint">
            {tool.label}
          </text>
        </g>
      ))}
    </g>
  );
}

function Head({ x, y, angle, tone }: { x: number; y: number; angle: number; tone: 'accent' | 'ink' }) {
  return (
    <path
      d="M-7 -4.5L0 0L-7 4.5"
      transform={`translate(${x} ${y}) rotate(${angle})`}
      className={tone === 'accent' ? 'stroke-accent' : 'stroke-white'}
      fill="none"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

/* The two lines that carry the rule, both dashed: jobs out in the accent,
   proposals back in ink. */
function Jobs({ d }: { d: string }) {
  return <path d={d} className="stroke-accent" strokeWidth={1.75} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 5" />;
}
function Proposals({ d }: { d: string }) {
  return <path d={d} className="stroke-white" strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 5" />;
}

function Clip({ id }: { id: string }) {
  return (
    <defs>
      <clipPath id={`${id}-round`} clipPathUnits="objectBoundingBox">
        <circle cx={0.5} cy={0.5} r={0.5} />
      </clipPath>
    </defs>
  );
}

/* ── Wide, for a desk ──────────────────────────────────────────────────── */

function PlanWide() {
  const id = 'wp-wide';
  /* The building: the lobby on the left, open onto the floor of desks; the
     shared shelves along the bottom wall. Set closer than it was (note
     #924: the lobby was about 40 percent of the plan and mostly empty). */
  const L = 112; /* outer left wall */
  const R = 1084; /* outer right wall */
  const T = 8;
  const B = 452;
  const FLOOR = 340; /* the left edge of the floor and of the shelves */
  const DESK = 110; /* the top edge of every desk */
  const JOBS = 94;
  const SHELVES = 272; /* the top of the shared shelves */
  const BACK = 256;
  const AGENTS = [
    { x: 479, name: 'Ruby', src: FACES.ruby, working: true },
    { x: 629, name: 'Milo', src: FACES.milo, working: false },
    { x: 779, name: 'Otis', src: FACES.otis, working: true },
    { x: 929, name: 'Ada', src: FACES.ada, working: false },
  ];
  return (
    <svg viewBox="0 0 1088 460" className="block h-auto w-full" role="img" aria-label={SAYS}>
      <Clip id={id} />
      {/* Two grey floors: the open floor of desks, and the shelves */}
      <Floor x={FLOOR} y={24} w={R - 16 - FLOOR} h={210} />
      <Floor x={FLOOR} y={SHELVES} w={R - 16 - FLOOR} h={164} />

      {/* The building, and its one door: the way in */}
      <Wall horizontal at={T} from={L} to={R} width={4} />
      <Wall horizontal at={B} from={L} to={R} width={4} />
      <Wall at={L} from={T} to={B} horizontal={false} gaps={[[196, 240]]} width={4} />
      <Wall at={R} from={T} to={B} horizontal={false} width={4} />
      <Door x={L} y={196} r={44} dir={1} toward={1} vertical />

      {/* You, at the way in */}
      <You x={52} y={210} />

      {/* The lobby: the Chief of Staff at the front desk, your yes by the door */}
      <Title x={134} y={44} title="Chief of Staff" sub="hands out jobs, follows up" />
      <FrontDesk id={id} x={222} y={128} />
      <Title x={134} y={300} title="Your yes" sub="nothing goes live without it" />
      <YesCounter x={222} y={372} />

      {/* One open floor: a desk for every agent, in one row */}
      <Title x={364} y={58} title="Desks" sub="one open floor, a computer for every agent" />
      {AGENTS.map((agent) => (
        <Desk key={agent.name} id={id} x={agent.x} y={DESK} name={agent.name} src={agent.src} working={agent.working} />
      ))}

      {/* Jobs out: from you to the front desk, then to the desks they wake */}
      <Jobs d="M78 218H222V176" />
      <Head x={222} y={175} angle={-90} tone="accent" />
      <Jobs d={`M274 128H296V${JOBS}H779V${DESK - 3}`} />
      <Head x={779} y={DESK - 2} angle={90} tone="accent" />
      <Jobs d={`M479 ${JOBS}V${DESK - 3}`} />
      <Head x={479} y={DESK - 2} angle={90} tone="accent" />
      <text x={306} y={JOBS - 8} fontSize={13} fontWeight={600} className="fill-accent">
        jobs
      </text>

      {/* Proposals back: from code and checks to your yes */}
      <Proposals d={`M1040 ${SHELVES}V${BACK}H318V385H276`} />
      <Head x={274} y={385} angle={180} tone="ink" />
      <text x={364} y={BACK - 7} fontSize={13} fontWeight={600} className="fill-white">
        proposals
      </text>

      {/* The shelves along the wall, shared by every desk */}
      <Title x={364} y={306} title="Memory" sub="read before every job" />
      <Shelf x={364} y={352} w={196} />
      <Shelf x={364} y={388} w={196} />
      <Title x={604} y={306} title="Keys" sub="added once, used by name" />
      <KeyCabinet x={604} y={352} />
      <Title x={804} y={306} title="Code and checks" sub="and the tools everyone shares" />
      <Tools x={806} y={346} step={52} />
    </svg>
  );
}

/* ── Tall, for a phone ─────────────────────────────────────────────────── */

function PlanTall() {
  const id = 'wp-tall';
  const L = 4;
  const R = 356;
  const T = 74;
  const SHELF = 72; /* the left edge of both floors: the desks, the shelves */
  const MEM = 684; /* the shelves' top */
  const B = 1112;
  const JOBS = 22;
  const BACK = 44;
  const ROW1 = 404; /* the top edge of the first row of desks */
  const ROW2 = 544;
  return (
    <svg viewBox="0 0 360 1118" className="block h-auto w-full" role="img" aria-label={SAYS}>
      <Clip id={id} />
      <Floor x={SHELF} y={312} w={276} h={356} />
      <Floor x={SHELF} y={MEM} w={276} h={B - 12 - MEM} />

      {/* The building, and its one door: the way in (note #924) */}
      <Wall horizontal at={T} from={L} to={R} gaps={[[44, 86]]} width={4} />
      <Wall horizontal at={B} from={L} to={R} width={4} />
      <Wall at={L} from={T} to={B} horizontal={false} width={4} />
      <Wall at={R} from={T} to={B} horizontal={false} width={4} />
      <Door x={86} y={T} r={42} dir={1} toward={-1} />

      <You x={65} y={26} label="right" />

      {/* Lobby */}
      <FrontDesk id={id} x={150} y={150} />
      <Title x={214} y={122} title="Chief of Staff" sub="hands out jobs," />
      <text x={214} y={160} fontSize={13} className="fill-hint">
        follows up
      </text>
      <YesCounter x={150} y={250} />
      <Title x={214} y={238} title="Your yes" sub="nothing goes live" />
      <text x={214} y={276} fontSize={13} className="fill-hint">
        without it
      </text>

      {/* One open floor: the desks in two rows */}
      <Title x={88} y={344} title="Desks" sub="one open floor," />
      <text x={88} y={382} fontSize={13} className="fill-hint">
        a computer for every agent
      </text>
      <Desk id={id} x={160} y={ROW1} name="Ruby" src={FACES.ruby} working />
      <Desk id={id} x={260} y={ROW1} name="Milo" src={FACES.milo} working={false} />
      <Desk id={id} x={160} y={ROW2} name="Otis" src={FACES.otis} working />
      <Desk id={id} x={260} y={ROW2} name="Ada" src={FACES.ada} working={false} />

      {/* Jobs out: from you to the front desk, then to the desks they wake */}
      <Jobs d="M65 50V150H94" />
      <Head x={95} y={150} angle={0} tone="accent" />
      <Jobs d={`M150 194V208H${JOBS}V${ROW2 + 8}H114`} />
      <Head x={115} y={ROW2 + 8} angle={0} tone="accent" />
      <Jobs d={`M${JOBS} ${ROW1 + 8}H114`} />
      <Head x={115} y={ROW1 + 8} angle={0} tone="accent" />
      <text x={JOBS + 6} y={318} fontSize={13} fontWeight={600} className="fill-accent" transform={`rotate(90 ${JOBS + 6} 318)`}>
        jobs
      </text>

      {/* Proposals back up to your yes */}
      <Proposals d={`M${SHELF} 1072H${BACK}V263H94`} />
      <Head x={95} y={263} angle={0} tone="ink" />
      <text x={BACK + 6} y={1042} fontSize={13} fontWeight={600} className="fill-white" transform={`rotate(-90 ${BACK + 6} 1042)`}>
        proposals
      </text>

      {/* The shelves along the wall, shared by every desk */}
      <Title x={88} y={718} title="Memory" sub="read before every job" />
      <Shelf x={104} y={756} w={228} />
      <Shelf x={104} y={784} w={228} />
      <Title x={88} y={846} title="Keys" sub="added once, used by name" />
      <KeyCabinet x={104} y={878} />
      <Title x={88} y={982} title="Code and checks" sub="and the tools everyone shares" />
      <Tools x={104} y={1012} step={48} />
    </svg>
  );
}

/** The whole workplace on one plan: wide on a desk, tall on a phone. */
export default function WorkplaceArt() {
  return (
    <figure className="workplace-art m-0">
      <div className="hidden lg:block">
        <PlanWide />
      </div>
      <div className="max-w-[460px] lg:hidden">
        <PlanTall />
      </div>
    </figure>
  );
}
