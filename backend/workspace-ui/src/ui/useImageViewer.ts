import { useContext } from 'react';
import { ImageViewerContext, type ViewerImage } from './image-viewer-context.js';

/**
 * Open a picture full screen. Returns a no-op outside a provider rather than
 * throwing, so a screen can be rendered in isolation by a test without
 * standing the whole viewer up — the tap then simply does nothing, which is
 * what a missing viewer honestly is.
 */
export function useImageViewer(): (images: readonly ViewerImage[], index: number, host?: HTMLElement) => void {
  const value = useContext(ImageViewerContext);
  return value ? value.open : () => {};
}
