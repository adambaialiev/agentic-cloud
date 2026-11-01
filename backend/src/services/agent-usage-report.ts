import type { OrgSeatDocument } from '../types/org.js';
import type { ProviderUsageWindow } from '../types/user.js';
import { seatNoReadingNotice } from '../shared/harness-clis.js';
import {
  TOKEN_WEEKS_SHOWN,
  tokenWeeksByAgent,
  tokenWeeksSince,
  type AgentTokenLedger,
  type TokenCounts,
  type TokenProvider,
  type TokenWeekByAgent,
} from './agent-token-ledger.js';
import { formatUsagePlan, formatUsageReset, sortUsageWindows } from './agent-service.js';
import { seatWindowReading } from './workspace-seat-usage.js';

/**
 * `agentbuilt usage` (note #719): the owner's subscription usage, read by
 * one of their own agents. Two halves, both the owner's and nobody else's:
 *
 * - the tokens their agents spent, week by week, per provider and model and
 *   split by agent — the token ledger (agent-token-ledger.ts), the same rows
 *   the Subscriptions screen folds without the agents;
 * - their subscriptions' limits — each seat's plan, its usage windows with
 *   the share used and the reset, as the seats read describes them — where
 *   the platform has a reading.
 *
 * Every agent turn runs on its owner's own subscription, so the figures are
 * the owner's; the credential names the owner, and an agent asking is their
 * agent. That is why a ROOM agent reads it as well as the Workspace Agent:
 * "how much of my plan did you burn" deserves an answer from the ledger
 * rather than a guess, and nothing here crosses owners. A teammate's usage
 * never appears, for an admin's agent either — the ledger page's rule.
 *
 * A seat's token (the credential itself) never enters this projection: the
 * answer is built from named fields, never by spreading the document.
 */

/** How many weeks the CLI shows unless asked for more, this one included. */
export const USAGE_WEEKS_DEFAULT = 4;

export interface AgentUsageWindow {
  label: string;
  usedPercent: number;
  percentText: string;
  /** ISO instant of the next reset, when the provider says. */
  resetAt?: string;
  /** The same reset as words, in UTC. */
  resetsText?: string;
  /** A spend cap (extra usage), not a window that stops a turn. */
  spend?: true;
  /** "$12.00 of $80.00" for the spend cap, when the seat's grant can read amounts. */
  detailText?: string;
}

export interface AgentUsagePlan {
  provider: TokenProvider;
  /** The owner's own name for the subscription. */
  label: string;
  /** "Max 20x", "Plus" — when the plan has been read. */
  planText?: string;
  status: OrgSeatDocument['status'];
  /** Assigned to the asking agent's workplace (its turns may run on it). */
  inThisWorkplace: boolean;
  /** The owner's first pick among their same-provider seats here. */
  primary: boolean;
  windows: AgentUsageWindow[];
  /** When the reading was taken. */
  usageRefreshedAt?: string;
  /** Why there are no windows, when there are none. */
  usageNotice?: string;
}

export interface AgentUsageAgent extends TokenCounts {
  agentId: string;
  name: string;
  /** No record of it any more — the spend still happened. */
  deleted?: true;
  /** Lives in another workplace of the owner's. */
  elsewhere?: true;
}

export interface AgentUsageWeek {
  start: string;
  providers: Array<TokenCounts & {
    provider: TokenProvider;
    models: Array<TokenCounts & { model: string; agents: AgentUsageAgent[] }>;
  }>;
}

export interface AgentUsageAnswer {
  /** The first day the weeks reach back to (a Monday, UTC). */
  since: string;
  weeks: AgentUsageWeek[];
  plans: AgentUsagePlan[];
}

