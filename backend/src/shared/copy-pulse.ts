/**
 * The daily pulse of a private copy, as our side keeps and reads it (notes
 * #1056, #1057, #1058).
 *
 * A copy (a company's own Agentic Cloud) sends us one small report a day, at
 * every boot, and when its contact changes: counts only, plus the contact
 * person its admin gave on purpose. The copy side and the receiving route
 * are note #1057's; this module is the contract both sides build against:
 * the pulse's exact shape and its check (`parseCopyPulse`), what the Copies
 * screen shows for one copy (`copyRow`), and when a copy is worth a line in
 * the Chief of Staff's chat (`copyConditions`).
 *
 * Pure: no storage, no clock but the one passed in.
 */

export const COPY_CLIS = ['claude', 'codex', 'opencode'] as const;
export type CopyCli = typeof COPY_CLIS[number];
export type CopyCounts = Record<CopyCli, number>;

export const COPY_PULSE_REASONS = ['daily', 'boot', 'contact-changed'] as const;
export type CopyPulseReason = typeof COPY_PULSE_REASONS[number];

/** One pulse, exactly as a copy sends it (note #1057). */
export interface CopyPulse {
  copyId: string;
  domain: string;
  contactName: string;
  contactEmail: string;
  sentAt: string;
  reason: CopyPulseReason;
  /** The release the copy runs, e.g. 2026.11.06.0; null when it does not know. */
  release: string | null;
  /** The copy's own update check: current, behind, unknown or off. */
  updatesState: string;
  /** False on the one last pulse a copy sends when its admin turns the pulse off. */
  pulseEnabled: boolean;
  people: number;
  agentsByCli: CopyCounts;
  turnsLast24hByCli: CopyCounts;
  machineHours24h: number;
  sitesLive: number;
  lastActivityAt: string | null;
  health: {
    backupAgeHours: number | null;
    diskFreePercent: number | null;
    state: string;
  };
}

/** A pulse as stored: what arrived, and when it did. */
export interface StoredCopyPulse extends CopyPulse {
  receivedAt: string;
}

/** One copy as the store holds it: its newest pulse and when we first and last heard from it. */
export interface CopyPulseRecord {
  copyId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  pulse: StoredCopyPulse;
}

/** One day of a copy's history: the last pulse that arrived that day (UTC). */
export interface CopyPulseDay {
  copyId: string;
  /** YYYY-MM-DD, the UTC day the pulse arrived. */
  day: string;
  lastSeenAt: string;
  pulse: StoredCopyPulse;
}

/** A copy that has not been heard from for this long is silent. */
export const COPY_SILENT_HOURS = 72;
/** This many offered releases newer than the one a copy runs is worth a word. */
export const COPY_BEHIND_RELEASES = 2;
/** A database backup older than this is trouble. */
export const COPY_BACKUP_HOURS = 48;
/** Less free disk than this, in percent, is trouble. */
export const COPY_DISK_PERCENT = 10;
/** A first pulse older than this is history, not news. */
export const COPY_FIRST_PULSE_NEWS_HOURS = 72;

const RELEASE_SHAPE = /^\d{4}\.\d{2}\.\d{2}\.\d{1,3}$/;
const COPY_ID_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;
const DOMAIN_SHAPE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EMAIL_SHAPE = /^[^\s@<>]{1,64}@[^\s@<>]{1,253}$/;

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9;
const isIso = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

function counts(value: unknown): CopyCounts | null {
  if (!value || typeof value !== 'object') return null;
  const out = {} as CopyCounts;
  for (const cli of COPY_CLIS) {
    const n = (value as Record<string, unknown>)[cli] ?? 0;
    if (!isCount(n)) return null;
    out[cli] = Math.round(n);
  }
  return out;
}

/**
 * The pulse a body carries, or why it is not one. Only the fields of the
 * contract are kept, so nothing a copy adds beyond it is ever stored. The
 * signature is checked before this, by the receiving route.
 */
