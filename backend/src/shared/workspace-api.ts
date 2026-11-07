/**
 * The Workspace's browser-facing API, as TYPES.
 *
 * Shared between the backend handlers that answer under /workspace and the
 * React app that calls them, so a renamed field fails to compile on both
 * sides instead of rendering as `undefined` on one. Handlers `satisfies`
 * these shapes; the client's `api<T>()` is parameterized by them.
 *
 * Slice 1 covers authentication and the entry doors. Each later vertical
 * slice (agents, repositories, proposals, notes, knowledge, workplaces,
 * secrets) adds its own section here as its screens move.
 *
 * Pure types plus the one constant both sides validate with. No runtime
 * dependencies, importable from Node and the browser alike.
 */

import type { LeaderboardAllTime, LeaderboardDay, LeaderboardWeekNumbers } from './leaderboard.js';
import type { WorkspaceMailApproval, WorkspaceMailboxSummary } from './workspace-mail.js';

/** Source text of the Workspace username rule; the same pattern the browser
 *  form uses and the server enforces. Anchored by whoever compiles it. */
export const WORKSPACE_USERNAME_PATTERN_SOURCE = '[a-z0-9_]{3,32}';

/** Every error body a Workspace endpoint sends: a sentence for people, and a
 *  code when the flow needs to branch on the reason. */
export interface WorkspaceApiErrorBody {
  error: string;
  code?: WorkspaceWebAuthErrorCode | string;
}

/** The `code` on every 404 that means "no repository by that name in this
 *  workplace". A repository of another workplace answers exactly the same —
 *  a private one is never confirmed to exist — and the code is what lets a
 *  screen tell that answer from a missing folder or file (note #671). */
export const NO_SUCH_REPOSITORY = 'no_such_repository';

export type WorkspaceWebAuthErrorCode =
  | 'invalid_username'
  | 'username_taken'
  | 'already_enabled'
  | 'enrollment_missing'
  | 'enrollment_expired'
  | 'authentication_required'
  | 'invalid_code'
  | 'invalid_credentials'
  | 'verification_invalid'
  | 'verification_expired'
  | 'verification_unavailable'
  | 'invalid_mailbox'
  | 'mailbox_taken'
  | 'outside_email_closed'
  | 'profile_missing';

// ── auth/* ──────────────────────────────────────────────────────────────────

export interface WorkspaceSessionSummary {
  sessionId: string;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
}

/** GET auth/session — 200 with the signed-in shape, 401 with the other. */
export type WorkspaceSessionAnswer =
  | { authenticated: false }
  | {
    authenticated: true;
    username: string;
    displayName: string;
    /** The workplace this tab stands in: the one the read named with
     *  `?org=` while the person still belongs to it, else the account's
     *  active marker (note #628). Lets Home start its workplace-only reads
     *  beside api/state, while a personal workspace starts none of them. */
    activeOrgId?: string;
    emailVerification?: {
      email: string;
      status: 'pending' | 'verified' | 'legacy';
    };
    session: WorkspaceSessionSummary;
  };

export type WorkspaceSignedInSession = Extract<WorkspaceSessionAnswer, { authenticated: true }>;

/** POST auth/enroll/start */
export interface WorkspaceEnrollmentStartRequest { username: string }
export interface WorkspaceEnrollmentStartAnswer {
  enrollmentToken: string;
  username: string;
  /** Base32 authenticator secret, for the manual-entry path. */
  secret: string;
  otpauthUrl: string;
  expiresAt: string;
  /** The same otpauth URL as a QR code, ready for an <img src>. */
  qrDataUrl: string;
  /** The parameters encoded in the QR code and enforced by the server. */
  otp: { digits: number; periodSeconds: number; kind: 'totp' };
}

/** POST auth/enroll/finish — sets the session cookies as a side effect. */
export interface WorkspaceEnrollmentFinishRequest { enrollmentToken: string; code: string }
export interface WorkspaceEnrollmentFinishAnswer {
  authenticated: true;
  username: string;
  /** Shown exactly once; each signs the person in one time. */
  recoveryCodes: string[];
  linkedExistingUser: boolean;
}

/** POST auth/login — sets the session cookies as a side effect. */
export interface WorkspaceLoginRequest { username: string; code: string }
export interface WorkspaceLoginAnswer { authenticated: true }

/** POST auth/email/register — creates the account from the address this
 *  person chooses on our own mail domain and a password (note #509). No
 *  outside email, no confirmation link: the session opens straight away. */
export interface WorkspaceEmailRegisterRequest {
  mailbox: string; password: string; firstName: string; lastName: string;
  /** A private copy's admission (note #808): the invite link the account
   *  comes through — its request to join is filed with it — or, for the
   *  copy's first account, the installer's code. Ignored anywhere else. */
  inviteToken?: string;
  firstAccountCode?: string;
}
export interface WorkspaceEmailRegisterAnswer {
  authenticated: true;
  address: string;
}

/** POST auth/email/link — current session stays open while ownership is confirmed. */
export interface WorkspaceEmailLinkAnswer {
  authenticated: true;
  email: string;
  verificationRequired: true;
}

/** POST auth/email/login — password first, then optional authenticator. */
export interface WorkspaceEmailLoginRequest { email: string; password: string }
export type WorkspaceEmailLoginAnswer =
  | {
    authenticated: true;
  }
  | {
    authenticated: false;
    secondFactorRequired: true;
    secondFactorToken: string;
    expiresAt: string;
  }
  | {
    authenticated: false;
    verificationRequired: true;
  };

/** Public, existence-oblivious confirmation operations. */
export interface WorkspaceEmailVerificationResendRequest { email: string; inviteToken?: string }
export interface WorkspaceEmailVerificationResendAnswer { accepted: true }
export interface WorkspaceEmailVerificationFinishRequest { token: string }
export type WorkspaceEmailVerificationFinishAnswer =
  | { verified: true; authenticated: true }
  | { verified: true; authenticated: false };

/** POST auth/email/password — authenticated password rotation. */
export interface WorkspaceEmailPasswordRequest { currentPassword: string; newPassword: string }
export interface WorkspaceEmailPasswordAnswer { changed: true; revoked: number }

/** POST auth/email/forgot — existence-oblivious: 202 whether or not the
 *  name has an account, and whether or not that account has anywhere to
 *  send a reset. The mail, when there is one, goes to the account's
 *  confirmed recovery address. */
export interface WorkspacePasswordForgotRequest { name: string }
export interface WorkspacePasswordForgotAnswer { accepted: true }

/** POST auth/email/reset — the link from that mail sets a new password and
 *  signs every browser out. It opens no session: sign in with the new
 *  password (and the authenticator, when one is enabled). */
export interface WorkspacePasswordResetRequest { token: string; password: string }
export interface WorkspacePasswordResetAnswer { reset: true }

/** POST auth/email/recovery — authenticated: an OUTSIDE address a forgotten
 *  password may be reset through, pending until its owner opens our link.
 *  DELETE removes it. */
export interface WorkspaceRecoveryEmailRequest { email: string }
export interface WorkspaceRecoveryEmailAnswer { email: string; verificationRequired: true }
export interface WorkspaceRecoveryEmailRemoveAnswer { removed: true }

/** POST auth/email/recovery/confirm — public, from the link. */
export interface WorkspaceRecoveryEmailConfirmRequest { token: string }
export interface WorkspaceRecoveryEmailConfirmAnswer { confirmed: true; email: string }

export interface WorkspaceRecoveryEmailSummary {
  email: string;
  status: 'pending' | 'verified';
}

/** POST auth/email/second-factor — completes an email sign-in when enabled. */
export interface WorkspaceSecondFactorRequest {
  secondFactorToken: string;
  code?: string;
  recoveryCode?: string;
}
export interface WorkspaceSecondFactorAnswer { authenticated: true }

/** POST auth/recovery — consumes the code and sets the session cookies. */
export interface WorkspaceRecoveryRequest { username: string; recoveryCode: string }
export interface WorkspaceRecoveryAnswer { authenticated: true; usedRecoveryCode: true }

/** GET auth/sessions */
export interface WorkspaceBrowserSession {
  sessionId: string;
  authMethod: 'password' | 'email_verification' | 'totp' | 'recovery';
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  userAgent?: string;
  /** The browser making the request. */
  current: boolean;
}
export interface WorkspaceBrowserSessionsAnswer { sessions: WorkspaceBrowserSession[] }

/** DELETE auth/sessions/:sessionId */
export interface WorkspaceSessionRevokedAnswer { revoked: boolean }
/** POST auth/logout-others, POST auth/logout-all */
export interface WorkspaceSessionsRevokedAnswer { revoked: number }
/** POST auth/logout */
export interface WorkspaceLogoutAnswer { loggedOut: boolean }

/** GET auth/invite/:token — what an unauthenticated visitor may learn about a
 *  bearer. `closed`: inviting is switched off on this backend for now, and
 *  the link says nothing else about itself. */
export type WorkspaceInviteStatus = 'available' | 'used' | 'closed';
export interface WorkspaceInviteStatusAnswer { status: WorkspaceInviteStatus }

/** POST api/org/invites/:token/redeem */
export interface WorkspaceInviteRedeemAnswer {
  ok: true;
  orgId: string;
  name: string;
  alreadyMember?: boolean;
  status: 'pending' | 'member';
  requestId?: string;
}

/** Authenticated link preview or the requester's own durable request status. */
export interface WorkspaceJoinPreviewAnswer {
  orgId: string;
  name: string;
  status: 'available' | 'pending' | 'rejected' | 'member' | 'used' | 'removed' | 'closed';
  requestId?: string;
}

export interface WorkspaceOrgJoinRequest {
  requestId: string;
  userId: string;
  name: string;
  username?: string;
  requestedAt: string;
}

/** GET api/org/join-requests — the people waiting at the door and nothing
 *  else, for the tick that keeps an open workplace screen current while
 *  the heavy `api/org` record is read only on open. Admins only. */
export interface WorkspaceOrgJoinRequestsAnswer {
  joinRequests: WorkspaceOrgJoinRequest[];
}

// ── Home / Overview (slice 2) ───────────────────────────────────────────────
//
// What `api/state`, `api/agents/live` and `api/notifications` send, as far as
// the Home screen reads them. Sections Home does not draw yet (notes,
// sites, secrets) are typed only as far as "present
// or not"; their slices refine them when their screens move.

/** An agent's runtime, as the fleet knows it; `'retired'` rows carry a CLI
 *  this product no longer runs and are shown so they can be removed. */
export type WorkspaceAgentStatus =
  | 'ready'
  /** Made with the workplace and waiting for its cloud and subscription (note #144). */
  | 'planned'
  | 'setting-up'
  | 'needs-seat'
  | 'needs-sign-in'
  | 'needs-bot'
  | 'payment-required'
  | 'retired';

/** What an agent is ABOUT right now, from records that name it. */
export type WorkspaceAgentDoing =
  | { kind: 'proposal'; count: number; number: number }
  | { kind: 'site'; count: number; host: string }
  | { kind: 'preview' };

export interface WorkspaceAgentSessionLimit {
  hitAt: string;
  resetAt: string;
  resetsText?: string;
  resumeReady: boolean;
}

export interface WorkspaceAgentContext {
  usedPercent: number;
  tokens: number;
  window: number;
  at: string;
}

/** One agent row of `api/state`. Fields the details screen (slice 3) reads
 *  and Home does not — `version`, `seatId` — stay open here. */
export interface WorkspaceAgentRow {
  id: string;
  name: string;
  cli: string;
  model?: string;
  effort?: string;
  seatId?: string;
  avatarUrl?: string;
  status: WorkspaceAgentStatus;
  createdAt?: string;
  recap?: string;
  recapAt?: string;
  /**
   * The recap summarizer judged the latest turn's work FINISHED — done, with
   * nothing waiting on anyone — and no turn has ended since (note #707). Only
   * half of "safe to reset": `agentReadyForFreshChat` (shared/fresh-chats.ts)
   * adds the records'. Absent otherwise, and always absent while a turn runs.
   */
  finished?: true;
  now?: string;
  nowAt?: string;
  doing?: WorkspaceAgentDoing;
  working?: boolean;
  activity?: string;
  activitySince?: string;
  lastActiveAt?: string;
  /** The record-known half of the details screen's version card, sent with
   *  the state so that screen opens on facts instead of a loading card. */
  version?: WorkspaceAgentVersionSeed;
  lastReply?: { text: string; at: string };
  /**
   * The files on the newest message in its chat (note #553) — the owner's or
   * its own, whichever was said last — so the agents list shows the pictures
   * an agent just delivered on its plate, and a tap opens them full screen.
   * Absent when that message carried none. Bytes are asked for the way the
   * chat asks: `api/agents/:id/chat/files/:fileId`.
   */
  lastFiles?: WorkspaceChatFile[];
  /** Durable background jobs running on its machine as of the last time the
   *  backend looked (turn end, an open jobs read, the idle sweep) — absent at
   *  zero, so the plate draws nothing rather than "0 jobs" (note #564). */
  activeJobs?: number;
  sessionLimit?: WorkspaceAgentSessionLimit;
  context?: WorkspaceAgentContext;
  /**
   * What this agent's machine is made of (note #356) — the shape the row
   * names, beside the runtime it thinks with.
   *
   * The last OBSERVED shape off the record, not a live read: `api/state`
   * makes no control-plane calls (see `version`), and a machine's shape is
   * the rarest fact about it. Absent until something has looked — a fleet
   * sweep, the agent's own screen, a resize — which is why the row treats it
   * as a line it may not have rather than one it is owed.
   *
   * Deliberately not folded into `version`: that seed is defined as the
   * version card MINUS the machine, and the live block it stands in for
   * carries where the machine runs and whether it is awake, neither of which
   * is true off a record.
   */
  machineSize?: { cpuKind: string; cpus: number; memoryMb: number };
  /**
   * The Workspace Agent asked the owner to remove this agent (note #710):
   * who asked, when, and the reason it gave. The agent's screen shows it over
   * the delete button with Keep beside it; nothing is removed until the
   * owner types the name, as always.
   */
  removeAsk?: WorkspaceRepoAsk & { reason?: string };
  /** A sealed public guide (note #1010): its screen lists the visitors' conversations. */
  sealed?: 'public-guide' | 'guest';
}

