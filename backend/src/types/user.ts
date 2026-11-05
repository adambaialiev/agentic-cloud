import { createHash, randomUUID } from 'node:crypto';
import { normalizeAgentUsername } from '../utils/agent-username.js';
import type { FirstVisit } from '../shared/first-visit.js';
import { HARNESS_CLIS, harnessName } from '../shared/harness-clis.js';
import type { SealedAgentKind } from '../shared/public-guide.js';

export interface UserRoleState {
  admin?: boolean;
  /**
   * One of the team's own accounts — a test, a demo — which the sign-up
   * roster must not count as someone from outside. Said, never guessed:
   * set by `scripts/mark-team-account.mjs` (sqlite-user-roster.ts says why
   * the address can no longer tell).
   */
  internal?: boolean;
}

export interface TelegramLinkState {
  telegramUserId?: string;
  chatId?: string;
  username?: string;
  timeZone?: string;
  languageCode?: string;
  firstName?: string;
  lastName?: string;
  linkedAt?: string;
  notificationsEnabled?: boolean;
  lastUserActivityAt?: string;
  lastActivityAt?: string;
  /**
   * Per-agent records, keyed by agent id. An "agent" is one CLI (codex or
   * claude) running on one machine — the successor to the former CLI-keyed
   * maps (connectedHarnesses / harnessServers / harnessModels /
   * harnessConversations). Id-keyed rather than a list so field-path
   * updates such as `telegram.agents.<id>.conversation.<key>` stay surgical.
   * Uncapped — unlimited agents is the product pitch; the common case is a
   * single default agent created implicitly by the setup-agent flow.
   */
  agents?: Record<string, AgentRecord>;
  /**
   * Latest account-level subscription usage reported by each connected CLI.
   * Agents that share a provider login also share these limits, so snapshots
   * deliberately live beside the fleet instead of on an individual agent.
   */
  providerUsage?: Partial<Record<AgentCli, ProviderUsageSnapshot>>;
  /**
   * Onboarding funnel timestamps. Not load-bearing for routing — purely metrics.
   */
  onboarding?: TelegramOnboardingState;
  /**
   * @deprecated Legacy field from the app-per-user model. It once held the single
   * Fly app slug shared by all of a user's agent machines; provisioning is now
   * app-per-agent (each agent owns a fresh app, tracked via its `serverId`), so
   * nothing writes this anymore. Kept only so legacy profiles that still carry it
   * deserialize without crashing — it is never read for routing/provisioning.
   */
  flyAppSlug?: string;
}

/**
 * Onboarding state (ISO 8601 timestamps, each stamped at most once). Only
 * FUNCTIONAL fields live here — guards the product logic reads, not funnel
 * analytics. (Older stamps — machineCreatedAt, signInConfirmedAt, fleetReadyAt,
 * firstTaskCompletedAt, firstTaskDispatchedAt, and the invite-gate's
 * inviteRedeemedAt — were removed; old profiles carrying them are harmlessly
 * ignored.)
 */
export interface TelegramOnboardingState {
  /** First inbound message / `/start` we saw from this user. */
  firstStartAt?: string;
}

export type TelegramHarness = 'default' | 'codex' | 'claude' | 'opencode';

export const TELEGRAM_AGENT_CLIS = HARNESS_CLIS;

export type AgentCli = (typeof TELEGRAM_AGENT_CLIS)[number];

/**
 * Whether a cli value READ BACK FROM STORAGE is one this product still runs.
 *
 * Takes a `string`, not a `AgentCli`, and that is the whole point: the
 * type says a retired harness cannot appear, while storage was written when it
 * could. Kimi was removed on 2026-08-25 and Kimi agents may still sit in older
 * records; narrowing the union does not rewrite a database. Anything outside
 * the supported set is a retired agent — shown so its owner can delete it, and
 * never handed to a harness.
 */
export function isSupportedAgentCli(cli: string | undefined): cli is AgentCli {
  return (TELEGRAM_AGENT_CLIS as readonly string[]).includes(cli ?? '');
}

export interface ProviderUsageWindow {
  /** Provider-stable bucket id (`five_hour`, `seven_day`, `primary`, ...). */
  id: string;
  /** Percentage consumed, normalized to 0..100. */
  usedPercent: number;
  /** Window duration when the provider exposes it. */
  windowDurationMins?: number;
  /** Unix epoch seconds for the next reset. */
  resetsAt?: number;
}

export interface ProviderUsageSnapshot {
  windows: Record<string, ProviderUsageWindow>;
  /** ISO timestamp when the provider supplied this snapshot. */
  capturedAt: string;
  /**
   * WHICH subscription this is, as the provider's own key: `max_20x`,
   * `max_5x`, `pro` for Claude; `plus`, `pro`, `team` for Codex. Two Max
   * sign-ins are otherwise identical rows on the subscriptions screen, and
   * their sizes differ fourfold (note #142).
   */
  planType?: string;
  /**
   * ISO timestamp of the plan read itself. Claude's plan rides a SECOND
   * endpoint (the profile one), so it is re-read on its own slower schedule
   * rather than with every usage pass; `capturedAt` says nothing about it.
   */
  planReadAt?: string;
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance?: string;
  };
  /**
   * Extra-usage spend against its monthly cap (Claude's "usage credits"), in
   * minor units so no formatting is baked in at capture time: $56.32 spent of
   * an $80.00 cap is `{usedMinor: 5632, limitMinor: 8000, currency: 'USD',
   * exponent: 2}`. Only the profile-scoped usage endpoint reports amounts —
   * the `overage` WINDOW (a percent) can also come from the header probe.
   */
  spend?: {
    usedMinor: number;
    limitMinor: number;
    currency: string;
    exponent: number;
  };
}

