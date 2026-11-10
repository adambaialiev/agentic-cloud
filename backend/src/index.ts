import { SqliteDirectMessageStorage } from './services/sqlite/sqlite-direct-message-storage.js';
import { SqliteDirectMessageUnreadStore } from './services/sqlite/sqlite-direct-message-unread-store.js';
import { isHarnessCli } from './shared/harness-clis.js';
import { RemoteDirectMessageStorage } from './services/remote-direct-message-storage.js';
import type { DirectMessageStorage } from './services/direct-message-storage.js';
import { OrgMsgHostService } from './services/org-msg-host.js';
import { SqliteMailboxStorage } from './services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from './services/sqlite/sqlite-mail-message-storage.js';
import { SqliteMailApprovalStorage } from './services/sqlite/sqlite-mail-approval-storage.js';
import { InMemoryMailApprovalStorage } from './services/mail-approval-storage.js';
import { MailApprovalService } from './services/mail-approval.js';
import { DirectMessageApprovalService, InMemoryDirectMessageApprovalStorage, SqliteDirectMessageApprovalStorage } from './services/direct-message-approval.js';
import { MailboxService } from './services/mailbox-service.js';
import { OrgHandleService } from './services/org-handles.js';
import { DEFAULT_BRAND_FILES_DIR, workspaceRootRoutes } from './routes/workspace-root.js';
import { workspaceRoutePath } from './shared/workspace-routes.js';
import { MailIngestService } from './services/mail-ingest.js';
import { MailWakeService } from './services/mail-wake.js';
import { MailOutboxService } from './services/mail-outbox.js';
import { ResendMailSender } from './services/mail-sender.js';
import 'dotenv/config';
import './lib/ai-provider.js';
import { outreachLinkRoutes } from './routes/outreach-links.js';
import { RESEND_WEBHOOK_PATH, outreachMailEventRoutes } from './routes/outreach-mail-events.js';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { SessionManager } from './agent/session-manager.js';
import { globalEventEmitter } from './agent/agent-event-emitter.js';
import { globalBackgroundRunner } from './agent/background-runner.js';
import { InMemorySandboxStorage } from './services/sandbox-storage.js';
import { openSqliteDb } from './services/sqlite/sqlite-db.js';
import { readUserRoster } from './services/sqlite/sqlite-user-roster.js';
import { SqliteSessionStorage } from './services/sqlite/sqlite-session-storage.js';
import { SqliteAgentChatStorage, InMemoryAgentChatStorage } from './services/agent-chat-storage.js';
import { SqliteSecretStorage } from './services/sqlite/sqlite-secret-storage.js';
import { SqliteUserStorage } from './services/sqlite/sqlite-user-storage.js';
import { SqliteWorkspaceWebAuthStorage } from './services/sqlite/sqlite-workspace-web-auth.js';
import { SqliteWorkspaceNotificationStorage } from './services/sqlite/sqlite-workspace-notifications.js';
import { SqlitePendingTurnStorage } from './services/sqlite/sqlite-pending-turn-storage.js';
import { InMemorySeatSignInStorage } from './services/seat-signin-storage.js';
import { SqliteSeatSignInStorage } from './services/sqlite/sqlite-seat-signin-storage.js';
import { SqliteStoppedUserMessageStorage } from './services/sqlite/sqlite-stopped-user-message-storage.js';
import { SqliteAgentActivityStore } from './services/sqlite/sqlite-agent-activity-store.js';
import { InMemoryPublicGuideStorage, SqlitePublicGuideStorage } from './services/public-guide-storage.js';
import { PublicGuideService } from './services/public-guide-service.js';
import { GuestAgentService } from './services/guest-agent-service.js';
import { GuestModelDoor, GUEST_MODEL_DOOR_PATH } from './services/guest-model-door.js';
import { InMemoryGuestAgentStorage, SqliteGuestAgentStorage } from './services/guest-agent-storage.js';
import { GUEST_AGENT_KIND } from './shared/guest-agent.js';
import type { GuideSource } from './services/public-guide-machine.js';
import type { AgentRecord } from './types/user.js';
import { PUBLIC_GUIDE_REPO_NAME } from './shared/public-guide.js';
import { SqliteAgentWorkLedger } from './services/sqlite/sqlite-agent-work-ledger.js';
import { InMemoryAgentWorkLedger } from './services/agent-work-ledger.js';
import { SqliteAgentTokenLedger } from './services/sqlite/sqlite-agent-token-ledger.js';
import { InMemoryAgentTokenLedger } from './services/agent-token-ledger.js';
import { SqlitePlatformCredentialPool } from './services/sqlite/sqlite-platform-credential-pool.js';
import { SqliteOrgStorage } from './services/sqlite/sqlite-org-storage.js';
import { InMemoryOrgStorage } from './services/org-storage.js';
import { OrgSeatCredentialSource, seatToCredentialDoc } from './services/org-seat-credentials.js';
import { isLeasable } from './services/platform-credential-pool.js';
import { AgentScheduleService } from './services/agent-schedules.js';
import { InMemoryAgentScheduleStorage } from './services/agent-schedule-storage.js';
import { SqliteAgentScheduleStorage } from './services/sqlite/sqlite-agent-schedules.js';
import { resolveEffectiveModel as scheduleEffectiveModel } from './agent/harness-models.js';
import { resolveContextUsage as scheduleContextUsage } from './utils/context-window.js';
import { OrgSecretsService } from './services/org-secrets.js';
import { OrgFlyService } from './services/org-fly.js';
import { OrgGitService } from './services/org-git.js';
import { OrgGitHostService } from './services/org-git-host.js';
import { OrgGitBackupService, describeOrgGitSweep } from './services/org-git-backup.js';
import { backfillLegacyOrgOwnership } from './services/org-ownership-backfill.js';
import { OrgCiService } from './services/org-ci.js';
import { DatabaseBucketBackup } from './services/database-bucket-backup.js';
import { MediaBucketMirror } from './services/media-bucket-mirror.js';
import { createCopyHealth } from './services/copy-health.js';
import { createReleaseCheck, updatesUrlFrom } from './services/copy-release-check.js';
import { InMemoryCopyPulseStore } from './services/copy-pulse-storage.js';
import { InMemoryCopyPulseKeyStore, SqliteCopyPulseKeyStore } from './services/copy-pulse-keys.js';
import { createCopyPulse, InMemoryCopyPulseSettingsStore, pulseUrlFrom, SqliteCopyPulseSettingsStore } from './services/copy-pulse-sender.js';
import { collectCopyPulseFacts } from './services/copy-pulse-facts.js';
import { copyPulseHandler } from './routes/copy-pulse.js';
import { SqliteCopyPulseStore } from './services/sqlite/sqlite-copy-pulse-storage.js';
import { OutreachService } from './services/outreach.js';
import { InMemoryOutreachStore } from './services/outreach-storage.js';
import { SqliteOutreachStore } from './services/sqlite/sqlite-outreach-storage.js';
import { InMemoryOutreachPassStore, OutreachPasses, SqliteOutreachPassStore } from './services/outreach-pass.js';
import { OUTREACH_SITE_ORIGIN_DEFAULT, outreachSiteCors } from './routes/outreach.js';
import { CopyLicence, SqliteLicenceStore, InMemoryLicenceStore } from './services/copy-licence.js';
import { readFileSync as readFileSyncNode } from 'node:fs';
import { dirname as dirnameNode } from 'node:path';
import { readFile as readFileNode, writeFile as writeFileNode } from 'node:fs/promises';
import { DEFAULT_MAIL_DOMAIN, MAIL_DOMAIN } from './shared/workspace-mail.js';
import { FlyAppOrgContextResolver } from './services/fly-app-org-context.js';
import { OrgSpendService } from './services/org-spend.js';
import { OrgWireGuardService } from './services/org-wireguard.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { OrgSeatSignInFlow } from './services/org-seat-signin-flow.js';
import { OpsBotService } from './services/ops-bot-service.js';
import { SqliteDeploymentStorage } from './services/sqlite/sqlite-deployment-storage.js';
import { SqliteStorageBucketStorage } from './services/sqlite/sqlite-storage-bucket-storage.js';
import { InMemoryStorageBucketStorage } from './services/storage-bucket-storage.js';
import { ObjectStorageService } from './services/object-storage.js';
import { UserSecretsService, SHARED_USER_SECRET_SCOPE } from './services/user-secrets.js';
import { HOSTED_BUCKET_GB, HOSTED_BUCKET_LIMIT } from './config/access.js';
import { InMemoryDeploymentStorage } from './services/deployment-storage.js';
import { SqliteGitRepoStorage } from './services/sqlite/sqlite-git-repo-storage.js';
import { InMemoryGitRepoStorage } from './services/git-repo-storage.js';
import { SqliteGitPullRequestStorage } from './services/sqlite/sqlite-git-pr-storage.js';
import { SqliteKnowledgeProposalStorage } from './services/sqlite/sqlite-knowledge-storage.js';
import { InMemoryKnowledgeProposalStorage } from './services/knowledge-storage.js';
import { SqliteKnowledgePageCommentStorage } from './services/sqlite/sqlite-knowledge-page-comments.js';
import { InMemoryKnowledgePageCommentStorage, shelfMappedPageComments } from './services/knowledge-page-comments.js';
import type { KnowledgeShelfResolver } from './services/knowledge-service.js';
import { backfillRoomMerge } from './services/room-merge-backfill.js';
import { dropRooms } from './services/room-drop.js';
import { InMemoryLegacyRooms } from './services/legacy-rooms.js';
import { SqliteLegacyRooms } from './services/sqlite/sqlite-legacy-rooms.js';
import { ShelfMappedSecretStorage } from './services/shelf-mapped-secret-storage.js';
import { settleOpenKnowledgeProposals } from './services/knowledge-direct-backfill.js';
import { transferSchoolReposToPersonal } from './services/school-repo-transfer.js';
import { transferSchoolSiteToPersonal } from './services/school-site-transfer.js';
import { InMemoryDriveStorage } from './services/drive-storage.js';
import { SqliteDriveStorage } from './services/sqlite/sqlite-drive-storage.js';
import { InMemoryRadioStorage } from './services/radio-storage.js';
import { SqliteRadioStorage } from './services/sqlite/sqlite-radio-storage.js';
import { RadioStation } from './services/radio-station.js';
import { RadioLibrary } from './services/radio-library.js';
import { SqliteQuickNoteStorage } from './services/sqlite/sqlite-quick-note-storage.js';
import { InMemoryQuickNoteStorage } from './services/quick-note-storage.js';
import { InMemoryGitPullRequestStorage } from './services/git-pr-storage.js';
import { SqliteGitCommitStatusStorage } from './services/sqlite/sqlite-git-commit-status-storage.js';
import { SqliteBackupHeartbeatStore } from './services/sqlite/sqlite-backup-heartbeats.js';
import {
  BackupStalenessMonitor,
  InMemoryBackupHeartbeatStore,
  createOpsNotifier,
} from './services/backup-monitor.js';
import { InMemoryGitCommitStatusStorage } from './services/git-commit-status-storage.js';
import { GitHostClient } from './services/git-host-client.js';
import { CloudflareAppsDns, DeploymentService } from './services/deployment-service.js';
import { resolveSiteSecrets } from './services/site-secrets.js';
import { WORKPLACE_DELETION_SWEEP_MS, WorkplaceDeletionService } from './services/workplace-deletion.js';
import { HostingFulfilment } from './services/hosting-fulfilment.js';
import { siteRedirectHandler, siteTlsAskHandler } from './services/site-redirects.js';
import {
  PreviewDomainService,
  previewMapHandler,
  previewMappingsFromProfiles,
  siteMappingsFromDeployments,
} from './services/preview-domain-service.js';
import { SqliteConfigDocSource } from './services/sqlite/sqlite-config-docs.js';
import { InMemorySessionStorage } from './services/session-storage.js';
import { InMemorySecretStorage } from './services/secret-storage.js';
import { secretCipherFromEnv } from './services/secret-cipher.js';
import { EncryptedSecretStorage } from './services/encrypted-secret-storage.js';
import { InMemoryUserStorage } from './services/user-storage.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from './services/workspace-web-auth.js';
import { ResendWorkspaceVerificationEmailSender } from './services/workspace-verification-email.js';
import {
  InMemoryWorkspaceNotificationStorage,
  WorkspaceNotificationService,
} from './services/workspace-notifications.js';
import { UserDevelopmentEnvironmentManager } from './services/user-sandbox-manager.js';
import { createS3MediaStorageFromEnv } from './services/s3-media-storage.js';
import { OrgMediaService, OrgRoutedMediaStorage } from './services/org-media.js';
import { AgentService } from './services/agent-service.js';
import { AgentConfigService } from './services/agent-config-service.js';
import { HarnessCliVersionService } from './services/harness-cli-versions.js';
import { createPinFollower, pinFollowerDocs, pinsUrlFrom } from './services/harness-cli-pin-follower.js';
import { HarnessCliUpdater } from './services/harness-cli-updater.js';
import { InMemoryPendingTurnStorage } from './services/pending-turn-storage.js';
import { InMemoryStoppedUserMessageStorage } from './services/stopped-user-message-storage.js';
import { InMemoryAgentActivityStore } from './services/agent-activity-store.js';
import { VoiceTranscriptionService, voicePauseReasonFor } from './services/voice-transcription-service.js';
import { WorkplaceVoiceService } from './services/workplace-voice.js';
import { OpenRouterAccountClient } from './services/openrouter-account.js';
import { PROCESS_SHUTDOWN_ABORT_REASON } from './agent/abort-reason.js';
import { consumeSystemdListenFd } from './services/systemd-listen.js';
import { RetiredSandboxClient } from './services/retired-sandbox-client.js';
import { FlySandboxClient } from './services/fly-sandbox-client.js';
import { FlyClient } from './services/fly-client.js';
import { CopyPeerRepin } from './services/copy-peer-repin.js';
import { ensureCopyUpgrader, upgraderAppName } from './services/copy-upgrader.js';
import { platformAppNames } from './services/platform-apps.js';
import { createCopyUpgrade, s3UpgradeBucket } from './services/copy-upgrade.js';
import { SmtpMailSender, SmtpWorkspaceVerificationEmailSender, createSmtpTransport, smtpSettingsFromEnv } from './services/smtp-mail.js';
import {
  CopyMailSetup, InMemoryCopyMailSetupStore, SqliteCopyMailSetupStore, type CopyMailSending,
} from './services/copy-mail-setup.js';
import type { WorkspaceVerificationEmailSender } from './services/workspace-verification-email.js';
import type { MailSender } from './services/mail-sender.js';
import { parseFlySandboxId, parseFlyServerRecordId } from './services/fly-sandbox-id.js';
import { listAgents } from './types/user.js';
import { RoutingSandboxClient } from './services/routing-sandbox-client.js';
import { FlyIdleReaper, InMemoryFlyIdleReaperAlertStore } from './services/fly-idle-reaper.js';
import { SqliteFlyIdleReaperAlertStore } from './services/sqlite/sqlite-fly-idle-reaper-alerts.js';
import { DEFAULT_DEVELOPMENT_SSH_USER } from './services/development-root.js';
import { MachineImageUpdater } from './services/machine-image-updater.js';
import {
  InMemoryPlatformCredentialPool,
  PlatformCredentialUsageRefresher,
} from './services/platform-credential-pool.js';
import { recordAgentRuntimeSamples } from './services/machine-runtime-meter.js';
import { recordAgentMachineShapes } from './services/agent-machine-observer.js';
import { FlyAgentRecycler } from './services/fly-agent-recycler.js';
import { globalSshClient } from './services/ssh-client.js';
import { countActiveDetachedTurns, markHarnessShutdown } from './agent/harness-turn-output.js';
import { buildAssistantSessionId } from './services/agent-service.js';
import {
  InMemoryManagedServerStorage,
  ManagedServerService,
} from './services/managed-server-service.js';
import { webhookRoutes } from './routes/webhooks.js';
import { agentCliRoutes } from './routes/agent-cli.js';
import { workspaceRoutes } from './routes/workspace.js';
import { opsMiniAppRoutes } from './routes/ops-miniapp.js';
import type { RouteDeps } from './routes/deps.js';
import { resolveConfiguredModel } from './config/models.js';
import { resolveAgentbuiltApiUrl } from './config/agentbuilt.js';
import { createCorsOptions, resolveAllowedCorsOrigins } from './config/cors.js';

/** Like {@link parsePositiveIntEnv} but allows 0, so a feature can be switched off. */
function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  console.warn(`[config] Invalid ${name}="${raw}", using fallback ${fallback}`);
  return fallback;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function parseCsvEnv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

// ── Environment ──

const app = express();
// Production terminates HTTPS in the same-host reverse proxy. Trust only that
// loopback hop so auth rate limits see the visitor address from
// X-Forwarded-For without accepting a spoofed header on a direct connection.
//
// On Fly (note #1032, stage 4) the hop is Fly's proxy, which connects from
// 172.16.0.0/12, and during the move also ia-backend's Caddy over WireGuard.
// TRUST_PROXY names those hops (Express's comma list). Left at loopback, every
// visitor would arrive as the proxy's one address and share a single sign-in
// rate limit. Never a whole fdaa range: any machine on the private network
// could then claim to be anyone.
const TRUST_PROXY = process.env.TRUST_PROXY?.trim() || 'loopback';
app.set('trust proxy', TRUST_PROXY);
if (TRUST_PROXY !== 'loopback') console.log(`[config] TRUST_PROXY=${TRUST_PROXY}`);
const PORT = process.env.PORT || 3001;
const CORS_ORIGINS = resolveAllowedCorsOrigins(process.env.CORS_ORIGIN);
const CORS_ORIGIN = CORS_ORIGINS[0];
const SHUTDOWN_HARD_EXIT_MS = parsePositiveIntEnv('SHUTDOWN_HARD_EXIT_MS', 25_000);
// How long an in-flight HTTP request may keep the old process alive after
// SIGTERM. Node's server.close() already drops idle keep-alive sockets, but a
// request still inside a handler (waking a machine, an SSH exec, a git-host
// call) holds its socket until it finishes. Two of 112 restarts measured on
// ia-backend (2026-08-31..09-04) waited on exactly that and hit the 25s hard
// exit, while every agent loop had settled within a second. Past this bound
// the remaining connections are closed; systemd's socket keeps the listener,
// so a retried request lands on the new process.
const SHUTDOWN_DRAIN_MS = parsePositiveIntEnv('SHUTDOWN_DRAIN_MS', 5_000);
const AI_MODEL = resolveConfiguredModel();
console.log(`[config] AI_MODEL=${AI_MODEL}`);
// SSH keys may arrive with literal `\n` escapes instead of real newlines:
// systemd's EnvironmentFile= (the Hetzner VM deploy) does no escape
// processing, unlike Render's env UI which stored real multi-line values.
// Real newlines pass through unchanged.
const decodeMultilineEnv = (value: string | undefined): string =>
  (value || '').replace(/\\n/g, '\n');
