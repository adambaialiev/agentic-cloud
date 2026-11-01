import { createContext } from 'react';

/** One document the viewer can show. `name` is what the header says and what
 *  the screen reader is told the viewer opened; `url` is a signed link the
 *  media host serves INLINE, because a link that says "attachment" is
 *  downloaded by the browser rather than drawn in the frame.
 *
 *  `kind` is what the frame is asked to draw: a PDF (the default, drawn by
 *  the browser's own viewer with a reading fragment on the URL) or an HTML
 *  page (note #557), which is framed under a `sandbox` that gives it no
 *  origin — it can lay itself out and run its own script, and reach nothing
 *  of the Workspace or of the media host it was served from. A Markdown
 *  file (note #677) is the one kind with no frame: it arrives as its text.
 *
 *  `save`, when the opener supplies it, puts a Download beside Close: a page
 *  has no viewer chrome of its own to save from, where a PDF's browser
 *  viewer already carries one. It is a callback and not a URL for the reason
 *  the picture viewer's is (note #552): saving goes back through the screen,
 *  which mints a link signed for saving at the press. */
export type ViewerDocument =
  | { url: string; name: string; kind?: 'pdf' | 'html'; save?: () => void }
  /** A Markdown file (note #677): no URL, because nothing here is framed —
   *  its words, drawn by the Workspace's own renderer as a page to read. */
  | { text: string; name: string; kind: 'markdown'; save?: () => void };

export interface PdfViewerValue {
  /**
   * Open the viewer on one document — a PDF, an HTML page, or a Markdown
   * file's words.
   *
   * ONE document, where the picture viewer takes a gallery. Stepping exists
   * there because a proposal's second screenshot is otherwise reachable only
   * by closing the viewer and finding it again; a PDF is not glanced at
   * beside its neighbours, it is READ, and the reader comes back out when
   * they are done with it. `host` keeps the overlay inside an already-open
   * native modal, whose top layer would otherwise hide one mounted on the
   * document underneath it.
   */
  open: (document: ViewerDocument, host?: HTMLElement) => void;
}

export const PdfViewerContext = createContext<PdfViewerValue | null>(null);