/**
 * Native CLI conversation continuity pointers for a single agent. The managed
 * VM owns the conversation itself; these are only the ids the backend needs to
 * resume the right native conversation (`codex exec resume` /
 * `claude -p --resume`) across backend restarts. Cleared by /clear (on the
 * active agent only) so the next turn starts a fresh native conversation.
 */
export interface TelegramAgentConversation {
  codexThreadId?: string;
  claudeSessionId?: string;
  /** OpenCode's session (`ses_…`, `opencode run --session`), note #780. */
  opencodeSessionId?: string;
}

/**
 * One job an agent was set going on, as its Workspace row says it.
 *
 * `text` is one line, already summarized and capped — never the message it
 * came from, which can be a pasted spec. `at` is when the turn STARTED, which
 * is what "what was it doing before this?" is really asking; a turn that ran
 * for an hour is still the thing it took on at the top of the hour.
 */
export interface TelegramAgentTask {
  text: string;
  /** ISO timestamp the turn this describes began. */
  at: string;
  /**
   * @deprecated Marked entries the agent wrote itself with the retired
   * `agentbuilt task` verb. Nothing sets it anymore; legacy entries carrying
   * it can seed `recap` until the summarizer's first visit.
   */
  byAgent?: boolean;
}

/**
 * One agent = one CLI (codex or claude) on one machine. Replaces the former
 * CLI-keyed maps. `serverId` is the tracked managed-server recordId this
 * agent's CLI runs on (e.g. `hcloud_123`); the harness runs the CLI on that
 * exact machine (as `hcloud-sandbox-<id>`), so the sign-in the setup agent
 * performed there is the one the harness uses.
 */
export function workspaceAssistantId(userId: string, orgId: string): string {
  return `workspace-${createHash('sha256').update(JSON.stringify([userId, orgId])).digest('hex').slice(0, 32)}`;
}

/**
 * The person's SECOND private record in a workplace (note #437): the machine
 * that writes the Home briefing, and nothing else. It shares nothing with the
 * Workspace Agent's record but the hash — a different prefix, so the two can
 * never be the same key and a note-author lookup that keys on `workspace-`
 * never mistakes it for the agent.
 */
export function workspaceBriefingId(userId: string, orgId: string): string {
  return `briefing-${createHash('sha256').update(JSON.stringify([userId, orgId])).digest('hex').slice(0, 32)}`;
}

/**
 * The two private, workplace-wide records a member may hold, by purpose:
 * `workspace-recap` is the Workspace Agent (the stored value keeps the old
 * word; no migration), `workspace-briefing` is the summarizer's own machine
 * since note #437 — read-only, tool-free, never given a credential. Each has
 * one id and one name per person and workplace.
 */
export type WorkspacePurpose = 'workspace-recap' | 'workspace-briefing';
export function workspaceRecordFor(purpose: WorkspacePurpose, userId: string, orgId: string): { id: string; name: string } {
  return purpose === 'workspace-briefing'
    ? { id: workspaceBriefingId(userId, orgId), name: WORKSPACE_BRIEFING_NAME }
    : { id: workspaceAssistantId(userId, orgId), name: WORKSPACE_AGENT_NAME };
}

/**
 * The name of a person's private, workplace-wide agent — the one that
 * writes the Home briefing and acts from the Workspace conversation. It was
 * "Workspace Recap" while it could only read; the record's `purpose` value
 * keeps the old word so no stored profile needs a migration, and
 * `reserveWorkspaceAssistant` renames an old record the first time it is
 * reached.
 */
export const WORKSPACE_AGENT_NAME = 'Workspace Agent';
/** The briefing machine's name, as the Cloud inventory meters it. */
export const WORKSPACE_BRIEFING_NAME = 'Workspace Recap';

/** The workplace-wide assistant record, as opposed to a room agent. */
export function isWorkspaceAgent(agent: Pick<AgentRecord, 'purpose'> | null | undefined): boolean {
  return agent?.purpose === 'workspace-recap';
}

/**
 * A SEALED agent (note #1010): set once, at creation, and never changed — a
 * machine that ever held a token or a secret cannot be made clean by a flag.
 * Its machine is never given a platform token or a workplace secret, and
 * every turn runs as a separate user with read-only tools over a public copy
 * of the code (services/public-guide-machine.ts). Knowledge page:
 * sealed-public-agent.
 */
export function isSealedAgent(agent: Pick<AgentRecord, 'sealed'> | null | undefined): boolean {
  return Boolean(agent?.sealed);
}

