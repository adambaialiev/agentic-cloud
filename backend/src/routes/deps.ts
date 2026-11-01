import type { CopyMailSetup } from '../services/copy-mail-setup.js';
import type { CopyHealth } from '../services/copy-health.js';
import type { AgentChatUpload } from '../services/agent-chat-storage.js';
import type { CopyLicence } from '../services/copy-licence.js';
import type { WorkspaceChatFile, WorkspaceChatFileTextAnswer, WorkspaceManagedJob, WorkspaceSettledJob } from '../shared/workspace-api.js';
import type { DirectMessageStorage } from '../services/direct-message-storage.js';
import type { FinishedJobReceipt } from '../types/job-receipt.js';
import type { MailboxService } from '../services/mailbox-service.js';
import type { MailIngestService } from '../services/mail-ingest.js';
import type { MailOutboxService } from '../services/mail-outbox.js';
import type { MailApprovalService } from '../services/mail-approval.js';
import type { MailMessageStorage } from '../services/mail-message-storage.js';
import type { MailRemoteImageOutcome } from '../services/mail-remote-image.js';
import type { OpsBotService } from '../services/ops-bot-service.js';
import type { RosterPerson } from '../services/sqlite/sqlite-user-roster.js';
import type { UserStorage } from '../services/user-storage.js';
import type { AgentWorkLedger } from '../services/agent-work-ledger.js';
import type { AgentTokenLedger } from '../services/agent-token-ledger.js';
import type { DeploymentService } from '../services/deployment-service.js';
import type { DeploymentStorage } from '../services/deployment-storage.js';
import type { ObjectStorageService } from '../services/object-storage.js';
import type { WorkplaceDeletionService } from '../services/workplace-deletion.js';
import type { OrgSpendService } from '../services/org-spend.js';
import type { OrgFlyService } from '../services/org-fly.js';
import type { OrgGitService } from '../services/org-git.js';
import type { OrgGitHostService } from '../services/org-git-host.js';
import type { OrgCiService } from '../services/org-ci.js';
import type { OrgSecretsService } from '../services/org-secrets.js';
import type { OrgWireGuardService } from '../services/org-wireguard.js';
import type { SiteFavicons } from '../services/site-favicon.js';
import type { HostingFulfilment } from '../services/hosting-fulfilment.js';
import type { DriveStorage } from '../services/drive-storage.js';
import type { MediaStorage } from '../services/media-storage.js';
import type { GitRepoStorage } from '../services/git-repo-storage.js';
import type { GitHostClient } from '../services/git-host-client.js';
import type { GitPullRequestStorage } from '../services/git-pr-storage.js';
import type { KnowledgePageCommentStorage } from '../services/knowledge-page-comments.js';
import type { KnowledgeShelfResolver } from '../services/knowledge-service.js';
import type { KnowledgeProposalStorage } from '../services/knowledge-storage.js';
import type { KnowledgeProposalStatus } from '../types/knowledge.js';
import type { QuickNoteStorage } from '../services/quick-note-storage.js';
import type { GitCommitStatusStorage } from '../services/git-commit-status-storage.js';
import type { GitPullRequestStatus } from '../types/git-pr.js';
import type { AgentRecord } from '../types/user.js';
import type { SecretStorage } from '../services/secret-storage.js';
import type { OrgStorage } from '../services/org-storage.js';
import type { OrgHandleService } from '../services/org-handles.js';
import type { OrgSeatSignInFlow } from '../services/org-seat-signin-flow.js';
import type { VoiceTranscriptionService } from '../services/voice-transcription-service.js';
import type { WorkspaceWebAuthService } from '../services/workspace-web-auth.js';
import type { WorkspaceNotificationService } from '../services/workspace-notifications.js';
import type { RadioStation } from '../services/radio-station.js';
import type {
  AgentPeerMessageResult,
  WorkspaceAgentRemoveAskResult,
  WorkspaceAgentResetResult,
  WorkspaceAgentRuntimeResult,
  PendingPeerMessageSummary,
  WorkspaceAgentStopResult,
  TelegramAgentPeerRoster,
  TelegramAgentMachineInfo,
  TelegramAgentVersionInfo,
  TelegramAgentVersionSeed,
} from '../services/agent-service.js';

/**
 * Dependencies for the HTTP routes: the webhooks (the original surface) and
 * the /api/agent-cli routes the `agentbuilt` CLI on agent machines calls.
 */
/** One agent-side change the Home overview should fold in. */
export interface WorkspaceActivityEvent {
  userId: string;
  agentId: string;
  kind: 'turn-started' | 'turn-ended' | 'recap-written';
}

