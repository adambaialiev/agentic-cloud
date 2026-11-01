/**
 * The one bar every wait in this app is built out of.
 *
 * It lived in the proposal screen's own `Skeleton.tsx` until a second screen
 * needed it (note #309), which is exactly the moment a shape stops belonging
 * to one screen: the stylesheet's own rule beside it is already "named for
 * the SHAPE and not for the screen", because a second copy per screen is how
 * two waits end up disagreeing about what a wait looks like.
 */

/**
 * A bar standing in for one line of text.
 *
 * INLINE inside an ordinary line box, not a block of its own — which is the
 * whole trick. A block bar is as tall as the number in the stylesheet; an
 * inline one takes the line box of whatever container it sits in, so a held
 * line is exactly as tall as the words that will replace it, in a container
 * whose leading nobody has to look up. Widths vary between rows on purpose:
 * rows of one width read as a graphic, these read as a list waiting to fill.
 */
export function SkelText({ width, height = 11, delay }: {
  width: string;
  height?: number;
  delay?: string;
}) {
  return (
    <div>
      <span
        className="skel skel-inline"
        style={{ width, height: `${height}px`, ...(delay ? { animationDelay: delay } : {}) }}
      />
    </div>
  );
}
