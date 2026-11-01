import { FlyClient } from './fly-client.js';
import { flyBillingFixUrl, flyBillingProblem } from './fly-billing.js';
import type { OrgStorage } from './org-storage.js';
import type { OrgSecretsService } from './org-secrets.js';

/**
 * The org → Fly binding (byo-fly-design): which Fly organization an org's
 * machines and deploys land in, and the token that authorizes it.
 *
 * Two verbs. CONNECT validates an offered org token before anything commits —
 * a typo fails at paste time, not at first agent creation — then stores the
 * token as an org secret and writes the pointer (`OrgDocument.fly`) that
 * every later resolution reads. RESOLVE answers "which Fly context does this
 * org act in": the org's own explicitly connected account, or a loud refusal.
 *
 * HOSTED WORKPLACES (note #664, the owner, 2026-09-25: "we should not require
 * fly cloud token. we should run user's cloud on our fly account"). A
 * workplace with no `fly` pointer is no longer stuck at a token form: its
 * agents and sites run in the PLATFORM's Fly account, which we pay for.
 * That is its own verb, `resolveHostingContext`, used only where machines
 * and sites are built and driven (the app→org resolver). `resolveOrgFlyContext`
 * keeps answering the narrower question "the workplace's OWN account", and
 * still refuses a workplace without one — so the consumers that act in a
 * customer's account on the customer's behalf (their git host and backups,
 * their media bucket, their CI machines, the spending walk over their whole
 * account) can never be pointed at ours by accident.
 *
 * The hard edge that remains: a connected pointer whose token has gone
 * missing never falls back, in either verb. That workplace's machines are in
 * ITS account; building a fresh one in ours would split it across two clouds
 * and two bills without anybody deciding it.
 *
 * A SECOND CONNECT IS TWO DIFFERENT ACTS, and note #372 ("I should be able to
 * replace my cloud … so replace the fly token key") is the surface that made
 * telling them apart necessary:
 *
 *  ROTATION  the new token resolves to the Fly org already connected. Nothing
 *            moves — same account, same machines, same private network — so it
 *            commits on the one paste, and the WireGuard peer is carried over
 *            untouched rather than re-minted under live SSH sessions.
 *  A MOVE    the new token resolves to a DIFFERENT Fly org. Everything already
 *            running stays in the old account, billing there, and out of this
 *            platform's reach the moment the pointer moves — so it is refused
 *            until the caller says `replace`, and the refusal is a QUESTION
 *            (`{ connected: false, move }`) rather than an error, because the
 *            only way to learn the destination is to validate the token, and
 *            the admin deserves to be asked about the org Fly actually named.
 *            The peer goes with the account it was minted in.
 */

/** Where a connected org's token lives in the org-secret namespace. */
export const ORG_FLY_TOKEN_SECRET_NAME = 'FLY_ORG_TOKEN';

export interface OrgFlyContext {
  /** Always the organization's explicitly connected Fly account. */
  source: 'org';
  orgSlug: string;
  apiToken: string;
}

/** The platform's own Fly account, where hosted workplaces run (note #664). */
export interface PlatformFlyContext {
  source: 'platform';
  orgSlug: string;
  apiToken: string;
}

/** Where a workplace's machines and sites are built: its own connected
 *  account, or ours when it has none. */
export type HostingFlyContext = OrgFlyContext | PlatformFlyContext;

export class OrgFlyError extends Error {}

/** Committed: the org now points at `orgSlug`. `moved` is the second act
 *  above — a different Fly org than the one that was connected before. */
export interface OrgFlyConnected {
  connected: true;
  orgSlug: string;
  /** Apps the token could see — proof of life for the caller to show. */
  appCount: number;
  /** The Fly org this replaced, when there was one. */
  previousSlug?: string;
  moved: boolean;
}

/** Not committed: the token is good and points somewhere else. Nothing was
 *  written — the caller confirms with `replace` and asks again. */
export interface OrgFlyMoveAsked {
  connected: false;
  move: {
    fromSlug: string;
    toSlug: string;
    appCount: number;
    /**
     * What the organization would leave behind, from its OWN record.
     *
     * Machines are the visible half and the caller can count those itself.
     * These are the half nobody has on screen: the org's git host is an app
     * and a volume in `fromSlug` holding every repository, its backup bucket
     * and its attachment bucket are Fly extensions on that same account, and
     * all three are reached through the token and the peer this move
     * re-points. Unsaid, a move reads as "my machines stay behind" when it
     * also means the repositories go dark.
     */
    leaves: { gitHost: boolean; gitBackup: boolean; media: boolean };
  };
}

export type OrgFlyConnectResult = OrgFlyConnected | OrgFlyMoveAsked;