export interface AgentUsageInputs {
  ledger: AgentTokenLedger | undefined;
  userId: string;
  /** The asking agent's workplace; null on a legacy org-less record. */
  orgId: string | null;
  /** The owner's seats assigned to that workplace, as the seats read lists them. */
  seatsHere: OrgSeatDocument[];
  /** Every seat the owner holds, those included. */
  seatsAll: OrgSeatDocument[];
  /** The owner's live agent records: name and workplace, by id. */
  agents: Record<string, { name?: string; orgId?: string }>;
  weeks: number;
  now: number;
}

/** `?weeks=` as the route reads it: a whole number from 1 to the screen's reach. */
export function usageWeeksRequested(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return USAGE_WEEKS_DEFAULT;
  return Math.min(TOKEN_WEEKS_SHOWN, Math.max(1, parsed));
}

function describePlan(seat: OrgSeatDocument, here: boolean): AgentUsagePlan {
  const spend = seat.usage?.spend;
  const minor = (value: number) => {
    const amount = (value / 10 ** spend!.exponent).toFixed(spend!.exponent);
    return spend!.currency === 'USD' ? `$${amount}` : `${amount} ${spend!.currency}`;
  };
  const spendText = spend ? `${minor(spend.usedMinor)} of ${minor(spend.limitMinor)}` : null;
  const all: ProviderUsageWindow[] = seat.usage
    ? [...Object.values(seat.usage.windows), ...Object.values(seat.modelWindows ?? {})]
    : [];
  const gating = all.filter((window) => window.id !== 'overage');
  return {
    provider: seat.provider,
    label: seat.label,
    ...(seat.usage?.planType ? { planText: formatUsagePlan(seat.usage.planType) } : {}),
    status: seat.status,
    inThisWorkplace: here,
    primary: here && seat.selected,
    windows: sortUsageWindows(all).map((window) => {
      const reading = seatWindowReading(window, gating);
      return {
        label: reading.label,
        usedPercent: reading.usedPercent,
        percentText: reading.percentText,
        ...(reading.resetAt ? { resetAt: reading.resetAt } : {}),
        ...(window.resetsAt ? { resetsText: formatUsageReset(window.resetsAt) } : {}),
        ...(window.id === 'overage' ? { spend: true as const } : {}),
        ...(window.id === 'overage' && spendText ? { detailText: spendText } : {}),
      };
    }),
    ...(seat.usageRefreshedAt ? { usageRefreshedAt: seat.usageRefreshedAt } : {}),
    ...(seat.usage
      ? {}
      : {
        usageNotice: seatNoReadingNotice(seat.provider),
      }),
  };
}

export function agentUsageReport(inputs: AgentUsageInputs): AgentUsageAnswer {
  const since = tokenWeeksSince(inputs.now, inputs.weeks);
  const rows = inputs.ledger?.userAgentDays(inputs.userId, since) ?? [];
  const weeks: AgentUsageWeek[] = tokenWeeksByAgent(rows).map((week: TokenWeekByAgent) => ({
    start: week.start,
    providers: week.providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        agents: model.agents.map(({ orgId, name, ...agent }) => {
          const live = inputs.agents[agent.agentId];
          const elsewhere = Boolean(inputs.orgId) && (live?.orgId ?? orgId) !== null && (live?.orgId ?? orgId) !== inputs.orgId;
          return {
            ...agent,
            name: live?.name || name,
            ...(live ? {} : { deleted: true as const }),
            ...(elsewhere ? { elsewhere: true as const } : {}),
          };
        }),
      })),
    })),
  }));
  const hereIds = new Set(inputs.seatsHere.map((seat) => seat.seatId));
  const order: TokenProvider[] = ['claude', 'codex', 'opencode'];
  const plans = [
    ...inputs.seatsHere.map((seat) => describePlan(seat, true)),
    ...inputs.seatsAll.filter((seat) => !hereIds.has(seat.seatId)).map((seat) => describePlan(seat, false)),
  ].sort((a, b) => Number(b.inThisWorkplace) - Number(a.inThisWorkplace)
    || order.indexOf(a.provider) - order.indexOf(b.provider)
    || Number(b.primary) - Number(a.primary));
  return { since, weeks, plans };
}
