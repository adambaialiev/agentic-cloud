import type { GitHostClient } from './git-host-client.js';
import type { KnowledgeProposalStorage } from './knowledge-storage.js';
import type { NumberSeries } from './workplace-numbers.js';
import {
  knowledgePagePath,
  MAX_KNOWLEDGE_PROPOSAL_TITLE_LENGTH,
  readKnowledgePageMeta,
  type KnowledgePageAttachment,
  type KnowledgePageChange,
  type KnowledgePageSummary,
  type KnowledgeProposalDocument,
} from '../types/knowledge.js';

/**
 * The knowledge base itself (docs/agent-knowledge-pages.md): what is in it, and
 * what a change does to it.
 *
 * Since note #746 an agent's change is APPLIED the moment it is written
 * ({@link KnowledgeService.apply}): no card, no tap, the owner told rather
 * than asked. What used to be the gate is now the HISTORY — every landing is
 * still recorded as a proposal document with who, when, why and the words
 * before ({@link KnowledgePageChange.previousHtml}), and
 * {@link KnowledgeService.restore} writes one more of them to put a page back.
 * {@link KnowledgeService.land} is what both go through, and what the legacy
 * decision surface still calls for a proposal recorded before the change.
 */

/** The derived listing that makes `knowledge list` one blob read instead of
 *  one read per page. Rebuilt from the pages themselves on every landing, so a
 *  drifted entry is corrected the next time its page changes. */
interface KnowledgeIndexFile {
  pages: Record<string, {
    title: string;
    description: string;
    updatedAt: string;
    bytes: number;
    /** The agent whose proposal landed this version — what puts a face on the
     *  page's row, the same one its site and note rows wear. Absent on every
     *  entry written before this was recorded. */
    updatedByAgentId?: string;
    /**
     * The ROOM namespace the page came from (note #566): the proposing agent's
     * when it was created, or the room whose base it was migrated out of. A
     * label for finding things on a shelf the whole workplace shares — it
     * grants nothing, restricts nothing, and an edit from another room does
     * not change it. Absent on a personal account's pages.
     */
    originNamespaceId?: string;
    /**
     * The files the page carries. The RECORDS live here, in git, beside the
     * title and description they belong with — so a page and its pictures land
     * in one commit and move together. The bytes are in media storage; a git
     * base is no place for photos.
     */
    attachments?: KnowledgePageAttachment[];
  }>;
}

export const KNOWLEDGE_INDEX_PATH = 'index.json';

export type { KnowledgeIndexFile };

/**
 * Maps the namespace a caller stands in to the namespace whose knowledge base
 * it reads and writes (note #566, `OrgGitService.knowledgeShelfFor`). Every
 * caller keeps passing the namespace it always did — a room's, a proposal's —
 * and the service resolves the one shelf underneath, so "which base" is
 * decided in exactly one place.
 */
export type KnowledgeShelfResolver = (namespaceId: string) => Promise<string>;

export function parseKnowledgeIndex(raw: string | null): KnowledgeIndexFile {
  return parseIndex(raw);
}

function parseIndex(raw: string | null): KnowledgeIndexFile {
  if (!raw) return { pages: {} };
  try {
    const parsed = JSON.parse(raw) as KnowledgeIndexFile;
    return parsed && typeof parsed === 'object' && parsed.pages ? parsed : { pages: {} };
  } catch {
    // A corrupt index is a cache miss, never an outage: listPages falls back to
    // the pages themselves, and the next landing writes a clean one.
    return { pages: {} };
  }
}

export type KnowledgeLandResult =
  | {
    status: 'landed';
    commitSha: string;
    proposal: KnowledgeProposalDocument;
    /** Files nothing points at any more — a deleted page's, or ones this
     *  change took off. The caller holds media storage; this service does not. */
    orphaned: KnowledgePageAttachment[];
  }
  | { status: 'conflict'; pages: string[] }
  | { status: 'not-open'; proposal: KnowledgeProposalDocument }
  | { status: 'missing' };

