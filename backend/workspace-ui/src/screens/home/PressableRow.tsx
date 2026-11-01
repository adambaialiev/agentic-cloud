/**
 * A list row that is a door. The legacy page made these `div.crow` with an
 * `onclick`; here the row is keyboard-reachable too, and every row on Home
 * uses this one so tap and Enter mean the same thing everywhere.
 *
 * Given an `href` the row IS a link (note #284): same class, same box, same
 * pixels — `.crow` lays out as a flex box under either tag — but now the
 * browser can open it in a new tab, copy its address and long-press it, which
 * no amount of `onclick` ever gives back. The tap itself is still the shell's:
 * a plain left-click is answered by `onPress` and never reloads the app, while
 * a modifier or a middle button is left to the browser. `draggable={false}` is
 * the one thing an anchor brings that a row must not have — a link is
 * draggable by default, and that fights the swipe living on the same element.
 */

import type { HTMLAttributes, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { AGENT_DOOR_ATTR, ROW_DOOR_ATTR } from '../../ui/FaceDoor.js';
import { plainClick } from '../../ui/link-click.js';

/** Anything else a caller needs on the row itself — an id, a `data-` mark, a
 *  swipe's transform and its pointer handlers — rides through untouched. The
 *  three this component owns are the three it is for. Typed on `HTMLElement`
 *  because the row is a `div` or an `a` depending on the caller. */
type RowRest = Omit<HTMLAttributes<HTMLElement>, 'className' | 'onClick' | 'onKeyDown' | 'role' | 'tabIndex'>;

/**
 * A press that landed on an AGENT'S FACE opens that agent instead of the row
 * (note #640). The face is marked rather than made a button of its own: a
 * button inside this row would be invalid markup and, by ARIA's
 * presentational children rule, invisible to a screen reader anyway — so the
 * row, which is the one real control here, reads the mark and answers the
 * more specific tap. Keyboard and screen reader keep the row's single
 * destination, which is the row's own subject; the agent behind the face is
 * always reachable from the screen that subject opens.
 */
function agentDoorFrom(event: MouseEvent<HTMLElement>): string | null {
  const node = (event.target as HTMLElement | null)?.closest?.(`[${AGENT_DOOR_ATTR}]`);
  return node?.getAttribute(AGENT_DOOR_ATTR) || null;
}

/** A press on a row's other marked door (`ROW_DOOR_ATTR`): the address it opens. */
function rowDoorFrom(event: MouseEvent<HTMLElement>): string | null {
  const node = (event.target as HTMLElement | null)?.closest?.(`[${ROW_DOOR_ATTR}]`);
  return node?.getAttribute(ROW_DOOR_ATTR) || null;
}

export function PressableRow({ className, onPress, href, children, ...rest }: {
  className: string;
  onPress: () => void;
  /** The row's own address. Given one, the row is an anchor rather than a
   *  `div` playing one. */
  href?: string;
  children: ReactNode;
} & RowRest) {
  const navigate = useNavigate();
  const pressed = (event: MouseEvent<HTMLElement>): void => {
    const door = rowDoorFrom(event);
    if (door) { navigate(door); return; }
    const agentId = agentDoorFrom(event);
    const to = agentId ? toFor({ kind: 'agent', id: agentId }) : null;
    if (to) { navigate(to); return; }
    onPress();
  };
  if (href) {
    // No role, no tabIndex, no key handler: an anchor is already focusable and
    // already fires a click on Enter, which lands in exactly the handler
    // below. Adding them back would only make it announce itself twice.
    return (
      <a
        className={className}
        href={href}
        draggable={false}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (!plainClick(event.nativeEvent)) return;
          event.preventDefault();
          pressed(event);
        }}
        {...rest}
      >
        {children}
      </a>
    );
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPress(); }
  };
  return (
    <div className={className} role="button" tabIndex={0} onClick={pressed} onKeyDown={onKeyDown} {...rest}>
      {children}
    </div>
  );
}
