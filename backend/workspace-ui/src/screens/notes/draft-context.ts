import { createContext } from 'react';

/**
 * A file picked for a note that does not exist yet. The object URL is minted
 * WITH the pick and held beside it, rather than per repaint: each URL pins
 * the file's bytes in memory until it is revoked, and this list repaints on
 * every pick and every removal.
 */
export interface NoteDraftFile {
  file: File;
  /** The photo's own bytes, ready for an `<img src>`; null for anything that
   *  is not shown as a picture. */
  url: string | null;
}

/**
 * The unsaved note — its words and its files — for as long as the reader has
 * not saved it.
 *
 * Above the screens rather than inside one, exactly as the legacy page keeps
 * it in module state: the draft is NOT cleared on the way in, only a save
 * empties it, so backing out of a half-written note (or missing and hitting
 * the swipe) and coming back finds the words still there — which is what
 * every notes app on the phone does. It survives moving between Home and the
 * notes screen for the same reason.
 */
export interface NoteDraftValue {
  text: string;
  files: readonly NoteDraftFile[];
  setText: (text: string) => void;
  addFile: (file: File) => void;
  removeFile: (file: File) => void;
  /** The draft is spent: let the photos' bytes go with it, or every note
   *  written this session stays pinned behind a live object URL. */
  clear: () => void;
}

export const NoteDraftContext = createContext<NoteDraftValue | null>(null);
