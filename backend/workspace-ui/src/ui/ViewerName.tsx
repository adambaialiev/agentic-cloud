/**
 * The file's name in a full-screen viewer's head, and the button that copies
 * it (note #561) — shared by the picture viewer and the document viewer,
 * which draw the same `.ivhead`.
 *
 * The viewer as a whole refuses selection (`user-select: none` on the
 * dialog: a drag on the stage pans the picture, it must not paint a blue
 * wash over the chrome), and the name used to inherit that — so the one
 * piece of text in the head a reader might want to take away was the one
 * they could not. It opts back in with `.ivname`, and the icon beside it
 * copies the whole name in one tap, even when the head has cut it short.
 *
 * Callers key it on the name, so stepping to the next picture starts with a
 * fresh copy icon rather than the last one's tick.
 *
 * The answer to a copy is the button itself: the icon turns to a tick for a
 * moment. A toast would land under the viewer, which covers the page. When
 * the clipboard refuses, the name is selected instead, so the reader's own
 * copy is one keystroke or one "Copy" away.
 */

import { useEffect, useRef, useState } from 'react';
import { copyFromTap } from './format.js';
import { Svg } from './icons.js';

export function ViewerName({ id, name }: { id: string; name: string }) {
  const text = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const selectName = () => {
    const node = text.current;
    const selection = window.getSelection();
    if (!node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const copy = () => {
    setFailed(false);
    void copyFromTap(async () => name).then(
      () => setCopied(true),
      () => { setCopied(false); setFailed(true); selectName(); },
    );
  };

  return (
    <div className="ivtitle">
      <div className="ivname" id={id} ref={text}>{name}</div>
      <button
        className="ivcopy"
        id={`${id}Copy`}
        type="button"
        aria-label={copied ? `Copied ${name}` : `Copy the name ${name}`}
        title={copied ? 'Copied' : 'Copy name'}
        onClick={copy}
      >
        <Svg name={copied ? 'tick' : 'copy'} size={17} />
      </button>
      <span className="sr-only" role="status">
        {copied ? `Copied ${name}` : failed ? 'Could not copy — the name is selected instead.' : ''}
      </span>
    </div>
  );
}
