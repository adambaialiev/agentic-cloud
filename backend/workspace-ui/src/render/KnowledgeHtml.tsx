/**
 * A knowledge page, a quick note or a margin remark, on screen.
 *
 * The words are built as DOM by `buildKnowledgeHtml` — allowlisted node by
 * node, never innerHTML — and mounted here. Nothing is written during render,
 * so the same source always draws the same page; `files` and `onImage` are
 * dependencies of the rebuild, so a caller passes stable ones (useMemo /
 * useCallback) rather than a fresh object each paint.
 */

import { useEffect, useRef } from 'react';
import { buildKnowledgeHtml, type KnowledgeRenderOptions } from './knowledge-html.js';

export function KnowledgeHtml({ source, empty, files, compact, onImage, dropTitle, titleIsFirstLine, noteRefs, extraClass, plainWhenBare }: KnowledgeRenderOptions & {
  source: string;
  /** The sentence to stand in for a page with nothing in it. */
  empty?: string;
  /** Classes to put on the `.kpage` box itself, as the legacy callers do. */
  extraClass?: string;
  /** A remark whose whole text is one bare sentence has no elements of its
   *  own; `.plain` is what keeps its line breaks. */
  plainWhenBare?: boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const page = buildKnowledgeHtml(source, empty, { files, compact, onImage, dropTitle, titleIsFirstLine, noteRefs });
    if (extraClass) page.className = `${page.className} ${extraClass}`;
    if (plainWhenBare && page.children.length === 0) page.classList.add('plain');
    node.replaceChildren(page);
    return () => { node.replaceChildren(); };
  }, [source, empty, files, compact, onImage, dropTitle, titleIsFirstLine, noteRefs, extraClass, plainWhenBare]);
  return <div ref={host} />;
}