export interface AgentRecord {
  /** Absent on every room agent; see {@link WorkspacePurpose}. */
  purpose?: WorkspacePurpose;
  /** Set only at creation; see {@link isSealedAgent}. */
  sealed?: SealedAgentKind;
  id: string;
  /**
   * The workplace this agent permanently belongs to. Switching the
   * Workspace never moves it. Optional only for records created before the
   * multi-org migration; those are backfilled from their owner's sole org.
   */
  orgId?: string;
  /** Display name, assigned at creation. Defaults to the CLI label. */
  name: string;
  /**
   * @deprecated The agent's own "what I am for" line (`agentbuilt describe`),
   * retired by the recap design (agent-row-recap-design, 2026-08-25). Nothing
   * writes or displays it anymore; the value remains only as inert legacy
   * profile data.
   */
  about?: string;
  /**
   * The Workspace Agent asked its person to remove this agent (note #710,
   * `agentbuilt agent remove`). Removal itself stays the person's tap on the
   * agent's screen, exactly as a site's `deleteAsk` does; this only flags the
   * record so that screen can say who asked and why. Newest ask wins, one at
   * a time; cleared by Keep on that screen, or with the record.
   */
  removeAsk?: { byAgentId: string; byUserId: string; at: string; reason?: string };
  /**
   * What this agent was set going on — the message that started the turn,
   * summarized to one line and stamped at turn START. The Workspace shows it
   * as the NOW line while the turn runs and drops it the moment the turn
   * ends: a finished turn's story belongs to `recap`, which is written by a
   * summarizer that read the whole exchange rather than its first message.
   *
   * Still newest-first and capped ([1] is legacy data from the retired
   * LAST/Before rows; only [0] is read now, and only while `working`).
   */
  tasks?: TelegramAgentTask[];
  /**
   * The row's line under the name: written ONLY by the post-turn recap
   * summarizer (agent-row-recap-design), never by the agent — one brief
   * latest-work update, including a blocker or owner action only when one
   * exists. The room supplies the standing context; the recap does not repeat
   * the agent's role. `at` is when the text last CHANGED; a turn whose recap
   * came back identical keeps the old stamp, so the stamp answers "when did
   * this row last say something new".
   *
   * Absent until the first summarizer run; readers fall back to composing a
   * seed from a legacy agent-authored task. The retired `about` description is
   * intentionally not part of that seed (note #109).
   */
  recap?: { text: string; at: string };
  /**
   * The last turn that stopped on this agent's subscription window. Kept on
   * the agent rather than the seat because the warning answers which
   * conversation stopped and therefore which one can be resumed. A later
   * admitted turn clears it on completion; another limit hit writes a fresh
   * marker instead.
   */
  sessionLimit?: {
    /** ISO timestamp of the turn failure. */
    hitAt: string;
    /** ISO timestamp when the provider/pool says this window can be tried again. */
    resetAt: string;
  };
  cli: AgentCli;
  /**
   * Managed-server recordId this agent's CLI runs on. String-capable so Fly
   * machine ids (hex strings) fit alongside today's numeric Hetzner ids.
   * Absent until the setup agent records the server.
   */
  serverId?: string;
  /**
   * Fly app this agent is CURRENTLY being provisioned into, written before the
   * app is created and cleared in the same write that saves `serverId`.
   *
   * The record and the machine live in two different systems, so they cannot be
   * written atomically — but the app slug is ours to choose, so we can decide it
   * first and record the intent before anything exists to be lost. Whatever dies
   * next (the API call, the write, the process mid-deploy), the machine that may
   * have been born is named on a record somebody owns, instead of running
   * unattributed and unmetered forever. Left set when provisioning fails: the
   * next attempt reclaims that app before minting a new one.
   */
  provisioningAppName?: string;
  /**
   * Apps this agent's machine USED to live in, retired when a rebuild replaced
   * a machine that had gone (note #792). The rebuild builds a fresh app and
   * re-points `serverId`, so from that moment nothing claims the old app — nor
   * the volume with the agent's old home on it — and before this it stayed in
   * the Fly account for good (four such leftovers on 2026-10-25). The idle
   * reaper deletes one once it has gone RETIRED_APP_RETENTION_MS without a
   * machine; that window is the time to recover anything from it by hand.
   */
  retiredMachineApps?: Array<{ appName: string; retiredAt: string }>;
  /** CLI model override. Absent means use that CLI's account default. */
  model?: string;
  /**
   * Per-agent reasoning effort override, scoped to that agent's CLI. Absent
   * means use the CLI's own default. Values are CLI-specific (see
   * TELEGRAM_CLAUDE_EFFORT_OPTIONS / TELEGRAM_CODEX_EFFORT_OPTIONS).
   */
  effort?: string;
  /**
   * The model or effort was changed by the Workspace Agent on the person's
   * behalf (`agentbuilt agent model`, note #776). The agent's next turn is
   * told so in one platform line, and the line clears this. The person's own
   * pick clears it too: what the agent runs on is then theirs, as always.
   */
  runtimeChange?: { by: 'workspace-agent'; at: string };
  /**
   * Per-agent sign-in override (note #129): this agent runs on that one seat
   * first, over the org's selected seat. Absent means the org's own
   * selection/fallback order. Points at a seat of the OWNER's — the lease
   * path quietly ignores it when the seat is gone or unassigned from this
   * agent's org, so a deleted seat degrades to the default instead of
   * stranding the agent.
   */
  seatId?: string;
  /**
   * Last observed installed version of this agent's CLI on its machine
   * (e.g. "2.1.219"), stamped by the pre-sleep updater and the menu's live
   * check. Display + skip-if-current only — the pinned fleet version lives in
   * `config/harnessCliVersions`, never here.
   */
  cliVersion?: string;
  /** ISO timestamp of the last CLI version observation. */
  cliVersionCheckedAt?: string;
  /**
   * Machine image this agent's machine was last CONFIRMED to be on, stamped by
   * MachineImageUpdater. Display only, and deliberately the observed value
   * rather than the intended one: the fleet target lives in FLY_MACHINE_IMAGE,
   * and the point of showing this is to say where a machine actually stands.
   */
  machineImage?: string;
  /** ISO timestamp of the last machine-image observation. */
  machineImageCheckedAt?: string;
  /**
   * What this agent's machine was last OBSERVED to be made of — shared vs
   * dedicated cores, how many, and its memory (note #356). Written by every
   * path that already reads a machine, never by a path that reads one just to
   * fill this in: the idle reaper's sweep (whose listing carries every
   * machine's guest for free), the details screen's own read, and an accepted
   * resize.
   *
   * OBSERVED, like `machineImage` directly above and for the same reason: the
   * fleet default is a config constant, and the point of keeping this is to
   * say what a machine actually IS — an owner who moved one rung up wants
   * their row to say so, not to be told what a new agent would have got.
   *
   * It exists so the fleet list can say it. A control-plane read per agent on
   * every state read is exactly what the version seed refuses to do, and a
   * shape changes about once in a machine's life, so the record is the right
   * place for it to live between the rare moments something looks.
   */
  machineSize?: { cpuKind: string; cpus: number; memoryMb: number };
  /**
   * When this shape was last WRITTEN — first observed, or changed since.
   * Deliberately not `...CheckedAt` like the image stamp above it: an
   * observation that agrees with the record writes nothing (a sweep sees
   * every machine every few minutes and a shape changes about once in a
   * machine's life), so a "checked" stamp would go stale while the value it
   * describes stayed true.
   */
  machineSizeAt?: string;
  /**
   * SHA-256 of the machine's `agentbuilt` CLI token (services/agentbuilt-token).
   * The plaintext lives only on the machine; the identity writer mints a fresh
   * token (replacing this hash) on every identity rewrite, and machine
   * rebuild/recycle clears it — that IS the revocation story.
   */
  agentbuiltTokenHash?: string;
  /**
   * A CLI call presented a WELL-FORMED token for this agent whose hash does
   * not match the record — the shape a deploy-interrupted identity write
   * leaves behind: machine and record holding different tokens with the
   * version already current, so no rewrite would ever fire again (live,
   * 2026-08-26, one machine locked out permanently). The turn-start
   * staleness check treats this flag exactly like a version mismatch, and
   * the successful rewrite clears it — which is what makes the 401's "try
   * again next turn" advice actually true.
   */
  agentbuiltTokenStale?: boolean;
  /**
   * Version of the identity block last written to this agent's machine
   * (see TELEGRAM_AGENT_IDENTITY_VERSION). A mismatch at turn start triggers
   * a background rewrite, so template improvements reach EXISTING machines
   * without waiting for a rename or roster change.
   */
  identityVersion?: number;
  /**
   * Short slug of the agent's branded preview hostname
   * (`<previewHostname>.agentbuilt.app`). Belongs to the AGENT, not the
   * machine: rebuilds/recycles re-point the same name at the replacement app,
   * so the branded link outlives the machine. Absent on agents provisioned
   * before preview domains existed (or when DNS isn't configured) — the
   * fly.dev URL is the fallback either way.
   */
  previewHostname?: string;
  /**
   * Platform pool credential this agent's machine currently holds (Codex:
   * whose auth.json is on disk). Leasing prefers it so a credential's
   * refreshed tokens stay on one machine instead of churning across the
   * fleet. Cleared/replaced when the pin gets benched and a different
   * credential is leased.
   */
  platformCredentialId?: string;
  /** Native CLI conversation continuity pointer. */
  conversation?: TelegramAgentConversation;
  /**
   * ISO timestamp of a confirmed sign-in. Absent until the setup agent
   * verifies the CLI is signed in; presence on the active agent is what routes
   * turns to the CLI harness instead of the setup agent.
   */
  connectedAt?: string;
  /**
   * Made WITH the workplace (note #144), before its owner had connected a
   * cloud or signed in a subscription: a named seat at the table and nothing
   * else — no machine, no money spent. The first subscription to land
   * decides what it runs (`cli` is a placeholder until then) and starts its
   * setup, which clears this in the same write. A planned record is skipped
   * by every pass that would otherwise build it a machine, and is the one
   * shape of agent a workplace may still be quick-deleted with.
   */
  planned?: true;
  /**
   * Public `https://<app>.fly.dev` URL when this agent has an ACTUALLY-published
   * live site (set by `expose_port`, cleared by `unexpose_port` once no ports
   * remain). Display/record only — shown in /agents so the user can find their
   * link. It does NOT keep the machine warm: the idle reaper stops idle
   * machines regardless (a machine is a workbench, not hosting; always-on
   * sites belong on the user's own infrastructure).
   */
  exposedUrl?: string;
  /** Internal ports currently published to the public internet (via `expose_port`). */
  exposedPorts?: number[];
  /**
   * Stamped when this agent is handed to the scoped interactive OAuth turn
   * (first of its CLI, a failed donor copy, or a harness auth failure that
   * paused it for re-authorization). While set on a
   * provisioned-but-unconnected agent, manager-chat messages fall through to
   * the setup agent so pasted verification codes reach it. Cleared when the
   * sign-in confirms. This replaced the legacy activeAgentId-clearing trick.
   */
  oauthPendingAt?: string;
  /**
   * ISO timestamp of the last thing that happened in THIS agent's chat.
   *
   * The account-level `telegram.lastActivityAt` can't distinguish a fleet the
   * user works across daily from one where a single agent carries all the
   * traffic and the rest were abandoned the day they were made — under it, one
   * active agent keeps every sibling's machine alive forever. This is what lets
   * the recycler judge agents individually.
   *
   * Written coarsely (see TELEGRAM_AGENT_ACTIVITY_THROTTLE_MS): the recycler
   * works in days, so a stamp per turn would be writes nobody reads. Absent on
   * agents that predate this field — the recycler falls back to account-level
   * activity for those, so they behave exactly as they did before.
   *
   * NOT a "last seen" clock, however it reads: up to an hour behind by design,
   * so anything shown to a user rounds it to days and asks the run registry
   * for whether the agent is working right now.
   */
  lastActivityAt?: string;
  /**
   * Stamped when the owner was warned that this agent's machine is about to be
   * recycled for inactivity, so the warning is sent once rather than on every
   * sweep. Cleared when the machine is recycled, when a fresh one is built, and
   * when the agent is used again — the last of those is what stops a second
   * idle stretch being recycled with no warning at all.
   */
  recycleWarnedAt?: string;
  /**
   * Observed machine runtime, ms, bucketed by UTC month (`"2026-07"`). Fed by
   * the idle reaper's sweep: every pass credits each machine it saw running
   * with the time since the previous pass, so accuracy is ±one sweep interval
   * per session — plenty for the question this answers ("what does this agent
   * actually cost us?"), and the raw material for usage-based pricing later.
   * Sampling beats start/stop events here: there is no pairing state to lose
   * when a machine dies or the backend restarts mid-session.
   *
   * Only the reaper's meter writes this field (single writer), so its
   * read-modify-write through updateAgentFields is race-free.
   */
  machineRuntimeMs?: Record<string, number>;
  /**
   * How full this agent's context window was at the end of its last turn —
   * the size of the last prompt actually sent, plus the model that received
   * it, because the window size is a property of the model and not of us.
   *
   * Per AGENT, not per session: the agents of one account share a session
   * document and are told apart by run key, so this would be six agents
   * overwriting one number if it lived there.
   *
   * Cleared when the conversation resets (`agentbuilt chat new`), because a
   * fresh chat is an empty window and a stale 78% would be a lie about the
   * conversation the user is now in.
   */
  contextUsage?: {
    /** Prompt tokens on the last request: input + cache reads + cache writes. */
    tokens: number;
    /** The concrete model the stream reported, e.g. `claude-opus-4-5-…`. */
    model?: string;
    /**
     * The window that prompt went into, when the CLI states one — Codex does,
     * and its figure is the one it enforces. Absent for a CLI that doesn't,
     * and then the window is looked up from the model instead.
     */
    window?: number;
    at: string;
  };
  /**
   * Where this agent's Codex thread's running token total stood after the
   * last turn the token ledger credited (agent/turn-tokens.ts). Codex only
   * reports cumulative totals, so a turn's spend is the total now less this.
   * Deliberately NOT cleared by a chat reset: the reset starts a new thread,
   * which the thread id already tells apart.
   */
  codexTokenBase?: import('../agent/turn-tokens.js').CodexTokenBase;
  /**
   * The same for Claude Code, whose `result` reports a per-model running
   * total for the conversation (agent/turn-tokens.ts): where it stood after
   * the last credited turn, keyed by the conversation it belongs to.
   */
  claudeTokenBase?: import('../agent/turn-tokens.js').ClaudeTokenBase;
  /**
   * Durable managed jobs running on this agent's machine when the backend last
   * looked (note #564). The fleet list cannot SSH into every machine per read,
   * so the count is recorded where the truth is already in hand: the end of a
   * turn, a jobs read from an open screen, and the idle sweep's final probe.
   */
  activeJobs?: { count: number; at: string };
  /**
   * Work turns admitted for this agent since turn counting was introduced.
   *
   * Kept on the agent rather than its native conversation so a chat reset
   * does not erase the lifetime total. Optional for records created before
   * the counter existed; their first later turn starts the count at one.
   */
  turnCount?: number;
  /**
   * When this agent's last work turn ENDED, ISO — the durable turn boundary
   * (note #455). The in-memory run registry says whether a turn is running
   * now, but it is emptied by a backend restart and refilled only as
   * pending turns are re-attached, so "not working" alone cannot mean "the
   * turn is over": a reader collecting the agent's reply would take the
   * text it had written so far and call it the answer. A stamp later than
   * the message that started the turn is the fact that the reply is whole.
   */
  lastTurnEndedAt?: string;
  /**
   * When that same turn STARTED, ISO, stamped in the same write as
   * `lastTurnEndedAt` (note #945): the chat's recap line says how long the
   * turn worked, and only a recap written since this moment is this turn's.
   */
  lastTurnStartedAt?: string;
  /**
   * When a recap summary last came back with a usable text, ISO — whether or
   * not it changed the recap (note #945). `recap.at` keeps answering "when
   * did the row last say something new"; this answers "has the summary for
   * the latest turn arrived", which an unchanged recap answers too.
   */
  recapCheckedAt?: string;
  /**
   * When the recap summarizer last judged this agent's work FINISHED — done,
   * with nothing waiting on anyone (note #707) — ISO. Written only by the
   * post-turn summary; cleared by one that judged otherwise and by a turn that
   * ended in a fresh chat, since there is no conversation left to reset.
   *
   * It counts only while it is LATER than `lastTurnEndedAt`: a summary that
   * failed (silence, by the recap contract) leaves the previous turn's verdict
   * here, and that verdict says nothing about the turn after it. Read through
   * `agentWorkFinished`, never on its own.
   */
  workFinishedAt?: string;
  /** ISO timestamp the record was created. */
  createdAt: string;
}
/**
 * A task line is longer than an `about` line and for the opposite reason: the
 * about line is WRITTEN to fit, and this one is CUT to fit, so the cut has to
 * fall past the point where a sentence has said what it is about. 90 lands
 * roughly two lines into a phone's width — the same wrap the about line above
 * it is allowed.
 */