/** One of a member's agents as their People plate and page draw it. */
export interface WorkspaceOrgMemberAgent {
  id: string;
  name: string;
  avatarUrl?: string;
  /** A turn is running right now (2026-10-28). The people tick keeps it current. */
  working?: true;
  /** Its latest-work line — the one-line recap its own row carries — and
   *  when it was written (2026-10-28, reversing note #346). Never the words
   *  of the chat it came from. */
  recap?: string;
  recapAt?: string;
}

/** What the people tick says about one of a member's agents: the two facts
 *  that move while somebody is looking. */
export type WorkspacePersonAgentLive = Pick<WorkspaceOrgMemberAgent, 'id' | 'working' | 'recap' | 'recapAt'>;

/**
 * A TEAMMATE'S agent, as the agents picker shows it (2026-09-23).
 *
 * The owner's rule: an agent a person drives is never hidden from the rest
 * of the workplace — every member sees it, face and name, wherever it has
 * left work. The Agents tab is the one place that stays the reader's OWN
 * fleet, because every plate there is a control (a chat, a runtime, a
 * machine) that only its owner may use; it still owes the reader the other
 * half of the workplace at a glance: who else is working here, and whose they
 * are. This row is exactly that much and no more — the face, the name, the
 * person who drives it, and whether a turn is running — each a door to the
 * read-only page of note #640. What an agent is asked to DO stays between it
 * and its owner (note #346), so no recap, no activity line, no runtime.
 */
export interface WorkspaceTeamAgentRow {
  id: string;
  name: string;
  avatarUrl?: string;
  /** Coarse, as on the agent's page: still being built, or ready. */
  status: 'ready' | 'setting-up';
  /** A turn is running right now. The live tick keeps it current. */
  working?: true;
  lastActiveAt?: string;
  owner: { userId: string; name?: string; photoUrl?: string };
}

export type WorkspaceCheckState = 'success' | 'pending' | 'failure' | 'superseded';

export interface WorkspaceChecksSummary {
  total: number;
  failing: number;
  pending: number;
  worst: WorkspaceCheckState;
}

export interface WorkspaceProposalRow {
  id: string;
  number: number;
  repoName: string;
  title: string;
  body: string | null;
  from: string;
  to: string;
  diffStat?: { insertions: number; deletions: number };
  status: string;
  /**
   * Open, but QUIET (note #293): the agent recorded it and has not yet run
   * `pr ready`, so no card or notification was sent, it is in no queue, and
   * nobody — the owner included — can decide it. Absent once shown.
   */
  draft?: true;
  createdAt: string;
  decidedAt: string | null;
  agentName: string | null;
  agentAvatarUrl?: string;
  agentId?: string;
  userName?: string;
  /** Whether THIS viewer decides it; Home's queue lists only those. */
  canDecide: boolean;
  checks?: WorkspaceChecksSummary;
  /**
   * Merged by auto-merge (note #944), not by a person: the mode's who
   * and when, which every surface names in place of a decider.
   */
  autoApproved?: { at: string; modeOnAt: string; modeOnByName: string };
  /** Auto-approve was on but did not merge it; it waits, and this says why. */
  autoApproveFallback?: { at: string; reason: string };
}

export interface WorkspaceKnowledgeProposalRow {
  id: string;
  number: number;
  title: string;
  status: string;
  /** Open, but QUIET (note #293): the agent has not yet run `knowledge
   *  proposals ready`, so it is in no queue and nobody can decide it. Absent
   *  once shown. */
  draft?: true;
  /** Applied by the agent the moment it was written (note #746): nobody was
   *  asked. A history entry, never a decision. */
  direct?: true;
  pages: string[];
  createdAt: string;
  /** When it stopped waiting — set by every ending, a conflict included. The
   *  queue has no use for it (its rows are all open); a HISTORY does. */
  decidedAt?: string;
  agentName: string | null;
  agentAvatarUrl?: string;
  agentId?: string;
  canDecide: boolean;
}

export interface WorkspaceSeatUsageWindow {
  usedPercent: number;
  percentText: string;
  trackText?: string;
  /** Consumption compared with time elapsed in this window. Absent when the
   * provider did not supply both a reset and a duration. */
  pace?: 'ahead' | 'even' | 'under';
  /** The pace comparison is valid, but too early to forecast exhaustion. */
  paceEarly?: true;
  /**
   * The rest of the row the subscription's own page draws for this window —
   * its full name, its length and its reset — so that page can open on the
   * very reading Home's plate shows instead of an older one it held (note
   * #697). The same words `WorkspaceSeatWindow` carries for the same window.
   */
  label?: string;
  windowMins?: number;
  resetAt?: string;
}

export interface WorkspaceSeatUsage {
  seatId: string;
  provider: string;
  label: string;
  planText?: string;
  status?: string;
  attention?: 'payment_required';
  selected: boolean;
  windows: WorkspaceSeatUsageWindow[];
  /** When the reading these windows show was taken — the page's "Checked". */
  usageRefreshedAt?: string;
  /**
   * When the server last changed this subscription at all: its reading, its
   * status, its sign-in. The seats read carries the same stamp, so the browser
   * keeps ONE copy of a subscription — whichever of the two reads is newer —
   * and re-reads the one that is behind (note #697).
   */
  updatedAt?: string;
}

export interface WorkspaceOrgSummary {
  orgId: string;
  name: string;
  /** The workplace's public handle — `acme` for agenticcloudcomputer.com/acme (public-addresses). */
  handle?: string;
  role: string;
  members: number;
  seats: number;
  seatProviders: string[];
  /** Locked until Fly and one usable subscription are connected, then while its founding team arrives. */
  setupRequired?: boolean;
  /** The account's spare workplace; its default name is accepted only when the person sets it up. */
  unnamed?: boolean;
  /**
   * Named and founded, its agents' computers being built, and the founder
   * not yet stepped in: the gate's arriving screen, whose Continue calls
   * `api/org/arrived` (2026-09-18).
   */
  arriving?: boolean;
  /** Founded with its agents (note #144): Home owes it no guide. */
  founded?: boolean;
  /**
   * The Workspace Agent's own face (note #627): the workplace's durable dog
   * choice, on the SAME read that carries every agent's. The arriving
   * gate, Home's plate and its conversation header draw it from here, so it
   * paints with the rest of the team instead of a moment after them, once
   * the separate recap read lands. Absent when the release carries no file.
   */
  workspaceAgentAvatarUrl?: string;
  /**
   * The reader's OWN auto-merge switch here (note #944): on, their agents'
   * proposals with passing checks merge without asking them. Absent until
   * they first touch it, which reads as off.
   */
  autoMerge?: { on: boolean; changedAt?: string };
  /**
   * An admin asked to delete this workplace (2026-09-22). While it stands the
   * Workspace shows only the lock screen: who asked, when it goes for good,
   * and — for an admin — Keep this workplace.
   */
  deletion?: WorkspaceOrgDeletion;
  paymentRequiredSeatProviders?: string[];
  seatUsage?: WorkspaceSeatUsage[];
  /** Seats currently leased by this member's private Workspace Agent or briefing. */
  activeSeatIds?: string[];
  avatarUrl?: string;
}

export interface WorkspaceOrganizationRow {
  orgId: string;
  name: string;
  /** The workplace's public handle (public-addresses). */
  handle?: string;
  role: string;
  active: boolean;
  members: number;
  agents: number;
  avatarUrl?: string;
  /** When it is deleted for good, while an admin's deletion stands. */
  deletingAt?: string;
  /** Inviting is switched off for THIS workplace (the backend's
   *  invitesClosed, and no invitesAllowed mark on it — note #805): its row
   *  then says no head count and no role. Absent means invites work there. */
  invitesClosed?: true;
}

/** A workplace an admin asked to delete, as its members read it (2026-09-22). */
export interface WorkspaceOrgDeletion {
  requestedAt: string;
  /** When it is deleted for good, unless an admin keeps it first. */
  purgeAt: string;
  requestedByName: string;
  /** The reader is an admin, so the lock screen offers Keep this workplace. */
  canKeep: boolean;
}

/** GET api/org/deletion — the delete screen's read. */
export interface WorkspaceOrgDeletionPreview {
  name: string;
  /** What goes, counted across every member. */
  holds: {
    people: number;
    agents: number;
    repos: number;
    sites: number;
    notes: number;
    knowledge: number;
    drive: number;
    secrets: number;
  };
  /** Nothing inside and nobody else here: it goes at once, with no week. */
  immediate: boolean;
  /** When a deletion asked for now would be final. */
  purgeAt: string;
  /** The Fly organization whose machines and storage stay behind. */
  cloud?: string;
  deletion?: WorkspaceOrgDeletion;
}

/** POST api/org/deletion. */
export type WorkspaceOrgDeletionAnswer =
  | { ok: true; deleted: true; activeOrgId: string | null }
  | { ok: true; deletion: WorkspaceOrgDeletion };

export interface WorkspaceUserSummary {
  name: string;
  profile: {
    firstName: string;
    lastName: string;
    photoUrl?: string;
    incomplete: boolean;
  };
  account: {
    browserLogin:
      | {
        enabled: true;
        method: 'email';
        email: string;
        secondFactorEnabled: boolean;
        verificationStatus: 'pending' | 'verified' | 'legacy';
        /** Where a forgotten password can be reset through; absent until one is added. */
        recoveryEmail?: WorkspaceRecoveryEmailSummary;
      }
      | { enabled: true; method: 'totp'; username: string }
      | { enabled: false };
    /** Their own address on the mail domain (note #509). Absent until they
     *  choose one — everyone who signed up earlier still can, in Settings. */
    mailbox?: WorkspaceMailboxSummary;
  };
}

/** The viewer's own open request to join somebody else's workplace. */
export interface WorkspaceOwnJoinRequest {
  requestId: string;
  /** The link it came through: the address of the screen that shows it. */
  inviteToken: string;
  orgName: string;
}

export interface WorkspaceStateAnswer {
  org: WorkspaceOrgSummary | null;
  /** Visitors of the home page make their own agents in this person's workplace (note #1038): draw the Guests group. */
  guestsHere?: true;
  /**
   * Set while the viewer is WAITING on an admin somewhere else. Every account
   * comes with a workplace of its own, so a person who signed up to join a
   * team would otherwise be asked to found one; the page reads this and
   * shows them their request instead of the setup gate.
   */
  joining?: WorkspaceOwnJoinRequest;
  /**
   * A private copy's licence, for an admin, while it needs their attention
   * (note #814): ending within 30 days, in its grace, lapsed, missing or not
   * usable. Absent when all is well, for members, and off a copy.
   */
  copyLicence?: { state: 'missing' | 'invalid' | 'ending' | 'grace' | 'lapsed' | 'over'; line: string };
  /**
   * Email in a private copy (note #946), which installs without it: `off`
   * until an admin starts setting it up, `provider`/`records` on the way,
   * `on` once it works. `canSetUp` is there for an admin. Absent off a copy,
   * where mail is always on.
   */
  mailSetup?: { state: WorkspaceCopyMailStatus['state']; canSetUp?: true };
  organizations: WorkspaceOrganizationRow[];
  canCreateOrg: boolean;
  user: WorkspaceUserSummary;
  agents: WorkspaceAgentRow[];
  /** The OTHER members' agents in this workplace (2026-09-23), for the
   *  compact strip in the agents picker. Absent in a personal
   *  workspace and from an older backend, which the strip reads as "none". */
  teamAgents?: WorkspaceTeamAgentRow[];
  prs: WorkspaceProposalRow[];
  knowledgeProposals: WorkspaceKnowledgeProposalRow[];
  secrets: unknown[] | null;
  /** The workplace's repositories, or null when this backend has no git host. */
  repos: WorkspaceRepoRow[] | null;
  sites: unknown[] | null;
  /** The workplace's object-storage buckets (note #768); absent when this
   *  backend has none to offer. */
  buckets?: WorkspaceBucketRow[];
  /** The workplace's pages, or null when this backend has no knowledge base at
   *  all — which the Knowledge section says rather than claiming an empty one. */
  knowledge: WorkspaceKnowledgePageRow[] | null;
  notes: WorkspaceNoteRow[] | null;
  driveAvailable?: boolean;
  /** This backend has the work radio (note #712). Absent or false, the
   *  Workspace never asks about a station and shows no play button. */
  radio?: boolean;
  /** Present only for the platform operator on a backend with the radio:
   *  the account menu then offers the radio's library page (note #758). */
  radioLibrary?: true;
  /** Present only for the platform operator, where private copies' pulses
   *  are kept: the account menu then offers the Copies screen (note #1058). */
  copies?: true;
  messagesAvailable?: boolean;
  /** Present when inviting people is switched off for the workplace this
   *  read stands in — on this backend (RouteDeps.invitesClosed) and that
   *  workplace not one the platform marked to have them (note #805): no
   *  Invite row in the workplace menu, no join requests card on Home, no
   *  people or roles. Absent means invites work there as built. */
  invitesClosed?: true;
  notesArchived: number;
  noteFiles: boolean;
  quota?: { repoMaxBytes: number; userMaxBytes: number; userUsedBytes: number };
}

