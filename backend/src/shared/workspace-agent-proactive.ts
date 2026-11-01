/**
 * A proactive Chief of Staff (note #716): event turns and standing
 * permissions, the two pieces the owner chose on 2026-10-11 ("you should be
 * more proactive").
 *
 * EVENT TURNS. The platform starts a turn of the person's Workspace Agent,
 * with nobody writing, when something in the workplace changes state without
 * the person: checks go red on a proposal, a proposal waits for their
 * decision, an agent's report goes unanswered, a note stays unclaimed, an
 * agent's turn fails or an agent finishes without answering the Workspace
 * Agent, mail arrives. The turn is quiet unless the agent decides the person
 * must hear.
 *
 * STANDING PERMISSIONS. A short list, owned by the person, of things the
 * agent may do in such a turn without asking. Everything else stays a
 * question for them, and the platform refuses it in an event turn.
 *
 * Pure: no DOM, no framework, importable from Node and the browser alike —
 * the Workplace window draws and edits the same shape the server stores.
 */

/** What can start an event turn. */
export type WorkspaceAgentEventKind =
  | 'checks-red'
  | 'proposal-waiting'
  | 'report-unanswered'
  | 'note-unclaimed'
  | 'turn-failed'
  | 'no-reply'
  | 'mail'
  | 'schedule-cap'
  | 'schedule-failed'
  | 'schedule-subscription';

/** Every kind, in the order the Workplace window lists them. */
export const WORKSPACE_AGENT_EVENT_KINDS: readonly WorkspaceAgentEventKind[] = [
  'checks-red', 'proposal-waiting', 'report-unanswered', 'note-unclaimed', 'turn-failed', 'no-reply', 'mail',
  'schedule-cap', 'schedule-failed', 'schedule-subscription',
];

/** The kinds that still start a turn inside the person's quiet hours. */
export const QUIET_HOURS_EXEMPT: ReadonlySet<WorkspaceAgentEventKind> = new Set(['checks-red', 'turn-failed', 'schedule-failed', 'schedule-subscription']);

/** One thing the platform noticed, as it is handed to the agent. */
export interface WorkspaceAgentEvent {
  kind: WorkspaceAgentEventKind;
  /**
   * The cause, as the once-a-day rule counts it: the same key never starts
   * a second turn within a day. A key names its episode — a proposal's
   * red sha, one report, one letter — so a new push, a new report or a new
   * letter is a new cause, and a cause that persists (a proposal still
   * waiting) comes back the next day under the next day's key.
   */
  key: string;
  /** One plain sentence the agent reads: who, what, how long, with numbers. */
  text: string;
  /** When the state it describes began. */
  at: string;
  /** The Workspace screen it is about, when there is one. */
  href?: string;
}

/** The person's standing permissions: what the agent may do in an event turn without asking. */
export type WorkspaceAgentPermission =
  | 'reset-finished-agent'
  | 'hand-unclaimed-note'
  | 'ask-silent-agent'
  | 'archive-finished-note';

export const WORKSPACE_AGENT_PERMISSIONS: readonly WorkspaceAgentPermission[] = [
  'reset-finished-agent', 'hand-unclaimed-note', 'ask-silent-agent', 'archive-finished-note',
];

/** What each permission says, in the Workplace window and in the agent's prompt alike. */
export const WORKSPACE_AGENT_PERMISSION_WORDS: Record<WorkspaceAgentPermission, { title: string; detail: string }> = {
  'reset-finished-agent': {
    title: 'Reset a finished agent’s chat',
    detail: 'When its work is merged or live, nothing is open and no reply is awaited.',
  },
  'hand-unclaimed-note': {
    title: 'Hand an unclaimed note to a free agent',
    detail: 'When the note is a clear request; it tells you which agent got it.',
  },
  'ask-silent-agent': {
    title: 'Ask a silent agent to report',
    detail: 'When an agent it was waiting for finished without answering.',
  },
  'archive-finished-note': {
    title: 'Archive a finished note',
    detail: 'When the note is live and its last comment says nothing is open.',
  },
};

/** How long a state must hold before it is an event, in hours. */
export interface WorkspaceAgentEventThresholds {
  /** A proposal awaiting the person's decision. */
  proposalHours: number;
  /** An agent's report the person has not answered in that agent's chat. */
  reportHours: number;
  /** A note nobody has picked up. */
  noteHours: number;
}

export const DEFAULT_EVENT_THRESHOLDS: WorkspaceAgentEventThresholds = { proposalHours: 24, reportHours: 24, noteHours: 48 };

/** The choices the Workplace window offers for a threshold. */
export const EVENT_THRESHOLD_CHOICES: readonly number[] = [6, 12, 24, 48, 72];

/** The person's settings for both pieces, as stored on their membership. */
export interface WorkspaceAgentProactive {
  /** Event turns on. Off until the person turns them on: each is a model turn on their subscription. */
  events: boolean;
  thresholds: WorkspaceAgentEventThresholds;
  /** Quiet hours, whole hours in `timeZone`, from `quietFrom` up to `quietTo`. Equal means none. */
  quietFrom: number;
  quietTo: number;
  /** The person's IANA time zone, taken from their browser when they save. */
  timeZone: string;
  permissions: Record<WorkspaceAgentPermission, boolean>;
}

export const DEFAULT_WORKSPACE_AGENT_PROACTIVE: WorkspaceAgentProactive = {
  events: false,
  thresholds: DEFAULT_EVENT_THRESHOLDS,
  quietFrom: 23,
  quietTo: 8,
  timeZone: 'UTC',
  permissions: { 'reset-finished-agent': false, 'hand-unclaimed-note': false, 'ask-silent-agent': false, 'archive-finished-note': false },
};

