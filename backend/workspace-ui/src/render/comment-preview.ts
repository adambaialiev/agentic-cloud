/**
 * The newest remark on a note, as one compact glimpse on a list row.
 *
 * A count told the reader a conversation existed and nothing about whether it
 * mattered, so the only way to find out was to open every note carrying one —
 * and the answer is almost always the single sentence that fits here: "fixed,
 * it is in your chat" (note #16).
 *
 * The backend chooses the visible sentence (`text`); the HTML it came from
 * (`html`) is what keeps emphasis and code inside that sentence. So the row
 * renders the HTML through the SAME allowlist a note is built with — never
 * innerHTML — and then CLIPS it to exactly the backend's answer. A tree that
 * cannot be clipped to those words falls back to the plain sentence rather
 * than showing formatted words that differ from what the server said.
 */

import { buildKnowledgeHtml } from './knowledge-html.js';

/** Page-shaped elements that must not lay out as pages inside one row. Their
 *  full layout remains on the note's own screen. */
const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,ul,ol,li,dl,dt,dd,table,thead,tbody,tfoot,tr,th,td,caption,'
  + 'colgroup,blockquote,pre,section,article,aside,nav,header,footer,main,figure,figcaption,div,details,summary';

/** The highest ancestor this text node leads — where a joining space belongs,
 *  so it lands outside the emphasis rather than inside it. */
function leadingEdge(root: Element, node: Node): Node {
  let edge: Node = node;
  while (edge.parentNode && edge.parentNode !== root) {
    let hasWordsBefore = false;
    for (let before = edge.parentNode.firstChild; before && before !== edge; before = before.nextSibling) {
      if ((before.textContent ?? '').trim()) { hasWordsBefore = true; break; }
    }
    if (hasWordsBefore) break;
    edge = edge.parentNode;
  }
  return edge;
}

/** Keep exactly the backend's short visible preview inside a safely rebuilt
 *  tree. Text beyond it is removed, the tags around what stays survive, and a
 *  clipped final node receives the ellipsis the backend chose. */
export function clipCommentPreview(root: HTMLElement, preview: string): HTMLElement {
  const wanted = String(preview || '').replace(/\s+/g, ' ').trim();
  const texts: Text[] = [];
  const collect = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) texts.push(child as Text);
      else if (child.nodeType === 1) collect(child);
    }
  };
  collect(root);
  let used = 0;
  let done = wanted.length === 0;
  for (const node of texts) {
    const flat = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    if (!flat || done) { node.remove(); continue; }
    const remaining = wanted.slice(used);
    const separator = remaining.charAt(0) === ' ' ? ' ' : '';
    const contribution = separator + flat;
    if (remaining.slice(0, contribution.length) === contribution) {
      if (separator) {
        const edge = leadingEdge(root, node);
        edge.parentNode?.insertBefore(document.createTextNode(' '), edge);
      }
      node.nodeValue = flat;
      used += contribution.length;
      done = used === wanted.length;
      continue;
    }
    // The target ends inside this node (often with a synthetic ellipsis). A
    // real mismatch falls back to plain text below rather than risking a
    // formatted preview whose visible words differ from the server's answer.
    let shared = 0;
    while (shared < remaining.length && shared < contribution.length
      && remaining.charAt(shared) === contribution.charAt(shared)) shared += 1;
    if (!shared) { node.remove(); continue; }
    let tail = remaining;
    if (separator) {
      const edge = leadingEdge(root, node);
      edge.parentNode?.insertBefore(document.createTextNode(' '), edge);
      tail = tail.slice(1);
    }
    node.nodeValue = tail;
    used = wanted.length;
    done = true;
  }
  // Media, rules, or wrappers left with no visible words have no place in a
  // text preview. Reverse order lets an emptied parent disappear after child.
  for (const element of [...root.querySelectorAll('*')].reverse()) {
    if (!(element.textContent ?? '').trim()) element.remove();
  }
  if (used === wanted.length) return root;
  const plain = document.createElement('span');
  plain.textContent = wanted;
  return plain;
}

export interface CommentPreviewSource { html?: string; text?: string }

/** The glimpse as a detached element, ready to mount. */
export function buildCommentPreview(comment: CommentPreviewSource): HTMLElement {
  const hasHtml = typeof comment.html === 'string';
  // Old backend + new cached page: `text` may itself still be markup. Parsing
  // it is the compatible answer and is safe for the same allowlist reason.
  const rendered = buildKnowledgeHtml(hasHtml ? comment.html! : (comment.text ?? ''), ' ', { compact: true });
  const wanted = hasHtml ? (comment.text ?? '') : (rendered.textContent ?? '');
  const clipped = clipCommentPreview(rendered, wanted);
  clipped.classList.add('ctext', 'commenthtml');
  for (const node of Array.from(clipped.querySelectorAll(BLOCKS))) node.classList.add('cinline');
  for (const link of Array.from(clipped.querySelectorAll('a'))) {
    // The whole row opens the note. A second live destination nested inside
    // it would make one tap mean two things; the link is active in the full
    // view.
    link.removeAttribute('href');
    link.removeAttribute('target');
    link.removeAttribute('rel');
  }
  return clipped;
}
