import { useEffect, useRef, useState } from 'react';

/**
 * The film at the top of the home page: a moving picture, not a player.
 *
 * - It starts by itself (note #965): muted, inline on a phone, looping, from
 *   code after the page loads and never by the autoPlay attribute, so a
 *   visitor whose system asks for reduced motion gets the poster and our own
 *   play button instead, and so does one whose browser refuses to start it.
 * - It never shows the browser's controls (note #970): no control bar on a
 *   hover or a tap, no picture-in-picture or cast, no right-click "Show
 *   controls".
 * - It is its own pause button (note #971): a click, a tap, Space or Enter
 *   pauses it and the next resumes it, named for what it will do; a pause or
 *   play mark shows at the tap and fades within a second.
 * - A phone gets the tall cut (note #973, the owner, 4 Nov 2026, 07:48 UTC:
 *   "Can we make vertical version of the video? For phones"). The rule is
 *   the page's own phone width, TALL_FILM_QUERY (under 640 px, Tailwind's
 *   sm): a phone held upright gets the 9:16 cut, a phone turned sideways, a
 *   tablet and a desk get the wide one. The frame's shape follows the same
 *   query in CSS, so the page never jumps when the script arrives; the
 *   poster is a <picture> whose <source media> is that query, so the browser
 *   fetches one poster; and the film's address is set from code only once
 *   the query has been read, so it fetches one film. Turning the phone
 *   round swaps the film (and only then fetches the other).
 * - The frame is always the film's own shape, never stretched or
 *   letterboxed. From note #973 to #977 the tall frame was capped at
 *   (100svh - 215px) x 9/16 to keep the headline's first line on a phone's
 *   first screen; since note #977 (the owner: "all content should be end to
 *   end wide") it takes the phone's whole width, so the film and its
 *   timeline are a phone's first screen and the headline follows.
 * - Under the picture, a timeline of the film's sections (note #977: "below
 *   the video player, let's implement switcher to different sections of the
 *   video. Timeline"): a bar with one segment per section, proportional to
 *   its length, the played part filled, and under it the sections' names,
 *   the current one marked. A click, a tap, Enter or Space on a name (or a
 *   click or tap on the bar) jumps the film to that section's first clean
 *   frame and plays on. Each film carries its own starts, read off its
 *   frames. On a desk the names sit under their own segments; on a phone
 *   they share the width equally, in two lines at most, never scrolling.
 */

/** A section of a film: where it starts (seconds), its name, and a shorter
 *  name for a phone, where five share one row. */
export type Section = { at: number; label: string; short?: string };

export const TALL_FILM_QUERY = '(max-width: 639px)';

export type Film = { src: string; poster: string; length?: number; sections?: Section[] };
type Shape = 'wide' | 'tall';
type State = 'still' | 'starting' | 'playing' | 'paused';

