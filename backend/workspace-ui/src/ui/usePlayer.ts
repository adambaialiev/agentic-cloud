/**
 * A video or a recording played on a signed link (note #693) — in a chat, or
 * on a note — and the one place that knows what such a link is like.
 *
 * The link is signed for fifteen minutes, while a player reads its bytes when
 * it is PRESSED, which may be an hour after the screen drew it. So a play that
 * fails on a link past its life asks for a fresh one, once, and carries on
 * from where it was. One that fails on a good link — a container this browser
 * cannot open, bytes that are gone — is `broken`, and the screen puts the
 * named row back, whose tap saves the file.
 *
 * A clip's own shape, once a player has read it, is held per tab by the
 * file's id: the same clip scrolled past again, or its screen opened again,
 * stands at its own shape from the first layout rather than at a 16:9 guess.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PlayerLink { url: string; expiresAt?: string }

const heldShape = new Map<string, string>();

/** How much life a link must have left for a failed play to be the FILE's
 *  fault rather than the link's. */
const LINK_MARGIN_MS = 60_000;

/** `#t=0.001` is what makes Safari on a phone draw a clip's first frame
 *  instead of a black box: it reads nothing until asked for a moment to show.
 *  The fragment never reaches the server, so the signature is untouched. */
export const videoSrc = (url: string): string => `${url}#t=0.001`;

/**
 * `mint` reads a preview link for the file (stable across renders — the
 * caller's `useCallback`), and is first called once `ready` is true. `shape`
 * is null until the player has read a video's own width and height.
 */
export function usePlayer(id: string, mint: () => Promise<PlayerLink | null>, ready = true) {
  const [link, setLink] = useState<PlayerLink | null>(null);
  const [broken, setBroken] = useState(false);
  const [shape, setShape] = useState(() => heldShape.get(id) ?? null);
  const renewed = useRef(false);
  // Where the player was when its link ran out, to carry on from there.
  const resume = useRef<{ at: number; playing: boolean } | null>(null);

  const read = useCallback(() => mint().then((answer) => {
    if (answer?.url) setLink(answer);
    else setBroken(true);
  }), [mint]);

  useEffect(() => {
    if (!ready || link || broken) return;
    read().catch(() => setBroken(true));
  }, [broken, link, read, ready]);

  const onError = (event: { currentTarget: HTMLMediaElement }) => {
    const player = event.currentTarget;
    const left = Date.parse(link?.expiresAt ?? '') - Date.now();
    if (renewed.current || left > LINK_MARGIN_MS) { setBroken(true); return; }
    renewed.current = true;
    resume.current = { at: player.currentTime, playing: !player.paused };
    read().catch(() => setBroken(true));
  };
  const onLoadedMetadata = (event: { currentTarget: HTMLMediaElement }) => {
    const player = event.currentTarget;
    const held = resume.current;
    resume.current = null;
    if (held?.at) player.currentTime = held.at;
    if (held?.playing) player.play().catch(() => { /* the reader presses play again */ });
    if (player instanceof HTMLVideoElement && player.videoWidth && player.videoHeight) {
      const measured = `${player.videoWidth} / ${player.videoHeight}`;
      heldShape.set(id, measured);
      setShape(measured);
    }
  };

  return { link, broken, shape, events: { onError, onLoadedMetadata } };
}
