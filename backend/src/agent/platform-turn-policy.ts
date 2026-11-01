/**
 * Model-lane naming and the shared refusal copy.
 *
 * This file (as platform-usage-metering.ts) used to be the per-user metering:
 * hourly spend buckets, measured window budgets, and the pre-turn gate that
 * enforced them. All of that went with the dedicated-credential model
 * (2026-08-19, see docs/dedicated-credentials-and-limbo.md) — a user's limits
 * are their own subscription's windows, limbo is deliberately unmetered, and
 * the pool tracks no dollars at all: it is a donor of turns to the admin
 * account and to limbo, not a budget anyone reconciles. What remains is the
 * policy more than one harness shares: which model belongs to the Fable lane,
 * and the refusal messages.
 */

import { catalogModelName } from '../shared/model-catalog.js';

/** "in a moment" / "within N hours" — shared by every refusal that names a reset. */
export function formatResetHint(resetAt: Date, now: Date): string {
  const minutes = Math.ceil((resetAt.getTime() - now.getTime()) / 60_000);
  if (minutes <= 1) return 'in a moment';
  if (minutes < 60) return `within ${Math.ceil(minutes / 5) * 5} minutes`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return hours === 1 ? 'within an hour' : `within ${hours} hours`;
  const days = Math.ceil(hours / 24);
  return days === 1 ? 'within a day' : `within ${days} days`;
}

/**
 * The refusal for a turn with no seat behind it (org-layer-design: turns run
 * on the owner's own seats, and "not a customer" is now simply "owner has no
 * live seat"). On Telegram the harness routes this case through
 * `onHarnessAuthFailure({reason: 'no_seat'})` instead — the seat sign-in
 * door, which pauses the owner's agents and walks them into the ceremony —
 * so this message survives only as the hookless fallback: it states the
 * situation, promises nothing is lost, and stops.
 */
export const NO_SEAT_MESSAGE = [
  "I can't pick up work yet: no subscription is signed in for this account.",
  'Everything of yours is still here — your machine, your files and this conversation —',
  'and I carry straight on from where we stopped as soon as a subscription is signed in.',
].join(' ');

/** A provider paused a still-valid subscription, not the sign-in itself. */
export function paymentRequiredMessage(provider: 'Claude' | 'ChatGPT' | 'OpenCode'): string {
  return `${provider} has paused this subscription because the provider account needs attention. `
    + `Restore access in ${provider} settings, then send your message again. `
    + 'The sign-in is still valid and nothing is lost.';
}

/**
 * One model is out on the member's subscription while the rest of it still
 * runs (note #772): a model's own weekly window, or a model the plan only
 * runs on usage credits. Waiting is one way on; the other is a model the
 * subscription still serves, which is one tap on the agent's screen — the
 * member must be told both, or they wait days for a reset they never needed.
 */
export function modelLimitMessage(model: string, resetAt?: Date, now: Date = new Date()): string {
  const name = catalogModelName(model) ?? model.charAt(0).toUpperCase() + model.slice(1);
  const when = resetAt && resetAt.getTime() > now.getTime()
    ? `it frees up ${formatResetHint(resetAt, now)}`
    : 'it frees up on its own later';
  return `${name} is used up on your subscription for now — ${when}. Every other model still runs: `
    + 'pick another one under "Thinks with" on this agent\'s screen and send your message again.';
}

/**
 * A user's own subscription (dedicated credential or org seat) is out of
 * window. Deliberately the same honest answer the providers give their own
 * subscribers — wait for the reset — and never a quiet hop onto shared
 * capacity. Provider-neutral: both harnesses send it.
 */
export function dedicatedLimitMessage(resetAt?: Date, now: Date = new Date()): string {
  return resetAt && resetAt.getTime() > now.getTime()
    ? `Your subscription has hit its usage limit. It resets ${formatResetHint(resetAt, now)} — send your message again after that.`
    : 'Your subscription has hit its usage limit. It frees up on its own — send your message again in a little while.';
}
