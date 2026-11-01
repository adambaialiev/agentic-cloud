/**
 * A PDF's first page, as a picture of itself.
 *
 * A frame of the document's own top, clipped to a band, with every control
 * the browser would draw asked away and the pointer passing straight through
 * to whatever the caller made the tap target. It is a preview, not a second
 * place to read in — the reader taps it and gets the full-screen viewer,
 * which is where reading happens.
 *
 * The chat is the one place that shows a band today. Drive shows a PDF whole,
 * on a screen of its own, off its own preview endpoint (`DriveFileScreen`),
 * which is the right answer where there is one file and a screen to give it.
 *
 * Clipped rather than trusted: `toolbar=0` is a request a browser may ignore
 * (Firefox does), so the band shows the top of the page and the stylesheet's
 * `overflow: hidden` is what actually decides where the preview ends.
 *
 * Lazy on purpose. Every frame here is a whole PDF viewer instance in the
 * browser, and a transcript scrolled back through a month of reports would
 * otherwise stand up one for each of them at once; `loading="lazy"` holds
 * them to what is near the reader.
 *
 * The BAND is drawn whether or not there is a URL yet, and that is the point:
 * a caller knows a file is a PDF from its stored type, long before the read
 * that mints a link to it answers, so the block can stand at its final size
 * from the first layout and the frame drop into it. A preview that appears a
 * beat later grows whatever it is inside — in the chat, by a quarter of a
 * screen, under a reader who was at the end of the conversation and is then
 * no longer (measured in Chrome against this stylesheet: 51px of drift left
 * behind after the transcript had already been followed to its end). It is
 * the same bargain note #302 struck for pictures, made easier: every page
 * gets the same band, so there is no shape to discover first.
 */

import { pdfPreviewSrc } from './pdf-src.js';

export function PdfPreview({ url, name }: { url: string; name: string }) {
  return (
    <span className={url ? 'pdfpreview' : 'pdfpreview loading'}>
      {url ? <iframe
        className="pdfpreviewframe"
        // The document itself carries the name in the row beside this frame
        // and in the viewer it opens; a screen reader that stops on a frame
        // titled with the same words twice has been told nothing new.
        title={`${name}, first page`}
        src={pdfPreviewSrc(url)}
        loading="lazy"
        tabIndex={-1}
        aria-hidden="true"
        referrerPolicy="no-referrer"
      /> : null}
    </span>
  );
}