// Legacy names kept as fallbacks for one release: production stored the shared
// backend keypair under HETZNER_SSH_* until 8 Nov 2026, when Hetzner was retired
// (note #1072) and the setting became FLY_SSH_*. Remove these after the next
// release that every private copy has taken.
const HETZNER_SSH_PRIVATE_KEY = decodeMultilineEnv(process.env.HETZNER_SSH_PRIVATE_KEY);
const HETZNER_SSH_PUBLIC_KEY = decodeMultilineEnv(process.env.HETZNER_SSH_PUBLIC_KEY);
const HETZNER_SSH_PASSPHRASE = process.env.HETZNER_SSH_PASSPHRASE || '';
// Fly.io Machines (app-per-user on the org DEFAULT 6PN network; cross-tenant
// isolation is the machine image's nftables firewall, not per-user networks).
// The SSH keypair is the shared backend keypair (same one Hetzner uses); the
// public half is injected into each machine as AUTHORIZED_KEYS. Example verified
// image: registry.fly.io/ia-machine-images:sha-f56f232ae5c7 — always via env.
const FLY_API_TOKEN = process.env.FLY_API_TOKEN || '';
const FLY_ORG = process.env.FLY_ORG || process.env.FLY_ORG_SLUG || 'personal';
// Amsterdam over Frankfurt: same latency class for European users, ~13% cheaper
// for our shape. Volumes are region-bound, so this only steers NEW machines.
const FLY_REGION = process.env.FLY_REGION || 'ams';
// Neighbors tried when the primary declines a machine start (capacity 408s).
const FLY_FALLBACK_REGIONS = parseCsvEnv('FLY_FALLBACK_REGIONS');
const FLY_MACHINE_IMAGE = process.env.FLY_MACHINE_IMAGE || '';
// Registry app that holds the baked machine images — never a user machine, so
// the idle reaper skips it.
const FLY_IMAGE_APP = process.env.FLY_IMAGE_APP || 'ia-machine-images';
const FLY_IDLE_STOP_MINUTES = parsePositiveIntEnv('FLY_IDLE_STOP_MINUTES', 15);
// How often the reaper looks. It is the RESOLUTION of FLY_IDLE_STOP_MINUTES,
// not a second timeout: a machine sleeps between `idle` and `idle + sweep`
// after it goes quiet, so a 5-minute sweep made a 3-minute idle window mean
// "somewhere between 3 and 8 minutes" and the setting looked ignored.
const FLY_IDLE_SWEEP_SECONDS = parsePositiveIntEnv('FLY_IDLE_SWEEP_SECONDS', 60);
// How long after THIS process started the reaper stops nothing at all — a
// short floor only. The post-boot safety gate is turn recovery
// (agentRecoveryReady, below), and the recently-active stamp is durable, so
// the 15-minute default this used to carry is no longer needed. It was also
// harmful: CI restarts the backend on every push that touches backend/, those
// landed more often than every 15 minutes, the windows chained end to end and
// the reaper stopped nothing all working day (2026-09-03, note #297).
const FLY_BOOT_GRACE_MINUTES = parsePositiveIntEnv('FLY_BOOT_GRACE_MINUTES', 1);
// Recycle (destroy machine + volume + app) an agent nobody has touched in this
// many days, warning its owner this many days ahead. Stopping a machine frees
// CPU/RAM but not the volume, which bills on provisioned size forever — so this
// is what stops an abandoned signup accruing cost indefinitely. Recoverable:
// the next message rebuilds the machine. Set the idle window to 0 to disable.
const FLY_RECYCLE_IDLE_DAYS = parseNonNegativeIntEnv('FLY_RECYCLE_IDLE_DAYS', 3);
const FLY_RECYCLE_WARN_DAYS = parsePositiveIntEnv('FLY_RECYCLE_WARN_DAYS', 1);
// Volumes bill on PROVISIONED size, forever, whether or not the machine ever
// runs again — so this is the cost floor under every abandoned agent. Start
// small and let Fly grow it on demand (below) rather than sizing for the
// largest repo anyone might clone. Fly can extend a volume but never shrink it.
const FLY_VOLUME_SIZE_GB = parsePositiveIntEnv('FLY_VOLUME_SIZE_GB', 5);
const FLY_VOLUME_EXTEND_THRESHOLD_PERCENT = parsePositiveIntEnv('FLY_VOLUME_EXTEND_THRESHOLD_PERCENT', 80);
const FLY_VOLUME_EXTEND_INCREMENT_GB = parsePositiveIntEnv('FLY_VOLUME_EXTEND_INCREMENT_GB', 5);
const FLY_VOLUME_SIZE_LIMIT_GB = parsePositiveIntEnv('FLY_VOLUME_SIZE_LIMIT_GB', 50);
// The public port every machine boots publish-ready on: a 443/80 → this-port
// service is baked into the initial machine config (no post-create reboot), and
// the image firewall accepts it by default (PUBLIC_PORT env). The onboarding aha
// site listens here so its https://<app>.fly.dev is instantly live.
const FLY_PUBLIC_PORT = parsePositiveIntEnv('FLY_PUBLIC_PORT', 8080);
// Budget for the post-wake sshd readiness probe. A reaped machine's image
// entrypoint (host keys, authorized_keys, nftables, sshd) takes several seconds
// after Fly reports `started`; the wake path waits for :2222 to accept before
// SSHing so the stop/start stays invisible to the user.
const FLY_WAKE_READINESS_TIMEOUT_MS = parsePositiveIntEnv('FLY_WAKE_READINESS_TIMEOUT_MS', 45_000);
const FLY_SSH_PUBLIC_KEY = decodeMultilineEnv(process.env.FLY_SSH_PUBLIC_KEY) || HETZNER_SSH_PUBLIC_KEY;
const FLY_SSH_PRIVATE_KEY = decodeMultilineEnv(process.env.FLY_SSH_PRIVATE_KEY) || HETZNER_SSH_PRIVATE_KEY;
const FLY_SSH_PASSPHRASE = process.env.FLY_SSH_PASSPHRASE || HETZNER_SSH_PASSPHRASE;
// A private copy of the whole platform in a customer's own Fly organization
// (note #802, stage 0 in note #804): the Fly account above is theirs, the
// central git host is theirs, and nothing of ours is in the path. Off here.
const PRIVATE_COPY = parseBoolEnv('PRIVATE_COPY', false);
// New sign-ups on our hosted platform closed (note #823): only the private
// copy is offered. One setting so hosting reopens without a rebuild; never
// in a copy, whose own sign-up rules stand. See RouteDeps.signupClosed.
const SIGNUP_CLOSED = !PRIVATE_COPY && parseBoolEnv('SIGNUP_CLOSED', false);
if (SIGNUP_CLOSED) console.log('[config] SIGNUP_CLOSED=on (no new accounts here except through a live invite link)');
// The backend's own WireGuard address inside the Fly 6PN network. Injected into
// every machine as BACKEND_PEER_IP so the image firewall pins SSH ingress to it.
// Prod example: fdaa:0:1:a7b:1:2:3:4. Unset in dev — the image
// then falls back to the machine's own /48 prefix so local machines stay reachable.
//
// A copy's backend is itself a Fly machine, and Fly tells it its address
// (FLY_PRIVATE_IP). That stays true when Fly moves the backend or it is
// restored onto a new machine, which the setting written at install does not,
// so a copy goes by it and re-pins every machine still naming the old one
// (services/copy-peer-repin.ts, note #815).
//
// Our own platform's backend goes the same way since it left ia-backend for a
// Fly machine (note #1032, stage 4): BACKEND_PEER_FROM_FLY=on. Its machines
// are re-pinned too, but only while asleep (CopyPeerRepin.leaveAwake), since
// they run real turns.
const BACKEND_PEER_FROM_FLY = PRIVATE_COPY || parseBoolEnv('BACKEND_PEER_FROM_FLY', false);
const CONFIGURED_BACKEND_PEER_IP = process.env.FLY_BACKEND_PEER_IP?.trim() || '';
const FLY_BACKEND_PEER_IP = (BACKEND_PEER_FROM_FLY && process.env.FLY_PRIVATE_IP?.trim()) || CONFIGURED_BACKEND_PEER_IP;
// A copy takes no open sign-up (note #808): every account arrives through an
// invite link, except the first, which the installer makes with this code at
// /signup#first-account=<code>. It works only while the copy has no account.
const FIRST_ACCOUNT_CODE = (process.env.FIRST_ACCOUNT_CODE ?? '').trim();
if (PRIVATE_COPY) {
  console.log('[config] PRIVATE_COPY=on (this backend is a customer\'s own copy)');
  // Each of these silently falls back to one of OUR names, which a copy must
  // never hand out (note #807). Said at boot rather than discovered in a link.
  const missing = ['WORKSPACE_URL', 'APPS_DOMAIN', 'MAIL_DOMAIN'].filter((name) => !process.env[name]?.trim());
  if (missing.length) console.warn(`[config] PRIVATE_COPY is missing ${missing.join(', ')}: those names fall back to ours`);
  if (FIRST_ACCOUNT_CODE && FIRST_ACCOUNT_CODE.length < 16) {
    console.warn('[config] FIRST_ACCOUNT_CODE is shorter than 16 characters and is ignored');
  }
}

// ── Service Initialization ──

// Shared process-wide SSH session registry: the runtime clients drive
// terminal sessions through one client, so a session started anywhere (and
// the idle reaper's live-session check) resolves from one map. The retired client keeps session-keyed terminal methods working
// and fails loudly on any stale non-Fly sandbox id.
const retiredSandboxClient = new RetiredSandboxClient(globalSshClient);

// Fly provider client. Built when configured; consumed by the setup-agent
// administrator tools (step 6), the routing runtime client (wake-on-connect),
// and the idle reaper.
// App→org context resolution (byo-fly-design slice 4.2). The sandbox client
// is built before the storages its resolver needs, so the resolver arrives by
// late binding. No Fly call is allowed before assignment: falling back to the
// static token could create a valid machine in the platform org for a client.
let flyAppOrgContextResolver: FlyAppOrgContextResolver | undefined;
const resolveFlyAppOrgContext = async (appName: string) => {
  if (!flyAppOrgContextResolver) {
    throw new Error('Fly app organization resolver is not initialized');
  }
  return flyAppOrgContextResolver.resolve(appName);
};
const flySandboxClient = FLY_API_TOKEN && FLY_MACHINE_IMAGE
  ? new FlySandboxClient({
      apiToken: FLY_API_TOKEN,
      orgSlug: FLY_ORG,
      resolveAppContext: resolveFlyAppOrgContext,
      region: FLY_REGION,
      ...(FLY_FALLBACK_REGIONS.length > 0 ? { fallbackRegions: FLY_FALLBACK_REGIONS } : {}),
      machineImage: FLY_MACHINE_IMAGE,
      volumeSizeGb: FLY_VOLUME_SIZE_GB,
      volumeExtendThresholdPercent: FLY_VOLUME_EXTEND_THRESHOLD_PERCENT,
      volumeExtendIncrementGb: FLY_VOLUME_EXTEND_INCREMENT_GB,
      volumeSizeLimitGb: FLY_VOLUME_SIZE_LIMIT_GB,
      publicPort: FLY_PUBLIC_PORT,
      sshPublicKey: FLY_SSH_PUBLIC_KEY,
      sshPrivateKey: FLY_SSH_PRIVATE_KEY,
      sshPassphrase: FLY_SSH_PASSPHRASE,
      wakeReadinessTimeoutMs: FLY_WAKE_READINESS_TIMEOUT_MS,
      ...(FLY_BACKEND_PEER_IP ? { backendPeerIp: FLY_BACKEND_PEER_IP } : {}),
      sshClient: globalSshClient,
    })
  : undefined;
console.log(
  `[config] FLY_SANDBOX=${flySandboxClient ? 'enabled' : 'disabled'} `
  + `(image=${FLY_MACHINE_IMAGE || 'unset'}, org=${FLY_ORG}, region=${FLY_REGION}, `
  + `volume=${FLY_VOLUME_SIZE_GB}GB +${FLY_VOLUME_EXTEND_INCREMENT_GB}GB@${FLY_VOLUME_EXTEND_THRESHOLD_PERCENT}% max ${FLY_VOLUME_SIZE_LIMIT_GB}GB, `
  + `publicPort=${FLY_PUBLIC_PORT}, `
  + `backendPeerIp=${FLY_BACKEND_PEER_IP || 'unset (image firewall falls back to /48)'})`,
);

// --- Production deployments (docs/deployments-phase1.md) -------------------
// Enabled when the app-runtime image is configured alongside the Fly client.
// DNS (the agentbuilt.app zone) is optional: without it, deployments come up
// on their <app>.fly.dev URL only — dev environments work without the zone
// token, and the log line says which mode we're in.
const FLY_APP_RUNTIME_IMAGE = process.env.FLY_APP_RUNTIME_IMAGE || '';
const APPS_DOMAIN = process.env.APPS_DOMAIN || 'agentbuilt.app';
const CLOUDFLARE_APPS_DNS_TOKEN = process.env.CLOUDFLARE_APPS_DNS_TOKEN || '';
const CLOUDFLARE_APPS_ZONE_ID = process.env.CLOUDFLARE_APPS_ZONE_ID || '';
// The public base URL agent machines call for /api/agent-cli. The webhook
// fallback is transitional: the customer Telegram flow is gone, but deployed
// hosts that predate that retirement may still carry its URL instead of the
// dedicated setting. Keep their NEW machines provisioned while operators move
// the value; the checked-in host template below names the permanent setting.
const AGENTBUILT_API_URL = resolveAgentbuiltApiUrl(
  process.env.AGENTBUILT_API_URL,
  process.env.TELEGRAM_WEBHOOK_URL,
);
if (!process.env.AGENTBUILT_API_URL && AGENTBUILT_API_URL) {
  console.warn('[config] AGENTBUILT_API_URL is unset; using the retired TELEGRAM_WEBHOOK_URL origin as a compatibility fallback');
}
// The browser Workspace rides the public origin at /workspace.
// The origin is security configuration as well as presentation: every
// credential-creating POST must carry this canonical Origin or one explicitly
// named transition origin, and cookies are scoped to the HTTPS host the
// browser actually used. Explicit configuration keeps reverse-proxy Host
// headers out of the trust decision.
// The Workspace lives at the root of its origin since 2026-09-26
// (public-addresses); a configured value that still ends in /workspace is
// read as that origin, so every link the backend writes lands on the root.
const WORKSPACE_URL = (process.env.WORKSPACE_URL || (AGENTBUILT_API_URL.startsWith('http') ? AGENTBUILT_API_URL : ''))
  .replace(/\/workspace\/?$/, '');
const WORKSPACE_ORIGIN = (() => {
  try { return WORKSPACE_URL ? new URL(WORKSPACE_URL).origin : ''; } catch { return ''; }
})();
// The public site fronts /workspace while the backend keeps its own api.
// During that host move BOTH doors must be able to finish an already-open
// form: HTTPS CORS_ORIGINS name the same-domain public doors and the HTTPS
// AGENTBUILT_API_URL is the old direct door. Plain-HTTP development origins
// do not become production-compatible by accident; if one is deliberately
// needed it can still be named in WORKSPACE_COMPATIBLE_ORIGINS. Nothing is
// inferred from the request, and none can become a generated link —
// WORKSPACE_ORIGIN remains canonical.
const workspaceAutomaticCompatibleOrigins = [...CORS_ORIGINS, AGENTBUILT_API_URL]
  .flatMap((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? [url.origin] : [];
    } catch {
      return [];
    }
  });
const WORKSPACE_COMPATIBLE_ORIGINS = [...new Set([
  ...parseCsvEnv('WORKSPACE_COMPATIBLE_ORIGINS'),
  ...workspaceAutomaticCompatibleOrigins,
]
  .flatMap((value) => {
    try { return value ? [new URL(value).origin] : []; } catch { return []; }
  })
  .filter((origin) => origin !== WORKSPACE_ORIGIN))];
const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim() || '';
// A private copy that names its own mail domain sends from it by default
// (note #807); ours keeps the updates subdomain and its reputation.
const WORKSPACE_EMAIL_FROM = process.env.WORKSPACE_EMAIL_FROM?.trim()
  || (MAIL_DOMAIN !== DEFAULT_MAIL_DOMAIN
    ? `Workspace <workspace@${MAIL_DOMAIN}>`
    : 'Agentic Cloud Computer <workspace@updates.agenticcloudcomputer.com>');
// The ops bot's own Mini App — the roster as a real table, which a Telegram
// message cannot draw. Same origin, same HTTPS rule: no HTTPS, no button.
const OPS_MINIAPP_URL = process.env.OPS_MINIAPP_URL
  || (AGENTBUILT_API_URL.startsWith('https://') ? `${AGENTBUILT_API_URL}/ops` : '');
// First-deploy tarballs wait for payment here (see DeploymentService.stageTarball).
const DEPLOY_STAGING_DIR = process.env.DEPLOY_STAGING_DIR || '/var/lib/infinite-agents/deploy-staging';

// The runtime/provisioning client the rest of the app talks to. It routes each
// call to Hetzner or Fly by sandbox id (so a harness message to a stopped Fly
// machine transparently wakes it); generic provisioning stays on Hetzner.
const sandboxClient = new RoutingSandboxClient(retiredSandboxClient, flySandboxClient);

// SQLite is the only persistence backend (SQLITE_DB_PATH, a file on the
// backend host); InMemory covers tests/dev when it is unset.
const sqliteDbPath = process.env.SQLITE_DB_PATH?.trim();
const sqliteDb = sqliteDbPath ? openSqliteDb(sqliteDbPath) : null;
if (sqliteDb) {
  console.log(`[Storage] Persistence: SQLite (${sqliteDbPath})`);
} else {
  console.warn('[Storage] Persistence: in-memory only (data will not survive restarts) - set SQLITE_DB_PATH');
}

// user_sandboxes is legacy web-app state (0 docs in prod; its writers were
// removed) — the read path gets the same "empty" answer from the InMemory
// impl instead of a table.
const sandboxStorage = new InMemorySandboxStorage();
// Deployment records (production hosting). SQLite or in-memory only.
const deploymentStorage = sqliteDb
  ? new SqliteDeploymentStorage(sqliteDb)
  : new InMemoryDeploymentStorage();
// Internal git repos (docs/agent-git-phase1.md). Like deployments:
// SQLite or in-memory only.
const gitRepoStorage = sqliteDb
  ? new SqliteGitRepoStorage(sqliteDb)
  : new InMemoryGitRepoStorage();
const gitPullRequestStorage = sqliteDb
  ? new SqliteGitPullRequestStorage(sqliteDb)
  : new InMemoryGitPullRequestStorage();
const gitCommitStatusStorage = sqliteDb
  ? new SqliteGitCommitStatusStorage(sqliteDb)
  : new InMemoryGitCommitStatusStorage();
// Knowledge proposals (docs/agent-knowledge-pages.md). The pages live on the
// git host; this is the queue of changes waiting on the owner.
const knowledgeProposalStorage = sqliteDb
  ? new SqliteKnowledgeProposalStorage(sqliteDb)
  : new InMemoryKnowledgeProposalStorage();
// A knowledge page's margin (note #66) — beside the base, not in its history.
const rawKnowledgePageCommentStorage = sqliteDb
  ? new SqliteKnowledgePageCommentStorage(sqliteDb)
  : new InMemoryKnowledgePageCommentStorage();
// Knowledge belongs to the workplace (note #566): whichever room a caller
// stands in, its pages and their margins resolve to the workplace's one
// shelf. Late-bound — the org layer is built further down — and only ever
// called from a request or the boot backfill, both long after it exists.
const knowledgeShelf: KnowledgeShelfResolver = (namespaceId) => orgGitService.knowledgeShelfFor(namespaceId);
const knowledgePageCommentStorage = shelfMappedPageComments(rawKnowledgePageCommentStorage, knowledgeShelf);
// Quick notes (docs/agent-quick-notes.md). No git host behind these — the
// note IS the document, which is what makes it quick.
const driveStorage = sqliteDb ? new SqliteDriveStorage(sqliteDb) : new InMemoryDriveStorage();
const quickNoteStorage = sqliteDb
  ? new SqliteQuickNoteStorage(sqliteDb)
  : new InMemoryQuickNoteStorage();
// CI status ingest (docs/ci-status-miniapp.md): its own secret, held by CI
// runners alone. Absent → the ingest route 503s and every screen shows no
// checks, which is the honest degraded state.
const CI_STATUS_SECRET = process.env.CI_STATUS_SECRET || '';

// Backup staleness monitor (infra/db-backup, infra/git-host/backup-repos.sh).
// The jobs report every successful run here; this watches the GAPS and
// complains when one gets too wide. It lives in the backend because a backup
// job cannot report its own absence — a dead ia-media will never tell anyone
// its git bundles stopped.
const BACKUP_HEARTBEAT_SECRET = process.env.BACKUP_HEARTBEAT_SECRET || '';
const backupHeartbeatStore = sqliteDb
  ? new SqliteBackupHeartbeatStore(sqliteDb)
  : new InMemoryBackupHeartbeatStore();
const TELEGRAM_OPS_BOT_TOKEN = process.env.TELEGRAM_OPS_BOT_TOKEN || '';
const TELEGRAM_OPS_CHAT_ID = process.env.TELEGRAM_OPS_CHAT_ID || '';
// The jobs it expects to hear from. Configurable, but the default IS the
// answer: these are the two things being backed up.
const BACKUP_MONITOR_JOBS = (process.env.BACKUP_MONITOR_JOBS || 'git,db')
  .split(',').map((job) => job.trim()).filter(Boolean);
const opsNotifier = TELEGRAM_OPS_BOT_TOKEN && TELEGRAM_OPS_CHAT_ID
  ? createOpsNotifier({
      botToken: TELEGRAM_OPS_BOT_TOKEN,
      chatId: TELEGRAM_OPS_CHAT_ID,
    })
  : undefined;
const backupMonitor = opsNotifier
  ? new BackupStalenessMonitor({
      store: backupHeartbeatStore,
      jobs: BACKUP_MONITOR_JOBS,
      notify: opsNotifier,
      ...(process.env.BACKUP_STALE_AFTER_HOURS
        ? { staleAfterMs: Number(process.env.BACKUP_STALE_AFTER_HOURS) * 60 * 60_000 }
        : {}),
    })
  : undefined;
if (backupMonitor) {
  backupMonitor.start();
} else {
  // Said out loud rather than failing silently: without the ops bot there is
  // nowhere to send an alert, so nothing is watching the backups.
  console.log(
    '[config] BACKUP_MONITOR=disabled (set TELEGRAM_OPS_BOT_TOKEN + TELEGRAM_OPS_CHAT_ID)',
  );
}

// Git host on the media box. All three env vars or nothing: a half-configured
// host would hand agents clone URLs that 404, which is worse than the feature
// being absent (the CLI then says so plainly).
const GIT_HOST_BASE_URL = process.env.GIT_HOST_BASE_URL || '';
const GIT_HOST_CONTROL_URL = process.env.GIT_HOST_CONTROL_URL || GIT_HOST_BASE_URL;
const GIT_HOST_SECRET = process.env.GIT_HOST_SECRET || '';
const gitHostClient = GIT_HOST_BASE_URL && GIT_HOST_SECRET
  ? new GitHostClient({
      baseUrl: GIT_HOST_BASE_URL,
      controlUrl: GIT_HOST_CONTROL_URL,
      secret: GIT_HOST_SECRET,
    })
  : undefined;
console.log(
  `[config] GIT_HOSTING=${gitHostClient ? `enabled (${GIT_HOST_BASE_URL})` : 'disabled (set GIT_HOST_BASE_URL + GIT_HOST_SECRET)'}`,
);
const sessionStorage = sqliteDb
  ? new SqliteSessionStorage(sqliteDb)
  : new InMemorySessionStorage();
