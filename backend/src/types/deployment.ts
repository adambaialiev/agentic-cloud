/**
 * A production deployment: one always-on Fly machine serving one user app at
 * `https://<name>.<apps-domain>` (docs/deployments-phase1.md). Distinct from
 * agent sandboxes on every axis that matters — never touched by the idle
 * reaper or recycler, destroyed only by an operator.
 *
 * Hosting has no price and no subscription of its own: per-site purchases
 * became per-plan allowances on 2026-08-16, and the allowances themselves
 * retired with the pricing ladder (org-layer-design). What survives from the
 * paid era is the LIFECYCLE — a site can still be paused with its files
 * kept, and some stored records still carry the paid-era statuses.
 */

export type DeploymentPreset = 'static' | 'service' | 'service-pro';

/** Every preset, for validating what an agent asked for. */
export const DEPLOYMENT_PRESETS: DeploymentPreset[] = ['static', 'service', 'service-pro'];

/**
 * What a plan's hosting allowance counts. Presets are machine sizes; kinds are
 * what the user is actually buying room for, which is why `service-pro` is a
 * `service` here — a bigger machine is not another site.
 */
export type SiteKind = 'static' | 'service';

export function siteKindForPreset(preset: DeploymentPreset): SiteKind {
  return preset === 'static' ? 'static' : 'service';
}

/**
 * How much of each allowance a set of sites uses. Callers pass the records
 * that still hold a slot (everything but `destroyed`) — a paused site is
 * keeping its name and its files, so it is still one of the user's sites.
 */
export function countSitesByKind(
  sites: ReadonlyArray<{ preset: DeploymentPreset }>,
): Record<SiteKind, number> {
  const counts: Record<SiteKind, number> = { static: 0, service: 0 };
  for (const site of sites) counts[siteKindForPreset(site.preset)] += 1;
  return counts;
}

/**
 * The one preset-change on offer: more power for a running service. Static
 * sites don't upgrade (different content model — a bigger static site is a new
 * deployment), and downgrades follow the same rule as plans: nothing shrinks
 * itself. Free since hosting joined the plan — it moves a machine, not a bill.
 */
export const DEPLOYMENT_UPGRADE_PATHS: Partial<Record<DeploymentPreset, DeploymentPreset>> = {
  service: 'service-pro',
};

/**
 * Two of these names are older than the plan-included model and are kept
 * because they are written into every stored record: `pending-payment` now
 * means "name reserved, nothing built yet" (a first deploy passes through it
 * in milliseconds, and a provision that fails rolls back to it), and
 * `payment-lapsed` means "paused, files kept" — reached when the owner's PLAN
 * ends rather than one site's card. Neither has anything left to pay.
 */
export type DeploymentStatus =
  | 'pending-payment' // record exists, nothing provisioned yet
  | 'provisioning'    // infra being created
  | 'live'            // serving
  | 'payment-lapsed'  // paused: machine stopped, data kept, comes back on its own
  | 'stopped'         // operator stop (abuse kill switch)
  | 'destroyed';      // infra gone; record kept as tombstone