export const TELEGRAM_AGENT_TASK_MAX_LENGTH = 90;

/**
 * Where the task line is actually CUT (note #73, Owner 2026-08-27).
 *
 * The 90 above is the ROW's size, and storing at the row's size meant the row's
 * size was all that ever existed — the agent screen's "Working on" could only
 * ever show what a row had room for. Worse than the recap's version of this
 * bug (note #67), because a recap is WRITTEN to fit and this is a person's own
 * message CUT to fit: a voice note runs for a paragraph, and at 90 characters
 * "[Voice message]: Так, ну давай предложи, как мы можем улучшить показатель
 * среднего…" stops before it ever says what was asked for.
 *
 * So the row keeps 90 — by clamping in CSS, where a cut costs nothing because
 * the words are still there — and what is written down keeps enough of the
 * request that the agent's own screen can answer "what did I ask it to do?".
 * Bounded, because this text comes from outside and nothing else caps it.
 */
export const TELEGRAM_AGENT_TASK_STORE_MAX_LENGTH = 400;

/**
 * The message that started a turn → the one line the Workspace row shows.
 *
 * Whitespace collapses (a three-paragraph brief becomes one line), control
 * characters go, and anything past the STORE cap is trimmed back to a word
 * boundary with an ellipsis — mid-word truncation reads as corruption, where
 * "…" reads as "there was more". The word boundary is only honoured in the
 * last 40% of the line: one unbroken token would otherwise collapse to nothing.
 *
 * The cut is at the store cap, not the row's (note #73). The row's 90 is a
 * LOOK, and it is enforced where looks belong — in CSS, on the row.
 *
 * Returns undefined for a message with no words in it at all (a bare photo),
 * which the caller answers for — a line saying nothing is worse than no line.
 */