/**
 * POST api/agents/fresh-chats (note #707) — the picker's "Reset finished
 * agents". The page sends the agents it NAMED in its confirmation; each is
 * checked again here and sent the owner's "reset chat" only if it is still
 * safe. Who was asked and who was not, and why, come back by name.
 */
export interface WorkspaceFreshChatsRequest {
  agentIds: string[];
}

export interface WorkspaceFreshChatsAnswer {
  asked: Array<{ id: string; name: string }>;
  skipped: Array<{ id: string; name?: string; reason: string }>;
}

/** GET api/agents/live — the facts that change between ticks, and nothing
 *  else. `agents` lists only the ones mid-turn; anything absent is idle. */
export interface WorkspaceAgentsLiveAnswer {
  agents: Array<{ id: string; working: true; activity?: string; activitySince?: string }>;
  recaps: Array<{ id: string; recap: string; recapAt?: string }>;
  sessionLimits: Array<{ id: string } & WorkspaceAgentSessionLimit>;
  /** Current private Workspace Agent and briefing seat leases for this reader. */
  activeSeatIds?: string[];
  /** Durable managed jobs running on each agent's machine right now (note
   *  #564), read straight off the records this answer already holds. Only
   *  agents running at least one are listed; the rest carry no count.
   *
   *  OPTIONAL on purpose: a page that outlived a backend release without this
   *  field must not read its absence as "nobody is running anything" and wipe
   *  every plate's count. */
  jobs?: Array<{ id: string; count: number }>;
  /** The agents whose `finished` stands right now (note #707). The verdict is
   *  written seconds after a turn ends — after the full read that turn end
   *  set off — so without this the reset button would wait for the
   *  next navigation to notice it. Optional like `jobs`: an older backend's
   *  silence leaves every row as drawn. */
  finished?: string[];
  /** Active note leases across this workplace (or personal namespace). The
   *  live tick patches matching rows without re-reading note bodies. Optional
   *  so a tab open across an older backend keeps its last truthful state. */
  noteClaims?: WorkspaceNoteLiveClaim[];
  /** Which of `teamAgents` are mid-turn right now (2026-09-23): ids only,
   *  every other one is idle. Optional for the same reason `jobs` is — an
   *  older backend's silence must not stop every teammate's agent at once. */
  teamWorking?: string[];
  /** An admin's deletion stands on this workplace (2026-09-22). A change
   *  from what the page last read reloads it into, or out of, the lock
   *  screen. Absent on an older backend, which says nothing either way. */
  workplaceDeleting?: boolean;
}

export type WorkspaceNotificationKindName = 'agent_completed' | 'approval_required';

export interface WorkspaceNotificationRow {
  notificationId: string;
  userId: string;
  kind: WorkspaceNotificationKindName;
  title: string;
  body: string;
  /** Same-origin Workspace address the notification opens. */
  url: string;
  source?: 'direct_agent_chat';
  dedupeKey: string;
  createdAt: string;
  readAt?: string;
}

/** POST api/notifications/read */
export interface WorkspaceNotificationsReadRequest { notificationIds?: string[]; all?: true }
export interface WorkspaceNotificationsReadAnswer { marked: number }

/** GET api/notifications */
export interface WorkspaceNotificationsAnswer {
  notifications: WorkspaceNotificationRow[];
  unread: number;
}

/* ------------------------------------------------------------------ *
 * The agent's own screen and its conversation (slice 3).
 * ------------------------------------------------------------------ */

/** GET api/agents/:id/version — the per-agent version card. Read once when
 *  the screen opens; `busy` is the one field on it that goes stale while it
 *  is being looked at, and the live tick corrects that one alone. */
export interface WorkspaceAgentVersionAnswer {
  cliLabel: string;
  installed?: string;
  pinned?: string;
  cliUpdateAvailable: boolean;
  image?: { current: boolean; observed?: string; target?: string; canUpdate: boolean };
  busy: boolean;
  machine?: {
    awake: boolean;
    region?: string;
    regionName?: string;
    memoryMb?: number;
    /** Shared vs dedicated cores, and how many (note #268). */
    cpuKind?: string;
    cpus?: number;
  };
  model?: string;
  effort?: string;
  lastActiveAt?: string;
  turnCount: number;
  /** How long it has worked, for life, milliseconds (note #644). */
  workedMs: number;
  /** ISO day counting began; sent only for an agent older than that day. */
  workedSince?: string;
  siteUrl?: string;
  /** The platform's own instructions on the machine, and whether the copy it
   *  has read is the one this backend would write now. */
  docs: { file: string; version?: number; latest: number; current: boolean };
}

/**
 * A version card as far as the RECORD can fill it in — the same shape minus
 * the one fact that costs a control-plane read. Rides the state payload per
 * agent, so the details screen opens on facts instead of a loading card; the
 * machine row joins them when the live read lands.
 */
export type WorkspaceAgentVersionSeed = Omit<WorkspaceAgentVersionAnswer, 'machine'>;

/**
 * SOMEBODY ELSE'S AGENT, as the Workspace may show it (note #640).
 *
 * Every face on these screens is a door now — a note's row, a knowledge page,
 * a remark in a margin — and most of the agents behind them belong to a
 * teammate. The reader's own agent opens its control room: runtime, machine,
 * chat, delete. A teammate's opens this, which is the same facts with nothing
 * to press: who it is, what it runs, who drives it,
 * and what it last did. What an agent is asked to DO stays between it and its
 * owner (note #346) — this says what the workplace can already see of it.
 */
export interface WorkspaceAgentCardAnswer {
  agent: {
    id: string;
    name: string;
    cli: string;
    model?: string;
    effort?: string;
    avatarUrl?: string;
    /** Coarse on purpose for a teammate's: working, still being built, or
     *  ready. Whether ITS OWNER has a subscription to sign in is theirs. */
    status: WorkspaceAgentStatus;
    working?: boolean;
    recap?: string;
    recapAt?: string;
    lastActiveAt?: string;
    createdAt?: string;
  };
  /** The human who drives it, and the door to their member page. */
  owner: { userId: string; name?: string; photoUrl?: string; you?: true };
  /** The reader's own: the screen hands them straight to its control room
   *  rather than showing them a read-only copy of their own agent. */
  yours?: true;
}

/** One rung of the machine ladder the owner may move an agent onto. */
export interface WorkspaceMachineSize {
  /** Fly's own name for the shape — `performance-4x`, `shared-2x`. */
  id: string;
  cpuKind: 'shared' | 'performance';
  cpus: number;
  memoryMb: number;
  /**
   * Estimated compute price per hour the machine is AWAKE — an estimate from
   * Fly's published prices, and priced per awake hour rather than per month
   * because a stopped machine is billed no CPU and no memory at all.
   */
  hourlyUsd: number;
  /**
   * The size a new agent machine is built at HERE — this workplace's own
   * choice where it has made one, and the platform's default where it has
   * not (note #355). Unset on a ladder where a badge already says which rung
   * is in force, so the same fact is never told twice.
   */
  standard?: boolean;
}

/**
 * GET api/agents/:id/machine — what this agent's machine is made of and what
 * else it could be (note #268).
 *
 * Its own read rather than a slice of the version card: the ladder is the
 * same for every agent, so riding it on the state payload would copy it once
 * per agent onto a screen most opens never reach. `current` is absent when
 * Fly could not be read, and when the machine is on a shape that is not on
 * the ladder — a hand-resized machine says what it is, and the screen does
 * not claim it is standing on the nearest rung.
 */
export interface WorkspaceAgentMachineAnswer {
  awake: boolean;
  /**
   * Fly is moving it between states — the seconds after a resize, on a
   * sleeping machine as much as a running one (measured: a second or two
   * asleep, four or five awake, on a tiny image). Neither awake nor asleep,
   * nothing may be written to it until it settles, and a read taken inside
   * that window still reports the OLD shape — so a screen that shows this
   * has to read again rather than draw a conclusion from it.
   */
  restarting?: boolean;
  region?: string;
  regionName?: string;
  cpuKind?: string;
  cpus?: number;
  memoryMb?: number;
  /** The catalog id this machine's shape matches, when one does. */
  current?: string;
  /** The durable home volume, in GB — what a resize does NOT touch. */
  storageGb?: number;
  sizes: WorkspaceMachineSize[];
  /** False when this backend cannot resize machines; the screen then reads. */
  canResize: boolean;
  disclaimer: string;
}

/** POST api/agents/:id/machine */
export interface WorkspaceAgentMachineRequest { size: string }
export interface WorkspaceAgentMachineWritten extends WorkspaceAgentMachineAnswer {
  ok: true;
  /** False when the machine was already this shape — no reboot was spent. */
  changed: boolean;
  /**
   * The machine was AWAKE when the write landed, so it is rebooting onto the
   * new shape rather than simply waking up different next time. Its own
   * field because `awake` above is the read taken straight after the write,
   * and inside Fly's transitional window that read says neither.
   */
  restarted: boolean;
}

/**
 * GET api/agents/:id/prs — every proposal this agent made, of BOTH kinds,
 * each half newest first. Two arrays rather than one merged list, exactly as
 * the state payload carries them: the two rows say different things (a
 * branch and a repository; the pages a change would touch), and only the
 * screen knows how it wants them ordered against each other.
 *
 * `canDecide` is absent here on purpose: this list is the agent's HISTORY
 * across repositories, and the decision lives on the proposal's own
 * screen. Home's queue is the surface that filters by who decides.
 */
export interface WorkspaceAgentProposalsAnswer {
  prs: Array<Omit<WorkspaceProposalRow, 'canDecide'> & { canDecide?: boolean }>;
  knowledgeProposals: Array<Omit<WorkspaceKnowledgeProposalRow, 'canDecide'> & { canDecide?: boolean }>;
}

/**
 * `GET api/decisions` (note #721): every proposal waiting on this viewer in
 * the whole workplace — the queue the Workspace shows.
 */
export interface WorkspaceDecisionsAnswer {
  prs: WorkspaceProposalRow[];
  knowledgeProposals: WorkspaceKnowledgeProposalRow[];
}