export interface DeploymentDocument {
  id: string;
  userId: string;
  /** The workplace that owns this site. Legacy records are backfilled. */
  orgId?: string;
  /**
   * The workplace whose FLY ACCOUNT this app physically lives in, when that is
   * not the workplace that owns the site. Absent on every ordinary record, and
   * absent is what every ordinary record means: the owner hosts its own app.
   *
   * It exists because ownership can move and running infrastructure cannot. A
   * Fly app answers only to the token of the org it was created in (a foreign
   * org's token gets 403), so a site whose `orgId` moved to another workplace
   * would otherwise be stranded — still online, but impossible to redeploy,
   * restart, read logs from or destroy, which is precisely the deadlock that
   * `destroyContextFor` was later added to break. This pin keeps
   * `FlyAppOrgContextResolver` pointed at the account the app is really in.
   *
   * Set only by a deliberate transfer of an EXISTING site. Never consulted
   * when creating anything: what it records is where bytes already are, and a
   * creation path that read it would bill a workplace for another's resources.
   */
  flyOrgId?: string;
  /** The agent that requested the deploy — where fulfilment notices go. */
  agentId: string;
  /** Public subdomain: `<name>.<apps-domain>`. Globally unique. */
  name: string;
  /**
   * Names this deployment used to answer on, oldest first. A rename does not
   * take the old address down — the certificate and the CNAME stay, so every
   * link anyone has already shared keeps serving the same site — and the old
   * name stays reserved to this record for the same reason: released back into
   * a first-come namespace, it would eventually point a stranger's site at
   * links the owner handed out. `getByName` resolves these too, which is what
   * makes both true at once.
   */
  formerNames?: string[];
  preset: DeploymentPreset;
  /** Fly app slug (`iapp-<hex12>`). The public name lives only in DNS. */
  flyApp?: string;
  /**
   * Custom hostnames served beside `<name>.<apps-domain>` (byo-fly-design:
   * a company's own product wants app.theirco.com). Each is a Fly
   * certificate on the site's app; the DNS record pointing here is the
   * OWNER's to create — we only tell them what it must say.
   */
  customDomains?: string[];
  machineId?: string;
  volumeId?: string;
  status: DeploymentStatus;
  /**
   * The site's OWN Paddle subscription, from the era when hosting was sold per
   * site. Nothing writes this on new records — hosting comes with the plan —
   * but sites sold before 2026-08-16 still carry one, and their webhooks still
   * arrive until the operator cancels them, so the linkage stays readable.
   */
  paddle?: {
    subscriptionId?: string;
    priceId?: string;
    /** occurred_at of the newest applied webhook event — the stale-event guard. */
    lastEventAt?: string;
  };
  /**
   * Set when background provisioning (or a resize) is queued; cleared once the
   * user has been told the outcome. Fulfilment runs in-memory after the deploy
   * request is answered, so a restart (every deploy of ours is one) would
   * otherwise kill it silently — a site reserved but never built, with nothing
   * left to retry it. Boot scans for this marker and resumes the job
   * (2026-08-05: a deploy killed hello-world's notice probe 4s before it
   * fired).
   */
  fulfilmentPendingSince?: string;
  /**
   * The preset a queued resize is moving this machine TO. Set beside the
   * marker above and cleared with it, so a restart mid-resize is resumable
   * without asking a billing system what size was paid for — which is what the
   * pre-2026-08-16 code did, and there is no per-site price to read any more.
   */
  pendingPreset?: DeploymentPreset;
  /**
   * An agent has asked the owner to delete this site. Recorded by
   * `agentbuilt delete`, cleared by "Keep it", and gone with the record when
   * the owner goes through with it — the same shape, and the same rule, as a
   * repository's `deleteAsk`: taking a public address down is not an agent
   * verb, so the ask is all an agent can write.
   *
   * Newest wins, one at a time: a second ask before the owner has looked
   * replaces this one rather than queueing behind it.
   */
  deleteAsk?: {
    byAgentId: string;
    /** Owner of the asking agent — the only person who may decide this ask. */
    byUserId?: string;
    at: string;
  };
  createdAt: string;
  lastDeployAt?: string;
  /**
   * Who put the content that is live there now (note #566). A redeploy has
   * no approval gate and is public at once, and since sites became the
   * workplace's any agent in any room can do one — so the site remembers who
   * did the last, for two readers: the `--replace` fence, which stops an
   * agent that merely picked a taken name from silently replacing somebody
   * else's live site, and the person asking "who changed this?". Names are a
   * snapshot from the moment of the deploy, so they outlive a renamed room or
   * a retired agent. Absent until the first deploy after this shipped; the
   * creating {@link agentId} stands in for it.
   */
  lastDeployBy?: {
    agentId: string;
    userId: string;
    agentName?: string;
    /** Published by CI on an approved merge (`agentbuilt repo publish`),
     *  acting as the agent above: which repository, at which commit. */
    ci?: { repo: string; sha: string };
  };
  /**
   * The saved secrets a service runs with (note #661): NAMES only, never a
   * value. `agentbuilt deploy --secret NAME` sets the list and a redeploy
   * without the flag keeps it. Values are read fresh on every deploy from the
   * DEPLOYING agent's own secrets and set as the machine's env, so a deploy
   * can only ever hand a site keys its deployer was already handed.
   */
  secretNames?: string[];
  /**
   * The site's entry in the public app catalogue (note #756,
   * agenticcloudcomputer.com/apps): the one line on what it does and the
   * picture, written by the agent that deploys it. Every deployed site is
   * listed by default (the owner, 2026-10-15); the maker opts out by asking
   * their agent to `unlist` it. Absent on records from before the
   * catalogue: such a site is listed the moment a line is written for it.
   * What the catalogue actually shows is decided by {@link siteIsListed}.
   */
  listing?: SiteListing;
  lapsedAt?: string;
  destroyedAt?: string;
}

