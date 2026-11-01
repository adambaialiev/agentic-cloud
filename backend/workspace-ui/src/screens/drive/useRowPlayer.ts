import { useCallback, useEffect, useRef, useState } from 'react';

/** The recording a Drive list is playing: which row, whether it is sounding,
 *  and how far in, in seconds (a duration of 0 is one not yet read). */
export interface RowTrack { id: string; playing: boolean; at: number; duration: number }

interface Loaded extends RowTrack { url: string; renewedAt: number }

/**
 * The one player a Drive list plays its recordings on (note #698).
 *
 * ONE element for the whole list, so pressing play on a second row stops the
 * first: a folder of tracks is something a reader goes through one at a
 * time. It is made on the first press and never on a render — the landing
 * draws these rows on the build machine, where there is no Audio to make —
 * and it is emptied when the list goes, so leaving a folder stops its sound.
 *
 * The press itself starts the sound. A row's address is its own and needs no
 * link asked for first (`/:id/audio` answers with a redirect to the signed
 * bytes), so `play()` runs inside the tap, which is what a phone requires
 * before it will make a sound. Once a person has started the element, the
 * element may be started again without one.
 *
 * The bytes behind that redirect are signed for fifteen minutes, and a long
 * recording is read as it plays. So a track that stops on an error after it
 * got further than it last had asks for its address again and carries on
 * from where it was. One that fails without getting anywhere — a format this
 * browser cannot open, a file gone since — is `broken`, and its row puts the
 * glyph back, as a picture's row does when the picture will not draw.
 */
export function useRowPlayer() {
  const audio = useRef<HTMLAudioElement | null>(null);
  // What the element holds. Its listeners outlive any one render, so they
  // read this rather than the state the screen draws from.
  const loaded = useRef<Loaded | null>(null);
  const [track, setTrack] = useState<RowTrack | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());

  const publish = useCallback(() => {
    const now = loaded.current;
    setTrack(now ? { id: now.id, playing: now.playing, at: now.at, duration: now.duration } : null);
  }, []);

  const start = useCallback((player: HTMLAudioElement, now: Loaded) => {
    now.playing = true;
    publish();
    // Refused — a browser that did not count this as a press — or cut short
    // by the next track: draw what the element is really doing.
    void player.play()?.catch(() => {
      if (loaded.current !== now) return;
      now.playing = !player.paused;
      publish();
    });
  }, [publish]);

  const element = useCallback((): HTMLAudioElement => {
    if (audio.current) return audio.current;
    const player = new Audio();
    player.preload = 'auto';
    player.addEventListener('play', () => { if (loaded.current) { loaded.current.playing = true; publish(); } });
    player.addEventListener('pause', () => { if (loaded.current) { loaded.current.playing = false; publish(); } });
    player.addEventListener('durationchange', () => {
      if (!loaded.current) return;
      loaded.current.duration = Number.isFinite(player.duration) ? player.duration : 0;
      publish();
    });
    // Drawn once a second, not at every tick the element reports.
    player.addEventListener('timeupdate', () => {
      const now = loaded.current;
      if (!now) return;
      const before = Math.floor(now.at);
      now.at = player.currentTime;
      if (Math.floor(now.at) !== before) publish();
    });
    player.addEventListener('ended', () => { loaded.current = null; publish(); });
    player.addEventListener('error', () => {
      const now = loaded.current;
      if (!now) return;
      if (now.at > now.renewedAt) {
        now.renewedAt = now.at;
        const { at, playing } = now;
        player.addEventListener('loadedmetadata', () => {
          if (loaded.current !== now) return;
          player.currentTime = at;
          if (playing) start(player, now);
        }, { once: true });
        player.src = `${now.url}${now.url.includes('?') ? '&' : '?'}again=${Date.now()}`;
        return;
      }
      loaded.current = null;
      publish();
      setBroken((was) => new Set(was).add(now.id));
    });
    audio.current = player;
    return player;
  }, [publish, start]);

  /** Play a row's recording, or pause it if it is the one playing. */
  const toggle = useCallback((id: string, url: string) => {
    const player = element();
    const now = loaded.current;
    if (now?.id === id) {
      if (now.playing) { now.playing = false; publish(); player.pause(); }
      else start(player, now);
      return;
    }
    const next: Loaded = { id, url, playing: false, at: 0, duration: 0, renewedAt: 0 };
    loaded.current = next;
    player.src = url;
    start(player, next);
  }, [element, publish, start]);

  /** Silence the list and let go of what it was reading. */
  const stop = useCallback(() => {
    loaded.current = null;
    publish();
    const player = audio.current;
    if (!player) return;
    player.pause();
    player.removeAttribute('src');
    player.load();
  }, [publish]);

  useEffect(() => stop, [stop]);

  return { track, broken, toggle, stop };
}

export type RowPlayer = ReturnType<typeof useRowPlayer>;
