/**
 * A long write-up folds. The agent explaining itself is worth reading, but it
 * must not cost the reader the rows underneath: the tail fades and one tap
 * gives it back. Short bodies are left alone — a fold over four lines is a
 * control that does nothing.
 *
 * The measurement itself lives in `fold.ts`; this is the whole thing in one
 * box, for a screen with nowhere else to put the button.
 */

import { useRef, type ReactNode } from 'react';
import { Icon } from '../../ui/icons.js';
import { useFold } from './fold.js';

export function ReadMore({ onClick }: { onClick: () => void }) {
  return (
    <button className="readmore" type="button" onClick={onClick}>
      <Icon name="chev" size={15} className="icon down" />
      <span>Read more</span>
    </button>
  );
}

export function FoldLong({ contentKey, children }: { contentKey: string; children: ReactNode }) {
  // The wrap itself, so the write-up stays its DIRECT child exactly as the
  // legacy page leaves it: the stylesheet's spacing around `#prBody .mdwrap`
  // is measured against that, and one more box between them moves the card.
  const wrap = useRef<HTMLDivElement | null>(null);
  const fold = useFold(wrap, contentKey);
  return (
    <div className={fold.className} ref={wrap}>
      {children}
      {fold.showFold ? <ReadMore onClick={fold.open} /> : null}
    </div>
  );
}
