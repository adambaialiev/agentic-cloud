import type { MarginComment } from '../types/comment.js';
import type { KnowledgePageChange } from '../types/knowledge.js';

/**
 * The margin under a knowledge PAGE (Owner, note #66).
 *
 * Pages live in git — one blob per page, changed only through an approved
 * proposal — and their margin deliberately does not. A remark is not part of
 * the reviewed document: it needs no approval, it signs one voice rather than
 * joining the page's, and a comment that cost a commit would write the
 * conversation into a history that is meant to be the pages themselves. So
 * threads live BESIDE the base, keyed by the page's name in its namespace.
 *
 * A thread dies with its page: when a delete lands, the caller drops the
 * margin too, so a page recreated under the same name later starts clean
 * rather than wearing remarks about a document nobody can read any more.
 *
 * A RENAME is the opposite case and the reason `renamePage` exists. The page
 * is the same document at a new address, so its margin travels with it —
 * without that, renaming a page would silently destroy the conversation under
 * it, and every agent who noticed would (rightly) leave a stale name alone
 * rather than pay that price.
 *
 * Whether the page EXISTS is the routes' question (they hold the git host);
 * this store answers only for the margin.
 */
export interface KnowledgePageCommentStorage {
  /** Oldest first, the order every margin appends in. Empty when none. */
  list(userId: string, page: string): Promise<MarginComment[]>;
  /**
   * Appends a remark and returns the whole thread. Atomic, like every
   * `addComment` here: the writers are a person tapping Send and an agent
   * mid-turn, and a read-modify-write from each would quietly drop one.
   */
  add(userId: string, page: string, comment: MarginComment): Promise<MarginComment[]>;
  /** Replaces one remark without dropping one appended concurrently. */
  edit(userId: string, page: string, commentId: string, text: string, editedAt: string): Promise<MarginComment[] | null>;
  /** Takes one remark out of the thread, for the person who wrote it, without
   *  dropping one appended concurrently. `null` when it is already gone. */
  remove(userId: string, page: string, commentId: string): Promise<MarginComment[] | null>;
  /** The page is gone; take its margin with it. */
  deletePage(userId: string, page: string): Promise<void>;
  /** The whole room is gone; every page margin in its namespace goes too. */
  deleteByUser(userId: string): Promise<number>;
  /**
   * The page moved to a new name; its margin moves with it. Anything already
   * filed under the new name is REPLACED — the only way to reach that state is
   * a page that was deleted and whose thread outlived it, and the remarks
   * arriving belong to the document that is actually there now.
   */
  renamePage(userId: string, from: string, to: string): Promise<void>;
  /**
   * The page moved to ANOTHER namespace's shelf (note #566: a room's page
   * joining the workplace's one shelf), possibly under a new name. Its thread
   * follows and is APPENDED to whatever the destination already holds — unlike
   * a rename, nothing there is known to be stale. Idempotent: a second call
   * finds nothing left to move.
   */
  movePage(fromUserId: string, fromPage: string, toUserId: string, toPage: string): Promise<void>;
}

/**
 * Margins follow the shelf (note #566). Every caller keeps naming the
 * namespace it stands in — a room's — and the thread is filed under the
 * workplace's one shelf, the same mapping `KnowledgeService` applies to the
 * pages themselves. `deleteByUser` is deliberately NOT mapped: it means "this
 * namespace is gone", and mapping it would let one room's removal clear the
 * whole workplace's margins.
 */
export function shelfMappedPageComments(
  inner: KnowledgePageCommentStorage,
  shelfOf: (namespaceId: string) => Promise<string>,
): KnowledgePageCommentStorage {
  return {
    list: async (userId, page) => inner.list(await shelfOf(userId), page),
    add: async (userId, page, comment) => inner.add(await shelfOf(userId), page, comment),
    edit: async (userId, page, commentId, text, editedAt) => inner.edit(await shelfOf(userId), page, commentId, text, editedAt),
    remove: async (userId, page, commentId) => inner.remove(await shelfOf(userId), page, commentId),
    deletePage: async (userId, page) => inner.deletePage(await shelfOf(userId), page),
    deleteByUser: (userId) => inner.deleteByUser(userId),
    renamePage: async (userId, from, to) => inner.renamePage(await shelfOf(userId), from, to),
    movePage: (fromUserId, fromPage, toUserId, toPage) => inner.movePage(fromUserId, fromPage, toUserId, toPage),
  };
}

