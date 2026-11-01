/**
 * Somebody else's HTML, on screen, with nothing of theirs running.
 *
 * `KnowledgeHtml` next door draws OUR OWN pages — written by an agent in this
 * workplace, through an allowlist the server already enforced at propose time.
 * This one draws markup from outside the building: the formatted half of an
 * email (note #509). Same builder, same allowlist, one difference that matters
 * — `compact` skips every `svg`, and every `img` the caller has not decided
 * about.
 *
 * NO PICTURE IS FETCHED UNLESS THE SCREEN SAYS WHICH ONE. A remote image in a
 * message is a read receipt: requesting it tells the sender the message was
 * opened, when, from which address, in what. So an `img` here draws nothing by
 * default; a caller that has a safe answer for a particular picture — mail's
 * `mailImageDecider` (slice 10): the bytes are already ours, or the reader has
 * asked for it and it goes through our own proxy — passes `images`, and gets
 * exactly the pictures it named.
 *
 * Nothing is written during render, and the nodes are rebuilt only when the
 * source changes.
 */

import { useEffect, useRef } from 'react';
import { buildSafeHtmlNodes } from './knowledge-html.js';

/** What to do with one `<img>` of the sender's: the URL to draw, or null. */
export type SafeHtmlImages = (element: Element) => string | null;

/** One option set for both functions below, because the question
 *  `safeHtmlHasWords` answers is only worth anything if it is asked of the
 *  SAME build that will be mounted: markup that is nothing but a tracking
 *  pixel builds a picture under one of these and nothing under the other. */
const OUTSIDE_MARKUP = { compact: true } as const;

/**
 * Whether this source comes out of the allowlist with words in it.
 *
 * The allowlist is free to refuse everything — markup that is one `<script>`,
 * or a body wrapped entirely in tags this app does not build, arrives as a
 * perfectly valid formatted half and leaves here as nothing at all. A screen
 * choosing between this half and a plain-text one has to know that BEFORE it
 * draws, or it hands the reader an empty card and calls it the message; so
 * the answer is synchronous, built and thrown away.
 *
 * WORDS, deliberately, and not pictures: what this decides is whether the
 * formatted half is a letter or an empty box, and a screen that also draws
 * pictures (the mail conversation, slice 10) asks about those separately —
 * a body that is one photograph and no words is still that body.
 */
export function safeHtmlHasWords(source: string): boolean {
  return Boolean((buildSafeHtmlNodes(source, OUTSIDE_MARKUP).textContent ?? '').trim());
}

export function SafeHtml({ source, className, images }: {
  source: string;
  className?: string;
  images?: SafeHtmlImages;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    node.replaceChildren(buildSafeHtmlNodes(source, images ? { ...OUTSIDE_MARKUP, image: images } : OUTSIDE_MARKUP));
    return () => { node.replaceChildren(); };
  }, [source, images]);
  return <div className={className ? `kpage ${className}` : 'kpage'} ref={host} />;
}
