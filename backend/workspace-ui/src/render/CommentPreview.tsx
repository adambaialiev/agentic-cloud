/**
 * The newest remark on a note, mounted. Built as DOM by
 * `buildCommentPreview` — the same node-by-node allowlist a note itself goes
 * through — and never as a string into markup.
 */

import { useEffect, useRef } from 'react';
import { buildCommentPreview, type CommentPreviewSource } from './comment-preview.js';

export function CommentPreview({ comment }: { comment: CommentPreviewSource }) {
  const host = useRef<HTMLSpanElement | null>(null);
  const html = comment.html;
  const text = comment.text;
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    node.replaceChildren(buildCommentPreview({ html, text }));
    return () => { node.replaceChildren(); };
  }, [html, text]);
  return <span ref={host} />;
}
