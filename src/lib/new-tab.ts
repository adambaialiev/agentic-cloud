import { createContext, useContext } from 'react';

/* Every link on the home page opens in a new tab (note #999, the owner,
   5 Nov 2026, 11:32 UTC: "all links in the landing page should open in new
   tab"). The home page turns this on for everything inside it; the same
   links on every other page keep opening in place. */
export const NewTabContext = createContext(false);

export function useNewTab(): boolean {
  return useContext(NewTabContext);
}

/* A new tab never hands the opener to the page it opens. */
export const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' } as const;