/** One file carried by a chat message. */
export interface WorkspaceChatFile {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** A picture's pixel size, so the row is drawn at its final height before
   *  the bytes arrive (note #302). Absent for anything that is not a picture
   *  and for pictures stored before it was recorded. */
  width?: number;
  height?: number;
}

/** One row of the transcript. `role` decides how it is drawn: the owner's own
 *  words verbatim, an agent's (or a peer's) as Markdown, everything else as a
 *  platform receipt. */
export interface WorkspaceChatMessage {
  seq: number;
  role: 'owner' | 'agent' | 'platform';
  text: string;
  at: string;
  files?: WorkspaceChatFile[];
  /** Legacy single-file row, normalized by the reader. */
  file?: WorkspaceChatFile;
  /** The Workspace screen this row opens — the proposal it is about. */
  open?: { pr?: string; kp?: string };
  /** Stored pointer plus its current durable answer. The card is in chat;
   *  there is intentionally no route or detail screen behind it. */
  mailApprovalId?: string;
  mailApproval?: WorkspaceMailApproval;
  /** A peer agent's picture, when the pool really has one for that name. */
  fromAvatarUrl?: string;
  /** The fresh-chat marker: punctuation, not a platform event. */
  kind?: string;
}

/** GET api/agents/:id/chat?after= — the incremental transcript read. The
 *  working flag, the activity line and the context fill ride along so the
 *  status line and the rows can never be two requests that disagree. */
export interface WorkspaceChatAnswer {
  messages: WorkspaceChatMessage[];
  working: boolean;
  /** The agent's machine is being rebuilt before a message can start its
   *  turn (note #658) — a send is waiting on it. Absent otherwise. */
  preparing?: boolean;
  activity?: string;
  activitySince?: string;
  context?: WorkspaceAgentContext;
  /** The latest completed turn and its recap, for the line under it (note #945). */
  lastTurn?: import('./turn-recap.js').WorkspaceTurnRecap;
}

/** One durable process the agent deliberately left running beyond its turn.
 *  Commands are reduced and redacted on the agent machine before they cross
 *  into the Workspace; the browser never receives the job's argv or output. */
export interface WorkspaceManagedJob {
  id: string;
  label: string;
  startedAt: string;
}

/** How a durable job ended, in the machine CLI's own vocabulary. */
export type WorkspaceManagedJobOutcome =
  'succeeded' | 'failed' | 'timed_out' | 'stopped' | 'interrupted';

/** A job that has already ended (note #564) — kept on the details page for a
 *  day so "what happened to it" has an answer after the live row is gone. */
export interface WorkspaceSettledJob extends WorkspaceManagedJob {
  status: WorkspaceManagedJobOutcome;
  finishedAt: string;
}

/** GET api/agents/:id/jobs — `jobs` is the durable work running NOW, which is
 *  all the chat's strip counts; `recent` is the newest few outcomes, absent
 *  when there are none or the machine's CLI predates them. */
export interface WorkspaceAgentJobsAnswer {
  jobs: WorkspaceManagedJob[];
  recent?: WorkspaceSettledJob[];
}

/** GET api/agents/:id/chat/latest — the last exact agent reply, for the
 *  details screen's Last reply section. */
export interface WorkspaceChatLatestAnswer {
  message: { text: string; at: string } | null;
}

/** GET api/agents/:id/chat/files/:fileId — a short-lived URL for one file. */
export interface WorkspaceChatFileAccessAnswer {
  url: string;
  fileName?: string;
  expiresAt?: string;
  /** The size of a picture whose row did not carry one: measured on this
   *  read and written back, so the frame is drawn before the bytes land. */
  width?: number;
  height?: number;
}

/**
 * The largest Markdown file a chat draws (note #677): the cap Drive's text
 * preview keeps, for the same reason — a document is read on a phone, and
 * one this size is a generated data set, not a write-up. Past it the row
 * stays a download.
 */
export const CHAT_FILE_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** GET api/agents/:id/chat/files/:fileId/text — a Markdown file's words,
 *  as data for the Workspace's own renderer (note #677). */
export type WorkspaceChatFileTextAnswer =
  | { kind: 'markdown'; fileName: string; content: string }
  | { kind: 'too-large'; fileName: string; maxBytes: number }
  | { kind: 'unsupported'; fileName: string };

/** POST api/agents/:id/chat */
export interface WorkspaceChatSendAnswer { ok: true; name: string; steered: boolean }

/**
 * POST api/agents/:id/message — one message to an IDLE agent, the door the
 * Resume and "reset chat" asks go through. A busy agent is a 409 rather than
 * a queue: a message accepted "for later" hides an unbounded wait behind a
 * green button. The agent answers in its own chat, which is why the screen
 * says so.
 *
 * `name` is what the SERVER calls the recipient, and a caller falls back to
 * the name it already has: the route can prove it sent the message, not that
 * it resolved a display name for it.
 */
export interface WorkspaceIdleMessageAnswer { ok: true; name?: string }

/** POST api/agents/:id/stop — `stopped: false` means the turn beat the tap. */
export interface WorkspaceAgentStopAnswer { ok: true; stopped: boolean; name: string }

/** One model, with the efforts THAT model supports — never a CLI-wide list. */
export interface WorkspaceRuntimeModel {
  value: string;
  label: string;
  /** `heavy` marks a level that spends far more compute than the ones below
   *  it (note #482) — the picker says so on the row before it is tapped. */
  efforts: Array<{ value: string; label: string; heavy?: boolean }>;
}

/** GET api/agents/:id/runtime, and the echo a POST to it returns. */
export interface WorkspaceAgentRuntimeAnswer {
  cli: string;
  model: string;
  effort: string;
  models: WorkspaceRuntimeModel[];
}

export interface WorkspaceAgentRuntimeWritten extends WorkspaceAgentRuntimeAnswer { ok: true }

/** POST api/agents — the harness pick, made once and kept for life. */
export interface WorkspaceAgentCreateRequest { cli: string }
export interface WorkspaceAgentCreatedAnswer { ok: true }

/** DELETE api/agents/:id */
export interface WorkspaceAgentDeletedAnswer {
  ok: true;
  name: string;
  machine?: unknown;
  remaining?: number;
}

/** POST api/agents/:id/seat — `{ seatId: '' }` puts the agent back on the
 *  workplace default (note #773); the answer is the pin as now stored. */
export interface WorkspaceAgentSeatAnswer { ok: true; seatId: string | null }

/**
 * A schedule as a screen or the CLI reads it (note #779): one per agent,
 * proposed by an agent and decided by the owner on the agent's screen.
 * `awake` says the schedule is holding the agent's machine awake right now
 * — the cost of the thing, said out loud.
 */
export interface WorkspaceScheduleView {
  id: string;
  agentId: string;
  agentName: string;
  status: 'proposed' | 'active' | 'paused' | 'rejected';
  pause?: { reason: 'owner' | 'workspace-agent' | 'cap' | 'failures' | 'subscription'; at: string; until?: string; detail?: string; text: string };
  message: string;
  everyMinutes: number;
  windowFrom: string;
  windowTo: string;
  timeZone: string;
  capTurns?: number;
  capTokens?: number;
  /** "every 8 minutes, 07:00–23:00 America/Los_Angeles, at most 120 turns a day" */
  summary: string;
  day: { date: string; turns: number; tokens: number; skipped: number; failed: number; resets: number };
  failStreak: number;
  nextTickAt?: string;
  lastTickAt?: string;
  lastOutcome?: 'ran' | 'skipped' | 'reset' | 'failed' | 'no-machine';
  /** The turn a tick started is still running. */
  ticking: boolean;
  awake: boolean;
  proposedBy: { agentId: string; name: string };
  createdAt: string;
  decidedAt?: string;
}

/** GET api/agents/:id/schedule — null when the agent has none. */
export interface WorkspaceAgentScheduleAnswer { schedule: WorkspaceScheduleView | null }
/** POST api/agents/:id/schedule/decision — `{ decision }`; `remove` answers null. */
export type WorkspaceScheduleDecision = 'approve' | 'reject' | 'pause' | 'resume' | 'remove';
// ── Decisions: change and knowledge proposals (slice 4) ─────────────────────
//
// The two screens behind the Home queue. Both answer the same question about
// the same kind of author, so their payloads share the margin, the runtime
// line and the decision shape; what differs is what is being decided — a
// patch on a branch, or a page as it would read.

/** The runtime a proposal's or a remark's author will answer with, resolved
 *  now rather than as the defaults it was stored with. */
export interface WorkspaceAgentRuntime {
  cli: string;
  model?: string;
  effort?: string;
}

/** One remark in a margin (note #66): an agent's, or a person's own. Either
 *  half of the signature may be missing and the line still reads. */
export interface WorkspaceMarginComment {
  /** Stable stored identity. Older payload fixtures may omit it, in which
   *  case the comment remains readable but cannot offer an edit action. */
  id?: string;
  /** Semantic HTML, rebuilt node by node through the page allowlist — never
   *  handed to a browser as markup. */
  text: string;
  createdAt: string;
  editedAt?: string;
  agentName?: string;
  agentAvatarUrl?: string;
  agentRuntime?: WorkspaceAgentRuntime;
  /** Present exactly when the face is a door: the viewer's own agent. */
  agentId?: string;
  /** An agent wrote it, and the workplace no longer has that agent (note
   *  #705). `agentName` is then the name the work ledger last knew it by, or
   *  absent; `userName` is still its driver — never the author. */
  formerAgent?: boolean;
  userName?: string;
  userPhotoUrl?: string;
  byPerson?: boolean;
  authorUserId?: string;
  /** The plain source for the current person's own comment editor. It is not
   *  sent for anybody else's words. */
  editableText?: string;
  /** This person wrote the comment directly, so a live margin may offer its
   *  edit action. An owned agent's comment is deliberately not `self`. */
  self?: boolean;
}

/**
 * POST …/comments — the whole thread back, and nothing else.
 *
 * A comment starts no agent at all (note #518), not even the one that opened
 * the proposal it is written on. It is a durable remark ON a document, read
 * by whoever opens that document next; asking an agent to act on it is a
 * message to that agent, in its own chat, where the request arrives with the
 * rest of what is being asked. So there is no delivery to report, and the
 * thread back is the whole answer.
 */
export interface WorkspaceCommentPostRequest {
  text: string;
}
export interface WorkspaceCommentPostAnswer {
  ok: true;
  comments: WorkspaceMarginComment[];
}

/** One action a change ran through, as every screen that lists checks shows
 *  it. `logTail` is the only artifact a failed check has. */
export interface WorkspaceCheckRow {
  context: string;
  state: WorkspaceCheckState | string;
  description?: string;
  startedAt: string;
  completedAt?: string;
  logTail?: string;
}

/** A file the proposing agent attached as evidence. Read-only: the reader on
 *  this screen is the one being shown it. */
export interface WorkspaceProposalAttachment {
  id: string;
  fileName: string;
  contentType?: string;
  sizeBytes: number;
  addedAt: string;
  /** A picture's pixel size, so its frame is drawn at the right shape before
   *  the bytes arrive (note #825). Absent for anything that is not a picture. */
  width?: number;
  height?: number;
  /**
   * For a picture the sheet is about to draw: the signed URL to draw it
   * from, carried in the proposal's own answer so the picture starts
   * downloading the moment the sheet has its words — not after a further
   * round trip per picture (note #825). The same URL is handed out for most
   * of its life and the bytes go out cacheable, so a sheet reopened within
   * it draws from the browser's cache. Only the detail carries it; the queue
   * row never mints anything.
   */
  preview?: { url: string; expiresAt: string };
}

/** GET api/prs/:id/files/:file — a short-lived URL for one attachment. */
export interface WorkspaceFileAccessAnswer {
  url: string;
  fileName: string;
  expiresAt: string;
}

/** The proposal itself, as its own screen reads it: the queue row's fields
 *  plus everything only the detail knows. */
export interface WorkspaceProposalDetailRecord extends Omit<WorkspaceProposalRow, 'checks' | 'canDecide'> {
  canDecide: boolean;
  commitSubjects?: string[];
  decisionNote?: string | null;
  agentRuntime?: WorkspaceAgentRuntime;
  /** The notes this change implements (note #206), named where the record has
   *  them and numbered where it does not. */
  quickNoteNumbers?: number[];
  quickNotes?: Array<{ number: number; title?: string }>;
  attachments?: WorkspaceProposalAttachment[];
  comments?: WorkspaceMarginComment[];
}

export interface WorkspaceProposalCommit {
  sha?: string;
  subject: string;
  at?: string;
}

/** The protected-branch run that starts after a proposal lands. */
export interface WorkspaceProposalDelivery {
  sha?: string;
  branch: string;
  mergedAt: string | null;
  checks: WorkspaceCheckRow[];
  live: boolean;
  /** Whether the repository's CI is on (note #662). Off, a push starts no
   *  run at all, so nothing will ever report on this landing — the screen
   *  says so at once instead of waiting six minutes for rows that cannot
   *  come. Absent from a backend that predates the field: read as unknown. */
  ci?: boolean;
}

/** GET api/prs/:id — the whole screen in one read. The patch is the FROZEN
 *  half: what the reader decides on is what they were shown, pinned by
 *  `headSha`, which the approval sends back. */
export interface WorkspaceProposalDetailAnswer {
  pr: WorkspaceProposalDetailRecord;
  checks: WorkspaceCheckRow[];
  patch: string | null;
  patchTruncated: boolean;
  commits: WorkspaceProposalCommit[];
  diffStat?: { files?: number; insertions: number; deletions: number };
  headSha: string;
  requireChecks: boolean;
  /** The repository's CI switch, before there is a landing to carry it: an
   *  approval draws its After approval card from this until the server's
   *  own delivery record arrives. */
  ci?: boolean;
  delivery?: WorkspaceProposalDelivery;
  compareError?: string;
}

/** GET api/prs/:id/delivery — the changing half of a decided proposal,
 *  without re-running its git compare every five seconds. */
export interface WorkspaceProposalDeliveryAnswer {
  status: string;
  decidedAt: string | null;
  delivery: WorkspaceProposalDelivery | null;
}

/** POST api/prs/:id/decision */
export interface WorkspaceProposalDecisionRequest {
  decision: 'approve' | 'reject';
  /** The sha this screen's diff described, so what merges is what was read. */
  headSha?: string;
  note?: string;
}
export interface WorkspaceProposalDecisionAnswer {
  ok: true;
  /** Null when the flow refused to act at all. */
  status?: string | null;
  /** Why it refused, when it did. */
  note?: string | null;
}

/** One page a knowledge proposal would change. `currentHtml` is what the page
 *  says NOW — the diff is built in the browser from both versions. */
export interface WorkspaceKnowledgeChange {
  /** On a rename this is the name the page has TODAY; `renameTo` is where it
   *  is going. */
  page: string;
  /** `edit` is the store's word; the screen says "Update" (see the label). */
  action: 'create' | 'edit' | 'delete' | 'rename';
  /** Where a rename puts the page. Its words are unchanged, so this — with
   *  `page` — is the whole of what the reader is deciding. */
  renameTo?: string;
  title?: string;
  description?: string;
  html?: string;
  currentHtml?: string;
  /** The files this change would leave the page with, as name → signed URL. */
  files?: Record<string, string>;
  /** The page moved after the proposal was written, so it cannot land. */
  moved?: boolean;
}

export interface WorkspaceKnowledgeProposalRecord extends Omit<WorkspaceKnowledgeProposalRow, 'canDecide'> {
  canDecide: boolean;
  /** The human driving the proposing agent, when this workspace can name
   *  them: the parenthetical half of the signature (note #80). */
  userName?: string;
  note?: string;
  summary?: string;
  decisionNote?: string;
  agentRuntime?: WorkspaceAgentRuntime;
  comments?: WorkspaceMarginComment[];
}

/** GET api/knowledge/proposals/:id */
export interface WorkspaceKnowledgeProposalDetailAnswer {
  proposal: WorkspaceKnowledgeProposalRecord;
  changes: WorkspaceKnowledgeChange[];
}

/** POST api/knowledge/proposals/:id/decision */
export interface WorkspaceKnowledgeDecisionRequest {
  decision: 'approve' | 'reject';
  note?: string;
}
export interface WorkspaceKnowledgeDecisionAnswer {
  ok: true;
  status?: string | null;
  note?: string | null;
}

// ── Knowledge pages (slice 6) ───────────────────────────────────────────────
//
// The pages themselves, as opposed to the proposals that change them: the
// list Home glimpses and the Knowledge screen holds whole, and one page as
// the screen that RENDERS it reads it.

/** One page as a list lists it: what it is called, what it is for, and the
 *  agent whose proposal last landed it. Six agents write into one knowledge
 *  base, which is why the face is worth carrying on the row. Both agent
 *  fields are dropped for an agent the fleet no longer has. */
export interface WorkspaceKnowledgePageRow {
  name: string;
  title: string;
  description: string;
  sizeBytes: number;
  /** The blob's sha — what a proposal pins to detect that a page MOVED. */
  sha: string;
  updatedAt?: string;
  updatedByAgentId?: string;
  agentName?: string;
  agentAvatarUrl?: string;
  /** WHICH agent, when the workplace has a screen to open for it (note
   *  #640) — sent exactly when the face on the row is a door, which is never
   *  for an agent the workplace no longer has. */
  agentId?: string;
}

/** One page, whole. The html travels as SOURCE and the screen builds it into
 *  elements through the same allowlist a proposal's preview uses — nothing a
 *  page carries ever becomes markup. */
export interface WorkspaceKnowledgePageRecord {
  name: string;
  html: string;
  /** Absent when the page's own front matter could not be read; the screen
   *  falls back to the name, which is what addresses it anyway. */
  title?: string;
  description?: string;
  /** The page's own files as name → short-lived URL, for `files/chart.png`. */
  files?: Record<string, string>;
  /** Present — empty included — exactly when this backend keeps a margin. */
  comments?: WorkspaceMarginComment[];
  /** Every landed version of the page, newest first (note #746). */
  history?: WorkspaceKnowledgeVersionRow[];
}

/** One landed change to a page (note #746): who, when, why — and whether it
 *  can be put back. */
export interface WorkspaceKnowledgeVersionRow {
  number: number;
  action: 'create' | 'edit' | 'delete' | 'rename';
  renameTo?: string;
  title: string;
  note?: string;
  at: string;
  agentName: string | null;
  agentAvatarUrl?: string;
  agentId?: string;
  /** A restore of an earlier version. */
  restore?: true;
  /** Decided by the person, before changes applied at once. */
  approved?: true;
  /** Whether "put back to the version before this" is possible. */
  canRestore: boolean;
}

/** GET api/knowledge/pages/:name */
export interface WorkspaceKnowledgePageAnswer {
  page: WorkspaceKnowledgePageRecord;
}

/** POST api/knowledge/pages/:name/restore — { to?: number } */
export interface WorkspaceKnowledgeRestoreAnswer {
  ok: true;
  /** The page as it stands now; absent when it was removed by the restore. */
  page?: WorkspaceKnowledgePageRecord;
  number: number;
}

// ── Workplaces, seats, sites, secrets, profile (slice 8) ─────────

/** GET auth/sessions */
export interface WorkspaceBrowserSessionRow {
  sessionId: string;
  userId: string;
  authMethod: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  userAgent?: string;
  revokedAt?: string;
  current: boolean;
}
export interface WorkspaceBrowserSessionsListAnswer { sessions: WorkspaceBrowserSessionRow[] }
export interface WorkspaceBrowserSessionRevokeAnswer { revoked: boolean }

/** POST api/profile */
export interface WorkspaceProfileNameRequest { firstName: string; lastName: string }
export interface WorkspaceProfileNameAnswer { ok: true; name: string }
/** POST api/profile/photo (raw image body) */
export interface WorkspaceProfilePhotoAnswer { ok: true; photoUrl?: string }
export interface WorkspaceOkAnswer { ok: true }

/** POST api/org */
/** POST api/org — the public handle is derived from the name, never asked for (public-addresses). */
export interface WorkspaceOrgCreateRequest { name: string }
export interface WorkspaceOrgCreateAnswer { ok: true; orgId: string; name: string; handle?: string }
/** POST api/org/name — admin-only, for the workplace named by the request scope. */
export interface WorkspaceOrgNameRequest { name: string }
export interface WorkspaceOrgNameAnswer { ok: true; orgId: string; name: string }
/** POST api/org/active */
export interface WorkspaceOrgActivateRequest { orgId: string }
export interface WorkspaceOrgActivateAnswer { ok: true; orgId: string; name: string }

export interface WorkspaceOrgMember {
  userId: string;
  name: string;
  photoUrl?: string;
  you: boolean;
  role: 'admin' | 'member' | string;
  joinedAt: string;
  invitedByName?: string;
  /** The address they are reached at (note #626): their sign-in email, or
   *  their own address on the mail domain. Every member reads it on every
   *  row (note #632); absent only when they have neither. */
  email?: string;
  /** HOW MANY agents they drive in this workplace (note #346). */
  agents: number;
  /** And which (2026-09-23): a person's agents are never hidden from the
   *  rest of the workplace — name and face, and since 2026-10-28 what
   *  each is doing (working or not, and its latest-work line). Absent from
   *  an older backend. */
  agentFaces?: WorkspaceOrgMemberAgent[];
  /** How long their agents have worked in this workplace, for life,
   *  milliseconds (note #644): the Workspace Agent and deleted agents
   *  included. Counted since the day the platform began counting. */
  workedMs: number;
  /** Agents they no longer have whose hours are in `workedMs`, by name,
   *  longest first — the one place a deleted agent is still named. Absent
   *  when there are none. */
  formerAgents?: Array<{ name: string; workedMs: number }>;
  /** What their agents did in this workplace this week (note #925): every
   *  member reads every member's. Absent from an older backend. */
  contribution?: WorkspaceMemberContribution;
  /** The People page's live half (note #328) — the same fields
   *  `api/org/people/live` carries, so a row opens on facts and the tick
   *  only ever changes them. */
  lastSeenAt?: string;
  /** Present exactly when the Workspace is open in front of them right now. */
  here?: true;
  recap?: string;
  recapAt?: string;
}

/** GET api/org/people/live — what changes between ticks on the People page,
 *  and nothing else: one membership read per tick, no profile or picture. */
export interface WorkspacePersonLive {
  userId: string;
  lastSeenAt?: string;
  here?: true;
  recap?: string;
  recapAt?: string;
  /** Every agent they drive here, with what moves (2026-10-28) — all of
   *  them, so an agent missing from it has gone. Absent from an older backend. */
  agents?: WorkspacePersonAgentLive[];
  /** Their week's contribution, as the full read says it (note #925), so the
   *  card's numbers move without a reload. Absent from an older backend. */
  contribution?: WorkspaceMemberContribution;
}
export interface WorkspacePeopleLiveAnswer { people: WorkspacePersonLive[] }

/**
 * What a person's agents did in ONE workplace (note #925): the builder
 * page's three numbers (shared/leaderboard.ts) — agent hours, changes
 * merged, tokens written — counted only from agents working here and
 * proposals merged in this workplace's repositories, so a person's other
 * workplaces never show. Inside the workplace only: nothing here is public.
 */
export interface WorkspaceContributionNumbers {
  /** Agent working time, milliseconds (the Workspace Agent's included). */
  workingMs: number;
  /** Proposals merged whose proposing agent is theirs. */
  merged: number;
  /** OUTPUT tokens per provider, never added together; a provider absent
   *  when it wrote none here. */
  tokens: Partial<Record<'claude' | 'codex' | 'opencode', number>>;
}

/** One merged change, as a contribution names it: what it was called, which
 *  of their agents made it and when it landed. `id` opens the proposal. */
export interface WorkspaceContributionChange {
  id: string;
  title: string;
  /** When it was merged. */
  at: string;
  /** "PR #12", per repository. */
  number: number;
  /** The repository's name, when it still has one. */
  repo?: string;
  /** The agent that proposed it, by its name at the time; absent when that
   *  is no longer known. */
  agentName?: string;
}

/** A person's week on their card (note #925): the numbers since Monday
 *  00:00 UTC and the latest change merged in it, absent when there was none. */
export interface WorkspaceMemberContribution {
  week: WorkspaceContributionNumbers;
  latest?: WorkspaceContributionChange;
}

/** GET api/org/members/:userId/contribution — the member's screen (note
 *  #925): this week, all time, and every change merged this week, newest first. */
export interface WorkspaceMemberContributionAnswer {
  /** This week's Monday, UTC, `YYYY-MM-DD`. */
  weekStart: string;
  /** The first day tokens were counted by day (LEADERBOARD_DAYS_FROM): all
   *  time's tokens start there; its hours and merges go back further. */
  tokensFrom: string;
  week: WorkspaceContributionNumbers;
  allTime: WorkspaceContributionNumbers;
  merged: WorkspaceContributionChange[];
}

/** GET api/org/people — the people of the active workplace and the
 *  workplace they belong to, for every list that draws them (Home's
 *  people section, the People page). The workplace's own RECORD —
 *  invites, join requests, git and cloud facts — stays on `api/org`. */
export interface WorkspacePeopleAnswer {
  org: {
    orgId: string;
    name: string;
    role: 'admin' | 'member' | string;
    avatarUrl?: string;
    /** How long every agent of this workplace has worked, for life,
     *  milliseconds (note #644) — removed members' and deleted agents' too. */
    workedMs: number;
  };
  people: WorkspaceOrgMember[];
}

/** An invite link. It lives until an admin revokes it — there is no expiry. */
export interface WorkspaceOrgInvite {
  token: string;
  link: string | null;
  createdAt: string;
}

export interface WorkspaceOrgGitHost {
  app?: string;
  health?: 'ok' | 'waking' | 'unreachable' | string;
  diskUsedPercent?: number;
  volumeSizeGb?: number;
  snapshotRetentionDays?: number;
  growByGb: number;
  growMonthlyUsd: number;
  repoMaxBytes: number;
  repoMaxBytesAfterGrow: number;
}

/** One backup run, as a page reports it: when, and whether it worked. */
export interface WorkspaceBackupRun {
  at: string;
  ok: boolean;
}

export interface WorkspaceOrgGit {
  repoCount: number;
  totalSizeBytes: number;
  host?: WorkspaceOrgGitHost;
  /** The org's OWN bucket, for an org with a git host of its own. */
  backup?: { bucket?: string; everyHours: number; last?: WorkspaceBackupRun };
}

/**
 * What the PLATFORM's own nightly jobs last managed, for the parts of an org
 * that live with the platform rather than in its cloud (note #357). Every org
 * has a `workspace` run — chats, notes and proposals are the platform's to
 * keep however the code is hosted; `code` appears only for an org still on the
 * central git host, whose repos those nightly bundles cover. An org with a
 * host of its own reads its code's backups off `git.backup` instead.
 *
 * Times and outcomes only. The jobs' own detail lines ("7 repos, 0 failures")
 * count the whole fleet, which is nobody's org's business.
 */
export interface WorkspacePlatformBackup {
  code?: WorkspaceBackupRun;
  workspace?: WorkspaceBackupRun;
}

/** One part of a private copy, asked live (note #813). */
export interface WorkspaceCopyHealthPart {
  key: 'workspace' | 'licence' | 'database' | 'disk' | 'code-host' | 'previews' | 'mail-in';
  name: string;
  ok: boolean;
  line: string;
}

/**
 * Whether a newer release exists (note #1005): `current` (green, up to
 * date), `behind` (amber, a newer one is out), `unknown` (the update service
 * not reached lately, or the running release is not known), `off` (the
 * company turned the check off with COPY_UPDATES_URL=off).
 */
export type WorkspaceCopyUpdatesState = 'current' | 'behind' | 'unknown' | 'off';

export interface WorkspaceCopyUpdates {
  state: WorkspaceCopyUpdatesState;
  running: string | null;
  latest: string | null;
  /** When the update service last answered well. */
  reachedAt: string | null;
  /** When it was last asked. */
  triedAt: string | null;
  /** Why the last ask failed, in words. */
  lastError: string | null;
  /** How to upgrade today, in one sentence; only when `behind`. */
  howToUpgrade: string | null;
}

/** One release on the What's new screen (note #1006). */
export interface WorkspaceCopyRelease {
  version: string;
  date: string | null;
  /** The notes' title line, from the update service's list. */
  summary: string | null;
  /** The notes, as written (Markdown); null when they could not be read. */
  notes: string | null;
  /** The release this copy runs. */
  running: boolean;
}

/** GET api/copy/releases — a private copy only, for its admins (note
 *  #1006): every release newer than the running one, newest first, then the
 *  running one itself. */
export interface WorkspaceCopyReleases {
  updates: WorkspaceCopyUpdates;
  releases: WorkspaceCopyRelease[];
}

/** One step of an upgrade, as the progress screen lists it (note #1008). */
export interface WorkspaceCopyUpgradeStep {
  key: string;
  label: string;
  state: 'done' | 'now' | 'wait' | 'fail';
  seconds: number | null;
  /** A step of the way back (putting the old release back). */
  back: boolean;
}

/** One upgrade run, read from the run record in the backup bucket (note #1008). */
export interface WorkspaceCopyUpgradeRun {
  id: string;
  requestedBy: string | null;
  from: string | null;
  to: string | null;
  drill: 'rollback' | 'backend' | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** starting → running → (putting-back) → an outcome; stopped when its upgrader went quiet. */
  phase: 'starting' | 'running' | 'putting-back' | 'stopped' | 'done' | 'put-back' | 'drill-done' | 'unchanged' | 'failed';
  heardSecondsAgo: number | null;
  message: string | null;
  snapshotAt: string | null;
  steps: WorkspaceCopyUpgradeStep[];
}

/** GET api/copy/upgrade — the Upgrade button and its run, for a copy's admins (note #1008). */
export interface WorkspaceCopyUpgradeState {
  running: string | null;
  latest: string | null;
  behind: boolean;
  /** The button, when an upgrade may start now. */
  offer: { version: string; date: string | null; agentsWorking: number; minutes: number } | null;
  /** Why there is no button although a newer release exists. */
  refusal: string | null;
  /** The open run, else the last one this Workspace started. */
  run: WorkspaceCopyUpgradeRun | null;
}

/** GET api/copy/health — a private copy only, for its admins (note #813). */
export interface WorkspaceCopyHealth {
  release: string | null;
  commit: string | null;
  /** The release this copy runs (the same as `release`) and the newest one
   *  the update service offers, for support reading the JSON (note #1005). */
  running: string | null;
  latest: string | null;
  updates: WorkspaceCopyUpdates;
  checkedAt: string;
  parts: WorkspaceCopyHealthPart[];
}

/** GET api/org */
export interface WorkspaceOrgDetail {
  orgId?: string;
  name: string;
  /** The workplace's public handle — `acme` for agenticcloudcomputer.com/acme (public-addresses). */
  handle?: string;
  role: 'admin' | 'member' | string;
  avatarUrl?: string;
  members: WorkspaceOrgMember[];
  /** Null unless the viewer is an admin on a backend that can mint links. */
  invites: WorkspaceOrgInvite[] | null;
  /** Only admins can see applicants, who are not yet members. */
  joinRequests?: WorkspaceOrgJoinRequest[] | null;
  /** Every admin gets the delete door, except on the platform's own workplace. */
  canDelete?: boolean;
  blocked?: string;
  deletion?: WorkspaceOrgDeletion;
  /**
   * The workplace's cloud account, and how the control plane reaches the
   * machines in it (note #642). `peer` states only what the record knows:
   * `routed-elsewhere` is the host already routing that network (org #0 —
   * reachable, no tunnel of our own wanted), `failed` is an attempt that
   * threw, and `unknown` is nobody having tried since outcomes were kept.
   * It was `'up' | 'pending'` until 2026-09-23, where "pending" was every
   * one of those three wearing a promise none of them could keep.
   */
  fly:
    | { connected: true; orgSlug: string; peer: 'up' | 'routed-elsewhere' | 'failed' | 'unknown' }
    /**
     * HOSTED (note #664): no cloud account of its own — its agents and sites
     * run on ours, free, up to these limits across the whole workplace.
     */
    | {
      connected: false;
      hosted: true;
      agents: { used: number; limit: number };
      sites: { used: number; limit: number };
      /** The platform marked this workplace to bring a Fly account of its
       *  own (note #801): an admin is offered the token form. */
      ownCloudAllowed?: true;
    };
  git?: WorkspaceOrgGit;
  /** Absent on a backend with no backup monitor behind it — nothing to claim. */
  platformBackup?: WorkspacePlatformBackup;
}
export interface WorkspaceOrgDetailAnswer { org: WorkspaceOrgDetail }
export interface WorkspaceOrgAvatarAnswer { ok: true; avatarUrl?: string }
export interface WorkspaceOrgGitVolumeAnswer { ok: true; sizeGb: number }
export interface WorkspaceOrgFlyRequest {
  orgSlug?: string;
  token: string;
  /**
   * Consent to a MOVE — this token belongs to a different Fly org than the
   * one connected, and everything already there is to be left behind (note
   * #372). A first connect and a token rotation never carry it.
   *
   * The SLUG that was agreed to, not a bare `true`: the question names an org
   * and the answer has to name the same one, or the yes is a yes to whatever
   * the second resolution happens to find.
   */
  replace?: string;
}
export interface WorkspaceOrgFlyAnswer {
  ok: true;
  orgSlug: string;
  appCount: number;
  peer: 'up' | 'pending' | 'route-conflict';
  /** The Fly org this replaced, when there was one. */
  previousSlug?: string;
  /** True when that was a different org — the machines in it stayed behind. */
  moved?: boolean;
}

/**
 * The other answer this route can give, and it is a QUESTION rather than a
 * failure — hence 200 and a discriminant, not an error body.
 *
 * The token is good; it simply belongs to a Fly org other than the one
 * connected, which is the one thing that cannot be known before Fly is asked.
 * Nothing has been written. The caller shows the admin where their token
 * actually points and what a move would leave behind, and sends the same
 * paste back with `replace` if they say yes.
 */
export interface WorkspaceOrgFlyMoveAsked {
  ok: false;
  move: {
    fromSlug: string;
    toSlug: string;
    appCount: number;
    /** What the workplace's own record says it would strand in `fromSlug`
     *  besides its machines: repositories, their backups, and every file on a
     *  note, page, proposal or chat. */
    leaves: { gitHost: boolean; gitBackup: boolean; media: boolean };
  };
}
export type WorkspaceOrgFlyResult = WorkspaceOrgFlyAnswer | WorkspaceOrgFlyMoveAsked;

/** GET api/org/cloud — connection facts and aggregate live machine counts for members. */
export interface WorkspaceCloudMachines {
  active: number;
  sleeping: number;
  checkedAt: string;
}
export interface WorkspaceOrgCloudAnswer {
  orgId: string;
  role: string;
  fly: WorkspaceOrgDetail['fly'];
  machines: WorkspaceCloudMachines | null;
  inventoryError?: string;
  /** Present only when Fly will not build in this workplace's own account
   *  until its billing is sorted (note #801): plain words and where to fix it. */
  billing?: { problem: string; fixUrl: string };
}

/**
 * GET api/org/agent-machine — the machine every new agent in this
 * workplace is built on, and the ladder it may be chosen from (note #355).
 *
 * Its own small read rather than a corner of the spend report: the report
 * calls Fly and takes seconds, and this answers from the workplace's own
 * record, so the choice is on the screen while the machines are still
 * arriving.
 */
export interface WorkspaceOrgAgentMachineAnswer {
  /** The rung in force — the org's choice, else the platform's default. */
  current: string;
  /** True when that is a choice somebody made, rather than the fallback. */
  chosen: boolean;
  sizes: WorkspaceMachineSize[];
  /** False for a member: the ladder is readable, the choice is an admin's. */
  canChoose: boolean;
  disclaimer: string;
}

/** POST api/org/agent-machine */
export interface WorkspaceOrgAgentMachineRequest { size: string }
export interface WorkspaceOrgAgentMachineWritten extends WorkspaceOrgAgentMachineAnswer {
  ok: true;
  /** False when the workplace was already building new agents on it. */
  changed: boolean;
}

/**
 * GET / PUT api/org/auto-approve (note #944): the READER's own auto-merge
 * switch in this workplace — each person turns theirs on and off, and it
 * covers only their own agents' proposals.
 */
export interface WorkspaceOrgAutoApproveAnswer {
  on: boolean;
  /** The last flip, absent while they have never touched the switch. */
  changedAt?: string;
  /** Every flip, newest first. */
  history?: Array<{ on: boolean; at: string }>;
}
export interface WorkspaceOrgAutoApproveRequest { on: boolean }

/** GET api/org/spend */
export interface WorkspaceOrgSpendMachine {
  app: string;
  machineId: string;
  /** `'ci'`: a machine that exists only while one check runs. */
  kind: 'agent' | 'site' | 'ci' | 'other';
  state: string;
  size: string;
  estimatedMonthlyUsd: number;
  runningMonthlyUsd: number;
  hourlyUsd: number;
  /** The agent this machine belongs to, wearing the same face its fleet row
   *  wears, and the human it works for where the profile names them. */
  agent?: { id: string; name: string; avatarUrl?: string; driver?: string };
  /** That agent has not recorded this machine yet: its setup made the app and
   *  is still finishing (note #375). Nothing meters it, and the agent's own
   *  awake time belongs to whatever machine it is actually running on. */
  settingUp?: boolean;
  /** Awake time this month, where it is known: an agent's from the sweep, a
   *  site's from Fly's last start, a check lane's summed over its runs. */
  activeMs?: number;
  /** What that awake time has cost, plus the month's storage — a fact, not a
   *  projection; present exactly when `activeMs` is known. */
  totalMonthlyUsd?: number;
  /** A check lane: how many runs this month the awake time is summed over. */
  runs?: number;
  /** A running site: when Fly last started it, which is where its awake time
   *  counts from (or the month's start, whichever is later). */
  awakeSince?: string;
}
export interface WorkspaceOrgSpendAnswer {
  orgSlug: string;
  machines: WorkspaceOrgSpendMachine[];
  totals: {
    estimatedMonthlyUsd: number;
    runningMonthlyUsd: number;
    /** Every row's month-to-date figure added up — a sum of facts, never of
     *  projections, which is what lets it stand at the top of the screen. */
    spentThisMonthUsd: number;
    /** Rows nothing meters, which that sum leaves out. */
    unmeasured: number;
    running: number;
    stopped: number;
  };
  /** Whether the agent records behind these names were read at all. False
   *  makes every row look unclaimed, so the screen offers no removal on one
   *  (note #375). */
  namesRead: boolean;
  /** Machines in this account that belong to another workplace: counted,
   *  never listed, and in none of the totals (note #635). */
  machinesElsewhere: number;
  disclaimer: string;
}

/** DELETE api/org/machines/:app — take a machine no agent is on off the account. */
export interface WorkspaceOrgMachineRemoved {
  ok: true;
  /** The app that was destroyed, with the machines that went with it. */
  app: string;
  machines: number;
}

/** POST api/org/invites */
export interface WorkspaceOrgInviteCreatedAnswer { ok: true; invite: WorkspaceOrgInvite }
/** POST api/org/members/:userId/role */
export interface WorkspaceOrgRoleRequest { role: 'admin' | 'member' }
export interface WorkspaceOrgRoleAnswer { ok: true; role: 'admin' | 'member' }
/** DELETE api/org/members/:userId */
export interface WorkspaceOrgMemberRemovedAnswer { ok: true; retiredAgents: number }
/** DELETE api/org/membership */
export interface WorkspaceOrgLeftAnswer { ok: true; retiredAgents: number; activeOrgId: string | null }
/** DELETE api/org */
export interface WorkspaceOrgDeletedAnswer { ok: true; activeOrgId: string | null }


export type WorkspaceSeatStatus = 'active' | 'cooldown' | 'payment_required' | 'dead' | 'disabled';

export interface WorkspaceSeatWindow {
  label: string;
  usedPercent: number;
  percentText: string;
  trackText?: string;
  spend?: true;
  resetAt?: string;
  resetsText?: string;
  detailText?: string;
  /**
   * How long the WHOLE window is, when the provider says. With `resetAt` it
   * is the second half of a pace: the two together say how much of the
   * window has already gone by, which is what an even spend is measured
   * against (note #279).
   */
  windowMins?: number;
}

/** One seat as GET api/org/seats and the seat mutations describe it. */
export interface WorkspaceSeatRecord {
  seatId: string;
  provider: 'claude' | 'codex' | string;
  label: string;
  planText?: string;
  status: WorkspaceSeatStatus | string;
  attention?: 'payment_required';
  usageIsLastKnown?: true;
  subscriptionStatus?: string;
  subscriptionCheckedAt?: string;
  selected: boolean;
  createdAt: string;
  cooldownUntil?: string;
  usageRefreshedAt?: string;
  /** The same stamp the state read's row carries (`WorkspaceSeatUsage`, note #697). */
  updatedAt?: string;
  windows?: WorkspaceSeatWindow[];
  usageNotice?: string;
  /** Only on the `available` list: a private sign-in not assigned here. */
  assigned?: false;
}
/** GET api/org/seats */
export interface WorkspaceSeatsAnswer { seats: WorkspaceSeatRecord[]; available: WorkspaceSeatRecord[] }
/**
 * GET api/org/tokens — the tokens the CALLER's own agents spent, per week
 * (newest first), each provider (Claude, Codex, OpenCode) kept apart. Private like the sign-ins it
 * runs on: nobody else's, never anyone else's to read. `input` excludes the
 * cache for both providers; `output` includes thinking/reasoning, and
 * `reasoning` is the part of it Codex reports separately.
 */
export interface WorkspaceTokenUsageAnswer {
  /** The first day the weeks reach back to (a Monday, UTC). */
  since: string;
  weeks: Array<{
    start: string;
    providers: Array<{
      provider: 'claude' | 'codex' | 'opencode';
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
      models: string[];
    }>;
  }>;
}
/** POST api/org/seats/:seatId/check */
export interface WorkspaceSeatCheckAnswer { check: 'ready' | 'payment_required' | 'attention'; seat: WorkspaceSeatRecord }
/** POST api/org/seats/:seatId/assign */
export interface WorkspaceSeatAssignedAnswer { ok: true; seat: WorkspaceSeatRecord }
/** POST api/org/seats/order */
export interface WorkspaceSeatOrderRequest { provider: string; seatIds: string[] }

export type WorkspaceSeatSignInPhase =
  | { phase: 'done'; seatId: string; label: string; attention?: 'payment_required' }
  | { phase: 'failed'; reason: string }
  | { phase: string; [key: string]: unknown };

/** GET/POST api/org/signin, POST api/org/signin/code */
export interface WorkspaceSeatSignInStatus {
  provider: 'claude' | 'codex' | string;
  startedAt: string;
  state: WorkspaceSeatSignInPhase;
}
export interface WorkspaceSeatSignInAnswer { signin: WorkspaceSeatSignInStatus | null }
export interface WorkspaceSeatSignInStartRequest { provider: 'claude' | 'codex' | 'opencode' }
export interface WorkspaceSeatSignInCodeRequest { code: string }

/** One site as api/state lists it. */
export interface WorkspaceSiteRow {
  name: string;
  url?: string;
  iconUrl?: string;
  preset: string;
  status: string;
  kind: string;
  agentName?: string;
  agentAvatarUrl?: string;
  /** The agent whose screen the face opens (note #640), sent exactly when
   *  there is one to open. */
  agentId?: string;
  deleteAsk?: WorkspaceRepoAsk;
  createdAt: string;
  lastDeployAt?: string;
  /** Who last deployed it, in words (note #566): the agent by name, the
   *  reader's or a teammate's alike (2026-09-23). Absent until
   *  the first deploy after sites became the workplace's. */
  lastDeployedBy?: string;
  /** The same hand, as the screen draws it: name, face, and the door to the
   *  agent's page when the workplace still has it. */
  lastDeployer?: { agentName: string; agentAvatarUrl?: string; agentId?: string };
  /** The repository whose approved change that last deploy was, when CI
   *  published it on approval (`agentbuilt repo publish`) rather than an
   *  agent by hand. */
  lastDeployVia?: string;
}
/** DELETE api/sites/:name, POST api/sites/:name/keep */
export interface WorkspaceSiteNamedAnswer { ok: true; name: string }

/** One disk a site's app holds, priced from the spend view's table. */
export interface WorkspaceSiteDisk { sizeGb: number; monthlyUsd: number }

/**
 * One site's estimated monthly cost (note #993), read from the machine and
 * disks Fly reports for its app and priced by `config/fly-cost-estimates.ts`.
 * `read: false` means the machine or its disks could not be read: there is
 * no figure then, never a guess, and it is left out of the total.
 */
export interface WorkspaceSiteCost {
  name: string;
  preset: string;
  read: boolean;
  /** `false` for a reserved name with nothing built: it costs nothing. */
  built?: false;
  /** Why there is no figure: no machine found, or the read failed. */
  reason?: 'no-machine' | 'unreadable';
  machine?: {
    cpuKind: 'shared' | 'performance';
    cpus: number;
    memoryMb: number;
    /** Sites never sleep; false only for one paused or stopped by support. */
    running: boolean;
    /** The machine's share of the estimate: a full month while it runs, 0 stopped. */
    monthlyUsd: number;
    /** A stopped machine's shape, priced as if it ran — what it costs when back. */
    runningMonthlyUsd?: number;
  };
  /** The disk(s) its machine mounts. */
  disks?: WorkspaceSiteDisk[];
  /** Disks the app holds that no machine mounts — billed all the same. */
  spareDisks?: WorkspaceSiteDisk[];
  disksMonthlyUsd?: number;
  /** Machine plus every disk, per 30-day month. */
  monthlyUsd?: number;
}

/** GET api/sites/costs */
export interface WorkspaceSiteCostsAnswer {
  /** The workplace runs on the platform's cloud: the estimate is our cost, not its bill. */
  hosted: boolean;
  sites: WorkspaceSiteCost[];
  /** The sum over every site that was read. */
  monthlyUsd: number;
  /** Sites the sum leaves out because they could not be read. */
  unread: number;
  disclaimer: string;
}

/**
 * One object-storage bucket as api/state lists it (note #768): what the
 * owner sees of what their agents keep files in — and, for a public one,
 * that strangers can read it. Keys never cross.
 */
export interface WorkspaceBucketRow {
  name: string;
  /** Objects readable by anyone with the URL, or keys only. */
  public: boolean;
  /** The S3 bucket name Tigris gave it, which is in every public URL. */
  bucket: string;
  /** Where it lives: the platform's cloud, or the workplace's own. */
  hostedOn: 'platform' | 'org';
  createdAt: string;
  /** The agent that created it, in words. */
  createdBy?: string;
  agentName?: string;
  agentAvatarUrl?: string;
  agentId?: string;
  deleteAsk?: WorkspaceRepoAsk;
  /** Where its files are read from, for a PUBLIC bucket only (note #778). */
  publicUrl?: string;
  /** The four workplace secrets holding its endpoint, bucket name and keys —
   *  their NAMES; a value never crosses (note #778). */
  secretNames?: string[];
}
/** GET api/storage/:name/usage (note #778): what the bucket holds, read with
 *  its own keys on demand. No `usage` when the keys are gone or the read
 *  failed; `truncated` when the walk stopped early (the numbers are a floor). */
export interface WorkspaceBucketUsageAnswer {
  usage?: { bytes: number; objects: number; truncated: boolean };
}
/** DELETE api/storage/:name, POST api/storage/:name/keep */
export interface WorkspaceBucketNamedAnswer { ok: true; name: string }

/** One secret as api/state lists it: names and masks, never values. */
export interface WorkspaceSecretRow {
  name: string;
  maskedValue: string;
  maskedPreview: string;
  valueLength: number;
  valueKind?: string;
  description?: string;
  scope: 'shared' | 'agent';
  agentId?: string;
  agentName?: string;
  /** Shared rows (note #655): whose agents this key is handed to. */
  audience?: WorkspaceSecretAudience;
  /** Shared rows: the names of the agents in the workplace that receive it. */
  reaches?: string[];
  /** Shared rows the merge renamed (note #783): what it was called. */
  renamedFrom?: { name: string };
  updatedAt?: string;
  shadowedByAgentScope?: true;
  shadowedBy?: string[];
}
export type WorkspaceSecretAudience = 'admins' | 'everyone';
/** POST api/secrets — shared (admin; optional audience) or, with `?agent=`, private to one of the caller's own agents. */
export interface WorkspaceSecretWriteRequest { name: string; value: string; audience?: WorkspaceSecretAudience }
/** PATCH api/secrets/:name/audience */
export interface WorkspaceSecretAudienceRequest { audience: WorkspaceSecretAudience }
export interface WorkspaceSecretAudienceAnswer { ok: true; name: string; audience: WorkspaceSecretAudience }
export interface WorkspaceSecretWrittenAnswer { ok: true; created: boolean; name: string }
/** PATCH api/secrets/:name/description */
export interface WorkspaceSecretDescribeRequest { description: string }
export interface WorkspaceSecretNamedAnswer { ok: true; name: string }
/** GET api/secrets/:name/value — read only inside a copy gesture. */
export interface WorkspaceSecretValueAnswer { name: string; value: string }
// ── Notes (slice 5) ─────────────────────────────────────────────────────────
//
// A quick note is the one store on this account that a PERSON writes into
// without anybody being asked, so its payloads carry two authors at once: the
// agent (or member) whose words these are, and whoever last remarked on them.
// `byPerson` is the discriminator throughout — an agent's line names a human
// too, the driver behind it (note #177).

/**
 * What is happening to the request a note carries (notes #234/#258).
 *
 * `handed` and `working` are shaped alike on purpose: the row draws them the
 * same way and the difference between the two is one word in the label. The
 * agent id rides along whenever the workplace has a screen for that agent
 * (note #640) — which is what makes its face a door — and the face itself
 * comes with it, so a teammate's agent holding a note is a portrait rather
 * than the generic glyph.
 */
export type WorkspaceNoteWork =
  | { state: 'unclaimed' }
  | {
    state: 'handed' | 'working';
    agentName?: string;
    expiresAt?: string;
    agentId?: string;
    agentAvatarUrl?: string;
  }
  | { state: 'proposal' | 'merged' | 'live'; proposalNumber: number; proposalStatus?: string };

export interface WorkspaceNoteLiveClaim {
  id: string;
  /** Exactly what the full read puts on the row, face and door included, so
   *  an unchanged claim compares equal and repaints nothing. */
  work: {
    state: 'working';
    agentName?: string;
    agentAvatarUrl?: string;
    expiresAt?: string;
    agentId?: string;
  };
}

/** One file on a note. Names and sizes only — the bytes travel on their own
 *  short-lived signed URL, minted per tap. */
export interface WorkspaceNoteAttachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  addedAt: string;
  /** Who put it there, when the answer is a person: this reader, or another
   *  member. Absent for an agent's, like every other conditional field here. */
  byUser?: true;
  byMember?: true;
}

