/**
 * A person's face, by the same rule an agent's follows (AgentFace): their
 * picture when they have one, the user glyph when they have none or the
 * picture fails to load. One copy, so a member from before profile pictures
 * reads as the same KIND of thing as the ones beside them — on the People
 * page, the workplace's door, and the member's own screen alike.
 *
 * Given their `name`, a person with no picture wears their INITIALS on the
 * accent's soft tint instead of the glyph (note #833, Adam: "just redesign
 * this"): a grey outline of a person says nothing, two letters say who.
 */

import { useState } from 'react';
import { TypeIcon } from './icons.js';
import { personInitials } from './initials.js';

export function PersonFace({ photoUrl, name, className = 'avatar' }: {
  photoUrl?: string;
  /** Draw initials, not the glyph, when there is no picture. */
  name?: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (!photoUrl || broken) {
    const initials = name ? personInitials(name) : '';
    return initials
      ? <span className={`${className} initials`} aria-hidden="true">{initials}</span>
      : <TypeIcon glyph="user" />;
  }
  return <img className={className} src={photoUrl} alt="" onError={() => setBroken(true)} />;
}
