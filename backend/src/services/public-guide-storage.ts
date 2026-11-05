/**
 * Transcripts of the public guide's visits (note #1010), and which agent is
 * the guide. One row per visit; the questions ride the visit's document.
 * Nothing about a visitor is stored beyond what they typed: no address, no
 * user agent, no cookie — the address lives only in the route's in-memory
 * limiter. Kept {@link PUBLIC_GUIDE_LIMITS.transcriptDays} days.
 */
import type { SqliteDb } from './sqlite/sqlite-db.js';
import { PUBLIC_GUIDE_LIMITS, type PublicGuideVisitRecord } from '../shared/public-guide.js';

export interface PublicGuidePointer {
  userId: string;
  agentId: string;
  setAt: string;
}

export interface PublicGuideStorage {
  getVisit(visitId: string): Promise<PublicGuideVisitRecord | null>;
  putVisit(visit: PublicGuideVisitRecord): Promise<void>;
  /** The visit a question belongs to, or null. */
  visitIdForQuestion(questionId: string): Promise<string | null>;
  /** Newest first. */
  listVisits(agentId: string, limit: number): Promise<PublicGuideVisitRecord[]>;
  /** Questions taken (not failed) since this moment, across every visit. */
  countQuestionsSince(sinceMs: number): Promise<number>;
  /** Deletes visits started before this moment. Returns how many went. */
  pruneBefore(beforeMs: number): Promise<number>;
  getGuide(): Promise<PublicGuidePointer | null>;
  setGuide(pointer: PublicGuidePointer | null): Promise<void>;
}

export function transcriptCutoffMs(now = Date.now()): number {
  return now - PUBLIC_GUIDE_LIMITS.transcriptDays * 24 * 60 * 60 * 1000;
}

function counted(visit: PublicGuideVisitRecord, sinceMs: number): number {
  return visit.questions.filter((q) => q.state !== 'failed' && q.state !== 'resting' && Date.parse(q.askedAt) >= sinceMs).length;
}

export class InMemoryPublicGuideStorage implements PublicGuideStorage {
  private readonly visits = new Map<string, PublicGuideVisitRecord>();
  private readonly questions = new Map<string, string>();
  private guide: PublicGuidePointer | null = null;

  async getVisit(visitId: string) { const v = this.visits.get(visitId); return v ? structuredClone(v) : null; }
  async putVisit(visit: PublicGuideVisitRecord) {
    this.visits.set(visit.visitId, structuredClone(visit));
    for (const q of visit.questions) this.questions.set(q.questionId, visit.visitId);
  }
  async visitIdForQuestion(questionId: string) { return this.questions.get(questionId) ?? null; }
  async listVisits(agentId: string, limit: number) {
    return [...this.visits.values()].filter((v) => v.agentId === agentId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit).map((v) => structuredClone(v));
  }
  async countQuestionsSince(sinceMs: number) {
    let n = 0;
    for (const v of this.visits.values()) n += counted(v, sinceMs);
    return n;
  }
  async pruneBefore(beforeMs: number) {
    let n = 0;
    for (const [id, v] of this.visits) {
      if (Date.parse(v.startedAt) < beforeMs) {
        this.visits.delete(id);
        for (const q of v.questions) this.questions.delete(q.questionId);
        n++;
      }
    }
    return n;
  }
  async getGuide() { return this.guide; }
  async setGuide(pointer: PublicGuidePointer | null) { this.guide = pointer; }
}

export const PUBLIC_GUIDE_SCHEMA = `
CREATE TABLE IF NOT EXISTS public_guide_visits (
  visit_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS public_guide_visits_by_agent ON public_guide_visits (agent_id, started_at_ms);
CREATE TABLE IF NOT EXISTS public_guide_questions (
  question_id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  asked_at_ms INTEGER NOT NULL,
  counted INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS public_guide_questions_by_time ON public_guide_questions (asked_at_ms);
CREATE TABLE IF NOT EXISTS public_guide_pointer (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  doc TEXT NOT NULL
);
`;

export class SqlitePublicGuideStorage implements PublicGuideStorage {
  constructor(private readonly db: SqliteDb) {
    db.exec(PUBLIC_GUIDE_SCHEMA);
  }

  async getVisit(visitId: string) {
    const row = this.db.prepare('SELECT doc FROM public_guide_visits WHERE visit_id = ?').get(visitId) as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) as PublicGuideVisitRecord : null;
  }

  async putVisit(visit: PublicGuideVisitRecord) {
    const upsertVisit = this.db.prepare(
      'INSERT INTO public_guide_visits (visit_id, agent_id, started_at_ms, doc) VALUES (?, ?, ?, ?)'
      + ' ON CONFLICT(visit_id) DO UPDATE SET doc = excluded.doc',
    );
    const upsertQuestion = this.db.prepare(
      'INSERT INTO public_guide_questions (question_id, visit_id, asked_at_ms, counted) VALUES (?, ?, ?, ?)'
      + ' ON CONFLICT(question_id) DO UPDATE SET counted = excluded.counted',
    );
    this.db.transaction(() => {
      upsertVisit.run(visit.visitId, visit.agentId, Date.parse(visit.startedAt), JSON.stringify(visit));
      for (const q of visit.questions) {
        upsertQuestion.run(q.questionId, visit.visitId, Date.parse(q.askedAt), q.state === 'failed' || q.state === 'resting' ? 0 : 1);
      }
    })();
  }

  async visitIdForQuestion(questionId: string) {
    const row = this.db.prepare('SELECT visit_id FROM public_guide_questions WHERE question_id = ?').get(questionId) as { visit_id: string } | undefined;
    return row?.visit_id ?? null;
  }

  async listVisits(agentId: string, limit: number) {
    const rows = this.db.prepare(
      'SELECT doc FROM public_guide_visits WHERE agent_id = ? ORDER BY started_at_ms DESC LIMIT ?',
    ).all(agentId, limit) as Array<{ doc: string }>;
    return rows.map((row) => JSON.parse(row.doc) as PublicGuideVisitRecord);
  }

  async countQuestionsSince(sinceMs: number) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM public_guide_questions WHERE asked_at_ms >= ? AND counted = 1').get(sinceMs) as { n: number };
    return row.n;
  }

  async pruneBefore(beforeMs: number) {
    let removed = 0;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM public_guide_questions WHERE visit_id IN (SELECT visit_id FROM public_guide_visits WHERE started_at_ms < ?)').run(beforeMs);
      removed = this.db.prepare('DELETE FROM public_guide_visits WHERE started_at_ms < ?').run(beforeMs).changes;
    })();
    return removed;
  }

  async getGuide() {
    const row = this.db.prepare('SELECT doc FROM public_guide_pointer WHERE id = 1').get() as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) as PublicGuidePointer : null;
  }

  async setGuide(pointer: PublicGuidePointer | null) {
    if (!pointer) { this.db.prepare('DELETE FROM public_guide_pointer WHERE id = 1').run(); return; }
    this.db.prepare('INSERT INTO public_guide_pointer (id, doc) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc')
      .run(JSON.stringify(pointer));
  }
}
