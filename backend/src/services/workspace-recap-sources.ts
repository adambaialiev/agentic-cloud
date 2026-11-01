import { resolveQuickNoteWorkMap } from './quick-note-work.js';
import type { RouteDeps } from '../routes/deps.js';
import type { AgentRecord } from '../types/user.js';
import type { WorkspaceRecapSource } from '../shared/workspace-recap.js';
import { workspaceRoutePath } from '../shared/workspace-routes.js';
import { quickNoteTitle } from '../types/quick-note.js';
import { RECAP_CONVERSATION_ROWS, recapPlainText } from './workspace-recap.js';
import type { KnowledgePageSummary } from '../types/knowledge.js';

const latestAt = (...values: Array<string | undefined>) => values.filter((v): v is string => Boolean(v)).sort().at(-1) ?? '';

/** Local records and bounded knowledge reads. Never reads a teammate's profile
 * or chat, hidden draft proposals, another workplace, or arbitrary URLs.
 * A workplace is one place (note #843): `namespaces` is its own namespace and
 * its old rooms', and no source names a room. The budget is applied by the
 * caller with `selectRecapSources`. */
export async function collectWorkspaceRecapSources(args: {
  deps: RouteDeps; userId: string; orgId: string; namespaces: string[];
  agents: AgentRecord[];
  pages: (namespace: string) => Promise<KnowledgePageSummary[]>;
}): Promise<{ sources: WorkspaceRecapSource[]; incomplete: boolean }> {
  const { deps, userId, orgId } = args;
  const sources: WorkspaceRecapSource[] = [];
  let incomplete = false;
  const read = async <T>(load: () => Promise<T>, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([load(), new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('recap source timeout')), 6000);
      })]);
    } catch { incomplete = true; return fallback; }
    finally { clearTimeout(timer); }
  };
  const tasks: Array<() => Promise<void>> = args.namespaces.map((namespace) => async () => {
    const scope = { orgId };
    const [notes, prs, kps, pages] = await Promise.all([
      read(() => deps.quickNoteStorage?.listByUser(namespace) ?? Promise.resolve([]), []),
      read(() => deps.gitPullRequestStorage?.listByUser(namespace) ?? Promise.resolve([]), []),
      read(() => deps.knowledgeProposalStorage?.listByUser(namespace) ?? Promise.resolve([]), []),
      read(() => args.pages(namespace), []),
    ]);
    const work = await read(() => resolveQuickNoteWorkMap({ notes, pullRequests: deps.gitPullRequestStorage, commitStatuses: deps.gitCommitStatusStorage }), new Map());
    for (const doc of notes) {
      const state = work.get(doc.id)?.state ?? 'unclaimed';
      sources.push({ id: `note:${doc.id}`, kind: 'note', title: `Note #${doc.number}: ${quickNoteTitle(doc.html)}`,
        text: recapPlainText(doc.html, 800) + (doc.comments?.length ? ` Latest comment: ${recapPlainText(doc.comments.at(-1)!.text)}` : ''),
        at: latestAt(doc.comments?.at(-1)?.createdAt, doc.updatedAt),
        href: workspaceRoutePath({ kind: 'note', id: String(doc.number), ...scope })!,
        status: state === 'unclaimed' ? 'Unclaimed' : state === 'proposal' ? 'Proposal recorded' : state,
      });
    }
    for (const doc of prs.filter((p) => !p.draft)) {
      sources.push({ id: `pr:${doc.id}`, kind: 'proposal', title: `Proposal #${doc.number}: ${doc.title}`,
        text: recapPlainText(doc.body ?? '', 800) + (doc.comments?.length ? ` Latest comment: ${doc.comments.at(-1)!.text}` : ''),
        at: latestAt(doc.comments?.at(-1)?.createdAt, doc.decidedAt, doc.refreshedAt, doc.readyAt, doc.createdAt),
        href: workspaceRoutePath({ kind: 'pr', id: doc.id })!,
        status: doc.status === 'open' ? ((doc.createdByUserId === userId || (!doc.createdByUserId && args.agents.some((a) => a.id === doc.createdByAgentId)))
          ? 'Awaiting your decision' : 'Awaiting its owner’s decision') : doc.status,
      });
    }
    for (const doc of kps.filter((p) => !p.draft)) sources.push({
      id: `kp:${doc.id}`, kind: 'proposal', title: `Knowledge proposal #${doc.number}: ${doc.title}`,
      text: recapPlainText(doc.note ?? '', 800) + (doc.comments?.length ? ` Latest comment: ${doc.comments.at(-1)!.text}` : ''), at: latestAt(doc.comments?.at(-1)?.createdAt, doc.decidedAt, doc.readyAt, doc.createdAt),
      href: workspaceRoutePath({ kind: 'knowledge', id: doc.id })!,
      status: doc.status === 'open' ? ((doc.createdByUserId === userId || (!doc.createdByUserId && args.agents.some((a) => a.id === doc.createdByAgentId)))
        ? 'Awaiting your decision' : 'Awaiting its owner’s decision') : doc.status,
    });
    for (const page of pages) sources.push({ id: `page:${namespace}:${page.name}`, kind: 'knowledge',
      title: page.title, text: page.description, at: page.updatedAt ?? '',
      href: workspaceRoutePath({ kind: 'knowledgePage', id: page.name, ...scope })!, status: 'Published knowledge',
    });
  });
  for (const agent of args.agents) tasks.push(async () => {
    const working = deps.agentLifecycle?.isAgentWorking?.(userId, agent.id) ?? false;
    // The model is told an agent is mid-turn, and which request it is on:
    // without this, a request with no reply yet read as "interrupted before
    // reaching an answer" on a card whose agent was eight minutes into it.
    // The live tool line is deliberately left out — it changes every second
    // and would churn the fingerprint without changing the story.
    if (agent.recap?.text) sources.push({ id: `turn:${agent.id}`, kind: 'turn', title: agent.name,
      text: agent.recap.text, at: agent.recap.at,
      href: workspaceRoutePath({ kind: 'agent', id: agent.id })!,
      status: working ? `Working now; this recap describes ${agent.name}’s previous turn` : 'Latest work recap',
    });
    const messages = await read(() => deps.agentLifecycle?.agentChatMessages?.(userId, agent.id, 0) ?? Promise.resolve([]), []);
    const recent = messages.slice(-RECAP_CONVERSATION_ROWS).filter((message) => message.text.trim());
    const current = working ? recent.filter((message) => message.role === 'owner').at(-1) : undefined;
    for (const message of recent) {
      sources.push({ id: `chat:${agent.id}:${message.seq}`, kind: message.role === 'owner' ? 'request' : 'message',
        title: message.role === 'owner' ? `You → ${agent.name}` : message.role === 'agent' ? `${agent.name} → you` : `${agent.name} · workspace message`,
        text: message.text, at: message.at, href: workspaceRoutePath({ kind: 'chat', id: agent.id })!,
        ...(message === current ? { status: `In progress: ${agent.name} is working on this right now` } : {}),
      });
    }
  });
  // Four source groups at a time; a large fleet cannot flood its git host.
  for (let i = 0; i < tasks.length; i += 4) await Promise.all(tasks.slice(i, i + 4).map((task) => task()));
  return { sources, incomplete };
}