/** The one safe glimpse a compact row shows of what a note carries: the first
 *  photograph if there is one, else the first file at all. */
export type WorkspaceNoteAttachmentPreview = Pick<
  WorkspaceNoteAttachment, 'id' | 'fileName' | 'contentType' | 'sizeBytes'
>;

/** The newest remark, as a row previews it: the sentence with room to show,
 *  and the HTML it came from so emphasis inside that sentence survives. */
export interface WorkspaceNoteCommentPreview {
  html: string;
  text: string;
  agentName?: string;
  agentAvatarUrl?: string;
  byPerson?: true;
  userName?: string;
  userPhotoUrl?: string;
}

/** One note as every list draws it — home's glimpse, the notes screen, the
 *  archive and a search result. */
export interface WorkspaceNoteRow {
  id: string;
  number: number;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  /** Present only when a person wrote it: this reader (`byUser`) or another
   *  member (`byMember`). Absent, never false — a row says who touched a note
   *  or says nothing. */
  byUser?: true;
  byMember?: true;
  /** Present when the note stands on the READER's own side of the workplace:
   *  they wrote it, or an agent of theirs keeps it. It is a different question
   *  from `byUser` — that one is about the words — and it is what the verbs
   *  that take a note off somebody's desk are offered on (note #637). */
  yours?: true;
  memberName?: string;
  authorUserId?: string;
  authorName?: string;
  authorPhotoUrl?: string;
  /** Who KEEPS the note, and its face. Both dropped for an agent the fleet no
   *  longer has, which keeps the line and offers no door. */
  agentName?: string;
  /** Present when the reader's own agents may still rewrite these words — the
   *  rule the agent CLI's editor applies, answered here so the screen can name
   *  what the reader HAS instead of an Edit button (note #638). On a note whose
   *  author is gone from every fleet there is no `agentName` to ask, and
   *  whether anybody can rewrite it at all is the rest of that sentence. */
  agentsCanEdit?: true;
  agentId?: string;
  agentAvatarUrl?: string;
  /** The human behind that agent — the parenthetical half of the signature. */
  userName?: string;
  /** How many remarks and files hang off it, absent when none. */
  comments?: number;
  files?: number;
  lastComment?: WorkspaceNoteCommentPreview;
  attachmentPreview?: WorkspaceNoteAttachmentPreview;
  work?: WorkspaceNoteWork;
  /** When it was put away. Present on a row only ever drawn in the archive —
   *  which sounds redundant until a note is opened from a stale list. */
  archivedAt?: string;
}