export interface RouteDeps {
  /**
   * The Workspace Agent's conversation, reached from the agent CLI routes:
   * when the owner's private assistant acts through `agentbuilt` (a note
   * written, an agent messaged), the route that served it leaves the receipt
   * on the conversation where the person is reading. Set by the Workspace
   * router, which owns the conversation; absent until it has mounted.
   */
  workspaceAgent?: WorkspaceAgentHooks;
  /**
   * Registered by the Workspace router (note #144): found a workplace —
   * rooms, agents, the Workspace Agent's first words — once its cloud, a
   * subscription and a name are all in. The seat sign-in flow calls it when
   * a subscription lands; the router calls it from the other two writes.
   */
  workplaceFounding?: { foundIfReady(userId: string, orgId: string): Promise<void> };
  /**
   * Browser login for the Workspace. Absent (notably when the encryption key
   * is missing) means authenticated Workspace routes fail closed.
   */
  workspaceWebAuth?: WorkspaceWebAuthService;
  /** Canonical public origin used for links, login CSRF checks and secure cookies. */
  workspaceWebOrigin?: string;
  /**
   * Previous or proxy-fronting origins that may submit the same protected
   * Workspace forms during a domain transition. They never become link
   * targets; `workspaceWebOrigin` remains the one canonical address.
   */
  workspaceWebCompatibleOrigins?: string[];
  /** Durable web inbox plus optional standards-based Web Push delivery. */
  workspaceNotifications?: WorkspaceNotificationService;
  /**
   * The React Workspace shell's build directory (routes/workspace-ui.ts).
   * Defaults to backend/dist/workspace-ui; tests point it at a fixture.
   */
  workspaceUiDir?: string;
  /**
   * The ops bot's inbound half (@ACCOps_bot /users, /fleet). Absent without
   * TELEGRAM_OPS_BOT_TOKEN + TELEGRAM_OPS_CHAT_ID — the route 503s, which is
   * the same shape as the backup monitor's absence.
   */
  opsBotService?: OpsBotService;
  /**
   * Everyone and how far each got — `readUserRoster` on the backend's own
   * handle, the facts list-users.mjs and the ops bot show. Read by
   * `agentbuilt signups`, for the platform admin's agents alone.
   */
  userRoster?: () => Promise<RosterPerson[]>;
  /** Telegram's `secret_token` for the ops webhook, when one was set. */
  opsBotWebhookSecret?: string;
  /** Backs agent-CLI token verification (the hash lives on the agent record). */
  userStorage?: UserStorage;
  /** How long each agent has worked, for life (note #644). Absent → totals read as zero. */
  agentWorkLedger?: AgentWorkLedger;
  /** The tokens each agent turn spent, read by its owner only. Absent → no usage to show. */
  agentTokenLedger?: AgentTokenLedger;
  /** Absent when Fly or the app-runtime image is unconfigured; agent-cli routes 503. */
  deploymentService?: DeploymentService;
  deploymentStorage?: DeploymentStorage;
  /** Object storage for agents and sites (note #768). Absent → `agentbuilt storage` 503s. */
  objectStorage?: ObjectStorageService;
  orgSpend?: OrgSpendService;
  orgFly?: OrgFlyService;
  orgWireGuard?: OrgWireGuardService;
  /**
   * Deleting a whole workplace (2026-09-22): the lock, the three days and the purge.
   * Absent → the routes build one over these same deps, without notices and
   * without the org #0 guard's slug (so tests need no wiring).
   */
  workplaceDeletion?: WorkplaceDeletionService;
  /** Git namespace resolution (byo-git-design slice 1). Absent → every
   *  namespace is the caller's own userId, the pre-org behavior. */
  orgGit?: OrgGitService;
  /** Per-org git hosts (slice 2b): resolves which host an org's repos live
   *  on, and provisions one in a client org's own Fly account on first use.
   *  Absent → every repo lives on the central host. */
  orgGitHost?: OrgGitHostService;
  /** Org secrets, for callbacks signed by a per-org host's own secret. */
  orgSecrets?: OrgSecretsService;
  /** CI in the client's org (slice 5): webhook → machine in their account. */
  orgCi?: OrgCiService;
  /**
   * The Sites rows' favicons. Production needs no wiring — the Workspace router
   * makes its own — so this exists to hand tests a cache with a stubbed fetch,
   * because the alternative is a unit test that goes out to the internet.
   */
  siteFavicons?: SiteFavicons;
  /**
   * Builds and resizes hosted sites in the background, and tells the user when
   * one is live. A deploy of a site the plan has room for goes straight here —
   * there is no checkout in the path any more. Absent → the deploy is recorded
   * and staged, and the reply says an operator has to look.
   */
  hostingFulfilment?: Pick<HostingFulfilment, 'startBringUp' | 'startResize'>;
  /**
   * Where note attachments (and nothing else on these routes) keep their
   * bytes — the same S3 store chat attachments ride. Absent → the attach
   * routes 503 and notes are words-only, which is what they always were.
   */
  mediaStorage?: MediaStorage;
  /**
   * Turns a short recording from any Workspace prose field into text. The
   * shared transcription service keeps the Workspace independent of uneven
   * browser SpeechRecognition implementations. Absent →
   * the authenticated endpoint reports that dictation is unavailable.
   */
  voiceTranscriptionService?: Pick<VoiceTranscriptionService, 'transcribe'>;
  /** Internal git repos (docs/agent-git-phase1.md). Absent → those routes 503. */
  gitRepoStorage?: GitRepoStorage;
  gitHostClient?: GitHostClient;
  /**
   * Shared secret the git host presents when it calls back to verify an
   * agent's token mid-push. Absent → the verify route 503s, which fails every
   * push closed rather than open.
   */
  gitHostSecret?: string;
  gitPullRequestStorage?: GitPullRequestStorage;
  /**
   * Knowledge pages (docs/agent-knowledge-pages.md). The pages themselves live
   * on the git host beside the repos; this holds the proposals waiting on the
   * owner. Absent → the knowledge routes 503.
   */
  knowledgeProposalStorage?: KnowledgeProposalStorage;
  /**
   * The Chief of Staff's event sweep (note #716), built by the Workspace
   * router beside the conversation it hands events to. index.ts starts it and
   * routes arrivals to it; the CLI router nudges it when a check lands.
   */
  workspaceAgentEvents?: import('../services/workspace-agent-events.js').WorkspaceAgentEventSweep;
  /**
   * Schedules (note #779): wake an agent on a heartbeat, with a cap. Built
   * in index.ts beside the sweep that ticks them; the CLI router proposes,
   * lists, pauses and resumes, the Workspace router decides and pauses.
   */
  agentSchedules?: import('../services/agent-schedules.js').AgentScheduleService;
  /**
   * The margin under a knowledge PAGE (note #66). Beside the base rather than
   * in it — a remark is not part of the reviewed document. Absent → pages
   * simply have no comments, and the comment routes 503.
   */
  knowledgePageCommentStorage?: KnowledgePageCommentStorage;
  /**
   * Which namespace's knowledge base a caller standing in a namespace reads
   * and writes (note #566): the workplace's one shelf for every room of a
   * merged workplace. Handed to every `KnowledgeService`. Absent → each
   * namespace is its own shelf, the pre-workplace behaviour tests rely on.
   */
  knowledgeShelf?: KnowledgeShelfResolver;
  /**
   * Puts a knowledge proposal in front of the owner — the page RENDERED, not
   * its source. Returns whether the ask was delivered. Like every other ask
   * here, the agent can only request: nothing agent-facing lands a page.
   */
  requestKnowledgeApproval?: (args: {
    userId: string;
    agentId: string;
    proposalId: string;
  }) => Promise<boolean>;
  /**
   * Quick notes (docs/agent-quick-notes.md): one short HTML fragment an agent
   * writes straight into the account, with no git host behind it and no
   * approval in front of it. Absent → the note routes 503 and the Workspace
   * section is simply not there.
   */
  quickNoteStorage?: QuickNoteStorage;
  driveStorage?: DriveStorage;
  /** The work radio (note #712): one station for the platform. Absent (as it
   *  is unless WORK_RADIO=on, note #842) → its routes 404 and the Workspace
   *  shows no play button. */
  radio?: RadioStation;
  directMessageStorage?: DirectMessageStorage;
  /**
   * Inviting people to a workplace is switched off for now (owner,
   * 2026-10-11). True closes the door: the state says `invitesClosed`, so the
   * workplace menu loses "Invite to this workplace" and Home its join
   * requests card; `api/org` lists no invite links or join requests; making
   * a link or requesting to join through one is refused; and a link already
   * out there opens on a page that says invites are closed. Nothing is
   * removed — members stay members, the screens stay built — and leaving
   * this unset (as every test and harness does) is the whole of turning
   * invites back on. The production value is set in index.ts.
   *
   * A workplace the platform marked (`OrgDocument.invitesAllowed`, note
   * #805) is the exception: every one of those doors stays open there, and
   * only there.
   */
  invitesClosed?: boolean;
  /**
   * This backend is a private copy in a customer's own Fly organization
   * (note #802, stage 0 in note #804). Its hosted workplaces run on the
   * customer's account, so their bill is shown rather than refused.
   *
   * Many people, one company (note #808): index.ts leaves `invitesClosed`
   * off, so every workplace takes invites with no mark, and nobody makes an
   * account by walking up. POST auth/email/register needs a live invite
   * link (`inviteToken`) — that account gets NO spare workplace, its request
   * to join is filed with it, and it waits on the request page until an
   * admin decides — or, while the copy has no account at all, the
   * installer's `firstAccountCode`. A new workplace is made only by someone
   * already in one, so a declined applicant holds an account and nothing else.
   */
  privateCopy?: boolean;
  /**
   * New sign-ups on our hosted platform are closed (SIGNUP_CLOSED, note
   * #823, the owner, 2026-10-28: only the private copy is offered). The
   * sign-up door then takes nobody who walks up and points them at
   * /private-copy and hello@; an account comes only through a live invite
   * link into a workplace whose invites are open (a marked one, note #805),
   * gets NO spare workplace, and has its request to join filed with it, as
   * in a copy. The public authenticator enrollment makes no new account,
   * and a new workplace is made only by someone already in one. Existing
   * accounts sign in and work as before. Never set with `privateCopy`.
   */
  signupClosed?: boolean;
  /**
   * The installer's code for a copy's FIRST account (FIRST_ACCOUNT_CODE,
   * note #808), opened as `/signup#first-account=<code>`. It works only
   * while the copy has no account, and only with `privateCopy`.
   */
  firstAccountCode?: string;
  /**
   * A private copy's health page and diagnostics bundle for its admins
   * (note #813): `GET api/copy/health` and `GET api/copy/diagnostics`.
   * Unset here, where both answer 404.
   */
  copyHealth?: CopyHealth;
  /**
   * A private copy's licence (note #814): admins paste a renewal at
   * `POST api/copy/licence`, and a new person or agent is refused in words
   * at the people limit or once it has lapsed. Unset here, and in a copy
   * that leaves the check off (COPY_LICENCE=off).
   */
  copyLicence?: CopyLicence;
  /** Personal addresses on the mail domain (note #509). Absent → the
   *  Workspace simply never offers one. */
  mailboxes?: MailboxService;
  /** Mail that has arrived at those addresses (note #509 slice 2). Absent →
   *  the inbox routes 503 and the Worker retries rather than bouncing. */
  mailIngest?: MailIngestService;
  /**
   * Email set up after the install, in a private copy (note #946): its
   * state, the setup an admin goes through, and the one answer to "is mail
   * on here?" that the Mail section and the agents' CLI read. Absent off a
   * copy, where mail is always on.
   */
  copyMail?: CopyMailSetup;
  /** The owner's own reads of that inbox. Same absence, same answer. */
  mailMessages?: MailMessageStorage;
  /** Answering a message (slice 4). Absent without a sending key → the reply
   *  route 503s and the screen offers no Reply. */
  mailOutbox?: MailOutboxService;
  /** How a picture a letter points at is fetched (slice 10) — the service's
   *  own rules in production (`fetchMailRemoteImage`), and a stand-in in a
   *  test, so nothing here goes out to the internet to be tested. */
  mailRemoteImage?: (src: string) => Promise<MailRemoteImageOutcome>;
  /** Agent-authored mail waits here until its owner taps inside chat. */
  mailApprovals?: MailApprovalService;
  /**
   * What the Cloudflare `mail-inbound` Email Worker presents on every ingest
   * call. Absent → inbound mail is off on this backend, which is the state
   * every machine except production is in.
   */
  mailIngestSecret?: string;
  /** CI commit statuses (docs/ci-status-miniapp.md). Absent → ingest 503s. */
  gitCommitStatusStorage?: GitCommitStatusStorage;
  /**
   * Secret a CI runner presents to file a status. Deliberately NOT the git
   * host secret: that one verifies pushes and lives on the git host too; this
   * one writes statuses and lives only on CI boxes.
   */
  ciStatusSecret?: string;
  /**
   * The public origin the `agentbuilt` CLI talks to. Handed to a CI run that
   * publishes a linked site, whose machine has no config file of its own.
   * Absent → `/git/ci-secrets` hands out no publish key at all.
   */
  agentbuiltApiUrl?: string;
  /**
   * Secret the nightly backup jobs present to report a run. Its own secret
   * again, and for the same reason: it lives on the two backup boxes, and all
   * it can do is say "a backup happened".
   */
  backupHeartbeatSecret?: string;
  /**
   * Files a backup run against the staleness monitor. Absent → the heartbeat
   * route 503s, which is the honest degraded state: nothing is watching.
   */
  recordBackupHeartbeat?: (job: string, status: 'ok' | 'fail', detail?: string) => void;
  /**
   * Reads back what a backup job last managed, for the org screen's backups
   * block (note #357). Separate from `recordBackupHeartbeat` on purpose: that
   * one needs the ops notifier behind it to be worth accepting a report,
   * while READING is useful whenever the store exists. Absent → the block
   * says nothing rather than guessing.
   */
  readBackupHeartbeat?: (job: string) => { at: string; ok: boolean } | undefined;
  /**
   * Puts an Approve/Reject card in the user's chat for a proposal. Returns
   * whether it was delivered. The agent CLI can only ever ASK — the tap is
   * what merges, which is the entire point of the gate.
   */
  requestPullRequestApproval?: (args: {
    userId: string;
    agentId: string;
    repoName: string;
    pullRequestId: string;
  }) => Promise<boolean>;
  /**
   * Auto-merge (note #944): `pr ready` calls it, never an agent verb, for a
   * proposal it just made ready while its owner's own switch — which only
   * that person turns on — is on and the checks passed. Merges through the owner's own gate and records the decision as
   * automatic; anything that stops the merge leaves the proposal open,
   * awaiting its owner, with the reason recorded.
   */
  autoApprovePullRequest?: (args: {
    pullRequestId: string;
    mode: { onAt: string; byUserId: string; byName: string };
  }) => Promise<{ status: 'merged'; mergeCommitSha: string } | { status: 'fallback'; reason: string }>;
  /**
   * Tells the owner, in the asking agent's chat, that `names` now reach CI
   * runs on the repo's protected branch (note #739: the grant is applied at
   * once; nothing is asked). Returns whether the line was written. Names
   * only — values never cross this route.
   */
  /**
   * An agent changed a knowledge page and it is live (note #746): the owner
   * is TOLD by a line in that agent's chat, never asked. Returns whether the
   * line could be written.
   */
  tellOwnerKnowledgeChanged?: (args: {
    userId: string;
    agentId: string;
    proposalId: string;
  }) => Promise<boolean>;
  tellOwnerCiSecretsGranted?: (args: {
    userId: string;
    agentId: string;
    repoId: string;
    names: string[];
  }) => Promise<boolean>;
  /**
   * Tells the owner, in the asking agent's chat, that approving a change to
   * this repository now publishes its linked site (`agentbuilt repo
   * publish`, applied at once since note #739). Returns whether the line
   * was written.
   */
  tellOwnerPublishLinked?: (args: {
    userId: string;
    agentId: string;
    repoId: string;
  }) => Promise<boolean>;
  /**
   * Tells the agent that asked what the owner decided about deleting its repo
   * (docs/agent-git-project-repos.md slice 5). Deleting happens in the
   * workspace and ONLY there — there is no card and no agent-reachable route
   * that deletes — so this is the whole of the hand-back: the asking agent
   * wakes with the answer instead of polling for a repo that may be gone.
   */
  notifyRepoDeleteDecision?: (args: {
    userId: string;
    agentId: string;
    repoName: string;
    decision: 'deleted' | 'kept';
    /** Present on 'deleted': the day the trash stops being restorable. */
    restorableUntil?: string;
    withdrawnPrs?: number;
  }) => Promise<void>;
  /**
   * The same hand-back for a site. No `restorableUntil` twin: a site has no
   * trash, because its content is a redeploy away and what a delete actually
   * keeps is the address (the tombstone reserves the name).
   */
  notifySiteDeleteDecision?: (args: {
    userId: string;
    agentId: string;
    siteName: string;
    decision: 'deleted' | 'kept';
  }) => Promise<void>;
  /** The same hand-back for a bucket (note #768). */
  notifyStorageDeleteDecision?: (args: {
    userId: string;
    agentId: string;
    bucketName: string;
    decision: 'deleted' | 'kept';
  }) => Promise<void>;
  /**
   * Applies the USER's decision on a proposal from the Workspace. Runs the
   * head-sha anchored merge with agent hand-back and
   * outcome into the chat — and returns the proposal's status afterwards,
   * with the guard note when the flow refused to act.
   */
  decidePullRequest?: (args: {
    userId: string;
    pullRequestId: string;
    decision: 'approve' | 'reject';
    /** The head sha the deciding screen rendered; a mismatch re-asks. */
    shownHeadSha?: string;
    /** The rejection reason, relayed to the proposing agent. */
    note?: string;
  }) => Promise<{ status: GitPullRequestStatus | null; note: string | null }>;
  /**
   * Applies the OWNER's decision on a knowledge proposal, from the Workspace —
   * the only surface that has one, because a chat card cannot render a page
   * and nobody should approve one they have not read. Returns the proposal's
   * status afterwards, with a note when the flow refused to act.
   */
  decideKnowledgeProposal?: (args: {
    userId: string;
    proposalId: string;
    decision: 'approve' | 'reject';
    note?: string;
  }) => Promise<{ status: KnowledgeProposalStatus | null; note: string | null }>;
  /**
   * The agent's own "new chat" (`agentbuilt chat new`): records that the
   * calling turn is the conversation's last, applies the reset once that turn
   * ends (an immediate null would lose the race with the finishing harness
   * writing its session id back), and starts the fresh conversation with the
   * agent's handoff when one was given. Absent → the chat route 503s.
   */
  requestChatReset?: (args: {
    userId: string;
    agentId: string;
    /** The agent's first message to its fresh self, delivered after the reset. */
    handoff?: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * User secrets (docs/user-secrets.md), for `agentbuilt secret`. Absent →
   * those routes 503, and the machine keeps getting its secrets exported into
   * every turn regardless — the CLI is a management surface, not the delivery
   * path.
   */
  secretStorage?: SecretStorage;
  /**
   * Agent lifecycle shared by the browser Workspace and the agent CLI.
   * `createAgent` answers the gates synchronously and continues setup after
   * the response, reporting progress in browser chat. `deleteAgent` performs
   * the matching teardown; `listPeers` / `messagePeer` back idle-only
   * coordination. Absent → the agent endpoints 503.
   */
  agentLifecycle?: {
    /**
     * `cli` is the harness picked at creation — the one choice an agent
     * keeps for life (nothing may write it afterwards). Omitted → claude.
     */
    /**
     * The Chief of Staff's computer, built ahead of its first turn (note
     * #726): started when the person taps Claude or Codex on the sign-in
     * card in its chat. Record and machine only; the first turn still owns
     * the credential and waits for this build on the same chain.
     */
    prepareWorkspaceAgent?(userId: string, orgId: string, cli: 'claude' | 'codex'): Promise<void>;
    createAgent(
      userId: string,
      cli?: 'claude' | 'codex' | 'opencode',
      /** Workspace context at the instant creation was requested. */
      orgId?: string | null,
      /** `awaitName`: answer once the record is reserved, with its name (note #710); `concurrent`: several at once, outside the person's one-at-a-time lock (note #726); `model` / `effort`: what it thinks with, already judged against the catalog, stored on the record as a pick (note #757). */
      options?: { awaitName?: boolean; concurrent?: boolean; model?: string; effort?: string },
    ): Promise<
      /** `agent` is the record reserved before the machine is built (note
       *  #710): its name, so a coordinator can say who is arriving. Absent on
       *  a backend from before it was reported, or when setup fell over
       *  before the record was made. */
      | { ok: true; agent?: { id: string; name: string } }
      | { ok: false; reason: string }
    >;
    deleteAgent(userId: string, agentId: string): Promise<
      | { ok: true; name: string; machine: 'destroyed' | 'none' | 'unmanaged' | 'left'; remaining: number }
      | { ok: false; reason: string }
    >;
    /** A workplace being deleted: stop this agent where it is and put its machine to sleep. */
    suspendAgent?(userId: string, agentId: string): Promise<'stopped' | 'no-machine' | 'failed'>;
    /**
     * A deleted workplace's agent: its record goes, and its machine stays in
     * the workplace's own cloud — or, for a hosted workplace whose machines
     * are on ours (note #664), is destroyed with it (`destroyMachine`).
     */
    forgetAgent?(userId: string, agentId: string, opts?: { destroyMachine?: boolean }): Promise<
      | { ok: true; name: string; machine: 'destroyed' | 'none' | 'unmanaged' | 'left'; remaining: number }
      | { ok: false; reason: string }
    >;
    /** Wake this org's waiting agents after an existing private sign-in is assigned. */
    connectAgentsForSeat?(userId: string, provider: 'claude' | 'codex' | 'opencode', orgId: string): Promise<void>;
    /** Build the computers of the agents this workplace was founded with (note #144), once its cloud and a subscription are in. */
    setUpPlannedAgents?(userId: string, orgId: string): Promise<void>;
    /**
     * The per-agent version card (CLI version, pin, machine image) and its
     * two update actions — the Workspace surface that replaced the control
     * keyboard's Version view (2026-08-09). Absent → those endpoints 503.
     */
    agentVersion?(userId: string, agentId: string): Promise<TelegramAgentVersionInfo | null>;
    /**
     * The record-known half of that same card, for every agent at once, so the
     * state payload can carry it and the screen opens on facts instead of a
     * loading card (note #102). Costs no machine read. Absent → the state
     * sends no seed and the screen opens on "Checking…", as it did before.
     */
    agentVersionSeeds?(
      userId: string,
      agents: AgentRecord[],
    ): Promise<Record<string, TelegramAgentVersionSeed>>;
    /**
     * Whether this agent is mid-turn right now — the same live signal the
     * agent's own card shows as `busy`, lifted to the fleet list so a row can
     * say "Working now" instead of a stamp that moves at most once an hour.
     * Synchronous on purpose (an in-memory run-registry lookup), so the list
     * can ask per agent without a round trip. Absent → rows fall back to the
     * stamp, which is what they did before.
     */
    isAgentWorking?(userId: string, agentId: string): boolean;
    /**
     * What that turn is doing this second — the newest tool line the CLI
     * reported and the moment the turn started, the same pair the agent chat's
     * status button shows. `null` when nothing is running; an object with
     * neither field when a turn has started but has not called a tool yet.
     * Synchronous for the same reason as `isAgentWorking` (in-memory registry).
     * Absent → rows say "Working now" and stop there, as they did before.
     */
    agentActivity?(userId: string, agentId: string): { activity?: string; startedAt?: number } | null;
    /**
     * Whether this agent's machine is being rebuilt right now, before a turn
     * can start on it (note #658) — the wait a Send sits in when the machine
     * has gone, e.g. after the workplace's cloud was replaced. In-memory and
     * synchronous, like `isAgentWorking`. Absent → the chat never says so.
     */
    isAgentPreparing?(userId: string, agentId: string): boolean;
    /**
     * Epoch ms of the freshest interaction this process has seen with the
     * agent — the unthrottled twin of the persisted `lastActivityAt` stamp,
     * which is written at most once an hour and therefore orders two agents
     * used in the same hour by coin flip. Synchronous (an in-memory map) and
     * process-local: undefined means "not touched since boot", never "idle",
     * so the fleet list uses it to RAISE the stamp and never to replace it.
     */
    lastActiveAtMs?(userId: string, agentId: string): number | undefined;
    /**
     * The roster and same-owner messages for `agentbuilt agent`. An
     * idle recipient starts at once; a working one holds the message until
     * its turn ends (note #267), and the sender may list or withdraw what it
     * has waiting.
     */
    listPeers?(userId: string, senderAgentId: string): Promise<TelegramAgentPeerRoster>;
    /**
     * End the Workspace Agent's orphaned turn on its machine (note #455)
     * before the conversation picks an interrupted request up again.
     */
    endWorkspaceAgentTurn?(userId: string, orgId: string): Promise<'ended' | 'none' | 'unreachable'>;
    messagePeer?(args: {
      userId: string;
      senderAgentId: string;
      recipient: string;
      message: string;
    }): Promise<AgentPeerMessageResult>;
    /**
     * A managed job on the agent's own machine reached a terminal state
     * (note #532) — the one platform event that starts a turn without any
     * person being involved. Queues into a running turn rather than refusing
     * it: a dropped job result has no second sender. Absent → the route 503s
     * and the machine keeps the receipt owed until a backend that has it
     * answers.
     */
    deliverFinishedJobs?(args: {
      userId: string;
      agentId: string;
      receipts: FinishedJobReceipt[];
    }): Promise<{ accepted: string[] }>;
    listPendingPeerMessages?(userId: string, senderAgentId: string): PendingPeerMessageSummary[];
    cancelPendingPeerMessage?(
      userId: string,
      senderAgentId: string,
      id: string,
    ): { ok: true; recipient: { id: string; name: string } } | { ok: false; reason: string };
    /**
     * The user's one-shot starts from the Workspace: Send beneath a note or
     * knowledge page (note #87) and the proposal review hand-off (note #327).
     * Both are a deliberate hand-over; a margin comment is not one of them any
     * more and starts nobody (note #518). Same idle-only
     * contract as `messagePeer` — busy is a refusal, never a queue. Absent →
     * those routes 503 and the page offers no target.
     */
    messageAgentFromUser?(args: {
      userId: string;
      agentId: string;
      message: string;
    }): Promise<AgentPeerMessageResult>;
    /**
     * The agent's chat screen in the Workspace (inhouse-chat-design, note
     * #131). Send follows the agent-bot inbound contract, not the one-shot
     * Send's: a working agent is steered mid-turn rather than refused. The
     * read is the screen's incremental cursor over the platform's chat
     * record. Either absent → the chat routes 503 and the screen is not
     * offered.
     */
    chatMessageAgentFromUser?(args: {
      userId: string;
      agentId: string;
      message: string;
      /** Files selected together in the composer, admitted with one turn:
       *  inline bytes, or the id of a file that went up in parts (note #943). */
      attachments?: AgentChatUpload[];
    }): Promise<AgentPeerMessageResult & { steered?: boolean }>;
    /**
     * Something that changes what a Home overview should say happened to one
     * of this owner's agents: a turn was admitted, a turn ended, or its row
     * recap was rewritten. The Workspace subscribes to regenerate the private
     * overview before anyone opens Home, instead of only when they do.
     * Returns the unsubscribe. Absent → overviews refresh on read alone.
     */
    onWorkspaceActivity?(listener: (event: WorkspaceActivityEvent) => void): () => void;
    /**
     * One model run on the person's dedicated Workspace Agent machine. With
     * `options.act` the run is the agent's own turn: the machine holds a
     * full room-scoped agentbuilt credential and the CLI may call `agentbuilt`
     * (notes, knowledge, messaging the owner's agents — nothing else), and
     * the bound is minutes rather than seconds. Without it, the run is a
     * tool-free summarizer call, which is what the Home briefing uses.
     */
    converseWorkspaceRecap?(userId: string, orgId: string, prompt: string, settings?: import('../shared/workspace-recap.js').WorkspaceRecapSettings | null, onPhase?: (phase: string) => Promise<void>, options?: import('../services/agent-service.js').WorkspaceAgentTurnOptions): Promise<import('../shared/workspace-recap.js').WorkspaceRecapRun>;
    summarizeWorkspaceRecap?(userId: string, orgId: string, prompt: string, settings?: import('../shared/workspace-recap.js').WorkspaceRecapSettings | null): Promise<import('../shared/workspace-recap.js').WorkspaceRecapRun>;
    /**
     * The Chief of Staff's request ended (note #945): stamp the turn on its
     * record and run the row-recap summary over it, for the recap line under
     * the turn in its chat. Fire-and-forget; failure is silence.
     */
    workspaceAgentTurnEnded?(userId: string, orgId: string, turn: { startedAt?: string; messages: import('../services/agent-recap.js').AgentRecapTurnMessage[] }): Promise<void>;
    /** Seat IDs actually leased by this member's private Workspace Agent or briefing. */
    workspaceSeatIdsInUse?(userId: string, orgId: string): string[];
    agentChatMessages?(userId: string, agentId: string, afterSeq: number): Promise<Array<{
      seq: number;
      role: 'owner' | 'agent' | 'platform';
      text: string;
      at: string;
      files?: Array<{ id: string; fileName: string; contentType: string; sizeBytes: number }>;
      /** Legacy/single-agent-output row. */
      file?: { id: string; fileName: string; contentType: string; sizeBytes: number };
      /**
       * The Workspace screen this row opens: the change proposal (`pr`) or
       * knowledge proposal (`kp`) it is about. Both the ask and its outcome
       * carry one (note #181) — the row is the only place in the chat that
       * names a proposal, so it is the only place that can open it.
       */
      open?: { pr?: string; kp?: string };
      /** An email request whose decision is rendered in this row. */
      mailApprovalId?: string;
    }>>;
    /** Put an agent's email request into its own Workspace conversation. */
    requestMailApproval?(args: {
      userId: string;
      agentId: string;
      approvalId: string;
      text: string;
    }): Promise<boolean>;
    /**
     * One exact agent reply for its details screen. Kept distinct from the
     * incremental transcript read so this glance neither fetches the chat
     * window nor counts as reading it.
     */
    latestAgentChatMessage?(userId: string, agentId: string): Promise<{
      text: string;
      at: string;
    } | null>;
    /** The newest message of either voice since the last fresh chat (note #716's event sweep). */
    latestAgentChatRow?(userId: string, agentId: string): Promise<{
      role: 'owner' | 'agent' | 'platform';
      text: string;
      at: string;
      seq: number;
    } | null>;
    /**
     * That same reply for every agent at once, so the state payload seeds each
     * details screen and its Last reply section is already there on the first
     * open (note #155) — the same bargain `agentVersionSeeds` makes for the
     * version card. Absent, or absent for one agent, → that screen reads the
     * reply for itself, as it did before.
     */
    agentChatReplySeeds?(
      userId: string,
      agents: AgentRecord[],
    ): Promise<Record<string, { text: string; at: string }>>;
    /** Durable machine jobs: the running ones for the chat's horizontal
     *  subheader, and the newest outcomes for the details page (note #564). */
    listManagedJobs?(userId: string, agentId: string): Promise<{
      jobs: WorkspaceManagedJob[];
      recent: WorkspaceSettledJob[];
    }>;
    /**
     * The files on the newest message of each agent's chat (note #553), for
     * the whole fleet at once: what the agents list draws on a plate whose
     * agent just sent, or was just sent, pictures. Absent, or absent for one
     * agent, → that plate shows no files, which is also what an agent whose
     * last message carried none shows.
     */
    agentChatLastFiles?(
      userId: string,
      agents: AgentRecord[],
    ): Promise<Record<string, WorkspaceChatFile[]>>;
    /**
     * The chat screen's Stop: interrupt the running turn, preserve accepted
     * owner messages for its next Send, and settle other queued work.
     * `stopped: false` = it had already finished. Absent → no Stop.
     */
    stopAgentTurn?(args: {
      userId: string;
      agentId: string;
      /** Who ended it (note #462): the owner's button, or the Workspace Agent for them. Default the owner. */
      stoppedBy?: 'user' | 'workspace-agent';
      /** The Workspace Agent's reason, written on the agent's chat row. */
      reason?: string;
      /** How long to wait for the turn to unwind to idle before answering; `idle` says whether it did. */
      awaitIdleMs?: number;
    }): Promise<
      | { ok: false; code: 'not_found'; reason: string }
      | { ok: true; stopped: boolean; name: string; idle: boolean }
    >;
    /**
     * A platform row in one agent's own chat, said to the person who reads
     * it there (note #776: "the Workspace Agent changed this agent's model").
     * False when the agent is no longer on the account.
     */
    recordAgentPlatformRow?(userId: string, agentId: string, text: string): Promise<boolean>;
    /** A chat file's short-lived signed URL — the note-file contract. */
    agentChatFileAccess?(userId: string, agentId: string, fileId: string, preview?: boolean): Promise<{
      url: string;
      fileName: string;
      expiresAt: string;
      /** A picture's pixel size, when a preview read could measure it. */
      width?: number;
      height?: number;
    } | null>;
    /** A Markdown chat file's words, for the Workspace to draw itself (note #677). */
    agentChatFileText?(userId: string, agentId: string, fileId: string): Promise<WorkspaceChatFileTextAnswer | null>;
    updateAgentCli?(userId: string, agentId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    updateAgentMachine?(userId: string, agentId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    /**
     * The machine screen (note #268): what this agent's machine is made of
     * and the ladder it may move along, then the move itself. Absent → the
     * machine routes 503 and the screen keeps its read-only row.
     */
    agentMachine?(userId: string, agentId: string): Promise<TelegramAgentMachineInfo | null>;
    resizeAgentMachine?(userId: string, agentId: string, size: string): Promise<
      { ok: true; changed: boolean; awake: boolean } | { ok: false; reason: string }
    >;
  };
  /**
   * The org layer (org-layer-design): members, seats, invites. Absent → the
   * Workspace org routes 503 and the state payload carries no org section.
   */
  orgStorage?: OrgStorage;
  /** Workplace public handles (public-addresses): grammar, uniqueness across people and workplaces, derivation. */
  orgHandles?: OrgHandleService;
  /**
   * Probe fresh usage readings onto the seat rows — the credential pool's
   * own all-provider walk, the one the 5-minute timer runs. The seats screen
   * and Home call it on load/focus only when their saved readings are stale.
   * Absent → the screens render the stamps they have.
   */
  refreshSeatUsage?: () => Promise<void>;
  /**
   * The Workspace seat sign-in (org-layer-design workstream 2): the
   * deterministic driver behind the seats screen's "Sign in a subscription"
   * flow. Absent → the sign-in routes 503 and the screen keeps its hint.
   */
  seatSignIn?: OrgSeatSignInFlow;
}

/**
 * What the agent CLI routes may tell the Workspace Agent's conversation.
 * Every call names the person and workplace the acting credential belongs
 * to; the conversation checks that pair against its own record and ignores a
 * receipt for a run that is not in flight.
 */
export interface WorkspaceAgentHooks {
  /** A completed action: the words for the transcript and the screen it opens. */
  receipt(userId: string, orgId: string, text: string, href?: string): Promise<void>;
  /**
   * The person's plan landed (note #726): the receipt row in their Chief of
   * Staff's conversation, and — when they wrote before signing in — the
   * first turn, started by itself on what they wrote.
   */
  seatSignedIn?(userId: string, orgId: string, provider: 'claude' | 'codex'): Promise<void>;
  /** Put the Workspace Agent's email request in this same conversation. */
  requestMailApproval?(args: {
    userId: string;
    orgId: string;
    approvalId: string;
    text: string;
  }): Promise<boolean>;
  /**
   * `agentbuilt forward` (note #724): proposal cards on one action row of a
   * running request. A proposal already in front of the person in this
   * conversation gets no second card (note #752): the outcome says which
   * landed and which were already there, and `text` may be written for the
   * ones that landed.
   */
  forwardProposals?(args: {
    userId: string;
    orgId: string;
    proposals: import('../shared/workspace-recap-chat.js').RecapForwardedProposalRef[];
    text: string | ((added: import('../shared/workspace-recap-chat.js').RecapForwardedProposalRef[]) => string);
  }): Promise<import('../shared/workspace-recap-chat.js').RecapForwardOutcome>;
  /**
   * `agentbuilt pr ready` from one of the person's own agents (note #752):
   * the same card `agentbuilt forward` puts in their Chief of Staff chat,
   * landed by the platform at once, whoever asked for the work — no model
   * turn, and never twice. Runs outside any request of that conversation.
   */
  proposalReady?(args: {
    userId: string;
    orgId: string;
    proposal: import('../shared/workspace-recap-chat.js').RecapForwardedProposalRef;
    text: string;
  }): Promise<import('../shared/workspace-recap-chat.js').RecapProposalReadyOutcome>;
  /**
   * Message one of the owner's agents on the agent's behalf — the same
   * idle-only admission `agentbuilt agent message` has for every agent, plus
   * the reply cursor that lets the conversation collect the answer later.
   */
  messageAgent(args: {
    userId: string; orgId: string; senderAgentId: string; recipient: string; message: string;
    /** The row the send leaves instead of "Sent to …" (`note hand`, note #716), given the recipient's name. */
    receipt?: (name: string) => string;
  }): Promise<AgentPeerMessageResult>;
  /**
   * `agentbuilt agent history` from the Workspace Agent (note #466): a tiny
   * read-only window over the same owner-visible chat rows the Workspace
   * renders. The implementation resolves only this person's own agents and
   * returns no files, harness transcript, prompts or model events.
   */
  agentHistory(args: { userId: string; orgId: string; agent: string; limit: number }): Promise<
    | { ok: true; agent: { id: string; name: string }; steps: Array<{ role: 'owner' | 'agent' | 'platform'; author: string; at: string; text: string }> }
    | { ok: false; code: 'ambiguous' | 'not_found' | 'not_own' | 'unavailable'; reason: string }
  >;
  /**
   * `agentbuilt chat new` from the Workspace Agent (note #429): the fresh
   * chat starts when the running request ends — the reply still goes out
   * with full context, then the divider lands and the next request reads
   * nothing above it. Refused outside a running request, exactly as a
   * receipt is.
   */
  resetConversation(userId: string, orgId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * After a backend restart (note #455): every conversation left with a
   * running request is recovered now — the orphaned turn ended, the request
   * named, and picked up again when it is recent — rather than waiting for
   * the person to open the screen and read about it.
   */
  resumeInterrupted?(): Promise<void>;
  /**
   * A room agent's answer, sent by the agent itself with `agentbuilt agent
   * message "Workspace Agent" "…"` (note #457): the row lands in the
   * owner's Workspace Agent conversation and closes the wait for that agent.
   * Nothing reads a room agent's chat into this conversation any more.
   *
   * The answer also starts the Workspace Agent on a turn that reacts to it,
   * or carries one after the turn already running (note #539). `reacting` is
   * false when it could not: a Workspace Agent the person has never started,
   * or a backend with no conversation runtime. The row lands either way.
   */
  receiveFromAgent(args: { userId: string; orgId: string; senderAgentId: string; message: string }): Promise<{ ok: true; name: string; reacting: boolean } | { ok: false; reason: string }>;
  /**
   * `agentbuilt workplace message` (note #753): pass a message to the SAME
   * person's Chief of Staff in another workplace they belong to, only in a
   * turn the person's own words started. The route has already resolved the
   * workplace among the person's memberships; this records the wait and the
   * receipt here, lands one row there that starts (or follows) a turn, and
   * that turn's reply comes back here by itself and starts a reaction.
   */
  messageWorkplace?(args: { userId: string; orgId: string; orgName: string; toOrgId: string; toName: string; message: string }): Promise<
    | { ok: true; name: string; queued: boolean }
    | { ok: false; code: 'refused' | 'busy' | 'unavailable'; reason: string }
  >;
  /**
   * `agentbuilt agent stop` from the Workspace Agent (note #462): end the
   * running turn of one of the owner's own agents, exactly as the owner's
   * Stop does — and close this conversation's wait for that agent, since the
   * answer it owed is not coming. The Workspace Agent's verb alone; the route
   * refuses a room agent before this is reached.
   */
  stopAgent(args: { userId: string; orgId: string; agent: string; reason?: string }): Promise<WorkspaceAgentStopResult>;
  /**
   * `agentbuilt agent reset` from the Workspace Agent (note #710): send one
   * of the owner's own IDLE agents the owner's "reset chat" — the same ask
   * the agent screen's button sends, through the same idle-only door — so a
   * handoff unrelated to that agent's last work starts clean. The agent
   * saves what matters and runs `chat new` itself; nothing is cleared here.
   */
  resetAgent(args: { userId: string; orgId: string; agent: string }): Promise<WorkspaceAgentResetResult>;
  /**
   * `agentbuilt agent remove` from the Workspace Agent (note #710): ASK the
   * owner to remove one of their own agents, as a site's `delete` asks. The
   * record is flagged for the agent's screen; nothing is removed, and only
   * the owner's typed confirmation there does.
   */
  askRemoveAgent(args: { userId: string; orgId: string; agent: string; reason?: string }): Promise<WorkspaceAgentRemoveAskResult>;
  /**
   * `agentbuilt agent model` from the Workspace Agent (note #776): change
   * one of the owner's own agents' model and effort exactly as the picker on
   * its screen does — the same catalog, the same rule — from its next turn.
   * Its chat gets a row saying who changed it, and its next turn is told.
   */
  changeAgentRuntime(args: { userId: string; orgId: string; agent: string; model?: string; effort?: string }): Promise<WorkspaceAgentRuntimeResult>;
  /**
   * What the platform noticed (note #716): the rows land in the person's
   * conversation and start one EVENT turn, or carry one after the turn
   * already running. False when the person never started their Workspace
   * Agent, or there is no conversation runtime.
   */
  receiveEvents?(args: { userId: string; orgId: string; events: import('../shared/workspace-agent-proactive.js').WorkspaceAgentEvent[] }): Promise<boolean>;
  /**
   * The event turn's fence (note #716), asked for every Workspace Agent CLI
   * call that is not a read: null lets it through, words refuse it.
   */
  eventTurnRefusal?(userId: string, orgId: string, method: string, path: string): Promise<string | null>;
  /** Whether the turn in flight is an event turn (note #716). */
  isEventTurn?(userId: string, orgId: string): Promise<boolean>;
  /** The newest event turns, for the Workplace window (note #716). */
  eventHistory?(userId: string, orgId: string, limit?: number): Promise<import('../shared/workspace-agent-proactive.js').WorkspaceAgentEventTurnSummary[]>;
}
