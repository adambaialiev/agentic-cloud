/**
 * Whether this reader has asked for less movement.
 *
 * One copy for the whole shell: the chat's smooth scroll to a new message and
 * the proposal screen's move to the landing sequence are the same question
 * asked twice, and two copies is how they end up disagreeing about it.
 */
export const reducedMotion = (): boolean =>
  Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