/** The note itself, as its own screen reads it: the row's fields, plus the
 *  words, the margin whole, and the files. */
export interface WorkspaceNoteRecord extends Omit<WorkspaceNoteRow, 'comments'> {
  /** Semantic HTML, rebuilt node by node through the page allowlist. */
  html: string;
  /** The plain text the note was TYPED as — present only for a note this
   *  reader wrote, which is the only kind the Workspace edits. */
  text?: string;
  /** Present (empty included) exactly when this backend can hold files. */
  attachments?: WorkspaceNoteAttachment[];
  /** The remarks themselves; the row carries a COUNT in the same field. */
  comments: WorkspaceMarginComment[];
}

/** GET api/notes/:number */
export interface WorkspaceNoteDetailAnswer { note: WorkspaceNoteRecord }
/** GET api/notes/archive, GET api/notes/search?q= */
export interface WorkspaceNoteListAnswer { notes: WorkspaceNoteRow[] }

/** POST api/notes, PUT api/notes/:number — plain text in; the server does the
 *  markup, so the box asks for nothing a person would have to know. */
export interface WorkspaceNoteWriteRequest { text: string }
export interface WorkspaceNoteWriteAnswer { ok: true; note: WorkspaceNoteRow; title: string }

/** POST/DELETE api/notes/:number/archive, DELETE api/notes/:number */
export interface WorkspaceNoteArchiveAnswer { ok: true; number: number; title: string }