export function parseCopyPulse(body: unknown): { ok: true; pulse: CopyPulse } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'A pulse is a JSON object.' };
  const doc = body as Record<string, unknown>;
  const text = (key: string, max: number): string | null => {
    const value = doc[key];
    return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
  };
  const copyId = text('copyId', 64);
  if (!copyId || !COPY_ID_SHAPE.test(copyId)) return { ok: false, error: 'copyId is missing or not a copy id.' };
  const domain = text('domain', 253)?.toLowerCase() ?? null;
  if (!domain || !DOMAIN_SHAPE.test(domain)) return { ok: false, error: 'domain is missing or not a domain.' };
  const contactName = text('contactName', 120);
  if (!contactName) return { ok: false, error: 'contactName is missing.' };
  const contactEmail = text('contactEmail', 254);
  if (!contactEmail || !EMAIL_SHAPE.test(contactEmail)) return { ok: false, error: 'contactEmail is missing or not an address.' };
  if (!isIso(doc.sentAt)) return { ok: false, error: 'sentAt is missing or not a time.' };
  if (!COPY_PULSE_REASONS.includes(doc.reason as CopyPulseReason)) return { ok: false, error: 'reason is not daily, boot or contact-changed.' };
  const release = doc.release === null || doc.release === undefined ? null : text('release', 20);
  if (release !== null && !RELEASE_SHAPE.test(release)) return { ok: false, error: 'release is not a release version.' };
  const updatesState = text('updatesState', 20) ?? 'unknown';
  if (typeof doc.pulseEnabled !== 'boolean') return { ok: false, error: 'pulseEnabled is not true or false.' };
  if (!isCount(doc.people)) return { ok: false, error: 'people is not a count.' };
  const agentsByCli = counts(doc.agentsByCli);
  if (!agentsByCli) return { ok: false, error: 'agentsByCli is not counts by CLI.' };
  const turnsLast24hByCli = counts(doc.turnsLast24hByCli);
  if (!turnsLast24hByCli) return { ok: false, error: 'turnsLast24hByCli is not counts by CLI.' };
  if (!isCount(doc.machineHours24h)) return { ok: false, error: 'machineHours24h is not a number.' };
  if (!isCount(doc.sitesLive)) return { ok: false, error: 'sitesLive is not a count.' };
  if (doc.lastActivityAt !== null && doc.lastActivityAt !== undefined && !isIso(doc.lastActivityAt)) return { ok: false, error: 'lastActivityAt is not a time.' };
  const health = doc.health as Record<string, unknown> | undefined;
  if (!health || typeof health !== 'object') return { ok: false, error: 'health is missing.' };
  const optionalNumber = (value: unknown): number | null | undefined => (value === null || value === undefined ? null : isCount(value) ? value : undefined);
  const backupAgeHours = optionalNumber(health.backupAgeHours);
  const diskFreePercent = optionalNumber(health.diskFreePercent);
  if (backupAgeHours === undefined) return { ok: false, error: 'health.backupAgeHours is not a number.' };
  if (diskFreePercent === undefined || (diskFreePercent !== null && diskFreePercent > 100)) return { ok: false, error: 'health.diskFreePercent is not a percentage.' };
  const state = typeof health.state === 'string' && health.state.trim() ? health.state.trim().slice(0, 40) : 'unknown';
  return {
    ok: true,
    pulse: {
      copyId, domain, contactName, contactEmail, sentAt: new Date(doc.sentAt as string).toISOString(), reason: doc.reason as CopyPulseReason,
      release, updatesState, pulseEnabled: doc.pulseEnabled,
      people: Math.round(doc.people), agentsByCli, turnsLast24hByCli,
      machineHours24h: Math.round(doc.machineHours24h * 10) / 10, sitesLive: Math.round(doc.sitesLive),
      lastActivityAt: doc.lastActivityAt ? new Date(doc.lastActivityAt as string).toISOString() : null,
      health: { backupAgeHours, diskFreePercent, state },
    },
  };
}