/** A time zone the runtime knows, or null. */
export function validTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() });
    return value.trim();
  } catch {
    return null;
  }
}

const hour = (value: unknown, fallback: number): number => (
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 23 ? value as number : fallback
);
const threshold = (value: unknown, fallback: number): number => (
  EVENT_THRESHOLD_CHOICES.includes(value as number) ? value as number : fallback
);

/** The stored settings with every absent or malformed field at its default. */
export function resolveWorkspaceAgentProactive(stored: unknown): WorkspaceAgentProactive {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Partial<Record<keyof WorkspaceAgentProactive, unknown>>;
  const defaults = DEFAULT_WORKSPACE_AGENT_PROACTIVE;
  const thresholds = (raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {}) as Partial<Record<keyof WorkspaceAgentEventThresholds, unknown>>;
  const permissions = (raw.permissions && typeof raw.permissions === 'object' ? raw.permissions : {}) as Partial<Record<WorkspaceAgentPermission, unknown>>;
  return {
    events: raw.events === true,
    thresholds: {
      proposalHours: threshold(thresholds.proposalHours, defaults.thresholds.proposalHours),
      reportHours: threshold(thresholds.reportHours, defaults.thresholds.reportHours),
      noteHours: threshold(thresholds.noteHours, defaults.thresholds.noteHours),
    },
    quietFrom: hour(raw.quietFrom, defaults.quietFrom),
    quietTo: hour(raw.quietTo, defaults.quietTo),
    timeZone: validTimeZone(raw.timeZone) ?? defaults.timeZone,
    permissions: Object.fromEntries(WORKSPACE_AGENT_PERMISSIONS.map((p) => [p, permissions[p] === true])) as Record<WorkspaceAgentPermission, boolean>,
  };
}

/**
 * A change the person sent, checked field by field against what is stored:
 * a field that is absent keeps its value, a field that is present must be
 * valid. Returns the whole new value, or the first refusal in words.
 */
export function applyWorkspaceAgentProactiveChange(current: WorkspaceAgentProactive, body: unknown): { ok: true; value: WorkspaceAgentProactive } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Send the settings to change.' };
  const change = body as Record<string, unknown>;
  const next: WorkspaceAgentProactive = structuredClone(current);
  if ('events' in change) {
    if (typeof change.events !== 'boolean') return { ok: false, error: '`events` is on or off.' };
    next.events = change.events;
  }
  for (const field of ['quietFrom', 'quietTo'] as const) {
    if (!(field in change)) continue;
    const value = change[field];
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 23) return { ok: false, error: 'Quiet hours are whole hours from 0 to 23.' };
    next[field] = value as number;
  }
  if ('timeZone' in change) {
    const zone = validTimeZone(change.timeZone);
    if (!zone) return { ok: false, error: 'That time zone is not one this server knows.' };
    next.timeZone = zone;
  }
  if ('thresholds' in change) {
    const thresholds = change.thresholds;
    if (!thresholds || typeof thresholds !== 'object') return { ok: false, error: 'Send the thresholds as hours.' };
    for (const [field, value] of Object.entries(thresholds as Record<string, unknown>)) {
      if (!(field in next.thresholds)) return { ok: false, error: `There is no threshold called ${field}.` };
      if (!EVENT_THRESHOLD_CHOICES.includes(value as number)) return { ok: false, error: `A threshold is one of ${EVENT_THRESHOLD_CHOICES.join(', ')} hours.` };
      next.thresholds[field as keyof WorkspaceAgentEventThresholds] = value as number;
    }
  }
  if ('permissions' in change) {
    const permissions = change.permissions;
    if (!permissions || typeof permissions !== 'object') return { ok: false, error: 'Send each permission as on or off.' };
    for (const [field, value] of Object.entries(permissions as Record<string, unknown>)) {
      if (!WORKSPACE_AGENT_PERMISSIONS.includes(field as WorkspaceAgentPermission)) return { ok: false, error: `There is no permission called ${field}.` };
      if (typeof value !== 'boolean') return { ok: false, error: 'Each permission is on or off.' };
      next.permissions[field as WorkspaceAgentPermission] = value;
    }
  }
  return { ok: true, value: next };
}

/** The hour of the day, 0–23, in `timeZone` at `now`. */
export function hourIn(timeZone: string, now: Date): number {
  const text = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now);
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed % 24 : now.getUTCHours();
}

/** The calendar day, YYYY-MM-DD, in `timeZone` at `now` — the "per day" the once-a-day rule counts. */
export function dayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Whether `now` falls inside the person's quiet hours (a window may cross midnight). */
export function inQuietHours(settings: Pick<WorkspaceAgentProactive, 'quietFrom' | 'quietTo' | 'timeZone'>, now: Date): boolean {
  const { quietFrom: from, quietTo: to } = settings;
  if (from === to) return false;
  const h = hourIn(settings.timeZone, now);
  return from < to ? h >= from && h < to : h >= from || h < to;
}

/** One event turn, as the Workplace window lists it under "Noticed lately". */
export interface WorkspaceAgentEventTurnSummary {
  at: string;
  /** What the platform noticed, one sentence per event. */
  noticed: string[];
  /** What came of it: told the person in the chat, kept quiet, or could not run. */
  outcome: 'told' | 'quiet' | 'failed' | 'running';
  /** The agent's own words: its quiet line, or the start of what it told them. */
  summary?: string;
  /** Actions it recorded in that turn. */
  actions: number;
}

/** GET/PUT api/recap/agent/proactive. */
export interface WorkspaceAgentProactiveAnswer {
  orgId: string;
  settings: WorkspaceAgentProactive;
  /** Newest first, at most a handful. */
  recent: WorkspaceAgentEventTurnSummary[];
}