/** POST/DELETE api/notes/:number/files[/:id] */
export interface WorkspaceNoteFilesAnswer { ok: true; attachments: WorkspaceNoteAttachment[] }

/** POST api/notes/:number/handoff — the message goes AND the note records who
 *  it went to, in one request (notes #234/#258). 202: the turn has been
 *  admitted, not finished. */
export interface WorkspaceNoteHandoffRequest { agentId: string; message: string }
export interface WorkspaceNoteHandoffAnswer { ok: true; name: string; work: WorkspaceNoteWork }


// ── Repositories (slice 7) ──────────────────────────────────────────────────
//
// A repository has six addressable forms but five route kinds: root and
// folders share `repo` with a normalized `path` query, and files, history,
// contributors and commits have their own. Overview and Content are TABS on
// the same place, so the selection lives in history state rather than in a
// second URL (knowledge page "miniapp-navigation").

/** One writer of a repository, as the host counted them. `agentId` and the
 *  face are present exactly when the writer is one of this account's agents;
 *  a human's own commits and merge identities have neither. */
export interface WorkspaceRepoContributor {
  name: string;
  email: string;
  commits: number;
  insertions: number;
  deletions: number;
  agentId?: string;
  agentAvatarUrl?: string;
}

/** The three faces a repository ROW wears: no email, no numbers — the row has
 *  space for a picture and the full list is one tap in. */
export interface WorkspaceRepoRowFace {
  name: string;
  agentAvatarUrl: string;
  commits: number;
}

/** An agent has asked for something only the owner may decide. `canDecide` is
 *  false for a member looking at an admin's decision. */
export interface WorkspaceRepoAsk {
  at: string;
  canDecide: boolean;
  byAgentName?: string;
  /** Whose agent asked, when it is not the reader's (2026-09-23): the person
   *  the request waits on when this reader cannot decide it. */
  byOwnerName?: string;
}

/** What approved checks in a repository may use (`agentbuilt repo
 *  ci-secrets`). Granted at once by an admin's agent (note #739), so this is
 *  the owner's standing view, not a decision. Only names ride this payload;
 *  values stay in the encrypted store. */
export interface WorkspaceRepoCiSecrets {
  names: string[];
}

/** One repository as Home lists it. */
export interface WorkspaceRepoRow {
  name: string;
  cloneUrl: string;
  sizeBytes: number;
  contributors: WorkspaceRepoRowFace[];
  /** The default branch when it is protected, else null. */
  protectedBranch: string | null;
  createdAt: string;
  lastPushAt?: string;
  branch?: string;
  /** Said only of a landing the backend OBSERVED on the home branch — never
   *  inferred from a repo-level push. */
  branchPushAt?: string;
  /** Present only while anonymous read access is live. */
  publicUrl?: string;
  publishedAt?: string;
  deleteAsk?: WorkspaceRepoAsk;
  /** Present while a grant stands. */
  ciSecrets?: WorkspaceRepoCiSecrets;
  /** The live site approved changes publish on their own, by its current
   *  name. Absent while this repository is published by hand. */
  publishesTo?: string;
}

/** GET api/repos/:name/tree — `branch: null` means no commits yet. */
export interface WorkspaceRepoTreeEntry {
  name: string;
  type: 'dir' | 'file' | 'symlink' | 'submodule';
  sizeBytes?: number;
}
export interface WorkspaceRepoTreeAnswer {
  branch: string | null;
  entries: WorkspaceRepoTreeEntry[];
}

