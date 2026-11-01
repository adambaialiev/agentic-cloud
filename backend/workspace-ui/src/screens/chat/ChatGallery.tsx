/**
 * Every picture on screen in one conversation, in the order it was said
 * (note #544).
 *
 * Until this, a picture opened full screen from the chat had for its
 * gallery the OTHER pictures on the same message, and nothing else: the
 * screenshot two messages up was reachable only by closing the viewer and
 * finding it again. The owner asked for the whole conversation under the
 * left and right controls, which is what every phone gallery does with a
 * thread.
 *
 * The rows are what know the pictures — each fetches its own preview and
 * knows whether it painted — and the screen is what knows the order. So
 * the screen holds the register and the rows write into it: a picture that
 * PAINTED is added under its message's sequence and its place on that
 * message, and one that unmounted or broke is taken out again. A tap then
 * reads the whole register in order, and the viewer steps through it.
 *
 * Only pictures that painted, for the reason the per-message gallery
 * already had: the viewer draws a URL, and a URL that drew nothing here
 * would draw nothing there. A PDF opens in the document viewer alone and is
 * not in this register; an archive is never drawn at all.
 *
 * A surface with no provider — the landing page's live panels — falls back
 * to the message's own pictures, exactly as before.
 */

import { useMemo, type ReactNode } from 'react';
import { ChatGalleryContext, type ChatGallery, type GalleryPicture } from './chat-gallery-context.js';

export type { ChatGallery, GalleryPicture };

export function ChatGalleryProvider({ children }: { children: ReactNode }) {
  // A Map in a memo rather than state: a picture painting must not re-render
  // the transcript, and nothing draws from the register until a tap reads it.
  const value = useMemo<ChatGallery>(() => {
    const held = new Map<string, GalleryPicture>();
    return {
      add: (picture) => { held.set(picture.file.id, picture); },
      remove: (id) => { held.delete(id); },
      pictures: () => [...held.values()].sort((a, b) => a.seq - b.seq || a.index - b.index),
    };
  }, []);
  return <ChatGalleryContext value={value}>{children}</ChatGalleryContext>;
}
