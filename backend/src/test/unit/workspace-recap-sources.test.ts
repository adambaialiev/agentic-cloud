import { expect, it, vi } from 'vitest';
import { collectWorkspaceRecapSources } from '../../services/workspace-recap-sources.js';
import type { RouteDeps } from '../../routes/deps.js';
it('includes published knowledge and visible decisions, excludes drafts, and reports partial reads honestly', async () => {
  const now = new Date().toISOString();
  const deps = {
    gitPullRequestStorage: { listByUser: vi.fn(async () => [
      { id: 'visible', number: 1, title: 'Booking form', status: 'open', createdAt: now, createdByUserId: 'reader', userId: 'workplace-ns' },
      { id: 'draft', number: 2, title: 'SECRET DRAFT', status: 'open', createdAt: now, draft: true, userId: 'workplace-ns' },
      { id: 'merged', number: 3, title: 'Booking emails', status: 'merged', createdAt: now, userId: 'workplace-ns' },
    ]) },
    agentLifecycle: { agentChatMessages: vi.fn(async () => { throw new Error('chat unavailable'); }) },
  } as unknown as RouteDeps;
  const result = await collectWorkspaceRecapSources({ deps, userId: 'reader', orgId: 'org', namespaces: ['workplace-ns'],
    agents: [{ id: 'own', name: 'Leo' }] as never,
    pages: async () => [{ name: 'booking', title: 'Booking rules', description: 'Allow cancellation before noon.', updatedAt: now, sha: 'a', sizeBytes: 100 }],
  });
  expect(result.incomplete).toBe(true);
  expect(result.sources.map((s) => s.id)).not.toContain('pr:draft');
  expect(result.sources.find((s) => s.id === 'pr:visible')?.status).toBe('Awaiting your decision');
  expect(result.sources.find((s) => s.id === 'pr:merged')?.status).toBe('merged');
  expect(result.sources.find((s) => s.kind === 'knowledge')?.href).toBe('/knowledge/booking?org=org');
});
it('marks the request a working agent is on as in progress, and its recap as the previous turn', async () => {
  const now = new Date().toISOString();
  const deps = {
    agentLifecycle: {
      isAgentWorking: vi.fn(() => true),
      agentChatMessages: vi.fn(async () => [
        { seq: 1, role: 'owner', text: 'Why does the ops bot flag stale backups?', at: now },
        { seq: 2, role: 'agent', text: 'Looking now.', at: now },
        { seq: 3, role: 'owner', text: 'Also check the retention job.', at: now },
      ]),
    },
  } as unknown as RouteDeps;
  const result = await collectWorkspaceRecapSources({ deps, userId: 'reader', orgId: 'org', namespaces: [],
    agents: [{ id: 'own', name: 'Leo', recap: { text: 'Shipped the login page.', at: now } }] as never,
    pages: async () => [],
  });
  expect(result.sources.find((s) => s.id === 'chat:own:3')?.status).toBe('In progress: Leo is working on this right now');
  expect(result.sources.find((s) => s.id === 'chat:own:1')?.status).toBeUndefined();
  expect(result.sources.find((s) => s.id === 'turn:own')?.status).toContain('previous turn');
});
/**
 * Note #688 made a briefing one room's, every source naming its room. Since
 * rooms left the product (notes #843, #923) the briefing is the workplace's:
 * it reads the workplace's own namespace and its old rooms' (where records
 * from before the merge still stand), and every agent of the person's — and
 * no source names a room.
 */
it('reads the workplace\'s namespace and its old rooms\', and every agent, naming no room on any source', async () => {
  const now = new Date().toISOString();
  const deps = {
    quickNoteStorage: { listByUser: vi.fn(async (namespace: string) => [
      { id: `n-${namespace}`, number: 1, html: `<p>Note in ${namespace}</p>`, updatedAt: now, userId: namespace },
    ]) },
    agentLifecycle: { agentChatMessages: vi.fn(async (_user: string, id: string) => [{ seq: 1, role: 'owner', text: `Ask ${id}`, at: now }]) },
  } as unknown as RouteDeps;
  const result = await collectWorkspaceRecapSources({ deps, userId: 'reader', orgId: 'org', namespaces: ['workplace-ns', 'old-room-ns'],
    agents: [{ id: 'legacy', name: 'Old' }, { id: 'ivy', name: 'Ivy' }] as never, pages: async () => [],
  });
  expect(result.sources.map((s) => s.id).sort()).toEqual(['chat:ivy:1', 'chat:legacy:1', 'note:n-old-room-ns', 'note:n-workplace-ns']);
  for (const source of result.sources) {
    expect(source).not.toHaveProperty('room');
    expect(source).not.toHaveProperty('roomId');
  }
  expect(result.sources.find((s) => s.id === 'note:n-old-room-ns')?.href).toBe('/notes/1?org=org');
});
