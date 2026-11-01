import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';

/**
 * The narrow document-read API the config-doc readers (AgentConfigService,
 * HarnessCliVersionService) actually use, kept as an interface so those
 * services stay independent of the storage backend.
 */
export interface ConfigDocSource {
  collection(name: string): {
    doc(id: string): {
      get(): Promise<{ data(): Record<string, unknown> | undefined }>;
    };
  };
}

export class SqliteConfigDocSource implements ConfigDocSource {
  constructor(private readonly db: SqliteDb) {}

  private read(docId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT doc FROM config_docs WHERE doc_id = ?')
      .get(docId) as { doc: string } | undefined;
    return row ? deserializeDoc<Record<string, unknown>>(row.doc) : undefined;
  }

  /** Merge-write, matching the operator scripts' `set(..., { merge: true })`. */
  setConfigDoc(docId: string, updates: Record<string, unknown>): void {
    const current = this.read(docId) ?? {};
    this.db.prepare(
      'INSERT INTO config_docs (doc_id, doc) VALUES (?, ?)'
      + ' ON CONFLICT(doc_id) DO UPDATE SET doc = excluded.doc',
    ).run(docId, serializeDoc({ ...current, ...updates }));
  }

  collection(name: string) {
    return {
      doc: (id: string) => ({
        get: async () => {
          // Doc ids here are `<collection>/<doc>`-scoped; the table
          // key keeps both parts so `config/agent` and any future collection
          // can't collide.
          const data = this.read(`${name}/${id}`);
          return { data: () => data };
        },
      }),
    };
  }
}
