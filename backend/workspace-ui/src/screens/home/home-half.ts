/**
 * The two halves of the overview's old address (note #404): Workplace, and
 * the rooms. Since note #715 they are what Home opens over itself — the
 * Workplace window and the agents picker — and this word survives only
 * where `?half=` is still read: the overview's old address, which opens the
 * one it names. The per-tab memory of which half was last chosen went with
 * the tabs: a window is opened by a door, and nothing reopens one by itself.
 *
 * The second half was the ROOMS until rooms left the product (note #843):
 * the agents picker it opens is one list of every agent now, so it is
 * called that. An old address that still says `half=rooms` reads as it.
 */

export type HomeHalf = 'workplace' | 'agents';