function asksForStillness(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function HomeFilm({ wide, tall, label }: { wide: Film; tall?: Film | null; label: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [shape, setShape] = useState<Shape | null>(null);
  const [state, setState] = useState<State>('starting');
  const latest = useRef<State>('starting');
  const go = (next: State) => {
    latest.current = next;
    setState(next);
  };
  /* The poster lies over the film until a frame of it has been drawn. */
  const [drawn, setDrawn] = useState(false);

  /* Which film this screen gets, read once the page runs, and again when
     the phone is turned round. */
  useEffect(() => {
    const query = tall && typeof window.matchMedia === 'function' ? window.matchMedia(TALL_FILM_QUERY) : null;
    let gone = false;
    const read = () => { if (!gone) setShape(query?.matches ? 'tall' : 'wide'); };
    void Promise.resolve().then(read);
    query?.addEventListener?.('change', read);
    return () => {
      gone = true;
      query?.removeEventListener?.('change', read);
    };
  }, [tall]);

  /* Start it once its film is known; after a turn of the phone, carry on
     playing if it was. */
  const first = useRef(true);
  useEffect(() => {
    if (!shape) return;
    const film = video.current;
    const opening = first.current;
    first.current = false;
    const wanted = opening ? !asksForStillness() : latest.current === 'playing';
    let started: Promise<void> | undefined;
    if (!film || !wanted) {
      started = Promise.reject(new Error('still'));
    } else {
      film.muted = true;
      try {
        started = film.play();
      } catch (refused) {
        started = Promise.reject(refused);
      }
    }
    let gone = false;
    Promise.resolve(started).then(
      () => { if (!gone) go('playing'); },
      () => { if (!gone && (opening || latest.current === 'playing')) go(opening ? 'still' : 'paused'); },
    );
    return () => { gone = true; };
  }, [shape]);

  /* The momentary mark at a tap. */
  const [mark, setMark] = useState<{ kind: 'pause' | 'play'; fading: boolean; n: number } | null>(null);
  const markTimers = useRef<number[]>([]);
  useEffect(() => () => markTimers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const flash = (kind: 'pause' | 'play') => {
    markTimers.current.forEach((timer) => window.clearTimeout(timer));
    const n = Date.now();
    setMark({ kind, fading: false, n });
    markTimers.current = [
      window.setTimeout(() => setMark((now) => (now && now.n === n ? { ...now, fading: true } : now)), 450),
      window.setTimeout(() => setMark((now) => (now && now.n === n ? null : now)), 900),
    ];
  };
  const toggle = () => {
    const film = video.current;
    if (!film) return;
    if (film.paused) {
      go('playing');
      flash('play');
      const started = film.play();
      if (started) started.catch(() => go('paused'));
    } else {
      film.pause();
      go('paused');
      flash('pause');
    }
  };

  /* Our play button goes when the film starts; a keyboard that pressed it
     lands on the film's own pause button rather than nowhere. */
  const handFocus = useRef(false);
  const start = (event: { currentTarget: EventTarget }) => {
    handFocus.current = document.activeElement === event.currentTarget;
    go('playing');
    const started = video.current?.play();
    if (started) started.catch(() => go('still'));
  };

  /* Where the film is, for the timeline: read each frame while it plays,
     and on every seek. */
  const [time, setTime] = useState(0);
  useEffect(() => {
    if (state !== 'playing') return;
    let frameId = 0;
    const tick = () => {
      if (video.current) setTime(video.current.currentTime);
      frameId = window.requestAnimationFrame(tick);
    };
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [state]);
  /* A jump before the film has loaded (preload is none) waits for its
     length to be known, then lands. */
  const pendingJump = useRef<number | null>(null);
  const jump = (at: number) => {
    const film = video.current;
    if (!film) return;
    setTime(at);
    if (film.readyState >= 1) film.currentTime = at;
    else pendingJump.current = at;
    if (film.paused) {
      film.muted = true;
      go('playing');
      let started: Promise<void> | undefined;
      try {
        started = film.play();
      } catch (refused) {
        started = Promise.reject(refused);
      }
      Promise.resolve(started).catch(() => go('paused'));
    }
  };

  const what = label.replace(/^Play /, '');
  const src = shape === 'tall' && tall ? tall.src : shape === 'wide' ? wide.src : undefined;
  /* The tall frame on a phone, the wide one from sm up (TALL_FILM_QUERY). */
  const frame = tall ? 'aspect-[9/16] w-full sm:aspect-video' : 'aspect-video w-full';
  /* The timeline of the film being shown (the wide one until the page has
     read the screen). */
  const film = shape === 'tall' && tall ? tall : wide;
  const sections = film.sections ?? [];
  const length = film.length ?? 0;
  const parts = sections.map((section, i) => {
    const end = i + 1 < sections.length ? sections[i + 1]!.at : length;
    return { ...section, end, span: Math.max(end - section.at, 0.001) };
  });
  const current = parts.reduce((found, part, i) => (time >= part.at ? i : found), 0);
  const columns = parts.map((part) => `${part.span}fr`).join(' ');

  return (
    <figure className="relative m-0 w-full">
      <div data-film-frame className={`relative overflow-hidden rounded-[20px] bg-panel-soft shadow-[0_0_0_1px_rgb(31_30_29/0.1)] ${frame}`}>
        <video
          ref={video}
          className="absolute inset-0 block h-full w-full object-cover"
          src={src}
          playsInline
          muted
          loop
          preload="none"
          disablePictureInPicture
          disableRemotePlayback
          onContextMenu={(event) => event.preventDefault()}
          onPlay={() => go('playing')}
          onPause={() => { if (latest.current === 'playing') go('paused'); }}
          onPlaying={() => setDrawn(true)}
          onEmptied={() => { setDrawn(false); setTime(0); }}
          onSeeked={(event) => setTime(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => {
            if (pendingJump.current !== null) {
              event.currentTarget.currentTime = pendingJump.current;
              pendingJump.current = null;
            }
          }}
        />
        {drawn ? null : (
          <picture>
            {tall ? <source media={TALL_FILM_QUERY} srcSet={tall.poster} /> : null}
            <img
              src={wide.poster}
              alt=""
              data-film-poster
              className="pointer-events-none absolute inset-0 block h-full w-full object-cover"
            />
          </picture>
        )}
        {state === 'playing' || state === 'paused' ? (
          <button
            type="button"
            ref={(node) => {
              if (node && handFocus.current) {
                handFocus.current = false;
                node.focus();
              }
            }}
            onClick={toggle}
            onContextMenu={(event) => event.preventDefault()}
            aria-label={state === 'playing' ? `Pause ${what}` : `Play ${what}`}
            data-film-toggle={state}
            className="absolute inset-0 block h-full w-full cursor-pointer rounded-[20px] bg-transparent [-webkit-tap-highlight-color:transparent] focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-accent"
          >
            {mark ? (
              <span
                key={mark.n}
                aria-hidden="true"
                data-film-mark={mark.kind}
                className={`pointer-events-none absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/80 text-panel transition-opacity duration-[400ms] motion-reduce:transition-none sm:h-16 sm:w-16 ${mark.fading ? 'opacity-0' : 'opacity-100'}`}
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
                  {mark.kind === 'pause' ? (
                    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
                  ) : (
                    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5Z" />
                  )}
                </svg>
              </span>
            ) : null}
          </button>
        ) : null}
        {state === 'still' ? (
          /* Our own play button: in the empty band under the page in the
             tall poster, in the empty lower left of the wide one. */
          <button
            type="button"
            onClick={start}
            aria-label={label}
            className={`absolute flex h-12 w-12 items-center justify-center rounded-full bg-white text-panel shadow-[0_2px_10px_rgb(31_30_29/0.18)] transition-colors hover:bg-white/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:h-16 sm:w-16 ${tall ? 'bottom-[7%] left-1/2 -translate-x-1/2 sm:bottom-[9%] sm:left-[5%] sm:translate-x-0' : 'bottom-[9%] left-[5%]'}`}
          >
            <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5 sm:h-6 sm:w-6" fill="currentColor" aria-hidden="true">
              <path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5Z" />
            </svg>
          </button>
        ) : null}
      </div>
      {parts.length > 1 && length > 0 ? (
        <div data-film-timeline role="group" aria-label="Sections of the film" className="mt-3 sm:mt-4">
          {/* The bar: one segment per section, as long as the section, the
              played part filled. For a pointer; the names under it are the
              buttons a keyboard and a screen reader use. */}
          <div className="grid gap-x-1 sm:gap-x-1.5" style={{ gridTemplateColumns: columns }} aria-hidden="true">
            {parts.map((part, i) => {
              const filled = Math.min(Math.max((time - part.at) / part.span, 0), 1);
              return (
                <button
                  key={part.at}
                  type="button"
                  tabIndex={-1}
                  onClick={() => jump(part.at)}
                  data-film-segment={i}
                  className="group block w-full cursor-pointer py-2 [-webkit-tap-highlight-color:transparent]"
                >
                  <span className="relative block h-1 overflow-hidden rounded-full bg-hint/25 transition-colors group-hover:bg-hint/40 sm:h-1.5">
                    <span
                      data-film-played={filled.toFixed(2)}
                      className="absolute inset-y-0 left-0 block rounded-full bg-white"
                      style={{ width: `${filled * 100}%` }}
                    />
                  </span>
                </button>
              );
            })}
          </div>
          {/* The names: under their own segments on a desk; on a phone the
              width shared equally, two lines at most. */}
          <ol
            className="mt-1 grid grid-cols-5 gap-x-1 sm:mt-1.5 sm:gap-x-1.5 sm:[grid-template-columns:var(--film-sections)]"
            style={{ ['--film-sections' as string]: columns }}
          >
            {parts.map((part, i) => (
              <li key={part.at} className="min-w-0">
                <button
                  type="button"
                  onClick={() => jump(part.at)}
                  aria-current={i === current ? 'step' : undefined}
                  data-film-section={i}
                  className={`block min-h-6 w-full cursor-pointer py-1 text-left type-xs leading-[1.25] [text-wrap:balance] transition-colors focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:type-sm ${i === current ? 'font-semibold text-white' : 'text-hint hover:text-white'}`}
                >
                  {part.short ? (
                    <>
                      <span className="sm:hidden">{part.short}</span>
                      <span className="hidden sm:inline">{part.label}</span>
                    </>
                  ) : part.label}
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </figure>
  );
}
