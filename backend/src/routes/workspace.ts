import { WorkspaceRecapChat, RecapChatError, recapChatFilePath, type RecapScope } from '../services/workspace-recap-chat.js';
import { AUTO_APPROVE_HISTORY_MAX, type WorkplaceAutoApprove } from '../shared/auto-approve.js';
import { WorkspaceAgentEventSweep } from '../services/workspace-agent-events.js';
import { isHarnessCli, seatNoReadingNotice, subscriptionName } from '../shared/harness-clis.js';
import { applyWorkspaceAgentProactiveChange, resolveWorkspaceAgentProactive, type WorkspaceAgentProactiveAnswer } from '../shared/workspace-agent-proactive.js';
import { WORKSPACE_AGENT_CHAT_ID, type RecapChatStopAnswer } from '../shared/workspace-recap-chat.js';
import { cleanFirstVisit } from '../shared/first-visit.js';
import { registerDirectMessageRoutes } from './direct-messages.js';
import { availableRecapModels, recapCandidates, resolveRecapSettings, validRecapSettings } from '../services/workspace-recap-settings.js';
import type { WorkspaceRecapSettingsAnswer } from '../shared/workspace-recap.js';
import { WorkspaceRecapCoordinator, appendRecapHistory, buildWorkspaceRecapPrompt, previousRecaps, recapFingerprint, selectRecapSources, RECAP_WINDOW_MS } from '../services/workspace-recap.js';
import { collectWorkspaceRecapSources } from '../services/workspace-recap-sources.js';
import type { WorkspaceAgentDetailsAnswer, WorkspaceRecapAnswer } from '../shared/workspace-recap.js';
import type { RecapChatAnswer, RecapForwardedProposalRef, WorkspaceForwardedProposal } from '../shared/workspace-recap-chat.js';
import { registerDriveRoutes } from './drive.js';
import { registerRadioRoutes } from './radio.js';
import { Router, raw, type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { MailboxError } from '../services/mailbox-service.js';
import type { AgentWorkLedger } from '../services/agent-work-ledger.js';
import { tokenWeeks, tokenWeeksSince } from '../services/agent-token-ledger.js';
import { Leaderboard, hasBuilderPage } from '../services/leaderboard.js';
import { WorkplaceContributions, cardContribution, memberContributionAnswer } from '../services/workplace-contribution.js';
import { FOUNDER_HANDLE } from '../shared/handles.js';
import { normalizeXHandle } from '../shared/leaderboard.js';
import {
  PUBLIC_GUIDE_LIMITS,
  type PublicAskAnswer,
  type PublicAskStatus,
  type PublicGuideOverview,
  type WorkspacePublicGuideVisitAnswer,
  type WorkspacePublicGuideVisitsAnswer,
} from '../shared/public-guide.js';
import { isSealedAgent } from '../types/user.js';
import type {
  WorkspaceMailAddressClaimAnswer,
  WorkspaceMailApproval,
  WorkspaceMailApprovalAnswer,
  WorkspaceMailConversationAnswer,
  WorkspaceMailConversationMoveAnswer,
  WorkspaceMailStarAnswer,
  WorkspaceMailConversationSummary,
  WorkspaceMailConversationsAnswer,
  WorkspaceMailBlockAnswer,
  WorkspaceMailBlockedSendersAnswer,
  WorkspaceMailImageSendersAnswer,
  WorkspaceMailMessageAnswer,
  WorkspaceMailMessageSummary,
  WorkspaceMailMessagesAnswer,
  WorkspaceMailMoveAnswer,
  WorkspaceMailPlace,
  WorkspaceMailReply,
  WorkspaceMailReplyAnswer,
  WorkspaceMailSendAnswer,
  WorkspaceMailForwardAnswer,
  WorkspaceMailThreadMessage,
  WorkspaceMailUnreadAnswer,
  WorkspaceMailWakeAnswer,
  WorkspaceMailWakeCandidate,
} from '../shared/workspace-mail.js';
import { MAIL_UPLOAD_CONTENT_TYPE, mailAddress } from '../shared/workspace-mail.js';
import { handleProblem } from '../shared/handles.js';
import { agentWorkFinished, FRESH_CHAT_MESSAGE, freshChatRefusal } from '../shared/fresh-chats.js';
import { turnRecapOf } from '../shared/turn-recap.js';
import { MailOutboxError, replyAll, replyRecipient } from '../services/mail-outbox.js';
import { MAIL_UPLOAD_MAX_BYTES, readMailUpload } from '../services/mail-upload.js';
import { MailSendError } from '../services/mail-sender.js';
import type { MailConversation, MailMessageDocument, MailMove, MailPartyRef } from '../services/mail-message-storage.js';
import { mailConversationAnswerable, mailConversationFacts } from '../services/mail-threads.js';
import { mailMoveRefusal, mailMovedBy, mailPlaceOf, mailStarRefusal, mailStarredBy, readMailPlace, readMailView } from '../services/mail-places.js';
import { mailHtmlNamesImage, mailSenderKey } from '../services/mail-pictures.js';
import { fetchMailRemoteImage } from '../services/mail-remote-image.js';
import { HOSTED_AGENT_LIMIT, HOSTED_SITE_LIMIT, isAdminAccount } from '../config/access.js';
import { hostedFootprint, hostedSpendRefusal, hostedUsage, isHostedWorkplace, type HostedUsage } from '../services/hosted-workplace.js';
import type { RouteDeps } from './deps.js';
import { WORKSPACE_BASE, canonicalWorkspacePath, workspacePublicPathPatterns, workspaceRoutePath, workspaceShellPathPatterns } from '../shared/workspace-routes.js';
import { publicAddress } from './workspace-root.js';
import {
  type WorkspaceAgentCardAnswer,
  type WorkspaceAgentCreatedAnswer,
  type WorkspaceAgentDeletedAnswer,
  type WorkspaceAgentMachineAnswer,
  type WorkspaceAgentMachineWritten,
  type WorkspaceAgentJobsAnswer,
  type WorkspaceAgentProposalsAnswer,
  type WorkspaceDecisionsAnswer,
  type WorkspaceAgentSeatAnswer,
  type WorkspaceAgentRuntimeAnswer,
  type WorkspaceAgentRuntimeWritten,
  type WorkspaceAgentStatus,
  type WorkspaceAgentStopAnswer,
  type WorkspaceAgentVersionAnswer,
  type WorkspaceAgentsLiveAnswer,
  type WorkspaceChatAnswer,
  type WorkspaceChatFile,
  type WorkspaceChatFileAccessAnswer,
  type WorkspaceChatFileTextAnswer,
  type WorkspaceChatLatestAnswer,
  type WorkspaceChatSendAnswer,
  type WorkspaceIdleMessageAnswer,
  type WorkspaceFreshChatsAnswer,
  type WorkspaceFreshChatsRequest,
  type WorkspaceOrgMember,
  type WorkspaceOrgMemberAgent,
  type WorkspaceOrgCloudAnswer,
  type WorkspaceOrgDetail,
  type WorkspaceOrgFlyAnswer,
  type WorkspaceOrgFlyMoveAsked,
  type WorkspaceOrgAgentMachineAnswer,
  type WorkspaceOrgAutoApproveAnswer,
  type WorkspacePeopleAnswer,
  type WorkspaceTokenUsageAnswer,
  type WorkspacePeopleLiveAnswer,
  type WorkspaceMemberContributionAnswer,
  type WorkspacePersonLive,
  type WorkspaceCommentPostAnswer,
  type WorkspaceEnrollmentFinishAnswer,
  type WorkspaceEmailLoginAnswer,
  type WorkspaceEmailLinkAnswer,
  type WorkspaceEmailPasswordAnswer,
  type WorkspacePasswordForgotAnswer,
  type WorkspacePasswordResetAnswer,
  type WorkspaceRecoveryEmailAnswer,
  type WorkspaceRecoveryEmailConfirmAnswer,
  type WorkspaceRecoveryEmailRemoveAnswer,
  type WorkspaceEmailRegisterAnswer,
  type WorkspaceEmailVerificationFinishAnswer,
  type WorkspaceEmailVerificationResendAnswer,
  type WorkspaceFileAccessAnswer,
  type WorkspaceKnowledgeDecisionAnswer,
  type WorkspaceKnowledgePageAnswer,
  type WorkspaceKnowledgePageRow,
  type WorkspaceKnowledgeRestoreAnswer,
  type WorkspaceKnowledgeVersionRow,
  type WorkspaceKnowledgeProposalDetailAnswer,
  type WorkspaceKnowledgeProposalRow,
  type WorkspaceNoteArchiveAnswer,
  type WorkspaceNoteDetailAnswer,
  type WorkspaceNoteFilesAnswer,
  type WorkspaceNoteHandoffAnswer,
  type WorkspaceNoteListAnswer,
  type WorkspaceNoteRow,
  type WorkspaceNoteWork,
  type WorkspaceNoteWriteAnswer,
  type WorkspaceNotificationsAnswer,
  type WorkspaceNotificationsReadAnswer,
  type WorkspaceProposalDecisionAnswer,
  type WorkspaceProposalDeliveryAnswer,
  type WorkspaceProposalDetailAnswer,
  type WorkspaceProposalRow,
  type WorkspaceRepoChecksAnswer,
  type WorkspaceRepoCommitAnswer,
  type WorkspaceRepoContributorsAnswer,
  type WorkspaceRepoFileAnswer,
  type WorkspaceRepoPublicAccessAnswer,
  type WorkspaceRepoRow,
  type WorkspaceRepoTreeAnswer,
  type WorkspacePublicAddressAnswer,
  type WorkspacePublicPersonAnswer,
  type WorkspaceAppCatalogueAnswer,
  type WorkspaceAppCatalogueEntry,
  type WorkspaceXProfileSettings,
  type WorkspacePublicPersonRepo,
  type WorkspacePublicWorkplaceAnswer,
  type WorkspacePublicRepoTreeAnswer,
  type WorkspacePublicRepoFileAnswer,
  type WorkspacePublicRepoCommitsAnswer,
  type WorkspacePublicRepoCommitAnswer,
  type WorkspacePublicRepoProposalRow,
  type WorkspacePublicRepoProposalsAnswer,
  type WorkspacePublicRepoProposalDoorAnswer,
  type WorkspacePublicRepoAboutAnswer,
  type WorkspaceStateAnswer,
  type WorkspaceTeamAgentRow,
  type WorkspaceNoteLiveClaim,
  type WorkspaceEnrollmentStartAnswer,
  type WorkspaceLoginAnswer,
  type WorkspaceRecoveryAnswer,
  type WorkspaceSessionAnswer,
  type WorkspaceSecondFactorAnswer,
  type WorkspaceSeatUsage,
  type WorkspaceBucketRow,
  type WorkspaceBucketUsageAnswer,
  type WorkspaceBucketNamedAnswer,
  type WorkspaceSiteCostsAnswer,
  NO_SUCH_REPOSITORY,
} from '../shared/workspace-api.js';
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from '../utils/totp.js';
import {
  DEFAULT_WORKSPACE_UI_DIR,
  handleRetiredWorkspaceUiSwitch,
  loadWorkspaceUiShell,
  sendWorkspaceUiShell,
  workspaceUiAssetRoutes,
} from './workspace-ui.js';
import {
  SHARED_USER_SECRET_SCOPE,
  UserSecretsService,
  SECRET_ROOMS_GONE,
  type UserSecretAudience,
  agentUserSecretScope,
  validateUserSecretAudience,
} from '../services/user-secrets.js';
import {
  GIT_REPO_MAX_BYTES,
  GIT_USER_MAX_BYTES,
  gitUserMaxBytesForVolume,
  nextContributors,
  repoCiSecretsNamespaceId,
 type GitRepoDocument } from '../types/git-repo.js';
import type { RepoContributors } from '../types/git-repo.js';
import { bucketPublicUrl } from '../types/storage-bucket.js';
import { DEPLOYMENT_NAME_PATTERN, siteIsListed, siteKindForPreset } from '../types/deployment.js';
import { SiteFavicons } from '../services/site-favicon.js';
import { SiteCostReader } from '../services/site-costs.js';
import { mintHumanGitToken } from '../services/human-git-token.js';
import { inferContentType, SESSION_ATTACHMENT_MAX_BYTES } from '../services/session-attachments.js';
import { imageDimensions } from '../utils/image-dimensions.js';
import { canServeInline, isInlineImageFile } from '../shared/inline-files.js';
import { VoiceTranscriptionError } from '../services/voice-transcription-service.js';
import { OrgSpendError } from '../services/org-spend.js';
import {
  AGENT_CHAT_MESSAGE_MAX_BYTES,
  agentChatAttachmentPath,
  agentChatFileSetRefusal,
  agentChatStorageOwner,
  agentChatStoragePrefix,
  validateAgentChatAttachment,
  type AgentChatMessage,
  type AgentChatUpload,
} from '../services/agent-chat-storage.js';
import { ChatFileUploadError, ChatFileUploads, isChatUploadId, type ChatFileUploadPlace } from '../services/chat-file-uploads.js';
import { composeSeedAgentRecap } from '../services/agent-recap.js';
import { deleteRepoNow, isRestorableRepo } from '../services/git-repo-admin.js';
import type { GitPullRequestDocument, PullRequestAttachment } from '../types/git-pr.js';
import { CopyMailSetupError } from '../services/copy-mail-setup.js';
import { CopyUpgradeRefused } from '../services/copy-upgrade.js';
import type { WorkspaceCopyMailProviderInput } from '../shared/workspace-api.js';
import { LICENSE_FILE, detectLicense, readmeDescription } from '../shared/licenses.js';
import { orgKnowledgeShelfNamespace, type GitNamespace } from '../services/org-git.js';
import { pickNumbered, workplaceNumberSeries, type NumberSeries } from '../services/workplace-numbers.js';
import { WorkplaceDeletionService } from '../services/workplace-deletion.js';
import {
  COMMENT_AUTHOR_USER,
  COMMENT_HTML_LABELS,
  COMMENT_MAX_LENGTH,
  COMMENT_MAX_TEXT_LENGTH,
  MAX_COMMENTS,
  newMarginComment,
  validateMarginComment,
  type MarginComment,
} from '../types/comment.js';
import type {
  KnowledgePageAttachment,
  KnowledgePageSummary,
  KnowledgeProposalDocument,
} from '../types/knowledge.js';
import {
  knowledgeProposalAwaitsDecision,
  MAX_KNOWLEDGE_DECISION_NOTE_LENGTH,
  knowledgeProposalTakesComments,
  readKnowledgePageMeta,
  validateKnowledgePageName,
} from '../types/knowledge.js';
import { KnowledgeService, describeKnowledgeChanges } from '../services/knowledge-service.js';
import { moveMarginsForLandedChanges } from '../services/knowledge-page-comments.js';
import type { QuickNoteClaim, QuickNoteComment, QuickNoteDocument, QuickNoteHandoff } from '../types/quick-note.js';
import { NoteFileUploadError, NoteFileUploads } from '../services/note-file-uploads.js';
import type { QuickNoteStorage } from '../services/quick-note-storage.js';
import { UPLOAD_PART_BYTES } from '../shared/uploads.js';
import {
  QUICK_NOTES_MAX_PER_USER,
  QUICK_NOTE_ATTACHMENT_MAX_BYTES,
  QUICK_NOTE_SINGLE_UPLOAD_MAX_BYTES,
  QUICK_NOTE_AUTHOR_USER,
  QUICK_NOTE_HANDOFF_WINDOW_MS,
  QUICK_NOTE_MAX_LENGTH,
  QUICK_NOTE_MAX_TEXT_LENGTH,
  activeQuickNoteClaim,
  quickNoteAttachmentPath,
  quickNoteCommentPreview,
  quickNoteEditableText,
  quickNoteIsArchived,
  quickNoteIsUsers,
  quickNoteStoragePrefix,
  quickNoteTitle,
  summarizeQuickNote,
  validateQuickNoteAttachment,
  validateQuickNoteHtml,
} from '../types/quick-note.js';
import {
  QUICK_NOTE_SEARCH_LIMIT,
  quickNoteSearchSnippet,
  quickNoteSearchTerms,
} from '../types/quick-note-search.js';
import { editableTextFromSafeHtml, textToSafeHtml } from '../types/safe-html.js';
import {
  pullRequestAwaitsDecision,
  MAX_PR_DECISION_NOTE_LENGTH,
  pullRequestRoomNamespaceId,
  pullRequestQuickNoteNumbers,
  pullRequestStoragePrefix,
  pullRequestTakesComments,
} from '../types/git-pr.js';
import type { GitCommitStatusDocument } from '../types/git-commit-status.js';
import { GIT_COMMIT_STATUS_NOT_PASSING, effectiveStatusState, worstCheckState } from '../types/git-commit-status.js';
import { ORG_GIT_VOLUME_GB, ORG_GIT_VOLUME_GROW_GB } from '../services/org-git-host.js';
import {
  mergedProposalIsLive,
  resolveQuickNoteWorkMap,
  type QuickNoteWork,
} from '../services/quick-note-work.js';
import {
  modelCatalogForCli,
  planRuntimeChange,
  resolveEffectiveEffort,
  resolveEffectiveModel,
} from '../agent/harness-models.js';

// The org-git-backup sweep's cadence — same env and default as index.ts reads.
const ORG_GIT_BACKUP_INTERVAL_HOURS = Number(process.env.ORG_GIT_BACKUP_INTERVAL_MS || 6 * 60 * 60_000) / 3_600_000;
import { COST_ESTIMATE_DISCLAIMER, VOLUME_GB_MONTHLY_USD } from '../config/fly-cost-estimates.js';
import {
  effectiveAgentMachineSize, agentMachineSizeById, pricedAgentMachineSizes,
} from '../config/agent-machine-sizes.js';
import { resolveContextUsage } from '../utils/context-window.js';
import {
  PERSON_NAME_MAX_LENGTH,
  PROFILE_PHOTO_CONTENT_TYPES,
  PROFILE_PHOTO_MAX_BYTES,
  isSupportedAgentCli,
  isWorkspaceAgent,
  listAgents,
  personDisplayName,
  personPhotoPath,
  personProfileIncomplete,
  type PersonPhotoState,
  type AgentRecord,
  type UserProfileDocument,
  WORKSPACE_AGENT_NAME,
} from '../types/user.js';
import {
  WORKSPACE_AGENT_AVATAR_SLUG,
  readTelegramAgentAvatar,
  readWorkspaceAgentAvatar,
  telegramAgentAvatarSlug,
  workspaceAgentAvatarSlug,
} from '../services/telegram-agent-avatars.js';
import { type OrgStorage } from '../services/org-storage.js';
import { orgAdminSeats } from '../services/org-admin-seats.js';
import { isLiveSeatStatus, memberHasLiveSeat } from '../services/org-seat-signin.js';
import { firstRunGreeting, joinerDoingLine, joinerWelcome, JOINER_WELCOME_LIMITS, JOINER_WELCOME_SINCE } from '../shared/first-run.js';
import { seatUsageCacheIsStale, seatWindowReading, workspaceSeatUsageRows } from '../services/workspace-seat-usage.js';
import {
  PERSON_SEEN_STAMP_MS,
  personActionLines,
  personLiveFields,
} from '../services/person-recap.js';
import {
  orgAvatarPath,
  type OrgDocument,
  type OrgMembershipDocument,
  type OrgSeatDocument,
} from '../types/org.js';
import {
  buildHarnessSandboxId,
  formatUsagePlan, formatUsageReset,
  sortUsageWindows,
  type TelegramAgentVersionSeed,
} from '../services/agent-service.js';
import { compressResponses } from '../utils/http-compression.js';
import { RateLimiter } from '../services/rate-limiter.js';
import { scheduleView } from '../types/agent-schedule.js';
import type { WorkspaceAgentScheduleAnswer, WorkspaceScheduleDecision } from '../shared/workspace-api.js';
import {
  WorkspaceWebAuthError,
  workspaceEmailVerificationStatus,
  type WorkspaceWebSessionDocument,
} from '../services/workspace-web-auth.js';
import {
  clearWorkspaceSessionCookies,
  isSafeHttpMethod,
  requestHasValidCsrf,
  requestHasWorkspaceOrigin,
  setWorkspaceSessionCookies,
  parseCookieHeader,
  workspaceCsrfCookie,
  workspaceSessionToken,
} from '../services/workspace-web-session.js';

/**
 * A page focus is a reason to LOOK at usage again, not a reason to hit the
 * providers again unconditionally. The periodic credential probe owns the
 * freshness window; the Workspace only fills a missed/stale window before it
 * returns rows. Dead/disabled/payment-paused seats have historical readings,
 * not a cache that page focus should keep probing (note #285).
 */
/**
 * The browser Workspace: agents, secrets, repositories, sites, knowledge,
 * notes, and workplace management behind one cookie-authenticated app.
 *
 * Everything the CLI secrets surface promises holds here too: listings carry
 * names, masked previews and scopes, never values. The one exception is
 * `GET /api/secrets/:name/value`, which hands the OWNER back their own
 * plaintext for the copy button — a deliberate addition, since a key you
 * cannot get back out is a key you have to go find again elsewhere. It is
 * reachable only through the owner's authenticated browser session, it is
 * never logged, and it is the only route here that returns plaintext.
 *
 * Adding a secret is now this surface ALONE — the `/secret NAME=value` chat
 * command is retired. That is the point of it: a value set here travels
 * straight over HTTPS and never appears in a chat transcript.
 */

/**
 * Git's empty tree — the base of a proposal made into a branch that did not
 * exist yet (every repo's first one: `git init --bare` leaves the protected
 * branch with no commits, so there is nothing to have branched from). It
 * names a tree, never a commit, so the host cannot peel it and falls back to
 * diffing from the empty tree, which is exactly the intended reading: every
 * line of the proposal is an addition.
 */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface MiniAppAuth {
  userId: string;
  profile: UserProfileDocument;
  /** Persistent Workspace selection for this browser session. */
  orgId: string | null;
  orgRole: 'admin' | 'member' | null;
  /** Oldest membership: immutable home for records created before org pinning. */
  legacyOrgId: string | null;
  webSession: WorkspaceWebSessionDocument;
  webSessionToken: string;
}

/**
 * What the page needs to show a proposal — the row on home and the header of
 * its own screen. Diff numbers and commit subjects here are the ones frozen
 * at `pr create`; the PR screen fetches a LIVE compare besides, because the
 * user decides on what the branch is NOW.
 */
/**
 * The agent that proposed something, and the HUMAN who drives it (note #80).
 *
 * "Alex proposed this" says which agent asked and leaves out whose it is —
 * the one thing a reader deciding on a change wants to know, and the thing a
 * note's author line and every margin remark have said since note #57. This
 * carries the same pair to a proposal's own screen so all three sign alike.
 *
 * Resolved across the whole org, the same directory those lines already use:
 * a teammate's agent is NAMED rather than going anonymous, as it did while
 * this read the viewer's own fleet alone. The DOOR stays viewer-only by the
 * rule every face on these screens follows — a teammate's agent is named here
 * but has no screen of its own to land on.
 */
function describeProposingAgent(agentId: string, people: WorkspacePeople) {
  const agent = people.agent(agentId);
  const face = agentFaceUrl(agent?.name);
  const driverName = agent ? people.name(agent.ownerUserId) : undefined;
  // The proposal screen names the agent that wrote it, so it also needs the
  // concrete harness, model and effort that agent will use next. These are
  // resolved here rather than handing the page stored overrides: an omitted
  // override and a retired model both still mean a real runtime.
  const runtime = agent && isSupportedAgentCli(agent.cli)
    ? {
      cli: agent.cli,
      model: resolveEffectiveModel(agent.cli, agent.model),
      effort: resolveEffectiveEffort(agent.cli, agent.model, agent.effort),
    }
    : undefined;
  return {
    agentName: agent?.name ?? null,
    ...(face ? { agentAvatarUrl: face } : {}),
    ...(runtime ? { agentRuntime: runtime } : {}),
    // Dropped, not nulled, for a driver this workspace cannot name — the line
    // then signs with the agent alone, exactly as it did before note #80.
    ...(driverName ? { userName: driverName } : {}),
  };
}

/**
 * A knowledge proposal as every screen lists it: what it would do, in the one
 * sentence the queue row and the proposal's own header both use.
 */
/**
 * A page's versions, newest first (note #746): each landed change that
 * touched it, with the face of the agent that made it — or none for a
 * restore the person did themselves — and whether it can be put back.
 */
async function knowledgePageHistory(
  namespaces: readonly string[],
  service: KnowledgeService,
  name: string,
  people: WorkspacePeople,
): Promise<WorkspaceKnowledgeVersionRow[]> {
  const versions = await service.pageHistory(namespaces, name);
  return versions.map(({ proposal, change, canRestore }) => {
    const agent = people.agent(proposal.createdByAgentId);
    return {
      number: proposal.number,
      action: change.action,
      ...(change.action === 'rename' && change.renameTo ? { renameTo: change.renameTo } : {}),
      title: proposal.title,
      ...(proposal.note ? { note: proposal.note } : {}),
      at: proposal.decidedAt ?? proposal.createdAt,
      agentName: agent?.name ?? null,
      ...(agent ? { agentId: proposal.createdByAgentId, ...(agentFaceUrl(agent.name) ? { agentAvatarUrl: agentFaceUrl(agent.name)! } : {}) } : {}),
      ...(proposal.restoreOf ? { restore: true as const } : {}),
      ...(proposal.direct ? {} : { approved: true as const }),
      canRestore,
    };
  });
}

function describeKnowledgeProposal(
  doc: KnowledgeProposalDocument,
  people: WorkspacePeople,
  viewerUserId: string,
) {
  const agent = people.agent(doc.createdByAgentId);
  return {
    id: doc.id,
    number: doc.number,
    title: doc.title,
    ...(doc.note ? { note: doc.note } : {}),
    status: doc.status,
    // Quiet: open, but the agent has not invited a decision yet. Absent —
    // not false — once it has (the change proposal's rule, note #293).
    ...(doc.draft ? { draft: true as const } : {}),
    ...(doc.direct ? { direct: true as const } : {}),
    summary: describeKnowledgeChanges(doc.changes),
    // The pages themselves, which is what the row's second line says now: a
    // count ("1 page (1 new)") repeats what the title and each change's own
    // label already say, and tells the reader nothing they can act on.
    pages: doc.changes.map((change) => change.page),
    createdAt: doc.createdAt,
    ...(doc.decidedAt ? { decidedAt: doc.decidedAt } : {}),
    ...(doc.decisionNote ? { decisionNote: doc.decisionNote } : {}),
    // Who asked, and whose agent it is — plus the proposing agent's own face,
    // the same picture its row on home wears, and the same one a change
    // proposal's row carries, because the queue is one queue and a reader
    // should not have to ask who a row is from twice.
    ...describeProposingAgent(doc.createdByAgentId, people),
    // WHICH agent, under the same rule a change proposal's payload carries it
    // by: the face is a door, and the screen's chat door (note #152) needs an
    // id to find the agent in the fleet it already holds. Sent for a
    // TEAMMATE's agent too since note #640 — that face opens the agent's
    // read-only page, while the CHAT stays the viewer's own by the fleet
    // lookup the screen already does. Absent for an agent the workplace no
    // longer has: the screen keeps the picture and offers no door.
    ...agentDoorId(doc.createdByAgentId, people),
  };
}

/**
 * A git author, matched to an agent of this account.
 *
 * Agents commit as `Ruby <ruby@agentbuilt.app>`, so the local part of the
 * address is the name — that is the match, lowercased, and it survives an
 * agent that has since changed the display name on its commits. Falling back
 * to the NAME catches the older `Ruby (agent) <ruby@agenticcloudcomputer.com>`
 * shape and anything hand-configured. Everyone else — the owner, a merge
 * identity, a human collaborator — resolves to nothing and stays a name.
 */
function resolveContributorAgent(
  author: { name: string; email: string },
  agents: ReadonlyMap<string, { name?: string }>,
): { id: string; name: string } | null {
  const local = author.email.includes('@') ? author.email.split('@')[0]! : author.email;
  const wanted = [local.toLowerCase(), author.name.trim().toLowerCase()];
  for (const [id, agent] of agents) {
    const name = agent?.name?.trim().toLowerCase();
    if (name && wanted.includes(name)) return { id, name: agent!.name! };
  }
  return null;
}

/**
 * The contributor list as every screen shows it: the agent behind each author
 * where there is one, the face to go with it, and the numbers untouched.
 * Most commits first, which is the order the record already holds them in.
 *
 * Matched against the whole WORKPLACE's agents since note #640, not the
 * reader's own fleet: a repository is the workplace's, most of its commits
 * are somebody else's agent's, and those rows carried the raw git name and
 * no face at all — the same half-signed list a knowledge shelf had.
 */
function describeContributors(
  stored: RepoContributors | undefined,
  agents: ReadonlyMap<string, { name?: string }>,
) {
  return (stored?.authors ?? []).map((author) => {
    const agent = resolveContributorAgent(author, agents);
    return {
      // The agent's CURRENT name when it is one of ours — a rename should
      // change the list, not leave it showing what git happens to remember.
      name: agent?.name ?? author.name,
      // The address git knows them by. It is what actually IDENTIFIES a
      // contributor — two people can share a display name and one person can
      // change theirs — so the screen that lists everybody shows it. The row
      // on home drops it again: it has no room, and no question it answers.
      email: author.email,
      commits: author.commits,
      insertions: author.insertions,
      deletions: author.deletions,
      ...(agent ? { agentId: agent.id } : {}),
      ...(agentFaceUrl(agent?.name) ? { agentAvatarUrl: agentFaceUrl(agent?.name) } : {}),
    };
  });
}

/** How many faces a repository ROW carries. Three is what fits beside the
 *  branch and the time on a phone without the line giving way. */
const REPO_ROW_FACES = 3;

/**
 * How a stored file's read URL is signed: to be SAVED, or to be drawn.
 *
 * `?preview=1` is the Workspace saying "I am about to put this on a screen" —
 * a note's photograph in its files card, a proposal's evidence above the
 * diff, a PDF in the full-screen viewer (note #403) — and only then does the
 * object go out with an inline disposition. Every other read keeps the
 * save-as name it has always had, including a preview asked for on a kind no
 * screen here draws: this flag is the one place that decides whether a
 * browser is invited to interpret a stored object instead of filing it away,
 * so what may pass is the shell's own list (`shared/inline-files.ts`) rather
 * than whatever the caller put in the query.
 */
function readDisposition(
  req: Request,
  attachment: { fileName: string; contentType?: string },
): { responseDisposition: string } | { promptSaveAs: string } {
  const wanted = req.query.preview === '1';
  return wanted && canServeInline(attachment.contentType, attachment.fileName)
    ? { responseDisposition: 'inline' }
    : { promptSaveAs: attachment.fileName };
}

/** One message, as a list row. The body and the files are the message
 *  screen's business; this is what a row can show without them. */
function mailMessageSummary(doc: MailMessageDocument): WorkspaceMailMessageSummary {
  return {
    id: doc.id,
    ...(doc.from ? { from: doc.from } : {}),
    // A row this person WROTE is named by who it went to, so `to` rides the
    // summary and the direction says which of the two names the row.
    ...((doc.direction ?? 'in') === 'sent' ? { direction: 'sent' as const, to: doc.to } : {}),
    // Named, not hidden: a message that went out of this address without the
    // owner typing it is exactly the thing they should be able to see at a
    // glance, and the id alone would tell them nothing.
    ...(doc.sentBy ? { sentBy: doc.sentBy.name ?? 'an agent' } : {}),
    subject: doc.subject,
    snippet: doc.snippet,
    receivedAt: doc.receivedAt,
    ...(doc.sentAt ? { sentAt: doc.sentAt } : {}),
    files: doc.attachments.length,
    // New until its owner opens it. Only mail that ARRIVED can be new: a row
    // this person sent is one they wrote.
    ...((doc.direction ?? 'in') === 'in' && !doc.readAt ? { unread: true } : {}),
    ...(doc.suspicious ? { suspicious: true } : {}),
    ...(doc.parseError ? { unreadable: true } : {}),
    // Where it is kept, when that is not the inbox (slice 7) — and which
    // agent put it there, when a person did not.
    ...(mailPlaceOf(doc) !== 'inbox' ? { place: mailPlaceOf(doc) as WorkspaceMailPlace } : {}),
    ...(mailMovedBy(doc) ? { movedBy: mailMovedBy(doc) } : {}),
    ...(mailPlaceOf(doc) === 'spam' && doc.spamWhy ? { spamWhy: doc.spamWhy } : {}),
    ...(doc.forwards ? { forwards: doc.forwards } : {}),
    // Starred (note #666), and by which agent when a person did not.
    ...(doc.starredAt ? { starred: true as const } : {}),
    ...(mailStarredBy(doc) ? { starredBy: mailStarredBy(doc) } : {}),
  };
}

/** One conversation, as a row of the list (slice 8). */
function mailConversationSummary(conversation: MailConversation): WorkspaceMailConversationSummary {
  const facts = mailConversationFacts(conversation);
  const { latest } = facts;
  return {
    id: facts.thread,
    with: facts.with,
    ...(facts.started ? { started: true } : {}),
    subject: facts.subject,
    latest: {
      id: latest.id,
      snippet: latest.snippet,
      receivedAt: latest.receivedAt,
      ...((latest.direction ?? 'in') === 'sent' ? { direction: 'sent' as const } : {}),
      ...(latest.sentBy ? { sentBy: latest.sentBy.name ?? 'an agent' } : {}),
    },
    count: facts.count,
    opens: facts.opens,
    ...(facts.unread ? { unread: true } : {}),
    files: facts.files,
    ...(facts.suspicious ? { suspicious: true } : {}),
    ...(facts.unreadable ? { unreadable: true } : {}),
    ...(facts.place !== 'inbox' ? { place: facts.place } : {}),
    ...(facts.movedBy ? { movedBy: facts.movedBy } : {}),
    ...(facts.spamWhy ? { spamWhy: facts.spamWhy } : {}),
    ...(facts.trashed ? { trashed: facts.trashed } : {}),
    ...(facts.starred ? { starred: true as const } : {}),
  };
}

/**
 * One message with its body and files — the part of a message the screen
 * reads that is not about what answers it.
 *
 * `imagesLoaded` is the reader's own list of senders whose pictures they have
 * asked for (slice 10). It is answered HERE, off the stored list, rather than
 * left to the screen: what a body is allowed to fetch is the server's answer,
 * exactly as where a letter is kept is.
 */
function mailMessageBody(
  doc: MailMessageDocument,
  imagesLoaded: ReadonlySet<string> = new Set(),
  blocked: ReadonlySet<string> = new Set(),
): WorkspaceMailThreadMessage {
  const sent = (doc.direction ?? 'in') === 'sent';
  // What this person SENT is shown as what they wrote: the quote under it went
  // to the recipient, and the message it quotes is already in front of them.
  const text = sent ? doc.wrote ?? doc.text : doc.text;
  return {
    ...mailMessageSummary(doc),
    to: doc.to,
    cc: doc.cc,
    replyTo: doc.replyTo,
    ...(text ? { text } : {}),
    ...(doc.html && !sent ? { html: doc.html } : {}),
    ...(doc.bodyTruncated ? { bodyTruncated: true } : {}),
    ...(!sent && doc.from && imagesLoaded.has(mailSenderKey(doc.from.address)) ? { imagesAllowed: true as const } : {}),
    ...(!sent && doc.from && blocked.has(mailSenderKey(doc.from.address)) ? { senderBlocked: true as const } : {}),
    attachments: doc.attachments.map((file) => ({
      id: file.id,
      fileName: file.fileName,
      contentType: file.contentType,
      size: file.size,
      ...(file.inline ? { inline: true } : {}),
      ...(file.contentId ? { contentId: file.contentId } : {}),
    })),
    ...(doc.authentication
      ? {
        authentication: {
          ...(doc.authentication.spf ? { spf: doc.authentication.spf } : {}),
          ...(doc.authentication.dkim ? { dkim: doc.authentication.dkim } : {}),
          ...(doc.authentication.dmarc ? { dmarc: doc.authentication.dmarc } : {}),
        },
      }
      : {}),
    rawSize: doc.raw.size,
  };
}

/**
 * Reply to all (slice 12), as the conversation screen is offered it: the
 * answered letter's other recipients, decided here off the letter — the
 * screen only prefills the Cc line with them.
 */
function mailReplyAll(message: MailMessageDocument, to: MailPartyRef): { all?: MailPartyRef[]; allLeftOut?: number } {
  const { all, leftOut } = replyAll(message, to);
  return all.length ? { all, ...(leftOut ? { allLeftOut: leftOut } : {}) } : {};
}

/** One reply, as the message screen reads it under the message it answers. */
function mailReply(doc: MailMessageDocument): WorkspaceMailReply {
  return {
    id: doc.id,
    to: doc.to,
    ...(doc.cc?.length ? { cc: doc.cc } : {}),
    ...(doc.attachments.length
      ? { attachments: doc.attachments.map((file) => ({ id: file.id, fileName: file.fileName, contentType: file.contentType, size: file.size })) }
      : {}),
    text: doc.wrote ?? doc.text ?? '',
    sentAt: doc.receivedAt,
    // Named for the same reason a sent row names it: an answer that went out
    // of this address without its owner typing it is exactly the thing they
    // should be able to see at a glance.
    ...(doc.sentBy ? { sentBy: doc.sentBy.name ?? 'an agent' } : {}),
  };
}

/**
 * Direct messages between people: offered again since 29 Oct 2026 (Adam:
 * "Let's bring back direct messages between people"), after being switched
 * off on 2026-09-22 (note #583) while effort went into mail. The state offers
 * Messages only where there can be someone to write to — the team view's own
 * rule (`workplaceHasTeam`): invites open (a workplace we mark, or any
 * workplace of a private copy) or a second person already in. A workplace of
 * one that nobody can join gets no Direct messages row and no Message button.
 * False again hides every door; the screens and `api/messages` stay.
 */
const DIRECT_MESSAGES_OFFERED = true;

/** What a closed invite door says (RouteDeps.invitesClosed), on every route
 *  that would have opened it. The same sentence the screens show. */
const INVITES_CLOSED_MESSAGE = 'Inviting people to a workplace is switched off for now.';
/** What a person who walks up to our sign-up door is told while new
 *  sign-ups are closed (note #823): the platform is offered as a private
 *  copy, and where to read about it or ask. */
export const SIGNUP_CLOSED_LINE = 'New accounts are closed here. Agentic Cloud Computer runs as your own Agentic Cloud, in your own cloud account: see agenticcloudcomputer.com/own-cloud, or write to adam@agenticcloudcomputer.com.';

/** Whether inviting is shut for THIS workplace: switched off on the backend
 *  (RouteDeps.invitesClosed) and the workplace not one the platform marked
 *  (OrgDocument.invitesAllowed, note #805). No workplace at all is shut. */
const invitesShutFor = (closed: boolean | undefined, org: Pick<OrgDocument, 'invitesAllowed'> | null | undefined): boolean =>
  Boolean(closed) && !org?.invitesAllowed;

/** The longest message the Workspace will hand an agent (notes #87, #704):
 *  the same number the page's own boxes stop at — a paste the route would
 *  refuse should never be typeable. A person's own words, so it is larger
 *  than the 4000 `agentbuilt agent message` holds one agent to: an agent can
 *  push the detail and send a pointer, a person writing a long brief cannot. */
const AGENT_USER_MESSAGE_MAX_LENGTH = 10_000;
/** A room's agents are few; this only bounds a request nobody's page sends. */
const FRESH_CHATS_MAX_AGENTS = 100;
/** Four bytes of manifest length, then its UTF-8 JSON, then each file in order. */
const AGENT_CHAT_ATTACHMENT_ENVELOPE_PREFIX_BYTES = 4;
/** Kept for the one-file envelope pages open across this deploy still send. */
const AGENT_CHAT_ATTACHMENT_MESSAGE_MAX_BYTES = AGENT_USER_MESSAGE_MAX_LENGTH * 4;
/** Names and sizes only — room for well over a thousand files (note #672
 *  took the count cap away; the bytes are what one message is held to). */
const AGENT_CHAT_ATTACHMENT_MANIFEST_MAX_BYTES = 256 * 1024;

/**
 * The chat composer's upload, as one request (the agent chat route and the
 * Workspace Agent's share it): four big-endian bytes say how long the UTF-8
 * JSON manifest is; it names and sizes each file, whose raw bytes follow in
 * order. The old one-file envelope is accepted when its x-chat-file-name
 * header is present — a Workspace page can stay open across a backend
 * deploy, and an ordinary attachment picked on that page must not turn into
 * a malformed upload because the server beneath it learned the wider
 * contract.
 */
function parseChatAttachmentEnvelope(req: Request): { message: string; attachments: AgentChatUpload[] } | { error: string } {
  const envelope = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (envelope.length < AGENT_CHAT_ATTACHMENT_ENVELOPE_PREFIX_BYTES) {
    return { error: 'That chat attachment upload is incomplete.' };
  }
  let message = '';
  const attachments: AgentChatUpload[] = [];
  const legacyFileName = String(req.get('x-chat-file-name') ?? '').trim();

  if (legacyFileName) {
    const messageBytesLength = envelope.readUInt32BE(0);
    const fileOffset = AGENT_CHAT_ATTACHMENT_ENVELOPE_PREFIX_BYTES + messageBytesLength;
    if (messageBytesLength > AGENT_CHAT_ATTACHMENT_MESSAGE_MAX_BYTES || fileOffset > envelope.length) {
      return { error: 'That chat attachment upload is malformed.' };
    }
    const messageBytes = envelope.subarray(AGENT_CHAT_ATTACHMENT_ENVELOPE_PREFIX_BYTES, fileOffset);
    const decodedMessage = messageBytes.toString('utf8');
    // Buffer's decoder replaces malformed sequences. Round-tripping makes
    // that a refusal instead of silently changing the user's words.
    if (!Buffer.from(decodedMessage, 'utf8').equals(messageBytes)) {
      return { error: 'That message is not valid UTF-8.' };
    }
    message = decodedMessage.trim();
    const data = envelope.subarray(fileOffset);
    const refusal = validateAgentChatAttachment({ fileName: legacyFileName, sizeBytes: data.byteLength });
    if (refusal) return { error: refusal };
    attachments.push({
      fileName: legacyFileName,
      contentType: String(req.get('x-chat-file-type') ?? '').trim() || undefined,
      data,
    });
  } else {
    const manifestBytesLength = envelope.readUInt32BE(0);
    const filesOffset = AGENT_CHAT_ATTACHMENT_ENVELOPE_PREFIX_BYTES + manifestBytesLength;
    if (manifestBytesLength <= 0
      || manifestBytesLength > AGENT_CHAT_ATTACHMENT_MANIFEST_MAX_BYTES
      || filesOffset > envelope.length) {
      return { error: 'That chat attachment upload is malformed.' };
    }
    const manifestBytes = envelope.subarray(AGENT_CHAT_ATTACHMENT_ENVELOPE_PREFIX_BYTES, filesOffset);
    const manifestText = manifestBytes.toString('utf8');
    if (!Buffer.from(manifestText, 'utf8').equals(manifestBytes)) {
      return { error: 'That attachment manifest is not valid UTF-8.' };
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      return { error: 'That chat attachment upload is malformed.' };
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { error: 'That chat attachment upload is malformed.' };
    }
    const described = manifest as { message?: unknown; files?: unknown };
    if (typeof described.message !== 'string' || !Array.isArray(described.files)) {
      return { error: 'That chat attachment upload is malformed.' };
    }
    message = described.message.trim();
    let offset = filesOffset;
    for (const value of described.files) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { error: 'That chat attachment upload is malformed.' };
      }
      const file = value as { fileName?: unknown; contentType?: unknown; sizeBytes?: unknown; upload?: unknown };
      const fileName = typeof file.fileName === 'string' ? file.fileName.trim() : '';
      const contentType = typeof file.contentType === 'string' ? file.contentType.trim() : '';
      // A file that already went up in parts (note #943): named by its id,
      // with no bytes of its own in this body. The service finds it under
      // this conversation's prefix and reads its size from the store.
      if (file.upload !== undefined) {
        if (!isChatUploadId(file.upload) || contentType.length > 200) {
          return { error: 'That chat attachment upload is malformed.' };
        }
        const refusal = validateAgentChatAttachment({ fileName, sizeBytes: 1 });
        if (refusal) return { error: refusal };
        attachments.push({ fileName, contentType: contentType || undefined, uploadId: file.upload });
        continue;
      }
      const sizeBytes = file.sizeBytes;
      if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) <= 0
        || contentType.length > 200 || offset + (sizeBytes as number) > envelope.length) {
        return { error: 'That chat attachment upload is malformed.' };
      }
      const refusal = validateAgentChatAttachment({ fileName, sizeBytes: sizeBytes as number });
      if (refusal) return { error: refusal };
      const end = offset + (sizeBytes as number);
      attachments.push({ fileName, contentType: contentType || undefined, data: envelope.subarray(offset, end) });
      offset = end;
    }
    // Every byte must be described. Trailing data is not a hidden extra
    // file, and a short body must not silently truncate the last one.
    if (offset !== envelope.length) {
      return { error: 'That chat attachment upload is malformed.' };
    }
    if (!attachments.length) return { error: 'Attach at least one file.' };
    const inline = attachments.flatMap((file) => (file.data ? [file.data.byteLength] : []));
    const setRefusal = inline.length ? agentChatFileSetRefusal(inline) : null;
    if (setRefusal) return { error: setRefusal };
  }
  return { message, attachments };
}


/**
 * Public images generated by the Workspace use its canonical route tree.
 * The router is mounted only at /workspace; returning another base here would
 * make avatar requests on agenticcloudcomputer.com fall through to the
 * marketing site's HTML shell instead of reaching the image route.
 */
const WORKSPACE_PUBLIC_ASSET_BASE = '/workspace';

/**
 * An agent's face, from its name — `undefined` when the fleet has no agent by
 * that name or the pool has no picture for it. One definition because four
 * different rows now wear one, and a face that resolves differently in two
 * places is two agents as far as the reader is concerned.
 */
function agentFaceUrl(agentName: string | undefined): string | undefined {
  const slug = agentName ? telegramAgentAvatarSlug(agentName) : undefined;
  return slug ? `${WORKSPACE_PUBLIC_ASSET_BASE}/avatars/${slug}` : undefined;
}

/**
 * The Workspace Agent's face. New workplaces save one shepherd, sheepdog or
 * big working dog at birth (note #582); older workplaces keep note #434's
 * reserved Bernese. Resolved by the same existence check as a room agent's,
 * so a release shipped without the file hands the plate no URL rather than a
 * broken image.
 */
function workspaceAgentFaceUrl(selectedAvatarSlug?: string): string | undefined {
  const slug = workspaceAgentAvatarSlug(selectedAvatarSlug);
  return slug ? `${WORKSPACE_PUBLIC_ASSET_BASE}/avatars/${slug}` : undefined;
}

/**
 * What a new agent's machine is built on in one workplace, and the ladder
 * it may be chosen from (note #355).
 *
 * Nothing here is marked `standard`: on this ladder the chosen rung wears a
 * badge, and a word saying the same thing beside it reads as a second fact.
 * The agent's own picker asks for the mark instead, where "what new agents
 * get" is genuinely news.
 *
 * It answers the PERMISSION rather than the reader's role: who may set this is
 * the route's rule, and a screen that re-derives it from a role is a second
 * copy of that rule waiting to disagree with the refusal.
 */
function orgAgentMachineAnswer(
  chosenId: string | undefined,
  role: string,
): WorkspaceOrgAgentMachineAnswer {
  const size = effectiveAgentMachineSize(chosenId);
  return {
    current: size.id,
    chosen: Boolean(agentMachineSizeById(chosenId)),
    sizes: pricedAgentMachineSizes(),
    canChoose: role === 'admin',
    disclaimer: COST_ESTIMATE_DISCLAIMER,
  };
}

function autoApproveAnswer(mode: WorkplaceAutoApprove | undefined): WorkspaceOrgAutoApproveAnswer {
  return {
    on: Boolean(mode?.on),
    ...(mode ? { changedAt: mode.changedAt } : {}),
    ...(mode?.history?.length
      ? { history: [...mode.history].reverse().map((change) => ({ on: change.on, at: change.at })) }
      : {}),
  };
}

/**
 * Who sent a message that arrived from another agent, out of the row's own
 * words. The page reads the same two wordings for the same reason: the old one
 * is stored in every existing chat, and a row already written deserves the
 * face the new ones get.
 */
const PEER_CHAT_MESSAGE_SENDER = /^(?:\[Platform\]\s*)?(?:Message|Handoff) from agent ([^:]+):/;

/**
 * A peer's message, wearing the sender's face (note #183).
 *
 * Resolved at READ time rather than stamped on at write time, which is what
 * gives every row already in the store its face too — the same reason the
 * page recognises these rows rather than the backend re-shaping them.
 *
 * The URL is only handed over when a picture is really behind it:
 * `agentFaceUrl` asks the avatar pool whether the file exists, and a renamed
 * agent has none. The name then stands alone, which is the whole rule the
 * slug function was written for — a broken <img> is worse than no picture.
 *
 * The Workspace Agent is the one sender whose face is not derived from its
 * display name (notes #507/#582): its workplace saved a dog slug at birth.
 * Asking `agentFaceUrl` for the two-word display name answers "no picture",
 * so this row receives that saved URL explicitly. The existence check still
 * makes a release without the asset degrade to the name alone rather than a
 * broken image.
 */
function withPeerChatFace(
  message: AgentChatMessage,
  workspaceFace = workspaceAgentFaceUrl(),
): AgentChatMessage & { fromAvatarUrl?: string } {
  if (message.role !== 'platform') return message;
  const sender = PEER_CHAT_MESSAGE_SENDER.exec(String(message.text ?? '').trim());
  const from = sender?.[1]!.trim();
  const face = from
    ? (from.toLowerCase() === WORKSPACE_AGENT_NAME.toLowerCase()
      ? workspaceFace
      : agentFaceUrl(from))
    : undefined;
  return face ? { ...message, fromAvatarUrl: face } : message;
}

/**
 * A quick note as the Workspace lists it (docs/agent-quick-notes.md): the title
 * line, a glimpse of the rest, and who last touched it. The full text is NOT
 * here — it arrives when the reader opens one, the same trade a knowledge page
 * makes, so a hundred notes cost a hundred titles rather than a hundred bodies.
 */
/**
 * Everyone the workspace can name (note #57): every member's agents, every
 * member's own name and face — built once per request from the org's member
 * list, so a teammate's agent no longer renders unsigned and every remark can
 * say which HUMAN drives the agent that made it. On an account with no org
 * layer it wraps just the viewer's profile, which is the old behavior.
 */
interface WorkspacePeople {
  /** The agent, its effective-runtime inputs, and who owns it, from ANY member's fleet. */
  agent(agentId: string): {
    name?: string;
    ownerUserId: string;
    roomId?: string;
    cli?: string;
    model?: string;
    effort?: string;
    /** A member's private Workspace Agent, which no teammate may open. */
    workspaceAgent?: boolean;
  } | undefined;
  /** Every agent in the workplace, for the one question that is asked of the
   *  DIRECTORY rather than of one id: which agent committed as this git
   *  author (note #640). Workspace Agents are not in it — they write no code
   *  and are nobody else's to name. */
  everyAgent(): ReadonlyMap<string, { name?: string }>;
  /** The OTHER members' agents in the workplace on screen, as records
   *  (2026-09-23) — for the one screen that lists them rather than names
   *  them one at a time: the agents picker. */
  teammateAgents(): ReadonlyArray<{ ownerUserId: string; record: AgentRecord }>;
  /** The name a DELETED agent of this person last worked under, from the work
   *  ledger (note #705) — for signing words it left behind, and nothing else:
   *  it is no door, no runtime and no owner. Undefined for an agent that never
   *  worked after the ledger began (2026-09-23). */
  formerAgentName(agentId: string, ownerUserId: string): string | undefined;
  /** How this workspace names a human — personDisplayName over their profile. */
  name(userId: string): string | undefined;
  /** A short-lived signed URL for their profile picture, if they set one. */
  photoUrl(userId: string): string | undefined;
}

/**
 * WHICH agent a face belongs to — the id the door behind it needs (note #640,
 * the owner: "when user presses on not own agent's avatar, it should open
 * agent's detail page").
 *
 * Every face on these screens used to be a door only for the reader's OWN
 * agent, because a teammate's had no screen to land on. It has one now — the
 * same facts, read-only — so the rule is simply "is there an agent behind
 * this face": one the workplace still has is openable, one it has forgotten
 * keeps its picture and offers no door, and a member's private Workspace
 * Agent is never anybody else's to open.
 */
function agentDoorId(agentId: string, people: WorkspacePeople): { agentId?: string } {
  const agent = people.agent(agentId);
  return agent && !agent.workspaceAgent ? { agentId } : {};
}

/**
 * WHICH agent left a request on a repository or a site, and — when it is not
 * the reader's own — whose it is (2026-09-23). Read across the workplace: a
 * teammate's agent's ask used to come up nameless, because only the reader's
 * fleet was searched, and "waiting for its agent's owner" named nobody.
 */
function describeAskAgent(
  agentId: string,
  people: WorkspacePeople,
  viewerUserId: string,
): { byAgentName?: string; byOwnerName?: string } {
  const agent = people.agent(agentId);
  if (!agent?.name) return {};
  const ownerName = agent.ownerUserId !== viewerUserId ? people.name(agent.ownerUserId) : undefined;
  return { byAgentName: agent.name, ...(ownerName ? { byOwnerName: ownerName } : {}) };
}

/**
 * The directory over member profiles already read, with the faces of the
 * PEOPLE passed in — signed URLs cost a storage call each, so the live tick,
 * which names agents but draws no person, hands in none.
 */
function peopleFrom(
  profiles: ReadonlyMap<string, UserProfileDocument>,
  photos: ReadonlyMap<string, string>,
  viewer: Pick<MiniAppAuth, 'userId' | 'orgId'>,
  ledger?: Pick<AgentWorkLedger, 'userTotals'>,
): WorkspacePeople {
  const agents = new Map<string, {
    name?: string;
    ownerUserId: string;
    roomId?: string;
    cli?: string;
    model?: string;
    effort?: string;
    workspaceAgent?: boolean;
  }>();
  const names = new Map<string, string>();
  for (const [userId, profile] of profiles) {
    names.set(userId, personDisplayName(profile));
    for (const [agentId, agent] of Object.entries(profile.telegram?.agents ?? {})) {
      agents.set(agentId, {
        name: agent?.name,
        ownerUserId: userId,
        cli: agent?.cli,
        model: agent?.model,
        effort: agent?.effort,
        ...(isWorkspaceAgent(agent) ? { workspaceAgent: true } : {}),
      });
    }
  }
  // Read once per person per request: a margin can hold many remarks by the
  // same deleted agent, and each would otherwise ask the ledger again.
  const formerNames = new Map<string, ReadonlyMap<string, string>>();
  const formerNamesOf = (ownerUserId: string): ReadonlyMap<string, string> => {
    let known = formerNames.get(ownerUserId);
    if (!known) {
      known = new Map((ledger?.userTotals(ownerUserId) ?? []).map((total) => [total.agentId, total.agentName]));
      formerNames.set(ownerUserId, known);
    }
    return known;
  };
  return {
    agent: (agentId) => agents.get(agentId),
    formerAgentName: (agentId, ownerUserId) => (
      agents.has(agentId) ? undefined : formerNamesOf(ownerUserId).get(agentId) || undefined
    ),
    everyAgent: () => new Map(
      [...agents].filter(([, agent]) => !agent.workspaceAgent).map(([id, agent]) => [id, { name: agent.name }]),
    ),
    teammateAgents: () => teammateAgentsIn(profiles, viewer.userId, viewer.orgId),
    name: (userId) => names.get(userId),
    photoUrl: (userId) => photos.get(userId),
  };
}

/**
 * The OTHER members' room agents in the workplace on screen (2026-09-23, the
 * owner: "those agents should not be hidden from other humans").
 *
 * A member's profile holds every agent they drive in EVERY workplace they
 * belong to, so each record is checked against this one: its own `orgId`
 * where it has one, and otherwise — an agent from before workplaces — the
 * room it works in, which is this workplace's or somebody else's. Workspace
 * Agents and the briefing machine are private to their person, and an agent
 * whose record is still a placeholder has no face to show yet.
 */
function teammateAgentsIn(
  profiles: ReadonlyMap<string, UserProfileDocument>,
  viewerUserId: string,
  orgId: string | null,
): Array<{ ownerUserId: string; record: AgentRecord }> {
  if (!orgId) return [];
  const found: Array<{ ownerUserId: string; record: AgentRecord }> = [];
  for (const [ownerUserId, profile] of profiles) {
    if (ownerUserId === viewerUserId) continue;
    for (const record of listAgents(profile.telegram)) {
      if (record.orgId === orgId) found.push({ ownerUserId, record });
    }
  }
  return found;
}

/** "Working by …" on a note, for the full read and the live tick alike — one
 *  shape, so a tick that has nothing new compares equal to the row. */
function describeNoteClaim(claim: QuickNoteClaim, people: WorkspacePeople): WorkspaceNoteLiveClaim['work'] {
  const agent = people.agent(claim.agentId);
  return {
    state: 'working',
    agentName: agent?.name ?? claim.agentName,
    ...(agentFaceUrl(agent?.name ?? claim.agentName)
      ? { agentAvatarUrl: agentFaceUrl(agent?.name ?? claim.agentName)! }
      : {}),
    expiresAt: claim.expiresAt,
    ...agentDoorId(claim.agentId, people),
  };
}

function describeQuickNoteWork(work: QuickNoteWork, people: WorkspacePeople, viewerUserId: string) {
  // Shaped exactly like `working` — name, clock, and the door only for an
  // agent the viewer owns — because the row draws them the same way and the
  // difference between the two is one word in the label, not one in the data.
  if (work.state === 'handed') {
    const agent = people.agent(work.handoff.agentId);
    return {
      state: work.state,
      agentName: agent?.name ?? work.handoff.agentName,
      ...(agentFaceUrl(agent?.name ?? work.handoff.agentName)
        ? { agentAvatarUrl: agentFaceUrl(agent?.name ?? work.handoff.agentName)! }
        : {}),
      expiresAt: work.handoff.expiresAt,
      // The face beside "Handed to Leo" opens Leo (note #640) — a teammate's
      // read-only page, the viewer's own control room.
      ...agentDoorId(work.handoff.agentId, people),
    } satisfies WorkspaceNoteWork;
  }
  if (work.state === 'working') return describeNoteClaim(work.claim, people);
  if (work.state === 'proposal' || work.state === 'merged' || work.state === 'live') {
    return {
      state: work.state,
      proposalNumber: work.proposal.number,
      // A quiet proposal reads as its own state on the note's badge: it IS a
      // PR, and the fence holds, but nobody has been asked anything yet.
      proposalStatus: work.proposal.draft ? 'draft' : work.proposal.status,
    } satisfies WorkspaceNoteWork;
  }
  return { state: 'unclaimed' as const } satisfies WorkspaceNoteWork;
}

/**
 * One safe, useful glimpse of what a note carries for the compact lists.
 * Prefer the first photograph over a document: at 28px a picture can be
 * recognised, while every other file is still honestly represented by its
 * typed glyph and name. The full count remains on the summary, and the note's
 * own screen still carries every attachment.
 *
 * Storage paths never leave the backend. The id is enough for the existing
 * authenticated file-access route to mint a short-lived URL when the preview
 * actually comes near the viewport.
 */
function describeQuickNoteAttachmentPreview(doc: QuickNoteDocument) {
  const attachments = (doc.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: inferContentType(attachment.fileName, attachment.contentType),
    sizeBytes: attachment.sizeBytes,
  }));
  return attachments.find((attachment) => (
    attachment.contentType.startsWith('image/')
      && attachment.contentType !== 'image/svg+xml'
  )) ?? attachments[0];
}

/**
 * WHOSE note this is, at the level of the human behind it (note #637).
 *
 * Not the same question as "who wrote these words", which is what the screen's
 * signature answers and what the edit gate reads. A note an agent wrote stands
 * with the person that agent belongs to: they asked for it, it is written into
 * their Workspace, and their other agents may pick it up. So the owner is the
 * human stamp when there is one, the agent's owner when the writer was an
 * agent, and the storage namespace otherwise — which is the person themselves
 * in a personal namespace, and nobody in a room shared by a workplace.
 *
 * This is what Move, Archive, Restore and Delete are offered on: everything
 * that takes a note off somebody's desk. Everything that ADDS to it — a
 * comment, a file, handing it to an agent — stays open to every member, for
 * the reason the margin exists at all.
 */
function noteHumanOwner(
  doc: Pick<QuickNoteDocument, 'userId' | 'updatedByAgentId' | 'updatedByUserId'>,
  agentOwner: (agentId: string) => string | undefined,
): string {
  return doc.updatedByUserId
    ?? (quickNoteIsUsers(doc) ? undefined : agentOwner(doc.updatedByAgentId))
    ?? doc.userId;
}

/**
 * Whether the READER's own agents may still rewrite these words (note #638).
 *
 * The same rule the agent CLI's editor applies — a note an agent wrote may be
 * rewritten by any agent of the same human — answered here because the screen
 * cannot work it out. Almost half the agent-written notes on this account were
 * written by an agent that has since been deleted: there is no name to ask, so
 * the card in place of the Edit button has to say either "ask any of yours" or
 * "these words cannot be changed now", and those are different sentences.
 *
 * Not the same question as {@link noteHumanOwner}. Ownership falls back to the
 * storage namespace so a note always stands with somebody; editing has no such
 * fallback — a legacy note with no human stamp behind a deleted agent is one
 * nobody can rewrite, and saying otherwise sends the reader to an agent that
 * will be refused.
 */
function noteAgentsCanEdit(
  doc: Pick<QuickNoteDocument, 'updatedByAgentId' | 'updatedByUserId'>,
  viewerUserId: string,
  agentOwner: (agentId: string) => string | undefined,
): boolean {
  if (quickNoteIsUsers(doc)) return false;
  return (doc.updatedByUserId ?? agentOwner(doc.updatedByAgentId)) === viewerUserId;
}

function describeQuickNote(
  doc: QuickNoteDocument,
  people: WorkspacePeople,
  viewerUserId: string,
  work?: QuickNoteWork,
) {
  // Who to ask about it: the agent that last wrote it, which is not always the
  // one that started it — another agent of the same human can pick a note up.
  // Resolved across every member's fleet, so a teammate's agent is named and
  // worn like one of the viewer's own. A note
  // the user wrote themselves has no agent behind it at all: the id is the
  // `QUICK_NOTE_AUTHOR_USER` sentinel, so every lookup here misses and the
  // screen says either "Written by you" or the member's name from
  // the human-owner stamp — no invented agent name or face.
  const agent = people.agent(doc.updatedByAgentId);
  const agentName = agent?.name;
  const workspaceAssistant = doc.updatedByAgentId.startsWith('workspace-');
  const face = workspaceAssistant ? undefined : agentFaceUrl(agentName);
  // The human behind the agent (note #57) — the note screen signs
  // "Written by Ruby (Aisha Karimova)". The viewer's own agents too
  // (Owner, 2026-08-26): one rule for every line.
  const agentDriverName = agent ? people.name(agent.ownerUserId) : undefined;
  // The NEWEST remark, not the first: a margin is read from the bottom, and
  // the last thing said is the part still standing — "fixed, it is in your
  // chat" is the line that makes the row worth knowing about, and it is never
  // the opening one. The count beside it already says a conversation exists;
  // this says what it SAID, which is the whole of the ask (note #16).
  const lastComment = doc.comments?.length ? doc.comments[doc.comments.length - 1] : undefined;
  // Resolved against the same org-wide directory as the note's own author, and
  // going unsigned by the same rule when that agent is gone: the remark still
  // holds, there is simply nobody left to point at.
  const commentAgent = lastComment ? people.agent(lastComment.authorId) : undefined;
  // Except where the work ledger still remembers a deleted agent's name: the
  // row then signs it as the full thread does (note #705), rather than with a
  // bare dot that leaves the reader guessing whose words these are.
  const commentFormerName = lastComment && !commentAgent && lastComment.authorId !== COMMENT_AUTHOR_USER
    && lastComment.userId
    ? people.formerAgentName(lastComment.authorId, lastComment.userId)
    : undefined;
  const commentAgentName = commentAgent?.name ?? commentFormerName;
  const commentFace = agentFaceUrl(commentAgentName);
  // A remark is an agent's or a PERSON'S, and this row only ever resolved the
  // first (note #177). A comment the user wrote in their own Workspace carries
  // the `user` sentinel as its author, so every lookup above misses it and the
  // row drew their words unsigned and faceless — the one line on the whole
  // screen wearing the stand-in for somebody who could not be named, when the
  // person is the reader themselves and their picture is already on the row
  // above. Resolved from the stamp written when the remark was made, exactly
  // as the full thread resolves it, so the row and the note screen sign the
  // same remark the same way. No id rides along: the face on a compact row is
  // never a door — the whole row already opens the note.
  const commentDriverId = lastComment?.userId ?? commentAgent?.ownerUserId;
  const commentPerson = lastComment?.authorId === COMMENT_AUTHOR_USER && commentDriverId
    ? { name: people.name(commentDriverId), photoUrl: people.photoUrl(commentDriverId) }
    : undefined;
  const summary = summarizeQuickNote(doc);
  const attachmentPreview = describeQuickNoteAttachmentPreview(doc);
  const { byUser: humanWritten, ...sharedSummary } = summary;
  const humanAuthorId = doc.updatedByUserId ?? doc.userId;
  const writtenByViewer = Boolean(humanWritten) && humanAuthorId === viewerUserId;
  // A teammate's own jotting wears their NAME now (note #57), not the generic
  // "another member" — who wrote it is exactly what that line is for.
  const memberName = Boolean(humanWritten) && !writtenByViewer ? people.name(humanAuthorId) : undefined;
  // The human author, whole (note #60): name and face for EVERY human-written
  // note, the viewer's own included — the row signs "Owner Example" with his
  // picture, not "you wrote this". The id makes the face a door to their
  // member page (note #61).
  const authorName = humanWritten ? people.name(humanAuthorId) : undefined;
  const authorPhotoUrl = humanWritten ? people.photoUrl(humanAuthorId) : undefined;
  return {
    ...sharedSummary,
    ...(attachmentPreview ? { attachmentPreview } : {}),
    ...(work && !quickNoteIsArchived(doc)
      ? { work: describeQuickNoteWork(work, people, viewerUserId) }
      : {}),
    ...(writtenByViewer ? { byUser: true as const } : humanWritten ? { byMember: true as const } : {}),
    // Whether the note stands with the READER — written by them, or kept by
    // one of their agents (note #637). The row carries it because the lists
    // act on notes too: the swipe that archives one is offered on the same
    // answer the note's own screen offers Archive on.
    ...(noteHumanOwner(doc, (id) => people.agent(id)?.ownerUserId) === viewerUserId
      ? { yours: true as const }
      : {}),
    // Whether an agent of the reader's can still rewrite it (note #638) — the
    // half of "there is no Edit button here" that says what they have instead.
    ...(noteAgentsCanEdit(doc, viewerUserId, (id) => people.agent(id)?.ownerUserId)
      ? { agentsCanEdit: true as const }
      : {}),
    ...(memberName ? { memberName } : {}),
    ...(humanWritten ? { authorUserId: humanAuthorId } : {}),
    ...(authorName ? { authorName } : {}),
    ...(authorPhotoUrl ? { authorPhotoUrl } : {}),
    // Dropped rather than nulled for a retired agent: an id on screen says
    // less than silence, exactly as a deployment's row decides.
    ...(agentName ? { agentName } : {}),
    // WHICH agent, and its face — the same pair a proposal carries, for the
    // same reason: on a note the name is the one thing on screen pointing at
    // a whole other thing, and "ask the agent that keeps it" is the only way
    // a note ever changes. Both absent for an agent the fleet no longer has,
    // which keeps the line and offers no door. A TEAMMATE's agent is a door
    // too since note #640 — onto its read-only page — and a Workspace Agent
    // is nobody else's to open.
    ...(workspaceAssistant ? {} : agentDoorId(doc.updatedByAgentId, people)),
    ...(face ? { agentAvatarUrl: face } : {}),
    ...(agentDriverName ? { userName: agentDriverName } : {}),
    // Shaped like every other agent line on these screens (name + face + what
    // was said), so the row can draw it with `agentLineNodes` rather than a
    // second idea of what an agent saying something looks like.
    ...(lastComment
      ? {
        lastComment: {
          // The compact row needs both halves: `text` is the first complete
          // sentence it has room to show, while `html` lets the client keep
          // emphasis and code inside that sentence. The client rebuilds it
          // through the same allowlist as the full comment.
          html: lastComment.text,
          text: quickNoteCommentPreview(lastComment.text),
          ...(commentAgentName ? { agentName: commentAgentName } : {}),
          ...(commentFace ? { agentAvatarUrl: commentFace } : {}),
          // The same three fields the full thread sends for a person's remark,
          // read by the same flag: `byPerson` is the discriminator because an
          // AGENT's remark names a human too — the driver behind it — and a
          // row deciding whose face to draw by "is there a userName" would
          // eventually put the driver's picture on the agent's words.
          ...(commentPerson
            ? {
              byPerson: true as const,
              ...(commentPerson.name ? { userName: commentPerson.name } : {}),
              ...(commentPerson.photoUrl ? { userPhotoUrl: commentPerson.photoUrl } : {}),
            }
            : {}),
        },
      }
      : {}),
  } satisfies WorkspaceNoteRow;
}

/**
 * A knowledge page as the home list shows it: what the page says, plus the
 * agent that last landed it and its face.
 *
 * A page belongs to the ACCOUNT, not to the agent that wrote it — which is
 * exactly why the face is worth carrying. Six agents write into one knowledge
 * base, and "who wrote this?" is otherwise unanswerable without opening the
 * page and guessing from its prose (Owner, 2026-08-17). Both fields are
 * dropped for an agent the fleet no longer has, leaving the row as it was.
 *
 * Resolved across EVERY member's fleet (note #640), exactly as a note's row
 * and a margin's remark already are. One shelf holds the whole workplace's
 * pages, so most rows on a teammate's screen were landed by somebody else's
 * agent — looked up in the reader's own fleet alone they all missed, and half
 * the card went faceless and unsigned while the reader's own pages wore their
 * names. Naming crosses no boundary the rest of these screens keeps: members
 * already see each other, and the DOOR is what stays the viewer's own.
 */
function describeKnowledgePage(page: KnowledgePageSummary, people: WorkspacePeople) {
  const agent = page.updatedByAgentId
    ? people.agent(page.updatedByAgentId)
    : undefined;
  const face = agentFaceUrl(agent?.name);
  return {
    ...page,
    ...(agent?.name ? { agentName: agent.name } : {}),
    ...(face ? { agentAvatarUrl: face } : {}),
    // And the door behind that face (note #640): the agent that landed the
    // page, whoever in the workplace owns it.
    ...(page.updatedByAgentId ? agentDoorId(page.updatedByAgentId, people) : {}),
  };
}

function describeProposal(
  doc: GitPullRequestDocument,
  repoName: string,
  people: WorkspacePeople,
  viewerUserId: string,
) {
  const agent = people.agent(doc.createdByAgentId);
  return {
    id: doc.id,
    number: doc.number,
    repoName,
    title: doc.title,
    body: doc.body ?? null,
    from: doc.sourceBranch,
    to: doc.targetBranch,
    diffStat: doc.diffStat,
    commitSubjects: doc.commitSubjects,
    ...(pullRequestQuickNoteNumbers(doc).length
      ? { quickNoteNumbers: pullRequestQuickNoteNumbers(doc) }
      : {}),
    status: doc.status,
    // Quiet (note #293): open, but the agent has not invited a decision yet.
    // Absent — not false — when it has, so every proposal ever shown keeps
    // the exact shape it had.
    ...(doc.draft ? { draft: true as const } : {}),
    createdAt: doc.createdAt,
    // When it stopped being a question — what a decided proposal's row dates
    // itself by, since its creation date is the less interesting of the two.
    decidedAt: doc.decidedAt ?? null,
    // The rejection reason, so a decided proposal's screen shows WHY — the
    // same words the agent was woken with.
    decisionNote: doc.decisionNote ?? null,
    // Who decided, when nobody did (note #944): the auto-merge switch that
    // merged it, and the reason it did not when it fell back to a person.
    ...(doc.autoApproved
      ? { autoApproved: { at: doc.autoApproved.at, modeOnAt: doc.autoApproved.modeOnAt, modeOnByName: doc.autoApproved.modeOnByName } }
      : {}),
    ...(doc.autoApproveFallback && doc.status === 'open'
      ? { autoApproveFallback: { at: doc.autoApproveFallback.at, reason: doc.autoApproveFallback.reason } }
      : {}),
    // Who asked, whose agent it is, and the agent's own face — the same one
    // its row on home wears, absent for a renamed or deleted agent, which
    // keeps the name line and loses only the picture.
    ...describeProposingAgent(doc.createdByAgentId, people),
    // WHICH agent, not just its name — the face on the proposal's own screen
    // is a way in to it, and the page needs an id to find it by in the fleet
    // it already holds. Absent for an agent since deleted, which is exactly
    // when the page must keep the picture and offer no door. A teammate's
    // agent carries it since note #640: the face opens its read-only page,
    // where an agent of the reader's own opens its chat (note #617).
    ...agentDoorId(doc.createdByAgentId, people),
    // What the proposal CARRIES: the screenshot of the screen that changed,
    // shown beside the decision it is evidence for (Owner, notes #10/#18).
    // Shaped exactly like a note's file list, so the screen draws it with the
    // renderer that already exists rather than a second idea of what a file
    // on a card looks like. Absent — not empty — on a proposal with none, so
    // a card with no files has no card.
    ...(doc.attachments?.length
      ? {
        attachments: doc.attachments.map((a) => ({
          id: a.id,
          fileName: a.fileName,
          // Re-read through the same inference that stores it, so the files
          // attached BEFORE it learned to ignore an octet-stream header draw
          // as what they are rather than needing a migration to rewrite them.
          // A record that already carries a real type is returned unchanged —
          // this only ever fills in the case where nothing was claimed.
          contentType: inferContentType(a.fileName, a.contentType),
          sizeBytes: a.sizeBytes,
          addedAt: a.addedAt,
        })),
      }
      : {}),
  };
}

/**
 * The proposal-row pip: worst effective state across every check filed under
 * one sha. Absent entirely (`{}`) when no CI has spoken — a repo without CI
 * must render exactly as before, not as "0 checks".
 *
 * The worst-state rule itself is {@link worstCheckState}, shared with the
 * proposal card in the chat: home's queue asks per proposal, the repository's
 * list asks for all of them at once, and the card asks at send time — none of
 * the three may mean a different thing by the same sha.
 */
function checksPip(docs: GitCommitStatusDocument[], now: Date) {
  const worst = worstCheckState(docs, now);
  if (!worst) return {};
  const states = docs.map((doc) => effectiveStatusState(doc, now));
  return {
    checks: {
      total: docs.length,
      // What BROKE, which is not everything that failed to pass (note #76): a
      // superseded job is counted by the screen as "never ran", so counting it
      // here as failing put "1 failing" beside a pip that had gone grey.
      failing: states.filter((s) => s === 'failure' || s === 'error').length,
      pending: states.filter((s) => s === 'pending').length,
      worst,
    },
  };
}

/**
 * An agent's context fill, as the screen needs it: a percentage, the raw token
 * count for the line under it, and when it was measured.
 *
 * `{}` — the field simply absent — whenever a percentage would be invented:
 * no turn measured yet, or a model this backend holds no context window for.
 * A bar drawn against a guessed denominator is worse than no bar, because it
 * looks exactly as authoritative as a real one.
 */
function contextFields(usage: AgentRecord['contextUsage']) {
  // Shared with the line the agent itself is told each turn: same measurement,
  // same refusal to invent a denominator, so the bar and the sentence cannot
  // report different numbers for one agent.
  const reading = resolveContextUsage(usage);
  if (!reading) return {};
  return { context: reading };
}

/**
 * Has this agent ever actually been USED, as opposed to merely made?
 *
 * `lastActivityAt` cannot answer it. Creation stamps that field on purpose —
 * the idle reaper reads it, and without the stamp it destroys the brand-new
 * machine at its first sweep, mid sign-in (live 2026-07-26). So EVERY agent
 * carries a fresh stamp from the second it is born, and the fleet ordering,
 * which reads the stamp as recency, put the one agent that had done nothing
 * yet at the top of the list — above the agents that actually run, and while
 * it was still being built (notes #227/#264). That is the exact placement
 * note #79 removed; the reaper's stamp quietly put it back.
 *
 * So ask the records only a REAL turn writes: the job it was set going on,
 * the recap written after it finished, the native conversation the CLI opened.
 * Any turn writes the first of those at its start, so an agent counts as used
 * from the moment it begins working rather than when it stops.
 *
 * Deliberately NOT `hasRunBefore` below, which asks a different question —
 * "did this machine ever get through setup", where an activity stamp is fair
 * (weak) evidence and the cost of a wrong answer is a misread status, not a
 * misplaced row.
 */
function agentHasBeenUsed(agent: AgentRecord): boolean {
  return Boolean(
    agent.tasks?.length
    || agent.recap?.text
    || agent.conversation?.claudeSessionId
    || agent.conversation?.codexThreadId
    || agent.conversation?.opencodeSessionId,
  );
}

/**
 * One stopped agent's subscription-window marker, shaped for the page. The
 * stored record keeps only instants; readiness is derived at read time so the
 * five-second live endpoint can turn Resume on at the reset without a broad
 * Workspace reload.
 */
function sessionLimitFields(
  limit: AgentRecord['sessionLimit'],
  nowMs = Date.now(),
): {
  sessionLimit?: {
    hitAt: string;
    resetAt: string;
    resetsText?: string;
    resumeReady: boolean;
  };
} {
  if (!limit) return {};
  const resetMs = Date.parse(limit.resetAt);
  return {
    sessionLimit: {
      hitAt: limit.hitAt,
      resetAt: limit.resetAt,
      ...(Number.isFinite(resetMs) ? { resetsText: formatUsageReset(resetMs / 1000) } : {}),
      resumeReady: Number.isFinite(resetMs) && resetMs <= nowMs,
    },
  };
}

async function checksSummary(deps: RouteDeps, repoId: string, sha: string) {
  if (!deps.gitCommitStatusStorage) return {};
  return checksPip(await deps.gitCommitStatusStorage.listBySha(repoId, sha), new Date());
}

/** How many runs the repository's CI list carries. A screenful and change —
 *  the older ones are reachable through the commits they ran against. */
const CHECK_RUNS_LIMIT = 20;

/**
 * Profile and workplace pictures have immutable UUID paths, but their read
 * URLs are signed. Keep one signature stable for most of its lifetime so a
 * state poll does not turn the same picture into a new browser resource.
 */
/** A proposal read slower than this is logged with where its time went
 *  (follow-up to note #825). */
const SLOW_PROPOSAL_READ_MS = 400;

const PICTURE_URL_TTL_MS = 15 * 60_000;
const PICTURE_URL_REFRESH_MARGIN_MS = 60_000;
const PICTURE_URL_CACHE_LIMIT = 512;
const PICTURE_RESPONSE_CACHE_CONTROL = `private, max-age=${Math.floor(
  (PICTURE_URL_TTL_MS - PICTURE_URL_REFRESH_MARGIN_MS) / 1000,
)}, immutable`;

/** One check row on the proposal/commit screens. The log tail rides along —
 *  it is the only artifact a failed check has, and it is already capped. */
function describeCheck(doc: GitCommitStatusDocument, now: Date) {
  return {
    context: doc.context,
    state: effectiveStatusState(doc, now),
    description: doc.description,
    startedAt: doc.startedAt,
    ...(doc.completedAt ? { completedAt: doc.completedAt } : {}),
    ...(doc.logTail ? { logTail: doc.logTail } : {}),
  };
}

/**
 * The protected-branch run that starts AFTER a proposal lands.
 *
 * It is deliberately separate from `checks` on the proposal response. Those
 * judged the source branch before approval; these checks and deploys answer
 * what happened after the target branch moved. A fast-forward gives both runs
 * the same sha, so `deliveryStartedAt` is the boundary that keeps the old
 * source-branch verdict from appearing as an instant main-branch pass while
 * the new run is still being queued.
 *
 * `ci` is the repository's switch as it stands now, not as it stood at the
 * merge: it only ever decides whether an EMPTY landing is still worth waiting
 * for, and rows that did arrive are shown whatever it says.
 */
function describeProposalDelivery(
  proposal: GitPullRequestDocument,
  docs: GitCommitStatusDocument[],
  now: Date,
  ci: boolean,
) {
  if (proposal.status !== 'merged') return null;
  const sha = proposal.mergeCommitSha ?? proposal.headSha;
  const cutoff = Date.parse(proposal.deliveryStartedAt ?? proposal.decidedAt ?? '');
  const landingDocs = sha === proposal.headSha && Number.isFinite(cutoff)
    ? docs.filter((doc) => Date.parse(doc.startedAt) >= cutoff)
    : docs;
  return {
    sha,
    branch: proposal.targetBranch,
    mergedAt: proposal.decidedAt ?? null,
    checks: landingDocs.map((doc) => describeCheck(doc, now)),
    // The same deliberately narrow claim a linked quick note uses: a backup
    // or GitHub mirror alone never turns a proposal into “Live”.
    live: mergedProposalIsLive(landingDocs, now),
    ci,
  };
}

/**
 * What a running turn is doing, in the shape the page renders: the tool line
 * as the CLI reported it (already redacted where it was stored), and the start
 * as an ISO instant, because the page's stopwatch parses dates and never epoch
 * millis. Both are optional on purpose — a turn a second old has called no
 * tool yet, and a re-attached turn can have lost the start it began with.
 */
function liveActivityFields(live: { activity?: string; startedAt?: number } | null | undefined) {
  return {
    ...(live?.activity ? { activity: live.activity } : {}),
    ...(live?.startedAt ? { activitySince: new Date(live.startedAt).toISOString() } : {}),
  };
}

export function workspaceRoutes(deps: RouteDeps): Router {
  /** The knowledge base, or a 503 that says so. Both halves or neither: a
   *  page list with nothing behind it would be an empty knowledge base, which
   *  is a different and wrong answer. */
  const requireKnowledge = async (userId: string, orgId: string | null, res: Response) => {
    if (!deps.knowledgeProposalStorage || !deps.gitHostClient) {
      res.status(503).json({ error: 'Knowledge pages are not available on this backend yet' });
      return null;
    }
    // The viewer's namespace on the namespace's own host (byo-git slice 3):
    // an org's pages are one shared base (note #566), on its one git host.
    const ns = deps.orgGit
      ? await deps.orgGit.resolveNamespace(userId, orgId)
      : { namespaceId: userId, orgId: null };
    const host = deps.orgGitHost ? await deps.orgGitHost.clientFor(ns.orgId) : deps.gitHostClient;
    return { ns, service: new KnowledgeService(host, deps.knowledgeProposalStorage, deps.knowledgeShelf) };
  };

  const router = Router();

  /** One read for the workplace's durable choice; no org layer means the
   * legacy reserved Bernese, which keeps narrow route fixtures and old data
   * useful without inventing a second fallback. A workplace's choice never
   * changes, so chat polling pays for this storage read only once per process. */
  const workspaceAgentFaces = new Map<string, string | undefined>();
  const workspaceAgentFaceForOrg = async (orgId?: string | null): Promise<string | undefined> => {
    if (!orgId || !deps.orgStorage) return workspaceAgentFaceUrl();
    if (workspaceAgentFaces.has(orgId)) return workspaceAgentFaces.get(orgId);
    const org = await deps.orgStorage.getOrg(orgId).catch(() => null);
    const face = workspaceAgentFaceUrl(org?.workspaceAgentAvatarSlug);
    workspaceAgentFaces.set(orgId, face);
    return face;
  };

  /** Resolve the current answer onto a stored chat pointer. Pending cards
   *  therefore update across tabs without rewriting either chat store. */
  const withMailApprovals = async <T extends { mailApprovalId?: string }>(
    userId: string,
    messages: T[],
  ): Promise<Array<T & { mailApproval?: WorkspaceMailApproval }>> => {
    const ids = messages.flatMap((message) => message.mailApprovalId ? [message.mailApprovalId] : []);
    if (!ids.length || !deps.mailApprovals) return messages;
    const approvals = await deps.mailApprovals.getMany(userId, ids).catch(() => new Map());
    return messages.map((message) => {
      const approval = message.mailApprovalId ? approvals.get(message.mailApprovalId) : undefined;
      return approval ? { ...message, mailApproval: approval } : message;
    });
  };

  // Everything below this line goes out compressed when the client can take
  // it: the page, and the file/diff/state payloads, which are all text.
  router.use(compressResponses());
  // Build the page's variants now rather than making the first visitor after a
  // deploy wait for the brotli pass. A failure here is not one: the request
  // path tries again and reports it.
  // One cache per router, so a test's stub never leaks into the next test and
  // production gets it with nothing to configure.
  const siteFavicons = deps.siteFavicons ?? new SiteFavicons();

  // Unauthenticated on purpose: the shell is static and holds no data. Every
  // fact it displays comes from an authenticated API call. Named routes make
  // browser links durable across navigation and refreshes.
  // Every shell address under /workspace is a permanent redirect to the same
  // place at the root of the domain (public-addresses, 2026-09-26): a link
  // copied, forwarded or bookmarked before the move still arrives. The bare
  // `/workspace` was also the sign-in page; signed out it goes to the login
  // door, since the root belongs to the landing page for a visitor.
  const workspaceUiDir = deps.workspaceUiDir ?? DEFAULT_WORKSPACE_UI_DIR;
  router.use(workspaceUiAssetRoutes(workspaceUiDir));
  const redirectToRoot = (req: Request, res: Response) => {
    if (handleRetiredWorkspaceUiSwitch(req, res)) return;
    const url = new URL(req.originalUrl, 'http://placeholder.invalid');
    let pathname = canonicalWorkspacePath(url.pathname);
    // The same signed-in signal the edge reads: either cookie, under either
    // name, whatever origin this backend was configured with.
    const jar = parseCookieHeader(req.headers.cookie);
    const signedIn = ['__Host-acc_session', 'acc_session', '__Host-acc_csrf', 'acc_csrf'].some((name) => Boolean(jar[name]));
    if (pathname === '/' && !signedIn) pathname = '/login';
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(301, `${pathname}${url.search}${url.hash}`);
  };
  for (const pattern of workspaceShellPathPatterns()) router.get(pattern, redirectToRoot);
  // `/workspace/adam` was never an address, but the parser reads the prefix
  // as nothing, so it redirects to the public page like every other shell
  // address does — registered LAST (the end of this router), so `/:handle`
  // cannot swallow the API, the assets or the service worker mounted here.
  const redirectPublicToRoot = (req: Request, res: Response, next: NextFunction) => {
    if (!publicAddress(String(req.path ?? ''))) return next();
    return redirectToRoot(req, res);
  };
  router.get('/organization/spending', (req, res) => {
    const query = new URL(req.originalUrl, 'http://placeholder.invalid').search;
    res.redirect(301, `${WORKSPACE_BASE}/workplace/cloud${query}`);
  });
  router.get('/service-worker.js', (_req, res) => {
    // Browser notifications were retired (note #477). A browser that turned
    // them on before note #331 removed the control still holds the earlier
    // worker — the one that showed pushes — and nothing in the Workspace
    // registers a worker any more, so nothing would ever replace it. The
    // address stays served for exactly that browser: it checks this file on
    // every navigation (no-cache), finds it changed, installs this worker,
    // which drops the push subscription and unregisters itself. Deleting
    // the route instead would leave the old worker in place for good.
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/workspace/');
    res.type('application/javascript').send(`'use strict';
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  const registration = self.registration;
  const unsubscribe = registration.pushManager
    ? registration.pushManager.getSubscription()
        .then((subscription) => (subscription ? subscription.unsubscribe() : false))
        .catch(() => false)
    : Promise.resolve(false);
  event.waitUntil(unsubscribe.then(() => registration.unregister()));
});`);
  });

  /** Workspace identity is an opaque HttpOnly browser session, and nothing else. */
  /**
   * In a private copy an account is IN while it belongs to a workplace or
   * waits on a request to join one (note #814). Removed, left, declined or
   * gone with its workplace, it is out: every sign-in it holds ends at once,
   * where until now one could last 90 days and its mail stayed readable.
   * Out, it can sign in again only through a live invite link, which files
   * its request to join as it does. A storage error never locks anyone out.
   */
  const OUTSIDE_COPY = 'You are not in a workplace here any more, so you have been signed out. To come back, open an invite link from an admin.';
  const insideCopy = async (userId: string, memberships?: readonly unknown[]): Promise<boolean> => {
    if (!deps.orgStorage) return true;
    const held = memberships ?? await deps.orgStorage.listMembershipsByUser(userId).catch(() => null);
    if (held === null || held.length) return true;
    const requests = await deps.orgStorage.listJoinRequestsByUser(userId).catch(() => null);
    return requests === null || requests.some((request) => request.status === 'pending');
  };
  const signOutOfCopy = async (userId: string): Promise<void> => {
    if (!deps.privateCopy || !deps.workspaceWebAuth || await insideCopy(userId)) return;
    const ended = await deps.workspaceWebAuth.revokeAllSessions(userId).catch(() => 0);
    console.log(`[copy] ${userId} is in no workplace now: ${ended} sign-in(s) ended at once`);
  };
  /** At sign-in in a copy: in, or let in by the invite link it came with
   *  (its request to join filed now), or refused with the plain line. */
  const admitToCopy = async (userId: string, body: unknown): Promise<string | null> => {
    if (!deps.privateCopy || await insideCopy(userId)) return null;
    const admission = await copyAdmission(body);
    if (admission?.kind === 'invite' && deps.orgStorage) {
      const refusal = await deps.copyLicence?.personRefusal();
      if (refusal) return refusal;
      const outcome = await deps.orgStorage.requestToJoin(admission.token, userId).catch(() => null);
      if (outcome?.ok) {
        await notifyJoinRequested(outcome.org.orgId, outcome.org.name, userId, outcome.request.requestId).catch(() => {});
        return null;
      }
    }
    return 'This account is not in a workplace here any more. To come back, open an invite link from an admin and sign in there.';
  };

  const authenticate = async (req: Request, res: Response): Promise<MiniAppAuth | null> => {
    // Authenticated Workspace payloads may contain private chat, secret, repo,
    // and workplace data. Neither browser caches nor a reverse proxy may
    // retain them under a reusable URL.
    // A few direct-handler unit fixtures implement only status/json. Real
    // Express responses always provide setHeader; keep those narrow fixtures
    // usable without weakening the live response.
    if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
    if (!deps.userStorage) {
      res.status(503).json({ error: 'The Workspace is not configured on this backend' });
      return null;
    }
    const unauthorized = () => {
      res.status(401).json({ error: 'Sign in to continue.' });
      return null;
    };

    if (!deps.workspaceWebAuth || !deps.workspaceWebOrigin) return unauthorized();
    const webSessionToken = workspaceSessionToken(req, deps.workspaceWebOrigin);
    const webSession = await deps.workspaceWebAuth.authenticateSession(webSessionToken);
    if (!webSession) return unauthorized();
    if (!isSafeHttpMethod(req.method)) {
      if (!requestHasWorkspaceOrigin(req, deps.workspaceWebOrigin, deps.workspaceWebCompatibleOrigins)
        || !requestHasValidCsrf(req, deps.workspaceWebOrigin)) {
        res.status(403).json({ error: 'This request failed the browser security check. Refresh and try again.' });
        return null;
      }
    }
    const profile = await deps.userStorage.getProfile(webSession.userId);
    if (!profile) return unauthorized();
    const memberships = deps.orgStorage
      ? await deps.orgStorage.listMembershipsByUser(profile.userId).catch(() => [])
      : [];
    // Out of a copy, a sign-in still held is ended here, whatever reached it.
    if (deps.privateCopy && memberships.length === 0 && !(await insideCopy(profile.userId, memberships))) {
      await deps.workspaceWebAuth.revokeAllSessions(profile.userId).catch(() => 0);
      res.status(401).json({ error: OUTSIDE_COPY, code: 'outside_copy' });
      return null;
    }
    // A screen may name the workplace it is viewing. Never substitute the
    // globally active org after another tab switches it, and never trust a
    // supplied workplace without checking this person's membership.
    const requestedOrg = req.query?.org;
    if (requestedOrg !== undefined && (typeof requestedOrg !== 'string' || !requestedOrg.trim())) {
      res.status(400).json({ error: 'Choose a workplace.' });
      return null;
    }
    const activeMembership = typeof requestedOrg === 'string'
      ? memberships.find((membership) => membership.orgId === requestedOrg.trim()) ?? null
      : memberships[0] ?? null;
    if (requestedOrg !== undefined && !activeMembership) {
      res.status(403).json({ error: 'You do not belong to this workplace.' });
      return null;
    }
    const legacyOrgId = [...memberships]
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]
      ?.orgId ?? null;
    const auth: MiniAppAuth = {
      userId: profile.userId,
      profile,
      orgId: activeMembership?.orgId ?? null,
      orgRole: activeMembership?.role ?? null,
      legacyOrgId,
      webSession,
      webSessionToken,
    };
    stampPersonSeen(auth);
    return auth;
  };

  /**
   * The People page's "here now" (note #328): every authenticated request is
   * a sign of life in the ACTIVE workplace, written to that membership at
   * most once a minute. Fire-and-forget on purpose — a request must never
   * wait on, or fail for, a stamp that exists to decorate a row. The throttle
   * is per process; a restart costs one extra write per reader, nothing else.
   */
  const personSeenStamps = new Map<string, number>();
  const stampPersonSeen = (auth: MiniAppAuth): void => {
    if (!auth.orgId || !deps.orgStorage) return;
    const key = `${auth.orgId}/${auth.userId}`;
    const now = Date.now();
    const last = personSeenStamps.get(key) ?? 0;
    if (now - last < PERSON_SEEN_STAMP_MS) return;
    personSeenStamps.set(key, now);
    void deps.orgStorage.touchMember(auth.orgId, auth.userId, { lastSeenAt: new Date(now).toISOString() })
      .catch(() => { /* silence: the previous stamp stands */ });
  };

  /**
   * The People page's recap line (note #328): the latest thing this person
   * drove in the active workplace, in the platform's own words. Written
   * by the routes where a human acts — a message to an agent, a decision on
   * a proposal, a note — and read back by `api/org` and the people tick.
   * Awaited so a test can read it straight after the route answers; caught
   * so a failed stamp can never turn a landed action into an error.
   */
  const recordPersonAction = async (auth: MiniAppAuth, text: string): Promise<void> => {
    if (!auth.orgId || !deps.orgStorage || !text) return;
    await deps.orgStorage.touchMember(auth.orgId, auth.userId, { recap: { text, at: new Date().toISOString() } })
      .catch(() => { /* silence: the previous line stands */ });
  };

  /**
   * A subscription is the person's, not the workplace's (note #602). When a
   * membership is first entered, carry one current sign-in for every provider
   * the person can already use. Prefer the primary choices from their active
   * workplace, then their newest usable private sign-ins. The membership
   * stamp keeps this a welcome, not a policy loop: removing a sign-in here
   * later remains an explicit choice.
   */
  const inheritPrivateSeats = async (userId: string, orgId: string): Promise<void> => {
    const storage = deps.orgStorage;
    if (!storage) return;
    const membership = await storage.getMembership(orgId, userId);
    if (!membership || membership.inheritedSeatsAt) return;

    const memberships = await storage.listMembershipsByUser(userId);
    const [assigned, privateSeats, sourceLists] = await Promise.all([
      storage.listSeatsByMember(orgId, userId),
      storage.listSeatsByUser(userId),
      Promise.all(memberships
        .filter((entry) => entry.orgId !== orgId)
        .map((entry) => storage.listSeatsByMember(entry.orgId, userId))),
    ]);
    const covered = new Set<OrgSeatDocument['provider']>(
      assigned.filter((seat) => isLiveSeatStatus(seat.status)).map((seat) => seat.provider),
    );
    const inherited = new Set<OrgSeatDocument['provider']>();
    const seen = new Set<string>();
    const candidates = [
      ...sourceLists.flatMap((seats) => [
        ...seats.filter((seat) => seat.selected),
        ...seats.filter((seat) => !seat.selected),
      ]),
      ...privateSeats,
    ];
    for (const seat of candidates) {
      if (seen.has(seat.seatId) || covered.has(seat.provider) || !isLiveSeatStatus(seat.status)) continue;
      seen.add(seat.seatId);
      const assignment = await storage.assignSeat(orgId, userId, seat.seatId);
      if (!assignment) throw new Error(`could not inherit seat ${seat.seatId} into ${orgId}`);
      covered.add(seat.provider);
      inherited.add(seat.provider);
    }
    await storage.touchMember(orgId, userId, { inheritedSeatsAt: new Date().toISOString() });
    for (const provider of inherited) {
      await deps.agentLifecycle?.connectAgentsForSeat?.(userId, provider, orgId)
        .catch(() => { /* the assignment landed; an agent can reconnect on its next turn */ });
    }
  };

  // Browser authentication endpoints are available only when the rotating
  // secret can be encrypted at rest and a canonical public origin is set.
  const loginLimiter = new RateLimiter(12, 10 * 60_000);
  const enrollmentLimiter = new RateLimiter(8, 10 * 60_000);
  const verificationLimiter = new RateLimiter(8, 10 * 60_000);
  // Typing a name into the signup field asks this a handful of times; a
  // harvester reading out every name we host would need it thousands of
  // times. The check is free to a person and slow to a list-builder.
  const mailAddressLimiter = new RateLimiter(40, 10 * 60_000);
  const webConfig = (res: Response) => {
    if (!deps.workspaceWebAuth || !deps.workspaceWebOrigin || !deps.userStorage) {
      res.status(503).json({ error: 'Browser sign-in is not configured on this backend.' });
      return null;
    }
    return {
      auth: deps.workspaceWebAuth,
      origin: deps.workspaceWebOrigin,
      users: deps.userStorage,
    };
  };
  const publicWriteAllowed = (req: Request, res: Response, limiter: RateLimiter): boolean => {
    const configured = webConfig(res);
    if (!configured) return false;
    if (!requestHasWorkspaceOrigin(req, configured.origin, deps.workspaceWebCompatibleOrigins)) {
      res.status(403).json({ error: 'Open this sign-in page from the Workspace address and try again.' });
      return false;
    }
    const address = req.ip || req.socket.remoteAddress || 'unknown';
    if (!limiter.check(address)) {
      res.setHeader('Retry-After', '600');
      res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
      return false;
    }
    return true;
  };
  /**
   * A public READ door: configured, and rate-limited per source address.
   *
   * Deliberately without the Origin check `publicWriteAllowed` makes: a
   * browser sends no Origin header on a same-origin GET, so requiring one
   * would 403 the Workspace's own signup field while every test that never
   * speaks real HTTP stayed green. Nothing here changes state, so the header
   * that exists to stop a cross-site WRITE has nothing to protect.
   */
  const publicReadAllowed = (req: Request, res: Response, limiter: RateLimiter): boolean => {
    if (!webConfig(res)) return false;
    const address = req.ip || req.socket.remoteAddress || 'unknown';
    if (!limiter.check(address)) {
      res.setHeader('Retry-After', '600');
      res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
      return false;
    }
    return true;
  };
  const sendWebAuthError = (res: Response, error: unknown) => {
    if (error instanceof WorkspaceWebAuthError) {
      const status = error.code === 'authentication_required' ? 401
        : error.code === 'verification_unavailable' ? 503
        : error.code === 'profile_missing' ? 404
          : error.code === 'outside_email_closed' ? 410
            : error.code === 'username_taken' || error.code === 'email_taken'
              || error.code === 'already_enabled' || error.code === 'mailbox_taken' ? 409
            : 400;
      return res.status(status).json({ error: error.message, code: error.code });
    }
    console.warn('[workspace-auth] request failed:', error);
    return res.status(500).json({ error: 'Browser sign-in could not be completed.' });
  };

  router.get('/auth/session', async (req, res) => {
    const configured = webConfig(res);
    if (!configured) return;
    res.setHeader('Cache-Control', 'no-store');
    const token = workspaceSessionToken(req, configured.origin);
    const session = await configured.auth.authenticateSession(token);
    /*
     * A browser holding a session that no longer resolves — revoked from
     * another device, expired, or belonging to a profile that has since gone —
     * has BOTH cookies taken back, not just a 401. The CSRF cookie beside the
     * session one is readable by JavaScript, and the public front page reads it
     * as "signed in" to send its owner here (index.html, note #526). Left in
     * place after the session behind it died, it would bounce this person off
     * the marketing page every time they asked for it, and the only way back
     * would be clearing cookies by hand. Clearing it here makes the first
     * bounce the last one.
     *
     * Either cookie alone is enough to act on, and the CSRF one is the reason:
     * it is the half the front page actually reads, so a jar that has kept it
     * and lost the session is precisely the jar that bounces forever. A caller
     * carrying neither is simply anonymous and is told nothing to forget.
     */
    const forgetStaleSession = (): void => {
      clearWorkspaceSessionCookies(res, configured.origin);
    };
    if (!session) {
      if (token || workspaceCsrfCookie(req, configured.origin)) forgetStaleSession();
      return res.status(401).json({ authenticated: false } satisfies WorkspaceSessionAnswer);
    }
    const [profile, identity, memberships] = await Promise.all([
      configured.users.getProfile(session.userId),
      configured.auth.identityForUser(session.userId),
      deps.orgStorage?.listMembershipsByUser(session.userId).catch(() => []) ?? [],
    ]);
    if (!profile || !identity) {
      forgetStaleSession();
      return res.status(401).json({ authenticated: false } satisfies WorkspaceSessionAnswer);
    }
    // Where THIS TAB stands (note #628): the workplace it names, while this
    // person still belongs to it; the account's own marker otherwise. Two
    // tabs on two workplaces each keep their own — the marker is only where
    // a tab that names none begins.
    const standing = typeof req.query?.org === 'string' ? req.query.org.trim() : '';
    const standingIn = (standing && memberships.find((membership) => membership.orgId === standing)) || memberships[0];
    return res.json({
      authenticated: true,
      username: identity.username,
      displayName: personDisplayName(profile),
      ...(standingIn?.orgId ? { activeOrgId: standingIn.orgId } : {}),
      ...(identity.kind === 'email' ? {
        emailVerification: {
          email: identity.email,
          status: workspaceEmailVerificationStatus(identity),
        },
      } : {}),
      session: {
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
      },
    } satisfies WorkspaceSessionAnswer);
  });

  /**
   * What lets a person make an account on a private copy (note #808), which
   * takes nobody who walks up. A live invite link into a workplace that is
   * not being deleted; or, while the copy has no account at all, the
   * installer's first-account code. Null is a refusal. Seam for company
   * sign-in, if it comes: a verified company identity would be a third kind.
   */
  type CopyAdmission = { kind: 'invite'; token: string } | { kind: 'first' };
  const copyAdmission = async (body: unknown): Promise<CopyAdmission | null> => {
    const fields = (body ?? {}) as { inviteToken?: unknown; firstAccountCode?: unknown };
    const token = typeof fields.inviteToken === 'string' ? fields.inviteToken.trim() : '';
    if (token) {
      if (!deps.orgStorage) return null;
      const invite = await deps.orgStorage.getInvite(token).catch(() => null);
      const org = invite ? await deps.orgStorage.getOrg(invite.orgId).catch(() => null) : null;
      if (!invite || !org || invite.usedAt || org.deletion || invitesShutFor(deps.invitesClosed, org)) return null;
      return { kind: 'invite', token };
    }
    const code = typeof fields.firstAccountCode === 'string' ? fields.firstAccountCode : '';
    if (!code || !deps.firstAccountCode || !deps.userStorage) return null;
    // Compared as digests, so the time taken says nothing about the code.
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(code), digest(deps.firstAccountCode))) return null;
    return (await deps.userStorage.getAllUsers()).length === 0 ? { kind: 'first' } : null;
  };

  /**
   * Create an account: one address on our own mail domain, and a password
   * (note #509). There is no outside email here and no confirmation link —
   * nobody but this person could have chosen this name, so there is nothing
   * to prove and the session opens at once.
   *
   * The path keeps its old name so a page loaded before this change still
   * reaches a live route; an outside email sent to it is refused in words
   * that say where accounts come from now.
   */
  router.post('/auth/email/register', async (req, res) => {
    if (!publicWriteAllowed(req, res, enrollmentLimiter)) return;
    const configured = webConfig(res)!;
    // A page loaded before this change still posts an outside email here.
    // Say what happened rather than refusing it as a malformed name.
    if (req.body?.email && !req.body?.mailbox) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(410).json({
        error: 'Accounts are created with an address here now. Reload this page to choose yours.',
        code: 'outside_email_closed',
      });
    }
    // A private copy takes nobody who walks up (note #808): an account comes
    // through a live invite link, or is the copy's first, made with the
    // installer's code. Refused in words, and nothing is created. Our own
    // platform with sign-up closed (note #823) takes the same invite links,
    // into a workplace whose invites are open, and nothing else.
    const gated = Boolean(deps.privateCopy || deps.signupClosed);
    // An invite link admits on every backend (note #949, Adam, 2 Nov 2026):
    // whoever makes their account through one gets no spare workplace, open
    // sign-up or not. A link that no longer admits leaves open sign-up as it
    // was (an ordinary account) and is refused where sign-up is closed.
    const admission = gated || req.body?.inviteToken ? await copyAdmission(req.body) : null;
    // The licence's people limit, or a lapsed licence, turns the next person
    // away in words (note #814). Never the first account: its admin is who
    // pastes the licence.
    const licenceRefusal = admission?.kind === 'invite' ? await deps.copyLicence?.personRefusal() : null;
    if (licenceRefusal) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(403).json({ error: licenceRefusal, code: 'licence' });
    }
    if (gated && !admission) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(403).json({
        error: req.body?.inviteToken
          ? 'This invite link is no longer active. Ask an admin of the workplace for its current link.'
          : deps.privateCopy
            ? 'Accounts here are made through an invite link. Ask an admin of your workplace for one.'
            : SIGNUP_CLOSED_LINE,
        code: 'registration_closed',
      });
    }
    const firstVisit = cleanFirstVisit(req.body?.firstVisit);
    try {
      const created = await configured.auth.registerMailbox({
        mailbox: req.body?.mailbox,
        password: req.body?.password,
        firstName: req.body?.firstName,
        lastName: req.body?.lastName,
        userAgent: req.get('user-agent'),
        // Where this browser first came from (shared/first-visit.ts). A
        // malformed one is dropped, never a reason to refuse the account.
        ...(firstVisit ? { firstVisit } : {}),
      });
      setWorkspaceSessionCookies(res, created.session, configured.origin);
      // The workplace is made WITH the account (note #144), with a useful
      // default name from the person's first name. It stays `unnamed` while
      // it is only the spare workplace every account receives — important for
      // a person who came to join somebody else's team. Once a live
      // subscription is connected (the cloud is ours since note #664),
      // `foundIfReady` accepts this default automatically and founds it
      // without another form.
      // A workplace that could not be made is not a reason to refuse the
      // account — the founder door still opens one by hand.
      // Through an invite link there is no spare workplace (a copy since note
      // #808, every backend since note #949): the request to join is filed
      // with the account, the request page is where it starts, and once an
      // admin approves, the team's workplace is the person's only one. A request that could not be filed leaves the link's
      // own Request to join button, one screen on.
      if (deps.orgStorage && admission?.kind === 'invite') {
        try {
          const outcome = await deps.orgStorage.requestToJoin(admission.token, created.userId);
          if (outcome.ok) {
            await notifyJoinRequested(outcome.org.orgId, outcome.org.name, created.userId, outcome.request.requestId);
          }
        } catch (error) {
          console.warn(`[org] the new account ${created.userId} could not ask to join with its invite:`, error);
        }
      } else if (deps.orgStorage) {
        try {
          const first = String(req.body?.firstName ?? '').trim();
          const org = await deps.orgStorage.createOrg({
            name: first ? `${first}’s workplace` : 'Your workplace',
            createdByUserId: created.userId, unnamed: true, foundingPending: true, firstRun: true,
          });
          await deps.orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
          await deps.orgHandles?.assignDerived(org);
          await deps.orgStorage.addMember({ orgId: org.orgId, userId: created.userId, role: 'admin' });
          await deps.orgStorage.setActiveOrg(created.userId, org.orgId);
          // Ordinarily the prerequisites are still absent. Browser harnesses
          // and restored accounts may already have them; the same readiness
          // edge must skip the retired naming step there too.
          await foundIfReady(created.userId, org.orgId);
        } catch (error) {
          console.warn(`[org] no workplace could be made for the new account ${created.userId}:`, error);
        }
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(201).json({
        authenticated: true,
        address: created.address,
      } satisfies WorkspaceEmailRegisterAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  /**
   * Is this name still free? The signup field asks while it is being typed,
   * so the person learns it before they submit rather than after their
   * account is refused. A read, with the same per-IP ceiling the public auth
   * routes have.
   */
  router.get('/auth/email/address', async (req, res) => {
    if (!publicReadAllowed(req, res, mailAddressLimiter)) return;
    if (!deps.mailboxes) return res.status(503).json({ error: 'Addresses are not available on this backend.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(await deps.mailboxes.availability(req.query.local ?? req.query.address));
  });

  router.post('/auth/email/login', async (req, res) => {
    if (!publicWriteAllowed(req, res, loginLimiter)) return;
    const configured = webConfig(res)!;
    try {
      const issued = await configured.auth.loginEmail({
        email: req.body?.email,
        password: req.body?.password,
        userAgent: req.get('user-agent'),
      });
      if ('verificationRequired' in issued) {
        res.setHeader('Cache-Control', 'no-store');
        return res.json(issued satisfies WorkspaceEmailLoginAnswer);
      }
      if ('secondFactorRequired' in issued) {
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ authenticated: false, ...issued } satisfies WorkspaceEmailLoginAnswer);
      }
      const outside = await admitToCopy(issued.session.userId, req.body);
      if (outside) {
        await configured.auth.revokeAllSessions(issued.session.userId).catch(() => 0);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(403).json({ error: outside, code: 'outside_copy' });
      }
      setWorkspaceSessionCookies(res, issued, configured.origin);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ authenticated: true } satisfies WorkspaceEmailLoginAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.post('/auth/email/resend', async (req, res) => {
    if (!publicWriteAllowed(req, res, verificationLimiter)) return;
    const configured = webConfig(res)!;
    try {
      await configured.auth.requestEmailVerification(req.body?.email, req.body?.inviteToken);
    } catch (error) {
      if (error instanceof WorkspaceWebAuthError && error.code === 'verification_unavailable') {
        return sendWebAuthError(res, error);
      }
      // The public answer never reveals whether an address exists, is already
      // verified, hit its durable limit, or had a provider delivery failure.
      console.warn('[workspace-auth] verification resend could not be delivered');
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(202).json({ accepted: true } satisfies WorkspaceEmailVerificationResendAnswer);
  });

  router.post('/auth/email/verify', async (req, res) => {
    if (!publicWriteAllowed(req, res, verificationLimiter)) return;
    const configured = webConfig(res)!;
    try {
      const issued = await configured.auth.verifyEmail(req.body?.token, req.get('user-agent'));
      if (issued) setWorkspaceSessionCookies(res, issued, configured.origin);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        verified: true,
        authenticated: Boolean(issued),
      } satisfies WorkspaceEmailVerificationFinishAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.post('/auth/email/second-factor', async (req, res) => {
    if (!publicWriteAllowed(req, res, loginLimiter)) return;
    const configured = webConfig(res)!;
    try {
      const issued = await configured.auth.finishSecondFactor({
        secondFactorToken: typeof req.body?.secondFactorToken === 'string' ? req.body.secondFactorToken : '',
        code: typeof req.body?.code === 'string' ? req.body.code : undefined,
        recoveryCode: typeof req.body?.recoveryCode === 'string' ? req.body.recoveryCode : undefined,
        userAgent: req.get('user-agent'),
      });
      const outside = await admitToCopy(issued.session.userId, req.body);
      if (outside) {
        await configured.auth.revokeAllSessions(issued.session.userId).catch(() => 0);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(403).json({ error: outside, code: 'outside_copy' });
      }
      setWorkspaceSessionCookies(res, issued, configured.origin);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ authenticated: true } satisfies WorkspaceSecondFactorAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.post('/auth/email/link', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    const configured = webConfig(res)!;
    try {
      const registered = await configured.auth.registerEmail({
        email: req.body?.email,
        password: req.body?.password,
        authenticatedUserId: current.userId,
        userAgent: req.get('user-agent'),
      });
      return res.json({
        authenticated: true,
        email: registered.email,
        verificationRequired: true,
      } satisfies WorkspaceEmailLinkAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.post('/auth/email/password', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    const configured = webConfig(res)!;
    try {
      await configured.auth.changeEmailPassword(
        current.userId,
        req.body?.currentPassword,
        req.body?.newPassword,
      );
      const revoked = await configured.auth.revokeAllSessions(current.userId, current.webSession?.sessionId);
      return res.json({ changed: true, revoked } satisfies WorkspaceEmailPasswordAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  /**
   * "Forgot your password?" Existence-oblivious like the public resend: the
   * answer is 202 whether the name has an account and whether that account
   * has a recovery address to write to. Only a backend with no mail
   * delivery at all says so.
   */
  router.post('/auth/email/forgot', async (req, res) => {
    if (!publicWriteAllowed(req, res, verificationLimiter)) return;
    const configured = webConfig(res)!;
    try {
      await configured.auth.requestPasswordReset(req.body?.name ?? req.body?.email);
    } catch (error) {
      if (error instanceof WorkspaceWebAuthError && error.code === 'verification_unavailable') {
        return sendWebAuthError(res, error);
      }
      console.warn('[workspace-auth] password reset could not be delivered');
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(202).json({ accepted: true } satisfies WorkspacePasswordForgotAnswer);
  });

  /** The link from that mail. Sets the password, signs every browser out,
   * opens no session of its own. */
  router.post('/auth/email/reset', async (req, res) => {
    if (!publicWriteAllowed(req, res, verificationLimiter)) return;
    const configured = webConfig(res)!;
    try {
      await configured.auth.resetPassword(req.body?.token, req.body?.password);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ reset: true } satisfies WorkspacePasswordResetAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  /** Settings: the outside address a forgotten password may be reset
   * through. Pending until its owner opens the link. */
  router.post('/auth/email/recovery', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    const configured = webConfig(res)!;
    try {
      const requested = await configured.auth.requestRecoveryEmail(current.userId, req.body?.email);
      return res.json({ email: requested.email, verificationRequired: true } satisfies WorkspaceRecoveryEmailAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.delete('/auth/email/recovery', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    const configured = webConfig(res)!;
    try {
      await configured.auth.removeRecoveryEmail(current.userId);
      return res.json({ removed: true } satisfies WorkspaceRecoveryEmailRemoveAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.post('/auth/email/recovery/confirm', async (req, res) => {
    if (!publicWriteAllowed(req, res, verificationLimiter)) return;
    const configured = webConfig(res)!;
    try {
      const confirmed = await configured.auth.confirmRecoveryEmail(req.body?.token);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ confirmed: true, email: confirmed.email } satisfies WorkspaceRecoveryEmailConfirmAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.post('/auth/totp/start', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    const configured = webConfig(res)!;
    try {
      const enrollment = await configured.auth.startTotpSecondFactor(current.userId);
      const qrDataUrl = await QRCode.toDataURL(enrollment.otpauthUrl, {
        errorCorrectionLevel: 'M', margin: 1, width: 240,
      });
      return res.status(201).json({
        ...enrollment,
        username: current.profile.email,
        qrDataUrl,
        otp: { digits: TOTP_DIGITS, periodSeconds: TOTP_PERIOD_SECONDS, kind: 'totp' },
      } satisfies WorkspaceEnrollmentStartAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.post('/auth/totp/finish', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    const configured = webConfig(res)!;
    try {
      const finished = await configured.auth.finishTotpSecondFactor({
        userId: current.userId,
        enrollmentToken: typeof req.body?.enrollmentToken === 'string' ? req.body.enrollmentToken : '',
        code: typeof req.body?.code === 'string' ? req.body.code : '',
      });
      return res.status(201).json({
        authenticated: true,
        username: current.profile.email,
        recoveryCodes: finished.recoveryCodes,
        linkedExistingUser: true,
      } satisfies WorkspaceEnrollmentFinishAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.post('/auth/totp/disable', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    const configured = webConfig(res)!;
    try {
      await configured.auth.disableTotpSecondFactor(
        current.userId,
        typeof req.body?.code === 'string' ? req.body.code : '',
      );
      return res.json({ disabled: true });
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  // Legacy authenticator endpoints stay reachable during the migration. The
  // public door no longer creates TOTP accounts, but an owner who has not yet
  // linked email can still enter with the credential they already hold.
  router.post('/auth/enroll/start', async (req, res) => {
    if (!publicWriteAllowed(req, res, enrollmentLimiter)) return;
    const configured = webConfig(res)!;
    // This door only ever makes a NEW account, so with sign-up closed on our
    // platform (note #823) it is shut too.
    if (deps.signupClosed) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(403).json({ error: SIGNUP_CLOSED_LINE, code: 'registration_closed' });
    }
    try {
      const enrollment = await configured.auth.startEnrollment(req.body?.username);
      const qrDataUrl = await QRCode.toDataURL(enrollment.otpauthUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 240,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(201).json({
        ...enrollment,
        qrDataUrl,
        otp: { digits: TOTP_DIGITS, periodSeconds: TOTP_PERIOD_SECONDS, kind: 'totp' },
      } satisfies WorkspaceEnrollmentStartAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.post('/auth/enroll/finish', async (req, res) => {
    if (!publicWriteAllowed(req, res, enrollmentLimiter)) return;
    const configured = webConfig(res)!;
    try {
      const issued = await configured.auth.finishEnrollment({
        enrollmentToken: typeof req.body?.enrollmentToken === 'string' ? req.body.enrollmentToken : '',
        code: typeof req.body?.code === 'string' ? req.body.code : '',
        userAgent: req.get('user-agent'),
      });
      setWorkspaceSessionCookies(res, issued, configured.origin);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(201).json({
        authenticated: true,
        username: issued.username,
        recoveryCodes: issued.recoveryCodes,
        linkedExistingUser: issued.linkedExistingUser,
      } satisfies WorkspaceEnrollmentFinishAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.post('/auth/login', async (req, res) => {
    if (!publicWriteAllowed(req, res, loginLimiter)) return;
    const configured = webConfig(res)!;
    try {
      const issued = await configured.auth.login({
        username: req.body?.username,
        code: typeof req.body?.code === 'string' ? req.body.code : '',
        userAgent: req.get('user-agent'),
      });
      setWorkspaceSessionCookies(res, issued, configured.origin);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ authenticated: true } satisfies WorkspaceLoginAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.post('/auth/recovery', async (req, res) => {
    if (!publicWriteAllowed(req, res, loginLimiter)) return;
    const configured = webConfig(res)!;
    try {
      const issued = await configured.auth.recover({
        username: req.body?.username,
        recoveryCode: typeof req.body?.recoveryCode === 'string' ? req.body.recoveryCode : '',
        userAgent: req.get('user-agent'),
      });
      setWorkspaceSessionCookies(res, issued, configured.origin);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ authenticated: true, usedRecoveryCode: true } satisfies WorkspaceRecoveryAnswer);
    } catch (error) {
      return sendWebAuthError(res, error);
    }
  });

  router.get('/auth/sessions', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    const configured = webConfig(res);
    if (!configured) return;
    const sessions = await configured.auth.listSessions(current.userId, current.webSessionToken);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ sessions });
  });

  router.delete('/auth/sessions/:sessionId', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    const configured = webConfig(res);
    if (!configured) return;
    const sessionId = String(req.params.sessionId ?? '');
    const revoked = await configured.auth.revokeSession(current.userId, sessionId);
    if (current.webSession?.sessionId === sessionId) clearWorkspaceSessionCookies(res, configured.origin);
    return res.json({ revoked });
  });

  router.post('/auth/logout-others', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    const configured = webConfig(res);
    if (!configured) return;
    const revoked = await configured.auth.revokeAllSessions(current.userId, current.webSession?.sessionId);
    return res.json({ revoked });
  });

  router.post('/auth/logout', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    const configured = webConfig(res);
    if (!configured) return;
    if (current.webSession) {
      await configured.auth.revokeSession(current.userId, current.webSession.sessionId);
      clearWorkspaceSessionCookies(res, configured.origin);
    }
    return res.json({ loggedOut: Boolean(current.webSession) });
  });

  router.post('/auth/logout-all', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    const configured = webConfig(res);
    if (!configured) return;
    const revoked = await configured.auth.revokeAllSessions(current.userId);
    if (current.webSession) clearWorkspaceSessionCookies(res, configured.origin);
    return res.json({ revoked });
  });

  router.get('/api/notifications', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    if (!deps.workspaceNotifications) {
      return res.json({ notifications: [], unread: 0 } satisfies WorkspaceNotificationsAnswer);
    }
    const notificationState = await deps.workspaceNotifications.list(current.userId);
    res.setHeader('Cache-Control', 'no-store');
    return res.json(notificationState satisfies WorkspaceNotificationsAnswer);
  });

  router.post('/api/notifications/read', async (req, res) => {
    const current = await authenticate(req, res);
    if (!current) return;
    if (!deps.workspaceNotifications) return res.json({ marked: 0 });
    const marked = req.body?.all === true
      ? await deps.workspaceNotifications.markAllRead(current.userId)
      : await deps.workspaceNotifications.markRead(
          current.userId,
          Array.isArray(req.body?.notificationIds)
            ? req.body.notificationIds.filter((id: unknown): id is string => typeof id === 'string')
            : [],
        );
    return res.json({ marked } satisfies WorkspaceNotificationsReadAnswer);
  });

  /**
   * The pre-generated agent avatars (one fixed dog per pool name), for the
   * Workspace's agent rows. Unauthenticated ON PURPOSE: an <img> tag cannot
   * carry the initData Authorization header, and the set is one public
   * picture per pool name, keyed by first names. Nothing here is per-user.
   */
  router.get('/avatars/:name', (req, res) => {
    const name = String(req.params.name ?? '');
    // The one reserved face, outside the pool's letters-only names.
    const avatar = name === WORKSPACE_AGENT_AVATAR_SLUG ? readWorkspaceAgentAvatar() : readTelegramAgentAvatar(name);
    if (!avatar) {
      return res.status(404).json({ error: 'No such avatar' });
    }
    // A day of cache: the dogs change about never (a breed swap is a PR), and
    // a stale day after one is painless.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.type('image/jpeg').send(avatar);
  });

  /**
   * A site's own favicon, for its row in the Sites card. Unauthenticated for
   * the same reason the avatars are — an `<img>` cannot carry initData — and
   * it gives nothing away: these are public files off public sites, reachable
   * by anyone who can type the address the row already links to.
   *
   * The name is looked up BEFORE anything is fetched, and only a live site
   * with that exact current name gets one. That is what keeps this from being
   * an open proxy: the only URL it will ever request is a site of ours that
   * exists, on our own apps domain, at the address `url()` builds.
   */
  router.get('/site-icon/:name', async (req, res) => {
    const missing = () => res.status(404).json({ error: 'No icon for this site' });
    const name = String(req.params.name ?? '');
    if (!deps.deploymentStorage || !deps.deploymentService) return missing();
    if (!DEPLOYMENT_NAME_PATTERN.test(name)) return missing();
    const doc = await deps.deploymentStorage.getByName(name).catch(() => null);
    // `getByName` also answers to a site's FORMER names, and an old address is
    // a redirect, not a site — the row that wants an icon always asks by the
    // current name.
    if (!doc || doc.name !== name || doc.status !== 'live') return missing();
    const icon = await siteFavicons.get(deps.deploymentService.url(doc));
    if (!icon) return missing();
    // An hour in the webview, which reopens constantly; the fetch behind this
    // is cached for longer still. Nothing here is per-user, so `public`.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('ETag', icon.etag);
    // An SVG favicon is a document, and this one came off a site the user's
    // agent deployed. Rendered in an `<img>` it is inert either way, but a
    // person can also open this URL directly — and then it would be a script
    // running on the backend's own origin. Sandboxed, with sniffing off, it
    // cannot be anything but a picture.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.type(icon.contentType).send(icon.body);
  });

  const requireSecrets = (res: Response) => {
    if (!deps.secretStorage) {
      res.status(503).json({ error: 'Secrets are not available on this backend yet' });
      return null;
    }
    return new UserSecretsService(deps.secretStorage);
  };

  /**
   * The viewer's git namespace (byo-git-design slice 1): the workplace's own
   * — a workplace is one place since note #843 — or the viewer's on a
   * personal account. Destruction and CI-secret grants stay admin verbs;
   * `role` gates them.
   */
  const gitNamespaceFor = async (userId: string, orgId?: string | null): Promise<GitNamespace> => {
    if (deps.orgGit) return deps.orgGit.resolveNamespace(userId, orgId);
    // Small/test deployments may wire the org store before the git service.
    if (orgId && deps.orgStorage) {
      const org = await deps.orgStorage.getOrg(orgId).catch(() => null);
      if (org) return { namespaceId: orgKnowledgeShelfNamespace(org), orgId, role: null };
    }
    return { namespaceId: userId, orgId: null, role: null };
  };

  /** Where the page's notes, keys, knowledge and repositories are: the
   *  workplace's namespace. An old link's `?room=` is read by nothing. */
  const viewerNamespaceFor = async (
    auth: MiniAppAuth,
    _req?: Request,
    _res?: Response,
    _opts?: { notes?: boolean },
  ): Promise<GitNamespace | null> => gitNamespaceFor(auth.userId, auth.orgId);

  const viewerOwnerId = async (
    auth: MiniAppAuth,
    req: Request,
    res: Response,
    opts?: { notes?: boolean },
  ): Promise<string | null> => (
    (await viewerNamespaceFor(auth, req, res, opts))?.namespaceId ?? null
  );

  /**
   * Every namespace of the viewer's org — what by-id reads check ownership
   * against. The home queue is room-scoped (note #98), but a proposal opened
   * from a saved decision link remains reachable after the
   * viewer switches rooms, so by-id authorization still checks the whole org.
   */
  const viewerNamespaces = async (auth: Pick<MiniAppAuth, 'userId' | 'orgId'>): Promise<string[]> => (
    deps.orgGit && auth.orgId
      ? deps.orgGit.namespacesForOrg(auth.userId, auth.orgId)
      : [(await gitNamespaceFor(auth.userId, auth.orgId)).namespaceId]
  );

  /**
   * Where a new note's NUMBER comes from (note #741): one series for the
   * whole workplace, seeded above every number any of its rooms holds, so a
   * number names exactly one note anywhere in it. A personal account is its
   * own series.
   */
  const numberSeries = async (auth: MiniAppAuth): Promise<NumberSeries> => ({
    series: workplaceNumberSeries(auth.orgId, (await gitNamespaceFor(auth.userId, auth.orgId)).namespaceId),
    namespaces: await numberedNamespaces(auth),
  });

  /**
   * Every namespace a note or proposal number is looked for in, and a new
   * number seeded above: the viewer's org namespaces plus every room's own —
   * read off the room rows as well, because a small deployment (and the
   * browser harnesses) may wire the org store without the git service that
   * `viewerNamespaces` otherwise walks.
   */
  const numberedNamespaces = async (auth: MiniAppAuth, extra?: string | null): Promise<string[]> => {
    const namespaces = new Set(await viewerNamespaces(auth));
    if (extra) namespaces.add(extra);
    if (auth.orgId && deps.orgStorage) {
      const org = await deps.orgStorage.getOrg(auth.orgId).catch(() => null);
      for (const namespace of org?.roomsMerged?.namespaces ?? []) namespaces.add(namespace);
    }
    return [...namespaces];
  };

  /** Resolve Drive's workplace only after proving membership. Generated
   * links carry `org`; an older hand-written link may omit it and then means
   * the caller's active workplace. */
  const driveOrganizationMembership = async (
    auth: MiniAppAuth,
    rawOrgId: unknown,
  ): Promise<OrgMembershipDocument | null> => {
    if (!deps.orgStorage) return null;
    const requested = typeof rawOrgId === 'string' ? rawOrgId.trim() : '';
    const orgId = requested || auth.orgId || '';
    if (!orgId) return null;
    return deps.orgStorage.getMembership(orgId, auth.userId).catch(() => null);
  };

  registerDriveRoutes(router, '/api/drive', deps, async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return null;
    const membership = await driveOrganizationMembership(auth, req.query.org);
    if (!membership) { res.status(404).json({ error: 'No such workplace Drive.' }); return null; }
    return { orgId: membership.orgId, userId: auth.userId, canDeleteForever: membership.role === 'admin' };
  }, { allowPermanentDelete: true });
  registerRadioRoutes(router, '/api/radio', deps, authenticate, async (auth) => isAdminAccount(auth.profile));

  /** Shared org secrets are an admin cupboard; personal namespaces have no role gate. */
  const canManageSharedSecrets = (auth: MiniAppAuth): boolean => (
    !auth.orgId || auth.orgRole === 'admin'
  );

  /** A bounded LRU of still-valid signatures, plus in-flight de-duplication. */
  const pictureUrls = new Map<string, { url: string; expiresAt: string; refreshAt: number }>();
  const pictureUrlLoads = new Map<string, Promise<{ url: string; expiresAt: string } | undefined>>();

  /**
   * A phone-openable URL for a stored picture — profile photos and org
   * avatars, and since note #825 the pictures on a proposal. Signed and
   * short-lived like a note file's, because an <img> cannot carry the
   * initData header and these are not the public agent faces. The UUID path
   * changes when the picture does; while it does not, reuse one signed URL
   * and let the viewer's browser keep the bytes private.
   *
   * `draw` signs the object to be shown inline rather than saved — what a
   * proposal's picture needs and a profile photo never asks for — and is
   * part of the cache key, so the two signatures never stand in for each
   * other.
   */
  const pictureAccess = async (
    storagePath: string | undefined,
    draw = false,
  ): Promise<{ url: string; expiresAt: string } | undefined> => {
    if (!storagePath || !deps.mediaStorage) return undefined;
    const key = draw ? `${storagePath}#draw` : storagePath;
    const now = Date.now();
    const cached = pictureUrls.get(key);
    if (cached && cached.refreshAt > now) {
      // Refresh insertion order so the cap evicts the least recently used path.
      pictureUrls.delete(key);
      pictureUrls.set(key, cached);
      return { url: cached.url, expiresAt: cached.expiresAt };
    }
    pictureUrls.delete(key);

    const pending = pictureUrlLoads.get(key);
    if (pending) return pending;

    const load = deps.mediaStorage.createReadAccess({
      storagePath,
      expiresInMs: PICTURE_URL_TTL_MS,
      responseCacheControl: PICTURE_RESPONSE_CACHE_CONTROL,
      ...(draw ? { responseDisposition: 'inline' } : {}),
    }).then((access) => {
      const refreshAt = Date.parse(access.expiresAt) - PICTURE_URL_REFRESH_MARGIN_MS;
      if (Number.isFinite(refreshAt) && refreshAt > Date.now()) {
        pictureUrls.set(key, { url: access.url, expiresAt: access.expiresAt, refreshAt });
        while (pictureUrls.size > PICTURE_URL_CACHE_LIMIT) {
          const oldest = pictureUrls.keys().next().value as string | undefined;
          if (!oldest) break;
          pictureUrls.delete(oldest);
        }
      }
      return { url: access.url, expiresAt: access.expiresAt };
    }).catch(() => undefined).finally(() => {
      pictureUrlLoads.delete(key);
    });
    pictureUrlLoads.set(key, load);
    return load;
  };
  const pictureUrl = async (storagePath: string | undefined): Promise<string | undefined> => (
    (await pictureAccess(storagePath))?.url
  );

  /** Whether a proposal's file is a picture the sheet draws as one — the
   *  screen's own rule (ProposalFiles.isPhoto): an image, but not an SVG, a
   *  drawing of unknown dimensions that crops badly. */
  const drawsAsPicture = (file: { fileName: string; contentType?: string }): boolean => {
    const type = inferContentType(file.fileName, file.contentType);
    return type.startsWith('image/') && type !== 'image/svg+xml' && canServeInline(type, file.fileName);
  };

  /**
   * A proposal picture's pixel size (note #825): what was recorded when it
   * was attached, or — for one attached before sizes were — measured once
   * from its header now and written back, so the next read has it for free.
   * Null when the bytes cannot be read or are not a picture after all; the
   * sheet then draws the frame it always drew.
   */
  const proposalPictureShape = async (
    doc: GitPullRequestDocument,
    file: PullRequestAttachment,
  ): Promise<{ width: number; height: number } | null> => {
    if (file.width && file.height) return { width: file.width, height: file.height };
    if (!deps.mediaStorage?.downloadObject || !deps.gitPullRequestStorage) return null;
    const size = await deps.mediaStorage.downloadObject({ storagePath: file.storagePath })
      .then((data) => imageDimensions(Buffer.from(data)))
      .catch(() => null);
    if (!size) return null;
    Object.assign(file, size);
    await deps.gitPullRequestStorage.update(doc.id, { attachments: doc.attachments ?? [] }).catch(() => {});
    return size;
  };

  /**
   * The builders' numbers (services/leaderboard.ts): one read of every
   * builder, shared by every builder page read in the next half minute.
   * Built here because their pictures are signed by this router.
   */
  const leaderboard = new Leaderboard({
    users: async () => (deps.userStorage ? deps.userStorage.getAllUsers() : []),
    workDays: (sinceDay) => deps.agentWorkLedger?.daysSince(sinceDay) ?? [],
    tokenDays: (sinceDay) => deps.agentTokenLedger?.outputDaysSince(sinceDay) ?? [],
    mergedSince: async (sinceIso) => (deps.gitPullRequestStorage ? deps.gitPullRequestStorage.listMergedSince(sinceIso) : []),
    handleOf: async (userId) => {
      const mailbox = deps.mailboxes ? await deps.mailboxes.forUser(userId) : null;
      return mailbox?.address.split('@')[0];
    },
    photoUrl: (storagePath) => pictureUrl(storagePath),
    isWorking: (userId, agentId) => Boolean(deps.agentLifecycle?.isAgentWorking?.(userId, agentId)),
  });

  /**
   * Every member's contribution to a workplace (note #925): the same
   * ledgers, cut to the workplace, read once per workplace every ten seconds
   * and shared by every card, tick and member's screen in that time.
   */
  const contributions = new WorkplaceContributions({
    members: async (orgId) => {
      if (!deps.orgStorage) return [];
      const storage = deps.orgStorage;
      const memberships = await storage.listMembers(orgId);
      return Promise.all(memberships.map(async (member) => {
        const profile = deps.userStorage ? await deps.userStorage.getProfile(member.userId).catch(() => null) : null;
        const historical = await storage.listMembershipsByUser(member.userId).catch(() => []);
        const legacyOrgId = [...historical]
          .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]?.orgId ?? null;
        return { userId: member.userId, profile, legacyOrgId };
      }));
    },
    workTotals: (userId) => deps.agentWorkLedger?.userTotals(userId) ?? [],
    workSince: (userIds, sinceDay) => deps.agentWorkLedger?.agentsSince(userIds, sinceDay) ?? [],
    tokenOutput: (userIds, sinceDay) => deps.agentTokenLedger?.agentOutput(userIds, sinceDay) ?? [],
    merged: async (orgId) => {
      if (!deps.gitPullRequestStorage || !deps.orgStorage) return [];
      const org = await deps.orgStorage.getOrg(orgId);
      return org ? deps.gitPullRequestStorage.listMergedIn(await workplaceNamespaces(org)) : [];
    },
    repoName: async (repoId) => (await deps.gitRepoStorage?.get(repoId))?.name,
  });

  /** The viewer's profile and every other member's of their active org —
   *  the walk the directory below is built on, and the one the live tick
   *  makes for teammates' agents without paying for anybody's picture. */
  const memberProfiles = async (auth: MiniAppAuth): Promise<Map<string, UserProfileDocument>> => {
    const profiles = new Map<string, UserProfileDocument>([[auth.userId, auth.profile]]);
    if (deps.orgStorage && auth.orgId && deps.userStorage) {
      const members = await deps.orgStorage.listMembers(auth.orgId).catch(() => []);
      for (const member of members) {
        if (profiles.has(member.userId)) continue;
        const profile = await deps.userStorage.getProfile(member.userId).catch(() => null);
        if (profile) profiles.set(member.userId, profile);
      }
    }
    return profiles;
  };

  /**
   * Build the request's WorkspacePeople (note #57): the viewer plus every
   * member of their active org, each with their fleet, their name and their
   * face. One pass over the member list — orgs here are rooms, not stadiums —
   * and a missing org layer degrades to the viewer alone, the old behavior.
   */
  const workspacePeople = async (auth: MiniAppAuth): Promise<WorkspacePeople> => {
    const profiles = await memberProfiles(auth);
    const photos = new Map<string, string>();
    for (const [userId, profile] of profiles) {
      const url = await pictureUrl(profile.person?.photo?.storagePath);
      if (url) photos.set(userId, url);
    }
    return peopleFrom(profiles, photos, auth, deps.agentWorkLedger);
  };

  /**
   * One agent of ANY member of the workplace, and who drives it (note #640).
   *
   * The reader's own fleet first — their profile is already in hand — then
   * the other members' profiles, which is the same walk `workspacePeople`
   * makes and costs a read per member on a workplace of a dozen. Whether
   * the agent belongs to the workplace ON SCREEN is the caller's check: this
   * only says which member's fleet it was found in.
   */
  const workplaceAgentRecord = async (
    auth: MiniAppAuth,
    agentId: string,
  ): Promise<{ record: AgentRecord; ownerUserId: string } | null> => {
    const own = auth.profile.telegram?.agents?.[agentId];
    if (own) return { record: own, ownerUserId: auth.userId };
    if (!auth.orgId || !deps.orgStorage || !deps.userStorage) return null;
    const members = await deps.orgStorage.listMembers(auth.orgId).catch(() => []);
    for (const member of members) {
      if (member.userId === auth.userId) continue;
      const profile = await deps.userStorage.getProfile(member.userId).catch(() => null);
      const record = profile?.telegram?.agents?.[agentId];
      if (record) return { record, ownerUserId: member.userId };
    }
    return null;
  };

  const activeAgent = (auth: Pick<MiniAppAuth, 'profile' | 'orgId' | 'legacyOrgId'>, agentId: string): AgentRecord | null => {
    const agent = auth.profile.telegram?.agents?.[agentId];
    const belongs = agent?.orgId
      ? agent.orgId === auth.orgId
      : auth.orgId === auth.legacyOrgId;
    if (!agent || !belongs || agent.purpose) return null;
    return agent;
  };

  /**
   * A room agent of this caller's, or this caller's own Workspace Agent in
   * this workplace. The machine a Workspace Agent runs on is looked after
   * exactly like a room agent's — its size, its software, its CLI — so the
   * routes about the MACHINE take either; everything else stays room-only.
   */
  const machineOwnedAgent = (auth: Pick<MiniAppAuth, 'profile' | 'orgId' | 'legacyOrgId'>, agentId: string): AgentRecord | null => (
    activeAgent(auth, agentId)
    ?? Object.values(auth.profile.telegram?.agents ?? {}).find((candidate) => (
      candidate.id === agentId && candidate.orgId === auth.orgId && isWorkspaceAgent(candidate)
    ))
    ?? null
  );

  const proposalOwnedByViewer = (
    auth: MiniAppAuth,
    doc: { createdByUserId?: string; createdByAgentId: string },
  ): boolean => doc.createdByUserId
    ? doc.createdByUserId === auth.userId
    : Boolean(activeAgent(auth, doc.createdByAgentId));

  /** Legacy asks lack byUserId; the asking agent itself still proves ownership. */
  const agentRequestOwnedByViewer = (
    auth: MiniAppAuth,
    ask: { byUserId?: string; byAgentId: string },
  ): boolean => ask.byUserId
    ? ask.byUserId === auth.userId
    : Boolean(activeAgent(auth, ask.byAgentId));

  /** Which git host serves an org's repos (byo-git slice 2b): the org's own
   *  when it has one, else the central host. */
  const gitHostFor = async (orgId?: string | null) => (
    deps.orgGitHost ? deps.orgGitHost.clientFor(orgId ?? null) : deps.gitHostClient!
  );

  /** The named repo of the viewer's workplace, or answer 404 and return null.
   *  Host calls that follow use `repo.userId` — the record's own namespace.
   *
   *  A repository of ANOTHER workplace misses exactly as one that never
   *  existed does — same status, same words, same `code` — so a link to a
   *  private repository confirms nothing to someone outside it. The code is
   *  what lets the screen say so instead of drawing empty tabs (note #671). */
  const namespacedRepo = async (auth: MiniAppAuth, req: Request, name: string, res: Response) => {
    const ns = await viewerNamespaceFor(auth, req, res);
    if (!ns) return null;
    const repo = await workplaceRepo(auth, ns, name);
    if (!repo) {
      res.status(404).json({ error: 'No such repository here', code: NO_SUCH_REPOSITORY });
      return null;
    }
    return repo;
  };

  /**
   * Where a workplace's repositories may live (note #566). A repository
   * belongs to the workplace, not to a room: the namespace in its clone URL
   * is only the address of its bytes, so whichever room a screen is opened
   * from reaches every repository at any of these.
   */
  const workplaceRepoNamespaces = async (
    auth: MiniAppAuth,
    ns: { namespaceId: string; orgId: string | null },
  ): Promise<string[]> => (
    ns.orgId && deps.orgGit
      ? deps.orgGit.namespacesForOrg(auth.userId, ns.orgId)
      : [ns.namespaceId]
  );

  const workplaceRepo = async (
    auth: MiniAppAuth,
    ns: { namespaceId: string; orgId: string | null },
    name: string,
  ) => (await deps.gitRepoStorage?.getLiveByNameIn(await workplaceRepoNamespaces(auth, ns), name)) ?? null;

  const publicRepoUrl = (id: string): string => {
    const path = `${WORKSPACE_BASE}/public/repositories/${encodeURIComponent(id)}`;
    return deps.workspaceWebOrigin ? `${deps.workspaceWebOrigin.replace(/\/+$/, '')}${path}` : path;
  };

  /**
   * Where a public repository OPENS (public-addresses, slice 6): under its
   * workplace's handle, `/acme/site`, when the workplace has one — the
   * link-only token door only for a workplace the boot backfill has not
   * reached. `publicRepoAddress` takes the handle already in hand (a list
   * of one workplace's rows looks it up once); `publicRepoUrlFor` looks it
   * up for one repository.
   */
  const publicRepoAddress = (repo: GitRepoDocument, orgHandle: string | undefined): string => {
    if (!orgHandle) return publicRepoUrl(repo.publicAccess?.id ?? '');
    const path = workspaceRoutePath({ kind: 'workplaceRepo', handle: orgHandle, repo: repo.name })!;
    return deps.workspaceWebOrigin ? `${deps.workspaceWebOrigin.replace(/\/+$/, '')}${path}` : path;
  };
  const orgHandleOf = async (orgId: string | null | undefined): Promise<string | undefined> => (
    orgId && deps.orgStorage ? (await deps.orgStorage.getOrg(orgId).catch(() => null))?.handle : undefined
  );
  const publicRepoUrlFor = async (repo: GitRepoDocument): Promise<string> => (
    publicRepoAddress(repo, await orgHandleOf(repo.orgId))
  );

  /** A public lookup has ONE key and no list endpoint. Keeping the response
   * no-store makes withdrawing access take effect on the next request rather
   * than after a browser or proxy cache decides to let go. */
  const publicRepo = async (id: string, res: Response) => {
    if (typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }
    if (!deps.gitRepoStorage || !deps.gitHostClient) {
      res.status(503).json({ error: 'Repository hosting is not available right now.' });
      return null;
    }
    // Public ids are UUIDs. Refuse every other shape as absence so this door
    // cannot become a registry oracle or an unbounded JSON query.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      res.status(404).json({ error: 'This public repository link is not available.' });
      return null;
    }
    const repo = await deps.gitRepoStorage.getPublicById(id);
    if (!repo) {
      res.status(404).json({ error: 'This public repository link is not available.' });
      return null;
    }
    return repo;
  };

  /** Who is reading a public page, if anybody: the session, never a 401. */
  const publicViewer = async (req: Request) => (
    deps.workspaceWebAuth && deps.workspaceWebOrigin
      ? deps.workspaceWebAuth.authenticateSession(workspaceSessionToken(req, deps.workspaceWebOrigin)).catch(() => null)
      : null
  );

  /**
   * A person's public page (knowledge page "public-addresses", slice 5):
   * `/adam` is whoever holds adam@ on the mail domain. Anonymous and
   * existence-oblivious — a handle nobody holds, a reserved word and a
   * malformed one all answer the same null, so the door tells a stranger
   * nothing the address itself does not. What it says: name, picture,
   * handle, and the public repositories git counts them in (by the address
   * git knows them by: their address here or their sign-in email). Never
   * their workplaces. A signed-in viewer who shares a workplace with them
   * is told which one, so the shell can open the member screen instead.
   */
  const publicPerson = async (handle: string, req: Request): Promise<WorkspacePublicPersonAnswer | null> => {
    if (handleProblem(handle) || !deps.mailboxes || !deps.userStorage) return null;
    const userId = await deps.mailboxes.holderOf(mailAddress(handle)).catch(() => null);
    if (!userId) return null;
    const profile = await deps.userStorage.getProfile(userId).catch(() => null);
    if (!profile) return null;
    const photoUrl = await pictureUrl(profile.person?.photo?.storagePath);
    const knownAs = new Set([mailAddress(handle), profile.email?.trim().toLowerCase()].filter(Boolean));
    const repos: WorkspacePublicPersonRepo[] = [];
    for (const repo of deps.gitRepoStorage ? await deps.gitRepoStorage.listPublic() : []) {
      const author = repo.contributors?.authors.find((entry) => knownAs.has(entry.email.trim().toLowerCase()));
      if (!author || !repo.publicAccess) continue;
      const org = repo.orgId && deps.orgStorage ? await deps.orgStorage.getOrg(repo.orgId).catch(() => null) : null;
      repos.push({
        name: repo.name,
        workplace: org?.name ?? '',
        ...(org?.handle ? { workplaceHandle: org.handle } : {}),
        publicUrl: publicRepoAddress(repo, org?.handle),
        commits: author.commits,
      });
    }
    let colleague: { orgId: string; userId: string } | undefined;
    const session = await publicViewer(req);
    if (session && deps.orgStorage && session.userId !== userId) {
      const theirs = new Set((await deps.orgStorage.listMembershipsByUser(userId)).map((membership) => membership.orgId));
      const shared = (await deps.orgStorage.listMembershipsByUser(session.userId)).find((membership) => theirs.has(membership.orgId));
      if (shared) colleague = { orgId: shared.orgId, userId };
    }
    // Their numbers and the Follow on X pill: to the person themselves,
    // signed in (Adam, 28 Oct 2026, note #824: the public Leaderboard went,
    // and with it the reason anyone else's numbers were public), and to
    // everyone on the founder's page, which the front page shows (note
    // #786). A private copy has no numbers (note #814): its pages stay bare.
    const shown = session?.userId === userId || handle === FOUNDER_HANDLE;
    const board = !deps.privateCopy && shown && hasBuilderPage(profile) ? await leaderboard.forPerson(userId).catch(() => null) : null;
    return {
      handle,
      name: personDisplayName(profile),
      ...(photoUrl ? { photoUrl } : {}),
      repos,
      ...(colleague ? { colleague } : {}),
      ...(board && profile.person?.x ? { x: profile.person.x } : {}),
      ...(board ? { board } : {}),
    };
  };

  /**
   * Every namespace a workplace's repositories can live under, with nobody
   * asking: the org's own stamp (the founder's, before it had one), its old
   * rooms' (note #843), and the ones its repositories already carry — the same walk OrgGitService.namespacesForOrg makes for
   * a member, without the member.
   */
  const workplaceNamespaces = async (org: OrgDocument): Promise<string[]> => {
    if (!deps.orgStorage) return [];
    const carried = await (deps.gitRepoStorage?.listNamespacesByOrg(org.orgId).catch(() => []) ?? []);
    return [...new Set([
      org.git?.namespaceId ?? org.createdByUserId,
      ...(org.roomsMerged?.namespaces ?? []),
      ...carried,
    ])];
  };

  /**
   * A workplace's word, `/acme`: no public page (the owner, 2026-10-12,
   * note #748). Only one of its own signed-in members is told which
   * workplace it is, so the shell opens the workplace's own screen; to
   * anyone else it is null — the same "Nothing at this address." a word
   * nobody holds answers, so the word does not even say a workplace holds
   * it. Its repositories keep their addresses under it (repoByAddress).
   */
  const publicWorkplace = async (handle: string, req: Request): Promise<WorkspacePublicWorkplaceAnswer | null> => {
    if (handleProblem(handle) || !deps.orgStorage) return null;
    const session = await publicViewer(req);
    if (!session) return null;
    const org = await deps.orgStorage.getOrgByHandle(handle).catch(() => null);
    if (!org) return null;
    const member = await deps.orgStorage.getMembership(org.orgId, session.userId).catch(() => null);
    return member ? { member: { orgId: org.orgId } } : null;
  };

  const nothingHere = (res: Response) => res.status(404).json({ error: 'Nothing at this address.' });
  const publicHeaders = (res: Response) => {
    if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
  };

  /**
   * The sealed public guide (note #1010): anyone, signed out, asks the home
   * page's agent a question about the product. One fresh conversation per
   * visit (the page's random visit id), one answer at a time, answers back
   * by polling. The limits, the queue and the rest states live in
   * PublicGuideService; this door checks the Origin and passes the visitor's
   * address, which keys an in-memory limit and is never stored.
   *
   * The address: Cloudflare's own header when the request came through the
   * site's function (every visitor does), else the socket. A caller that
   * goes around the site can name any address in that header — which only
   * moves them between per-visitor buckets; the global hour and day caps
   * count every question whatever it claims.
   */
  const publicAskAddress = (req: Request): string => {
    const forwarded = req.headers?.['cf-connecting-ip'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return (typeof value === 'string' && value.trim()) || req.ip || req.socket?.remoteAddress || 'unknown';
  };
  router.post('/api/public/ask', async (req, res) => {
    publicHeaders(res);
    if (deps.workspaceWebOrigin && !requestHasWorkspaceOrigin(req, deps.workspaceWebOrigin, deps.workspaceWebCompatibleOrigins)) {
      return res.status(403).json({ state: 'invalid', error: 'Ask from agenticcloudcomputer.com.' } satisfies PublicAskAnswer);
    }
    if (!deps.publicGuide) return res.json({ state: 'resting', until: null } satisfies PublicAskAnswer);
    const body = (req.body ?? {}) as { visitId?: unknown; question?: unknown };
    const answer = await deps.publicGuide.ask({ visitId: body.visitId, question: body.question, address: publicAskAddress(req) })
      .catch((error) => {
        console.warn('[public-guide] ask failed:', error);
        return { state: 'resting', until: null } satisfies PublicAskAnswer;
      });
    return res.status(answer.state === 'accepted' ? 202 : answer.state === 'invalid' ? 400 : 200).json(answer satisfies PublicAskAnswer);
  });

  /* Registered before /:questionId, which would otherwise take "status" for an id. */
  router.get('/api/public/ask/status', async (_req, res) => {
    publicHeaders(res);
    const overview = deps.publicGuide ? await deps.publicGuide.overview().catch(() => null) : null;
    if (!overview) return res.json({ state: 'resting', until: null, agent: null } satisfies PublicGuideOverview);
    const name = overview.agentName;
    return res.json({
      state: overview.state,
      until: overview.until,
      agent: name ? { name, avatarUrl: agentFaceUrl(name) ?? null } : null,
    } satisfies PublicGuideOverview);
  });

  router.get('/api/public/ask/:questionId', async (req, res) => {
    publicHeaders(res);
    const status = deps.publicGuide ? await deps.publicGuide.status(String(req.params.questionId ?? '')).catch(() => null) : null;
    return status ? res.json(status satisfies PublicAskStatus) : res.status(404).json({ error: 'No such question.' });
  });

  router.get('/api/public/people/:handle', async (req, res) => {
    publicHeaders(res);
    const person = await publicPerson(String(req.params.handle ?? ''), req);
    return person ? res.json(person satisfies WorkspacePublicPersonAnswer) : nothingHere(res);
  });

  router.get('/api/public/workplaces/:handle', async (req, res) => {
    publicHeaders(res);
    const workplace = await publicWorkplace(String(req.params.handle ?? ''), req);
    return workplace ? res.json(workplace satisfies WorkspacePublicWorkplaceAnswer) : nothingHere(res);
  });

  /**
   * The app catalogue, anonymous (note #756): every site on the platform
   * that is live and listed, most recently PUBLISHED first (note #767) —
   * the name, one line, who built it, the picture and the link. Published
   * means the latest deploy, not the first: a redeployed app is "recent" to
   * a visitor, and that is what the owner asked to see on top. A site whose
   * record predates `lastDeployAt` counts from its first deploy. The maker is the PERSON whose agent
   * deployed it, named as their public page names them and opening it when
   * they have one; the agent, the room and the workplace never cross.
   * Memoised briefly: it is one read of every site record and a signed
   * picture URL each, and a shared link gets opened in bursts.
   */
  const CATALOGUE_MEMO_MS = 20_000;
  const publishedAt = (doc: { createdAt: string; lastDeployAt?: string }) => doc.lastDeployAt ?? doc.createdAt;
  let catalogueMemo: { at: number; answer: WorkspaceAppCatalogueAnswer } | null = null;
  const appCatalogue = async (): Promise<WorkspaceAppCatalogueAnswer> => {
    if (catalogueMemo && Date.now() - catalogueMemo.at < CATALOGUE_MEMO_MS) return catalogueMemo.answer;
    if (!deps.deploymentStorage || !deps.deploymentService) return { apps: [] };
    const docs = (await deps.deploymentStorage.listAll())
      .filter((doc) => siteIsListed(doc))
      .sort((a, b) => publishedAt(b).localeCompare(publishedAt(a)));
    const builders = new Map<string, WorkspaceAppCatalogueEntry['builder']>();
    const builderOf = async (userId: string): Promise<WorkspaceAppCatalogueEntry['builder']> => {
      const known = builders.get(userId);
      if (known) return known;
      const profile = deps.userStorage ? await deps.userStorage.getProfile(userId).catch(() => null) : null;
      const mailbox = deps.mailboxes ? await deps.mailboxes.forUser(userId).catch(() => null) : null;
      const handle = mailbox?.address.split('@')[0];
      const photoUrl = await pictureUrl(profile?.person?.photo?.storagePath);
      const builder: WorkspaceAppCatalogueEntry['builder'] = {
        name: profile ? personDisplayName(profile) : 'A builder',
        ...(handle && !handleProblem(handle) ? { handle } : {}),
        ...(photoUrl ? { photoUrl } : {}),
      };
      builders.set(userId, builder);
      return builder;
    };
    const apps: WorkspaceAppCatalogueEntry[] = [];
    for (const doc of docs) {
      const pictureUrlValue = await pictureUrl(doc.listing?.picture?.storagePath);
      apps.push({
        name: doc.name,
        url: deps.deploymentService.url(doc),
        line: doc.listing?.line ?? '',
        builder: await builderOf(doc.lastDeployBy?.userId ?? doc.userId),
        ...(pictureUrlValue ? { pictureUrl: pictureUrlValue } : {}),
        publishedAt: publishedAt(doc),
        createdAt: doc.createdAt,
      });
    }
    const answer = { apps };
    catalogueMemo = { at: Date.now(), answer };
    return answer;
  };

  router.get('/api/public/apps', async (_req, res) => {
    publicHeaders(res);
    try {
      return res.json(await appCatalogue() satisfies WorkspaceAppCatalogueAnswer);
    } catch (error) {
      console.warn('[apps] the catalogue could not be read:', error);
      return res.status(503).json({ error: 'The app catalogue could not be read just now. Try again in a minute.' });
    }
  });

  /** One word at the root of the domain: a person, or a workplace for one of
   *  its own members (they share the namespace, so never both). */
  router.get('/api/public/addresses/:handle', async (req, res) => {
    publicHeaders(res);
    const handle = String(req.params.handle ?? '');
    const person = await publicPerson(handle, req);
    if (person) return res.json({ kind: 'person', person } satisfies WorkspacePublicAddressAnswer);
    const workplace = await publicWorkplace(handle, req);
    if (workplace) return res.json({ kind: 'workplace', workplace } satisfies WorkspacePublicAddressAnswer);
    return nothingHere(res);
  });

  /**
   * A repository at its address, `/acme/site` (slice 6): the tree or a file
   * for a public one, exactly as the link-only door answers; for a signed-in
   * MEMBER of the workplace, only which workplace it is, so the shell opens
   * the full repository screen — public or private. A private repository
   * is a 404 to anyone else, identical to one that does not exist.
   */
  const repoByAddress = async (req: Request, res: Response, { membersToo = false } = {}): Promise<GitRepoDocument | null> => {
    publicHeaders(res);
    if (typeof res.setHeader === 'function') res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    const handle = String(req.params.handle ?? '');
    const name = String(req.params.repo ?? '');
    if (handleProblem(handle) || !name || !deps.orgStorage || !deps.gitRepoStorage || !deps.gitHostClient) { nothingHere(res); return null; }
    const org = await deps.orgStorage.getOrgByHandle(handle).catch(() => null);
    if (!org) { nothingHere(res); return null; }
    const repo = await deps.gitRepoStorage.getLiveByNameIn(await workplaceNamespaces(org), name);
    if (!repo) { nothingHere(res); return null; }
    const session = await publicViewer(req);
    const member = session ? await deps.orgStorage.getMembership(org.orgId, session.userId).catch(() => null) : null;
    if (member && !membersToo) { res.json({ member: { orgId: org.orgId } }); return null; }
    if (!repo.publicAccess) { nothingHere(res); return null; }
    return repo;
  };

  const answerPublicTree = async (repo: GitRepoDocument, path: string, res: Response) => {
    try {
      const host = await gitHostFor(repo.orgId);
      const tree = await host.tree(repo.userId, repo.name, path);
      return res.json({
        name: repo.name,
        cloneUrl: host.cloneUrl(repo.userId, repo.name),
        path,
        ...tree,
      } satisfies WorkspacePublicRepoTreeAnswer);
    } catch {
      return res.status(404).json({ error: path ? 'That folder is not in this repository.' : 'This repository is unavailable right now.' });
    }
  };

  const answerPublicFile = async (repo: GitRepoDocument, path: string, res: Response) => {
    if (!path) return res.status(400).json({ error: 'Choose a file.' });
    try {
      const host = await gitHostFor(repo.orgId);
      const file = await host.file(repo.userId, repo.name, path);
      return res.json({
        name: repo.name,
        cloneUrl: host.cloneUrl(repo.userId, repo.name),
        path,
        ...file,
      } satisfies WorkspacePublicRepoFileAnswer);
    } catch {
      return res.status(404).json({ error: 'That file is not in this repository.' });
    }
  };

  router.get('/api/public/workplaces/:handle/repos/:repo/tree', async (req, res) => {
    const repo = await repoByAddress(req, res);
    if (!repo) return;
    return answerPublicTree(repo, String(req.query.path ?? ''), res);
  });

  router.get('/api/public/workplaces/:handle/repos/:repo/file', async (req, res) => {
    const repo = await repoByAddress(req, res);
    if (!repo) return;
    return answerPublicFile(repo, String(req.query.path ?? ''), res);
  });

  /**
   * One text file of a public repository, as its exact bytes, at one exact
   * commit the default branch contains (note #941). This is what the own-cloud
   * guide downloads the installer from: `curl -o install.mjs <this>`, then a
   * SHA-256 the guide prints, so the URL must name a commit, never a branch,
   * and the answer must be the file itself, not JSON around it. Everyone gets
   * the same bytes, a member too (no "open the workplace" answer here), and a
   * private repository stays "Nothing at this address".
   */
  router.get('/api/public/workplaces/:handle/repos/:repo/raw/:sha', async (req, res) => {
    const repo = await repoByAddress(req, res, { membersToo: true });
    if (!repo) return;
    const sha = String(req.params.sha ?? '');
    const path = String(req.query.path ?? '');
    if (!/^[0-9a-f]{40}$/.test(sha) || !path) {
      return res.status(404).type('text/plain').send('Name a 40-character commit and a file path.\n');
    }
    try {
      const file = await (await gitHostFor(repo.orgId)).file(repo.userId, repo.name, path, sha);
      if (typeof file.content !== 'string') {
        return res.status(404).type('text/plain').send('That file is not text this door serves.\n');
      }
      if (typeof res.setHeader === 'function') res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).type('text/plain; charset=utf-8').send(file.content);
    } catch {
      return res.status(404).type('text/plain').send('That file is not in this repository at that commit.\n');
    }
  });

  /**
   * What HAPPENED in a public repository (the owner, 2026-09-27): its
   * history, one commit, and its proposals — the same reads a member's
   * screens make, behind the same address door, and no more than a stranger
   * may know. No checks (CI is the workplace's business), no faces, ids,
   * decision notes or margins; a proposal is signed by its agent's name,
   * which git already prints on the commits, and never by the person behind
   * it. A quiet proposal, which its own owner has not been shown, is not
   * listed. `HISTORY_CAP` is what "the full history" means here: the host
   * clamps a limit anyway, and a page of thousands of rows serves nobody.
   */
  const HISTORY_CAP = 500;

  router.get('/api/public/workplaces/:handle/repos/:repo/commits', async (req, res) => {
    const repo = await repoByAddress(req, res);
    if (!repo) return;
    const rawLimit = Number((req.query as Record<string, unknown>).limit);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, HISTORY_CAP) : HISTORY_CAP;
    try {
      const log = await (await gitHostFor(repo.orgId)).log(repo.userId, repo.name, limit);
      return res.json({
        name: repo.name,
        branch: log.branch,
        commits: log.commits.map((commit) => ({
          sha: commit.sha, authorName: commit.authorName, at: commit.at, subject: commit.subject,
        })),
      } satisfies WorkspacePublicRepoCommitsAnswer);
    } catch {
      return res.status(404).json({ error: 'This repository is unavailable right now.' });
    }
  });

  router.get('/api/public/workplaces/:handle/repos/:repo/commits/:sha', async (req, res) => {
    const repo = await repoByAddress(req, res);
    if (!repo) return;
    const sha = String(req.params.sha ?? '');
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return res.status(404).json({ error: 'That commit is not in this repository.' });
    try {
      const commit = await (await gitHostFor(repo.orgId)).commit(repo.userId, repo.name, sha);
      return res.json({
        name: repo.name,
        sha: commit.sha, authorName: commit.authorName, at: commit.at, subject: commit.subject,
        body: commit.body, parents: commit.parents, diffStat: commit.diffStat,
        patch: commit.patch, patchTruncated: commit.patchTruncated,
      } satisfies WorkspacePublicRepoCommitAnswer);
    } catch {
      return res.status(404).json({ error: 'That commit is not in this repository.' });
    }
  });

  /** The names of the agents that signed a public repository's proposals:
   *  one profile read per member of the workplace, and only the names. */
  const publicAgentNames = async (orgId: string | null | undefined, agentIds: Iterable<string>): Promise<Map<string, string>> => {
    const names = new Map<string, string>();
    const wanted = new Set(agentIds);
    if (!orgId || !deps.orgStorage || !deps.userStorage || wanted.size === 0) return names;
    const members = await deps.orgStorage.listMembers(orgId).catch(() => []);
    for (const member of members) {
      const profile = await deps.userStorage.getProfile(member.userId).catch(() => null);
      for (const [id, record] of Object.entries(profile?.telegram?.agents ?? {})) {
        if (wanted.has(id) && record?.name) names.set(id, record.name);
      }
      if (names.size === wanted.size) break;
    }
    return names;
  };

  const publicProposalRow = (doc: GitPullRequestDocument, names: Map<string, string>): WorkspacePublicRepoProposalRow => ({
    number: doc.number,
    title: doc.title,
    from: doc.sourceBranch,
    to: doc.targetBranch,
    status: doc.status,
    createdAt: doc.createdAt,
    decidedAt: doc.decidedAt ?? null,
    ...(doc.diffStat ? { diffStat: doc.diffStat } : {}),
    agentName: names.get(doc.createdByAgentId) ?? null,
  });

  router.get('/api/public/workplaces/:handle/repos/:repo/proposals', async (req, res) => {
    const repo = await repoByAddress(req, res);
    if (!repo) return;
    if (!deps.gitPullRequestStorage) return res.json({ name: repo.name, prs: [] } satisfies WorkspacePublicRepoProposalsAnswer);
    const docs = (await deps.gitPullRequestStorage.listByRepo(repo.id))
      .filter((doc) => !doc.draft)
      .sort((a, b) => b.number - a.number);
    const names = await publicAgentNames(repo.orgId, docs.map((doc) => doc.createdByAgentId));
    return res.json({
      name: repo.name,
      prs: docs.map((doc) => publicProposalRow(doc, names)),
    } satisfies WorkspacePublicRepoProposalsAnswer);
  });

  router.get('/api/public/workplaces/:handle/repos/:repo/proposals/:number', async (req, res) => {
    // The member check comes AFTER the proposal is found: a member is sent
    // to the proposal's own screen, which needs its id.
    publicHeaders(res);
    if (typeof res.setHeader === 'function') res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    const handle = String(req.params.handle ?? '');
    const name = String(req.params.repo ?? '');
    const number = Number(req.params.number);
    if (handleProblem(handle) || !name || !Number.isInteger(number) || number <= 0
      || !deps.orgStorage || !deps.gitRepoStorage || !deps.gitHostClient || !deps.gitPullRequestStorage) return nothingHere(res);
    const org = await deps.orgStorage.getOrgByHandle(handle).catch(() => null);
    if (!org) return nothingHere(res);
    const repo = await deps.gitRepoStorage.getLiveByNameIn(await workplaceNamespaces(org), name);
    if (!repo) return nothingHere(res);
    const doc = await deps.gitPullRequestStorage.getByNumber(repo.id, number);
    const session = await publicViewer(req);
    const member = session ? await deps.orgStorage.getMembership(org.orgId, session.userId).catch(() => null) : null;
    if (member && doc) return res.json({ member: { orgId: org.orgId, id: doc.id } } satisfies WorkspacePublicRepoProposalDoorAnswer);
    if (!repo.publicAccess || !doc || doc.draft) return nothingHere(res);
    const names = await publicAgentNames(repo.orgId, [doc.createdByAgentId]);
    const pr = { ...publicProposalRow(doc, names), body: doc.body ?? null };
    const [base, head] = doc.status === 'open'
      ? [doc.targetBranch, doc.sourceBranch]
      : [doc.baseSha ?? EMPTY_TREE_SHA, doc.headSha];
    try {
      const comparison = await (await gitHostFor(repo.orgId)).compare(repo.userId, repo.name, base, head);
      return res.json({
        name: repo.name,
        pr: { ...pr, diffStat: comparison.diffStat },
        commits: comparison.commits.map((commit) => ({
          sha: commit.sha, subject: commit.subject, ...(commit.at ? { at: commit.at } : {}),
        })),
        patch: comparison.patch,
        patchTruncated: comparison.patchTruncated,
      } satisfies WorkspacePublicRepoProposalDoorAnswer);
    } catch {
      return res.json({
        name: repo.name,
        pr,
        commits: doc.commitSubjects.map((subject) => ({ subject })),
        patch: null,
        patchTruncated: false,
        compareError: 'The diff could not be read right now.',
      } satisfies WorkspacePublicRepoProposalDoorAnswer);
    }
  });

  /**
   * The About strip and the contributors line (the owner, 2026-09-27): what
   * a visitor checks before cloning, in one read. The README's first
   * paragraph, the licence's name, the size, the dates, the counts, and who
   * wrote it as git counted them — names and numbers, never the address git
   * knows them by, never an agent's face or id. The count is refreshed the
   * way the member's screen refreshes it (incrementally, from the tip last
   * counted to), and what was counted last stands in when the host is away.
   */
  router.get('/api/public/workplaces/:handle/repos/:repo/about', async (req, res) => {
    const repo = await repoByAddress(req, res);
    if (!repo) return;
    const host = await gitHostFor(repo.orgId);
    let stored = repo.contributors;
    try {
      const counted = await host.contributors(repo.userId, repo.name, stored?.sha);
      const contributors = nextContributors(stored, counted, new Date().toISOString());
      if (contributors) {
        stored = contributors;
        await deps.gitRepoStorage?.update(repo.id, { contributors });
      }
    } catch { /* the last count stands */ }
    let branch: string | null = repo.defaultBranch ?? null;
    let description: string | undefined;
    let license: { name: string | null; file: string } | undefined;
    try {
      const root = await host.tree(repo.userId, repo.name, '');
      branch = root.branch;
      const licenseEntry = root.entries.find((entry) => entry.type === 'file' && (entry.sizeBytes ?? 0) > 0 && LICENSE_FILE.test(entry.name));
      if (licenseEntry) {
        const file = await host.file(repo.userId, repo.name, licenseEntry.name).catch(() => null);
        license = { name: file?.content ? detectLicense(file.content) : null, file: licenseEntry.name };
      }
      const readmes = root.entries.filter((entry) => entry.type === 'file' && /^readme(\.(md|markdown|mdown|mkd|txt|rst))?$/i.test(entry.name));
      const readme = readmes.find((entry) => /\.(md|markdown|mdown|mkd)$/i.test(entry.name)) ?? readmes[0];
      if (readme) {
        const file = await host.file(repo.userId, repo.name, readme.name).catch(() => null);
        const text = file?.content && !file.binary && !file.tooLarge ? readmeDescription(file.content) : null;
        if (text) description = text;
      }
    } catch { /* the tree is the page's own read; the strip does without */ }
    const proposals = deps.gitPullRequestStorage
      ? (await deps.gitPullRequestStorage.listByRepo(repo.id)).filter((doc) => !doc.draft).length
      : 0;
    const authors = stored?.authors ?? [];
    // Faces (the owner, 2026-09-27): the workplace's agents by name, as the
    // member's screen matches them, and its MEMBERS' profile photos by the
    // address git knows them by — their sign-in email or their address here.
    // One walk of the members; a stranger to the workplace gets no face.
    const agents = new Map<string, { name?: string }>();
    const photoByEmail = new Map<string, string>();
    if (repo.orgId && deps.orgStorage && deps.userStorage) {
      for (const member of await deps.orgStorage.listMembers(repo.orgId).catch(() => [])) {
        const profile = await deps.userStorage.getProfile(member.userId).catch(() => null);
        if (!profile) continue;
        for (const [id, record] of Object.entries(profile.telegram?.agents ?? {})) agents.set(id, { name: record?.name });
        const photo = await pictureUrl(profile.person?.photo?.storagePath);
        if (!photo) continue;
        const identity = await deps.workspaceWebAuth?.identityForUser(member.userId).catch(() => null);
        const mailbox = await deps.mailboxes?.forUser(member.userId).catch(() => null);
        for (const email of [profile.email, identity?.kind === 'email' ? identity.email : undefined, mailbox?.address]) {
          if (email) photoByEmail.set(email.trim().toLowerCase(), photo);
        }
      }
    }
    const contributors = authors.map((author) => {
      const agent = resolveContributorAgent(author, agents);
      const avatarUrl = agent ? agentFaceUrl(agent.name) : photoByEmail.get(author.email.trim().toLowerCase());
      return {
        name: agent?.name ?? author.name,
        ...(avatarUrl ? { avatarUrl } : {}),
        commits: author.commits, insertions: author.insertions, deletions: author.deletions,
      };
    });
    return res.json({
      name: repo.name,
      branch,
      ...(description ? { description } : {}),
      ...(license ? { license } : {}),
      sizeBytes: repo.sizeBytes,
      publishedAt: repo.publicAccess?.publishedAt ?? '',
      ...(repo.lastPushAt ? { lastPushAt: repo.lastPushAt } : {}),
      commits: stored ? authors.reduce((sum, author) => sum + author.commits, 0) : null,
      proposals,
      contributors,
      ...(stored?.countedAt ? { countedAt: stored.countedAt } : {}),
    } satisfies WorkspacePublicRepoAboutAnswer);
  });

  router.get('/api/public/repos/:id/tree', async (req, res) => {
    const repo = await publicRepo(String(req.params.id ?? ''), res);
    if (!repo) return;
    return answerPublicTree(repo, String(req.query.path ?? ''), res);
  });

  router.get('/api/public/repos/:id/file', async (req, res) => {
    const repo = await publicRepo(String(req.params.id ?? ''), res);
    if (!repo) return;
    return answerPublicFile(repo, String(req.query.path ?? ''), res);
  });

  router.get('/api/state', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (auth.orgId) {
      await inheritPrivateSeats(auth.userId, auth.orgId).catch((error) => {
        console.warn(`[org] could not carry ${auth.userId}'s subscriptions into ${auth.orgId}:`, error);
      });
    }
    const agents = Object.fromEntries(Object.entries(auth.profile.telegram?.agents ?? {}).filter(([, agent]) => (
      agent.orgId ? agent.orgId === auth.orgId : auth.orgId === auth.legacyOrgId
    )));
    // The workplace's shelves (notes, knowledge, repositories, sites and
    // secrets) and its whole agent fleet: one place since note #843.
    const ns = await viewerNamespaceFor(auth, req, res);
    if (!ns) return;
    const roomRepoDocs = deps.gitRepoStorage
      ? await deps.gitRepoStorage.listLiveIn(await workplaceRepoNamespaces(auth, ns))
      : [];
    // Who everyone is (note #57): names proposal rows and comments.
    const hasPrDecisions = Boolean(deps.gitPullRequestStorage && deps.gitRepoStorage);
    const hasKnowledgeDecisions = Boolean(deps.knowledgeProposalStorage && deps.gitHostClient);
    const decisionNamespaceIds = hasPrDecisions || hasKnowledgeDecisions
      ? await viewerNamespaces(auth)
      : [];
    const [statePeople, openPrsByNamespace] = await Promise.all([
      workspacePeople(auth),
      Promise.all(decisionNamespaceIds.map((namespaceId) => (
        hasPrDecisions ? deps.gitPullRequestStorage!.listOpenByUser(namespaceId) : []
      ))),
    ]);
    // What each agent row's second line is derived from — records the backend
    // already holds, never a call to the agent's machine (asleep for most of
    // the moments this screen opens). The open proposals double as the
    // workplace's decision queue further down.
    // A QUIET proposal — recorded, not yet made ready by its agent (note
    // #293) — is not in this set: not in the queue, not on the agent's row as
    // "waiting on you". The agent is still working on it, and nothing here
    // may put an Approve button in front of it.
    const openPrDocs = deps.gitPullRequestStorage && deps.gitRepoStorage
      ? openPrsByNamespace
        .flat()
        .filter((doc) => pullRequestAwaitsDecision(doc))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      : [];
    // Read once, used twice: the agent rows below say which agent is behind a
    // running site, and the Sites section lists what the account has online.
    const allDeploymentDocs = (deps.deploymentStorage
      ? (auth.orgId
        ? await deps.deploymentStorage.listByOrg(auth.orgId)
        : await deps.deploymentStorage.listByUser(auth.userId))
      : []);
    // A site belongs to the workplace (note #566), as a repository does.
    const deploymentDocs = allDeploymentDocs;
    const liveSites = deploymentDocs.filter((doc) => doc.status === 'live');

    // One workplace's fleet. The human owns the records, but an agent is
    // permanently attached to the org where it was created.
    const fleet = listAgents(auth.profile.telegram).filter((agent) => (
      agent.orgId ? agent.orgId === auth.orgId : auth.orgId === auth.legacyOrgId
    ));

    // Two live reads per agent, taken ONCE and reused by both the ordering and
    // the row itself, so the list cannot sort on one answer and render another.
    const workingNow = new Map<string, boolean>();
    const activityNow = new Map<string, { activity?: string; startedAt?: number }>();
    const usedAt = new Map<string, number>();
    const madeAt = new Map<string, number>();
    for (const agent of fleet) {
      workingNow.set(
        agent.id,
        Boolean(deps.agentLifecycle?.isAgentWorking?.(auth.userId, agent.id)),
      );
      // WHAT the running turn is doing, from the same registry the run flag
      // came from. Read here rather than left to the live poll below so the
      // FIRST paint already carries it: an app that opens saying "Working now"
      // and only names the job five seconds later looks like it was guessing.
      const doingNow = deps.agentLifecycle?.agentActivity?.(auth.userId, agent.id);
      if (doingNow) activityNow.set(agent.id, doingNow);
      // Freshest thing known about this agent's last turn, best source first.
      // The persisted stamp is throttled to one write an hour BY DESIGN (it
      // exists for the recycler, which works in days), so on its own it puts
      // two agents used in the same hour in the wrong order — which is the
      // whole hour that matters here. The in-memory clock is minute-fresh but
      // process-local, so it is a floor to raise the stamp with, never a
      // replacement: after a deploy it is empty and the stamp carries the list.
      const stamped = Date.parse(agent.lastActivityAt ?? '');
      const live = deps.agentLifecycle?.lastActiveAtMs?.(auth.userId, agent.id);
      const created = Date.parse(agent.createdAt ?? '');
      // Two facts, deliberately NOT merged into one (note #79). Used to fall
      // back to the creation date, which made an agent nobody has ever spoken
      // to look like the most recently used one in the fleet and put it on the
      // top row — above the agents that actually run, and while it was still
      // being built and could not be talked to at all. Zero here means never
      // used, which the ordering below reads as its own answer.
      //
      // …and a stamp is only believed once a turn has left its own trace
      // (`agentHasBeenUsed`). Creation stamps activity for the idle reaper, so
      // an unused agent reads as used-this-minute and lands back on the top
      // row — the exact placement note #79 removed, seen again in notes
      // #227/#264 the moment the reaper's stamp was added.
      const everUsed = agentHasBeenUsed(agent);
      usedAt.set(
        agent.id,
        everUsed ? Math.max(Number.isNaN(stamped) ? 0 : stamped, live ?? 0) : 0,
      );
      madeAt.set(agent.id, Number.isNaN(created) ? 0 : created);
    }

    // Most recently used first (Owner's call, 2026-08-15). This list is read
    // to find the agent you were just talking to, and creation order buried it
    // under whatever you made first — the fleet's daily driver sat fifth while
    // an agent last touched four days ago held the top row.
    //
    // The chat roster and the switcher keep creation order deliberately
    // (`listAgents`): their positions are muscle memory, and a list
    // that reshuffles under a numbered pick is a list that picks the wrong
    // agent. Nothing about this screen is positional, so it can move.
    //
    // A turn IN FLIGHT outranks every stamp: it is happening at the instant the
    // list is read, which is the same rule the row's own text already follows
    // ("Working now" beats "Active 2h ago").
    //
    // An agent NOBODY HAS USED YET goes below every agent that has been, both
    // while it is being built and after it is ready (note #79). Recency is a
    // claim about work done, and a brand-new agent has done none — sorting it
    // by its birthday made "just created" the strongest claim on the top row,
    // so making one pushed the whole working fleet down a place and the row
    // that arrived first was the one row that could do nothing yet.
    const ordered = [...fleet].sort((a, b) => (
      Number(workingNow.get(b.id)) - Number(workingNow.get(a.id))
      || Number((usedAt.get(b.id) ?? 0) > 0) - Number((usedAt.get(a.id) ?? 0) > 0)
      || (usedAt.get(b.id) ?? 0) - (usedAt.get(a.id) ?? 0)
      // Among the never-used, OLDEST first — so the agent being made right now
      // is the LAST row on the screen, which is where its placeholder already
      // sits and where the person watching it appear is looking.
      || (madeAt.get(a.id) ?? 0) - (madeAt.get(b.id) ?? 0)
      // Stable last resort, so two agents with identical timestamps (legacy
      // records, seeded fixtures) never swap places between two polls.
      || a.id.localeCompare(b.id)
    ));

    // Which providers the caller can actually RUN on — a live seat of their
    // own. It is what separates an agent still being built from one whose
    // machine is ready and WAITING FOR THE OWNER's sign-in: the first real
    // founder stared at "Setting up — a minute or two" for ten minutes while
    // the system was waiting for them.
    const stateMembership = deps.orgStorage && auth.orgId
      ? await deps.orgStorage.getMembership(auth.orgId, auth.userId).catch(() => null)
      : null;
    const liveSeatProviders = new Set<string>();
    const paymentRequiredSeatProviders = new Set<string>();
    let memberSeats: OrgSeatDocument[] = [];
    if (stateMembership && deps.orgStorage) {
      memberSeats = await deps.orgStorage
        .listSeatsByMember(stateMembership.orgId, auth.userId).catch(() => []);
      // The first Workspace read paints Home. Fill a stale/missing provider
      // snapshot before that paint, but let the periodic five-minute probe
      // remain the ordinary source of fresh data. Provider trouble costs the
      // reader only freshness; the saved rows still render.
      if (deps.refreshSeatUsage && seatUsageCacheIsStale(memberSeats)) {
        try {
          await deps.refreshSeatUsage();
          memberSeats = await deps.orgStorage
            .listSeatsByMember(stateMembership.orgId, auth.userId).catch(() => memberSeats);
        } catch { /* stale stamps remain usable */ }
      }
      for (const seat of memberSeats) {
        if (isLiveSeatStatus(seat.status)) {
          liveSeatProviders.add(seat.provider);
        } else if (seat.status === 'payment_required') {
          paymentRequiredSeatProviders.add(seat.provider);
        }
      }
    }

    // What each agent's version card can say off its own record (note #102).
    // Built here, on records this request already holds, so the agent screen
    // opens on its facts instead of on "Checking…" while a read that SSHes
    // into an awake machine finishes. One fleet-wide call, no machine reads.
    const versionSeeds: Record<string, TelegramAgentVersionSeed> = await deps
      .agentLifecycle?.agentVersionSeeds?.(auth.userId, ordered)
      // A seed is an optimisation, never the state read's reason to fail: the
      // screen falls back to asking for itself, exactly as it used to.
      .catch(() => ({})) ?? {};

    // And what its Last reply section can say (note #155), on the same terms.
    // Bounded per agent by the chat store's own newest-rows peek, so seeding
    // the fleet costs the state read one small query each.
    const chatReplySeeds: Record<string, { text: string; at: string }> = await deps
      .agentLifecycle?.agentChatReplySeeds?.(auth.userId, ordered)
      .catch(() => ({})) ?? {};

    // And what each one's newest message carries (note #553): the pictures an
    // agent just sent are shown on its plate, not described there. Same
    // terms as the reply seeds — one bounded peek per agent, never the state
    // read's reason to fail.
    const chatFileSeeds: Record<string, WorkspaceChatFile[]> = await deps
      .agentLifecycle?.agentChatLastFiles?.(auth.userId, ordered)
      .catch(() => ({})) ?? {};


    const agentRows = ordered.map((agent) => {
      // Only when the file is really there (renamed agents have no dog) — the
      // page falls back to its generic icon on absence, never a broken image.
      const avatarUrl = agentFaceUrl(agent.name);
      // The handoff picker names what every candidate RUNS. Resolve the
      // concrete model here rather than handing the page a stored override:
      // an absent override still means a real default model, and a retired
      // override has already fallen back by the time the harness starts.
      // Retired CLIs get neither — there is no model this product can run for
      // them, and they are never offered as handoff targets anyway.
      const supportedCli = isSupportedAgentCli(agent.cli);
      const effectiveModel = supportedCli
        ? resolveEffectiveModel(agent.cli, agent.model)
        : undefined;
      const model = supportedCli && effectiveModel
        ? modelCatalogForCli(agent.cli)
          .find((option) => option.value === effectiveModel)?.label ?? effectiveModel
        : undefined;
      const effort = supportedCli && effectiveModel
        ? resolveEffectiveEffort(agent.cli, agent.model, agent.effort)
        : undefined;
      // A seat-backed agent can carry two stale-looking halves after its
      // subscription dies: the harness clears connectedAt immediately, while
      // the credential health probe may still call the seat active. That is
      // NOT a new agent being built. A prior turn (recap/activity/task/native
      // conversation) proves this machine already made it through setup, so
      // the owner-facing state is the actionable one: sign the seat in again.
      //
      // The converse remains important too: a genuinely fresh machine with a
      // live seat and no history is still setting up for the brief gap before
      // the connect hook stamps connectedAt.
      const hasRunBefore = Boolean(
        agent.lastActivityAt
        || agent.recap?.text
        || agent.tasks?.length
        || agent.conversation?.claudeSessionId
        || agent.conversation?.codexThreadId
        || agent.conversation?.opencodeSessionId,
      );
      const seatBacked = Boolean(
        agent.serverId
        && stateMembership
        && isHarnessCli(agent.cli),
      );
      const paymentRequired = seatBacked
        && !liveSeatProviders.has(agent.cli)
        && paymentRequiredSeatProviders.has(agent.cli);
      const needsSeat = seatBacked && (
        !liveSeatProviders.has(agent.cli)
        || (!agent.connectedAt && hasRunBefore)
      );
      // 'retired': an agent stored against a harness this product no longer
      // runs (Kimi, removed 2026-08-25) — shown, since deleting them is
      // exactly what this screen is for. Tested against the STORED value
      // rather than the union: narrowing the type did not rewrite anyone's
      // records, and a legacy row must not fall through to a live status.
      // 'needs-sign-in' is the interactive-OAuth wait — a legacy
      // state now that every tier runs on pooled credentials, and one the
      // factory chat no longer talks anyone through, so the row says it is
      // finishing rather than sending them somewhere silent.
      const status: WorkspaceAgentStatus = !supportedCli
        ? 'retired'
        // A founding agent (note #144) has no machine to be setting up and no
        // provider to be signed in: it is waiting for the workplace itself.
        : agent.planned && !agent.serverId
          ? 'planned'
        : paymentRequired
          ? 'payment-required'
        // Seat truth outranks an old connectedAt stamp: a dead/disabled seat
        // cannot run a turn however ready the machine used to be.
        : needsSeat
          ? 'needs-seat'
        : agent.connectedAt
          ? 'ready'
            : agent.serverId && !agent.connectedAt && agent.oauthPendingAt
              ? 'needs-sign-in'
              : 'setting-up';
      // What this agent is ABOUT right now, said only from records that name
      // it: an open proposal it made outranks a production site it is behind
      // (the deployment record routes that site's notices to it), which
      // outranks a page served off its own machine. Facts, not words — the
      // page does the wording — and nothing is inferred: an agent with no
      // artifact on its name gets no `doing` at all, and its row falls back
      // to recency (`lastActiveAt`), which at least tells the daily driver
      // from the one abandoned in January.
      const proposals = openPrDocs.filter((doc) => doc.createdByAgentId === agent.id);
      const newest = proposals[proposals.length - 1]; // listOpenByUser sorts oldest-first
      const sites = liveSites.filter((doc) => doc.agentId === agent.id);
      const newestSite = [...sites]
        .sort((a, b) => (a.lastDeployAt ?? a.createdAt).localeCompare(b.lastDeployAt ?? b.createdAt))
        .pop();
      const doing = newest
        ? { kind: 'proposal' as const, count: proposals.length, number: newest.number }
        : newestSite
          ? {
            kind: 'site' as const,
            count: sites.length,
            // The public host when the service that knows the apps domain is
            // wired; the site's bare name (which is most of the host) when not.
            host: deps.deploymentService
              ? new URL(deps.deploymentService.url(newestSite)).host
              : newestSite.name,
          }
          : agent.exposedUrl
            ? { kind: 'preview' as const }
            : undefined;
      return {
        id: agent.id,
        name: agent.name,
        cli: agent.cli,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        // The agent's own seat pin (note #129) — the id alone: the page names
        // it from the seats it already fetches, and an id naming a seat that
        // is gone renders as the org default, which is what it leases as.
        ...(agent.seatId ? { seatId: agent.seatId } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
        status,
        createdAt: agent.createdAt,
        // The row's line under the name (agent-row-recap-design): the
        // post-turn summarizer's brief latest-work recap. Agents the
        // summarizer has not visited yet can seed it from a legacy
        // agent-authored task; their retired `about` description is omitted
        // now that the room supplies standing context (note #109). Sent
        // alongside the derived facts rather than instead of them: the page
        // still falls back to a fact off the records for an agent with neither.
        ...(() => {
          const recap = agent.recap?.text ?? composeSeedAgentRecap(agent);
          return recap ? { recap, ...(agent.recap?.at ? { recapAt: agent.recap.at } : {}) } : {};
        })(),
        // The summarizer's verdict that its work is done with nothing
        // waiting (note #707) — half of what the room's reset button asks.
        ...(!workingNow.get(agent.id) && agentWorkFinished(agent) ? { finished: true as const } : {}),
        // The job the turn in flight was set going on, in the owner's words.
        // Sent whenever known; the page shows it only while `working`,
        // because once the turn ends the recap is the line that reports.
        ...(agent.tasks?.[0]?.text ? {
          now: agent.tasks[0].text,
          ...(agent.tasks[0].at ? { nowAt: agent.tasks[0].at } : {}),
        } : {}),
        ...(doing ? { doing } : {}),
        // Live, and read at the moment the list is built — the answer the
        // stamp below cannot give, since it is written at most once an hour.
        ...(workingNow.get(agent.id) ? { working: true } : {}),
        ...(workingNow.get(agent.id) ? liveActivityFields(activityNow.get(agent.id)) : {}),
        // Only once a turn has left its own trace, on the same reading the
        // ordering uses: creation stamps this field for the idle reaper, and
        // an agent nobody has ever spoken to must not sit on the bottom row
        // (never used) while its own line claims it was "Active 1m ago". Its
        // row says "Ready" instead, which is the whole truth about it.
        ...(agent.lastActivityAt && (usedAt.get(agent.id) ?? 0) > 0
          ? { lastActiveAt: agent.lastActivityAt }
          : {}),
        // Its version card as far as the record fills it in — what the agent
        // runs, what it was told, and what it thinks with. The screen paints
        // this the instant it opens and refreshes it underneath.
        ...(versionSeeds[agent.id] ? { version: versionSeeds[agent.id] } : {}),
        // Its exact last words, for the details screen's Last reply section —
        // painted the instant that screen opens and refreshed underneath, the
        // same way the version card treats its own seed.
        ...(chatReplySeeds[agent.id] ? { lastReply: chatReplySeeds[agent.id] } : {}),
        // What its newest message carries (note #553), so the plate can show
        // the picture rather than a sentence about it.
        ...(chatFileSeeds[agent.id]?.length ? { lastFiles: chatFileSeeds[agent.id] } : {}),
        // How many durable jobs its machine was running when the backend last
        // looked (note #564). Absent at zero: the plate draws nothing then.
        ...((agent.activeJobs?.count ?? 0) > 0 ? { activeJobs: agent.activeJobs!.count } : {}),
        // The structured subscription-window stop for THIS conversation.
        // Readiness is time-derived, never inferred from the error text the
        // chat happened to preserve.
        ...sessionLimitFields(agent.sessionLimit),
        // How full this agent's conversation has got. Computed here rather
        // than sent raw, because the WINDOW comes either from the CLI's own
        // report or from the model, and the page has no business knowing
        // either — and absent entirely when neither answers, since a
        // percentage of an unknown denominator is a made-up number.
        ...contextFields(agent.contextUsage),
        // What its machine is made of (note #356), straight off the record —
        // stamped by whatever last looked at that machine, so this row costs
        // the same nothing every other field here does. Omitted rather than
        // guessed at from the fleet default: an owner who moved a machine up
        // the ladder would be told it is still standard.
        ...(agent.machineSize ? { machineSize: agent.machineSize } : {}),
        // The Workspace Agent's ask to remove it (note #710): the owner's
        // own private agent is the only one that can leave it, and these
        // rows are the owner's fleet, so the reader is the one who decides.
        // A sealed public guide (note #1010): its screen shows the Visits list.
        ...(agent.sealed ? { sealed: agent.sealed } : {}),
        ...(agent.removeAsk ? {
          removeAsk: {
            at: agent.removeAsk.at,
            canDecide: agent.removeAsk.byUserId === auth.userId,
            byAgentName: WORKSPACE_AGENT_NAME,
            ...(agent.removeAsk.reason ? { reason: agent.removeAsk.reason } : {}),
          },
        } : {}),
      };
    });

    // The other half of each room (2026-09-23): the agents the OTHER members
    // drive, for the compact strip on the Agents tab. Every room's travel in
    // one list, as the reader's own fleet does, so switching rooms filters
    // what is already on screen. Most recently active first; the page lifts
    // the ones mid-turn to the front, because the live tick moves those.
    const teamAgents: WorkspaceTeamAgentRow[] = statePeople
      .teammateAgents()
      .map(({ ownerUserId, record }) => {
        const stamped = Date.parse(record.lastActivityAt ?? '');
        const live = deps.agentLifecycle?.lastActiveAtMs?.(ownerUserId, record.id);
        const activeMs = Math.max(Number.isFinite(stamped) ? stamped : 0, live ?? 0);
        const avatarUrl = agentFaceUrl(record.name);
        const ownerName = statePeople.name(ownerUserId);
        const ownerPhoto = statePeople.photoUrl(ownerUserId);
        return {
          id: record.id,
          name: record.name,
          ...(avatarUrl ? { avatarUrl } : {}),
          status: record.connectedAt ? 'ready' as const : 'setting-up' as const,
          ...(deps.agentLifecycle?.isAgentWorking?.(ownerUserId, record.id) ? { working: true as const } : {}),
          ...(activeMs > 0 ? { lastActiveAt: new Date(activeMs).toISOString() } : {}),
          owner: {
            userId: ownerUserId,
            ...(ownerName ? { name: ownerName } : {}),
            ...(ownerPhoto ? { photoUrl: ownerPhoto } : {}),
          },
        };
      })
      .sort((a, b) => (
        (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '')
        || a.name.localeCompare(b.name)
        || a.id.localeCompare(b.id)
      ));

    // Always the concierge view: every agent's private secrets alongside the
    // shared ones (the badges say which is which). Masked, never values. The
    // WORKPLACE's one set (note #783): the viewed room's namespace is named,
    // and the store maps it to the workplace's own, so every room shows the
    // same list.
    let secrets: unknown[] | null = null;
    if (deps.secretStorage) {
      const rows = await new UserSecretsService(deps.secretStorage).listSecrets(ns.namespaceId);
      // Which agents each shared key actually REACHES (note #655): every
      // agent working in the workplace, or only the ones admins own — and,
      // for a key limited to some rooms (note #783), only the agents standing
      // in one of them. Named so an admin can see at a glance that a platform
      // token is riding onto a teammate's machine. Roles come off the
      // membership records.
      const roleOf = new Map<string, string>();
      if (auth.orgId && deps.orgStorage && rows.some((row) => row.scope.kind === 'shared')) {
        for (const member of await deps.orgStorage.listMembers(auth.orgId).catch(() => [])) {
          roleOf.set(member.userId, member.role);
        }
      }
      // Every agent of the workplace.
      const workplaceAgents: Array<{ name: string; ownerUserId: string }> = [
        ...Object.values(agents).filter((record) => !record.purpose).map((record) => ({ name: record.name, ownerUserId: auth.userId })),
        ...teamAgents.map((row) => ({ name: row.name, ownerUserId: row.owner.userId })),
      ];
      const reachedBy = (audience: string | undefined): string[] => workplaceAgents
        .filter(({ ownerUserId }) => (
          audience === 'everyone'
          || !auth.orgId
          || (ownerUserId === auth.userId ? auth.orgRole === 'admin' : roleOf.get(ownerUserId) === 'admin')
        ))
        .map(({ name }) => name)
        .sort((a, b) => a.localeCompare(b));
      // A key renamed by the merge (note #783) says what it was called, so
      // the owner learns of the clash on the screen they look at.
      const renames = (auth.orgId && rows.some((row) => row.scope.kind === 'shared')
        ? (await deps.orgStorage?.getOrg(auth.orgId).catch(() => null))?.secretShelf?.renames
        : undefined) ?? [];
      // The namespace is shared, but an agent-scoped secret is still private
      // to that agent's owner. Never let a teammate (including an admin) see
      // even its name or masked preview.
      secrets = rows
        .filter((row) => row.scope.kind === 'shared' || Boolean(agents[row.scope.agentId]))
        .map((row) => {
          // Ids mean nothing on screen: the workspace names the agents that hold
          // their own copy, and drops any that no longer exist.
          const shadowedBy = (row.shadowedByAgentIds ?? [])
            .map((id) => agents[id]?.name)
            .filter((name): name is string => Boolean(name));
          return {
            name: row.name,
            maskedValue: row.maskedValue,
            maskedPreview: row.maskedPreview,
            valueLength: row.valueLength,
            ...(row.valueKind ? { valueKind: row.valueKind } : {}),
            ...(row.description ? { description: row.description } : {}),
            scope: row.scope.kind,
            ...(row.scope.kind === 'shared' && row.audience
              ? { audience: row.audience, reaches: reachedBy(row.audience) }
              : {}),
            ...(row.scope.kind === 'shared' && renames.some((rename) => rename.to === row.name)
              ? {
                renamedFrom: { name: renames.find((rename) => rename.to === row.name)!.from },
              }
              : {}),
            ...(row.scope.kind === 'agent'
              ? {
                agentId: row.scope.agentId,
                ...(agents[row.scope.agentId]?.name ? { agentName: agents[row.scope.agentId]!.name } : {}),
              }
              : {}),
            ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
            ...(row.shadowedByAgentScope ? { shadowedByAgentScope: true } : {}),
            ...(shadowedBy.length ? { shadowedBy } : {}),
          };
        });
    }

    let repos: WorkspaceRepoRow[] | null = null;
    let quota: { repoMaxBytes: number; userMaxBytes: number; userUsedBytes: number } | undefined;
    if (deps.gitRepoStorage && deps.gitHostClient) {
      // Live repositories only. Deleted ones used to ride along so the list
      // could show them waiting with a Restore button — the workspace kept
      // the promise the delete had made. It keeps it earlier now: the delete
      // asks for the repository's name to be typed out, and what it leaves
      // behind is a list of what the account actually has. The bytes are
      // still in the host's trash for fourteen days and an agent still
      // restores them (`agentbuilt repo restore`); this screen simply no
      // longer carries a row for something already thrown away.
      const docs = roomRepoDocs;
      const nsHost = await gitHostFor(ns.orgId);
      const nsHandle = await orgHandleOf(ns.orgId);
      // The sites publish links name, by their current names. Read only for
      // repositories that have one, so a workplace that never linked
      // anything pays nothing here.
      const siteNameById = new Map<string, string>();
      const linkedSiteIds = new Set(docs.map((doc) => doc.publishTo?.siteId)
        .filter((id): id is string => Boolean(id)));
      for (const siteId of linkedSiteIds) {
        const site = await deps.deploymentStorage?.get(siteId).catch(() => null);
        if (site && site.status !== 'destroyed') siteNameById.set(siteId, site.name);
      }
      repos = docs.map((doc) => ({
        name: doc.name,
        cloneUrl: nsHost.cloneUrl(doc.userId, doc.name),
        ...(doc.publicAccess ? {
          publicUrl: publicRepoAddress(doc, nsHandle),
          publishedAt: doc.publicAccess.publishedAt,
        } : {}),
        sizeBytes: doc.sizeBytes,
        // Who has actually WRITTEN this repository, most commits first — the
        // faces the row wears. Only the ones that are agents of this account:
        // a row has space for a picture and not for a name, and there is no
        // picture to draw for the owner's own commits or a merge identity.
        // The full list, everybody in it, is on the repository's own screen.
        // The predicate is a type guard, not just a filter: the row's face is
        // never optional once it is in this list, and saying so here is what
        // lets the client draw it without asking again.
        contributors: describeContributors(doc.contributors, statePeople.everyAgent())
          .filter((c): c is typeof c & { agentAvatarUrl: string } => Boolean(c.agentAvatarUrl))
          .slice(0, REPO_ROW_FACES)
          .map((c) => ({ name: c.name, agentAvatarUrl: c.agentAvatarUrl, commits: c.commits })),
        protectedBranch: doc.protectDefaultBranch ? (doc.defaultBranch ?? 'main') : null,
        createdAt: doc.createdAt,
        ...(doc.lastPushAt ? { lastPushAt: doc.lastPushAt } : {}),
        // For the row's "pushed … to <branch>" line — said only of a landing
        // the backend actually observed on the home branch, never inferred
        // from a repo-level push.
        ...(doc.defaultBranch ? { branch: doc.defaultBranch } : {}),
        ...(doc.defaultBranchPushAt ? { branchPushAt: doc.defaultBranchPushAt } : {}),
        // An agent asked for this one to go. It is a REQUEST on a screen, not
        // a notification: the agent also records the request in chat so it is
        // not missed while this screen is closed.
        ...(doc.deleteAsk ? {
          deleteAsk: {
            at: doc.deleteAsk.at,
            canDecide: (!ns.orgId || ns.role === 'admin')
              && agentRequestOwnedByViewer(auth, doc.deleteAsk),
            // The agent's name, or nothing — an id on screen says less than
            // silence, and an agent can be deleted after asking. Any member's
            // agent (2026-09-23), with whose it is when it is not the
            // reader's: that person is who the request is waiting on.
            ...describeAskAgent(doc.deleteAsk.byAgentId, statePeople, auth.userId),
          },
        } : {}),
        // What approved checks may use (note #739: granted at once by an
        // admin's agent, so this is the owner's standing view of it, not a
        // decision). Names only, and whose room's they are; values stay in
        // the encrypted store.
        ...(doc.ciSecrets?.length ? {
          ciSecrets: {
            names: doc.ciSecrets,
          },
        } : {}),
        // Publishing on approval: the link, by the site's CURRENT name — the
        // link holds its id, so a rename is followed.
        ...(doc.publishTo ? { publishesTo: siteNameById.get(doc.publishTo.siteId) ?? doc.publishTo.site } : {}),
      }));
      quota = {
        repoMaxBytes: GIT_REPO_MAX_BYTES,
        // Sized by the disk the repos are actually on (note #62): an org with
        // its own git host is bounded by the volume it pays for, so the
        // "Storage: … of …" line moves when an admin grows it. Everyone on
        // the shared box keeps the fair share.
        userMaxBytes: deps.orgGitHost
          ? await deps.orgGitHost.userMaxBytesFor(ns.orgId)
          : GIT_USER_MAX_BYTES,
        // Summed over every namespace of the org — historical base plus all
        // explicit rooms (note #85) — because the ceiling is the org's disk.
        userUsedBytes: ns.orgId && deps.orgGit
          ? (await Promise.all(
            (await deps.orgGit.namespacesForOrg(auth.userId, ns.orgId)).map((n) => deps.gitRepoStorage!.totalBytesForUser(n)),
          )).reduce((total, bytes) => total + bytes, 0)
          : await deps.gitRepoStorage.totalBytesForUser(ns.namespaceId),
      };
    }

    // The viewed room's decision queue, oldest first — the same set that has
    // an undecided card somewhere in chat. It follows the proposing room,
    // independently of which other rooms may use the same repository.
    let prs: WorkspaceProposalRow[] = [];
    if (deps.gitPullRequestStorage && deps.gitRepoStorage) {
      prs = await Promise.all(openPrDocs.map(async (doc) => {
        const repo = await deps.gitRepoStorage!.get(doc.repoId);
        return {
          ...describeProposal(doc, repo?.name ?? '(deleted repo)', statePeople, auth.userId),
          canDecide: proposalOwnedByViewer(auth, doc),
          // The one pixel that must arrive BEFORE the tap: has CI said
          // anything about the exact sha the user would be approving.
          ...(await checksSummary(deps, doc.repoId, doc.headSha)),
        };
      }));
    }

    // The production sites this account pays for. Every state EXCEPT
    // 'destroyed' rides along: a site waiting on its checkout link and one
    // whose payment lapsed are the two the owner most needs to see, and both
    // are invisible everywhere else in the app — the chat card that asked for
    // payment scrolls away, and nothing notifies anyone when a card expires.
    // Newest activity first, so the site an agent just deployed is on top.
    // Null (not empty) when this backend has no deployment storage at all,
    // matching repos/knowledge: the section can then say so instead of
    // claiming the account has nothing.
    const sites = deps.deploymentStorage
      ? deploymentDocs
        .filter((doc) => doc.status !== 'destroyed')
        .sort((a, b) => (b.lastDeployAt ?? b.createdAt).localeCompare(a.lastDeployAt ?? a.createdAt))
        .map((doc) => ({
          name: doc.name,
          // The public host, when the service that knows the apps domain is
          // wired. Without it the row still has the name — never a broken link.
          ...(deps.deploymentService ? { url: deps.deploymentService.url(doc) } : {}),
          // Where to ask for the site's own favicon, which the row wears in
          // place of the generic globe. A URL, not the answer: whether there
          // IS an icon takes a fetch of the site, and the state payload is
          // what the whole home screen waits on. The row draws the globe, asks
          // for this, and swaps only if a picture comes back — so a site with
          // no favicon costs nothing and looks exactly as it did.
          ...(deps.deploymentService && doc.status === 'live'
            ? { iconUrl: `${WORKSPACE_PUBLIC_ASSET_BASE}/site-icon/${encodeURIComponent(doc.name)}` }
            : {}),
          preset: doc.preset,
          status: doc.status,
          // No price: hosting is included with the account, and a
          // per-month figure on a row nobody is billed for would be the
          // workspace inventing a charge.
          kind: siteKindForPreset(doc.preset),
          // Who to ask about it. Deployments belong to the ACCOUNT, not to one
          // agent, but the record names the agent that deployed it and that is
          // who the fulfilment notices go to — so it is also who the owner
          // should message. Dropped when that agent is gone: an id on screen
          // says less than silence.
          //
          // Read across the whole workplace since note #640, not the reader's
          // own fleet: a site a teammate's agent deployed is every member's
          // to find, and it came up nameless and faceless for all of them.
          ...(statePeople.agent(doc.agentId)?.name
            ? { agentName: statePeople.agent(doc.agentId)!.name! }
            : {}),
          // And its face, beside the name it already carries — the same
          // picture that agent wears everywhere else on this screen, with the
          // door onto the agent behind it.
          ...(agentFaceUrl(statePeople.agent(doc.agentId)?.name)
            ? { agentAvatarUrl: agentFaceUrl(statePeople.agent(doc.agentId)?.name) }
            : {}),
          ...agentDoorId(doc.agentId, statePeople),
          // Who put the content that is live there now (note #566): any agent
          // in the workplace may redeploy, so the screen answers "who changed
          // this?". A teammate's agent is named exactly as the reader's own
          // is (2026-09-23) — it was "A teammate’s agent", back when agents
          // were their owner's private business — and wears its face and its
          // door, like the agent that first deployed it above.
          ...(doc.lastDeployBy ? (() => {
            const by = doc.lastDeployBy;
            const name = statePeople.agent(by.agentId)?.name ?? by.agentName
              ?? (by.userId === auth.userId ? 'One of your agents' : 'A teammate’s agent');
            const face = agentFaceUrl(statePeople.agent(by.agentId)?.name ?? by.agentName);
            const door = agentDoorId(by.agentId, statePeople).agentId;
            return {
              ...(by.ci ? { lastDeployVia: by.ci.repo } : {}),
              lastDeployedBy: name,
              lastDeployer: {
                agentName: name,
                ...(face ? { agentAvatarUrl: face } : {}),
                ...(door ? { agentId: door } : {}),
              },
            };
          })() : {}),
          // An agent has asked for this one to come down. Same shape as a
          // repository's ask, and read by the site screen for the same
          // reason: the owner should see who asked before they decide.
          ...(doc.deleteAsk ? {
            deleteAsk: {
              at: doc.deleteAsk.at,
              canDecide: (!auth.orgId || auth.orgRole === 'admin')
                && agentRequestOwnedByViewer(auth, doc.deleteAsk),
              ...describeAskAgent(doc.deleteAsk.byAgentId, statePeople, auth.userId),
            },
          } : {}),
          createdAt: doc.createdAt,
          ...(doc.lastDeployAt ? { lastDeployAt: doc.lastDeployAt } : {}),
        }))
      : null;

    // Object-storage buckets (note #768): what the agents keep files in, and
    // — the reason the owner must see them — which are PUBLIC, since those
    // are hosted under the platform's account for strangers to read. Keys
    // never cross. Absent when this backend offers none.
    const buckets: WorkspaceBucketRow[] | undefined = deps.objectStorage
      ? (await deps.objectStorage.list({ orgId: auth.orgId, userId: auth.userId })).map((doc) => {
          const agentName = statePeople.agent(doc.createdBy.agentId)?.name ?? doc.createdBy.agentName;
          const face = agentFaceUrl(agentName);
          const publicUrl = bucketPublicUrl(doc);
          return {
            name: doc.name,
            public: doc.public,
            bucket: doc.bucket,
            hostedOn: doc.hostedOn,
            createdAt: doc.createdAt,
            ...(agentName ? { createdBy: agentName, agentName } : {}),
            ...(face ? { agentAvatarUrl: face } : {}),
            ...agentDoorId(doc.createdBy.agentId, statePeople),
            ...(doc.deleteAsk ? {
              deleteAsk: {
                at: doc.deleteAsk.at,
                canDecide: (!auth.orgId || auth.orgRole === 'admin')
                  && agentRequestOwnedByViewer(auth, doc.deleteAsk),
                ...describeAskAgent(doc.deleteAsk.byAgentId, statePeople, auth.userId),
              },
            } : {}),
            // The bucket's own page (note #778): where a public one is read
            // from, and which secrets hold its keys — names only.
            ...(publicUrl ? { publicUrl } : {}),
            secretNames: Object.values(doc.secretNames),
          };
        })
      : undefined;

    // Knowledge pages (docs/agent-knowledge-pages.md): the list the owner
    // reads, and the proposals waiting on them. Null (not empty) when the
    // feature is unavailable, so the section can say so rather than claim an
    // empty knowledge base.
    let knowledge: WorkspaceKnowledgePageRow[] | null = null;
    let knowledgeProposals: WorkspaceKnowledgeProposalRow[] = [];
    if (deps.knowledgeProposalStorage && deps.gitHostClient) {
      const service = new KnowledgeService(await gitHostFor(ns.orgId), deps.knowledgeProposalStorage, deps.knowledgeShelf);
      knowledge = await service.listPages(ns.namespaceId)
        // Most recently landed first — which is NOT how the service returns
        // them. It sorts by name: the right order for `agentbuilt knowledge
        // list`, where an agent is scanning for a slug, and the wrong one for a
        // card that now shows six pages of eleven (Owner, note #48) — those six
        // would be alphabetical by a slug the reader never sees, which reads as
        // no order at all. A page the index has forgotten carries no stamp and
        // sorts last, not first where an empty date would otherwise put it.
        .then((pages) => [...pages].sort((a, b) => (
          (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.name.localeCompare(b.name)
        )))
        // One shelf for the workplace (note #566), with no room labels.
        .then((pages) => pages.map(({ originNamespaceId: _from, ...page }) => describeKnowledgePage(page, statePeople)))
        .catch(() => null);
      // The workplace's queue (note #843): every namespace's open proposals.
      // A quiet proposal is not in the queue (note #293): the agent is still
      // on it, and nothing here may put an Approve button in front of it.
      const openKnowledgeProposalsByNamespace = await Promise.all(decisionNamespaceIds.map((namespaceId) => (
        hasKnowledgeDecisions ? deps.knowledgeProposalStorage!.listOpenByUser(namespaceId) : []
      )));
      knowledgeProposals = openKnowledgeProposalsByNamespace.flat()
        .filter((doc) => knowledgeProposalAwaitsDecision(doc))
        .map((doc) => ({
          ...describeKnowledgeProposal(doc, statePeople, auth.userId),
          canDecide: proposalOwnedByViewer(auth, doc),
        }));
    }

    // Quick notes (docs/agent-quick-notes.md): what the agents have jotted
    // down, newest first. Null (not empty) when this backend has no note
    // storage, so the section can be absent rather than claim the account has
    // written nothing.
    let notes: ReturnType<typeof describeQuickNote>[] | null = null;
    if (deps.quickNoteStorage) {
      const noteDocs = await deps.quickNoteStorage.listByUser(ns.namespaceId);
      const work = await resolveQuickNoteWorkMap({
        notes: noteDocs,
        pullRequests: deps.gitPullRequestStorage,
        commitStatuses: deps.gitCommitStatusStorage,
      });
      notes = noteDocs.map((doc) => describeQuickNote(
        doc,
        statePeople,
        auth.userId,
        work.get(doc.id) ?? { state: 'unclaimed' },
      ));
    }
    // How many are put away — a NUMBER, not the notes themselves. It is all
    // the notes screen needs to decide whether to draw the door onto the
    // archive, and the archive's own screen fetches its rows when opened.
    const notesArchived = deps.quickNoteStorage
      ? await deps.quickNoteStorage.countArchivedByUser(ns.namespaceId)
      : 0;
    // A workplace whose founding this read found owed (note #664), if any.
    let owedFounding: string | null = null;
    // The workplace, as the home card needs it: presence, name, role and
    // counts. Null when this account is in no org (or the layer isn't wired)
    // — the section hides. The screens behind the card fetch their own rows
    // on open (/api/org, /api/org/seats).
    let org: {
      orgId: string; name: string; handle?: string; role: string; members: number; seats: number; seatProviders: string[];
      setupRequired?: true; unnamed?: true; arriving?: true; founded?: true;
      deletion?: { requestedAt: string; purgeAt: string; requestedByName: string; canKeep: boolean };
      seatUsage?: WorkspaceSeatUsage[];
      activeSeatIds?: string[];
      avatarUrl?: string;
      workspaceAgentAvatarUrl?: string;
      autoMerge?: { on: boolean; changedAt?: string };
    } | null = null;
    // Whether the Workplace section may offer the founder door. Creation
    // is unlimited, so this is true whenever the layer is wired, whether the
    // caller belongs to zero workplaces or twenty — except in a private copy
    // (note #808), where it takes belonging to one already.
    let canCreateOrg = false;
    let organizations: Array<{
      orgId: string; name: string; handle?: string; role: string; active: boolean;
      members: number; agents: number; avatarUrl?: string; deletingAt?: string; invitesClosed?: true;
    }> = [];
    // Shut unless the workplace this tab stands in is one the platform
    // marked (note #805); decided below, once that workplace is read.
    let invitesClosed = Boolean(deps.invitesClosed);
    // People in the workplace this tab stands in, for the Messages offer below.
    let activeMembers = 0;
    if (deps.orgStorage) {
      canCreateOrg = true;
      const memberships = await deps.orgStorage.listMembershipsByUser(auth.userId).catch(() => []);
      if ((deps.privateCopy || deps.signupClosed) && memberships.length === 0) canCreateOrg = false;
      const orgs = await Promise.all(memberships.map(async (membership) => ({
        membership,
        org: await deps.orgStorage!.getOrg(membership.orgId).catch(() => null),
        // One count per workplace, taken once here and reused by the home
        // card below: the picker's rows say what each workplace holds, and
        // the card would otherwise list the active org's members a second
        // time in the same request.
        members: (await deps.orgStorage!.listMembers(membership.orgId)).length,
      })));
      // The viewer's own agents, grouped by the workplace each is pinned to.
      // The whole fleet already rides their profile, so this costs nothing:
      // note #196's picker needs the count for EVERY workplace, not only the
      // one the state payload's agent list is filtered down to. Unstamped
      // agents belong to the legacy org, by the rule this file uses
      // everywhere an agent's workplace is resolved.
      const fleetByOrg = new Map<string, number>();
      for (const agent of listAgents(auth.profile.telegram)) {
        const agentOrgId = agent.orgId ?? auth.legacyOrgId;
        if (agentOrgId) fleetByOrg.set(agentOrgId, (fleetByOrg.get(agentOrgId) ?? 0) + 1);
      }
      organizations = await Promise.all(orgs
        .filter((entry): entry is {
          membership: OrgMembershipDocument; org: NonNullable<typeof entry.org>; members: number;
        } => Boolean(entry.org))
        .map(async ({ membership, org: entryOrg, members }) => ({
          orgId: membership.orgId,
          name: entryOrg.name,
          ...(entryOrg.handle ? { handle: entryOrg.handle } : {}),
          role: membership.role,
          active: membership.orgId === auth.orgId,
          // What the picker's row says about this workplace (note #196):
          // how many people are in it, and how many of the viewer's agents
          // stand there. Every other row said only "You're an admin".
          members,
          agents: fleetByOrg.get(membership.orgId) ?? 0,
          // Being deleted (2026-09-22): the picker says when, so switching to
          // it is never a surprise lock screen.
          ...(entryOrg.deletion ? { deletingAt: entryOrg.deletion.purgeAt } : {}),
          // Per workplace (note #805): a marked one says how many people and
          // who is an admin, while the rest stay name and agents only.
          ...(invitesShutFor(deps.invitesClosed, entryOrg) ? { invitesClosed: true as const } : {}),
          // Each org's face (note #59): the switcher's picker draws every
          // workplace the way the org row draws the active one.
          ...(await pictureUrl(entryOrg.avatar?.storagePath).then((url) => (url ? { avatarUrl: url } : {}))),
        })));
      const membership = auth.orgId
        ? memberships.find((entry) => entry.orgId === auth.orgId) ?? null
        : null;
      const orgDoc = membership ? await deps.orgStorage.getOrg(membership.orgId).catch(() => null) : null;
      if (membership && orgDoc) {
        invitesClosed = invitesShutFor(deps.invitesClosed, orgDoc);
        const members = orgs.find((entry) => entry.membership.orgId === membership.orgId)?.members ?? 0;
        activeMembers = members;
        // Read and, when needed, refreshed once above: status gating and Home
        // usage must describe the same seat snapshot.
        const seats = memberSeats;
        const orgAvatarUrl = await pictureUrl(orgDoc.avatar?.storagePath);
        // The Workspace Agent's face rides this read too (note #627): the
        // arriving gate and Home used to wait for api/recap for it, and drew
        // the bot glyph beside six room agents whose faces this payload
        // already carried. Same resolution as the recap's, so they agree.
        const workspaceAgentAvatarUrl = workspaceAgentFaceUrl(orgDoc.workspaceAgentAvatarSlug);
        // Every seat by name with a reading per TRACK, for the home row —
        // from the snapshot the 5-minute probe keeps fresh, at zero probe
        // cost. Note #86: Fable and the other models hold separate weekly
        // allowances, so one collapsed number cannot say which is spent.
        // Extra usage is a spend cap rather than a limit that stops a turn,
        // and stays on the seat's own screen with its amounts. A dead seat
        // keeps its name but not its stale readings.
        const seatUsage = workspaceSeatUsageRows(seats);
        // One live subscription is the prerequisite for the Workspace, no
        // matter when this workplace was created (its own cloud was one too,
        // until note #664 hosted workplaces on ours). `setupRequired` began as
        // a founder-onboarding marker, which let an older empty workplace
        // expose the whole shell after its owner switched into it. Derive the
        // lock from today's facts instead: active context selects a workplace,
        // but it cannot make missing infrastructure or credentials usable.
        // …and, once founded, until the founder has stepped in from the
        // arriving screen (2026-09-18): the team is built behind the gate.
        // A founding still owed stands in front too (note #664): with the
        // cloud step gone, a founder whose subscription was CARRIED in — a
        // second workplace from the founder door, or the spare their account
        // came with — has a seat the moment they arrive, and would otherwise
        // open onto an empty Workspace while the team is being written.
        // Only for the founder, whose team it is: a member who joined an
        // unfounded workplace is not held behind a founding only its founder
        // can start.
        // Since note #726 none of that stands in front of the Workspace: a
        // new account lands on Home — the Chief of Staff's chat — at once,
        // the plan is asked for inside that chat, and no team is built
        // before the person has said what they are working on. `setupRequired`
        // is false for every workplace; what is left of the founding is the
        // name-settling edge below, and the deletion lock the gate still
        // draws. A workplace caught `arriving` at the deploy keeps its
        // planned agents, which finish on their own.
        const owesFounding = Boolean(orgDoc.foundingPending) && orgDoc.createdByUserId === auth.userId;
        const setupRequired = false;
        if (owesFounding && liveSeatProviders.size > 0) owedFounding = orgDoc.orgId;
        // The stored marker remains only as old bookkeeping. Clear it once
        // complete so older code and records keep their previous invariant;
        // the response above never trusts it as the source of truth.
        if (orgDoc.setupRequired && !setupRequired) {
          await deps.orgStorage.updateOrg(orgDoc.orgId, { setupRequired: false }).catch(() => false);
        }
        org = {
          orgId: membership.orgId,
          name: orgDoc.name,
          ...(orgDoc.handle ? { handle: orgDoc.handle } : {}),
          role: membership.role,
          members,
          seats: seats.filter((seat) => seat.status !== 'disabled').length,
          ...(seatUsage.length ? { seatUsage } : {}),
          ...(deps.agentLifecycle?.workspaceSeatIdsInUse
            ? { activeSeatIds: deps.agentLifecycle.workspaceSeatIdsInUse(auth.userId, membership.orgId) }
            : {}),
          // The org's face (note #56), when an admin has set one — the same
          // signed-URL shape every personal picture on this payload rides.
          ...(orgAvatarUrl ? { avatarUrl: orgAvatarUrl } : {}),
          ...(workspaceAgentAvatarUrl ? { workspaceAgentAvatarUrl } : {}),
          // The reader's OWN auto-merge (note #944), on the read Home and the
          // Workplace window already make: the header's yellow line and the
          // window's switch draw from it, with no request of their own.
          // Absent until they first touch it.
          ...(membership.autoApprove
            ? { autoMerge: { on: membership.autoApprove.on, changedAt: membership.autoApprove.changedAt } }
            : {}),
          // Which providers the caller could run an agent on RIGHT NOW — a
          // live seat of their own (the set the agent rows above were judged
          // by). The New-agent chooser reads it to route a missing sign-in
          // to the seats screen instead of bouncing off the server's refusal.
          seatProviders: [...liveSeatProviders].sort(),
          ...(setupRequired ? { setupRequired: true } : {}),
          ...(orgDoc.unnamed ? { unnamed: true } : {}),
          ...(orgDoc.arriving ? { arriving: true } : {}),
          // An admin asked to delete it (2026-09-22): the whole Workspace
          // stands behind the lock screen until it is kept or gone.
          ...(orgDoc.deletion ? { deletion: deletionFacts(orgDoc, membership.role)! } : {}),
          // Founded for real (note #144): `foundingPending` is stamped at
          // creation and cleared by the founding, so a false says it
          // happened; a workplace from before founding never had the stamp.
          ...(orgDoc.foundingPending === false ? { founded: true } : {}),
          // Kept separate from live capacity so creation and agent rows can
          // point at billing without ever treating the paused grant as usable.
          ...(paymentRequiredSeatProviders.size
            ? { paymentRequiredSeatProviders: [...paymentRequiredSeatProviders].sort() }
            : {}),
        };
      }
    }

    const webIdentity = deps.workspaceWebAuth
      ? await deps.workspaceWebAuth.identityForUser(auth.userId).catch(() => null)
      : null;
    const mailbox = deps.mailboxes ? await deps.mailboxes.forUser(auth.userId).catch(() => null) : null;
    // The viewer's own pending request to join another workplace, if any —
    // only looked up while their active workplace is still the unnamed one
    // their account came with, which is the one case the page acts on it.
    // In a private copy (note #808) a newcomer has no workplace at all until
    // the request is decided, and that case is acted on too.
    let joining: { requestId: string; inviteToken: string; orgName: string } | undefined;
    // And an account in no workplace at all: a copy's newcomer (note #808),
    // and since note #949 anyone who made their account through an invite
    // link on our own platform too.
    if (deps.orgStorage && (org?.unnamed || !org)) {
      const pending = (await deps.orgStorage.listJoinRequestsByUser(auth.userId).catch(() => []))
        .find((request) => request.status === 'pending');
      const target = pending ? await deps.orgStorage.getOrg(pending.orgId).catch(() => null) : null;
      // A request into a workplace whose door has since shut (its mark taken
      // off, note #805) is decided by nobody, so it holds nobody at the door.
      if (pending && target && !invitesShutFor(deps.invitesClosed, target)) {
        joining = { requestId: pending.requestId, inviteToken: pending.inviteToken, orgName: target.name };
      }
    }
    // Nothing else calls the founding once a carried-in subscription has
    // arrived (it used to be the cloud connect). Never while the person waits
    // to join another team: that spare workplace is a by-product, and its
    // team would be four machines nobody asked for.
    if (owedFounding && !joining) {
      void foundIfReady(auth.userId, owedFounding).catch((error) => {
        console.warn(`[founding] ${owedFounding} could not be founded from the state read:`, error);
      });
    }
    const licenceNotice = deps.copyLicence && auth.orgRole === 'admin'
      ? await deps.copyLicence.status().catch(() => null)
      : null;
    return res.json({
      org,
      ...(joining ? { joining } : {}),
      ...(licenceNotice && (licenceNotice.state !== 'valid' || licenceNotice.overLimit)
        ? { copyLicence: { state: licenceNotice.state === 'valid' ? 'over' : licenceNotice.state, line: licenceNotice.line } }
        : {}),
      // Email in a private copy, which installs without it (note #946).
      ...(deps.copyMail
        ? { mailSetup: { state: deps.copyMail.phase(), ...(auth.orgRole === 'admin' ? { canSetUp: true as const } : {}) } }
        : {}),
      organizations,
      canCreateOrg,
      // Who is looking: the browser-authenticated identity plus the profile
      // the person screen edits — names from their own words or a legacy
      // profile mirror, the face as a signed URL, and whether the profile
      // still wants their minute (note #57's "required" is this flag: home
      // nudges until a first name, last name and picture are all there).
      user: {
        name: personDisplayName(auth.profile),
        profile: {
          firstName: auth.profile.person?.firstName ?? '',
          lastName: auth.profile.person?.lastName ?? '',
          ...(statePeople.photoUrl(auth.userId) ? { photoUrl: statePeople.photoUrl(auth.userId) } : {}),
          incomplete: personProfileIncomplete(auth.profile),
        },
        account: {
          browserLogin: webIdentity
            ? webIdentity.kind === 'email'
              ? {
                enabled: true,
                method: 'email',
                email: webIdentity.email,
                secondFactorEnabled: Boolean(webIdentity.encryptedTotpSecret),
                verificationStatus: workspaceEmailVerificationStatus(webIdentity),
                ...(webIdentity.recoveryEmail ? {
                  recoveryEmail: {
                    email: webIdentity.recoveryEmail,
                    status: webIdentity.recoveryEmailVerifiedAt ? 'verified' as const : 'pending' as const,
                  },
                } : {}),
              }
              : { enabled: true, method: 'totp', username: webIdentity.username }
            : { enabled: false },
          // Their own address on the mail domain, absent until they pick one.
          ...(mailbox ? { mailbox } : {}),
        },
      },
      agents: agentRows,
      ...(auth.orgId ? { teamAgents } : {}),
      secrets,
      repos,
      sites,
      ...(buckets ? { buckets } : {}),
      prs,
      knowledge,
      knowledgeProposals,
      notes,
      messagesAvailable: DIRECT_MESSAGES_OFFERED && Boolean(deps.directMessageStorage && auth.orgId)
        && (!invitesClosed || activeMembers > 1),
      ...(invitesClosed ? { invitesClosed: true as const } : {}),
      driveAvailable: Boolean(deps.driveStorage && deps.mediaStorage && auth.orgId),
      radio: Boolean(deps.radio),
      // The radio's library page (note #758) is the platform operator's, so
      // only their account is told there is one; anyone else has no door.
      ...(deps.radio && isAdminAccount(auth.profile) ? { radioLibrary: true as const } : {}),
      notesArchived,
      // Whether a note can carry files at all. An OPEN note answers this for
      // itself — it arrives with an `attachments` list, or without one on a
      // backend that has nowhere to put bytes. A note being WRITTEN has no
      // list to read, and the composer still has to decide whether to offer
      // "Attach a file", so the capability is stated once here rather than
      // guessed at, and a backend with no media store offers no button
      // instead of one that 503s.
      noteFiles: Boolean(deps.mediaStorage),
      ...(quota ? { quota } : {}),
    } satisfies WorkspaceStateAnswer);
  });

  /**
   * The small facts on the home screen that can change between ticks: which
   * agents are mid-turn, what each one is doing, and a newly written recap.
   * Their own endpoint stays deliberately tiny — the state payload above reads
   * proposals, deployments, repositories, secrets, knowledge pages and every
   * proposal's checks, and re-reading all of that every five seconds for the
   * length of a turn (which can be an hour) to repaint one line would be the
   * most expensive thing this backend does.
   *
   * Here it is one profile read and an in-memory registry lookup per agent:
   * nothing is fetched that cannot change between two ticks.
   *
   * `agents` still lists only the ones actually working; anything absent is
   * idle. `recaps` is separate because a final recap is written after the
   * working agent has left that set. The page treats a change in the working
   * SET as "the world moved" and re-reads full state once; recap changes can
   * be applied directly to the already-loaded rows.
   */
  const recapCoordinator = new WorkspaceRecapCoordinator();
  const recapSources = new Map<string, {
    at: number; promise: ReturnType<typeof collectWorkspaceRecapSources>;
  }>();
  const recapProviders = async (userId: string, orgId: string): Promise<string[]> => (await deps.orgStorage!.listSeatsByMember(orgId, userId)).filter(s => s.status !== 'disabled' && s.status !== 'dead').map(s => s.provider);
  const recapSettingsResponse = async (
    auth: MiniAppAuth,
    stored?: import('../shared/workspace-recap.js').WorkspaceRecapSettings,
  ): Promise<WorkspaceRecapSettingsAnswer> => {
    const agents = Object.values(auth.profile.telegram?.agents ?? {}).filter((a) => activeAgent(auth, a.id));
    const providers = await recapProviders(auth.userId, auth.orgId!);
    const settings = resolveRecapSettings(agents, stored, providers);
    return { orgId: auth.orgId!, settings, models: availableRecapModels(agents, settings, providers) };
  };
  const initializeAgentSettings = async (
    userId: string,
    orgId: string,
    agents: AgentRecord[],
    providers: string[],
    member: OrgMembershipDocument,
    pinDefault = false,
  ): Promise<OrgMembershipDocument | null> => {
    if (member.workspaceAgentSettings) return member;
    // Only a pick is written down. A member who never chose keeps following
    // the default, so it moves with their sign-ins (note #747) — it used to
    // be frozen at the first read, on whatever the default was that day.
    const inherited = validRecapSettings(member.workspaceRecapSettings)
      ? member.workspaceRecapSettings
      : pinDefault ? resolveRecapSettings(agents, undefined, providers) : null;
    return inherited ? deps.orgStorage!.initializeWorkspaceAgentSettings(orgId, userId, inherited) : member;
  };
  /**
   * The original split left one compatibility edge: until somebody opened
   * the Agent picker, its value was read from workspaceRecapSettings. A recap
   * pick therefore still moved both. Materialize that old effective value in
   * the Agent's own field exactly once; every read and run after this uses
   * only that field (note #447). `pinDefault` is for the recap write alone:
   * the recap pick it is about to store would otherwise be inherited next.
   */
  const independentAgentSettings = async (
    auth: MiniAppAuth,
    member: OrgMembershipDocument,
    pinDefault = false,
  ): Promise<WorkspaceRecapSettingsAnswer | null> => {
    const agents = Object.values(auth.profile.telegram?.agents ?? {}).filter((a) => activeAgent(auth, a.id));
    const providers = await recapProviders(auth.userId, auth.orgId!);
    const initialized = await initializeAgentSettings(auth.userId, auth.orgId!, agents, providers, member, pinDefault);
    if (!initialized) return null;
    const settings = resolveRecapSettings(agents, initialized.workspaceAgentSettings, providers);
    return { orgId: auth.orgId!, settings, models: availableRecapModels(agents, settings, providers) };
  };
  router.get('/api/recap/settings', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.orgId || !deps.orgStorage) return res.status(404).json({ error: 'Choose a workplace first.' });
    const member = await deps.orgStorage.getMembership(auth.orgId, auth.userId);
    if (!member) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    return res.json(await recapSettingsResponse(auth, member.workspaceRecapSettings));
  });
  /** A picked model, validated and written to one of the two settings (note #437). */
  const writeRecapSettings = async (req: Request, res: Response, field: 'workspaceRecapSettings' | 'workspaceAgentSettings') => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.orgId || !deps.orgStorage) return res.status(404).json({ error: 'Choose a workplace first.' });
    const member = await deps.orgStorage.getMembership(auth.orgId, auth.userId);
    if (!member) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    if (!validRecapSettings(req.body)) return res.status(400).json({ error: 'Choose a supported model and effort.' });
    const { cli, model, effort } = req.body;
    const settings = { cli, model, effort };
    const candidates = recapCandidates(Object.values(auth.profile.telegram?.agents ?? {}).filter((a) => activeAgent(auth, a.id)));
    if (!candidates.some((a) => a.cli === cli) && !(await recapProviders(auth.userId, auth.orgId)).includes(cli)) return res.status(409).json({ error: `Connect your own ${cli === 'codex' ? 'ChatGPT' : 'Claude'} subscription in this workplace to use that model.` });
    // Preserve the Agent's CURRENT effective value before changing the old
    // shared recap field. The atomic initializer refuses to replace a pick
    // that may have landed concurrently in another tab.
    if (field === 'workspaceRecapSettings' && !await independentAgentSettings(auth, member, true)) {
      return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    }
    const written = await deps.orgStorage.touchMember(auth.orgId, auth.userId, { [field]: settings });
    if (!written) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    // Both simply use it next time: the agent on its next request, the recap
    // on the reader's next press. Nothing is rewritten on a model change, and
    // a recap already being written finishes with the model it was asked for
    // (note #607).
    return res.json(await recapSettingsResponse(auth, settings));
  };
  router.post('/api/recap/settings', (req, res) => writeRecapSettings(req, res, 'workspaceRecapSettings'));
  // The Workspace Agent's own model and effort. Pre-split memberships are
  // initialized once from what the shared setting meant, then this route
  // reads and writes only the Agent's independent value (note #447).
  router.get('/api/recap/agent/settings', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.orgId || !deps.orgStorage) return res.status(404).json({ error: 'Choose a workplace first.' });
    const member = await deps.orgStorage.getMembership(auth.orgId, auth.userId);
    if (!member) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    const answer = await independentAgentSettings(auth, member);
    return answer ? res.json(answer) : res.status(403).json({ error: 'You no longer belong to this workplace.' });
  });
  router.post('/api/recap/agent/settings', (req, res) => writeRecapSettings(req, res, 'workspaceAgentSettings'));
  /**
   * The Workspace Agent's own screen (note #439): the same state Home's plate
   * reads, plus the two facts a person opens an agent's screen to check —
   * what it thinks with, and what it runs on. The machine's SHAPE comes off
   * the record rather than from Fly: this screen is opened from a
   * conversation header mid-thread, and a live machine read would put a
   * network round trip in front of a page that is otherwise already known.
   */
  router.get('/api/recap/agent', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.orgId || !deps.orgStorage) return res.status(404).json({ error: 'Choose a workplace first.' });
    const member = await deps.orgStorage.getMembership(auth.orgId, auth.userId);
    if (!member) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    const record = Object.values(auth.profile.telegram?.agents ?? {}).find((a) => a.orgId === auth.orgId && isWorkspaceAgent(a));
    const face = await workspaceAgentFaceForOrg(auth.orgId);
    const settings = await independentAgentSettings(auth, member);
    if (!settings) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    return res.json({
      orgId: auth.orgId,
      ...(record?.id ? { agentId: record.id } : {}),
      agent: {
        ...(await recapChat.status(auth.userId, auth.orgId, Boolean(record))),
        ...(face ? { avatarUrl: face } : {}),
        ...contextFields(record?.contextUsage),
      },
      settings: settings.settings,
      ...(record?.machineSize ? { machine: record.machineSize } : {}),
      ...(record?.createdAt ? { createdAt: record.createdAt } : {}),
    } satisfies WorkspaceAgentDetailsAnswer);
  });

  /** Who an overview is for: enough of a MiniAppAuth to scope sources, with
   *  no browser session behind it, so an event can build one from storage. */
  type RecapReader = Pick<MiniAppAuth, 'userId' | 'profile' | 'orgId' | 'legacyOrgId'> & { orgId: string };
  /** Event-driven refreshes only serve members who looked at Home this recently. */
  const RECAP_READER_WINDOW_MS = 24 * 60 * 60 * 1000;
  /** ...and the read stamp behind that is written at most this often. */
  const RECAP_READ_STAMP_MS = 10 * 60 * 1000;
  const recapReaderFor = async (userId: string, orgId: string): Promise<RecapReader | null> => {
    if (!deps.orgStorage) return null;
    if (!deps.userStorage) return null;
    const [profile, memberships] = await Promise.all([
      deps.userStorage.getProfile(userId),
      deps.orgStorage.listMembershipsByUser(userId),
    ]);
    if (!profile || !memberships.some((m) => m.orgId === orgId)) return null;
    const legacyOrgId = [...memberships]
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]?.orgId ?? null;
    return { userId, profile, orgId, legacyOrgId };
  };
  /**
   * The week's sources, read for one reader and held for a minute: the
   * workplace's one briefing (note #843) budgets them with
   * `selectRecapSources` (`recapMaterial`). The reader's conversation with
   * the Workspace Agent is not material for it.
   */
  const collectRecap = (reader: RecapReader, fresh: boolean) => {
    const key = `${reader.orgId}/${reader.userId}`;
    const now = Date.now();
    for (const [other, entry] of recapSources) if (now - entry.at > 60_000) recapSources.delete(other);
    let entry = fresh ? undefined : recapSources.get(key);
    if (!entry) {
      const promise = (async () => {
        const namespaces = await viewerNamespaces(reader);
        const agents = Object.values(reader.profile.telegram?.agents ?? {}).filter((a) => activeAgent(reader, a.id));
        return collectWorkspaceRecapSources({
          deps, userId: reader.userId, orgId: reader.orgId, namespaces, agents,
          pages: async (namespace) => deps.knowledgeProposalStorage && (deps.gitHostClient || deps.orgGitHost)
            ? new KnowledgeService(await gitHostFor(reader.orgId), deps.knowledgeProposalStorage, deps.knowledgeShelf).listPagesFrom(namespace) : [],
        });
      })();
      entry = { at: now, promise }; recapSources.set(key, entry);
    }
    return { key, entry };
  };
  /**
   * What a recap is read from and written over, shared by the card's read and
   * the press that writes one: the sources this reader may see, their own
   * subscription capacity, and the model they chose.
   */
  const recapMaterial = async (reader: RecapReader, fresh: boolean) => {
    const orgId = reader.orgId;
    const { key: readerKey, entry } = collectRecap(reader, fresh);
    // One run per reader: the workplace's one briefing (note #843).
    const key = `${readerKey}/workplace`;
    const whole = await entry.promise;
    // Every source under one budget.
    const collected = {
      sources: selectRecapSources(whole.sources),
      incomplete: whole.incomplete,
    };
    // Subscription capacity is current account state, not seven-day activity,
    // so it stays out of the expandable source list. Read only this member's
    // assigned items and project the exact non-secret rows Home already shows.
    // A failed seat read must not silently mint a recap that omits a likely
    // bottleneck; the previous recap remains in place until the read recovers.
    const seatDocs = await deps.orgStorage!.listSeatsByMember(orgId, reader.userId).catch(() => null);
    const subscriptions = workspaceSeatUsageRows(seatDocs ?? []);
    const incomplete = collected.incomplete || seatDocs === null;
    // Settings may have changed while the source read was in flight.
    const member = await deps.orgStorage!.getMembership(orgId, reader.userId);
    const ownAgents = Object.values(reader.profile.telegram?.agents ?? {}).filter((a) => activeAgent(reader, a.id));
    const settings = member ? resolveRecapSettings(ownAgents, member.workspaceRecapSettings, (seatDocs ?? []).map(s => s.provider)) : null;
    return { key, entry, collected, subscriptions, incomplete, member, settings };
  };
  /**
   * The card: the saved words, what they were written over, and whether a
   * recap the reader asked for is being written right now. Reading it never
   * starts one (note #607) — only the card's button does, through
   * api/recap/write. `stamp` records that a person actually read the card,
   * which is what event-driven source collection keys on.
   */
  const recapAnswer = async (reader: RecapReader, options: { stamp?: boolean } = {}): Promise<WorkspaceRecapAnswer | null> => {
    const orgId = reader.orgId;
    const { key, entry, collected, subscriptions, incomplete, member, settings } = await recapMaterial(reader, false);
    if (!member) return null;
    const saved = { recap: member.workspaceRecap };
    const readAt = Date.parse(member.workspaceRecapReadAt ?? '');
    if (options.stamp && !(Date.now() - readAt < RECAP_READ_STAMP_MS)) {
      await deps.orgStorage!.touchMember(orgId, reader.userId, { workspaceRecapReadAt: new Date().toISOString() }).catch(() => false);
    }
    const summary = collected.sources.length || incomplete ? saved?.recap ?? null : null;
    const updating = recapCoordinator.busy(key);
    // Nothing running, and the last press came back empty: the reader is owed
    // the reason rather than a card that simply went quiet (note #389).
    const refreshFailed = updating ? undefined : recapCoordinator.failureFor(key);
    const org = await deps.orgStorage!.getOrg(orgId);
    // The plate over the briefing: whether the person's Workspace Agent has a
    // machine yet, and what its conversation is doing right now.
    const started = Object.values(reader.profile.telegram?.agents ?? {}).some((a) => a.orgId === orgId && isWorkspaceAgent(a));
    const face = workspaceAgentFaceUrl(org?.workspaceAgentAvatarSlug);
    const record = Object.values(reader.profile.telegram?.agents ?? {})
      .find((candidate) => candidate.orgId === orgId && isWorkspaceAgent(candidate));
    const agent = {
      ...(await recapChat.status(reader.userId, orgId, started)),
      ...(face ? { avatarUrl: face } : {}),
      ...contextFields(record?.contextUsage),
    };
    return { orgId, summary, updating, agent,
      stale: Boolean(summary && summary.fingerprint !== recapFingerprint(collected.sources, settings, subscriptions)),
      ...(refreshFailed ? { refreshFailed } : {}),
      sources: collected.sources, incomplete,
      since: new Date(entry.at - RECAP_WINDOW_MS).toISOString(), checkedAt: new Date(entry.at).toISOString(),
    };
  };
  /**
   * Event-driven source collection (note #392). A change re-reads the sources
   * at once, past the one-minute cache, so the card's next read — and the
   * reader's next press — find the week as it now stands. It writes nothing:
   * since note #607 a briefing is written only when the reader asks. Only
   * members who opened Home in the last day are served; a card nobody opens
   * is not worth the reads.
   */
  const refreshRecapFor = async (userId: string, orgId: string): Promise<void> => {
    const member = await deps.orgStorage?.getMembership(orgId, userId).catch(() => null);
    // A member who never opened Home has no stamp: NaN compares false both ways, so the test is written as "read recently".
    if (!member || !(Date.now() - Date.parse(member.workspaceRecapReadAt ?? '') < RECAP_READER_WINDOW_MS)) return;
    const reader = await recapReaderFor(userId, orgId);
    if (reader) await collectRecap(reader, true).entry.promise;
  };
  const refreshRecapForOrg = (orgId: string | null | undefined): void => {
    if (!orgId || !deps.orgStorage) return;
    void deps.orgStorage.listMembers(orgId).then((members) => Promise.all(members.map((m) => refreshRecapFor(m.userId, orgId))))
      .catch((error) => console.warn(`[recap] Workplace refresh after a change failed for ${orgId}:`, error));
  };
  deps.agentLifecycle?.onWorkspaceActivity?.((event) => {
    void (async () => {
      const profile = await deps.userStorage?.getProfile(event.userId);
      const agent = profile?.telegram?.agents?.[event.agentId];
      if (!agent) return;
      const orgId = agent.orgId ?? (await recapReaderFor(event.userId, agent.orgId ?? ''))?.legacyOrgId
        ?? (await deps.orgStorage?.listMembershipsByUser(event.userId))?.[0]?.orgId;
      if (orgId) {
        if (event.kind === 'turn-ended') {
          await recapChat.read(event.userId, orgId).catch(() => {});
          // A turn ending is when a failure, a report or a silence becomes
          // true: look for events now rather than at the next tick (note #716).
          if (!isWorkspaceAgent(agent)) deps.workspaceAgentEvents?.nudge(event.userId, orgId);
        }
        await refreshRecapFor(event.userId, orgId);
      }
    })().catch((error) => console.warn(`[recap] Refresh after ${event.kind} on agent ${event.agentId} failed:`, error));
  });

  const recapChat = new WorkspaceRecapChat(deps, async (userId, orgId) => {
    const reader = await recapReaderFor(userId, orgId);
    if (!reader) return null;
    const [member, namespaces, members] = await Promise.all([
      deps.orgStorage!.getMembership(orgId, userId), viewerNamespaces(reader), deps.orgStorage!.listMembers(orgId),
    ]);
    if (!member) return null;
    const agents: RecapScope['agents'] = [];
    for (const person of members) {
      const profile = person.userId === userId ? reader.profile : await deps.userStorage!.getProfile(person.userId);
      for (const record of Object.values(profile?.telegram?.agents ?? {})) {
        if (record.orgId !== orgId || record.purpose) continue;
        agents.push({ record, own: person.userId === userId, owner: profile ? personDisplayName(profile) : undefined, working: Boolean(deps.agentLifecycle?.isAgentWorking?.(person.userId, record.id)) });
      }
    }
    const ownAgents = agents.filter(a => a.own).map(a => a.record);
    const providers = await recapProviders(userId, orgId);
    // The conversation may be entered through a direct link before any of
    // its browser settings reads settles. Initialize here too, so the first
    // acting turn already uses and persists the independent Agent value.
    const initialized = await initializeAgentSettings(userId, orgId, ownAgents, providers, member);
    if (!initialized) return null;
    // Unlike a prose briefing, this is factual model input read for the turn
    // itself, from the same source collector that understands decision
    // state; this conversation is carried separately.
    const activity = selectRecapSources((await collectWorkspaceRecapSources({
      deps, userId, orgId, namespaces, agents: ownAgents,
      pages: async (namespace) => deps.knowledgeProposalStorage && (deps.gitHostClient || deps.orgGitHost)
        ? new KnowledgeService(await gitHostFor(orgId), deps.knowledgeProposalStorage, deps.knowledgeShelf).listPagesFrom(namespace) : [],
    })).sources);
    return {
      activity,
      // Its own persisted pick. A pre-split membership copied the previously
      // shared effective value immediately above; after that this run never
      // reads the recap's setting (note #447).
      settings: resolveRecapSettings(ownAgents, initialized.workspaceAgentSettings, providers),
      agents,
    };
  }, refreshRecapForOrg, {
    seated: async (userId, orgId) => (await recapProviders(userId, orgId)).length > 0,
    // The founder of a workplace made since note #726, by their first name.
    // A member who joined is welcomed below instead (note #820).
    greeting: async (userId, orgId) => {
      const org = await deps.orgStorage!.getOrg(orgId).catch(() => null);
      if (!org?.firstRun || org.createdByUserId !== userId) return null;
      const profile = await deps.userStorage!.getProfile(userId).catch(() => null);
      return firstRunGreeting(profile?.person?.firstName);
    },
    // A person who joined this workplace through an invite or a join request
    // (note #820) — the membership names who let them in — and joined since
    // the hello shipped. What it names is what every member sees: every
    // member's agents in one list (note #843) and the latest notes.
    welcome: async (userId, orgId) => {
      const [org, member] = await Promise.all([deps.orgStorage!.getOrg(orgId).catch(() => null), deps.orgStorage!.getMembership(orgId, userId)]);
      if (!org || !member?.invitedByUserId || org.createdByUserId === userId || member.joinedAt < JOINER_WELCOME_SINCE) return null;
      const [members, profile] = await Promise.all([deps.orgStorage!.listMembers(orgId), deps.userStorage!.getProfile(userId).catch(() => null)]);
      const agents: Array<{ name: string; owner?: string; doing?: string; working: boolean; at: string }> = [];
      for (const person of members) {
        if (person.userId === userId) continue;
        const owner = await deps.userStorage!.getProfile(person.userId).catch(() => null);
        for (const record of Object.values(owner?.telegram?.agents ?? {})) {
          if (record.orgId !== orgId || record.purpose) continue;
          const working = Boolean(deps.agentLifecycle?.isAgentWorking?.(person.userId, record.id));
          agents.push({
            name: record.name, owner: owner?.person?.firstName?.trim() || personDisplayName(owner), working,
            ...(record.recap?.text ? { doing: joinerDoingLine(record.recap.text) } : working ? { doing: 'working on its first job now.' } : {}),
            at: record.recap?.at ?? '',
          });
        }
      }
      const notes = deps.quickNoteStorage
        ? (await deps.quickNoteStorage.listByUser(orgKnowledgeShelfNamespace(org)).catch(() => []))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, JOINER_WELCOME_LIMITS.notes)
        : [];
      return joinerWelcome({
        firstName: profile?.person?.firstName,
        workplace: org.name,
        agents: agents.sort((a, b) => Number(b.working) - Number(a.working) || b.at.localeCompare(a.at)),
        notes: notes.map((doc) => ({
          title: quickNoteTitle(doc.html),
          href: `/notes/${doc.number}?org=${encodeURIComponent(orgId)}`,
        })),
      });
    },
  });
  // The agent CLI routes leave the Workspace Agent's action receipts here
  // (RouteDeps.workspaceAgent): the conversation is owned by this router, and
  // the CLI router only ever sees the shared deps object.
  deps.workspaceAgent = recapChat;
  // The Chief of Staff's event turns (note #716): the sweep that notices,
  // built beside the conversation that reacts. index.ts starts it.
  const eventSweep = deps.orgStorage && deps.userStorage ? new WorkspaceAgentEventSweep({
    orgStorage: deps.orgStorage, userStorage: deps.userStorage,
    ...(deps.quickNoteStorage ? { quickNoteStorage: deps.quickNoteStorage } : {}),
    ...(deps.gitPullRequestStorage ? { gitPullRequestStorage: deps.gitPullRequestStorage } : {}),
    ...(deps.gitCommitStatusStorage ? { gitCommitStatusStorage: deps.gitCommitStatusStorage } : {}),
    ...(deps.knowledgeProposalStorage ? { knowledgeProposalStorage: deps.knowledgeProposalStorage } : {}),
    ...(deps.agentLifecycle?.latestAgentChatRow ? { latestChatRow: (userId: string, agentId: string) => deps.agentLifecycle!.latestAgentChatRow!(userId, agentId) } : {}),
    isAgentWorking: (userId, agentId) => Boolean(deps.agentLifecycle?.isAgentWorking?.(userId, agentId)),
    ...(deps.mailboxes ? {
      mailHolderOf: (address: string) => deps.mailboxes!.holderOf(address),
      mailWakeAgentOf: async (userId: string) => (await deps.mailboxes!.mailboxOf(userId))?.wakeAgentId ?? null,
    } : {}),
    receiveEvents: (args) => recapChat.receiveEvents(args),
  }) : undefined;
  if (eventSweep) deps.workspaceAgentEvents = eventSweep;
  /**
   * The Chief of Staff's event turns and standing permissions (note #716):
   * the person's own settings, read and changed from the Workplace window, and
   * its newest event turns for that window's "Noticed lately". Private like
   * the rest of the membership's Workspace Agent fields.
   */
  const proactiveAnswer = async (auth: MiniAppAuth & { orgId: string }, stored: unknown): Promise<WorkspaceAgentProactiveAnswer> => ({
    orgId: auth.orgId, settings: resolveWorkspaceAgentProactive(stored), recent: await recapChat.eventHistory(auth.userId, auth.orgId).catch(() => []),
  });
  router.get('/api/recap/agent/proactive', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.orgId || !deps.orgStorage) return res.status(404).json({ error: 'Choose a workplace first.' });
    const member = await deps.orgStorage.getMembership(auth.orgId, auth.userId);
    if (!member) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    return res.json(await proactiveAnswer({ ...auth, orgId: auth.orgId }, member.workspaceAgentProactive));
  });
  router.put('/api/recap/agent/proactive', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.orgId || !deps.orgStorage) return res.status(404).json({ error: 'Choose a workplace first.' });
    const member = await deps.orgStorage.getMembership(auth.orgId, auth.userId);
    if (!member) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    const current = resolveWorkspaceAgentProactive(member.workspaceAgentProactive);
    const change = applyWorkspaceAgentProactiveChange(current, req.body);
    if (!change.ok) return res.status(400).json({ error: change.error });
    const written = await deps.orgStorage.touchMember(auth.orgId, auth.userId, { workspaceAgentProactive: change.value });
    if (!written) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    // Just turned on: the first look comes within a minute, not at the next tick.
    if (change.value.events && !current.events) eventSweep?.nudge(auth.userId, auth.orgId);
    return res.json(await proactiveAnswer({ ...auth, orgId: auth.orgId }, change.value));
  });
  const recapChatError = (res: Response, error: unknown) => res.status(error instanceof RecapChatError ? error.status : 503).json({ error: error instanceof RecapChatError ? error.message : 'Workspace Agent could not be reached.' });
  // What every conversation answer carries besides the transcript: the
  // header wears the same durable workplace face as Home's plate (note #582), and
  // the ring reads the agent's last measured context fill.
  const recapChatDecor = async (auth: MiniAppAuth) => {
    const face = await workspaceAgentFaceForOrg(auth.orgId);
    const record = Object.values(auth.profile.telegram?.agents ?? {})
      .find((candidate) => candidate.orgId === auth.orgId && isWorkspaceAgent(candidate));
    // The line under its latest completed request (note #945), from the
    // record every answer already reads.
    const lastTurn = turnRecapOf(record);
    return { ...(face ? { avatarUrl: face } : {}), ...contextFields(record?.contextUsage), ...(lastTurn ? { lastTurn } : {}) };
  };
  /** How many forwarded proposals one answer reads fresh — the newest. An
   *  older card keeps the words it was forwarded with (its row's text). */
  const FORWARDED_PROPOSALS_READ = 20;
  /**
   * The proposals the Chief of Staff forwarded (note #724), read as they
   * stand NOW on every answer — the stored row holds a pointer only, so a
   * card says Merged the moment the proposal merges, in every open tab. A
   * proposal outside the reader's workplace is never described, whatever
   * pointer a row holds.
   */
  const withForwardedProposals = async <T extends { proposals?: RecapForwardedProposalRef[] }>(
    auth: MiniAppAuth,
    messages: T[],
  ): Promise<Array<T & { forwarded?: WorkspaceForwardedProposal[] }>> => {
    const refs = messages.flatMap((message) => message.proposals ?? []).slice(-FORWARDED_PROPOSALS_READ);
    if (!refs.length) return messages;
    const wanted = new Set(refs.map((ref) => `${ref.kind}:${ref.id}`));
    const [people, namespaces] = await Promise.all([
      workspacePeople(auth),
      viewerNamespaces(auth),
    ]);
    const inWorkplace = new Set(namespaces);
    const read = async (ref: RecapForwardedProposalRef): Promise<WorkspaceForwardedProposal> => {
      const gone: WorkspaceForwardedProposal = { kind: ref.kind, id: ref.id };
      try {
        if (ref.kind === 'pr') {
          const doc = await deps.gitPullRequestStorage?.get(ref.id);
          if (!doc) return gone;
          const repo = await deps.gitRepoStorage?.get(doc.repoId);
          const roomNamespace = pullRequestRoomNamespaceId(doc);
          if (!inWorkplace.has(roomNamespace) && !(repo && inWorkplace.has(repo.userId))) return gone;
          return {
            ...gone,
            pr: {
              ...describeProposal(doc, repo?.name ?? '(deleted repo)', people, auth.userId),
              // The card never shows the write-up; the proposal's screen does.
              body: null,
              canDecide: proposalOwnedByViewer(auth, doc),
              ...(await checksSummary(deps, doc.repoId, doc.headSha)),
            },
          };
        }
        const doc = await deps.knowledgeProposalStorage?.get(ref.id);
        if (!doc || !inWorkplace.has(doc.userId)) return gone;
        return {
          ...gone,
          knowledge: { ...describeKnowledgeProposal(doc, people, auth.userId), canDecide: proposalOwnedByViewer(auth, doc) },
        };
      } catch {
        return gone;
      }
    };
    const unique = [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()];
    const byKey = new Map((await Promise.all(unique.map(read))).map((entry) => [`${entry.kind}:${entry.id}`, entry]));
    return messages.map((message) => {
      const forwarded = (message.proposals ?? [])
        .filter((ref) => wanted.has(`${ref.kind}:${ref.id}`))
        .map((ref) => byKey.get(`${ref.kind}:${ref.id}`))
        .filter((entry): entry is WorkspaceForwardedProposal => Boolean(entry));
      return forwarded.length ? { ...message, forwarded } : message;
    });
  };
  /** Everything a conversation answer resolves onto its stored rows. */
  const recapMessages = async (auth: MiniAppAuth, messages: RecapChatAnswer['messages']) => (
    withForwardedProposals(auth, await withMailApprovals(auth.userId, messages))
  );
  router.get('/api/recap/chat', async (req, res) => {
    const auth = await authenticate(req, res); if (!auth) return;
    if (!auth.orgId) return res.status(404).json({ error: 'Choose a workplace.' });
    try {
      const answer = await recapChat.read(auth.userId, auth.orgId);
      return res.json({ ...answer, messages: await recapMessages(auth, answer.messages), ...(await recapChatDecor(auth)) } satisfies RecapChatAnswer);
    } catch (error) { return recapChatError(res, error); }
  });
  router.post('/api/recap/chat', async (req, res) => {
    const auth = await authenticate(req, res); if (!auth) return;
    if (!auth.orgId) return res.status(404).json({ error: 'Choose a workplace.' });
    try {
      const answer = await recapChat.send(auth.userId, auth.orgId, req.body?.clientId, req.body?.text);
      return res.status(202).json({ ...answer, messages: await recapMessages(auth, answer.messages), ...(await recapChatDecor(auth)) } satisfies RecapChatAnswer);
    } catch (error) { return recapChatError(res, error); }
  });
  /**
   * A chat file in parts (note #943, `services/chat-file-uploads.ts`): the
   * Drive and note protocol — start, 8 MB parts, complete, cancel — on both
   * chats' doors. A file past one part goes up this way before its message
   * is sent, and the message's envelope then names it by id, so no request
   * carries more than one part and the edge's 100 MB body limit stops being
   * a limit on what a person can send an agent. The Workspace Agent's doors
   * are mounted first, on its reserved id, so that id never reaches the room
   * agents' lookup.
   */
  const mountChatFileUploads = (
    base: string,
    placeFor: (auth: MiniAppAuth, req: Request, res: Response) => ChatFileUploadPlace | null,
  ) => {
    const step = async (req: Request, res: Response, act: (uploads: ChatFileUploads) => Promise<unknown>) => {
      const auth = await authenticate(req, res);
      if (!auth) return;
      if (!deps.mediaStorage) return res.status(503).json({ error: 'Chat file storage is not available right now.' });
      const place = placeFor(auth, req, res);
      if (!place) return;
      try {
        return await act(new ChatFileUploads(deps.mediaStorage, place));
      } catch (error) {
        if (error instanceof ChatFileUploadError) return res.status(error.status).json({ error: error.message });
        console.warn('[chat] a file upload step failed:', error);
        return res.status(503).json({ error: 'The file could not be uploaded just now. Try again.' });
      }
    };
    router.post(base, (req, res) => step(req, res, async (uploads) => (
      res.status(201).json(await uploads.start({ fileName: req.body?.fileName, sizeBytes: req.body?.sizeBytes, contentType: req.body?.contentType }))
    )));
    router.put(
      `${base}/:upload/parts/:part`,
      raw({ type: () => true, limit: UPLOAD_PART_BYTES }),
      (req, res) => step(req, res, async (uploads) => res.json(await uploads.part(String(req.params.upload), {
        uploadId: req.query.upload, fileName: req.query.name, partNumber: req.params.part,
        data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      }))),
    );
    router.post(`${base}/:upload/complete`, (req, res) => step(req, res, async (uploads) => res.json(
      await uploads.complete(String(req.params.upload), { uploadId: req.body?.uploadId, fileName: req.body?.fileName, parts: req.body?.parts }),
    )));
    router.delete(`${base}/:upload`, (req, res) => step(req, res, async (uploads) => {
      await uploads.abort(String(req.params.upload), { uploadId: req.query.upload, fileName: req.query.name });
      return res.json({ ok: true });
    }));
  };
  mountChatFileUploads(`/api/agents/${WORKSPACE_AGENT_CHAT_ID}/chat/uploads`, (auth, _req, res) => {
    const org = auth.orgId;
    if (!org) { res.status(404).json({ error: 'Choose a workplace.' }); return null; }
    return {
      prefix: agentChatStoragePrefix(agentChatStorageOwner(auth.userId, org), `${WORKSPACE_AGENT_CHAT_ID}-${auth.userId}`),
      path: (fileId, fileName) => recapChatFilePath(auth.userId, org, fileId, fileName),
    };
  });
  mountChatFileUploads('/api/agents/:id/chat/uploads', (auth, req, res) => {
    const agent = activeAgent(auth, String(req.params.id ?? ''));
    if (!agent) { res.status(404).json({ error: 'No such agent on this account' }); return null; }
    const owner = agentChatStorageOwner(auth.userId, agent.orgId);
    return {
      prefix: agentChatStoragePrefix(owner, agent.id),
      path: (fileId, fileName) => agentChatAttachmentPath(owner, agent.id, fileId, fileName),
    };
  });

  /**
   * Files with a message to the Workspace Agent (note #423): the room chat's
   * envelope, the room chat's landing — stored beside the row and staged
   * into the agent machine's inbox for the turn. The request id rides a
   * header because the manifest is the room chat's shape.
   */
  router.post(
    '/api/recap/chat/files',
    raw({
      type: () => true,
      limit: AGENT_CHAT_MESSAGE_MAX_BYTES
        + AGENT_CHAT_ATTACHMENT_MANIFEST_MAX_BYTES
        + AGENT_CHAT_ATTACHMENT_ENVELOPE_PREFIX_BYTES,
    }),
    async (req, res) => {
      const auth = await authenticate(req, res); if (!auth) return;
      if (!auth.orgId) return res.status(404).json({ error: 'Choose a workplace.' });
      const parsed = parseChatAttachmentEnvelope(req);
      if ('error' in parsed) return res.status(400).json({ error: parsed.error });
      try {
        const sent = await recapChat.send(auth.userId, auth.orgId, String(req.get('x-recap-client-id') ?? ''), parsed.message, parsed.attachments);
        return res.status(202).json({ ...sent, messages: await recapMessages(auth, sent.messages), ...(await recapChatDecor(auth)) } satisfies RecapChatAnswer);
      } catch (error) { return recapChatError(res, error); }
    },
  );
  /** Stop the running request (note #423): the room chat's Stop, with its honest answer when the turn had already ended. */
  router.post('/api/recap/chat/stop', async (req, res) => {
    const auth = await authenticate(req, res); if (!auth) return;
    if (!auth.orgId) return res.status(404).json({ error: 'Choose a workplace.' });
    try {
      const { stopped } = await recapChat.stop(auth.userId, auth.orgId);
      return res.json({ ok: true, stopped, name: WORKSPACE_AGENT_NAME } satisfies RecapChatStopAnswer);
    } catch (error) { return recapChatError(res, error); }
  });
  /**
   * A file on a Workspace Agent row, by the contract the room chat's rows
   * use (`api/agents/<id>/chat/files/<file>`), on the reserved id the row
   * renderer is given for this conversation. Registered before the room
   * agents' route so the reserved id never reaches its agent lookup.
   */
  router.get(`/api/agents/${WORKSPACE_AGENT_CHAT_ID}/chat/files/:fileId`, async (req, res) => {
    const auth = await authenticate(req, res); if (!auth) return;
    if (!auth.orgId) return res.status(404).json({ error: 'Choose a workplace.' });
    const result = await recapChat.fileAccess(auth.userId, auth.orgId, String(req.params.fileId ?? ''), req.query.preview === '1');
    if (!result) return res.status(404).json({ error: 'That file is no longer on this chat' });
    return res.json(result satisfies WorkspaceChatFileAccessAnswer);
  });

  /** A Markdown file's words on a Workspace Agent row (note #677), by the room chat's contract. */
  router.get(`/api/agents/${WORKSPACE_AGENT_CHAT_ID}/chat/files/:fileId/text`, async (req, res) => {
    const auth = await authenticate(req, res); if (!auth) return;
    if (!auth.orgId) return res.status(404).json({ error: 'Choose a workplace.' });
    const result = await recapChat.fileText(auth.userId, auth.orgId, String(req.params.fileId ?? ''));
    if (!result) return res.status(404).json({ error: 'That file is no longer on this chat' });
    return res.json(result satisfies WorkspaceChatFileTextAnswer);
  });

  router.get('/api/recap', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.orgId || !deps.orgStorage) return res.status(404).json({ error: 'Choose a workplace to read its recap.' });
    const member = await deps.orgStorage.getMembership(auth.orgId, auth.userId);
    if (!member) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    const answer = await recapAnswer({ ...auth, orgId: auth.orgId }, { stamp: true });
    if (!answer) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    return res.json(answer satisfies WorkspaceRecapAnswer);
  });
  /**
   * The recap's button (note #607): the one thing that writes a briefing.
   * The sources are read fresh, past the one-minute cache the card polls, so
   * the words cover the week as it stands at the moment of the press. The
   * answer is the card's own read, which already says it is being written.
   */
  router.post('/api/recap/write', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!auth.orgId || !deps.orgStorage) return res.status(404).json({ error: 'Choose a workplace to write its recap.' });
    const orgId = auth.orgId;
    const reader = { ...auth, orgId };
    const { key, collected, subscriptions, incomplete, member, settings } = await recapMaterial(reader, true);
    if (!member) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    const summarize = deps.agentLifecycle?.summarizeWorkspaceRecap;
    if (!summarize) return res.status(503).json({ error: 'None of your machines can write a recap right now.' });
    // A recap written over a partial read would leave part of the week out
    // without saying so; the one already on the card stays until it recovers.
    if (incomplete) return res.status(503).json({ error: 'Some recent work could not be read, so no recap was written. Try again in a moment.' });
    if (!collected.sources.length) return res.status(409).json({ error: 'Nothing happened in the last seven days to write about.' });
    const org = await deps.orgStorage.getOrg(orgId);
    // What this reader has already been told (note #413). Deliberately absent
    // from the fingerprint: see recapFingerprint.
    const previous = previousRecaps(member.workspaceRecapHistory, member.workspaceRecap);
    recapCoordinator.write({
      key, sources: collected.sources, subscriptions, settings,
      summarize: () => summarize(auth.userId, orgId, buildWorkspaceRecapPrompt(org?.name ?? 'Workspace', collected.sources, subscriptions, previous), settings),
      save: async (recap) => {
        // The log is re-read here, not carried from above: a run takes a
        // minute or more. A reader who predates the log has their standing
        // overview seeded into it.
        const current = await deps.orgStorage!.getMembership(orgId, auth.userId);
        if (!current) return;
        // The workplace's one briefing (note #843), written whole in one
        // touch so the words and their history cannot drift apart. Home
        // receives it; the Workspace Agent reads briefings with `agentbuilt
        // briefing list` when the person asks for them (note #496).
        const history = appendRecapHistory(previousRecaps(current.workspaceRecapHistory, current.workspaceRecap), recap);
        await deps.orgStorage!.touchMember(orgId, auth.userId, { workspaceRecap: recap, workspaceRecapHistory: history });
      },
    });
    const answer = await recapAnswer(reader, { stamp: true });
    if (!answer) return res.status(403).json({ error: 'You no longer belong to this workplace.' });
    return res.status(202).json(answer satisfies WorkspaceRecapAnswer);
  });

  /**
   * Every live note claim the reader can see: the workplace's notes, which
   * all stand at its namespace (note #843). One indexed query, ids and lease
   * metadata only.
   */
  const activeNoteClaims = async (auth: Pick<MiniAppAuth, 'userId' | 'orgId'>) => {
    if (!deps.quickNoteStorage) return [];
    const base = await gitNamespaceFor(auth.userId, auth.orgId);
    return deps.quickNoteStorage.listActiveClaimsByUsers([base.namespaceId], new Date());
  };

  router.get('/api/agents/live', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const scoped = listAgents(auth.profile.telegram)
      .filter((agent) => (
        agent.orgId ? agent.orgId === auth.orgId : auth.orgId === auth.legacyOrgId
      ));
    const live = scoped
      .filter((agent) => deps.agentLifecycle?.isAgentWorking?.(auth.userId, agent.id))
      .map((agent) => ({
        id: agent.id,
        working: true as const,
        ...liveActivityFields(deps.agentLifecycle?.agentActivity?.(auth.userId, agent.id)),
      }));
    // Only stamped summarizer recaps travel here. Legacy task seeds have no
    // live change to announce and already arrive with the full state read.
    const recaps = scoped.flatMap((agent) => agent.recap?.text ? [{
      id: agent.id,
      recap: agent.recap.text,
      ...(agent.recap.at ? { recapAt: agent.recap.at } : {}),
    }] : []);
    // Tiny and record-only like recaps. The important transition here is
    // time-based: when resetAt passes, an already-open details screen should
    // gain Resume without re-reading repos, secrets, proposals and CI.
    const sessionLimits = scoped.flatMap((agent) => {
      const view = sessionLimitFields(agent.sessionLimit).sessionLimit;
      return view ? [{ id: agent.id, ...view }] : [];
    });
    // The plate's count of durable work (note #564), off the same record and
    // costing the same nothing. Without it a count refreshed by the machine
    // read at turn end reaches an open list only on the NEXT full state read
    // — a navigation, a focus, or another turn — which is why a job started
    // in the room you were looking at appeared only once you had opened the
    // agent's chat and come back (note #588).
    const jobs = scoped.flatMap((agent) => ((agent.activeJobs?.count ?? 0) > 0
      ? [{ id: agent.id, count: agent.activeJobs!.count }]
      : []));
    // The finished verdict lands seconds AFTER the turn-end full read
    // (note #707), so it rides the tick, off the same records, the way the
    // recap it is written with does.
    const finished = scoped
      .filter((agent) => agentWorkFinished(agent) && !deps.agentLifecycle?.isAgentWorking?.(auth.userId, agent.id))
      .map((agent) => agent.id);
    // A note is usually claimed moments AFTER the turn has started. The
    // working set therefore does not move again, so the full-state refresh
    // above cannot carry "Working by …" to an already-open Workspace. Claims
    // ride this cheap tick instead: one indexed query returning ids and lease
    // metadata only, never note words, comments or files.
    // Every member's fleet, read once for the two answers below that name
    // agents beyond the reader's own. No person's face is drawn from a tick.
    const tickPeople = peopleFrom(await memberProfiles(auth), new Map(), auth, deps.agentWorkLedger);
    const noteClaims = deps.quickNoteStorage
      ? await (async () => {
        const claims = await activeNoteClaims(auth);
        // Drawn by the SAME describer the full read uses, so a tick with
        // nothing new compares equal to the row it would patch. It used to
        // build its own smaller copy — no face, and a door only on the
        // reader's own agent — which every five seconds took the picture off
        // "Working by …" and the door off a teammate's agent (note #640).
        return claims.map(({ id, claim }) => ({
          id,
          work: describeNoteClaim(claim, tickPeople),
        }));
      })()
      : undefined;
    // Which of the OTHER members' agents are mid-turn (2026-09-23): the dots
    // on a room's teammates strip, and on a teammate's face in the decision
    // queue. Ids only — what a teammate's agent is doing is its owner's to
    // watch — off the same in-memory registry the reader's own rows read,
    // after one profile read per member.
    const workingLookup = deps.agentLifecycle?.isAgentWorking?.bind(deps.agentLifecycle);
    const teamWorking = auth.orgId && workingLookup
      ? tickPeople.teammateAgents()
        .filter(({ ownerUserId, record }) => workingLookup(ownerUserId, record.id))
        .map(({ record }) => record.id)
      : undefined;
    // Whether an admin has asked to delete this workplace (2026-09-22), so a
    // member's open Workspace turns into the lock screen — and back, when an
    // admin keeps it — within a tick, not at their next reload.
    const workplace = auth.orgId && deps.orgStorage ? await deps.orgStorage.getOrg(auth.orgId).catch(() => null) : null;
    res.json({
      agents: live, recaps, sessionLimits, jobs, finished,
      ...(auth.orgId && deps.agentLifecycle?.workspaceSeatIdsInUse
        ? { activeSeatIds: deps.agentLifecycle.workspaceSeatIdsInUse(auth.userId, auth.orgId) }
        : {}),
      ...(noteClaims ? { noteClaims } : {}),
      ...(teamWorking ? { teamWorking } : {}),
      ...(workplace ? { workplaceDeleting: Boolean(workplace.deletion) } : {}),
    } satisfies WorkspaceAgentsLiveAnswer);
  });

  /**
   * Dictation for every prose field in the Workspace. The request body is the
   * recording itself — no multipart or base64 expansion — and identity comes
   * from the same browser session as every other Workspace write.
   *
   * Exact-value fields (secrets, OAuth codes and destructive confirmations)
   * never call this route: speech recognition is deliberately not allowed to
   * turn a near-match into a credential or a deletion confirmation.
   */
  router.post(
    '/api/transcribe',
    raw({ type: () => true, limit: SESSION_ATTACHMENT_MAX_BYTES + 1024 }),
    async (req, res) => {
      const auth = await authenticate(req, res);
      if (!auth) return;
      if (!deps.voiceTranscriptionService) {
        return res.status(503).json({ error: 'Voice-to-text is unavailable right now.' });
      }

      const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const contentType = String(req.get('content-type') ?? '')
        .split(';', 1)[0]!
        .trim()
        .toLowerCase();
      try {
        const result = await deps.voiceTranscriptionService.transcribe({
          userId: auth.userId,
          audio,
          contentType,
          fileName: 'workspace-recording',
        });
        return res.json({ text: result.text });
      } catch (error) {
        if (error instanceof VoiceTranscriptionError && error.code === 'invalid_audio') {
          return res.status(400).json({ error: error.message });
        }
        if (error instanceof VoiceTranscriptionError && error.code === 'not_configured') {
          return res.status(503).json({ error: 'Voice-to-text is unavailable right now.' });
        }
        return res.status(502).json({ error: 'That recording could not be transcribed. Please try again.' });
      }
    },
  );

  /**
   * Publish or withdraw a repository. This is a HUMAN, admin-only decision:
   * agents may prepare the LICENSE and the source, but cannot expose workplace
   * code by calling their own API. Anonymous access is read-only in both the
   * browser routes above and the git host's verify path.
   */
  router.post('/api/repos/:name/public-access', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitRepoStorage || !deps.gitHostClient) {
      return res.status(503).json({ error: 'Repository hosting is not available on this backend yet' });
    }
    if (typeof req.body?.public !== 'boolean') {
      return res.status(400).json({ error: 'Choose whether this repository is public.' });
    }
    const ns = await viewerNamespaceFor(auth, req, res);
    if (!ns) return;
    const repo = await workplaceRepo(auth, ns, String(req.params.name ?? ''));
    if (!repo) return res.status(404).json({ error: 'No such repository here', code: NO_SUCH_REPOSITORY });
    if (ns.orgId && ns.role !== 'admin') {
      return res.status(403).json({ error: 'Only a workplace admin can make shared source public or private.' });
    }

    if (!req.body.public) {
      if (repo.publicAccess) await deps.gitRepoStorage.update(repo.id, { publicAccess: undefined });
      return res.json({ public: false } satisfies WorkspaceRepoPublicAccessAnswer);
    }
    if (repo.publicAccess) {
      return res.json({
        public: true,
        publicUrl: await publicRepoUrlFor(repo),
        publishedAt: repo.publicAccess.publishedAt,
      } satisfies WorkspaceRepoPublicAccessAnswer);
    }

    // Visibility is not a licence. Requiring a conventional root licence
    // file prevents the UI from calling source "open" while every visitor is
    // legally left with no permission to use, copy or modify it.
    let root: WorkspaceRepoTreeAnswer;
    try {
      root = await (await gitHostFor(repo.orgId)).tree(repo.userId, repo.name, '');
    } catch {
      return res.status(502).json({ error: 'The repository host did not answer. Nothing was made public.' });
    }
    const license = root.entries.find((entry) => (
      entry.type === 'file'
      && (entry.sizeBytes ?? 0) > 0
      && /^(?:licen[cs]e|copying)(?:\.(?:md|txt|rst))?$/i.test(entry.name)
    ));
    if (!root.branch || !license) {
      return res.status(409).json({
        error: 'Add a non-empty LICENSE file to the repository root before making it public.',
      });
    }

    // UUIDs are already collision-resistant; the read makes that property an
    // enforced product invariant in the in-memory store as well as SQLite's
    // unique index.
    let id = randomUUID();
    while (await deps.gitRepoStorage.getPublicById(id)) id = randomUUID();
    const publishedAt = new Date().toISOString();
    const updated = await deps.gitRepoStorage.update(repo.id, {
      publicAccess: { id, publishedAt, publishedByUserId: auth.userId },
    });
    if (!updated) return res.status(409).json({ error: 'The repository changed. Nothing was made public.' });
    return res.json({
      public: true,
      publicUrl: await publicRepoUrlFor({ ...repo, publicAccess: { id, publishedAt, publishedByUserId: auth.userId } }),
      publishedAt,
    } satisfies WorkspaceRepoPublicAccessAnswer);
  });

  /**
   * Deleting a repository. It belongs to the workplace (note #566), so this
   * is the same act whichever room's screen it is opened from, and it is the
   * only repository deletion in the product (docs/agent-git-project-repos.md slice 5). No agent-reachable
   * route removes a repo and no chat card does either: an agent's `repo
   * delete` records an ask, and the owner acts here, on a screen that can
   * show what is actually at stake — the history, the size, the proposals
   * still waiting — which a card cannot.
   *
   * A repo with no ask on it deletes just the same: this is the owner's own
   * workspace, and needing an agent to ask first would be a strange thing to
   * require of the person who owns the bytes.
   */
  router.delete('/api/repos/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitRepoStorage || !deps.gitHostClient) {
      return res.status(503).json({ error: 'Repository hosting is not available on this backend yet' });
    }
    const name = String(req.params.name ?? '');
    const ns = await viewerNamespaceFor(auth, req, res);
    if (!ns) return;
    const repo = await workplaceRepo(auth, ns, name);
    if (!repo) {
      return res.status(404).json({ error: 'No such repository here', code: NO_SUCH_REPOSITORY });
    }
    // Destruction on shared ground is an admin verb: everyone in the org works
    // in this repo, so the role that owns the org's spend decides what is
    // destroyed. A personal namespace has no org and no gate.
    if (ns.orgId && ns.role !== 'admin') {
      return res.status(403).json({ error: 'Only a workplace admin can delete a shared repository.' });
    }
    // Read before the delete clears it: the agent that asked is who gets told.
    const asked = repo.deleteAsk;
    if (asked && !agentRequestOwnedByViewer(auth, asked)) {
      return res.status(403).json({ error: 'Only the owner of the agent that asked can decide this deletion.' });
    }
    let result;
    try {
      // No agent id on the record: the owner did this one with their own thumb.
      result = await deleteRepoNow(repo, null, {
        repos: deps.gitRepoStorage,
        host: await gitHostFor(repo.orgId),
        ...(deps.gitPullRequestStorage ? { prs: deps.gitPullRequestStorage } : {}),
      });
    } catch {
      return res.status(502).json({ error: 'The git host did not answer — nothing was deleted. Try again in a minute.' });
    }
    if (asked) {
      // Best-effort, and after the fact: the delete has happened, and an
      // agent that cannot be woken must not turn it into an error on screen.
      // The asking agent's own owner is the only possible decider.
      await deps.notifyRepoDeleteDecision?.({
        userId: asked.byUserId ?? auth.userId,
        agentId: asked.byAgentId,
        repoName: name,
        decision: 'deleted',
        restorableUntil: result.restorableUntil,
        withdrawnPrs: result.withdrawnPrs,
      }).catch(() => { /* the repo is gone either way */ });
    }
    return res.json({ ok: true, name, ...result });
  });

  /**
   * "Keep it" — the other half of an agent's delete ask. Clears the flag and
   * tells the agent, so a declined ask ends in words instead of the agent
   * asking again next turn.
   */
  router.post('/api/repos/:name/keep', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitRepoStorage) {
      return res.status(503).json({ error: 'Repository hosting is not available on this backend yet' });
    }
    const name = String(req.params.name ?? '');
    const ns = await viewerNamespaceFor(auth, req, res);
    if (!ns) return;
    const repo = await workplaceRepo(auth, ns, name);
    if (!repo) {
      return res.status(404).json({ error: 'No such repository here', code: NO_SUCH_REPOSITORY });
    }
    const asked = repo.deleteAsk;
    if (!asked) {
      // Nothing pending: answer the state rather than an error, so two taps
      // on a slow connection do not produce a scary message.
      return res.json({ ok: true, name });
    }
    if (ns.orgId && ns.role !== 'admin') {
      return res.status(403).json({ error: 'Only a workplace admin can answer a delete ask on a shared repository.' });
    }
    if (!agentRequestOwnedByViewer(auth, asked)) {
      return res.status(403).json({ error: 'Only the owner of the agent that asked can decide this deletion.' });
    }
    await deps.gitRepoStorage.update(repo.id, { deleteAsk: undefined });
    await deps.notifyRepoDeleteDecision?.({
      userId: asked.byUserId ?? auth.userId,
      agentId: asked.byAgentId,
      repoName: name,
      decision: 'kept',
    }).catch(() => { /* the flag is cleared either way */ });
    return res.json({ ok: true, name });
  });

  /**
   * What each site costs to keep up (note #993): its machine as Fly reports
   * it and every disk its app holds, priced by the spend view's own table
   * (`site-costs.ts`). Every member reads it, as every member reads the
   * Sites screen: these are list-price estimates of the shape of a machine,
   * not the invoice, which stays admin-only in the spend view. Read on
   * demand, never in `api/state`: it is a walk of the cloud account, and the
   * state read is what every screen waits on.
   */
  let siteCostReader: SiteCostReader | null = null;
  const siteCostsReader = () => {
    if (!deps.deploymentService) return null;
    siteCostReader ??= new SiteCostReader({ read: (doc) => deps.deploymentService!.readInfrastructure(doc) });
    return siteCostReader;
  };
  router.get('/api/sites/costs', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const siteCosts = siteCostsReader();
    if (!deps.deploymentStorage || !siteCosts) {
      return res.status(503).json({ error: 'Hosting is not available on this backend yet' });
    }
    const costsNs = await viewerNamespaceFor(auth, req, res);
    if (!costsNs) return;
    const docs = auth.orgId
      ? await deps.deploymentStorage.listByOrg(auth.orgId)
      : await deps.deploymentStorage.listByUser(auth.userId);
    const org = auth.orgId ? await deps.orgStorage?.getOrg(auth.orgId).catch(() => null) : null;
    const answer: WorkspaceSiteCostsAnswer = await siteCosts.forSites(docs, org ? isHostedWorkplace(org) : false);
    return res.json(answer);
  });

  /**
   * Taking a site down — and, like a repository, this is the ONLY place in
   * the product that can. An agent's `agentbuilt delete` records an ask and
   * stops there; the owner acts here, where the screen can show the address,
   * who deployed it and what it is serving.
   *
   * Why it exists at all: when hosting rode plan allowances (2026-08-16 to
   * the org pivot), nothing could hand a slot back — a customer's throwaway
   * first deploy took one of their two for good. The allowances are gone;
   * the verb stays, because taking a site down is still the user's call.
   *
   * What it keeps is the NAME. `destroy` leaves the record as a tombstone and
   * the deploy path reads it, so the address stays reserved to this account:
   * the owner can redeploy to it, and nobody else can ever pick it up and
   * inherit the links they handed out. What it does not keep is content —
   * there is no trash and no restore window, because a site's files are one
   * redeploy away and pretending otherwise would promise a way back that this
   * product does not have.
   */
  router.delete('/api/sites/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.deploymentStorage || !deps.deploymentService) {
      return res.status(503).json({ error: 'Hosting is not available on this backend yet' });
    }
    const name = String(req.params.name ?? '');
    const siteNs = await viewerNamespaceFor(auth, req, res);
    if (!siteNs) return;
    const doc = await deps.deploymentStorage.getByName(name);
    // The workplace's site, whichever room's screen this is (note #566).
    const belongsHere = auth.orgId ? doc?.orgId === auth.orgId : doc?.userId === auth.userId;
    if (!doc || !belongsHere || doc.status === 'destroyed') {
      return res.status(404).json({ error: 'No such site on this account' });
    }
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Only a workplace admin can take down shared infrastructure.' });
    }
    if (doc.deleteAsk && !agentRequestOwnedByViewer(auth, doc.deleteAsk)) {
      return res.status(403).json({ error: 'Only the owner of the agent that asked can decide this deletion.' });
    }
    // Read before the destroy: the agent that asked is who gets told.
    const askedBy = doc.deleteAsk?.byAgentId;
    try {
      await deps.deploymentService.destroy(doc.id);
    } catch {
      return res.status(502).json({
        error: 'The host did not answer — nothing was deleted. Try again in a minute.',
      });
    }
    if (askedBy) {
      // Best-effort and after the fact: the site is down either way, and an
      // agent that cannot be woken must not turn that into an error on screen.
      await deps.notifySiteDeleteDecision?.({
        userId: doc.deleteAsk?.byUserId ?? auth.userId,
        agentId: askedBy,
        siteName: doc.name,
        decision: 'deleted',
      }).catch(() => { /* the site is gone either way */ });
    }
    return res.json({ ok: true, name: doc.name });
  });

  /**
   * "Keep it" — the other half of an agent's ask, exactly as for a repo:
   * clears the flag and tells the agent, so a declined ask ends in words
   * rather than the agent asking again next turn.
   */
  /**
   * The owner's decision on a bucket (note #768): the one surface in the
   * product that removes one. Empties it, removes the add-on and its four
   * secrets. Admin, and the owner of the asking agent when an agent asked.
   */
  router.delete('/api/storage/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.objectStorage) {
      return res.status(503).json({ error: 'Object storage is not available on this backend yet' });
    }
    const name = String(req.params.name ?? '');
    const doc = await deps.objectStorage.getLive({ orgId: auth.orgId, userId: auth.userId }, name);
    if (!doc) return res.status(404).json({ error: 'No such bucket in this workplace' });
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Only a workplace admin can take down shared infrastructure.' });
    }
    if (doc.deleteAsk && !agentRequestOwnedByViewer(auth, doc.deleteAsk)) {
      return res.status(403).json({ error: 'Only the owner of the agent that asked can decide this deletion.' });
    }
    const askedBy = doc.deleteAsk?.byAgentId;
    try {
      await deps.objectStorage.destroy(doc.id);
    } catch {
      return res.status(502).json({ error: 'The cloud did not answer — nothing was deleted. Try again in a minute.' });
    }
    if (askedBy) {
      await deps.notifyStorageDeleteDecision?.({
        userId: doc.deleteAsk?.byUserId ?? auth.userId,
        agentId: askedBy,
        bucketName: doc.name,
        decision: 'deleted',
      }).catch(() => { /* the bucket is gone either way */ });
    }
    return res.json({ ok: true, name: doc.name } satisfies WorkspaceBucketNamedAnswer);
  });

  /**
   * What one bucket holds (note #778), for its page: read on demand with the
   * bucket's own keys rather than on every state read, because it walks the
   * bucket's listing. Any member — the list itself is every member's — and
   * the answer is numbers only.
   */
  router.get('/api/storage/:name/usage', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.objectStorage) {
      return res.status(503).json({ error: 'Object storage is not available on this backend yet' });
    }
    const doc = await deps.objectStorage.getLive({ orgId: auth.orgId, userId: auth.userId }, String(req.params.name ?? ''));
    if (!doc) return res.status(404).json({ error: 'No such bucket in this workplace' });
    const usage = await deps.objectStorage.usage(doc).catch(() => null);
    return res.json((usage ? { usage } : {}) satisfies WorkspaceBucketUsageAnswer);
  });

  router.post('/api/storage/:name/keep', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.objectStorage) {
      return res.status(503).json({ error: 'Object storage is not available on this backend yet' });
    }
    const name = String(req.params.name ?? '');
    const doc = await deps.objectStorage.getLive({ orgId: auth.orgId, userId: auth.userId }, name);
    if (!doc) return res.status(404).json({ error: 'No such bucket in this workplace' });
    const askedBy = doc.deleteAsk?.byAgentId;
    if (!askedBy) return res.json({ ok: true, name: doc.name } satisfies WorkspaceBucketNamedAnswer);
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Only a workplace admin can answer a deletion request.' });
    }
    if (doc.deleteAsk && !agentRequestOwnedByViewer(auth, doc.deleteAsk)) {
      return res.status(403).json({ error: 'Only the owner of the agent that asked can decide this deletion.' });
    }
    await deps.objectStorage.keep(doc.id);
    await deps.notifyStorageDeleteDecision?.({
      userId: doc.deleteAsk?.byUserId ?? auth.userId,
      agentId: askedBy,
      bucketName: doc.name,
      decision: 'kept',
    }).catch(() => undefined);
    return res.json({ ok: true, name: doc.name } satisfies WorkspaceBucketNamedAnswer);
  });

  router.post('/api/sites/:name/keep', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.deploymentStorage) {
      return res.status(503).json({ error: 'Hosting is not available on this backend yet' });
    }
    const name = String(req.params.name ?? '');
    const keepNs = await viewerNamespaceFor(auth, req, res);
    if (!keepNs) return;
    const doc = await deps.deploymentStorage.getByName(name);
    const belongsHere = auth.orgId ? doc?.orgId === auth.orgId : doc?.userId === auth.userId;
    if (!doc || !belongsHere || doc.status === 'destroyed') {
      return res.status(404).json({ error: 'No such site on this account' });
    }
    const askedBy = doc.deleteAsk?.byAgentId;
    if (!askedBy) {
      // Nothing pending: answer the state rather than an error, so two taps on
      // a slow connection do not produce a scary message.
      return res.json({ ok: true, name: doc.name });
    }
    if (auth.orgId && auth.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Only a workplace admin can answer a deletion request.' });
    }
    if (doc.deleteAsk && !agentRequestOwnedByViewer(auth, doc.deleteAsk)) {
      return res.status(403).json({ error: 'Only the owner of the agent that asked can decide this deletion.' });
    }
    await deps.deploymentStorage.update(doc.id, { deleteAsk: undefined });
    await deps.notifySiteDeleteDecision?.({
      userId: doc.deleteAsk?.byUserId ?? auth.userId,
      agentId: askedBy,
      siteName: doc.name,
      decision: 'kept',
    }).catch(() => { /* the flag is cleared either way */ });
    return res.json({ ok: true, name: doc.name });
  });

  /**
   * The repository explorer. Both routes browse the DEFAULT branch only —
   * what a `git clone` lands on, `main` on every protected repo — so a user
   * sees the repo as its agents left it, with no ref-picking to reason about.
   *
   * A repo name in the URL is trusted only after `getByName` proves it is the
   * caller's own; the git host is namespaced by userId besides, so a guessed
   * name never reaches another account's bytes.
   */
  router.get('/api/repos/:name/tree', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitRepoStorage || !deps.gitHostClient) {
      return res.status(503).json({ error: 'Repository hosting is not available on this backend yet' });
    }
    const name = String(req.params.name ?? '');
    const repo = await namespacedRepo(auth, req, name, res);
    if (!repo) return;
    const rawPath = (req.query as Record<string, unknown>).path;
    const treePath = typeof rawPath === 'string' ? rawPath : '';
    try {
      const tree = await (await gitHostFor(repo.orgId)).tree(repo.userId, name, treePath);
      return res.json(tree satisfies WorkspaceRepoTreeAnswer);
    } catch {
      return res.status(404).json({ error: 'No such folder in this repository' });
    }
  });

  router.get('/api/repos/:name/file', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitRepoStorage || !deps.gitHostClient) {
      return res.status(503).json({ error: 'Repository hosting is not available on this backend yet' });
    }
    const name = String(req.params.name ?? '');
    const repo = await namespacedRepo(auth, req, name, res);
    if (!repo) return;
    const rawPath = (req.query as Record<string, unknown>).path;
    const filePath = typeof rawPath === 'string' ? rawPath : '';
    if (!filePath) {
      return res.status(400).json({ error: 'Which file? Pass ?path=' });
    }
    try {
      const file = await (await gitHostFor(repo.orgId)).file(repo.userId, name, filePath);
      return res.json(file satisfies WorkspaceRepoFileAnswer);
    } catch {
      return res.status(404).json({ error: 'No such file in this repository' });
    }
  });

  /**
   * Every proposal ever made on one repository, newest first — the decided
   * ones included, which is the whole point: home carries only the open
   * queue, so before this the merged and rejected ones were reachable only
   * from whatever chat card happened to still be scrolled to. A repository's
   * own screen is where its history belongs, next to its commits.
   *
   * Checks ride along for the pip, in ONE lookup for every head sha rather
   * than one per proposal — the same join the commits route does.
   */
  router.get('/api/repos/:name/prs', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitRepoStorage || !deps.gitPullRequestStorage) {
      return res.status(503).json({ error: 'Change proposals are not available on this backend yet' });
    }
    const name = String(req.params.name ?? '');
    const repo = await namespacedRepo(auth, req, name, res);
    if (!repo) return;
    const docs = await deps.gitPullRequestStorage.listByRepo(repo.id);
    const statuses = deps.gitCommitStatusStorage
      ? await deps.gitCommitStatusStorage.listByShas(repo.id, docs.map((doc) => doc.headSha))
      : [];
    const now = new Date();
    const bySha = new Map<string, GitCommitStatusDocument[]>();
    for (const status of statuses) {
      bySha.set(status.sha, [...(bySha.get(status.sha) ?? []), status]);
    }
    const people = await workspacePeople(auth);
    const prs = docs
      .slice()
      // Newest first — the reverse of the CLI's listing, because a screen is
      // read from the top and the interesting proposal is the recent one.
      .sort((a, b) => b.number - a.number)
      .map((doc) => ({
        ...describeProposal(doc, repo.name, people, auth.userId),
        ...checksPip(bySha.get(doc.headSha) ?? [], now),
      }));
    return res.json({ prs });
  });

  /**
   * The repository's recent CI runs, newest first, whatever commit each ran
   * against. The commit rows already carry their own checks one by one; this
   * is the one list that answers "what has CI been doing here lately" without
   * walking the history — and it carries the sha so a run can be traced back
   * to its landing.
   */
  router.get('/api/repos/:name/checks', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitRepoStorage || !deps.gitCommitStatusStorage) {
      return res.status(503).json({ error: 'CI statuses are not available on this backend yet' });
    }
    const checkNs = await viewerNamespaceFor(auth, req, res);
    if (!checkNs) return;
    const repo = await workplaceRepo(auth, checkNs, String(req.params.name ?? ''));
    if (!repo) {
      return res.status(404).json({ error: 'No such repository here', code: NO_SUCH_REPOSITORY });
    }
    const docs = await deps.gitCommitStatusStorage.listRecentByRepo(repo.id, CHECK_RUNS_LIMIT);
    const now = new Date();
    return res.json({
      runs: docs.map((doc) => ({ ...describeCheck(doc, now), sha: doc.sha })),
    } satisfies WorkspaceRepoChecksAnswer);
  });

  /**
   * What has HAPPENED in a repository, which the explorer cannot say: the
   * default branch's recent commits. The host clamps the count; anything
   * unparseable in `?limit=` is simply not passed on, so a junk query gets
   * the default rather than an error the screen would have to render.
   */
  /**
   * Who has written this repository: every contributor, with the numbers.
   *
   * Its own fetch rather than a field on home's state, because home carries
   * five repositories and wants three faces from each, while this screen
   * wants everybody and their line counts — and the two would otherwise be
   * the same payload sized for the bigger one.
   *
   * It also BACKFILLS. The totals are normally refreshed by the push report,
   * so a repository nobody has pushed to since this shipped has none at all;
   * opening its screen counts them once, and the row on home has faces from
   * then on. Same incremental call the push report makes, so a repository
   * already counted pays a `git log` over nothing.
   */
  router.get('/api/repos/:name/contributors', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitRepoStorage || !deps.gitHostClient) {
      return res.status(503).json({ error: 'Repository hosting is not available on this backend yet' });
    }
    const name = String(req.params.name ?? '');
    const repo = await namespacedRepo(auth, req, name, res);
    if (!repo) return;
    let stored = repo.contributors;
    try {
      const counted = await (await gitHostFor(repo.orgId)).contributors(repo.userId, name, stored?.sha);
      const contributors = nextContributors(stored, counted, new Date().toISOString());
      if (contributors) {
        stored = contributors;
        await deps.gitRepoStorage.update(repo.id, { contributors });
      }
    } catch {
      // The host is unreachable or the branch is gone: show what was counted
      // last rather than an error over a list that is only ever a summary.
    }
    return res.json({
      contributors: describeContributors(stored, (await workspacePeople(auth)).everyAgent()),
      ...(stored?.countedAt ? { countedAt: stored.countedAt } : {}),
    } satisfies WorkspaceRepoContributorsAnswer);
  });

  router.get('/api/repos/:name/commits', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitRepoStorage || !deps.gitHostClient) {
      return res.status(503).json({ error: 'Repository hosting is not available on this backend yet' });
    }
    const name = String(req.params.name ?? '');
    const repo = await namespacedRepo(auth, req, name, res);
    if (!repo) return;
    const rawLimit = Number((req.query as Record<string, unknown>).limit);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
    try {
      const log = await (await gitHostFor(repo.orgId)).log(repo.userId, name, limit);
      // Decorate each commit with its checks summary — this screen is where
      // default-branch CI (deploys have no proposal to hang from) shows at
      // all. One listByShas, then a join in memory.
      if (deps.gitCommitStatusStorage && Array.isArray((log as { commits?: unknown }).commits)) {
        const commits = (log as { commits: Array<{ sha?: string }> }).commits;
        const shas = commits.map((c) => String(c.sha ?? '')).filter(Boolean);
        const statuses = await deps.gitCommitStatusStorage.listByShas(repo.id, shas);
        const now = new Date();
        const bySha = new Map<string, ReturnType<typeof describeCheck>[]>();
        for (const doc of statuses) {
          const list = bySha.get(doc.sha) ?? [];
          list.push(describeCheck(doc, now));
          bySha.set(doc.sha, list);
        }
        for (const commit of commits) {
          const checks = bySha.get(String(commit.sha ?? ''));
          if (checks) (commit as Record<string, unknown>).checks = checks;
        }
      }
      return res.json(log);
    } catch {
      return res.status(502).json({ error: 'Could not read this repository’s history' });
    }
  });

  /**
   * ONE commit and what it changed — the screen behind a commit row, in the
   * history and in a proposal's commit list alike.
   *
   * The sha is validated HERE as well as on the host: this route trusts a
   * repository name only after `getByName` says it is the caller's, and it
   * gives the same treatment to the other thing the client chose. A commit
   * that is not in this repository simply is not found.
   */
  router.get('/api/repos/:name/commit/:sha', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitRepoStorage || !deps.gitHostClient) {
      return res.status(503).json({ error: 'Repository hosting is not available on this backend yet' });
    }
    const checkNs = await viewerNamespaceFor(auth, req, res);
    if (!checkNs) return;
    const repo = await workplaceRepo(auth, checkNs, String(req.params.name ?? ''));
    if (!repo) {
      return res.status(404).json({ error: 'No such repository here', code: NO_SUCH_REPOSITORY });
    }
    const sha = String(req.params.sha ?? '');
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      return res.status(400).json({ error: 'That is not a commit id' });
    }
    try {
      const commit = await (await gitHostFor(repo.orgId)).commit(repo.userId, repo.name, sha);
      // The checks filed against this landing, if CI has spoken for it — the
      // same summary the history rows carry, so the screen agrees with the
      // row that opened it.
      const statuses = deps.gitCommitStatusStorage
        ? await deps.gitCommitStatusStorage.listBySha(repo.id, commit.sha)
        : [];
      const now = new Date();
      return res.json({
        ...commit, checks: statuses.map((doc) => describeCheck(doc, now)),
      } satisfies WorkspaceRepoCommitAnswer);
    } catch {
      return res.status(404).json({ error: 'That commit is not in this repository' });
    }
  });

  /**
   * A proposal's own screen: the frozen header plus a compare — patch,
   * commits, stats.
   *
   * While it is OPEN that compare is LIVE (target branch → source branch):
   * the user decides on what the branch is NOW, which is exactly what an
   * approval would merge (the merge re-checks the head sha besides).
   *
   * Once it is DECIDED the same live compare answers a question nobody is
   * asking any more, and after a merge it answers "nothing" — the source is
   * an ancestor of the target, so the merge base IS the head and the diff is
   * empty. A decided proposal is a record of what happened, so it compares
   * its own frozen shas instead: baseSha → headSha, the diff the user was
   * shown when they decided. Both survive the merge — nothing here deletes
   * branches, and the head stays reachable from the target either way. A
   * proposal made before the target branch existed has no baseSha; the empty
   * tree is its base, which is precisely what the host falls back to for a
   * base that names no commit.
   *
   * The compare can legitimately fail (branch deleted, repo rewound); the
   * proposal is still real, so answer with the frozen half and say why the
   * diff is missing rather than 404ing the whole screen.
   */
  router.get('/api/prs/:id', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitPullRequestStorage || !deps.gitRepoStorage || !deps.gitHostClient) {
      return res.status(503).json({ error: 'Change proposals are not available on this backend yet' });
    }
    const doc = await deps.gitPullRequestStorage.get(String(req.params.id ?? ''));
    if (!doc || !(await viewerNamespaces(auth)).includes(doc.userId)) {
      return res.status(404).json({ error: 'No such proposal on this account' });
    }
    const repo = await deps.gitRepoStorage.get(doc.repoId);
    if (!repo) {
      return res.status(404).json({ error: 'The repository this proposal belongs to no longer exists' });
    }
    // The git host's compare is the slowest thing this answer waits on
    // (110–230 ms measured from production for a 12–26 file proposal), and
    // nothing before it depends on it — so it starts NOW and runs while the
    // people, the notes, the pictures and the checks are read, instead of
    // after all of them (follow-up to note #825). Settled into a value so an
    // early failure is not an unhandled rejection while the rest is read.
    const timing = { started: Date.now(), compare: 0, rest: 0 };
    const [base, head] = doc.status === 'open'
      ? [doc.targetBranch, doc.sourceBranch]
      : [doc.baseSha ?? EMPTY_TREE_SHA, doc.headSha];
    const comparing = gitHostFor(repo.orgId)
      .then((host) => host.compare(repo.userId, repo.name, base, head))
      .then((comparison) => ({ comparison, error: null as unknown }), (error: unknown) => ({ comparison: null, error }))
      .finally(() => { timing.compare = Date.now() - timing.started; });
    const people = await workspacePeople(auth);
    // The notes this proposal implements, NAMED (note #206): the screen draws
    // a door to each under the write-up, and a door is worth its title — the
    // ask itself, not a bare number. Looked up in the namespace the numbers
    // were recorded against; a note since deleted keeps its numbered row and
    // simply goes untitled.
    const quickNotes: { number: number; title?: string }[] = [];
    if (deps.quickNoteStorage) {
      const noteNamespaceId = doc.quickNoteNamespaceId
        ?? pullRequestRoomNamespaceId(doc);
      for (const number of pullRequestQuickNoteNumbers(doc)) {
        const note = await deps.quickNoteStorage.getByNumber(noteNamespaceId, number);
        quickNotes.push({ number, ...(note ? { title: quickNoteTitle(note.html) } : {}) });
      }
    }
    const described = describeProposal(doc, repo.name, people, auth.userId);
    // Note #825: a picture's shape and the signed URL to draw it from ride
    // the answer itself. Measured on a phone, the sheet's pictures used to
    // wait for the words, then for one more round trip per picture to mint
    // a URL, and drew as flat grey blocks of no particular shape until the
    // bytes landed; with this, every picture starts downloading the moment
    // the words are in, into a frame already the right shape. The URL is the
    // cached one, stable for most of its life and signed cacheable, so a
    // sheet reopened within it draws from the browser's own cache.
    const attachments = described.attachments && deps.mediaStorage
      ? await Promise.all(described.attachments.map(async (file) => {
        const stored = (doc.attachments ?? []).find((a) => a.id === file.id);
        if (!stored || !drawsAsPicture(file)) return file;
        const [size, access] = await Promise.all([
          proposalPictureShape(doc, stored),
          pictureAccess(stored.storagePath, true),
        ]);
        return { ...file, ...(size ?? {}), ...(access ? { preview: access } : {}) };
      }))
      : described.attachments;
    const pr = {
      ...described,
      ...(attachments ? { attachments } : {}),
      ...(quickNotes.length ? { quickNotes } : {}),
      // Nobody decides a quiet proposal — not even its owner (note #293).
      canDecide: proposalOwnedByViewer(auth, doc) && !doc.draft,
      // The margin, whole (note #66), beside the diff it is about.
      comments: (doc.comments ?? []).map((comment) => describeMarginComment(comment, people, auth.userId)),
    };
    // Whether this repo requires green checks before an approval is honoured
    // — the decide card wires its button off this.
    const requireChecks = repo.requireChecks === true;
    // Checks are looked up by the PINNED headSha — the sha the user would be
    // approving — never by the branch's current tip.
    const checkDocs = deps.gitCommitStatusStorage
      ? await deps.gitCommitStatusStorage.listBySha(doc.repoId, doc.headSha)
      : [];
    const now = new Date();
    const checks = checkDocs.map((check) => describeCheck(check, now));
    const deliverySha = doc.status === 'merged' ? (doc.mergeCommitSha ?? doc.headSha) : null;
    const deliveryDocs = deliverySha && deps.gitCommitStatusStorage
      ? (deliverySha === doc.headSha
        ? checkDocs
        : await deps.gitCommitStatusStorage.listBySha(doc.repoId, deliverySha))
      : [];
    const delivery = describeProposalDelivery(doc, deliveryDocs, now, repo.ci === true);
    timing.rest = Date.now() - timing.started;
    const compared = await comparing;
    // Where this answer's time went, for the browser's own network panel and
    // for the log when it was slow — a phone's "proposals feel slow" is then
    // a number on the server, not a guess.
    const total = Date.now() - timing.started;
    res.setHeader('Server-Timing', `rest;dur=${timing.rest}, compare;dur=${timing.compare}, total;dur=${total}`);
    if (total > SLOW_PROPOSAL_READ_MS) {
      console.log(`[prs] detail ${doc.id} took ${total} ms (reads ${timing.rest} ms, compare ${timing.compare} ms, in parallel)`);
    }
    try {
      if (!compared.comparison) throw compared.error;
      const comparison = compared.comparison;
      return res.json({
        pr,
        checks,
        patch: comparison.patch,
        patchTruncated: comparison.patchTruncated,
        // Subject AND sha: the host has always sent both and this route used
        // to drop the sha, which is the half a reader takes to a terminal.
        // The date rides along so each row can say how long ago it landed; a
        // host that predates the field simply sends none, and the row omits it.
        commits: comparison.commits.map((commit) => ({
          sha: commit.sha,
          subject: commit.subject,
          ...(commit.at ? { at: commit.at } : {}),
        })),
        diffStat: comparison.diffStat,
        // The sha THIS response's diff describes. An approval sends it back,
        // so what merges is exactly what was on the screen — never whatever
        // the branch became while the user was reading.
        headSha: comparison.headSha,
        requireChecks,
        ci: repo.ci === true,
        ...(delivery ? { delivery } : {}),
      } satisfies WorkspaceProposalDetailAnswer);
    } catch (error) {
      return res.json({
        pr,
        checks,
        patch: null,
        patchTruncated: false,
        // The frozen half of the record: subjects only — the shas of a compare
        // that just failed are exactly what this branch does not have.
        commits: doc.commitSubjects.map((subject) => ({ subject })),
        diffStat: doc.diffStat,
        headSha: doc.headSha,
        requireChecks,
        ci: repo.ci === true,
        ...(delivery ? { delivery } : {}),
        compareError: error instanceof Error ? error.message : String(error),
      } satisfies WorkspaceProposalDetailAnswer);
    }
  });

  /**
   * The changing half of a decided proposal, without re-running its git
   * compare every five seconds. Main-branch actions can be serial and several
   * minutes long; polling the full proposal route for that whole delivery
   * would repeatedly ask the git host to rebuild a frozen diff that cannot
   * change. This route reads one proposal document and one sha's statuses.
   */
  router.get('/api/prs/:id/delivery', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitPullRequestStorage) {
      return res.status(503).json({ error: 'Change proposals are not available on this backend yet' });
    }
    const doc = await deps.gitPullRequestStorage.get(String(req.params.id ?? ''));
    if (!doc || !(await viewerNamespaces(auth)).includes(doc.userId)) {
      return res.status(404).json({ error: 'No such proposal on this account' });
    }
    const sha = doc.status === 'merged' ? (doc.mergeCommitSha ?? doc.headSha) : null;
    const docs = sha && deps.gitCommitStatusStorage
      ? await deps.gitCommitStatusStorage.listBySha(doc.repoId, sha)
      : [];
    // One more row per poll, because the screen replaces its whole landing
    // with this answer: leave the switch out and a CI-off card would fall
    // back to waiting on its first refresh.
    const repo = deps.gitRepoStorage ? await deps.gitRepoStorage.get(doc.repoId) : null;
    return res.json({
      status: doc.status,
      decidedAt: doc.decidedAt ?? null,
      delivery: describeProposalDelivery(doc, docs, new Date(), repo?.ci === true),
    } satisfies WorkspaceProposalDeliveryAnswer);
  });

  /**
   * The USER's decision, from the Workspace buttons. Body: `{ decision:
   * 'approve' | 'reject' }`. Runs the same protected decision flow —
   * that flow re-reads the proposal, refuses if already decided, anchors the
   * merge to the head sha the user was shown, and hands the outcome back to
   * the proposing agent — so this route adds no decision logic of its own.
   */
  /**
   * The person's remark on a proposal (Owner, note #66) — the same thread
   * the agents write from the CLI, open to every member who can see the
   * repo, closed once the question is decided. Asking ON the record is the
   * point: "why this table?" said here is still there when the next agent
   * opens the proposal, where the same words in chat reach one agent once.
   * A rejection with a reason is still the decision bar's job, not this.
   *
   * It is a WRITE and nothing else (note #518): no agent is started, not even
   * the one that opened the proposal. The remark waits on the record for its
   * next reader, and a person who needs an answer now asks that agent in its
   * own chat, where the request arrives with the rest of what they want.
   */
  router.post('/api/prs/:id/comments', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitPullRequestStorage) {
      return res.status(503).json({ error: 'Change proposals are not available on this backend yet' });
    }
    const doc = await deps.gitPullRequestStorage.get(String(req.params.id ?? ''));
    if (!doc || !(await viewerNamespaces(auth)).includes(doc.userId)) {
      return res.status(404).json({ error: 'No such proposal on this account' });
    }
    if (!pullRequestTakesComments(doc.status)) {
      return res.status(409).json({ error: `This proposal is ${doc.status} — its margin closed with the decision.` });
    }
    if ((doc.comments?.length ?? 0) >= MAX_COMMENTS) {
      return res.status(400).json({ error: `This proposal already carries ${MAX_COMMENTS} comments — the most one holds.` });
    }
    const html = commentHtmlFromText((req.body ?? {}) as Record<string, unknown>, res);
    if (html === null) return;
    const updated = await deps.gitPullRequestStorage.addComment(doc.id, newMarginComment(COMMENT_AUTHOR_USER, html, auth.userId));
    if (!updated) return res.status(404).json({ error: 'No such proposal on this account' });
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      comments: (updated.comments ?? []).map((comment) => describeMarginComment(comment, people, auth.userId)),
    } satisfies WorkspaceCommentPostAnswer);
  });

  /** Replace the signed-in person's own remark in an OPEN proposal. Editing
   *  changes no recipient state: rewriting words that already landed is never
   *  a second start for the agent that has them. */
  router.put('/api/prs/:id/comments/:commentId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitPullRequestStorage) {
      return res.status(503).json({ error: 'Change proposals are not available on this backend yet' });
    }
    const doc = await deps.gitPullRequestStorage.get(String(req.params.id ?? ''));
    if (!doc || !(await viewerNamespaces(auth)).includes(doc.userId)) {
      return res.status(404).json({ error: 'No such proposal on this account' });
    }
    if (!pullRequestTakesComments(doc.status)) {
      return res.status(409).json({ error: `This proposal is ${doc.status} — its margin closed with the decision.` });
    }
    if (!ownPersonComment(doc.comments, req.params.commentId, auth.userId, res)) return;
    const html = commentHtmlFromText((req.body ?? {}) as Record<string, unknown>, res);
    if (html === null) return;
    const updated = await deps.gitPullRequestStorage.editComment(
      doc.id,
      String(req.params.commentId ?? ''),
      html,
      new Date().toISOString(),
    );
    if (!updated) return res.status(404).json({ error: 'No such comment.' });
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      comments: (updated.comments ?? []).map((comment) => describeMarginComment(comment, people, auth.userId)),
    } satisfies WorkspaceCommentPostAnswer);
  });

  /** Withdraw the signed-in person's own remark from an OPEN proposal. What
   *  comes back is the thread without it: the margin is what stands now, and
   *  a remark its author took back leaves no trace to read around. */
  router.delete('/api/prs/:id/comments/:commentId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitPullRequestStorage) {
      return res.status(503).json({ error: 'Change proposals are not available on this backend yet' });
    }
    const doc = await deps.gitPullRequestStorage.get(String(req.params.id ?? ''));
    if (!doc || !(await viewerNamespaces(auth)).includes(doc.userId)) {
      return res.status(404).json({ error: 'No such proposal on this account' });
    }
    if (!pullRequestTakesComments(doc.status)) {
      return res.status(409).json({ error: `This proposal is ${doc.status} — its margin closed with the decision.` });
    }
    if (!ownPersonComment(doc.comments, req.params.commentId, auth.userId, res, 'deleted')) return;
    const updated = await deps.gitPullRequestStorage.deleteComment(doc.id, String(req.params.commentId ?? ''));
    if (!updated) return res.status(404).json({ error: 'No such comment.' });
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      comments: (updated.comments ?? []).map((comment) => describeMarginComment(comment, people, auth.userId)),
    } satisfies WorkspaceCommentPostAnswer);
  });

  /**
   * A file the proposal carries, for the reader who is about to decide.
   *
   * READ only, and that is deliberate rather than unfinished: a file here is
   * the proposing agent's evidence, and the person on this screen is the one
   * being shown it. The Workspace lets the user attach to a NOTE because a
   * note is a shared jotting; a proposal is one agent's ask, answered with a
   * tap rather than added to.
   */
  router.get('/api/prs/:id/files/:file', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.gitPullRequestStorage) {
      return res.status(503).json({ error: 'Change proposals are not available on this backend yet' });
    }
    if (!deps.mediaStorage) {
      return res.status(503).json({ error: 'File storage is not available on this backend yet.' });
    }
    const doc = await deps.gitPullRequestStorage.get(String(req.params.id ?? ''));
    if (!doc || !(await viewerNamespaces(auth)).includes(doc.userId)) {
      return res.status(404).json({ error: 'No such proposal on this account' });
    }
    const attachment = (doc.attachments ?? []).find((a) => a.id === String(req.params.file));
    if (!attachment) return res.status(404).json({ error: 'No such file on this proposal.' });
    // A picture about to be DRAWN gets the same stable, cacheable signature
    // the detail carries (note #825), so the fallback mint and the detail
    // agree on one URL and the browser's cache serves the second of them.
    const access = (req.query.preview === '1' && drawsAsPicture(attachment)
      ? await pictureAccess(attachment.storagePath, true)
      : undefined)
      ?? await deps.mediaStorage.createReadAccess({
        storagePath: attachment.storagePath,
        expiresInMs: 15 * 60_000,
        ...readDisposition(req, attachment),
      });
    return res.json({
      url: access.url, fileName: attachment.fileName, expiresAt: access.expiresAt,
    } satisfies WorkspaceFileAccessAnswer);
  });

  router.post('/api/prs/:id/decision', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.decidePullRequest) {
      return res.status(503).json({ error: 'Change proposals are not available on this backend yet' });
    }
    const doc = await deps.gitPullRequestStorage?.get(String(req.params.id ?? ''));
    if (!doc || !(await viewerNamespaces(auth)).includes(doc.userId)) {
      return res.status(404).json({ error: 'No such proposal on this account' });
    }
    if (!proposalOwnedByViewer(auth, doc)) {
      return res.status(403).json({ error: 'Only the owner of the agent that proposed this change can decide it.' });
    }
    if (doc.status === 'open' && !pullRequestAwaitsDecision(doc)) {
      // The flow underneath refuses this too; answering here keeps the
      // reason exact, and keeps a quiet proposal from ever reaching a merge
      // path (note #293).
      return res.status(409).json({ error: `PR #${doc.number} is not ready yet — the agent is still working on it and will invite you when it is.` });
    }
    const decision = (req.body as Record<string, unknown> | undefined)?.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({ error: "Pass decision: 'approve' or 'reject'" });
    }
    const shownHeadSha = (req.body as Record<string, unknown> | undefined)?.headSha;
    const reason = (req.body as Record<string, unknown> | undefined)?.note;
    const result = await deps.decidePullRequest({
      userId: auth.userId,
      pullRequestId: String(req.params.id ?? ''),
      decision,
      ...(typeof shownHeadSha === 'string' && shownHeadSha ? { shownHeadSha } : {}),
      // A reason only travels with a rejection — an approval explains itself.
      ...(decision === 'reject' && typeof reason === 'string' && reason.trim()
        ? { note: reason.trim().slice(0, MAX_PR_DECISION_NOTE_LENGTH) }
        : {}),
    });
    await recordPersonAction(auth, personActionLines.decidedProposal(decision, doc.number, doc.title));
    refreshRecapForOrg(auth.orgId);
    return res.json({ ok: true, ...result } satisfies WorkspaceProposalDecisionAnswer);
  });

  /**
   * One knowledge page, for the screen that RENDERS it. The html travels as
   * source and the page builds it into elements through its own allowlist —
   * the owner never sees markup, and nothing in a page can become live markup
   * either (the same rule the markdown renderer follows one screen over).
   */
  /**
   * A page's files as `{ name: signedUrl }`, or nothing at all when it has
   * none. What the renderer needs to turn `<img src="files/chart.png">` into a
   * picture, on the page's own screen and in a proposal's preview alike.
   *
   * Short-lived, like every other read of media storage here. A page left open
   * past the expiry shows a broken image and one reload fixes it; the
   * alternative is a URL that outlives the tap that earned it.
   */
  const signKnowledgeFiles = async (
    attachments: KnowledgePageAttachment[] | undefined,
  ): Promise<{ files?: Record<string, string> }> => {
    if (!attachments?.length || !deps.mediaStorage) return {};
    const files: Record<string, string> = {};
    for (const file of attachments) {
      // One bad object must not cost the page every other picture on it, nor
      // the words: a miss here is one broken image.
      const access = await deps.mediaStorage.createReadAccess({
        storagePath: file.storagePath,
        expiresInMs: 15 * 60_000,
      }).catch(() => null);
      if (access) files[file.fileName] = access.url;
    }
    return Object.keys(files).length ? { files } : {};
  };

  router.get('/api/knowledge/pages/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const roomNs = await viewerNamespaceFor(auth, req, res);
    if (!roomNs) return;
    const knowledge = await requireKnowledge(auth.userId, auth.orgId, res);
    if (!knowledge) return;
    const requested = String(req.params.name ?? '');
    let name = requested;
    if (validateKnowledgePageName(name)) {
      return res.status(400).json({ error: 'That is not a knowledge page name.' });
    }
    let page = await knowledge.service.readPage(knowledge.ns.namespaceId, requested);
    if (!page && auth.orgId) {
      // A link copied before the workplace's shelves were merged (note #566)
      // names the page as its room knew it. If the merge had to put the room's
      // name in front, the link follows it — when only one page was so renamed.
      const renames = (await deps.orgStorage?.getOrg(auth.orgId).catch(() => null))?.knowledgeShelf?.renames
        ?.filter((rename) => rename.from === requested) ?? [];
      const moved = renames.length === 1 ? renames[0] : undefined;
      if (moved) {
        name = moved.to;
        page = await knowledge.service.readPage(knowledge.ns.namespaceId, name);
      }
    }
    if (!page) return res.status(404).json({ error: 'No such knowledge page.' });
    const meta = readKnowledgePageMeta(page.content);
    const listed = (await knowledge.service.listPages(knowledge.ns.namespaceId)).find((entry) => entry.name === name);
    // The page's margin (note #66), resolved before the reply is assembled.
    const pageComments = deps.knowledgePageCommentStorage
      ? await deps.knowledgePageCommentStorage.list(knowledge.ns.namespaceId, name)
      : null;
    const people = await workspacePeople(auth);
    return res.json({
      page: {
        name,
        html: page.content,
        history: await knowledgePageHistory(await numberedNamespaces(auth), knowledge.service, name, people),
        ...('error' in meta ? {} : { title: meta.title, description: meta.description }),
        // The page's own files, already resolved: a page that carries a
        // diagram points at it as `files/<name>`, and the renderer needs a URL
        // to put in the img. Sent WITH the page rather than fetched per image
        // — the page is one request and its pictures should not each cost
        // another before anything appears.
        ...(await signKnowledgeFiles(listed?.attachments)),
        // The page's margin (note #66). Present — empty included — exactly
        // when this backend can hold one, so the screen keys the whole
        // Comments card off it, like the note screen's Files card.
        ...(pageComments
          ? { comments: pageComments.map((comment) => describeMarginComment(comment, people, auth.userId)) }
          : {}),
      },
    } satisfies WorkspaceKnowledgePageAnswer);
  });

  /**
   * Put a page back from the Workspace (note #746) — the person's own one
   * step, since nobody asks them any more. With `to`, the page becomes what
   * that change landed; without, the version before its last change. The
   * restore is a landed change like any other — in the history, signed with
   * the person's own sentinel — and, being theirs, told to nobody.
   */
  router.post('/api/knowledge/pages/:name/restore', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const roomNs = await viewerNamespaceFor(auth, req, res);
    if (!roomNs) return;
    const knowledge = await requireKnowledge(auth.userId, auth.orgId, res);
    if (!knowledge) return;
    const name = String(req.params.name ?? '');
    if (validateKnowledgePageName(name)) return res.status(400).json({ error: 'That is not a knowledge page name.' });
    const body = (req.body ?? {}) as { to?: unknown };
    const toNumber = body.to === undefined || body.to === null ? undefined : Number(body.to);
    if (toNumber !== undefined && (!Number.isInteger(toNumber) || toNumber < 1)) {
      return res.status(400).json({ error: 'That is not a version of this page.' });
    }
    const namespaces = await numberedNamespaces(auth);
    const result = await knowledge.service.restore({
      namespaces,
      page: name,
      ...(toNumber !== undefined ? { toNumber } : {}),
      actor: { agentId: QUICK_NOTE_AUTHOR_USER, userId: auth.userId, namespaceId: knowledge.ns.namespaceId },
      numbering: await numberSeries(auth),
    });
    if (result.status === 'nothing') return res.status(409).json({ error: result.reason });
    if (result.status === 'conflict') return res.status(409).json({ error: 'The page changed while you were looking at it. Reload and try again.' });
    for (const file of result.orphaned) {
      await deps.mediaStorage?.deleteObject?.({ storagePath: file.storagePath }).catch(() => {});
    }
    await moveMarginsForLandedChanges(deps.knowledgePageCommentStorage, result.proposal.userId, result.proposal.changes);
    await recordPersonAction(auth, personActionLines.restoredKnowledge(name, result.proposal.number));
    refreshRecapForOrg(auth.orgId);
    const page = await knowledge.service.readPage(knowledge.ns.namespaceId, name);
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      number: result.proposal.number,
      ...(page
        ? {
          page: {
            name,
            html: page.content,
            history: await knowledgePageHistory(namespaces, knowledge.service, name, people),
          },
        }
        : {}),
    } satisfies WorkspaceKnowledgeRestoreAnswer);
  });

  /** A person's remark on a page (note #66) — the same margin the agents
   *  write from the CLI, beside a document only a proposal may change. */
  router.post('/api/knowledge/pages/:name/comments', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const roomNs = await viewerNamespaceFor(auth, req, res);
    if (!roomNs) return;
    const knowledge = await requireKnowledge(auth.userId, auth.orgId, res);
    if (!knowledge) return;
    const store = deps.knowledgePageCommentStorage;
    if (!store) return res.status(503).json({ error: 'Comments are not available on this backend yet.' });
    const name = String(req.params.name ?? '');
    if (validateKnowledgePageName(name)) {
      return res.status(400).json({ error: 'That is not a knowledge page name.' });
    }
    const page = await knowledge.service.readPage(knowledge.ns.namespaceId, name);
    if (!page) return res.status(404).json({ error: 'No such knowledge page.' });
    if ((await store.list(knowledge.ns.namespaceId, name)).length >= MAX_COMMENTS) {
      return res.status(400).json({ error: `This page already carries ${MAX_COMMENTS} comments — the most one holds.` });
    }
    const html = commentHtmlFromText((req.body ?? {}) as Record<string, unknown>, res);
    if (html === null) return;
    const comments = await store.add(knowledge.ns.namespaceId, name, newMarginComment(COMMENT_AUTHOR_USER, html, auth.userId));
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      comments: comments.map((comment) => describeMarginComment(comment, people, auth.userId)),
    });
  });

  /** A page stays live, so its author may correct their own remark in place.
   *  The page itself is still changed only through a reviewed proposal. */
  router.put('/api/knowledge/pages/:name/comments/:commentId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const roomNs = await viewerNamespaceFor(auth, req, res);
    if (!roomNs) return;
    const knowledge = await requireKnowledge(auth.userId, auth.orgId, res);
    if (!knowledge) return;
    const store = deps.knowledgePageCommentStorage;
    if (!store) return res.status(503).json({ error: 'Comments are not available on this backend yet.' });
    const name = String(req.params.name ?? '');
    if (validateKnowledgePageName(name)) {
      return res.status(400).json({ error: 'That is not a knowledge page name.' });
    }
    const page = await knowledge.service.readPage(knowledge.ns.namespaceId, name);
    if (!page) return res.status(404).json({ error: 'No such knowledge page.' });
    const comments = await store.list(knowledge.ns.namespaceId, name);
    if (!ownPersonComment(comments, req.params.commentId, auth.userId, res)) return;
    const html = commentHtmlFromText((req.body ?? {}) as Record<string, unknown>, res);
    if (html === null) return;
    const updated = await store.edit(
      knowledge.ns.namespaceId,
      name,
      String(req.params.commentId ?? ''),
      html,
      new Date().toISOString(),
    );
    if (!updated) return res.status(404).json({ error: 'No such comment.' });
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      comments: updated.map((comment) => describeMarginComment(comment, people, auth.userId)),
    } satisfies WorkspaceCommentPostAnswer);
  });

  /** Take one's own remark off a live page. The page's own words are never
   *  touched here — they change only through a reviewed proposal. */
  router.delete('/api/knowledge/pages/:name/comments/:commentId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const roomNs = await viewerNamespaceFor(auth, req, res);
    if (!roomNs) return;
    const knowledge = await requireKnowledge(auth.userId, auth.orgId, res);
    if (!knowledge) return;
    const store = deps.knowledgePageCommentStorage;
    if (!store) return res.status(503).json({ error: 'Comments are not available on this backend yet.' });
    const name = String(req.params.name ?? '');
    if (validateKnowledgePageName(name)) {
      return res.status(400).json({ error: 'That is not a knowledge page name.' });
    }
    const page = await knowledge.service.readPage(knowledge.ns.namespaceId, name);
    if (!page) return res.status(404).json({ error: 'No such knowledge page.' });
    const comments = await store.list(knowledge.ns.namespaceId, name);
    if (!ownPersonComment(comments, req.params.commentId, auth.userId, res, 'deleted')) return;
    const updated = await store.remove(knowledge.ns.namespaceId, name, String(req.params.commentId ?? ''));
    if (!updated) return res.status(404).json({ error: 'No such comment.' });
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      comments: updated.map((comment) => describeMarginComment(comment, people, auth.userId)),
    } satisfies WorkspaceCommentPostAnswer);
  });

  /**
   * One quick note, whole (docs/agent-quick-notes.md). Its own fetch for the
   * same reason a knowledge page has one: home carries a title and a glimpse,
   * and the body arrives only for the note actually opened.
   */
  /**
   * The note this number names, or a reply and null.
   *
   * A number names one note of the workplace (notes #741, #843): its own
   * copy wins, then its old rooms' namespaces, and a number held twice there
   * (from before numbers were workplace-wide) cannot be guessed. A note's
   * earlier addresses count as well, so an old link still arrives.
   */
  const workspaceNote = async (
    auth: MiniAppAuth,
    req: Request,
    raw: unknown,
    res: Response,
  ): Promise<QuickNoteDocument | null> => {
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1) {
      res.status(400).json({ error: 'That is not a note.' });
      return null;
    }
    // The number names the workplace's note (note #843): an old link's
    // `&room=` is read by nothing.
    const preferred = (await viewerNamespaceFor(auth, req, res, { notes: true }))?.namespaceId ?? null;
    const found = pickNumbered(
      await deps.quickNoteStorage!.findByNumber(await numberedNamespaces(auth, preferred), number),
      number,
      preferred,
    );
    if (found.kind === 'one') return found.doc;
    res.status(404).json({
      error: found.kind === 'many'
        ? 'This number is held twice in the workplace (from before 12 Oct 2026). Open the note from the notes list.'
        : 'No such note.',
    });
    return null;
  };

  /**
   * One remark in a margin, ready to draw: what it says, when, and whose face
   * sits beside it. Written for a note's thread first, and now every margin —
   * a proposal's, a knowledge proposal's, a page's — draws its remarks
   * through the same describe (notes #64/#66).
   *
   * A comment is an agent's or a PERSON's. An agent's face rides with the
   * agent fields; a person's remark carries `byPerson` and the door fields
   * instead, so the screen can put the human's own face on it and make the
   * face a door to their page — the rule every face already follows.
   */
  const describeMarginComment = (comment: MarginComment, people: WorkspacePeople, viewerUserId: string) => {
    const agent = people.agent(comment.authorId);
    // WHO DRIVES that agent (note #57): the stamp written at creation when
    // there is one — it survives the agent's retirement — else the agent's
    // owner, resolved across the org. The viewer's own agents are signed the
    // same way (Owner, 2026-08-26): one rule for every line, and a margin a
    // teammate later reads carries the same names the writer saw. Named
    // plainly — members already see each other on the org screen, so a
    // signature here crosses no boundary.
    const driverId = comment.userId ?? agent?.ownerUserId;
    // An AGENT's remark whose agent the workplace no longer has (note #705).
    // Signed by its driver alone, it read as the person having written it —
    // "Adam B · 7d ago" over Willow's words — so it says it was an agent, and
    // by name wherever the work ledger still remembers one.
    const former = !agent && comment.authorId !== COMMENT_AUTHOR_USER;
    const name = agent?.name ?? (former && driverId ? people.formerAgentName(comment.authorId, driverId) : undefined);
    const face = agentFaceUrl(name);
    // A margin signs the agent that wrote each remark, so it carries the same
    // concrete runtime shown beneath an agent elsewhere: harness, model and
    // effort as they resolve now. Stored defaults are not concrete enough to
    // display, and an unsupported retired harness has no truthful runtime.
    const runtime = agent && isSupportedAgentCli(agent.cli)
      ? {
        cli: agent.cli,
        model: resolveEffectiveModel(agent.cli, agent.model),
        effort: resolveEffectiveEffort(agent.cli, agent.model, agent.effort),
      }
      : undefined;
    const driverName = driverId ? people.name(driverId) : undefined;
    const self = comment.authorId === COMMENT_AUTHOR_USER && driverId === viewerUserId;
    return {
      id: comment.id,
      text: comment.text,
      createdAt: comment.createdAt,
      ...(comment.editedAt ? { editedAt: comment.editedAt } : {}),
      // A deleted agent keeps the name the ledger last credited it under, and
      // the face that name wears (note #705); one the ledger never saw goes
      // unnamed, and `formerAgent` still says an agent wrote it.
      ...(name ? { agentName: name } : {}),
      ...(face ? { agentAvatarUrl: face } : {}),
      ...(runtime ? { agentRuntime: runtime } : {}),
      ...(former ? { formerAgent: true } : {}),
      // WHICH agent (note #58) — the face on a remark is a door onto the
      // agent that wrote it, the reader's own or a teammate's alike since
      // note #640. Absent only for an agent the workplace no longer has,
      // which is when the remark keeps its picture and offers no door.
      ...agentDoorId(comment.authorId, people),
      ...(driverName ? { userName: driverName } : {}),
      ...(driverName && driverId && people.photoUrl(driverId) ? { userPhotoUrl: people.photoUrl(driverId) } : {}),
      // A person's remark, not an agent's (note #64): the face drawn is the
      // human's own, and a door to their page. A retired AGENT's comment
      // never takes this branch — its driver is named only beside it, and
      // `formerAgent` above is what keeps the line from reading as the
      // human's own words.
      ...(comment.authorId === COMMENT_AUTHOR_USER && driverId
        ? {
          byPerson: true,
          authorUserId: driverId,
          ...(self ? { self: true, editableText: editableTextFromSafeHtml(comment.text) } : {}),
        }
        : {}),
    };
  };

  /** The comment a person may replace or withdraw, or a complete refusal.
   *  `userId` alone is not authorship: an agent comment carries its driver's
   *  id too, and the human must never be able to rewrite — or quietly remove —
   *  the agent's signed words. */
  const ownPersonComment = (
    comments: readonly MarginComment[] | undefined,
    commentId: unknown,
    viewerUserId: string,
    res: Response,
    verb: 'edited' | 'deleted' = 'edited',
  ): MarginComment | null => {
    const comment = (comments ?? []).find((row) => row.id === String(commentId ?? ''));
    if (!comment) {
      res.status(404).json({ error: 'No such comment.' });
      return null;
    }
    if (comment.authorId !== COMMENT_AUTHOR_USER || comment.userId !== viewerUserId) {
      res.status(403).json({ error: `Only your own comments can be ${verb}.` });
      return null;
    }
    return comment;
  };

  /** The notes storage, or a reply and null. */
  const workspaceNotes = (res: Response) => {
    if (!deps.quickNoteStorage) {
      res.status(503).json({ error: 'Notes are not available right now.' });
      return null;
    }
    return deps.quickNoteStorage;
  };

  /**
   * What the user typed, as the HTML a note is stored in — or a reply and null.
   *
   * Shared by the two routes that take a note from the box: writing one and
   * rewriting one. Both refuse in the units the person typed in, which is the
   * whole reason this is not just `validateQuickNoteHtml`.
   */
  const noteHtmlFromText = (body: Record<string, unknown>, res: Response): string | null => {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'Write something first.' });
      return null;
    }
    // Said in the user's own units. The HTML limit underneath is measured on
    // markup they never typed, so its arithmetic would read as nonsense.
    const tooLong = `That is longer than a quick note holds — ${QUICK_NOTE_MAX_TEXT_LENGTH} characters at most. Anything longer is worth asking an agent to write down properly.`;
    if (text.length > QUICK_NOTE_MAX_TEXT_LENGTH) {
      res.status(400).json({ error: tooLong });
      return null;
    }
    const html = textToSafeHtml(text);
    // The same validator every note passes, as a backstop rather than as the
    // rule the user meets: text this long converts to markup marginally longer
    // still, and only a note of two thousand one-word lines can reach it.
    const invalid = validateQuickNoteHtml(html);
    if (invalid) {
      res.status(400).json({ error: html.length > QUICK_NOTE_MAX_LENGTH ? tooLong : invalid });
      return null;
    }
    return html;
  };

  /**
   * What the person typed in a comment box, as the HTML the margin stores —
   * or a reply and null. One helper for all four margins (notes #64/#66),
   * the comment-sized sibling of `noteHtmlFromText`: it refuses in the units
   * the person typed in, and the markup is the server's job.
   */
  const commentHtmlFromText = (body: Record<string, unknown>, res: Response): string | null => {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'Write something first.' });
      return null;
    }
    const tooLong = `That is longer than a comment holds — ${COMMENT_MAX_TEXT_LENGTH} characters at most. Anything longer is worth a note of its own.`;
    if (text.length > COMMENT_MAX_TEXT_LENGTH) {
      res.status(400).json({ error: tooLong });
      return null;
    }
    const html = textToSafeHtml(text);
    // The validator every comment passes, as a backstop rather than the rule
    // the person meets — only a comment of hundreds of one-word lines can
    // convert past the HTML limit.
    const invalid = validateMarginComment(html, COMMENT_HTML_LABELS, 'Anything longer is worth a note of its own.');
    if (invalid) {
      res.status(400).json({ error: html.length > COMMENT_MAX_LENGTH ? tooLong : invalid });
      return null;
    }
    return html;
  };

  /** A note's files, as its screen shows them. Names and sizes only — bytes
   *  stay in media storage and travel on their own signed URLs. */
  const describeNoteAttachments = (doc: QuickNoteDocument, viewerUserId: string) => (
    (doc.attachments ?? []).map((a) => {
      const humanAdded = a.addedByAgentId === QUICK_NOTE_AUTHOR_USER;
      const addedByViewer = humanAdded && (a.addedByUserId
        ? a.addedByUserId === viewerUserId
        : doc.userId === viewerUserId);
      return {
        id: a.id,
        fileName: a.fileName,
        // Same heal as a proposal's files: a screenshot an agent pushed with
        // `note attach` was stored under the raw-upload header, so it drew as a
        // document row while the identical file picked in the Workspace drew as
        // the picture. One bug, both lists.
        contentType: inferContentType(a.fileName, a.contentType),
        sizeBytes: a.sizeBytes,
        addedAt: a.addedAt,
        ...(addedByViewer ? { byUser: true as const } : humanAdded ? { byMember: true as const } : {}),
      };
    })
  );

  /** A human-authored note whose standing words belong to this viewer. */
  const noteWrittenByViewer = (doc: QuickNoteDocument, userId: string): boolean => (
    quickNoteIsUsers(doc) && (doc.updatedByUserId ? doc.updatedByUserId === userId : doc.userId === userId)
  );

  /**
   * Whether this note stands with the reader rather than with a teammate
   * (note #637): their own jotting, or one their agents keep for them.
   *
   * The viewer's own fleet is the only directory needed — the question is
   * never "whose agent is this" but "is it one of mine", and an answer read
   * off `auth` costs nothing on a verb that until now fetched nobody. It is
   * the same rule `describeQuickNote` sends the screen as `yours`, so the
   * buttons a reader is offered and the ones the server will honour cannot
   * drift apart.
   */
  const noteStandsWithViewer = (doc: QuickNoteDocument, auth: MiniAppAuth): boolean => (
    noteHumanOwner(doc, (id) => (auth.profile.telegram?.agents?.[id] ? auth.userId : undefined))
      === auth.userId
  );

  /**
   * The refusal behind every one of those verbs, said in the same words the
   * screen says when it draws no button at all: whose note it is, and what
   * the reader has instead.
   *
   * The Workspace does not send these requests — it hides the actions on a
   * teammate's note — so this is the backstop, for a pasted address, a stale
   * page, or a shell written against the API. It names no member: the screen
   * above it already signs the note with their name and face, and an error
   * is the wrong place to introduce somebody.
   */
  const refuseSomebodyElsesNote = (
    doc: QuickNoteDocument,
    auth: MiniAppAuth,
    res: Response,
    verb: string,
  ): boolean => {
    if (noteStandsWithViewer(doc, auth)) return false;
    const whose = quickNoteIsUsers(doc)
      ? 'Another workplace member wrote this note'
      : 'Another workplace member’s agent keeps this note';
    res.status(403).json({
      error: `${whose}, so only they and their agents can ${verb}. Leave a comment on it instead.`,
    });
    return true;
  };

  const workspaceNoteWork = async (doc: QuickNoteDocument): Promise<QuickNoteWork> => {
    const work = await resolveQuickNoteWorkMap({
      notes: [doc],
      pullRequests: deps.gitPullRequestStorage,
      commitStatuses: deps.gitCommitStatusStorage,
    });
    return work.get(doc.id) ?? { state: 'unclaimed' };
  };

  /**
   * The archive (Owner, note #23). Its own fetch rather than a slice of
   * `/api/state`: the notes card on home is about what the account is working
   * from, and shipping every put-away jotting into every state load to draw a
   * door that says "Archive" is a hundred titles for a number.
   *
   * ABOVE `/:number` on purpose — Express matches in registration order, and
   * under it "archive" would be read as a note number and refused as one.
   */
  router.get('/api/notes/archive', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    const archiveOwner = await viewerOwnerId(auth, req, res, { notes: true });
    if (archiveOwner === null) return;
    const docs = await notes.listArchivedByUser(archiveOwner);
    const people = await workspacePeople(auth);
    return res.json({
      notes: docs.map((doc) => describeQuickNote(doc, people, auth.userId)),
    } satisfies WorkspaceNoteListAnswer);
  });

  /**
   * Searching them (note #242): every note in the room whose words match, live
   * and archived together, ranked by `rankQuickNoteSearch`.
   *
   * Its own fetch and not a filter over what the page already holds, for the
   * two reasons a filter cannot cover: the archive is never loaded into the
   * page at all, and the lists it does hold carry a title and a glimpse rather
   * than the words — so a client-side filter would answer "no such note" about
   * a note whose second paragraph says exactly what was typed.
   *
   * ABOVE `/:number`, with the archive, or Express reads "search" as a note
   * number and refuses it as one.
   */
  router.get('/api/notes/search', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    const owner = await viewerOwnerId(auth, req, res, { notes: true });
    if (owner === null) return;
    const terms = quickNoteSearchTerms(String(req.query.q ?? ''));
    // Nothing typed is not an error and not everything: it is the list the
    // reader already has in front of them, so the page draws that instead.
    if (!terms.length) return res.json({ notes: [] } satisfies WorkspaceNoteListAnswer);
    const docs = await notes.search(owner, terms, QUICK_NOTE_SEARCH_LIMIT);
    const people = await workspacePeople(auth);
    const work = await resolveQuickNoteWorkMap({
      notes: docs,
      pullRequests: deps.gitPullRequestStorage,
      commitStatuses: deps.gitCommitStatusStorage,
    });
    return res.json({
      notes: docs.map((doc) => ({
        ...describeQuickNote(doc, people, auth.userId, work.get(doc.id) ?? { state: 'unclaimed' }),
        // The row's second line, replaced by the part of the note the query is
        // actually IN. A result that shows a note's opening words cannot say
        // why it is on screen when the match is four sentences down.
        preview: quickNoteSearchSnippet(doc, terms),
      })),
    } satisfies WorkspaceNoteListAnswer);
  });

  router.get('/api/notes/:number', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!workspaceNotes(res)) return;
    const doc = await workspaceNote(auth, req, req.params.number, res);
    if (!doc) return;
    const people = await workspacePeople(auth);
    const work = await workspaceNoteWork(doc);
    return res.json({
      note: {
        ...describeQuickNote(doc, people, auth.userId, work),
        // Present (empty included) exactly when this backend can hold files —
        // the page keys the whole Files card off it, so a backend with no
        // media store shows no card rather than a button that 503s.
        ...(deps.mediaStorage ? { attachments: describeNoteAttachments(doc, auth.userId) } : {}),
        // The source, which the page rebuilds through its own allowlist — the
        // same trade a knowledge page makes, and for the same reason: markup
        // an agent wrote never reaches innerHTML.
        html: doc.html,
        // And, for the user's OWN note, the plain text they typed it as — what
        // the edit box is filled with. Absent on an agent's note, which is not
        // editable here and would not survive a text box anyway.
        ...(noteWrittenByViewer(doc, auth.userId) ? { text: quickNoteEditableText(doc.html) } : {}),
        // The margin, whole, to READ. `summarizeQuickNote` has already put a
        // COUNT in this field for the list; the screen that opened the note
        // wants the remarks themselves, so the fuller answer replaces it here.
        comments: (doc.comments ?? []).map((comment) => describeMarginComment(comment, people, auth.userId)),
      },
    } satisfies WorkspaceNoteDetailAnswer);
  });


  /**
   * A note the USER writes, in their own Workspace (Owner's call, 2026-08-16).
   *
   * Notes shipped agent-write-only: the reasoning was that a note the user
   * changed behind an agent's back is one the agent then contradicts. That
   * holds for EDITING what an agent wrote — which is still not offered here —
   * and not for jotting something down. The wifi code the user is looking at
   * right now, in the app that is already open, should not need a round trip
   * through a chat and an agent's turn.
   *
   * Plain text, and text is all this route accepts: the person types what they
   * mean and the server does the markup (`textToSafeHtml`, which escapes as it
   * goes). A user typing into a box is not writing a fragment, and there is no
   * markup here to get wrong or to smuggle anything through — every surface
   * that displays it rebuilds the nodes from its own allowlist regardless.
   */
  router.post('/api/notes', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    const html = noteHtmlFromText((req.body ?? {}) as Record<string, unknown>, res);
    if (html === null) return;
    const ownerId = await viewerOwnerId(auth, req, res, { notes: true });
    if (ownerId === null) return;
    if (await notes.countByUser(ownerId) >= QUICK_NOTES_MAX_PER_USER) {
      return res.status(400).json({
        error: `You have ${QUICK_NOTES_MAX_PER_USER} notes — the most an account holds. Archive one that has served its purpose; it stays readable in your archive.`,
      });
    }
    const doc = await notes.create({
      userId: ownerId,
      html,
      // Not an agent id: this one is the user's own, and every surface that
      // says who last touched a note reads it out of these two fields.
      createdByAgentId: QUICK_NOTE_AUTHOR_USER,
      createdByUserId: auth.userId,
      updatedByAgentId: QUICK_NOTE_AUTHOR_USER,
      updatedByUserId: auth.userId,
    }, await numberSeries(auth));
    await recordPersonAction(auth, personActionLines.wroteNote(doc.number, quickNoteTitle(doc.html)));
    refreshRecapForOrg(auth.orgId);
    return res.json({
      ok: true,
      note: describeQuickNote(
        doc,
        await workspacePeople(auth),
        auth.userId,
        await workspaceNoteWork(doc),
      ),
      title: quickNoteTitle(doc.html),
    } satisfies WorkspaceNoteWriteAnswer);
  });

  /**
   * Rewriting a note — the user's OWN only (Owner's call, 2026-08-16).
   *
   * The asymmetry with delete below is deliberate and is the whole shape of
   * this feature. Words an agent wrote are words it is still working from: a
   * user who rewrites them behind its back gets an agent that carries on from
   * its own version and contradicts the note on its next turn. So changing one
   * goes through the agent, which is also how the change reaches whatever it is
   * doing about the note. Removing one has no such problem — see DELETE.
   *
   * "Whose note" is read off `updatedByAgentId`, the same field the screen's
   * "Written by you" comes from: a note the user started and an agent has since
   * rewritten is the agent's now, because the words standing in it are.
   */
  router.put('/api/notes/:number', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    const doc = await workspaceNote(auth, req, req.params.number, res);
    if (!doc) return;
    // An archived note is read-only, whoever wrote it: a note being kept up to
    // date inside the archive is a live note in the wrong place.
    if (quickNoteIsArchived(doc)) {
      return res.status(400).json({
        error: 'This note is archived. Bring it back to the notes list first, then edit it.',
      });
    }
    if (!noteWrittenByViewer(doc, auth.userId)) {
      if (quickNoteIsUsers(doc)) {
        return res.status(403).json({
          error: 'Another workplace member last wrote this note. Only they can edit its words.',
        });
      }
      const agentName = auth.profile.telegram?.agents?.[doc.updatedByAgentId]?.name;
      if (agentName) {
        return res.status(403).json({
          error: `This note was created by ${agentName}, and only an agent can edit it — ask ${agentName} to change what it says.`,
        });
      }
      // With no name to give, the writer is an agent this reader does not have:
      // a teammate's, or one that has been deleted (note #638). One sentence
      // used to answer both — "only its owner's agents can edit it" — which
      // tells the owner of a note that their own note is somebody else's.
      if (!noteStandsWithViewer(doc, auth)) {
        return res.status(403).json({
          error: 'Another workplace member’s agent wrote this note. Only that member’s agents can rewrite its words '
            + '— leave a comment on it instead.',
        });
      }
      const canAsk = noteAgentsCanEdit(doc, auth.userId, (id) => (
        auth.profile.telegram?.agents?.[id] ? auth.userId : undefined
      ));
      return res.status(403).json({
        error: canAsk
          ? 'The agent that wrote this note is no longer in this workplace. The note is still yours — ask any of '
            + 'your agents to change what it says.'
          : 'The agent that wrote this note is no longer in this workplace, and its words cannot be rewritten now. '
            + 'Leave a comment on the note instead.',
      });
    }
    const html = noteHtmlFromText((req.body ?? {}) as Record<string, unknown>, res);
    if (html === null) return;
    const updated = await notes.update(doc.id, {
      html,
      updatedAt: new Date().toISOString(),
      updatedByAgentId: QUICK_NOTE_AUTHOR_USER,
      updatedByUserId: auth.userId,
    });
    if (!updated) return res.status(404).json({ error: 'No such note.' });
    refreshRecapForOrg(auth.orgId);
    return res.json({
      ok: true,
      note: describeQuickNote(
        updated,
        await workspacePeople(auth),
        auth.userId,
        await workspaceNoteWork(updated),
      ),
      title: quickNoteTitle(updated.html),
    } satisfies WorkspaceNoteWriteAnswer);
  });

  /**
   * The person's half of the margin (Owner, note #64).
   *
   * Comments shipped agents-only, with the user answering in chat. Opening
   * the margin from here closes the loop the note screen already implies:
   * the remark sits under the note, so the reply belongs under the remark —
   * and a teammate's note, which the viewer may never edit, still has a
   * place their words can go. Plain text in, exactly like the note box.
   *
   * A remark on a note starts nobody (note #518): agents find the margin when
   * they next read the note, and a person who wants one to read it now says
   * so in that agent's chat.
   */
  router.post('/api/notes/:number/comments', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    const doc = await workspaceNote(auth, req, req.params.number, res);
    if (!doc) return;
    // Read-only in the archive, like every other write to a note.
    if (quickNoteIsArchived(doc)) {
      return res.status(400).json({
        error: 'This note is archived. Bring it back to the notes list first, then comment on it.',
      });
    }
    if ((doc.comments?.length ?? 0) >= MAX_COMMENTS) {
      return res.status(400).json({ error: `This note already carries ${MAX_COMMENTS} comments — the most one holds.` });
    }
    const html = commentHtmlFromText((req.body ?? {}) as Record<string, unknown>, res);
    if (html === null) return;
    const updated = await notes.addComment(doc.id, newMarginComment(COMMENT_AUTHOR_USER, html, auth.userId));
    if (!updated) return res.status(404).json({ error: 'No such note.' });
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      comments: (updated.comments ?? []).map((comment) => describeMarginComment(comment, people, auth.userId)),
    });
  });

  /** Correct the person's own remark without rewriting the note around it.
   *  Archived notes stay wholly read-only until restored. */
  router.put('/api/notes/:number/comments/:commentId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    const doc = await workspaceNote(auth, req, req.params.number, res);
    if (!doc) return;
    if (quickNoteIsArchived(doc)) {
      return res.status(400).json({
        error: 'This note is archived. Bring it back to the notes list first, then edit its comment.',
      });
    }
    if (!ownPersonComment(doc.comments, req.params.commentId, auth.userId, res)) return;
    const html = commentHtmlFromText((req.body ?? {}) as Record<string, unknown>, res);
    if (html === null) return;
    const updated = await notes.editComment(
      doc.id,
      String(req.params.commentId ?? ''),
      html,
      new Date().toISOString(),
    );
    if (!updated) return res.status(404).json({ error: 'No such comment.' });
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      comments: (updated.comments ?? []).map((comment) => describeMarginComment(comment, people, auth.userId)),
    } satisfies WorkspaceCommentPostAnswer);
  });

  /** Take back the person's own remark, leaving the note and every other
   *  remark exactly as they were. Archived notes stay read-only. */
  router.delete('/api/notes/:number/comments/:commentId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    const doc = await workspaceNote(auth, req, req.params.number, res);
    if (!doc) return;
    if (quickNoteIsArchived(doc)) {
      return res.status(400).json({
        error: 'This note is archived. Bring it back to the notes list first, then delete its comment.',
      });
    }
    if (!ownPersonComment(doc.comments, req.params.commentId, auth.userId, res, 'deleted')) return;
    const updated = await notes.deleteComment(doc.id, String(req.params.commentId ?? ''));
    if (!updated) return res.status(404).json({ error: 'No such comment.' });
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      comments: (updated.comments ?? []).map((comment) => describeMarginComment(comment, people, auth.userId)),
    } satisfies WorkspaceCommentPostAnswer);
  });

  /**
   * Hand a note to an agent (notes #87, #234, #258): the Send under the note's
   * row of faces, going through the note instead of straight at the agent.
   *
   * The message itself is the same one-shot the agent route sends, and it is
   * still the whole of what makes the agent move. What this route adds is the
   * RECORD: the note learns, at the same moment, that it was given to this
   * agent. Before it, handing a note over touched nothing on the note — the
   * row went on saying Unclaimed through the agent's wake and its whole first
   * read, so a board of notes could not show which ones had already been dealt
   * out (note #234), and the state the user had just changed was the one thing
   * on screen that did not change (note #258).
   *
   * One route rather than the page making two calls, because the two halves
   * must not disagree: the record is written only after the turn is admitted,
   * so a busy agent (409, nothing sent) leaves no handoff behind claiming
   * otherwise, and the fresh state travels back in the same response — the
   * page repaints from the answer, with no poll in between.
   *
   * The archive is refused. Handing over a note the account has finished with
   * is asking an agent to work from something put away, and the page already
   * draws no faces there — this is the backstop for that rule, in words.
   */
  router.post('/api/notes/:number/handoff', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    const doc = await workspaceNote(auth, req, req.params.number, res);
    if (!doc) return;
    if (quickNoteIsArchived(doc)) {
      return res.status(400).json({
        error: 'This note is in the archive. Bring it back first, then hand it to an agent.',
      });
    }
    const body = (req.body ?? {}) as { agentId?: unknown };
    const agentId = typeof body.agentId === 'string' ? body.agentId : '';
    // Read BEFORE the send, because the name is what the note keeps: an agent
    // retired an hour from now must still name who this was handed to, exactly
    // as a claim keeps the name it was taken under.
    const agent = activeAgent(auth, agentId);
    const sent = await sendUserMessageToAgent(auth, agentId, req.body, res);
    if (!sent) return;
    const handedAt = new Date();
    const handoff: QuickNoteHandoff = {
      agentId,
      agentName: agent?.name ?? sent.name ?? 'an agent',
      userId: auth.userId,
      handedAt: handedAt.toISOString(),
      expiresAt: new Date(handedAt.getTime() + QUICK_NOTE_HANDOFF_WINDOW_MS).toISOString(),
    };
    // `update` merges inside the store's own transaction, so this cannot land
    // a stale copy over a claim taken between the read above and this write —
    // an agent fast enough to claim the note inside its own first second wins,
    // and the state below reports that instead.
    const updated = await notes.update(doc.id, { handoff });
    await recordPersonAction(auth, personActionLines.handedNote(doc.number, handoff.agentName));
    const people = await workspacePeople(auth);
    const work = await workspaceNoteWork(updated ?? doc);
    // 202, like the agent route: the turn has been admitted, not finished.
    return res.status(202).json({
      ok: true,
      name: handoff.agentName,
      work: describeQuickNoteWork(work, people, auth.userId),
    } satisfies WorkspaceNoteHandoffAnswer);
  });

  /**
   * Putting one away — any note of the reader's OWN, an agent's included.
   *
   * Not the same question as rewriting, and this is where the two part company
   * (Owner, note #23). Rewriting an agent's note leaves the agent contradicting
   * words it is still working from, so the Workspace does not offer it. Putting
   * one away destroys no words at all: the note is whole, in the archive, one
   * tap from being back. So a note one of the reader's agents keeps is theirs
   * to file, even though its words are not theirs to rewrite.
   *
   * What it is NOT is a verb over a teammate (note #637). A workplace shares
   * its rooms, so this route used to archive anything anyone could see — the
   * member who wrote a note would find it off their desk with nothing but a
   * timestamp to say why. The margin is what a reader has on somebody else's
   * note, and it leaves the note where its author put it.
   */
  router.post('/api/notes/:number/archive', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    const doc = await workspaceNote(auth, req, req.params.number, res);
    if (!doc) return;
    if (refuseSomebodyElsesNote(doc, auth, res, 'archive it')) return;
    if (quickNoteIsArchived(doc)) {
      return res.json({
        ok: true, number: doc.number, title: quickNoteTitle(doc.html),
      } satisfies WorkspaceNoteArchiveAnswer);
    }
    const updated = await notes.update(doc.id, {
      archivedAt: new Date().toISOString(),
      archivedByAgentId: QUICK_NOTE_AUTHOR_USER,
    });
    if (!updated) return res.status(404).json({ error: 'No such note.' });
    refreshRecapForOrg(auth.orgId);
    return res.json({
      ok: true, number: updated.number, title: quickNoteTitle(updated.html),
    } satisfies WorkspaceNoteArchiveAnswer);
  });

  /** Back out of the archive, under the number it kept the whole time — and
   *  by the same hands that could put it there (note #637). */
  router.delete('/api/notes/:number/archive', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    const doc = await workspaceNote(auth, req, req.params.number, res);
    if (!doc) return;
    if (refuseSomebodyElsesNote(doc, auth, res, 'bring it back from the archive')) return;
    if (!quickNoteIsArchived(doc)) {
      return res.json({
        ok: true, number: doc.number, title: quickNoteTitle(doc.html),
      } satisfies WorkspaceNoteArchiveAnswer);
    }
    // The ceiling of the room the note stands in — not the link's room,
    // which since note #741 may be another (or none).
    if (await notes.countByUser(doc.userId) >= QUICK_NOTES_MAX_PER_USER) {
      return res.status(400).json({
        error: `You already have ${QUICK_NOTES_MAX_PER_USER} notes — the most an account holds — so there is no room to bring this one back. Archive one of them first.`,
      });
    }
    const updated = await notes.update(doc.id, { archivedAt: undefined, archivedByAgentId: undefined });
    if (!updated) return res.status(404).json({ error: 'No such note.' });
    refreshRecapForOrg(auth.orgId);
    return res.json({
      ok: true, number: updated.number, title: quickNoteTitle(updated.html),
    } satisfies WorkspaceNoteArchiveAnswer);
  });

  /**
   * Deleting one for good — and ONLY out of the archive.
   *
   * The gate is the whole of note #23: a note is put away first, and deleting
   * is a second, deliberate act on something already off the desk. Nothing in
   * this Workspace ever sends this on a live note — the screen offers Archive
   * there — so this is a backstop rather than a path, and it refuses in words
   * instead of quietly archiving. The CLI's own DELETE does quietly archive,
   * and the difference is the client: an agent's CLI is a version already
   * installed on machines everywhere, while this page ships with the backend
   * serving it.
   *
   * The other half the agents are told in their identity block: a note of
   * yours that is gone from the list was put away or deleted on purpose — do
   * not write it again.
   *
   * And it is the reader's own archive it reaches into (note #637): the one
   * irreversible verb in this store cannot be the one place a teammate's note
   * was still within reach.
   */
  router.delete('/api/notes/:number', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    const doc = await workspaceNote(auth, req, req.params.number, res);
    if (!doc) return;
    if (refuseSomebodyElsesNote(doc, auth, res, 'delete it')) return;
    if (!quickNoteIsArchived(doc)) {
      return res.status(400).json({
        error: 'A note is archived before it is deleted. Archive this one first — you can delete it from there.',
      });
    }
    await notes.delete(doc.id);
    // The note's files go with it — best-effort, because the record is already
    // gone and a stranded object costs pennies while a failed delete costs the
    // user their tap. The whole prefix, not per-file: it also catches an
    // object a crashed upload left behind with no record pointing at it.
    if (doc.attachments?.length && deps.mediaStorage?.deleteObjectsWithPrefix) {
      // A moved note may have files under more than one historical room
      // prefix. Rooms share the org's bucket, so the bytes stay put on a move;
      // real deletion is where every prefix is swept (note #111).
      const owners = new Set([
        doc.userId,
        ...(doc.previousLocations ?? []).map((location) => location.userId),
      ]);
      Promise.all([...owners].map((owner) => deps.mediaStorage!.deleteObjectsWithPrefix!({
        prefix: quickNoteStoragePrefix(owner, doc.id),
      }))).catch((error) => console.warn(`[notes] file cleanup for note #${doc.number} failed:`, error));
    }
    // The title goes back so the confirmation can name what went — the same
    // answer the CLI's delete gives an agent, for the same reason.
    return res.json({
      ok: true, number: doc.number, title: quickNoteTitle(doc.html),
    } satisfies WorkspaceNoteArchiveAnswer);
  });

  /**
   * A file onto a note (docs/agent-quick-notes.md, attachments). Raw bytes in
   * the body with the name in a header — the same shape `agentbuilt deploy`
   * uploads a tarball in, and the reason is the same: multipart parsing buys
   * nothing when the request IS the file.
   *
   * The user may attach to ANY note, including an agent's. Attaching is not
   * editing: the Workspace's edit gate exists because rewriting an agent's
   * WORDS leaves it contradicting the note, and a file added beside them
   * changes no words.
   */
  router.post(
    '/api/notes/:number/files',
    raw({ type: () => true, limit: QUICK_NOTE_SINGLE_UPLOAD_MAX_BYTES + 1024 }),
    async (req, res) => {
      const auth = await authenticate(req, res);
      if (!auth) return;
      const notes = workspaceNotes(res);
      if (!notes) return;
      if (!deps.mediaStorage) {
        return res.status(503).json({ error: 'File storage is not available on this backend yet.' });
      }
      const doc = await workspaceNote(auth, req, req.params.number, res);
      if (!doc) return;
      if (quickNoteIsArchived(doc)) {
        return res.status(400).json({
          error: 'This note is archived. Bring it back to the notes list first, then attach to it.',
        });
      }
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
        addedByAgentId: QUICK_NOTE_AUTHOR_USER,
        addedByUserId: auth.userId,
        addedAt: new Date().toISOString(),
      };
      attachment.storagePath = quickNoteAttachmentPath(doc.userId, doc.id, attachment.id, fileName);
      // Bytes first, record second: a crash between the two leaves an object
      // nothing points at (cleaned when the note goes), never a row promising
      // a file that does not exist.
      await deps.mediaStorage.uploadObject({
        storagePath: attachment.storagePath,
        contentType: attachment.contentType,
        data,
      });
      const updated = await notes.update(doc.id, {
        attachments: [...(doc.attachments ?? []), attachment],
        updatedAt: new Date().toISOString(),
      });
      if (!updated) return res.status(404).json({ error: 'No such note.' });
      return res.json({
        ok: true, attachments: describeNoteAttachments(updated, auth.userId),
      } satisfies WorkspaceNoteFilesAnswer);
    },
  );

  // A note's file in parts (note #784, `services/note-file-uploads.ts`):
  // anything past one 8 MB part — up to 100 MB — goes start, parts,
  // complete, because the Workspace's front door refuses a body over
  // 100 MB and this server holds no more of a file than one part.
  const noteFileUpload = async (
    req: Request, res: Response,
    act: (doc: QuickNoteDocument, uploads: NoteFileUploads, notes: QuickNoteStorage, auth: MiniAppAuth) => Promise<unknown>,
  ) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    if (!deps.mediaStorage) return res.status(503).json({ error: 'File storage is not available on this backend yet.' });
    const doc = await workspaceNote(auth, req, req.params.number, res);
    if (!doc) return;
    if (quickNoteIsArchived(doc)) {
      return res.status(400).json({ error: 'This note is archived. Bring it back to the notes list first, then attach to it.' });
    }
    try {
      return await act(doc, new NoteFileUploads(deps.mediaStorage), notes, auth);
    } catch (error) {
      if (error instanceof NoteFileUploadError) return res.status(error.status).json({ error: error.message });
      console.warn('[notes] a file upload step failed');
      return res.status(503).json({ error: 'The file could not be saved just now. Try again.' });
    }
  };
  router.post('/api/notes/:number/files/uploads', (req, res) => noteFileUpload(req, res, async (doc, uploads) => (
    res.status(201).json(await uploads.start(doc, { fileName: req.body?.fileName, sizeBytes: req.body?.sizeBytes, contentType: req.body?.contentType }))
  )));
  router.put(
    '/api/notes/:number/files/uploads/:id/parts/:part',
    raw({ type: () => true, limit: UPLOAD_PART_BYTES }),
    (req, res) => noteFileUpload(req, res, async (doc, uploads) => res.json(await uploads.part(doc, String(req.params.id), {
      uploadId: req.query.upload, fileName: req.query.name, partNumber: req.params.part,
      data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    }))),
  );
  router.post('/api/notes/:number/files/uploads/:id/complete', (req, res) => noteFileUpload(req, res, async (doc, uploads, notes, auth) => {
    const attachment = await uploads.complete(doc, String(req.params.id), {
      uploadId: req.body?.uploadId, fileName: req.body?.fileName, contentType: req.body?.contentType, parts: req.body?.parts,
      addedBy: { addedByAgentId: QUICK_NOTE_AUTHOR_USER, addedByUserId: auth.userId },
    });
    const updated = await notes.update(doc.id, {
      attachments: [...(doc.attachments ?? []), attachment],
      updatedAt: new Date().toISOString(),
    });
    if (!updated) { await uploads.discard(attachment); return res.status(404).json({ error: 'No such note.' }); }
    return res.json({ ok: true, attachments: describeNoteAttachments(updated, auth.userId) } satisfies WorkspaceNoteFilesAnswer);
  }));
  router.delete('/api/notes/:number/files/uploads/:id', (req, res) => noteFileUpload(req, res, async (doc, uploads) => {
    await uploads.abort(doc, String(req.params.id), { uploadId: req.query.upload, fileName: req.query.name });
    return res.json({ ok: true });
  }));

  /**
   * A short-lived signed URL for one file, on demand. A URL and not a
   * redirect, because the page's fetches carry auth headers a browser
   * navigation would not — the page asks, then opens what it is given.
   */
  router.get('/api/notes/:number/files/:id', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!workspaceNotes(res)) return;
    if (!deps.mediaStorage) {
      return res.status(503).json({ error: 'File storage is not available on this backend yet.' });
    }
    const doc = await workspaceNote(auth, req, req.params.number, res);
    if (!doc) return;
    const attachment = (doc.attachments ?? []).find((a) => a.id === String(req.params.id));
    if (!attachment) return res.status(404).json({ error: 'No such file on this note.' });
    const access = await deps.mediaStorage.createReadAccess({
      storagePath: attachment.storagePath,
      expiresInMs: 15 * 60_000,
      ...readDisposition(req, attachment),
    });
    return res.json({
      url: access.url, fileName: attachment.fileName, expiresAt: access.expiresAt,
    } satisfies WorkspaceFileAccessAnswer);
  });

  /** Take a file off a note. Anyone on the account, like attaching. */
  router.delete('/api/notes/:number/files/:id', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const notes = workspaceNotes(res);
    if (!notes) return;
    const doc = await workspaceNote(auth, req, req.params.number, res);
    if (!doc) return;
    // Downloading one off an archived note is fine — reading is what the
    // archive is for. Taking one off is a write, and waits for the restore.
    if (quickNoteIsArchived(doc)) {
      return res.status(400).json({
        error: 'This note is archived. Bring it back to the notes list first, then change its files.',
      });
    }
    const attachment = (doc.attachments ?? []).find((a) => a.id === String(req.params.id));
    if (!attachment) return res.status(404).json({ error: 'No such file on this note.' });
    const updated = await notes.update(doc.id, {
      attachments: (doc.attachments ?? []).filter((a) => a.id !== attachment.id),
      updatedAt: new Date().toISOString(),
    });
    if (!updated) return res.status(404).json({ error: 'No such note.' });
    // Record first, bytes second — the mirror of the upload's order, and for
    // the same reason: the failure mode is a stranded object, never a row
    // promising bytes that are gone.
    deps.mediaStorage?.deleteObject?.({ storagePath: attachment.storagePath })
      .catch((error) => console.warn(`[notes] deleting ${attachment.fileName} from storage failed:`, error));
    return res.json({
      ok: true, attachments: describeNoteAttachments(updated, auth.userId),
    } satisfies WorkspaceNoteFilesAnswer);
  });

  /**
   * A knowledge proposal, with everything the decision needs on one screen:
   * what each change would make the page say, and — for an edit — what it says
   * now. Both as source; both rendered by the page.
   */
  router.get('/api/knowledge/proposals/:id', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth.userId, auth.orgId, res);
    if (!knowledge) return;
    const doc = await deps.knowledgeProposalStorage!.get(String(req.params.id ?? ''));
    if (!doc || !(await viewerNamespaces(auth)).includes(doc.userId)) {
      return res.status(404).json({ error: 'No such proposal on this account' });
    }
    const changes = await Promise.all(doc.changes.map(async (change) => {
      // The current version comes from the base, not from the proposal: an
      // edit written an hour ago must be compared against what the page says
      // NOW, which is also what the landing re-checks.
      const current = change.action === 'create'
        ? null
        : await knowledge.service.readPage(doc.userId, change.page);
      return {
        page: change.page,
        action: change.action,
        ...(change.renameTo ? { renameTo: change.renameTo } : {}),
        ...(change.title ? { title: change.title } : {}),
        ...(change.description ? { description: change.description } : {}),
        ...(change.html ? { html: change.html } : {}),
        ...(current ? { currentHtml: current.content } : {}),
        // The files this change would leave the page with, resolved — so the
        // PREVIEW shows the picture too. Reading a page "as it will look"
        // with its diagram missing is reading a different page, and this is
        // the screen where the decision is made (notes #10/#18).
        ...(await signKnowledgeFiles(change.attachments)),
        // Whether the page moved since the proposal was written. Said on the
        // screen rather than discovered at the tap: an approval that would be
        // refused should not look like one that will work.
        ...(current && change.baseSha && current.sha !== change.baseSha ? { moved: true } : {}),
      };
    }));
    const people = await workspacePeople(auth);
    return res.json({
      proposal: {
        ...describeKnowledgeProposal(doc, people, auth.userId),
        id: doc.id,
        canDecide: proposalOwnedByViewer(auth, doc) && !doc.draft,
        // The margin, whole (note #66), beside the change it is about.
        comments: (doc.comments ?? []).map((comment) => describeMarginComment(comment, people, auth.userId)),
      },
      changes,
    } satisfies WorkspaceKnowledgeProposalDetailAnswer);
  });

  /** The person's remark on a knowledge proposal (note #66) — the PR comment
   *  route on the other decision queue, under the same rules. */
  router.post('/api/knowledge/proposals/:id/comments', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth.userId, auth.orgId, res);
    if (!knowledge) return;
    const doc = await deps.knowledgeProposalStorage!.get(String(req.params.id ?? ''));
    if (!doc || !(await viewerNamespaces(auth)).includes(doc.userId)) {
      return res.status(404).json({ error: 'No such proposal on this account' });
    }
    if (!knowledgeProposalTakesComments(doc.status) && !(doc.direct && doc.status === 'approved')) {
      return res.status(409).json({ error: `This proposal is ${doc.status} — its margin closed with the decision.` });
    }
    if ((doc.comments?.length ?? 0) >= MAX_COMMENTS) {
      return res.status(400).json({ error: `This proposal already carries ${MAX_COMMENTS} comments — the most one holds.` });
    }
    const html = commentHtmlFromText((req.body ?? {}) as Record<string, unknown>, res);
    if (html === null) return;
    const updated = await deps.knowledgeProposalStorage!.addComment(doc.id, newMarginComment(COMMENT_AUTHOR_USER, html, auth.userId));
    if (!updated) return res.status(404).json({ error: 'No such proposal on this account' });
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      comments: (updated.comments ?? []).map((comment) => describeMarginComment(comment, people, auth.userId)),
    } satisfies WorkspaceCommentPostAnswer);
  });

  /** The knowledge decision queue follows the change queue's margin rule:
   *  only the current person's own words, and only while it is open. */
  router.put('/api/knowledge/proposals/:id/comments/:commentId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth.userId, auth.orgId, res);
    if (!knowledge) return;
    const doc = await deps.knowledgeProposalStorage!.get(String(req.params.id ?? ''));
    if (!doc || !(await viewerNamespaces(auth)).includes(doc.userId)) {
      return res.status(404).json({ error: 'No such proposal on this account' });
    }
    if (!knowledgeProposalTakesComments(doc.status) && !(doc.direct && doc.status === 'approved')) {
      return res.status(409).json({ error: `This proposal is ${doc.status} — its margin closed with the decision.` });
    }
    if (!ownPersonComment(doc.comments, req.params.commentId, auth.userId, res)) return;
    const html = commentHtmlFromText((req.body ?? {}) as Record<string, unknown>, res);
    if (html === null) return;
    const updated = await deps.knowledgeProposalStorage!.editComment(
      doc.id,
      String(req.params.commentId ?? ''),
      html,
      new Date().toISOString(),
    );
    if (!updated) return res.status(404).json({ error: 'No such comment.' });
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      comments: (updated.comments ?? []).map((comment) => describeMarginComment(comment, people, auth.userId)),
    } satisfies WorkspaceCommentPostAnswer);
  });

  /** And the same withdrawal, on the knowledge queue's margin. */
  router.delete('/api/knowledge/proposals/:id/comments/:commentId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const knowledge = await requireKnowledge(auth.userId, auth.orgId, res);
    if (!knowledge) return;
    const doc = await deps.knowledgeProposalStorage!.get(String(req.params.id ?? ''));
    if (!doc || !(await viewerNamespaces(auth)).includes(doc.userId)) {
      return res.status(404).json({ error: 'No such proposal on this account' });
    }
    if (!knowledgeProposalTakesComments(doc.status) && !(doc.direct && doc.status === 'approved')) {
      return res.status(409).json({ error: `This proposal is ${doc.status} — its margin closed with the decision.` });
    }
    if (!ownPersonComment(doc.comments, req.params.commentId, auth.userId, res, 'deleted')) return;
    const updated = await deps.knowledgeProposalStorage!.deleteComment(doc.id, String(req.params.commentId ?? ''));
    if (!updated) return res.status(404).json({ error: 'No such comment.' });
    const people = await workspacePeople(auth);
    return res.json({
      ok: true,
      comments: (updated.comments ?? []).map((comment) => describeMarginComment(comment, people, auth.userId)),
    } satisfies WorkspaceCommentPostAnswer);
  });

  /**
   * The owner's decision. Body: `{ decision: 'approve' | 'reject', note? }`.
   * The flow lives in the agent service — same as proposals — so the landing,
   * the conflict rule and the hand-back to the agent have one home.
   */
  router.post('/api/knowledge/proposals/:id/decision', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.decideKnowledgeProposal) {
      return res.status(503).json({ error: 'Knowledge pages are not available on this backend yet' });
    }
    const doc = await deps.knowledgeProposalStorage?.get(String(req.params.id ?? ''));
    if (!doc || !(await viewerNamespaces(auth)).includes(doc.userId)) {
      return res.status(404).json({ error: 'No such proposal on this account' });
    }
    if (!proposalOwnedByViewer(auth, doc)) {
      return res.status(403).json({ error: 'Only the owner of the agent that proposed this page can decide it.' });
    }
    if (doc.status === 'open' && !knowledgeProposalAwaitsDecision(doc)) {
      return res.status(409).json({ error: `Knowledge proposal #${doc.number} is not ready yet — the agent is still working on it and will invite you when it is.` });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = body.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({ error: "Pass decision: 'approve' or 'reject'" });
    }
    const note = body.note;
    const result = await deps.decideKnowledgeProposal({
      userId: auth.userId,
      proposalId: String(req.params.id ?? ''),
      decision,
      // A reason travels with a rejection only — an approval explains itself.
      ...(decision === 'reject' && typeof note === 'string' && note.trim()
        ? { note: note.trim().slice(0, MAX_KNOWLEDGE_DECISION_NOTE_LENGTH) }
        : {}),
    });
    await recordPersonAction(auth, personActionLines.decidedKnowledge(decision, doc.number, doc.title));
    refreshRecapForOrg(auth.orgId);
    return res.json({ ok: true, ...result } satisfies WorkspaceKnowledgeDecisionAnswer);
  });

  /**
   * Create an agent from the Workspace. The response answers the gates
   * (capacity, one-at-a-time); setup continues in the background and its
   * progress appears in the agent's browser chat. The pending agent shows up
   * in /api/state within moments.
   */
  router.post('/api/agents', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.agentLifecycle) {
      return res.status(503).json({ error: 'Agent management is not available on this backend yet' });
    }
    // The harness pick, made once at creation and kept for life. Absent means
    // claude (pages older than the chooser still create agents); anything
    // else is a request this product does not take.
    const body = (req.body ?? {}) as { cli?: unknown };
    const cli = body.cli ?? 'claude';
    if (typeof cli !== 'string' || !isHarnessCli(cli)) {
      return res.status(400).json({ error: 'Unknown agent type.' });
    }
    if (!auth.orgId) {
      return res.status(400).json({ error: 'Open a workplace first — every agent belongs to one.' });
    }
    if (await refuseWhileDeleting(auth.orgId, res, 'no new agent can start there')) return;
    // Carry the authenticated context through the asynchronous setup. Reading
    // "active org" again after this response would let a quick workspace
    // switch move the new agent into a different workplace.
    const result = await deps.agentLifecycle.createAgent(auth.userId, cli, auth.orgId);
    if (!result.ok) {
      // Written for a human (capacity refusals include the upgrade pitch) —
      // pass it through, exactly like the secrets service's refusals.
      return res.status(400).json({ error: result.reason });
    }
    return res.json({ ok: true } satisfies WorkspaceAgentCreatedAnswer);
  });

  /**
   * Every proposal one of the viewer's agents has made, of BOTH kinds, each
   * half newest first. A repository already owns its own change-proposal
   * history and the knowledge base owns its own; this is the inverse view for
   * an agent detail screen, across the repositories and rooms where that
   * agent worked (note #276). Only the caller's active agent can name this
   * route, and only namespaces in the active workplace are searched.
   *
   * The two halves are guarded separately. A backend with a knowledge base
   * and no git host still has an answer to give about its agents, and the
   * 503 is for the case where neither store can say anything at all.
   */
  router.get('/api/agents/:id/prs', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const agentId = String(req.params.id ?? '');
    if (!activeAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const hasChanges = Boolean(deps.gitPullRequestStorage && deps.gitRepoStorage);
    // Listing knowledge proposals reads the documents alone — unlike the
    // pages themselves, which need the git host behind the base.
    const hasKnowledge = Boolean(deps.knowledgeProposalStorage);
    if (!hasChanges && !hasKnowledge) {
      return res.status(503).json({ error: 'Proposals are not available on this backend yet' });
    }
    const namespaces = [...new Set(await viewerNamespaces(auth))];
    // `createdByUserId` is a second ownership proof for new records. The
    // legacy fallback remains the caller's active agent record, exactly as
    // proposal decisions do elsewhere in this router.
    const proposedByThisAgent = (doc: { createdByUserId?: string; createdByAgentId: string }): boolean => (
      doc.createdByAgentId === agentId && proposalOwnedByViewer(auth, doc)
    );
    const newestFirst = (a: { createdAt: string }, b: { createdAt: string }) => (
      b.createdAt.localeCompare(a.createdAt)
    );
    const [changeDocs, knowledgeDocs] = await Promise.all([
      hasChanges
        ? Promise.all(namespaces.map((namespaceId) => deps.gitPullRequestStorage!.listByUser(namespaceId)))
          .then((byNamespace) => byNamespace.flat().filter(proposedByThisAgent).sort(newestFirst))
        : [],
      hasKnowledge
        ? Promise.all(namespaces.map((namespaceId) => deps.knowledgeProposalStorage!.listByUser(namespaceId)))
          .then((byNamespace) => byNamespace.flat().filter(proposedByThisAgent).sort(newestFirst))
        : [],
    ]);
    const people = await workspacePeople(auth);
    const prs = await Promise.all(changeDocs.map(async (doc) => {
      const repo = await deps.gitRepoStorage!.get(doc.repoId);
      return describeProposal(doc, repo?.name ?? '(deleted repo)', people, auth.userId);
    }));
    const knowledgeProposals = knowledgeDocs.map((doc) => describeKnowledgeProposal(doc, people, auth.userId));
    return res.json({ prs, knowledgeProposals } satisfies WorkspaceAgentProposalsAnswer);
  });

  /**
   * Every decision waiting on this viewer, in EVERY room of the workplace
   * (note #721): the agents picker's All tab, which lists every room's agents
   * and so owes the reader every room's queue too. The state payload carries
   * only the viewed room's (note #98), and the hot read every screen waits on
   * is no place to add the rest — this is read when the tab is.
   *
   * The same rules as the room queue, applied without the room filter: a
   * quiet proposal is not in it (note #293), nor one only another member may
   * decide. Oldest first, changes before knowledge, as a room lists them.
   */
  router.get('/api/decisions', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const hasChanges = Boolean(deps.gitPullRequestStorage && deps.gitRepoStorage);
    const hasKnowledge = Boolean(deps.knowledgeProposalStorage && deps.gitHostClient);
    const namespaces = hasChanges || hasKnowledge ? [...new Set(await viewerNamespaces(auth))] : [];
    const oldestFirst = (a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt);
    const [changeDocs, knowledgeDocs] = await Promise.all([
      hasChanges
        ? Promise.all(namespaces.map((namespaceId) => deps.gitPullRequestStorage!.listOpenByUser(namespaceId)))
          .then((byNamespace) => byNamespace.flat()
            .filter((doc) => pullRequestAwaitsDecision(doc) && proposalOwnedByViewer(auth, doc)))
        : [],
      hasKnowledge
        ? Promise.all(namespaces.map((namespaceId) => deps.knowledgeProposalStorage!.listOpenByUser(namespaceId)))
          .then((byNamespace) => byNamespace.flat()
            .filter((doc) => knowledgeProposalAwaitsDecision(doc) && proposalOwnedByViewer(auth, doc)))
        : [],
    ]);
    // One proposal, one row, whichever namespaces listed it.
    const once = <T extends { id: string }>(docs: T[]): T[] => [...new Map(docs.map((doc) => [doc.id, doc])).values()];
    const people = await workspacePeople(auth);
    const prs = await Promise.all(once(changeDocs).sort(oldestFirst).map(async (doc) => {
      const repo = await deps.gitRepoStorage!.get(doc.repoId);
      return {
        ...describeProposal(doc, repo?.name ?? '(deleted repo)', people, auth.userId),
        canDecide: true,
        ...(await checksSummary(deps, doc.repoId, doc.headSha)),
      };
    }));
    const knowledgeProposals = once(knowledgeDocs).sort(oldestFirst).map((doc) => ({
      ...describeKnowledgeProposal(doc, people, auth.userId),
      canDecide: true,
    }));
    return res.json({ prs, knowledgeProposals } satisfies WorkspaceDecisionsAnswer);
  });

  /**
   * SOMEBODY ELSE'S AGENT (note #640): the read-only card every face in this
   * workplace can now open.
   *
   * The fleet payload is the READER's own agents, so a teammate's agent — the
   * one behind most faces on a shared shelf — had nothing behind its picture
   * at all. This answers for any agent of any member of the workplace on
   * screen, with the facts that workplace can already see: what it is, what
   * it runs, which room it works in, whether it is working right now, who
   * drives it, and what it last did.
   *
   * What it does NOT carry is the machine, the version, the chat, the
   * proposals or a single control — those belong to the person driving it
   * (note #346), and the reader's own agent has its own screen for them. An
   * own agent is answered too, flagged `yours`, so the screen can send them
   * there rather than draw a read-only copy of their own.
   *
   * A member's private Workspace Agent is nobody else's to open: it answers
   * 404 exactly as an agent in another workplace does.
   */
  router.get('/api/agents/:id/card', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const agentId = String(req.params.id ?? '');
    const found = await workplaceAgentRecord(auth, agentId);
    const record = found?.record;
    if (!found || !record || record.purpose) {
      return res.status(404).json({ error: 'No such agent in this workplace.' });
    }
    // The workplace on screen, not merely a workplace they share: an agent
    // belongs to one permanently, and its page belongs beside its own work.
    const belongs = record.orgId ? record.orgId === auth.orgId : auth.orgId === auth.legacyOrgId;
    if (!belongs) return res.status(404).json({ error: 'No such agent in this workplace.' });
    const yours = found.ownerUserId === auth.userId;
    const people = await workspacePeople(auth);
    const supportedCli = isSupportedAgentCli(record.cli);
    const effectiveModel = supportedCli ? resolveEffectiveModel(record.cli, record.model) : undefined;
    const ownerName = people.name(found.ownerUserId);
    const ownerPhoto = people.photoUrl(found.ownerUserId);
    return res.json({
      agent: {
        id: record.id,
        name: record.name,
        cli: record.cli,
        ...(supportedCli && effectiveModel
          ? {
            model: modelCatalogForCli(record.cli)
              .find((option) => option.value === effectiveModel)?.label ?? effectiveModel,
            effort: resolveEffectiveEffort(record.cli, record.model, record.effort),
          }
          : {}),
        ...(agentFaceUrl(record.name) ? { avatarUrl: agentFaceUrl(record.name) } : {}),
        // Coarse on purpose (see the answer type): a machine that has never
        // connected is still being built, and everything else reads Ready.
        // Whether its OWNER has a subscription to sign in is their business.
        status: record.connectedAt ? 'ready' as const : 'setting-up' as const,
        ...(deps.agentLifecycle?.isAgentWorking?.(found.ownerUserId, record.id)
          ? { working: true as const }
          : {}),
        // What it last DID — the same line its own row wears on its owner's
        // Home, and the one fact that tells one face from another (note
        // #295). The live narration of a turn in progress is deliberately
        // not here: that is the owner watching their own agent work.
        ...(record.recap?.text ? { recap: record.recap.text } : {}),
        ...(record.recap?.at ? { recapAt: record.recap.at } : {}),
        ...(record.lastActivityAt ? { lastActiveAt: record.lastActivityAt } : {}),
        ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      },
      owner: {
        userId: found.ownerUserId,
        ...(ownerName ? { name: ownerName } : {}),
        ...(ownerPhoto ? { photoUrl: ownerPhoto } : {}),
        ...(yours ? { you: true as const } : {}),
      },
      ...(yours ? { yours: true as const } : {}),
    } satisfies WorkspaceAgentCardAnswer);
  });

  /**
   * The per-agent version card — CLI version vs the fleet pin, machine
   * software state — plus its two update actions. This surface replaced the
   * agent chat keyboard's Version view. Reads never wake a machine; the
   * update actions are the user explicitly asking for work and may.
   */
  router.get('/api/agents/:id/version', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.agentLifecycle?.agentVersion) {
      return res.status(503).json({ error: 'Version info is not available on this backend yet' });
    }
    const agentId = String(req.params.id ?? '');
    // An HTTP param carries no guarantee the agent is the caller's own —
    // check the profile before acting, like the delete route.
    if (!machineOwnedAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const info = await deps.agentLifecycle.agentVersion(auth.userId, agentId);
    if (!info) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    return res.json(info satisfies WorkspaceAgentVersionAnswer);
  });

  /**
   * The model and effort an agent will use on its NEXT turn, plus the curated
   * choices for its CLI. Both the chat header and the agent screen open the
   * same picker, so this response is their one catalog rather than a second
   * copy of the CLI rules in the page.
   */
  const agentRuntimeResponse = (agent: AgentRecord) => {
    if (!isSupportedAgentCli(agent.cli)) return null;
    const model = resolveEffectiveModel(agent.cli, agent.model);
    return {
      cli: agent.cli,
      model,
      effort: resolveEffectiveEffort(agent.cli, agent.model, agent.effort),
      models: modelCatalogForCli(agent.cli).map((option) => ({
        value: option.value,
        label: option.label,
        efforts: option.efforts.map((effort) => ({
          value: effort.value,
          label: effort.label,
          ...(effort.heavy ? { heavy: true } : {}),
        })),
      })),
    };
  };

  /**
   * The Visits list on a sealed guide's screen (note #1010): every visitor's
   * conversation, kept 90 days, read only by the guide's owner. Nothing about
   * a visitor beyond what they typed.
   */
  router.get('/api/agents/:id/visits', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const agent = activeAgent(auth, String(req.params.id ?? ''));
    if (!agent || !isSealedAgent(agent)) return res.status(404).json({ error: 'No such agent on this account' });
    if (!deps.publicGuide) return res.json({ visits: [], keptDays: PUBLIC_GUIDE_LIMITS.transcriptDays } satisfies WorkspacePublicGuideVisitsAnswer);
    return res.json(await deps.publicGuide.listVisits(agent.id) satisfies WorkspacePublicGuideVisitsAnswer);
  });

  router.get('/api/agents/:id/visits/:visitId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const agent = activeAgent(auth, String(req.params.id ?? ''));
    if (!agent || !isSealedAgent(agent) || !deps.publicGuide) return res.status(404).json({ error: 'No such agent on this account' });
    const visit = await deps.publicGuide.getVisit(agent.id, String(req.params.visitId ?? ''));
    return visit ? res.json({ visit } satisfies WorkspacePublicGuideVisitAnswer) : res.status(404).json({ error: 'That visit is no longer kept.' });
  });

  router.get('/api/agents/:id/runtime', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const agent = activeAgent(auth, String(req.params.id ?? ''));
    if (!agent) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const runtime = agentRuntimeResponse(agent);
    if (!runtime) {
      return res.status(400).json({ error: 'This agent no longer has a supported model picker.' });
    }
    return res.json(runtime satisfies WorkspaceAgentRuntimeAnswer);
  });

  /**
   * Change one or both halves of an agent's runtime. A model change keeps the
   * stored effort only when the new model supports it; otherwise that field is
   * cleared and the new model's effective default is returned. The running
   * process is deliberately untouched — a turn already launched keeps the
   * command it started with and this choice begins on the next one.
   */
  router.post('/api/agents/:id/runtime', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const agentId = String(req.params.id ?? '');
    const agent = activeAgent(auth, agentId);
    if (!agent) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    if (!isSupportedAgentCli(agent.cli)) {
      return res.status(400).json({ error: 'This agent no longer has a supported model picker.' });
    }
    // A sealed guide's model is its kind's (note #1010); the harness runs it on that whatever is stored.
    if (isSealedAgent(agent)) {
      return res.status(409).json({ error: 'The public guide always runs on sonnet at medium effort.' });
    }
    if (!deps.userStorage) {
      return res.status(503).json({ error: 'Model settings are not available right now' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const changesModel = Object.prototype.hasOwnProperty.call(body, 'model');
    const changesEffort = Object.prototype.hasOwnProperty.call(body, 'effort');
    if (!changesModel && !changesEffort) {
      return res.status(400).json({ error: 'Choose a model or an effort to change.' });
    }

    // The one rule the Chief of Staff's `agentbuilt agent model` writes by
    // too (note #776), so the two can never store different pairs.
    const plan = planRuntimeChange(agent.cli, agent, {
      ...(changesModel ? { model: typeof body.model === 'string' ? body.model.trim() : resolveEffectiveModel(agent.cli, agent.model) } : {}),
      ...(changesEffort ? { effort: typeof body.effort === 'string' ? body.effort.trim() : '' } : {}),
    });
    if (!plan.ok) {
      return res.status(400).json({
        error: plan.field === 'model' ? 'Choose one of the models offered for this agent.' : 'Choose an effort offered for that model.',
      });
    }
    const { updates } = plan;

    // The person's own pick: what the agent runs on is theirs now, and a
    // change the Workspace Agent made before it is no longer news.
    const written = await deps.userStorage.updateAgentFields(auth.userId, agentId, {
      ...updates,
      ...(agent.runtimeChange ? { runtimeChange: null } : {}),
    });
    if (!written) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const updated: AgentRecord = {
      ...agent,
      ...(updates.model ? { model: updates.model } : {}),
      ...(updates.effort === null ? { effort: undefined }
        : updates.effort ? { effort: updates.effort } : {}),
    };
    // The CLI was proved supported above, so the catalog is there.
    const runtime = agentRuntimeResponse(updated)!;
    return res.json({ ok: true, ...runtime } satisfies WorkspaceAgentRuntimeWritten);
  });

  router.post('/api/agents/:id/update-cli', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.agentLifecycle?.updateAgentCli) {
      return res.status(503).json({ error: 'Updates are not available on this backend yet' });
    }
    const agentId = String(req.params.id ?? '');
    if (!machineOwnedAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const result = await deps.agentLifecycle.updateAgentCli(auth.userId, agentId);
    if (!result.ok) {
      return res.status(400).json({ error: result.reason });
    }
    return res.json({ ok: true });
  });

  // The app asks the "restarts the machine — running apps stop" question
  // before calling; this endpoint is the act itself.
  router.post('/api/agents/:id/update-machine', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.agentLifecycle?.updateAgentMachine) {
      return res.status(503).json({ error: 'Updates are not available on this backend yet' });
    }
    const agentId = String(req.params.id ?? '');
    if (!machineOwnedAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const result = await deps.agentLifecycle.updateAgentMachine(auth.userId, agentId);
    if (!result.ok) {
      return res.status(400).json({ error: result.reason });
    }
    return res.json({ ok: true });
  });

  /**
   * What this agent's machine is made of, and what else it could be
   * (note #268). Read when the machine screen opens, and again after a
   * successful change so the screen settles on Fly's own answer rather than
   * on what it asked for.
   */
  router.get('/api/agents/:id/machine', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.agentLifecycle?.agentMachine) {
      return res.status(503).json({ error: 'Machine details are not available on this backend yet' });
    }
    const agentId = String(req.params.id ?? '');
    // An HTTP param carries no guarantee the agent is the caller's own —
    // the same check the version and delete routes make before acting.
    const machineAgent = machineOwnedAgent(auth, agentId);
    if (!machineAgent) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const info = await deps.agentLifecycle.agentMachine(auth.userId, agentId);
    if (!info) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    return res.json(info satisfies WorkspaceAgentMachineAnswer);
  });

  /**
   * Move the machine onto another size. The app asks the "it restarts now"
   * question first when the machine is AWAKE — a sleeping one is changed with
   * nothing running on it and nobody interrupted — but the refusal that
   * matters is enforced here: never during the agent's own turn.
   *
   * Answers with the machine read back from Fly, so a change that half
   * happened cannot leave the screen claiming the size it asked for.
   */
  router.post('/api/agents/:id/machine', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const lifecycle = deps.agentLifecycle;
    if (!lifecycle?.resizeAgentMachine || !lifecycle.agentMachine) {
      return res.status(503).json({ error: 'Changing the machine is not available on this backend yet' });
    }
    const agentId = String(req.params.id ?? '');
    const machineAgent = machineOwnedAgent(auth, agentId);
    if (!machineAgent) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const size = typeof (req.body as { size?: unknown } | undefined)?.size === 'string'
      ? String((req.body as { size?: unknown }).size).trim()
      : '';
    if (!size) {
      return res.status(400).json({ error: 'Choose a machine size.' });
    }
    const result = await lifecycle.resizeAgentMachine(auth.userId, agentId, size);
    if (!result.ok) {
      return res.status(400).json({ error: result.reason });
    }
    const info = await lifecycle.agentMachine(auth.userId, agentId);
    if (!info) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    return res.json({
      ...info,
      ok: true,
      changed: result.changed,
      // From the write, not the read: a machine rebooting onto its new size
      // reads as neither awake nor asleep for a few seconds, and the screen
      // needs to know which of the two it is going to say.
      restarted: result.changed && result.awake,
    } satisfies WorkspaceAgentMachineWritten);
  });

  /**
   * The one-shot Send itself: check the agent is this caller's, check the
   * words, admit the turn — and answer the failures in the exact shape the
   * page already knows how to read, `code` included, because that is what
   * tells it apart a busy agent (pick another) from a restarting backend
   * (hold the tap and try again).
   *
   * Shared rather than copied since notes #234/#258 gave the note's own Send a
   * route of its own: the two differ only in what they do AFTER the message
   * lands, and an idle-only rule enforced in two places is an idle-only rule
   * that will one day be enforced in one. Returns the recipient on success and
   * null once it has answered, on the same convention `authenticate` uses.
   */
  const sendUserMessageToAgent = async (
    auth: MiniAppAuth,
    agentId: string,
    body: unknown,
    res: Response,
  ): Promise<{ name?: string } | null> => {
    const send = deps.agentLifecycle?.messageAgentFromUser;
    if (!send) {
      res.status(503).json({ error: 'Messaging an agent is not available on this backend yet' });
      return null;
    }
    // An HTTP param carries no guarantee the agent is the caller's own — the
    // same check the delete and version routes make before acting.
    if (!activeAgent(auth, agentId)) {
      res.status(404).json({ error: 'No such agent on this account' });
      return null;
    }
    const message = typeof (body as { message?: unknown } | undefined)?.message === 'string'
      ? String((body as { message?: unknown }).message).trim()
      : '';
    if (!message) {
      res.status(400).json({ error: 'Write something to send.' });
      return null;
    }
    if (message.length > AGENT_USER_MESSAGE_MAX_LENGTH) {
      res.status(400).json({
        error: `That message is ${message.length} characters — keep it under ${AGENT_USER_MESSAGE_MAX_LENGTH}.`,
      });
      return null;
    }
    const result = await send({ userId: auth.userId, agentId, message });
    if (!result.ok) {
      res.status(result.code === 'busy' ? 409 : result.code === 'not_found' ? 404 : 503)
        .json({ error: result.reason, code: result.code });
      return null;
    }
    return { name: result.recipient.name };
  };

  /**
   * Send one of the user's idle agents a message they wrote here (notes
   * #87/#327): the Send under a document's row of faces, which turns a note
   * into work or asks for a proposal review without a trip out to the agent's
   * own chat to retype the request.
   *
   * Idle-only, and a busy agent is a 409 rather than a queue — the same
   * contract `agentbuilt agent message` has, for the same reason: a message
   * accepted "for later" hides an unbounded wait behind a green button. The
   * agent still answers in its OWN chat, which is why the page says so.
   */
  router.post('/api/agents/:id/message', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const sent = await sendUserMessageToAgent(auth, String(req.params.id ?? ''), req.body, res);
    if (!sent) return;
    await recordPersonAction(auth, personActionLines.messaged(sent.name));
    return res.status(202).json({ ok: true, name: sent.name } satisfies WorkspaceIdleMessageAnswer);
  });

  /**
   * The room's "Reset finished agents" (note #707). The page sends the agents
   * it NAMED in its confirmation, and each is judged again here, off the
   * records as they stand at the press — a turn that started, a proposal
   * that opened or a note that was claimed since the page drew its list
   * keeps that agent's conversation. Every agent still safe is sent the
   * owner's own "reset chat" through the same idle-only door as the agent
   * screen's single button: an ask, so it saves what matters first.
   *
   * Never a queue: an agent that turned busy in between is reported back,
   * by name, with the reason, and nothing is sent to it.
   */
  router.post('/api/agents/fresh-chats', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const send = deps.agentLifecycle?.messageAgentFromUser;
    if (!send) {
      return res.status(503).json({ error: 'Messaging an agent is not available on this backend yet' });
    }
    const ids = (req.body as Partial<WorkspaceFreshChatsRequest> | undefined)?.agentIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > FRESH_CHATS_MAX_AGENTS || !ids.every((id) => typeof id === 'string' && id)) {
      return res.status(400).json({ error: 'Send { agentIds }: the agents to ask for a fresh chat.' });
    }
    // An open proposal — a draft too, which means the agent has not finished
    // proposing — and a held note are what the page knew least recently.
    // When either cannot be read, nobody is reset on a guess.
    const [openPrs, claims] = await Promise.all([
      deps.gitPullRequestStorage ? deps.gitPullRequestStorage.listOpenByUser(auth.userId).catch(() => null) : [],
      activeNoteClaims(auth).catch(() => null),
    ]);
    if (!openPrs || !claims) {
      return res.status(503).json({ error: 'Could not check what these agents are waiting on. Nothing was sent — try again in a moment.' });
    }
    const holdingNotes = new Set(claims.map(({ claim }) => claim.agentId));
    const answer: WorkspaceFreshChatsAnswer = { asked: [], skipped: [] };
    for (const id of new Set(ids)) {
      const agent = activeAgent(auth, id);
      if (!agent) {
        answer.skipped.push({ id, reason: 'is no longer on this account' });
        continue;
      }
      const proposals = openPrs.filter((doc) => doc.status === 'open' && doc.createdByAgentId === id);
      const refusal = freshChatRefusal({
        id,
        status: agent.connectedAt && !agent.planned && isHarnessCli(agent.cli) ? 'ready' : 'setting-up',
        ...(deps.agentLifecycle?.isAgentWorking?.(auth.userId, id) ? { working: true } : {}),
        ...(agentWorkFinished(agent) ? { finished: true as const } : {}),
        ...contextFields(agent.contextUsage),
        ...(proposals.length
          ? { doing: { kind: 'proposal' as const, count: proposals.length, number: proposals[proposals.length - 1]!.number } }
          : {}),
        ...((agent.activeJobs?.count ?? 0) > 0 ? { activeJobs: agent.activeJobs!.count } : {}),
        ...sessionLimitFields(agent.sessionLimit),
      }, holdingNotes);
      if (refusal) {
        answer.skipped.push({ id, name: agent.name, reason: refusal });
        continue;
      }
      const result = await send({ userId: auth.userId, agentId: id, message: FRESH_CHAT_MESSAGE });
      if (result.ok) {
        answer.asked.push({ id, name: result.recipient.name || agent.name });
      } else {
        answer.skipped.push({ id, name: agent.name, reason: result.code === 'busy' ? 'is working right now' : 'could not be reached' });
      }
    }
    if (answer.asked.length) {
      await recordPersonAction(auth, personActionLines.askedFreshChats(answer.asked.map((agent) => agent.name)));
    }
    return res.json(answer);
  });

  /**
   * The last exact reply on the agent's details screen (note #149). This is a
   * narrow read rather than `after=0` on the transcript: opening details must
   * not fetch up to 500 rows or tell the reply-nudge logic the chat was read.
   */
  router.get('/api/agents/:id/chat/latest', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const read = deps.agentLifecycle?.latestAgentChatMessage;
    if (!read) {
      return res.status(503).json({ error: 'Chat is not available on this backend yet' });
    }
    const agentId = String(req.params.id ?? '');
    if (!activeAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    return res.json({ message: await read(auth.userId, agentId) } satisfies WorkspaceChatLatestAnswer);
  });

  /**
   * The agent's chat screen (inhouse-chat-design, note #131): the incremental
   * read behind it. `after` is the newest seq the page already holds, so an
   * open screen polls for only what is new; the first read passes 0 and gets
   * the whole window. The working flag and activity line ride along — the
   * screen's status line and its transcript must not be two requests that can
   * disagree.
   */
  router.get('/api/agents/:id/chat', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const read = deps.agentLifecycle?.agentChatMessages;
    if (!read) {
      return res.status(503).json({ error: 'Chat is not available on this backend yet' });
    }
    const agentId = String(req.params.id ?? '');
    // An HTTP param carries no guarantee the agent is the caller's own — the
    // same check every other per-agent route makes before acting.
    const agent = activeAgent(auth, agentId);
    if (!agent) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const afterRaw = Number(req.query.after);
    const after = Number.isFinite(afterRaw) && afterRaw > 0 ? Math.floor(afterRaw) : 0;
    const messages = await read(auth.userId, agentId, after);
    const working = deps.agentLifecycle?.isAgentWorking?.(auth.userId, agentId) ?? false;
    // Only while no turn is running: once one is, the turn is the news.
    const preparing = !working && (deps.agentLifecycle?.isAgentPreparing?.(auth.userId, agentId) ?? false);
    const workspaceFace = await workspaceAgentFaceForOrg(agent.orgId ?? auth.orgId);
    return res.json({
      messages: (await withMailApprovals(auth.userId, messages))
        .map((message) => withPeerChatFace(message, workspaceFace)),
      working,
      ...(preparing ? { preparing: true } : {}),
      // The ring around the face in the chat's header (note #145), from the
      // same profile read this handler already made. It rides THIS response
      // rather than waiting for the next full state read because a turn ENDING
      // is what writes a new measurement, and the screen open at that moment is
      // usually this one. Absent whenever a percentage would be invented,
      // exactly as it is absent from the fleet list.
      ...contextFields(agent.contextUsage),
      ...(working
        ? liveActivityFields(deps.agentLifecycle?.agentActivity?.(auth.userId, agentId))
        : {}),
      // The recap line under the latest completed turn (note #945): the row
      // recap and the turn's own stamps, off the same record as the ring.
      ...(() => { const lastTurn = turnRecapOf(agent); return lastTurn ? { lastTurn } : {}; })(),
    } satisfies WorkspaceChatAnswer);
  });

  /**
   * The optional row immediately under a chat's identity header. It lists
   * only durable jobs that are running NOW; terminal records stay on the
   * machine and disappear from this live surface. The service checks machine
   * state before SSH, so merely opening a chat never wakes a sleeping agent.
   */
  router.get('/api/agents/:id/jobs', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const agentId = String(req.params.id ?? '');
    if (!activeAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const read = deps.agentLifecycle?.listManagedJobs;
    const { jobs, recent } = read ? await read(auth.userId, agentId) : { jobs: [], recent: [] };
    return res.json({
      jobs,
      ...(recent.length ? { recent } : {}),
    } satisfies WorkspaceAgentJobsAnswer);
  });

  /**
   * The chat screen's Stop (inhouse-chat-design phase 2): interrupt the
   * running turn. Owner messages already accepted behind it are preserved for
   * the next Send; peer/platform queue entries are settled as undelivered.
   * Answers honestly when the turn beat the tap: `stopped: false`, still 200
   * — the screen's next poll shows the same truth.
   */
  router.post('/api/agents/:id/stop', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const stop = deps.agentLifecycle?.stopAgentTurn;
    if (!stop) {
      return res.status(503).json({ error: 'Stopping a turn is not available on this backend yet' });
    }
    const agentId = String(req.params.id ?? '');
    if (!activeAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const result = await stop({ userId: auth.userId, agentId });
    if (!result.ok) {
      return res.status(404).json({ error: result.reason });
    }
    return res.json({ ok: true, stopped: result.stopped, name: result.name } satisfies WorkspaceAgentStopAnswer);
  });

  /**
   * Files selected together in the chat composer, admitted with their
   * optional text as ONE message. Four big-endian bytes say how long the
   * UTF-8 JSON manifest is; it names and sizes each file, whose raw bytes
   * follow in order. No base64 expansion, and one request lets the service
   * cross steer/start atomically with the whole set.
   *
   * The old one-file envelope is accepted when its x-chat-file-name header is
   * present. A Workspace page can stay open across a backend deploy, and an
   * ordinary attachment picked on that page must not turn into a malformed
   * upload just because the server beneath it learned the wider contract.
   */
  router.post(
    '/api/agents/:id/chat/files',
    raw({
      type: () => true,
      limit: AGENT_CHAT_MESSAGE_MAX_BYTES
        + AGENT_CHAT_ATTACHMENT_MANIFEST_MAX_BYTES
        + AGENT_CHAT_ATTACHMENT_ENVELOPE_PREFIX_BYTES,
    }),
    async (req, res) => {
      const auth = await authenticate(req, res);
      if (!auth) return;
      const send = deps.agentLifecycle?.chatMessageAgentFromUser;
      if (!send) {
        return res.status(503).json({ error: 'Chat is not available on this backend yet' });
      }
      const agentId = String(req.params.id ?? '');
      if (!activeAgent(auth, agentId)) {
        return res.status(404).json({ error: 'No such agent on this account' });
      }

      const parsed = parseChatAttachmentEnvelope(req);
      if ('error' in parsed) return res.status(400).json({ error: parsed.error });
      const { message, attachments } = parsed;

      if (message.length > AGENT_USER_MESSAGE_MAX_LENGTH) {
        return res.status(400).json({
          error: `That message is ${message.length} characters — keep it under ${AGENT_USER_MESSAGE_MAX_LENGTH}.`,
        });
      }

      const result = await send({
        userId: auth.userId,
        agentId,
        message,
        attachments,
      });
      if (!result.ok) {
        return res.status(result.code === 'busy' ? 409 : result.code === 'not_found' ? 404 : 503)
          .json({ error: result.reason, code: result.code });
      }
      return res.status(202).json(
      { ok: true, name: result.recipient.name, steered: !!result.steered } satisfies WorkspaceChatSendAnswer,
    );
    },
  );

  /**
   * A chat file's bytes, by signed URL — the same contract note files answer
   * on: the backend hands out a 15-minute link and never proxies the object.
   */
  router.get('/api/agents/:id/chat/files/:fileId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const access = deps.agentLifecycle?.agentChatFileAccess;
    if (!access) {
      return res.status(503).json({ error: 'Chat files are not available on this backend yet' });
    }
    const agentId = String(req.params.id ?? '');
    if (!activeAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const result = await access(
      auth.userId,
      agentId,
      String(req.params.fileId ?? ''),
      req.query.preview === '1',
    );
    if (!result) {
      return res.status(404).json({ error: 'That file is no longer on this chat' });
    }
    return res.json(result satisfies WorkspaceChatFileAccessAnswer);
  });

  /**
   * A Markdown file's words (note #677). The one chat-file read that carries
   * the bytes rather than a link to them: the shell draws Markdown itself,
   * and its policy will not let it fetch from the media host.
   */
  router.get('/api/agents/:id/chat/files/:fileId/text', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const read = deps.agentLifecycle?.agentChatFileText;
    if (!read) {
      return res.status(503).json({ error: 'Chat files are not available on this backend yet' });
    }
    const agentId = String(req.params.id ?? '');
    if (!activeAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const result = await read(auth.userId, agentId, String(req.params.fileId ?? ''));
    if (!result) {
      return res.status(404).json({ error: 'That file is no longer on this chat' });
    }
    return res.json(result satisfies WorkspaceChatFileTextAnswer);
  });

  /**
   * Send from the chat screen. Same validation as the one-shot message route
   * above, different admission contract: this is a conversation, so a working
   * agent is steered mid-turn, and busy refusals are the rare race rather
   * than the rule.
   */
  router.post('/api/agents/:id/chat', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const send = deps.agentLifecycle?.chatMessageAgentFromUser;
    if (!send) {
      return res.status(503).json({ error: 'Chat is not available on this backend yet' });
    }
    const agentId = String(req.params.id ?? '');
    if (!activeAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const body = (req.body ?? {}) as { message?: unknown };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return res.status(400).json({ error: 'Write something to send.' });
    }
    if (message.length > AGENT_USER_MESSAGE_MAX_LENGTH) {
      return res.status(400).json({
        error: `That message is ${message.length} characters — keep it under ${AGENT_USER_MESSAGE_MAX_LENGTH}.`,
      });
    }
    const result = await send({ userId: auth.userId, agentId, message });
    if (!result.ok) {
      return res.status(result.code === 'busy' ? 409 : result.code === 'not_found' ? 404 : 503)
        .json({ error: result.reason, code: result.code });
    }
    await recordPersonAction(auth, personActionLines.messaged(result.recipient.name));
    return res.status(202).json({ ok: true, name: result.recipient.name, steered: !!result.steered });
  });

  /**
   * Keep an agent the Workspace Agent asked to remove (note #710): the ask
   * comes off the record and the screen; nothing else changes. The agent's
   * own deletion needs no counterpart — the record goes with it.
   */
  router.post('/api/agents/:id/keep', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const agentId = String(req.params.id ?? '');
    const agent = activeAgent(auth, agentId);
    if (!agent) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    if (!deps.userStorage) {
      return res.status(503).json({ error: 'Agent management is not available on this backend yet' });
    }
    await deps.userStorage.updateAgentFields(auth.userId, agentId, { removeAsk: null });
    return res.json({ ok: true, name: agent.name });
  });

  router.delete('/api/agents/:id', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.agentLifecycle) {
      return res.status(503).json({ error: 'Agent management is not available on this backend yet' });
    }
    const agentId = String(req.params.id ?? '');
    // Same rule as scoped secret deletes: an HTTP param carries no guarantee
    // the agent is the caller's own — check the profile before acting.
    if (!activeAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    const result = await deps.agentLifecycle.deleteAgent(auth.userId, agentId);
    if (!result.ok) {
      return res.status(400).json({ error: result.reason });
    }
    return res.json({
      ok: true, name: result.name, machine: result.machine, remaining: result.remaining,
    } satisfies WorkspaceAgentDeletedAnswer);
  });

  // A workspace write lands in the ROOM the page is viewing (note #88) and is
  // shared with the agents that work there, whichever bot opened the app. This
  // is now the ONLY way a user adds a secret: the `/secret` chat command is
  // retired. Per-agent secrets still exist, but only the agent itself makes
  // one (`agentbuilt secret set --this-agent`).
  //
  // Two shapes (note #655). Without `?agent=` it is a SHARED secret, an admin
  // verb, carrying an optional `audience` — whose agents it reaches, admins'
  // only unless said otherwise. With `?agent=<own agent>` it is PRIVATE to that
  // one agent, and any member may save one: a member's own GitHub token for
  // their own agent is their business, and this form is the only way they can
  // hand it over without pasting it into a chat.
  router.post('/api/secrets', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const rawAgent = (req.query as Record<string, unknown>).agent;
    const agentId = typeof rawAgent === 'string' && rawAgent ? rawAgent : undefined;
    if (agentId && !activeAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    if (!agentId && !canManageSharedSecrets(auth)) {
      return res.status(403).json({ error: 'Only a workplace admin can add or replace shared secrets. You can save one for an agent of your own.' });
    }
    const secrets = requireSecrets(res);
    if (!secrets) return;
    const owner = await viewerOwnerId(auth, req, res);
    if (!owner) return;
    const body = (req.body ?? {}) as { name?: unknown; value?: unknown; audience?: unknown };
    if (typeof body.name !== 'string' || typeof body.value !== 'string') {
      return res.status(400).json({ error: 'Send { name, value } — both strings.' });
    }
    let audience: UserSecretAudience | undefined;
    if (!agentId && body.audience !== undefined) {
      const audienceResult = validateUserSecretAudience(body.audience);
      if (!audienceResult.ok) return res.status(400).json({ error: audienceResult.reason });
      audience = audienceResult.audience;
    }
    const scope = agentId ? agentUserSecretScope(agentId) : SHARED_USER_SECRET_SCOPE;
    const result = await secrets.setSecret(owner, body.name, body.value, scope, undefined, audience);
    if (!result.ok) {
      // The service's refusal text is written for a human — pass it through.
      return res.status(400).json({ error: result.reason });
    }
    return res.json({ ok: true, created: result.created, name: result.name });
  });

  /**
   * Whose agents a shared secret reaches (note #655): admins' only, or every
   * agent in the room. Admin-only and shared-only — a private key reaches one
   * agent by construction. Value and last-changed time are untouched.
   */
  router.patch('/api/secrets/:name/audience', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!canManageSharedSecrets(auth)) {
      return res.status(403).json({ error: 'Only a workplace admin can choose whose agents a shared secret reaches.' });
    }
    const secrets = requireSecrets(res);
    if (!secrets) return;
    const owner = await viewerOwnerId(auth, req, res);
    if (!owner) return;
    const body = (req.body ?? {}) as { audience?: unknown };
    const result = await secrets.setSecretAudience(owner, String(req.params.name ?? ''), body.audience);
    if (!result.ok) {
      return res.status(result.notFound ? 404 : 400).json({ error: result.reason });
    }
    return res.json({ ok: true, name: result.name, audience: result.audience });
  });

  /**
   * Which rooms a shared secret was limited to (note #783). Rooms are gone
   * (note #843): every key belongs to the whole workplace, so a screen that
   * still asks is told so — 410, the address is not coming back.
   */
  router.patch('/api/secrets/:name/rooms', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    return res.status(410).json({ error: SECRET_ROOMS_GONE });
  });

  /**
   * Say what a secret is FOR, without touching its value.
   *
   * The add form deliberately never asks for this — nobody types prose while
   * pasting a token, so the agent that uses the key writes it later (`agentbuilt
   * secret describe`). This route is the human's way in after the fact: a row
   * that predates descriptions, or one whose purpose has drifted, is otherwise
   * stuck with no way to fix it from the surface the user actually opens.
   */
  router.patch('/api/secrets/:name/description', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const secrets = requireSecrets(res);
    if (!secrets) return;
    const body = (req.body ?? {}) as { description?: unknown };
    if (typeof body.description !== 'string') {
      return res.status(400).json({ error: 'Send { description } as a string.' });
    }
    const rawAgent = (req.query as Record<string, unknown>).agent;
    const agentId = typeof rawAgent === 'string' && rawAgent ? rawAgent : undefined;
    if (agentId && !activeAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    if (!agentId && !canManageSharedSecrets(auth)) {
      return res.status(403).json({ error: 'Only a workplace admin can describe shared secrets.' });
    }
    const scope = agentId ? agentUserSecretScope(agentId) : SHARED_USER_SECRET_SCOPE;
    const owner = await viewerOwnerId(auth, req, res);
    if (!owner) return;
    const result = await secrets.describeSecret(
      owner,
      String(req.params.name ?? ''),
      body.description,
      scope,
    );
    if (!result.ok) {
      return res.status(result.notFound ? 404 : 400).json({ error: result.reason });
    }
    return res.json({ ok: true, name: result.name });
  });

  /**
   * Read one secret back in the clear, for the copy button. The scope comes
   * from the same `?agent=` param the delete route takes, so copying an
   * agent's private key never falls through to the shared one of that name.
   *
   * `no-store` matters more here than anywhere else on this surface: the
   * response body IS the secret, and a webview or proxy cache holding it is a
   * copy nobody knows about.
   */
  router.get('/api/secrets/:name/value', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const secrets = requireSecrets(res);
    if (!secrets) return;
    const rawAgent = (req.query as Record<string, unknown>).agent;
    const agentId = typeof rawAgent === 'string' && rawAgent ? rawAgent : undefined;
    if (agentId && !activeAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    if (!agentId && !canManageSharedSecrets(auth)) {
      return res.status(403).json({ error: 'Only a workplace admin can copy shared secret values.' });
    }
    const scope = agentId ? agentUserSecretScope(agentId) : SHARED_USER_SECRET_SCOPE;
    const name = String(req.params.name ?? '');
    const owner = await viewerOwnerId(auth, req, res);
    if (!owner) return;
    const value = await secrets.getSecretValue(owner, name, scope);
    if (value === null) {
      return res.status(404).json({
        error: scope.kind === 'shared'
          ? `No shared secret named "${name}".`
          : `No secret named "${name}" private to that agent.`,
      });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ name, value });
  });

  router.delete('/api/secrets/:name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const secrets = requireSecrets(res);
    if (!secrets) return;
    const rawAgent = (req.query as Record<string, unknown>).agent;
    const agentId = typeof rawAgent === 'string' && rawAgent ? rawAgent : undefined;
    // An HTTP param carries no guarantee the agent is the user's own — the
    // chat handlers get that from the bot registry, this route must check.
    if (agentId && !activeAgent(auth, agentId)) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    if (!agentId && !canManageSharedSecrets(auth)) {
      return res.status(403).json({ error: 'Only a workplace admin can delete shared secrets.' });
    }
    const scope = agentId ? agentUserSecretScope(agentId) : SHARED_USER_SECRET_SCOPE;
    const name = String(req.params.name ?? '');
    const owner = await viewerOwnerId(auth, req, res);
    if (!owner) return;
    const deleted = await secrets.deleteSecret(owner, name, scope);
    if (!deleted) {
      // Scope-specific on purpose: deleting a shared key must never silently
      // fall through to an agent's private copy of the same name.
      return res.status(404).json({
        error: scope.kind === 'shared'
          ? `No shared secret named "${name}".`
          : `No secret named "${name}" private to that agent.`,
      });
    }
    return res.json({ ok: true, name });
  });

  /**
   * The owner's git key — clone repositories on their own computer
   * (human-git-token.ts). This surface is the ONLY place the key exists in
   * the clear, exactly once, in the mint response: agents cannot ask for it,
   * chat never carries it, and the profile keeps only the hash.
   */
  router.get('/api/git-access', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    return res.json({ createdAt: auth.profile.gitAccess?.createdAt ?? null });
  });

  // Minting IS the rotation: a new key replaces the old hash, and the old
  // key dies on its next use. No separate "regenerate" verb to get subtly
  // out of sync with this one.
  router.post('/api/git-access', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.userStorage) return res.status(503).json({ error: 'Not available right now' });
    const minted = mintHumanGitToken(auth.userId);
    const createdAt = new Date().toISOString();
    await deps.userStorage.updateProfile(auth.userId, {
      gitAccess: { tokenHash: minted.tokenHash, createdAt },
    });
    res.set('Cache-Control', 'no-store');
    return res.json({ token: minted.token, createdAt });
  });

  router.delete('/api/git-access', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.userStorage) return res.status(503).json({ error: 'Not available right now' });
    if (!auth.profile.gitAccess) return res.status(404).json({ error: 'No key to revoke' });
    await deps.userStorage.updateProfile(auth.userId, { gitAccess: undefined });
    return res.json({ ok: true });
  });

  // ── The person (note #57) ────────────────────────────────────────────────
  // Who this user is to their teammates: the name and face beside everything
  // their agents do. Names are theirs to type; the picture rides the same
  // media store as note files, as raw bytes with the type in the header.

  /**
   * One uploaded picture, validated: the body `raw()` collected, its declared
   * type, and the two refusals (not an image, too big) shared by profile
   * photos and org avatars. Replies and returns null on refusal.
   */
  const readPictureUpload = (req: Request, res: Response): { data: Buffer; contentType: string } | null => {
    const contentType = (req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!(PROFILE_PHOTO_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      res.status(400).json({ error: 'A picture here is a JPEG, PNG or WebP image.' });
      return null;
    }
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!data.length) {
      res.status(400).json({ error: 'The upload arrived empty — pick the picture again.' });
      return null;
    }
    if (data.length > PROFILE_PHOTO_MAX_BYTES) {
      res.status(400).json({
        error: `A picture here is up to ${PROFILE_PHOTO_MAX_BYTES / 1024 / 1024} MB — this one is ${(data.length / 1024 / 1024).toFixed(1)} MB.`,
      });
      return null;
    }
    return { data, contentType };
  };

  /**
   * Land a new profile photo: bytes first, pointer second (the note-file
   * discipline — a crash between the two leaves an orphaned object, never a
   * pointer at nothing), and the old object deleted last, best-effort.
   */
  const savePersonPhoto = async (
    auth: MiniAppAuth,
    upload: { data: Buffer; contentType: string },
    source: PersonPhotoState['source'],
    res: Response,
  ) => {
    // Read BEFORE the pointer moves: the storage may hand back the live
    // object, and reading after the write would "replace" the new photo.
    const old = auth.profile.person?.photo?.storagePath;
    const photo: PersonPhotoState = {
      storagePath: personPhotoPath(auth.userId, randomUUID()),
      contentType: upload.contentType,
      sizeBytes: upload.data.length,
      updatedAt: new Date().toISOString(),
      source,
    };
    await deps.mediaStorage!.uploadObject({
      storagePath: photo.storagePath,
      contentType: photo.contentType,
      data: upload.data,
    });
    await deps.userStorage!.updatePersonFields(auth.userId, { photo });
    if (old) await deps.mediaStorage!.deleteObject?.({ storagePath: old }).catch(() => { /* orphan, swept never — harmless */ });
    return res.json({ ok: true, photoUrl: await pictureUrl(photo.storagePath) });
  };

  /** Save the profile names. Both required — that is what note #57 asked for. */
  router.post('/api/profile', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.userStorage) return res.status(503).json({ error: 'Not available right now' });
    const firstName = String((req.body as Record<string, unknown> | undefined)?.firstName ?? '').trim();
    const lastName = String((req.body as Record<string, unknown> | undefined)?.lastName ?? '').trim();
    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'Both names are needed — teammates see them beside everything your agents do.' });
    }
    if (firstName.length > PERSON_NAME_MAX_LENGTH || lastName.length > PERSON_NAME_MAX_LENGTH) {
      return res.status(400).json({ error: `A name here fits in ${PERSON_NAME_MAX_LENGTH} characters.` });
    }
    await deps.userStorage.updatePersonFields(auth.userId, {
      firstName,
      lastName,
      confirmedAt: new Date().toISOString(),
    });
    return res.json({ ok: true, name: `${firstName} ${lastName}` });
  });

  /**
   * Settings → Your builder page: the X profile their page's Follow on X
   * button links to (the owner, 2026-10-10). Until note #824 this was the
   * Leaderboard's section, with the switch that took them off the board.
   */
  const xProfileSettings = async (userId: string): Promise<WorkspaceXProfileSettings> => {
    const profile = await deps.userStorage!.getProfile(userId);
    return profile?.person?.x ? { x: profile.person.x } : {};
  };

  router.get('/api/profile/x', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.userStorage) return res.status(503).json({ error: 'Not available right now' });
    return res.json(await xProfileSettings(auth.userId) satisfies WorkspaceXProfileSettings);
  });

  router.put('/api/profile/x', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.userStorage) return res.status(503).json({ error: 'Not available right now' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const x = body.x === null ? '' : normalizeXHandle(body.x);
    if (x === null) {
      return res.status(400).json({ error: 'That is not an X handle — letters, numbers and underscores, up to 15.' });
    }
    await deps.userStorage.updatePersonFields(auth.userId, { x: x || null });
    return res.json(await xProfileSettings(auth.userId) satisfies WorkspaceXProfileSettings);
  });

  /**
   * Claim the address for this account (note #509). One per person and for
   * keeps: there is no rename here, because mail already addressed to a name
   * would otherwise arrive at whoever took it next. Everyone who signed up
   * before addresses existed picks theirs through this door.
   */
  router.post('/api/mail/address', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailboxes) return res.status(503).json({ error: 'Addresses are not available on this backend yet.' });
    try {
      const claimed = await deps.mailboxes.claim(auth.userId, (req.body as Record<string, unknown> | undefined)?.local);
      // The name they just took is how they sign in from now on; the outside
      // email they signed in with until now becomes their recovery address.
      await deps.workspaceWebAuth?.adoptMailboxAddress(auth.userId, claimed.address);
      return res.status(201).json({
        mailbox: { address: claimed.address },
      } satisfies WorkspaceMailAddressClaimAnswer);
    } catch (error) {
      if (error instanceof MailboxError) {
        return res.status(error.code === 'invalid_mailbox' ? 400 : 409).json({ error: error.message, code: error.code });
      }
      console.warn('[workspace-mail] address claim failed');
      return res.status(503).json({ error: 'That address could not be claimed. Try again.' });
    }
  });

  /**
   * The inbox behind that address (note #509, slice 2). PRIVATE TO ITS
   * OWNER: every read below is keyed on the signed-in person's own userId,
   * so there is no workplace-wide door and no way to ask for somebody
   * else's mail by knowing an id.
   *
   * `?in=` picks the place — inbox (the default), archive, trash, or all of
   * it but Trash — and `?q=` searches it (slice 7), through the index rather
   * than a walk. A search with no `in` looks through everything but Trash: a
   * letter somebody archived is still a letter they may be looking for.
   * Either way it pages with the same `before` cursor, newest first.
   *
   * `?in=sent` (slice 9) is the other question: everything that has gone OUT
   * of this address, replies included, one row per letter — and the one list
   * a reply is a row of. A search of it looks through Sent alone.
   */
  router.get('/api/mail/messages', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const place = readMailView(req.query.in);
    if ('refused' in place) return res.status(400).json({ error: place.refused });
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q : undefined;
    const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const page = await deps.mailMessages.list(auth.userId, {
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(req.query.before ? { before: String(req.query.before) } : {}),
      ...(place.view ? { in: place.view } : {}),
      ...(search ? { search } : {}),
    });
    const mailbox = deps.mailboxes ? await deps.mailboxes.forUser(auth.userId).catch(() => null) : null;
    return res.json({
      ...(mailbox ? { address: mailbox.address } : {}),
      messages: page.messages.map(mailMessageSummary),
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
    } satisfies WorkspaceMailMessagesAnswer);
  });

  /**
   * HOW MANY ARE NEW — the door on Home asks this every few seconds, so it is
   * a count and nothing else: no subject, no sender, no words, and nothing a
   * poll could leak. A backend with no inbox answers zero rather than 503:
   * the door is furniture, and furniture does not report outages.
   */
  router.get('/api/mail/unread', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) return res.json({ unread: 0 } satisfies WorkspaceMailUnreadAnswer);
    const unread = await deps.mailMessages.countUnread(auth.userId).catch(() => 0);
    return res.json({ unread } satisfies WorkspaceMailUnreadAnswer);
  });

  /**
   * WHO A LETTER WAKES (slice 11) — the opt-in choice under Settings \u2192 Your
   * address, and the roster it is chosen from.
   *
   * The candidates are every agent this PERSON has, in every room of theirs,
   * because that is already the scope of an agent's reach into their mail:
   * slice 6 keys every mail route on `auth.userId`, deliberately not on the
   * git namespace a workplace shares. What is excluded is the Workspace
   * Agent, for the reason `jobs/finished` excludes it — its conversation is
   * started by the person or by its own coordination, never by an event on
   * the outside of the platform.
   */
  const mailWakeAnswer = async (
    auth: { userId: string; profile: UserProfileDocument },
  ): Promise<WorkspaceMailWakeAnswer> => {
    const fleet = listAgents(auth.profile.telegram);
    const candidate = (agent: AgentRecord): WorkspaceMailWakeCandidate => ({
      id: agent.id,
      name: agent.name,
      ...(agent.cli ? { cli: agent.cli } : {}),
    });
    const agents = fleet.map(candidate);
    const mailbox = await deps.mailboxes?.mailboxOf(auth.userId) ?? null;
    // An agent that has been deleted, or is no longer this person's, reads as
    // NOBODY here — the same silent fall-back the wake itself makes. The card
    // says what the answer says, so the screen never shows a name that is
    // gone.
    const chosen = mailbox?.wakeAgentId
      ? agents.find((row) => row.id === mailbox.wakeAgentId) ?? null
      : null;
    return { agent: chosen, agents, ...(mailbox?.wakeAgentId && !chosen ? { lapsed: true as const } : {}) };
  };

  router.get('/api/mail/wake', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailboxes) return res.status(503).json({ error: 'Addresses are not available on this backend yet.' });
    return res.json(await mailWakeAnswer(auth) satisfies WorkspaceMailWakeAnswer);
  });

  /**
   * Choose, or unchoose. `{ agentId: null }` is NOBODY, which is where every
   * address starts and where one goes back to; anything that is not one of
   * this person's own agents is refused rather than stored, so nothing here
   * can point a mailbox at somebody else's turn.
   */
  router.put('/api/mail/wake', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailboxes) return res.status(503).json({ error: 'Addresses are not available on this backend yet.' });
    const raw = (req.body ?? {}) as { agentId?: unknown };
    const agentId = raw.agentId === null || raw.agentId === undefined ? null : String(raw.agentId);
    if (agentId && !listAgents(auth.profile.telegram).some((agent) => agent.id === agentId)) {
      return res.status(404).json({ error: 'That is not one of your agents.' });
    }
    const mailbox = await deps.mailboxes.setWakeAgent(auth.userId, agentId);
    if (!mailbox) return res.status(404).json({ error: 'This account has no address yet.' });
    return res.json(await mailWakeAnswer(auth) satisfies WorkspaceMailWakeAnswer);
  });

  /** One message, with its body and the list of files it carried. */
  router.get('/api/mail/messages/:id', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const doc = await deps.mailMessages.get(auth.userId, String(req.params.id ?? ''));
    if (!doc) return res.status(404).json({ error: 'No such message.' });
    const answers = await deps.mailMessages.listAnswers(auth.userId, doc.id).catch(() => []);
    // OPENING IT IS READING IT. This is the one door a person reads their own
    // mail through, so it is the one place the stamp is written — and the
    // message handed back is stamped too, so the screen that asked for it
    // never has to be told a second time.
    const readAt = doc.readAt ?? new Date().toISOString();
    if (!doc.readAt) await deps.mailMessages.markRead(auth.userId, doc.id, readAt).catch(() => false);
    // Who a reply would go to is decided HERE, off the message, and the screen
    // is only told the answer — it never gets to name a recipient.
    const answerTo = deps.mailOutbox ? replyRecipient(doc) : null;
    const loaded = new Set(await deps.mailMessages.imageSenders(auth.userId).catch(() => []));
    const blocked = new Set(await deps.mailMessages.blockedSenders(auth.userId).catch(() => []));
    return res.json({
      message: {
        ...mailMessageBody({ ...doc, readAt }, loaded, blocked),
        replies: answers.map(mailReply),
        ...(answerTo ? { answerTo } : {}),
      },
    } satisfies WorkspaceMailMessageAnswer);
  });

  /**
   * THE LIST AS CONVERSATIONS (slice 8): one row per conversation, newest
   * activity first — an answer this person sent is activity too. `?in=`
   * picks the place; a conversation is in the inbox while any letter of it
   * is, so an answer arriving in one that was put away brings it back.
   * Searching stays `api/mail/messages?q=`: a search finds LETTERS, and
   * opening one opens its conversation at it.
   */
  router.get('/api/mail/conversations', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    // `all` and `sent` are views of LETTERS. A conversation is listed in
    // exactly one place, so neither is one it could be listed in.
    const place = readMailPlace(req.query.in);
    if ('refused' in place) return res.status(400).json({ error: place.refused });
    const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const page = await deps.mailMessages.listConversations(auth.userId, {
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(req.query.before ? { before: String(req.query.before) } : {}),
      ...(place.place ? { in: place.place } : {}),
    });
    const mailbox = deps.mailboxes ? await deps.mailboxes.forUser(auth.userId).catch(() => null) : null;
    return res.json({
      ...(mailbox ? { address: mailbox.address } : {}),
      conversations: page.conversations.map(mailConversationSummary),
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
    } satisfies WorkspaceMailConversationsAnswer);
  });

  /**
   * One conversation, whole: the one the message `:id` is part of, every
   * letter in it oldest first with its body. OPENING IT IS READING IT — every
   * letter in it is on the screen — so every one that arrived is stamped
   * read, and the answer handed back is already stamped.
   *
   * What a reply at the foot answers is decided HERE: the newest letter that
   * arrived and names somebody to answer, and who that is, read off it.
   */
  router.get('/api/mail/conversations/:id', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const conversation = await deps.mailMessages.getConversation(auth.userId, String(req.params.id ?? ''));
    if (!conversation) return res.status(404).json({ error: 'No such message.' });
    const readAt = new Date().toISOString();
    const messages = conversation.messages.map((doc) => ((doc.direction ?? 'in') === 'in' && !doc.readAt ? { ...doc, readAt } : doc));
    if (messages.some((doc, at) => doc !== conversation.messages[at])) {
      await deps.mailMessages.markConversationRead(auth.userId, conversation.thread, readAt).catch(() => 0);
    }
    const opened = { thread: conversation.thread, messages };
    const answering = deps.mailOutbox ? mailConversationAnswerable(messages, (doc) => Boolean(replyRecipient(doc))) : null;
    const answerTo = answering ? replyRecipient(answering) : null;
    // Whose pictures this reader loads, read once for the whole conversation.
    const loaded = new Set(await deps.mailMessages.imageSenders(auth.userId).catch(() => []));
    // And whom they have blocked (slice 13): the letter says Unblock, not Block.
    const blocked = new Set(await deps.mailMessages.blockedSenders(auth.userId).catch(() => []));
    return res.json({
      conversation: {
        ...mailConversationSummary(opened),
        messages: messages.map((doc) => mailMessageBody(doc, loaded, blocked)),
        ...(answering && answerTo ? { reply: { id: answering.id, to: answerTo, ...mailReplyAll(answering, answerTo) } } : {}),
      },
    } satisfies WorkspaceMailConversationAnswer);
  });

  /**
   * Archive, Trash and their undos for a WHOLE conversation (slice 8) — what
   * the conversation screen's buttons do. Every letter of it the move applies
   * to moves, in one transaction, under the same guards a single letter has;
   * a letter already where it is going is left alone. Moving one letter
   * stays below, for the CLI and for anything else that wants exactly one.
   */
  const moveConversation = (move: MailMove) => async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const outcome = await deps.mailMessages.moveConversation(auth.userId, String(req.params.id ?? ''), move, {
      atIso: new Date().toISOString(),
    });
    if ('refused' in outcome) {
      const refusal = mailMoveRefusal(outcome, 'conversation');
      return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
    }
    return res.json({
      conversation: mailConversationSummary(outcome.conversation),
      messages: outcome.conversation.messages.map((doc) => ({
        id: doc.id,
        ...(mailPlaceOf(doc) !== 'inbox' ? { place: mailPlaceOf(doc) as WorkspaceMailPlace } : {}),
        ...(mailMovedBy(doc) ? { movedBy: mailMovedBy(doc) } : {}),
        ...(mailPlaceOf(doc) === 'spam' && doc.spamWhy ? { spamWhy: doc.spamWhy } : {}),
      })),
    } satisfies WorkspaceMailConversationMoveAnswer);
  };
  router.post('/api/mail/conversations/:id/archive', moveConversation('archive'));
  router.post('/api/mail/conversations/:id/unarchive', moveConversation('unarchive'));
  router.post('/api/mail/conversations/:id/spam', moveConversation('spam'));
  router.post('/api/mail/conversations/:id/unspam', moveConversation('unspam'));
  router.post('/api/mail/conversations/:id/trash', moveConversation('trash'));
  router.post('/api/mail/conversations/:id/restore', moveConversation('restore'));

  /**
   * STARS (note #666): one letter from the conversation screen, or a
   * conversation's row from a list — which stars its newest letter outside
   * Trash and Spam, and unstars every letter in it. A star moves nothing.
   * The answer is the conversation as it now stands with every letter in it,
   * so the screen redraws from what the server did.
   */
  const starMail = (starred: boolean, whole: boolean) => async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const outcome = await deps.mailMessages.star(auth.userId, String(req.params.id ?? ''), {
      starred, whole, atIso: new Date().toISOString(),
    });
    if ('refused' in outcome) {
      const refusal = mailStarRefusal(outcome);
      return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
    }
    return res.json({
      conversation: mailConversationSummary(outcome.conversation),
      messages: outcome.conversation.messages.map(mailMessageSummary),
    } satisfies WorkspaceMailStarAnswer);
  };
  router.post('/api/mail/messages/:id/star', starMail(true, false));
  router.post('/api/mail/messages/:id/unstar', starMail(false, false));
  router.post('/api/mail/conversations/:id/star', starMail(true, true));
  router.post('/api/mail/conversations/:id/unstar', starMail(false, true));

  /**
   * One file off a message, as a short-lived signed URL — the same shape a
   * note's file uses. The id `raw` hands back the original message as it
   * arrived, which is the whole point of keeping it: a body we could not
   * parse is still a message its owner can download and open elsewhere.
   */
  router.get('/api/mail/messages/:id/files/:fileId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    if (!deps.mediaStorage) {
      return res.status(503).json({ error: 'File storage is not available on this backend yet.' });
    }
    const doc = await deps.mailMessages.get(auth.userId, String(req.params.id ?? ''));
    if (!doc) return res.status(404).json({ error: 'No such message.' });
    const fileId = String(req.params.fileId ?? '');
    const file = fileId === 'raw'
      ? { fileName: `${doc.subject.replace(/[^\w .-]+/g, ' ').trim().slice(0, 60) || 'message'}.eml`,
        contentType: 'message/rfc822',
        storagePath: doc.raw.storagePath }
      : doc.attachments.find((entry) => entry.id === fileId);
    if (!file) return res.status(404).json({ error: 'No such file on this message.' });
    const access = await deps.mediaStorage.createReadAccess({
      storagePath: file.storagePath,
      expiresInMs: 15 * 60_000,
      ...readDisposition(req, file),
    });
    return res.json({
      url: access.url, fileName: file.fileName, expiresAt: access.expiresAt,
    } satisfies WorkspaceFileAccessAnswer);
  });

  /**
   * A PICTURE THAT TRAVELLED INSIDE THE MESSAGE (slice 10), drawn in place.
   *
   * The body points at it with `cid:`, the bytes are already in our own media
   * storage, and the screen turns that reference into a read of THIS route —
   * so an inline picture costs its reader nothing: nobody outside is asked
   * for anything, and there is nothing for a sender to learn. Owner-keyed
   * like every other read here, and answered with a redirect to the same
   * short-lived signed URL the files shelf hands out, so the bytes never pass
   * through this process.
   *
   * Only a picture, and never an SVG (`isInlineImageFile`): this is the one
   * place a stored attachment is drawn rather than downloaded, and a document
   * that can carry script is not a picture.
   */
  router.get('/api/mail/messages/:id/inline/:fileId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    if (!deps.mediaStorage) {
      return res.status(503).json({ error: 'File storage is not available on this backend yet.' });
    }
    const doc = await deps.mailMessages.get(auth.userId, String(req.params.id ?? ''));
    if (!doc) return res.status(404).json({ error: 'No such message.' });
    const file = doc.attachments.find((entry) => entry.id === String(req.params.fileId ?? ''));
    if (!file || !isInlineImageFile(file.contentType)) {
      return res.status(404).json({ error: 'No such picture on this message.' });
    }
    const access = await deps.mediaStorage.createReadAccess({
      storagePath: file.storagePath,
      expiresInMs: 15 * 60_000,
      responseDisposition: 'inline',
    });
    // The redirect may be kept by THIS browser for a few minutes — never by
    // anything in front of it. A letter is redrawn whenever its conversation
    // is read again, and a picture that had to be signed for twice in one
    // sitting blinks out and back in front of the reader.
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.redirect(302, access.url);
  });

  /**
   * A PICTURE THE LETTER POINTS AT, fetched by us (slice 10).
   *
   * Nothing reaches this route until its reader has tapped Load pictures on
   * that message, and what it fetches is bounded twice over: the URL has to
   * be one the stored message itself names, and the fetch has to survive
   * `fetchMailRemoteImage`'s rules — public addresses only, redirects capped
   * and re-checked, one timeout, a byte ceiling, and bytes that sniff as a
   * raster image.
   *
   * The sender still learns the letter was opened; that is why the button
   * says so. What they do not learn is who opened it: the request wears one
   * of our servers, carries nothing of the reader, and the answer is
   * `no-store`, so no cache holds a picture fetched for one person where
   * another could be served it.
   */
  router.get('/api/mail/messages/:id/remote-image', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const doc = await deps.mailMessages.get(auth.userId, String(req.params.id ?? ''));
    if (!doc) return res.status(404).json({ error: 'No such message.' });
    const src = typeof req.query.src === 'string' ? req.query.src : '';
    // The letter's own markup is the list of pictures that may be asked for.
    // Without this the door would fetch any address a signed-in caller typed.
    if (!mailHtmlNamesImage(doc.html, src)) {
      return res.status(404).json({ error: 'That picture is not in this message.' });
    }
    const outcome = await (deps.mailRemoteImage ?? ((at: string) => fetchMailRemoteImage(at)))(src);
    if ('refused' in outcome) {
      return res.status(502).json({ error: 'That picture could not be loaded.', code: outcome.refused });
    }
    res.setHeader('Content-Type', outcome.contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    // Served from our own origin, so it is nailed down as bytes: the declared
    // type is the only one it may be read as, and nothing in it may load or
    // run anything else.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    return res.send(outcome.body);
  });

  /**
   * THE SENDERS WHOSE PICTURES THIS PERSON LOADS (slice 10) — the list, and
   * the two ways to change it. Offered on a letter, under the button, after
   * the pictures in that letter have been loaded once: the question "always?"
   * is only worth asking about a sender the reader has already decided about
   * one letter of. There is deliberately no general switch.
   */
  router.get('/api/mail/image-senders', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const addresses = await deps.mailMessages.imageSenders(auth.userId);
    return res.json({ addresses } satisfies WorkspaceMailImageSendersAnswer);
  });

  router.post('/api/mail/image-senders', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const address = mailSenderKey(String(req.body?.address ?? ''));
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
      return res.status(400).json({ error: 'That is not an email address.' });
    }
    const addresses = await deps.mailMessages.allowImagesFrom(auth.userId, address, new Date().toISOString());
    return res.json({ addresses } satisfies WorkspaceMailImageSendersAnswer);
  });

  router.delete('/api/mail/image-senders/:address', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const addresses = await deps.mailMessages.stopImagesFrom(auth.userId, String(req.params.address ?? ''));
    return res.json({ addresses } satisfies WorkspaceMailImageSendersAnswer);
  });

  /**
   * Archive, Trash and their two undos (slice 7). Nothing here removes a
   * message: Trash is a place, the row and its bytes stay exactly as they
   * were, and Restore takes it back to where it was. There is deliberately no
   * route that deletes a letter for good.
   *
   * Only the answer the server wrote is said back — the screen draws the
   * message's new place from this, never from the button it pressed.
   */
  const moveMail = (move: MailMove) => async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const outcome = await deps.mailMessages.move(auth.userId, String(req.params.id ?? ''), move, {
      atIso: new Date().toISOString(),
    });
    if ('refused' in outcome) {
      const refusal = mailMoveRefusal(outcome);
      return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
    }
    return res.json({ message: mailMessageSummary(outcome.doc) } satisfies WorkspaceMailMoveAnswer);
  };
  router.post('/api/mail/messages/:id/archive', moveMail('archive'));
  router.post('/api/mail/messages/:id/unarchive', moveMail('unarchive'));
  router.post('/api/mail/messages/:id/spam', moveMail('spam'));
  router.post('/api/mail/messages/:id/unspam', moveMail('unspam'));
  router.post('/api/mail/messages/:id/trash', moveMail('trash'));
  router.post('/api/mail/messages/:id/restore', moveMail('restore'));

  /**
   * THE SENDERS THIS PERSON HAS BLOCKED (slice 13) — the list, and the two
   * ways to change it. Offered on a letter, where the picture allowlist is,
   * so the decision is made about a sender the reader is looking at a letter
   * from. Blocking moves what that sender already sent out of the inbox and
   * the archive into Spam; unblocking moves nothing back, because a letter
   * is brought back with Not spam, one at a time, on purpose.
   */
  router.get('/api/mail/blocked-senders', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const addresses = await deps.mailMessages.blockedSenders(auth.userId);
    return res.json({ addresses } satisfies WorkspaceMailBlockedSendersAnswer);
  });

  router.post('/api/mail/blocked-senders', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const address = mailSenderKey(String(req.body?.address ?? ''));
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
      return res.status(400).json({ error: 'That is not an email address.' });
    }
    // Your own address is never blocked: every reply you write would land in
    // Spam, and the screen would have no way to say why.
    const own = deps.mailboxes ? await deps.mailboxes.forUser(auth.userId).catch(() => null) : null;
    if (own && mailSenderKey(own.address) === address) {
      return res.status(400).json({ error: 'That is your own address.' });
    }
    const outcome = await deps.mailMessages.blockSender(auth.userId, address, { atIso: new Date().toISOString() });
    return res.json(outcome satisfies WorkspaceMailBlockAnswer);
  });

  router.delete('/api/mail/blocked-senders/:address', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailMessages) {
      return res.status(503).json({ error: 'The inbox is not available on this backend yet.' });
    }
    const addresses = await deps.mailMessages.unblockSender(auth.userId, String(req.params.address ?? ''));
    return res.json({ addresses } satisfies WorkspaceMailBlockedSendersAnswer);
  });

  /**
   * Agent-authored mail is a decision IN chat. These are data endpoints for
   * that card, not a screen: the owner sees the full recipient, subject and
   * body before either answer is enabled.
   */
  router.get('/api/mail/approvals/:id', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailApprovals) return res.status(503).json({ error: 'Mail approvals are not available.' });
    const approval = await deps.mailApprovals.get(auth.userId, String(req.params.id ?? ''));
    if (!approval) return res.status(404).json({ error: 'No such mail approval.' });
    return res.json({ approval } satisfies WorkspaceMailApprovalAnswer);
  });

  router.post('/api/mail/approvals/:id/decision', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailApprovals) return res.status(503).json({ error: 'Mail approvals are not available.' });
    const decision = String((req.body as { decision?: unknown } | undefined)?.decision ?? '');
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({ error: 'Choose Send email or Don’t send.' });
    }
    try {
      const approval = await deps.mailApprovals.decide({
        userId: auth.userId,
        id: String(req.params.id ?? ''),
        decision,
      });
      if (!approval) return res.status(404).json({ error: 'No such mail approval.' });
      return res.json({ approval } satisfies WorkspaceMailApprovalAnswer);
    } catch (error) {
      if (error instanceof MailOutboxError) {
        const status = error.code === 'no_such_message' ? 404
          : error.code === 'too_many' ? 429
            : error.code === 'not_replyable' || error.code === 'no_mailbox' ? 409 : 400;
        return res.status(status).json({ error: error.message, code: error.code });
      }
      if (error instanceof MailSendError) {
        console.warn('[workspace-mail] approved agent mail was refused:', error.message);
        return res.status(502).json({ error: 'The email could not be sent. Try again in a moment.' });
      }
      console.error('[workspace-mail] approved agent mail failed:', error);
      return res.status(500).json({ error: 'The email could not be sent.' });
    }
  });

  /**
   * The person's name as their mail wears it, and a refusal from the outbox
   * turned into a sentence and a status — the same for every way out.
   */
  const mailSenderName = async (userId: string): Promise<string> => {
    const profile = deps.userStorage ? await deps.userStorage.getProfile(userId).catch(() => null) : null;
    const person = profile?.person;
    return [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim();
  };
  const mailSendFailure = (res: Response, error: unknown, noun: 'reply' | 'message' | 'forward') => {
    if (error instanceof MailOutboxError) {
      const status = error.code === 'no_such_message' ? 404
        : error.code === 'too_many' ? 429
          : error.code === 'files_unavailable' ? 503
            : error.code === 'not_replyable' || error.code === 'no_mailbox' || error.code === 'not_forwardable' ? 409 : 400;
      return res.status(status).json({ error: error.message, code: error.code });
    }
    if (error instanceof MailSendError) {
      // The provider refused or did not answer. Nothing was stored, so the
      // person can simply send again — say that rather than a stack.
      console.warn(`[workspace-mail] ${noun} send failed:`, error.message);
      return res.status(502).json({ error: `The ${noun} could not be sent. Try again in a moment.` });
    }
    console.error(`[workspace-mail] ${noun} failed:`, error);
    return res.status(500).json({ error: `The ${noun} could not be sent.` });
  };
  /** Words only, the body is JSON; with files it is the upload envelope
   *  (slice 12) — see mail-upload.ts. */
  const mailUpload = raw({ type: MAIL_UPLOAD_CONTENT_TYPE, limit: MAIL_UPLOAD_MAX_BYTES });

  /**
   * Answer a message (note #509, slice 4).
   *
   * The recipient is read off the message on this side, so there is no way
   * to address a reply at somebody who never wrote. That is the abuse
   * control, and it is why this door can be open on a free address at all.
   * What the body may carry besides the words (slice 12) is a Cc line and
   * files — and a Cc that reaches somebody the letter was not addressed to
   * spends the NEW allowance, decided in the outbox.
   */
  router.post('/api/mail/messages/:id/reply', mailUpload, async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailOutbox) {
      return res.status(503).json({ error: 'Replying is not available on this backend yet.' });
    }
    const upload = readMailUpload(req.body);
    if ('error' in upload) return res.status(400).json({ error: upload.error });
    try {
      const senderName = await mailSenderName(auth.userId);
      const sent = await deps.mailOutbox.reply({
        userId: auth.userId,
        messageId: String(req.params.id ?? ''),
        text: String(upload.fields.text ?? ''),
        cc: upload.fields.cc,
        files: upload.files,
        ...(senderName ? { senderName } : {}),
      });
      return res.status(201).json({ reply: mailReply(sent) } satisfies WorkspaceMailReplyAnswer);
    } catch (error) {
      return mailSendFailure(res, error, 'reply');
    }
  });

  /**
   * Write to somebody who has not written first (note #509, slice 5).
   *
   * Unlike a reply, this one DOES take a recipient from the request — which
   * is what slice 4 would not do. The ceilings that pay for it live in
   * `mail-outbox.ts`, next to the reasoning, rather than being scattered
   * here: this route's job is to name the person, hand over what they typed,
   * and turn a refusal into a sentence and a status.
   */
  router.post('/api/mail/send', mailUpload, async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailOutbox) {
      return res.status(503).json({ error: 'Sending is not available on this backend yet.' });
    }
    const upload = readMailUpload(req.body);
    if ('error' in upload) return res.status(400).json({ error: upload.error });
    try {
      const senderName = await mailSenderName(auth.userId);
      const sent = await deps.mailOutbox.send({
        userId: auth.userId,
        to: upload.fields.to,
        cc: upload.fields.cc,
        subject: upload.fields.subject,
        text: String(upload.fields.text ?? ''),
        files: upload.files,
        ...(senderName ? { senderName } : {}),
      });
      return res.status(201).json({ message: mailMessageSummary(sent) } satisfies WorkspaceMailSendAnswer);
    } catch (error) {
      return mailSendFailure(res, error, 'message');
    }
  });

  /**
   * Pass a letter on (note #509, slice 12): to one address, Cc'd to up to
   * three more, the person's words on top and the letter quoted under them.
   * `carry` names which of the letter's own files go — absent, every one of
   * them — and more files may come with the request. It reaches somebody who
   * has not written, so it spends the NEW allowance, and it is kept in the
   * letter's conversation as well as in Sent.
   */
  router.post('/api/mail/messages/:id/forward', mailUpload, async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.mailOutbox) {
      return res.status(503).json({ error: 'Forwarding is not available on this backend yet.' });
    }
    const upload = readMailUpload(req.body);
    if ('error' in upload) return res.status(400).json({ error: upload.error });
    try {
      const senderName = await mailSenderName(auth.userId);
      const sent = await deps.mailOutbox.forward({
        userId: auth.userId,
        messageId: String(req.params.id ?? ''),
        to: upload.fields.to,
        cc: upload.fields.cc,
        text: String(upload.fields.text ?? ''),
        ...(upload.fields.carry !== undefined ? { carry: upload.fields.carry } : {}),
        files: upload.files,
        ...(senderName ? { senderName } : {}),
      });
      return res.status(201).json({ message: mailMessageSummary(sent) } satisfies WorkspaceMailForwardAnswer);
    } catch (error) {
      return mailSendFailure(res, error, 'forward');
    }
  });

  /** A picture they chose. Raw bytes, like a note file. */
  router.post(
    '/api/profile/photo',
    raw({ type: () => true, limit: PROFILE_PHOTO_MAX_BYTES + 1024 }),
    async (req, res) => {
      const auth = await authenticate(req, res);
      if (!auth) return;
      if (!deps.userStorage || !deps.mediaStorage) {
        return res.status(503).json({ error: 'Picture storage is not available on this backend yet.' });
      }
      const upload = readPictureUpload(req, res);
      if (!upload) return;
      return savePersonPhoto(auth, upload, 'upload', res);
    },
  );

  /** Take the picture off. The profile then counts as incomplete again. */
  router.delete('/api/profile/photo', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.userStorage) return res.status(503).json({ error: 'Not available right now' });
    const old = auth.profile.person?.photo?.storagePath;
    if (!old) return res.status(404).json({ error: 'No picture to remove.' });
    await deps.userStorage.updatePersonFields(auth.userId, { photo: null });
    await deps.mediaStorage?.deleteObject?.({ storagePath: old }).catch(() => { /* orphan, harmless */ });
    return res.json({ ok: true });
  });

  // ── The workplace (org-layer-design) ──────────────────────────────────
  // Members, seats and invites. Every route below is member-gated on the org
  // MEMBERSHIP role — deliberately not `roles.admin`, which is the platform
  // operator flag: an org admin is a customer fact, not an ops one.

  /** The caller's org context, or the 403 that says they are in none. */
  const requireMembership = async (
    auth: MiniAppAuth,
    res: Response,
  ): Promise<{ storage: OrgStorage; membership: OrgMembershipDocument } | null> => {
    if (!deps.orgStorage) {
      res.status(503).json({ error: 'The workplace layer is not available on this backend yet' });
      return null;
    }
    const membership = auth.orgId
      ? await deps.orgStorage.getMembership(auth.orgId, auth.userId)
      : null;
    if (!membership) {
      res.status(403).json({
        error: 'This account is not part of a workplace yet — an invite from one is the way in.',
      });
      return null;
    }
    return { storage: deps.orgStorage, membership };
  };

  /**
   * A workplace an admin asked to delete is LOCKED (2026-09-22): nothing new
   * starts in it — no agent, no room, nobody joining. Answers true when it
   * refused, having said why; everything else a member can do there waits
   * behind the lock screen anyway.
   */
  const refuseWhileDeleting = async (orgId: string | null | undefined, res: Response, what: string): Promise<boolean> => {
    if (!orgId || !deps.orgStorage) return false;
    const org = await deps.orgStorage.getOrg(orgId).catch(() => null);
    if (!org?.deletion) return false;
    res.status(409).json({ error: `${org.name} is being deleted, so ${what}.` });
    return true;
  };

  const inviteLink = (token: string): string | null => deps.workspaceWebOrigin
    ? `${deps.workspaceWebOrigin}/invite/${encodeURIComponent(token)}`
    : null;

  /** Minimal public preview for a bearer invite link. It does not name the
   * organization: chat/link scanners are not authenticated invitees. The
   * authenticated request screen names the destination. */
  router.get('/auth/invite/:token', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.orgStorage) {
      return res.status(503).json({ error: 'Workplace invites are not available.' });
    }
    const invite = await deps.orgStorage.getInvite(String(req.params.token ?? ''));
    const orgDoc = invite ? await deps.orgStorage.getOrg(invite.orgId) : null;
    if (!invite || !orgDoc) return res.status(404).json({ error: 'This invite link is not valid.' });
    // Closed says nothing more about the link: not whether it was used, and
    // still not whose it is. Only a marked workplace takes people (note #805).
    if (invitesShutFor(deps.invitesClosed, orgDoc)) return res.json({ status: 'closed' });
    const status = invite.usedAt ? 'used' : 'available';
    return res.json({ status });
  });

  /** Reading a link never changes membership or the user's active org. */
  router.get('/api/org/invites/:token', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const storage = deps.orgStorage;
    if (!storage) return res.status(503).json({ error: 'Workplace invites are not available.' });
    const invite = await storage.getInvite(String(req.params.token ?? ''));
    const org = invite ? await storage.getOrg(invite.orgId) : null;
    if (!invite || !org) return res.status(404).json({ error: 'This invite link is not valid. Ask an admin for a new one.' });
    const member = await storage.getMembership(org.orgId, auth.userId);
    const request = await storage.getJoinRequestByUser(org.orgId, auth.userId);
    // Someone already in walks in; everyone else meets the closed door, a
    // pending request included — nobody is deciding those while this holds.
    const status = member ? 'member'
      : invitesShutFor(deps.invitesClosed, org) ? 'closed'
      : request?.status === 'pending' ? 'pending'
        : invite.usedAt ? 'used'
          : request?.status === 'rejected' ? 'rejected' : 'available';
    return res.json({ orgId: org.orgId, name: org.name, status, ...(request ? { requestId: request.requestId } : {}) });
  });

  /** The legacy URL now submits a request; even an older client cannot join directly. */
  router.post('/api/org/invites/:token/redeem', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.orgStorage) {
      return res.status(503).json({ error: 'Workplace invites are not available.' });
    }
    const token = String(req.params.token ?? '');
    const invite = await deps.orgStorage.getInvite(token);
    if (invite && await deps.orgStorage.getMembership(invite.orgId, auth.userId)) {
      const orgDoc = await deps.orgStorage.getOrg(invite.orgId);
      return res.json({ ok: true, status: 'member', alreadyMember: true, orgId: invite.orgId, name: orgDoc?.name ?? '' });
    }
    if (invite && invitesShutFor(deps.invitesClosed, await deps.orgStorage.getOrg(invite.orgId))) {
      return res.status(403).json({ error: INVITES_CLOSED_MESSAGE, reason: 'closed' });
    }
    if (await refuseWhileDeleting(invite?.orgId, res, 'it is not taking new people')) return;
    const outcome = await deps.orgStorage.requestToJoin(token, auth.userId);
    if (!outcome.ok) {
      const messages = {
        unknown: 'This invite link is not valid.',
        used: 'This invite has already been used.',
        'already-member': 'You already belong to this workplace.',
      } as const;
      return res.status(outcome.reason === 'unknown' ? 404 : 409).json({
        error: messages[outcome.reason],
        reason: outcome.reason,
      });
    }
    await notifyJoinRequested(outcome.org.orgId, outcome.org.name, auth.userId, outcome.request.requestId);
    return res.json({ ok: true, status: 'pending', requestId: outcome.request.requestId, orgId: outcome.org.orgId, name: outcome.org.name });
  });

  /**
   * Just the people waiting, for the tick that keeps an open workplace
   * screen current — the same split the People page keeps between its heavy
   * read and its live one. `api/org` answers this inside the workplace's
   * whole RECORD, which is a dozen reads and a call out to the git host; an
   * admin watching for a request should not make all of that every few
   * seconds.
   */
  router.get('/api/org/join-requests', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can see join requests.' });
    }
    return res.json({ joinRequests: await pendingJoinRequestRows(ctx.storage, ctx.membership.orgId) });
  });

  /** A request remains readable by its applicant even after its link is revoked. */
  router.get('/api/org/join-requests/:id', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const storage = deps.orgStorage;
    if (!storage) return res.status(503).json({ error: 'Join requests are not available.' });
    const request = await storage.getJoinRequest(String(req.params.id ?? ''));
    if (!request || request.userId !== auth.userId) return res.status(404).json({ error: 'No such join request.' });
    const org = await storage.getOrg(request.orgId);
    if (!org) return res.status(404).json({ error: 'This workplace no longer exists.' });
    const member = await storage.getMembership(org.orgId, auth.userId);
    // Still waiting, at a door that has since shut (note #805): nobody there
    // is shown it to decide, so say closed rather than keep the page polling.
    const shut = request.status === 'pending' && invitesShutFor(deps.invitesClosed, org);
    return res.json({ orgId: org.orgId, name: org.name, requestId: request.requestId,
      status: member ? 'member' : shut ? 'closed' : request.status === 'approved' ? 'removed' : request.status });
  });

  router.post('/api/org/join-requests/:id/decision', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') return res.status(403).json({ error: 'Only an admin can decide join requests.' });
    const request = await ctx.storage.getJoinRequest(String(req.params.id ?? ''));
    if (!request || request.orgId !== ctx.membership.orgId) return res.status(404).json({ error: 'No such join request.' });
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') return res.status(400).json({ error: 'Choose Approve or Decline.' });
    if (decision === 'approve' && await refuseWhileDeleting(request.orgId, res, 'it is not taking new people')) return;
    const outcome = await ctx.storage.decideJoinRequest(request.requestId, auth.userId, decision);
    if (!outcome.ok) return res.status(outcome.reason === 'forbidden' ? 403 : outcome.reason === 'unknown' ? 404 : 409)
      .json({ error: outcome.reason === 'resolved' ? 'This request was already decided. Refresh the list.' : 'This request could not be decided.' });
    // A newcomer's account came with an unnamed workplace of its own, and
    // that is what is active for them. They asked to be HERE: once approved,
    // this is the workplace they open into — unless they have made the other
    // one theirs by naming it, in which case their choice stands.
    if (decision === 'approve') {
      await inheritPrivateSeats(request.userId, request.orgId).catch((error) => {
        console.warn(`[org] could not carry ${request.userId}'s subscriptions into ${request.orgId}:`, error);
      });
      try {
        const current = await ctx.storage.getMembershipByUser(request.userId);
        const currentOrg = current && current.orgId !== request.orgId ? await ctx.storage.getOrg(current.orgId) : null;
        if (currentOrg?.unnamed) await ctx.storage.setActiveOrg(request.userId, request.orgId);
      } catch (error) {
        console.warn(`[org] could not move the approved joiner ${request.userId} into ${request.orgId}:`, error);
      }
    }
    const org = await ctx.storage.getOrg(ctx.membership.orgId);
    await notifyJoinDecided(
      ctx.membership.orgId, org?.name ?? 'the workplace',
      request.userId, request.requestId, decision === 'approve',
    );
    // Declined in a copy, with nowhere else to be: signed out, now.
    if (decision === 'reject') await signOutOfCopy(request.userId);
    return res.json({ ok: true, status: outcome.request.status });
  });

  /**
   * A seat as the screens may see it: everything BUT the secret material.
   * Usage rides along as consistently formatted window views, from the
   * snapshot the 5-minute probe keeps fresh —
   * `usageRefreshedAt` says how fresh. A seat with no reading yet says why
   * instead, in the words the usage report already uses.
   *
   * Per-model windows join the list here (they are stored apart so a full
   * Fable window can't bench the whole seat, but the member should SEE
   * them), and the overage row carries the spend amounts when the seat's
   * grant can read them — the full picture for this seat.
   */
  /** 5632 minor units of USD/2 → "$56.32"; unknown currencies stay explicit ("56.32 XYZ"). */
  const formatMinorAmount = (minor: number, currency: string, exponent: number): string => {
    const amount = (minor / 10 ** exponent).toFixed(exponent);
    return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`;
  };

  const describeSeat = (seat: OrgSeatDocument) => {
    const spend = seat.usage?.spend;
    const spendText = spend
      ? `${formatMinorAmount(spend.usedMinor, spend.currency, spend.exponent)} of ${formatMinorAmount(spend.limitMinor, spend.currency, spend.exponent)}`
      : null;
    const allWindows = seat.usage
      ? [...Object.values(seat.usage.windows), ...Object.values(seat.modelWindows ?? {})]
      : [];
    return {
      seatId: seat.seatId,
      provider: seat.provider,
      label: seat.label,
      // The plan outlives a reading: it is still true for a seat that is
      // resting or needs signing in again, so it sits outside the usage block.
      ...(seat.usage?.planType ? { planText: formatUsagePlan(seat.usage.planType) } : {}),
      status: seat.status,
      ...(seat.status === 'payment_required'
        ? {
          attention: 'payment_required' as const,
          usageIsLastKnown: true,
          ...(seat.subscriptionStatus ? { subscriptionStatus: seat.subscriptionStatus } : {}),
          ...(seat.subscriptionStatusReadAt
            ? { subscriptionCheckedAt: seat.subscriptionStatusReadAt }
            : {}),
        }
        : {}),
      selected: seat.selected,
      createdAt: seat.createdAt,
      ...(seat.cooldownUntil ? { cooldownUntil: seat.cooldownUntil } : {}),
      ...(seat.usageRefreshedAt ? { usageRefreshedAt: seat.usageRefreshedAt } : {}),
      // The stamp Home's row for this subscription carries too (note #697).
      updatedAt: seat.updatedAt,
      ...(seat.usage
        ? {
          windows: sortUsageWindows(allWindows).map((window) => ({
            // `trackText` is the short name for the compact list row; `label`
            // stays the full one this seat's own screen prints (note #86).
            // The same projection Home's row takes its windows from.
            ...seatWindowReading(window, allWindows.filter((entry) => entry.id !== 'overage')),
            // A spend cap, not a limit that stops a turn: the compact list
            // row leaves it out, this seat's own screen shows it in full.
            ...(window.id === 'overage' ? { spend: true as const } : {}),
            // The instant rides `resetAt`; the UTC sentence stays as the
            // wording any older page already served is still rendering
            // (note #245).
            ...(window.resetsAt ? { resetsText: formatUsageReset(window.resetsAt) } : {}),
            ...(window.id === 'overage' && spendText ? { detailText: spendText } : {}),
          })),
        }
        : {
          usageNotice: seatNoReadingNotice(seat.provider),
        }),
    };
  };

  /**
   * The founder door: create another workplace and become its admin.
   * Membership and workplace count are intentionally unlimited; the new
   * workplace becomes the persistent active context.
   * Since note #664 every new workplace is HOSTED on our cloud, so its
   * machines are our cost from its first agent; the owner chose growth over
   * a gate here (2026-09-25: "don't think about abuse"). What bounds each one
   * is the hosted allowance — HOSTED_AGENT_LIMIT agents and
   * HOSTED_SITE_LIMIT sites.
   */
  router.post('/api/org', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.orgStorage) {
      return res.status(503).json({ error: 'The workplace layer is not available on this backend yet' });
    }
    const name = String((req.body as { name?: unknown } | undefined)?.name ?? '')
      .replace(/\s+/g, ' ').trim();
    if (!name) {
      return res.status(400).json({ error: 'Give your workplace a name.' });
    }
    if (name.length > 80) {
      return res.status(400).json({ error: 'That name is too long — 80 characters at most.' });
    }
    // A private copy is one company's (note #808): a new workplace is made by
    // someone already in one, never by an account that came in through a
    // link and was not let in.
    // Our own platform with sign-up closed (note #823) holds the same line:
    // no workplace for an account that is in none.
    if ((deps.privateCopy || deps.signupClosed) && (await deps.orgStorage.listMembershipsByUser(auth.userId)).length === 0) {
      return res.status(403).json({
        error: 'Here, a new workplace is made by someone already in one. Ask an admin of your workplace to let you in first.',
      });
    }
    const org = await deps.orgStorage.createOrg({ name, createdByUserId: auth.userId, foundingPending: true, firstRun: true });
    let handle: string | undefined;
    try {
      // The public handle (public-addresses): read off the name, never
      // asked for — the next free word when the plain one is somebody's.
      handle = (await deps.orgHandles?.assignDerived(org)) ?? undefined;
      // A second org must have a namespace before any state endpoint reads
      // repos, knowledge, secrets or notes. Falling back to the human's id
      // was safe in the one-org era and would alias two workplaces now.
      await deps.orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
      await deps.orgStorage.addMember({ orgId: org.orgId, userId: auth.userId, role: 'admin' });
      await deps.orgStorage.setActiveOrg(auth.userId, org.orgId);
    } catch {
      await deps.orgStorage.deleteOrg(org.orgId).catch(() => false);
      return res.status(500).json({ error: 'The workplace could not be created. Try again.' });
    }
    // Its founding — two rooms and four agents — is owed (note #144) and
    // lands the moment this workplace has a cloud and a subscription, from
    // whichever of those arrives last.
    return res.json({ ok: true, orgId: org.orgId, name: org.name, ...(handle ? { handle } : {}) });
  });

  /**
   * Rename a workplace. The same route used to exist only as the final step
   * of founder onboarding; keeping it makes an old page compatible while the
   * current workplace screen gives it its permanent job. The name is display
   * metadata: rooms, agents, shared work, git namespaces and cloud resources
   * keep their immutable ids and stay exactly where they are.
   */
  router.post('/api/org/name', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') return res.status(403).json({ error: 'Renaming the workplace is an admin action.' });
    const name = String((req.body as { name?: unknown } | undefined)?.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) return res.status(400).json({ error: 'Give your workplace a name.' });
    if (name.length > 80) return res.status(400).json({ error: 'That name is too long — 80 characters at most.' });
    const orgId = ctx.membership.orgId;
    if (!await ctx.storage.updateOrg(orgId, { name, unnamed: false })) return res.status(404).json({ error: 'This workplace no longer exists.' });
    void foundIfReady(auth.userId, orgId);
    return res.json({ ok: true, orgId, name });
  });

  /**
   * The founder steps in (2026-09-18): the Continue on the gate's arriving
   * screen, which the screen enables once the four agents are ready.
   * Any member may press it — the gate is per reader, and a member invited
   * while the team was still being built is held on the same screen. Idempotent:
   * a second press, or one on a workplace that was never arriving, is a no-op.
   */
  router.post('/api/org/arrived', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const orgId = ctx.membership.orgId;
    const org = await ctx.storage.getOrg(orgId).catch(() => null);
    if (!org) return res.status(404).json({ error: 'This workplace no longer exists.' });
    if (org.arriving && !await ctx.storage.updateOrg(orgId, { arriving: false })) return res.status(404).json({ error: 'This workplace no longer exists.' });
    return res.json({ ok: true, orgId });
  });

  /**
   * Found the workplace when — and only when — everything it needs is in
   * (note #144): a live subscription of its founder's. (It also waited for
   * the workplace's own cloud until note #664 hosted every new one on ours.) A
   * workplace made with the account already carries a first-name-based
   * default; reaching readiness accepts it by clearing `unnamed`, so the
   * founder is never asked to type a second name. Called from each write that
   * can complete the set, so the founding lands right behind whichever came
   * last. Once: the
   * `foundingPending` stamp comes off in the same breath, and a workplace
   * from before founding never had it.
   *
   * What it makes: the rooms and the four planned agents (records), then —
   * detached, because four machines take minutes — their computers.
   *
   * It no longer starts the Workspace Agent (note #656, the owner: "hide
   * workspace agent. don't create it also at onboarding flow"). Its first
   * words used to be a turn of its own here, and that turn built its private
   * machine — one more computer for an agent Home no longer shows.
   */
  // One founding per workplace at a time in this process. The stamp checks
  // below are a read and a write, not a compare-and-set, and since note #664
  // the state read can ask too, so two reads landing together would otherwise
  // both pass them and write the team twice. A caller that arrives while one
  // runs waits for THAT one, so a sign-in's next screen still finds it.
  const foundingsInFlight = new Map<string, Promise<void>>();
  const foundIfReady = (userId: string, orgId: string): Promise<void> => {
    const running = foundingsInFlight.get(orgId);
    if (running) return running;
    const founding = foundOnce(userId, orgId).finally(() => foundingsInFlight.delete(orgId));
    foundingsInFlight.set(orgId, founding);
    return founding;
  };
  const foundOnce = async (userId: string, orgId: string): Promise<void> => {
    const storage = deps.orgStorage;
    if (!storage || !deps.userStorage) return;
    const org = await storage.getOrg(orgId).catch(() => null);
    if (!org?.foundingPending) return;
    const founder = org.createdByUserId;
    let seated = false;
    for (const provider of ['claude', 'codex'] as const) {
      if (await memberHasLiveSeat(storage, founder, provider, orgId)) { seated = true; break; }
    }
    if (!seated) return;
    // The registration route already chose the default name. `unnamed` means
    // only that the spare has not become the person's own workplace yet; the
    // two real commitments above are what make that choice now.
    if (org.unnamed && !await storage.updateOrg(orgId, { unnamed: false })) return;
    // The stamp comes off. Nothing is furnished any more (note #726, the
    // owner's decision 3): the rooms and the agents are the Chief of
    // Staff's to open and bring in, for the work the person named, in its
    // first turn — which the plan landing starts (`seatSignedIn`).
    if (!await storage.updateOrg(orgId, { foundingPending: false })) return;
    console.info(`[founding] ${orgId} named for ${userId}; its team is the Chief of Staff's to bring in`);
  };
  deps.workplaceFounding = { foundIfReady };

  /** "2 agents, a site and 3 keys" — the sentence that refuses a delete has to
   *  name what is in the way, or "move things out first" is not actionable. */
  const describeHoldings = (holds: Record<string, number>): string => {
    const parts = ([
      ['agents', 'agent', 'agents'],
      // "assigned", because a sign-in is personal and global to its owner:
      // what this workplace holds is the ASSIGNMENT, and unassigning is
      // what clears it. Plain "1 sign-in" invites deleting the credential
      // itself, which would take it out of every other workplace too.
      ['signins', 'assigned sign-in', 'assigned sign-ins'],
      ['sites', 'site', 'sites'],
      ['repos', 'repository', 'repositories'],
      ['trash', 'repository in the trash', 'repositories in the trash'],
      ['notes', 'note', 'notes'],
      ['drive', 'Drive item (including Trash)', 'Drive items (including Trash)'],
      ['messages', 'private conversation', 'private conversations'],
      ['knowledge', 'knowledge page', 'knowledge pages'],
      ['proposals', 'waiting proposal', 'waiting proposals'],
      ['secrets', 'key', 'keys'],
      ['invites', 'active invite link', 'active invite links'],
      ['joinRequests', 'pending join request', 'pending join requests'],
      ['cloud', 'connected cloud resource', 'connected cloud resources'],
    ] as const)
      .filter(([key]) => (holds[key] ?? 0) > 0)
      .map(([key, one, many]) => `${holds[key]} ${holds[key] === 1 ? one : many}`);
    if (parts.length < 2) return parts.join('');
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  };

  /**
   * What the whole workplace holds — the answer to whether it can be
   * deleted outright (note #246).
   *
   * `org-layer-design` calls the condition "genuinely unused": one admin left
   * and no agents, sign-ins, repositories (including trash), notes, knowledge,
   * sites, secrets, invites, or connected cloud/git resources. This counts
   * exactly that list, by name, because a refusal that says only "resources or
   * history" leaves the owner staring at a screen reading "0 repositories"
   *
   * The caller's own agents ARE every agent here — this is only ever asked of
   * a workplace down to its last member — but it stays the same read the
   * delete has always used rather than a wider one that would quietly change
   * who the door opens for.
   */
  const orgHoldings = async (
    auth: MiniAppAuth,
    orgId: string,
    org: OrgDocument,
    namespaceId: string,
  ) => {
    // A founding agent (note #144) is a name on a record — no machine, no
    // history — and no reason to keep a workplace its admin wants gone.
    const agents = listAgents(auth.profile.telegram).filter((agent) => (
      (agent.orgId ? agent.orgId === orgId : auth.legacyOrgId === orgId) && !agent.planned
    )).length;
    const signins = deps.orgStorage
      ? (await deps.orgStorage.listSeatsByMember(orgId, auth.userId)).length
      : 0;
    const sites = deps.deploymentStorage ? (await deps.deploymentStorage.listByOrg(orgId)).length : 0;
    const repos = deps.gitRepoStorage ? (await deps.gitRepoStorage.listByUser(namespaceId)).length : 0;
    // Only while Restore can still bring it back. Past the window the host has
    // purged the bytes, the Workspace shows no trash at all, and the row that
    // is left would refuse this delete for as long as the workplace exists.
    const trash = deps.gitRepoStorage
      ? (await deps.gitRepoStorage.listTrashedByUser(namespaceId)).filter(isRestorableRepo).length
      : 0;
    const noteNamespaces = [namespaceId];
    const notes = deps.quickNoteStorage
      ? (await Promise.all(noteNamespaces.map(async (candidate) => (
        (await deps.quickNoteStorage!.listByUser(candidate)).length
          + (await deps.quickNoteStorage!.listArchivedByUser(candidate)).length
      )))).reduce((sum, count) => sum + count, 0)
      : 0;
    const proposals = deps.knowledgeProposalStorage
      ? (await deps.knowledgeProposalStorage.listByUser(namespaceId)).length
      : 0;
    // A host that will not answer counts as "something is there" — under a
    // failed read, refusing the delete is the only honest way to be wrong.
    const knowledge = deps.gitHostClient && deps.knowledgeProposalStorage
      ? (await new KnowledgeService(
        await gitHostFor(orgId),
        deps.knowledgeProposalStorage,
        deps.knowledgeShelf,
      ).listPages(namespaceId).catch(() => ['unverified'])).length
      : 0;
    const secrets = deps.secretStorage
      ? (await new UserSecretsService(deps.secretStorage).listSecrets(namespaceId)).length
      : 0;
    const invites = deps.orgStorage ? (await deps.orgStorage.listInvites(orgId))
      .filter((invite) => !invite.usedAt).length : 0;
    const joinRequests = deps.orgStorage ? (await deps.orgStorage.listJoinRequests(orgId))
      .filter((request) => request.status === 'pending').length : 0;
    // The cloud footprint, counted but not itemised: the org's own Fly
    // account, its own git host, a backup target, a storage add-on. A number
    // is honest and a list would not help — none of these is a thing a person
    // takes off a shelf, which is exactly why offboarding exists.
    const cloud = [org.fly, org.git?.host, org.git?.backup, org.media, org.messages?.host].filter(Boolean).length;
    return {
      drive: (await deps.driveStorage?.read(orgId))?.size ?? 0,
      messages: await deps.directMessageStorage?.count(orgId) ?? 0,
      agents, signins, sites, repos, trash,
      notes, knowledge, proposals, secrets, invites, joinRequests, cloud,
    };
  };


  /**
   * Pin one of the caller's own agents to one of their own seats (note #129),
   * or clear the pin with an empty seatId. The pin overrides the org's
   * selected seat for THIS agent only, at its next lease — the same fallback
   * order still stands behind it, so nothing here can strand a turn. Applied
   * at lease time, a mid-turn change simply takes effect next turn, which is
   * why (unlike a room move) it is not refused while the agent works.
   */
  /**
   * The schedule on an agent's screen (note #779): what a room agent
   * proposed, as the owner reads and decides it — approve, reject, pause,
   * resume, remove. Only the owner: a schedule is a standing order to spend
   * their subscription while nobody is watching.
   */
  const scheduleViewFor = (auth: MiniAppAuth, doc: { agentId: string; createdByAgentId: string }) => {
    const agents = auth.profile.telegram?.agents ?? {};
    return { agentName: agents[doc.agentId]?.name ?? doc.agentId, proposerName: agents[doc.createdByAgentId]?.name ?? doc.createdByAgentId };
  };
  router.get('/api/agents/:id/schedule', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const agentId = String(req.params.id ?? '');
    const agent = activeAgent(auth, agentId);
    if (!agent) return res.status(404).json({ error: 'No such agent on this account' });
    if (!deps.agentSchedules) return res.json({ schedule: null } satisfies WorkspaceAgentScheduleAnswer);
    const doc = await deps.agentSchedules.forAgent(agent.id);
    if (!doc || doc.ownerUserId !== auth.userId) return res.json({ schedule: null } satisfies WorkspaceAgentScheduleAnswer);
    return res.json({ schedule: scheduleView(doc, scheduleViewFor(auth, doc), new Date()) } satisfies WorkspaceAgentScheduleAnswer);
  });
  router.post('/api/agents/:id/schedule/decision', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const agentId = String(req.params.id ?? '');
    const agent = activeAgent(auth, agentId);
    if (!agent) return res.status(404).json({ error: 'No such agent on this account' });
    if (!deps.agentSchedules) return res.status(503).json({ error: 'Schedules are not available right now.' });
    const decision = (req.body as { decision?: unknown } | undefined)?.decision;
    const decisions: WorkspaceScheduleDecision[] = ['approve', 'reject', 'pause', 'resume', 'remove'];
    if (typeof decision !== 'string' || !decisions.includes(decision as WorkspaceScheduleDecision)) {
      return res.status(400).json({ error: 'decision is approve, reject, pause, resume or remove' });
    }
    const doc = await deps.agentSchedules.forAgent(agent.id);
    if (!doc || doc.ownerUserId !== auth.userId) return res.status(404).json({ error: 'This agent has no schedule.' });
    const service = deps.agentSchedules;
    const result = decision === 'approve' || decision === 'reject'
      ? await service.decide({ userId: auth.userId, id: doc.id, decision })
      : decision === 'pause'
        ? await service.pause({ id: doc.id, userId: auth.userId, by: 'owner' })
        : decision === 'resume'
          ? await service.resume({ id: doc.id, userId: auth.userId, by: 'owner' })
          : await service.remove({ id: doc.id, userId: auth.userId });
    if (!result.ok) return res.status(result.code === 'not_found' ? 404 : 409).json({ error: result.reason });
    const after = await deps.agentSchedules.forAgent(agent.id);
    return res.json({ schedule: after ? scheduleView(after, scheduleViewFor(auth, after), new Date()) : null } satisfies WorkspaceAgentScheduleAnswer);
  });

  router.post('/api/agents/:id/seat', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const agentId = String(req.params.id ?? '');
    const agent = activeAgent(auth, agentId);
    if (!agent) {
      return res.status(404).json({ error: 'No such agent on this account' });
    }
    if (!deps.userStorage) {
      return res.status(503).json({ error: 'Not available right now' });
    }
    // A pin is also the explicit "use this existing subscription" recovery
    // the agent screen offers. Only wake when this workplace really has a
    // live seat for the provider: clearing a stale pin must never stamp an
    // agent connected against an empty account.
    const wakeFromExistingSeat = async (): Promise<void> => {
      if (!deps.agentLifecycle?.connectAgentsForSeat) return;
      const seats = await ctx.storage.listSeatsByMember(ctx.membership.orgId, auth.userId);
      if (!seats.some((candidate) => candidate.provider === agent.cli
        && (candidate.status === 'active' || candidate.status === 'cooldown'))) return;
      await deps.agentLifecycle.connectAgentsForSeat(
        auth.userId,
        agent.cli,
        ctx.membership.orgId,
      ).catch(() => { /* the pin is durable even when the wake-up hook fails */ });
    };
    const seatId = String((req.body as { seatId?: unknown } | undefined)?.seatId ?? '').trim();
    if (!seatId) {
      await deps.userStorage.updateAgentFields(auth.userId, agentId, { seatId: null });
      await wakeFromExistingSeat();
      return res.json({ ok: true, seatId: null } satisfies WorkspaceAgentSeatAnswer);
    }
    const seat = await ownSeat(ctx, seatId, res);
    if (!seat) return;
    if (seat.provider !== agent.cli) {
      const label = subscriptionName;
      return res.status(400).json({
        error: `That is a ${label(seat.provider)} subscription — ${agent.name} runs on ${label(agent.cli)}.`,
      });
    }
    if (seat.status !== 'active' && seat.status !== 'cooldown') {
      return res.status(409).json({
        error: seat.status === 'payment_required'
          ? 'Claude paused that subscription. Restore access in your Claude account before assigning it to an agent.'
          : 'That subscription is not ready to run an agent.',
      });
    }
    await deps.userStorage.updateAgentFields(auth.userId, agentId, { seatId });
    await wakeFromExistingSeat();
    return res.json({ ok: true, seatId } satisfies WorkspaceAgentSeatAnswer);
  });

  /** Persistently switch every Workspace surface into one of the caller's orgs. */
  router.post('/api/org/active', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.orgStorage) {
      return res.status(503).json({ error: 'The workplace layer is not available on this backend yet' });
    }
    const orgId = String((req.body as { orgId?: unknown } | undefined)?.orgId ?? '').trim();
    if (!orgId || !await deps.orgStorage.getMembership(orgId, auth.userId)) {
      return res.status(404).json({ error: 'No such workplace in your workspace.' });
    }
    await inheritPrivateSeats(auth.userId, orgId).catch((error) => {
      console.warn(`[org] could not carry ${auth.userId}'s subscriptions into ${orgId}:`, error);
    });
    if (!await deps.orgStorage.setActiveOrg(auth.userId, orgId)) {
      return res.status(404).json({ error: 'No such workplace in your workspace.' });
    }
    const org = await deps.orgStorage.getOrg(orgId);
    return res.json({ ok: true, orgId, name: org?.name ?? 'Workplace' });
  });

  /**
   * The agents a member drives in this workplace, as every people list names
   * them: the Workspace Agent and other purpose agents left out, oldest
   * first — the order the person made them in. `inThisOrg` places an agent
   * from before workplaces by its person's first membership.
   */
  const peopleAgentsOf = (
    profile: UserProfileDocument | null | undefined,
    inThisOrg: (agentOrgId: string | null | undefined) => boolean,
  ): AgentRecord[] => Object.values(profile?.telegram?.agents ?? {})
    .filter((agent) => inThisOrg(agent.orgId) && !agent.purpose)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));

  /**
   * What one of a member's agents is doing, for the people lists (Adam,
   * 2026-10-28: "my teammates and their statuses and what their agents
   * cooking", reversing note #346): whether a turn is running now, off the
   * in-memory registry, and its latest-work line — the same one-line recap
   * its own row carries, the summarizer's or the legacy seed. Never a word
   * of the chat that produced it; the recap is what the agent's row already
   * says to its owner.
   */
  const personAgentLiveFields = (
    ownerUserId: string,
    agent: AgentRecord,
  ): Pick<WorkspaceOrgMemberAgent, 'working' | 'recap' | 'recapAt'> => {
    const recap = agent.recap?.text ?? composeSeedAgentRecap(agent);
    return {
      ...(deps.agentLifecycle?.isAgentWorking?.(ownerUserId, agent.id) ? { working: true as const } : {}),
      ...(recap ? { recap, ...(agent.recap?.at ? { recapAt: agent.recap.at } : {}) } : {}),
    };
  };

  /**
   * The rows every people list draws (note #328): each member's
   * public-in-org facts — name, face, role, how many agents they drive here
   * — and the live half the tick then keeps current. One profile read per
   * member and nothing heavier, so a list that only needs PEOPLE never pays
   * for the workplace's record. Every people surface reads the same rows:
   * the plate, the People page and the member's own screen all say how many
   * agents somebody drives — and, since the owner's rule of 2026-09-23 that
   * a person's agents are never hidden from the rest of the workplace, WHICH:
   * each one's name and face. What each is doing stays with the person
   * driving it (note #346).
   */
  const orgPeopleRows = async (
    storage: OrgStorage,
    orgId: string,
    viewerUserId: string,
    /**
     * Filled with the workplace's whole working time (note #644) when the
     * caller wants it: every agent ever credited under this workplace, the
     * deleted ones and the removed members' included, plus the legacy
     * records whose workplace is only known by the fallback below.
     */
    work?: { totalMs: number },
  ): Promise<WorkspaceOrgMember[]> => {
    const memberships = await storage.listMembers(orgId);
    if (work) work.totalMs = deps.agentWorkLedger?.orgTotal(orgId) ?? 0;
    // What each one's agents did here this week (note #925), one read for
    // the whole list. A failed read leaves the cards as they were.
    const contributed = await contributions.read(orgId).catch(() => null);
    // Where to reach somebody (note #626): the address they sign in with,
    // else their own address on the mail domain. Everyone in the workplace
    // reads everyone's (note #632) — a colleague's address is how you reach
    // them, and it is not the admin's alone to know.
    const emailOf = async (userId: string): Promise<string | undefined> => {
      const identity = await deps.workspaceWebAuth?.identityForUser(userId).catch(() => null);
      if (identity?.kind === 'email' && identity.email) return identity.email;
      const mailbox = await deps.mailboxes?.forUser(userId).catch(() => null);
      return mailbox?.address || undefined;
    };
    const profiles = new Map<string, UserProfileDocument | null>();
    const legacyOrgByUser = new Map<string, string | null>();
    for (const member of memberships) {
      profiles.set(
        member.userId,
        deps.userStorage ? await deps.userStorage.getProfile(member.userId).catch(() => null) : null,
      );
      const historical = await storage.listMembershipsByUser(member.userId).catch(() => []);
      legacyOrgByUser.set(
        member.userId,
        [...historical].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]
          ?.orgId ?? null,
      );
    }
    // One rule for naming a human, everywhere — their profile-screen names
    // first, then the Telegram mirror; see personDisplayName.
    const nameOf = (userId: string): string => personDisplayName(profiles.get(userId));

    const members: WorkspaceOrgMember[] = [];
    for (const member of memberships) {
      const profile = profiles.get(member.userId);
      const photoUrl = await pictureUrl(profile?.person?.photo?.storagePath);
      const email = await emailOf(member.userId);
      const inThisOrg = (agentOrgId: string | null | undefined) => (
        agentOrgId ? agentOrgId === orgId : legacyOrgByUser.get(member.userId) === orgId
      );
      const memberAgents = peopleAgentsOf(profile, inThisOrg);
      // How long their agents have worked here (note #644): every agent the
      // ledger has credited under this workplace, the Workspace Agent and
      // the deleted ones included — a deleted agent's hours were asked to
      // stay, and here is where they stay, named among the former agents.
      const credited = (deps.agentWorkLedger?.userTotals(member.userId) ?? [])
        .filter((total) => inThisOrg(total.orgId));
      const workedMs = credited.reduce((sum, total) => sum + total.ms, 0);
      if (work) {
        // Legacy rows carry no workplace; they belong here by the same
        // fallback the agent count uses, and orgTotal could not see them.
        work.totalMs += credited.filter((total) => !total.orgId).reduce((sum, total) => sum + total.ms, 0);
      }
      const formerAgents = credited
        .filter((total) => total.ms > 0 && !profile?.telegram?.agents?.[total.agentId])
        .sort((a, b) => b.ms - a.ms || a.agentName.localeCompare(b.agentName))
        .map((total) => ({ name: total.agentName, workedMs: total.ms }));
      members.push({
        userId: member.userId,
        name: nameOf(member.userId),
        // The face they chose (note #57), signed like every stored picture.
        ...(photoUrl ? { photoUrl } : {}),
        ...(email ? { email } : {}),
        you: member.userId === viewerUserId,
        role: member.role,
        joinedAt: member.joinedAt,
        // The People page's live half (note #328): seen-stamp, "here now"
        // and the latest thing they drove — the same fields the people tick
        // carries, so the row opens on facts and the tick only changes them.
        ...personLiveFields(member),
        // Who let them in — absent for founders, and for inviters who have
        // since left (their name left with their profile’s membership).
        ...(member.invitedByUserId && profiles.has(member.invitedByUserId)
          ? { invitedByName: nameOf(member.invitedByUserId) }
          : {}),
        // How many agents they drive here (note #346), and which: a face and
        // a name each, and the room it works in (2026-09-23). Note #346 took
        // the list off because it carried each agent's latest-work line —
        // what an agent is DOING stays with its person — but it took the
        // names and faces with it, and those the owner wants every member
        // to see. Oldest first, the order the person made them in.
        // And, since 2026-10-28 (Adam: "what their agents cooking"), what
        // each is doing: working or not, and its latest-work line.
        agents: memberAgents.length,
        agentFaces: memberAgents.map((agent) => {
          const avatarUrl = agentFaceUrl(agent.name);
          return {
            id: agent.id,
            name: agent.name,
            ...(avatarUrl ? { avatarUrl } : {}),
            ...personAgentLiveFields(member.userId, agent),
          };
        }),
        workedMs,
        ...(formerAgents.length > 0 ? { formerAgents } : {}),
        ...(contributed ? { contribution: cardContribution(contributed.byUser.get(member.userId)) } : {}),
      });
    }
    return members;
  };

  /**
   * The org screen's whole payload: the org and every member's public-in-org
   * facts (name, role, agent count), plus open invites for admins. Sign-ins
   * are private and never appear on another member's row. One fetch per open, like
   * usage.
   */
  router.get('/api/org', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const { storage, membership } = ctx;
    const orgDoc = await storage.getOrg(membership.orgId);
    if (!orgDoc) return res.status(404).json({ error: 'This workplace no longer exists.' });

    const members = await orgPeopleRows(storage, membership.orgId, auth.userId);

    // Open invites, admins only. Null (not []) when this viewer cannot see
    // them — the page hides the block instead of claiming there are none.
    // Also null when the browser has no canonical address: an invite is its
    // link, and there would be nowhere safe to redeem one.
    // Also null, both of them, while invites are closed (RouteDeps.invitesClosed)
    // and this workplace is not one marked to have them (note #805): the page
    // then shows neither block rather than a door nobody can use.
    const showsDoor = membership.role === 'admin' && !invitesShutFor(deps.invitesClosed, orgDoc);
    const joinRequests = showsDoor ? await pendingJoinRequestRows(storage, membership.orgId) : null;
    let invites: Array<Record<string, unknown>> | null = null;
    if (showsDoor && deps.workspaceWebOrigin) {
      invites = (await storage.listInvites(membership.orgId))
        .filter((invite) => !invite.usedAt)
        .map((invite) => ({
          token: invite.token,
          link: inviteLink(invite.token),
          createdAt: invite.createdAt,
        }));
    }

    // The org's code (byo-git-design slice 6): repo facts for any org with a
    // git namespace; host, volume and backup facts only where the org has a
    // host of its own. Org #0 and every org on the central host show just
    // their repos — there is no host of theirs to report on.
    let git: Record<string, unknown> | undefined;
    if (orgDoc.git && deps.gitRepoStorage) {
      git = {
        repoCount: (await deps.gitRepoStorage.listByUser(orgDoc.git.namespaceId)).length,
        totalSizeBytes: await deps.gitRepoStorage.totalBytesForUser(orgDoc.git.namespaceId),
      };
      if (orgDoc.git.host && deps.orgGitHost) {
        const facts = await deps.orgGitHost.describeHost(membership.orgId).catch(() => null);
        if (facts) {
          git.host = {
            ...facts,
            // The grow card's price, computed where the estimate lives — the
            // page only renders it.
            growByGb: ORG_GIT_VOLUME_GROW_GB,
            growMonthlyUsd: Math.round(ORG_GIT_VOLUME_GROW_GB * VOLUME_GB_MONTHLY_USD * 100) / 100,
            // What the repos may fill, now and after one grow (note #62). The
            // ceiling follows the volume, so the tap that buys disk has to be
            // able to say what the disk buys — that it moved nothing at all
            // was half of what made the old flat cap wrong.
            repoMaxBytes: gitUserMaxBytesForVolume(facts.volumeSizeGb ?? ORG_GIT_VOLUME_GB),
            repoMaxBytesAfterGrow: gitUserMaxBytesForVolume(
              (facts.volumeSizeGb ?? ORG_GIT_VOLUME_GB) + ORG_GIT_VOLUME_GROW_GB,
            ),
          };
        }
      }
      if (orgDoc.git.backup) {
        git.backup = {
          bucket: orgDoc.git.backup.bucket,
          // The sweep's cadence, so the page can call a silence overdue
          // instead of forever printing a stale "last backup" as if fine.
          everyHours: Math.max(1, Math.round(ORG_GIT_BACKUP_INTERVAL_HOURS)),
          ...(orgDoc.git.backup.last
            ? { last: { at: orgDoc.git.backup.last.at, ok: orgDoc.git.backup.last.ok } }
            : {}),
        };
      }
    }

    // What the PLATFORM's own nightly jobs last managed (note #357). Every
    // org gets the `db` line: chats, notes and proposals live here however
    // the code is hosted. The `git` line is for an org still on the CENTRAL
    // host — those nightly bundles are literally its code's backup, and
    // without this the screen showed it nothing at all. An org with a host of
    // its own is covered by `git.backup` above and would be told, wrongly,
    // that a job touching none of its repos had backed its code up.
    let platformBackup: { code?: { at: string; ok: boolean }; workspace?: { at: string; ok: boolean } } | undefined;
    if (deps.readBackupHeartbeat) {
      const workspaceRun = deps.readBackupHeartbeat('db');
      // An org with no git namespace at all has no code to speak for, and is
      // told only about its workspace rather than reassured about nothing.
      const codeRun = orgDoc.git && !orgDoc.git.host ? deps.readBackupHeartbeat('git') : undefined;
      if (workspaceRun || codeRun) {
        platformBackup = { ...(codeRun ? { code: codeRun } : {}), ...(workspaceRun ? { workspace: workspaceRun } : {}) };
      }
    }

    // Whether the delete door is offered (owner, 2026-09-22): to every admin,
    // whatever the workplace holds — what it takes is read on the door's own
    // screen (`api/org/deletion`), so this screen pays nothing for it. The
    // platform's own workplace says why it has no door rather than hiding
    // one silently; a workplace already being deleted is kept or not from
    // its lock screen, not asked about twice.
    let danger: { canDelete: boolean; blocked?: string } | undefined;
    if (membership.role === 'admin') {
      const refusal = workplaceDeletion.standingRefusalFor(orgDoc);
      danger = refusal ? { canDelete: false, blocked: refusal } : { canDelete: !orgDoc.deletion };
    }

    // The org's face (note #56), for the screen's own header.
    const orgAvatarUrl = await pictureUrl(orgDoc.avatar?.storagePath);
    return res.json({
      org: {
        orgId: membership.orgId,
        name: orgDoc.name,
        ...(orgDoc.handle ? { handle: orgDoc.handle } : {}),
        role: membership.role,
        ...(orgAvatarUrl ? { avatarUrl: orgAvatarUrl } : {}),
        members,
        invites,
        joinRequests,
        ...(danger ?? {}),
        ...(orgDoc.deletion ? { deletion: deletionFacts(orgDoc, membership.role) } : {}),
        // The org's own cloud account (byo-fly-design slice 7). Facts only,
        // never the token; `peer` is the backend's tunnel into that account.
        fly: await cloudFacts(orgDoc),
        ...(git ? { git } : {}),
        ...(platformBackup ? { platformBackup } : {}),
      },
    });
  });

  /**
   * The org's avatar (note #56) — admin-set, like every fact about the whole
   * workplace. Raw bytes with the type in the header, the note-file shape;
   * the object lands under the org's OWN owner prefix, so a client org's
   * avatar lives in its own bucket beside its other files.
   */
  router.post(
    '/api/org/avatar',
    raw({ type: () => true, limit: PROFILE_PHOTO_MAX_BYTES + 1024 }),
    async (req, res) => {
      const auth = await authenticate(req, res);
      if (!auth) return;
      const ctx = await requireMembership(auth, res);
      if (!ctx) return;
      if (ctx.membership.role !== 'admin') {
        return res.status(403).json({ error: 'Only an admin can set the workplace picture.' });
      }
      if (!deps.mediaStorage) {
        return res.status(503).json({ error: 'Picture storage is not available on this backend yet.' });
      }
      const upload = readPictureUpload(req, res);
      if (!upload) return;
      const orgDoc = await ctx.storage.getOrg(ctx.membership.orgId);
      if (!orgDoc) return res.status(404).json({ error: 'This workplace no longer exists.' });
      const avatar = {
        storagePath: orgAvatarPath(ctx.membership.orgId, randomUUID()),
        contentType: upload.contentType,
        sizeBytes: upload.data.length,
        updatedAt: new Date().toISOString(),
        setByUserId: auth.userId,
      };
      // Bytes first, pointer second — the note-file discipline.
      await deps.mediaStorage.uploadObject({
        storagePath: avatar.storagePath,
        contentType: avatar.contentType,
        data: upload.data,
      });
      await ctx.storage.updateOrg(ctx.membership.orgId, { avatar });
      if (orgDoc.avatar?.storagePath) {
        await deps.mediaStorage.deleteObject?.({ storagePath: orgDoc.avatar.storagePath })
          .catch(() => { /* orphan, harmless */ });
      }
      return res.json({ ok: true, avatarUrl: await pictureUrl(avatar.storagePath) });
    },
  );

  /** Take the org picture off. Admin, like setting it. */
  router.delete('/api/org/avatar', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can remove the workplace picture.' });
    }
    const orgDoc = await ctx.storage.getOrg(ctx.membership.orgId);
    if (!orgDoc) return res.status(404).json({ error: 'This workplace no longer exists.' });
    if (!orgDoc.avatar) return res.status(404).json({ error: 'No picture to remove.' });
    await ctx.storage.updateOrg(ctx.membership.orgId, { avatar: undefined });
    await deps.mediaStorage?.deleteObject?.({ storagePath: orgDoc.avatar.storagePath })
      .catch(() => { /* orphan, harmless */ });
    return res.json({ ok: true });
  });

  /**
   * Grow the org git host's volume by one step (byo-git-design slice 6) —
   * a spend-scaling action on the org's own bill, so the admin's tap IS the
   * approval, and the button they tapped carried the price.
   */
  router.post('/api/org/git/volume', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') {
      return res.status(403).json({ error: 'Growing the volume is an admin action — it raises the cloud bill.' });
    }
    if (!deps.orgGitHost) {
      return res.status(503).json({ error: 'Git hosting is not configured on this backend.' });
    }
    try {
      const grown = await deps.orgGitHost.growVolume(ctx.membership.orgId);
      return res.json({ ok: true, sizeGb: grown.sizeGb });
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * Connect the org's own Fly account (byo-fly-design slice 7): validate the
   * offered slug+token against Fly BEFORE anything commits (a typo fails at
   * paste time), store the token encrypted, write the pointer, then bring the
   * backend's tunnel into that account up. Admin only — this is the org's
   * cloud bill. Re-connecting rotates in place.
   *
   * A token for a DIFFERENT Fly org is the other thing this route can be
   * asked (note #372), and it comes back as a question rather than a change:
   * see `WorkspaceOrgFlyMoveAsked`. `replace: true` is the answer to it.
   */
  router.post('/api/org/fly', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') {
      return res.status(403).json({ error: 'Connecting the cloud account is an admin action.' });
    }
    if (!deps.orgFly) {
      return res.status(503).json({ error: 'Cloud connection is not configured on this backend.' });
    }
    // Workplaces run on our cloud now (note #664: no bring-your-own option).
    // Only one that connected its own before then may rotate or move it; a
    // hosted workplace's machines are in OUR account, and pointing it at
    // another would strand every one of them where nothing could reach them.
    // The one exception is a workplace the platform marked (note #801), and
    // only while nothing of it runs in ours yet — which is why an operator
    // marks it before its first message to the Chief of Staff.
    const current = await ctx.storage.getOrg(ctx.membership.orgId);
    if (!current || (isHostedWorkplace(current) && !current.ownCloudAllowed)) {
      return res.status(409).json({ error: 'This workplace runs on the cloud, so there is no cloud account to connect.' });
    }
    if (isHostedWorkplace(current) && deps.userStorage) {
      const footprint = await hostedFootprint({
        orgStorage: ctx.storage,
        userStorage: deps.userStorage,
        ...(deps.deploymentStorage ? { deploymentStorage: deps.deploymentStorage } : {}),
        ...(deps.objectStorage
          ? {
            listPlatformBuckets: async (orgId: string) => (await deps.objectStorage!.list({ orgId, userId: auth.userId }))
              .filter((bucket) => bucket.hostedOn === 'platform').length,
          }
          : {}),
      }, current.orgId);
      const running = [
        footprint.machines ? `${footprint.machines} agent machine${footprint.machines === 1 ? '' : 's'}` : '',
        footprint.sites ? `${footprint.sites} site${footprint.sites === 1 ? '' : 's'}` : '',
        footprint.buckets ? `${footprint.buckets} storage bucket${footprint.buckets === 1 ? '' : 's'}` : '',
        footprint.messages ? 'its direct messages' : '',
      ].filter(Boolean);
      if (running.length > 0) {
        return res.status(409).json({
          error: `This workplace already has ${running.join(', ')} on our cloud, and connecting your own Fly account `
            + 'would leave them where nothing could reach them. Ask us to move them first.',
        });
      }
    }
    // The token is all the form asks for — the backend derives the org from
    // it. `orgSlug` is accepted as an optional hint (older pages, scripts).
    const body = (req.body ?? {}) as { orgSlug?: unknown; token?: unknown; replace?: unknown };
    const orgSlug = String(body.orgSlug ?? '').trim();
    const token = String(body.token ?? '').trim();
    // The slug the caller was shown and agreed to move to, never a bare yes.
    const replace = typeof body.replace === 'string' ? body.replace.trim() : '';
    if (!token) {
      return res.status(400).json({ error: 'Paste the org deploy token.' });
    }
    let connected;
    try {
      connected = await deps.orgFly.connectOrgFly({
        orgId: ctx.membership.orgId,
        ...(orgSlug ? { orgSlug } : {}),
        token,
        ...(replace ? { replace } : {}),
      });
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
    // A move nobody has agreed to yet: nothing was written, and the answer is
    // the question. 200 because the request was good and the token is good.
    if (!connected.connected) {
      const asked: WorkspaceOrgFlyMoveAsked = { ok: false, move: connected.move };
      return res.json(asked);
    }
    // The tunnel, best-effort: a failure here leaves the account connected
    // and the peer 'pending' — the next connect (or an operator ensure)
    // retries; refusing the whole connect over it would hide the progress.
    //
    // A ROTATION converges only if the interface is missing. Nothing about
    // the tunnel changed — same account, same network, same key, carried over
    // by `connectOrgFly` — and a full ensure is a down-then-up that would
    // drop every live SSH session running on it to achieve nothing. A first
    // connect and a move both need the real thing: there is no peer into that
    // account yet.
    let peer: 'up' | 'pending' | 'route-conflict' = 'pending';
    if (deps.orgWireGuard) {
      const rotation = connected.previousSlug !== undefined && !connected.moved;
      try {
        const ensured = rotation
          ? await deps.orgWireGuard.ensureUpIfMissing(ctx.membership.orgId)
          : await deps.orgWireGuard.ensureOrgWireGuard(ctx.membership.orgId);
        peer = ensured.status === 'up' ? 'up' : 'route-conflict';
      } catch (error) {
        console.warn('[miniapp] org fly connect: tunnel bring-up failed (left pending)', error);
      }
    }
    // The cloud may have been the last thing the founding waited for. Await
    // the small record-only founding edge so the next state read goes straight
    // to the arriving team; the machine builds stay detached.
    await foundIfReady(auth.userId, ctx.membership.orgId);
    const answer: WorkspaceOrgFlyAnswer = {
      ok: true,
      orgSlug: connected.orgSlug,
      appCount: connected.appCount,
      peer,
      ...(connected.previousSlug ? { previousSlug: connected.previousSlug } : {}),
      moved: connected.moved,
    };
    return res.json(answer);
  });

  /**
   * Fly's billing verdict on each workplace's own account (note #801), kept
   * five minutes: the Cloud card re-reads this route every fifteen seconds,
   * and a bill does not change that fast. A failed read is kept for a minute
   * and says nothing — the card claims no problem it could not read.
   */
  const billingReads = new Map<string, { until: number; billing: WorkspaceOrgCloudAnswer['billing'] | null }>();
  const billingOf = async (orgId: string): Promise<WorkspaceOrgCloudAnswer['billing'] | null> => {
    const kept = billingReads.get(orgId);
    if (kept && kept.until > Date.now()) return kept.billing;
    let billing: WorkspaceOrgCloudAnswer['billing'] | null = null;
    let keepMs = 5 * 60_000;
    try {
      billing = await deps.orgFly!.billingProblem(orgId);
    } catch {
      keepMs = 60_000;
    }
    billingReads.set(orgId, { until: Date.now() + keepMs, billing });
    return billing;
  };

  /** Aggregate connection and machine facts, without the admin-only spending inventory. */
  router.get('/api/org/cloud', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const org = await ctx.storage.getOrg(ctx.membership.orgId);
    if (!org) return res.status(404).json({ error: 'No such workplace.' });
    const answer: WorkspaceOrgCloudAnswer = {
      orgId: ctx.membership.orgId,
      role: ctx.membership.role,
      fly: await cloudFacts(org),
      machines: null,
    };
    if (org.fly && deps.orgFly) {
      const billing = await billingOf(ctx.membership.orgId);
      if (billing) answer.billing = billing;
    }
    // Only a workplace's OWN account is walked for machine counts: a hosted
    // one's machines are in ours, beside everybody else's.
    if (org.fly && req.query.inventory !== '0') {
      try {
        if (!deps.orgSpend) throw new Error('unavailable');
        answer.machines = await deps.orgSpend.liveMachines(ctx.membership.orgId);
      } catch {
        answer.inventoryError = 'Machine counts are unavailable. Try refreshing in a moment.';
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json(answer);
  });

  /**
   * What a NEW agent's machine is built on here, and the ladder it may be
   * moved to (note #355). Any member may read it — it is what their next
   * agent will get, and the prices are already on every agent's own machine
   * screen — and only an admin may write it, because it is the workplace's
   * cloud bill.
   */
  router.get('/api/org/agent-machine', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const org = await ctx.storage.getOrg(ctx.membership.orgId);
    if (!org) return res.status(404).json({ error: 'No such workplace.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(orgAgentMachineAnswer(org.agentMachineSizeId, ctx.membership.role));
  });

  /**
   * Choose it. The write is the org record's own field and nothing else: no
   * machine is touched, no agent is restarted, and every machine already
   * running keeps the size it is on — which is why this needs none of the
   * refusals an agent's own resize keeps.
   */
  router.post('/api/org/agent-machine', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') {
      return res.status(403).json({
        error: 'Choosing what new agents are built on is an admin action — it sets the cloud bill for the whole workplace.',
      });
    }
    const wanted = typeof req.body?.size === 'string' ? req.body.size.trim() : '';
    const size = agentMachineSizeById(wanted);
    if (!size) {
      return res.status(400).json({ error: 'Choose one of the sizes offered.' });
    }
    const org = await ctx.storage.getOrg(ctx.membership.orgId);
    if (!org) return res.status(404).json({ error: 'No such workplace.' });
    // Compared against what is IN FORCE, not against the stored field: an
    // workplace that has chosen nothing is already building new agents on
    // the platform's default, so choosing that same rung changes nothing the
    // reader can see. The field is still written — it makes the choice
    // deliberate rather than inherited, which is what `chosen` reports.
    const changed = effectiveAgentMachineSize(org.agentMachineSizeId).id !== size.id;
    await ctx.storage.updateOrg(ctx.membership.orgId, { agentMachineSizeId: size.id });
    return res.json({ ...orgAgentMachineAnswer(size.id, ctx.membership.role), ok: true, changed });
  });

  /**
   * Auto-merge (note #944): whether a proposal one of the READER's own
   * agents makes ready is merged without asking them. Each person's own
   * switch ("Each user should enable disable for itself", Adam, 1 Nov
   * 2026), so this reads the caller's membership and nobody else's.
   */
  router.get('/api/org/auto-approve', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    res.setHeader('Cache-Control', 'no-store');
    return res.json(autoApproveAnswer(ctx.membership.autoApprove));
  });

  /**
   * Turn one's own on or off. Any member, for themselves only: there is no
   * user id to name, so a teammate's switch cannot be reached, and the
   * agents' router has no verb that writes it. Every flip is recorded on the
   * membership (when), and on the person's own line of what they last did.
   */
  router.put('/api/org/auto-approve', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const on = (req.body as { on?: unknown } | undefined)?.on;
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'Pass on: true or false.' });
    const current = ctx.membership.autoApprove;
    if (Boolean(current?.on) === on) {
      // Nothing moved: no flip to record, so the history keeps meaning flips.
      return res.json({ ...autoApproveAnswer(current), ok: true, changed: false });
    }
    const at = new Date().toISOString();
    const byName = personDisplayName(await deps.userStorage?.getProfile(auth.userId).catch(() => null));
    const autoApprove: WorkplaceAutoApprove = {
      on,
      changedAt: at,
      changedByUserId: auth.userId,
      changedByName: byName,
      history: [...current?.history ?? [], { on, at, byUserId: auth.userId, byName }].slice(-AUTO_APPROVE_HISTORY_MAX),
    };
    await ctx.storage.touchMember(ctx.membership.orgId, auth.userId, { autoApprove });
    await recordPersonAction(auth, personActionLines.switchedAutoApprove(on));
    return res.json({ ...autoApproveAnswer(autoApprove), ok: true, changed: true });
  });

  /** The org's cloud inventory and honest cost estimates — admins only. */
  router.get('/api/org/spend', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only a workplace admin can inspect workplace spending.' });
    }
    if (!deps.orgSpend) {
      return res.status(503).json({ error: 'Spend reporting is not configured on this backend.' });
    }
    const hostedOrg = await ctx.storage.getOrg(ctx.membership.orgId);
    if (hostedOrg && isHostedWorkplace(hostedOrg) && !deps.privateCopy) {
      return res.status(409).json({ error: hostedSpendRefusal(await usageOf(hostedOrg.orgId)) });
    }
    try {
      const report = await deps.orgSpend.report(ctx.membership.orgId);
      // The same face the fleet row wears, by the same rule (note #319):
      // a spending row is one more place an agent is named.
      const machines = report.machines.map((machine) => {
        const avatarUrl = machine.agent ? agentFaceUrl(machine.agent.name) : undefined;
        return avatarUrl ? { ...machine, agent: { ...machine.agent, avatarUrl } } : machine;
      });
      return res.json({ ...report, machines });
    } catch (error) {
      return res.status(502).json({ error: (error as Error).message });
    }
  });

  /**
   * Take a machine no agent is on off the account (note #375).
   *
   * The screen that names those rows now offers to remove one, and this is
   * the only way to do it: an agent CLI has no verb for it, deliberately —
   * destroying infrastructure is the human's call, and this route is admin
   * only for the same reason the inventory above is.
   *
   * Every check that matters lives in the service, on purpose: the client
   * sends a name, and what makes that name safe to destroy is the walk of
   * the org's account and of every agent record, which cannot be done here
   * and must not be trusted from the browser.
   */
  router.delete('/api/org/machines/:app', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only a workplace admin can remove a machine.' });
    }
    if (!deps.orgSpend) {
      return res.status(503).json({ error: 'Spend reporting is not configured on this backend.' });
    }
    try {
      const removed = await deps.orgSpend.removeLeftoverMachine(ctx.membership.orgId, String(req.params.app ?? ''));
      return res.json({ ok: true, ...removed });
    } catch (error) {
      if (error instanceof OrgSpendError) return res.status(error.status).json({ error: error.message });
      return res.status(502).json({ error: (error as Error).message });
    }
  });

  /**
   * The tokens the caller's own agents spent, week by week — every agent of
   * theirs in every workplace, deleted ones included, and nobody else's.
   * Read off the token ledger (agent-token-ledger.ts).
   */
  router.get('/api/org/tokens', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const since = tokenWeeksSince(Date.now());
    const days = deps.agentTokenLedger?.userDays(auth.userId, since) ?? [];
    return res.json({ since, weeks: tokenWeeks(days) } satisfies WorkspaceTokenUsageAnswer);
  });

  /** The caller's own seats — never anyone else's, never the token. */
  router.get('/api/org/seats', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    let seats = await ctx.storage.listSeatsByMember(ctx.membership.orgId, auth.userId);
    let privateSeats = await ctx.storage.listSeatsByUser(auth.userId);
    // Every subscriptions page reads this route on load/focus. A fresh cache
    // returns immediately; a stale one is refreshed BEFORE its rows are
    // described. Include reusable seats from the member's other workplaces
    // because this response shows those too.
    const seen = new Map([...seats, ...privateSeats].map((seat) => [seat.seatId, seat]));
    if (deps.refreshSeatUsage && seatUsageCacheIsStale([...seen.values()])) {
      try {
        await deps.refreshSeatUsage();
        [seats, privateSeats] = await Promise.all([
          ctx.storage.listSeatsByMember(ctx.membership.orgId, auth.userId),
          ctx.storage.listSeatsByUser(auth.userId),
        ]);
      } catch { /* stale stamps still render, and say how stale they are */ }
    }
    const assignedIds = new Set(seats.map((seat) => seat.seatId));
    return res.json({
      seats: seats.map(describeSeat),
      available: privateSeats
        .filter((seat) => !assignedIds.has(seat.seatId))
        .map((seat) => ({ ...describeSeat({ ...seat, selected: false }), assigned: false })),
    });
  });

  /**
   * A seat of the caller's own, or the 404 that refuses to distinguish
   * "no such seat" from "somebody else's seat" — whose seats exist is
   * nobody's business but their owner's.
   */
  const ownSeat = async (
    ctx: { storage: OrgStorage; membership: OrgMembershipDocument },
    rawSeatId: unknown,
    res: Response,
  ): Promise<OrgSeatDocument | null> => {
    const seat = await ctx.storage.getSeat(String(rawSeatId ?? ''));
    if (!seat || seat.userId !== ctx.membership.userId
      || !await ctx.storage.isSeatAssigned(ctx.membership.orgId, ctx.membership.userId, seat.seatId)) {
      res.status(404).json({ error: 'No such subscription.' });
      return null;
    }
    return seat;
  };

  /**
   * An explicit, authoritative billing recheck. The ordinary list read keeps
   * stale rows usable during provider outages; this action must do the
   * opposite, because “payment is still required” is a claim about a live
   * provider response rather than a cached screen.
   */
  router.post('/api/org/seats/:seatId/check', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const before = await ownSeat(ctx, req.params.seatId, res);
    if (!before) return;
    if (!deps.refreshSeatUsage) {
      return res.status(503).json({ error: 'Couldn’t check Claude right now. Try again in a moment.' });
    }
    try {
      await deps.refreshSeatUsage();
    } catch {
      return res.status(503).json({ error: 'Couldn’t check Claude right now. Try again in a moment.' });
    }
    const fresh = await ctx.storage.getSeat(before.seatId);
    if (!fresh || fresh.userId !== auth.userId) {
      return res.status(404).json({ error: 'No such subscription.' });
    }
    const providerAnswered = fresh.status !== before.status
      || Boolean(fresh.subscriptionStatusReadAt
        && fresh.subscriptionStatusReadAt !== before.subscriptionStatusReadAt);
    if (!providerAnswered) {
      return res.status(503).json({ error: 'Couldn’t check Claude right now. Try again in a moment.' });
    }
    const ready = fresh.status === 'active' || fresh.status === 'cooldown';
    if (ready && deps.agentLifecycle?.connectAgentsForSeat) {
      await deps.agentLifecycle.connectAgentsForSeat(
        auth.userId,
        fresh.provider,
        ctx.membership.orgId,
      ).catch(() => { /* access is restored even if wake-up waits for the next turn */ });
    }
    return res.json({
      check: ready ? 'ready' : fresh.status === 'payment_required' ? 'payment_required' : 'attention',
      seat: describeSeat(fresh),
    });
  });

  router.post('/api/org/seats/:seatId/select', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const seat = await ownSeat(ctx, req.params.seatId, res);
    if (!seat) return;
    await ctx.storage.selectSeat(seat.seatId, ctx.membership.orgId);
    // Selecting an ALREADY signed-in seat is also a recovery action. An
    // established agent may have been paused while another usable seat was
    // sitting here as a fallback; making it primary must wake those agents
    // instead of still demanding a new OAuth ceremony.
    if (deps.agentLifecycle?.connectAgentsForSeat
      && (seat.status === 'active' || seat.status === 'cooldown')) {
      await deps.agentLifecycle.connectAgentsForSeat(
        auth.userId,
        seat.provider,
        ctx.membership.orgId,
      ).catch(() => { /* the selection is durable even when the wake-up hook fails */ });
    }
    return res.json({ ok: true });
  });

  /** Assign one of the caller's already signed-in credentials to this org. */
  router.post('/api/org/seats/:seatId/assign', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const seat = await ctx.storage.getSeat(String(req.params.seatId ?? ''));
    if (!seat || seat.userId !== auth.userId) {
      return res.status(404).json({ error: 'No such sign-in.' });
    }
    if (seat.status !== 'active' && seat.status !== 'cooldown') {
      const subscription = subscriptionName(seat.provider);
      return res.status(409).json({
        error: seat.status === 'payment_required'
          ? `${subscription} paused that subscription. Restore access in your ${subscription} account before assigning it here.`
          : 'That underlying sign-in is no longer usable. Delete it everywhere or sign in a new subscription.',
      });
    }
    const assignment = await ctx.storage.assignSeat(ctx.membership.orgId, auth.userId, seat.seatId);
    if (!assignment) return res.status(409).json({ error: 'That sign-in could not be assigned here.' });
    if (deps.agentLifecycle?.connectAgentsForSeat) {
      await deps.agentLifecycle.connectAgentsForSeat(
        auth.userId,
        seat.provider,
        ctx.membership.orgId,
      ).catch(() => { /* assignment is durable even when the wake-up hook fails */ });
    }
    return res.json({ ok: true, seat: describeSeat({ ...seat, orgId: ctx.membership.orgId, selected: true }) });
  });

  /**
   * An agent given a subscription that then leaves — unlinked from this
   * workplace, or deleted everywhere — goes back to the workplace default
   * (note #773). The lease already ignores a pin it cannot find, but a pin
   * left standing would silently rule again the day that sign-in came back,
   * long after its owner had stopped expecting it to. With `orgId`, only the
   * agents of that workplace (an unlink there leaves the others' choice
   * alone). A failed clear degrades to exactly that ignored pin.
   */
  const releaseSeatPins = async (userId: string, seatId: string, orgId?: string): Promise<void> => {
    if (!deps.userStorage) return;
    const profile = await deps.userStorage.getProfile(userId).catch(() => null);
    for (const agent of listAgents(profile?.telegram, true)) {
      if (agent.seatId !== seatId) continue;
      if (orgId && agent.orgId && agent.orgId !== orgId) continue;
      await deps.userStorage.updateAgentFields(userId, agent.id, { seatId: null }).catch(() => {});
    }
  };

  router.delete('/api/org/seats/:seatId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const seat = await ownSeat(ctx, req.params.seatId, res);
    if (!seat) return;
    await ctx.storage.unassignSeat(ctx.membership.orgId, auth.userId, seat.seatId);
    await releaseSeatPins(auth.userId, seat.seatId, ctx.membership.orgId);
    return res.json({ ok: true });
  });

  /** Delete the underlying private sign-in and therefore every org assignment. */
  router.delete('/api/seats/:seatId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (!deps.orgStorage) return res.status(503).json({ error: 'Subscriptions are not available right now.' });
    const seat = await deps.orgStorage.getSeat(String(req.params.seatId ?? ''));
    if (!seat || seat.userId !== auth.userId) {
      return res.status(404).json({ error: 'No such sign-in.' });
    }
    await deps.orgStorage.removeSeat(seat.seatId);
    await releaseSeatPins(auth.userId, seat.seatId);
    return res.json({ ok: true });
  });

  router.post('/api/org/seats/order', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const provider = String(req.body?.provider ?? '');
    const seatIds = Array.isArray(req.body?.seatIds)
      ? req.body.seatIds.map((value: unknown) => String(value))
      : [];
    if (!isHarnessCli(provider)
      || !await ctx.storage.orderSeats(ctx.membership.orgId, auth.userId, provider, seatIds)) {
      return res.status(400).json({ error: 'Send every assigned seat for that provider in the desired order.' });
    }
    return res.json({ ok: true });
  });

  /**
   * Seat sign-in from the Workspace (org-layer-design workstream 2): the
   * screen drives a deterministic state machine (OrgSeatSignInFlow) in which
   * the backend is the OAuth client for both OAuth providers — Claude's link
   * and paste, ChatGPT's one-time code — and the checker of OpenCode's
   * pasted key (note #780). Neither needs a machine, so a member can
   * sign in before any agent of theirs exists.
   */
  router.post('/api/org/signin', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (!deps.seatSignIn) {
      return res.status(503).json({ error: 'Subscription sign-in is not available on this backend yet.' });
    }
    const provider = req.body?.provider;
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'opencode') {
      return res.status(400).json({ error: 'provider must be claude, codex or opencode' });
    }
    const status = await deps.seatSignIn.start({
      userId: auth.userId,
      orgId: ctx.membership.orgId,
      provider,
    });
    // The first run (note #726): a person who tapped Claude or Codex on the
    // sign-in card in their Chief of Staff's chat is about to spend a minute
    // on the provider's page. Its computer is built now, behind the answer,
    // so the plan landing finds it standing rather than starting it. Only
    // then — a sign-in from the Seats screen builds nothing ahead.
    // Not for OpenCode: the Chief of Staff runs on Claude or ChatGPT only.
    const waiting = provider !== 'opencode'
      && Boolean((await ctx.storage.getMembership(ctx.membership.orgId, auth.userId).catch(() => null))?.workspaceRecapChat?.awaitingSeat);
    if (waiting) {
      void deps.agentLifecycle?.prepareWorkspaceAgent?.(auth.userId, ctx.membership.orgId, provider).catch((error) => {
        console.warn(`[first-run] ${ctx.membership.orgId}/${auth.userId}: the Chief of Staff's machine could not be prepared:`, error);
      });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ signin: status });
  });

  router.get('/api/org/signin', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (!deps.seatSignIn) {
      return res.status(503).json({ error: 'Subscription sign-in is not available on this backend yet.' });
    }
    // The poll IS the engine: each read advances the state machine one step.
    const status = await deps.seatSignIn.poll(auth.userId, ctx.membership.orgId);
    res.set('Cache-Control', 'no-store');
    return res.json({ signin: status });
  });

  router.post('/api/org/signin/code', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (!deps.seatSignIn) {
      return res.status(503).json({ error: 'Subscription sign-in is not available on this backend yet.' });
    }
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!code || code.length > 2000) {
      return res.status(400).json({ error: 'Paste the whole code from the sign-in page.' });
    }
    const status = await deps.seatSignIn.submitCode(auth.userId, code, ctx.membership.orgId);
    res.set('Cache-Control', 'no-store');
    return res.json({ signin: status });
  });

  router.delete('/api/org/signin', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (!deps.seatSignIn) {
      return res.status(503).json({ error: 'Subscription sign-in is not available on this backend yet.' });
    }
    await deps.seatSignIn.cancel(auth.userId, ctx.membership.orgId);
    return res.json({ ok: true });
  });

  /**
   * ONE LINK PER WORKPLACE. Reusable until an admin revokes it; every
   * applicant still needs an admin's approval, which is what makes a standing
   * link safe to hand out.
   *
   * So this mints only when the workplace has none. A second link bought
   * something when links expired on their own — an admin made a fresh one
   * because the old one was dying — and buys nothing now: revoke and make
   * another is the same act, and a drawer of live links is a drawer of
   * credentials nobody is tracking. Asking again hands back the one that
   * exists, which is also what the invite page has always wanted.
   *
   * Workplaces that already hold several keep them: those links are out
   * there in somebody's chat, and quietly killing them would lock out the
   * person about to tap one. They are listed, each revocable, and no new
   * one joins them.
   */
  router.post('/api/org/invites', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can invite people.' });
    }
    if (invitesShutFor(deps.invitesClosed, await ctx.storage.getOrg(ctx.membership.orgId))) {
      return res.status(403).json({ error: INVITES_CLOSED_MESSAGE, reason: 'closed' });
    }
    if (await refuseWhileDeleting(ctx.membership.orgId, res, 'it is not taking new people')) return;
    if (!deps.workspaceWebOrigin) {
      return res.status(503).json({ error: 'Invites are not available on this backend yet.' });
    }
    const live = (await ctx.storage.listInvites(ctx.membership.orgId)).filter((row) => !row.usedAt);
    const invite = live[0] ?? await ctx.storage.createInvite({
      orgId: ctx.membership.orgId,
      createdByUserId: auth.userId,
    });
    // The link is the credential here — same rule as the git key mint.
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      invite: {
        token: invite.token,
        link: inviteLink(invite.token),
        createdAt: invite.createdAt,
      },
    });
  });

  router.delete('/api/org/invites/:token', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can revoke invites.' });
    }
    // Scoped to THIS org before the shared verb runs: another org's token is
    // "no such invite" here, not a thing this admin can burn.
    const invite = await ctx.storage.getInvite(String(req.params.token ?? ''));
    if (!invite || invite.orgId !== ctx.membership.orgId) {
      return res.status(404).json({ error: 'No such invite.' });
    }
    const outcome = await ctx.storage.revokeInvite(invite.token);
    if (outcome === 'used') {
      return res.status(400).json({ error: 'This invite was already used — someone joined through it.' });
    }
    if (outcome === 'unknown') {
      return res.status(404).json({ error: 'No such invite.' });
    }
    return res.json({ ok: true });
  });

  /**
   * The people waiting at the door, as an admin's screen draws them. Shared
   * by the workplace record and by the tick that keeps it current, so both
   * say the same thing about the same request.
   */
  const pendingJoinRequestRows = async (storage: OrgStorage, orgId: string) => Promise.all(
    (await storage.listJoinRequests(orgId))
      .filter((request) => request.status === 'pending')
      .map(async (request) => {
        const profile = await deps.userStorage?.getProfile(request.userId);
        const identity = await deps.workspaceWebAuth?.identityForUser(request.userId);
        return {
          requestId: request.requestId,
          userId: request.userId,
          requestedAt: request.requestedAt,
          name: personDisplayName(profile),
          username: identity?.username,
        };
      }),
  );

  /**
   * Tell every admin somebody is waiting, and tell the applicant what was
   * decided. Both are durable inbox records, because both events are ones
   * the person is not looking at when they happen: the admin has no reason
   * to have the workplace screen open, and the applicant's pending page
   * polls only while they stay on it (note: the September 5 simulations
   * found the request and its decision reached nobody who had walked away).
   *
   * Delivery never decides the outcome. A membership is granted or refused
   * by the route above; this only reports it, so a notification failure is
   * logged and swallowed rather than turned into an error for a decision
   * that has already been made.
   */
  const notifyJoinRequested = async (orgId: string, orgName: string, applicantId: string, requestId: string) => {
    if (!deps.workspaceNotifications || !deps.orgStorage) return;
    const [applicant, members] = await Promise.all([
      deps.userStorage?.getProfile(applicantId).catch(() => null),
      deps.orgStorage.listMembers(orgId).catch(() => []),
    ]);
    const who = personDisplayName(applicant);
    const url = workspaceRoutePath({ kind: 'organization', orgId }) ?? '/';
    await Promise.all(members
      .filter((member) => member.role === 'admin')
      .map((member) => deps.workspaceNotifications!.notify({
        userId: member.userId,
        kind: 'approval_required',
        title: `${who} asked to join ${orgName}`,
        body: `Open ${orgName} to approve or decline. Nobody joins until an admin decides.`,
        url,
        // Per admin, per request: a second admin still gets their own copy,
        // and a reopened request never notifies the same admin twice.
        dedupeKey: `org-join-request:${requestId}:${member.userId}`,
      }).catch((error) => {
        console.warn(`[workspace-notifications] join request ${requestId} was not recorded for ${member.userId}:`, error);
      })));
  };

  const notifyJoinDecided = async (
    orgId: string, orgName: string, applicantId: string, requestId: string, approved: boolean,
  ) => {
    if (!deps.workspaceNotifications) return;
    // Approved: their new workplace. Declined: they are not a member, so
    // that screen would refuse them — the notification's own words are the
    // whole message and Home is the only place it can honestly open.
    const url = (approved ? workspaceRoutePath({ kind: 'organization', orgId }) : '/') ?? '/';
    await deps.workspaceNotifications.notify({
      userId: applicantId,
      kind: 'approval_required',
      title: approved ? `You joined ${orgName}` : `${orgName} declined your request`,
      body: approved
        ? `You are a member of ${orgName}. Open it to switch across.`
        : `Your request to join ${orgName} was declined. An admin there can send you a new link.`,
      url,
      dedupeKey: `org-join-decision:${requestId}`,
    }).catch((error) => {
      console.warn(`[workspace-notifications] the decision on join request ${requestId} was not recorded:`, error);
    });
  };

  /** Agents belong to exactly one org and retire before their owner leaves it. */
  const retireMemberAgents = async (
    userId: string,
    orgId: string,
  ): Promise<{ ok: true; retired: number } | { ok: false; reason: string }> => {
    const profile = await deps.userStorage?.getProfile(userId).catch(() => null);
    const historical = deps.orgStorage
      ? await deps.orgStorage.listMembershipsByUser(userId).catch(() => [])
      : [];
    const legacyOrgId = [...historical]
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]
      ?.orgId ?? null;
    const agents = listAgents(profile?.telegram, true).filter((agent) => (
      agent.orgId ? agent.orgId === orgId : legacyOrgId === orgId
    ));
    if (agents.length > 0 && !deps.agentLifecycle) {
      return { ok: false, reason: 'Agent retirement is unavailable right now, so the membership was kept.' };
    }
    const agentIds = new Set(agents.map((agent) => agent.id));
    const requestBelongsToMember = (
      request: { byUserId?: string; byAgentId: string },
    ): boolean => request.byUserId
      ? request.byUserId === userId
      : agentIds.has(request.byAgentId);
    const proposalBelongsToMember = (
      proposal: { createdByUserId?: string; createdByAgentId: string },
    ): boolean => proposal.createdByUserId
      ? proposal.createdByUserId === userId
      : agentIds.has(proposal.createdByAgentId);

    // A question can only be decided by the owner of the agent that asked it.
    // Withdraw that member's unanswered questions before their agents and
    // membership disappear; otherwise every other member could still see an
    // approval nobody is allowed to answer. Shared repos and sites remain —
    // only the departing member's pending asks are cleared.
    try {
      // Every namespace the org owns, not just its historical base (note
      // #85): the departing member's agents may have left open asks in any
      // room, and an ask that survives its owner is undecidable forever.
      const namespaces = deps.orgGit
        ? await deps.orgGit.namespacesForOrg(userId, orgId)
        : [(await gitNamespaceFor(userId, orgId)).namespaceId];
      const decidedAt = new Date().toISOString();
      for (const namespaceId of namespaces) {
        if (deps.gitPullRequestStorage) {
          const proposals = await deps.gitPullRequestStorage.listOpenByUser(namespaceId);
          await Promise.all(proposals
            .filter(proposalBelongsToMember)
            .map((proposal) => deps.gitPullRequestStorage!.update(proposal.id, {
              status: 'withdrawn', decidedAt,
            })));
        }
        if (deps.knowledgeProposalStorage) {
          const proposals = await deps.knowledgeProposalStorage.listOpenByUser(namespaceId);
          await Promise.all(proposals
            .filter(proposalBelongsToMember)
            .map((proposal) => deps.knowledgeProposalStorage!.update(proposal.id, {
              status: 'withdrawn', decidedAt,
            })));
        }
        if (deps.gitRepoStorage) {
          const repos = await deps.gitRepoStorage.listByUser(namespaceId);
          await Promise.all(repos.map(async (repo) => {
            const updates: {
              deleteAsk?: undefined; ciSecretsAsk?: undefined; publishAsk?: undefined; publishTo?: undefined;
            } = {};
            if (repo.deleteAsk && requestBelongsToMember(repo.deleteAsk)) updates.deleteAsk = undefined;
            if (repo.ciSecretsAsk && requestBelongsToMember(repo.ciSecretsAsk)) updates.ciSecretsAsk = undefined;
            if (repo.publishAsk && requestBelongsToMember(repo.publishAsk)) updates.publishAsk = undefined;
            // A link publishes AS the agent that asked for it; with its owner
            // gone it could only fail, so the repository goes back to being
            // published by hand, and says so.
            if (repo.publishTo && requestBelongsToMember(repo.publishTo)) updates.publishTo = undefined;
            if (Object.keys(updates).length > 0) {
              await deps.gitRepoStorage!.update(repo.id, updates);
            }
          }));
        }
      }
      if (deps.deploymentStorage) {
        const sites = await deps.deploymentStorage.listByOrg(orgId);
        await Promise.all(sites
          .filter((site) => site.deleteAsk && requestBelongsToMember(site.deleteAsk))
          .map((site) => deps.deploymentStorage!.update(site.id, { deleteAsk: undefined })));
      }
    } catch {
      return {
        ok: false,
        reason: 'Pending requests could not be closed, so the membership was kept.',
      };
    }

    if (agents.length === 0) return { ok: true, retired: 0 };
    let retired = 0;
    for (const agent of agents) {
      const result = await deps.agentLifecycle!.deleteAgent(userId, agent.id);
      if (!result.ok) {
        return {
          ok: false,
          reason: `${retired ? `${retired} agent${retired === 1 ? '' : 's'} retired, but ` : ''}${agent.name} could not be retired: ${result.reason}`,
        };
      }
      retired += 1;
    }
    return { ok: true, retired };
  };

  registerDirectMessageRoutes(router, deps, async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return null;
    const ctx = await requireMembership(auth, res);
    return ctx ? { userId: auth.userId, orgId: ctx.membership.orgId } : null;
  }, pictureUrl);

  /**
   * The people themselves, for every list that draws them: the rows and the
   * workplace they belong to, and nothing else. `api/org` answers the
   * same people inside the workplace's RECORD — invites, join requests,
   * the git host's own health, whether the delete door can work — which is a
   * dozen reads and one call out to another machine. Home draws its people
   * on every open, so it asks for this instead; the People page does too.
   */
  router.get('/api/org/people', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const orgDoc = await ctx.storage.getOrg(ctx.membership.orgId);
    if (!orgDoc) return res.status(404).json({ error: 'This workplace no longer exists.' });
    const work = { totalMs: 0 };
    const people = await orgPeopleRows(ctx.storage, ctx.membership.orgId, auth.userId, work);
    const avatarUrl = await pictureUrl(orgDoc.avatar?.storagePath);
    return res.json({
      org: {
        orgId: ctx.membership.orgId,
        name: orgDoc.name,
        role: ctx.membership.role,
        ...(avatarUrl ? { avatarUrl } : {}),
        workedMs: work.totalMs,
      },
      people,
    } satisfies WorkspacePeopleAnswer);
  });

  /**
   * The People page's tick (note #328): who is here right now and the latest
   * line on each person, from ONE membership read, and what each person's
   * agents are doing (2026-10-28) from one profile read apiece — no picture,
   * no email, no git facts. Polled every few seconds while a people list is
   * open in a workplace of more than one, which is why it is not `api/org`
   * (a dozen reads) re-read on a timer; the same split the fleet's own live
   * line has (workspace-miniapp-refresh).
   */
  router.get('/api/org/people/live', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const now = Date.now();
    const orgId = ctx.membership.orgId;
    const members = await ctx.storage.listMembers(orgId);
    // The cards' contribution (note #925) rides the same tick, from the
    // workplace's one shared read rather than one per card.
    const contributed = await contributions.read(orgId).catch(() => null);
    const people: WorkspacePersonLive[] = [];
    for (const member of members) {
      // What their agents are doing (2026-10-28): one profile read per
      // member, the walk api/agents/live already makes for the teammates
      // strip. The tick only runs where there is somebody else to watch
      // (usePeople), so a workplace of one never pays it.
      const profile = member.userId === auth.userId
        ? auth.profile
        : deps.userStorage ? await deps.userStorage.getProfile(member.userId).catch(() => null) : null;
      // An agent from before workplaces belongs to its person's first
      // membership, as on the full read — asked only when one exists.
      let legacyOrgId: string | null = null;
      if (Object.values(profile?.telegram?.agents ?? {}).some((agent) => !agent.orgId && !agent.purpose)) {
        const historical = await ctx.storage.listMembershipsByUser(member.userId).catch(() => []);
        legacyOrgId = [...historical]
          .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]?.orgId ?? null;
      }
      const inThisOrg = (agentOrgId: string | null | undefined) => (agentOrgId ? agentOrgId === orgId : legacyOrgId === orgId);
      people.push({
        userId: member.userId,
        ...personLiveFields(member, now),
        agents: peopleAgentsOf(profile, inThisOrg)
          .map((agent) => ({ id: agent.id, ...personAgentLiveFields(member.userId, agent) })),
        ...(contributed ? { contribution: cardContribution(contributed.byUser.get(member.userId)) } : {}),
      });
    }
    return res.json({ people } satisfies WorkspacePeopleLiveAnswer);
  });

  /**
   * A member's whole contribution to this workplace, for their own screen
   * (note #925): this week and all time, and every change merged this week
   * with the agent that made it. Any member reads any member's — the
   * workplace shows its people's work to its people — and nobody outside it.
   */
  router.get('/api/org/members/:userId/contribution', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const userId = String(req.params.userId ?? '');
    const target = await ctx.storage.getMembership(ctx.membership.orgId, userId).catch(() => null);
    if (!target) return res.status(404).json({ error: 'They are not in this workplace any more.' });
    const snapshot = await contributions.read(ctx.membership.orgId);
    return res.json(memberContributionAnswer(snapshot, userId) satisfies WorkspaceMemberContributionAnswer);
  });

  /** Promote or demote a member while preserving at least one administrator. */
  router.post('/api/org/members/:userId/role', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can change member roles.' });
    }
    const role = req.body?.role;
    if (role !== 'admin' && role !== 'member') {
      return res.status(400).json({ error: "Role must be 'admin' or 'member'." });
    }
    const members = await ctx.storage.listMembers(ctx.membership.orgId);
    const target = members.find((member) => member.userId === String(req.params.userId ?? ''));
    if (!target) return res.status(404).json({ error: 'No such member.' });
    if (target.role === role) return res.json({ ok: true, role });
    // A demotion counts against the same seats a departure does: the admin
    // this one is counting on may already be halfway out of the door, still
    // listed as an admin because their retirement has not finished.
    const demotion = await orgAdminSeats.giveUp({
      orgId: ctx.membership.orgId,
      userId: target.userId,
      holdsAdmin: target.role === 'admin' && role === 'member',
      listMembers: () => ctx.storage.listMembers(ctx.membership.orgId),
      settle: () => ctx.storage.setMemberRole(ctx.membership.orgId, target.userId, role),
    });
    if (!demotion.ok) {
      return res.status(409).json({ error: 'Promote another member before demoting the last admin.' });
    }
    return res.json({ ok: true, role });
  });

  /** Remove another member after permanently retiring their agents in this org. */
  router.delete('/api/org/members/:userId', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can remove members.' });
    }
    const targetUserId = String(req.params.userId ?? '');
    const members = await ctx.storage.listMembers(ctx.membership.orgId);
    const target = members.find((member) => member.userId === targetUserId);
    if (!target) return res.status(404).json({ error: 'No such member.' });
    if (target.userId === auth.userId) {
      return res.status(400).json({ error: 'You cannot remove yourself.' });
    }
    // The seat is reserved before the agents are retired, and given up only
    // once the membership row has actually moved — see `orgAdminSeats`.
    const removal = await orgAdminSeats.giveUp({
      orgId: ctx.membership.orgId,
      userId: target.userId,
      holdsAdmin: target.role === 'admin',
      listMembers: () => ctx.storage.listMembers(ctx.membership.orgId),
      settle: async () => {
        const retirement = await retireMemberAgents(target.userId, ctx.membership.orgId);
        if (!retirement.ok) return retirement;
        await ctx.storage.removeMember(ctx.membership.orgId, target.userId);
        return retirement;
      },
    });
    if (!removal.ok) {
      return res.status(409).json({ error: 'Promote another member before removing the last admin.' });
    }
    if (!removal.value.ok) return res.status(502).json({ error: removal.value.reason });
    // Removed from a copy's last workplace: signed out everywhere, now.
    await signOutOfCopy(target.userId);
    return res.json({ ok: true, retiredAgents: removal.value.retired });
  });

  /** Leave the active org. A last admin has to hand the role over first. */
  router.delete('/api/org/membership', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const members = await ctx.storage.listMembers(ctx.membership.orgId);
    const departure = await orgAdminSeats.giveUp({
      orgId: ctx.membership.orgId,
      userId: auth.userId,
      holdsAdmin: ctx.membership.role === 'admin',
      listMembers: () => ctx.storage.listMembers(ctx.membership.orgId),
      settle: async () => {
        const retirement = await retireMemberAgents(auth.userId, ctx.membership.orgId);
        if (!retirement.ok) return retirement;
        await ctx.storage.removeMember(ctx.membership.orgId, auth.userId);
        return retirement;
      },
    });
    if (!departure.ok) {
      return res.status(409).json({
        error: members.length === 1
          ? 'This is the last admin. Delete the unused workplace, or promote another member before leaving.'
          : 'Promote another member before the last admin leaves.',
      });
    }
    if (!departure.value.ok) return res.status(502).json({ error: departure.value.reason });
    const next = await ctx.storage.getMembershipByUser(auth.userId);
    return res.json({ ok: true, retiredAgents: departure.value.retired, activeOrgId: next?.orgId ?? null });
  });

  /**
   * Whether this workplace is genuinely unused — one admin left and nothing of
   * anybody's inside — and so can simply go at once, with no three days to wait
   * out. What is in the way, by name, when it cannot (note #246).
   */
  const unusedWorkplace = async (auth: MiniAppAuth, orgId: string, org: OrgDocument) => {
    const members = await deps.orgStorage!.listMembers(orgId);
    if (members.length !== 1 || members[0]?.userId !== auth.userId) return { unused: false as const, holds: null };
    const namespaceId = (await gitNamespaceFor(auth.userId, orgId)).namespaceId;
    const holds = await orgHoldings(auth, orgId, org, namespaceId);
    const total = Object.values(holds).reduce((sum, count) => sum + count, 0);
    return { unused: total === 0, holds };
  };

  /**
   * The quick delete of an unused workplace. What is left is the platform's
   * own furniture (note #144): the founding agents' records — which live on
   * the person's profile, not the org, and would otherwise outlive it.
   */
  const deleteUnusedWorkplace = async (auth: MiniAppAuth, storage: OrgStorage, orgId: string, res: Response) => {
    for (const agent of listAgents(auth.profile.telegram)) {
      if (agent.planned && agent.orgId === orgId) {
        await deps.userStorage?.removeTelegramAgent(auth.userId, agent.id).catch(() => false);
      }
    }
    await storage.removeMember(orgId, auth.userId);
    if (!await storage.deleteOrg(orgId)) {
      // The process is single-writer, but restore membership if storage still
      // refused so a failed delete never strands the user outside their org.
      await storage.addMember({ orgId, userId: auth.userId, role: 'admin' });
      await storage.setActiveOrg(auth.userId, orgId);
      return res.status(409).json({ error: 'The workplace changed while it was being deleted. Nothing was removed.' });
    }
    const next = await storage.getMembershipByUser(auth.userId);
    return res.json({ ok: true, deleted: true, activeOrgId: next?.orgId ?? null });
  };

  /**
   * Delete only a fresh, unused workplace, at once. Kept for what already
   * calls it; the Workspace now asks through `api/org/deletion`, which takes
   * this same path for an unused workplace and locks a populated one for its
   * three days instead (owner, 2026-09-22; a week until note #654).
   */
  router.delete('/api/org', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can delete an unused workplace.' });
    }
    const orgId = ctx.membership.orgId;
    const org = await ctx.storage.getOrg(orgId);
    if (!org) return res.status(404).json({ error: 'This workplace no longer exists.' });
    const members = await ctx.storage.listMembers(orgId);
    if (members.length !== 1 || members[0]?.userId !== auth.userId) {
      return res.status(409).json({
        error: 'Remove or transfer every other member before deleting this workplace.',
      });
    }

    // A room (note #85) counts as content by itself: its namespace may hold
    // repos, notes and pages this check reads none of, so an org with rooms
    // takes the offboarding flow — quick deletion would orphan those bytes.
    const { unused, holds } = await unusedWorkplace(auth, orgId, org);
    if (!unused && holds) {
      // Name it (note #246). "Resources or history" was true of eleven
      // different findings and actionable for none of them: the owner is
      // looking at a screen that says 0 repositories, and four of the eleven —
      // a room, a repository in the trash, a waiting proposal, an unspent
      // invite — appear nowhere on it at all. The room door has answered this
      // question by name since note #100; this is the same answer.
      return res.status(409).json({
        error: `${org.name} still has ${describeHoldings(holds)}.`
          + ' Clear them first, or use the offboarding flow.',
        holds,
      });
    }
    return deleteUnusedWorkplace(auth, ctx.storage, orgId, res);
  });

  /** The lock, the three days and the purge — built over these deps when index.ts did not. */
  const workplaceDeletion = deps.workplaceDeletion ?? new WorkplaceDeletionService(deps);

  /**
   * What deleting the whole workplace takes, counted across EVERY member and
   * room — the confirmation screen's list (owner, 2026-09-22). Unlike
   * {@link orgHoldings}, which asks whether the caller's own workplace is
   * empty enough to go at once, this is what a populated one loses.
   */
  const workplaceContents = async (auth: MiniAppAuth, orgId: string, org: OrgDocument) => {
    const storage = deps.orgStorage!;
    const members = await storage.listMembers(orgId);
    const memberIds = new Set(members.map((member) => member.userId));
    const namespaces = (deps.orgGit ? await deps.orgGit.namespacesForOrg(auth.userId, orgId) : [orgId])
      .filter((namespace) => !memberIds.has(namespace));
    let agents = 0;
    for (const member of members) {
      const profile = member.userId === auth.userId ? auth.profile : await deps.userStorage?.getProfile(member.userId).catch(() => null);
      agents += listAgents(profile?.telegram).filter((agent) => agent.orgId === orgId && !agent.planned).length;
    }
    const count = async (read: (namespace: string) => Promise<number>) => (
      (await Promise.all(namespaces.map((namespace) => read(namespace).catch(() => 0)))).reduce((sum, n) => sum + n, 0)
    );
    const knowledge = deps.gitHostClient && deps.knowledgeProposalStorage
      ? (await new KnowledgeService(await gitHostFor(orgId), deps.knowledgeProposalStorage, deps.knowledgeShelf)
        .listPages(orgKnowledgeShelfNamespace(org)).catch(() => [])).length
      : 0;
    return {
      people: members.length,
      agents,
      repos: deps.gitRepoStorage ? (await deps.gitRepoStorage.listLiveIn(namespaces)).length : 0,
      sites: deps.deploymentStorage
        ? (await deps.deploymentStorage.listByOrg(orgId)).filter((site) => site.status !== 'destroyed').length
        : 0,
      notes: deps.quickNoteStorage
        ? await count(async (namespace) => (await deps.quickNoteStorage!.listByUser(namespace)).length
          + (await deps.quickNoteStorage!.listArchivedByUser(namespace)).length)
        : 0,
      knowledge,
      drive: (await deps.driveStorage?.read(orgId).catch(() => null))?.size ?? 0,
      secrets: deps.secretStorage
        ? await count(async (namespace) => (await deps.secretStorage!.getUserSecrets(namespace)).length)
        : 0,
    };
  };

  /**
   * The workplace's cloud, as its own record can honestly state it (note #642).
   *
   * `peer` used to be `wireguard ? 'up' : 'pending'`, and "pending" was a
   * claim about the FUTURE that the record could not support. Three different
   * situations wore it: a tunnel genuinely mid-setup, one whose bring-up had
   * failed, and org #0's — whose network the host already routes, so its peer
   * is rolled back by the route guard on every single attempt and would have
   * said "coming up" until the end of time. The user asked why his said that
   * (2026-09-23) and the honest answer was "because it cannot tell".
   *
   * So the states are what a reader can act on, and each one occurs:
   *   up               a peer is up, or was recorded before we kept outcomes
   *   routed-elsewhere the network is already routed — the machines ARE
   *                    reachable and no tunnel of ours is wanted (org #0)
   *   failed           the last attempt threw; agents here may be unreachable
   *   unknown          nobody has tried since we started keeping the answer,
   *                    which is a silence rather than a reassurance
   *
   * The CHECK wins over the peer when both are present: a registered peer
   * whose interface was never installed is exactly the connect-time failure
   * `ensureUpIfMissing` exists to heal, and reading it as "up" is the lie
   * that hid it.
   */
  const cloudFacts = async (org: OrgDocument): Promise<WorkspaceOrgDetail['fly']> => (org.fly
    ? {
      connected: true as const,
      orgSlug: org.fly.orgSlug,
      peer: (org.fly.peerCheck?.status
        ?? (org.fly.wireguard ? 'up' : 'unknown')) as 'up' | 'routed-elsewhere' | 'failed' | 'unknown',
    }
    // Hosted on ours (note #664): nothing to name and no tunnel of its own —
    // what there is to say is how much of its allowance the workplace uses,
    // and, on a workplace the platform marked (note #801), that it may
    // connect a Fly account of its own.
    : {
      connected: false as const,
      hosted: true as const,
      ...await usageOf(org.orgId),
      ...(org.ownCloudAllowed ? { ownCloudAllowed: true as const } : {}),
    });

  /** A hosted workplace's allowance and what it uses of it (note #664). */
  const usageOf = async (orgId: string): Promise<HostedUsage> => (deps.orgStorage && deps.userStorage
    ? hostedUsage({
      orgStorage: deps.orgStorage,
      userStorage: deps.userStorage,
      ...(deps.deploymentStorage ? { deploymentStorage: deps.deploymentStorage } : {}),
    }, orgId)
    : { agents: { used: 0, limit: HOSTED_AGENT_LIMIT }, sites: { used: 0, limit: HOSTED_SITE_LIMIT } });

  /** The deletion as every member's screen reads it. Only an admin keeps it,
   *  and nobody once the three days are up: the purge may already be under way. */
  const deletionFacts = (org: OrgDocument, role: string) => (org.deletion
    ? {
      requestedAt: org.deletion.requestedAt,
      purgeAt: org.deletion.purgeAt,
      requestedByName: org.deletion.requestedByName,
      canKeep: role === 'admin' && !org.deletion.purge && org.deletion.purgeAt > new Date().toISOString(),
    }
    : undefined);

  /**
   * The confirmation screen's read (owner, 2026-09-22): what goes, what stays
   * in the workplace's own cloud account, when it will be gone — or that it
   * goes at once, when nothing and nobody else is in it.
   */
  /**
   * A private copy's health, for an admin of the workplace asking (note #813):
   * one live line per part of the copy. Not a copy, no page.
   */
  router.get('/api/copy/health', async (req, res) => {
    if (!deps.copyHealth) return res.status(404).json({ error: 'Only a private copy has this page.' });
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') return res.status(403).json({ error: 'Only an admin sees how this copy is doing.' });
    return res.json(await deps.copyHealth.report());
  });

  /**
   * What's new (note #1006): the releases newer than the one this copy runs,
   * and the running one, each with its notes from the update service. For an
   * admin of the workplace; not a copy, no screen.
   */
  router.get('/api/copy/releases', async (req, res) => {
    if (!deps.copyHealth) return res.status(404).json({ error: 'Only your own Agentic Cloud has this screen.' });
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') return res.status(403).json({ error: 'Only an admin sees what each release brings.' });
    return res.json(await deps.copyHealth.releases());
  });

  /**
   * The diagnostics bundle (note #813): the health report and which settings
   * are set, as a file the admin downloads. It leaves the copy only if they
   * send it to us; nothing here sends anything anywhere.
   */
  /** A licence renewal, pasted by an admin (note #814): kept if it is ours,
   *  for this copy's domain; refused in words if not. */
  router.post('/api/copy/licence', async (req, res) => {
    if (!deps.copyLicence) return res.status(404).json({ error: 'This copy has no licence check.' });
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') return res.status(403).json({ error: 'Only an admin can change the licence.' });
    const pasted = await deps.copyLicence.paste(String(req.body?.licence ?? ''));
    if (!pasted.ok) return res.status(400).json({ error: pasted.why });
    return res.json({ state: pasted.status.state, line: pasted.status.line });
  });

  /**
   * Email, set up after the install (note #946): for an admin of the
   * workplace asking, in a copy. The provider first, then the receiver in the
   * copy's own Fly organization, then the records, checked until they are
   * right, when mail turns on by itself. No answer ever carries a key.
   */
  const copyMailAdmin = async (req: Request, res: Response) => {
    if (!deps.copyMail) {
      res.status(404).json({ error: 'Only your own Agentic Cloud sets up its email here.' });
      return null;
    }
    const auth = await authenticate(req, res);
    if (!auth) return null;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return null;
    if (ctx.membership.role !== 'admin') {
      res.status(403).json({ error: 'Only an admin sets up email.' });
      return null;
    }
    return deps.copyMail;
  };
  const copyMailAnswer = async (res: Response, run: () => Promise<unknown>) => {
    try {
      return res.json(await run());
    } catch (error) {
      if (error instanceof CopyMailSetupError) return res.status(error.status).json({ error: error.message });
      console.warn('[copy-mail] setup step failed:', error);
      return res.status(502).json({ error: `That did not work: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  router.get('/api/copy/mail', async (req, res) => {
    const mail = await copyMailAdmin(req, res);
    if (!mail) return;
    return res.json(mail.status());
  });
  router.post('/api/copy/mail/provider', async (req, res) => {
    const mail = await copyMailAdmin(req, res);
    if (!mail) return;
    return copyMailAnswer(res, () => mail.setProvider(req.body as WorkspaceCopyMailProviderInput));
  });
  router.post('/api/copy/mail/receiver', async (req, res) => {
    const mail = await copyMailAdmin(req, res);
    if (!mail) return;
    return copyMailAnswer(res, () => mail.createReceiver());
  });
  router.post('/api/copy/mail/check', async (req, res) => {
    const mail = await copyMailAdmin(req, res);
    if (!mail) return;
    return copyMailAnswer(res, () => mail.check());
  });

  router.get('/api/copy/diagnostics', async (req, res) => {
    if (!deps.copyHealth) return res.status(404).json({ error: 'Only a private copy has this file.' });
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    if (ctx.membership.role !== 'admin') return res.status(403).json({ error: 'Only an admin can download this copy\'s diagnostics.' });
    const health = await deps.copyHealth.diagnostics();
    // The last upgrade's steps (note #1008), without who asked: the bundle holds no names.
    const run = deps.copyUpgrade ? await deps.copyUpgrade.state().then((state) => state.run).catch(() => null) : null;
    const bundle = run ? { ...health, lastUpgrade: { ...run, requestedBy: null } } : health;
    const day = bundle.generatedAt.slice(0, 10);
    res.setHeader('content-disposition', `attachment; filename="copy-diagnostics-${day}.json"`);
    return res.json(bundle);
  });

  /**
   * The Upgrade button (note #1008): its state for an admin, and the start.
   * Every change here is a POST, so authenticate() has already checked the
   * exact Workspace origin and the CSRF token. One run at a time, refused in
   * words while one is open, a machine is mid-deploy, the disk is short or a
   * Claude sign-in is open (services/copy-upgrade.ts).
   */
  const copyUpgradeAdmin = async (req: Request, res: Response) => {
    if (!deps.copyUpgrade) {
      res.status(404).json({ error: 'Only your own Agentic Cloud upgrades from here.' });
      return null;
    }
    const auth = await authenticate(req, res);
    if (!auth) return null;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return null;
    if (ctx.membership.role !== 'admin') {
      res.status(403).json({ error: 'Only an admin can upgrade this Agentic Cloud.' });
      return null;
    }
    return { upgrade: deps.copyUpgrade, by: auth.profile.displayName || 'An admin' };
  };
  const copyUpgradeAnswer = async (res: Response, run: () => Promise<unknown>) => {
    try {
      return res.json(await run());
    } catch (error) {
      if (error instanceof CopyUpgradeRefused) return res.status(error.status).json({ error: error.message });
      console.warn('[copy-upgrade] could not start:', error);
      return res.status(502).json({ error: `The upgrade could not start: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  router.get('/api/copy/upgrade', async (req, res) => {
    const ok = await copyUpgradeAdmin(req, res);
    if (!ok) return;
    return copyUpgradeAnswer(res, () => ok.upgrade.state());
  });
  router.post('/api/copy/upgrade', async (req, res) => {
    const ok = await copyUpgradeAdmin(req, res);
    if (!ok) return;
    const drill = req.body?.drill === 'backend' ? 'backend' : req.body?.drill === 'rollback' ? 'rollback' : null;
    return copyUpgradeAnswer(res, () => ok.upgrade.start({ version: String(req.body?.version ?? ''), drill, by: ok.by }));
  });
  router.post('/api/copy/upgrade/carry-on', async (req, res) => {
    const ok = await copyUpgradeAdmin(req, res);
    if (!ok) return;
    return copyUpgradeAnswer(res, () => ok.upgrade.carryOn(ok.by));
  });

  router.get('/api/org/deletion', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const orgId = ctx.membership.orgId;
    const org = await ctx.storage.getOrg(orgId);
    if (!org) return res.status(404).json({ error: 'This workplace no longer exists.' });
    if (ctx.membership.role !== 'admin') return res.status(403).json({ error: 'Only an admin can delete this workplace.' });
    const refusal = await workplaceDeletion.refusalFor(org);
    if (refusal) return res.status(403).json({ error: refusal });
    const { unused } = await unusedWorkplace(auth, orgId, org);
    return res.json({
      name: org.name,
      holds: await workplaceContents(auth, orgId, org),
      immediate: unused,
      purgeAt: org.deletion?.purgeAt ?? workplaceDeletion.purgeAtFrom(new Date()),
      ...(org.fly?.orgSlug ? { cloud: org.fly.orgSlug } : {}),
      ...(org.deletion ? { deletion: deletionFacts(org, ctx.membership.role) } : {}),
    });
  });

  /**
   * An admin deletes the workplace (owner, 2026-09-22). The name, typed, rides
   * the request and is checked here too: the screen's confirmation is the
   * gesture, and this is what makes it binding. An unused workplace goes at
   * once; any other is locked for its three days and every member is emailed.
   */
  router.post('/api/org/deletion', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const orgId = ctx.membership.orgId;
    const org = await ctx.storage.getOrg(orgId);
    if (!org) return res.status(404).json({ error: 'This workplace no longer exists.' });
    if (ctx.membership.role !== 'admin') return res.status(403).json({ error: 'Only an admin can delete this workplace.' });
    const typed = String((req.body as { name?: unknown } | undefined)?.name ?? '').trim();
    if (typed !== org.name) return res.status(400).json({ error: 'Type the workplace’s name exactly to delete it.' });
    const refusal = await workplaceDeletion.refusalFor(org);
    if (refusal) return res.status(403).json({ error: refusal });
    if (!org.deletion && (await unusedWorkplace(auth, orgId, org)).unused) {
      return deleteUnusedWorkplace(auth, ctx.storage, orgId, res);
    }
    const scheduled = await workplaceDeletion.schedule({ orgId, userId: auth.userId });
    if (!scheduled.ok) return res.status(scheduled.status).json({ error: scheduled.error });
    return res.json({ ok: true, deletion: deletionFacts({ ...org, deletion: scheduled.deletion }, 'admin') });
  });

  /** Any admin keeps it, until the three days are up. */
  router.delete('/api/org/deletion', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const ctx = await requireMembership(auth, res);
    if (!ctx) return;
    const kept = await workplaceDeletion.cancel({ orgId: ctx.membership.orgId, userId: auth.userId });
    if (!kept.ok) return res.status(kept.status).json({ error: kept.error });
    return res.json({ ok: true });
  });

  for (const pattern of workspacePublicPathPatterns()) router.get(pattern, redirectPublicToRoot);

  return router;
}
