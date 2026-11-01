import { createContext } from 'react';

/**
 * Where a screen puts its own name.
 *
 * Every detail screen used to draw its own title block: some a bare `h1`,
 * some an `h1` over a `.sub`, some a face beside both — three shapes, three
 * gaps under the navigation bar, and a different answer on every screen
 * (note #282). There is one header now, and this is the door into it: the
 * header owns the box, a screen fills it, and the hairline underneath closes
 * the whole block off from the words below it.
 *
 * A DOM node rather than a piece of state, because a title is markup — a
 * context ring around a face, a workplace's mark, a runtime line — and a
 * portal carries all of it without the header having to know the shapes.
 * `null` while no header is up (Home, the chat), and a `ScreenTitle` renders
 * nothing then rather than guessing.
 */
export const HeadSlotContext = createContext<HTMLElement | null>(null);