/** Newer first is positive: 2026.11.03.0 vs 2026.11.01.1 → > 0. */
function compareRelease(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** How many offered releases are newer than `release`; null when either is unknown. */
export function releasesBehind(release: string | null, offered: readonly string[] | null): number | null {
  if (!release || !offered || !offered.length) return null;
  return offered.filter((version) => compareRelease(version, release) > 0).length;
}

export const sumCounts = (value: CopyCounts): number => COPY_CLIS.reduce((total, cli) => total + (value[cli] ?? 0), 0);

export type CopyStanding = 'live' | 'silent' | 'opted-out';

/** One row of the Copies screen. */
export interface WorkspaceCopyRow {
  copyId: string;
  domain: string;
  contactName: string;
  contactEmail: string;
  release: string | null;
  /** Offered releases newer than the one it runs; null when not known. */
  releasesBehind: number | null;
  updatesState: string;
  people: number;
  agents: number;
  agentsByCli: CopyCounts;
  turns24h: number;
  turnsLast24hByCli: CopyCounts;
  machineHours24h: number;
  sitesLive: number;
  lastActivityAt: string | null;
  lastSeenAt: string;
  firstSeenAt: string;
  /** Live, silent for three days, or its admin turned the pulse off. */
  standing: CopyStanding;
  health: {
    state: 'ok' | 'trouble' | 'unknown';
    /** What is wrong, one short phrase each; empty when nothing is. */
    problems: string[];
    backupAgeHours: number | null;
    diskFreePercent: number | null;
  };
}

/** GET api/copies */
export interface WorkspaceCopiesAnswer {
  copies: WorkspaceCopyRow[];
  /** The newest release we offer, when the update service answered. */
  latestRelease: string | null;
}

/** One day of a copy's history, on its own screen. */
export interface WorkspaceCopyDay {
  day: string;
  release: string | null;
  people: number;
  agents: number;
  turns24h: number;
  machineHours24h: number;
  sitesLive: number;
  backupAgeHours: number | null;
  diskFreePercent: number | null;
  pulseEnabled: boolean;
}

/** GET api/copies/:copyId */
export interface WorkspaceCopyAnswer {
  copy: WorkspaceCopyRow;
  latestRelease: string | null;
  /** Newest first, up to sixty days. */
  days: WorkspaceCopyDay[];
}

const hoursBetween = (from: string, now: Date): number => (now.getTime() - Date.parse(from)) / 3_600_000;

/** What a copy's health is, by our thresholds and its own word. */
export function copyHealth(pulse: Pick<CopyPulse, 'health'>): WorkspaceCopyRow['health'] {
  const { backupAgeHours, diskFreePercent, state } = pulse.health;
  const problems: string[] = [];
  if (backupAgeHours !== null && backupAgeHours > COPY_BACKUP_HOURS) problems.push(`backup ${Math.floor(backupAgeHours / 24)} days old`);
  if (diskFreePercent !== null && diskFreePercent < COPY_DISK_PERCENT) problems.push(`disk ${Math.round(diskFreePercent)}% free`);
  const said = state.toLowerCase();
  if (!problems.length && said !== 'ok' && said !== 'unknown') problems.push(`says ${state}`);
  return {
    state: problems.length ? 'trouble' : said === 'ok' ? 'ok' : 'unknown',
    problems, backupAgeHours, diskFreePercent,
  };
}

export function copyStanding(record: Pick<CopyPulseRecord, 'lastSeenAt' | 'pulse'>, now: Date): CopyStanding {
  if (!record.pulse.pulseEnabled) return 'opted-out';
  return hoursBetween(record.lastSeenAt, now) >= COPY_SILENT_HOURS ? 'silent' : 'live';
}

export function copyRow(record: CopyPulseRecord, offered: readonly string[] | null, now: Date): WorkspaceCopyRow {
  const { pulse } = record;
  return {
    copyId: record.copyId,
    domain: pulse.domain,
    contactName: pulse.contactName,
    contactEmail: pulse.contactEmail,
    release: pulse.release,
    releasesBehind: releasesBehind(pulse.release, offered),
    updatesState: pulse.updatesState,
    people: pulse.people,
    agents: sumCounts(pulse.agentsByCli),
    agentsByCli: pulse.agentsByCli,
    turns24h: sumCounts(pulse.turnsLast24hByCli),
    turnsLast24hByCli: pulse.turnsLast24hByCli,
    machineHours24h: pulse.machineHours24h,
    sitesLive: pulse.sitesLive,
    lastActivityAt: pulse.lastActivityAt,
    lastSeenAt: record.lastSeenAt,
    firstSeenAt: record.firstSeenAt,
    standing: copyStanding(record, now),
    health: copyHealth(pulse),
  };
}

/** The Copies screen's order: the copy heard from most recently first. */
export function sortCopies(rows: WorkspaceCopyRow[]): WorkspaceCopyRow[] {
  return [...rows].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || a.domain.localeCompare(b.domain));
}

