/**
 * What a seat (a private subscription sign-in) is called and how full it
 * is, ported from the legacy page's helpers of the same names — and, at the
 * foot, which agents a seat is carrying, which is what makes a subscription
 * item able to say it is in use rather than merely primary.
 */

import type { WorkspaceSeatRecord, WorkspaceSeatUsage } from '../../../src/shared/workspace-api.js';
import { subscriptionName as sharedSubscriptionName } from '../../../src/shared/harness-clis.js';

type SeatLike = Pick<WorkspaceSeatRecord, 'status' | 'attention'> | Pick<WorkspaceSeatUsage, 'status' | 'attention'>;

export function seatNeedsPayment(seat: SeatLike): boolean {
  return seat.attention === 'payment_required' || seat.status === 'payment_required';
}

export function seatHasCurrentUsage(seat: SeatLike): boolean {
  return !seatNeedsPayment(seat) && (!seat.status || seat.status === 'active' || seat.status === 'cooldown');
}

export function usageSeverity(usedPercent: number): '' | 'warn' | 'hot' {
  return usedPercent >= 90 ? 'hot' : usedPercent >= 75 ? 'warn' : '';
}

export function seatStatusWords(seat: SeatLike): { tone: 'rejected' | 'merged' | 'open' | 'quiet'; text: string } {
  if (seatNeedsPayment(seat)) return { tone: 'rejected', text: 'Subscription needs attention' };
  if (seat.status === 'active') return { tone: 'merged', text: 'Ready' };
  if (seat.status === 'cooldown') return { tone: 'open', text: 'Resting' };
  if (seat.status === 'dead') return { tone: 'rejected', text: 'Needs sign-in' };
  return { tone: 'quiet', text: 'Off' };
}

export function untilText(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'in under a minute';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `in ${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

/** "in 2h 10m (14:05)", "any moment now", or null for a bad time. */
export function resetPhrase(iso: string, now = Date.now()): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const left = at.getTime() - now;
  if (left <= 0) return 'any moment now';
  const clock = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return `${untilText(left)} (${sameDay ? '' : `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, `}${clock})`;
}

export function subscriptionName(provider: string): string {
  return provider === 'codex' || provider === 'opencode' ? sharedSubscriptionName(provider) : 'Claude';
}

type SeatNaming = Pick<WorkspaceSeatUsage, 'seatId' | 'provider' | 'planText' | 'label'>;

/**
 * A sign-in's short name — its product and plan, "Claude Max 20x", the words
 * its plate is titled with — so an agent that names its subscription names
 * the one on Home. Two sign-ins of one plan would read the same, so then the
 * stored label (which carries the sign-in date) tells them apart instead.
 */
export function seatShortName(seat: SeatNaming, seats: SeatNaming[] = []): string {
  if (!seat.planText) return seat.label;
  const twin = seats.some((other) => other.seatId !== seat.seatId
    && other.provider === seat.provider && other.planText === seat.planText);
  return twin ? seat.label : `${subscriptionName(seat.provider)} ${seat.planText}`;
}

/**
 * Whether a row of "Your subscriptions" says "Primary" (note #773 — the
 * compact plates on Home do not): it is the one this workplace's turns use
 * first, AND another sign-in of the same harness stands beside it.
 * With one Claude sign-in there is nothing to be primary over, and a Claude
 * and a ChatGPT sign-in are each first for their own agents — marking both
 * would say nothing a reader could act on.
 */
export function seatShowsPrimary(
  seat: Pick<WorkspaceSeatUsage, 'seatId' | 'provider' | 'selected'>,
  seats: Array<Pick<WorkspaceSeatUsage, 'seatId' | 'provider'>>,
): boolean {
  return seat.selected && seats.some((other) => other.seatId !== seat.seatId && other.provider === seat.provider);
}

/** The word a subscription's own sign-in page is addressed by — the
 *  subscription, as the page names it: `/sign-in/chatgpt`, `/sign-in/claude`,
 *  `/sign-in/opencode`. */
export function signInSlug(provider: string): 'claude' | 'chatgpt' | 'opencode' {
  return provider === 'codex' ? 'chatgpt' : provider === 'opencode' ? 'opencode' : 'claude';
}

/** The provider a sign-in address names, or null for any other word. */
export function providerForSignInSlug(slug: string | undefined): 'claude' | 'codex' | 'opencode' | null {
  return slug === 'claude' ? 'claude' : slug === 'chatgpt' ? 'codex' : slug === 'opencode' ? 'opencode' : null;
}

/** The seat facts the agent→seat join needs, on either seat shape. */
type SeatIdentity = Pick<WorkspaceSeatUsage, 'seatId' | 'provider' | 'selected'>;
/** And the agent facts. `working` is the live tick's, so this reads live. */
type SeatUser = { cli: string; seatId?: string; working?: boolean };

/**
 * WHICH seat an agent's turns spend. Its own pin first (note #129), then —
 * for an agent with no pin, or one naming a seat this member no longer holds
 * here — whichever seat of that harness is primary. That is the same rule
 * the lease itself follows (`OrgSeatCredentialSource.listForUser`) and the
 * same one the agent's own screen says out loud in `subscriptionLabel`.
 *
 * The lease's COOLDOWN fallback is deliberately not modelled: a resting seat
 * says it is resting in its own status, and guessing which sibling a lease
 * would hop to would put a live mark on a seat no reader could check.
 */
export function seatForAgent(agent: SeatUser, seats: SeatIdentity[]): string | null {
  const pinned = agent.seatId && seats.some((seat) => seat.seatId === agent.seatId) ? agent.seatId : null;
  return pinned ?? seats.find((seat) => seat.provider === agent.cli && seat.selected)?.seatId ?? null;
}

/**
 * How many of the reader's agents are running a turn on this subscription
 * RIGHT NOW — what the item's active indicator is drawn from (note #326).
 * Counted across every room, because a seat stands above them: an agent in
 * another room spends this subscription just the same.
 */
export function agentsWorkingOnSeat(
  seat: SeatIdentity,
  agents: SeatUser[] | null | undefined,
  seats: SeatIdentity[],
): number {
  return (agents ?? []).filter((agent) => agent.working && seatForAgent(agent, seats) === seat.seatId).length;
}

export interface SeatsEmptyState { title: string; body: string }

/**
 * The zero state of "Your subscriptions". A shelf that exists but is empty has to say
 * what would fill it and who fills it, and here there are two readings of
 * that: a member holding sign-ins in other workplaces is one tap from filling
 * this one and belongs pointed DOWN at their own list, while a member holding
 * none needs to hear what a subscription is for before the door beneath the
 * card means anything.
 */
export function seatsEmptyState(orgName: string, available: number): SeatsEmptyState {
  if (available > 0) {
    return {
      title: 'Nothing assigned here yet',
      body: `${available === 1 ? 'The sign-in you already hold' : `The ${available} sign-ins you already hold`} can work here too — assign one under “Your other sign-ins” below, or sign in a new subscription.`,
    };
  }
  return {
    title: 'Your agents need a subscription',
    body: `Sign in a Claude, ChatGPT or OpenCode subscription and the agents in ${orgName} can start work on it. It stays yours: teammates and admins never see its credentials or usage.`,
  };
}
