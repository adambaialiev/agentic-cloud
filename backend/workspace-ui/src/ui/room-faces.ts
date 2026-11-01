/**
 * How many agents a stack of faces shows. Pure, and shared. It also named
 * who was in a room, in words under the room's mark (`roomWhoLine`), until
 * rooms left the product (note #843); the stack is the agents picker's door
 * and a workplace's member count now.
 */

export const ROOM_FACES_SHOWN = 3;

/**
 * `counted` is what a stack is FOR.
 *
 * On a room it is a census — three faces and a `+N` for the rest, so the mark
 * agrees with the line of names beneath it. On the chat composer's switcher
 * it is a DOOR, and the owner (2026-09-20) was right that the `+12` there was
 * the worst thing on the button: a grey disc with a number in it reads as a
 * broken portrait, and it bought a fact the list behind the door states
 * properly a tap later. Uncounted, the same width holds three faces instead
 * of two and a smudge.
 */
export function roomFaceParts<T>(agents: T[], counted = true): { shown: T[]; rest: number } {
  if (!counted) return { shown: agents.slice(0, ROOM_FACES_SHOWN), rest: 0 };
  const shown = agents.length <= ROOM_FACES_SHOWN ? agents : agents.slice(0, ROOM_FACES_SHOWN - 1);
  return { shown, rest: agents.length - shown.length };
}
