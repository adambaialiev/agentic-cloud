import type { OutreachTargetRecord, OutreachTouch, OutreachWords } from '../shared/outreach.js';

/**
 * Where Outreach is kept (note #1089): a person's target companies, every
 * touch with each, and the words their last import brought. Per person — the
 * screen is the platform operator's alone, but the rows are keyed on who
 * imported them, never shared.
 */
export interface OutreachStore {
  words(userId: string): Promise<{ importedAt: string; words: OutreachWords } | null>;
  setWords(userId: string, importedAt: string, words: OutreachWords): Promise<void>;
  targets(userId: string): Promise<OutreachTargetRecord[]>;
  target(userId: string, targetId: string): Promise<OutreachTargetRecord | null>;
  putTarget(record: OutreachTargetRecord): Promise<void>;
  /** Every person's targets, for a pulse that may match any of them. */
  allTargets(): Promise<OutreachTargetRecord[]>;
  /** A target's touches, newest first; every target's when none is named. */
  touches(userId: string, targetId?: string): Promise<OutreachTouch[]>;
  addTouch(userId: string, touch: OutreachTouch): Promise<void>;
}

const newestFirst = (a: OutreachTouch, b: OutreachTouch) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

export class InMemoryOutreachStore implements OutreachStore {
  private readonly wordsBy = new Map<string, { importedAt: string; words: OutreachWords }>();
  private readonly targetsBy = new Map<string, Map<string, OutreachTargetRecord>>();
  private readonly touchesBy = new Map<string, OutreachTouch[]>();

  async words(userId: string) { const kept = this.wordsBy.get(userId); return kept ? structuredClone(kept) : null; }
  async setWords(userId: string, importedAt: string, words: OutreachWords) { this.wordsBy.set(userId, structuredClone({ importedAt, words })); }
  async targets(userId: string) { return [...(this.targetsBy.get(userId)?.values() ?? [])].map((record) => structuredClone(record)); }
  async target(userId: string, targetId: string) {
    const record = this.targetsBy.get(userId)?.get(targetId);
    return record ? structuredClone(record) : null;
  }
  async putTarget(record: OutreachTargetRecord) {
    const mine = this.targetsBy.get(record.userId) ?? new Map<string, OutreachTargetRecord>();
    mine.set(record.id, structuredClone(record));
    this.targetsBy.set(record.userId, mine);
  }
  async allTargets() { return [...this.targetsBy.values()].flatMap((mine) => [...mine.values()]).map((record) => structuredClone(record)); }
  async touches(userId: string, targetId?: string) {
    return (this.touchesBy.get(userId) ?? []).filter((touch) => !targetId || touch.targetId === targetId).sort(newestFirst).map((touch) => structuredClone(touch));
  }
  async addTouch(userId: string, touch: OutreachTouch) {
    this.touchesBy.set(userId, [...(this.touchesBy.get(userId) ?? []), structuredClone(touch)]);
  }
}
