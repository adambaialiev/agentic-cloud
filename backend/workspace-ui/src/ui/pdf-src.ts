/**
 * How a PDF is ASKED to be drawn — the fragment on the end of a signed URL.
 *
 * PDF open parameters are the one lever a page has over the viewer built into
 * the browser: we hand the frame a document and a reading, and Chrome, Edge,
 * Firefox and Safari each draw it with their own chrome. A browser that does
 * not recognise a parameter ignores it, so both fragments below are requests
 * rather than promises — which is why the preview frame is CLIPPED to the
 * page rather than trusting `toolbar=0` to have been honoured.
 *
 * Kept in one place because two screens and the viewer all build one, and a
 * preview that opens at a different page from the viewer it opens into is
 * exactly the kind of disagreement that never gets noticed.
 */

/** Fit the page to the frame's WIDTH — the reading a phone wants, because a
 *  page fitted to the height of a 4:3 window is a page nobody can read. */
const READING = 'view=FitH';

/** The first page, fitted the same way, with every control the viewer would
 *  otherwise draw asked away: a preview is a picture of the document, not a
 *  second place to work in. */
const PREVIEW = 'page=1&toolbar=0&navpanes=0&scrollbar=0&statusbar=0&view=FitH';

/** A signed URL carries a query and never a fragment; one that somehow does
 *  loses it, because a browser reads the LAST `#` and ours has to win. */
const withFragment = (url: string, fragment: string): string => {
  const hash = url.indexOf('#');
  return `${hash < 0 ? url : url.slice(0, hash)}#${fragment}`;
};

export const pdfReadingSrc = (url: string): string => withFragment(url, READING);
export const pdfPreviewSrc = (url: string): string => withFragment(url, PREVIEW);