export function copyDay(day: CopyPulseDay): WorkspaceCopyDay {
  const { pulse } = day;
  return {
    day: day.day, release: pulse.release, people: pulse.people, agents: sumCounts(pulse.agentsByCli),
    turns24h: sumCounts(pulse.turnsLast24hByCli), machineHours24h: pulse.machineHours24h, sitesLive: pulse.sitesLive,
    backupAgeHours: pulse.health.backupAgeHours, diskFreePercent: pulse.health.diskFreePercent, pulseEnabled: pulse.pulseEnabled,
  };
}

// ── Alerts (note #1058) ──

/**
 * The conditions worth a line in the Chief of Staff's chat. Each is raised
 * ONCE per copy while it holds, and may be raised again only after it has
 * cleared (the ledger is the store's copy_pulse_alerts). `first-pulse` never
 * clears: a copy is new once.
 */
export const COPY_ALERT_CONDITIONS = ['first-pulse', 'silent', 'behind', 'backup', 'disk', 'opted-out'] as const;
export type CopyAlertCondition = typeof COPY_ALERT_CONDITIONS[number];

export interface CopyAlert {
  condition: CopyAlertCondition;
  /** One plain sentence: which copy, what, with numbers, and who to write to. */
  text: string;
}

const day = (iso: string): string => {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]}`;
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Which conditions hold for one copy right now, and which cannot be told
 * (a release count with no release list): an unknown condition is neither
 * raised nor cleared.
 */
export function copyConditions(record: CopyPulseRecord, offered: readonly string[] | null, now: Date): { holding: CopyAlert[]; unknown: CopyAlertCondition[] } {
  const { pulse } = record;
  const who = `${pulse.contactName} <${pulse.contactEmail}>`;
  const holding: CopyAlert[] = [];
  const unknown: CopyAlertCondition[] = [];
  if (hoursBetween(record.firstSeenAt, now) <= COPY_FIRST_PULSE_NEWS_HOURS) {
    holding.push({
      condition: 'first-pulse',
      text: `A new private copy sent its first pulse: ${pulse.domain}, run by ${who}, release ${pulse.release ?? 'unknown'}, ${plural(pulse.people, 'person', 'people')}, ${plural(sumCounts(pulse.agentsByCli), 'agent')}.`,
    });
  }
  if (!pulse.pulseEnabled) {
    holding.push({
      condition: 'opted-out',
      text: `The private copy at ${pulse.domain} turned its daily pulse off on ${day(pulse.sentAt)}; its row keeps the last numbers it sent. Contact: ${who}.`,
    });
  } else {
    const silentHours = hoursBetween(record.lastSeenAt, now);
    if (silentHours >= COPY_SILENT_HOURS) {
      holding.push({
        condition: 'silent',
        text: `The private copy at ${pulse.domain} has been silent for ${plural(Math.floor(silentHours / 24), 'day')}: its last pulse came on ${day(record.lastSeenAt)}. Contact: ${who}.`,
      });
    }
  }
  const behind = releasesBehind(pulse.release, offered);
  if (behind === null) unknown.push('behind');
  else if (behind >= COPY_BEHIND_RELEASES) {
    holding.push({
      condition: 'behind',
      text: `The private copy at ${pulse.domain} runs ${pulse.release}, ${behind} releases behind the latest ${offered!.at(-1)}. Contact: ${who}.`,
    });
  }
  const { backupAgeHours, diskFreePercent } = pulse.health;
  if (backupAgeHours !== null && backupAgeHours > COPY_BACKUP_HOURS) {
    holding.push({
      condition: 'backup',
      text: `The private copy at ${pulse.domain} has not backed up its database for ${plural(Math.floor(backupAgeHours / 24), 'day')}. Contact: ${who}.`,
    });
  }
  if (diskFreePercent !== null && diskFreePercent < COPY_DISK_PERCENT) {
    holding.push({
      condition: 'disk',
      text: `The private copy at ${pulse.domain} has ${Math.round(diskFreePercent)}% of its disk free. Contact: ${who}.`,
    });
  }
  return { holding, unknown };
}