export interface OrgFlyServiceDeps {
  orgStorage: Pick<OrgStorage, 'getOrg' | 'updateOrg'>;
  orgSecrets: Pick<OrgSecretsService, 'setOrgSecret' | 'getOrgSecret'>;
  /** Injectable for tests; defaults to a real FlyClient on the offered token. */
  makeFlyClient?: (apiToken: string) => Pick<FlyClient, 'listApps' | 'listOrganizations'>
    & Partial<Pick<FlyClient, 'getOrganizationBilling'>>;
  /**
   * The platform's own Fly account (`FLY_ORG` + `FLY_API_TOKEN`), where a
   * workplace with no cloud of its own is hosted. Absent when the backend
   * runs without Fly, and then a hosted workplace simply cannot build
   * machines — exactly as before.
   */
  platform?: { orgSlug: string; apiToken: string };
}

export class OrgFlyService {
  constructor(private readonly deps: OrgFlyServiceDeps) {}

  /**
   * Validate an offered (slug, token) pair against Fly itself, then commit:
   * token into the org-secret store, pointer onto the org document. Returns
   * the validated slug and the app count the token could see — proof of life
   * for the caller to show, never the token.
   *
   * `replace` is consent to a MOVE, and only to a move: without it a token
   * resolving to a different Fly org comes back as the question above with
   * nothing written. A first connect and a rotation never need it.
   *
   * It is the SLUG that was agreed to rather than a bare yes, because a bare
   * yes has no object. The question is answered against a resolution made a
   * moment earlier, and the same token can resolve differently the second
   * time — a token whose visibility changed in between now sees two orgs, or
   * one it did not see before. `replace: 'other-co'` consents to moving to
   * other-co and to nothing else; anything else refuses with nothing written.
   */
  async connectOrgFly(args: {
    orgId: string;
    orgSlug?: string;
    token: string;
    replace?: string;
  }): Promise<OrgFlyConnectResult> {
    const orgId = args.orgId.trim();
    // Optional DISAMBIGUATION HINT only (operator scripts pass it): the form
    // stopped asking for a name entirely — Fly de-duplicates org names
    // silently (the dashboard says "big-bang", the real name is
    // "big-bang-988"), so a typed name dead-ends good tokens. The token is
    // the authority on where it works; we ask IT.
    const offeredName = (args.orgSlug ?? '').trim();
    const token = args.token.trim();
    if (!orgId || !token) {
      throw new OrgFlyError('connecting a Fly org needs an orgId and a token');
    }
    const org = await this.deps.orgStorage.getOrg(orgId);
    if (!org) {
      throw new OrgFlyError(`org ${orgId} does not exist`);
    }
    const fly = (this.deps.makeFlyClient ?? ((apiToken: string) => new FlyClient(apiToken)))(token);
    let visible: Array<{ slug: string; name: string }>;
    try {
      visible = await fly.listOrganizations();
    } catch (error) {
      throw new OrgFlyError(
        'Fly did not accept that token — is it an "Org deploy token" from your organization\'s Tokens page?'
        + ` (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const target = visible.length === 1
      ? visible[0]
      : visible.find((candidate) => offeredName !== ''
        && (candidate.slug === offeredName || candidate.name.trim().toLowerCase() === offeredName.toLowerCase()));
    if (!target) {
      throw new OrgFlyError(
        visible.length === 0
          ? 'that token cannot see any Fly organization — create an "Org deploy token" inside the organization you want to connect'
          : `that token can see several Fly organizations (${visible.map((candidate) => `"${candidate.slug}"`).join(', ')}) `
            + '— create an "Org deploy token" scoped to just the one you want, and paste that instead',
      );
    }
    const resolvedSlug = target.slug;
    let appCount: number;
    try {
      appCount = (await fly.listApps(resolvedSlug)).length;
    } catch (error) {
      throw new OrgFlyError(
        `the token belongs to Fly org "${resolvedSlug}" but could not list its apps — it may lack deploy access`
        + ` (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    // Asked AFTER the token has fully proved itself: a question about moving
    // to an org whose apps this token cannot list is a question about a move
    // that would then fail, and the admin would have answered it for nothing.
    const previous = org.fly;
    const moved = Boolean(previous) && previous!.orgSlug !== resolvedSlug;
    const agreedTo = (args.replace ?? '').trim();
    if (previous && moved && agreedTo === '') {
      return {
        connected: false,
        move: {
          fromSlug: previous.orgSlug,
          toSlug: resolvedSlug,
          appCount,
          leaves: {
            gitHost: Boolean(org.git?.host),
            gitBackup: Boolean(org.git?.backup),
            media: Boolean(org.media),
          },
        },
      };
    }
    if (previous && moved && agreedTo !== resolvedSlug) {
      throw new OrgFlyError(
        `that token now points at Fly org "${resolvedSlug}", not the "${agreedTo}" you agreed to move to`
        + ' — nothing has been changed. Check the token and try again.',
      );
    }
    // The card check (note #801), for a first connect and a move — the two
    // that are about to build in an account nothing of ours has run in yet.
    // Fly refuses every machine in an organization whose billing is not in
    // order, so refusing here is the difference between a plain sentence now
    // and a generic failure on the first agent. A rotation stays the same
    // account with the same bill; refusing it would only keep an old token.
    // An unreadable status connects anyway: the 422 still speaks for itself
    // if Fly refuses later, and a schema change must not lock everyone out.
    if ((!previous || moved) && fly.getOrganizationBilling) {
      let problem: string | null = null;
      try {
        problem = flyBillingProblem(await fly.getOrganizationBilling(resolvedSlug), resolvedSlug);
      } catch (error) {
        console.warn(`[org-fly] could not read billing for Fly org "${resolvedSlug}"; connecting anyway`, error);
      }
      if (problem) throw new OrgFlyError(problem);
    }
    // Secret before pointer: a pointer whose secret is missing refuses to
    // resolve (below), so this order can crash mid-way without ever leaving
    // the org silently resolving to the platform context.
    await this.deps.orgSecrets.setOrgSecret(
      orgId,
      ORG_FLY_TOKEN_SECRET_NAME,
      token,
      `Fly org token for ${resolvedSlug} — authorizes machines and deploys in the org's own Fly account`,
    );
    // `updateOrg` replaces `fly` whole, so what is not carried here is
    // dropped — and the peer is the one thing in it that a re-connect must
    // decide about rather than lose by accident. On a ROTATION it is still
    // exactly right: same Fly account, same 6PN network, same key, and
    // re-minting it would flap a tunnel other machines' SSH is riding
    // (`ensureUpIfMissing` exists for that reason). On a MOVE it is a
    // registration in an account we are about to stop being able to reach, so
    // it goes and the next ensure mints one in the new account. The old peer
    // is left registered there deliberately: we only learn a move is
    // happening by validating the new token, and tearing the live tunnel down
    // before the new account is proven would risk leaving the org with no
    // cloud at all. It routes nowhere once our interface is reconfigured, and
    // the account it sits in is the customer's own.
    await this.deps.orgStorage.updateOrg(orgId, {
      fly: {
        orgSlug: resolvedSlug,
        tokenSecretName: ORG_FLY_TOKEN_SECRET_NAME,
        ...(previous?.wireguard && !moved ? { wireguard: previous.wireguard } : {}),
      },
    });
    return {
      connected: true,
      orgSlug: resolvedSlug,
      appCount,
      ...(previous ? { previousSlug: previous.orgSlug } : {}),
      moved,
    };
  }

  /**
   * Where this workplace's machines and sites are built (note #664): its own
   * connected account when it has one — with the same refusal as below when
   * that account's token is missing — and otherwise the platform's.
   */
  async resolveHostingContext(orgId: string): Promise<HostingFlyContext> {
    const org = await this.deps.orgStorage.getOrg(orgId.trim());
    if (!org) {
      throw new OrgFlyError(`org ${orgId} does not exist`);
    }
    if (org.fly) return this.resolveOrgFlyContext(org.orgId);
    const platform = this.deps.platform;
    if (!platform?.orgSlug || !platform.apiToken) {
      throw new OrgFlyError(`org ${org.orgId} has no Fly org of its own and this backend has no platform Fly account to host it`);
    }
    return { source: 'platform', orgSlug: platform.orgSlug, apiToken: platform.apiToken };
  }

  /**
   * What stops Fly building in this workplace's own account right now, in
   * plain words, or null (note #801) — the red line on its Cloud card, read
   * live because a card can lapse long after the connect-time check passed.
   * Throws when the account cannot be asked; the caller then says nothing.
   */
  async billingProblem(orgId: string): Promise<{ problem: string; fixUrl: string } | null> {
    const context = await this.resolveOrgFlyContext(orgId);
    const fly = (this.deps.makeFlyClient ?? ((apiToken: string) => new FlyClient(apiToken)))(context.apiToken);
    if (!fly.getOrganizationBilling) return null;
    const problem = flyBillingProblem(await fly.getOrganizationBilling(context.orgSlug), context.orgSlug);
    return problem ? { problem, fixUrl: flyBillingFixUrl(context.orgSlug) } : null;
  }

  /** The Fly context this org acts in. See the module doc for the hard edge. */
  async resolveOrgFlyContext(orgId: string): Promise<OrgFlyContext> {
    const org = await this.deps.orgStorage.getOrg(orgId.trim());
    if (!org) {
      throw new OrgFlyError(`org ${orgId} does not exist`);
    }
    if (org.fly) {
      const secretName = org.fly.tokenSecretName ?? ORG_FLY_TOKEN_SECRET_NAME;
      const apiToken = await this.deps.orgSecrets.getOrgSecret(org.orgId, secretName);
      if (!apiToken) {
        // NO platform fallback here, ever — see the module doc.
        throw new OrgFlyError(
          `org ${org.orgId} points at Fly org "${org.fly.orgSlug}" but its token secret `
          + `"${secretName}" is missing — re-connect the Fly org to restore it`,
        );
      }
      return { source: 'org', orgSlug: org.fly.orgSlug, apiToken };
    }
    throw new OrgFlyError(
      `org ${org.orgId} has no Fly org connected — connect and validate its Fly token before creating Fly resources`,
    );
  }
}
