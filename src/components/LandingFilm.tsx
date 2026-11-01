import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
/* Imported, not served from public/, for the same reason as the dog on the
   door: Vite gives each build a content-hashed name, so the file can be held
   for a year (public/_headers, /assets/*) and a new cut is a new URL. */
import film from '../assets/landing/beyond-the-laptop.mp4';
import poster from '../assets/landing/beyond-the-laptop-poster.webp';

/**
 * "Beyond the laptop", the film made for X (final 2026-10-07; the master is
 * in Drive's "Motion videos — @AgenticCloud", its source in the
 * motion-videos repository). Since note #207 (the owner, 2026-10-12) it is
 * round 22: the page-margin frame where two teammates talked is cut, as a
 * workplace is one person's while inviting is off, and "one brain" and "the
 * second brain" say "one workplace". It runs 85.3 s, which a player shows as 1:25;
 * the play button's name spells that out, because "1:25" in the built page
 * reads as a clock to the prerender test. The owner asked for it on the page
 * on 2026-10-08, and took the caption under it away on 2026-10-09 (title and
 * length, said only to screen readers now). Every Workspace surface in it is the real component, answered
 * from the same Northstar fixture the page's panels use, so the film and the
 * panels around it tell one story.
 *
 * Since note #197 (the owner, 2026-10-09) it plays on the page by itself:
 * silent, looping, with no controls, as a moving picture beside the heading.
 * A tap opens the whole film in a window of its own, from the start, with
 * its soundtrack and the browser's controls; the press is the reader's, so
 * the sound is allowed. Both are the same file, so the window starts from
 * what the preview has already fetched. The preview still loads nothing for a
 * reader who never gets near it: the page ships the first frame ("Your agent
 * lives on your laptop."), and the 16 MB starts streaming only once the film
 * is on screen, and pauses when it leaves. Until then that first frame is
 * the poster, so the wait never shows.
 *
 * It stands still, with the play disc over its first frame as before, for a
 * reader who asked for less motion or less data, and wherever the browser
 * will not start a silent video on its own (iOS in Low Power Mode). The
 * window is a native <dialog>, drawn in the top layer, never a portal: the
 * prerender writes it closed in place (landing-live-panels: nothing portals).
 */
export const FILM_TITLE = 'Beyond the laptop';

/* A reader who asked for less motion or less data gets the first frame
   standing still, as does a browser with no way to tell when the film is in
   view. The prerender cannot know, so it draws the moving version and the
   browser corrects it as it hydrates. */
const CALM = '(prefers-reduced-motion: reduce)';
const subscribeCalm = (changed: () => void) => {
  const query = window.matchMedia?.(CALM);
  query?.addEventListener?.('change', changed);
  return () => query?.removeEventListener?.('change', changed);
};
const isCalm = () =>
  Boolean(window.matchMedia?.(CALM).matches)
  || Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData)
  || typeof IntersectionObserver === 'undefined';

/* A refusal says NotAllowedError; anything else is a pause that overtook the
   start (scrolling straight past), which is no reason to stop moving. */
function moveSilently(video: HTMLVideoElement | null, refused: () => void) {
  if (!video) return;
  video.muted = true;
  void video.play()?.catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'NotAllowedError') refused();
  });
}

export default function LandingFilm({ className = '' }: { className?: string }) {
  const preview = useRef<HTMLVideoElement>(null);
  const theatre = useRef<HTMLDialogElement>(null);
  const whole = useRef<HTMLVideoElement>(null);
  const inView = useRef(false);
  const byPointer = useRef(false);
  const calm = useSyncExternalStore(subscribeCalm, isCalm, () => false);
  const [refused, setRefused] = useState(false);
  const still = calm || refused;

  useEffect(() => {
    const video = preview.current;
    if (!video) return;
    if (calm) {
      video.pause();
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      inView.current = entry.isIntersecting;
      if (!entry.isIntersecting) video.pause();
      else if (!theatre.current?.open) moveSilently(video, () => setRefused(true));
    });
    observer.observe(video);
    return () => observer.disconnect();
  }, [calm]);

  const watch = () => {
    const box = theatre.current;
    const video = whole.current;
    if (!box || !video) return;
    preview.current?.pause();
    box.showModal();
    video.currentTime = 0;
    void video.play()?.catch(() => undefined);
  };

  // A click is a pointer's; Enter or Space on the button is a click too,
  // with no detail, and stays the keyboard's.
  const shut = (pointer: boolean) => {
    byPointer.current = pointer;
    theatre.current?.close();
  };

  // Escape, the close button and a tap beside the film all end here. The
  // browser has already handed focus back to the picture; after a pointer
  // that would leave the disc over a moving film, so it is let go. After a
  // key it stays, and the disc shows the reader where they are.
  const closed = () => {
    whole.current?.pause();
    if (byPointer.current && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    byPointer.current = false;
    if (inView.current && !still) moveSilently(preview.current, () => setRefused(true));
  };

  return (
    <figure className={`min-w-0 ${className}`}>
      <p className="sr-only">
        A film of the product: an agent stops when the laptop lid shuts. Then every agent gets a
        cloud computer of its own and runs the official Claude Code and Codex CLIs, all of them
        work from one shared set of notes, you talk to each in its own chat, they hand work to
        each other and comment on the work itself, push to git hosting made for agents, ship
        sites, and run on the Claude plan you sign in with.
      </p>
      {/* The film's own paper is a shade off the page's, so a hairline
          gives it an edge; the corners are the card's. */}
      <div className="relative aspect-[4/5] overflow-hidden rounded-2xl border border-hint/16 bg-panel-deep">
        <video
          ref={preview}
          src={film}
          poster={poster}
          preload="none"
          muted
          loop
          playsInline
          disablePictureInPicture
          disableRemotePlayback
          width={1080}
          height={1350}
          className="absolute inset-0 h-full w-full"
        />
        {/* The whole picture is the button. While the preview moves, the
            disc shows only under a pointer or keyboard focus, so nothing
            sits over the film; standing still, it says the film waits. */}
        <button
          type="button"
          onClick={watch}
          aria-label={`Play the film “${FILM_TITLE}”, 1 minute 25 seconds, with sound`}
          className="group absolute inset-0 grid cursor-pointer place-items-center"
        >
          <span
            className={`grid h-[72px] w-[72px] place-items-center rounded-full bg-white text-panel transition duration-200 group-hover:scale-105 ${still ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`}
          >
            {/* The path already sits right of the box's middle so the
                triangle's centroid lands on the disc's centre; no margin. */}
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-8 w-8" fill="currentColor">
              <path d="M7 4.5v15a1 1 0 0 0 1.5.87l12.5-7.5a1 1 0 0 0 0-1.74L8.5 3.63A1 1 0 0 0 7 4.5Z" />
            </svg>
          </span>
        </button>
      </div>
      <dialog
        ref={theatre}
        aria-label={FILM_TITLE}
        className="landing-film-dialog"
        onClose={closed}
        onClick={(event) => { if (event.target === event.currentTarget) shut(true); }}
      >
        <div className="flex justify-end">
          <button
            type="button"
            onClick={(event) => shut(event.detail > 0)}
            aria-label="Close the film"
            className="grid h-11 w-11 cursor-pointer place-items-center rounded-full bg-panel text-white transition-transform duration-200 hover:scale-105"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <video
          ref={whole}
          src={film}
          poster={poster}
          preload="none"
          controls
          playsInline
          width={1080}
          height={1350}
          className="mt-3 block aspect-[4/5] h-auto w-full rounded-2xl bg-panel-deep"
        />
      </dialog>
    </figure>
  );
}
