/**
 * The workplace layer (knowledge: org-layer-design, approved 2026-08-22).
 *
 * Humans may be MEMBERS of several orgs. They sign in to their own
 * Claude/Codex subscriptions as private SEATS, bring their current seats into
 * a workplace on first entry, and create agents permanently pinned to one org. A
 * seat may serve that owner's agents in several orgs at once, but credentials
 * and usage are never exposed to another member. What an org shares is the
 * workplace: repos, knowledge, notes, sites, org secrets, and its Fly org.
 *
 * Greenfield: these documents replace the single-owner workspace model rather
 * than wrapping it. The admin profile becomes org #0 via a run-once bootstrap
 * and every other org is born on this schema.
 */

/**
 * v1 keeps two roles. Admin: invite/remove members, org secrets, shared
 * infrastructure and spend. Member: their own agents and seats, and the
 * shared workplace. Every agent owner decides that agent's code and
 * knowledge proposals; admin-only boundaries still apply to destructive and
 * shared-secret requests. Finer roles wait for a real client to need one.
 */
import type { WorkplaceAutoApprove } from '../shared/auto-approve.js';

export type OrgRole = 'admin' | 'member';

export interface OrgDocument {
  orgId: string;
  /** Display name — "Acme Trading", not an address. Not unique. */
  name: string;
  /**
   * The workplace's public address at the root of the domain (knowledge page
   * "public-addresses", 2026-09-26): `acme` is `agenticcloudcomputer.com/acme`
   * and its repositories live under it. Unique across every workplace AND
   * every person's address name — one namespace — read off the name when
   * the workplace is made, claimed only through `OrgStorage.claimHandle`,
   * never written by `updateOrg` and never changed: an address is for
   * keeps, as a person's is. Absent only on a workplace the boot backfill
   * has not reached yet.
   */
  handle?: string;
  /** The founder (platform userId). Also the first admin, written by createOrg. */
  createdByUserId: string;
  createdAt: string;
  /**
   * One shepherd, sheepdog or big working dog chosen when this workplace is
   * created for its Workspace Agent. Optional only for workplaces born before
   * note #582; those keep the original reserved Bernese avatar.
   */
  workspaceAgentAvatarSlug?: string;
  /**
   * ONE knowledge shelf for the workplace (note #566). Set once, by the boot
   * backfill (`knowledge-shelf-backfill.ts`), after every room's pages were
   * brought into the knowledge base at the workplace's own namespace. From
   * then on every room's knowledge reads and writes resolve to that one base;
   * until then each room still reads its own, so no shelf is ever empty
   * between the release and the merge. `renames` records a page that had to
   * take its room's name in front because the shelf already held its name, so
   * a link copied before the merge (it carries the room) still arrives.
   */
  knowledgeShelf?: {
    mergedAt: string;
    renames?: Array<{ roomId: string; from: string; to: string }>;
  };
  /**
   * ONE set of secrets for the workplace (note #783), like repositories. Set
   * once, by the boot backfill (`secret-shelf-backfill.ts`), after every
   * room's keys were brought into the store at the workplace's own namespace.
   * From then on every room's secret reads and writes resolve to that one
   * store (`OrgGitService.secretShelfFor`); until then each room still reads
   * its own, so no key is ever missing between the release and the merge.
   * `renames` records a key that had to take its room's name behind it
   * (`GH_TOKEN_GROWTH`) because the workplace already held that name with a
   * different value — the owner is told on the Secrets screen.
   */
  secretShelf?: {
    mergedAt: string;
    renames?: Array<{ roomId: string; from: string; to: string }>;
  };
  /**
   * Rooms are leaving the product (note #843, Adam, 30 Oct 2026: "Let's
   * remove rooms. I think it's not actually helpful."). Set once, by the boot
   * migration (`room-merge-backfill.ts`), after every room's notes were
   * brought onto the workplace's own namespace — the one the knowledge and
   * secret shelves already stand at; a workplace made since is born with it.
   * From then on every room of the workplace resolves to that one namespace
   * (`OrgGitService.resolveNamespace`): notes, knowledge changes, new
   * repositories, the decision queue and the briefing answer for the whole
   * workplace whichever room a caller names.
   *
   * `namespaces` keeps the rooms' own namespaces as they were at the merge,
   * so the records still standing at one — decided proposals, repositories,
   * stored files, a moved note's earlier address — stay the workplace's once
   * the room rows themselves are gone.
   */
  roomsMerged?: {
    mergedAt: string;
    namespaces?: string[];
  };
  /**
   * An admin asked to delete this workplace (owner, 2026-09-22). While this
   * stands the workplace is LOCKED: every member sees the deletion screen
   * instead of the Workspace, its agents were put to sleep and are refused
   * new turns, and nobody new can join. Any admin may clear it — keeping the
   * workplace exactly as it was — until `purgeAt`, when the deletion sweep
   * removes the workplace's records for good. Nothing in the workplace's own
   * cloud account is destroyed, then or now: that stays the customer's.
   */
  deletion?: {
    requestedAt: string;
    requestedByUserId: string;
    /** Their name as it was, for the lock screen and the emails: they may
     *  leave, or have their profile renamed, before the end. */
    requestedByName: string;
    purgeAt: string;
    /** The sweep's last attempt that did not finish, so a stuck purge is
     *  visible in the record and simply tried again on the next pass. */
    lastAttempt?: { at: string; error: string };
    /**
     * Stamped by the purge before its first destructive step, and from then
     * on the workplace can no longer be kept. It carries what a retry needs
     * and could not read again once earlier steps have run: every namespace
     * whose contents are the workplace's (a deleted room's is known only by
     * its repository rows, which step 3 removes) and everyone who was a
     * member (step 7 removes the memberships the last email goes to).
     */
    purge?: { startedAt: string; namespaces: string[]; memberIds: string[] };
  };
  /** When an admin last kept this workplace. Asking again waits an hour, so
   *  a delete-and-keep loop cannot turn every member's inbox into a channel. */
  deletionKeptAt?: string;
  /**
   * Legacy completion marker from the original founder-only setup gate. The
   * Workspace now derives its lock from current Fly and live-seat facts, so
   * older workplaces are covered even when this is absent.
   */
  setupRequired?: boolean;
  /**
   * Made for the person the moment their account was (note #144), so the
   * cloud and the subscription have a workplace to land in. It already has a
   * first-name-based default, but remains a spare while this is true — which
   * lets an invited person join somebody else's workplace without being asked
   * to set up their own. `foundIfReady` clears it when both prerequisites land.
   */
  unnamed?: boolean;
  /**
   * The founding is still owed (note #144): two rooms and four agents built
   * for real (no Workspace Agent since note #656). Stamped at creation and
   * cleared by `foundIfReady` the moment the cloud and a subscription are in;
   * that same edge accepts the account workplace's default name. Absent on
   * every workplace from before founding, which
   * is what keeps them from being furnished on their next reload.
   */
  foundingPending?: boolean;
  /**
   * A workplace made since the first run moved into the Chief of Staff's
   * chat (note #726): its founder's conversation opens on the fixed greeting
   * and the three starter answers, and a plan is asked for inside the chat.
   * Workplaces from before keep the old empty-chat words. Stamped at
   * creation; never cleared, because the greeting row itself is what says
   * the first run has begun.
   */
  firstRun?: true;
  /**
   * The team is arriving (2026-09-18): the founding has written the rooms
   * and the agents, their computers are being built, and the founder has
   * not yet stepped into the Workplace. Stamped by the founding, cleared by
   * `POST /api/org/arrived` — the Continue on the arriving screen, which
   * opens once two of the four are ready. While it stands the Workspace
   * stays behind the gate, on that screen.
   */
  arriving?: boolean;
  /**
   * The platform's yes to this ONE workplace bringing a Fly account of its own
   * (note #801, the owner, 2026-10-26: "yes let's bring back bring your own
   * Fly account"). Every workplace is hosted on ours by default (note #664)
   * and none may connect one; a marked workplace may, once, while nothing of
   * its own runs in our account yet. Set and cleared only by an operator
   * (`backend/scripts/allow-own-cloud.mjs`) — no route writes it, so the
   * token step never comes back in front of an ordinary sign-up.
   */
  ownCloudAllowed?: { at: string; by: string };
  /**
   * The platform's yes to this ONE workplace inviting people (note #805, the
   * owner, 2026-10-26). Inviting is switched off on production
   * (`RouteDeps.invitesClosed`, 2026-10-11); a workplace carrying this mark
   * gets it back whole — the invite page, join requests, people and roles,
   * and a newcomer's account landing here once an admin approves. A mark of
   * its own, apart from `ownCloudAllowed`: a team may want either without
   * the other. Set and cleared only by an operator
   * (`backend/scripts/allow-invites.mjs`); no route writes it.
   */
  invitesAllowed?: { at: string; by: string };
  /**
   * Workstream 3's interface: the client's own Fly org, where agent machines
   * and deploys land. Absent until the client connects one — the org layer
   * only carries the pointer, provisioning owns what it means.
   */
  fly?: {
    orgSlug: string;
    /** Name of the org-level secret holding the Fly token — never the token. */
    tokenSecretName?: string;
    /**
     * The backend's WireGuard peer into this org's 6PN network — how the
     * control plane reaches machines that live in the client's Fly org.
     * Everything here is public-side state; the private key is an org secret.
     */
    wireguard?: {
      /** Peer name registered with Fly (also how it is removed). */
      peerName: string;
      /** The address our end got inside the org's 6PN network. */
      peerIp: string;
      /** Gateway hostname to dial (port 51820). */
      endpoint: string;
      /** The GATEWAY's public key — the [Peer] side of the local config. */
      gatewayPubkey: string;
    };
    /**
     * What happened the last time the control plane tried to bring this
     * workplace's own tunnel up (note #642).
     *
     * `wireguard` above says a peer is REGISTERED; it cannot say whether the
     * attempt to route through it succeeded, was refused, or was never made.
     * Before this record the Workspace read the peer's absence as "coming
     * up", which is a claim about the future the record could not support:
     * org #0's tunnel is rolled back by the route guard on every attempt and
     * would have said "coming up" forever, while a client whose bring-up had
     * failed said exactly the same thing.
     *
     * Written by `OrgWireGuardService` on every attempt whose outcome
     * DIFFERS from the one recorded — a converge that changes nothing costs
     * no write — and cleared with the peer itself. Absent on a workplace
     * that has not been through an attempt since this landed, which is the
     * honest "nobody has looked".
     */
    peerCheck?: {
      /** `routed-elsewhere`: the host already routes this network (the route
       *  guard rolled the peer back), so the machines ARE reachable and no
       *  tunnel of our own is wanted. `failed`: the attempt threw. */
      status: 'up' | 'routed-elsewhere' | 'failed';
      /** ISO 8601, by the control plane's clock. */
      at: string;
      /** The conflicting route, or the failure's message — for an operator. */
      detail?: string;
      /**
       * The /48 that was found already routed, on `routed-elsewhere` only.
       * Kept so the next converge can re-check the ROUTE instead of
       * registering a peer with Fly just to learn the network again — the
       * register-then-roll-back round trip that ran on every machine build
       * for org #0, and that stranded `ia-backend-8d47d7ff` in its Fly org
       * the one time a roll-back failed (found 2026-09-23).
       */
      network?: string;
    };
  };
  /**
   * Workstream 4's interface (byo-git-design): the git namespace this org's
   * repos live under — the first path segment of every clone URL and disk
   * path, shared by every member. On the central host org #0's is its admin's
   * userId (the pre-org layout, unmigrated on purpose); an org born on its
   * own git host gets its orgId. Absent until stamped: members then resolve
   * to their own userId, which is exactly the pre-org behavior.
   */
  git?: {
    namespaceId: string;
    /**
     * The org's OWN git host (byo-git-design slice 2b), written by
     * `ensureOrgGitHost` after the machine answered healthy. Absent on org #0
     * and any org still on the central host. Public-side facts only — the
     * host's shared secret lives in the org-secret store under `secretName`.
     */
    host?: {
      app: string;
      /** The flycast address the backend and the org's machines dial. */
      flycastIp: string;
      volumeId: string;
      /**
       * How big that volume is, in GB — written at provisioning and rewritten
       * by every grow. The push ceiling is derived from it (note #62), so it
       * is kept HERE rather than read from Fly: the quota is answered on the
       * push path, and a network call to another provider is not something a
       * `git push` should wait on or be failed by.
       *
       * Absent on a host provisioned before this shipped; readers fall back to
       * `ORG_GIT_VOLUME_GB`, which is the size those hosts were built with.
       */
      volumeGb?: number;
      secretName?: string;
    };
    /**
     * The org's OWN backup bucket (slice 4): its git bundles land here, on
     * its bill, in its custody. Public-side facts — the S3 credentials live
     * in the org-secret store, minted ONCE by the bucket's creation.
     */
    backup?: {
      /** The Fly extension name (also how it is deleted at off-boarding). */
      addOnName: string;
      bucket: string;
      endpoint: string;
      credsSecretName?: string;
      /**
       * The most recent backup run against this org's host, stamped by the
       * sweep — the per-org fact the Workspace shows, where the backup
       * monitor's heartbeat is one row for the whole fleet.
       */
      last?: { at: string; ok: boolean; detail: string };
    };
  };
  /**
   * Direct messages between people (note #608): the workplace's OWN messaging
   * machine, written by `ensureOrgMsgHost` after it answered healthy. The
   * message text lives there and nowhere else. Public-side facts only — the
   * shared secret is in the org-secret store under `secretName`.
   */
  messages?: {
    host: {
      app: string;
      machineId: string;
      /** The machine's own private-network address; only the backend's peer may dial it. */
      privateIp: string;
      volumeId: string;
      secretName?: string;
    };
  };
  /**
   * BYO media (byo-media-design): the org's OWN attachment bucket — chat,
   * note, proposal and knowledge files land here, on the org's bill, in its
   * custody. Absent until the org's first attachment provisions it (which
   * needs a connected Fly org); org #0 never gets one and rides the
   * platform's env-configured store. Public-side facts only — the S3
   * credentials live in the org-secret store, minted ONCE at creation.
   */
  media?: {
    /** The Fly extension name (also how it is deleted at off-boarding). */
    addOnName: string;
    bucket: string;
    endpoint: string;
    credsSecretName?: string;
  };
  /**
   * The machine every NEW agent in this workplace is built on: one rung of
   * the ladder in `config/agent-machine-sizes.ts`, chosen by an admin on the
   * cloud screen (note #355).
   *
   * An OVERRIDE, never the whole answer. Absent until somebody chooses, and a
   * rung that has since left the ladder reads exactly as absent does — both
   * fall through to the platform's own default in
   * `effectiveAgentMachineSize`, because a stale id must not be able to fail
   * a provision.
   *
   * It decides what a new machine is BUILT at and nothing else: existing
   * agents keep the size they run on, and their owners still move them along
   * the ladder from the agent's own machine screen.
   *
   * Deliberately NOT inside `fly`: connecting a cloud account writes that
   * block whole (`org-fly.ts`), so a setting kept in there would be erased by
   * a reconnect nobody expected to change it.
   */
  agentMachineSizeId?: string;
  /**
   * Auto-approve mode (note #944): while `on`, a code proposal an agent makes
   * ready with passing checks is merged at once, decided automatically and
   * never in a person's name. Absent is off — the default. Written only by
   * an admin's own request (`PUT /api/org/auto-approve`); no agent route
   * writes it. Every flip is kept in `history` (who, when).
   */
  autoApprove?: WorkplaceAutoApprove;
  /**
   * The org's face (note #56): an avatar an admin set, shown wherever the
   * workplace is named. Bytes live in the org's OWN media bucket under
   * `users/<orgId>/org/…` (the org-namespaced owner prefix the media router
   * already files by); this is only the pointer, replaced whole on change.
   */
  avatar?: {
    storagePath: string;
    contentType: string;
    sizeBytes: number;
    updatedAt: string;
    /** The admin who set it — an audit fact, not an authorization field. */
    setByUserId: string;
  };
}

