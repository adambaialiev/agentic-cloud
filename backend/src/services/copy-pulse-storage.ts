import type { CopyAlertCondition, CopyPulse, CopyPulseDay, CopyPulseRecord, StoredCopyPulse } from '../shared/copy-pulse.js';

/**
 * Where the private copies' pulses are kept on our side (notes #1057, #1058).
 *
 * Two tables, agreed on note #1057: `copy_pulses` holds each copy's newest
 * pulse and when we first and last heard from it; `copy_pulse_days` holds the
 * last pulse of each UTC day, for the copy's history. The receiving route
 * (note #1057) checks the signature and the shape, then calls `record`; the
 * Copies screen and the alert sweep only read.
 *
 * A third, `copy_pulse_alerts`, is the alert sweep's own ledger: which
 * condition has already been said for which copy, so each is said once while
 * it holds.
 */
export interface CopyPulseStore {
  /** Keep a verified pulse: the copy's newest, and its day's row. */
  record(pulse: CopyPulse, receivedAt: string): Promise<CopyPulseRecord>;
  list(): Promise<CopyPulseRecord[]>;
  get(copyId: string): Promise<CopyPulseRecord | null>;
  /** A copy's daily rows, newest first. */
  days(copyId: string, limit?: number): Promise<CopyPulseDay[]>;
  /** The conditions already said for a copy, with when. */
  alerts(copyId: string): Promise<Partial<Record<CopyAlertCondition, string>>>;
  /** Say a condition was raised (a time) or has cleared (null). */
  setAlert(copyId: string, condition: CopyAlertCondition, raisedAt: string | null): Promise<void>;
}

export const COPY_HISTORY_DAYS = 60;

/** The UTC day a pulse arrived on. */
export const pulseDay = (receivedAt: string): string => new Date(receivedAt).toISOString().slice(0, 10);

export function storedPulse(pulse: CopyPulse, receivedAt: string): StoredCopyPulse {
  return { ...pulse, receivedAt: new Date(receivedAt).toISOString() };
}

export class InMemoryCopyPulseStore implements CopyPulseStore {
  private readonly copies = new Map<string, CopyPulseRecord>();
  private readonly history = new Map<string, Map<string, CopyPulseDay>>();
  private readonly ledger = new Map<string, Partial<Record<CopyAlertCondition, string>>>();

  async record(pulse: CopyPulse, receivedAt: string): Promise<CopyPulseRecord> {
    const stored = storedPulse(pulse, receivedAt);
    const before = this.copies.get(pulse.copyId);
    const record: CopyPulseRecord = {
      copyId: pulse.copyId,
      firstSeenAt: before?.firstSeenAt ?? stored.receivedAt,
      lastSeenAt: stored.receivedAt,
      pulse: stored,
    };
    this.copies.set(pulse.copyId, record);
    const days = this.history.get(pulse.copyId) ?? new Map<string, CopyPulseDay>();
    const day = pulseDay(stored.receivedAt);
    days.set(day, { copyId: pulse.copyId, day, lastSeenAt: stored.receivedAt, pulse: stored });
    this.history.set(pulse.copyId, days);
    return structuredClone(record);
  }
  async list(): Promise<CopyPulseRecord[]> { return [...this.copies.values()].map((record) => structuredClone(record)); }
  async get(copyId: string): Promise<CopyPulseRecord | null> {
    const record = this.copies.get(copyId);
    return record ? structuredClone(record) : null;
  }
  async days(copyId: string, limit = COPY_HISTORY_DAYS): Promise<CopyPulseDay[]> {
    return [...(this.history.get(copyId)?.values() ?? [])]
      .sort((a, b) => b.day.localeCompare(a.day)).slice(0, limit).map((row) => structuredClone(row));
  }
  async alerts(copyId: string): Promise<Partial<Record<CopyAlertCondition, string>>> { return { ...this.ledger.get(copyId) }; }
  async setAlert(copyId: string, condition: CopyAlertCondition, raisedAt: string | null): Promise<void> {
    const current = { ...this.ledger.get(copyId) };
    if (raisedAt) current[condition] = raisedAt;
    else delete current[condition];
    this.ledger.set(copyId, current);
  }
}
