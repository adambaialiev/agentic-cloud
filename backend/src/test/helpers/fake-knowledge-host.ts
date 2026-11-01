import { createHash } from 'node:crypto';
import { GitHostClient } from '../../services/git-host-client.js';

/**
 * A knowledge base in memory behind the REAL GitHostClient, so the wire shape
 * this backend depends on is exercised rather than mocked away.
 */
export function fakeKnowledgeHost() {
  const files = new Map<string, string>();
  let head: string | null = null;
  const sha = (content: string) => createHash('sha1').update(content).digest('hex');
  const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
    const path = String(url).replace('http://host', '');
    const body = JSON.parse(init?.body ?? '{}') as {
      page?: string;
      writes?: Array<{ path: string; content: string }>;
      deletes?: string[];
    };
    const answer = (payload: unknown, status = 200) => ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(payload),
    });
    if (path === '/internal/knowledge/list') {
      const pages = [...files.entries()]
        .filter(([file]) => file.startsWith('pages/'))
        .map(([file, content]) => ({
          name: file.slice('pages/'.length, -'.html'.length),
          sha: sha(content),
          sizeBytes: Buffer.byteLength(content, 'utf8'),
        }));
      return answer({ pages, index: files.get('index.json') ?? null, head });
    }
    if (path === '/internal/knowledge/read') {
      const content = files.get(`pages/${body.page}.html`);
      if (content === undefined) return answer({ error: 'no such page' }, 409);
      return answer({ content, sha: sha(content), sizeBytes: Buffer.byteLength(content, 'utf8') });
    }
    if (path === '/internal/knowledge/commit') {
      const expected = (body as { expectedHead?: string }).expectedHead;
      if (expected && expected !== head) return answer({ status: 'stale', head });
      for (const write of body.writes ?? []) files.set(write.path, write.content);
      for (const file of body.deletes ?? []) files.delete(file);
      head = sha(JSON.stringify([...files.keys()]) + String(head));
      return answer({ status: 'committed', commitSha: head });
    }
    return answer({ error: 'no such control route' }, 404);
  }) as unknown as typeof fetch;
  return {
    files,
    client: new GitHostClient({
      baseUrl: 'http://host', controlUrl: 'http://host', secret: 's', fetchImpl,
    }),
  };
}

