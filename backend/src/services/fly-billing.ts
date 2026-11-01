/**
 * Whether Fly will build in a workplace's own Fly organization, and what to
 * tell a person when it will not (note #801).
 *
 * Fly refuses to create or change anything in an organization whose billing
 * is not in order, with a 422 "We require your billing information, please
 * add it at https://fly.io/dashboard/<org>/billing". Machines it already runs
 * keep running, which is why the failure shows up late and somewhere else: on
 * 23 Oct 2026 acme-trading took every new machine, image roll and resize
 * that way. Its organization HAS a card saved — Fly's GraphQL said
 * `billingStatus: PAST_DUE, isCreditCardSaved: true` — so "is there a card"
 * is the wrong question; the status is the one Fly acts on.
 *
 * The statuses, as Fly's schema had them on 26 Oct 2026: CURRENT,
 * SOURCE_REQUIRED, PAST_DUE, DELINQUENT, TRIAL_ACTIVE, TRIAL_ENDED,
 * SUSPENDED. An organization billed by invoice can be CURRENT with no card,
 * so a missing card alone is only a problem on a trial.
 */

export interface FlyOrganizationBilling {
  billingStatus: string;
  isCreditCardSaved: boolean;
}

/** Where the organization's owner puts it right. */
export function flyBillingFixUrl(orgSlug: string): string {
  return `https://fly.io/dashboard/${encodeURIComponent(orgSlug)}/billing`;
}

/**
 * Plain words for what stops Fly building in this organization, or null when
 * nothing does. A status this code does not know is not a refusal it can
 * stand behind, so it answers null and leaves the 422 (below) to speak if
 * Fly does refuse.
 */
export function flyBillingProblem(billing: FlyOrganizationBilling, orgSlug: string): string | null {
  const where = `your Fly organization "${orgSlug}"`;
  const fix = flyBillingFixUrl(orgSlug);
  switch (billing.billingStatus) {
    case 'CURRENT':
      return null;
    case 'TRIAL_ACTIVE':
      return billing.isCreditCardSaved
        ? null
        : `Add a card to ${where} first (${fix}). On a trial without one, Fly limits and stops machines.`;
    case 'SOURCE_REQUIRED':
    case 'TRIAL_ENDED':
      return `Add a card to ${where} first (${fix}). Fly builds nothing in an organization without one.`;
    case 'PAST_DUE':
    case 'DELINQUENT':
      return `Fly says the bill for ${where} is past due. Settle it at ${fix} first; until then Fly refuses to build or change machines there.`;
    case 'SUSPENDED':
      return `Fly has suspended ${where}. Sort it out with Fly (${fix}) first.`;
    default:
      return null;
  }
}

/** The organization slug inside Fly's own refusal, when it names one. */
export function flyBillingUrlFrom(message: string): string | undefined {
  return message.match(/https:\/\/fly\.io\/dashboard\/[^\s"'),]+\/billing/)?.[0];
}

/**
 * What a person is told when Fly refuses with the 422, wherever it happens:
 * building an agent, rebuilding one, deploying a site, moving a machine to
 * another size.
 */
export function flyBillingRefusalWords(fixUrl: string | undefined): string {
  return 'The Fly account this workplace runs on needs its billing sorted before anything can be built or changed. '
    + `Whoever owns it should ${fixUrl ? `open ${fixUrl}` : 'open its Billing page in the Fly dashboard'} and add or update the card.`;
}