export function summarizeTelegramAgentTask(content: string): string | undefined {
  const line = content.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line) {
    return undefined;
  }
  if (line.length <= TELEGRAM_AGENT_TASK_STORE_MAX_LENGTH) {
    return line;
  }
  const cut = line.slice(0, TELEGRAM_AGENT_TASK_STORE_MAX_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > TELEGRAM_AGENT_TASK_STORE_MAX_LENGTH * 0.6
    ? cut.slice(0, lastSpace)
    : cut;
  return `${kept.replace(/[\s,;:.!?-]+$/, '')}…`;
}

export function defaultTelegramAgentName(cli: AgentCli): string {
  return harnessName(cli);
}

/**
 * The pool of human names agents are christened from at creation. Human-like
 * names make agents approachable and remove the "come up with a name" friction
 * entirely — the user is never asked, and there is no "Main"/"Agent 2".
 * Deliberately excludes anything that collides with model names (sol, terra,
 * luna) or effort levels (max).
 *
 * Every name here must also have a face: adding one without the matching
 * backend/assets/agent-avatars/<name>.jpg is a REGRESSION, not a partial win.
 * Before this pool grew, the 21st agent was called "Kai 21" and reused Kai's
 * dog, so every agent had one; an avatar-less name gets the grey default
 * instead. The pool/asset pairing is enforced by a test, and the images come
 * from scripts/generate-agent-avatars.mjs.
 */