export class KnowledgeService {
  constructor(
    private readonly host: GitHostClient,
    private readonly proposals: KnowledgeProposalStorage,
    private readonly shelfOf: KnowledgeShelfResolver = async (namespaceId) => namespaceId,
  ) {}

  /**
   * Every page, as the CLI and the Workspace list them. The index answers for
   * title and description; a page the index does not know about is read
   * directly rather than listed without one — a row with no description is
   * exactly the row nobody opens.
   */
  async listPages(userId: string): Promise<KnowledgePageSummary[]> {
    const listing = await this.host.knowledgeList(await this.shelfOf(userId));
    const index = parseIndex(listing.index);
    const summaries: KnowledgePageSummary[] = [];
    for (const entry of listing.pages) {
      const known = index.pages[entry.name];
      if (known) {
        summaries.push({
          name: entry.name,
          title: known.title,
          description: known.description,
          sizeBytes: entry.sizeBytes,
          sha: entry.sha,
          updatedAt: known.updatedAt,
          ...(known.updatedByAgentId ? { updatedByAgentId: known.updatedByAgentId } : {}),
          ...(known.originNamespaceId ? { originNamespaceId: known.originNamespaceId } : {}),
          ...(known.attachments?.length ? { attachments: known.attachments } : {}),
        });
        continue;
      }
      const page = await this.host.knowledgeRead(await this.shelfOf(userId), entry.name).catch(() => null);
      const meta = page ? readKnowledgePageMeta(page.content) : null;
      summaries.push({
        name: entry.name,
        title: meta && !('error' in meta) ? meta.title : entry.name,
        description: meta && !('error' in meta) ? meta.description : '',
        sizeBytes: entry.sizeBytes,
        sha: entry.sha,
      });
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The pages that CAME FROM one namespace (note #566) — for the readers that
   * still walk a workplace room by room (the briefing's sources, the
   * workplace's holdings). On a merged shelf every room resolves to the same
   * listing, so asking each room for "its pages" with {@link listPages} would
   * count the whole shelf once per room; this answers with the pages labelled
   * for that room, and the unlabelled ones for the shelf's own namespace.
   */
  async listPagesFrom(userId: string): Promise<KnowledgePageSummary[]> {
    const shelf = await this.shelfOf(userId);
    return (await this.listPages(userId)).filter((page) => (page.originNamespaceId ?? shelf) === userId);
  }

  /** One page's exact source — what an agent reads, and what it edits. */
  async readPage(userId: string, name: string): Promise<{ content: string; sha: string } | null> {
    try {
      const page = await this.host.knowledgeRead(await this.shelfOf(userId), name);
      return { content: page.content, sha: page.sha };
    } catch {
      return null;
    }
  }

  /** The blob sha of each named page right now, for pinning a proposal and for
   *  re-checking it at approval. Absent from the map = no such page. */
  async currentShas(userId: string): Promise<Map<string, string>> {
    const listing = await this.host.knowledgeList(await this.shelfOf(userId));
    return new Map(listing.pages.map((page) => [page.name, page.sha]));
  }

  async pageCount(userId: string): Promise<number> {
    const listing = await this.host.knowledgeList(await this.shelfOf(userId));
    return listing.pages.length;
  }

  /**
   * Land an APPROVED proposal. Two things can still stop it here, and both are
   * refusals rather than surprises:
   *
   * - a page moved since the proposal was written (another proposal landed
   *   first), which would make this a silent clobber of work the owner already
   *   approved once;
   * - the base moved between reading it and committing, which the host's own
   *   compare-and-swap catches.
   */
  async land(
    proposalId: string,
    decidedBy: string,
    note?: string,
    retrying = false,
  ): Promise<KnowledgeLandResult> {
    const proposal = await this.proposals.get(proposalId);
    if (!proposal) return { status: 'missing' };
    if (proposal.status !== 'open') return { status: 'not-open', proposal };

    // A proposal stays the ROOM's — its number, its card and its queue are the
    // proposing agent's room's — while the pages it lands on are the
    // workplace's one shelf (note #566).
    const shelf = await this.shelfOf(proposal.userId);
    const listing = await this.host.knowledgeList(shelf);
    const shas = new Map(listing.pages.map((page) => [page.name, page.sha]));
    const moved = proposal.changes.filter((change) => {
      const current = shas.get(change.page) ?? null;
      // `baseSha` is what the page was when the agent wrote against it. A
      // create pins null: if a page now exists under that name, someone else
      // got there first and this is no longer a create.
      if ((change.baseSha ?? null) !== current) return true;
      // A rename also needs its DESTINATION to still be free. The source can
      // be untouched while somebody else has since created a page under the
      // name this one is moving to, and landing then would overwrite theirs.
      return change.action === 'rename' && Boolean(change.renameTo && shas.has(change.renameTo));
    });
    if (moved.length) {
      await this.proposals.update(proposal.id, {
        status: 'conflict',
        decidedAt: new Date().toISOString(),
      });
      return { status: 'conflict', pages: moved.map((change) => change.page) };
    }

    const index = parseIndex(listing.index);
    const now = new Date().toISOString();
    // The words each touched page had before this landing (note #746): the
    // way back, kept on the record itself so a restore needs no git history.
    // A removal also records which files it took off, since their bytes go
    // with it and a restore has to say they did not come back.
    const changes: KnowledgePageChange[] = [];
    for (const change of proposal.changes) {
      if (change.action === 'create' || change.previousHtml !== undefined) { changes.push(change); continue; }
      const before = await this.host.knowledgeRead(shelf, change.page).catch(() => null);
      const files = change.action === 'delete' ? (index.pages[change.page]?.attachments ?? []).map((file) => file.fileName) : [];
      changes.push({
        ...change,
        ...(before ? { previousHtml: before.content } : {}),
        ...(files.length ? { previousFiles: files } : {}),
      });
    }
    const writes: Array<{ path: string; content: string }> = [];
    const deletes: string[] = [];
    // Files this landing leaves with nothing pointing at them: a page deleted
    // whole, or a file the proposal took off. The bytes are in media storage,
    // which this service deliberately does not know about — so they are
    // reported back and the approval surface, which does, clears them.
    const orphaned: KnowledgePageAttachment[] = [];
    for (const change of proposal.changes) {
      const previous = index.pages[change.page];
      if (change.action === 'delete') {
        deletes.push(knowledgePagePath(change.page));
        orphaned.push(...(previous?.attachments ?? []));
        delete index.pages[change.page];
        continue;
      }
      // The page's files, as this change leaves them. `attachments` absent
      // means the change said nothing about files, so whatever the page
      // already carried carries on — an edit to the WORDS must never quietly
      // strip the pictures.
      const attachments = change.attachments ?? previous?.attachments ?? [];
      if (change.attachments) {
        const kept = new Set(change.attachments.map((a) => a.id));
        orphaned.push(...(previous?.attachments ?? []).filter((a) => !kept.has(a.id)));
      }
      // A rename is the same document at a new address: the old blob goes and
      // the same bytes are written under the new name, so the index entry —
      // and with it the page's FILES — moves rather than being rebuilt.
      // Nothing is orphaned by it: `storagePath` is recorded on each file when
      // it is attached and read back from the record, never recomputed from
      // the page's name, so the bytes stay reachable where they already are.
      const landsAt = change.action === 'rename' && change.renameTo ? change.renameTo : change.page;
      if (landsAt !== change.page) {
        deletes.push(knowledgePagePath(change.page));
        delete index.pages[change.page];
      }
      writes.push({ path: knowledgePagePath(landsAt), content: change.html ?? '' });
      index.pages[landsAt] = {
        title: change.title ?? change.page,
        description: change.description ?? '',
        updatedAt: now,
        bytes: change.bytes ?? Buffer.byteLength(change.html ?? '', 'utf8'),
        // Who wrote this version. The proposal is the only record of that —
        // the commit is authored by the platform, not the agent — so it is
        // captured here, at the one moment both are in hand.
        updatedByAgentId: proposal.createdByAgentId,
        // Where the page came from stays where it came from; a NEW page is
        // from the proposing agent's room. On a personal account the shelf IS
        // the proposal's namespace and there is no room to name.
        ...((previous?.originNamespaceId ?? (shelf !== proposal.userId ? proposal.userId : undefined))
          ? { originNamespaceId: previous?.originNamespaceId ?? proposal.userId }
          : {}),
        ...(attachments.length ? { attachments } : {}),
      };
    }
    writes.push({ path: KNOWLEDGE_INDEX_PATH, content: `${JSON.stringify(index, null, 2)}\n` });

    // Pinned on the head the listing described (note #746): two agents
    // changing the shelf at once both pass the moved check above, and without
    // the pin the later commit would silently overwrite the earlier one —
    // whose record would then be the only trace it ever happened. A stale
    // answer is retried once from a fresh read; stale twice is a conflict.
    const result = await this.host.knowledgeCommit(shelf, {
      writes,
      deletes,
      message: proposal.title,
      expectedHead: listing.head ?? null,
    });
    if (result.status === 'stale' && !retrying) return this.land(proposalId, decidedBy, note, true);
    if (result.status !== 'committed') {
      // `stale` twice, or `empty`: nothing landed, and the proposal stays open
      // so the next attempt runs against what is there now.
      return { status: 'conflict', pages: proposal.changes.map((change) => change.page) };
    }
    await this.proposals.update(proposal.id, {
      status: 'approved',
      changes,
      decidedAt: now,
      decidedBy,
      ...(note ? { decisionNote: note } : {}),
      commitSha: result.commitSha,
    });
    const landed = (await this.proposals.get(proposal.id))!;
    return { status: 'landed', commitSha: result.commitSha, proposal: landed, orphaned };
  }

  /**
   * Record a change and land it at once (note #746). The record is written
   * open and landed in the same breath, so a conflict leaves it marked
   * `conflict` for the agent to redo, exactly as a refused approval did —
   * and a landed one is the page's history entry, flagged `direct`.
   */
  async apply(
    doc: Omit<KnowledgeProposalDocument, 'id' | 'createdAt' | 'number' | 'status' | 'direct'>,
    numbering?: NumberSeries,
  ): Promise<KnowledgeApplyResult> {
    // Recorded quiet AND direct for the instant before it lands: a crash in
    // between must leave a record no queue shows and no boot-time settling
    // applies — the agent simply retries.
    const created = await this.proposals.create({ ...doc, status: 'open', direct: true, draft: true }, numbering);
    const result = await this.land(created.id, doc.createdByUserId ?? doc.createdByAgentId, doc.note);
    if (result.status === 'landed') {
      await this.proposals.update(created.id, { draft: undefined });
      return { status: 'applied', commitSha: result.commitSha, proposal: (await this.proposals.get(created.id))!, orphaned: result.orphaned };
    }
    if (result.status === 'conflict') {
      // `land` marks a moved page conflict; a host refusal (stale/empty) leaves
      // the record open, which for a direct change is the wrong resting state.
      await this.proposals.update(created.id, { status: 'conflict', decidedAt: new Date().toISOString() });
      return { status: 'conflict', pages: result.pages, proposal: (await this.proposals.get(created.id))! };
    }
    await this.proposals.update(created.id, { status: 'conflict', decidedAt: new Date().toISOString() });
    return { status: 'conflict', pages: doc.changes.map((change) => change.page), proposal: (await this.proposals.get(created.id))! };
  }

  /**
   * Every landed version of one page, newest first, across the namespaces a
   * workplace's rooms recorded them in (a proposal is filed in its agent's
   * room; the page is the workplace's). A rename shows under both names.
   */
  async pageHistory(namespaces: readonly string[], page: string): Promise<KnowledgePageVersion[]> {
    const docs = (await Promise.all([...new Set(namespaces)].map((namespace) => this.proposals.listByUser(namespace)))).flat();
    const versions: Array<Omit<KnowledgePageVersion, 'canRestore'>> = [];
    for (const proposal of docs) {
      if (proposal.status !== 'approved') continue;
      for (const change of proposal.changes) {
        if (change.page === page || (change.action === 'rename' && change.renameTo === page)) {
          versions.push({ proposal, change });
        }
      }
    }
    versions.sort((a, b) => (b.proposal.decidedAt ?? b.proposal.createdAt).localeCompare(a.proposal.decidedAt ?? a.proposal.createdAt)
      || b.proposal.number - a.proposal.number);
    return versions.map((version, at) => ({
      ...version,
      canRestore: version.change.action === 'rename'
        ? at === 0 && version.change.renameTo === page
        : version.change.action === 'create' || version.change.previousHtml !== undefined,
    }));
  }

  /**
   * Put a page back in one step (note #746). With no `toNumber`, the page
   * goes back to what it was BEFORE its latest landed change (that change's
   * `previousHtml`; a create is undone by removing the page, a removal by
   * writing the page again). With `toNumber`, the page becomes what that
   * record landed. The restore is itself a landed record, so it can be put
   * back too, and nothing in history is ever rewritten.
   */
  async restore(args: {
    namespaces: readonly string[];
    page: string;
    toNumber?: number;
    actor: { agentId: string; userId: string; namespaceId: string };
    note?: string;
    numbering?: NumberSeries;
  }): Promise<KnowledgeApplyResult | { status: 'nothing'; reason: string }> {
    const history = await this.pageHistory(args.namespaces, args.page);
    let wanted: string | null;
    let title: string;
    let lostFiles: string[] = [];
    const record = (change: KnowledgePageChange, title: string) => this.apply({
      userId: args.actor.namespaceId,
      createdByUserId: args.actor.userId,
      createdByAgentId: args.actor.agentId,
      title,
      ...(args.note ? { note: args.note } : {}),
      changes: [change],
      restoreOf: { page: args.page, ...(args.toNumber !== undefined ? { toNumber: args.toNumber } : {}) },
    }, args.numbering);
    if (args.toNumber !== undefined) {
      const version = history.find((entry) => entry.proposal.number === args.toNumber);
      if (!version) return { status: 'nothing', reason: `No landed change #${args.toNumber} touched "${args.page}".` };
      if (version.change.action === 'rename') {
        return { status: 'nothing', reason: `#${version.proposal.number} renamed "${version.change.page}" to "${version.change.renameTo}" and changed no words. Undo it with \`agentbuilt knowledge restore ${version.change.renameTo}\` while it is the latest change; the words themselves are put back from an earlier or later version.` };
      }
      wanted = version.change.action === 'delete' ? null : (version.change.html ?? '');
      title = `Put "${args.page}" back as it was after #${version.proposal.number}`;
    } else {
      const [latest] = history;
      if (!latest) return { status: 'nothing', reason: `"${args.page}" has no recorded changes to go back from.` };
      if (latest.change.action === 'rename') {
        // The inverse of a rename is the rename back — from the renamed page.
        if (latest.change.renameTo !== args.page) {
          return { status: 'nothing', reason: `"${args.page}" was renamed to "${latest.change.renameTo}" by #${latest.proposal.number}. Put it back from there: \`agentbuilt knowledge restore ${latest.change.renameTo}\`.` };
        }
        const shas = await this.currentShas(args.actor.namespaceId);
        const here = shas.get(args.page);
        if (!here) return { status: 'nothing', reason: `"${args.page}" is not on the shelf any more.` };
        if (shas.has(latest.change.page)) return { status: 'nothing', reason: `"${latest.change.page}" exists again, so the rename cannot be undone onto it.` };
        return record(
          { page: args.page, action: 'rename', renameTo: latest.change.page, baseSha: here },
          `Put "${latest.change.page}" back (undo the rename to "${args.page}" in #${latest.proposal.number})`,
        );
      }
      if (latest.change.action !== 'create' && latest.change.previousHtml === undefined) {
        return { status: 'nothing', reason: `The last change to "${args.page}" (#${latest.proposal.number}) was landed before versions were kept, so there is nothing to put back.` };
      }
      wanted = latest.change.action === 'create' ? null : latest.change.previousHtml ?? null;
      lostFiles = latest.change.action === 'delete' ? latest.change.previousFiles ?? [] : [];
      title = `Put "${args.page}" back as it was before #${latest.proposal.number}`;
    }
    const current = await this.readPage(args.actor.namespaceId, args.page);
    if ((current?.content ?? null) === wanted) {
      return { status: 'nothing', reason: `"${args.page}" already is that version.` };
    }
    let change: KnowledgePageChange;
    if (wanted === null) {
      change = { page: args.page, action: 'delete', baseSha: current!.sha };
    } else {
      const meta = readKnowledgePageMeta(wanted);
      change = {
        page: args.page,
        action: current ? 'edit' : 'create',
        html: wanted,
        ...('error' in meta ? {} : { title: meta.title, description: meta.description }),
        bytes: Buffer.byteLength(wanted, 'utf8'),
        baseSha: current?.sha ?? null,
      };
    }
    const result = await record(change, title);
    return result.status === 'applied' && lostFiles.length ? { ...result, lostFiles } : result;
  }
}

export type KnowledgeApplyResult =
  | {
    status: 'applied';
    commitSha: string;
    proposal: KnowledgeProposalDocument;
    orphaned: KnowledgePageAttachment[];
    /** A restore of a removed page: the files the removal cleared, which the
     *  words still point at and which have to be attached again. */
    lostFiles?: string[];
  }
  | { status: 'conflict'; pages: string[]; proposal: KnowledgeProposalDocument };

/** One landed version of a page, newest first in {@link KnowledgeService.pageHistory}. */
export interface KnowledgePageVersion {
  proposal: KnowledgeProposalDocument;
  change: KnowledgePageChange;
  /** Whether this row can be put back: the newest row to the version before
   *  it, an older row to what it landed. A rename is undone only from the
   *  renamed page and only while it is the latest thing that happened. */
  canRestore: boolean;
}

/**
 * What one proposal would do, in the words a card and a CLI line both use.
 * Separate from the service because it touches nothing: given the changes, it
 * is the same sentence everywhere.
 */
export function describeKnowledgeChanges(changes: KnowledgePageChange[]): string {
  const counts = { create: 0, edit: 0, delete: 0, rename: 0 };
  for (const change of changes) counts[change.action] += 1;
  const parts: string[] = [];
  if (counts.create) parts.push(`${counts.create} new`);
  if (counts.edit) parts.push(`${counts.edit} updated`);
  if (counts.rename) parts.push(`${counts.rename} renamed`);
  if (counts.delete) parts.push(`${counts.delete} removed`);
  const pages = changes.length === 1 ? 'page' : 'pages';
  return `${changes.length} ${pages} (${parts.join(', ')})`;
}

/**
 * The title a proposal gets when the agent did not write one. Named for what
 * it does rather than derived in the route, so the CLI and the tests agree.
 *
 * CLAMPED, because every branch below can outgrow the limit the route then
 * checks it against, and the refusal the agent would get talks about a title
 * it never wrote. A page title may be 120 characters on its own, and a rename
 * names two page names of up to 62 each — so the composed line is over the cap
 * with nothing unusual in it.
 */
export function defaultProposalTitle(changes: KnowledgePageChange[]): string {
  return clampTitle(composeProposalTitle(changes));
}

function clampTitle(title: string): string {
  if (title.length <= MAX_KNOWLEDGE_PROPOSAL_TITLE_LENGTH) return title;
  return `${title.slice(0, MAX_KNOWLEDGE_PROPOSAL_TITLE_LENGTH - 1).trimEnd()}…`;
}

function composeProposalTitle(changes: KnowledgePageChange[]): string {
  if (changes.length === 1) {
    const [change] = changes as [KnowledgePageChange];
    if (change.action === 'delete') return `Remove the "${change.page}" knowledge page`;
    // Named by both addresses, because that IS the change — the words are
    // untouched, so a title saying only what the page is called would read as
    // though nothing had happened.
    if (change.action === 'rename') return `Rename "${change.page}" to "${change.renameTo}"`;
    const name = change.title ?? change.page;
    return change.action === 'create' ? `Add "${name}" to knowledge` : `Update "${name}"`;
  }
  return `Update ${describeKnowledgeChanges(changes)} of knowledge`;
}