/** Anonymous GET api/public/repos/:id/tree. The opaque id is the only public
 * lookup; there is deliberately no endpoint that lists public repositories. */
export interface WorkspacePublicRepoTreeAnswer extends WorkspaceRepoTreeAnswer {
  name: string;
  cloneUrl: string;
  path: string;
}

export interface WorkspacePublicRepoFileAnswer extends WorkspaceRepoFileAnswer {
  name: string;
  cloneUrl: string;
  path: string;
}

/** One public repository on a person's page: where it is and how much of
 *  it, as git counted it, is theirs. */
export interface WorkspacePublicPersonRepo {
  name: string;
  /** The workplace it belongs to, by display name and handle; the handle is
   *  absent on a workplace the boot backfill has not reached. */
  workplace: string;
  workplaceHandle?: string;
  /** Where it opens: the public repository page. */
  publicUrl: string;
  commits: number;
}

/**
 * Anonymous GET api/public/people/:handle — a person's public page
 * (knowledge page "public-addresses", slice 5). What a stranger may know:
 * name, picture, handle, and the public repositories git counts them in.
 * Never their workplaces, their email or their address. The answer for a
 * handle nobody holds is a 404 identical to a reserved or malformed one,
 * so the door is not a registry oracle.
 */
export interface WorkspacePublicPersonAnswer {
  handle: string;
  name: string;
  photoUrl?: string;
  repos: WorkspacePublicPersonRepo[];
  /** Present only for a signed-in viewer who shares a workplace with them:
   *  the workplace whose member screen says the rest, and their id there. */
  colleague?: { orgId: string; userId: string };
  /** Their X handle, for the Follow on X pill — only beside `board`, and
   *  only if they added one in Settings. */
  x?: string;
  /** Their numbers: only to the person themselves, signed in, and on the
   *  founder's page to anyone (note #824). */
  board?: WorkspacePublicPersonBoard;
}

/** One builder's numbers, their page's week (shared/leaderboard.ts). */
export interface WorkspaceLeaderboardBuilder {
  /** Their address, where the row opens their page; absent for someone who
   *  never chose one, whose row opens nothing. */
  handle?: string;
  name: string;
  photoUrl?: string;
  /** Their agents, every workplace of theirs together. */
  agents: number;
  /** How many of those are in a turn right now. */
  working: number;
  /** What their agents run on, Claude Code before Codex. */
  runs: Array<'claude' | 'codex' | 'opencode'>;
  week: LeaderboardWeekNumbers;
  /** One level (0–4) per day, from the answer's `gridStart` to today. */
  grid: number[];
}

/**
 * Every builder's week, in one read (services/leaderboard.ts): what was the
 * public Leaderboard's answer until note #824, and now only the source each
 * builder page's numbers are cut from. Counts only; never the work.
 */
export interface WorkspaceLeaderboardAnswer {
  /** Monday, UTC, `YYYY-MM-DD`: the week these numbers are. */
  weekStart: string;
  /** This week's Monday, so a reader on a past week knows how far forward
   *  it can step. The board resets there. */
  thisWeek: string;
  /** The grid's first day, a Monday twelve weeks before `thisWeek`: the
   *  grid is always the last 90 days, whichever week is read. */
  gridStart: string;
  builders: WorkspaceLeaderboardBuilder[];
}

/**
 * The app catalogue — `agenticcloudcomputer.com/apps` (note #756): every
 * site deployed on the platform that is serving and listed, newest first.
 * Public to anyone; nothing about the workplace or the agent
 * crosses, only the maker (a person) and what they made.
 */
export interface WorkspaceAppCatalogueEntry {
  /** The site's name, which is its address: `<name>.agentbuilt.app`. */
  name: string;
  url: string;
  /** One line on what it does, written by the agent that deployed it. */
  line: string;
  /** The person whose agent built it. */
  builder: {
    name: string;
    /** Their public address, when they have one: the row's door. */
    handle?: string;
    photoUrl?: string;
  };
  /** The screenshot, when one was taken; absent until the deploying
   *  machine could take one. */
  pictureUrl?: string;
  /** When the site was last deployed (its first deploy for a record from
   *  before that was kept) — the order of the catalogue, newest first
   *  (note #767). */
  publishedAt: string;
  /** When the site was first deployed. */
  createdAt: string;
}

export interface WorkspaceAppCatalogueAnswer {
  apps: WorkspaceAppCatalogueEntry[];
}

/** A person's builder page: their week, days and all-time totals. */
export interface WorkspacePublicPersonBoard extends Omit<WorkspaceLeaderboardBuilder, 'handle' | 'name' | 'photoUrl'> {
  gridStart: string;
  /** Each square's counts, in `grid`'s order, for the day a reader taps
   *  (note #208). On their page only: the board's rows do not carry it. */
  days: LeaderboardDay[];
  /** Their totals since LEADERBOARD_DAYS_FROM (note #209). On their page only. */
  allTime: LeaderboardAllTime;
}

/** GET/PUT api/profile/x — Settings' X profile, for the Follow on X button. */
export interface WorkspaceXProfileSettings {
  /** Their X handle, without the @; absent when they added none. */
  x?: string;
}

/**
 * A workplace's word — `/acme` — read by one of its own signed-in members:
 * which workplace it is, so the shell opens the workplace's own screen. A
 * workplace has no public page (the owner, 2026-10-12, note #748): to
 * anyone else, signed in or not, its word is the same 404 as a word nobody
 * holds. The handle stays, as the word its repositories live under.
 */
export interface WorkspacePublicWorkplaceAnswer {
  member: { orgId: string };
}

/**
 * Anonymous GET api/public/addresses/:handle — what ONE word at the root of
 * the domain is: a person, or — for one of its own members only — a
 * workplace (they share the namespace, so it is never both). A word nobody
 * holds is a 404 like any other, and so is a workplace's to anyone else.
 */
export type WorkspacePublicAddressAnswer =
  | { kind: 'person'; person: WorkspacePublicPersonAnswer }
  | { kind: 'workplace'; workplace: WorkspacePublicWorkplaceAnswer };

/**
 * Anonymous GET api/public/workplaces/:handle/repos/:repo/tree (and /file):
 * the same answer the link-only door gives for a public repository — or,
 * for a signed-in MEMBER of the workplace, only which workplace it is, so
 * the shell opens the full repository screen. A private repository is a
 * 404 to anyone else, identical to one that does not exist.
 */
export type WorkspacePublicRepoDoorAnswer<T> = T | { member: { orgId: string } };

/**
 * Anonymous GET api/public/workplaces/:handle/repos/:repo/commits — the
 * default branch's history, as a member's history screen reads it, minus
 * the checks: CI is the workplace's business and stays behind the door.
 */
export interface WorkspacePublicRepoCommitsAnswer {
  name: string;
  branch: string | null;
  commits: Array<Omit<WorkspaceRepoCommit, 'checks'>>;
}

/** Anonymous GET api/public/workplaces/:handle/repos/:repo/commits/:sha —
 *  one commit and its diff, no checks. */
export interface WorkspacePublicRepoCommitAnswer extends Omit<WorkspaceRepoCommitAnswer, 'checks'> {
  name: string;
}

/**
 * One proposal as a public repository lists it: what was proposed, from
 * which branch, what became of it and when, and the agent that signed it —
 * the name git already shows on its commits, never the person behind it,
 * never a face, an id, a decision note or a margin. Quiet proposals (never
 * shown to the owner) are not listed at all.
 */
export interface WorkspacePublicRepoProposalRow {
  number: number;
  title: string;
  from: string;
  to: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  diffStat?: { files?: number; insertions: number; deletions: number };
  agentName: string | null;
}

/** Anonymous GET api/public/workplaces/:handle/repos/:repo/proposals —
 *  every proposal ever shown on one public repository, newest first. */
export interface WorkspacePublicRepoProposalsAnswer {
  name: string;
  prs: WorkspacePublicRepoProposalRow[];
}

/**
 * Anonymous GET api/public/workplaces/:handle/repos/:repo/proposals/:number
 * — one proposal whole: its write-up, its commits and its diff (live while
 * open, frozen once decided — exactly the compare a member's screen makes).
 * A signed-in member is told the proposal's id as well as the workplace,
 * so the shell can open the proposal's own screen.
 */
export interface WorkspacePublicRepoProposalAnswer {
  name: string;
  pr: WorkspacePublicRepoProposalRow & { body: string | null };
  commits: WorkspaceProposalCommit[];
  patch: string | null;
  patchTruncated: boolean;
  compareError?: string;
}
export type WorkspacePublicRepoProposalDoorAnswer = WorkspacePublicRepoProposalAnswer | { member: { orgId: string; id: string } };

/** One contributor as a public repository names them: the git author name
 *  and the numbers — never the address git knows them by. */
export interface WorkspacePublicRepoContributor {
  name: string;
  /** The face (the owner, 2026-09-27): an agent's own picture, or a member's
   *  profile photo when the git address is theirs. Absent for everyone else. */
  avatarUrl?: string;
  commits: number;
  insertions: number;
  deletions: number;
}

/**
 * Anonymous GET api/public/workplaces/:handle/repos/:repo/about — the About
 * strip and the contributors line (the owner, 2026-09-27): what a visitor
 * checks before cloning. The description is the README's first paragraph;
 * the licence is named from the LICENSE file when it is a common one, else
 * only that the file exists. Counts are of the default branch (as the
 * contributors were last counted) and of the proposals ever shown.
 */
export interface WorkspacePublicRepoAboutAnswer {
  name: string;
  branch: string | null;
  description?: string;
  license?: { name: string | null; file: string };
  sizeBytes: number;
  publishedAt: string;
  lastPushAt?: string;
  commits: number | null;
  proposals: number;
  contributors: WorkspacePublicRepoContributor[];
  countedAt?: string;
}

/** The admin-only answer after publishing or withdrawing a repository. */
export interface WorkspaceRepoPublicAccessAnswer {
  public: boolean;
  publicUrl?: string;
  publishedAt?: string;
}

/** GET api/repos/:name/file — exactly one of `content`, `image`, `binary` or
 *  `tooLarge` describes the body. `image.mime` comes from the host's own
 *  extension table, never from anything read out of the file. */
export interface WorkspaceRepoFileAnswer {
  branch: string;
  sizeBytes: number;
  content?: string;
  image?: { mime: string; base64: string };
  binary?: boolean;
  tooLarge?: boolean;
}

/** One commit in a listing, with the checks that ran on it. */
export interface WorkspaceRepoCommit {
  sha: string;
  authorName: string;
  at: string;
  subject: string;
  checks?: WorkspaceChecksSummary;
}

/** GET api/repos/:name/commits */
export interface WorkspaceRepoCommitsAnswer {
  branch: string | null;
  commits: WorkspaceRepoCommit[];
}

/**
 * GET api/repos/:name/commit/:sha — one commit, whole.
 *
 * `checks` is a different shape here than on a listing row, which is why the
 * summary is omitted rather than extended: a LIST wants the worst state as
 * one pip, and the commit's own screen wants every run it can name.
 */
export interface WorkspaceRepoCommitAnswer extends Omit<WorkspaceRepoCommit, 'checks'> {
  body: string;
  /** Empty on a root commit, more than one on a merge. */
  parents: string[];
  diffStat: { files: number; insertions: number; deletions: number };
  patch: string;
  patchTruncated: boolean;
  checks?: WorkspaceCheckRow[];
}

/** GET api/repos/:name/contributors */
export interface WorkspaceRepoContributorsAnswer {
  contributors: WorkspaceRepoContributor[];
  countedAt?: string;
}

/** GET api/repos/:name/checks — the recent runs, newest first. */
export interface WorkspaceRepoChecksAnswer {
  runs: Array<WorkspaceCheckRow & { sha: string }>;
}

/** GET api/repos/:name/prs — every proposal ever made on one repository. */
export interface WorkspaceRepoProposalsAnswer {
  prs: WorkspaceProposalRow[];
}

/** GET api/git-access — whether this account has a personal git key. */
export interface WorkspaceGitAccessAnswer {
  createdAt?: string | null;
}

/** POST api/repos/:name/ci-secrets/decision */
export interface WorkspaceRepoCiDecisionRequest { decision: 'approve' | 'reject' }

/** One DNS record email needs in a private copy (note #946). */
export interface WorkspaceCopyMailRecord {
  name: string;
  type: 'A' | 'MX' | 'TXT' | 'CNAME';
  value: string;
  priority?: number;
  why: string;
  /** As the domain's own name servers answered at the last check; null for a
   *  record the Workspace cannot check. Absent before any check. */
  ok?: boolean | null;
}

/** POST api/copy/mail/provider: how mail goes out. */
export type WorkspaceCopyMailProviderInput =
  | { kind: 'resend'; apiKey: string }
  | { kind: 'smtp'; host: string; port?: number; user?: string; password?: string };

/** GET api/copy/mail: email's setup in a private copy, for its admins. */
export interface WorkspaceCopyMailStatus {
  state: 'off' | 'provider' | 'records' | 'on';
  domain: string;
  /** Mail was set up by an installer before note #946. */
  fromInstall?: true;
  provider?: { kind: 'resend' | 'smtp'; line: string };
  receiver?: { app: string; ipv4: string; adopted?: true };
  records: WorkspaceCopyMailRecord[];
  providerRecordsNote?: string;
  certificate: 'issued' | 'pending' | 'unknown';
  providerVerified?: boolean | null;
  checkedAt?: string;
  turnedOnAt?: string;
  /** What the receiver adds to the Fly bill, at Fly's list prices. */
  monthlyUsd: number;
  /** Why this Workspace cannot set mail up by itself, when it cannot. */
  unavailable?: string;
}