export const TELEGRAM_AGENT_NAME_POOL: readonly string[] = [
  'Alex', 'Leo', 'Theo', 'Felix', 'Oscar', 'Noah', 'Kai', 'Ben', 'Sam', 'Jack',
  'Mia', 'Zoe', 'Nora', 'Ivy', 'Emma', 'Eva', 'Nina', 'Ada', 'Ruby', 'Stella',
  'Milo', 'Hugo', 'Gus', 'Toby', 'Otis', 'Elias', 'Caleb', 'Isaac', 'Marcus', 'Rowan',
  'Iris', 'Hazel', 'Clara', 'Freya', 'Juno', 'Willow', 'Greta', 'Pearl', 'Sadie', 'Rosa',
];

/**
 * Pick a human name for a new agent: random among pool names the user isn't
 * already using (case-insensitive), so siblings never collide. Once the pool
 * is exhausted (agents are uncapped), falls back to a numbered pool name.
 */
export function pickTelegramAgentName(
  telegram: TelegramLinkState | undefined,
  random: () => number = Math.random,
): string {
  const taken = new Set(
    listAgents(telegram).map((agent) => agent.name.trim().toLowerCase()),
  );
  const available = TELEGRAM_AGENT_NAME_POOL.filter(
    (name) => !taken.has(name.toLowerCase()),
  );
  if (available.length === 0) {
    return `${TELEGRAM_AGENT_NAME_POOL[Math.floor(random() * TELEGRAM_AGENT_NAME_POOL.length)]} ${taken.size + 1}`;
  }
  return available[Math.floor(random() * available.length)];
}