/** Where an org's avatar lives in media storage: the org's own owner prefix,
 *  so the bytes land in the org's bucket beside its other files. */
export function orgAvatarPath(orgId: string, avatarId: string): string {
  return ['users', orgId, 'org', avatarId].join('/');
}

/**
 * One human's membership in one org. Identity stays the personal Telegram
 * account exactly as today, so `userId` is the platform profile key. A human
 * may hold any number of these. Exactly one is their active Workspace context;
 * agents never inherit that mutable choice — every agent carries its own
 * immutable `orgId`.
 */
export interface OrgMembershipDocument {
  orgId: string;
  userId: string;
  role: OrgRole;
  joinedAt: string;
  /** The Workspace context remembered for this human. At most one per user. */
  active?: boolean;
  /** Who minted the invite this membership came from. Absent for founders. */
  invitedByUserId?: string;
  /**
   * The first time this membership opened, the person's already-usable
   * private subscriptions followed them here (note #602). The stamp makes
   * that welcome one-shot: a later manual unassignment remains a choice
   * instead of being silently undone by every Workspace read.
   */
  inheritedSeatsAt?: string;
  /**
   * The person as the People page shows them (note #328) — on the MEMBERSHIP,
   * not the profile, so no workplace learns what a member does in another
   * (org-layer-design's privacy boundary holds by construction).
   *
   * `lastSeenAt`: the newest authenticated Workspace request they made while
   * this workplace was their active one, stamped at most once a minute.
   * `recap`: the latest thing they drove here, one plain line — written by
   * the action routes today (a message to an agent, a decision, a note) and
   * by a summarizer in the design's next tier. Failure is silence: a stamp
   * that cannot be written leaves the previous one standing.
   */
  lastSeenAt?: string;
  recap?: { text: string; at: string };
  /** The workplace's briefing for this member — one per workplace again since
   * rooms left the product (note #843), with its history below. Private to
   * this member; never serialized in People or workplace lists. */
  workspaceRecap?: import('../shared/workspace-recap.js').SavedWorkspaceRecap;
  /** The briefings this reader has already been given, newest first and capped
   * at RECAP_HISTORY (note #413) — the context that lets the next one carry the
   * story forward rather than restate it. `workspaceRecap` is its head; both are
   * written in one touch, so they cannot drift apart. As private as the
   * overview itself: never serialized in People or workplace lists. */
  workspaceRecapHistory?: import('../shared/workspace-recap.js').PreviousWorkspaceRecap[];
  /** The model and effort the reader's next recap is written with. Two older
   * recap keys may still sit on a membership beside it, read by nothing:
   * `workspaceRecapEnabled` (the pause, note #489) and `workspaceRecapCadence`
   * (How often, note #510). Both went with automatic writing when recaps
   * became on demand (note #607). */
  workspaceRecapSettings?: import('../shared/workspace-recap.js').WorkspaceRecapSettings;
  /** The Workspace Agent's own model and effort. A member from before note
   * #447 is initialized once from the previously shared effective setting;
   * after that this field and workspaceRecapSettings never fall back to one
   * another. Private like the rest. */
  workspaceAgentSettings?: import('../shared/workspace-recap.js').WorkspaceRecapSettings;
  /** When this member last read their Home overview. Event-driven source
   * collection (a turn ending, a decision) serves only members who have looked
   * recently, so nobody's activity is re-read for a card nobody opens. */
  workspaceRecapReadAt?: string;
  workspaceRecapChat?: import('../shared/workspace-recap-chat.js').RecapConversation;
  /** The Chief of Staff's event turns and standing permissions (note #716).
   * Absent until the person first saves them: event turns are off. */
  workspaceAgentProactive?: import('../shared/workspace-agent-proactive.js').WorkspaceAgentProactive;
  /** The once-a-day rule's memory (note #716): each event cause that started
   * a turn, keyed by its cause key, with when. Pruned as it is written. */
  workspaceAgentEventLedger?: Record<string, string>;
}