export interface SiteListing {
  /** One line on what the app does, as the catalogue shows it. */
  line?: string;
  /**
   * `false` once an agent ran `agentbuilt unlist`; `relist` sets it back.
   * Absent means listed — the default, so nothing has to be written for
   * the ordinary site to appear.
   */
  listed?: boolean;
  /** The screenshot, taken by the deploying agent's machine once the site
   *  answered; retaken on every redeploy. */
  picture?: {
    storagePath: string;
    sizeBytes: number;
    takenAt: string;
  };
  /**
   * An operator took it out of the catalogue (moderation, note #756): the
   * only hand that is not the workplace's own, and set by the operator on
   * the backend host, never by a route. Reserved; nothing writes it yet.
   */
  hiddenByOperator?: boolean;
  /** When the line was last written, and by which agent. */
  updatedAt?: string;
  updatedByAgentId?: string;
}

/** A catalogue line is one line: no line breaks, at most this long. */
export const SITE_LISTING_LINE_MAX = 160;

/**
 * The line as the catalogue stores it, or why it cannot be one. One
 * sentence on what the app does — the maker reads it beside the name and
 * the picture, so a line break or an essay is refused rather than cropped.
 */
export function validateSiteListingLine(raw: string): { ok: true; line: string } | { ok: false; error: string } {
  const line = raw.replace(/\s+/g, ' ').trim();
  if (!line) return { ok: false, error: 'The catalogue line is empty. Say in one sentence what the app does, for a stranger reading the catalogue.' };
  if (line.length > SITE_LISTING_LINE_MAX) {
    return { ok: false, error: `The catalogue line is ${line.length} characters; the catalogue shows at most ${SITE_LISTING_LINE_MAX}. One sentence on what the app does.` };
  }
  return { ok: true, line };
}

/**
 * Whether a site stands in the public catalogue right now: serving, with a
 * line to show, not unlisted by its workplace and not hidden by an
 * operator. A site that is paused, stopped or deleted leaves the catalogue
 * with its status and returns with it — the catalogue never shows a link
 * that does not work.
 */
export function siteIsListed(doc: Pick<DeploymentDocument, 'status' | 'listing'>): boolean {
  return doc.status === 'live'
    && Boolean(doc.listing?.line)
    && doc.listing?.listed !== false
    && doc.listing?.hiddenByOperator !== true;
}

/** `ember-coffee`, not `-x`, `a`, or `login`. 3–42 chars total. */
export const DEPLOYMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;

/**
 * Names that read as an official or credential-harvesting surface on the apps
 * domain. Matched as whole name or hyphen-separated token, so `login`,
 * `my-login` and `login-page` are all refused.
 */
export const DEPLOYMENT_NAME_DENYLIST = [
  'login', 'signin', 'sign-in', 'auth', 'verify', 'wallet', 'bank',
  'support', 'admin', 'account', 'billing', 'password', 'secure',
  'agentbuilt', 'agenticcloud', 'agentic-cloud-computer', 'www', 'api',
] as const;

/**
 * Whole names the platform's own hosts answer on, beside every site: the code
 * host (git.agentbuilt.app today, git.<domain> in a private copy) and a copy's
 * mail (note #804). An explicit DNS record beats the wildcard, so a site by
 * one of these names would never be reached. Whole names only: `git-stats` is
 * a fine site.
 */
export const DEPLOYMENT_NAME_RESERVED = ['git', 'mail'] as const;

export function validateDeploymentName(name: string): string | null {
  if (!DEPLOYMENT_NAME_PATTERN.test(name)) {
    return 'Names are 3–42 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit.';
  }
  if ((DEPLOYMENT_NAME_RESERVED as readonly string[]).includes(name)) {
    return `"${name}" is the platform's own address. Choose another name.`;
  }
  const tokens = name.split('-');
  for (const banned of DEPLOYMENT_NAME_DENYLIST) {
    if (name === banned || tokens.includes(banned)) {
      return `"${banned}" is not allowed in app names.`;
    }
  }
  return null;
}