export function listAgents(
  telegram: TelegramLinkState | undefined,
  includeWorkspace = false,
): AgentRecord[] {
  // Deterministic creation order (id tiebreak): the map's key order varies by
  // source — storage returns keys sorted, in-memory spreads move updated
  // agents to the end — and roster/switcher positions must never shuffle.
  return Object.values(telegram?.agents ?? {}).filter(a => includeWorkspace || !a.purpose).sort((a, b) => (
    (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)
  ));
}

/**
 * The single agent for a CLI, mirroring the old one-connection-per-CLI model.
 * The setup/menu flow keeps at most one agent per CLI, so this is unambiguous.
 */
export function getTelegramAgentByCli(
  telegram: TelegramLinkState | undefined,
  cli: AgentCli,
): AgentRecord | undefined {
  return listAgents(telegram).find((agent) => agent.cli === cli);
}

export interface EnsureTelegramAgentResult {
  /** A cloned agents map with the ensured agent present. */
  agents: Record<string, AgentRecord>;
  agentId: string;
  created: boolean;
}

/**
 * Find the agent for `cli` in the requested workplace, or create one.
 * With no org this preserves the legacy one-agent-per-CLI lookup. Returns a
 * cloned agents map so callers can persist it via updateProfile without
 * mutating the loaded profile.
 */
export function ensureAgentForCli(
  telegram: TelegramLinkState | undefined,
  cli: AgentCli,
  makeId: () => string = () => randomUUID(),
  orgId?: string,
): EnsureTelegramAgentResult {
  const agents: Record<string, AgentRecord> = { ...(telegram?.agents ?? {}) };
  const existing = Object.values(agents).find((agent) => (
    agent.cli === cli && (!orgId || agent.orgId === orgId)
  ));
  if (existing) {
    return { agents, agentId: existing.id, created: false };
  }
  const id = makeId();
  agents[id] = {
    id,
    name: pickTelegramAgentName(telegram),
    cli,
    turnCount: 0,
    ...(orgId ? { orgId } : {}),
    createdAt: new Date().toISOString(),
  };
  return { agents, agentId: id, created: true };
}

/**
 * Always create a NEW agent record (new id). Unlike
 * {@link ensureAgentForCli}, this never reuses an existing agent of
 * the same CLI — same-CLI agents are allowed (e.g. two Claude Code agents on
 * separate machines), and each is its own switchable record. Returns a cloned
 * agents map.
 */
export function addTelegramAgentRecord(
  telegram: TelegramLinkState | undefined,
  cli: AgentCli,
  name?: string,
  makeId: () => string = () => randomUUID(),
  orgId?: string,
  /** A model and effort chosen at creation (note #757); absent, the defaults. */
  runtime?: { model?: string; effort?: string },
  /** A sealed kind (note #1010), only ever set here. */
  sealed?: SealedAgentKind,
): { agents: Record<string, AgentRecord>; agentId: string } {
  const agents: Record<string, AgentRecord> = { ...(telegram?.agents ?? {}) };
  const id = makeId();
  agents[id] = {
    id,
    // An explicit name wins (the user asked for it); otherwise christen from
    // the human-name pool — the user is never asked to invent one.
    name: name?.trim() || pickTelegramAgentName(telegram),
    cli,
    turnCount: 0,
    ...(runtime?.model ? { model: runtime.model } : {}),
    ...(runtime?.effort ? { effort: runtime.effort } : {}),
    ...(orgId ? { orgId } : {}),
    ...(sealed ? { sealed } : {}),
    createdAt: new Date().toISOString(),
  };
  return { agents, agentId: id };
}

export interface TelegramMemoryState {
  storagePath: string;
  versionStoragePath?: string;
  version: number;
  updatedAt: string;
  lastDreamAt: string;
  lastLoadedAt?: string;
  sourceSessionId?: string;
  sourceMessageCount?: number;
  sha256?: string;
}

export interface TelegramSkillsState {
  storagePath: string;
  versionStoragePath?: string;
  version: number;
  updatedAt: string;
  lastLoadedAt?: string;
  sourceSessionId?: string;
  sourceMessageCount?: number;
  sha256?: string;
}

export interface AgentMessagingPolicyState {
  inboundEnabled?: boolean;
  allowUnknownSenders?: boolean;
  contacts?: string[];
  contactNames?: Record<string, string>;
  allowedUsernames?: string[];
  blockedUsernames?: string[];
}

export interface ResolvedAgentMessagingPolicy {
  inboundEnabled: boolean;
  allowUnknownSenders: boolean;
  contacts: string[];
  contactNames: Record<string, string>;
  allowedUsernames: string[];
  blockedUsernames: string[];
}

function normalizeMessagingUsernameList(usernames: string[] | undefined): string[] {
  if (!Array.isArray(usernames)) {
    return [];
  }

  const normalized = usernames
    .map((username) => normalizeAgentUsername(String(username ?? '')))
    .filter(Boolean);

  return [...new Set(normalized)];
}

