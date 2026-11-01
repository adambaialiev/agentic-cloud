import { createContext, type ReactNode } from 'react';

/**
 * The app's destinations, drawable somewhere other than the page.
 *
 * A window over a screen that keeps its own pages (note #722: the rooms
 * window in the agents picker) draws the same screens the router does — a
 * proposal, a note, an agent — inside itself. The table that maps an address
 * to its screen lives in `App.tsx` and is the only one; this hands its
 * routes down to the window, which draws them under a location of its own
 * (`WindowNavigation`), rather than importing the app it is part of.
 *
 * The routes themselves, drawn wherever they are put: under a window's own
 * location they match that location. `null` outside the signed-in app.
 */
export const DestinationsContext = createContext<ReactNode>(null);
