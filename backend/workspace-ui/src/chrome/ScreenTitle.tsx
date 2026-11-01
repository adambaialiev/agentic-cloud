import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HeadSlotContext } from './head-slot.js';

/**
 * One screen's name, drawn inside the one header (note #282).
 *
 * The shape is the same everywhere: an optional mark on the left — a face, a
 * ring, a workplace's letter — then the title, then an optional line
 * under it. A screen that has no mark and no sub still gets the same box, so
 * its title sits exactly where every other screen's does.
 *
 * It renders into the header rather than at the top of the screen, which is
 * what makes the hairline mean something: everything above the line is the
 * header, everything below it is the screen. `id` is kept on the `h1` where
 * a screen already had one, because the stylesheet and the tests key on it.
 */
export function ScreenTitle({ mark, markId, title, titleId, titleClass, sub, subId, subNode }: {
  mark?: ReactNode;
  markId?: string;
  title: ReactNode;
  titleId?: string;
  titleClass?: string;
  sub?: ReactNode;
  subId?: string;
  /** For a line that already draws itself as one — a repository crumb, a
   *  proposal's eyebrow. It replaces `sub` rather than nesting inside it. */
  subNode?: ReactNode;
}) {
  const slot = useContext(HeadSlotContext);
  if (!slot) return null;
  return (
    <>
      {createPortal(
        <div className="phead">
          {mark ? <div className="pmark" id={markId}>{mark}</div> : null}
          <div className="pname">
            <h1 className={titleClass} id={titleId}>{title}</h1>
            {subNode ?? (sub ? <div className="sub" id={subId}>{sub}</div> : null)}
          </div>
        </div>,
        slot,
      )}
    </>
  );
}