// The Workspace chat screen's record of each agent's conversation
// (inhouse-chat-design, note #131) — display data, never the harness
// transcript, which stays on the agent's own machine.
const agentChatStorage = sqliteDb
  ? new SqliteAgentChatStorage(sqliteDb)
  : new InMemoryAgentChatStorage();
// Secret values and AI sign-ins (seat tokens) are encrypted at rest when
// SECRETS_MASTER_KEY is set (docs/user-secrets.md, seat-credential-cipher.ts)
// — the DB file and its nightly backups then hold only ciphertext for them.
// Without the key everything still works, in plaintext.
const secretCipher = secretCipherFromEnv();
if (secretCipher) {
  console.log('[Storage] Secret values and AI sign-ins: encrypted at rest (AES-256-GCM)');
} else {
  console.warn('[Storage] Secret values and AI sign-ins: PLAINTEXT at rest - set SECRETS_MASTER_KEY to encrypt');
}
const innerSecretStorage = sqliteDb
  ? new SqliteSecretStorage(sqliteDb)
  : new InMemorySecretStorage();
const rawSecretStorage = secretCipher
  ? new EncryptedSecretStorage(innerSecretStorage, secretCipher)
  : innerSecretStorage;
// ONE set of secrets per workplace (note #783): every caller names the room
// it stands in, and this maps that namespace to the workplace's own once the
// boot backfill below has merged the rooms' stores. Late-bound on purpose —
// the org git service is built further down, and the resolver only runs
// once requests arrive.
const secretStorage = new ShelfMappedSecretStorage(rawSecretStorage, (namespaceId) => orgGitService.secretShelfFor(namespaceId));
// Platform-owned subscription credentials (platform-plan Claude turns lease
// from here). The refresher keeps each credential's 5h/7d utilization fresh
// so leasing can spread load and predict exhaustion.
// The org layer (org-layer-design): orgs, members and member-owned seats.
// Seats plug into the credential pool below as each member's own
// credentials — leaseForUser resolves them first, so an org member's turns
// run on their seats and never on shared capacity.
const orgStorage = sqliteDb ? new SqliteOrgStorage(sqliteDb, secretCipher) : new InMemoryOrgStorage();
const orgSeatCredentials = new OrgSeatCredentialSource(orgStorage);
console.log(`[config] ORG_LAYER=wired (${sqliteDb ? 'sqlite' : 'memory'}) — member seats resolve before pool credentials`);
const platformCredentialPool = sqliteDb
  ? new SqlitePlatformCredentialPool(sqliteDb, orgSeatCredentials)
  : new InMemoryPlatformCredentialPool(orgSeatCredentials);
new PlatformCredentialUsageRefresher(platformCredentialPool).start();
const userStorage = sqliteDb
  ? new SqliteUserStorage(sqliteDb)
  : new InMemoryUserStorage();
// Standard SMTP for a private copy's mail out (note #815): both streams,
// each only where no Resend key is set for it. Unset on our platform.
const SMTP_SETTINGS = smtpSettingsFromEnv(process.env);
const smtpTransport = SMTP_SETTINGS ? createSmtpTransport(SMTP_SETTINGS) : undefined;
const envVerificationEmail = RESEND_API_KEY
  ? new ResendWorkspaceVerificationEmailSender({ apiKey: RESEND_API_KEY, from: WORKSPACE_EMAIL_FROM })
  : smtpTransport
    ? new SmtpWorkspaceVerificationEmailSender({ transport: smtpTransport, from: WORKSPACE_EMAIL_FROM })
    : undefined;
// What the Workspace's own mail (sign-in links, recovery, notices) goes out
// through RIGHT NOW. On our platform it is the environment's, for good. A
// private copy installs without email and an admin turns it on later from the
// Workspace (note #946): copyMailSetup swaps this in, with no restart.
let liveVerificationEmail: WorkspaceVerificationEmailSender | undefined = envVerificationEmail;
const verificationEmailVia = (sending: CopyMailSending): WorkspaceVerificationEmailSender => (sending.kind === 'resend'
  ? new ResendWorkspaceVerificationEmailSender({ apiKey: sending.apiKey, from: WORKSPACE_EMAIL_FROM })
  : new SmtpWorkspaceVerificationEmailSender({ transport: createSmtpTransport(sending.settings), from: WORKSPACE_EMAIL_FROM }));
const noLiveSender = () => new Error('mail is not set up on this Workspace');
/** One sender the auth service keeps for good, handing each message to
 *  whichever one is live when it is sent. */
const workspaceVerificationEmail: WorkspaceVerificationEmailSender | undefined = envVerificationEmail || PRIVATE_COPY
  ? {
    sendVerification: async (message) => { if (!liveVerificationEmail) throw noLiveSender(); await liveVerificationEmail.sendVerification(message); },
    sendPasswordReset: async (message) => { if (!liveVerificationEmail?.sendPasswordReset) throw noLiveSender(); await liveVerificationEmail.sendPasswordReset(message); },
    sendRecoveryConfirmation: async (message) => { if (!liveVerificationEmail?.sendRecoveryConfirmation) throw noLiveSender(); await liveVerificationEmail.sendRecoveryConfirmation(message); },
    sendNotice: async (message) => { if (!liveVerificationEmail?.sendNotice) throw noLiveSender(); await liveVerificationEmail.sendNotice(message); },
  }
  : undefined;
/** What a copy says wherever a flow needs mail before an admin set it up. */
const COPY_MAIL_UNSET = 'Email is not set up in this Workspace yet, so nothing can be sent by email. An admin can set it up under Mail.';
// Each person's own address on the mail domain (note #509). Signup holds the
// name, confirming the account's email makes it deliverable, and Settings is
// where everyone who signed up before this picks theirs.
const mailboxStorage = new SqliteMailboxStorage(sqliteDb ?? openSqliteDb(':memory:'));
// A person's name and a workplace's handle share the root of the domain
// (public-addresses), so each side asks the other before handing a word out.
const mailboxService = new MailboxService(mailboxStorage, undefined, async (local) => (await orgStorage.getOrgByHandle(local)) !== null);
const orgHandleService = new OrgHandleService({ orgStorage, mailboxHolder: (address) => mailboxService.holderOf(address) });
// The inbox behind those addresses (slice 2). The storage is shared with the
// service above on purpose: the Email Worker's "does anybody hold this?" and
// the signup field's "is this free?" must never be able to disagree.
const mailMessageStorage = new SqliteMailMessageStorage(sqliteDb ?? openSqliteDb(':memory:'));
const mailApprovalStorage = sqliteDb
  ? new SqliteMailApprovalStorage(sqliteDb)
  : new InMemoryMailApprovalStorage();
const workspaceWebAuth = secretCipher && WORKSPACE_ORIGIN
  ? new WorkspaceWebAuthService(
      sqliteDb
        ? new SqliteWorkspaceWebAuthStorage(sqliteDb)
        : new InMemoryWorkspaceWebAuthStorage(),
      userStorage,
      secretCipher,
      undefined,
      workspaceVerificationEmail
        ? {
          sender: workspaceVerificationEmail,
          workspaceUrl: WORKSPACE_URL,
          available: () => Boolean(liveVerificationEmail),
          unavailableMessage: COPY_MAIL_UNSET,
        }
        : undefined,
      mailboxService,
    )
  : undefined;
