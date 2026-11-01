import type { ReactNode } from 'react';
import { FACES } from './live/fixture';

/**
 * The four small pictures over the four phases on the landing (the owner,
 * note #172: more visuals for the phases).
 *
 * These are drawings, not the product: phases one to three are other kinds of
 * tool, and nothing of theirs belongs in a live panel. They are drawn in the
 * page's own palette and type, with no logos and no product named, and every
 * line in them is Northstar's (the fixture's team): the pilot email to Dana at
 * Harbour Freight, its forty vans, note #58 that Ruby is working. The fourth
 * is the only one with a team in it: one person and the agents he runs, which
 * is the whole difference the section is about. (It drew four people until
 * inviting was switched off, note #206.)
 *
 * Each picture is decorative: the phase's own heading and sentence say what
 * it shows, so the frame is hidden from assistive technology.
 */

export type Phase = 1 | 2 | 3 | 4;

const ART = 'flex h-full min-w-0 flex-col gap-2 rounded-2xl bg-panel-soft p-4';

function Bubble({ mine = false, children }: { mine?: boolean; children: ReactNode }) {
  return (
    <p
      className={`max-w-[88%] rounded-2xl px-3 py-2 type-xs ${
        mine ? 'self-end rounded-br-md bg-white text-panel' : 'self-start rounded-bl-md bg-panel text-white'
      }`}
    >
      {children}
    </p>
  );
}

function File({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-hint/20 bg-panel px-1.5 py-0.5 type-xs text-hint">
      <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0" fill="none" aria-hidden="true">
        <path d="M3 1.5h4l2 2v7H3z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      </svg>
      {children}
    </span>
  );
}

function Face({ src, size = 'h-5 w-5' }: { src: string; size?: string }) {
  return <img src={src} alt="" width={20} height={20} className={`${size} shrink-0 rounded-full bg-panel-soft object-cover`} />;
}

/* Phase one: you ask, it answers, and the work is still yours. */
function ChatArt() {
  return (
    <div className={`${ART} justify-center`}>
      <Bubble mine>Write the pilot email to Harbour Freight</Bubble>
      <Bubble>Hi Dana, thanks for Tuesday. Here is the plan for Friday’s pilot…</Bubble>
      <Bubble mine>Make it shorter</Bubble>
    </div>
  );
}

/* Phase two: the same chat, reading your files first. */
function ConnectedArt() {
  return (
    <div className={`${ART} justify-center`}>
      <Bubble mine>How many vans does Harbour Freight run?</Bubble>
      <div className="flex flex-wrap items-center gap-1.5 self-start">
        <span className="type-xs text-hint">Read</span>
        <File>pilot-notes.md</File>
        <File>routes.csv</File>
      </div>
      <Bubble>Forty. The pilot starts Friday.</Bubble>
    </div>
  );
}

/* Phase three: an agent at work on a machine of its own, for one person. */
function ComputerArt() {
  const steps = [
    ['done', 'Cloned the repo'],
    ['done', 'Ran 412 tests'],
    ['done', 'Opened a proposal'],
    ['now', 'Writing it up…'],
  ] as const;
  return (
    <div className={`${ART} justify-center`}>
      <div className="min-w-0 rounded-xl bg-panel p-3">
        <div className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-hint/30" />
          <span className="h-2 w-2 rounded-full bg-hint/30" />
          <span className="h-2 w-2 rounded-full bg-hint/30" />
          <span className="ml-1.5 truncate font-mono type-xs text-hint">agent’s computer</span>
        </div>
        <ul className="mt-2.5 space-y-1 font-mono type-xs">
          {steps.map(([state, line]) => (
            <li key={line} className={`flex min-w-0 gap-2 ${state === 'now' ? 'text-hint' : 'text-white'}`}>
              <span className={state === 'now' ? 'text-warn' : 'text-ok'}>{state === 'now' ? '●' : '✓'}</span>
              <span className="truncate">{line}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center gap-2 type-xs text-hint">
        <Face src={FACES.jamesPerson} />
        Working for James
      </div>
    </div>
  );
}

/* Phase four: one person and a team of agents on the same piece of work.
   The note is the fixture's #58, which James wrote, Otis commented on and
   Ruby is working. */
function TeamArt() {
  const team = [
    FACES.jamesPerson,
    FACES.ruby,
    FACES.milo,
    FACES.otis,
    FACES.ada,
    FACES.theo,
    FACES.mia,
    FACES.nora,
  ];
  const rows = [
    { face: FACES.jamesPerson, who: 'James', what: 'wrote it' },
    { face: FACES.otis, who: 'Otis', what: 'commented' },
    { face: FACES.ruby, who: 'Ruby', what: 'Working', working: true },
  ];
  return (
    <div className={`${ART} justify-center gap-3`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex shrink-0 -space-x-1.5">
          {team.map((face) => (
            <img key={face} src={face} alt="" width={22} height={22} className="h-[22px] w-[22px] rounded-full bg-panel-soft object-cover ring-2 ring-panel-soft" />
          ))}
        </div>
        <span className="whitespace-nowrap type-xs text-hint">1 person, 18 agents</span>
      </div>
      <div className="min-w-0 rounded-xl bg-panel p-3">
        <p className="type-sm font-semibold text-white">Driver app must work with no signal</p>
        <ul className="mt-2 space-y-1.5">
          {rows.map(({ face, who, what, working }) => (
            <li key={who} className="flex min-w-0 items-center gap-2 type-xs">
              <Face src={face} />
              <span className="shrink-0 font-semibold text-white">{who}</span>
              <span className={`truncate ${working ? 'text-warn' : 'text-hint'}`}>{what}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function PhaseArt({ phase }: { phase: Phase }) {
  return (
    <div aria-hidden="true" className="h-full">
      {phase === 1 ? <ChatArt /> : phase === 2 ? <ConnectedArt /> : phase === 3 ? <ComputerArt /> : <TeamArt />}
    </div>
  );
}
