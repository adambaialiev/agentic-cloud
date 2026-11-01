import { useContext } from 'react';
import { PdfViewerContext, type ViewerDocument } from './pdf-viewer-context.js';

/**
 * Open a PDF full screen. Returns a no-op outside a provider rather than
 * throwing, exactly as `useImageViewer` does, so a screen can be rendered in
 * isolation by a test without standing the whole viewer up — the tap then
 * simply does nothing, which is what a missing viewer honestly is.
 */
export function usePdfViewer(): (document: ViewerDocument, host?: HTMLElement) => void {
  const value = useContext(PdfViewerContext);
  return value ? value.open : () => {};
}
