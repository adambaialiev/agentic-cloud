/**
 * Home's address: the record of what Home is showing (note #524).
 *
 * Home is ONE place, so the choices a reader makes on it are presentation
 * state rather than destinations of their own. Until 2026-10-10 three of
 * them lived in its address — the HALF being read (note #404), the ROOM whose
 * chip was tapped, and the open SHELF (note #419):
 *
 *     /?half=rooms&room=<room-id>&content=notes
 *
 * Since then Home is the Chief of Staff's conversation and always opens as
 * it (`HomeScreen`): an address that still carries any of the three has them
 * dropped in place. The overview's own old address keeps reading `half`
 * (`overviewTo`, `overviewArrival`), because buttons and open tabs still
 * name it.
 *
 * Rooms left the product with note #843: `room` and `content` are read only
 * to be dropped (or, for an old link to a room's notes shelf, to open the
 * notes), and the half that was `rooms` is the agents picker, `agents`.
 *
 * Pure, and the ONLY place these parameter names are written.
 */

import { workspaceRoutePath } from '../../../../src/shared/workspace-routes.js';
import type { HomeHalf } from './home-half.js';

export const HOME_HALF_PARAM = 'half';
/** Old addresses only (note #843): read to be dropped, never written. */
export const HOME_ROOM_PARAM = 'room';
/** Old addresses only (note #843): read to be dropped, never written. */
export const HOME_CONTENT_PARAM = 'content';

const HALF_WORD: Record<HomeHalf, string> = { workplace: 'workplace', agents: 'agents' };
/** The word the agents picker's half went by while it was the rooms. */
const ROOMS_WORD = 'rooms';

/** Which half an address names, or null when it does not name one. An old
 *  `half=rooms` is the agents picker (note #843). */
export function addressHalf(search: URLSearchParams): HomeHalf | null {
  const word = (search.get(HOME_HALF_PARAM) ?? '').trim();
  if (word === ROOMS_WORD) return 'agents';
  const half = (Object.keys(HALF_WORD) as HomeHalf[]).find((which) => HALF_WORD[which] === word);
  return half ?? null;
}

/**
 * The overview's address with the half it should open written in
 * (2026-10-10): the Workplace window, or the agents picker. Router-relative,
 * as `toFor` writes. Where a caller used to `navigate('/')` to land on a
 * room's agents, it lands here — on every agent, since note #843 — and
 * Home opens the picker over the conversation.
 */
export function overviewTo(orgId: string | null | undefined, shown: { half?: HomeHalf } = {}): string {
  const base = workspaceRoutePath({ kind: 'recapAgent', ...(orgId ? { orgId } : {}) }) ?? '/overview';
  const split = base.indexOf('?');
  const path = split < 0 ? base : base.slice(0, split);
  const query = new URLSearchParams(split < 0 ? '' : base.slice(split + 1));
  if (shown.half) query.set(HOME_HALF_PARAM, HALF_WORD[shown.half]);
  const suffix = query.toString();
  return `${path}${suffix ? `?${suffix}` : ''}`;
}

/** Whether an address carries Home's old presentation parameters — every
 *  tab that was open on the old Home, and every link copied from one. Home
 *  drops them and opens the chat (2026-10-10). */
export function carriesHomeShown(search: URLSearchParams): boolean {
  return search.has(HOME_HALF_PARAM) || search.has(HOME_ROOM_PARAM) || search.has(HOME_CONTENT_PARAM);
}