function normalizeMessagingContactName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function normalizeMessagingContactNames(
  contactNames: Record<string, string> | undefined,
  contacts: string[],
): Record<string, string> {
  if (!contactNames || typeof contactNames !== 'object' || Array.isArray(contactNames)) {
    return {};
  }

  const contactSet = new Set(contacts);
  const normalizedEntries = Object.entries(contactNames)
    .map(([username, name]) => {
      const normalizedUsername = normalizeAgentUsername(username);
      const normalizedName = normalizeMessagingContactName(name);
      return normalizedUsername && normalizedName && contactSet.has(normalizedUsername)
        ? [normalizedUsername, normalizedName]
        : null;
    })
    .filter((entry): entry is [string, string] => Boolean(entry));

  return Object.fromEntries(normalizedEntries);
}

export function resolveAgentMessagingPolicy(
  policy?: AgentMessagingPolicyState | null,
): ResolvedAgentMessagingPolicy {
  const contacts = normalizeMessagingUsernameList(policy?.contacts);
  const contactNames = normalizeMessagingContactNames(policy?.contactNames, contacts);
  const blockedUsernames = normalizeMessagingUsernameList(policy?.blockedUsernames);
  const blockedSet = new Set(blockedUsernames);
  const allowedUsernames = normalizeMessagingUsernameList(policy?.allowedUsernames)
    .filter((username) => !blockedSet.has(username));

  return {
    inboundEnabled: policy?.inboundEnabled !== false,
    allowUnknownSenders: policy?.allowUnknownSenders !== false,
    contacts,
    contactNames,
    allowedUsernames,
    blockedUsernames,
  };
}

/**
 * The user's own profile picture, kept on the same media rails as note files:
 * bytes in the org-routed store under `users/<userId>/profile/…`, only the
 * pointer here. Replaced whole on every change — the old object is deleted
 * best-effort after the pointer moves.
 */
export interface PersonPhotoState {
  storagePath: string;
  contentType: string;
  sizeBytes: number;
  updatedAt: string;
  /** Where the picture came from: their Telegram photo, or a file they chose. */
  source: 'telegram' | 'upload';
}

/**
 * Who this account IS, as teammates should see them (note #57): the name and
 * face shown beside everything their agents do, in the user's own words from
 * the profile screen.
 */
export interface PersonProfileState {
  firstName?: string;
  lastName?: string;
  photo?: PersonPhotoState;
  /** When they last saved the profile screen — the "asked and answered" stamp. */
  confirmedAt?: string;
  /** Their X handle, without the @, for the Follow on X pill on their page.
   *  (A `leaderboard` flag may still sit beside it on older profiles: the
   *  public Leaderboard's switch, read by nothing since note #824.) */
  x?: string;
}

/** A profile name field never needs more than this. */
export const PERSON_NAME_MAX_LENGTH = 64;

/** Profile pictures and org avatars: big enough for any phone photo export. */
export const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** The picture types every phone produces and every <img> renders. */
export const PROFILE_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Where a user's profile photo lives — under their own owner prefix, so the
 *  org media router files it with the rest of their bytes. */
export function personPhotoPath(userId: string, photoId: string): string {
  return ['users', userId, 'profile', photoId].join('/');
}

/**
 * The one way this product turns an account into a person's name, everywhere
 * a human is named: profile-screen names first (their own words), then the
 * sign-up displayName.
 */
export function personDisplayName(profile: UserProfileDocument | null | undefined): string {
  const person = profile?.person;
  const full = [person?.firstName?.trim(), person?.lastName?.trim()].filter(Boolean).join(' ');
  return full || profile?.displayName?.trim() || 'Member';
}

/**
 * Whether the profile still needs the owner's minute (note #57 requires a
 * first name, a last name and a picture): true until all three are there.
 */
export function personProfileIncomplete(profile: UserProfileDocument | null | undefined): boolean {
  const person = profile?.person;
  return !(person?.firstName?.trim() && person?.lastName?.trim() && person?.photo);
}

export interface UserProfileDocument {
  userId: string;
  email: string;
  displayName: string;
  photoURL: string;
  username?: string;
  authType?: 'google' | 'email' | 'anonymous_totp';
  roles?: UserRoleState;
  onboardingCompletedAt?: string | null;
  /**
   * The owner's own git credential — the "laptop key". Minted only in the
   * Mini App (shown once there, never in chat or an agent transcript); only
   * the hash is stored, and minting again is the rotation. Verified by
   * /git/verify like every other git credential. See human-git-token.ts.
   */
  gitAccess?: {
    tokenHash: string;
    createdAt: string;
  };
  telegram?: TelegramLinkState;
  telegramMemory?: TelegramMemoryState;
  telegramSkills?: TelegramSkillsState;
  agentMessaging?: AgentMessagingPolicyState;
  /** The human's own name and face — see PersonProfileState. */
  person?: PersonProfileState;
  /**
   * The site that sent this person's browser to us on its first visit, and
   * the first page it opened (shared/first-visit.ts), as it arrived with the
   * account-creation request. Absent for accounts made before 2026-10-09 and
   * for browsers that keep nothing.
   */
  firstVisit?: FirstVisit;

  createdAt: any;
  updatedAt: any;
}