export type OrgSeatProvider = 'claude' | 'codex' | 'opencode';

/**
 * Lifecycle mirrors the credential pool's, deliberately: the turn path that
 * reads seats inherits the pool's cooldown handling rather than growing a
 * second one. `dead` needs the member to re-auth (workstream 2's self-healing
 * flow); `cooldown` restores itself; `payment_required` keeps a healthy grant
 * probeable until the provider confirms the invoice has been paid.
 */
export type OrgSeatStatus = 'active' | 'cooldown' | 'payment_required' | 'dead' | 'disabled';

/**
 * A member-owned CLI subscription. THE invariant of the whole model: a seat
 * belongs to one human and powers only that human's agents — storage carries
 * `userId` on every seat and the turn path must never select across owners.
 * That is what keeps one-human-one-seat true by construction (Anthropic's and
 * OpenAI's terms both require it) and makes "your people's seats stay their
 * seats" a sentence sales can say.
 */
export interface OrgSeatDocument {
  seatId: string;
  /**
   * The org this VIEW is assigned to. The credential itself is personal and
   * may be explicitly assigned to several orgs simultaneously; storage
   * decorates each org-scoped read with that org here. For legacy rows this is
   * also the org in which the sign-in was first created.
   */
  orgId: string;
  /** The member this seat belongs to. Never used for anyone else's turns. */
  userId: string;
  provider: OrgSeatProvider;
  /**
   * Provider-shaped secret material, exactly as the credential pool holds it
   * today: Claude — the setup-token, injected per turn; Codex — the full
   * auth.json contents, written to the machine before the turn and synced
   * back after (the CLI refreshes tokens in place).
   */
  token: string;
  /** The member's own name for it — "my Max account", "work ChatGPT". */
  label: string;
  status: OrgSeatStatus;
  /**
   * The member's pick among their same-provider seats IN THIS ORG — the one
   * their turns run on first. Storage keeps at most one selected per
   * (org, member, provider);
   * a rate-limited selected seat may fall back to the member's OTHER seats of
   * that provider (same human, still clean), never to anyone else's.
   */
  selected: boolean;
  /** Zero-based order inside this org/provider; primary is still `selected`. */
  assignmentPriority?: number;
  /** ISO — set while `status === 'cooldown'`; past values read as expired. */
  cooldownUntil?: string;
  /**
   * Health bookkeeping written by the turn path through the credential
   * pool's shared outcome brain (org-seat-credentials.ts translates) — the
   * same fields, with the same meanings, as PlatformCredentialDocument.
   */
  modelCooldowns?: Record<string, string>;
  authFailureStreak?: number;
  deadReason?: string;
  /** Provider-shaped subscription state that established a billing pause (for example `past_due`). */
  subscriptionStatus?: string;
  /** ISO timestamp of that provider profile reading. */
  subscriptionStatusReadAt?: string;
  /**
   * Last probed unified usage windows (the credential pool's periodic
   * refresher walks seats too). What lets a model-scoped rate limit bench
   * one model instead of the whole seat — without evidence of headroom the
   * outcome brain deliberately cools the entire seat down.
   */
  usage?: import('./user.js').ProviderUsageSnapshot;
  usageRefreshedAt?: string;
  /**
   * Present on a seat minted through our own OAuth flow (the Workspace
   * sign-in): `token` is then the grant's ~8h ACCESS token — profile-scoped,
   * so it reads the full usage picture — and this block is what keeps it
   * alive. Absent on legacy `claude setup-token` seats (long-lived,
   * inference-only) and on Codex seats (auth.json refreshes CLI-side).
   */
  oauth?: {
    /** Rotates on refresh; persist what comes back or the seat strands. */
    refreshToken: string;
    /** Epoch ms — when `token` stops working. */
    expiresAt?: number;
    scopes?: string[];
    /** Set when the grant died — the member must sign in again. */
    failedAt?: string;
    failedReason?: string;
  };
  /**
   * Per-model windows (alias → window, e.g. `fable`), from the profile-scoped
   * usage read. Kept apart from `usage.windows` for the same reason the pool
   * keeps them apart: a full Fable window must not bench the whole seat.
   */
  modelWindows?: Record<string, import('./user.js').ProviderUsageWindow>;
  modelWindowsReadAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A deliberate link between one private sign-in and one workplace. */
export interface OrgSeatAssignmentDocument {
  orgId: string;
  userId: string;
  seatId: string;
  selected: boolean;
  /** Zero-based fallback order within (org, user, provider). */
  priority: number;
  assignedAt: string;
}

/**
 * A reusable web link for requesting workplace membership. Submitting
 * it creates a pending request; an admin's explicit approval grants access.
 *
 * It does not expire: a link an admin hands out stays live until that admin
 * revokes it. Older documents still carry the `expiresAt` they were minted
 * with; nothing reads it any more, and they are live again.
 */
export interface OrgInviteDocument {
  /** URL-safe, 22 random chars. */
  token: string;
  orgId: string;
  createdByUserId: string;
  createdAt: string;
  /** Legacy single-use history. Consumed links stay invalid after migration. */
  usedAt?: string;
  usedByUserId?: string;
}

/** Why an invite tap did not become a membership, for an honest refusal. */
export type OrgInviteRefusal = 'unknown' | 'used' | 'already-member';

export type OrgInviteRedemption =
  | { ok: true; membership: OrgMembershipDocument; org: OrgDocument }
  | { ok: false; reason: OrgInviteRefusal };

/**
 * A JOIN REQUEST (note #1): a reusable invite link no longer admits anyone by
 * itself. Opening it while signed in files a request, and an admin of the
 * workplace decides it. The link stays live for the next person; the
 * request is what carries one person through the door.
 */
export type OrgJoinRequestStatus = 'pending' | 'approved' | 'rejected';

export interface OrgJoinRequestDocument {
  requestId: string;
  orgId: string;
  userId: string;
  /** The link this request came through. Kept for history even once revoked. */
  inviteToken: string;
  requestedAt: string;
  status: OrgJoinRequestStatus;
  decidedAt?: string;
  decidedByUserId?: string;
}

/** Why opening a link filed no request: the same refusals a direct redeem gives. */
export type OrgJoinRequestOutcome =
  | { ok: true; request: OrgJoinRequestDocument; org: OrgDocument }
  | { ok: false; reason: OrgInviteRefusal };

export type OrgJoinDecision = 'approve' | 'reject';

/** `forbidden`: the decider is not an admin of that org (any more). `resolved`:
 *  the request was already decided, so this decision changed nothing. */
export type OrgJoinDecisionRefusal = 'unknown' | 'forbidden' | 'resolved';

export type OrgJoinDecisionOutcome =
  | { ok: true; request: OrgJoinRequestDocument }
  | { ok: false; reason: OrgJoinDecisionRefusal };
