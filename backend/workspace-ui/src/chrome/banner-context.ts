import { createContext } from 'react';

/** What an action has to say when the screen itself cannot say it: a failure,
 *  or the receipt for something that has already finished and left. */
export interface BannerValue {
  /** `ok` is the success tint; the default is the failure one. */
  show: (text: string, ok?: boolean) => void;
  hide: () => void;
}

export const BannerContext = createContext<BannerValue | null>(null);
