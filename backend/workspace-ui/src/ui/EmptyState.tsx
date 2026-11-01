/**
 * The block a room-owned section draws when it has nothing on it yet — the
 * legacy `workspaceEmptyState(glyph, tint, title, body)`.
 *
 * It is not a placeholder: a shelf that exists but is empty has to say what
 * would fill it and who fills it, or the reader is left deciding whether the
 * section is broken. One copy, because the mark, the title and the body are
 * three nodes the shared stylesheet sizes together.
 */

import { TypeIcon, type IconName, type IconTint } from './icons.js';

export function EmptyState({ glyph, tint = '', title, body }: {
  glyph: IconName;
  tint?: IconTint;
  title: string;
  body: string;
}) {
  return (
    <div className="empty roomempty">
      <div className={tint ? `roomemptymark ft-${tint}` : 'roomemptymark'} aria-hidden="true">
        <TypeIcon glyph={glyph} tint={tint} />
      </div>
      <div className="roomemptycopy">
        <div className="roomemptytitle">{title}</div>
        <div className="roomemptybody">{body}</div>
      </div>
    </div>
  );
}
