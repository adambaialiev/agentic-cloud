/** A window's pages, as data (`WindowNavigation`, note #722). */

import { parsePath, type Path, type To } from 'react-router-dom';

/** One page of a window: an address, as a location of its own. */
export interface WindowPage {
  key: string;
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
}

/** What a window does with a move asked for under it. `level` is where
 *  it was asked: 0 is the window's own view, 1 its first page. */
export interface WindowMoves {
  to: (path: Path, state: unknown, replace: boolean, level: number) => void;
  go: (delta: number) => void;
}

/** A whole path from whatever a navigator was handed. */
export function pathOf(to: To): Path {
  const parsed = typeof to === 'string' ? parsePath(to) : to;
  return { pathname: parsed.pathname || '/', search: parsed.search ?? '', hash: parsed.hash ?? '' };
}

/** A fresh page key, the router's own shape. */
export function pageKey(): string {
  return Math.random().toString(36).slice(2, 10);
}