console.log(
  `[config] WORKSPACE_WEB_AUTH=${workspaceWebAuth ? `enabled (${WORKSPACE_URL})` : 'disabled (set SECRETS_MASTER_KEY + WORKSPACE_URL)'}`,
);
console.log(
  `[config] WORKSPACE_EMAIL_VERIFICATION=${envVerificationEmail
    ? `enabled (${WORKSPACE_EMAIL_FROM}${RESEND_API_KEY ? '' : ` over SMTP ${SMTP_SETTINGS!.host}:${SMTP_SETTINGS!.port}`})`
    : PRIVATE_COPY ? 'set up from the Workspace (Mail), note #946' : 'disabled (set RESEND_API_KEY or SMTP_HOST)'}`,
);
// In-app only: browser (Web Push) notifications were retired by note #477.
const workspaceNotifications = new WorkspaceNotificationService(
  sqliteDb
    ? new SqliteWorkspaceNotificationStorage(sqliteDb)
    : new InMemoryWorkspaceNotificationStorage(),
);
const orgOwnershipBackfillReady = backfillLegacyOrgOwnership({
  userStorage,
  orgStorage,
  deploymentStorage,
}).then(({ agents, deployments }) => {
  if (agents || deployments) {
    console.log(`[org] Backfilled immutable ownership on ${agents} agent(s), ${deployments} deployment(s)`);
  }
});
// Rooms left the product (note #843). Stage 1 brought every room's notes
// onto its workplace's namespace and stamped it; stage 3 (note #923) drops
// the rooms themselves. Both run here, in that order, on every boot: on our
// own platform the merge has long been done and the drop happens once, but a
// company's own Agentic Cloud that skipped the release carrying the merge is
// merged first and dropped on the same boot. The drop copies the database
// beside itself first, waits while any workplace is unmerged, and does
// nothing once the rooms are gone. Nothing else reads a room.
const legacyRooms = sqliteDb ? new SqliteLegacyRooms(sqliteDb) : new InMemoryLegacyRooms();
const roomsGoneReady = orgOwnershipBackfillReady.then(async () => {
  const merged = await backfillRoomMerge({ orgStorage, legacyRooms, quickNoteStorage });
  if (merged.workplaces || merged.moved || merged.swept || merged.deferred.length) {
    console.log(
      `[rooms] One workplace, no rooms: stamped ${merged.workplaces} workplace(s), moved ${merged.moved} note(s)`
      + (merged.renumbered.length ? `, ${merged.renumbered.length} of them to a new number` : '')
      + (merged.swept ? `, swept ${merged.swept} leftover note(s)` : '')
      + (merged.deferred.length ? `; deferred ${merged.deferred.map((d) => `${d.orgId} (${d.reason})`).join(', ')}` : ''),
    );
  }
  const dropped = await dropRooms({
    orgStorage,
    legacyRooms,
    ...(sqliteDb && sqliteDbPath ? {
      backup: async () => {
        const destination = `${sqliteDbPath}.before-room-drop-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await sqliteDb.backup(destination);
        return destination;
      },
    } : {}),
  });
  if (dropped.dropped || dropped.deferred) {
    console.log(dropped.deferred
      ? `[rooms] Drop deferred: ${dropped.deferred}`
      : `[rooms] Dropped ${dropped.dropped} room(s); recorded ${dropped.recorded} old namespace(s); `
        + `room fields removed from ${Object.entries(dropped.stripped).map(([kind, count]) => `${count} ${kind}`).join(', ') || 'no records'}`
        + (dropped.backup ? `; the database was copied first to ${dropped.backup}` : ''));
  }
}).catch((error) => console.warn('[rooms] merge or drop failed; tried again next boot:', error));
// Every workplace gets its public handle (public-addresses, 2026-09-26):
// derived from its name for the ones born before handles existed.
void roomsGoneReady.then(async () => {
  try {
    const { assigned, skipped } = await orgHandleService.backfill();
    if (assigned || skipped) console.log(`[org] handles: ${assigned} assigned, ${skipped} still without one`);
  } catch (error) {
    console.warn('[org] handle backfill failed; tried again next boot:', error);
  }
});
// Knowledge changes apply at once since note #746 (12 Oct 2026): whatever
// was still waiting for a tap is settled once at boot — ready ones applied,
// quiet ones withdrawn, moved ones marked conflict — so no decision list
// keeps a row nobody can decide. Late-bound like the merge above.
void roomsGoneReady.then(async () => {
  if (!gitHostClient) return;
  const settled = await settleOpenKnowledgeProposals({
    proposals: knowledgeProposalStorage,
    orgStorage,
    hostFor: async (orgId) => orgGitHostService.clientFor(orgId),
    shelf: knowledgeShelf,
    pageComments: rawKnowledgePageCommentStorage,
    ...(mediaStorage ? { media: mediaStorage } : {}),
    told: (args) => agentService.tellOwnerKnowledgeChanged(args),
  });
  if (settled.applied.length || settled.withdrawn.length || settled.conflicts.length || settled.deferred.length) {
    console.log(
      `[knowledge] Open proposals settled (note #746): applied ${settled.applied.join(', ') || 'none'}`
      + `; withdrawn ${settled.withdrawn.join(', ') || 'none'}; conflicts ${settled.conflicts.join(', ') || 'none'}`
      + (settled.deferred.length ? `; deferred ${settled.deferred.map((d) => `#${d.number} (${d.reason})`).join(', ')}` : ''),
    );
  }
}).catch((error) => console.warn('[knowledge] settling open proposals failed:', error));
// The owner's two School repositories move to their separate Personal
// workplace (owner decision, 2026-09-20). Pinned to those two ids, idempotent,
// and a no-op once done — see school-repo-transfer.ts for why this is a
// migration rather than a `repo transfer` verb. Late-bound and unawaited for
// the same reason as the merge above: the host layer is built below, and a
// host that cannot be reached leaves both repositories exactly where they are.
void roomsGoneReady.then(async () => {
  if (!gitHostClient) return;
  const transfer = await transferSchoolReposToPersonal({
    orgStorage,
    gitRepoStorage,
    hostFor: async (orgId) => orgGitHostService.clientFor(orgId),
  });
  if (transfer.moved.length || transfer.deferred.length) {
    console.log(
      `[git] School repositories to Personal: moved ${transfer.moved.length}`
      + (transfer.moved.length ? ` (${transfer.moved.map((r) => r.name).join(', ')})` : '')
      + (transfer.alreadyDone.length ? `, already there ${transfer.alreadyDone.join(', ')}` : '')
      + (transfer.deferred.length ? `; deferred ${transfer.deferred.map((d) => `${d.name} (${d.reason})`).join(', ')}` : ''),
    );
  }
}).catch((error) => console.warn('[git] School repository transfer failed:', error));
// The live `school` site follows its repositories into the Personal workplace
// (owner decision, 2026-09-20). A site is scoped by orgId alone, so this is a
// record update and nothing else: no Fly call, no downtime, same address, same
// app, same volume. It also writes the hosting pin — see school-site-transfer.ts
// for why ownership can move while running infrastructure cannot.
void roomsGoneReady.then(async () => {
  const site = await transferSchoolSiteToPersonal({ orgStorage, deploymentStorage });
  if (site.state === 'moved') {
    console.log(`[sites] school moved to workplace ${site.to}, still hosted on ${site.flyOrgId}'s Fly account`);
  } else if (site.state === 'deferred') {
    console.warn(`[sites] school NOT moved: ${site.reason}`);
  }
}).catch((error) => console.warn('[sites] School site transfer failed:', error));
// The org→Fly binding (byo-fly-design): org-scoped secrets, the connect/
// resolve path, and app→org context resolution for the sandbox client. This
// assignment is what activates the late-bound resolver handed to
// FlySandboxClient above.
const orgSecrets = new OrgSecretsService(secretStorage);
// A workplace with no cloud of its own is hosted on the platform's Fly
// account (note #664); the boot-time pair is that account.
const orgFlyService = new OrgFlyService({
  orgStorage,
  orgSecrets,
  ...(FLY_API_TOKEN && FLY_ORG ? { platform: { orgSlug: FLY_ORG, apiToken: FLY_API_TOKEN } } : {}),
});
flyAppOrgContextResolver = new FlyAppOrgContextResolver({
  userStorage,
  deploymentStorage,
  orgStorage,
  orgFly: orgFlyService,
  ...(FLY_ORG ? { platformOrgSlug: FLY_ORG } : {}),
  ...(FLY_BACKEND_PEER_IP ? { platformBackendPeerIp: FLY_BACKEND_PEER_IP } : {}),
});
console.log(`[config] ORG_FLY_CONTEXT=wired (app→org resolution; workplaces without their own cloud hosted on ${FLY_API_TOKEN && FLY_ORG ? FLY_ORG : 'nothing — no platform Fly account'})`);
// Object storage for agents and sites (note #768): one Tigris bucket per
// `agentbuilt storage create`, in the workplace's hosting account, its keys
// saved as room secrets through the same cupboard `agentbuilt secret` uses.
const storageBucketStorage = sqliteDb
  ? new SqliteStorageBucketStorage(sqliteDb)
  : new InMemoryStorageBucketStorage();
const objectStorageService = secretStorage && FLY_API_TOKEN
  ? new ObjectStorageService({
      storage: storageBucketStorage,
      resolveHostingContext: (orgId) => orgFlyService.resolveHostingContext(orgId),
      ...(FLY_ORG ? { platform: { orgSlug: FLY_ORG, apiToken: FLY_API_TOKEN } } : {}),
      secrets: {
        save: async (namespaceId, name, value, description) => {
          const result = await new UserSecretsService(secretStorage).setSecret(namespaceId, name, value, SHARED_USER_SECRET_SCOPE, description);
          if (!result.ok) throw new Error(result.reason);
        },
        remove: async (namespaceId, name) => {
          await new UserSecretsService(secretStorage).deleteSecret(namespaceId, name, SHARED_USER_SECRET_SCOPE);
        },
        read: (namespaceId, name) => new UserSecretsService(secretStorage).getSecretValue(namespaceId, name, SHARED_USER_SECRET_SCOPE),
      },
      caps: { hostedBucketLimit: HOSTED_BUCKET_LIMIT, hostedBucketGb: HOSTED_BUCKET_GB },
    })
  : undefined;
console.log(`[config] OBJECT_STORAGE=${objectStorageService ? `enabled (${HOSTED_BUCKET_LIMIT} buckets × ${HOSTED_BUCKET_GB} GB per hosted workplace)` : 'disabled'}`);
// Per-org WireGuard tunnels (byo-fly slice 4). The service runs unprivileged
// (User=app) while the WG verbs need root: every argv this exec runs is
// enumerated in /etc/sudoers.d/infinite-agents-wireguard (infra/backend-host)
// and prefixed with sudo when the process is not root. Root (dev, operator
// scripts) skips sudo, so behavior there is exactly what it was.
//
// None in a private copy (note #815): its backend lives in the same Fly
// organization as every machine it makes and reaches them over that
// network, and its image carries no WireGuard tools, so the attempt made
// before every agent machine could only fail.
const orgWireGuardService = PRIVATE_COPY ? undefined : new OrgWireGuardService({
  orgStorage,
  orgSecrets,
  orgFly: orgFlyService,
  exec: (argv, opts) => new Promise((resolve) => {
    const privileged = typeof process.getuid === 'function' && process.getuid() !== 0
      ? ['sudo', '-n', ...argv]
      : argv;
    const child = execFile(privileged[0], privileged.slice(1), (error, stdout, stderr) => {
      resolve({
        stdout: String(stdout),
        stderr: String(stderr),
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      });
    });
    child.stdin?.end(opts?.stdin ?? '');
  }),
  region: FLY_REGION,
  platformOrgSlug: FLY_ORG,
});
// The org→git namespace binding (byo-git-design slice 1): members of a
// stamped org share one git namespace; destruction and CI-secret grants
// become admin verbs on it. Unstamped orgs and org-less users resolve to
// their own userId — the pre-org behavior exactly.
const orgGitService = new OrgGitService({
  orgStorage,
  repoNamespacesForOrg: (orgId) => gitRepoStorage.listNamespacesByOrg(orgId),
});
// Per-org git hosts (slice 2b): a client org's repos live on a host in its
// OWN Fly account, provisioned lazily on the first `repo create`. Org #0 and
// every unstamped path resolve to the central host (the env seed above).
const FLY_GIT_HOST_IMAGE = process.env.FLY_GIT_HOST_IMAGE || '';
const orgGitHostService = new OrgGitHostService({
  orgStorage,
  orgSecrets,
  orgFly: orgFlyService,
  orgGit: orgGitService,
  ...(FLY_GIT_HOST_IMAGE ? { gitHostImage: FLY_GIT_HOST_IMAGE } : {}),
  ...(AGENTBUILT_API_URL ? { backendUrl: AGENTBUILT_API_URL } : {}),
  region: FLY_REGION,
  ...(GIT_HOST_BASE_URL && GIT_HOST_SECRET
    ? {
        platformEnv: {
          baseUrl: GIT_HOST_BASE_URL,
          controlUrl: GIT_HOST_CONTROL_URL,
          secret: GIT_HOST_SECRET,
        },
      }
    : {}),
});
console.log(`[config] ORG_GIT_HOSTS=${FLY_GIT_HOST_IMAGE ? `provisionable (${FLY_GIT_HOST_IMAGE})` : 'resolve-only (set FLY_GIT_HOST_IMAGE to provision)'}`);
// Direct messages between people (note #608): the text lives on each
// workplace's OWN messaging machine, reachable by this backend alone. The
// platform database keeps one unread number per person and nothing else. With
// no database at all (development) there is no cloud either, so a throwaway
// in-memory store stands in.
const FLY_MSG_HOST_IMAGE = process.env.FLY_MSG_HOST_IMAGE || '';
const orgMsgHostService = new OrgMsgHostService({
  orgStorage,
  orgSecrets,
  orgFly: orgFlyService,
  orgWireGuard: orgWireGuardService,
  ...(FLY_MSG_HOST_IMAGE ? { msgHostImage: FLY_MSG_HOST_IMAGE } : {}),
  ...(FLY_BACKEND_PEER_IP ? { platformBackendPeerIp: FLY_BACKEND_PEER_IP } : {}),
  region: FLY_REGION,
});
const directMessageStorage: DirectMessageStorage = sqliteDb
  ? new RemoteDirectMessageStorage(orgMsgHostService, new SqliteDirectMessageUnreadStore(sqliteDb))
  : new SqliteDirectMessageStorage(openSqliteDb(':memory:'));
// Note #1090: the Chief of Staff's drafts to a teammate wait here for the
// person's tap; the tap sends through the same storage their own Send uses.
const directMessageApprovals = new DirectMessageApprovalService(
  sqliteDb ? new SqliteDirectMessageApprovalStorage(sqliteDb) : new InMemoryDirectMessageApprovalStorage(),
  () => directMessageStorage,
  async (orgId, userId) => Boolean(await orgStorage.getMembership(orgId, userId)),
);
console.log(`[config] ORG_MSG_HOSTS=${!sqliteDb ? 'in-memory (development)' : FLY_MSG_HOST_IMAGE ? `provisionable (${FLY_MSG_HOST_IMAGE})` : 'resolve-only (set FLY_MSG_HOST_IMAGE to provision)'}`);
// Backups that live with the code (byo-git slice 4): the sweep is the CLOCK
// for org git hosts — they sleep between pushes and fire no timers of their
// own. Every run's summary lands on the backup monitor as the `org-git` job,
// so a sweep that stops happening alerts exactly like the central nightly.
const orgGitBackupService = new OrgGitBackupService({
  orgStorage,
  orgSecrets,
  orgFly: orgFlyService,
  orgGitHost: orgGitHostService,
  log: (line) => console.log(`[OrgGitBackup] ${line}`),
});
// CI in the client's org (byo-git slice 5): the runner script lane A uses,
// loaded from the release artifact (the build copies it beside dist). A
// backend without it simply answers "org CI is not configured".
const runnerScriptPath = new URL('./ci-runner-agent.sh', import.meta.url);
let ORG_CI_RUNNER_B64: string | undefined;
try {
  ORG_CI_RUNNER_B64 = (await import('node:fs')).readFileSync(runnerScriptPath).toString('base64');
} catch {
  ORG_CI_RUNNER_B64 = undefined;
}
const orgCiService = CI_STATUS_SECRET
  ? new OrgCiService({
      orgStorage,
      orgSecrets,
      orgFly: orgFlyService,
      orgGitHost: orgGitHostService,
      gitRepoStorage,
      gitCommitStatusStorage,
      ciStatusSecret: CI_STATUS_SECRET,
      ...(FLY_MACHINE_IMAGE ? { machineImage: FLY_MACHINE_IMAGE } : {}),
      ...(AGENTBUILT_API_URL ? { backendUrl: AGENTBUILT_API_URL } : {}),
      region: FLY_REGION,
      ...(ORG_CI_RUNNER_B64 ? { runnerScriptB64: ORG_CI_RUNNER_B64 } : {}),
      ...(PRIVATE_COPY && GIT_HOST_SECRET ? { privateCopyCentralHost: { secret: GIT_HOST_SECRET } } : {}),
      log: (line) => console.log(`[OrgCi] ${line}`),
    })
  : undefined;
console.log(`[config] ORG_CI=${orgCiService?.enabled ? 'enabled (machines in the client org)' : 'disabled (needs CI_STATUS_SECRET + FLY_MACHINE_IMAGE + AGENTBUILT_API_URL + runner script)'}`);

const ORG_GIT_BACKUP_INTERVAL_MS = Number(process.env.ORG_GIT_BACKUP_INTERVAL_MS || 6 * 60 * 60_000);
if (ORG_GIT_BACKUP_INTERVAL_MS > 0) {
  const runOrgBackupSweep = async () => {
    try {
      const { status, detail } = describeOrgGitSweep(await orgGitBackupService.sweep());
      backupMonitor?.record('org-git', status, detail);
    } catch (error) {
      backupMonitor?.record('org-git', 'fail', error instanceof Error ? error.message : String(error));
    }
  };
  setInterval(runOrgBackupSweep, ORG_GIT_BACKUP_INTERVAL_MS).unref();
  // One sweep shortly after boot, so a restarted backend never leaves a
  // fresh org host unbacked for a whole interval.
  setTimeout(runOrgBackupSweep, 5 * 60_000).unref();
  console.log(`[config] ORG_GIT_BACKUPS=every ${Math.round(ORG_GIT_BACKUP_INTERVAL_MS / 60_000)}m`);
} else {
  console.log('[config] ORG_GIT_BACKUPS=disabled (ORG_GIT_BACKUP_INTERVAL_MS=0)');
}
// The database into a bucket (note #807): a private copy's backups live in
// its own Fly account, taken by this process on a timer. Since note #1032 our
// own backend does it too, into Cloudflare R2 off Fly (DB_BACKUP_INTERVAL_HOURS=6,
// DB_BACKUP_LOCK_DAYS=30 for the bucket's lock, DB_BACKUP_MONITOR_JOB=db-r2
// while the Hetzner host script still reports as `db`).
const BACKUP_S3 = {
  endpoint: process.env.BACKUP_S3_ENDPOINT?.trim() || '',
  name: process.env.BACKUP_S3_BUCKET?.trim() || '',
  accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID?.trim() || '',
  secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY?.trim() || '',
};
// The last scheduled backup, kept for a copy's health page (note #813): a
// copy has no ops channel for backupMonitor to report to.
let lastDbBackup: { at: string; ok: boolean; detail?: string } | undefined;
const DB_BACKUP_EVERY_HOURS = parsePositiveIntEnv('DB_BACKUP_INTERVAL_HOURS', 24);
const dbBackupsOn = Boolean(sqliteDb && sqliteDbPath && BACKUP_S3.endpoint && BACKUP_S3.name && BACKUP_S3.accessKeyId && BACKUP_S3.secretAccessKey);
if (sqliteDb && sqliteDbPath && dbBackupsOn) {
  const everyHours = DB_BACKUP_EVERY_HOURS;
  const keep = parsePositiveIntEnv('DB_BACKUP_KEEP', 14);
  const keepWeekly = parseNonNegativeIntEnv('DB_BACKUP_KEEP_WEEKLY', 8);
  const lockDays = parseNonNegativeIntEnv('DB_BACKUP_LOCK_DAYS', 0);
  const monitorJob = process.env.DB_BACKUP_MONITOR_JOB?.trim() || 'db';
  new DatabaseBucketBackup({
    dbPath: sqliteDbPath,
    backup: (destination) => sqliteDb.backup(destination),
    bucket: BACKUP_S3,
    keep,
    keepWeekly,
    lockDays,
    log: (line) => console.log(`[DbBackup] ${line}`),
    record: (status, detail) => {
      lastDbBackup = { at: new Date().toISOString(), ok: status === 'ok', ...(status === 'ok' ? {} : { detail }) };
      backupMonitor?.record(monitorJob, status, detail);
    },
    // A good backup already in the bucket (from before this start) counts,
    // unless this process has since recorded a newer run (note #1082).
    found: (at) => {
      if (!lastDbBackup || new Date(lastDbBackup.at).getTime() < at.getTime()) lastDbBackup = { at: at.toISOString(), ok: true };
    },
  }).start(everyHours * 60 * 60_000, 10 * 60_000);
  console.log(`[config] DB_BACKUPS=every ${everyHours}h into ${BACKUP_S3.name}, keeping ${keep} dailies + ${keepWeekly} weeklies`
    + (lockDays ? `, lock ${lockDays}d` : '') + `, reporting as ${monitorJob}`);
}
// The platform's media, mirrored nightly into the backups bucket (note #1032):
// with the control plane on Fly, media only in a Fly bucket has no copy off
// Fly. Production only, by MEDIA_MIRROR=on; a copy's media and backups share
// one account, so a mirror there buys nothing.
if (parseBoolEnv('MEDIA_MIRROR', false)) {
  const media = {
    endpoint: process.env.MEDIA_S3_ENDPOINT?.trim() || '',
    name: process.env.MEDIA_S3_BUCKET?.trim() || '',
    accessKeyId: process.env.MEDIA_S3_ACCESS_KEY_ID?.trim() || '',
    secretAccessKey: process.env.MEDIA_S3_SECRET_ACCESS_KEY?.trim() || '',
    ...(process.env.MEDIA_S3_REGION?.trim() ? { region: process.env.MEDIA_S3_REGION.trim() } : {}),
  };
  if (media.endpoint && media.name && media.accessKeyId && media.secretAccessKey && BACKUP_S3.endpoint && BACKUP_S3.name && BACKUP_S3.accessKeyId && BACKUP_S3.secretAccessKey) {
    const everyHours = parsePositiveIntEnv('MEDIA_MIRROR_INTERVAL_HOURS', 24);
    new MediaBucketMirror({
      source: media,
      target: BACKUP_S3,
      log: (line) => console.log(`[MediaMirror] ${line}`),
      record: (status, detail) => backupMonitor?.record('media', status, detail),
    }).start(everyHours * 60 * 60_000, 20 * 60_000);
    console.log(`[config] MEDIA_MIRROR=every ${everyHours}h, ${media.name} into ${BACKUP_S3.name}/media/`);
  } else {
    console.warn('[config] MEDIA_MIRROR=on needs MEDIA_S3_* and BACKUP_S3_*; not started');
  }
}
// The central code host's repos into the backups bucket (note #1032): the
// host already bundles and uploads on request (/internal/backup/run, the
// org hosts' path); this is the clock for OUR central host, whose Hetzner
// nightly went to the Storage Box. Opt-in by CENTRAL_GIT_BACKUP=on. The first
// run of a fresh state uploads every repo and may outlive the HTTP call; seed
// it by hand (docs/control-plane-on-fly.md), after which runs are incremental.
if (parseBoolEnv('CENTRAL_GIT_BACKUP', false)) {
  if (gitHostClient && BACKUP_S3.endpoint && BACKUP_S3.name && BACKUP_S3.accessKeyId && BACKUP_S3.secretAccessKey) {
    // At most one run per UTC day, remembered beside the database. A bundle's
    // key is the day (git/<ns>/<repo>/<day>.bundle), and the R2 bucket's lock
    // refuses to overwrite it: a second run on the same day, which every
    // deploy's restart used to start, would fail on each repo pushed since
    // the first. The file survives restarts; losing it costs one refused run.
    const centralGitStamp = sqliteDbPath ? `${dirnameNode(sqliteDbPath)}/central-git-backup.last` : '';
    const runCentralGitBackup = async () => {
      const today = new Date().toISOString().slice(0, 10);
      if (centralGitStamp) {
        const last = await readFileNode(centralGitStamp, 'utf8').then((text) => text.trim()).catch(() => '');
        if (last === today) return;
      }
      try {
        const r = await gitHostClient.runBackup({
          endpoint: BACKUP_S3.endpoint, bucket: BACKUP_S3.name,
          accessKeyId: BACKUP_S3.accessKeyId, secretAccessKey: BACKUP_S3.secretAccessKey,
        });
        const detail = `${r.repos} repos, ${r.uploaded} uploaded (${r.uploadedBytes} bytes), ${r.unchanged} unchanged, ${r.pruned} pruned`
          + (r.failed.length ? `, ${r.failed.length} failed (first: ${r.failed[0]!.repo}: ${r.failed[0]!.error.slice(0, 120)})` : '');
        console.log(`[CentralGitBackup] ${detail}`);
        backupMonitor?.record('git-r2', r.failed.length || r.repos === 0 ? 'fail' : 'ok', detail);
        if (centralGitStamp && r.repos > 0) await writeFileNode(centralGitStamp, `${today}\n`).catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[CentralGitBackup] failed: ${message}`);
        backupMonitor?.record('git-r2', 'fail', message);
      }
    };
    // Checked hourly; the stamp keeps it to one run a day.
    setInterval(runCentralGitBackup, 60 * 60_000).unref();
    setTimeout(runCentralGitBackup, 15 * 60_000).unref();
    console.log(`[config] CENTRAL_GIT_BACKUP=once a UTC day into ${BACKUP_S3.name}/git/`);
  } else {
    console.warn('[config] CENTRAL_GIT_BACKUP=on needs the git host and BACKUP_S3_*; not started');
  }
}
// The central code host's weekly upkeep (note #1032): on Hetzner a systemd
// timer ran maintain-repos.sh (trash purge, git gc); on Fly the host has no
// timers, so this is its clock. Once per ISO week, remembered beside the
// database, checked every 6 hours. Opt-in by CENTRAL_GIT_MAINTENANCE=on.
if (parseBoolEnv('CENTRAL_GIT_MAINTENANCE', false) && gitHostClient) {
  const stampFile = sqliteDbPath ? `${dirnameNode(sqliteDbPath)}/central-git-maintenance.last` : '';
  const isoWeekOf = (d: Date) => {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  };
  const runCentralGitMaintenance = async () => {
    const week = isoWeekOf(new Date());
    if (stampFile && (await readFileNode(stampFile, 'utf8').then((t) => t.trim()).catch(() => '')) === week) return;
    try {
      const r = await gitHostClient.runMaintenance();
      console.log(`[CentralGitMaintenance] exit ${r.code} in ${r.seconds}s: ${r.tail.split('\n').slice(-1)[0] ?? ''}`);
      if (r.code !== 0) await opsNotifier?.(`🔴 code host upkeep failed (exit ${r.code})\n${r.tail.slice(-1500)}`).catch(() => undefined);
      if (stampFile) await writeFileNode(stampFile, `${week}\n`).catch(() => undefined);
    } catch (error) {
      console.warn(`[CentralGitMaintenance] failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  setInterval(runCentralGitMaintenance, 6 * 60 * 60_000).unref();
  setTimeout(runCentralGitMaintenance, 30 * 60_000).unref();
  console.log('[config] CENTRAL_GIT_MAINTENANCE=once an ISO week (trash purge, git gc)');
}
// A private copy's health page and diagnostics bundle (note #813), for its
// admins. Every part is asked live: the code host and router by their
// public names, the mail receiver over the private network by the app name
// the installer gave it (<prefix>-mx beside <prefix>-backend).
// The image writes the commit it was built from beside dist/ (RELEASE_SHA).
const copyReleaseSha = PRIVATE_COPY ? (() => {
  try { return readFileSyncNode('RELEASE_SHA', 'utf8').trim() || null; } catch { return null; }
})() : null;
const copyAppPrefix = /^(.+)-backend$/.exec(process.env.FLY_APP_NAME ?? '')?.[1];
// A private copy's licence (note #814): read at start and daily, never sent
// anywhere. Licensing is OFF (note #935, 1 Nov 2026: the product is free for now): the
// copy checks and counts nothing unless COPY_LICENCE=on, the one switch the
// installer and the update service share.
const COPY_LICENCE_ON = PRIVATE_COPY && (process.env.COPY_LICENCE ?? '').trim().toLowerCase() === 'on';
/** People who can use the copy: members of a workplace, and anyone waiting
 *  on a request to join one. */
const countCopyPeople = async (): Promise<number> => {
  const people = new Set<string>();
  for (const org of await orgStorage.listOrgs()) {
    for (const member of await orgStorage.listMembers(org.orgId)) people.add(member.userId);
    for (const request of await orgStorage.listJoinRequests(org.orgId)) if (request.status === 'pending') people.add(request.userId);
  }
  return people.size;
};
const copyLicence = COPY_LICENCE_ON
  ? new CopyLicence({
      domain: (() => { try { return new URL(process.env.WORKSPACE_URL ?? '').hostname; } catch { return ''; } })(),
      ...(process.env.LICENCE?.trim() ? { installed: process.env.LICENCE.trim() } : {}),
      store: sqliteDb ? new SqliteLicenceStore(sqliteDb) : new InMemoryLicenceStore(),
      countPeople: countCopyPeople,
      log: (line) => console.log(line),
    })
  : null;
if (PRIVATE_COPY) console.log(`[config] COPY_LICENCE=${copyLicence ? 'on' : 'off'}`);
copyLicence?.start();
// Whether a newer release is out (note #1005): our public release list,
// asked about hourly with nothing about this copy in the question.
// COPY_UPDATES_URL points it at another address; COPY_UPDATES_URL=off stops it.
const copyReleaseCheck = PRIVATE_COPY
  ? createReleaseCheck({ url: updatesUrlFrom(process.env.COPY_UPDATES_URL), log: (line) => console.warn(line) })
  : null;
if (copyReleaseCheck) {
  const where = copyReleaseCheck.state().url;
  console.log(`[config] COPY_UPDATES_URL=${where ?? 'off'}`);
  copyReleaseCheck.start();
}
// Our side of the private copies (note #1058): the pulses they send us (the
// receiving route is note #1057's), and the releases we offer, which "two
// releases behind" is counted against. Never in a copy, which keeps none.
const copyPulses = PRIVATE_COPY ? null : sqliteDb ? new SqliteCopyPulseStore(sqliteDb) : new InMemoryCopyPulseStore();
const offeredReleases = PRIVATE_COPY ? null : createReleaseCheck({ url: updatesUrlFrom(process.env.COPY_UPDATES_URL), log: (line) => console.warn(line) });
offeredReleases?.start();
const copyReleaseList = async (): Promise<string[] | null> => {
  if (!offeredReleases) return null;
  const read = await offeredReleases.current();
  return read.reachedAt ? read.releases.map((release) => release.version) : null;
};
const copyHealth = PRIVATE_COPY
  ? createCopyHealth({
      ...(process.env.COPY_RELEASE?.trim() ? { release: process.env.COPY_RELEASE.trim() } : {}),
      ...(copyReleaseSha ? { commit: copyReleaseSha } : {}),
      startedAt: new Date(),
      ...(sqliteDbPath ? { dbPath: sqliteDbPath, dataDir: dirnameNode(sqliteDbPath) } : {}),
      ...(dbBackupsOn ? { lastDbBackup: () => lastDbBackup, backupEveryHours: DB_BACKUP_EVERY_HOURS } : {}),
      ...(process.env.GIT_HOST_CONTROL_URL ? { gitHealthUrl: `${process.env.GIT_HOST_CONTROL_URL.replace(/\/$/, '')}/health` } : {}),
      ...(process.env.APPS_DOMAIN ? { routerHealthUrl: `https://health-check.${process.env.APPS_DOMAIN}/__router/health` } : {}),
      // Read live: a copy installs without email (note #946).
      mail: () => ({ phase: copyMailSetup?.phase() ?? 'off', healthUrl: copyMailSetup?.receiverHealthUrl() ?? null }),
      env: process.env,
      ...(copyLicence ? { licence: () => copyLicence.status() } : {}),
      ...(copyReleaseCheck ? { updates: copyReleaseCheck } : {}),
    })
  : null;
// The daily pulse, the copy's side (note #1057): counts and the contact
// person, signed, to our backend once a day, at boot and when the contact
// changes. The admin's off switch is in the Workspace; COPY_LICENCE=on keeps
// it on. COPY_PULSE_URL points it at another receiver (a scratch one in tests).
const copyPulse = PRIVATE_COPY
  ? createCopyPulse({
      store: sqliteDb ? new SqliteCopyPulseSettingsStore(sqliteDb) : new InMemoryCopyPulseSettingsStore(),
      url: pulseUrlFrom(process.env.COPY_PULSE_URL),
      domain: (() => { try { return new URL(process.env.WORKSPACE_URL ?? '').hostname; } catch { return ''; } })(),
      release: process.env.COPY_RELEASE?.trim() || null,
      installContact: { name: process.env.COPY_CONTACT_NAME, email: process.env.COPY_CONTACT_EMAIL },
      // A copy installed before the installer asked: its first admin.
      firstAdmin: async () => {
        const admins = [];
        for (const org of await orgStorage.listOrgs()) {
          for (const member of await orgStorage.listMembers(org.orgId)) if (member.role === 'admin') admins.push(member);
        }
        admins.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
        const profile = admins[0] ? await userStorage.getProfile(admins[0].userId) : null;
        return profile?.email ? { name: profile.displayName || profile.email, email: profile.email } : null;
      },
      licenceOn: COPY_LICENCE_ON,
      collect: () => (sqliteDb
        ? collectCopyPulseFacts({
            db: sqliteDb,
            countPeople: countCopyPeople,
            lastBackupAt: () => (lastDbBackup?.ok ? lastDbBackup.at : null),
            ...(sqliteDbPath ? { dataDir: dirnameNode(sqliteDbPath) } : {}),
            ...(copyHealth ? { healthReport: () => copyHealth.report() } : {}),
          })
        : Promise.reject(new Error('no database to count from'))),
      log: (line) => console.log(line),
    })
  : null;
if (copyPulse) {
  console.log(`[config] COPY_PULSE_URL=${copyPulse.url}`);
  void copyPulse.start().catch((error) => console.warn('[copy-pulse] could not start:', error));
}
// Our side: the public half of each copy's pulse key (note #1057).
const copyPulseKeys = PRIVATE_COPY ? null : sqliteDb ? new SqliteCopyPulseKeyStore(sqliteDb) : new InMemoryCopyPulseKeyStore();
// The Upgrade button (note #1008): the Workspace starts the one-shot upgrader
// in <prefix>-upgrader and reads the run record back from the backup bucket.
let copyUpgraderReady = false;
const copyUpgrade = PRIVATE_COPY && copyAppPrefix && FLY_API_TOKEN
  ? createCopyUpgrade({
      prefix: copyAppPrefix,
      region: FLY_REGION,
      token: FLY_API_TOKEN,
      updatesUrl: copyReleaseCheck?.state().url ?? null,
      bucket: process.env.BACKUP_S3_ENDPOINT && process.env.BACKUP_S3_BUCKET && process.env.BACKUP_S3_ACCESS_KEY_ID && process.env.BACKUP_S3_SECRET_ACCESS_KEY
        ? s3UpgradeBucket({
          endpoint: process.env.BACKUP_S3_ENDPOINT, bucket: process.env.BACKUP_S3_BUCKET,
          accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY,
        })
        : null,
      fly: new FlyClient(FLY_API_TOKEN),
      releases: async () => {
        const check = copyReleaseCheck ? await copyReleaseCheck.current() : null;
        const latest = check?.latest ?? null;
        return {
          running: process.env.COPY_RELEASE?.trim() || null,
          latest,
          latestDate: check?.releases.find((release) => release.version === latest)?.date ?? null,
        };
      },
      upgraderReady: () => copyUpgraderReady,
      ...(sqliteDbPath ? { dbPath: sqliteDbPath, dataDir: dirnameNode(sqliteDbPath) } : {}),
      signInsOpen: () => seatSignInFlow.openClaudeSignIns(),
      cancelSignIn: (userId) => seatSignInFlow.cancel(userId),
      agentsWorking: () => countActiveDetachedTurns(),
      rollMx: Boolean(process.env.RESEND_MAIL_API_KEY || process.env.SMTP_HOST),
    })
  : null;
// The ops bot's inbound half: /users answers with who is on the platform,
// /fleet with which identity version the agents are on. Same two
// env vars the backup monitor already needs — with them the bot gains a
// command, without them it stays the send-only alert channel it was.
const opsBotWebhookSecret = process.env.TELEGRAM_OPS_WEBHOOK_SECRET || '';
const opsBotWebhookUrl = process.env.TELEGRAM_OPS_WEBHOOK_URL || '';
const opsBotService = TELEGRAM_OPS_BOT_TOKEN && TELEGRAM_OPS_CHAT_ID
  ? new OpsBotService({
      botToken: TELEGRAM_OPS_BOT_TOKEN,
      chatId: TELEGRAM_OPS_CHAT_ID,
      users: userStorage,
      ...(sqliteDb ? { roster: async () => readUserRoster(sqliteDb) } : {}),
      ...(OPS_MINIAPP_URL ? { miniAppUrl: OPS_MINIAPP_URL } : {}),
      ...(opsBotWebhookUrl
        ? { webhookBaseUrl: new URL(opsBotWebhookUrl).href.replace(/\/telegram-ops\/?$/, '') }
        : {}),
      ...(opsBotWebhookSecret ? { webhookSecret: opsBotWebhookSecret } : {}),
    })
  : undefined;
// managed_droplets is likewise frozen legacy state (0 docs, writers
// unreachable): the InMemory impl serves the same empty answers.
const managedServerStorage = new InMemoryManagedServerStorage();
const managedServerService = new ManagedServerService(managedServerStorage);
const pendingTurnStorage = sqliteDb
  ? new SqlitePendingTurnStorage(sqliteDb)
  : new InMemoryPendingTurnStorage();
const seatSignInStorage = sqliteDb
  ? new SqliteSeatSignInStorage(sqliteDb, secretCipher)
  : new InMemorySeatSignInStorage();
const stoppedUserMessageStorage = sqliteDb
  ? new SqliteStoppedUserMessageStorage(sqliteDb)
  : new InMemoryStoppedUserMessageStorage();
const agentActivityStore = sqliteDb
  ? new SqliteAgentActivityStore(sqliteDb)
  : new InMemoryAgentActivityStore();
// How long each agent has worked, for life (note #644) — beside the record,
// so a deleted agent's hours stay on its owner's and the workplace's totals.
const agentWorkLedger = sqliteDb
  ? new SqliteAgentWorkLedger(sqliteDb)
  : new InMemoryAgentWorkLedger();
// The tokens each agent turn spent, per owner and day — read only by that
// owner (the Subscriptions screen), kept past the agent's deletion.
const agentTokenLedger = sqliteDb
  ? new SqliteAgentTokenLedger(sqliteDb)
  : new InMemoryAgentTokenLedger();
const configDocSource = sqliteDb ? new SqliteConfigDocSource(sqliteDb) : null;
// BYO media (byo-media-design): the env-configured store is org #0's row;
// every other org's attachments route to a bucket in ITS OWN Fly account,
// provisioned lazily on first upload. The routing happens per storage path
// inside the wrapper, so every consumer keeps holding one MediaStorage.
const platformMediaStorage = createS3MediaStorageFromEnv();
const mediaStorage = platformMediaStorage
  ? new OrgRoutedMediaStorage(
    new OrgMediaService({
      orgStorage, orgSecrets, orgFly: orgFlyService, platformStorage: platformMediaStorage,
      platformFlyOrgSlug: FLY_ORG,
    }),
    platformMediaStorage,
  )
  : undefined;
if (mediaStorage) {
  console.log('[Storage] Media storage: S3-compatible endpoint, org-routed');
} else {
  console.warn('[Storage] Media storage disabled - set MEDIA_S3_* env vars to enable attachments');
}
// Work radio (note #712): stations for every signed-in person (note #761),
// their tracks in the platform's own bucket. Tracks are made when the
// operator orders them, and only where fal.ai can be reached; RADIO_LIBRARY=off
// stops the making (orders wait) and leaves the stations playing what they have.
//
// OFF since 2026-10-30 (note #842), on every backend, customer copies too:
// WORK_RADIO=on in the backend env is the one switch that brings it back.
// Off, nothing is built — no station, no maker, no hourly check, no call to
// fal.ai — so the state read says `radio: false`, the Workspace draws no
// button, picker or library row, and the radio's doors answer 404. The
// tracks' rows and bytes are left exactly where they are.
const radioOn = process.env.WORK_RADIO === 'on';
if (!radioOn) console.log('[radio] off (WORK_RADIO=on turns it on)');
const radioStorage = sqliteDb ? new SqliteRadioStorage(sqliteDb) : new InMemoryRadioStorage();
const radioMaker = radioOn && platformMediaStorage && process.env.FAL_KEY && process.env.RADIO_LIBRARY !== 'off'
  ? new RadioLibrary({ storage: radioStorage, media: platformMediaStorage, falKey: process.env.FAL_KEY })
  : undefined;
radioMaker?.start();
const radioStation = radioOn && platformMediaStorage
  ? new RadioStation(radioStorage, platformMediaStorage, Math.random, () => { void radioMaker?.check(); },
    radioMaker ? (station, take) => radioMaker.importTrack(station, take) : undefined)
  : undefined;
// Inbound mail (note #509 slice 2). The Cloudflare `mail-inbound` Email
// Worker presents MAIL_INGEST_SECRET on every call; without it — or without
// somewhere to put the raw bytes — the ingest routes 503 and the Worker
// fails the delivery, so the sending server retries instead of bouncing.
const MAIL_INGEST_SECRET = process.env.MAIL_INGEST_SECRET?.trim() || '';
const mailIngest = mediaStorage && MAIL_INGEST_SECRET
  ? new MailIngestService({ mailboxes: mailboxStorage, messages: mailMessageStorage, media: mediaStorage })
  : undefined;
console.log(
  `[config] MAIL_INBOUND=${mailIngest
    ? 'enabled'
    : `disabled (${MAIL_INGEST_SECRET ? 'needs MEDIA_S3_*' : 'set MAIL_INGEST_SECRET'})`}`,
);
// Answering a message (note #509 slice 4). A DIFFERENT Resend key from the
// sign-in links': that one is scoped to updates.agenticcloudcomputer.com and
// must keep its own reputation, this one sends as the person's own address on
// the root domain.
const RESEND_MAIL_API_KEY = process.env.RESEND_MAIL_API_KEY?.trim() || '';
const outboxVia = (sender: MailSender) => new MailOutboxService({
  mailboxes: mailboxStorage,
  messages: mailMessageStorage,
  sender,
  // Where a file that leaves with a message is kept (slice 12). Without it
  // mail still goes, words only, and a message with files is refused.
  ...(mediaStorage ? { media: mediaStorage } : {}),
});
// Both are `let`: a copy's admin turns mail on while the Workspace runs
// (note #946), and the routes read them through getters on deps.
let mailOutbox = RESEND_MAIL_API_KEY || smtpTransport
  ? outboxVia(RESEND_MAIL_API_KEY ? new ResendMailSender({ apiKey: RESEND_MAIL_API_KEY }) : new SmtpMailSender(smtpTransport!))
  : undefined;
let mailApprovals = mailOutbox
  ? new MailApprovalService(mailApprovalStorage, mailOutbox)
  : undefined;
// Outreach (note #1089): the platform operator's own screen for cold
// outreach. Never in a private copy. It sends only through the person's own
// outbox (read through a getter: mail may be set up after boot), and only
// when the owner presses Send.
// Its own site (note #1093) reaches it with a pass from the pass door; the
// one origin a pass is sent to.
const OUTREACH_SITE_ORIGIN = process.env.OUTREACH_SITE_ORIGIN?.trim().replace(/\/+$/, '') || OUTREACH_SITE_ORIGIN_DEFAULT;
const outreachPasses = PRIVATE_COPY ? null : new OutreachPasses(sqliteDb ? new SqliteOutreachPassStore(sqliteDb) : new InMemoryOutreachPassStore());
// Resend's webhook signing secret for the Outreach letters' delivery facts (note #1112); without it they are off.
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET?.trim() || '';
const outreach = PRIVATE_COPY ? null : new OutreachService({
  store: sqliteDb ? new SqliteOutreachStore(sqliteDb) : new InMemoryOutreachStore(),
  mailEventsConfigured: Boolean(RESEND_WEBHOOK_SECRET),
  // A sent letter's words, read back from his Sent (note #1130).
  sentMail: (userId, mailId) => mailMessageStorage.get(userId, mailId),
  outbox: () => mailOutbox,
  mailboxes: mailboxStorage,
  pulses: async () => (copyPulses ? (await copyPulses.list()).map((record) => record.pulse) : []),
  senderName: async (userId) => {
    const person = (await userStorage.getProfile(userId).catch(() => null))?.person;
    return [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim();
  },
});
console.log(`[config] OUTREACH_MAIL_FACTS=${PRIVATE_COPY ? 'none (a private copy)' : RESEND_WEBHOOK_SECRET ? 'enabled' : 'off (set RESEND_WEBHOOK_SECRET)'}`);
console.log(`[config] MAIL_REPLIES=${mailOutbox
  ? (RESEND_MAIL_API_KEY ? 'enabled' : `enabled over SMTP ${SMTP_SETTINGS!.host}:${SMTP_SETTINGS!.port}`)
  : PRIVATE_COPY ? 'set up from the Workspace (Mail), note #946' : 'disabled (set RESEND_MAIL_API_KEY or SMTP_HOST)'}`);
// Email set up after the install (note #946): a copy only. A copy whose
// installer predates it may carry its provider in the environment, and then
// mail is on from the start, exactly as before.
const envSending: CopyMailSending | null = RESEND_MAIL_API_KEY
  ? { kind: 'resend', apiKey: RESEND_MAIL_API_KEY }
  : SMTP_SETTINGS ? { kind: 'smtp', settings: SMTP_SETTINGS } : null;
const copyMailSetup = PRIVATE_COPY
  ? new CopyMailSetup({
    store: sqliteDb ? new SqliteCopyMailSetupStore(sqliteDb) : new InMemoryCopyMailSetupStore(),
    cipher: secretCipher,
    domain: MAIL_DOMAIN,
    org: FLY_ORG,
    region: FLY_REGION,
    prefix: copyAppPrefix ?? null,
    mxImage: process.env.FLY_MX_IMAGE?.trim() || null,
    ingestSecret: MAIL_INGEST_SECRET || null,
    backendUrl: `http://${process.env.FLY_APP_NAME?.trim() || 'localhost'}.internal:8080`,
    fly: FLY_API_TOKEN ? new FlyClient(FLY_API_TOKEN) : null,
    fromInstall: envSending,
    onSendingChanged: (sending) => {
      liveVerificationEmail = sending ? verificationEmailVia(sending) : envVerificationEmail;
      mailOutbox = sending
        ? outboxVia(sending.kind === 'resend' ? new ResendMailSender({ apiKey: sending.apiKey }) : new SmtpMailSender(createSmtpTransport(sending.settings)))
        : undefined;
      mailApprovals = mailOutbox ? new MailApprovalService(mailApprovalStorage, mailOutbox) : undefined;
      console.log(`[config] mail out ${sending ? `on, through ${sending.kind === 'resend' ? 'Resend' : `SMTP ${sending.settings.host}:${sending.settings.port}`}` : 'off'} (note #946)`);
    },
  })
  : null;
copyMailSetup?.boot();
if (copyMailSetup && !copyMailSetup.isOn()) console.log('[config] email is not set up yet: an admin sets it up in the Workspace, under Mail (note #946)');
const eventEmitter = globalEventEmitter;
const backgroundRunner = globalBackgroundRunner;
const userSandboxManager = new UserDevelopmentEnvironmentManager(
  sandboxClient,
  sandboxStorage,
  managedServerService,
);
const sessionManager = new SessionManager(sandboxClient);
const agentConfigService = new AgentConfigService(configDocSource);
// Pinned harness-CLI versions (config/harnessCliVersions) — written only by
// scripts/harness-cli-versions.mjs; read by the pre-sleep updater and the
// agent menu's Version view.
const harnessCliVersionService = new HarnessCliVersionService(configDocSource);
// A private copy follows the pin we publish, daily, unless its admin holds a
// pin of their own (note #1052). Writes the copy's own config/harnessCliVersions;
// the updater below does the rest. COPY_PINS_URL points it elsewhere; =off stops it.
const cliPinFollower = PRIVATE_COPY && configDocSource
  ? createPinFollower({
      url: pinsUrlFrom(process.env.COPY_PINS_URL),
      docs: pinFollowerDocs(configDocSource),
      log: (line) => console.log(line),
      onAdopted: () => harnessCliVersionService.clearCache(),
    })
  : null;
if (cliPinFollower) {
  console.log(`[config] COPY_PINS_URL=${cliPinFollower.url ?? 'off'}`);
  cliPinFollower.start();
}
// One updater behind both convergence paths: the reaper's pre-sleep pass and
// the agent menu's Update button. Exec routes per sandbox id, so it works for
// Fly and legacy Hetzner machines alike.
const harnessCliUpdater = new HarnessCliUpdater({
  execSync: (sandboxId, command, options) => (
    sessionManager.getSandboxClient().execSync(sandboxId, command, undefined, options)
  ),
  getPinnedVersions: () => harnessCliVersionService.getPinnedVersions(),
  persistObservedVersion: async ({ userId, agentId, version, checkedAt }) => {
    await userStorage.updateAgentFields(userId, agentId, {
      cliVersion: version,
      cliVersionCheckedAt: checkedAt,
    });
  },
});
// One updater behind both image paths as well: the reaper's roll at sleep, and
// the agent menu's manual button. Without it a machine runs its creation-time
// image for life, so every image fix reaches new signups and nobody else.
const machineImageUpdater = FLY_API_TOKEN && FLY_MACHINE_IMAGE
  ? new MachineImageUpdater({
    flyClient: new FlyClient(FLY_API_TOKEN),
    // A client-org machine's config writes ride that org's own token.
    resolveFlyClientForApp: async (appName) => (await resolveFlyAppOrgContext(appName))?.client ?? null,
    // …and a machine built with no SSH pin is given its network's (note #664).
    resolveBackendPeerForApp: async (appName) => (await resolveFlyAppOrgContext(appName))?.backendPeerIp,
    getTargetImage: () => FLY_MACHINE_IMAGE,
    // …and every sleeping machine comes to trust exactly the keys a new one
    // would get: how a fleet SSH key rotation reaches existing machines
    // (note #1074, docs/fleet-ssh-key.md).
    getAuthorizedKeys: () => FLY_SSH_PUBLIC_KEY,
    persistObservedImage: async ({ userId, agentId, image, checkedAt }) => {
      await userStorage.updateAgentFields(userId, agentId, {
        machineImage: image,
        machineImageCheckedAt: checkedAt,
      });
    },
  })
  : undefined;
// Production deployments: built when Fly + the app-runtime image are
// configured. Consumed by /api/agent-cli (the `agentbuilt` CLI on agent
// machines), the hosting fulfilment below, and
// backend/scripts/deployments.mjs (operator control). Built BEFORE the agent
// service so the identity writer knows whether to teach production hosting.
const deploymentService = flySandboxClient && FLY_APP_RUNTIME_IMAGE
  ? new DeploymentService({
      // Deploys land in the owning org's Fly account (byo-fly-design slice 5).
      resolveAppContext: resolveFlyAppOrgContext,
      fly: new FlyClient(FLY_API_TOKEN),
      sandboxClient: flySandboxClient,
      storage: deploymentStorage,
      dns: CLOUDFLARE_APPS_DNS_TOKEN && CLOUDFLARE_APPS_ZONE_ID
        ? new CloudflareAppsDns(CLOUDFLARE_APPS_DNS_TOKEN, CLOUDFLARE_APPS_ZONE_ID)
        : null,
      orgSlug: FLY_ORG,
      region: FLY_REGION,
      image: FLY_APP_RUNTIME_IMAGE,
      appsDomain: APPS_DOMAIN,
      // A site's name reaches its machine through the name map below, the
      // same way an agent's preview link does (note #766): tell the map
      // whenever a site goes live, moves, pauses or goes.
      onNamesChanged: () => previewDomainService?.invalidate(),
      stagingDir: DEPLOY_STAGING_DIR,
      ...(FLY_SSH_PUBLIC_KEY ? { authorizedKeys: FLY_SSH_PUBLIC_KEY } : {}),
      ...(FLY_BACKEND_PEER_IP ? { backendPeerIp: FLY_BACKEND_PEER_IP } : {}),
      // A new site's keys (note #661), read for the agent that deployed it:
      // the record's own user and agent are that deployer's.
      resolveSecrets: async (deployment) => {
        const { env, missing } = await resolveSiteSecrets(
          { secretStorage, resolveNamespace: (u, o) => orgGitService.resolveNamespace(u, o) },
          {
            userId: deployment.userId,
            orgId: deployment.orgId ?? null,
            agentId: deployment.agentId,
          },
          deployment.secretNames ?? [],
        );
        if (missing.length > 0) {
          throw new Error(`${deployment.name} runs with ${missing.join(', ')}, which its deploying agent is no longer handed`);
        }
        return env;
      },
    })
  : undefined;
console.log(
  `[config] DEPLOYMENTS=${deploymentService ? 'enabled' : 'disabled'} `
  + `(runtimeImage=${FLY_APP_RUNTIME_IMAGE || 'unset'}, domain=${APPS_DOMAIN}, `
  + `agentCliUrl=${AGENTBUILT_API_URL || 'unset'}, `
  + `dns=${CLOUDFLARE_APPS_DNS_TOKEN && CLOUDFLARE_APPS_ZONE_ID ? 'zone-configured' : 'unset (legacy records left as they are)'})`,
);

// Set once agentService exists (constructed later); the closure below
// only fires on webhook events, long after boot.
let hostingNotifier: ((args: { userId: string; agentId: string; text: string }) => Promise<unknown>) | undefined;

// Building a site and announcing it: hosting is included with the account
// (the pricing ladder retired with the org pivot), so `agentbuilt deploy`
// takes a site live with no payment in the path.
const hostingFulfilment = deploymentService
  ? new HostingFulfilment({
      storage: deploymentStorage,
      service: deploymentService,
      notify: (args) => hostingNotifier?.(args) ?? Promise.resolve(false),
    })
  : undefined;

// Branded hostnames on the apps domain (<name>.agentbuilt.app): every agent
// machine's preview link and, since note #766, every hosted site. Independent
// of the deployments product: needs only Fly + the DNS zone, so previews stay
// branded even where hosting is off. The taken-name hook keeps preview slugs
// out of hosting's namespace (a name reserved by a deploy has no record of
// its own anywhere but the deployments table).
// A private copy (note #804) has no Cloudflare zone: it names its own apps
// domain and runs its own router (infra/copy-router), which asks this map.
const APPS_DNS_ZONE = CLOUDFLARE_APPS_DNS_TOKEN && CLOUDFLARE_APPS_ZONE_ID
  ? new CloudflareAppsDns(CLOUDFLARE_APPS_DNS_TOKEN, CLOUDFLARE_APPS_ZONE_ID)
  : null;
const previewDomainService = flySandboxClient && (APPS_DNS_ZONE || process.env.APPS_DOMAIN)
  ? new PreviewDomainService({
      dns: APPS_DNS_ZONE,
      appsDomain: APPS_DOMAIN,
      isNameTaken: async (name) => Boolean(await deploymentStorage.getByName(name)),
      // The deployment and agent records ARE the name→app mapping the
      // preview-router Worker asks for (GET /api/preview-map/:slug, below).
      // Sites first: a site's name beats an agent's, as its CNAME used to
      // beat the wildcard record.
      loadMappings: async () => [
        ...siteMappingsFromDeployments(await deploymentStorage.listAll()),
        ...previewMappingsFromProfiles(await userStorage.getAllUsers()),
      ],
    })
  : undefined;
console.log(`[config] PREVIEW_DOMAINS=${previewDomainService ? `enabled (*.${APPS_DOMAIN})` : 'disabled (fly.dev URLs)'}`);

// The sealed public guide (note #1010): transcripts and the route's pointer
// at its agent. Its service is built after the agent service, which it
// borrows the guide's machine from.
const publicGuideStorage = sqliteDb ? new SqlitePublicGuideStorage(sqliteDb) : new InMemoryPublicGuideStorage();
/**
 * Where a sealed guide's public copy comes from: the repository named
 * PUBLIC_GUIDE_REPO_NAME in the guide's own workplace, and ONLY while it is
 * public — an anonymous clone URL, or nothing. If it is not public, it is
 * not on that machine.
 */
const publicGuideSource = async (_userId: string, agent: AgentRecord): Promise<GuideSource | null> => {
  if (!agent.orgId) return null;
  const org = await orgStorage.getOrg(agent.orgId).catch(() => null);
  if (!org) return null;
  const carried = await gitRepoStorage.listNamespacesByOrg(org.orgId).catch(() => [] as string[]);
  const namespaces = [...new Set([org.git?.namespaceId ?? org.createdByUserId, ...(org.roomsMerged?.namespaces ?? []), ...carried])];
  const repo = await gitRepoStorage.getLiveByNameIn(namespaces, PUBLIC_GUIDE_REPO_NAME).catch(() => null);
  if (!repo?.publicAccess) return null;
  const host = await orgGitHostService.clientFor(org.orgId).catch(() => gitHostClient ?? null);
  if (!host) return null;
  return { cloneUrl: host.cloneUrl(repo.userId, repo.name), branch: repo.defaultBranch ?? 'main' };
};

const agentService = new AgentService({
  publicGuide: {
    setGuide: (userId, agentId) => publicGuideStorage.setGuide({ userId, agentId, setAt: new Date().toISOString() }),
    clearGuide: async (agentId) => {
      if ((await publicGuideStorage.getGuide())?.agentId === agentId) await publicGuideStorage.setGuide(null);
    },
  },
  publicGuideSource,
  sessionStorage,
  agentChatStorage,
  secretStorage,
  platformCredentialPool,
  orgStorage,
  ...(copyLicence ? { copyLicenceAgentRefusal: () => copyLicence.agentRefusal() } : {}),
  // Converges a client org's tunnel before provisioning spends a machine on
  // a network the backend cannot reach (the first founder's failure mode).
  orgWireGuard: orgWireGuardService,
  userStorage,
  sessionManager,
  eventEmitter,
  backgroundRunner,
  userSandboxManager,
  notifyWorkspace: (input) => workspaceNotifications.notify(input),
  mediaStorage,
  agentConfigService,
  aiModel: AI_MODEL,
  managedServerService,
  flySandboxClient,
  pendingTurnStorage,
  stoppedUserMessageStorage,
  agentActivityStore,
  agentWorkLedger,
  agentTokenLedger,
  harnessCliVersionService,
  harnessCliUpdater,
  ...(machineImageUpdater ? { machineImageUpdater } : {}),
  getTargetMachineImage: () => FLY_MACHINE_IMAGE,
  deploymentStorage,
  gitPullRequestStorage,
  gitRepoStorage,
  gitCommitStatusStorage,
  orgGit: orgGitService,
  orgGitHost: orgGitHostService,
  knowledgeProposalStorage,
  knowledgePageCommentStorage,
  knowledgeShelf,
  ...(gitHostClient ? { gitHostClient, knowledgeHost: gitHostClient } : {}),
  // Only teach agents production hosting when the whole path works: a
  // provisionable deployment service AND a public URL the CLI can call.
  ...(deploymentService && AGENTBUILT_API_URL
    ? { agentbuilt: { apiUrl: AGENTBUILT_API_URL, appsDomain: APPS_DOMAIN } }
    : {}),
  ...(previewDomainService ? { previewDomains: previewDomainService } : {}),
});
// Hosting notices ("your site is live") go to the requesting agent's own chat.
hostingNotifier = (args) => agentService.notifyDeploymentEvent(args);
// A letter arriving wakes the agent its owner chose, if they chose one (note
// #509, slice 11). Wired AFTER the agent service, and by a setter rather than
// a constructor argument, because the ingest service is built long before
// there is anything to resume a turn into. Off entirely when inbound mail is
// off: there is then no arrival to announce.
if (mailIngest) {
  const mailWake = new MailWakeService({
    mailboxes: mailboxStorage,
    wake: (args) => agentService.wakeAgentForArrivedMail(args),
    isWorking: (userId, agentId) => agentService.isAgentTurnRunning(userId, agentId),
  });
  // The same arrival is also an event for its holder's Chief of Staff (note
  // #716), read through `deps` at the moment it lands: the sweep is built by
  // the Workspace router, long after this line.
  mailIngest.watchArrivals({
    noteArrival: (arrival, opts) => {
      mailWake.noteArrival(arrival, opts);
      // Outreach (note #1089): a reply from a target company lands on its timeline.
      void outreach?.noteArrival(arrival, opts).catch((error) => {
        console.warn('[outreach] an arrival could not be matched:', error instanceof Error ? error.message : error);
      });
      void deps.workspaceAgentEvents?.mailArrived(arrival, opts).catch((error) => {
        console.warn('[workspace-agent-events] a letter could not be handed over:', error);
      });
    },
  });
}
// A live assigned seat and a provisioned agent imply `connectedAt`. The
// seat-landing hook normally stamps it synchronously; reconcile at boot too,
// so a restart in that narrow gap — or an older false auth pause whose seat
// has already healed — cannot strand agents on "setting up" forever.
const liveSeatAgentReconciliationReady = roomsGoneReady
  // Ownership must be stamped first: the reconnect is intentionally scoped
  // to an agent's immutable workplace, never the mutable active one.
  .then(() => agentService.reconcileTelegramAgentsForLiveSeats())
  .catch((error) => {
    // Best effort: a transient storage read must not withhold the listener or
    // pending-turn recovery. The next backend restart retries the invariant.
    console.error('[startup] Live-seat agent reconciliation failed:', error);
  });
// Claim the run slot of every turn checkpointed during shutdown before new
// browser messages can enter. This settles when the slots are CLAIMED and
// every detached process is quarantined in memory — not when the turns have
// re-attached to their machines. The re-attach itself settles in the
// background, each turn under its own limit (note #762): on 15 Oct 2026 one
// machine that did not answer held this promise, the listener and the health
// check, and the release of PR #1394 was rolled back for it. Bot
// migration/rehydration is intentionally absent: bots are no longer a product
// route and cannot become live during startup.
const agentRecoveryReady = liveSeatAgentReconciliationReady
  .then(() => agentService.resumePendingTurns());
// The boot summary, once those re-attaches have settled or been called late —
// bounded, and never awaited by anything that serves requests.
void agentRecoveryReady
  .then(() => agentService.whenPendingTurnRecoverySettled())
  .then((outcomes) => {
    if (outcomes.length === 0) return;
    const count = (kind: (typeof outcomes)[number]['outcome']) => outcomes.filter((o) => o.outcome === kind).length;
    console.log(
      `[pending-turns] Boot recovery settled: ${count('resumed')} resumed, ${count('dropped')} dropped, `
      + `${count('late')} late, ${count('failed')} failed`,
    );
  })
  .catch(() => undefined);
// Same deal for hosting: a site is built detached from the request that asked
// for it, so a deploy mid-provision would strand a half-built site. It still
// waits for turn recovery, but does not hold the HTTP listener after every
// recovery run has synchronously claimed its run key.
void agentRecoveryReady
  .then(() => hostingFulfilment?.resumePending())
  .catch((error) => {
    console.error('[startup] Hosting recovery held because agent recovery failed:', error);
  });
// Agent creation is the third long operation that must survive a restart,
// beside those turns and that hosting: a release landing in the 15-60s while
// a new agent's machine is built used to strand that agent on "setting up"
// for good, because the record never learned which machine was its own
// (note #508). Detached for the same reason hosting is — resuming one may
// have to build a machine, and nothing about that should hold the listener.
void agentRecoveryReady
  .then(() => agentService.resumeInterruptedAgentSetups())
  .catch((error) => {
    console.error('[startup] Resuming interrupted agent setups failed:', error);
  });

// The seats screen's "Sign in a subscription" ceremony (org-layer-design
// workstream 2). Every provider's login runs in this process — OpenCode's is a
// pasted key — and no machine is involved in any of them.
const seatSignInFlow = new OrgSeatSignInFlow({
  orgStorage,
  seatSignInStorage,
  onSeatAdded: async (userId, provider, orgId) => {
    await agentService.connectTelegramAgentsForSeat(userId, provider, orgId);
    const org = await orgStorage.getOrg(orgId).catch(() => null);
    if (org?.setupRequired) {
      await orgStorage.updateOrg(orgId, { setupRequired: false });
    }
    // A subscription may be the last thing the workplace's naming waited
    // for: the record-only edge, awaited so the next read already has it.
    await deps.workplaceFounding?.foundIfReady(userId, orgId);
    // The first run (note #726): the receipt row in the person's Chief of
    // Staff chat, and — when they wrote before signing in — its first turn,
    // started by itself on what they wrote. Awaited: the sign-in's last poll
    // answers once the conversation already shows it.
    // The Chief of Staff runs on Claude or ChatGPT; an OpenCode key powers
    // room agents only (note #780), so it is no answer to a first run waiting
    // for a plan.
    if (provider !== 'opencode') {
      await deps.workspaceAgent?.seatSignedIn?.(userId, orgId, provider).catch((error) => {
        console.error(`[first-run] ${orgId}/${userId}: the Chief of Staff could not start on the sign-in:`, error);
      });
    }
    // Planned agents from a founding before note #726 that were waiting for
    // a usable subscription: built now, once.
    if (!org?.foundingPending) {
      void agentService.setUpPlannedAgents(userId, orgId, provider).catch((error) => {
        console.error(`[founding] building the founding agents of ${orgId} failed:`, error);
      });
    }
  },
});
// A Codex ceremony that spanned the last restart is still outstanding: its
// poll must resume rather than answer "no sign-in here". Started now so the
// first poll does not wait on the read; failure is logged inside.
void seatSignInFlow.restore();

// Idle reaper: stop Fly machines idle ≥ FLY_IDLE_STOP_MINUTES, unless THAT
// AGENT has an in-flight turn, a live terminal session, a managed job, or
// recent activity. Checked every FLY_IDLE_SWEEP_SECONDS. Nothing is stopped
// until turn recovery has settled (agentRecoveryReady) — that is when the
// in-memory turn registry is trustworthy again — nor for the short
// FLY_BOOT_GRACE_MINUTES floor after this process starts.
// Only runs when Fly is configured; only ever stops Fly machines.
// Schedules (note #779): built after the route deps below (its owner-facing
// rows ride the event sweep the Workspace router builds); the reaper reads
// it lazily, so the gate is simply closed until then.
let agentSchedules: AgentScheduleService | undefined;
if (flySandboxClient) {
  const flyIdleReaperAlertStore = sqliteDb
    ? new SqliteFlyIdleReaperAlertStore(sqliteDb)
    : new InMemoryFlyIdleReaperAlertStore();
  const flyReaper = new FlyIdleReaper({
    flyClient: new FlyClient(FLY_API_TOKEN),
    orgSlug: FLY_ORG,
    userStorage,
    // THIS agent's own turn slot, or the account-level setup loop that
    // provisions a machine before an agent slot exists to name it. Not
    // `hasSessionRuns`: that is true while ANY of the owner's agents works, so
    // on a fleet of twenty one long turn pinned all twenty machines awake and
    // no value of FLY_IDLE_STOP_MINUTES could ever take effect.
    isTurnRunningForAgent: (userId, agentId) => (
      agentService.isAgentTurnRunning(userId, agentId)
      // The setup loop runs under the bare session key, with no agent slot to
      // name it, and it is what provisions a machine in the first place.
      || backgroundRunner.isRunning(buildAssistantSessionId(userId))
    ),
    // Per-agent recency, so one busy agent doesn't keep its siblings hot.
    getAgentLastActiveAt: (userId, agentId) => agentService.getTelegramAgentLastActiveAt(userId, agentId),
    // Runtime metering: every sweep credits each running machine with the
    // elapsed interval, into telegram.agents.<id>.machineRuntimeMs monthly
    // buckets — the ground truth for "what does this agent cost us".
    recordRuntimeSamples: (samples) => recordAgentRuntimeSamples(userStorage, samples, new Date()),
    // What each machine is made of (note #356), from the listing this sweep
    // already fetched — so every agent's row in the fleet list can say it
    // without `api/state` making a control-plane call per agent. Diff-only:
    // a fleet nobody is resizing writes nothing.
    recordMachineShapes: (observations) => (
      recordAgentMachineShapes(userStorage, observations, new Date())
    ),
    // The stop path's final probe just said "no durable job here" — clear a
    // count a quiet job may have left standing on the plate (note #564).
    recordNoManagedJobs: async ({ userId, agentId }) => {
      const held = (await userStorage.getProfile(userId))?.telegram?.agents?.[agentId]?.activeJobs;
      if (held) await userStorage.updateAgentFields(userId, agentId, { activeJobs: null });
    },
    getActiveSessionHosts: () => globalSshClient.getActiveSessionHosts(),
    // Durable `agentbuilt job` processes live outside turns and outside this
    // backend's memory. Ask the machine itself, as the development user that
    // owns the dedicated tmux socket; the reaper supplies and validates the
    // exact protocol command and fails closed on every unhealthy response.
    execManagedJobProbe: ({ sandboxId, command }) => flySandboxClient.execSync(
      sandboxId,
      command,
      undefined,
      { timeoutMs: 10_000, sshUser: DEFAULT_DEVELOPMENT_SSH_USER },
    ),
    // A copy's upgrader app (note #1008) is the installer's, not an agent's.
    skipAppNames: [FLY_IMAGE_APP, ...(PRIVATE_COPY && copyAppPrefix ? [upgraderAppName(copyAppPrefix)] : [])],
    // The platform's own control plane (note #1070): this backend's app and
    // its siblings by role (ia-git, ia-ci… / <prefix>-git, <prefix>-router…),
    // learned from FLY_APP_NAME so production and every copy agree. Never
    // walked, stopped, deleted or alerted on.
    platformAppNames: platformAppNames({
      ownAppName: process.env.FLY_APP_NAME,
      imageApp: FLY_IMAGE_APP,
      extra: parseCsvEnv('FLY_PLATFORM_APPS'),
    }),
    // Record-allowlist ownership (byo-fly-design): the sweep walks only apps
    // an agent or deployment record claims; anything else is reported, never
    // touched — the posture that has to hold before any client Fly org.
    listDeploymentAppNames: async () => (await deploymentStorage.listAll())
      .map((d) => d.flyApp)
      .filter((appName): appName is string => Boolean(appName)),
    // Connected client orgs are swept too — same allowlist, same gates —
    // so a client-org machine sleeps and converges exactly like ours do.
    listAdditionalOrgContexts: async () => {
      const contexts: Array<{ orgSlug: string; connectionRevision: string; flyClient: FlyClient }> = [];
      for (const org of await orgStorage.listOrgs()) {
        if (!org.fly || org.fly.orgSlug === FLY_ORG) {
          continue;
        }
        try {
          const context = await orgFlyService.resolveOrgFlyContext(org.orgId);
          if (context.source === 'org') {
            // Do not retain or expose the token itself. The reaper only needs
            // an opaque change signal so a 404-suppressed org is retried after
            // the connection is repaired, including a same-slug recreation.
            const connectionRevision = createHash('sha256')
              .update(org.orgId)
              .update('\0')
              .update(context.orgSlug)
              .update('\0')
              .update(context.apiToken)
              .digest('base64url');
            contexts.push({
              orgSlug: context.orgSlug,
              connectionRevision,
              flyClient: new FlyClient(context.apiToken),
            });
          }
        } catch (error) {
          console.warn(`[FlyIdleReaper] org ${org.orgId} has an unresolvable Fly context; skipping its sweep`, error);
        }
      }
      return contexts;
    },
    idleMs: FLY_IDLE_STOP_MINUTES * 60_000,
    intervalMs: FLY_IDLE_SWEEP_SECONDS * 1_000,
    // Deliberately independent of idleMs: a floor, not a copy of the window.
    bootGraceMs: FLY_BOOT_GRACE_MINUTES * 60_000,
    // The gate that actually protects a detached turn across a deploy: the
    // previous process checkpointed it, and this promise settles once
    // resumePendingTurns has re-registered it (or proven it gone).
    recoveryReady: agentRecoveryReady,
    ...(opsNotifier
      ? {
          notifyUnrecordedApps: opsNotifier,
          unrecordedAppAlertStore: flyIdleReaperAlertStore,
        }
      : {}),
    scheduleHoldsAwake: (userId, agentId) => agentSchedules?.holdsAwake(userId, agentId) ?? false,
    updateClisBeforeStop: (args) => harnessCliUpdater.updateBeforeSleep(args),
    cliInstallInFlight: (sandboxId) => harnessCliUpdater.isInstalling(sandboxId),
    ...(machineImageUpdater
      ? { rollImageWhileStopped: (args) => machineImageUpdater.rollWhileStopped(args) }
      : {}),
  });
  flyReaper.start();
  console.log(
    `[config] FLY_IDLE_REAPER=enabled (idle=${FLY_IDLE_STOP_MINUTES}m, `
    + `sweep=${FLY_IDLE_SWEEP_SECONDS}s, boot-grace=${FLY_BOOT_GRACE_MINUTES}m, skip=${FLY_IMAGE_APP})`,
  );
  console.log(`[config] FLY_MACHINE_IMAGE_ROLL=enabled (sleeping machines converge on ${FLY_MACHINE_IMAGE})`);

  // A copy's machines follow its backend to a new address (note #815). Each
  // pins SSH to the address it was made with; a backend Fly moved, or one
  // restored onto a new machine, is refused by all of them until re-pinned.
  if (BACKEND_PEER_FROM_FLY && FLY_BACKEND_PEER_IP) {
    if (CONFIGURED_BACKEND_PEER_IP && CONFIGURED_BACKEND_PEER_IP !== FLY_BACKEND_PEER_IP) {
      console.warn(
        `[config] FLY_BACKEND_PEER_IP names ${CONFIGURED_BACKEND_PEER_IP}, but this backend is now at `
        + `${FLY_BACKEND_PEER_IP}: new machines pin the new address and older ones are re-pinned`,
      );
    }
    const repinFly = new FlyClient(FLY_API_TOKEN);
    const copyPeerRepin = new CopyPeerRepin({
      peerIp: FLY_BACKEND_PEER_IP,
      flyClient: repinFly,
      // Our platform: never restart an awake machine, and keep trying every
      // 10 minutes for a day so each is moved at its next sleep.
      ...(PRIVATE_COPY ? {} : { leaveAwake: true, maxPasses: 144 }),
      // Every app a record claims, in the copy's own account only: a cloud a
      // workplace connected itself pins a different address. Our platform
      // also has machines no agent or site record names (the workplaces'
      // messaging machines), so there it is every app of our own account;
      // a machine with no pin is skipped either way.
      listApps: async () => {
        if (!PRIVATE_COPY) return (await repinFly.listApps(FLY_ORG)).map((app) => app.name);
        const apps = new Set<string>();
        for (const user of await userStorage.getAllUsers()) {
          for (const agent of listAgents(user.telegram, true)) {
            const target = parseFlySandboxId(parseFlyServerRecordId(agent.serverId));
            if (target) apps.add(target.appName);
          }
        }
        for (const deployment of await deploymentStorage.listAll()) {
          if (deployment.flyApp) apps.add(deployment.flyApp);
        }
        const own: string[] = [];
        for (const appName of apps) {
          const context = await resolveFlyAppOrgContext(appName).catch(() => null);
          if (context?.orgSlug === FLY_ORG) own.push(appName);
        }
        return own;
      },
    });
    copyPeerRepin.start(30_000);
    console.log(`[config] COPY_PEER_REPIN=enabled (machines pinned to another address move to ${FLY_BACKEND_PEER_IP})`);
  }

  // A copy's upgrades run on a one-shot machine in <prefix>-upgrader (note
  // #1008): made here if missing, with this backend's Fly token and backup
  // bucket keys as its secrets. Never in the way of starting up.
  if (PRIVATE_COPY && copyAppPrefix && FLY_API_TOKEN && FLY_ORG) {
    void ensureCopyUpgrader({ prefix: copyAppPrefix, org: FLY_ORG, env: process.env, fly: new FlyClient(FLY_API_TOKEN) })
      .then((result) => { copyUpgraderReady = result.ok; })
      .catch((error: unknown) => console.warn(`[copy-upgrader] could not make ${upgraderAppName(copyAppPrefix)} ready: ${error instanceof Error ? error.message : String(error)}`));
  }

  // Recycler: destroy the machines of agents nobody has touched in
  // FLY_RECYCLE_IDLE_DAYS, warning the owner FLY_RECYCLE_WARN_DAYS ahead.
  // Stopping a machine does nothing for the volume, which bills on provisioned
  // size forever — so without this every abandoned signup accrues a permanent
  // floor. Safe only because clearing serverId makes the next message rebuild
  // the machine (ensureTelegramAgentMachine); set FLY_RECYCLE_IDLE_DAYS=0 to
  // switch the whole thing off.
  if (FLY_RECYCLE_IDLE_DAYS > 0) {
    const flyRecycler = new FlyAgentRecycler({
      sandboxClient: flySandboxClient,
      userStorage,
      isTurnRunningForUser: (userId) => backgroundRunner.hasSessionRuns(buildAssistantSessionId(userId)),
      isOrgMember: async (userId) => (await orgStorage.getMembershipByUser(userId)) !== null,
      warnOwner: (args) => agentService.warnTelegramAgentRecycle(args),
      idleMs: FLY_RECYCLE_IDLE_DAYS * 24 * 60 * 60_000,
      warnLeadMs: FLY_RECYCLE_WARN_DAYS * 24 * 60 * 60_000,
    });
    flyRecycler.start();
    console.log(
      `[config] FLY_RECYCLER=enabled (idle=${FLY_RECYCLE_IDLE_DAYS}d, warn=${FLY_RECYCLE_WARN_DAYS}d ahead)`,
    );
  } else {
    console.log('[config] FLY_RECYCLER=disabled (FLY_RECYCLE_IDLE_DAYS=0)');
  }
}
// ── Shared Route Dependencies ──

const publicGuideService = new PublicGuideService({
  storage: publicGuideStorage,
  host: {
    guideAgent: (userId, agentId) => agentService.publicGuideAgent(userId, agentId),
    guideSandbox: (userId, agentId) => agentService.publicGuideSandbox(userId, agentId),
    guideSource: (userId, agent) => agentService.publicGuideSource(userId, agent),
  },
  pool: platformCredentialPool,
  seats: orgStorage,
  sandboxClient: () => sessionManager.getSandboxClient(),
});
publicGuideService.start();

// Guests' own agents (note #1038): the visitor's sealed agent on a dedicated
// machine. Its Claude Code reaches the model only through the door below,
// which swaps a per-turn key for the seat token here, so the token never
// reaches a machine a stranger has a shell on.
const guestModelDoor = new GuestModelDoor();
const guestDoorUrl = AGENTBUILT_API_URL.startsWith('https://') ? `${AGENTBUILT_API_URL.replace(/\/+$/, '')}${GUEST_MODEL_DOOR_PATH}` : null;
const guestTurnstile = process.env.TURNSTILE_SECRET_KEY && process.env.TURNSTILE_SITE_KEY
  ? { secretKey: process.env.TURNSTILE_SECRET_KEY, siteKey: process.env.TURNSTILE_SITE_KEY }
  : null;
const guestAgentService = new GuestAgentService({
  storage: sqliteDb ? new SqliteGuestAgentStorage(sqliteDb) : new InMemoryGuestAgentStorage(),
  host: {
    createRecord: async (userId, orgId) => {
      const created = await agentService.startAgentCreationFromMiniApp(userId, 'claude', orgId, { awaitName: true, concurrent: true, sealed: GUEST_AGENT_KIND });
      if (!created.ok) return { error: created.reason };
      return created.agent ? { id: created.agent.id, name: created.agent.name } : { error: 'The record was not reserved in time.' };
    },
    agent: async (userId, agentId) => {
      const agent = await agentService.publicGuideAgent(userId, agentId);
      return agent?.sealed === GUEST_AGENT_KIND ? agent : null;
    },
    sandbox: (userId, agentId) => agentService.publicGuideSandbox(userId, agentId),
    source: (userId, agent) => agentService.publicGuideSource(userId, agent),
    deleteAgent: async (userId, agentId) => {
      const deleted = await agentService.deleteAgentFromMiniApp(userId, agentId);
      return deleted.ok || /already gone/i.test(deleted.reason);
    },
    guestAgentIds: (userId) => agentService.guestAgentIds(userId),
  },
  door: guestModelDoor,
  doorUrl: guestDoorUrl,
  pool: platformCredentialPool,
  seats: orgStorage,
  sandboxClient: () => sessionManager.getSandboxClient(),
  turnstile: guestTurnstile,
  idleStopMs: FLY_IDLE_STOP_MINUTES * 60_000,
  // A guest from one of the owner's Outreach letters names its company (note #1139).
  outreach: outreach
    ? {
      company: (userId, companyId) => outreach.company(userId, companyId),
      guestStarted: async (userId, companyId, guest) => { await outreach.guestStarted(userId, companyId, guest); },
      siteOrigin: OUTREACH_SITE_ORIGIN,
    }
    : null,
});
guestAgentService.start();
console.log(`[config] GUEST_AGENTS door=${guestDoorUrl ?? 'off (AGENTBUILT_API_URL is not https)'}, turnstile=${guestTurnstile ? 'on' : 'off'}`);

const deps: RouteDeps = {
  publicGuide: publicGuideService,
  ...(opsNotifier ? { opsNotifier } : {}),
  guestAgents: guestAgentService,
  ...(workspaceWebAuth && WORKSPACE_ORIGIN
    ? {
      workspaceWebAuth,
      workspaceWebOrigin: WORKSPACE_ORIGIN,
      workspaceWebCompatibleOrigins: WORKSPACE_COMPATIBLE_ORIGINS,
    }
    : {}),
  workspaceNotifications,
  opsBotService,
  ...(opsBotWebhookSecret ? { opsBotWebhookSecret } : {}),
  ...(sqliteDb ? { userRoster: async () => readUserRoster(sqliteDb) } : {}),
  userStorage,
  agentWorkLedger,
  agentTokenLedger,
  deploymentService,
  deploymentStorage,
  // The org spend view (byo-fly-design slice 6): the bill-payer's honest
  // inventory of every machine and volume in their Fly org.
  orgSpend: new OrgSpendService({
    orgFly: orgFlyService,
    ...(PRIVATE_COPY ? { privateCopy: true } : {}),
    userStorage,
    // The month's check runs, priced at the shape each was recorded with
    // (note #319): the org's repositories are found through its rooms.
    orgStorage,
    gitRepoStorage,
    gitCommitStatusStorage,
    // A site another workplace owns is counted, not listed (note #635).
    deploymentStorage,
  }),
  // Connect-your-cloud (slice 7): validate + store the client's Fly token,
  // and bring the per-org WireGuard tunnel up. The backend runs as root on
  // the control-plane host, so the tunnel exec is plain local argv.
  orgFly: orgFlyService,
  // Git namespace resolution (byo-git-design slice 1): org members share
  // their repos; admin-gated destruction rides the role in the answer.
  orgGit: orgGitService,
  // Per-org git hosts (slice 2b) + the org secrets their callbacks sign with.
  orgGitHost: orgGitHostService,
  orgSecrets,
  ...(orgCiService ? { orgCi: orgCiService } : {}),
  orgWireGuard: orgWireGuardService,
  // `agentbuilt deploy` and `agentbuilt upgrade` both land here: a site the
  // plan has room for is built (or resized) straight away, with no checkout
  // anywhere in the path.
  ...(hostingFulfilment ? { hostingFulfilment } : {}),
  gitRepoStorage,
  gitPullRequestStorage,
  gitCommitStatusStorage,
  knowledgeProposalStorage,
  knowledgePageCommentStorage,
  knowledgeShelf,
  quickNoteStorage,
  driveStorage,
  ...(radioStation ? { radio: radioStation } : {}),
  directMessageStorage,
  directMessageApprovals,
  // Owner, 2026-10-11: workplaces are for one person for now; nobody from
  // outside had invited anyone, and every untested door is a risk. The flag
  // is documented on RouteDeps; deleting this line reopens invites. A
  // workplace marked with scripts/allow-invites.mjs (note #805) has them open,
  // and so does every workplace of a private copy (note #808): a company's
  // own copy is many people by design, and invites are its only way in.
  invitesClosed: !PRIVATE_COPY,
  ...(PRIVATE_COPY ? { privateCopy: true } : {}),
  ...(SIGNUP_CLOSED ? { signupClosed: true } : {}),
  ...(PRIVATE_COPY && FIRST_ACCOUNT_CODE.length >= 16 ? { firstAccountCode: FIRST_ACCOUNT_CODE } : {}),
  ...(copyHealth ? { copyHealth } : {}),
  ...(copyPulses ? { copyPulses, copyReleaseList } : {}),
  ...(outreach && outreachPasses ? { outreach, outreachPasses, outreachSiteOrigin: OUTREACH_SITE_ORIGIN } : {}),
  ...(copyPulse ? { copyPulse } : {}),
  ...(copyUpgrade ? { copyUpgrade } : {}),
  ...(copyLicence ? { copyLicence } : {}),
  // Owner, 2026-10-11 (note #733): the Chief of Staff covers recaps now, so
  // a room no longer draws its briefing card. Documented on RouteDeps;
  // deleting this line brings the card back.
  mailboxes: mailboxService,
  orgHandles: orgHandleService,
  mailMessages: mailMessageStorage,
  ...(mailIngest ? { mailIngest } : {}),
  ...(copyMailSetup ? { copyMail: copyMailSetup } : {}),
  ...(MAIL_INGEST_SECRET ? { mailIngestSecret: MAIL_INGEST_SECRET } : {}),
  // Note attachments keep their bytes here; absent → notes are words-only.
  ...(mediaStorage ? { mediaStorage } : {}),
  // Workspace dictation, on each workplace's own OpenRouter key and model
  // (note #1026); reached only after the browser session is verified.
  workplaceVoice: new WorkplaceVoiceService({
    orgStorage,
    orgSecrets,
    openRouter: new OpenRouterAccountClient(),
    transcriber: new VoiceTranscriptionService(),
    pauseReasonFor: voicePauseReasonFor,
  }),
  // The knowledge gate's two halves, and they travel together: the ask that
  // reaches the owner, and the decision that lands or refuses.
  requestKnowledgeApproval: (args) => agentService.requestKnowledgeApproval(args),
  decideKnowledgeProposal: (args) => agentService.decideKnowledgeProposal(args),
  ...(gitHostClient ? { gitHostClient } : {}),
  ...(GIT_HOST_SECRET ? { gitHostSecret: GIT_HOST_SECRET } : {}),
  ...(CI_STATUS_SECRET ? { ciStatusSecret: CI_STATUS_SECRET } : {}),
  // Where a CI run's publish step points the CLI (`agentbuilt repo publish`).
  ...(AGENTBUILT_API_URL ? { agentbuiltApiUrl: AGENTBUILT_API_URL } : {}),
  // Reading is not writing: the store is always there, so the org screen can
  // report what a backup job last managed even on a backend with no ops bot
  // to alert. A job that has never reported reads as absent, not as fine.
  readBackupHeartbeat: (job: string) => {
    const beat = backupHeartbeatStore.get(job);
    if (!beat?.lastReportAt) return undefined;
    return { at: beat.lastReportAt, ok: beat.lastStatus !== 'fail' };
  },
  // Both or neither: a secret with nothing behind it would accept heartbeats
  // and drop them, which reads as "monitored" and is not.
  ...(BACKUP_HEARTBEAT_SECRET && backupMonitor
    ? {
        backupHeartbeatSecret: BACKUP_HEARTBEAT_SECRET,
        recordBackupHeartbeat: (job: string, status: 'ok' | 'fail', detail?: string) =>
          backupMonitor.record(job, status, detail),
      }
    : {}),
  // The agent asks; the USER taps. This is the only path that merges.
  requestPullRequestApproval: (args) => agentService.requestPullRequestApproval(args),
  // Auto-merge (note #944): the proposal owner's own switch merges.
  autoApprovePullRequest: (args) => agentService.autoApprovePullRequest(args),
  // Same shape for CI secrets: the tap is what hands a key to a repo's runs.
  tellOwnerCiSecretsGranted: (args) => agentService.tellOwnerCiSecretsGranted(args),
  tellOwnerKnowledgeChanged: (args) => agentService.tellOwnerKnowledgeChanged(args),
  tellOwnerPublishLinked: (args) => agentService.tellOwnerPublishLinked(args),
  notifyRepoDeleteDecision: (args) => agentService.notifyRepoDeleteDecision(args),
  notifySiteDeleteDecision: (args) => agentService.notifySiteDeleteDecision(args),
  notifyStorageDeleteDecision: (args) => agentService.notifyStorageDeleteDecision(args),
  ...(objectStorageService ? { objectStorage: objectStorageService } : {}),
  // The Workspace decision buttons run the same guarded merge flow.
  decidePullRequest: (args) => agentService.decidePullRequestFromMiniApp(args),
  // `agentbuilt chat new` — the agent's own new-chat, applied when its turn ends.
  requestChatReset: (args) => agentService.requestChatResetFromCli(args),
  // Backs `agentbuilt secret` — the same storage the Workspace add form and the
  // per-turn env export use, so every surface sees one cupboard.
  secretStorage,
  // The Workspace's org screens: members, seats, invites.
  orgStorage,
  // Home and the subscription screens fill a stale usage cache on load/focus.
  refreshSeatUsage: () => platformCredentialPool.refreshUsage(),
  // The seats screen's "Sign in a subscription" flow: the deterministic
  // ceremony driver (org-layer-design workstream 2). Sign-in is
  // Mini-App-only, so the landed seat is also what connects the member's
  // waiting agents — no chat step anywhere in the loop.
  seatSignIn: seatSignInFlow,
  // Agent lifecycle shared by the Workspace and the machine CLI —
  // create/delete ride the same chat paths, while peer messaging claims the
  // recipient's live runner slot and never queues a busy handoff.
  agentLifecycle: {
    createAgent: (userId, cli, orgId, options) => (
      agentService.startAgentCreationFromMiniApp(userId, cli, orgId, options)
    ),
    deleteAgent: (userId, agentId) => agentService.deleteAgentFromMiniApp(userId, agentId),
    suspendAgent: (userId, agentId) => agentService.suspendAgentForWorkplaceDeletion(userId, agentId),
    forgetAgent: (userId, agentId, opts) => agentService.forgetAgentOfDeletedWorkplace(userId, agentId, opts),
    connectAgentsForSeat: (userId, provider, orgId) => (
      agentService.connectTelegramAgentsForSeat(userId, provider, orgId)
    ),
    setUpPlannedAgents: (userId, orgId) => agentService.setUpPlannedAgents(userId, orgId),
    prepareWorkspaceAgent: (userId, orgId, cli) => agentService.prepareWorkspaceAgent(userId, orgId, cli),
    // The Workspace's per-agent version card — the surface that replaced the
    // agent chat keyboard's Version view.
    agentVersion: (userId, agentId) => agentService.buildAgentVersionInfoForMiniApp(userId, agentId),
    // The record-known half of that card for the whole fleet, so the state
    // payload seeds every agent's screen and the card opens already drawn.
    agentVersionSeeds: (userId, agents) => agentService
      .buildAgentVersionSeedsForMiniApp(userId, agents),
    isAgentWorking: (userId, agentId) => agentService.isAgentTurnRunning(userId, agentId),
    agentActivity: (userId, agentId) => agentService.getAgentTurnActivity(userId, agentId),
    isAgentPreparing: (userId, agentId) => agentService.isAgentMachinePreparing(userId, agentId),
    lastActiveAtMs: (userId, agentId) => agentService.getTelegramAgentLastActiveAt(userId, agentId),
    listPeers: (userId, senderAgentId) => agentService.listPeerAgentsForCli(userId, senderAgentId),
    endWorkspaceAgentTurn: (userId, orgId) => agentService.endWorkspaceAgentTurn(userId, orgId),
    messagePeer: (args) => agentService.messagePeerAgentFromCli(args),
    // A finished managed job starting its own agent's turn (note #532).
    deliverFinishedJobs: (args) => agentService.deliverFinishedJobsFromCli(args),
    listPendingPeerMessages: (userId, senderAgentId) => agentService.listPendingPeerMessages(userId, senderAgentId),
    cancelPendingPeerMessage: (userId, senderAgentId, id) => agentService.cancelPendingPeerMessage(userId, senderAgentId, id),
    messageAgentFromUser: (args) => agentService.messageAgentFromUser(args),
    // The Workspace chat screen (inhouse-chat-design, note #131): its send —
    // which steers a working agent instead of refusing it — and the
    // incremental read behind its transcript.
    chatMessageAgentFromUser: (args) => agentService.chatMessageAgentFromUser(args),
    converseWorkspaceRecap: (userId, orgId, prompt, settings, onPhase, options) => agentService.converseWorkspaceRecap(userId, orgId, prompt, settings, onPhase, options),
    summarizeWorkspaceRecap: (userId, orgId, prompt, settings) => agentService.summarizeWorkspaceRecap(userId, orgId, prompt, settings),
    workspaceAgentTurnEnded: (userId, orgId, turn) => agentService.workspaceAgentTurnEnded(userId, orgId, turn),
    workspaceSeatIdsInUse: (userId, orgId) => agentService.workspaceSeatIdsInUse(userId, orgId),
    onWorkspaceActivity: (listener) => agentService.onWorkspaceActivity(listener),
    agentChatMessages: (userId, agentId, afterSeq) => (
      agentService.getAgentChatMessages(userId, agentId, afterSeq)
    ),
    requestMailApproval: (args) => agentService.requestMailApprovalFromAgent(args),
    latestAgentChatMessage: (userId, agentId) => (
      agentService.getLatestAgentChatMessage(userId, agentId)
    ),
    latestAgentChatRow: (userId, agentId) => (
      agentService.getLatestChatRow(userId, agentId)
    ),
    // The same reply for the whole fleet, so the state payload seeds every
    // details screen's Last reply the way it already seeds the version card.
    agentChatReplySeeds: (userId, agents) => (
      agentService.buildAgentChatReplySeedsForMiniApp(userId, agents)
    ),
    agentChatLastFiles: (userId, agents) => (
      agentService.buildAgentChatLastFilesForMiniApp(userId, agents)
    ),
    listManagedJobs: (userId, agentId) => (
      agentService.listManagedJobs(userId, agentId)
    ),
    agentChatFileAccess: (userId, agentId, fileId, preview) => (
      agentService.getAgentChatFileAccess(userId, agentId, fileId, preview)
    ),
    agentChatFileText: (userId, agentId, fileId) => (
      agentService.getAgentChatFileText(userId, agentId, fileId)
    ),
    stopAgentTurn: (args) => agentService.stopAgentTurnFromWorkspace(args),
    recordAgentPlatformRow: (userId, agentId, text) => agentService.recordAgentPlatformRow(userId, agentId, text),
    updateAgentCli: (userId, agentId) => agentService.updateAgentCliFromMiniApp(userId, agentId),
    updateAgentMachine: (userId, agentId) => agentService.updateAgentMachineImageFromMiniApp(userId, agentId),
    agentMachine: (userId, agentId) => agentService.buildAgentMachineForMiniApp(userId, agentId),
    resizeAgentMachine: (userId, agentId, size) => agentService.resizeAgentMachineFromMiniApp(userId, agentId, size),
  },
};
// Mail out and its approvals are read at each request, never kept: in a
// private copy an admin turns email on while the Workspace runs (note #946).
Object.defineProperties(deps, {
  mailOutbox: { get: () => mailOutbox, enumerable: true, configurable: true },
  mailApprovals: { get: () => mailApprovals, enumerable: true, configurable: true },
});

// Deleting a whole workplace (owner, 2026-09-22): an admin's ask locks it and
// emails every member; this sweep deletes it for good once its three days are up.
// Org #0 is recognised by its Fly slug, as the reaper and the media router
// recognise it, and is refused.
const workplaceDeletion = new WorkplaceDeletionService(deps, {
  platformFlyOrgSlug: FLY_ORG,
  releaseMessagesMachine: (orgId) => orgMsgHostService.releaseHostedMachine(orgId),
  ...(WORKSPACE_URL ? { workspaceUrl: WORKSPACE_URL } : {}),
  notices: {
    from: WORKSPACE_EMAIL_FROM,
    ...(mailIngest ? { deliverToInbox: (args: { to: string; from: string; raw: Buffer }) => mailIngest.accept(args) } : {}),
    // Read when each notice goes: a copy's admin may have turned mail on
    // since (note #946). Until then a notice reaches the person's inbox here
    // and their screen, and the outside copy is skipped, said in the log.
    ...(workspaceVerificationEmail
      ? {
        sendOutside: async (message: Parameters<NonNullable<WorkspaceVerificationEmailSender['sendNotice']>>[0]) => {
          if (!liveVerificationEmail?.sendNotice) {
            console.log('[workplace-deletion] outside notice not sent: email is not set up in this Workspace yet');
            return;
          }
          await liveVerificationEmail.sendNotice(message);
        },
      }
      : {}),
  },
});
deps.workplaceDeletion = workplaceDeletion;
const runWorkplaceDeletionSweep = () => {
  void workplaceDeletion.sweep().catch((error) => console.warn('[workplace-deletion] sweep failed:', error));
};
setInterval(runWorkplaceDeletionSweep, WORKPLACE_DELETION_SWEEP_MS).unref();
// Working time (note #644): every running turn is credited with the minute
// that passed, so a turn cut off by a restart or a Stop loses at most one.
setInterval(() => { void agentService.tickAgentWorkMeter(); }, 60_000).unref();
setTimeout(runWorkplaceDeletionSweep, 2 * 60_000).unref();

// ── Middleware ──

// Before everything, and before CORS: a request arriving on a renamed site's
// OLD address is not an API call at all, it is someone opening a link that was
// shared before the site moved. It gets a 301 to wherever the site lives now.
// Only the former names of sites renamed before 2026-10-16 still reach this
// host (their CNAMEs point here); since then the preview-router Worker serves
// the 301 itself from the name map, and a rename writes no record. Scoped by
// hostname, so nothing addressed to this backend's own host can match. (Both handlers are cheap record reads; only requests whose Host ends
// in the apps domain reach storage at all.)
if (APPS_DOMAIN && deps.deploymentStorage) {
  const redirectOpts = { storage: deps.deploymentStorage, appsDomain: APPS_DOMAIN };
  // Caddy's on-demand TLS gate — it asks before issuing a certificate for a
  // hostname it has never seen. Answered on this host's own name, so it is
  // reachable at http://localhost:3001 regardless of which site is being asked
  // about, and it is the only thing standing between us and minting
  // certificates for anyone who points a DNS record here.
  app.get('/internal/site-tls-ask', siteTlsAskHandler(redirectOpts));
  app.use(siteRedirectHandler(redirectOpts));
}

// The Outreach site (note #1093), and only it, may call the Outreach routes
// across origins; answered before the platform's own CORS layer.
if (outreach) app.use('/workspace/api/outreach', outreachSiteCors(OUTREACH_SITE_ORIGIN));
app.use(cors(createCorsOptions(CORS_ORIGINS)));
// A knowledge proposal carries whole HTML pages, which the default 100 KB JSON
// limit refuses. Mounted BEFORE the global parser and scoped to that one path:
// body-parser marks a request it has already read, so the general parser below
// no-ops on it and every other route keeps the smaller ceiling.
app.use('/api/agent-cli/knowledge', express.json({ limit: '8mb' }));
// A batch of finished-job receipts (note #532) carries up to twenty commands
// and output tails — bounded on the machine and again on the route, but close
// enough to the default 100 KB that a full fan-out could trip it. A 413 is a
// 4xx, and a 4xx is what tells a machine to retire a receipt for good, so the
// ceiling that must never be reached is raised here rather than risked.
app.use('/api/agent-cli/jobs', express.json({ limit: '1mb' }));
// A quick note holds QUICK_NOTE_MAX_LENGTH (100,000) characters since note
// #676 — a whole plan, not a jotting — and JSON escaping plus multi-byte
// letters put such a body past the default 100 KB. Both doors a note comes in
// by, the agent CLI's and the Workspace's own, get the wider parser; the
// route's own length check is still the one that refuses, in words.
app.use('/api/agent-cli/notes', express.json({ limit: '1mb' }));
// A batch of outreach companies with their profiles (note #1103) is ~100 kB today.
app.use('/api/agent-cli/outreach', express.json({ limit: '2mb' }));
app.use('/workspace/api/notes', express.json({ limit: '1mb' }));
// The org-CI webhook and job result are HMAC-verified over the RAW body, so
// they must reach their routes as bytes. Same trick as the knowledge mount:
// a scoped parser before the global one — body-parser marks a request it has
// read, so the json parser below no-ops on these two.
// One inbound message arrives as the bytes the sender sent — not JSON, and
// not something to re-encode on the way in. Cloudflare Email Routing refuses
// anything over 25 MiB before we see it; the ceiling here is that plus the
// envelope headers' worth of slack.
app.use('/api/webhooks/mail/inbound', express.raw({ type: () => true, limit: '26mb' }));
// A copy's pulse is signed over its exact bytes (note #1057): read it raw.
app.use('/api/copy-pulse', express.raw({ type: () => true, limit: '64kb' }));
// The mail provider's word on the Outreach letters (note #1112) is signed over its exact bytes: read it raw.
app.use(RESEND_WEBHOOK_PATH, express.raw({ type: () => true, limit: '256kb' }));
app.use('/api/agent-cli/git/ci-webhook', express.raw({ type: () => true, limit: '256kb' }));
app.use('/api/agent-cli/git/ci-result', express.raw({ type: () => true, limit: '256kb' }));
// The guests' model door (note #1038): the body passes byte for byte, so it is parsed raw, before JSON.
// Its jobs door (note #1063): a guest's \`agentbuilt job start\` registers a background job with the
// running turn's per-turn key. Mounted first, so the model door never sees these paths.
app.use(`${GUEST_MODEL_DOOR_PATH}/jobs`, express.json({ limit: '128kb' }), (req, res) => { void guestAgentService.handleJobsDoor(req, res); });
app.use(GUEST_MODEL_DOOR_PATH, express.raw({ type: () => true, limit: '32mb' }), (req, res) => { void guestModelDoor.handle(req, res); });
app.use(express.json());

// ── Routes ──

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Where a `<name>.agentbuilt.app` name goes — an agent's machine, a site's
// app, or a renamed site's new address — asked by the preview-router Worker
// (infra/preview-router) for every name it has not cached. Replaced the
// one-TXT-record-per-agent mapping (2026-10-13) and the one-CNAME-per-site
// records (2026-10-16), both of which the zone's 200-record ceiling would
// have run out of.
if (previewDomainService) {
  app.get('/api/preview-map/:slug', previewMapHandler(previewDomainService));
}

/**
 * The fleet's pinned harness-CLI versions, read-only.
 *
 * Exists for the machine-image build. The image BAKES the CLIs, and it used to
 * bake `latest` — which handed version control to the npm registry and left the
 * pre-sleep updater to drag machines back to the pin afterwards, for the one CLI
 * the agent happened to use. Two owners of one number. The build now asks for
 * the pin, so the database stays the only place a version is chosen.
 *
 * The CI runner has no database access; it reaches this over the SSH path it
 * already uses to call `set-machine-image`, as `curl localhost:PORT` on the
 * backend host. Unauthenticated on purpose and safe to be: three published npm
 * version numbers, no user data, no way to write.
 */
/**
 * The fleet's CLI pin, published for private copies to follow (note #1052).
 *
 * The same three numbers as above, but a public contract with its own name:
 * cacheable for five minutes and served from the updater's 60 s cache, so a
 * crowd of copies asking costs nothing — and the image build keeps its own
 * uncached endpoint, which is what closed the cache trap. Unsigned: three
 * published npm version numbers, nothing secret, and a copy only ever writes
 * them as exact versions after the same validation the script applies. A
 * partial pin is published as is; a copy adopts only a pin for every CLI.
 */
// Where private copies' daily pulses arrive (note #1057): signed, checked,
// kept as the copy's latest and its day's row for the Copies screen.
if (copyPulses && copyPulseKeys) {
  app.post('/api/copy-pulse', copyPulseHandler({
    store: copyPulses,
    keys: copyPulseKeys,
    onPulse: (pulse) => {
      deps.copyAlerts?.nudge();
      // Outreach (note #1089): a target company's own copy reporting in is an install.
      void outreach?.notePulse(pulse).catch((error) => {
        console.warn('[outreach] a pulse could not be matched:', error instanceof Error ? error.message : error);
      });
    },
  }));
}

app.get('/api/cli-pins', async (_req, res) => {
  try {
    const { claude, codex, opencode } = await harnessCliVersionService.getPinnedVersions();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ claude: claude ?? null, codex: codex ?? null, opencode: opencode ?? null });
  } catch (error) {
    console.warn('[cli-pins] read failed:', error);
    res.status(503).json({ error: 'pinned versions unavailable' });
  }
});

app.get('/api/harness-cli-versions', async (_req, res) => {
  try {
    // `{}` covers BOTH "no pin configured" and "the read failed" — the service
    // swallows its own errors by design. The build cannot tell them apart and
    // does not need to: it refuses to bake anything it was not given a valid
    // version for, so either way an image never ships on a guess. The catch
    // below is only for an unexpected throw, which would otherwise surface as
    // an unhandled rejection rather than a failed request.
    // Uncached: this endpoint has ONE caller, the image build, and it asks
    // immediately after a pin bump writes — inside the cache window the other
    // readers live on. See getPinnedVersionsUncached().
    res.json(await harnessCliVersionService.getPinnedVersionsUncached());
  } catch (error) {
    console.warn('[harness-cli-versions] read failed:', error);
    res.status(503).json({ error: 'pinned versions unavailable' });
  }
});

app.use('/api/webhooks', webhookRoutes(deps));
// The `agentbuilt` CLI on agent machines: production deploys, status, logs.
app.use('/api/agent-cli', agentCliRoutes(deps));
// The browser Workspace.
const workspaceRouter = workspaceRoutes(deps);
app.use('/workspace', workspaceRouter);
// The outreach letters' short links, /go/<code> (note #1106): before the
// root routes, so the word is ours and never a person's address.
app.use(outreachLinkRoutes(() => outreach));
// Delivered, bounced, spam, pictures loaded: Resend's signed events on the Outreach letters (note #1112).
app.use(outreachMailEventRoutes({ outreach: () => outreach, secret: () => RESEND_WEBHOOK_SECRET }));
// Its addresses live at the root of the domain (public-addresses): the shell
// is served there, and every old /workspace address redirects to it.
app.use(workspaceRootRoutes({
  workspaceUiDir: deps.workspaceUiDir,
  ...(PRIVATE_COPY ? { brandFilesDir: DEFAULT_BRAND_FILES_DIR } : {}),
  publicRepoAddress: async (publicId) => {
    const repo = await gitRepoStorage.getPublicById(publicId);
    const org = repo?.orgId ? await orgStorage.getOrg(repo.orgId) : null;
    return org?.handle ? workspaceRoutePath({ kind: 'workplaceRepo', handle: org.handle, repo: repo!.name }) : null;
  },
}));
// The ops bot's Mini App: the roster as a table, for the operator alone.
app.use('/ops', opsMiniAppRoutes({
  opsBotToken: TELEGRAM_OPS_BOT_TOKEN,
  opsChatId: TELEGRAM_OPS_CHAT_ID,
  ...(sqliteDb ? { roster: async () => readUserRoster(sqliteDb) } : {}),
  findUserByTelegramUserId: (id) => userStorage.findUserByTelegramUserId(id),
}));

// ── Server ──

const server = createServer(app);
// In production systemd owns the listener and keeps it open across service
// restarts. Local/dev/test launches receive no activation environment and keep
// listening on PORT exactly as before.
const systemdListenFd = consumeSystemdListenFd();

// ── Startup ──

// Last-resort safety net: keep the server alive on unexpected errors instead of
// exiting. A single background failure (e.g. a transient storage error from a
// worker tick) must not crash the instance and trigger
// a restart loop. Individual operations still catch and handle their own errors;
// these only fire for paths that slipped through.
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection (keeping process alive):', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[Process] Uncaught exception (keeping process alive):', error);
});

// Do not accept work until every pending agent turn has claimed
// its BackgroundRunner slot. Otherwise an inbound message can launch a fresh
// CLI during async route resolution, beside a detached PID awaiting recovery.
// The claims are local and take milliseconds; the re-attaches they start are
// NOT waited for here (note #762) — a machine that never answers must not
// hold the health check, and the quarantine makes opening early safe.
// The Workspace Agent's conversations, after the room agents' turns (note
// #455): a request its restart cut short is named and picked up again now,
// not when its owner next opens the screen.
// Note #1109: every messaging machine always on — moved onto the rule and
// started if down, half a minute after boot so it never slows the start.
if (sqliteDb) {
  setTimeout(() => {
    void orgStorage.listOrgs()
      .then((orgs) => orgMsgHostService.convergeAll(orgs.filter((org) => org.messages?.host).map((org) => org.orgId)))
      .catch((error) => console.warn('[org-msg-host] keep-on sweep failed:', error instanceof Error ? error.message : error));
  }, 30_000).unref();
}
void agentRecoveryReady.then(() => deps.workspaceAgent?.resumeInterrupted?.()).catch((error) => {
  console.error('[workspace-agent] Recovering interrupted requests failed:', error);
});
// Event turns (note #716), once those recovered turns are under way: the
// sweep's first pass waits a few minutes more on its own.
void agentRecoveryReady.then(() => deps.workspaceAgentEvents?.start()).catch((error) => {
  console.error('[workspace-agent-events] could not start the sweep:', error);
});
// The private copies' alerts (note #1058), once the conversations are back.
void agentRecoveryReady.then(() => deps.copyAlerts?.start()).catch((error) => {
  console.error('[copy-alerts] could not start the sweep:', error);
});
// Schedules (note #779): the sweep that ticks approved schedules. Every
// tick is a quiet platform turn of a room agent; the owner hears only when
// a schedule stops itself (cap, failures, subscription), as a row in the
// agent's chat and one quiet event turn of the Chief of Staff.
agentSchedules = new AgentScheduleService({
  storage: sqliteDb ? new SqliteAgentScheduleStorage(sqliteDb) : new InMemoryAgentScheduleStorage(),
  getAgent: async (userId, agentId) => (await userStorage.getProfile(userId))?.telegram?.agents?.[agentId] ?? null,
  listAgents: async (userId) => Object.values((await userStorage.getProfile(userId))?.telegram?.agents ?? {}),
  isAgentWorking: (userId, agentId) => agentService.isAgentTurnRunning(userId, agentId),
  contextPercent: (agent) => scheduleContextUsage(agent.contextUsage)?.usedPercent ?? null,
  startScheduledTurn: (args) => agentService.startScheduledTurn(args),
  resetChat: async (args) => {
    const result = await agentService.requestChatResetFromCli(args);
    return { ok: result.ok };
  },
  // The subscription the agent's turns run on FIRST — its pin, else the
  // member's primary for that provider — and nothing behind it: a
  // scheduled turn must not hop to the next subscription (note #773 is the
  // right rule for a person's agents and the wrong one for an unattended
  // loop). Unknown when no seat is on record (a pool-backed account).
  subscriptionHasRoom: async (userId, agent) => {
    if (!isHarnessCli(agent.cli) || !agent.orgId) return null;
    const seats = (await orgStorage.listSeatsByMember(agent.orgId, userId)).filter((seat) => seat.provider === agent.cli);
    if (seats.length === 0) return null;
    const chosen = (agent.seatId ? seats.find((seat) => seat.seatId === agent.seatId) : undefined) ?? seats.find((seat) => seat.selected) ?? seats[0]!;
    return isLeasable(seatToCredentialDoc(chosen), new Date().toISOString(), scheduleEffectiveModel(agent.cli, agent.model));
  },
  tokensSpent: (userId, agentId) => {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    return agentTokenLedger.userAgentDays(userId, since)
      .filter((row) => row.agentId === agentId)
      .reduce((sum, row) => sum + row.input + row.output + row.cacheRead + row.cacheWrite + row.reasoning, 0);
  },
  latestChatRow: (userId, agentId) => agentService.getLatestChatRow(userId, agentId),
  tellOwner: async ({ userId, orgId, agentId, text, event }) => {
    await agentService.recordAgentPlatformRow(userId, agentId, text);
    await deps.workspaceAgentEvents?.scheduleEvent(userId, orgId, event);
  },
  recordRow: async ({ userId, agentId, text }) => { await agentService.recordAgentPlatformRow(userId, agentId, text); },
  notifyAgent: (args) => agentService.notifyScheduleDecision(args),
});
deps.agentSchedules = agentSchedules;
{
  const schedules = agentSchedules;
  void agentRecoveryReady.then(() => schedules.start()).catch((error) => {
    console.error('[schedules] could not start the sweep:', error);
  });
}
void Promise.all([agentRecoveryReady, roomsGoneReady]).then(() => {
  const onListening = async () => {
    console.log(systemdListenFd === undefined
      ? `Server running on http://localhost:${PORT}`
      : `Server running on inherited systemd socket (fd ${systemdListenFd})`);

    // The ops bot listens only once Telegram knows where to deliver. Failure is
    // logged, never thrown: a bot that cannot take commands must not stop a
    // backend that is serving turns.
    if (opsBotService) {
      try {
        const { configured, menu } = await opsBotService.syncWebhook();
        // Without the URL nothing is sent to Telegram at all, so whatever it
        // last had stays — commands may well still arrive on an old
        // registration, and the "/" menu stays as stale as it was.
        console.log(
          !configured
            ? '[ops-bot] TELEGRAM_OPS_WEBHOOK_URL is not set; webhook and / menu left as Telegram last had them'
            : menu
              ? '[ops-bot] Webhook synced; / menu published'
              : '[ops-bot] Webhook synced; / menu NOT published (see the warning above)',
        );
        // The secret is what keeps a stranger from posting a forged update to
        // /telegram-ops. Lost once in a host move, and nothing said so.
        if (!opsBotWebhookSecret) {
          console.warn('[ops-bot] TELEGRAM_OPS_WEBHOOK_SECRET is not set; /telegram-ops accepts unsigned updates');
        }
      } catch (error) {
        console.error('[ops-bot] Failed to sync webhook:', error);
      }
    } else {
      console.log('[config] OPS_BOT=disabled (set TELEGRAM_OPS_BOT_TOKEN + TELEGRAM_OPS_CHAT_ID)');
    }
  };

  if (systemdListenFd === undefined) server.listen(PORT, onListening);
  else server.listen({ fd: systemdListenFd }, onListening);
}).catch((error) => {
  // Fail closed: opening webhooks when the pending-turn checkpoints could not
  // even be LISTED could let a fresh message launch beside an unquarantined
  // detached CLI. The process stays unhealthy so the supervisor can retry
  // startup safely. (One turn's own failure no longer reaches here: it is
  // logged, its owner told, and the others go on — note #762.)
  console.error('[startup] HTTP listener withheld because turn recovery failed:', error);
});

// ── Graceful Shutdown ──

let shutdownStarted = false;

async function gracefulShutdown(signal: string) {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  console.log(`[shutdown] Received ${signal}, shutting down gracefully`);
  // Stop accepting new work BEFORE the one-and-only in-memory snapshot. Any
  // in-flight webhook that reaches a runner intake method now fails for retry
  // instead of launching an uncheckpointed CLI after this boundary.
  backgroundRunner.beginShutdown();
  const serverClosed = new Promise<void>((resolve) => {
    server.close(() => {
      console.log('[shutdown] HTTP server closed');
      resolve();
    });
  });
  // A request mid-handler holds server.close() open indefinitely. Give it a
  // bounded chance to finish, then cut what is left so the restart stays a
  // couple of seconds instead of waiting out the hard-exit timer.
  const drainTimer = setTimeout(() => {
    server.getConnections((error, count) => {
      const open = error ? 'unknown' : String(count);
      console.warn(`[shutdown] ${open} connection(s) still open after ${SHUTDOWN_DRAIN_MS}ms; closing them`);
      server.closeAllConnections();
    });
  }, SHUTDOWN_DRAIN_MS);
  drainTimer.unref();
  // Detached harness turns must SURVIVE this shutdown: the flag flips the
  // meaning of the abort signal inside the harnesses from "user cancelled"
  // (kill the remote process group) to "backend restarting" (leave the CLI
  // running; the checkpoint below carries the attach info for re-attach).
  markHarnessShutdown();

  // Snapshot BEFORE interrupting: the abort path clears the queues and the
  // in-flight message exists only in the runner's memory. Persisting the
  // snapshots lets the next boot resume these turns (resumePendingTurns)
  // instead of silently dropping whatever users had in flight.
  const shutdownSnapshots = backgroundRunner.collectShutdownSnapshots();
  const interruptedSessionIds = backgroundRunner.interruptAllAgents(PROCESS_SHUTDOWN_ABORT_REASON);
  if (interruptedSessionIds.length > 0) {
    console.log(`[shutdown] Interrupted ${interruptedSessionIds.length} running agent loop(s)`);
  }
  // Persistence below retries transient storage failures because exiting
  // cleanly with an untracked detached CLI is unsafe. This timer is the
  // bounded last resort and must cover checkpointing itself, not just loop
  // completion after checkpointing.
  const hardExitTimer = setTimeout(() => process.exit(1), SHUTDOWN_HARD_EXIT_MS);
  hardExitTimer.unref();
  const persistableSnapshots = shutdownSnapshots.filter((snapshot) => snapshot.persistShutdownTurn);
  if (persistableSnapshots.length > 0) {
    const persisted = await Promise.allSettled(persistableSnapshots.map(
      (snapshot) => snapshot.persistShutdownTurn!(snapshot.payloads, {
        includeActiveTurn: snapshot.includeActiveTurn,
        terminateOnly: snapshot.terminateOnly,
        ...(snapshot.knownDetachedTurn ? { knownDetachedTurn: snapshot.knownDetachedTurn } : {}),
      }),
    ));
    const failures = persisted.filter((result) => result.status === 'rejected');
    console.log(
      `[shutdown] Checkpointed ${persistableSnapshots.length - failures.length}/${persistableSnapshots.length} in-flight turn(s) for resume`,
    );
    for (const failure of failures) {
      console.error('[shutdown] Failed to checkpoint an in-flight turn:', (failure as PromiseRejectedResult).reason);
    }
  }

  await Promise.allSettled([
    serverClosed,
    backgroundRunner.waitForAllCompletions(interruptedSessionIds),
  ]);

  clearTimeout(hardExitTimer);
  clearTimeout(drainTimer);
  if (backgroundRunner.getRunningCount() > 0) {
    console.warn(`[shutdown] Exiting with ${backgroundRunner.getRunningCount()} agent loop(s) still running`);
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
