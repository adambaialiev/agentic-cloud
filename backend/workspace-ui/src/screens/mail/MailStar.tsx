/**
 * THE STAR (note #666) — one control, drawn the same on a list's row and on a
 * letter in its conversation, because it is the same mark in both places.
 *
 * An outline while the letter is not starred and a filled one while it is,
 * with `aria-pressed` saying the same thing to a reader who cannot see the
 * glyph fill in. The state is always the SERVER's: a tap disables the star
 * until the answer arrives, and the fill follows the answer, never the tap.
 */

import { Svg } from '../../ui/icons.js';
import { mailStarLabel } from './mail-words.js';

export function MailStar({ id, starred, busy, what = 'message', onPress }: {
  id: string;
  starred: boolean;
  busy: boolean;
  what?: 'message' | 'conversation';
  onPress: () => void;
}) {
  const label = mailStarLabel(starred, what);
  return <button
    className={`mailstar${starred ? ' on' : ''}`}
    id={id}
    type="button"
    aria-pressed={starred}
    aria-label={label}
    title={label}
    disabled={busy}
    onClick={onPress}
  >
    <Svg name="star" size={18} />
  </button>;
}