export class InMemoryKnowledgePageCommentStorage implements KnowledgePageCommentStorage {
  private threads = new Map<string, MarginComment[]>();

  private key(userId: string, page: string): string {
    return `${userId}\n${page}`;
  }

  async list(userId: string, page: string): Promise<MarginComment[]> {
    return [...(this.threads.get(this.key(userId, page)) ?? [])];
  }

  async add(userId: string, page: string, comment: MarginComment): Promise<MarginComment[]> {
    const key = this.key(userId, page);
    const next = [...(this.threads.get(key) ?? []), comment];
    this.threads.set(key, next);
    return next;
  }

  async edit(userId: string, page: string, commentId: string, text: string, editedAt: string): Promise<MarginComment[] | null> {
    const key = this.key(userId, page);
    const comments = [...(this.threads.get(key) ?? [])];
    const at = comments.findIndex((comment) => comment.id === commentId);
    if (at < 0) return null;
    comments[at] = { ...comments[at]!, text, editedAt };
    this.threads.set(key, comments);
    return comments;
  }

  async remove(userId: string, page: string, commentId: string): Promise<MarginComment[] | null> {
    const key = this.key(userId, page);
    const before = this.threads.get(key) ?? [];
    const comments = before.filter((comment) => comment.id !== commentId);
    if (comments.length === before.length) return null;
    this.threads.set(key, comments);
    return comments;
  }

  async deletePage(userId: string, page: string): Promise<void> {
    this.threads.delete(this.key(userId, page));
  }

  async deleteByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const key of this.threads.keys()) {
      if (!key.startsWith(`${userId}\n`)) continue;
      this.threads.delete(key);
      removed += 1;
    }
    return removed;
  }

  async renamePage(userId: string, from: string, to: string): Promise<void> {
    if (from === to) return;
    const thread = this.threads.get(this.key(userId, from));
    this.threads.delete(this.key(userId, from));
    if (thread) this.threads.set(this.key(userId, to), thread);
    else this.threads.delete(this.key(userId, to));
  }

  async movePage(fromUserId: string, fromPage: string, toUserId: string, toPage: string): Promise<void> {
    const from = this.key(fromUserId, fromPage);
    const to = this.key(toUserId, toPage);
    const thread = this.threads.get(from);
    if (from === to || !thread) return;
    this.threads.set(to, [...(this.threads.get(to) ?? []), ...thread]);
    this.threads.delete(from);
  }
}

/**
 * What a LANDED proposal does to the margins of the pages it touched.
 *
 * Three rules, and the middle one is why a rename exists at all:
 *
 *   delete  the page is gone, so its remarks go with it — they are about a
 *           document nobody can read any more, and the name may be reused.
 *   rename  the page is the SAME document at a new address, so its margin
 *           travels. Without this a rename would have to be a delete beside a
 *           create, which is exactly the trade that left five of this room's
 *           pages named after a product we no longer have.
 *   create / edit
 *           nothing. The words changed; the conversation about them did not.
 *
 * Best-effort by design, like the orphaned bytes beside it: the pages have
 * already landed and the index is already correct, so a margin that fails to
 * follow is untidy rather than wrong, and must never fail the receipt.
 *
 * Lives here rather than in `KnowledgeService` for the same reason the media
 * cleanup does: that service commits to git and deliberately knows about
 * nothing else.
 */
export async function moveMarginsForLandedChanges(
  storage: KnowledgePageCommentStorage | undefined,
  userId: string,
  changes: ReadonlyArray<Pick<KnowledgePageChange, 'page' | 'action' | 'renameTo'>>,
): Promise<void> {
  if (!storage) return;
  for (const change of changes) {
    if (change.action === 'delete') {
      await storage.deletePage(userId, change.page)
        .catch((error: unknown) => console.warn(`[knowledge] clearing comments on ${change.page} failed:`, error));
      continue;
    }
    if (change.action === 'rename' && change.renameTo) {
      const to = change.renameTo;
      await storage.renamePage(userId, change.page, to)
        .catch((error: unknown) => console.warn(`[knowledge] moving comments ${change.page} → ${to} failed:`, error));
    }
  }
}
