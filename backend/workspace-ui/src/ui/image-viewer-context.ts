import { createContext } from 'react';

/** One picture the viewer can show. `name` is what the header says and what
 *  the screen reader is told the viewer opened.
 *
 *  `save` is what the viewer's Download control does for this picture, when
 *  the surface that opened it has a way to save it (note #552): the chat
 *  mints a URL signed for saving at the tap and hands it to the browser. A
 *  picture without one — a face, a knowledge page's figure — shows no
 *  control, rather than one that saves the preview under a made-up name. */
export interface ViewerImage { url: string; name: string; save?: () => void }

export interface ImageViewerValue {
  /**
   * Open the viewer on `index` of `images`.
   *
   * A GALLERY, not one picture, because the second and third screenshots on a
   * proposal are otherwise reachable only by closing this and finding them on
   * the page again. A caller with one picture passes a list of one, and the
   * step controls are then absent rather than dead. `host` keeps the overlay
   * inside an already-open native modal, whose top layer would otherwise hide
   * a viewer mounted on the document underneath it.
   */
  open: (images: readonly ViewerImage[], index: number, host?: HTMLElement) => void;
}

export const ImageViewerContext = createContext<ImageViewerValue | null>(null);
