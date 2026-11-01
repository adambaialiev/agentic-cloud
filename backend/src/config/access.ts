import type { UserProfileDocument } from '../types/user.js';

/**
 * Who may do what, after the pricing ladder (config/plans.ts) retired with
 * the org pivot (org-layer-design). There are no rungs left to encode: turn
 * admission is "the owner has a live seat" and lives in the lease path;
 * what models a seat may run is the seat's own subscription's business; and
 * hosting rides the account until deploys move into the client's Fly org
 * (workstream 3). What remains here is the operator role and the deployment
 * backstop.
 */

/**
 * Admin accounts (roles.admin) are exempt from the outsider creation gate and
 * idle recycling.
 */
export function isAdminAccount(
  profile: Pick<UserProfileDocument, 'roles'> | null | undefined,
): boolean {
  return profile?.roles?.admin === true;
}

/**
 * Active deployments one ORG may run, same reasoning: every site is an
 * always-on machine on the client's bill. Sits beside the per-user
 * MAX_ACTIVE_DEPLOYMENTS_PER_USER backstop, which guards abuse rather than
 * spend.
 */
export const ORG_DEPLOYMENT_LIMIT = Number(process.env.ORG_DEPLOYMENT_LIMIT ?? 50);

/**
 * The two ceilings of a HOSTED workplace (note #664): one with no cloud of
 * its own, whose agents and sites run on the platform's Fly account at our
 * expense. The owner set them on 2026-09-25 — "overall limits should be 20
 * agents. 10 sites" — for the whole workplace, across all its members, and
 * raised the sites to 30 on 2026-10-17 (note #771) once a site no longer cost
 * a DNS record (note #766). A workplace on its own cloud pays its own bill
 * and keeps the ceilings above instead. Env-overridable like the rest.
 */
export const HOSTED_AGENT_LIMIT = Number(process.env.HOSTED_AGENT_LIMIT ?? 20);
export const HOSTED_SITE_LIMIT = Number(process.env.HOSTED_SITE_LIMIT ?? 30);

/**
 * Object storage for a HOSTED workplace (note #768): how many buckets it may
 * hold, and how much each may grow to, since the bill is ours. The per-bucket
 * size is REPORTED against, not enforced at the store (Tigris has no quota
 * to set): `agentbuilt storage show` says where a bucket stands, and a
 * bucket past it is the operator's conversation with the owner. Both
 * env-overridable; a workplace on its own cloud has neither.
 */
export const HOSTED_BUCKET_LIMIT = Number(process.env.HOSTED_BUCKET_LIMIT ?? 3);
export const HOSTED_BUCKET_GB = Number(process.env.HOSTED_BUCKET_GB ?? 10);

/**
 * Agent-capacity check for the creation paths.
 *
 * Org members are uncapped here: the flat per-member cap of 20 retired with
 * the per-agent Telegram bots (inhouse-chat-design) — BotFather's 20-bot
 * ceiling was the number's real source — and the later 25-machine org
 * guardrail was removed too. A workplace on its own cloud owns its bill and
 * controls its roster; a hosted one is held to HOSTED_AGENT_LIMIT across the
 * whole workplace, by the creation gate in agent-service.
 * Strangers still get zero: an agent always belongs to a workplace.
 *
 * `limit` is Infinity on every uncapped account — screens render that as a
 * bare count instead of "n of Infinity".
 */
export function agentCapacity(
  profile: Pick<UserProfileDocument, 'telegram' | 'roles'> | null | undefined,
  isOrgMember: boolean,
): { used: number; limit: number; atCapacity: boolean } {
  const limit = isAdminAccount(profile) || isOrgMember ? Infinity : 0;
  const used = Object.values(profile?.telegram?.agents ?? {}).length;
  return { used, limit, atCapacity: used >= limit };
}
