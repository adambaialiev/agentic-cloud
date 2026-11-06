import { PUBLIC_GUIDE_EFFORT, PUBLIC_GUIDE_KIND, PUBLIC_GUIDE_MODEL } from '../shared/public-guide.js';
import { CATALOGUE_FULL_NAME, CATALOGUE_NAME, CATALOGUE_URL } from '../shared/public-host.js';
import { harnessName, isHarnessCli } from '../shared/harness-clis.js';
import { autoApproveChecksBlocker, autoApproveTime, type WorkplaceAutoApprove } from '../shared/auto-approve.js';
import { memberHasLiveSeat } from '../services/org-seat-signin.js';
import { agentBroughtInReceipt } from '../shared/first-run.js';
import { registerDriveRoutes } from './drive.js';
import { registerRadioRoutes } from './radio.js';
import { WORKSPACE_AGENT_NAME, workspaceAssistantId } from '../types/user.js';
import { checkCreationRuntime, resolveEffectiveEffort, resolveEffectiveModel } from '../agent/harness-models.js';
import { Router, raw } from 'express';
import type { Request, Response } from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteDeps } from './deps.js';
import type { MailConversation, MailMessageDocument, MailMove } from '../services/mail-message-storage.js';
import { isMailListRow, mailConversationAnswerable, mailConversationFacts } from '../services/mail-threads.js';
import { mailMoveRefusal, mailMovedBy, mailPlaceOf, mailStarRefusal, mailStarredBy, readMailPlace, readMailView } from '../services/mail-places.js';
import { mailSenderKey } from '../services/mail-pictures.js';
import { MailOutboxError, replyAll, replyRecipient, type SentByAgent } from '../services/mail-outbox.js';
import type { MailApprovalDocument } from '../services/mail-approval-storage.js';
import { MAIL_UPLOAD_MAX_BYTES, readMailUpload } from '../services/mail-upload.js';
import { MAIL_UPLOAD_CONTENT_TYPE } from '../shared/workspace-mail.js';
import { agentbuiltTokenMatches, parseAgentbuiltToken } from '../services/agentbuilt-token.js';
import { looksLikeCiDeployToken, mintCiDeployToken, verifyCiDeployToken } from '../services/ci-deploy-token.js';
import { previousRecaps } from '../services/workspace-recap.js';
import { HOSTED_SITE_LIMIT, ORG_DEPLOYMENT_LIMIT, isAdminAccount } from '../config/access.js';
import { ObjectStorageError } from '../services/object-storage.js';
import type { StorageBucketDocument } from '../types/storage-bucket.js';
import { signupFunnel } from '../services/signup-funnel.js';
import { agentUsageReport, usageWeeksRequested } from '../services/agent-usage-report.js';
import { seatUsageCacheIsStale } from '../services/workspace-seat-usage.js';
import { hostedSpendRefusal, hostedUsage, isHostedWorkplace, workplaceSiteCount } from '../services/hosted-workplace.js';
import {
  CI_CLONE_TOKEN_DEFAULT_TTL_MS,
  looksLikeCiCloneToken,
  mintCiCloneToken,
  verifyCiCloneToken,
} from '../services/ci-clone-token.js';
import {
  humanGitTokenMatches,
  looksLikeHumanGitToken,
  parseHumanGitToken,
} from '../services/human-git-token.js';
import type { DeploymentDocument, DeploymentPreset, SiteKind } from '../types/deployment.js';
import {
  DEPLOYMENT_PRESETS,
  DEPLOYMENT_UPGRADE_PATHS,
  countSitesByKind,
  siteIsListed,
  siteKindForPreset,
  validateDeploymentName,
  validateSiteListingLine,
} from '../types/deployment.js';
import type { GitRepoDocument } from '../types/git-repo.js';
import type { GitPullRequestDocument } from '../types/git-pr.js';
import type { GitNamespace } from '../services/org-git.js';
import { pickNumbered, workplaceNumberSeries, type NumberSeries } from '../services/workplace-numbers.js';
import type { GitCommitStatusMachine, GitCommitStatusState } from '../types/git-commit-status.js';
import { worstCheckState } from '../types/git-commit-status.js';
import {
  GIT_COMMIT_STATUS_LOG_TAIL_MAX_BYTES,
  GIT_COMMIT_STATUS_STALE_PENDING_MS,
  GIT_COMMIT_STATUS_STATES,
  effectiveStatusState,
  validateStatusContext,
} from '../types/git-commit-status.js';
import type { GitCommitStatusStorage } from '../services/git-commit-status-storage.js';
import { ORG_CI_CONTEXT } from '../services/org-ci.js';
import {
  PR_ATTACHMENT_MAX_BYTES,
  pullRequestAttachmentPath,
  pullRequestQuickNoteNamespaceId,
  pullRequestQuickNoteNumbers,
  pullRequestTakesAttachments,
  pullRequestTakesComments,
  validateBranchName,
  validatePullRequestAttachment,
  validatePullRequestBody,
  validatePullRequestComment,
  validatePullRequestTitle,
} from '../types/git-pr.js';
import {
  COMMENT_AUTHOR_USER,
  MAX_COMMENTS,
  newMarginComment,
  type MarginComment,
} from '../types/comment.js';
import {
  GIT_REPO_MAX_BYTES,
  GIT_TRASH_KEEP_DAYS,
  GIT_USER_MAX_BYTES,
  nextContributors,
  repoCiSecretsNamespaceId,
  validateGitRepoName,
} from '../types/git-repo.js';

import {
  KNOWLEDGE_ATTACHMENT_MAX_BYTES,
  KNOWLEDGE_BASE_MAX_PAGES,
  KNOWLEDGE_PROPOSAL_MAX_BYTES,
  knowledgeAttachmentPath,
  readKnowledgePageMeta,
  knowledgeProposalTakesComments,
  validateKnowledgeAttachment,
  validateKnowledgeComment,
  validateKnowledgeHtml,
  validateKnowledgePageName,
  validateKnowledgeRename,
  validateKnowledgeProposalNote,
  validateKnowledgeProposalTitle,
  type KnowledgePageAttachment,
  type KnowledgePageChange,
  type KnowledgeProposalDocument,
} from '../types/knowledge.js';
import {
  describeKnowledgeChanges,
  defaultProposalTitle,
  KnowledgeService,
  type KnowledgeApplyResult,
} from '../services/knowledge-service.js';
import { moveMarginsForLandedChanges } from '../services/knowledge-page-comments.js';
import {
  QUICK_NOTE_AUTHOR_USER,
  QUICK_NOTE_MAX_COMMENTS,
  QUICK_NOTES_MAX_PER_USER,
  QUICK_NOTE_ATTACHMENT_MAX_BYTES,
  QUICK_NOTE_SINGLE_UPLOAD_MAX_BYTES,
  QUICK_NOTE_HANDOFF_WINDOW_MS,
  activeQuickNoteClaim,
  quickNoteAttachmentPath,
  quickNoteFingerprint,
  quickNoteIsArchived,
  quickNoteStoragePrefix,
  quickNoteTitle,
  summarizeQuickNote,
  validateQuickNoteComment,
  validateQuickNoteAttachment,
  validateQuickNoteHtml,
  type QuickNoteComment,
  type QuickNoteDocument,
} from '../types/quick-note.js';
import { NoteFileUploadError, NoteFileUploads } from '../services/note-file-uploads.js';
import type { QuickNoteStorage } from '../services/quick-note-storage.js';
import { UPLOAD_PART_BYTES } from '../shared/uploads.js';
import { newQuickNoteComment } from '../services/quick-note-storage.js';
import {
  FINISHED_JOBS_MAX_PER_REQUEST,
  validateFinishedJobReceipt,
  type FinishedJobReceipt,
} from '../types/job-receipt.js';
import { WORKSPACE_BASE, workspaceRoutePath } from '../shared/workspace-routes.js';
import { STOP_REASON_MAX } from '../shared/workspace-recap-chat.js';
import { PullRequestNumberRaceError, QuickNoteProposalConflictError } from '../services/git-pr-storage.js';
import {
  resolveQuickNoteWorkMap,
  type QuickNoteWork,
} from '../services/quick-note-work.js';
import { inferContentType } from '../services/session-attachments.js';
import { imageDimensions } from '../utils/image-dimensions.js';
import { textToSafeHtml } from '../types/safe-html.js';
import { scheduleView } from '../types/agent-schedule.js';
import { restorableUntil } from '../services/git-repo-admin.js';
import { parseSiteSecretNames, redactSiteSecrets, resolveSiteSecrets } from '../services/site-secrets.js';
import type { GitHostRepoStat } from '../services/git-host-client.js';
import {
  agentUserSecretScope,
  describeUserSecretAudience,
  SHARED_USER_SECRET_SCOPE,
  UserSecretsService,
  SECRET_ROOMS_GONE,
  type UserSecretAudience,
  type UserSecretScope,
  validateUserSecretAudience,
} from '../services/user-secrets.js';

/**
 * The backend surface of the `agentbuilt` CLI (docs/deployments-phase1.md):
 * deploy / list / status / logs / restart, plus git repos, proposals, and
 * secrets — authenticated by the per-agent token the identity writer put on
 * each machine.
 *
 * What that token can do bounds the blast radius of prompt injection, so it is
 * worth stating plainly. Everything here is confined to the user's own account
 * and reversible by them: a bad redeploy the next deploy fixes, a proposal only
 * the user can merge, and secrets the agent could already READ from its own
 * environment. The one genuinely new power is WRITING a secret — an injected
 * agent can rotate a key out from under the user's other agents with
 * `--shared`. It cannot exfiltrate anything it could not already read, and the
 * user sees every value's last-changed time in `/secrets`.
 */

/**
 * An abuse backstop, NOT a product limit — hosting is included with the
 * account (the pricing ladder retired with the org pivot), and this is the
 * only ceiling: it exists so one account cannot hold the whole public namespace
 * (or quietly run a hundred machines) between an operator's blinks; a real
 * customer who needs more than this is a conversation, not a refusal we should
 * automate away.
 */
const MAX_ACTIVE_DEPLOYMENTS_PER_USER = 50;

/** Generous for a site tarball; far below anything that troubles the host. */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
/** The public app catalogue (note #756), where every listed site appears. */
/** A catalogue picture: one PNG of the site at 1280×800, as the CLI takes it. */
const LISTING_PICTURE_MAX_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Recent check runs returned when no sha is named. A handful is all an agent
 *  ever reads — it knows the sha it pushed, and asks for that one. */
const AGENT_CHECK_RUNS_LIMIT = 10;

/** How far back to look for a finished run of the same check. A repo with
 *  four contexts per push files forty rows in ten pushes; one finished run of
 *  the slowest is all this needs. */
const AGENT_CHECK_HISTORY_LIMIT = 40;

/**
 * The length, in whole seconds, of the most recent FINISHED run among the
 * given contexts — the slowest context's, since that is the one a wait for
 * the whole sha is really waiting for. `undefined` when nothing of these
 * contexts has ever finished with a measured duration. With no contexts
 * named (a sha the runner has not filed on yet), any context counts.
 */
async function lastFinishedRunSeconds(
  storage: GitCommitStatusStorage,
  repoId: string,
  contexts: Set<string>,
): Promise<number | undefined> {
  const recent = await storage.listRecentByRepo(repoId, AGENT_CHECK_HISTORY_LIMIT);
  const seen = new Set<string>();
  let longest: number | undefined;
  for (const doc of recent) {
    // Newest first, so the first finished row per context is its latest run.
    if (seen.has(doc.context)) continue;
    if (contexts.size > 0 && !contexts.has(doc.context)) continue;
    if (!doc.completedAt || (doc.state !== 'success' && doc.state !== 'failure' && doc.state !== 'error')) continue;
    seen.add(doc.context);
    const seconds = Math.round((new Date(doc.completedAt).getTime() - new Date(doc.startedAt).getTime()) / 1000);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    longest = longest === undefined ? seconds : Math.max(longest, seconds);
  }
  return longest;
}

/**
 * A fresh-chat handoff is a pointer, not an archive: the durable detail
 * belongs in ~/SCRATCHPAD.md, which survives the reset anyway. Generous enough for
 * a real paragraph, small enough that nobody ships a transcript through it.
 */
const CHAT_HANDOFF_MAX_LENGTH = 4000;
/** A coordination pointer, not a transcript or file-transfer channel. */
const AGENT_MESSAGE_MAX_LENGTH = 4000;
const AGENT_STOP_REASON_MAX_LENGTH = STOP_REASON_MAX;

/** What `agentbuilt room …` from an older CLI is told once a workplace's
 *  rooms are merged (note #843). */
const ROOMS_GONE = 'Rooms are gone (note #843): every agent, note, key, repository and page belongs to the whole workplace. There is no room to open, rename, order or remove.';

interface AgentAuth {
  userId: string;
  agentId: string;
  /** Immutable org of this agent; null only on legacy org-less deployments. */
  orgId: string | null;
  orgRole: 'admin' | 'member' | null;
  /** The account's fleet, as the profile records it. Carried because a note's
   *  comments are signed by agent id, and an id tells the reader nothing. */
  agents: Record<string, { name?: string }>;
  /**
   * Set for the owner's Workspace Agent (types/user.ts). It is a full agent
   * credential: its ordinary verbs reach the workplace like any agent's, and
   * the coordinator-only verbs below are its alone.
   */
  purpose?: 'workspace-recap';
}

/** `Workspace Agent`, in any case, or that agent's id for this owner and workplace (note #457). */
function isWorkspaceAgentRecipient(recipient: string, auth: Pick<AgentAuth, 'userId' | 'orgId'>): boolean {
  if (recipient.toLowerCase() === WORKSPACE_AGENT_NAME.toLowerCase()) return true;
  return Boolean(auth.orgId) && recipient === workspaceAssistantId(auth.userId, auth.orgId!);
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * Where the single-file CLI lives: the build copies it into dist (deploys ship
 * only dist + node_modules + assets), while the src path serves tests and
 * local ts runs straight from the repo checkout.
 */
const CLI_FILE_CANDIDATES = [
  path.join(moduleDir, '..', 'agentbuilt-cli.mjs'),
  path.join(moduleDir, '..', '..', '..', 'cli', 'agentbuilt', 'agentbuilt.mjs'),
];


/** What an agent is told when its copy has no email yet (note #946). */
export const COPY_MAIL_NOT_SET_UP = 'Email is not set up in this Agentic Cloud yet. An admin sets it up in the Workspace, under Mail; until then there is no inbox and nothing can be sent.';
export function agentCliRoutes(deps: RouteDeps): Router {
  const router = Router();

  // Unauthenticated on purpose: this is the CLI's own code (no secrets), and
  // the ~/.boot.d installer on agent machines curls it before it has any way
  // to authenticate.
  router.get('/install/agentbuilt', async (_req, res) => {
    for (const candidate of CLI_FILE_CANDIDATES) {
      try {
        const source = await readFile(candidate, 'utf8');
        return res.type('text/javascript').send(source);
      } catch {
        // Try the next layout.
      }
    }
    return res.status(404).json({ error: 'CLI file not found on this backend build' });
  });

  const authenticate = async (req: Request, res: Response): Promise<AgentAuth | null> => {
    if (!deps.userStorage) {
      res.status(503).json({ error: 'Agent CLI is not configured on this backend' });
      return null;
    }
    const token = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const claim = token ? parseAgentbuiltToken(token) : null;
    if (!claim) {
      res.status(401).json({ error: 'Missing or malformed agentbuilt token' });
      return null;
    }
    const profile = await deps.userStorage.getProfile(claim.userId);
    const agent = profile?.telegram?.agents?.[claim.agentId];
    if (!agent || !agentbuiltTokenMatches(token, agent.agentbuiltTokenHash)) {
      // A REAL agent presenting a mismatched token is the wedge an identity
      // write interrupted by a deploy leaves behind: machine and record hold
      // different tokens, the version is already current, and no rewrite
      // would ever fire again (live, 2026-08-26). Flag the record so the
      // turn-start staleness check forces one — that is what makes the
      // "try again next turn" below true instead of a permanent lockout.
      if (agent && !agent.agentbuiltTokenStale) {
        await deps.userStorage
          .updateAgentFields(claim.userId, claim.agentId, { agentbuiltTokenStale: true })
          .catch(() => { /* best effort — the next failing call retries */ });
      }
      // One answer for "no such agent" and "stale token": the fix is the same
      // (the machine gets a fresh token on its next identity write).
      res.status(401).json({ error: 'Token is not valid (it may have been rotated — try again next turn)' });
      return null;
    }
    const auth = await agentAuthFor(req, res, claim, profile);
    // The event turn's fence (note #716): while the Workspace Agent runs a
    // turn nobody asked for, it reads freely and changes only what the
    // person's standing permissions allow. Here, on its own token alone — a
    // CI publish key acting as it (`ciPublishAuth`) is not a turn of it.
    if (auth?.purpose && auth.orgId && req.method !== 'GET' && deps.workspaceAgent?.eventTurnRefusal) {
      const refusal = await deps.workspaceAgent.eventTurnRefusal(auth.userId, auth.orgId, req.method, req.path)
        .catch(() => 'Whether an event turn is running could not be read just now, so nothing was done. Try again in a moment.');
      if (refusal) {
        res.status(403).json({ error: refusal });
        return null;
      }
    }
    return auth;
  };

  /**
   * Everything an agent's credential resolves to — its workplace, role, room
   * and fleet — once something has established WHICH agent is acting: its own
   * token above, or a CI publish key acting as the agent that linked the
   * repository to its site (`ciPublishAuth`).
   */
  const agentAuthFor = async (
    req: Request,
    res: Response,
    claim: { userId: string; agentId: string },
    profile: Awaited<ReturnType<NonNullable<RouteDeps['userStorage']>['getProfile']>>,
  ): Promise<AgentAuth | null> => {
    const agent = profile?.telegram?.agents?.[claim.agentId];
    if (!agent || !deps.userStorage) {
      res.status(401).json({ error: 'No such agent' });
      return null;
    }
    let orgId: string | null = agent.orgId ?? null;
    let orgRole: 'admin' | 'member' | null = null;
    let legacyOrgId: string | null = null;
    if (deps.orgStorage) {
      const memberships = await deps.orgStorage.listMembershipsByUser(claim.userId).catch(() => []);
      // A legacy agent predates org pinning. Before multi-org existed its
      // owner could hold exactly one membership; after the cutover the oldest
      // membership is therefore the only safe home, never the mutable active
      // Workspace choice.
      legacyOrgId = [...memberships]
        .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]
        ?.orgId ?? null;
      orgId ??= legacyOrgId;
      const membership = orgId ? memberships.find((row) => row.orgId === orgId) : null;
      if (orgId && !membership) {
        res.status(403).json({ error: 'This agent no longer belongs to a workplace.' });
        return null;
      }
      // A workplace an admin asked to delete is locked (2026-09-22): its
      // agents were put to sleep and are refused new turns, and a command
      // from one still mid-turn is refused here, so nothing new is deployed,
      // pushed or proposed from a workplace that is on its way out.
      const workplace = orgId ? await deps.orgStorage.getOrg(orgId).catch(() => null) : null;
      if (workplace?.deletion) {
        res.status(403).json({ error: `${workplace.name} is being deleted, so its agents are stopped.` });
        return null;
      }
      orgRole = membership?.role ?? null;
      if (orgId && !agent.orgId) {
        void deps.userStorage!.updateAgentFields?.(claim.userId, claim.agentId, { orgId })
          .catch(() => false);
      }
    }
    const orgAgents = Object.fromEntries(Object.entries(profile?.telegram?.agents ?? {}).filter(([, candidate]) => (
      !orgId || candidate.orgId === orgId || (!candidate.orgId && legacyOrgId === orgId)
    )));
    if (agent.purpose && agent.purpose !== 'workspace-recap') {
      // The briefing machine (note #437) is never given a credential; a
      // token that names it is one that should not exist.
      res.status(403).json({ error: 'This machine writes the Home briefing and holds no agent credential.' });
      return null;
    }
    // `--room` (the Chief of Staff's, once) is accepted and ignored for one
    // more release since rooms left the product (note #843).
    return {
      userId: claim.userId,
      agentId: claim.agentId,
      orgId,
      orgRole,
      agents: orgAgents,
      ...(agent.purpose ? { purpose: agent.purpose } : {}),
    };
  };

  /**
   * Where a note opens in the browser. The Workspace Agent's note verbs leave
   * NO row in its conversation (note #623): its reply already says what it
   * did, and a card per note buried that reply under a stack of them.
   */
  const noteHref = async (auth: AgentAuth, doc: QuickNoteDocument): Promise<string | undefined> => {
    return workspaceRoutePath({
      kind: 'note', id: String(doc.number), ...(auth.orgId ? { orgId: auth.orgId } : {}),
    }) ?? undefined;
  };

  registerDriveRoutes(router, '/drive', deps, async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return null;
    if (!auth.orgId) { res.status(404).json({ error: 'No workplace Drive is available.' }); return null; }
    return { orgId: auth.orgId, userId: auth.userId, agentId: auth.agentId, canDeleteForever: false };
  });
  // What the work radio is playing (note #712), so an agent can say — and,
  // for the platform admin's agents alone, its library (note #758).
  registerRadioRoutes(router, '/radio', deps, authenticate,
    async (auth) => isAdminAccount(await deps.userStorage?.getProfile(auth.userId)));

  const requireDeployments = (res: Response) => {
    if (!deps.deploymentService || !deps.deploymentStorage) {
      res.status(503).json({ error: 'Production hosting is not available on this backend yet' });
      return null;
    }
    return { service: deps.deploymentService, storage: deps.deploymentStorage };
  };

  // No price on a deployment any more: hosting is part of the plan, and a
  // "$5/mo" on a row the user is not billed for is simply false. What replaces
  // it is `kind` — which of the plan's two allowances this site sits in.
  /**
   * Who last deployed a site, in words an agent can repeat (note #566). An
   * agent of the SAME owner is named. So is a teammate's, since the owner's
   * rule of 2026-09-23 that a person's agents are never hidden from the rest
   * of the workplace — by the name it deployed under, and said to be a
   * teammate's, so the agent reading it knows it is not one of its own
   * owner's.
   */
  const lastDeployerWords = (doc: DeploymentDocument, auth: AgentAuth): string | null => {
    const by = doc.lastDeployBy;
    const agentId = by?.agentId ?? doc.agentId;
    if (agentId === auth.agentId) return 'you';
    const ownerId = by?.userId ?? doc.userId;
    const name = ownerId === auth.userId
      ? (auth.agents[agentId]?.name ?? by?.agentName ?? 'another of your agents')
      : by?.agentName ? `${by.agentName}, a teammate's agent` : "a teammate's agent";
    return by?.ci ? `an approved change to ${by.ci.repo}, published as ${name}` : name;
  };

  const describe = (doc: DeploymentDocument, url: string, auth?: AgentAuth) => ({
    name: doc.name,
    preset: doc.preset,
    kind: siteKindForPreset(doc.preset),
    status: doc.status,
    url,
    createdAt: doc.createdAt,
    ...(doc.lastDeployAt ? { lastDeployAt: doc.lastDeployAt } : {}),
    ...(auth && doc.lastDeployAt && lastDeployerWords(doc, auth)
      ? { lastDeployBy: lastDeployerWords(doc, auth) }
      : {}),
    // Names only (note #661) — a value never leaves the secret store this way.
    ...(doc.secretNames?.length ? { secrets: doc.secretNames } : {}),
    // Its catalogue entry (note #756): whether the public sees it there now,
    // and what is missing when it does not.
    listing: {
      listed: siteIsListed(doc),
      ...(doc.listing?.line ? { line: doc.listing.line } : {}),
      picture: Boolean(doc.listing?.picture),
      unlisted: doc.listing?.listed === false,
      ...(doc.listing?.hiddenByOperator ? { hiddenByOperator: true } : {}),
    },
  });

  /**
   * The catalogue sentence a deploy's answer ends with (note #756): where
   * the site stands in the catalogue after this deploy, and the one
   * thing to do when it is not there yet. Said on every deploy, because the
   * listing is written at deploy time and nowhere else.
   */
  const listingWords = (doc: DeploymentDocument, opts: { picturePending: boolean }): string => {
    if (doc.listing?.hiddenByOperator) return ` An operator has taken "${doc.name}" out of ${CATALOGUE_NAME}.`;
    if (doc.listing?.listed === false) return ` "${doc.name}" is NOT in ${CATALOGUE_NAME} (unlisted); \`agentbuilt relist ${doc.name}\` puts it back.`;
    if (!doc.listing?.line) {
      return ` "${doc.name}" is not in ${CATALOGUE_NAME} yet: it has no line. \`agentbuilt listing ${doc.name} --line "<one sentence on what it does>"\` lists it.`;
    }
    const where = doc.status === 'live' ? 'is in' : 'will be in';
    return ` "${doc.name}" ${where} ${CATALOGUE_NAME} at ${CATALOGUE_URL} ("${doc.listing.line}")`
      + (opts.picturePending ? '; the CLI takes its picture once the site answers.' : '.')
      + ` \`agentbuilt unlist ${doc.name}\` takes it out if your user asks.`;
  };

  /**
   * The account's hosting, counted per kind. Per-plan allowances retired
   * with the pricing ladder (org-layer-design): hosting rides the account
   * until deploys land in the client's own Fly org (workstream 3), so
   * `limit` is always null on the wire — "no limit" — and the account-wide
   * backstop against name-squatting below is the only ceiling.
   */
  const hostingAllowance = async (
    auth: AgentAuth,
    storage: NonNullable<RouteDeps['deploymentStorage']>,
  ) => {
    const sites = (auth.orgId
      ? await storage.listByOrg(auth.orgId)
      : await storage.listByUser(auth.userId))
      .filter((d) => d.status !== 'destroyed');
    const used = countSitesByKind(sites);
    // The one ceiling a site counts against: the whole workplace's, of live
    // and provisioning sites together — HOSTED_SITE_LIMIT on our cloud
    // (note #664), the backstop on a cloud of its own. The per-kind rows
    // above it have no limit of their own, which the CLI used to print as
    // "no limit on this plan" — untrue once a hosted workplace holds ten.
    const org = auth.orgId && deps.orgStorage ? await deps.orgStorage.getOrg(auth.orgId).catch(() => null) : null;
    const ceiling = org && isHostedWorkplace(org) ? HOSTED_SITE_LIMIT : ORG_DEPLOYMENT_LIMIT;
    const holding = sites.filter((d) => d.status === 'live' || d.status === 'provisioning').length;
    return {
      sites,
      used,
      wire: {
        static: { used: used.static, limit: null },
        service: { used: used.service, limit: null },
        ...(auth.orgId ? { sites: { used: holding, limit: ceiling } } : {}),
      },
    };
  };

  /** Who is deploying, as the site will remember it; see
   *  {@link DeploymentDocument.lastDeployBy}. */
  const deployerStamp = async (auth: AgentAuth): Promise<NonNullable<DeploymentDocument['lastDeployBy']>> => {
    const agentName = auth.agents[auth.agentId]?.name;
    return {
      agentId: auth.agentId,
      userId: auth.userId,
      ...(agentName ? { agentName } : {}),
    };
  };

  /** The user's non-destroyed deployment by name, or respond and return null. */
  const ownedByName = async (
    auth: AgentAuth,
    storage: NonNullable<RouteDeps['deploymentStorage']>,
    name: string,
    res: Response,
  ): Promise<DeploymentDocument | null> => {
    const doc = await storage.getByName(name);
    // A site belongs to the WORKPLACE (note #566): every room's agents reach
    // every site of theirs, as they do its repositories and its Drive. The
    // workplace stays the wall — another's name answers 404, the same answer
    // a name nobody holds gets.
    const belongsHere = Boolean(doc)
      && (auth.orgId ? doc?.orgId === auth.orgId : doc?.userId === auth.userId);
    if (!doc || doc.status === 'destroyed' || !belongsHere) {
      res.status(404).json({ error: `No deployment named "${name}" on this account` });
      return null;
    }
    return doc;
  };

  // The org spend view (byo-fly-design slice 6): every machine and volume in
  // the org's Fly account with an honest monthly estimate. Admin-gated because
  // the report exposes workplace-wide infrastructure and billing detail.
  router.get('/org/spend', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.orgStorage || !deps.orgSpend) {
      return res.status(503).json({ error: 'Org spend is not configured on this backend' });
    }
    if (!auth.orgId) {
      return res.status(403).json({ error: 'Spend is a workplace view, and this account is not in one.' });
    }
    if (auth.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Only a workplace admin can inspect workplace spending.' });
    }
    const org = await deps.orgStorage.getOrg(auth.orgId).catch(() => null);
    if (org && isHostedWorkplace(org) && deps.userStorage) {
      return res.status(409).json({
        error: hostedSpendRefusal(await hostedUsage({
          orgStorage: deps.orgStorage,
          userStorage: deps.userStorage,
          ...(deps.deploymentStorage ? { deploymentStorage: deps.deploymentStorage } : {}),
        }, auth.orgId)),
      });
    }
    try {
      return res.json(await deps.orgSpend.report(auth.orgId));
    } catch (error) {
      return res.status(502).json({ error: (error as Error).message });
    }
  });

  /**
   * `agentbuilt usage` (note #719): the owner's subscription usage — the
   * tokens their agents spent per week, provider, model and agent, and
   * their subscriptions' limits and resets. Any agent of the owner's may
   * read it, the Workspace Agent included; it answers only for the owner the
   * credential names, never for a teammate (agent-usage-report.ts says why).
   */
  router.get('/usage', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    let seatsHere = auth.orgId && deps.orgStorage ? await deps.orgStorage.listSeatsByMember(auth.orgId, auth.userId) : [];
    let seatsAll = deps.orgStorage ? await deps.orgStorage.listSeatsByUser(auth.userId) : [];
    // The same refresh the Subscriptions screen makes before it describes a
    // stale reading: the share used and the reset are the point of the read.
    if (deps.orgStorage && deps.refreshSeatUsage && seatUsageCacheIsStale([...seatsHere, ...seatsAll])) {
      try {
        await deps.refreshSeatUsage();
        [seatsHere, seatsAll] = await Promise.all([
          auth.orgId ? deps.orgStorage.listSeatsByMember(auth.orgId, auth.userId) : Promise.resolve([]),
          deps.orgStorage.listSeatsByUser(auth.userId),
        ]);
      } catch { /* a stale reading still answers, with its own stamp */ }
    }
    const profile = await deps.userStorage!.getProfile(auth.userId);
    const agents: Record<string, { name?: string; orgId?: string }> = {};
    for (const [id, record] of Object.entries(profile?.telegram?.agents ?? {})) {
      agents[id] = {
        ...(record.name ? { name: record.name } : {}),
        ...(record.orgId ? { orgId: record.orgId } : {}),
      };
    }
    return res.json(agentUsageReport({
      ledger: deps.agentTokenLedger,
      userId: auth.userId,
      orgId: auth.orgId,
      seatsHere,
      seatsAll,
      agents,
      weeks: usageWeeksRequested(req.query.weeks),
      now: Date.now(),
    }));
  });

  router.get('/deployments', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const configured = requireDeployments(res);
    if (!configured) return;
    const allowance = await hostingAllowance(auth, configured.storage);
    // Every site of the workplace (note #566).
    const docs = [...allowance.sites].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return res.json({
      deployments: docs.map((doc) => describe(doc, configured.service.url(doc), auth)),
      // Beside the list, always: an agent about to deploy needs to know
      // whether there is room BEFORE it packs a tarball and gets a 403.
      quota: allowance.wire,
    });
  });

  router.get('/deployments/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const configured = requireDeployments(res);
    if (!configured) return;
    const doc = await ownedByName(auth, configured.storage, req.params.name, res);
    if (!doc) return;
    return res.json({ deployment: describe(doc, configured.service.url(doc), auth) });
  });

  router.get('/deployments/:name/logs', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const configured = requireDeployments(res);
    if (!configured) return;
    const doc = await ownedByName(auth, configured.storage, req.params.name, res);
    if (!doc) return;
    const lines = Number.parseInt(String(req.query.lines ?? '100'), 10) || 100;
    try {
      const logs = await configured.service.readLogs(doc.id, lines);
      return res.json({ logs });
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  });

  router.post('/deployments/:name/restart', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const configured = requireDeployments(res);
    if (!configured) return;
    const doc = await ownedByName(auth, configured.storage, req.params.name, res);
    if (!doc) return;
    try {
      await configured.service.restart(doc.id);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  });

  /**
   * Move a site to a new address. Unlike `upgrade`, the agent does this
   * ITSELF: no confirmation card, because a rename changes no money — the
   * subscription follows the record, not the name — and because the old
   * address keeps serving, so there is nothing here for a user to rescue. The
   * worst a confused agent can do is give a site a second address.
   */
  router.post('/deployments/:name/rename', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const configured = requireDeployments(res);
    if (!configured) return;
    const doc = await ownedByName(auth, configured.storage, req.params.name, res);
    if (!doc) return;
    const to = String((req.body as { to?: unknown } | undefined)?.to ?? '').trim();
    if (!to) return res.status(400).json({ error: 'Say what to rename it to: `agentbuilt rename <name> <new-name>`.' });
    try {
      const result = await configured.service.rename(doc.id, to);
      return res.json({
        ok: true,
        name: result.deployment.name,
        url: result.url,
        previousUrl: result.previousUrl,
        formerNames: result.deployment.formerNames ?? [],
      });
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  });

  // Custom domains (byo-fly-design slice 5): the cert goes on the site's Fly
  // app wherever it lives; the DNS record is the OWNER's to create, so the
  // response carries the exact CNAME instruction rather than any DNS write.
  router.post('/deployments/:name/domains', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const configured = requireDeployments(res);
    if (!configured) return;
    const doc = await ownedByName(auth, configured.storage, req.params.name, res);
    if (!doc) return;
    const hostname = String((req.body as { hostname?: unknown } | undefined)?.hostname ?? '').trim();
    if (!hostname) return res.status(400).json({ error: 'Say which hostname: `agentbuilt domain add <site> app.example.com`.' });
    try {
      const result = await configured.service.addCustomDomain(doc.id, hostname);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  });

  router.get('/deployments/:name/domains', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const configured = requireDeployments(res);
    if (!configured) return;
    const doc = await ownedByName(auth, configured.storage, req.params.name, res);
    if (!doc) return;
    try {
      return res.json({ domains: await configured.service.customDomainStatus(doc.id) });
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  });

  router.delete('/deployments/:name/domains/:hostname', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Removing shared infrastructure is a workplace admin action.' });
    }
    const configured = requireDeployments(res);
    if (!configured) return;
    const doc = await ownedByName(auth, configured.storage, req.params.name, res);
    if (!doc) return;
    try {
      await configured.service.removeCustomDomain(doc.id, String(req.params.hostname));
      return res.json({ ok: true });
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  });

  /**
   * More memory for a running service. This used to put a confirmation button
   * in the user's chat, because it moved a site from the $10 hosting price to
   * the $20 one — with hosting inside the plan there is no second price to
   * move to, so the agent does it itself, like a rename.
   *
   * What is left to get wrong is small and reversible in the same breath: a
   * machine reboot the site rides through, on an allowance slot it already
   * occupies (`service-pro` counts as a `service`).
   */
  router.post('/deployments/:name/upgrade', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Increasing workplace infrastructure spend is an admin action.' });
    }
    const configured = requireDeployments(res);
    if (!configured) return;
    const doc = await ownedByName(auth, configured.storage, req.params.name, res);
    if (!doc) return;

    const target = DEPLOYMENT_UPGRADE_PATHS[doc.preset];
    if (!target) {
      const reason = doc.preset === 'static'
        ? `"${doc.name}" is a static site — there is no bigger static machine. A heavier app is a new service deployment.`
        : `"${doc.name}" is already on ${doc.preset} — there is no bigger preset.`;
      return res.status(409).json({ error: reason });
    }

    if (doc.status === 'pending-payment') {
      // Nothing is built yet, so the "upgrade" is just a bigger machine to
      // build: change the record and let the deploy that reserved it carry on.
      await configured.storage.update(doc.id, { preset: target });
      return res.json({
        deployment: describe({ ...doc, preset: target }, configured.service.url(doc)),
        message: `"${doc.name}" hasn't been built yet, so it will come up as ${target} (1 GB) instead.`,
      });
    }
    if (doc.status !== 'live') {
      return res.status(409).json({ error: `"${doc.name}" is ${doc.status} — it has to be live before it can be upgraded.` });
    }
    if (!deps.hostingFulfilment) {
      return res.status(503).json({ error: 'Upgrades are not available on this backend yet.' });
    }
    const started = await deps.hostingFulfilment.startResize(doc.id, target);
    if (!started) {
      return res.status(409).json({ error: `"${doc.name}" could not be moved to ${target} right now — try again in a minute.` });
    }
    return res.json({
      deployment: describe(doc, configured.service.url(doc)),
      message: `${doc.name} is moving to a 1 GB machine now — it restarts for a few seconds and then serves from the bigger machine.`
        + ' It stays inside your user\'s plan; a bigger machine costs them nothing extra.',
    });
  });

  /**
   * Asking for a site to be taken down — and, exactly as with repositories,
   * ASKING IS ALL AN AGENT CAN DO. There is no route here that removes a
   * deployment: the owner does it in their workspace, on a screen that can
   * show what is at stake (the address, who put it there, what it is serving)
   * in a way a chat card cannot.
   *
   * The verb predates the org pivot: when hosting rode plan allowances,
   * nothing in the product could hand a slot back — a throwaway first deploy
   * took one of a customer's two for good, and the only way round it was
   * renaming the old site and building over it. The allowances are gone; the
   * verb stays, because taking a site down is still the user's call.
   *
   * What a delete costs and what it keeps are deliberately different from a
   * repository's. There is no restore window, because there are no bytes to
   * bring back that the agent does not still have — a site's content is one
   * redeploy away. What survives instead is the ADDRESS: the record stays as a
   * tombstone, and the deploy path reads it, so the name stays reserved to
   * this account and no stranger inherits the links its owner handed out.
   */
  router.post('/deployments/:name/delete', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Taking down shared infrastructure is a workplace admin action.' });
    }
    const configured = requireDeployments(res);
    if (!configured) return;
    const doc = await ownedByName(auth, configured.storage, req.params.name, res);
    if (!doc) return;
    await configured.storage.update(doc.id, {
      // Newest wins, one at a time — the same rule as a repository's ask.
      deleteAsk: { byAgentId: auth.agentId, byUserId: auth.userId, at: new Date().toISOString() },
    });
    return res.status(202).json({
      pending: true,
      message: `Asked. "${doc.name}" is now flagged for deletion in your user's workspace — they take it down there,`
        + ' and the slot it holds goes back to the workplace the moment they do.'
        + ` The address stays reserved to their account either way, so ${doc.name} can never become somebody else's site.`
        + ' Nothing notifies them, so TELL THEM in your reply.'
        + ' Do not wait for it: end your turn, and you are messaged when they decide.',
    });
  });

  /**
   * The catalogue entry (note #756), after the deploy that wrote it: the line
   * (for a site from before the catalogue, or a better sentence), and the
   * switch. `unlist` is what an agent runs when its user asks; `relist` puts
   * it back. Any agent of the workplace, the same trust as a redeploy — the
   * site is the workplace's, and the catalogue shows only what is public
   * anyway.
   */
  router.post('/deployments/:name/listing', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const configured = requireDeployments(res);
    if (!configured) return;
    const doc = await ownedByName(auth, configured.storage, req.params.name, res);
    if (!doc) return;
    const body = (req.body ?? {}) as { line?: unknown; listed?: unknown };
    if (body.line === undefined && body.listed === undefined) {
      return res.status(400).json({ error: 'Say what to change: a `line` (one sentence on what the app does) or `listed` (true or false).' });
    }
    if (body.listed !== undefined && typeof body.listed !== 'boolean') {
      return res.status(400).json({ error: '`listed` is true or false.' });
    }
    let line: string | undefined;
    if (body.line !== undefined) {
      const parsed = validateSiteListingLine(String(body.line));
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      line = parsed.line;
    }
    const listing: NonNullable<DeploymentDocument['listing']> = {
      ...doc.listing,
      ...(line !== undefined ? { line, updatedAt: new Date().toISOString(), updatedByAgentId: auth.agentId } : {}),
      ...(body.listed !== undefined ? { listed: body.listed as boolean } : {}),
    };
    await configured.storage.update(doc.id, { listing });
    const updated = (await configured.storage.get(doc.id)) ?? { ...doc, listing };
    const described = describe(updated, configured.service.url(updated), auth);
    const message = (() => {
      if (body.listed === false) return `"${updated.name}" is out of ${CATALOGUE_NAME}. \`agentbuilt relist ${updated.name}\` puts it back whenever your user wants it there.`;
      if (described.listing.listed) {
        return `"${updated.name}" is in ${CATALOGUE_NAME} at ${CATALOGUE_URL}: "${updated.listing?.line}".`
          + (described.listing.picture ? '' : ` It has no picture yet: \`agentbuilt listing ${updated.name} --retake\` takes one from a machine with Chrome, or \`--picture <file.png>\` uploads yours.`);
      }
      if (updated.listing?.hiddenByOperator) return `An operator has taken "${updated.name}" out of ${CATALOGUE_NAME}; relisting does not override that.`;
      if (updated.status !== 'live') return `"${updated.name}" is listed, and appears in the catalogue once it is live again (it is ${updated.status}).`;
      return `"${updated.name}" is listed but has no line yet, so the catalogue does not show it: \`agentbuilt listing ${updated.name} --line "<one sentence on what it does>"\`.`;
    })();
    return res.json({ deployment: described, message });
  });

  /**
   * The picture (note #756): one PNG of the site, taken by the deploying
   * machine's Chrome once the address answered, or a file the agent chose.
   * Bytes first, record second, as a proposal's file; the one before it is
   * deleted after, best-effort — a stale object is cheaper than a record
   * promising bytes that are gone.
   */
  router.post(
    '/deployments/:name/listing/picture',
    raw({ type: () => true, limit: LISTING_PICTURE_MAX_BYTES + 1024 }),
    async (req, res) => {
      const auth = await authenticate(req, res);
      if (!auth) return;
      const configured = requireDeployments(res);
      if (!configured) return;
      if (!deps.mediaStorage) {
        return res.status(503).json({ error: 'Picture storage is not available on this backend yet — the catalogue lists the site without one.' });
      }
      const doc = await ownedByName(auth, configured.storage, req.params.name, res);
      if (!doc) return;
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        return res.status(400).json({ error: 'A catalogue picture is a PNG (the CLI takes one at 1280×800 with `agentbuilt listing <name> --retake`).' });
      }
      if (data.length > LISTING_PICTURE_MAX_BYTES) {
        return res.status(400).json({ error: `A catalogue picture is at most ${LISTING_PICTURE_MAX_BYTES / 1024 / 1024} MB; this one is ${(data.length / 1024 / 1024).toFixed(1)} MB.` });
      }
      const previous = doc.listing?.picture?.storagePath;
      const picture = {
        storagePath: ['users', doc.userId, 'sites', doc.id, 'catalogue', `${randomUUID()}.png`].join('/'),
        sizeBytes: data.length,
        takenAt: new Date().toISOString(),
      };
      await deps.mediaStorage.uploadObject({ storagePath: picture.storagePath, contentType: 'image/png', data });
      await configured.storage.update(doc.id, { listing: { ...doc.listing, picture } });
      if (previous && previous !== picture.storagePath) {
        deps.mediaStorage.deleteObject?.({ storagePath: previous }).catch(() => undefined);
      }
      const updated = (await configured.storage.get(doc.id)) ?? doc;
      return res.json({
        deployment: describe(updated, configured.service.url(updated), auth),
        message: siteIsListed(updated)
          ? `Picture saved; the catalogue at ${CATALOGUE_URL} shows it.`
          : `Picture saved. ${listingWords(updated, { picturePending: false }).trim()}`,
      });
    },
  );

  /**
   * A CI run's publish key (`ci-deploy-token.ts`), on `/deploy` — the only
   * route that accepts one. `undefined` when the bearer is not such a key (an
   * agent's own token follows), `null` once a refusal has been sent. Nothing
   * here touches an agent record: a refused key is not an agent's, so it must
   * never trip the stale-token flag that forces a rotation.
   *
   * The publish runs AS the agent that linked the repository to its site: a
   * service reads its saved keys from whoever deploys it, and a key with
   * nobody behind it would have none to hand on.
   */
  const ciPublishAuth = async (req: Request, res: Response): Promise<{
    auth: AgentAuth; siteId: string; repoName: string; sha: string;
  } | null | undefined> => {
    const token = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!looksLikeCiDeployToken(token)) return undefined;
    const scope = deps.ciStatusSecret ? verifyCiDeployToken(deps.ciStatusSecret, token) : null;
    if (!scope) {
      res.status(401).json({ error: 'This publish key is not valid: it is made for one CI run and lasts an hour at most. Nothing was deployed.' });
      return null;
    }
    const repo = await deps.gitRepoStorage?.get(scope.repoId).catch(() => null);
    const link = repo && !repo.deletedAt ? repo.publishTo : undefined;
    if (!repo || !link || link.siteId !== scope.siteId) {
      res.status(403).json({ error: 'This repository no longer publishes to that site: the link was taken off since this run started. Nothing was deployed.' });
      return null;
    }
    const profile = await deps.userStorage?.getProfile(link.byUserId).catch(() => null);
    if (!profile?.telegram?.agents?.[link.byAgentId]) {
      res.status(403).json({
        error: `The agent that linked ${repo.name} to its site no longer exists, so nothing can publish as it. Nothing was deployed.`
          + ` Link the site again from an admin's agent (\`agentbuilt repo publish ${repo.name} <site>\`).`,
      });
      return null;
    }
    const auth = await agentAuthFor(req, res, { userId: link.byUserId, agentId: link.byAgentId }, profile);
    if (!auth) return null;
    return { auth, siteId: scope.siteId, repoName: repo.name, sha: scope.sha };
  };

  router.post(
    '/deploy',
    raw({ type: () => true, limit: MAX_TARBALL_BYTES }),
    async (req, res) => {
      const ciPublish = await ciPublishAuth(req, res);
      if (ciPublish === null) return;
      const auth = ciPublish ? ciPublish.auth : await authenticate(req, res);
      if (!auth) return;
      const configured = requireDeployments(res);
      if (!configured) return;

      const name = (req.get('x-agentbuilt-name') ?? '').trim();
      const requestedPreset = (req.get('x-agentbuilt-preset') ?? '').trim();
      const nameError = validateDeploymentName(name);
      if (nameError) return res.status(400).json({ error: nameError });
      const tarball = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (tarball.length === 0) {
        return res.status(400).json({ error: 'Empty upload — send the gzipped tarball as the request body' });
      }

      const existing = await configured.storage.getByName(name);
      const active = existing && existing.status !== 'destroyed' ? existing : null;

      // The catalogue entry (note #756), written at deploy time by the agent
      // deploying — the one moment the maker's agent is at the keyboard and
      // knows what the app does. The line travels URL-encoded (a header is
      // Latin-1; a line is anyone's language). Present replaces the site's
      // line, absent keeps it; `--unlisted` keeps the site out of the
      // catalogue from the first deploy.
      const lineHeader = req.get('x-agentbuilt-line');
      let listingLine: string | undefined;
      if (lineHeader !== undefined) {
        let decoded = '';
        try { decoded = decodeURIComponent(lineHeader); } catch { decoded = lineHeader; }
        const parsed = validateSiteListingLine(decoded);
        if (!parsed.ok) return res.status(400).json({ error: `${parsed.error} Nothing was deployed.` });
        listingLine = parsed.line;
      }
      const unlisted = (req.get('x-agentbuilt-unlisted') ?? '').trim() === 'true';
      const listingUpdate = (doc: DeploymentDocument | null): DeploymentDocument['listing'] | undefined => {
        if (listingLine === undefined && !unlisted) return undefined;
        return {
          ...doc?.listing,
          ...(listingLine !== undefined ? { line: listingLine, updatedAt: new Date().toISOString(), updatedByAgentId: auth.agentId } : {}),
          ...(unlisted ? { listed: false } : {}),
        };
      };

      // A CI publish only ever REDEPLOYS the one running site its link names,
      // with the keys that site already runs with. Everything else a deploy
      // can do — create, revive, change the preset or the secrets — stays
      // with an agent someone is talking to.
      if (ciPublish) {
        if (!active || active.id !== ciPublish.siteId) {
          const linked = await configured.storage.get(ciPublish.siteId).catch(() => null);
          return res.status(403).json({
            error: `This key publishes ${linked?.name ? `"${linked.name}"` : 'one linked site'} only, not "${name}". Use --name "$AGENTBUILT_SITE". Nothing was deployed.`,
          });
        }
        if (active.status !== 'live') {
          return res.status(409).json({
            error: `"${name}" is ${active.status}, not live: publishing on approval only redeploys a running site. Nothing was deployed.`,
          });
        }
        if (req.get('x-agentbuilt-secrets') !== undefined || req.get('x-agentbuilt-no-secrets') !== undefined) {
          return res.status(400).json({
            error: `A publish from CI keeps the keys "${name}" already runs with; changing them is an agent's deploy, not CI's. Drop --secret / --no-secrets. Nothing was deployed.`,
          });
        }
      }

      // A member may update an already-running site: that is ordinary work
      // and changes no resource footprint. Creating or reviving a machine is
      // workplace spend, so an agent owned by a member cannot do it.
      if (auth.orgId && auth.orgRole !== 'admin' && active?.status !== 'live') {
        return res.status(403).json({
          error: 'Creating or reviving workplace infrastructure is an admin action. A member can redeploy an existing live site.',
        });
      }

      // A name belongs to the account that last held it, standing or not.
      // `active` is null for a deleted site so its OWNER can deploy over their
      // own tombstone, but a stranger must never inherit the address: every
      // link already forwarded to it would start answering with somebody
      // else's site. It is the promise a rename keeps by holding on to
      // `formerNames`, kept here for the other way a name falls vacant.
      // The WORKPLACE is who a name belongs to (note #566), whichever room
      // deployed it: a stranger's name stays a blind "taken", while a name
      // this workplace holds is a redeploy — guarded by the fence below.
      const existingBelongsHere = existing
        && (auth.orgId ? existing.orgId === auth.orgId : existing.userId === auth.userId);
      if (existing && !existingBelongsHere) {
        // Deliberately suggestions, not a silent rename: the name is the
        // user-facing address (and appears on the invoice), so the agent and
        // user choose it — but with live alternatives in hand, resolving the
        // conflict costs one reply instead of a guessing loop.
        const suggestions = await suggestAlternateNames(configured.storage, name, 3, auth.userId);
        return res.status(409).json({
          error: `"${name}" is already taken.`
            + (suggestions.length ? ` Available right now: ${suggestions.join(', ')}.` : ''),
          suggestions,
        });
      }
      // THE FENCE (note #566). A redeploy has no approval gate and is public
      // at once, and any agent in the workplace may do one — accepted, the
      // same trust as Drive. What is NOT accepted is the accident that
      // creates: an agent picking a name for something new, which used to
      // hear "already taken", would now silently replace a colleague's live
      // site. So replacing a live site last deployed by a DIFFERENT agent
      // takes one deliberate word. It asks nobody's permission; it only makes
      // sure the agent knows what it is about to do. The agent that has been
      // deploying a site never meets it.
      // A CI publish never meets it: the owner's answer to the link was the
      // deliberate word, said once for every approved change after it.
      if (!ciPublish
        && active?.status === 'live'
        && (active.lastDeployBy?.agentId ?? active.agentId) !== auth.agentId
        && (req.get('x-agentbuilt-replace') ?? '').trim() !== 'true') {
        const when = active.lastDeployAt ?? active.createdAt;
        return res.status(409).json({
          error: `"${name}" is a LIVE site of this workplace — ${configured.service.url(active)} — last deployed by `
            + `${lastDeployerWords(active, auth)} on ${when.slice(0, 10)}. Deploying here REPLACES what the public sees there, at once, with no approval and no undo.`
            + ' If that is what your user asked for, run the same command with --replace. If you only needed a name for something new, pick another.',
          replaceRequired: true,
        });
      }
      // Saved secrets the service runs with (note #661). The header is the
      // whole list: present replaces it, absent keeps what the site already
      // has, and `x-agentbuilt-no-secrets` clears it. Values are read for
      // THIS deployer either way, so nothing it is not handed can reach code
      // it just shipped.
      const clearSecrets = (req.get('x-agentbuilt-no-secrets') ?? '').trim() === 'true';
      const secretsHeader = clearSecrets ? '' : req.get('x-agentbuilt-secrets');
      let secretNames = active?.secretNames ?? [];
      if (secretsHeader !== undefined) {
        const parsed = parseSiteSecretNames(secretsHeader);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        secretNames = parsed.names;
      }
      const effectivePreset = active?.preset ?? requestedPreset;
      if (secretNames.length > 0 && effectivePreset === 'static') {
        return res.status(400).json({
          error: 'A static site only serves files, so a secret on it would have nowhere to go (and must never be in the files).'
            + ' A key that has to be used while running needs --preset service with a run.sh.',
        });
      }
      let secretEnv: Record<string, string> = {};
      if (secretNames.length > 0) {
        let resolved: Awaited<ReturnType<typeof resolveSiteSecrets>>;
        try {
          resolved = await resolveSiteSecrets({
            secretStorage: deps.secretStorage,
            ...(deps.orgGit ? { resolveNamespace: (u, o) => deps.orgGit!.resolveNamespace(u, o) } : {}),
          }, { userId: auth.userId, orgId: auth.orgId, agentId: auth.agentId }, secretNames);
        } catch (error) {
          return res.status(500).json({ error: `Could not read the secrets for this deploy: ${(error as Error).message}` });
        }
        if (resolved.missing.length > 0) {
          const list = resolved.missing.join(', ');
          return res.status(400).json({
            error: secretsHeader !== undefined
              ? `Nothing was deployed: this agent is not handed ${list}. A site can only run with keys its deployer has —`
                + ' run `agentbuilt secret list`: the key must be saved in this workplace (shared, or private to you).'
                + ' If your owner is a member, a key an admin has not opened to everyone is not handed to you either.'
              : `Nothing was deployed: "${name}" runs with ${list}, and this agent is not handed ${resolved.missing.length > 1 ? 'them' : 'it'}.`
                + ' Every deploy reads a site\'s keys from the agent deploying it. Deploy from an agent that has them,'
                + ' or pass --secret with only the keys you have (or --no-secrets) if dropping them is what your user asked for.',
            missingSecrets: resolved.missing,
          });
        }
        secretEnv = resolved.env;
      }
      const secretWords = secretNames.length > 0
        ? ` It runs with ${secretNames.join(', ')} from your saved secrets, set as environment variables — read them with process.env / os.environ, never write them into files or logs.`
        : '';

      if (active && requestedPreset && requestedPreset !== active.preset) {
        return res.status(409).json({
          error: `"${name}" is a ${active.preset} deployment; its preset can't change on redeploy.`
            + (DEPLOYMENT_UPGRADE_PATHS[active.preset] === requestedPreset
              ? ` Use \`agentbuilt upgrade ${name}\` to move it onto the bigger machine.`
              : ' A different size is a different deployment.'),
        });
      }

      try {
        if (active) {
          switch (active.status) {
            case 'live': {
              await configured.service.syncTarball(active.id, tarball);
              const listing = listingUpdate(active);
              await configured.storage.update(active.id, {
                lastDeployBy: {
                  ...await deployerStamp(auth),
                  ...(ciPublish ? { ci: { repo: ciPublish.repoName, sha: ciPublish.sha } } : {}),
                },
                ...(listing ? { listing } : {}),
              });
              let restarted = false;
              if (secretNames.length > 0 || (active.secretNames?.length ?? 0) > 0) {
                try {
                  restarted = await configured.service.setSecretEnv(active.id, secretEnv, active.secretNames ?? []);
                } catch (error) {
                  // The new content IS live; only the keys did not change.
                  return res.status(500).json({
                    error: `The new content is live at ${configured.service.url(active)}, but its secrets could not be set:`
                      + ` ${redactSiteSecrets((error as Error).message, secretEnv)}. Deploy again to retry.`,
                  });
                }
                await configured.storage.update(active.id, { secretNames: secretNames.length > 0 ? secretNames : undefined });
              }
              const updated = (await configured.storage.get(active.id)) ?? active;
              return res.json({
                deployment: describe(updated, configured.service.url(updated), auth),
                message: `Deployed. Live at ${configured.service.url(updated)}.${secretWords}`
                  + (restarted ? ' The machine restarted to pick up its keys, so give it a few seconds.' : '')
                  + listingWords(updated, { picturePending: siteIsListed(updated) }),
              });
            }
            // Both of these are sites that exist but are not serving (the
            // statuses are plan-era leftovers a stored record may still
            // carry): one was never built, one is paused. The content is
            // staged either way and the bring-up delivers it.
            case 'pending-payment':
            case 'payment-lapsed': {
              const allowance = await hostingAllowance(auth, configured.storage);
              await configured.service.stageTarball(active.id, tarball);
              const revivedListing = listingUpdate(active);
              await configured.storage.update(active.id, {
                lastDeployBy: await deployerStamp(auth),
                secretNames: secretNames.length > 0 ? secretNames : undefined,
                ...(revivedListing ? { listing: revivedListing } : {}),
              });
              const revived = (await configured.storage.get(active.id)) ?? active;
              const reviveResponse = await bringUpResponse(deps, revived, configured.service.url(revived), allowance.wire);
              return res.json({
                ...reviveResponse,
                message: reviveResponse.message + listingWords({ ...revived, status: 'provisioning' }, { picturePending: true }),
              });
            }
            case 'provisioning':
              return res.status(409).json({ error: `"${name}" is being set up right now — try again in a minute.` });
            default:
              return res.status(409).json({
                error: `"${name}" is ${active.status} — an operator has to look at it before it can change.`,
              });
          }
        }

        if (!DEPLOYMENT_PRESETS.includes(requestedPreset as DeploymentPreset)) {
          return res.status(400).json({ error: 'Pass --preset static (site files), --preset service (an app with a run.sh), or --preset service-pro (the same on a 1 GB machine)' });
        }
        const preset = requestedPreset as DeploymentPreset;
        // Every deployed site is listed (the owner, 2026-10-15), so a NEW site
        // says what it does before it is built — refused here rather than
        // listed with nothing to show, because a listing with no line says
        // nothing to a stranger. A redeploy keeps the line it has; a site from
        // before the catalogue is told, in the answer, how to get one.
        if (listingLine === undefined && !unlisted) {
          return res.status(400).json({
            error: `Every deployed site is listed in ${CATALOGUE_FULL_NAME} (${CATALOGUE_URL}), so a first deploy says what the app does:`
              + ' add `--line "<one sentence on what it does, for a stranger>"` to the same command (at most 160 characters),'
              + ' or `--unlisted` if your user does not want it in the catalogue. Nothing was deployed.',
            listingLineRequired: true,
          });
        }
        const kind = siteKindForPreset(preset);
        const allowance = await hostingAllowance(auth, configured.storage);
        if (allowance.sites.length >= MAX_ACTIVE_DEPLOYMENTS_PER_USER) {
          return res.status(403).json({
            error: `This account already has ${allowance.sites.length} sites, which is as many as one account may run without an operator looking at it.`,
          });
        }
        // The ORG ceiling (byo-fly-design: cost guardrails): every site is an
        // always-on machine, so the count is bounded workplace-wide too,
        // across all members. A HOSTED workplace (note #664) runs its sites
        // on our account, and holds HOSTED_SITE_LIMIT of them; one on its own
        // cloud keeps the looser backstop, since the bill is its own.
        if (deps.orgStorage && auth.orgId) {
          const orgSites = await workplaceSiteCount(configured.storage, auth.orgId).catch(() => 0);
          const orgDoc = await deps.orgStorage.getOrg(auth.orgId).catch(() => null);
          const hosted = Boolean(orgDoc && isHostedWorkplace(orgDoc));
          const ceiling = hosted ? HOSTED_SITE_LIMIT : ORG_DEPLOYMENT_LIMIT;
          if (orgSites >= ceiling) {
            return res.status(403).json({
              error: hosted
                ? `Your workplace already runs ${orgSites} sites, which is as many as a workplace can run. Take one down to put up another (\`agentbuilt delete <name>\` asks your user to remove it).`
                : `Your workplace already runs ${orgSites} sites, which is its ceiling — each is an always-on machine on the workplace's cloud bill. Your org admin can ask the platform to raise it.`,
            });
          }
        }
        const doc = await configured.service.createPending({
          userId: auth.userId,
          ...(auth.orgId ? { orgId: auth.orgId } : {}),
          agentId: auth.agentId,
          lastDeployBy: await deployerStamp(auth),
          name,
          preset,
          ...(secretNames.length > 0 ? { secretNames } : {}),
          ...(listingUpdate(null) ? { listing: listingUpdate(null) } : {}),
        });
        // Staged BEFORE the build starts, because provisioning picks the
        // tarball up on its way to live: the address never serves an empty
        // machine, not even for the minute in between.
        await configured.service.stageTarball(doc.id, tarball);
        // The allowance was read before this site existed; the agent is told
        // what it has AFTER the deploy it just made, or the reply says there
        // is room for a site it has this second used up.
        const spent = {
          ...allowance.wire,
          [kind]: { used: allowance.wire[kind].used + 1, limit: allowance.wire[kind].limit },
          ...(allowance.wire.sites ? { sites: { used: allowance.wire.sites.used + 1, limit: allowance.wire.sites.limit } } : {}),
        };
        const response = await bringUpResponse(deps, doc, configured.service.url(doc), spent);
        return res.json({
          ...response,
          message: `${response.message}${secretWords}${listingWords({ ...doc, status: 'provisioning' }, { picturePending: true })}`,
        });
      } catch (error) {
        return res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // ── Internal git repos (docs/agent-git-phase1.md) ──

  /**
   * Which git host serves an org's repos (byo-git-design slice 2b): the org's
   * own, when it has one, else the central host. `orgId` comes from the repo
   * record (or the caller's namespace, before a record exists) — never from
   * anything the request body says.
   */
  const gitHostFor = async (orgId?: string | null) => (
    deps.orgGitHost ? deps.orgGitHost.clientFor(orgId ?? null) : deps.gitHostClient!
  );

  /**
   * How many bytes this namespace may hold (note #62). Asked of the org's git
   * service so the answer follows the DISK the repos are actually on: an org
   * on its own volume is bounded by the volume it pays for, everyone on the
   * shared box keeps the fair share.
   */
  const gitUserMaxBytesFor = async (orgId?: string | null): Promise<number> => (
    deps.orgGitHost ? deps.orgGitHost.userMaxBytesFor(orgId ?? null) : GIT_USER_MAX_BYTES
  );

  /**
   * The bytes that ceiling actually bounds: every namespace of the org — its
   * own and its old rooms' (note #843) — because the ceiling is the org's
   * disk, not a namespace's.
   */
  const gitUsedBytesFor = async (userId: string, orgId: string | null, namespaceId: string): Promise<number> => {
    if (!deps.gitRepoStorage) return 0;
    if (!orgId || !deps.orgGit) return deps.gitRepoStorage.totalBytesForUser(namespaceId);
    const namespaces = new Set([namespaceId, ...await deps.orgGit.namespacesForOrg(userId, orgId)]);
    const sizes = await Promise.all([...namespaces].map((ns) => deps.gitRepoStorage!.totalBytesForUser(ns)));
    return sizes.reduce((total, bytes) => total + bytes, 0);
  };

  const requireGit = (res: Response) => {
    if (!deps.gitRepoStorage || !deps.gitHostClient) {
      res.status(503).json({ error: 'Internal git hosting is not available on this backend yet' });
      return null;
    }
    return { storage: deps.gitRepoStorage, hostFor: gitHostFor };
  };

  /**
   * The git namespace this token acts in (byo-git-design slice 1): the shared
   * org namespace for members of a stamped org, the caller's own userId
   * otherwise — which is also the answer whenever the org layer is not wired.
   * Every repo route resolves through this; auth.userId is an identity, never
   * a namespace.
   */
  const gitNamespace = async (auth: AgentAuth): Promise<GitNamespace> => (
    deps.orgGit
      ? deps.orgGit.resolveNamespace(auth.userId, auth.orgId)
      : { namespaceId: auth.userId, orgId: null, role: null }
  );

  /**
   * Where a workplace's repositories may live (note #566). A repository
   * belongs to the workplace: the namespace in its clone URL is only the
   * address of its bytes, so every agent reaches every repository at any of
   * these. A personal account has its one namespace.
   */
  const workplaceNamespaces = async (auth: AgentAuth, ns: GitNamespace): Promise<string[]> => (
    ns.orgId && deps.orgGit
      ? deps.orgGit.namespacesForOrg(auth.userId, ns.orgId)
      : [ns.namespaceId]
  );

  /**
   * Where a new note's or knowledge proposal's NUMBER comes from (note #741):
   * one series for the whole workplace, seeded above every number any of its
   * namespaces holds, so a number names exactly one thing anywhere in it. A
   * personal account is its own series.
   */
  const numberSeries = async (auth: AgentAuth, ns: GitNamespace): Promise<NumberSeries> => ({
    series: workplaceNumberSeries(ns.orgId, ns.namespaceId),
    namespaces: await numberedNamespaces(auth, ns),
  });

  /** Every namespace a note or proposal number is looked for in: the
   *  workplace's, plus its old rooms' (note #843), where records numbered
   *  before 12 Oct 2026 may still stand. A small deployment may wire the org
   *  store without the git service. */
  const numberedNamespaces = async (auth: AgentAuth, ns: GitNamespace): Promise<string[]> => {
    const namespaces = new Set([ns.namespaceId, ...await workplaceNamespaces(auth, ns)]);
    if (ns.orgId && deps.orgStorage) {
      const org = await deps.orgStorage.getOrg(ns.orgId).catch(() => null);
      for (const namespace of org?.roomsMerged?.namespaces ?? []) namespaces.add(namespace);
    }
    return [...namespaces];
  };

  /**
   * A number held twice in the workplace, neither copy at its own namespace.
   * Only numbers issued before note #741 (12 Oct 2026) can be, in the old
   * rooms' namespaces (note #843). Nothing names which one; the person does.
   */
  const sharedNumberError = async (thing: string, number: number, _namespaces: string[]): Promise<string> => (
    `${thing} #${number} is held twice in this workplace (numbers were per room before 12 Oct 2026). Ask your user which one was meant.`
  );

  /** Where a NEW repository's bytes go: the workplace's own namespace. */
  const newRepoNamespace = async (auth: AgentAuth): Promise<GitNamespace> => (
    deps.orgGit
      ? deps.orgGit.resolveNamespace(auth.userId, auth.orgId)
      : { namespaceId: auth.userId, orgId: null, role: null }
  );

  /** A shared namespace makes proposals visible to teammates, not mutable by
   * them. New records name their human author; legacy records prove the same
   * ownership through the proposing agent in this human's org-scoped fleet. */
  const proposalOwnedByAuth = (
    auth: AgentAuth,
    doc: { createdByUserId?: string; createdByAgentId: string },
  ): boolean => doc.createdByUserId
    ? doc.createdByUserId === auth.userId
    : Boolean(auth.agents[doc.createdByAgentId]);

  /**
   * Where a public repository opens (public-addresses, slice 6): under its
   * workplace's handle, `/acme/site`, when the workplace has one; the
   * link-only token door only for a workplace the boot backfill has not
   * reached. The handle is the caller's to look up once per answer.
   */
  const publicRepoUrl = (doc: GitRepoDocument, orgHandle: string | undefined): string => {
    const origin = (deps.workspaceWebOrigin ?? '').replace(/\/+$/, '');
    const path = orgHandle && doc.publicAccess
      ? workspaceRoutePath({ kind: 'workplaceRepo', handle: orgHandle, repo: doc.name })!
      : `${WORKSPACE_BASE}/public/repositories/${encodeURIComponent(doc.publicAccess?.id ?? '')}`;
    return `${origin}${path}`;
  };
  const orgHandleOf = async (orgId: string | null | undefined): Promise<string | undefined> => (
    orgId && deps.orgStorage ? (await deps.orgStorage.getOrg(orgId).catch(() => null))?.handle : undefined
  );

  const describeRepo = (doc: GitRepoDocument, cloneUrl: string, orgHandle?: string) => ({
    name: doc.name,
    cloneUrl,
    sizeBytes: doc.sizeBytes,
    protectedBranch: doc.protectDefaultBranch ? (doc.defaultBranch ?? 'main') : null,
    ...(doc.requireChecks ? { requireChecks: true } : {}),
    ...(doc.ci ? { ci: true } : {}),
    ...(doc.ciSecrets?.length ? { ciSecrets: doc.ciSecrets } : {}),
    createdAt: doc.createdAt,
    ...(doc.lastPushAt ? { lastPushAt: doc.lastPushAt } : {}),
    ...(doc.publicAccess ? {
      publicUrl: publicRepoUrl(doc, orgHandle),
      publishedAt: doc.publicAccess.publishedAt,
    } : {}),
  });

  /** A deleted repo as the trash shows it: what it was, and how long the
   *  bytes are still there. No clone URL — it does not answer one. */
  const describeTrashedRepo = (doc: GitRepoDocument) => ({
    name: doc.name,
    sizeBytes: doc.sizeBytes,
    deletedAt: doc.deletedAt,
    restorableUntil: doc.deletedAt ? restorableUntil(doc.deletedAt) : undefined,
  });

  router.get('/repos', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requireGit(res);
    if (!git) return;
    const ns = await gitNamespace(auth);
    const host = await git.hostFor(ns.orgId);
    const namespaces = await workplaceNamespaces(auth, ns);
    const docs = await git.storage.listLiveIn(namespaces);
    const trashed = await git.storage.listTrashedIn(namespaces);
    return res.json({
      repos: await Promise.all(docs.map(async (doc) => describeRepo(doc, host.cloneUrl(doc.userId, doc.name), await orgHandleOf(doc.orgId)))),
      // Only when there is one: an empty key on every list would read as a
      // feature the account has, rather than a shelf that happens to be full.
      ...(trashed.length ? { trash: trashed.map(describeTrashedRepo) } : {}),
      quota: {
        repoMaxBytes: GIT_REPO_MAX_BYTES,
        userMaxBytes: await gitUserMaxBytesFor(ns.orgId),
        userUsedBytes: await gitUsedBytesFor(auth.userId, ns.orgId, ns.namespaceId),
      },
    });
  });

  router.post('/repos', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requireGit(res);
    if (!git) return;
    const name = String((req.body as { name?: unknown })?.name ?? '').trim();
    const nameError = validateGitRepoName(name);
    if (nameError) {
      return res.status(400).json({ error: nameError });
    }
    // `--unprotected` is opt-IN: an omitted flag must never weaken the phase-2
    // approval gate, so anything other than an explicit `false` protects.
    const protectDefaultBranch = (req.body as { protect?: unknown })?.protect !== false;

    let ns = await newRepoNamespace(auth);
    // The first repo of a client org is what builds its git host (lazy,
    // idempotent, a quiet no-op everywhere else). Re-resolve after: the
    // provision stamps the org, which moves the namespace to the orgId.
    if (deps.orgGitHost && ns.orgId) {
      try {
        if (await deps.orgGitHost.maybeProvisionForOrg(ns.orgId)) {
          ns = await newRepoNamespace(auth);
        }
      } catch (error) {
        return res.status(502).json({
          error: `Could not bring up your workplace's git host: ${(error as Error).message}`,
        });
      }
    }
    const host = await git.hostFor(ns.orgId);
    const namespaces = await workplaceNamespaces(auth, ns);
    const existing = await git.storage.getLiveByNameIn(namespaces, name);
    if (existing) {
      // Not an error: a retried create (or a second agent reaching for the
      // same repo) should hand back the same clone URL rather than fail a
      // turn over a race the user does not care about.
      return res.json({
        repo: describeRepo(existing, host.cloneUrl(existing.userId, existing.name), await orgHandleOf(existing.orgId)),
        created: false,
      });
    }
    try {
      // Disk first, record second: a directory with no record is invisible
      // and harmless, while a record with no directory is a repo whose clone
      // URL 404s — the failure the agent cannot diagnose.
      await host.createRepo(ns.namespaceId, name, {
        ...(protectDefaultBranch ? { protectedBranches: ['main'] } : {}),
      });
      const doc = await git.storage.create({
        userId: ns.namespaceId,
        ...(ns.orgId ? { orgId: ns.orgId } : {}),
        name,
        createdByAgentId: auth.agentId,
        sizeBytes: 0,
        protectDefaultBranch,
      }, namespaces);
      return res.status(201).json({
        repo: describeRepo(doc, host.cloneUrl(doc.userId, doc.name), await orgHandleOf(doc.orgId)),
        created: true,
      });
    } catch (error) {
      return res.status(500).json({ error: (error as Error).message });
    }
  });

  // Protection is add-only, mirroring the approval gate's shape: an agent may
  // narrow what agents can do to a repo, never widen it. There is no
  // unprotect route — absent, like the approve route — and a repo created
  // `--unprotected` stays that way (the docs on every machine promise it).
  router.post('/repos/:name/protect', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Changing workplace repository protection is an admin action.' });
    }
    const git = requireGit(res);
    if (!git) return;
    const doc = await ownedRepo(auth, git.storage, String(req.params.name ?? ''), res);
    if (!doc) return;
    const body = (req.body ?? {}) as { branches?: unknown; requireChecks?: unknown };
    const branches = Array.isArray(body.branches) ? body.branches.map((value) => String(value).trim()) : [];
    // Add-only in both directions: `true` narrows what can merge, so an
    // agent may say it; `false` would widen, so it is simply not a thing
    // this route can express — same shape as protection itself.
    const requireChecks = body.requireChecks === true;
    if (branches.length === 0 && !requireChecks) {
      return res.status(400).json({
        error: 'Pass the branches to protect, e.g. {"branches":["dev"]} — and/or {"requireChecks":true}',
      });
    }
    for (const branch of branches) {
      const branchError = validateBranchName(branch);
      if (branchError) return res.status(400).json({ error: branchError });
    }
    if (!doc.protectDefaultBranch) {
      // The record answers before the host does: --unprotected is a product
      // promise, and the host's own config check backs it up underneath.
      return res.status(409).json({
        error: `"${doc.name}" was created --unprotected, which is permanent. Protected work belongs in a repo created without that flag.`,
      });
    }
    try {
      const host = await git.hostFor(doc.orgId);
      const result = branches.length > 0
        ? await host.protect(doc.userId, doc.name, branches)
        : { branches: (await host.statRepo(doc.userId, doc.name)).protectedBranches ?? [] };
      if (requireChecks && !doc.requireChecks) {
        await git.storage.update(doc.id, { requireChecks: true });
      }
      return res.json({
        protectedBranches: result.branches,
        requireChecks: requireChecks || doc.requireChecks === true,
      });
    } catch (error) {
      return res.status(502).json({ error: (error as Error).message });
    }
  });

  /**
   * Turn a repo's CI on or off (docs/ci-two-lane-runner.md — this replaces
   * "opt-in is an operator with a shell on the git host"). Agent-reachable
   * in BOTH directions, unlike protection: CI grants no authority, moves no
   * branch, and reads nothing the agent could not already read — enabling it
   * only means a push starts the repo's own committed `.agentbuilt/ci.sh` on
   * a throwaway machine. Secrets are the thing that needs an owner's tap,
   * and they have their own gate.
   *
   * The request carries a boolean. It cannot carry a URL: the host holds the
   * one dispatcher address, because a caller-supplied one would turn a box
   * inside the private network into an SSRF proxy.
   */
  router.post('/repos/:name/ci', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requireGit(res);
    if (!git) return;
    const repo = await ownedRepo(auth, git.storage, String(req.params.name ?? ''), res);
    if (!repo) return;
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      return res.status(400).json({ error: 'Pass {"enabled": true} or {"enabled": false}' });
    }
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({
        error: 'Changing workplace CI is an admin action because it controls billable builds and shared checks.',
      });
    }
    try {
      const result = await (await git.hostFor(repo.orgId)).setCi(repo.userId, repo.name, body.enabled);
      // The host's config is the truth; this is the product's copy of it, so
      // it is written only after the host agreed.
      await git.storage.update(repo.id, { ci: result.ci });
      return res.json({
        ci: result.ci,
        message: result.ci
          ? 'CI is on: every push runs this repo\'s .agentbuilt/ci.sh on a throwaway machine, and the result shows on your proposals. Commit that script if it does not exist yet — without one, runs report "skipped".'
          : 'CI is off: pushes here start no builds.',
      });
    } catch (error) {
      // 409 from the host ("no CI dispatcher configured") arrives as a thrown
      // message; hand it to the agent rather than dressing it as our failure.
      return res.status(502).json({ error: (error as Error).message });
    }
  });

  /**
   * CI secrets for a repo (docs/ci-two-lane-runner.md phase 3). Two verbs in
   * one route:
   *
   * - GRANT (default): validates the names and writes `ciSecrets` at once
   *   (note #739). Until then the route only recorded an ask the owner
   *   decided on the repository's screen; the owner chose to drop that tap,
   *   because the names only ever reach runs on the protected branch — code
   *   they already approved through the merge gate — and only an ADMIN's own
   *   agent may grant. The owner is told in the chat instead, and the grant
   *   stands on the repository's screen where any agent can be asked to take
   *   it back.
   * - REMOVE (`remove: true`): applied directly, by any agent. Taking a
   *   secret away from CI narrows exposure — a thing an agent may always say,
   *   like protection.
   */
  router.post('/repos/:name/ci-secrets', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requireGit(res);
    if (!git) return;
    if (!deps.secretStorage) {
      return res.status(503).json({ error: 'Secrets are not available on this backend yet' });
    }
    const repo = await ownedRepo(auth, git.storage, String(req.params.name ?? ''), res);
    if (!repo) return;
    const body = (req.body ?? {}) as { names?: unknown; remove?: unknown };
    const names = Array.isArray(body.names)
      ? [...new Set(body.names.map((value) => String(value).trim()).filter(Boolean))]
      : [];
    if (names.length === 0) {
      return res.status(400).json({ error: 'Pass the secret NAMES, e.g. {"names":["CLOUDFLARE_API_TOKEN"]}' });
    }

    if (body.remove === true) {
      const kept = (repo.ciSecrets ?? []).filter((name) => !names.includes(name));
      // An emptied grant names no room any more.
      await git.storage.update(repo.id, {
        ciSecrets: kept,
        ...(kept.length === 0 ? { ciSecretsNamespaceId: undefined, ciSecretsRoomId: undefined } : {}),
      });
      return res.json({
        ciSecrets: kept,
        message: 'Removed. CI runs of this repo stop receiving them from the next job.',
      });
    }
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({
        error: 'Workplace secrets are an admin action. This member-owned agent may narrow CI access, but only an admin-owned agent may request a new grant.',
      });
    }

    if (!repo.protectDefaultBranch) {
      // No protected branch means no run the owner has vouched for — a secret
      // handed to this repo's CI would ride ANY push.
      return res.status(409).json({
        error: `"${repo.name}" was created --unprotected, so no branch carries owner-approved code — there is nothing safe to hand a secret to.`,
      });
    }
    const granted = repo.ciSecrets ?? [];
    // Secrets belong to the workplace (note #783), so every grant draws from
    // the same store. One recorded at a namespace whose store is NOT this
    // one — which only a personal account can hold — stays one per repo.
    const askerNamespaceId = (await gitNamespace(auth)).namespaceId;
    const sameStore = repoCiSecretsNamespaceId(repo) === askerNamespaceId
      || (deps.orgGit
        ? (await deps.orgGit.secretShelfFor(repoCiSecretsNamespaceId(repo))) === (await deps.orgGit.secretShelfFor(askerNamespaceId))
        : false);
    if (granted.length > 0 && !sameStore) {
      return res.status(409).json({
        error: `"${repo.name}" already draws its CI secrets from another store — one store per repository.`
          + ' To change it, remove every granted name first (`--remove`).',
      });
    }
    const wanted = names.filter((name) => !granted.includes(name));
    if (wanted.length === 0) {
      return res.json({ ciSecrets: granted, message: 'Already granted — CI runs on the protected branch receive these.' });
    }
    // Every asked name must BE a saved shared secret of the workplace: a name
    // that resolves to nothing grants nothing, and an agent-private secret is
    // one agent's own key, not CI material.
    // `/git/ci-secrets` reads the same projection when the job boards.
    const summaries = await new UserSecretsService(deps.secretStorage).listSecrets(askerNamespaceId);
    const shared = new Set(summaries.filter((s) => s.scope.kind === 'shared').map((s) => s.name));
    for (const name of wanted) {
      if (/^CI_/i.test(name)) {
        return res.status(400).json({ error: `"${name}" collides with the CI runner's own env contract (CI_*).` });
      }
      if (!shared.has(name)) {
        return res.status(404).json({
          error: `No SHARED secret named "${name}" in this workplace — check \`agentbuilt secret list\`. Agent-private secrets never reach CI.`,
        });
      }
    }
    const merged = [...new Set([...granted, ...wanted])];
    await git.storage.update(repo.id, {
      ciSecrets: merged,
      ciSecretsNamespaceId: askerNamespaceId,
      // An ask recorded before grants applied at once has nothing left to
      // decide: this grant covers it.
      ciSecretsAsk: undefined,
    });
    const told = await deps.tellOwnerCiSecretsGranted?.({
      userId: auth.userId,
      agentId: auth.agentId,
      repoId: repo.id,
      names: wanted,
    }).catch(() => false) ?? false;
    return res.json({
      ciSecrets: merged,
      message: `Granted: CI runs of ${repo.name} on its protected branch receive ${wanted.join(', ')} in their environment from the next run there. Runs on other branches never see them.`
        + (told
          ? ` Your user has been told in the chat and sees the grant on the repository's screen (Repositories → ${repo.name}); nothing waits for their approval.`
          : ` The chat line telling your user could not be written — say in your reply which names approved CI now receives; the grant shows on the repository's screen (Repositories → ${repo.name}).`)
        + ' Any agent takes a name back with `--remove`.',
    });
  });

  /** A linked site's name as it is NOW: the link holds the record's id, so a
   *  rename since is followed rather than reported under the old name. */
  const currentSiteName = async (link: { siteId: string; site: string }): Promise<string> => (
    (await deps.deploymentStorage?.get(link.siteId).catch(() => null))?.name ?? link.site
  );

  /**
   * Publishing on approval (`agentbuilt repo publish`). Before this, the only
   * key that could publish a site was an agent's own, re-minted on every
   * identity write — so a merge reached the live site only when the agent
   * that proposed it was awake to publish it by hand.
   *
   * The same two verbs as `ci-secrets`:
   * - LINK `{site}`: an admin's agent writes `publishTo` at once (note #739;
   *   before it, the owner answered an ask on the repository's screen). From
   *   then on approving a merge IS publishing it — which still rides their
   *   own tap on every proposal — so the owner is TOLD exactly that in the
   *   chat rather than asked first.
   * - OFF `{off: true}`: applied directly, by any agent. Going back to
   *   publishing by hand narrows what CI can do, like removing a secret.
   */
  router.post('/repos/:name/publish', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requireGit(res);
    if (!git) return;
    const configured = requireDeployments(res);
    if (!configured) return;
    const repo = await ownedRepo(auth, git.storage, String(req.params.name ?? ''), res);
    if (!repo) return;
    const body = (req.body ?? {}) as { site?: unknown; off?: unknown };

    if (body.off === true) {
      const was = repo.publishTo ? await currentSiteName(repo.publishTo) : null;
      await git.storage.update(repo.id, { publishTo: undefined, publishAsk: undefined });
      return res.json({
        publishesTo: null,
        message: was
          ? `Off. Approved changes to ${repo.name} no longer publish ${was} on their own; whoever merges publishes by hand again.`
          : repo.publishAsk
            ? `Withdrawn: the ask to publish ${await currentSiteName(repo.publishAsk)} is off your user's screen, and ${repo.name} stays published by hand.`
            : `${repo.name} was not publishing anywhere; nothing changed.`,
      });
    }

    const siteName = typeof body.site === 'string' ? body.site.trim() : '';
    if (!siteName) {
      return res.status(400).json({ error: 'Pass the site, e.g. {"site":"my-game"} — or {"off":true} to stop publishing.' });
    }
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({
        error: 'Linking a repository to a live site is an admin action: after it, approving a merge publishes to the public. This member-owned agent may turn publishing off, but only an admin-owned agent may ask for it.',
      });
    }
    if (!repo.protectDefaultBranch) {
      return res.status(409).json({
        error: `"${repo.name}" was created --unprotected, so nothing on it is approved before it lands — publishing it on every push would put unreviewed code live.`,
      });
    }
    if (!repo.ci) {
      return res.status(409).json({
        error: `CI is off for "${repo.name}", and publishing rides its checks: a protected-branch run that passes is what publishes.`
          + ` Turn it on first (\`agentbuilt repo ci enable ${repo.name}\`) and commit a .agentbuilt/ci.sh.`,
      });
    }
    const site = await ownedByName(auth, configured.storage, siteName, res);
    if (!site) return;
    if (site.status !== 'live') {
      return res.status(409).json({
        error: `"${site.name}" is ${site.status}, not live. Publishing on approval only ever REDEPLOYS a running site — deploy it once yourself, then link it.`,
      });
    }
    if (repo.publishTo?.siteId === site.id) {
      return res.json({
        publishesTo: site.name,
        message: `Already linked: approved changes to ${repo.name} publish ${site.name}.`,
      });
    }
    // Newest wins: a link to another site is replaced, and the reply says so.
    const replaced = repo.publishTo && repo.publishTo.siteId !== site.id ? await currentSiteName(repo.publishTo) : null;
    await git.storage.update(repo.id, {
      publishTo: { siteId: site.id, site: site.name, byAgentId: auth.agentId, byUserId: auth.userId, at: new Date().toISOString() },
      // An ask recorded before links applied at once is answered by this link.
      publishAsk: undefined,
    });
    const told = await deps.tellOwnerPublishLinked?.({
      userId: auth.userId,
      agentId: auth.agentId,
      repoId: repo.id,
    }).catch(() => false) ?? false;
    return res.json({
      publishesTo: site.name,
      message: `Linked: approved changes to ${repo.name} now publish ${site.name} on their own, as you${replaced ? ` (instead of ${replaced})` : ''}.`
        + ` After a run of .agentbuilt/ci.sh on the protected branch passes, the repo's .agentbuilt/deploy.sh runs on the same machine`
        + ` with AGENTBUILT_SITE=${site.name} and a one-hour key for that site alone — commit one if it is not there yet`
        + ' (for example `agentbuilt deploy dist --name "$AGENTBUILT_SITE"`).'
        + ` Its result is the deploy/${site.name} check on the merged commit: read it with \`agentbuilt repo checks ${repo.name} --sha <sha> --wait\``
        + ' before you tell your user a change is live.'
        + (told
          ? ' Your user has been told in the chat that approving a change here now publishes it; nothing waits for their approval.'
          : ` The chat line telling your user could not be written — say in your reply that approving a change to ${repo.name} now publishes ${site.name}.`)
        + ` They see the link on the repository's screen (Repositories → ${repo.name}); any agent turns it off with \`--off\`.`,
    });
  });

  // ── Admin surface (docs/agent-git-project-repos.md slice 5) ──
  //
  // Delete, restore, rename, show — and the shape of the first one is the
  // point: DELETING IS NOT AN AGENT VERB. `repo delete` records an ask and
  // nothing else; the repo goes when its owner deletes it in the workspace,
  // which is the only surface in the product that can. Not restricted, not
  // rate-limited: there is no route here that removes a repo, exactly as
  // there is no `pr approve`.
  //
  // Restore and rename ARE agent verbs. Neither destroys anything: one brings
  // bytes back, the other moves a directory the user already owns.

  /**
   * The CI verdict for one commit — the read an agent needs BEFORE it opens a
   * proposal.
   *
   * The Mini App has had this since the checks pip shipped, but only behind
   * Telegram init-data auth, so the agent doing the pushing could not see its
   * own build. That left the honest sequence (push, wait for green, then ask)
   * impossible to follow, and every proposal card arrived with a spinning pip
   * the user had to sit through.
   *
   * Read-only, and scoped like every other route here: the token's user must
   * own the repo. `?sha=` defaults to nothing rather than to a guess — the
   * caller knows which commit it pushed, and resolving "latest" server-side
   * would race the push report that pins it.
   */
  router.get('/repos/:name/checks', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requireGit(res);
    if (!git) return;
    if (!deps.gitCommitStatusStorage) {
      return res.status(503).json({ error: 'CI statuses are not available on this backend yet' });
    }
    const repo = await ownedRepo(auth, git.storage, String(req.params.name ?? ''), res);
    if (!repo) return;
    const sha = String(req.query.sha ?? '').trim();
    if (sha && !/^[0-9a-f]{40}$/.test(sha)) {
      return res.status(400).json({ error: 'sha must be 40 hex chars' });
    }
    const docs = sha
      ? await deps.gitCommitStatusStorage.listBySha(repo.id, sha)
      : await deps.gitCommitStatusStorage.listRecentByRepo(repo.id, AGENT_CHECK_RUNS_LIMIT);
    const now = new Date();
    const runs = docs.map((doc) => ({
      sha: doc.sha,
      context: doc.context,
      // Stale-pending reads as 'error' here exactly as it does on every other
      // surface: an agent polling a stranded pending would wait out its whole
      // turn on a daemon that died half an hour ago.
      state: effectiveStatusState(doc, now),
      description: doc.description,
      startedAt: doc.startedAt,
      ...(doc.completedAt ? { completedAt: doc.completedAt } : {}),
      ...(doc.logTail ? { logTail: doc.logTail } : {}),
    }));
    // NOT SETTLED UNTIL CI HAS SPOKEN. On a repo with CI on, every push gets
    // a `ci/checks` job — but a quick ancillary job (the GitHub mirror, in
    // seconds) files and finishes before the runner has filed CI's pending,
    // and in that gap "every run is terminal" was TRUE of a sha whose test
    // suite had not started. `--wait` returned green in three seconds on
    // exactly that, live (2026-09-06, again 2026-09-17). So the one context
    // CI is guaranteed to file is required to be there before the sha reads
    // settled; the stale horizon still bounds a wait for a pending that
    // never gets filed.
    const awaitingContexts = repo.ci && !runs.some((run) => run.context === ORG_CI_CONTEXT)
      ? [ORG_CI_CONTEXT]
      : [];
    const settled = runs.length > 0
      && runs.every((run) => run.state !== 'pending')
      && awaitingContexts.length === 0;
    // HOW LONG A WAIT CAN HONESTLY BE (note #549). The CLI used to give up on
    // `--wait` after a fixed ten minutes, on a suite that takes eleven: the
    // wait returned without a verdict and the chain it was gating broke in
    // the middle. But this route already guarantees an end — a pending older
    // than GIT_COMMIT_STATUS_STALE_PENDING_MS READS as `error` above, so
    // every sha settles, from the reader's side, within that window of its
    // pending being filed. That horizon is what a caller should wait for, and
    // it belongs here rather than as a second copy of the constant in the CLI,
    // where the two would drift. Absent once settled: there is nothing to
    // wait for.
    const settlesWithinSeconds = settled ? undefined : Math.max(0, Math.ceil(
      docs
        .filter((doc) => effectiveStatusState(doc, now) === 'pending')
        .reduce(
          (latest, doc) => Math.max(latest, new Date(doc.startedAt).getTime() + GIT_COMMIT_STATUS_STALE_PENDING_MS),
          // No pending filed yet (or CI's not yet): the runner files one
          // within seconds of a push, so the window is counted from now.
          runs.length === 0 || awaitingContexts.length > 0
            ? now.getTime() + GIT_COMMIT_STATUS_STALE_PENDING_MS
            : 0,
        ) / 1000 - now.getTime() / 1000,
    ));
    // And how long the LAST finished run of the same checks took, so the
    // caller can say "ci/checks usually takes 11 minutes" while it waits, and
    // an agent picking its own bound picks a sensible one. The slowest
    // context is the one that decides when the whole sha settles, so it is
    // the one reported. Terminal-without-a-duration states (skipped,
    // superseded) never ran and are not a run's length.
    const lastRunSeconds = await lastFinishedRunSeconds(
      deps.gitCommitStatusStorage, repo.id,
      new Set(runs.map((run) => run.context)),
    );
    // A sha with NO statuses is ambiguous: "the runner has not filed its
    // pending yet" and "this commit never reached the host" look identical —
    // and the second waits a whole --wait budget for a verdict that can never
    // come (a rejected push is exactly how it happens: git refused, a pipe
    // masked it, and the caller polled a sha nobody has). One host question
    // settles it, asked only in the empty case so settled polls never touch
    // the host.
    let commitKnown: boolean | undefined;
    if (sha && runs.length === 0) {
      try {
        await (await git.hostFor(repo.orgId)).commit(repo.userId, repo.name, sha);
        commitKnown = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/\(404\)/.test(message) && /no such commit/i.test(message)) commitKnown = false;
        // Anything else (host waking, network) stays silent — a guess here
        // would turn a sleepy machine into "your push never landed".
      }
    }
    return res.json({
      runs,
      // `ci: false` and "no runs yet" are the same empty array but opposite
      // instructions: one means never wait, the other means wait. Saying which
      // is the whole reason an agent can act on this without polling forever.
      ci: Boolean(repo.ci),
      ...(sha ? { sha } : {}),
      ...(commitKnown !== undefined ? { commitKnown } : {}),
      settled,
      ...(settlesWithinSeconds !== undefined && commitKnown !== false ? { settlesWithinSeconds } : {}),
      // The checks CI will file but has not yet — so a waiting CLI can say
      // what it is waiting FOR when nothing on the list is pending.
      ...(awaitingContexts.length > 0 && commitKnown !== false ? { awaitingContexts } : {}),
      ...(lastRunSeconds !== undefined ? { lastRunSeconds } : {}),
    });
  });

  /** Everything about one repo in one place — the settings screen for a
   *  surface whose every mutation already has its own verb. The host's copy
   *  of protection and CI is the truth; the record is asked only for what the
   *  host does not know (grants, checks, timestamps). */
  router.get('/repos/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requireGit(res);
    if (!git) return;
    const repo = await ownedRepo(auth, git.storage, String(req.params.name ?? ''), res);
    if (!repo) return;
    const host = await git.hostFor(repo.orgId);
    const cloneUrl = host.cloneUrl(repo.userId, repo.name);
    let stat: GitHostRepoStat | null = null;
    try {
      stat = await host.statRepo(repo.userId, repo.name);
    } catch {
      // A host we cannot reach costs the live numbers, not the answer: the
      // record still knows what this repo is and who may do what to it.
    }
    // `describeRepo`'s single `protectedBranch` is the LIST's answer, derived
    // from the default branch — which is the branch that has commits, not the
    // one the hook refuses. A repo pushed only to `proof` reports its default
    // as `proof` while `main` is the protected branch, so a screen carrying
    // both keys states two different things about the same repo. Here, where
    // the host has just been asked, its config replaces that guess instead of
    // sitting beside it.
    const { protectedBranch, ...listed } = describeRepo(repo, cloneUrl, await orgHandleOf(repo.orgId));
    return res.json({
      repo: {
        ...listed,
        defaultBranch: stat?.defaultBranch ?? repo.defaultBranch,
        ...(stat
          ? { protectedBranches: stat.protectedBranches ?? [], sizeBytes: stat.sizeBytes }
          // No answer from the host: the record's guess is all there is, and
          // it is labelled as the guess it is by the note below.
          : { protectedBranches: protectedBranch ? [protectedBranch] : [] }),
        ...(repo.defaultBranchPushAt ? { lastLandedAt: repo.defaultBranchPushAt } : {}),
        ...(repo.publishTo ? { publishesTo: await currentSiteName(repo.publishTo) } : {}),
        ...(repo.deleteAsk ? { deleteAsked: true } : {}),
      },
      ...(stat ? {} : { note: 'The git host did not answer just now — sizes and branch protection are from the last known state.' }),
    });
  });

  /**
   * ASKS for a repo to be deleted. That is the whole verb — this route moves
   * no bytes and writes no tombstone, whatever the repo's protection is.
   *
   * Deleting is a thing the owner does in their workspace, with the repo in
   * front of them. There is no card for it either: a delete has no deadline
   * and does not belong in the notification channel a user cannot mute, and
   * the workspace can show what is actually at stake — the size, the
   * proposals, the history — which a chat card cannot. The cost is honest and
   * worth saying to the agent in words: nothing pushes, so the agent has to
   * ASK IN CHAT if it matters.
   */
  router.post('/repos/:name/delete', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Deleting a shared repository is a workplace admin action.' });
    }
    const git = requireGit(res);
    if (!git) return;
    const repo = await ownedRepo(auth, git.storage, String(req.params.name ?? ''), res);
    if (!repo) return;
    await git.storage.update(repo.id, {
      // Newest wins, one at a time: a second ask before the user has looked
      // simply replaces this one, the same as every other ask on a repo.
      deleteAsk: { byAgentId: auth.agentId, byUserId: auth.userId, at: new Date().toISOString() },
    });
    return res.status(202).json({
      pending: true,
      message: `Asked. "${repo.name}" is now flagged for deletion in your user's workspace — they remove it there,`
        + ` with one tap, and it stays restorable for ${GIT_TRASH_KEEP_DAYS} days after that.`
        + ' Nothing notifies them, so TELL THEM in your reply if this matters.'
        + ' Do not wait for it: end your turn, and you are messaged when they decide.',
    });
  });

  /**
   * Undo, within the window. Agent-reachable whatever the repo's protection
   * was: bringing bytes back destroys nothing, and the tap that deleted a
   * protected repo does not have to be spent again to correct a mistake.
   */
  router.post('/repos/:name/restore', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requireGit(res);
    if (!git) return;
    const name = String(req.params.name ?? '');
    const namespaces = await workplaceNamespaces(auth, await gitNamespace(auth));
    const repo = await git.storage.getTrashedByNameIn(namespaces, name);
    if (!repo) {
      return res.status(404).json({ error: `Nothing named "${name}" is in this account's trash.` });
    }
    if (await git.storage.getLiveByNameIn(namespaces, name)) {
      return res.status(409).json({
        error: `A repo named "${name}" exists again — rename that one first, then restore this.`,
      });
    }
    if (!repo.trashedAs) {
      return res.status(409).json({
        error: `"${name}" was deleted before this account could record where its bytes went — it cannot be restored.`,
      });
    }
    try {
      await (await git.hostFor(repo.orgId)).restoreRepo(repo.userId, name, repo.trashedAs);
    } catch (error) {
      // 409 from the host: purged, or the name is taken on disk. Its words
      // are about the repo, so they reach the agent unchanged.
      return res.status(409).json({ error: (error as Error).message });
    }
    await git.storage.update(repo.id, {
      deletedAt: undefined,
      deletedByAgentId: undefined,
      trashedAs: undefined,
    });
    return res.json({
      restored: true,
      cloneUrl: (await git.hostFor(repo.orgId)).cloneUrl(repo.userId, name),
      message: `"${name}" is back, with its history and its branch protection.`
        + ' Proposals that were open when it went are still withdrawn — re-propose what still matters.',
    });
  });

  /**
   * Rename inside the user's own namespace. Not gated by protection: nothing
   * is destroyed and nothing lands on a branch — but it DOES change the clone
   * URL, so the answer says so, because a remote that 404s tomorrow is the
   * whole cost of this verb.
   */
  router.post('/repos/:name/rename', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requireGit(res);
    if (!git) return;
    const repo = await ownedRepo(auth, git.storage, String(req.params.name ?? ''), res);
    if (!repo) return;
    const newName = String((req.body as { newName?: unknown })?.newName ?? '').trim();
    const nameError = validateGitRepoName(newName);
    if (nameError) return res.status(400).json({ error: nameError });
    if (newName === repo.name) {
      return res.json({ renamed: false, cloneUrl: (await git.hostFor(repo.orgId)).cloneUrl(repo.userId, repo.name), message: 'That is already its name.' });
    }
    const conflict = await git.storage.getLiveByNameIn(
      await workplaceNamespaces(auth, await gitNamespace(auth)),
      newName,
    );
    if (conflict && conflict.id !== repo.id) {
      return res.status(409).json({
        error: `This workplace already has a repo named "${newName}".`,
      });
    }
    try {
      await (await git.hostFor(repo.orgId)).renameRepo(repo.userId, repo.name, newName);
    } catch (error) {
      return res.status(502).json({ error: (error as Error).message });
    }
    // Directory first, record second: a record pointing at a directory that
    // moved is the one state nobody can diagnose from a clone URL.
    await git.storage.update(repo.id, { name: newName });
    const cloneUrl = (await git.hostFor(repo.orgId)).cloneUrl(repo.userId, newName);
    return res.json({
      renamed: true,
      cloneUrl,
      message: `"${repo.name}" is now "${newName}" — same history, same protection, new clone URL.`
        + ` Every clone that already exists still points at the old one: \`git remote set-url origin ${cloneUrl}\`.`,
    });
  });

  // ── Change proposals (docs/agent-git-phase2-review.md) ──
  //
  // There is deliberately NO approve route. Not restricted, not flagged:
  // absent. The worst outcome of a prompt injection against an agent is a
  // proposal its user declines — approval happens only from Telegram.

  const requirePrs = (res: Response) => {
    const git = requireGit(res);
    if (!git) return null;
    if (!deps.gitPullRequestStorage || !deps.requestPullRequestApproval) {
      res.status(503).json({ error: 'Change proposals are not available on this backend yet' });
      return null;
    }
    return {
      ...git,
      prs: deps.gitPullRequestStorage,
      ask: deps.requestPullRequestApproval,
    };
  };

  const describePr = (auth: AgentAuth, doc: GitPullRequestDocument) => ({
    number: doc.number,
    title: doc.title,
    status: doc.status,
    from: doc.sourceBranch,
    to: doc.targetBranch,
    diffStat: doc.diffStat,
    ...(doc.squash ? { squash: true } : {}),
    // Still quiet (note #293): the agent has not run `pr ready`, so the user
    // has not been shown it and cannot decide it. The CLI prints this as the
    // state, because "open" alone reads as "with your user".
    ...(doc.draft ? { draft: true } : {}),
    ...(doc.readyAt ? { readyAt: doc.readyAt } : {}),
    ...(pullRequestQuickNoteNumbers(doc).length
      ? {
        quickNoteNumbers: pullRequestQuickNoteNumbers(doc),
      }
      : {}),
    createdAt: doc.createdAt,
    ...(doc.decidedAt ? { decidedAt: doc.decidedAt } : {}),
    ...(doc.decisionNote ? { note: doc.decisionNote } : {}),
    ...(doc.mergeCommitSha ? { mergeCommitSha: doc.mergeCommitSha } : {}),
    // Names and sizes only, exactly as a note's list answers: an agent needs
    // to know WHAT is on the proposal to decide whether to add or replace one,
    // and the bytes are a second call away behind a signed URL.
    ...(doc.attachments?.length
      ? {
        files: doc.attachments.map((a) => ({
          fileName: a.fileName,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
          addedAt: a.addedAt,
        })),
      }
      : {}),
    // The margin, whole (note #66) — a remark is short and there are few.
    ...(doc.comments?.length
      ? { comments: doc.comments.map((comment) => describeComment(auth, comment)) }
      : {}),
  });

  /** The named repo of this token's WORKPLACE (note #566: every room's agents
   *  reach every repository), or respond and return null. Host calls that
   *  follow must use `doc.userId` — the namespace in the clone URL, where the
   *  bytes live — never the caller's room namespace. */
  const ownedRepo = async (
    auth: AgentAuth,
    storage: NonNullable<RouteDeps['gitRepoStorage']>,
    name: string,
    res: Response,
  ) => {
    const doc = await storage.getLiveByNameIn(
      await workplaceNamespaces(auth, await gitNamespace(auth)),
      name,
    );
    if (!doc) {
      res.status(404).json({ error: `No repo named "${name}" on this account` });
      return null;
    }
    return doc;
  };

  router.post('/repos/:name/prs', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requirePrs(res);
    if (!git) return;
    const repo = await ownedRepo(auth, git.storage, req.params.name, res);
    if (!repo) return;
    const sourceNs = await gitNamespace(auth);

    const body = (req.body ?? {}) as {
      from?: unknown;
      to?: unknown;
      title?: unknown;
      body?: unknown;
      squash?: unknown;
      /** `note` is the one-note spelling; `notes` supports one PR for several. */
      note?: unknown;
      notes?: unknown;
    };
    const from = String(body.from ?? '').trim();
    // The PROTECTED branch wins as the default target. `defaultBranch` records
    // whatever HEAD currently points at, and with the gate on that is often a
    // feature branch (main cannot exist until the first approved merge) — so
    // defaulting to it aimed proposals at a random branch. Found in the first
    // live rehearsal, 2026-08-07.
    const protectedTarget = repo.protectDefaultBranch ? 'main' : undefined;
    const to = String(body.to ?? '').trim() || protectedTarget || repo.defaultBranch || 'main';
    const title = String(body.title ?? '').trim();
    // The write-up is checked WITH the title, and before the host is asked to
    // compare anything. It used to be sliced at the cap right where it is
    // stored, in silence — which is how a proposal reached its reader ending
    // mid-word (note #320). Whatever survives this line is what gets saved.
    const writeUp = body.body ? String(body.body) : '';
    for (const error of [
      validateBranchName(from), validateBranchName(to),
      validatePullRequestTitle(title), validatePullRequestBody(writeUp),
    ]) {
      if (error) return res.status(400).json({ error });
    }
    if (from === to) {
      return res.status(400).json({ error: 'A proposal needs a source branch different from its target.' });
    }

    let comparison;
    try {
      comparison = await (await git.hostFor(repo.orgId)).compare(repo.userId, repo.name, to, from);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
    if (comparison.commits.length === 0) {
      // Nothing to approve. Telling the agent plainly beats a user tapping
      // Approve on an empty diff and wondering what happened.
      return res.status(409).json({
        error: `"${from}" has no commits that "${to}" does not already have — push your work first.`,
      });
    }

    if (body.notes !== undefined && !Array.isArray(body.notes)) {
      return res.status(400).json({ error: '`notes` must be an array of positive note numbers.' });
    }
    const rawExplicitNotes = [
      ...(Array.isArray(body.notes) ? body.notes : []),
      ...(body.note === undefined ? [] : [body.note]),
    ];
    if (rawExplicitNotes.length > 10) {
      return res.status(400).json({ error: 'One proposal may link at most 10 notes.' });
    }
    const quickNoteNumbers = new Set<number>();
    for (const rawNumber of rawExplicitNotes) {
      const number = typeof rawNumber === 'number' ? rawNumber : Number(String(rawNumber));
      if (!Number.isSafeInteger(number) || number < 1) {
        return res.status(400).json({ error: `A linked note must be a positive number (got "${String(rawNumber)}").` });
      }
      quickNoteNumbers.add(number);
    }
    // The explicit flags are the WHOLE link. Nothing is read out of the
    // title, body or commit subjects any more: a “note #N” there is prose —
    // an example, a cross-reference — not a claim, and the docs on every
    // agent machine teach the flag instead.

    const linkedNotes: QuickNoteDocument[] = [];
    if (quickNoteNumbers.size) {
      const notes = deps.quickNoteStorage;
      if (!notes) {
        return res.status(503).json({ error: 'Quick-note claims are not available on this backend yet.' });
      }
      const now = new Date();
      // This read is deliberately IMMEDIATELY before proposal creation. It is
      // the commitment revalidation: a comment, edit or file added since
      // `note start` changes the fingerprint and stops the proposal.
      // Found across the workplace (note #741): this room's note wins when
      // the number is shared, otherwise the one room that holds it.
      const noteNamespaces = await numberedNamespaces(auth, sourceNs);
      for (const number of quickNoteNumbers) {
        const found = pickNumbered(await notes.findByNumber(noteNamespaces, number), number, sourceNs.namespaceId);
        if (found.kind === 'many') {
          return res.status(409).json({ error: await sharedNumberError('Note', number, found.docs.map((doc) => doc.userId)) });
        }
        if (found.kind === 'none') return res.status(404).json({ error: `No note #${number} in this workplace.` });
        const note = found.doc;
        linkedNotes.push(note);
        if (quickNoteIsArchived(note)) {
          return res.status(409).json({ error: `Note #${number} is archived. Restore and start it again before proposing work from it.` });
        }
        const claim = activeQuickNoteClaim(note, now);
        if (!claim) {
          return res.status(409).json({
            error: `Note #${number} is unclaimed (or its lease expired). Reread and claim it now: \`agentbuilt note start ${number}\`, then retry this proposal.`,
          });
        }
        if (claim.agentId !== auth.agentId || claim.userId !== auth.userId) {
          return res.status(409).json({
            error: `Note #${number} is already being worked on by ${claim.agentName} until ${claim.expiresAt}. Do not create a second implementation.`,
          });
        }
        if (claim.fingerprint !== quickNoteFingerprint(note)) {
          return res.status(409).json({
            error: `Note #${number} changed after you claimed it. Run \`agentbuilt note start ${number}\` again to reread its current body, comments and files, then confirm your work still matches before proposing.`,
          });
        }
      }
      // A moved note keeps proposal links made under its earlier room address
      // (note #111). The storage-level duplicate guard sees the current repo
      // namespace; this read catches an open or merged implementation that
      // stayed with a repository in a room the note has since left.
      const work = await resolveQuickNoteWorkMap({
        notes: linkedNotes,
        pullRequests: deps.gitPullRequestStorage,
        commitStatuses: deps.gitCommitStatusStorage,
        now,
      });
      for (const note of linkedNotes) {
        const linked = work.get(note.id);
        const proposal = linked?.state === 'proposal' || linked?.state === 'merged' || linked?.state === 'live'
          ? linked.proposal
          : null;
        if (proposal && (proposal.status === 'open' || proposal.status === 'merged')) {
          return res.status(409).json({
            error: `Note #${note.number} already has ${proposal.status} PR #${proposal.number}. A second implementation was refused.`,
          });
        }
      }
      // The proposal records ONE room its notes are numbered in: that is how
      // the notes find their proposal again (`resolveQuickNoteWorkMap`).
      if (new Set(linkedNotes.map((note) => note.userId)).size > 1) {
        return res.status(409).json({
          error: 'These notes are numbered in different places (old notes from before rooms were merged, note #843). One proposal links notes numbered in one place — make one proposal per note, or ask your user.',
        });
      }
    }

    let doc: GitPullRequestDocument;
    try {
      doc = await git.prs.create({
        repoId: repo.id,
        userId: repo.userId,
        // The repository may merely be SHARED into this agent's room. Its
        // physical home stays in `userId`; the proposal's room is where the
        // decision queue must show it (note #158).
        roomNamespaceId: sourceNs.namespaceId,
        createdByUserId: auth.userId,
        title,
        ...(writeUp ? { body: writeUp } : {}),
        sourceBranch: from,
        targetBranch: to,
        headSha: comparison.headSha,
        ...(comparison.baseSha ? { baseSha: comparison.baseSha } : {}),
        diffStat: comparison.diffStat,
        commitSubjects: comparison.commits.slice(0, 10).map((commit) => commit.subject),
        // The notes' CURRENT addresses (note #741): the room they live in,
        // which may not be this agent's, and the number they hold now, which
        // a moved note's old link may not have said.
        ...(linkedNotes.length
          ? {
            quickNoteNumbers: [...new Set(linkedNotes.map((note) => note.number))].sort((a, b) => a - b),
            quickNoteNamespaceId: linkedNotes[0]!.userId,
          }
          : {}),
        ...(body.squash === true ? { squash: true } : {}),
        createdByAgentId: auth.agentId,
        status: 'open',
        // Quiet until `pr ready` (note #293): the record exists so the agent
        // can attach files, comment and reword it, and nothing is shown.
        draft: true,
      });
    } catch (error) {
      if (error instanceof QuickNoteProposalConflictError) {
        return res.status(409).json({
          error: `Note #${error.noteNumber} already has ${error.proposal.status} PR #${error.proposal.number}. A second implementation was refused.`,
        });
      }
      if (error instanceof PullRequestNumberRaceError) {
        return res.status(409).json({ error: error.message });
      }
      // Never rethrow: an async throw has no error middleware behind it, so
      // the request would simply never answer and the CLI would sit on it
      // until its own five-minute timeout (how the room-move numbering bug
      // first surfaced, 2026-08-29).
      console.error('[agent-cli] pr create failed:', error);
      return res.status(500).json({ error: 'Recording the proposal failed on this backend. Nothing was created — try again, and report it if it repeats.' });
    }

    // Nothing is sent here (Owner, note #293). Creating used to BE the ask —
    // card, browser notification and queue row all at once — which put an
    // Approve button in front of the user while the agent was still attaching
    // the screenshot or fixing what the next push would fix. The ask is now a
    // separate, deliberate step: `pr ready`, below, once nothing is left.
    return res.status(201).json({
      pr: describePr(auth, doc),
      askedUser: false,
      message: `PR #${doc.number} is recorded and QUIET: your user has not been shown it — no card, no notification, not in their queue, and they cannot approve or reject it yet. Finish everything first (checks green, files attached, wording final), then run \`agentbuilt pr ready ${doc.number}\` to invite them to decide.`,
    });
  });

  /**
   * The ask itself (Owner, note #293): put a quiet proposal in front of the
   * user. The agent runs this when it has nothing left to do on the branch —
   * that is the whole contract, and the reason it is a separate verb from
   * `pr create`. Until it runs, the proposal is the agent's alone.
   *
   * Two things are checked first, because this is the moment a decision
   * becomes possible and the card is what the decision is made from:
   *
   *  - The pin is refreshed. The head sha, size and subjects were recorded at
   *    creation, and the agent has very likely pushed since; the card must
   *    describe the branch as it stands, and the sha the user approves must
   *    be the one they were shown.
   *  - The checks on THAT sha are read. Still running or red, and the invite
   *    is refused with what to do about it: the note that opened this asked
   *    for the ask to come "only after everything is passed", and a card
   *    that says "checks still running" is exactly the summons this exists
   *    to end. A repo with no CI, or a sha CI has not registered yet, has no
   *    verdict and is not held — that is the same rule the card always had.
   *
   * Idempotent on purpose: a proposal already with the user answers so and
   * sends nothing twice, because a CLI timeout after a successful ask would
   * otherwise fire a second card at the same person.
   */
  router.post('/repos/:name/prs/:number/ready', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requirePrs(res);
    if (!git) return;
    const repo = await ownedRepo(auth, git.storage, req.params.name, res);
    if (!repo) return;
    const doc = await git.prs.getByNumber(repo.id, Number(req.params.number));
    if (!doc) return res.status(404).json({ error: `No PR #${req.params.number} in ${repo.name}` });
    if (!proposalOwnedByAuth(auth, doc)) {
      return res.status(403).json({ error: 'Only the owner of the proposing agent can invite the user to this PR.' });
    }
    if (doc.status !== 'open') {
      return res.status(409).json({ error: `PR #${doc.number} is ${doc.status} — there is no decision left to invite your user to.` });
    }
    if (!doc.draft) {
      return res.json({
        ok: true,
        askedUser: false,
        message: `PR #${doc.number} is already with your user — nothing was sent again. Do not wait: end your turn, and you will be messaged with the outcome when they decide.`,
      });
    }

    // Re-pin to the branch as it stands now, so the card and the approval
    // anchor both describe what the user is actually asked to land.
    let head = doc.headSha;
    try {
      const moved = await (await git.hostFor(repo.orgId)).compare(repo.userId, repo.name, doc.targetBranch, doc.sourceBranch);
      if (moved.commits.length === 0) {
        return res.status(409).json({
          error: `"${doc.sourceBranch}" has no commits that "${doc.targetBranch}" does not already have — there is nothing to invite your user to decide.`,
        });
      }
      if (moved.headSha && moved.headSha !== doc.headSha) {
        head = moved.headSha;
        await git.prs.update(doc.id, {
          headSha: moved.headSha,
          ...(moved.baseSha ? { baseSha: moved.baseSha } : {}),
          diffStat: moved.diffStat,
          commitSubjects: moved.commits.slice(0, 10).map((commit) => commit.subject),
        });
      }
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }

    // "Only after everything is passed": the verdict on the sha the card
    // would describe, read the way the card and the queue pip read it.
    const verdict = deps.gitCommitStatusStorage
      ? worstCheckState(await deps.gitCommitStatusStorage.listBySha(repo.id, head), new Date())
      : null;
    if (deps.gitCommitStatusStorage) {
      if (verdict === 'pending') {
        return res.status(409).json({
          error: `Checks are still running on ${head.slice(0, 7)}. Wait for them — \`agentbuilt repo checks --wait\` — then run \`agentbuilt pr ready ${doc.number}\` again. Your user is not invited to a build that has not finished.`,
        });
      }
      if (verdict === 'failure') {
        return res.status(409).json({
          error: `Checks are not passing on ${head.slice(0, 7)} (\`agentbuilt repo checks\` prints the failing log). Fix and push, then run \`agentbuilt pr ready ${doc.number}\` again — or \`pr close\` it. Do not invite your user to a red build.`,
        });
      }
    }

    const readyAt = new Date().toISOString();
    // Who sent the card is recorded with the proposal (note #684): a reviewer
    // readying a colleague's work is told the outcome alongside the proposer.
    await git.prs.update(doc.id, { draft: undefined, readyAt, readyByAgentId: auth.agentId });

    // Auto-merge (note #944): when the proposal's owner has switched theirs
    // on, the proposal is merged now instead of waiting — through the
    // owner's own merge gate, recorded as automatic. Checks still gate: a
    // verdict that is not green, or none at all on a repo whose CI is on,
    // never merges. Anything that stops it leaves the ordinary ask below,
    // with the reason on the proposal, so nothing is ever silently stuck.
    let autoFallback: string | null = null;
    const autoMode = await autoApproveModeFor(auth, repo, doc);
    if (autoMode) {
      const blocker = autoApproveChecksBlocker(verdict, repo.ci === true);
      if (blocker) {
        autoFallback = blocker;
        await git.prs.update(doc.id, { autoApproveFallback: { at: new Date().toISOString(), reason: blocker } }).catch(() => false);
      } else {
        const outcome = await deps.autoApprovePullRequest!({
          pullRequestId: doc.id,
          mode: { onAt: autoMode.changedAt, byUserId: autoMode.changedByUserId, byName: autoMode.changedByName },
        }).catch((error: unknown) => ({ status: 'fallback' as const, reason: `the merge failed (${(error as Error).message})` }));
        if (outcome.status === 'merged') {
          const by = auth.agents[doc.createdByAgentId]?.name;
          const turnedOn = `turned on by ${autoMode.changedByName} at ${autoApproveTime(autoMode.changedAt)}`;
          const chiefOfStaff = await chiefOfStaffCard(auth, repo, doc,
            `${by ? `${by}'s ` : ''}PR #${doc.number} in ${repo.name} — ${doc.title} — was approved automatically and merged into ${doc.targetBranch} (auto-merge on, ${turnedOn}); no person read it first. Its card is in this conversation.`);
          return res.json({
            ok: true,
            askedUser: false,
            autoApproved: true,
            message: `Auto-merge is on for your user (${turnedOn}), so PR #${doc.number} was approved AUTOMATICALLY and ${doc.sourceBranch} is merged into ${doc.targetBranch} — nobody was asked${chiefOfStaff ? '; the card in their Chief of Staff chat says the same' : ''}. When you report it, say it merged automatically, never that your user approved it. Follow up on it as on any merge (its checks and deploys on ${doc.targetBranch}); the outcome also reaches you as a [Platform] message.`,
          });
        }
        autoFallback = outcome.reason;
      }
    }

    // The ask is best-effort on delivery but never on recording: a proposal
    // shown without a notification can still be found in the Workspace queue,
    // whereas a notification for a proposal that failed to save is a lie.
    const asked = await git.ask({
      userId: auth.userId,
      agentId: auth.agentId,
      repoName: repo.name,
      pullRequestId: doc.id,
    }).catch(() => false);
    // And in the person's Chief of Staff chat at once (note #752), whoever
    // asked for the work: Adam gave Ada note #750 himself and then asked why
    // Ada's proposal never reached the chat he reads them in. The same card
    // and pointer row `agentbuilt forward` writes, landed by the platform
    // with no model turn; the conversation itself refuses a second card for
    // a proposal already in front of them. Best effort like the chat card
    // above: the proposal is recorded and in the queue whatever happens here.
    const chiefOfStaff = await chiefOfStaffCard(auth, repo, doc, autoFallback
      ? `${auth.agents[doc.createdByAgentId]?.name ? `${auth.agents[doc.createdByAgentId]!.name}'s ` : ''}PR #${doc.number} in ${repo.name} — ${doc.title} — is ready for the person's decision: auto-merge is on, but it was not merged automatically because ${autoFallback}. Its card is in this conversation.`
      : undefined);
    const autoWords = autoFallback
      ? `Auto-merge is on for your user, but PR #${doc.number} was NOT merged automatically: ${autoFallback}. It waits for your user's decision like any other proposal, and its screen says why. `
      : '';
    return res.json({
      ok: true,
      askedUser: asked,
      ...(autoFallback ? { autoApproveFallback: autoFallback } : {}),
      message: autoWords + (asked
        ? `PR #${doc.number} is with your user now — they approve or reject it from their Workspace${chiefOfStaff ? ', and its card is in their Chief of Staff chat too' : ''}. Do not wait: end your turn, and you will be messaged with the outcome when they decide.`
        : `PR #${doc.number} is now in your user's queue${chiefOfStaff ? ' and in their Chief of Staff chat' : ''}, but the chat card could not be delivered. Tell them in your reply that it is waiting for their decision.`),
    });
  });

  /**
   * The proposal OWNER's auto-merge switch (note #944), when it is ON and
   * this backend can act on it — or null. Each person's own: it is read
   * from the membership of the person whose agent proposed it, in the
   * agent's own workplace, so one member's switch never merges a teammate's
   * work. An agent can only READ it here: no route of this router writes it.
   */
  const autoApproveModeFor = async (auth: AgentAuth, repo: GitRepoDocument, doc: GitPullRequestDocument): Promise<WorkplaceAutoApprove | null> => {
    const orgId = auth.orgId ?? repo.orgId ?? null;
    if (!orgId || !deps.orgStorage || !deps.autoApprovePullRequest) return null;
    const owner = doc.createdByUserId ?? auth.userId;
    const membership = await deps.orgStorage.getMembership(orgId, owner).catch(() => null);
    return membership?.autoApprove?.on ? membership.autoApprove : null;
  };

  /**
   * The card a proposal made ready lands in its owner's Chief of Staff chat
   * (note #752). Resolves whether it is there — landed now, or already —
   * and false when there is no conversation to write to: a legacy agent in
   * no workplace, a backend without the conversation, or a write that failed.
   */
  const chiefOfStaffCard = async (auth: AgentAuth, repo: GitRepoDocument, doc: GitPullRequestDocument, words?: string): Promise<boolean> => {
    const orgId = auth.orgId ?? repo.orgId ?? null;
    if (!orgId || !deps.workspaceAgent?.proposalReady) return false;
    const by = auth.agents[doc.createdByAgentId]?.name;
    const landed = await deps.workspaceAgent.proposalReady({
      userId: auth.userId,
      orgId,
      proposal: { kind: 'pr', id: doc.id },
      // What the conversation's next turn reads (the card replaces these
      // words on the screen): whose proposal, where, and that it is already
      // in front of the person — so the Chief of Staff does not forward it.
      text: (words ?? `${by ? `${by}'s ` : ''}PR #${doc.number} in ${repo.name} — ${doc.title} — is ready for the person's decision; its card is in this conversation.`).slice(0, 2000),
    }).catch(() => 'none' as const);
    return landed !== 'none';
  };

  router.get('/repos/:name/prs', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requirePrs(res);
    if (!git) return;
    const repo = await ownedRepo(auth, git.storage, req.params.name, res);
    if (!repo) return;
    const all = await git.prs.listByRepo(repo.id);
    const docs = req.query.all === 'true' ? all : all.filter((doc) => doc.status === 'open');
    return res.json({ prs: docs.map((doc) => describePr(auth, doc)) });
  });

  router.get('/repos/:name/prs/:number', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requirePrs(res);
    if (!git) return;
    const repo = await ownedRepo(auth, git.storage, req.params.name, res);
    if (!repo) return;
    const doc = await git.prs.getByNumber(repo.id, Number(req.params.number));
    if (!doc) return res.status(404).json({ error: `No PR #${req.params.number} in ${repo.name}` });
    // The write-up rides along so `pr show` can read back what an edit left.
    return res.json({
      pr: {
        ...describePr(auth, doc),
        commitSubjects: doc.commitSubjects,
        headSha: doc.headSha,
        ...(doc.body ? { body: doc.body } : {}),
      },
    });
  });

  router.get('/repos/:name/prs/:number/diff', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requirePrs(res);
    if (!git) return;
    const repo = await ownedRepo(auth, git.storage, req.params.name, res);
    if (!repo) return;
    const doc = await git.prs.getByNumber(repo.id, Number(req.params.number));
    if (!doc) return res.status(404).json({ error: `No PR #${req.params.number} in ${repo.name}` });
    try {
      const comparison = await (await git.hostFor(repo.orgId)).compare(repo.userId, repo.name, doc.targetBranch, doc.sourceBranch);
      return res.json({ patch: comparison.patch, truncated: comparison.patchTruncated });
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  });

  router.post('/repos/:name/prs/:number/close', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requirePrs(res);
    if (!git) return;
    const repo = await ownedRepo(auth, git.storage, req.params.name, res);
    if (!repo) return;
    const doc = await git.prs.getByNumber(repo.id, Number(req.params.number));
    if (!doc) return res.status(404).json({ error: `No PR #${req.params.number} in ${repo.name}` });
    if (!proposalOwnedByAuth(auth, doc)) {
      return res.status(403).json({ error: 'Only the owner of the proposing agent can withdraw this PR.' });
    }
    if (doc.status !== 'open') {
      return res.status(409).json({ error: `PR #${doc.number} is already ${doc.status}.` });
    }
    // Withdrawing its own proposal is the one state change an agent may make:
    // it removes a request, it never lands code.
    await git.prs.update(doc.id, { status: 'withdrawn', decidedAt: new Date().toISOString() });
    return res.json({ ok: true, message: `PR #${doc.number} withdrawn.` });
  });

  /**
   * Rewording an open proposal (Owner, note #52).
   *
   * Until this existed the only way to fix a typo in a title, or a body made
   * stale by a question answered on the card, was close-and-recreate — a
   * second approval card for a change the user already read, a burnt number
   * sitting in `pr list` looking rejected, and every attachment dropped. The
   * observed result was worse than any of those: small corrections did not
   * get made, because the correction was louder than the defect.
   *
   * What it changes is WORDS ONLY — never the branches, never the pinned sha,
   * never the diff. The code being approved is exactly what it was, which is
   * what makes an edit safe without re-asking. And it edits the RECORD: the
   * Workspace screen, where the decision is actually made, reads the record
   * and shows the new wording at once. The chat card keeps the text it was
   * sent with — deliberately, the same position its CI verdict already takes
   * (a snapshot; the workspace row holds the live truth) — and its one button
   * leads to the screen that is current.
   *
   * Once decided, refused: the wording of a merged or rejected proposal is
   * part of what was decided on, and stays as it was read. Same guard as the
   * attachment routes, because it is the same question — is this proposal
   * still being asked?
   */
  router.patch('/repos/:name/prs/:number', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requirePrs(res);
    if (!git) return;
    const repo = await ownedRepo(auth, git.storage, req.params.name, res);
    if (!repo) return;
    const doc = await git.prs.getByNumber(repo.id, Number(req.params.number));
    if (!doc) return res.status(404).json({ error: `No PR #${req.params.number} in ${repo.name}` });
    if (!proposalOwnedByAuth(auth, doc)) {
      return res.status(403).json({ error: 'Only the owner of the proposing agent can reword this PR.' });
    }
    if (!pullRequestTakesAttachments(doc.status)) {
      return res.status(409).json({
        error: `PR #${doc.number} is ${doc.status} — its wording is part of what was decided, and stays as it was read. Open a new proposal instead.`,
      });
    }
    const body = (req.body ?? {}) as { title?: unknown; body?: unknown };
    if (body.title === undefined && body.body === undefined) {
      return res.status(400).json({ error: 'Nothing to change — send a new title, a new body, or both.' });
    }
    const updates: Partial<GitPullRequestDocument> = {};
    if (body.title !== undefined) {
      const title = String(body.title).trim();
      const error = validatePullRequestTitle(title);
      if (error) return res.status(400).json({ error });
      updates.title = title;
    }
    if (body.body !== undefined) {
      // An empty --body clears the write-up, exactly as `pr create` would
      // have left it; a present one is held to the same limit create holds it
      // to — and refused rather than trimmed, for the same reason (note #320).
      // A reword is the one command whose entire job is the words, so silently
      // eating the end of them was worst of all here.
      const writeUp = body.body ? String(body.body) : '';
      const error = validatePullRequestBody(writeUp);
      if (error) return res.status(400).json({ error });
      updates.body = writeUp || undefined;
    }
    const updated = await git.prs.update(doc.id, updates);
    if (!updated) return res.status(404).json({ error: `No PR #${doc.number} in ${repo.name}` });
    return res.json({
      ok: true,
      pr: describePr(auth, { ...doc, ...updates }),
      message: `PR #${doc.number} reworded — your user sees the new text on the proposal's Workspace screen, where they decide. No new card is sent, and the one already in their chat keeps its original words.`,
    });
  });

  /**
   * Files ON a proposal (Owner, notes #10 and #18) — raw bytes with the name
   * in a header, the wire shape `/notes/:number/files` and `/deploy` both use.
   *
   * What it is for: the proposal is decided on a phone, off a title, a body
   * and a diff, and a diff is the worst of those on a small screen. A picture
   * of the screen that changed belongs ON the card where the tap happens, not
   * sent into the chat separately where it arrives detached from the thing it
   * is about.
   *
   * It changes NOTHING the decision is about: not the sha, not the diff, not
   * the branch. That is what makes it safe to allow after the proposal exists
   * — the same reasoning that lets any agent attach to any note.
   */
  const prForFiles = async (
    auth: AgentAuth,
    git: NonNullable<ReturnType<typeof requirePrs>>,
    req: Request,
    res: Response,
  ) => {
    const repo = await ownedRepo(auth, git.storage, req.params.name!, res);
    if (!repo) return null;
    const doc = await git.prs.getByNumber(repo.id, Number(req.params.number));
    if (!doc) {
      res.status(404).json({ error: `No PR #${req.params.number} in ${repo.name}` });
      return null;
    }
    return doc;
  };

  router.post(
    '/repos/:name/prs/:number/files',
    raw({ type: () => true, limit: PR_ATTACHMENT_MAX_BYTES + 1024 }),
    async (req, res) => {
      const auth = await authenticate(req, res);
      if (!auth) return;
      const git = requirePrs(res);
      if (!git) return;
      if (!deps.mediaStorage) {
        return res.status(503).json({ error: 'File storage is not available on this backend yet — proposals are words-only here.' });
      }
      const doc = await prForFiles(auth, git, req, res);
      if (!doc) return;
      if (!proposalOwnedByAuth(auth, doc)) {
        return res.status(403).json({ error: 'Only the owner of the proposing agent can attach files to this PR.' });
      }
      // A decided proposal takes no more evidence: the card it would appear on
      // has already been answered.
      if (!pullRequestTakesAttachments(doc.status)) {
        return res.status(409).json({
          error: `PR #${doc.number} is ${doc.status} — a file on it now is evidence for a decision that has already been made.`,
        });
      }
      const fileName = String(req.get('x-file-name') ?? req.get('x-note-file-name') ?? '').trim();
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const refusal = validatePullRequestAttachment({
        fileName,
        sizeBytes: data.length,
        existing: doc.attachments ?? [],
      });
      if (refusal) return res.status(400).json({ error: refusal });
      const id = randomUUID();
      const attachment = {
        id,
        fileName,
        contentType: inferContentType(fileName, req.get('content-type')),
        sizeBytes: data.length,
        // The PR's namespace, not the uploader's id — on a shared org repo
        // they differ, and fetch resolves through the stored path either way.
        storagePath: pullRequestAttachmentPath(doc.userId, doc.id, id, fileName),
        addedByAgentId: auth.agentId,
        addedAt: new Date().toISOString(),
        // A picture's shape, from its header (note #825): the sheet frames it
        // at the right proportions before the bytes arrive. Null for anything
        // that is not a picture, and nothing is recorded.
        ...(imageDimensions(data) ?? {}),
      };
      // Bytes first, record second — a crash between the two strands an object,
      // never a record promising absent bytes. The note routes' own order.
      await deps.mediaStorage.uploadObject({
        storagePath: attachment.storagePath,
        contentType: attachment.contentType,
        data,
      });
      const updated = await git.prs.update(doc.id, {
        attachments: [...(doc.attachments ?? []), attachment],
      });
      if (!updated) return res.status(404).json({ error: `No PR #${doc.number} in ${req.params.name}` });
      return res.json({
        ok: true,
        number: doc.number,
        fileName,
        message: `Attached ${fileName} to PR #${doc.number} — your user sees it on the proposal, beside the decision.`,
      });
    },
  );

  /** The bytes back, via a short-lived signed URL the CLI follows. */
  router.get('/repos/:name/prs/:number/files/:file', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requirePrs(res);
    if (!git) return;
    if (!deps.mediaStorage) {
      return res.status(503).json({ error: 'File storage is not available on this backend yet.' });
    }
    const doc = await prForFiles(auth, git, req, res);
    if (!doc) return;
    if (!proposalOwnedByAuth(auth, doc)) {
      return res.status(403).json({ error: 'Only the owner of the proposing agent can remove files from this PR.' });
    }
    const name = String(req.params.file ?? '');
    const attachment = (doc.attachments ?? []).find((a) => a.fileName === name);
    if (!attachment) {
      const names = (doc.attachments ?? []).map((a) => a.fileName).join(', ');
      return res.status(404).json({
        error: `No file named "${name}" on PR #${doc.number}.` + (names ? ` It has: ${names}.` : ' It has no files.'),
      });
    }
    const access = await deps.mediaStorage.createReadAccess({
      storagePath: attachment.storagePath,
      expiresInMs: 15 * 60_000,
    });
    return res.json({
      url: access.url,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
    });
  });

  /** Take a file off, by the name `pr show` lists it under. */
  router.delete('/repos/:name/prs/:number/files/:file', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requirePrs(res);
    if (!git) return;
    const doc = await prForFiles(auth, git, req, res);
    if (!doc) return;
    const name = String(req.params.file ?? '');
    const attachment = (doc.attachments ?? []).find((a) => a.fileName === name);
    if (!attachment) return res.status(404).json({ error: `No file named "${name}" on PR #${doc.number}.` });
    const updated = await git.prs.update(doc.id, {
      attachments: (doc.attachments ?? []).filter((a) => a.id !== attachment.id),
    });
    if (!updated) return res.status(404).json({ error: `No PR #${doc.number} in ${req.params.name}` });
    // Record first, bytes second — the upload's mirror; a stranded object is
    // the acceptable failure, a record promising absent bytes is not.
    deps.mediaStorage?.deleteObject?.({ storagePath: attachment.storagePath })
      .catch((error) => console.warn(`[prs] deleting ${attachment.fileName} from storage failed:`, error));
    return res.json({ ok: true, message: `Took ${attachment.fileName} off PR #${doc.number}.` });
  });

  /**
   * A remark on a proposal, without touching it (Owner, note #66).
   *
   * The margin notes grew (note #9), on the decision queue: the proposing
   * agent adding what a check turned up, a teammate's agent flagging a
   * collision, the user asking on the record — everyone in the workplace
   * writes in the same thread, and the Workspace shows it on the screen where
   * the decision is made. Anyone who can reach the repo may comment; there is
   * deliberately no ownership gate, because the margin is where everybody
   * ELSE gets to speak.
   *
   * Comments stop when the files do (`pullRequestTakesComments`): a decided
   * proposal is not a question any more.
   */
  router.post('/repos/:name/prs/:number/comments', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const git = requirePrs(res);
    if (!git) return;
    const body = (req.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string') {
      return res.status(400).json({ error: 'Send { text } — a comment is semantic HTML, and plain words are valid HTML.' });
    }
    const invalid = validatePullRequestComment(body.text);
    if (invalid) return res.status(400).json({ error: invalid });
    const repo = await ownedRepo(auth, git.storage, req.params.name, res);
    if (!repo) return;
    const doc = await git.prs.getByNumber(repo.id, Number(req.params.number));
    if (!doc) return res.status(404).json({ error: `No PR #${req.params.number} in ${repo.name}` });
    if (!pullRequestTakesComments(doc.status)) {
      return res.status(409).json({
        error: `PR #${doc.number} is ${doc.status} — its margin closed with the decision. Anything left to say belongs in the chat, or on a note.`,
      });
    }
    if ((doc.comments?.length ?? 0) >= MAX_COMMENTS) {
      return res.status(400).json({
        error: `PR #${doc.number} already carries ${MAX_COMMENTS} comments — the most one holds.`,
      });
    }
    const updated = await git.prs.addComment(doc.id, newMarginComment(auth.agentId, body.text.trim(), auth.userId));
    if (!updated) return res.status(404).json({ error: `No PR #${req.params.number} in ${repo.name}` });
    return res.json({
      ok: true,
      pr: describePr(auth, updated),
      message: `Commented on PR #${updated.number} — "${updated.title}". Anyone opening the proposal sees it; nothing notifies your user, so say it in chat too if it needs them now.`,
    });
  });

  // ── Knowledge pages (docs/agent-knowledge-pages.md) ──
  //
  // The reader's half of this feature is the Workspace, where a page renders.
  // What lives here is the agent's half: list what exists, read one page's
  // source, and PROPOSE a change. There is no route that writes a page —
  // landing one is the owner's tap, exactly as with `pr`.

  /** Knowledge lives in the caller's ROOM namespace on that namespace's own
   *  host (note #175). Every agent in the room resolves the same page base;
   *  an agent in another room resolves a different one. */
  const requireKnowledge = async (auth: AgentAuth, res: Response) => {
    if (!deps.knowledgeProposalStorage || !deps.gitHostClient) {
      res.status(503).json({ error: 'Knowledge pages are not available on this backend yet' });
      return null;
    }
    const ns = await gitNamespace(auth);
    return {
      ns,
      proposals: deps.knowledgeProposalStorage,
      service: new KnowledgeService(await gitHostFor(ns.orgId), deps.knowledgeProposalStorage, deps.knowledgeShelf),
    };
  };

  /** Where a page's new pictures are filed: with the shelf the page lives on
   *  (note #566), not the room that happened to propose them. Files already
   *  attached keep the path recorded on them. */
  const knowledgeShelfOf = async (namespaceId: string): Promise<string> => (
    deps.knowledgeShelf ? deps.knowledgeShelf(namespaceId) : namespaceId
  );

  /**
   * The knowledge proposal this number names, or respond and return null.
   * Found across the workplace (note #741) the way a note is: the caller's
   * room first, then the one room holding the number.
   */
  const knowledgeProposalByNumber = async (
    auth: AgentAuth,
    knowledge: NonNullable<Awaited<ReturnType<typeof requireKnowledge>>>,
    raw: unknown,
    res: Response,
  ): Promise<KnowledgeProposalDocument | null> => {
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1) {
      res.status(400).json({ error: `Knowledge proposals are addressed by number ("${String(raw)}" is not one) — \`agentbuilt knowledge proposals\` prints them.` });
      return null;
    }
    const found = pickNumbered(
      await knowledge.proposals.findByNumber(await numberedNamespaces(auth, knowledge.ns), number),
      number,
      knowledge.ns.namespaceId,
    );
    if (found.kind === 'one') return found.doc;
    if (found.kind === 'many') {
      res.status(409).json({ error: await sharedNumberError('Knowledge proposal', number, found.docs.map((doc) => doc.userId)) });
      return null;
    }
    res.status(404).json({ error: `No knowledge proposal #${number} in this workplace.` });
    return null;
  };

  const describeKnowledgeProposal = (auth: AgentAuth, doc: KnowledgeProposalDocument) => ({
    number: doc.number,
    title: doc.title,
    ...(doc.note ? { note: doc.note } : {}),
    status: doc.status,
    // Still quiet: the agent has not run `knowledge proposals ready`, so the
    // user has not been shown it and cannot decide it.
    ...(doc.draft ? { draft: true } : {}),
    // Applied at once, nobody asked (note #746): a history entry.
    ...(doc.direct ? { direct: true } : {}),
    ...(doc.restoreOf ? { restoreOf: doc.restoreOf } : {}),
    ...(doc.readyAt ? { readyAt: doc.readyAt } : {}),
    summary: describeKnowledgeChanges(doc.changes),
    changes: doc.changes.map((change) => ({
      page: change.page,
      action: change.action,
      ...(change.title ? { title: change.title } : {}),
      ...(change.bytes ? { bytes: change.bytes } : {}),
    })),
    createdAt: doc.createdAt,
    ...(doc.decidedAt ? { decidedAt: doc.decidedAt } : {}),
    ...(doc.decisionNote ? { decisionNote: doc.decisionNote } : {}),
    // The margin, whole (note #66) — a remark is short and there are few.
    ...(doc.comments?.length
      ? { comments: doc.comments.map((comment) => describeComment(auth, comment)) }
      : {}),
  });

  /**
   * Recent Home briefings on demand (note #496). They are private to this
   * person and span rooms, so only the Workspace Agent credential may read
   * them; room agents stay inside their own room. Nothing here starts a model
   * turn or writes a conversation row.
   *
   * Since note #688 a briefing is one room's: every room's briefings are
   * merged here newest first, each named with its room, so "what did the
   * recap say" still has one answer across the workplace. A room deleted
   * since keeps no name and is left out.
   */
  router.get('/briefings', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.purpose) return res.status(403).json({ error: "Recent briefings are the Workspace Agent's verb alone." });
    if (!auth.orgId || !deps.orgStorage) return res.status(404).json({ error: 'No workplace briefings are available.' });
    const rawLimit = req.query.limit === undefined ? 3 : Number(req.query.limit);
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 10) {
      return res.status(400).json({ error: '`limit` must be a whole number from 1 to 10.' });
    }
    const member = await deps.orgStorage.getMembership(auth.orgId, auth.userId);
    if (!member) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    // The workplace's briefings (note #843): one per workplace, written since
    // its rooms were merged. The per-room ones before went with the rooms.
    const org = await deps.orgStorage.getOrg(auth.orgId).catch(() => null);
    const briefings = previousRecaps(member.workspaceRecapHistory, member.workspaceRecap)
      .filter((briefing) => !org?.roomsMerged?.mergedAt || briefing.at >= org.roomsMerged.mergedAt)
      .sort((a, b) => b.at.localeCompare(a.at));
    return res.json({ briefings: briefings.slice(0, rawLimit) });
  });

  /**
   * Sign-ups from outside, without a name or an email in it (services/
   * signup-funnel.ts): what Growth reads to tell whether a post worked. The
   * platform's own numbers, so only the platform admin's agents may read them
   * — every room of theirs, which is how the Growth room gets them without
   * the host key. Anyone else's agent hears that it is not theirs to read.
   */
  router.get('/platform/signups', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!isAdminAccount(await deps.userStorage!.getProfile(auth.userId))) {
      return res.status(403).json({ error: "Sign-up numbers are the platform operator's: only the platform admin's agents can read them." });
    }
    if (!deps.userRoster) return res.status(503).json({ error: 'The roster is not available on this backend.' });
    return res.json(signupFunnel(await deps.userRoster()));
  });

  router.get('/knowledge', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth, res);
    if (!knowledge) return;
    try {
      const listed = await knowledge.service.listPages(knowledge.ns.namespaceId);
      // One shelf for the whole workplace (note #566), with no room labels
      // since rooms left the product (note #843).
      const shelf = deps.knowledgeShelf
        ? await deps.knowledgeShelf(knowledge.ns.namespaceId)
        : knowledge.ns.namespaceId;
      const pages = [];
      for (const { originNamespaceId, ...page } of listed) {
        const from = originNamespaceId ?? shelf;
        pages.push({
          ...page,
          ...(knowledge.ns.orgId && from === knowledge.ns.namespaceId ? { here: true } : {}),
        });
      }
      const open = await knowledge.proposals.listOpenByUser(knowledge.ns.namespaceId);
      return res.json({
        pages,
        // Stated on the list because it is the answer to "why is the page I
        // proposed not here": it is waiting on the owner, not lost.
        ...(open.length ? { openProposals: open.length } : {}),
      });
    } catch (error) {
      return res.status(502).json({ error: (error as Error).message });
    }
  });

  router.get('/knowledge/pages/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth, res);
    if (!knowledge) return;
    const name = String(req.params.name ?? '').trim();
    const nameError = validateKnowledgePageName(name);
    if (nameError) return res.status(400).json({ error: nameError });
    const page = await knowledge.service.readPage(knowledge.ns.namespaceId, name);
    if (!page) return res.status(404).json({ error: `There is no knowledge page called "${name}".` });
    // The page's margin rides along (note #66): an agent about to act on a
    // page should see the remarks under it — "this is stale, see the note" —
    // without a second verb it would never think to run.
    const comments = deps.knowledgePageCommentStorage
      ? await deps.knowledgePageCommentStorage.list(knowledge.ns.namespaceId, name)
      : [];
    return res.json({
      page: {
        name,
        html: page.content,
        sha: page.sha,
        ...(comments.length ? { comments: comments.map((c) => describeComment(auth, c)) } : {}),
      },
    });
  });

  /**
   * A file for a page, uploaded BEFORE the proposal that lands it (Owner,
   * notes #10 and #18).
   *
   * Before, not after, and the order is the whole design. A page can gain a
   * picture without a word of its text changing — "put the floor plan on the
   * unit page" — and `POST /knowledge/proposals` refuses a page whose HTML is
   * byte-identical to what is already there. So a file that could only be
   * attached to an existing proposal could never be attached to an unchanged
   * page at all. Staging first means the proposal is written knowing its
   * files, and it is the proposal — not this route — that lands them.
   *
   * The bytes go straight to the page's own permanent path. Nothing reads them
   * until a landing puts the record in the index, so an unapproved file is
   * bytes nobody can address; and landing then moves nothing, which matters
   * when the thing being moved is 10 MB.
   */
  router.post(
    '/knowledge/files',
    raw({ type: () => true, limit: KNOWLEDGE_ATTACHMENT_MAX_BYTES + 1024 }),
    async (req, res) => {
      const auth = await authenticate(req, res);
      if (!auth) return;
      const knowledge = await requireKnowledge(auth, res);
      if (!knowledge) return;
      if (!deps.mediaStorage) {
        return res.status(503).json({ error: 'File storage is not available on this backend yet — pages are words-only here.' });
      }
      const page = String(req.get('x-page') ?? '').trim();
      const nameError = validateKnowledgePageName(page);
      if (nameError) return res.status(400).json({ error: `"${page}": ${nameError}` });
      const fileName = String(req.get('x-file-name') ?? '').trim();
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      // Against what the page carries TODAY: the duplicate and the count are
      // both about the page, and the proposal that will carry this file does
      // not exist yet.
      const pages = await knowledge.service.listPages(knowledge.ns.namespaceId);
      const existing = pages.find((entry) => entry.name === page)?.attachments ?? [];
      const refusal = validateKnowledgeAttachment({ fileName, sizeBytes: data.length, existing });
      if (refusal) return res.status(400).json({ error: refusal });
      const id = randomUUID();
      const attachment = {
        id,
        fileName,
        contentType: inferContentType(fileName, req.get('content-type')),
        sizeBytes: data.length,
        storagePath: knowledgeAttachmentPath(await knowledgeShelfOf(knowledge.ns.namespaceId), page, id, fileName),
        addedByAgentId: auth.agentId,
        addedAt: new Date().toISOString(),
      };
      await deps.mediaStorage.uploadObject({
        storagePath: attachment.storagePath,
        contentType: attachment.contentType,
        data,
      });
      return res.json({
        ok: true,
        file: { id, fileName, contentType: attachment.contentType, sizeBytes: attachment.sizeBytes },
        message: `Staged ${fileName} for "${page}". Point the page at it with <img src="files/${fileName}"> and propose the page — the file lands when your user approves it.`,
      });
    },
  );

  router.post('/knowledge/proposals', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth, res);
    if (!knowledge) return;
    const body = (req.body ?? {}) as {
      title?: unknown;
      note?: unknown;
      pages?: unknown;
      deletes?: unknown;
      renames?: unknown;
    };
    const written = Array.isArray(body.pages) ? body.pages : [];
    const removed = Array.isArray(body.deletes) ? body.deletes.map((value) => String(value).trim()) : [];
    const renamed = Array.isArray(body.renames)
      ? body.renames.map((entry) => ({
        from: String((entry as { from?: unknown })?.from ?? '').trim(),
        to: String((entry as { to?: unknown })?.to ?? '').trim(),
      }))
      : [];
    if (!written.length && !removed.length && !renamed.length) {
      return res.status(400).json({ error: 'A proposal needs at least one page to add, change, rename or remove.' });
    }

    let shas: Map<string, string>;
    // What each page carries today, so a change that touches files can say
    // what the WHOLE set becomes rather than a patch of it — and so an edit
    // that says nothing about files leaves them exactly as they are.
    const pageAttachments = new Map<string, KnowledgePageAttachment[]>();
    try {
      shas = await knowledge.service.currentShas(knowledge.ns.namespaceId);
      for (const entry of await knowledge.service.listPages(knowledge.ns.namespaceId)) {
        if (entry.attachments?.length) pageAttachments.set(entry.name, entry.attachments);
      }
    } catch (error) {
      return res.status(502).json({ error: (error as Error).message });
    }

    const changes: KnowledgePageChange[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const entry of written) {
      const page = String((entry as { name?: unknown })?.name ?? '').trim();
      const html = String((entry as { html?: unknown })?.html ?? '');
      const nameError = validateKnowledgePageName(page);
      if (nameError) return res.status(400).json({ error: `"${page}": ${nameError}` });
      if (seen.has(page)) {
        return res.status(400).json({ error: `"${page}" appears twice in one proposal.` });
      }
      seen.add(page);
      const htmlError = validateKnowledgeHtml(html);
      if (htmlError) return res.status(400).json({ error: `"${page}": ${htmlError}` });
      const meta = readKnowledgePageMeta(html);
      if ('error' in meta) return res.status(400).json({ error: `"${page}": ${meta.error}` });
      // Which files this page should end up with. `attach` names what was
      // staged (by the id `POST /knowledge/files` handed back); `detach` names
      // what should come off. The storage path is REBUILT here from the
      // authenticated user, this page and the id — never taken from the
      // caller, which would be a path handed to us by the thing we are
      // checking.
      const attach = Array.isArray((entry as { attach?: unknown })?.attach)
        ? (entry as { attach: unknown[] }).attach
        : [];
      const detach = Array.isArray((entry as { detach?: unknown })?.detach)
        ? (entry as { detach: unknown[] }).detach.map((value) => String(value).trim())
        : [];
      const carried = pageAttachments.get(page) ?? [];
      let attachments: KnowledgePageAttachment[] | undefined;
      if (attach.length || detach.length) {
        const kept = carried.filter((file) => !detach.includes(file.fileName));
        const missing = detach.filter((name) => !carried.some((file) => file.fileName === name));
        if (missing.length) {
          return res.status(404).json({
            error: `"${page}" carries no file named ${missing.join(', ')}.`
              + (carried.length ? ` It has: ${carried.map((f) => f.fileName).join(', ')}.` : ' It has no files.'),
          });
        }
        const added: KnowledgePageAttachment[] = [];
        for (const staged of attach) {
          const id = String((staged as { id?: unknown })?.id ?? '').trim();
          const fileName = String((staged as { fileName?: unknown })?.fileName ?? '').trim();
          if (!/^[0-9a-f-]{36}$/i.test(id)) {
            return res.status(400).json({ error: `"${page}": ${fileName || id} was not staged by this backend — upload it first.` });
          }
          const refusal = validateKnowledgeAttachment({
            fileName,
            sizeBytes: Number((staged as { sizeBytes?: unknown })?.sizeBytes ?? 1),
            existing: [...kept, ...added],
          });
          if (refusal) return res.status(400).json({ error: `"${page}": ${refusal}` });
          added.push({
            id,
            fileName,
            contentType: String((staged as { contentType?: unknown })?.contentType ?? 'application/octet-stream'),
            sizeBytes: Number((staged as { sizeBytes?: unknown })?.sizeBytes ?? 0),
            storagePath: knowledgeAttachmentPath(await knowledgeShelfOf(knowledge.ns.namespaceId), page, id, fileName),
            addedByAgentId: auth.agentId,
            addedAt: new Date().toISOString(),
          });
        }
        attachments = [...kept, ...added];
      }
      const current = shas.get(page) ?? null;
      if (current) {
        // A proposal that changes nothing is a card the owner has to read and
        // then decide nothing about — worth catching here rather than there.
        // Unless it changes the page's FILES: putting the floor plan on a page
        // whose words are already right is a real change to what that page
        // shows, and it is one the owner should still get to approve.
        const existing = await knowledge.service.readPage(knowledge.ns.namespaceId, page);
        if (existing && existing.content === html && !attachments) {
          return res.status(409).json({ error: `"${page}" already says exactly this — there is nothing to propose.` });
        }
      }
      const bytes = Buffer.byteLength(html, 'utf8');
      totalBytes += bytes;
      changes.push({
        page,
        action: current ? 'edit' : 'create',
        html,
        title: meta.title,
        description: meta.description,
        bytes,
        baseSha: current,
        ...(attachments ? { attachments } : {}),
      });
    }
    for (const page of removed) {
      const nameError = validateKnowledgePageName(page);
      if (nameError) return res.status(400).json({ error: `"${page}": ${nameError}` });
      if (seen.has(page)) {
        return res.status(400).json({ error: `"${page}" is both changed and removed in one proposal.` });
      }
      seen.add(page);
      const current = shas.get(page) ?? null;
      if (!current) {
        return res.status(404).json({ error: `There is no knowledge page called "${page}" to remove.` });
      }
      changes.push({ page, action: 'delete', baseSha: current });
    }
    for (const { from, to } of renamed) {
      const error = validateKnowledgeRename(from, to);
      if (error) return res.status(400).json({ error });
      // Both ends are claimed, because both move: an edit to the source in the
      // same proposal would be written to a path this change is deleting, and
      // anything else aimed at the destination would race with what lands here.
      for (const name of [from, to]) {
        if (seen.has(name)) {
          return res.status(400).json({ error: `"${name}" is renamed and also changed in one proposal.` });
        }
        seen.add(name);
      }
      const current = shas.get(from) ?? null;
      if (!current) {
        return res.status(404).json({ error: `There is no knowledge page called "${from}" to rename.` });
      }
      if (shas.has(to)) {
        return res.status(409).json({ error: `"${to}" is already a knowledge page — rename it or pick another name.` });
      }
      // The bytes travel with the change, exactly as an edit's do, so the
      // proposal is a complete picture of the page that will exist and every
      // surface that previews one already knows how to read it. The words are
      // untouched: this moves an address, not a title.
      const page = await knowledge.service.readPage(knowledge.ns.namespaceId, from);
      if (!page) {
        return res.status(404).json({ error: `"${from}" could not be read to rename it.` });
      }
      const meta = readKnowledgePageMeta(page.content);
      const bytes = Buffer.byteLength(page.content, 'utf8');
      totalBytes += bytes;
      changes.push({
        page: from,
        action: 'rename',
        renameTo: to,
        html: page.content,
        ...('error' in meta ? {} : { title: meta.title, description: meta.description }),
        bytes,
        baseSha: current,
        // Its files come with it: they are recorded on the index entry this
        // landing carries across, and their bytes are addressed by a path
        // stored when they were attached, never rebuilt from the page's name.
        ...(pageAttachments.get(from)?.length ? { attachments: pageAttachments.get(from)! } : {}),
      });
    }

    if (totalBytes > KNOWLEDGE_PROPOSAL_MAX_BYTES) {
      return res.status(413).json({
        error: `One proposal carries at most ${Math.round(KNOWLEDGE_PROPOSAL_MAX_BYTES / (1024 * 1024))} MB of pages — split it.`,
      });
    }
    const creating = changes.filter((change) => change.action === 'create').length;
    if (shas.size + creating > KNOWLEDGE_BASE_MAX_PAGES) {
      return res.status(403).json({
        error: `This account's knowledge base holds ${KNOWLEDGE_BASE_MAX_PAGES} pages at most (it has ${shas.size}).`,
      });
    }

    const title = String(body.title ?? '').trim() || defaultProposalTitle(changes);
    const note = body.note ? String(body.note) : '';
    for (const error of [validateKnowledgeProposalTitle(title), validateKnowledgeProposalNote(note)]) {
      if (error) return res.status(400).json({ error });
    }

    // Applied at once (note #746): the record is the page's history entry,
    // not a request. Nobody is asked; the owner is told.
    const applied = await knowledge.service.apply({
      userId: knowledge.ns.namespaceId,
      createdByUserId: auth.userId,
      title,
      ...(note ? { note } : {}),
      changes,
      createdByAgentId: auth.agentId,
    }, await numberSeries(auth, knowledge.ns));
    return answerApplied(auth, applied, res);
  });

  /**
   * What a landed change leaves to do, and the reply (note #746): orphaned
   * bytes cleared, margins moved with their pages, the owner told by a line
   * in this agent's chat, and the agent answered with where the page is.
   */
  const answerApplied = async (auth: AgentAuth, applied: KnowledgeApplyResult, res: Response) => {
    if (applied.status === 'conflict') {
      return res.status(409).json({
        proposal: describeKnowledgeProposal(auth, applied.proposal),
        error: `${applied.pages.map((page) => `"${page}"`).join(', ')} changed after you read it, so nothing was applied. Read the page again with \`agentbuilt knowledge show\`, redo your change on top of what is there now, and propose again.`,
      });
    }
    for (const file of applied.orphaned) {
      await deps.mediaStorage?.deleteObject?.({ storagePath: file.storagePath })
        .catch((error: unknown) => console.warn(`[knowledge] clearing ${file.fileName} failed:`, error));
    }
    await moveMarginsForLandedChanges(deps.knowledgePageCommentStorage, applied.proposal.userId, applied.proposal.changes);
    const told = await deps.tellOwnerKnowledgeChanged?.({
      userId: auth.userId, agentId: auth.agentId, proposalId: applied.proposal.id,
    }).catch(() => false) ?? false;
    const pages = applied.proposal.changes.map((change) => (change.action === 'rename' && change.renameTo ? change.renameTo : change.page));
    const first = pages[0]!;
    return res.status(201).json({
      proposal: describeKnowledgeProposal(auth, applied.proposal),
      applied: true,
      toldUser: told,
      message: `${describeKnowledgeChanges(applied.proposal.changes)} — LIVE now as knowledge change #${applied.proposal.number}: ${pages.map((page) => `"${page}"`).join(', ')}. `
        + (applied.lostFiles?.length
          ? `Its files (${applied.lostFiles.join(', ')}) were cleared when the page was removed and did NOT come back — the page still points at them, so attach them again. `
          : '')
        + (told
          ? 'Your user has been told by a line in your chat; nobody was asked. '
          : 'Nobody was asked, and the line telling your user could not be written — say it in your reply. ')
        + `\`agentbuilt knowledge restore ${first}\` puts a page back to the version before; \`knowledge history ${first}\` lists its versions.`,
    });
  };

  /** Every version of a page, newest first (note #746). */
  router.get('/knowledge/pages/:name/history', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth, res);
    if (!knowledge) return;
    const name = String(req.params.name ?? '').trim();
    const nameError = validateKnowledgePageName(name);
    if (nameError) return res.status(400).json({ error: nameError });
    const versions = await knowledge.service.pageHistory(await numberedNamespaces(auth, knowledge.ns), name);
    return res.json({
      page: name,
      versions: versions.map(({ proposal, change, canRestore }) => ({
        number: proposal.number,
        action: change.action,
        ...(change.action === 'rename' && change.renameTo ? { renameTo: change.renameTo } : {}),
        title: proposal.title,
        ...(proposal.note ? { note: proposal.note } : {}),
        at: proposal.decidedAt ?? proposal.createdAt,
        by: proposal.createdByAgentId === auth.agentId
          ? 'you'
          : proposal.createdByAgentId === QUICK_NOTE_AUTHOR_USER
            ? 'your user'
            : auth.agents[proposal.createdByAgentId]?.name ?? 'another agent',
        ...(proposal.direct ? {} : { approved: true }),
        ...(proposal.restoreOf ? { restore: true } : {}),
        canRestore,
      })),
    });
  });

  /**
   * Put a page back in one step (note #746): to the version before its last
   * change, or — `--to <n>` — to what change #n landed. A restore is itself
   * a landed, told-not-asked change, so the owner hears of it the same way.
   */
  router.post('/knowledge/pages/:name/restore', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth, res);
    if (!knowledge) return;
    const name = String(req.params.name ?? '').trim();
    const nameError = validateKnowledgePageName(name);
    if (nameError) return res.status(400).json({ error: nameError });
    const body = (req.body ?? {}) as { to?: unknown; note?: unknown };
    const toNumber = body.to === undefined || body.to === null || body.to === '' ? undefined : Number(body.to);
    if (toNumber !== undefined && (!Number.isInteger(toNumber) || toNumber < 1)) {
      return res.status(400).json({ error: '`--to` names a knowledge change by number — `agentbuilt knowledge history <name>` prints them.' });
    }
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : '';
    const noteError = note ? validateKnowledgeProposalNote(note) : null;
    if (noteError) return res.status(400).json({ error: noteError });
    const result = await knowledge.service.restore({
      namespaces: await numberedNamespaces(auth, knowledge.ns),
      page: name,
      ...(toNumber !== undefined ? { toNumber } : {}),
      actor: { agentId: auth.agentId, userId: auth.userId, namespaceId: knowledge.ns.namespaceId },
      ...(note ? { note } : {}),
      numbering: await numberSeries(auth, knowledge.ns),
    });
    if (result.status === 'nothing') return res.status(409).json({ error: result.reason });
    return answerApplied(auth, result, res);
  });

  /**
   * The ask itself, as its own verb — the knowledge half of note #293. A
   * proposal's pages are frozen at creation, so there is no pin to refresh
   * and no CI to read; what this does is flip the record and send the card
   * and notification exactly as `knowledge propose` used to. Idempotent for
   * the same reason `pr ready` is: a retry after a CLI timeout must not fire
   * a second card at the same person.
   */
  router.post('/knowledge/proposals/:number/ready', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth, res);
    if (!knowledge) return;
    const doc = await knowledgeProposalByNumber(auth, knowledge, req.params.number, res);
    if (!doc) return;
    if (!proposalOwnedByAuth(auth, doc)) {
      return res.status(403).json({ error: 'Only the owner of the proposing agent can invite the user to this knowledge proposal.' });
    }
    if (doc.status === 'approved') {
      return res.json({
        ok: true,
        askedUser: false,
        message: `Knowledge change #${doc.number} is already LIVE — since 12 Oct 2026 (note #746) a knowledge change applies the moment it is written, and nobody is asked. There is nothing to invite your user to.`,
      });
    }
    if (doc.status !== 'open') {
      return res.status(409).json({ error: `Knowledge proposal #${doc.number} is ${doc.status} — there is nothing to apply.` });
    }
    // A proposal recorded before changes applied at once (note #746): "ready"
    // now means apply it, on the same terms as a fresh change.
    const landed = await knowledge.service.land(doc.id, auth.userId, doc.note);
    if (landed.status === 'conflict') {
      return res.status(409).json({
        error: `${landed.pages.map((page) => `"${page}"`).join(', ')} changed after #${doc.number} was written, so nothing was applied. Reread the page and propose again from its current words; #${doc.number} is marked conflict.`,
      });
    }
    if (landed.status !== 'landed') return res.status(409).json({ error: `Knowledge proposal #${doc.number} could not be applied.` });
    await knowledge.proposals.update(doc.id, { draft: undefined, direct: true });
    return answerApplied(auth, {
      status: 'applied', commitSha: landed.commitSha, proposal: (await knowledge.proposals.get(doc.id))!, orphaned: landed.orphaned,
    }, res);
  });

  router.get('/knowledge/proposals', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth, res);
    if (!knowledge) return;
    const all = await knowledge.proposals.listByUser(knowledge.ns.namespaceId);
    const docs = req.query.all === 'true' ? all : all.filter((doc) => doc.status === 'open');
    return res.json({ proposals: docs.map((doc) => describeKnowledgeProposal(auth, doc)) });
  });

  router.get('/knowledge/proposals/:number', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth, res);
    if (!knowledge) return;
    const doc = await knowledgeProposalByNumber(auth, knowledge, req.params.number, res);
    if (!doc) return;
    return res.json({ proposal: describeKnowledgeProposal(auth, doc) });
  });

  router.post('/knowledge/proposals/:number/close', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth, res);
    if (!knowledge) return;
    const doc = await knowledgeProposalByNumber(auth, knowledge, req.params.number, res);
    if (!doc) return;
    if (!proposalOwnedByAuth(auth, doc)) {
      return res.status(403).json({
        error: 'Only the owner of the proposing agent can withdraw this knowledge proposal.',
      });
    }
    if (doc.status !== 'open') {
      return res.status(409).json({ error: `Knowledge proposal #${doc.number} is already ${doc.status}.` });
    }
    // Withdrawing its own proposal is the one state change an agent may make
    // here: it removes a request, it never changes a page.
    await knowledge.proposals.update(doc.id, { status: 'withdrawn', decidedAt: new Date().toISOString() });
    return res.json({ ok: true, message: `Knowledge proposal #${doc.number} withdrawn.` });
  });

  /** The proposal's margin (note #66) — the PR comment route, on the other
   *  decision queue, under the same rules. */
  router.post('/knowledge/proposals/:number/comments', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth, res);
    if (!knowledge) return;
    const body = (req.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string') {
      return res.status(400).json({ error: 'Send { text } — a comment is semantic HTML, and plain words are valid HTML.' });
    }
    const invalid = validateKnowledgeComment(body.text);
    if (invalid) return res.status(400).json({ error: invalid });
    const doc = await knowledgeProposalByNumber(auth, knowledge, req.params.number, res);
    if (!doc) return;
    if (!knowledgeProposalTakesComments(doc.status) && !(doc.direct && doc.status === 'approved')) {
      return res.status(409).json({
        error: `Knowledge proposal #${doc.number} is ${doc.status} — its margin closed with the decision.`,
      });
    }
    if ((doc.comments?.length ?? 0) >= MAX_COMMENTS) {
      return res.status(400).json({
        error: `Knowledge proposal #${doc.number} already carries ${MAX_COMMENTS} comments — the most one holds.`,
      });
    }
    const updated = await knowledge.proposals.addComment(doc.id, newMarginComment(auth.agentId, body.text.trim(), auth.userId));
    if (!updated) return res.status(404).json({ error: `No knowledge proposal #${req.params.number}` });
    return res.json({
      ok: true,
      proposal: describeKnowledgeProposal(auth, updated),
      message: `Commented on knowledge proposal #${updated.number} — "${updated.title}". Anyone opening it sees it.`,
    });
  });

  /**
   * A remark on a knowledge PAGE itself (Owner, note #66) — the margin
   * beside a document only a proposal may change. "This page is stale — the
   * deploy moved to the new host" said next to the page, signed and dated,
   * without the ceremony of proposing an edit; and the reader who would have
   * trusted the page sees the caveat in the same glance. What is worth
   * KEEPING still belongs in the page: propose the change, then the margin
   * has nothing left to warn about.
   */
  router.post('/knowledge/pages/:name/comments', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth, res);
    if (!knowledge) return;
    const store = deps.knowledgePageCommentStorage;
    if (!store) return res.status(503).json({ error: 'Page comments are not available on this backend yet' });
    const body = (req.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string') {
      return res.status(400).json({ error: 'Send { text } — a comment is semantic HTML, and plain words are valid HTML.' });
    }
    const invalid = validateKnowledgeComment(body.text);
    if (invalid) return res.status(400).json({ error: invalid });
    const name = String(req.params.name ?? '').trim();
    const nameError = validateKnowledgePageName(name);
    if (nameError) return res.status(400).json({ error: nameError });
    const page = await knowledge.service.readPage(knowledge.ns.namespaceId, name);
    if (!page) return res.status(404).json({ error: `There is no knowledge page called "${name}".` });
    const existing = await store.list(knowledge.ns.namespaceId, name);
    if (existing.length >= MAX_COMMENTS) {
      return res.status(400).json({
        error: `"${name}" already carries ${MAX_COMMENTS} comments — the most a page holds. What they agree on belongs in the page now: propose the change.`,
      });
    }
    const comments = await store.add(knowledge.ns.namespaceId, name, newMarginComment(auth.agentId, body.text.trim(), auth.userId));
    return res.json({
      ok: true,
      comments: comments.map((c) => describeComment(auth, c)),
      message: `Commented on "${name}". Anyone opening the page sees it; nothing notifies anybody, so say it in chat too if it needs acting on now.`,
    });
  });

  // ── Quick notes (docs/agent-quick-notes.md) ──
  //
  // The one store an agent WRITES directly. No proposal, no branch, no tap:
  // a note is a jotting, and a jotting that costs a round trip through the
  // user's chat is a jotting nobody makes. A room agent's shelf is visible in
  // that room; the Workspace Agent's default shelf is private working memory
  // and never crosses into the person's UI (note #468).
  const requireNotes = (res: Response) => {
    if (!deps.quickNoteStorage) {
      res.status(503).json({ error: 'Quick notes are not available on this backend yet' });
      return null;
    }
    return deps.quickNoteStorage;
  };

  const notesOwner = async (auth: AgentAuth): Promise<string> => (
    (await gitNamespace(auth)).namespaceId
  );

  /**
   * The note this number names, or respond and return null.
   *
   * Found across the WORKPLACE (notes #741, #843): the workplace's own copy
   * wins, then its old rooms' namespaces; a number held twice there (from
   * before numbers were workplace-wide) is the person's to name. A note's
   * earlier addresses count too.
   */
  const noteByNumber = async (
    auth: AgentAuth,
    notes: NonNullable<RouteDeps['quickNoteStorage']>,
    raw: unknown,
    res: Response,
  ): Promise<QuickNoteDocument | null> => {
    const number = Number(raw);
    // A note is addressed by its number and nothing else, so a non-number is
    // worth naming outright rather than 404ing as "no note #shopping".
    if (!Number.isInteger(number) || number < 1) {
      res.status(400).json({ error: `Notes are addressed by number ("${String(raw)}" is not one) — \`agentbuilt note list\` prints them.` });
      return null;
    }
    const ns = await gitNamespace(auth);
    const found = pickNumbered(await notes.findByNumber(await numberedNamespaces(auth, ns), number), number, ns.namespaceId);
    if (found.kind === 'one') return found.doc;
    if (found.kind === 'many') {
      res.status(409).json({ error: await sharedNumberError('Note', number, found.docs.map((doc) => doc.userId)) });
      return null;
    }
    res.status(404).json({ error: `No note #${number} in this workplace.` });
    return null;
  };

  /**
   * Whether this human's agents own the words currently standing in a note.
   *
   * Notes share a workplace namespace, but authorship does not: an agent
   * may rewrite a note last written by another one of the same human's agents,
   * while a teammate's agent leaves a signed comment instead. Human-written
   * notes are never agent-editable, including by that human's own agents.
   * Legacy agent notes have no human stamp, so their author still proves
   * ownership through the authenticated human's org-scoped fleet.
   */
  const noteEditableByAuth = (auth: AgentAuth, doc: QuickNoteDocument): boolean => {
    if (doc.updatedByAgentId === QUICK_NOTE_AUTHOR_USER) return false;
    if (doc.updatedByUserId) return doc.updatedByUserId === auth.userId;
    return Boolean(auth.agents[doc.updatedByAgentId]);
  };

  /**
   * Who said it, in the words the reading agent needs: "you" is its own remark
   * from a turn it no longer remembers, any other agent gets its name, and a
   * PERSON — writing in the margin from their Workspace since notes #64/#66 —
   * is "your user", or "a workplace member" when the stamp names a
   * teammate. The id itself never travels — it names nothing an agent could
   * act on.
   */
  const describeComment = (auth: AgentAuth, comment: MarginComment) => ({
    text: comment.text,
    createdAt: comment.createdAt,
    by: comment.authorId === COMMENT_AUTHOR_USER
      ? (comment.userId && comment.userId !== auth.userId ? 'a workplace member' : 'your user')
      : comment.authorId === auth.agentId
        ? 'you'
        : auth.agents[comment.authorId]?.name ?? 'another agent',
  });

  const describeNoteWork = (auth: AgentAuth, work: QuickNoteWork) => {
    // The user gave this note to an agent and nobody has claimed it yet
    // (notes #234/#258). `byYou` is the whole point of carrying it here: the
    // agent reading its own list needs to know the difference between a note
    // going spare and a note its user handed to IT — the second is not
    // available work, it is a request already addressed.
    if (work.state === 'handed') {
      return {
        state: work.state,
        agentName: work.handoff.agentId === auth.agentId
          ? auth.agents[auth.agentId]?.name ?? work.handoff.agentName
          : work.handoff.agentName,
        ...(work.handoff.agentId === auth.agentId ? { byYou: true as const } : {}),
        handedAt: work.handoff.handedAt,
        expiresAt: work.handoff.expiresAt,
      };
    }
    if (work.state === 'working') {
      return {
        state: work.state,
        agentName: work.claim.agentId === auth.agentId
          ? auth.agents[auth.agentId]?.name ?? work.claim.agentName
          : work.claim.agentName,
        ...(work.claim.agentId === auth.agentId ? { byYou: true as const } : {}),
        claimedAt: work.claim.claimedAt,
        expiresAt: work.claim.expiresAt,
      };
    }
    if (work.state === 'proposal' || work.state === 'merged' || work.state === 'live') {
      return {
        state: work.state,
        proposalNumber: work.proposal.number,
        proposalStatus: work.proposal.status,
      };
    }
    return { state: 'unclaimed' as const };
  };

  const noteWork = async (docs: QuickNoteDocument[]) => resolveQuickNoteWorkMap({
    notes: docs,
    pullRequests: deps.gitPullRequestStorage,
    commitStatuses: deps.gitCommitStatusStorage,
  });

  const describeNoteSummary = (auth: AgentAuth, doc: QuickNoteDocument, work: QuickNoteWork) => ({
    ...summarizeQuickNote(doc),
    ...(!quickNoteIsArchived(doc) ? { work: describeNoteWork(auth, work) } : {}),
  });

  const describeNote = (auth: AgentAuth, doc: QuickNoteDocument, work: QuickNoteWork) => ({
    ...describeNoteSummary(auth, doc, work),
    html: doc.html,
    // Whole, not counted, once a note is actually open: a remark is short and
    // the reason to open a commented note is to read what it says.
    ...(doc.comments?.length
      ? { comments: doc.comments.map((comment) => describeComment(auth, comment)) }
      : {}),
    // Names and sizes ride the note; the bytes are one `note fetch` away.
    ...(doc.attachments?.length
      ? {
        attachments: doc.attachments.map((a) => ({
          fileName: a.fileName,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
          addedAt: a.addedAt,
        })),
      }
      : {}),
  });

  const describeOneNote = async (auth: AgentAuth, doc: QuickNoteDocument) => {
    const works = await noteWork([doc]);
    const href = await noteHref(auth, doc);
    return {
      ...describeNote(auth, doc, works.get(doc.id) ?? { state: 'unclaimed' }),
      // The exact registered path the browser understands. In particular the
      // Workspace Agent must not have to invent a hostname or reconstruct the
      // room scope after it creates or edits an explicit-room note (note
      // #441). Its private notes have no browser path (note #468).
      ...(href ? { href } : {}),
    };
  };

  /**
   * The note's HTML out of a request body, or a 400 that says what to send.
   *
   * `{ text }` is still accepted and CONVERTED: it is what CLI 1.8.0 sends,
   * and that CLI is still on every machine whose agent has not started a turn
   * since notes became HTML. Refusing it would break `note add` for exactly
   * the agents that cannot yet know why.
   */
  const noteHtmlFrom = (body: { html?: unknown; text?: unknown }, res: Response): string | null => {
    const html = typeof body.html === 'string' ? body.html
      : typeof body.text === 'string' ? textToSafeHtml(body.text)
        : null;
    if (html === null) {
      res.status(400).json({ error: 'Send { html } — the note, as one HTML fragment.' });
      return null;
    }
    const invalid = validateQuickNoteHtml(html);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return null;
    }
    return html;
  };

  /**
   * A note that must be LIVE for what is about to happen to it, or a reply and
   * null. Every write goes through here.
   *
   * An archived note is read-only (types/quick-note.ts): not to protect it,
   * but because a note kept up to date inside the archive is a live note in
   * the wrong place. The refusal names the way back rather than just saying
   * no — an agent that finds one of these has usually picked the right note.
   */
  const requireLiveNote = (doc: QuickNoteDocument, res: Response, verb: string): boolean => {
    if (!quickNoteIsArchived(doc)) return true;
    res.status(400).json({
      error: `Note #${doc.number} is archived, so it cannot be ${verb}. Bring it back first: \`agentbuilt note unarchive ${doc.number}\`.`,
    });
    return false;
  };

  router.get('/notes', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    // The archive is asked for, never mixed in: a list of notes is the notes
    // this account is working from, and one carrying last month's put-away
    // jottings is a list an agent has to filter before it can act on it.
    const archived = req.query.archived === '1' || req.query.archived === 'true';
    const ownerId = await notesOwner(auth);
    const docs = archived
      ? await notes.listArchivedByUser(ownerId)
      : await notes.listByUser(ownerId);
    // Titles and previews only: a list is for FINDING a note, and shipping a
    // hundred note bodies to answer "which one" is the one thing a store this
    // small could still get expensive at.
    const works = await noteWork(docs);
    return res.json({
      notes: docs.map((doc) => describeNoteSummary(auth, doc, works.get(doc.id) ?? { state: 'unclaimed' })),
      // How many are in the archive, on the LIVE list: it is the only place an
      // agent finds out the archive has anything in it — nothing else points
      // at it, and a note put away by another agent is otherwise invisible.
      ...(archived ? {} : { archived: await notes.countArchivedByUser(ownerId) }),
    });
  });

  router.get('/notes/:number', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    const doc = await noteByNumber(auth, notes, req.params.number, res);
    if (!doc) return;
    return res.json({ note: await describeOneNote(auth, doc) });
  });

  /**
   * One atomic commitment point for work sourced from a note (note #99): the
   * store rereads the current document, wins an expiring lease or loses whole,
   * and fingerprints exactly the body, margin and files returned here.
   */
  router.post('/notes/:number/claim', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    const doc = await noteByNumber(auth, notes, req.params.number, res);
    if (!doc) return;
    if (!requireLiveNote(doc, res, 'started')) return;

    // Once a linked proposal is open or merged, the structured state owns the
    // row; another lease would make the same note say two incompatible things.
    const proposals = deps.gitPullRequestStorage
      ? await deps.gitPullRequestStorage.listByQuickNoteNamespace(doc.userId)
      : [];
    const existing = proposals.find((proposal) => (
      (proposal.status === 'open' || proposal.status === 'merged')
      && pullRequestQuickNoteNumbers(proposal).includes(doc.number)
    ));
    if (existing) {
      return res.status(409).json({
        error: existing.status === 'merged'
          ? `Note #${doc.number} is already implemented by merged PR #${existing.number}.`
          : `Note #${doc.number} already has open PR #${existing.number}. Work from that proposal instead of starting a second implementation.`,
      });
    }

    const now = new Date();
    const result = await notes.claim(doc.id, {
      agentId: auth.agentId,
      userId: auth.userId,
      agentName: auth.agents[auth.agentId]?.name ?? 'This agent',
    }, now);
    if (!result) return res.status(404).json({ error: `No note #${doc.number} on this account.` });
    if (result.outcome === 'archived') {
      return res.status(409).json({
        error: `Note #${doc.number} moved into the archive before it could be claimed. Restore it before starting work.`,
      });
    }
    if (result.outcome === 'held') {
      return res.status(409).json({
        error: `Note #${doc.number} is already being worked on by ${result.claim.agentName} until ${result.claim.expiresAt}. Do not proceed from an older snapshot.`,
        note: await describeOneNote(auth, result.note),
      });
    }
    return res.json({
      ok: true,
      outcome: result.outcome,
      note: await describeOneNote(auth, result.note),
      message: result.outcome === 'renewed'
        ? `Renewed your claim on note #${doc.number} until ${result.claim.expiresAt}; the note below is the current version you are committing to.`
        : `Claimed note #${doc.number} until ${result.claim.expiresAt}; the note below is the current version you are committing to.`,
    });
  });

  /** Put abandoned or non-PR work back into Unclaimed immediately. */
  router.delete('/notes/:number/claim', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    const doc = await noteByNumber(auth, notes, req.params.number, res);
    if (!doc) return;
    const result = await notes.releaseClaim(doc.id, auth.agentId, new Date());
    if (!result) return res.status(404).json({ error: `No note #${doc.number} on this account.` });
    if (result.outcome === 'held') {
      return res.status(409).json({
        error: `Note #${doc.number} belongs to ${result.claim!.agentName} until ${result.claim!.expiresAt}; only that agent can release it.`,
      });
    }
    return res.json({
      ok: true,
      note: await describeOneNote(auth, result.note),
      message: result.outcome === 'released'
        ? `Released note #${doc.number}; it is Unclaimed again.`
        : `Note #${doc.number} is already Unclaimed.`,
    });
  });

  router.post('/notes', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    const html = noteHtmlFrom((req.body ?? {}) as Record<string, unknown>, res);
    if (html === null) return;
    const ownerId = await notesOwner(auth);
    if (await notes.countByUser(ownerId) >= QUICK_NOTES_MAX_PER_USER) {
      return res.status(400).json({
        error: `This account holds ${QUICK_NOTES_MAX_PER_USER} quick notes at most. Archive one that has served its purpose (\`agentbuilt note archive <n>\`) — it stays readable in the archive.`,
      });
    }
    const doc = await notes.create({
      userId: ownerId,
      html,
      createdByAgentId: auth.agentId,
      createdByUserId: auth.userId,
      updatedByAgentId: auth.agentId,
      updatedByUserId: auth.userId,
    }, await numberSeries(auth, await gitNamespace(auth)));
    return res.json({
      ok: true,
      note: await describeOneNote(auth, doc),
      message: `Note #${doc.number} saved — "${quickNoteTitle(doc.html)}". Your user can read it in their Workspace.`,
    });
  });

  /**
   * Rewrites a note whole. PUT rather than PATCH because that is what it is:
   * the text that arrives replaces the text that was there, and an agent that
   * wants to add a line reads the note first.
   *
   * Any of the same human owner's agents may edit an agent-written note. The
   * workplace shares the store, not authorship: a teammate's note and a
   * human-written note get a signed comment instead. The two updated-by fields
   * retain both halves of that boundary in a shared namespace.
   */
  router.put('/notes/:number', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    const html = noteHtmlFrom((req.body ?? {}) as Record<string, unknown>, res);
    if (html === null) return;
    const doc = await noteByNumber(auth, notes, req.params.number, res);
    if (!doc) return;
    if (!requireLiveNote(doc, res, 'edited')) return;
    if (!noteEditableByAuth(auth, doc)) {
      return res.status(403).json({
        error: doc.updatedByAgentId === QUICK_NOTE_AUTHOR_USER
          ? 'A person in this workplace wrote this note. An agent cannot rewrite their words; leave a comment instead.'
          : 'Another workplace member\'s agent last wrote this note. Only that member\'s agents can edit its words; leave a comment instead.',
      });
    }
    const updated = await notes.update(doc.id, {
      html,
      updatedAt: new Date().toISOString(),
      updatedByAgentId: auth.agentId,
      updatedByUserId: auth.userId,
    });
    if (!updated) return res.status(404).json({ error: `No note #${doc.number} on this account.` });
    return res.json({
      ok: true,
      note: await describeOneNote(auth, updated),
      message: `Note #${updated.number} updated — "${quickNoteTitle(updated.html)}".`,
    });
  });

  /**
   * A remark on a note, without touching the note (Owner's note #9).
   *
   * The margin, and the ONLY place an agent may answer a note that is not its
   * own. Editing is the wrong tool for half of what there is to say about a
   * note — "the code changed on Tuesday", "I could not reach the plumber" —
   * because rewriting the note destroys the words the USER put there, and
   * adding a line to somebody else's jotting makes it unclear who said what. A
   * comment is signed and additive.
   *
   * Agents only: the Workspace reads this margin and does not write in it, so
   * every remark here is one an agent left (Owner, 2026-08-17).
   */
  router.post('/notes/:number/comments', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    const body = (req.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string') {
      return res.status(400).json({ error: 'Send { text } — a comment is semantic HTML, and plain words are valid HTML.' });
    }
    const invalid = validateQuickNoteComment(body.text);
    if (invalid) return res.status(400).json({ error: invalid });
    const doc = await noteByNumber(auth, notes, req.params.number, res);
    if (!doc) return;
    if (!requireLiveNote(doc, res, 'commented on')) return;
    if ((doc.comments?.length ?? 0) >= QUICK_NOTE_MAX_COMMENTS) {
      return res.status(400).json({
        error: `Note #${doc.number} already carries ${QUICK_NOTE_MAX_COMMENTS} comments — the most one holds. What is worth keeping belongs in the note itself now.`,
      });
    }
    const updated = await notes.addComment(doc.id, newQuickNoteComment(auth.agentId, body.text.trim(), auth.userId));
    if (!updated) return res.status(404).json({ error: `No note #${doc.number} on this account.` });
    return res.json({
      ok: true,
      note: await describeOneNote(auth, updated),
      message: `Commented on note #${updated.number} — "${quickNoteTitle(updated.html)}". Your user sees it under the note in their Workspace.`,
    });
  });

  /**
   * Put a note away (Owner, note #23). Reversible, and the note keeps
   * everything — its number, its words, its comments, its files.
   *
   * This is what "getting rid of" a note means now, for an agent. It is the
   * verb the identity block teaches and the one the ceiling's refusal points
   * at, because almost every real reason to remove a note ("this has served
   * its purpose") is a reason to archive it: nothing is lost, the list is
   * clean, and if the agent was wrong the user has the note.
   */
  /**
   * `agentbuilt note hand <n> "<agent>" ["<message>"]` (note #716): the
   * Workspace Agent hands an UNCLAIMED note to one of the person's idle
   * agents in the note's own room — the person's hand-over
   * (`POST /api/notes/:n/handoff`), done by their Chief of Staff. The note
   * goes as the Workspace Agent's own message, so the answer comes back to
   * its conversation, and the note records whom it was handed to. Its verb
   * alone: a room agent tells its user instead.
   */
  router.post('/notes/:number/hand', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.purpose) return res.status(403).json({ error: 'Handing a note to an agent is the Workspace Agent\'s verb. Your user hands notes over from the Workspace.' });
    if (!deps.workspaceAgent || !auth.orgId) return res.status(503).json({ error: 'Handing notes over is not available on this backend.' });
    const notes = requireNotes(res);
    if (!notes) return;
    const doc = await noteByNumber(auth, notes, req.params.number, res);
    if (!doc) return;
    if (!requireLiveNote(doc, res, 'handed over')) return;
    const body = (req.body ?? {}) as { agent?: unknown; message?: unknown };
    const agent = typeof body.agent === 'string' ? body.agent.trim() : '';
    if (!agent) return res.status(400).json({ error: 'Name the agent: `agentbuilt note hand <n> "<name-or-id>"`.' });
    const extra = typeof body.message === 'string' ? body.message.trim() : '';
    if (extra.length > AGENT_MESSAGE_MAX_LENGTH - 400) return res.status(400).json({ error: `Keep the message under ${AGENT_MESSAGE_MAX_LENGTH - 400} characters; the note itself carries the request.` });
    const work = (await noteWork([doc])).get(doc.id) ?? { state: 'unclaimed' as const };
    if (work.state !== 'unclaimed') {
      return res.status(409).json({ error: `Note #${doc.number} is not unclaimed (it is ${work.state === 'handed' ? `handed to ${work.handoff.agentName}` : work.state === 'working' ? `being worked on by ${work.claim.agentName}` : `at "${work.state}"`}). Only an unclaimed note is handed over.` });
    }
    const title = quickNoteTitle(doc.html);
    const message = [
      `Your user's note #${doc.number}, "${title}", is yours to pick up. Start with \`agentbuilt note start ${doc.number}\`, work from what it says, and link a proposal with --note ${doc.number}.`,
      extra,
    ].filter(Boolean).join('\n\n');
    const result = await deps.workspaceAgent.messageAgent({
      userId: auth.userId, orgId: auth.orgId, senderAgentId: auth.agentId, recipient: agent, message,
      receipt: (name) => `Handed note #${doc.number} to ${name}: ${title}`,
    });
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : result.code === 'busy' ? 409 : result.code === 'ambiguous' ? 400 : 503;
      return res.status(status).json({ error: result.reason });
    }
    const handedAt = new Date();
    const updated = await notes.update(doc.id, {
      handoff: {
        agentId: result.recipient.id, agentName: result.recipient.name, userId: auth.userId,
        handedAt: handedAt.toISOString(), expiresAt: new Date(handedAt.getTime() + QUICK_NOTE_HANDOFF_WINDOW_MS).toISOString(),
      },
    });
    return res.json({
      ok: true,
      name: result.recipient.name,
      note: await describeOneNote(auth, updated ?? doc),
      message: `Handed note #${doc.number} to ${result.recipient.name}. The note says so, and ${result.recipient.name}'s answer comes back to this conversation.`,
    });
  });

  router.post('/notes/:number/archive', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    const doc = await noteByNumber(auth, notes, req.params.number, res);
    if (!doc) return;
    // Not an error: the note is where the caller wanted it. Two agents tidying
    // up at once should not have one of them fail at a job already done.
    if (quickNoteIsArchived(doc)) {
      return res.json({
        ok: true,
        note: await describeOneNote(auth, doc),
        message: `Note #${doc.number} was already archived — "${quickNoteTitle(doc.html)}".`,
      });
    }
    // In an event turn (note #716) the permission covers a FINISHED note
    // only: its work is live. Whether its last comment leaves anything open
    // is the agent's reading; this much the platform can check itself.
    const eventTurn = Boolean(auth.purpose && auth.orgId && await deps.workspaceAgent?.isEventTurn?.(auth.userId, auth.orgId).catch(() => false));
    if (eventTurn) {
      const state = (await noteWork([doc])).get(doc.id)?.state ?? 'unclaimed';
      if (state !== 'live') {
        return res.status(403).json({ error: `This is an event turn, and note #${doc.number} is ${state === 'unclaimed' ? 'unclaimed' : `at "${state}"`}, not live: only a finished note is archived without asking. Nothing was done.` });
      }
    }
    const updated = await notes.update(doc.id, {
      archivedAt: new Date().toISOString(),
      archivedByAgentId: auth.agentId,
    });
    if (!updated) return res.status(404).json({ error: `No note #${doc.number} on this account.` });
    // Note verbs leave no row (note #623) — except this one, done on the
    // agent's own motion: the row is how the person finds out (note #716).
    if (eventTurn) await deps.workspaceAgent!.receipt(auth.userId, auth.orgId!, `Archived note #${updated.number}: ${quickNoteTitle(updated.html)}`, await noteHref(auth, updated)).catch(() => {});
    return res.json({
      ok: true,
      note: await describeOneNote(auth, updated),
      message: `Archived note #${updated.number} — "${quickNoteTitle(updated.html)}". It is out of the notes list but not gone: your user can read it, and bring it back, from the archive in their Workspace.`,
    });
  });

  /** Back onto the desk, under the number it never stopped holding. */
  router.delete('/notes/:number/archive', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    const doc = await noteByNumber(auth, notes, req.params.number, res);
    if (!doc) return;
    if (!quickNoteIsArchived(doc)) {
      return res.json({
        ok: true,
        note: await describeOneNote(auth, doc),
        message: `Note #${doc.number} is not archived — it is in the notes list already.`,
      });
    }
    // The live ceiling is checked on the way BACK, not on the way out: the
    // archive is not a way to keep 200 working notes, so a restore into a full
    // desk is refused exactly as writing note 101 would be.
    // The ceiling of the room the note STANDS in (note #741), which a
    // cross-room lookup may have found elsewhere than the caller's.
    if (await notes.countByUser(doc.userId) >= QUICK_NOTES_MAX_PER_USER) {
      return res.status(400).json({
        error: `This account already holds ${QUICK_NOTES_MAX_PER_USER} live notes, so there is no room to bring #${doc.number} back. Archive one that has served its purpose first.`,
      });
    }
    const updated = await notes.update(doc.id, { archivedAt: undefined, archivedByAgentId: undefined });
    if (!updated) return res.status(404).json({ error: `No note #${doc.number} on this account.` });
    return res.json({
      ok: true,
      note: await describeOneNote(auth, updated),
      message: `Note #${updated.number} is back in the notes list — "${quickNoteTitle(updated.html)}".`,
    });
  });

  /**
   * The one destructive verb, and it only reaches a note that is ALREADY in
   * the archive — Owner's rule on note #23, whole: "Notes should not be
   * delete. It should be archived. And only from archive a note can be
   * deleted."
   *
   * So this route does two different things depending on where the note is,
   * and that is deliberate rather than sloppy. `DELETE /notes/:n` is what
   * every CLI already installed on every machine calls, and those agents
   * cannot know the rule changed until their identity block is rewritten
   * under them. Refusing them would break `note rm` for exactly the agents
   * with no way to find out why; ARCHIVING them lands the safe half of the
   * new behaviour on an old client, and the message says plainly what
   * happened instead of claiming a delete.
   *
   * `?forever=1` is the destructive half, and it is a separate word on the
   * command line for the reason destructive things always are: an agent
   * cannot reach it by accident, and cannot reach it at all on a live note.
   */
  router.delete('/notes/:number', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    const doc = await noteByNumber(auth, notes, req.params.number, res);
    if (!doc) return;
    const forever = req.query.forever === '1' || req.query.forever === 'true';
    const title = quickNoteTitle(doc.html);

    if (!forever) {
      // The compatibility path AND the honest one: archive, and say so.
      if (quickNoteIsArchived(doc)) {
        return res.json({
          ok: true,
          number: doc.number,
          title,
          archived: true,
          message: `Note #${doc.number} is already archived — "${title}". To delete it for good: \`agentbuilt note rm ${doc.number} --forever\`.`,
        });
      }
      await notes.update(doc.id, {
        archivedAt: new Date().toISOString(),
        archivedByAgentId: auth.agentId,
      });
      return res.json({
        ok: true,
        number: doc.number,
        title,
        archived: true,
        message: `Archived note #${doc.number} — "${title}". Notes are archived rather than deleted now: it is out of the list, still readable, and your user can bring it back or delete it for good from the archive in their Workspace.`,
      });
    }

    if (!quickNoteIsArchived(doc)) {
      return res.status(400).json({
        error: `Note #${doc.number} has not been archived, and a note is only deleted out of the archive. Archive it first (\`agentbuilt note archive ${doc.number}\`) — which is usually all you wanted, since an archived note is out of the list and still there.`,
      });
    }
    await notes.delete(doc.id);
    // Its files go with it — best-effort, the record is already gone. The
    // whole prefix, which also catches an object a crashed upload stranded.
    if (doc.attachments?.length && deps.mediaStorage?.deleteObjectsWithPrefix) {
      // Under the NOTE's room, not the caller's (note #741), and under every
      // room it stood in before: a moved note's files stay where they were
      // uploaded (note #111).
      const owners = new Set([doc.userId, ...(doc.previousLocations ?? []).map((location) => location.userId)]);
      Promise.all([...owners].map((owner) => deps.mediaStorage!.deleteObjectsWithPrefix!({
        prefix: quickNoteStoragePrefix(owner, doc.id),
      }))).catch((error) => console.warn(`[notes] file cleanup for note #${doc.number} failed:`, error));
    }
    // The title goes back in the answer: an agent that deleted the wrong
    // number finds out here, while it still remembers what the note said.
    return res.json({
      ok: true,
      number: doc.number,
      title,
      message: `Deleted note #${doc.number} for good — "${title}". Its comments and files went with it.`,
    });
  });

  /**
   * A file onto a note — raw bytes with the name in a header, the same wire
   * shape `/deploy` uses for its tarball. Any agent may attach to any note:
   * attaching is not editing (nothing about the note's words moves), which is
   * also why the user's Workspace can attach to an agent's note.
   */
  // A note's file in parts (note #784, `services/note-file-uploads.ts`):
  // the CLI sends anything past one 8 MB part — up to 100 MB — as start,
  // parts, complete, so neither end ever holds the whole file.
  const noteFileUpload = async (
    req: Request, res: Response,
    act: (doc: QuickNoteDocument, uploads: NoteFileUploads, notes: QuickNoteStorage, auth: AgentAuth) => Promise<unknown>,
  ) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    if (!deps.mediaStorage) {
      return res.status(503).json({ error: 'File storage is not available on this backend yet — notes are words-only here.' });
    }
    const doc = await noteByNumber(auth, notes, req.params.number, res);
    if (!doc) return;
    if (!requireLiveNote(doc, res, 'attached to')) return;
    try {
      return await act(doc, new NoteFileUploads(deps.mediaStorage), notes, auth);
    } catch (error) {
      if (error instanceof NoteFileUploadError) return res.status(error.status).json({ error: error.message });
      console.warn('[notes] a file upload step failed');
      return res.status(503).json({ error: 'The file could not be saved just now. Try again.' });
    }
  };
  router.post('/notes/:number/files/uploads', (req, res) => noteFileUpload(req, res, async (doc, uploads) => (
    res.status(201).json(await uploads.start(doc, { fileName: req.body?.fileName, sizeBytes: req.body?.sizeBytes, contentType: req.body?.contentType }))
  )));
  router.put(
    '/notes/:number/files/uploads/:id/parts/:part',
    raw({ type: () => true, limit: UPLOAD_PART_BYTES }),
    (req, res) => noteFileUpload(req, res, async (doc, uploads) => res.json(await uploads.part(doc, String(req.params.id), {
      uploadId: req.query.upload, fileName: req.query.name, partNumber: req.params.part,
      data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    }))),
  );
  router.post('/notes/:number/files/uploads/:id/complete', (req, res) => noteFileUpload(req, res, async (doc, uploads, notes, auth) => {
    const attachment = await uploads.complete(doc, String(req.params.id), {
      uploadId: req.body?.uploadId, fileName: req.body?.fileName, contentType: req.body?.contentType, parts: req.body?.parts,
      addedBy: { addedByAgentId: auth.agentId },
    });
    const updated = await notes.update(doc.id, {
      attachments: [...(doc.attachments ?? []), attachment],
      updatedAt: new Date().toISOString(),
    });
    if (!updated) { await uploads.discard(attachment); return res.status(404).json({ error: `No note #${doc.number} on this account.` }); }
    return res.json({
      ok: true,
      note: await describeOneNote(auth, updated),
      message: `Attached ${attachment.fileName} to note #${doc.number} — your user sees it on the note in their Workspace.`,
    });
  }));
  router.delete('/notes/:number/files/uploads/:id', (req, res) => noteFileUpload(req, res, async (doc, uploads) => {
    await uploads.abort(doc, String(req.params.id), { uploadId: req.query.upload, fileName: req.query.name });
    return res.json({ ok: true });
  }));

  router.post(
    '/notes/:number/files',
    raw({ type: () => true, limit: QUICK_NOTE_SINGLE_UPLOAD_MAX_BYTES + 1024 }),
    async (req, res) => {
      const auth = await authenticate(req, res);
      if (!auth) return;
      const notes = requireNotes(res);
      if (!notes) return;
      if (!deps.mediaStorage) {
        return res.status(503).json({ error: 'File storage is not available on this backend yet — notes are words-only here.' });
      }
      const doc = await noteByNumber(auth, notes, req.params.number, res);
      if (!doc) return;
      if (!requireLiveNote(doc, res, 'attached to')) return;
      const fileName = String(req.get('x-note-file-name') ?? '').trim();
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const refusal = validateQuickNoteAttachment({
        fileName,
        sizeBytes: data.length,
        existing: doc.attachments ?? [],
      });
      if (refusal) return res.status(400).json({ error: refusal });
      const attachment = {
        id: randomUUID(),
        fileName,
        contentType: inferContentType(fileName, req.get('content-type')),
        sizeBytes: data.length,
        storagePath: '',
        addedByAgentId: auth.agentId,
        addedAt: new Date().toISOString(),
      };
      // Filed under the note's own room (note #741): the note may live in
      // another room than the agent attaching to it.
      attachment.storagePath = quickNoteAttachmentPath(doc.userId, doc.id, attachment.id, fileName);
      // Bytes first, record second: a crash between the two strands an object
      // (cleared when the note goes), never a record promising absent bytes.
      await deps.mediaStorage.uploadObject({
        storagePath: attachment.storagePath,
        contentType: attachment.contentType,
        data,
      });
      const updated = await notes.update(doc.id, {
        attachments: [...(doc.attachments ?? []), attachment],
        updatedAt: new Date().toISOString(),
      });
      if (!updated) return res.status(404).json({ error: `No note #${doc.number} on this account.` });
      return res.json({
        ok: true,
        note: await describeOneNote(auth, updated),
        message: `Attached ${fileName} to note #${doc.number} — your user sees it on the note in their Workspace.`,
      });
    },
  );

  /** The bytes back, via a short-lived signed URL the CLI follows. */
  router.get('/notes/:number/files/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    if (!deps.mediaStorage) {
      return res.status(503).json({ error: 'File storage is not available on this backend yet.' });
    }
    const doc = await noteByNumber(auth, notes, req.params.number, res);
    if (!doc) return;
    const name = String(req.params.name ?? '');
    const attachment = (doc.attachments ?? []).find((a) => a.fileName === name);
    if (!attachment) {
      const names = (doc.attachments ?? []).map((a) => a.fileName).join(', ');
      return res.status(404).json({
        error: `No file named "${name}" on note #${doc.number}.` + (names ? ` It has: ${names}.` : ' It has no files.'),
      });
    }
    const access = await deps.mediaStorage.createReadAccess({
      storagePath: attachment.storagePath,
      expiresInMs: 15 * 60_000,
    });
    return res.json({
      url: access.url,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
    });
  });

  /** Take a file off a note, by the name `note show` lists it under. */
  router.delete('/notes/:number/files/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = requireNotes(res);
    if (!notes) return;
    const doc = await noteByNumber(auth, notes, req.params.number, res);
    if (!doc) return;
    // Fetching a file off an archived note is fine — reading is what the
    // archive is for. Taking one OFF is a write, and goes through the gate.
    if (!requireLiveNote(doc, res, 'changed')) return;
    const name = String(req.params.name ?? '');
    const attachment = (doc.attachments ?? []).find((a) => a.fileName === name);
    if (!attachment) return res.status(404).json({ error: `No file named "${name}" on note #${doc.number}.` });
    const updated = await notes.update(doc.id, {
      attachments: (doc.attachments ?? []).filter((a) => a.id !== attachment.id),
      updatedAt: new Date().toISOString(),
    });
    if (!updated) return res.status(404).json({ error: `No note #${doc.number} on this account.` });
    // Record first, bytes second — the upload's mirror; a stranded object is
    // the acceptable failure, a record promising absent bytes is not.
    deps.mediaStorage?.deleteObject?.({ storagePath: attachment.storagePath })
      .catch((error) => console.warn(`[notes] deleting ${attachment.fileName} from storage failed:`, error));
    return res.json({
      ok: true,
      message: `Took ${attachment.fileName} off note #${doc.number}.`,
    });
  });

  /**
   * The git host's callback, mid-push: "is this token good, and what may it
   * do?". Authenticated by the host-to-host secret, NOT by an agent token —
   * the token being asked about is the untrusted input here.
   *
   * One round trip answers authentication (which user), authorization (the
   * namespace it may write) and quota, so the host needs no database and no
   * copy of any of those rules.
   */
  /**
   * Did a git host we operate make this call? The central host signs with
   * the platform secret; a per-org host names its org (`x-git-host-org`) and
   * signs with that org's OWN secret — one backend, N hosts, no shared key.
   * The org id in the header selects which secret to compare against, so a
   * host can never authenticate as anything but itself.
   */
  const gitHostCallerOk = async (req: Request): Promise<boolean> => {
    const presented = Buffer.from(String(req.get('x-git-host-secret') ?? ''), 'utf8');
    const orgId = String(req.get('x-git-host-org') ?? '').trim();
    const expected = orgId
      ? (deps.orgSecrets
        ? await deps.orgSecrets.getOrgSecret(orgId, 'GIT_HOST_SECRET').catch(() => null)
        : null) ?? ''
      : deps.gitHostSecret ?? '';
    const expectedBuf = Buffer.from(expected, 'utf8');
    return expectedBuf.length > 0
      && presented.length === expectedBuf.length
      && timingSafeEqual(presented, expectedBuf);
  };

  router.post('/git/verify', async (req, res) => {
    if (!deps.gitHostSecret || !deps.userStorage || !deps.gitRepoStorage) {
      return res.status(503).json({ error: 'Internal git hosting is not configured' });
    }
    if (!(await gitHostCallerOk(req))) {
      return res.status(401).json({ error: 'Bad host secret' });
    }

    const verifyBody = (req.body ?? {}) as { token?: unknown; repo?: unknown };
    const token = String(verifyBody.token ?? '').trim();
    // A CI clone token authenticates a build machine, not an agent: no
    // profile behind it, its "user" is the repo owner it was minted for, and
    // the `scope` in the answer is what the host enforces — one repo, no
    // pushes. Routed on the prefix so agent tokens pay nothing for this.
    if (deps.ciStatusSecret && looksLikeCiCloneToken(token)) {
      const scope = verifyCiCloneToken(deps.ciStatusSecret, token);
      if (!scope) {
        return res.status(401).json({ error: 'CI clone token is invalid or expired' });
      }
      return res.json({
        userId: scope.owner,
        agentId: 'ci',
        scope: { repo: scope.repo, readOnly: true },
      });
    }
    // The owner's own key (human-git-token.ts): a person at a laptop, not an
    // agent. Same namespace and quota as their agents' tokens — it is the
    // same person — and `agentId: 'owner'` only names the credential in the
    // host's logs. Verified against the profile hash, so revoking or
    // re-minting in the Mini App cuts it off on the next push.
    // Both people-shaped tokens answer the caller's git NAMESPACE in the
    // `userId` field (byo-git-design slice 1): the host checks that field
    // against the URL's first segment, so members of a stamped org reaching
    // the org's shared repos needs no host change at all. Quota follows the
    // namespace for the same reason — it is the namespace's bytes the push
    // is growing.
    const requestedHostOrgId = String(req.get('x-git-host-org') ?? '').trim() || null;
    // The host also names the namespace parsed from the clone URL. This is
    // essential for a person's one laptop key: unlike an agent token it is
    // not pinned to one org, and must work in several org checkouts at once.
    const requestedNamespaceId = String(req.get('x-git-namespace') ?? '').trim() || null;
    // No credential means exactly one possible authority: anonymous READ of
    // the public repository named by this host's parsed namespace and path.
    // The host still rejects receive-pack before asking, and the scope here
    // independently says read-only — two gates around the public boundary.
    if (!token) {
      const repoName = String(verifyBody.repo ?? '').trim();
      const repo = requestedNamespaceId && repoName
        ? await deps.gitRepoStorage.getByName(requestedNamespaceId, repoName)
        : null;
      if (!repo?.publicAccess) {
        return res.status(401).json({ error: 'This repository is private' });
      }
      return res.json({
        userId: requestedNamespaceId,
        agentId: 'public',
        scope: { repo: repo.name, readOnly: true },
      });
    }
    const namespaceFor = async (userId: string, agentOrgId?: string | null) => (
      deps.orgGit ? (await deps.orgGit.resolveNamespace(userId, agentOrgId ?? requestedHostOrgId)).namespaceId : userId
    );
    if (looksLikeHumanGitToken(token)) {
      const claim = parseHumanGitToken(token);
      const profile = claim ? await deps.userStorage.getProfile(claim.userId) : null;
      if (!claim || !humanGitTokenMatches(token, profile?.gitAccess?.tokenHash)) {
        return res.status(401).json({ error: 'Git key is not valid' });
      }
      let namespaceId: string | null = null;
      let namespaceOrgId: string | null = requestedHostOrgId;
      if (!requestedNamespaceId) {
        // Compatibility with hosts from before namespace-aware verification:
        // a central host has only the persistent active context. An older
        // per-org host still names its org, so prove membership before
        // returning anything — resolveNamespace deliberately falls back to a
        // personal namespace for non-members, which must not authenticate a
        // person's key to somebody else's private host.
        if (requestedHostOrgId && deps.orgGit) {
          const resolved = await deps.orgGit.resolveNamespace(claim.userId, requestedHostOrgId);
          if (resolved.orgId === requestedHostOrgId) namespaceId = resolved.namespaceId;
        } else {
          namespaceId = await namespaceFor(claim.userId);
        }
      } else if (deps.orgGit && deps.orgStorage) {
        if (requestedHostOrgId) {
          // A member's key reaches every namespace of the org — the historical
          // base and every explicit room's (note #85): humans see everything, so
          // their one laptop key pushes everywhere their org's code lives.
          const resolved = await deps.orgGit.resolveNamespace(claim.userId, requestedHostOrgId);
          if (resolved.orgId === requestedHostOrgId
            && (await deps.orgGit.namespacesForOrg(claim.userId, requestedHostOrgId)).includes(requestedNamespaceId)) {
            namespaceId = requestedNamespaceId;
          }
        } else {
          // A central host serves several org namespaces. Match the URL's
          // namespace against every membership — each org's historical base
          // and explicit rooms — without changing which org is active in the
          // Workspace.
          for (const membership of await deps.orgStorage.listMembershipsByUser(claim.userId).catch(() => [])) {
            if ((await deps.orgGit.namespacesForOrg(claim.userId, membership.orgId)).includes(requestedNamespaceId)) {
              namespaceId = requestedNamespaceId;
              namespaceOrgId = membership.orgId;
              break;
            }
          }
          // Preserve a genuinely personal pre-org namespace. A legacy org may
          // itself be stamped with this human's id, though; once they leave it,
          // the same string must not become a back door into the org's repos.
          // An old room's namespace (note #843) is claimed ground the same way.
          if (!namespaceId && requestedNamespaceId === claim.userId) {
            const claimedByOrg = Boolean(await deps.orgStorage.getOrgByNamespace(requestedNamespaceId).catch(() => null));
            if (!claimedByOrg) namespaceId = claim.userId;
          }
        }
      } else if (requestedNamespaceId === claim.userId) {
        namespaceId = claim.userId;
      }
      if (!namespaceId) {
        return res.status(403).json({ error: 'This key cannot access that workplace namespace' });
      }
      return res.json({
        userId: namespaceId,
        agentId: 'owner',
        quota: {
          repoMaxBytes: GIT_REPO_MAX_BYTES,
          // The HOST names the org it is (`x-git-host-org`), which is exactly
          // the question the ceiling turns on: which disk these bytes land on.
          userMaxBytes: await gitUserMaxBytesFor(requestedHostOrgId),
          userUsedBytes: await gitUsedBytesFor(claim.userId, namespaceOrgId, namespaceId),
        },
      });
    }
    const claim = token ? parseAgentbuiltToken(token) : null;
    if (!claim) {
      return res.status(401).json({ error: 'Malformed token' });
    }
    const profile = await deps.userStorage.getProfile(claim.userId);
    const agent = profile?.telegram?.agents?.[claim.agentId];
    if (!agent || !agentbuiltTokenMatches(token, agent.agentbuiltTokenHash)) {
      return res.status(401).json({ error: 'Token is not valid' });
    }
    const memberships = deps.orgStorage
      ? await deps.orgStorage.listMembershipsByUser(claim.userId).catch(() => [])
      : [];
    const legacyOrgId = [...memberships]
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]
      ?.orgId ?? null;
    const agentOrgId = agent.orgId ?? legacyOrgId;
    // A token belongs to the agent's immutable org, not merely to the human
    // who may also be a member of the host's org. Otherwise one user's agent
    // from A could authenticate to B's private git host using B's valid host
    // secret and acquire a namespace there.
    if (requestedHostOrgId && agentOrgId !== requestedHostOrgId) {
      return res.status(403).json({ error: 'This agent belongs to a different workplace' });
    }
    if (deps.orgStorage && agentOrgId
      && !memberships.some((membership) => membership.orgId === agentOrgId)) {
      return res.status(403).json({ error: 'This agent no longer belongs to a workplace' });
    }
    // A repository belongs to the workplace (note #566), so an agent's token
    // opens every namespace of its OWN workplace — its own and its old
    // rooms' — exactly as a member's laptop key has since note #85. The
    // namespace in a clone URL is an address, not a wall. Membership and org
    // pinning above remain the outer boundary; no token crosses a workplace.
    const namespaceId = await namespaceFor(claim.userId, agentOrgId);
    let verifiedNamespaceId = namespaceId;
    if (requestedNamespaceId && namespaceId !== requestedNamespaceId) {
      if (!agentOrgId
        || !deps.orgGit
        || !(await deps.orgGit.namespacesForOrg(claim.userId, agentOrgId)).includes(requestedNamespaceId)) {
        return res.status(403).json({ error: 'This agent belongs to a different workplace namespace' });
      }
      verifiedNamespaceId = requestedNamespaceId;
    }
    // The event turn's fence reaches git too (note #716): while the Workspace
    // Agent runs a turn nobody asked for, its token reads and never pushes.
    // The host caches a positive answer for a minute, so the edge is soft by
    // that much in both directions.
    const fenced = Boolean(agent.purpose === 'workspace-recap' && agentOrgId
      && await deps.workspaceAgent?.isEventTurn?.(claim.userId, agentOrgId).catch(() => true));
    return res.json({
      userId: verifiedNamespaceId,
      agentId: claim.agentId,
      ...(fenced ? { scope: { readOnly: true } } : {}),
      quota: {
        repoMaxBytes: GIT_REPO_MAX_BYTES,
        userMaxBytes: await gitUserMaxBytesFor(requestedHostOrgId ?? agentOrgId),
        userUsedBytes: await gitUsedBytesFor(claim.userId, agentOrgId, verifiedNamespaceId),
      },
    });
  });

  /**
   * The host reports a completed push: size, default branch, timestamp. Same
   * host secret. Unknown repos are accepted silently — a repo created by an
   * operator directly on disk has no record, and refusing here would turn
   * that into a failed push.
   */
  router.post('/git/pushed', async (req, res) => {
    if (!deps.gitHostSecret || !deps.gitRepoStorage) {
      return res.status(503).json({ error: 'Internal git hosting is not configured' });
    }
    if (!(await gitHostCallerOk(req))) {
      return res.status(401).json({ error: 'Bad host secret' });
    }
    const body = (req.body ?? {}) as {
      userId?: unknown; name?: unknown; sizeBytes?: unknown; defaultBranch?: unknown;
      defaultBranchTip?: unknown;
    };
    const doc = await deps.gitRepoStorage.getByName(String(body.userId ?? ''), String(body.name ?? ''));
    if (!doc) {
      return res.json({ ok: true, recorded: false });
    }
    const now = new Date().toISOString();
    // "Landed on the default branch" is stamped only on an observed FACT: the
    // reported tip differs from the one we recorded last time, or this is the
    // repo's very first push (which is what created the branch). A repo from
    // before tips were reported gets its sha recorded without a stamp — the
    // branch may not have moved in months, and a false "pushed to main just
    // now" is exactly what this field exists to never say.
    const tip = typeof body.defaultBranchTip === 'string' && body.defaultBranchTip
      ? body.defaultBranchTip
      : null;
    const landed = tip !== null
      && (doc.defaultBranchTipSha ? doc.defaultBranchTipSha !== tip : !doc.lastPushAt);
    await deps.gitRepoStorage.update(doc.id, {
      sizeBytes: Number(body.sizeBytes ?? doc.sizeBytes) || 0,
      lastPushAt: now,
      ...(typeof body.defaultBranch === 'string' && body.defaultBranch
        ? { defaultBranch: body.defaultBranch }
        : {}),
      ...(tip ? { defaultBranchTipSha: tip } : {}),
      ...(landed ? { defaultBranchPushAt: now } : {}),
    });
    // Who has written this repository, refreshed while we are here — this is
    // the only moment the platform learns that anything changed, and doing it
    // on READ instead would put a git walk of the whole history in front of
    // every load of the workspace home.
    //
    // Incremental: the host gets the sha we last counted to and answers with
    // what landed after it, so the usual push costs a log over a few commits.
    // Failures are swallowed on purpose — a stale contributor list is worth
    // nothing next to a push report that got lost because counting broke.
    if (deps.gitHostClient) {
      try {
        const counted = await (await gitHostFor(doc.orgId)).contributors(doc.userId, doc.name, doc.contributors?.sha);
        const contributors = nextContributors(doc.contributors, counted, new Date().toISOString());
        if (contributors) await deps.gitRepoStorage.update(doc.id, { contributors });
      } catch {
        // The next push counts again, from wherever this one left the sha.
      }
    }

    // An open proposal FOLLOWS its branch: re-pin head, base and the stats so
    // the checks pip, `pr show` and the merge anchor all describe what is on
    // the branch NOW rather than what was there at `pr create`. The report
    // does not say which refs moved, so every open proposal on the repo gets
    // one compare — open proposals per repo are few, and the compare is a
    // local git call on the host. Per-proposal failures are skipped: a branch
    // deleted mid-life is the decision path's answer to give, not this
    // report's to guess at.
    if (deps.gitPullRequestStorage && deps.gitHostClient) {
      const open = (await deps.gitPullRequestStorage.listByRepo(doc.id))
        .filter((pr) => pr.status === 'open');
      for (const pr of open) {
        try {
          const moved = await (await gitHostFor(doc.orgId)).compare(doc.userId, doc.name, pr.targetBranch, pr.sourceBranch);
          // The sha guard matters: writing a malformed answer over the pin
          // would un-anchor the merge, which is worse than a stale pin.
          if (!moved.headSha || moved.headSha === pr.headSha) continue;
          await deps.gitPullRequestStorage.update(pr.id, {
            headSha: moved.headSha,
            ...(moved.baseSha ? { baseSha: moved.baseSha } : {}),
            diffStat: moved.diffStat,
            commitSubjects: moved.commits.slice(0, 10).map((commit) => commit.subject),
            refreshedAt: new Date().toISOString(),
          });
        } catch {
          // Branch gone, host busy: the proposal keeps its last good pin.
        }
      }
    }
    return res.json({ ok: true, recorded: true });
  });

  /**
   * A CI runner files a commit status (docs/ci-status-miniapp.md). Its own
   * secret, not the git host's: the webhook secret VERIFIES deliveries and is
   * held by the git host too; this one WRITES, and a smaller blast radius
   * costs one extra env line. Unknown repos are accepted and dropped, same
   * reasoning as /git/pushed — a status that cannot be filed must never fail
   * a build. `owner` is the repo owner's userId, which is what the git host's
   * post-receive webhook already carries as `repository.owner`.
   */
  router.post('/git/statuses', async (req, res) => {
    if (!deps.ciStatusSecret || !deps.gitCommitStatusStorage || !deps.gitRepoStorage) {
      return res.status(503).json({ error: 'CI status ingest is not configured' });
    }
    const presented = Buffer.from(String(req.get('x-ci-status-secret') ?? ''), 'utf8');
    const expected = Buffer.from(deps.ciStatusSecret, 'utf8');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return res.status(401).json({ error: 'Bad status secret' });
    }
    const body = (req.body ?? {}) as {
      owner?: unknown; repo?: unknown; sha?: unknown; context?: unknown;
      state?: unknown; description?: unknown; logTailB64?: unknown;
      machineGuest?: unknown;
    };
    const sha = String(body.sha ?? '');
    const context = String(body.context ?? '');
    const state = String(body.state ?? '');
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return res.status(400).json({ error: 'sha must be 40 hex chars' });
    }
    if (validateStatusContext(context)) {
      return res.status(400).json({ error: validateStatusContext(context) });
    }
    if (!GIT_COMMIT_STATUS_STATES.has(state)) {
      return res.status(400).json({ error: `state must be one of: ${[...GIT_COMMIT_STATUS_STATES].join(', ')}` });
    }
    const repo = await deps.gitRepoStorage.getByName(String(body.owner ?? ''), String(body.repo ?? ''));
    if (!repo) {
      return res.json({ ok: true, recorded: false });
    }
    const existing = await deps.gitCommitStatusStorage.get(repo.id, sha, context);
    const now = new Date().toISOString();
    const terminal = state !== 'pending';
    const logTail = typeof body.logTailB64 === 'string' && body.logTailB64
      ? Buffer.from(body.logTailB64, 'base64')
        .subarray(0, GIT_COMMIT_STATUS_LOG_TAIL_MAX_BYTES)
        .toString('utf8')
      : undefined;
    // The job machine's shape, in Fly's own field names as the daemon holds
    // it. Kept on the pending AND re-sent with the verdict, so a run whose
    // pending was lost to a restart still prices. An absent or malformed
    // shape drops silently: the verdict matters more than its price tag.
    const machine = parseStatusMachineGuest(body.machineGuest) ?? existing?.machine;
    await deps.gitCommitStatusStorage.upsert({
      userId: repo.userId,
      repoId: repo.id,
      sha,
      context,
      state: state as GitCommitStatusState,
      description: String(body.description ?? '').slice(0, 140),
      ...(machine ? { machine } : {}),
      // A terminal status keeps its OWN pending's start time so elapsed reads
      // true; a terminal with no prior pending stamps both sides now.
      //
      // It must inherit from a `pending` and nothing else. Statuses are keyed
      // (repo, sha, context), so a sha built twice — a branch push, then the
      // same sha fast-forwarded onto main — writes one document twice. Letting
      // the second run's PENDING inherit the first run's start time made it
      // arrive already older than GIT_COMMIT_STATUS_STALE_PENDING_MS, so
      // effectiveStatusState read the brand-new pending as `error`: a red pip
      // and a merge gate refusing an approval with "checks are failing", for a
      // build that was running normally and about to pass.
      startedAt: existing?.state === 'pending' && existing.startedAt ? existing.startedAt : now,
      ...(terminal ? { completedAt: now } : {}),
      ...(logTail ? { logTail } : {}),
    });
    // A check going red is an event for the Chief of Staff of whoever's
    // proposal it is (note #716): the sweep looks now, not at its next tick.
    if ((state === 'failure' || state === 'error') && existing?.state !== state) deps.workspaceAgentEvents?.nudgeOrg(repo.orgId);
    return res.json({ ok: true, recorded: true });
  });

  /**
   * A nightly backup job reporting that it ran (infra/db-backup,
   * infra/git-host/backup-repos.sh). The backend watches the gaps between
   * these and complains when one gets too wide — see services/backup-monitor.
   *
   * Always answers 2xx once authenticated, even on a malformed body: the
   * caller is a bash script that fires this and moves on, and a backup must
   * never fail because the thing watching it was fussy about JSON.
   */
  router.post('/ops/backup-heartbeat', async (req, res) => {
    if (!deps.backupHeartbeatSecret || !deps.recordBackupHeartbeat) {
      return res.status(503).json({ error: 'Backup monitoring is not configured' });
    }
    const presented = Buffer.from(String(req.get('x-backup-heartbeat-secret') ?? ''), 'utf8');
    const expected = Buffer.from(deps.backupHeartbeatSecret, 'utf8');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return res.status(401).json({ error: 'Bad heartbeat secret' });
    }
    const body = (req.body ?? {}) as { job?: unknown; status?: unknown; detail?: unknown };
    const job = String(body.job ?? '').trim();
    // Job ids are ours, not user input, but they become a map key and appear
    // in an alert — so keep them boring.
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(job)) {
      return res.status(400).json({ error: 'job must be a short lowercase id' });
    }
    const status = body.status === 'fail' ? 'fail' : 'ok';
    const detail = typeof body.detail === 'string' ? body.detail.slice(0, 500) : undefined;
    deps.recordBackupHeartbeat(job, status, detail);
    return res.json({ ok: true, job, status });
  });

  /**
   * The CI dispatcher asks for a clone token before boarding a job machine
   * (docs/ci-two-lane-runner.md → Credentials). Same caller and same secret
   * as the status ingest: holding it already means "trusted CI runner", and
   * the minted token is strictly weaker than the secret that minted it —
   * one repo, read-only, expired within the hour.
   */
  router.post('/git/ci-clone-token', async (req, res) => {
    if (!deps.ciStatusSecret || !deps.gitRepoStorage) {
      return res.status(503).json({ error: 'CI clone tokens are not configured' });
    }
    const presented = Buffer.from(String(req.get('x-ci-status-secret') ?? ''), 'utf8');
    const expected = Buffer.from(deps.ciStatusSecret, 'utf8');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return res.status(401).json({ error: 'Bad status secret' });
    }
    const body = (req.body ?? {}) as { owner?: unknown; repo?: unknown; ttlSeconds?: unknown };
    const owner = String(body.owner ?? '');
    const name = String(body.repo ?? '');
    const doc = await deps.gitRepoStorage.getByName(owner, name);
    if (!doc) {
      // Unlike the ingest routes, refusing is right here: a token for a repo
      // we do not host clones nothing, and the daemon deserves to hear that
      // before it pays for a machine.
      return res.status(404).json({ error: 'No such repo' });
    }
    const ttlSeconds = Number(body.ttlSeconds);
    const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? ttlSeconds * 1000
      : CI_CLONE_TOKEN_DEFAULT_TTL_MS;
    return res.json(mintCiCloneToken(deps.ciStatusSecret, owner, name, ttlMs));
  });

  /**
   * The CI dispatcher asks which secrets ride a platform job before boarding
   * the machine (docs/ci-two-lane-runner.md phase 3). Same caller and same
   * secret as the clone-token mint — and one of only three places plaintext
   * leaves the backend, so the rule is enforced HERE, not trusted to the
   * caller: values flow only for a ref the git host says is protected, and
   * only names the owner's own tap put on the repo's `ciSecrets` list. Every
   * other case answers `{}` — a job that gets no secrets still runs, it just
   * cannot deploy, and its own log says which variable was missing.
   */
  router.post('/git/ci-secrets', async (req, res) => {
    if (!deps.ciStatusSecret || !deps.gitRepoStorage || !deps.gitHostClient || !deps.secretStorage) {
      return res.status(503).json({ error: 'CI secrets are not configured' });
    }
    const presented = Buffer.from(String(req.get('x-ci-status-secret') ?? ''), 'utf8');
    const expected = Buffer.from(deps.ciStatusSecret, 'utf8');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return res.status(401).json({ error: 'Bad status secret' });
    }
    const body = (req.body ?? {}) as { owner?: unknown; repo?: unknown; ref?: unknown; sha?: unknown };
    const owner = String(body.owner ?? '');
    const name = String(body.repo ?? '');
    const ref = String(body.ref ?? '');
    const sha = String(body.sha ?? '');
    const doc = await deps.gitRepoStorage.getByName(owner, name);
    if (!doc) {
      return res.status(404).json({ error: 'No such repo' });
    }
    const granted = doc.ciSecrets ?? [];
    // A publish key needs the commit it publishes (a runner from before this
    // field sends none, and so publishes nothing) and the public address the
    // job's CLI will call.
    const publishes = Boolean(doc.publishTo && deps.agentbuiltApiUrl && /^[0-9a-f]{40}$/.test(sha));
    if ((granted.length === 0 && !publishes) || !ref) {
      return res.json({ secrets: {} });
    }
    // Protection is the host's fact, asked fresh per job — a stale copy here
    // would keep paying secrets into a branch someone just unprotected. No
    // answer means no secrets: this fails closed.
    let protectedBranches: string[];
    try {
      protectedBranches = (await (await gitHostFor(doc.orgId)).statRepo(owner, name)).protectedBranches ?? [];
    } catch {
      return res.status(502).json({ error: 'Could not confirm branch protection with the git host' });
    }
    if (!protectedBranches.includes(ref)) {
      return res.json({ secrets: {} });
    }
    // The grant names the namespace it was asked from. Secrets are the
    // workplace's (note #783; the store maps the namespace) — the same set
    // `ci-secrets` validated the names against, so what was granted and what
    // the job receives are one list.
    const secrets: Record<string, string> = {};
    if (granted.length > 0) {
      const env = await new UserSecretsService(deps.secretStorage)
        .getSecretEnv(repoCiSecretsNamespaceId(doc), undefined, { ownerIsAdmin: true });
      for (const key of granted) {
        if (env[key] !== undefined && !/^CI_/i.test(key)) secrets[key] = env[key];
      }
    }
    // Publishing on approval (`repo publish`): a key for this ONE job, this
    // site and this commit, dead within the hour. The runner hands it only to
    // the publish step after ci.sh passes; `/deploy` re-checks the link when
    // it is used. The site's CURRENT name, because a rename keeps the link.
    const site = publishes ? await deps.deploymentStorage?.get(doc.publishTo!.siteId).catch(() => null) : null;
    if (!publishes || !site || site.status === 'destroyed') {
      return res.json({ secrets });
    }
    const minted = mintCiDeployToken(deps.ciStatusSecret, { repoId: doc.id, siteId: site.id, sha });
    return res.json({
      secrets,
      publish: { site: site.name, token: minted.token, apiUrl: deps.agentbuiltApiUrl, expiresAt: minted.expiresAt },
    });
  });

  /**
   * A push on an org git host (byo-git slice 5). The hook signs the raw body
   * with the org's own host secret; the payload's owner IS the org, so it
   * names which secret the signature must match — verified inside the
   * service, where the org lookup lives.
   */
  router.post('/git/ci-webhook', raw({ type: () => true, limit: 256 * 1024 }), async (req, res) => {
    if (!deps.orgCi) {
      return res.status(503).json({ error: 'Org CI is not configured on this backend' });
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let payload: { repository?: { owner?: string } };
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'bad json' });
    }
    const owner = String(payload.repository?.owner ?? '');
    if (!owner || !(await deps.orgCi.verifyWebhook(rawBody, req.get('x-agentgit-signature-256'), owner))) {
      return res.status(401).json({ error: 'bad signature' });
    }
    const outcome = await deps.orgCi.handlePush(payload as never);
    return res.json({ ok: true, ...outcome });
  });

  /** A client-org CI machine's one report, signed with its per-job token. */
  router.post('/git/ci-result', raw({ type: () => true, limit: 256 * 1024 }), async (req, res) => {
    if (!deps.orgCi) {
      return res.status(503).json({ error: 'Org CI is not configured on this backend' });
    }
    const outcome = await deps.orgCi.handleResult(
      Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      req.get('x-ia-job-signature'),
    );
    if (!outcome.ok) return res.status(401).json({ error: outcome.error });
    return res.json({ ok: true });
  });

  /**
   * User secrets (docs/user-secrets.md) from the machine itself.
   *
   * A write defaults to SHARED — every agent in this workplace. The key an agent
   * is handed is almost always a general-purpose credential (a GitHub token,
   * an API key) the user would have to paste again for every other agent if it
   * were saved private; "this agent uses its own key" is the exception, so it
   * is the flag (`agentOnly`), not the default. The legacy `shared` flag is
   * still accepted and now names what happens anyway.
   *
   * No route here returns plaintext. That is not a barrier — in-scope values
   * are already in the machine's environment — but a value returned over HTTP
   * lands in the agent's own transcript, which is the exact durability problem
   * the Telegram handler deletes messages to avoid. `list` is for "what is
   * configured?"; `printenv` is for "what is the value?".
   */
  // ── Object storage (note #768) ──
  //
  // `agentbuilt storage create <name>` mints one Tigris bucket for the
  // workplace and saves its endpoint, bucket name and keys as FOUR workplace
  // secrets, so they reach the agent's next turn as env vars and any site via
  // `deploy --secret`. The reply names the secrets and never a value. Creating
  // infrastructure is a workplace admin's agent's act, like a first deploy;
  // listing and showing are every agent's; deleting only ASKS the owner.
  const requireObjectStorage = (res: Response) => {
    if (!deps.objectStorage) {
      res.status(503).json({ error: 'Object storage is not available on this backend yet' });
      return null;
    }
    return deps.objectStorage;
  };

  const describeBucket = (doc: StorageBucketDocument) => ({
    name: doc.name,
    public: doc.public,
    bucket: doc.bucket,
    endpoint: doc.endpoint,
    hostedOn: doc.hostedOn,
    secrets: doc.secretNames,
    createdAt: doc.createdAt,
    createdBy: doc.createdBy.agentName ?? undefined,
    ...(doc.deleteAsk ? { deleteAsk: { at: doc.deleteAsk.at } } : {}),
  });

  router.post('/storage', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const objectStorage = requireObjectStorage(res);
    if (!objectStorage) return;
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Creating a bucket is a workplace admin action — ask your user, or an admin\'s agent, to create it.' });
    }
    const body = (req.body ?? {}) as { name?: unknown; public?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return res.status(400).json({ error: 'Send { name } — the bucket\'s name, lowercase letters, digits and hyphens.' });
    }
    if (body.public !== undefined && typeof body.public !== 'boolean') {
      return res.status(400).json({ error: '`public` is true or false.' });
    }
    const ns = await gitNamespace(auth);
    try {
      const doc = await objectStorage.create({
        orgId: auth.orgId,
        userId: auth.userId,
        secretsNamespaceId: ns.namespaceId,
        agentId: auth.agentId,
        ...(auth.agents[auth.agentId]?.name ? { agentName: auth.agents[auth.agentId]!.name! } : {}),
        name: body.name.trim().toLowerCase(),
        public: body.public === true,
      });
      const caps = objectStorage.caps;
      const names = doc.secretNames;
      return res.status(201).json({
        bucket: describeBucket(doc),
        caps: doc.hostedOn === 'platform' ? caps : null,
        message: `Created the ${doc.public ? 'PUBLIC' : 'private'} bucket "${doc.name}" (S3 bucket ${doc.bucket}). `
          + `Its endpoint, bucket name and keys are saved as the workplace secrets ${names.endpoint}, ${names.bucket}, ${names.accessKeyId} and ${names.secretAccessKey}: `
          + 'they are exported into your NEXT turn as environment variables (not this one), and a site gets them with `agentbuilt deploy ... --secret NAME` for each. '
          + (doc.public
            ? `Anyone with an object's URL can read it (https://${doc.bucket}.${doc.endpoint.replace(/^https?:\/\//, '')}/<key>), and a page on any site can fetch() it — its CORS rule (every origin, GET and HEAD) was set at creation and reaches every edge within minutes; writing still needs the keys. `
            : 'It is private: every read and write needs the keys. ')
          + (doc.hostedOn === 'platform'
            ? `Hosted on the platform's cloud: at most ${caps.hostedBucketLimit} buckets per workplace, about ${caps.hostedBucketGb} GB each. `
            : 'It lives in the workplace\'s own cloud account. ')
          + 'Say the secret names in your reply, never a value. `agentbuilt storage delete <name>` only asks your user.',
      });
    } catch (error) {
      if (error instanceof ObjectStorageError) return res.status(error.status).json({ error: error.message });
      console.error('[storage] create failed:', error);
      return res.status(502).json({ error: `The bucket could not be created: ${(error as Error).message}` });
    }
  });

  router.get('/storage', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const objectStorage = requireObjectStorage(res);
    if (!objectStorage) return;
    const docs = await objectStorage.list({ orgId: auth.orgId, userId: auth.userId });
    const hosted = docs.some((doc) => doc.hostedOn === 'platform') || docs.length === 0;
    return res.json({
      buckets: docs.map(describeBucket),
      ...(hosted ? { caps: objectStorage.caps } : {}),
    });
  });

  router.get('/storage/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const objectStorage = requireObjectStorage(res);
    if (!objectStorage) return;
    const doc = await objectStorage.getLive({ orgId: auth.orgId, userId: auth.userId }, String(req.params.name ?? ''));
    if (!doc) return res.status(404).json({ error: `No bucket named "${req.params.name}" in this workplace.` });
    // Read with the bucket's own keys; a walk that stops early says so.
    const usage = await objectStorage.usage(doc).catch(() => null);
    return res.json({
      bucket: describeBucket(doc),
      ...(usage ? { usage } : {}),
      ...(doc.hostedOn === 'platform' ? { caps: objectStorage.caps } : {}),
    });
  });

  /**
   * Re-apply a public bucket's CORS rule (note #770): for a bucket made
   * before creation set one, or whose rule was replaced. Any agent of the
   * workplace, the same trust as a redeploy.
   */
  router.post('/storage/:name/cors', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const objectStorage = requireObjectStorage(res);
    if (!objectStorage) return;
    const doc = await objectStorage.getLive({ orgId: auth.orgId, userId: auth.userId }, String(req.params.name ?? ''));
    if (!doc) return res.status(404).json({ error: `No bucket named "${req.params.name}" in this workplace.` });
    try {
      await objectStorage.ensurePublicCors(doc);
    } catch (error) {
      if (error instanceof ObjectStorageError) return res.status(error.status).json({ error: error.message });
      return res.status(502).json({ error: `The rule could not be set: ${(error as Error).message}` });
    }
    return res.json({
      ok: true,
      name: doc.name,
      message: `The public CORS rule is set on "${doc.name}" (every origin, GET and HEAD, the usual headers). It reaches every edge within a few minutes; a page's fetch() of ${doc.bucket} works from then on.`,
    });
  });

  /**
   * Asking for a bucket to go — and, exactly as with sites and repositories,
   * ASKING IS ALL AN AGENT CAN DO. The owner empties and removes it on the
   * Workspace, where the screen can show what is at stake.
   */
  router.post('/storage/:name/delete', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const objectStorage = requireObjectStorage(res);
    if (!objectStorage) return;
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Taking down shared infrastructure is a workplace admin action.' });
    }
    const doc = await objectStorage.getLive({ orgId: auth.orgId, userId: auth.userId }, String(req.params.name ?? ''));
    if (!doc) return res.status(404).json({ error: `No bucket named "${req.params.name}" in this workplace.` });
    await objectStorage.askDelete(doc.id, { agentId: auth.agentId, userId: auth.userId });
    return res.status(202).json({
      pending: true,
      message: `Asked. "${doc.name}" is now flagged for deletion in your user's Workspace (Home → Storage) — they empty and remove it there, and its four secrets go with it.`
        + ' Nothing notifies them, so TELL THEM in your reply. Do not wait for it: end your turn, and you are messaged when they decide.',
    });
  });

  const requireSecrets = (res: Response) => {
    if (!deps.secretStorage) {
      res.status(503).json({ error: 'Secrets are not available on this backend yet' });
      return null;
    }
    return new UserSecretsService(deps.secretStorage);
  };

  // The agent's room namespace, which the secret store maps to the
  // WORKPLACE's one set (note #783, Adam: "secrets should not be per room, it
  // should be global per workplace, like repositories" — reversing note #88).
  // Every room reads and writes the same keys; a key may be limited to some
  // rooms, and the room named here is what that limit is checked against.
  const secretsOwner = async (auth: AgentAuth): Promise<string> => (
    (await gitNamespace(auth)).namespaceId
  );

  /** `agentOnly` in the body or query means this agent alone, else every agent in its workplace. */
  const scopeFrom = (auth: AgentAuth, agentOnlyFlag: unknown): UserSecretScope => (
    agentOnlyFlag === true || agentOnlyFlag === 'true' || agentOnlyFlag === '1'
      ? agentUserSecretScope(auth.agentId)
      : SHARED_USER_SECRET_SCOPE
  );

  router.get('/secrets', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const secrets = requireSecrets(res);
    if (!secrets) return;
    // Narrowed to this agent: its own secrets plus the shared ones, which is
    // the set its turns get. Another agent's private keys are not listed,
    // because they are not this machine's business.
    const rows = await secrets.listSecrets(await secretsOwner(auth), auth.agentId);
    return res.json({
      secrets: rows.map((row) => ({
        name: row.name,
        maskedValue: row.maskedValue,
        ...(row.description ? { description: row.description } : {}),
        scope: row.scope.kind === 'shared' ? 'shared' : 'agent',
        ...(row.audience ? { audience: row.audience } : {}),
        ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
        ...(row.shadowedByAgentScope ? { shadowedByAgentScope: true } : {}),
      })),
    });
  });

  router.post('/secrets', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const secrets = requireSecrets(res);
    if (!secrets) return;
    const body = (req.body ?? {}) as { name?: unknown; value?: unknown; description?: unknown; agentOnly?: unknown; audience?: unknown };
    if (typeof body.name !== 'string' || typeof body.value !== 'string') {
      return res.status(400).json({ error: 'Send { name, value } — both strings.' });
    }
    if (body.description !== undefined && typeof body.description !== 'string') {
      return res.status(400).json({ error: 'description must be a string.' });
    }
    // Optional at THIS layer only because CLIs from before descriptions
    // existed still call it — the current CLI refuses to create without one.
    const scope = scopeFrom(auth, body.agentOnly);
    if (auth.orgId && auth.orgRole !== 'admin' && scope.kind === 'shared') {
      return res.status(403).json({
        error: 'Only a workplace admin can add or replace shared secrets. Use --this-agent for a private agent secret.',
      });
    }
    let audience: UserSecretAudience | undefined;
    if (body.audience !== undefined) {
      if (scope.kind !== 'shared') {
        return res.status(400).json({ error: 'A private secret reaches this agent alone — --members and --admins-only apply to shared secrets.' });
      }
      const audienceResult = validateUserSecretAudience(body.audience);
      if (!audienceResult.ok) return res.status(400).json({ error: audienceResult.reason });
      audience = audienceResult.audience;
    }
    const result = await secrets.setSecret(await secretsOwner(auth), body.name, body.value, scope, body.description, audience);
    if (!result.ok) {
      // The service's refusal text is written for a human, so it is passed
      // through verbatim rather than restated in HTTP terms.
      return res.status(400).json({ error: result.reason });
    }
    return res.json({
      ok: true,
      created: result.created,
      name: result.name,
      scope: scope.kind === 'shared' ? 'shared' : 'agent',
      // The new value reaches turns at the NEXT one — this turn's environment
      // was fixed when its launch script was written.
      message: `${result.created ? 'Saved' : 'Rotated'} ${result.name} for ${
        scope.kind === 'shared'
          ? (auth.orgId
            ? (result.created ? describeUserSecretAudience(audience ?? 'admins') : 'the workplace')
            : 'all your user\'s agents')
          : 'this agent only'
      }. It is exported into your NEXT turn, not this one.${
        scope.kind === 'shared' && auth.orgId && result.created && (audience ?? 'admins') === 'admins'
          ? ' Members\' agents do not receive it; `agentbuilt secret share NAME --members` opens it to every agent in the workplace.'
          : ''
      }`,
    });
  });

  /**
   * Description only — the value is untouched, and `updatedAt` stays put so
   * "last changed" keeps meaning the key material. For annotating a secret
   * that predates descriptions, or correcting one whose purpose shifted.
   */
  router.patch('/secrets/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const secrets = requireSecrets(res);
    if (!secrets) return;
    const body = (req.body ?? {}) as { description?: unknown; agentOnly?: unknown; audience?: unknown; rooms?: unknown };
    // Rooms only (`agentbuilt secret rooms`, note #783) — gone with rooms
    // (note #843): every key is the whole workplace's. An older CLI that still
    // sends it is told so.
    if (body.rooms !== undefined) {
      return res.status(410).json({ error: SECRET_ROOMS_GONE });
    }
    // Audience only (`agentbuilt secret share`, note #655): whose agents a
    // SHARED secret reaches. Admin-owned agents only, like every shared write.
    if (body.audience !== undefined) {
      if (auth.orgId && auth.orgRole !== 'admin') {
        return res.status(403).json({ error: 'Only a workplace admin\'s agent can choose whose agents a shared secret reaches.' });
      }
      const name = String(req.params.name ?? '');
      const result = await secrets.setSecretAudience(await secretsOwner(auth), name, body.audience);
      if (!result.ok) {
        return res.status(result.notFound ? 404 : 400).json({ error: result.reason });
      }
      return res.json({
        ok: true,
        name: result.name,
        audience: result.audience,
        message: `${result.name} now reaches ${describeUserSecretAudience(result.audience)}, from each agent's next turn.`,
      });
    }
    if (typeof body.description !== 'string') {
      return res.status(400).json({ error: 'Send { description } — a short sentence on what this secret is for.' });
    }
    const scope = scopeFrom(auth, body.agentOnly);
    if (auth.orgId && auth.orgRole !== 'admin' && scope.kind === 'shared') {
      return res.status(403).json({
        error: 'Only a workplace admin can describe shared secrets. Use --this-agent for a private agent secret.',
      });
    }
    const name = String(req.params.name ?? '');
    const result = await secrets.describeSecret(await secretsOwner(auth), name, body.description, scope);
    if (!result.ok) {
      if (result.notFound) {
        // Scope-specific like delete: describing a shared key must never
        // silently annotate an agent's private copy, or vice versa.
        return res.status(404).json({
          error: scope.kind === 'shared'
            ? `No shared secret named "${name}". If it is private to this agent, describe it with --this-agent.`
            : `No secret named "${name}" private to this agent. If it is shared, describe it without --this-agent.`,
        });
      }
      return res.status(400).json({ error: result.reason });
    }
    return res.json({
      ok: true,
      name: result.name,
      scope: scope.kind === 'shared' ? 'shared' : 'agent',
      message: `Updated the description of ${result.name}.`,
    });
  });

  router.delete('/secrets/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const secrets = requireSecrets(res);
    if (!secrets) return;
    const scope = scopeFrom(auth, (req.query as Record<string, unknown>).agentOnly);
    if (auth.orgId && auth.orgRole !== 'admin' && scope.kind === 'shared') {
      return res.status(403).json({
        error: 'Only a workplace admin can delete shared secrets. Use --this-agent for a private agent secret.',
      });
    }
    const name = String(req.params.name ?? '');
    const deleted = await secrets.deleteSecret(await secretsOwner(auth), name, scope);
    if (!deleted) {
      // Scope-specific on purpose: deleting a shared key must never silently
      // fall through to an agent's private copy of the same name, or vice
      // versa.
      return res.status(404).json({
        error: scope.kind === 'shared'
          ? `No shared secret named "${name}". If it is private to this agent, delete it with --this-agent.`
          : `No secret named "${name}" private to this agent. If it is shared by the workplace, delete it without --this-agent.`,
      });
    }
    return res.json({
      ok: true,
      name,
      scope: scope.kind === 'shared' ? 'shared' : 'agent',
    });
  });

  /**
   * Retired 2026-08-25 (agent-row-recap-design): the row's recap is written
   * by a post-turn summarizer, and nothing the agent sends here is stored.
   *
   * Quiet no-ops rather than 410s, for a version or two: machines that have
   * not taken a turn since the bump still carry a CLI that calls these, and
   * an agent mid-task must learn the change from the message, not from a
   * command that suddenly errors. `message` is what every fielded CLI prints.
   */
  const RETIRED_ROW_LINE_MESSAGE = 'Retired: your row\'s recap is written for you after every turn now — nothing was stored.';
  router.put('/about', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    return res.json({ ok: true, about: null, retired: true, message: RETIRED_ROW_LINE_MESSAGE });
  });

  /**
   * The agent's own "new chat" (`agentbuilt chat new`) — since 2026-08-16 the
   * ONLY way a conversation resets: the button left the chat keyboard, and
   * when to start fresh became the agent's call. Nothing is cleared in this
   * handler; the service applies the reset when the calling turn ends, then
   * delivers the handoff as the fresh conversation's first message. Repeat
   * calls before the turn ends replace the handoff — last call wins, same as
   * `task`.
   */
  router.post('/chat/new', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.requestChatReset) {
      return res.status(503).json({ error: 'Fresh chats are not available on this backend' });
    }
    const body = (req.body ?? {}) as { handoff?: unknown };
    if (body.handoff !== undefined && typeof body.handoff !== 'string') {
      return res.status(400).json({ error: 'Send { handoff } as a string — the first message of the fresh chat.' });
    }
    const handoff = typeof body.handoff === 'string' ? body.handoff.trim() : '';
    // The Workspace Agent's conversation is the platform's, not a harness
    // session (note #429): the reset is recorded on it and applied when the
    // running request ends. No handoff — every request of that agent already
    // starts from the Home briefing, so there is nothing a handoff would
    // carry that the next request does not read anyway.
    if (auth.purpose) {
      if (!deps.workspaceAgent || !auth.orgId) return res.status(503).json({ error: 'Fresh chats are not available on this backend' });
      if (handoff) return res.status(400).json({ error: 'Workspace Agent starts a fresh chat without a handoff: every request of yours begins from the Home briefing. Run `agentbuilt chat new` alone.' });
      const reset = await deps.workspaceAgent.resetConversation(auth.userId, auth.orgId);
      if (!reset.ok) return res.status(409).json({ error: reset.reason });
      return res.json({ ok: true, message: 'Scheduled: this conversation resets right after this reply goes out — the person sees a divider, and your next request starts from the briefing alone. Tell them in your reply, in one plain sentence.' });
    }
    if (handoff.length > CHAT_HANDOFF_MAX_LENGTH) {
      return res.status(400).json({
        error: `That handoff is ${handoff.length} characters — keep it under ${CHAT_HANDOFF_MAX_LENGTH}. Put the detail in ~/SCRATCHPAD.md and hand yourself the pointer.`,
      });
    }
    const result = await deps.requestChatReset({
      userId: auth.userId,
      agentId: auth.agentId,
      ...(handoff ? { handoff } : {}),
    });
    if (!result.ok) return res.status(409).json({ error: result.reason });
    return res.json({
      ok: true,
      message: handoff
        ? 'Scheduled: this conversation resets right after this turn ends, and your handoff arrives as the first message of the fresh chat. Tell your user in your reply, in one plain sentence.'
        : 'Scheduled: this conversation resets right after this turn ends. No handoff — the fresh chat waits for your user\'s next message. Tell your user in your reply, in one plain sentence.',
    });
  });

  /** Live room-grouped roster for choosing an actually-idle recipient. */
  router.get('/agents', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const listPeers = deps.agentLifecycle?.listPeers;
    if (!listPeers) return res.status(503).json({ error: 'Agent-to-agent messaging is not available on this backend' });
    return res.json(await listPeers(auth.userId, auth.agentId));
  });

  /**
   * Note #466: only the Workspace Agent may read this tiny owner-visible
   * window. A room agent is refused before name resolution, so it cannot use
   * known ids to probe another conversation.
   */
  router.get('/agents/history', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.purpose) {
      return res.status(403).json({ error: 'Reading another agent\'s recent conversation is the Workspace Agent\'s verb alone: no other agent can read another agent\'s chat.' });
    }
    if (!deps.workspaceAgent || !auth.orgId) {
      return res.status(503).json({ error: 'The Workspace Agent conversation is not available on this backend.' });
    }
    const requested = typeof req.query.agent === 'string' ? req.query.agent.trim() : '';
    if (!requested) {
      return res.status(400).json({ error: 'Name an agent: `agentbuilt agent history "<name-or-id>" [--limit 1-4]`.' });
    }
    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined ? 4 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 4) {
      return res.status(400).json({ error: '`--limit` must be a whole number from 1 to 4.' });
    }
    const result = await deps.workspaceAgent.agentHistory({ userId: auth.userId, orgId: auth.orgId, agent: requested, limit });
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : result.code === 'not_own' ? 403 : result.code === 'ambiguous' ? 400 : 503;
      return res.status(status).json({ error: result.reason, code: result.code });
    }
    return res.json(result);
  });

  // Peer sends are idle-only (note #361). Pending/cancel remain readable for
  // older clients; the send path cannot enqueue new work.
  router.get('/agents/messages/pending', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const listPending = deps.agentLifecycle?.listPendingPeerMessages;
    if (!listPending) return res.status(503).json({ error: 'Agent-to-agent messaging is not available on this backend' });
    return res.json({ ok: true, pending: listPending(auth.userId, auth.agentId) });
  });

  router.delete('/agents/messages/:id', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const cancel = deps.agentLifecycle?.cancelPendingPeerMessage;
    if (!cancel) return res.status(503).json({ error: 'Agent-to-agent messaging is not available on this backend' });
    const id = String(req.params.id ?? '').trim();
    if (!id) return res.status(400).json({ error: 'Send the id of a waiting message — `agentbuilt agent pending` lists them.' });
    const result = cancel(auth.userId, auth.agentId, id);
    if (!result.ok) return res.status(404).json({ error: result.reason });
    return res.json({
      ok: true,
      recipient: result.recipient,
      message: `Withdrew the message waiting for ${result.recipient.name}. Nothing reaches them from it.`,
    });
  });

  /**
   * `agentbuilt agent stop` (note #462): the Workspace Agent ends the running
   * turn of one of the owner's agents, exactly as the owner's Stop button
   * does. The owner asked for the fence explicitly — a room agent cannot stop
   * another agent — so a room credential is refused here, in words that say
   * whose verb it is, before any name is resolved.
   */
  router.post('/agents/stop', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.purpose) {
      return res.status(403).json({
        error: 'Stopping another agent\'s turn is the Workspace Agent\'s verb alone: no other agent can stop one. Ask your user, or wait until it is idle (`agentbuilt agent list`) and message it then.',
      });
    }
    if (!deps.workspaceAgent || !auth.orgId) {
      return res.status(503).json({ error: 'The Workspace Agent conversation is not available on this backend.' });
    }
    const body = (req.body ?? {}) as { agent?: unknown; reason?: unknown };
    if (typeof body.agent !== 'string' || !body.agent.trim()) {
      return res.status(400).json({ error: 'Send { agent } with an agent name or id: `agentbuilt agent stop "<name-or-id>" ["<why>"]`.' });
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      return res.status(400).json({ error: 'Send { reason } as a string: the words that go on the stopped agent\'s chat row.' });
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length > AGENT_STOP_REASON_MAX_LENGTH) {
      return res.status(400).json({ error: `That reason is ${reason.length} characters — keep it under ${AGENT_STOP_REASON_MAX_LENGTH}. Say the rest in the message you send the agent afterwards.` });
    }
    const result = await deps.workspaceAgent.stopAgent({ userId: auth.userId, orgId: auth.orgId, agent: body.agent.trim(), ...(reason ? { reason } : {}) });
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404
        : result.code === 'not_own' ? 403
          : result.code === 'idle' ? 409
            : result.code === 'unavailable' ? 503
              : 400;
      return res.status(status).json({ error: result.reason, code: result.code });
    }
    return res.json({
      ok: true,
      name: result.name,
      idle: result.idle,
      message: result.idle
        ? `Stopped ${result.name}: its turn ended, what it already did stays on its machine, and its conversation says you stopped it${reason ? ' and why' : ''}. It is idle now — \`agentbuilt agent message "${result.name}" "..."\` reaches it.`
        : `Stopped ${result.name}: the turn is ending on its machine but has not unwound yet, so it still reads as working and a message sent now is refused. Run \`agentbuilt agent list\` until it reads idle, then message it.`,
    });
  });

  // The room verbs (notes #710, #740) went with rooms (note #843). An older
  // agentbuilt still calls them for one more release, and hears so.
  for (const path of ['/rooms', '/rooms/rename', '/rooms/order', '/rooms/remove']) {
    router.post(path, async (req, res) => {
      const auth = await authenticate(req, res);
      if (!auth) return;
      return res.status(410).json({ error: ROOMS_GONE });
    });
  }

  /**
   * `agentbuilt agent create` (note #710): the Workspace Agent brings a new
   * agent into the workplace, exactly as the person's New agent does — the
   * same lifecycle call, the same gates (ceiling, sign-in, deletion lock),
   * the same refusals in the same words. The record is named before the
   * machine is built, so the answer says who is arriving.
   *
   * `--model` / `--effort` (note #757): what it thinks with, when the person
   * asked — judged against the picker's own catalog before anything is
   * created, and stored on the record as the picker would store the pick.
   * Left out, the defaults, exactly as before. The answer names the pair the
   * agent will run on either way.
   */
  /**
   * Guests' own agents on or off (note #1038): the Workspace Agent's switch,
   * for its own person's workplace. On, a visitor of the home page can make
   * a sealed agent there, spending this person's Claude seat; off, the
   * public route rests and the spare is deleted. GET says where it stands.
   */
  router.get('/agents/guests', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.purpose) return res.status(403).json({ error: 'Guests are switched by the Workspace Agent alone.' });
    if (!deps.guestAgents) return res.status(503).json({ error: 'Guests are not available on this backend.' });
    const settings = await deps.guestAgents.settings();
    const list = await deps.guestAgents.listForOwner();
    const mine = settings?.userId === auth.userId && settings.orgId === auth.orgId;
    return res.json({
      enabled: Boolean(settings?.enabled && mine),
      elsewhere: Boolean(settings?.enabled && !mine),
      live: list.live.length,
      madeToday: list.madeToday,
      limits: list.limits,
      message: settings?.enabled
        ? mine
          ? `Guests are ON in this workplace: ${list.live.length} of ${list.limits.liveMax} live, ${list.madeToday} of ${list.limits.globalPerDay} made today, ${list.limits.sparesTarget} spare kept ready.`
          : 'Guests are ON in another workplace on this platform, not this one.'
        : 'Guests are OFF: the home page cannot make an agent.',
    });
  });

  router.post('/agents/guests', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.purpose) return res.status(403).json({ error: 'Guests are switched by the Workspace Agent alone.' });
    if (!deps.guestAgents || !deps.orgStorage || !auth.orgId) return res.status(503).json({ error: 'Guests are not available on this backend.' });
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'Send { enabled: true | false }: `agentbuilt agent guests on` or `off`.' });
    const membership = await deps.orgStorage.getMembership(auth.orgId, auth.userId).catch(() => null);
    if (membership?.role !== 'admin') return res.status(403).json({ error: 'Only a workplace admin\'s Workspace Agent can switch guests on.' });
    const current = await deps.guestAgents.settings();
    if (current?.enabled && (current.userId !== auth.userId || current.orgId !== auth.orgId)) {
      return res.status(409).json({ error: 'Guests are already ON in another workplace on this platform; that one must switch them off first.' });
    }
    await deps.guestAgents.setEnabled(auth.userId, auth.orgId, body.enabled);
    return res.json({
      ok: true,
      enabled: body.enabled,
      message: body.enabled
        ? 'Guests are ON: a visitor of the home page can now make a sealed agent in this workplace, on its own 2-core machine, thinking with your person\'s Claude seat (it rests at 50% of the 5-hour window or 70% of the week). A spare is being prepared; their agents appear on the Guests screen.'
        : 'Guests are OFF: the home page cannot make an agent. Live ones finish their 30 quiet minutes; the spare is deleted.',
    });
  });

  router.post('/agents', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.purpose) {
      return res.status(403).json({ error: 'Creating an agent is the Workspace Agent\'s verb alone. Ask your user: New agent, in the agents picker in their Workspace.' });
    }
    const createAgent = deps.agentLifecycle?.createAgent;
    if (!createAgent || !deps.orgStorage || !auth.orgId) {
      return res.status(503).json({ error: 'Agent management is not available on this backend yet.' });
    }
    const body = (req.body ?? {}) as { cli?: unknown; model?: unknown; effort?: unknown; sealed?: unknown };
    // The sealed public guide (note #1010): Claude Code on sonnet at medium,
    // whatever else was asked — its kind decides, not the request.
    if (body.sealed !== undefined) {
      if (body.sealed !== PUBLIC_GUIDE_KIND) return res.status(400).json({ error: 'The one sealed kind is --public-guide.' });
      if (body.cli !== undefined || body.model !== undefined || body.effort !== undefined) {
        return res.status(400).json({ error: 'No agent was created: --public-guide takes no --cli, --model or --effort. A guide is Claude Code on sonnet at medium.' });
      }
      const org = await deps.orgStorage.getOrg(auth.orgId).catch(() => null);
      if (org?.deletion) return res.status(409).json({ error: `${org.name} is being deleted, so no new agent can start there.` });
      const result = await createAgent(auth.userId, 'claude', auth.orgId, { awaitName: true, concurrent: true, sealed: PUBLIC_GUIDE_KIND });
      if (!result.ok) return res.status(400).json({ error: result.reason });
      const agent = result.agent;
      if (agent) void deps.workspaceAgent?.receipt(auth.userId, auth.orgId, agentBroughtInReceipt(agent.name)).catch(() => {});
      return res.status(202).json({
        ok: true,
        ...(agent ? { agent } : {}),
        runtime: { cli: 'claude', model: PUBLIC_GUIDE_MODEL, effort: PUBLIC_GUIDE_EFFORT },
        message: `${agent ? `${agent.name} is arriving [${agent.id}]` : 'The public guide is being set up'}, a SEALED Claude Code agent on ${PUBLIC_GUIDE_MODEL} at ${PUBLIC_GUIDE_EFFORT} effort, on a shared-core machine of its own: it is never given a platform token or a secret, and reads only a public copy of the code. The home page's questions now go to it. Its machine takes a few minutes; its Visits list on its screen holds every visitor's conversation.`,
      });
    }
    // Without --cli, the plan the person signed in (note #726): a ChatGPT-only
    // person used to be refused unless the agent asked for Codex by name.
    // Claude when both are in, as before; OpenCode only when it is all they
    // hold (note #780).
    const cli = body.cli ?? (await memberHasLiveSeat(deps.orgStorage, auth.userId, 'claude', auth.orgId) ? 'claude'
      : await memberHasLiveSeat(deps.orgStorage, auth.userId, 'codex', auth.orgId) ? 'codex'
        : await memberHasLiveSeat(deps.orgStorage, auth.userId, 'opencode', auth.orgId) ? 'opencode' : 'claude');
    if (typeof cli !== 'string' || !isHarnessCli(cli)) {
      return res.status(400).json({ error: '`--cli` is claude, codex or opencode.' });
    }
    const harness = harnessName(cli);
    const asked = (value: unknown) => (value == null ? undefined : String(value));
    const runtime = checkCreationRuntime(cli, asked(body.model), asked(body.effort));
    if (!runtime.ok) {
      const said = (value: unknown) => `"${String(value).trim().slice(0, 60)}"`;
      return res.status(400).json({
        error: runtime.field === 'model'
          ? `No agent was created: ${said(body.model)} is not a model a ${harness} agent can use. Choose one of: ${runtime.allowed.join(', ')}.`
            + (runtime.otherCli ? ` (It is a ${harnessName(runtime.otherCli)} model: add --cli ${runtime.otherCli} for an agent on it.)` : '')
          : `No agent was created: ${said(body.effort)} is not an effort ${runtime.model} offers. Choose one of: ${runtime.allowed.join(', ')}.`,
      });
    }
    const org = await deps.orgStorage.getOrg(auth.orgId).catch(() => null);
    if (org?.deletion) return res.status(409).json({ error: `${org.name} is being deleted, so no new agent can start there.` });
    // `concurrent` (note #726): a team is brought in together — two creates
    // from one turn are not a double tap, and the one-at-a-time lock the
    // person's own New agent keeps would refuse the second for a minute.
    const result = await createAgent(auth.userId, cli, auth.orgId, {
      awaitName: true,
      concurrent: true,
      ...(runtime.model ? { model: runtime.model } : {}),
      ...(runtime.effort ? { effort: runtime.effort } : {}),
    });
    if (!result.ok) {
      // Written for a human (capacity refusals include the upgrade pitch) —
      // passed through, exactly as the Workspace's own route does.
      return res.status(400).json({ error: result.reason });
    }
    const agent = result.agent;
    // Said where the person is reading (note #726): a row in the Chief of
    // Staff's chat, recorded only while its turn runs, as every receipt is.
    if (agent) void deps.workspaceAgent?.receipt(auth.userId, auth.orgId, agentBroughtInReceipt(agent.name)).catch(() => {});
    // The pair it will run on, resolved as its first turn will resolve it,
    // and which half was asked for — so the person hears what they got.
    const model = resolveEffectiveModel(cli, runtime.model);
    const effort = resolveEffectiveEffort(cli, runtime.model, runtime.effort);
    const whose = runtime.model && runtime.effort ? 'as asked'
      : runtime.model ? 'model as asked, default effort'
        : runtime.effort ? 'default model, effort as asked'
          : 'the defaults';
    const thinking = `${harness === 'OpenCode' ? 'an' : 'a'} ${harness} agent on ${model}${effort ? ` at ${effort} effort` : ''} (${whose})`;
    return res.status(202).json({
      ok: true,
      ...(agent ? { agent } : {}),
      runtime: { cli, model, effort },
      message: agent
        ? `${agent.name} is arriving [${agent.id}], ${thinking}: its machine is being built, which takes a few minutes. Run \`agentbuilt agent list\` until it reads idle, then message it with its job — it knows nothing until you do.`
        : `A new agent is being set up, ${thinking}: its machine is being built, which takes a few minutes. Run \`agentbuilt agent list\` to see its name once it appears, and message it with its job once it reads idle.`,
    });
  });

  /**
   * `agentbuilt agent reset` (note #710): the person's own "reset chat" to
   * one of their idle agents, through the conversation, which refuses an
   * agent whose answer it still awaits. The Workspace Agent's verb alone.
   */
  /**
   * `agentbuilt forward` (note #724): the Workspace Agent puts proposals in
   * front of its person as cards in its own conversation. Only the pointer is
   * stored; the Workspace reads each proposal's state fresh whenever it
   * answers the conversation, so a card never goes stale.
   *
   * Numbers are per repository and per room, so each one is looked up across
   * the workplace — every repository for a PR, every room for a knowledge
   * proposal — and only a number that matches more than one asks for
   * `--repo` / `--room`. The whole call is refused if any item is, so the
   * person never gets half of what the agent meant to show.
   */
  router.post('/forward', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.purpose) {
      return res.status(403).json({ error: 'Forwarding proposals into a conversation is the Workspace Agent\'s verb alone. Your own proposals reach your user with `agentbuilt pr ready` / `agentbuilt knowledge proposals ready`.' });
    }
    if (!deps.workspaceAgent?.forwardProposals || !auth.orgId) {
      return res.status(503).json({ error: 'The Workspace Agent conversation is not available on this backend.' });
    }
    const body = (req.body ?? {}) as { items?: unknown; repo?: unknown };
    const items = Array.isArray(body.items) ? body.items : [];
    const repoName = typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : null;
    const usage = 'agentbuilt forward pr <n> [knowledge <n>]... [--repo <name>]';
    if (!items.length || items.length > 5) {
      return res.status(400).json({ error: `Name one to five proposals: \`${usage}\`.` });
    }
    const wanted: Array<{ kind: 'pr' | 'knowledge'; number: number }> = [];
    for (const item of items as Array<{ kind?: unknown; number?: unknown }>) {
      const number = Number(item?.number);
      if ((item?.kind !== 'pr' && item?.kind !== 'knowledge') || !Number.isSafeInteger(number) || number < 1) {
        return res.status(400).json({ error: `Each item is pr <number> or knowledge <number>: \`${usage}\`.` });
      }
      if (!wanted.some((seen) => seen.kind === item.kind && seen.number === number)) wanted.push({ kind: item.kind, number });
    }
    const ns = await gitNamespace(auth);
    const namespaces = await workplaceNamespaces(auth, ns);
    const found: Array<{ kind: 'pr' | 'knowledge'; id: string; line: string }> = [];
    for (const item of wanted) {
      if (item.kind === 'pr') {
        if (!deps.gitPullRequestStorage || !deps.gitRepoStorage) {
          return res.status(503).json({ error: 'Change proposals are not available on this backend yet' });
        }
        const repos = (await deps.gitRepoStorage.listLiveIn(namespaces)).filter((repo) => !repoName || repo.name === repoName);
        if (repoName && !repos.length) return res.status(404).json({ error: `No repo named "${repoName}" in this workplace.` });
        const matches = (await Promise.all(repos.map(async (repo) => {
          const doc = await deps.gitPullRequestStorage!.getByNumber(repo.id, item.number);
          return doc ? { doc, repo } : null;
        }))).filter((match): match is NonNullable<typeof match> => Boolean(match));
        if (!matches.length) return res.status(404).json({ error: `No PR #${item.number}${repoName ? ` in ${repoName}` : ' in any repository of this workplace'}.` });
        if (matches.length > 1) {
          return res.status(409).json({ error: `PR #${item.number} exists in ${matches.map((match) => match.repo.name).join(', ')} — say which with --repo <name>.` });
        }
        const [{ doc, repo }] = matches as [typeof matches[number]];
        if (doc.draft) return res.status(409).json({ error: `PR #${doc.number} in ${repo.name} is still quiet — its agent has not run \`pr ready\`, so there is nothing for the person to decide yet.` });
        found.push({ kind: 'pr', id: doc.id, line: `PR #${doc.number} in ${repo.name} — ${doc.title}` });
      } else {
        if (!deps.knowledgeProposalStorage) {
          return res.status(503).json({ error: 'Knowledge pages are not available on this backend yet' });
        }
        // The workplace's own number first; one held only at old rooms'
        // namespaces (note #843) is found there, and one held twice there
        // is the person's to name.
        const own = await deps.knowledgeProposalStorage.getByNumber(ns.namespaceId, item.number);
        const matches = own ? [own] : (await Promise.all(namespaces.filter((namespaceId) => namespaceId !== ns.namespaceId)
          .map((namespaceId) => deps.knowledgeProposalStorage!.getByNumber(namespaceId, item.number))))
          .filter((doc): doc is NonNullable<typeof doc> => Boolean(doc));
        if (!matches.length) return res.status(404).json({ error: `No knowledge proposal #${item.number} in this workplace.` });
        if (matches.length > 1) {
          return res.status(409).json({ error: await sharedNumberError('Knowledge proposal', item.number, matches.map((doc) => doc.userId)) });
        }
        const [doc] = matches as [typeof matches[number]];
        if (doc.draft) return res.status(409).json({ error: `Knowledge proposal #${doc.number} is still quiet — its agent has not run \`knowledge proposals ready\`, so there is nothing for the person to decide yet.` });
        found.push({ kind: 'knowledge', id: doc.id, line: `knowledge proposal #${doc.number} — ${doc.title}` });
      }
    }
    const keyOf = (ref: { kind: string; id: string }) => `${ref.kind}:${ref.id}`;
    const lines = (refs: Array<{ kind: string; id: string }>) => found.filter((entry) => refs.some((ref) => keyOf(ref) === keyOf(entry))).map((entry) => entry.line).join('; ');
    const outcome = await deps.workspaceAgent.forwardProposals({
      userId: auth.userId,
      orgId: auth.orgId,
      proposals: found.map(({ kind, id }) => ({ kind, id })),
      // The row names only the proposals it carries: one already in front of
      // the person gets no second card (note #752) and is not "forwarded".
      text: (added) => `Forwarded ${lines(added)}`.slice(0, 2000),
    });
    if (!outcome.landed) {
      return res.status(409).json({ error: 'A proposal is forwarded from a running request — this one has ended, so nothing was shown.' });
    }
    const shownAlready = outcome.alreadyShown.length
      ? ` Already in front of the person in this conversation, so no second card: ${lines(outcome.alreadyShown)}.`
      : '';
    if (!outcome.added.length) {
      return res.json({
        ok: true,
        message: `No new card.${shownAlready} A proposal lands in this conversation by itself when its agent runs \`pr ready\`, and a card shows its state as it stands whenever the person looks — so do not repeat its title or number in your reply.`,
      });
    }
    return res.json({
      ok: true,
      message: `Forwarded ${outcome.added.length === 1 ? 'a card' : `${outcome.added.length} cards`} into your conversation: ${lines(outcome.added)}. Each opens the proposal, where the person approves or rejects it, and shows its state as it stands whenever they look — so do not repeat its title or number in your reply.${shownAlready}`,
    });
  });

  router.post('/agents/reset', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.purpose) {
      return res.status(403).json({ error: 'Asking another agent for a fresh chat is the Workspace Agent\'s verb alone. Hand your own chat over with `agentbuilt chat new`, or tell your user the agent needs a reset.' });
    }
    if (!deps.workspaceAgent || !auth.orgId) {
      return res.status(503).json({ error: 'The Workspace Agent conversation is not available on this backend.' });
    }
    const body = (req.body ?? {}) as { agent?: unknown };
    if (typeof body.agent !== 'string' || !body.agent.trim()) {
      return res.status(400).json({ error: 'Send { agent } with an agent name or id: `agentbuilt agent reset "<name-or-id>"`.' });
    }
    const result = await deps.workspaceAgent.resetAgent({ userId: auth.userId, orgId: auth.orgId, agent: body.agent.trim() });
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404
        : result.code === 'not_own' ? 403
          : result.code === 'busy' || result.code === 'awaited' ? 409
            : result.code === 'unavailable' ? 503
              : 400;
      return res.status(status).json({ error: result.reason, code: result.code });
    }
    return res.json({
      ok: true,
      name: result.name,
      message: `Asked ${result.name} for a fresh chat. It saves what matters and starts over in a turn of its own, so run \`agentbuilt agent list\` until it reads idle again before messaging it.`,
    });
  });

  /**
   * `agentbuilt agent model` (note #776): the picker on an agent's screen,
   * used by the Workspace Agent for the person — only on the person's own
   * agents, and only when they asked (an event turn is refused by the fence
   * above, as every unlisted write is). Applies from the agent's next turn.
   */
  router.post('/agents/model', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.purpose) {
      return res.status(403).json({ error: 'Changing another agent\'s model and effort is the Workspace Agent\'s verb alone. Tell your user, who changes it with the picker on that agent\'s screen.' });
    }
    if (!deps.workspaceAgent || !auth.orgId) {
      return res.status(503).json({ error: 'The Workspace Agent conversation is not available on this backend.' });
    }
    const usage = '`agentbuilt agent model "<name-or-id>" [--model <model>] [--effort <effort>]`';
    const body = (req.body ?? {}) as { agent?: unknown; model?: unknown; effort?: unknown };
    if (typeof body.agent !== 'string' || !body.agent.trim()) {
      return res.status(400).json({ error: `Send { agent } with an agent name or id: ${usage}.` });
    }
    if ((body.model != null && typeof body.model !== 'string') || (body.effort != null && typeof body.effort !== 'string')) {
      return res.status(400).json({ error: `--model and --effort are words: ${usage}.` });
    }
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const effort = typeof body.effort === 'string' ? body.effort.trim() : '';
    if (!model && !effort) {
      return res.status(400).json({ error: `Say what to change — a model, an effort, or both: ${usage}.` });
    }
    const result = await deps.workspaceAgent.changeAgentRuntime({
      userId: auth.userId, orgId: auth.orgId, agent: body.agent.trim(), ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    });
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404
        : result.code === 'not_own' ? 403
          : result.code === 'unavailable' ? 503
            : 400;
      return res.status(status).json({ error: result.reason, code: result.code });
    }
    const pair = `${result.model}${result.effort ? ` at ${result.effort} effort` : ''}`;
    const harness = harnessName(result.cli);
    return res.json({
      ok: true,
      name: result.name,
      runtime: { cli: result.cli, model: result.model, effort: result.effort },
      changed: result.changed,
      working: result.working,
      message: !result.changed
        ? `${result.name} already runs on ${pair} (${harness}), so nothing was changed.`
        : `${result.name} now runs on ${pair} (${harness}), from its next turn.`
          + (result.working
            ? ` It is working right now: this turn finishes on ${result.was.model}${result.was.effort ? ` at ${result.was.effort} effort` : ''}, and the new setting starts with the turn after it.`
            : '')
          + ' Its chat shows that you changed it, and its next turn is told. Tell the person what it runs on now — they can change it back with the picker on its screen.',
    });
  });

  /**
   * `agentbuilt agent remove` (note #710): an ASK on the agent's screen in
   * the person's Workspace, where only their typed confirmation removes it —
   * the same shape as a site's `agentbuilt delete`. Nothing is removed here,
   * and nothing notifies the person. The Workspace Agent's verb alone.
   */
  /**
   * Schedules (note #779). An agent PROPOSES one — for itself or a sibling
   * in its workplace — and the owner approves it on the agent's screen:
   * a schedule spends the owner's subscription while nobody is watching, so
   * only they sign it. The Workspace Agent lists and pauses, never creates
   * or resumes, and is never a target. Agents cannot schedule each other
   * without the owner — that is how two agents ping forever.
   */
  const scheduleStatus = (code: string): number => (code === 'not_found' ? 404 : code === 'refused' ? 403 : code === 'unavailable' ? 503 : 400);
  const scheduleNames = async (auth: AgentAuth, doc: { agentId: string; createdByAgentId: string }) => ({
    agentName: auth.agents[doc.agentId]?.name ?? doc.agentId,
    proposerName: auth.agents[doc.createdByAgentId]?.name ?? doc.createdByAgentId,
  });
  const scheduleReach = (auth: AgentAuth, doc: { ownerUserId: string; orgId: string }): boolean => (
    doc.ownerUserId === auth.userId && doc.orgId === auth.orgId
  );
  router.post('/schedules', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (auth.purpose) {
      return res.status(403).json({ error: 'The Chief of Staff lists and pauses schedules; it cannot create one. An agent proposes a schedule with `agentbuilt schedule propose`, and the person approves it on that agent\'s screen — tell your user which agent to ask.' });
    }
    if (!deps.agentSchedules || !auth.orgId) return res.status(503).json({ error: 'Schedules are not available on this backend.' });
    const body = (req.body ?? {}) as { agent?: unknown; message?: unknown; every?: unknown; window?: unknown; timeZone?: unknown; capTurns?: unknown; capTokens?: unknown };
    const usage = '`agentbuilt schedule propose [--agent "<name-or-id>"] --every 8m [--window 07:00-23:00] [--tz Europe/Amsterdam] [--cap-turns N] [--cap-tokens N] --message "…"`';
    if (typeof body.message !== 'string' || typeof body.every !== 'string') return res.status(400).json({ error: `Send { every, message }: ${usage}.` });
    const whole = (value: unknown): number | undefined => (value === undefined || value === null ? undefined : Number(value));
    const result = await deps.agentSchedules.propose({
      userId: auth.userId, orgId: auth.orgId, byAgentId: auth.agentId,
      ...(typeof body.agent === 'string' ? { agent: body.agent } : {}),
      message: body.message, every: body.every,
      ...(typeof body.window === 'string' ? { window: body.window } : {}),
      ...(typeof body.timeZone === 'string' ? { timeZone: body.timeZone } : {}),
      ...(whole(body.capTurns) !== undefined ? { capTurns: whole(body.capTurns) } : {}),
      ...(whole(body.capTokens) !== undefined ? { capTokens: whole(body.capTokens) } : {}),
    });
    if (!result.ok) return res.status(scheduleStatus(result.code)).json({ error: result.reason, code: result.code });
    const view = scheduleView(result.schedule, await scheduleNames(auth, result.schedule), new Date());
    return res.status(202).json({
      ok: true, schedule: view,
      message: `Proposed ${view.id}: ${result.targetName} would wake ${view.summary}, with "${view.message}". Nothing ticks until your user approves it under Schedule on ${result.targetName}'s screen; its chat shows the ask. TELL THEM in your reply what you proposed and why — then end your turn; you are messaged when they decide. A tick every few minutes keeps ${result.targetName}'s machine awake for the whole window: say that too.`,
    });
  });
  router.get('/schedules', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.agentSchedules || !auth.orgId) return res.status(503).json({ error: 'Schedules are not available on this backend.' });
    const docs = await deps.agentSchedules.list({ orgId: auth.orgId, ownerUserId: auth.userId });
    const now = new Date();
    const schedules = await Promise.all(docs.map(async (doc) => scheduleView(doc, await scheduleNames(auth, doc), now)));
    return res.json({ schedules });
  });
  const scheduleById = async (auth: AgentAuth, res: Response, id: string) => {
    const doc = await deps.agentSchedules!.get(id);
    if (!doc || !scheduleReach(auth, doc)) {
      res.status(404).json({ error: `No schedule ${id} reaches you. \`agentbuilt schedule list\` names the ones that do.` });
      return null;
    }
    return doc;
  };
  router.get('/schedules/:id', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.agentSchedules || !auth.orgId) return res.status(503).json({ error: 'Schedules are not available on this backend.' });
    const doc = await scheduleById(auth, res, String(req.params.id ?? ''));
    if (!doc) return;
    return res.json({ schedule: scheduleView(doc, await scheduleNames(auth, doc), new Date()) });
  });
  router.post('/schedules/:id/pause', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.agentSchedules || !auth.orgId) return res.status(503).json({ error: 'Schedules are not available on this backend.' });
    const doc = await scheduleById(auth, res, String(req.params.id ?? ''));
    if (!doc) return;
    const result = await deps.agentSchedules.pause({ id: doc.id, userId: auth.userId, by: auth.purpose ? 'workspace-agent' : 'agent' });
    if (!result.ok) return res.status(scheduleStatus(result.code)).json({ error: result.reason, code: result.code });
    const view = scheduleView(result.schedule, await scheduleNames(auth, result.schedule), new Date());
    return res.json({ ok: true, schedule: view, message: result.changed ? `Paused ${view.id}: ${view.agentName} is no longer woken ${view.summary}. Your user resumes it under Schedule on ${view.agentName}'s screen${auth.purpose ? '' : ', or you do with `agentbuilt schedule resume`'}.` : `${view.id} was already paused (${view.pause?.text ?? 'paused'}).` });
  });
  router.post('/schedules/:id/resume', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (auth.purpose) return res.status(403).json({ error: 'The Chief of Staff pauses schedules; resuming one is the person\'s, on the agent\'s screen. Tell your user.' });
    if (!deps.agentSchedules || !auth.orgId) return res.status(503).json({ error: 'Schedules are not available on this backend.' });
    const doc = await scheduleById(auth, res, String(req.params.id ?? ''));
    if (!doc) return;
    const result = await deps.agentSchedules.resume({ id: doc.id, userId: auth.userId, by: 'agent' });
    if (!result.ok) return res.status(scheduleStatus(result.code)).json({ error: result.reason, code: result.code });
    const view = scheduleView(result.schedule, await scheduleNames(auth, result.schedule), new Date());
    return res.json({ ok: true, schedule: view, message: result.changed ? `Resumed ${view.id}: ${view.agentName} wakes ${view.summary} again${view.nextTickAt ? `, next at ${view.nextTickAt}` : ''}.` : `${view.id} was already active.` });
  });
  router.post('/schedules/:id/withdraw', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.agentSchedules || !auth.orgId) return res.status(503).json({ error: 'Schedules are not available on this backend.' });
    const doc = await scheduleById(auth, res, String(req.params.id ?? ''));
    if (!doc) return;
    const result = await deps.agentSchedules.remove({ id: doc.id, userId: auth.userId, byAgentId: auth.agentId });
    if (!result.ok) return res.status(scheduleStatus(result.code)).json({ error: result.reason, code: result.code });
    return res.json({ ok: true, message: `Withdrew ${doc.id}; nothing was ever ticking.` });
  });

  router.post('/agents/remove', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.purpose) {
      return res.status(403).json({ error: 'Asking for an agent\'s removal is the Workspace Agent\'s verb alone. Tell your user, who removes an agent from its screen in their Workspace.' });
    }
    if (!deps.workspaceAgent || !auth.orgId) {
      return res.status(503).json({ error: 'The Workspace Agent conversation is not available on this backend.' });
    }
    const body = (req.body ?? {}) as { agent?: unknown; reason?: unknown };
    if (typeof body.agent !== 'string' || !body.agent.trim()) {
      return res.status(400).json({ error: 'Send { agent } with an agent name or id: `agentbuilt agent remove "<name-or-id>" ["<why>"]`.' });
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      return res.status(400).json({ error: 'Send { reason } as a string: the words the person reads beside the ask.' });
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length > AGENT_STOP_REASON_MAX_LENGTH) {
      return res.status(400).json({ error: `That reason is ${reason.length} characters — keep it under ${AGENT_STOP_REASON_MAX_LENGTH}. Say the rest in your reply.` });
    }
    const result = await deps.workspaceAgent.askRemoveAgent({ userId: auth.userId, orgId: auth.orgId, agent: body.agent.trim(), ...(reason ? { reason } : {}) });
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404
        : result.code === 'not_own' ? 403
          : result.code === 'unavailable' ? 503
            : 400;
      return res.status(status).json({ error: result.reason, code: result.code });
    }
    return res.status(202).json({
      pending: true,
      name: result.name,
      message: `Asked. ${result.name} is now flagged for removal on its screen in your person's Workspace — they remove it there by typing its name, or keep it.`
        + ' Nothing is removed until they do, and nothing notifies them, so TELL THEM in your reply.'
        + ' Do not wait for it: end your turn.',
    });
  });

  router.post('/agents/messages', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const messagePeer = deps.agentLifecycle?.messagePeer;
    if (!messagePeer) return res.status(503).json({ error: 'Agent-to-agent messaging is not available on this backend' });
    const body = (req.body ?? {}) as { recipient?: unknown; message?: unknown };
    if (typeof body.recipient !== 'string' || !body.recipient.trim()) {
      return res.status(400).json({ error: 'Send { recipient, message } with an agent name or id.' });
    }
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return res.status(400).json({ error: 'The agent message cannot be empty.' });
    }
    const message = body.message.trim();
    if (message.length > AGENT_MESSAGE_MAX_LENGTH) {
      return res.status(400).json({
        error: `That message is ${message.length} characters — keep it under ${AGENT_MESSAGE_MAX_LENGTH}. Push code or attach files to a note, then send the pointer.`,
      });
    }
    // A room agent answering the Workspace Agent (note #457): the recipient
    // is not in any roster — it has no room — but its NAME reaches its
    // conversation, where the owner is reading. The row lands, the wait for
    // this agent closes, and the answer starts the Workspace Agent on a turn
    // that reacts to it (note #539), exactly as a message to a room agent
    // starts one.
    if (!auth.purpose && isWorkspaceAgentRecipient(body.recipient.trim(), auth)) {
      if (!deps.workspaceAgent || !auth.orgId) {
        return res.status(503).json({ error: 'The Workspace Agent conversation is not available on this backend.' });
      }
      const delivered = await deps.workspaceAgent.receiveFromAgent({ userId: auth.userId, orgId: auth.orgId, senderAgentId: auth.agentId, message });
      if (!delivered.ok) return res.status(409).json({ error: delivered.reason });
      return res.status(202).json({
        ok: true,
        recipient: { id: workspaceAssistantId(auth.userId, auth.orgId), name: delivered.name },
        message: delivered.reacting
          ? `Delivered to the ${delivered.name}'s conversation, where your user reads it, and it reads your answer and reacts there. Nothing more to send: it is your final answer.`
          : `Delivered to the ${delivered.name}'s conversation, where your user reads it. Nothing more to send: it is your final answer there.`,
      });
    }
    // The Workspace Agent's send goes through its conversation, which records
    // the reply cursor and the receipt before the same idle-only admission.
    if (auth.purpose && (!deps.workspaceAgent || !auth.orgId)) {
      return res.status(503).json({ error: 'The Workspace Agent conversation is not available on this backend.' });
    }
    const result = auth.purpose
      ? await deps.workspaceAgent!.messageAgent({
        userId: auth.userId, orgId: auth.orgId!, senderAgentId: auth.agentId, recipient: body.recipient.trim(), message,
      })
      : await messagePeer({
        userId: auth.userId,
        senderAgentId: auth.agentId,
        recipient: body.recipient.trim(),
        message,
      });
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404
        : result.code === 'self' ? 400
          : result.code === 'restarting' ? 503
            : 409;
      return res.status(status).json({ error: result.reason, code: result.code });
    }
    if (result.queued) {
      const { queued } = result;
      const waiting = queued.position === 1 ? 'nothing else waiting' : `${queued.position - 1} ahead of it`;
      return res.status(202).json({
        ok: true,
        recipient: result.recipient,
        queued,
        message: `Queued for ${result.recipient.name}, who is working now (${waiting}). It is delivered the moment ${result.recipient.name} is idle, as one turn with anything else waiting, and dropped if that has not happened by ${queued.expiresAt} — both chats are told either way. Do not send it again. Withdraw it with \`agentbuilt agent cancel ${queued.id}\`; \`agentbuilt agent pending\` lists what you have waiting.`,
      });
    }
    return res.status(202).json({
      ok: true,
      recipient: result.recipient,
      message: `Started ${result.recipient.name}. Their response will appear in their Workspace conversation, and the Workspace will notify the user when it lands.`,
    });
  });

  /**
   * The person's OTHER workplaces, for their Chief of Staff (note #753): the
   * one door from one workplace to another, and only ever to the same
   * person's own Chief of Staff there. Read from the person's memberships
   * alone, so a workplace they never joined or have left does not exist
   * here — asked for by name it is "not found", exactly like a name nobody
   * uses (the privacy rule on workplace-layer-design).
   */
  const ownWorkplaces = async (userId: string): Promise<Array<{ orgId: string; name: string }>> => {
    const memberships = await deps.orgStorage!.listMembershipsByUser(userId).catch(() => []);
    const orgs = await Promise.all(memberships.map((member) => deps.orgStorage!.getOrg(member.orgId).catch(() => null)));
    return orgs.filter((org): org is NonNullable<typeof org> => Boolean(org) && !org!.deletion)
      .map((org) => ({ orgId: org.orgId, name: org.name }));
  };
  const coordinatorWorkplaces = async (req: Request, res: Response, what: string) => {
    const auth = await authenticate(req, res);
    if (!auth) return null;
    if (!auth.purpose) {
      res.status(403).json({ error: `${what} is the Workspace Agent's verb alone: any other agent works in its own workplace. Ask your user, whose Chief of Staff can pass a message to their other workplaces.` });
      return null;
    }
    if (!deps.orgStorage || !auth.orgId) {
      res.status(503).json({ error: 'Workplaces are not available on this backend.' });
      return null;
    }
    return { auth, orgId: auth.orgId, workplaces: await ownWorkplaces(auth.userId) };
  };

  router.get('/workplaces', async (req, res) => {
    const ctx = await coordinatorWorkplaces(req, res, 'Listing workplaces');
    if (!ctx) return;
    const others = ctx.workplaces.filter((workplace) => workplace.orgId !== ctx.orgId);
    return res.json({
      ok: true,
      current: ctx.workplaces.find((workplace) => workplace.orgId === ctx.orgId) ?? null,
      workplaces: others,
      message: others.length
        ? `Your user's other workplaces: ${others.map((workplace) => `"${workplace.name}" [${workplace.orgId}]`).join(', ')}. \`agentbuilt workplace message "<workplace>" "<message>"\` reaches their Chief of Staff there, when they ask you to.`
        : 'Your user belongs to no other workplace.',
    });
  });

  router.post('/workplaces/messages', async (req, res) => {
    const ctx = await coordinatorWorkplaces(req, res, 'Messaging another workplace');
    if (!ctx) return;
    if (!deps.workspaceAgent?.messageWorkplace) return res.status(503).json({ error: 'Messaging another workplace is not available on this backend.' });
    const body = (req.body ?? {}) as { workplace?: unknown; message?: unknown };
    const usage = '`agentbuilt workplace message "<workplace>" "<message>"`';
    if (typeof body.workplace !== 'string' || !body.workplace.trim()) return res.status(400).json({ error: `Say which workplace: ${usage}.` });
    if (typeof body.message !== 'string' || !body.message.trim()) return res.status(400).json({ error: `The message cannot be empty: ${usage}.` });
    const message = body.message.trim();
    if (message.length > AGENT_MESSAGE_MAX_LENGTH) {
      return res.status(400).json({ error: `That message is ${message.length} characters — keep it under ${AGENT_MESSAGE_MAX_LENGTH}.` });
    }
    const requested = body.workplace.trim();
    const byId = ctx.workplaces.find((workplace) => workplace.orgId === requested);
    const byName = ctx.workplaces.filter((workplace) => workplace.name.trim().toLowerCase() === requested.toLowerCase());
    if (!byId && byName.length > 1) {
      return res.status(409).json({ error: `More than one of your user's workplaces is called "${requested}": ${byName.map((workplace) => `[${workplace.orgId}]`).join(', ')}. Use the id from \`agentbuilt workplace list\`.` });
    }
    const target = byId ?? byName[0];
    // A workplace that is not the person's — unknown, another member's, or
    // one they have left — gets the one answer a name nobody uses gets.
    if (!target) return res.status(404).json({ error: `No workplace of your user's is called "${requested}". \`agentbuilt workplace list\` names them.`, code: 'not_found' });
    if (target.orgId === ctx.orgId) return res.status(400).json({ error: `"${target.name}" is this workplace: you are its Chief of Staff. Nothing was sent.` });
    const here = ctx.workplaces.find((workplace) => workplace.orgId === ctx.orgId);
    const result = await deps.workspaceAgent.messageWorkplace({
      userId: ctx.auth.userId, orgId: ctx.orgId, orgName: here?.name ?? 'another workplace',
      toOrgId: target.orgId, toName: target.name, message,
    });
    if (!result.ok) return res.status(409).json({ error: result.reason, code: result.code });
    return res.status(202).json({
      ok: true,
      workplace: { orgId: target.orgId, name: target.name },
      message: result.queued
        ? `Delivered to your user's ${result.name}, which is in the middle of another request there and answers after it. Its reply comes back into this conversation by itself and starts you again; nothing more to send.`
        : `Started your user's ${result.name}. Its reply comes back into this conversation by itself and starts you again; nothing more to send.`,
    });
  });

  /**
   * A managed job on this machine reached a terminal state (note #532).
   *
   * The whole point is the turn it starts: a job outlives the turn that asked
   * for it, and until this existed nothing could say so when it finished. The
   * machine has already bounded and redacted every field — it is the only side
   * that can see the job's output and the environment holding the user's
   * credentials — and everything here is bounded AGAIN, because a payload from
   * a machine is still a payload.
   *
   * Answering 2xx is what retires a receipt on the machine, so this answers it
   * only once the delivery has actually been handed over. A 4xx retires the
   * receipt too, permanently, and therefore has to be reserved for something
   * retrying could never fix; everything transient answers 5xx and the machine
   * keeps the receipt owed.
   */
  router.post('/jobs/finished', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const deliver = deps.agentLifecycle?.deliverFinishedJobs;
    if (!deliver) {
      return res.status(503).json({ error: 'Job wake-ups are not available on this backend' });
    }
    // The Workspace Agent's conversation is platform-owned and is started by
    // the person or by its own coordination, never by a machine event. Said
    // plainly rather than dropped, so a job started there stops asking.
    if (auth.purpose) {
      return res.status(409).json({
        error: 'The Workspace Agent is not woken by its machine\'s jobs. Inspect the job with `agentbuilt job status <id>`.',
      });
    }
    const body = (req.body ?? {}) as { jobs?: unknown };
    if (!Array.isArray(body.jobs) || body.jobs.length === 0) {
      return res.status(400).json({ error: 'Send { jobs: [receipt, ...] } with at least one finished job.' });
    }
    const receipts = body.jobs
      .slice(0, FINISHED_JOBS_MAX_PER_REQUEST)
      .map((value) => validateFinishedJobReceipt(value))
      .filter((receipt): receipt is FinishedJobReceipt => receipt !== null);
    if (!receipts.length) {
      return res.status(400).json({ error: 'No usable job receipt in that request.' });
    }
    const { accepted } = await deliver({
      userId: auth.userId,
      agentId: auth.agentId,
      receipts,
    });
    // Nothing taken is not a verdict on the receipt — a runner shutting down
    // for a deploy is the usual cause. 5xx keeps it owed on the machine, which
    // offers it again to the backend that comes back up.
    if (!accepted.length) {
      return res.status(503).json({ error: 'Could not hand that to the agent right now; keep it and try again.' });
    }
    return res.status(202).json({ ok: true, accepted });
  });

  // Retired with /about above (agent-row-recap-design). GET answers the
  // shape old CLIs print — an empty list reads as "no job on the row yet" —
  // and PUT stores nothing.
  router.get('/task', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    return res.json({ ok: true, tasks: [], retired: true });
  });

  router.put('/task', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    return res.json({ ok: true, retired: true, message: RETIRED_ROW_LINE_MESSAGE });
  });

  /**
   * MAIL (note #509, slice 6): an agent reads and writes its OWNER'S mail.
   *
   * Every route here is keyed on `auth.userId` — the human this agent belongs
   * to — and NOT on the git namespace the notes routes use. A namespace can be
   * shared across a workplace; a mailbox never is. One person's letters are
   * not a team resource, and an agent of a teammate must not reach them.
   *
   * What goes OUT wears the person: the address is theirs, so their name and
   * their address are what the recipient sees, exactly as their agent's commits
   * are pushed under their namespace. What the owner gets in exchange is
   * `sentBy` on the stored row, so their own list says which messages they did
   * not write.
   *
   * The limits are the ones `mail-outbox.ts` already enforces for the screen —
   * ten new messages an hour, thirty a day, four people a message at most (one
   * To, up to three Cc), up to five files (slice 12). An agent is not a second
   * allowance; it writes from the same mailbox and spends the same ceiling.
   * Its files are KEPT when it asks, so the card its owner decides on lists
   * exactly what would leave — by name and size.
   */
  const mailDeps = (res: Response): {
    messages: NonNullable<RouteDeps['mailMessages']>;
    mailboxes: NonNullable<RouteDeps['mailboxes']>;
  } | null => {
    if (!deps.mailMessages || !deps.mailboxes) {
      res.status(503).json({ error: 'Mail is not available on this backend yet.' });
      return null;
    }
    return { messages: deps.mailMessages, mailboxes: deps.mailboxes };
  };

  /** The one sentence an agent whose user has no address should read. */
  const NO_MAILBOX = 'Your user has not taken an address yet. They choose one in their Workspace under Settings → Your address, and from that moment mail sent to it arrives here.';

  const mailRow = (doc: MailMessageDocument) => ({
    id: doc.id,
    direction: doc.direction ?? 'in',
    ...(doc.from ? { from: doc.from } : {}),
    ...((doc.direction ?? 'in') === 'sent' ? { to: doc.to } : {}),
    subject: doc.subject,
    snippet: doc.snippet,
    at: doc.receivedAt,
    files: doc.attachments.length,
    ...(doc.suspicious ? { suspicious: true } : {}),
    ...(doc.parseError ? { unreadable: true } : {}),
    ...(doc.answers ? { answers: doc.answers } : {}),
    ...(doc.sentBy ? { sentBy: doc.sentBy.name ?? 'an agent' } : {}),
    ...(mailPlaceOf(doc) !== 'inbox' ? { place: mailPlaceOf(doc) } : {}),
    ...(mailMovedBy(doc) ? { movedBy: mailMovedBy(doc) } : {}),
    ...(mailPlaceOf(doc) === 'spam' && doc.spamWhy ? { spamWhy: doc.spamWhy } : {}),
    ...(doc.starredAt ? { starred: true } : {}),
    ...(mailStarredBy(doc) ? { starredBy: mailStarredBy(doc) } : {}),
  });

  /**
   * A private copy installs without email (note #946). Until an admin sets
   * it up in the Workspace, every `agentbuilt mail …` answers in one line
   * that says so, instead of an empty inbox or a send that cannot go.
   */
  router.use('/mail', (_req, res, next) => {
    if (deps.copyMail && !deps.copyMail.isOn()) {
      return res.status(409).json({ error: COPY_MAIL_NOT_SET_UP, code: 'mail_not_set_up' });
    }
    return next();
  });

  /**
   * The inbox — or, with `?in=`, the archive, Trash or everything but Trash,
   * and with `?q=`, a search of it (slice 7). The same reads, index and
   * defaults as the owner's own screen: a search with no `in` looks through
   * everything but Trash.
   */
  router.get('/mail', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const mail = mailDeps(res);
    if (!mail) return;
    const mailbox = await mail.mailboxes.forUser(auth.userId).catch(() => null);
    if (!mailbox) return res.status(409).json({ error: NO_MAILBOX, code: 'no_mailbox' });
    const place = readMailView(req.query.in);
    if ('refused' in place) return res.status(400).json({ error: place.refused });
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q : undefined;
    const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const page = await mail.messages.list(auth.userId, {
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(req.query.before ? { before: String(req.query.before) } : {}),
      ...(place.view ? { in: place.view } : {}),
      ...(search ? { search } : {}),
    });
    return res.json({
      address: mailbox.address,
      messages: page.messages.map(mailRow),
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
    });
  });

  /**
   * One conversation as a row (slice 8), named for the CLI: its `id` is the
   * NEWEST message's — the one its first line and clock are about, and what
   * `mail show` reads — and `reply` is the message an answer to it would
   * answer, which is not always the newest (that may be one this person sent).
   */
  const mailConversationRow = (conversation: MailConversation) => {
    const facts = mailConversationFacts(conversation);
    const answering = deps.mailOutbox
      ? mailConversationAnswerable(conversation.messages, (doc) => Boolean(replyRecipient(doc)))
      : null;
    return {
      id: facts.latest.id,
      conversation: facts.thread,
      with: facts.with,
      ...(facts.started ? { started: true } : {}),
      subject: facts.subject,
      snippet: facts.latest.snippet,
      at: facts.latest.receivedAt,
      latest: {
        direction: facts.latest.direction ?? 'in',
        ...(facts.latest.sentBy ? { sentBy: facts.latest.sentBy.name ?? 'an agent' } : {}),
      },
      count: facts.count,
      files: facts.files,
      ...(facts.suspicious ? { suspicious: true } : {}),
      ...(facts.unreadable ? { unreadable: true } : {}),
      ...(facts.place !== 'inbox' ? { place: facts.place } : {}),
      ...(facts.movedBy ? { movedBy: facts.movedBy } : {}),
      ...(facts.spamWhy ? { spamWhy: facts.spamWhy } : {}),
      ...(facts.trashed ? { trashed: facts.trashed } : {}),
      ...(facts.starred ? { starred: true } : {}),
      ...(answering ? { reply: answering.id } : {}),
    };
  };

  /**
   * THE LIST AS CONVERSATIONS (slice 8) — what `mail list` prints since CLI
   * 1.32.0. A route of its own rather than a new answer from `/mail`, so a
   * machine still running an older CLI keeps reading the rows it understands
   * until it updates. Declared before `/mail/:id`, like `/mail/sent`.
   */
  router.get('/mail/conversations', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const mail = mailDeps(res);
    if (!mail) return;
    const mailbox = await mail.mailboxes.forUser(auth.userId).catch(() => null);
    if (!mailbox) return res.status(409).json({ error: NO_MAILBOX, code: 'no_mailbox' });
    const place = readMailPlace(req.query.in);
    if ('refused' in place) return res.status(400).json({ error: place.refused });
    const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const page = await mail.messages.listConversations(auth.userId, {
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(req.query.before ? { before: String(req.query.before) } : {}),
      ...(place.place ? { in: place.place } : {}),
    });
    return res.json({
      address: mailbox.address,
      conversations: page.conversations.map(mailConversationRow),
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
    });
  });

  /**
   * EVERYTHING that has gone out, newest first — replies included.
   *
   * The list above answers "what is in front of me": a reply belongs under the
   * message it answers, so it is not a row there. This answers the other
   * question an agent actually has — "what has this address sent" — which
   * walking the inbox cannot. Declared before `/mail/:id` on purpose: the
   * parser would otherwise read `sent` as a message id.
   */
  router.get('/mail/sent', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const mail = mailDeps(res);
    if (!mail) return;
    const mailbox = await mail.mailboxes.forUser(auth.userId).catch(() => null);
    if (!mailbox) return res.status(409).json({ error: NO_MAILBOX, code: 'no_mailbox' });
    const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const page = await mail.messages.listSent(auth.userId, {
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(req.query.before ? { before: String(req.query.before) } : {}),
    });
    return res.json({
      address: mailbox.address,
      messages: page.messages.map(mailRow),
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
    });
  });

  /** The senders this person has blocked (slice 13) — `mail blocked`.
   *  Before `/mail/:id`, like `/mail/sent`, or `blocked` reads as an id. */
  router.get('/mail/blocked', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const mail = mailDeps(res);
    if (!mail) return;
    const mailbox = await mail.mailboxes.forUser(auth.userId).catch(() => null);
    if (!mailbox) return res.status(409).json({ error: NO_MAILBOX, code: 'no_mailbox' });
    return res.json({ address: mailbox.address, blocked: await mail.messages.blockedSenders(auth.userId) });
  });

  router.get('/mail/:id', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const mail = mailDeps(res);
    if (!mail) return;
    const doc = await mail.messages.get(auth.userId, String(req.params.id ?? ''));
    if (!doc) return res.status(404).json({ error: 'No such message.' });
    const answers = await mail.messages.listAnswers(auth.userId, doc.id).catch(() => []);
    // Who a reply would go to is decided HERE, off the message, exactly as it
    // is for the screen: an agent cannot aim a reply either.
    const answerTo = deps.mailOutbox ? replyRecipient(doc) : null;
    // The rest of its conversation, as ids an agent can `mail show` (slice 8)
    // — who wrote each and when, never their words: one message is shown at
    // a time, and each stranger's words inside its own frame.
    const conversation = await mail.messages.getConversation(auth.userId, doc.id).catch(() => null);
    const answering = conversation && deps.mailOutbox
      ? mailConversationAnswerable(conversation.messages, (one) => Boolean(replyRecipient(one)))
      : null;
    return res.json({
      message: {
        ...(conversation && conversation.messages.length > 1 ? {
          conversation: {
            id: conversation.thread,
            messages: conversation.messages.map((one) => ({
              id: one.id,
              direction: one.direction ?? 'in',
              ...(one.from ? { from: one.from } : {}),
              ...((one.direction ?? 'in') === 'sent' ? { to: one.to } : {}),
              at: one.receivedAt,
              ...(one.sentBy ? { sentBy: one.sentBy.name ?? 'an agent' } : {}),
              ...(mailPlaceOf(one) !== 'inbox' && isMailListRow(one) ? { place: mailPlaceOf(one) } : {}),
            })),
            ...(answering ? { reply: answering.id } : {}),
          },
        } : {}),
        ...mailRow(doc),
        to: doc.to,
        cc: doc.cc,
        replyTo: doc.replyTo,
        ...(doc.text ? { text: doc.text } : {}),
        ...(doc.html ? { html: doc.html } : {}),
        ...(doc.bodyTruncated ? { bodyTruncated: true } : {}),
        ...(doc.authentication ? { authentication: doc.authentication } : {}),
        attachments: doc.attachments.map((file) => ({
          id: file.id, fileName: file.fileName, contentType: file.contentType, size: file.size,
          ...(file.inline ? { inline: true } : {}),
        })),
        rawSize: doc.raw.size,
        replies: answers.map((reply) => ({
          id: reply.id, to: reply.to, text: reply.wrote ?? reply.text ?? '', at: reply.receivedAt,
          ...(reply.sentBy ? { sentBy: reply.sentBy.name ?? 'an agent' } : {}),
        })),
        ...(answerTo ? { answerTo } : {}),
        // Reply to all (slice 12): the letter's other recipients, read off it
        // here exactly as the screen is offered them; `mail reply --all` Ccs
        // them. The To is still `answerTo`, and nothing else can aim it.
        ...(answerTo ? (() => {
          const { all, leftOut } = replyAll(doc, answerTo);
          return all.length ? { answerAll: all, ...(leftOut ? { answerAllLeftOut: leftOut } : {}) } : {};
        })() : {}),
        ...(doc.forwards ? { forwards: doc.forwards } : {}),
      },
    });
  });

  /** One file off a message — or `raw`, the original as it arrived. */
  router.get('/mail/:id/files/:fileId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const mail = mailDeps(res);
    if (!mail) return;
    if (!deps.mediaStorage) {
      return res.status(503).json({ error: 'File storage is not available on this backend yet.' });
    }
    const doc = await mail.messages.get(auth.userId, String(req.params.id ?? ''));
    if (!doc) return res.status(404).json({ error: 'No such message.' });
    const fileId = String(req.params.fileId ?? '');
    const file = fileId === 'raw'
      ? {
        fileName: `${doc.subject.replace(/[^\w .-]+/g, ' ').trim().slice(0, 60) || 'message'}.eml`,
        contentType: 'message/rfc822',
        storagePath: doc.raw.storagePath,
      }
      : doc.attachments.find((entry) => entry.id === fileId);
    // A message we composed has no original of its own, so `raw` on one is a
    // missing file rather than an empty download.
    if (!file || !file.storagePath) return res.status(404).json({ error: 'No such file on this message.' });
    const access = await deps.mediaStorage.createReadAccess({
      storagePath: file.storagePath,
      expiresInMs: 15 * 60_000,
    });
    return res.json({ url: access.url, fileName: file.fileName, expiresAt: access.expiresAt });
  });

  /**
   * Archive, Trash and their undos (slice 7) — the one kind of change an
   * agent makes to its owner's mail without asking, because every one of
   * them is undone by another and nothing is removed: Trash is a place, and
   * there is no route here that deletes a letter for good.
   *
   * The agent's NAME rides the move, so the owner's own list says "archived
   * by Ruby" on a letter they never touched. That matters more here than
   * anywhere: a stranger's message can ask an agent to hide another one, and
   * this is how its owner would see that it had.
   */
  const moveMail = (move: MailMove) => async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const mail = mailDeps(res);
    if (!mail) return;
    const name = auth.agents[auth.agentId]?.name ?? (auth.purpose ? WORKSPACE_AGENT_NAME : undefined);
    const outcome = await mail.messages.move(auth.userId, String(req.params.id ?? ''), move, {
      atIso: new Date().toISOString(),
      by: { agentId: auth.agentId, ...(name ? { name } : {}) },
    });
    if ('refused' in outcome) {
      const refusal = mailMoveRefusal(outcome);
      return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
    }
    // One letter of a conversation moved alone: say how big the conversation
    // is, so the CLI can say the rest of it stayed where it was (slice 8).
    const conversation = await mail.messages.getConversation(auth.userId, outcome.doc.id).catch(() => null);
    return res.json({
      moved: outcome.moved,
      message: mailRow(outcome.doc),
      ...(conversation && conversation.messages.length > 1
        ? { conversation: { id: conversation.thread, count: conversation.messages.length } }
        : {}),
    });
  };
  router.post('/mail/:id/archive', moveMail('archive'));
  router.post('/mail/:id/unarchive', moveMail('unarchive'));
  router.post('/mail/:id/spam', moveMail('spam'));
  router.post('/mail/:id/unspam', moveMail('unspam'));
  router.post('/mail/:id/trash', moveMail('trash'));
  router.post('/mail/:id/restore', moveMail('restore'));

  /**
   * The same four moves for a WHOLE conversation (slice 8) — `mail archive
   * <id> --conversation`, where `<id>` is any message in it. What the
   * owner's own screen does from a conversation, with the agent's name on
   * every letter it moved, exactly as a single move carries it.
   */
  const moveMailConversation = (move: MailMove) => async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const mail = mailDeps(res);
    if (!mail) return;
    const name = auth.agents[auth.agentId]?.name ?? (auth.purpose ? WORKSPACE_AGENT_NAME : undefined);
    const outcome = await mail.messages.moveConversation(auth.userId, String(req.params.id ?? ''), move, {
      atIso: new Date().toISOString(),
      by: { agentId: auth.agentId, ...(name ? { name } : {}) },
    });
    if ('refused' in outcome) {
      const refusal = mailMoveRefusal(outcome, 'conversation');
      return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
    }
    return res.json({ moved: outcome.moved, conversation: mailConversationRow(outcome.conversation) });
  };
  router.post('/mail/conversations/:id/archive', moveMailConversation('archive'));
  router.post('/mail/conversations/:id/unarchive', moveMailConversation('unarchive'));
  router.post('/mail/conversations/:id/spam', moveMailConversation('spam'));
  router.post('/mail/conversations/:id/unspam', moveMailConversation('unspam'));
  router.post('/mail/conversations/:id/trash', moveMailConversation('trash'));
  router.post('/mail/conversations/:id/restore', moveMailConversation('restore'));

  /**
   * STARS (note #666) — `mail star <id>` and `mail unstar <id>`, with
   * `--conversation` for what a conversation's row does on the owner's own
   * screen. A star moves nothing, and the agent's name rides it the way it
   * rides a move: a letter starred by an agent says so on its owner's list.
   */
  const starMail = (starred: boolean, whole: boolean) => async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const mail = mailDeps(res);
    if (!mail) return;
    const name = auth.agents[auth.agentId]?.name ?? (auth.purpose ? WORKSPACE_AGENT_NAME : undefined);
    const outcome = await mail.messages.star(auth.userId, String(req.params.id ?? ''), {
      starred, whole, atIso: new Date().toISOString(),
      by: { agentId: auth.agentId, ...(name ? { name } : {}) },
    });
    if ('refused' in outcome) {
      const refusal = mailStarRefusal(outcome);
      return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
    }
    return res.json({
      changed: outcome.changed,
      message: mailRow(outcome.doc),
      conversation: mailConversationRow(outcome.conversation),
    });
  };
  router.post('/mail/:id/star', starMail(true, false));
  router.post('/mail/:id/unstar', starMail(false, false));
  router.post('/mail/conversations/:id/star', starMail(true, true));
  router.post('/mail/conversations/:id/unstar', starMail(false, true));

  /**
   * BLOCKED SENDERS (slice 13) — `mail blocked`, `mail block <address>` and
   * `mail unblock <address>`. The agent's name rides the block, as it rides
   * every move: a letter that left its owner's inbox because an agent blocked
   * its sender says so on their own screen. The list is declared BEFORE
   * `/mail/:id`, beside `/mail/sent`, or the parser reads `blocked` as a
   * message id — which is exactly what happened in production the day this
   * shipped, and a test now pins the order.
   */

  router.post('/mail/blocked', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const mail = mailDeps(res);
    if (!mail) return;
    const mailbox = await mail.mailboxes.forUser(auth.userId).catch(() => null);
    if (!mailbox) return res.status(409).json({ error: NO_MAILBOX, code: 'no_mailbox' });
    const address = mailSenderKey(String((req.body as { address?: unknown } | undefined)?.address ?? ''));
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) return res.status(400).json({ error: 'That is not an email address.', code: 'bad_address' });
    if (mailSenderKey(mailbox.address) === address) return res.status(400).json({ error: 'That is your user\'s own address.', code: 'own_address' });
    const name = auth.agents[auth.agentId]?.name ?? (auth.purpose ? WORKSPACE_AGENT_NAME : undefined);
    const outcome = await mail.messages.blockSender(auth.userId, address, {
      atIso: new Date().toISOString(),
      by: { agentId: auth.agentId, ...(name ? { name } : {}) },
    });
    return res.json({ address: mailbox.address, blocked: outcome.addresses, moved: outcome.moved });
  });

  // A POST, not a DELETE: nothing under /mail answers DELETE, and a test
  // holds it there — the one verb an agent must never have on its owner's
  // mail is the one that removes something. Unblocking removes a decision,
  // not a letter, but the rule is worth more than the verb.
  router.post('/mail/unblock', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const mail = mailDeps(res);
    if (!mail) return;
    const mailbox = await mail.mailboxes.forUser(auth.userId).catch(() => null);
    if (!mailbox) return res.status(409).json({ error: NO_MAILBOX, code: 'no_mailbox' });
    const address = mailSenderKey(String((req.body as { address?: unknown } | undefined)?.address ?? ''));
    if (!address.includes('@')) return res.status(400).json({ error: 'That is not an email address.', code: 'bad_address' });
    const blocked = await mail.messages.unblockSender(auth.userId, address);
    return res.json({ address: mailbox.address, blocked });
  });

  /** What rides the From line, and what the owner is shown afterwards. */
  const mailSender = async (auth: AgentAuth): Promise<{ senderName?: string; sentBy: SentByAgent }> => {
    const profile = deps.userStorage ? await deps.userStorage.getProfile(auth.userId).catch(() => null) : null;
    const person = profile?.person;
    const senderName = [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim();
    const name = auth.agents[auth.agentId]?.name;
    return {
      ...(senderName ? { senderName } : {}),
      sentBy: { agentId: auth.agentId, ...(name ? { name } : {}) },
    };
  };

  const mailApprovalFailure = (error: unknown, res: Response): Response => {
    if (error instanceof MailOutboxError) {
      const status = error.code === 'no_such_message' ? 404
        : error.code === 'too_many' ? 429
          : error.code === 'files_unavailable' ? 503
            : error.code === 'not_replyable' || error.code === 'no_mailbox' || error.code === 'not_forwardable' ? 409 : 400;
      const said = error.code === 'no_mailbox' ? NO_MAILBOX : error.message;
      return res.status(status).json({ error: said, code: error.code });
    }
    // Request creation never calls the provider. Be explicit about both
    // halves: the card failed, and no mail left the account.
    console.error('[agent-cli] mail approval request failed:', error);
    return res.status(500).json({ error: 'The approval could not be created. Nothing was sent.' });
  };

  /** Put the ask in the conversation this credential belongs to. */
  const deliverMailApproval = async (
    auth: AgentAuth,
    approval: Pick<MailApprovalDocument, 'id' | 'kind' | 'to' | 'cc' | 'files'>,
  ): Promise<boolean> => {
    const name = auth.agents[auth.agentId]?.name ?? (auth.purpose ? WORKSPACE_AGENT_NAME : 'This agent');
    const others = approval.cc?.length ? ` and ${approval.cc.length} more` : '';
    const files = approval.files?.length ? `, with ${approval.files.length === 1 ? 'a file' : `${approval.files.length} files`}` : '';
    const what = approval.kind === 'reply' ? `reply to ${approval.to.address}`
      : approval.kind === 'forward' ? `forward a letter to ${approval.to.address}`
        : `send email to ${approval.to.address}`;
    const text = `${name} wants to ${what}${others}${files}. Nothing will be sent until you approve it here.`;
    return auth.purpose
      ? Boolean(auth.orgId && await deps.workspaceAgent?.requestMailApproval?.({
        userId: auth.userId, orgId: auth.orgId, approvalId: approval.id, text,
      }))
      : Boolean(await deps.agentLifecycle?.requestMailApproval?.({
        userId: auth.userId, agentId: auth.agentId, approvalId: approval.id, text,
      }));
  };

  /** Words only, the body is JSON; with `--attach` it is the upload
   *  envelope (slice 12) — see mail-upload.ts. */
  const mailUpload = raw({ type: MAIL_UPLOAD_CONTENT_TYPE, limit: MAIL_UPLOAD_MAX_BYTES });

  /** Place the card, or withdraw the request (and its kept files), and say
   *  which in the one sentence the CLI prints. */
  const placeMailApproval = async (
    auth: AgentAuth, res: Response, approval: MailApprovalDocument, said: string,
  ): Promise<Response> => {
    if (!await deliverMailApproval(auth, approval)) {
      await deps.mailApprovals!.withdraw(auth.userId, approval.id);
      return res.status(503).json({ error: 'The approval could not be placed in your conversation. Nothing was sent.' });
    }
    const others = approval.cc?.length ? ` (Cc ${approval.cc.map((party) => party.address).join(', ')})` : '';
    const files = approval.files?.length ? ` with ${approval.files.length === 1 ? '1 file' : `${approval.files.length} files`}` : '';
    return res.status(202).json({
      approval: { id: approval.id, to: approval.to.address },
      said: `${said} to ${approval.to.address}${others}${files}. Nothing was sent.`,
    });
  };

  const mailRequester = async (auth: AgentAuth) => {
    const identity = await mailSender(auth);
    return {
      userId: auth.userId,
      agentId: auth.agentId,
      requestedBy: identity.sentBy.name ?? (auth.purpose ? WORKSPACE_AGENT_NAME : 'This agent'),
      ...(auth.orgId ? { orgId: auth.orgId } : {}),
      ...(identity.senderName ? { senderName: identity.senderName } : {}),
    };
  };

  router.post('/mail/send', mailUpload, async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailApprovals) return res.status(503).json({ error: 'Mail approvals are not available on this backend yet.' });
    const upload = readMailUpload(req.body);
    if ('error' in upload) return res.status(400).json({ error: upload.error });
    try {
      const approval = await deps.mailApprovals.requestSend({
        ...await mailRequester(auth),
        to: upload.fields.to,
        cc: upload.fields.cc,
        subject: upload.fields.subject,
        text: String(upload.fields.text ?? ''),
        files: upload.files,
      });
      return await placeMailApproval(auth, res, approval, 'Approval requested in your chat for email');
    } catch (error) {
      return mailApprovalFailure(error, res);
    }
  });

  router.post('/mail/:id/reply', mailUpload, async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailApprovals) return res.status(503).json({ error: 'Mail approvals are not available on this backend yet.' });
    const upload = readMailUpload(req.body);
    if ('error' in upload) return res.status(400).json({ error: upload.error });
    try {
      const approval = await deps.mailApprovals.requestReply({
        ...await mailRequester(auth),
        messageId: String(req.params.id ?? ''),
        text: String(upload.fields.text ?? ''),
        cc: upload.fields.cc,
        files: upload.files,
      });
      return await placeMailApproval(auth, res, approval, 'Approval requested in your chat for a reply');
    } catch (error) {
      return mailApprovalFailure(error, res);
    }
  });

  /**
   * Forward one of the owner's letters (slice 12). `carry` names which of its
   * files go — absent, all of them — and `--attach` adds the agent's own. It
   * spends the NEW allowance, and like everything else here it sends nothing:
   * it places the card.
   */
  router.post('/mail/:id/forward', mailUpload, async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailApprovals) return res.status(503).json({ error: 'Mail approvals are not available on this backend yet.' });
    const upload = readMailUpload(req.body);
    if ('error' in upload) return res.status(400).json({ error: upload.error });
    try {
      const approval = await deps.mailApprovals.requestForward({
        ...await mailRequester(auth),
        messageId: String(req.params.id ?? ''),
        to: upload.fields.to,
        cc: upload.fields.cc,
        text: String(upload.fields.text ?? ''),
        ...(upload.fields.carry !== undefined ? { carry: upload.fields.carry } : {}),
        files: upload.files,
      });
      return await placeMailApproval(auth, res, approval, 'Approval requested in your chat for a forward');
    } catch (error) {
      return mailApprovalFailure(error, res);
    }
  });

  return router;
}

/**
 * Available variants of a taken name: numbered first (`ember-2` … `ember-9`,
 * the natural human choice), then short random suffixes as the fallback that
 * practically always finds a free slot. Exported for tests.
 */
export async function suggestAlternateNames(
  storage: Pick<NonNullable<RouteDeps['deploymentStorage']>, 'getByName'>,
  name: string,
  count = 3,
  /**
   * Who is asking. A deleted site keeps its address reserved to the account
   * that held it, so a tombstone is free ground for its OWN owner and taken
   * for everybody else — without this, the suggestions would cheerfully offer
   * a name the deploy path is about to refuse.
   */
  ownerId?: string,
): Promise<string[]> {
  const candidates: string[] = [];
  for (let n = 2; n <= 9; n += 1) candidates.push(`${name}-${n}`);
  for (let i = 0; i < 5; i += 1) candidates.push(`${name}-${randomBytes(2).toString('hex')}`);
  const available: string[] = [];
  for (const candidate of candidates) {
    if (available.length >= count) break;
    if (validateDeploymentName(candidate) !== null) continue;
    const existing = await storage.getByName(candidate);
    if (!existing) {
      available.push(candidate);
      continue;
    }
    if (existing.status === 'destroyed' && ownerId && existing.userId === ownerId) {
      available.push(candidate);
    }
  }
  return available;
}

/**
 * What a deploy answers once the name is reserved and the content is staged:
 * the build is already running. Nothing to pay, nothing to relay, and no
 * checkout link — the site comes up on its own, and the user gets a message
 * the moment its address answers.
 */
async function bringUpResponse(
  deps: RouteDeps,
  doc: DeploymentDocument,
  url: string,
  quota: {
    static: { used: number; limit: number | null };
    service: { used: number; limit: number | null };
    /** The workplace's one ceiling, live + provisioning sites together. */
    sites?: { used: number; limit: number };
  },
) {
  const started = deps.hostingFulfilment
    ? await deps.hostingFulfilment.startBringUp(doc.id)
    : 'unknown';
  const message = (() => {
    if (started === 'unknown') {
      return `"${doc.name}" is reserved and its content is staged, but this backend can't build sites right now.`
        + ' An operator has to look — nothing is lost, and the next deploy picks up where this stopped.';
    }
    if (started === 'resuming') {
      return `${doc.name} is starting back up with the new content — it should answer at ${url} in a minute or so.`;
    }
    if (started === 'already-live') {
      // Two deploys raced, or a build finished between the read and here.
      return `${doc.name} is already serving at ${url}.`;
    }
    return `${doc.name} is being built now — it usually answers at ${url} within a couple of minutes`
      + ' (the address itself can take a few more the very first time). Your user gets a message the moment it is live.'
      + ' Hosting is included; there is nothing to pay and no link to relay.';
  })();
  return {
    deployment: {
      name: doc.name,
      preset: doc.preset,
      kind: siteKindForPreset(doc.preset),
      status: started === 'unknown' ? doc.status : 'provisioning',
      url,
      createdAt: doc.createdAt,
    },
    quota,
    message,
  };
}

/** `{ cpu_kind, cpus, memory_mb }` as a daemon posts it, or nothing. */
function parseStatusMachineGuest(raw: unknown): GitCommitStatusMachine | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const guest = raw as { cpu_kind?: unknown; cpus?: unknown; memory_mb?: unknown };
  const cpus = Number(guest.cpus);
  const memoryMb = Number(guest.memory_mb);
  if (typeof guest.cpu_kind !== 'string' || !guest.cpu_kind || !Number.isFinite(cpus) || !Number.isFinite(memoryMb)) return undefined;
  return { cpuKind: guest.cpu_kind.slice(0, 32), cpus, memoryMb };
}
