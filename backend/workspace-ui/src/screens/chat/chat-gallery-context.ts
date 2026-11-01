/**
 * The conversation gallery's contract, apart from its provider so the
 * component file exports components alone (fast refresh). What it is FOR is
 * explained on `ChatGallery.tsx`.
 */

import { createContext, useContext } from 'react';
import type { WorkspaceChatFile } from '../../../../src/shared/workspace-api.js';

export interface GalleryPicture {
  file: WorkspaceChatFile;
  /** The preview URL the row painted. */
  url: string;
  /** Where in the conversation the picture was said: the row's sequence,
   *  then its place among that message's files. */
  seq: number;
  index: number;
}

export interface ChatGallery {
  /** A picture that is now painted, or painted again under a new URL. */
  add: (picture: GalleryPicture) => void;
  /** A picture that left the screen or broke. */
  remove: (id: string) => void;
  /** Every painted picture, oldest first. */
  pictures: () => GalleryPicture[];
}

export const ChatGalleryContext = createContext<ChatGallery | null>(null);

export const useChatGallery = (): ChatGallery | null => useContext(ChatGalleryContext);
