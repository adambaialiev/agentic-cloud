import { randomUUID } from 'node:crypto';
import { isLiveRepo, type GitRepoDocument } from '../types/git-repo.js';

/**
 * Storage for internal git repos (docs/agent-git-phase1.md). The registry is
 * the BACKEND's: the host owns bytes on disk, the backend owns who may touch
 * them. Keeping those apart is what makes the authorization rule one line
 * (the userId in the URL must equal the userId the token resolves to).
 *
 * Uniqueness of `name` is enforced here, among LIVE repos: across the
 * namespaces the caller names (a workplace's, note #566 — a repository belongs
 * to the workplace, and its namespace is only the address its bytes live at),
 * or within the repo's own namespace when none are named.
 */
export interface GitRepoStorage {
  create(
    doc: Omit<GitRepoDocument, 'id' | 'createdAt'>,
    uniqueAcrossNamespaceIds?: readonly string[],
  ): Promise<GitRepoDocument>;
  get(id: string): Promise<GitRepoDocument | null>;
  /** A live repository carrying this opaque public link id, or null. */
  getPublicById(publicId: string): Promise<GitRepoDocument | null>;
  /** Every LIVE public repository, oldest first — what a person's public
   *  page walks to find the ones git counts them in (public-addresses). */
  listPublic(): Promise<GitRepoDocument[]>;
  /**
   * LIVE repos only, here and in {@link listByUser} — a deleted repo answers
   * nothing by name. That is the whole reason delete is a tombstone rather
   * than a flag every caller must remember to check: `repo delete` reaches
   * one route, while "a repo by name" is reached by pushes, proposals, CI
   * secrets, the Mini App and the quota, and any of those forgetting the flag
   * would be a repo the user deleted still working.
   */
  getByName(userId: string, name: string): Promise<GitRepoDocument | null>;
  listByUser(userId: string): Promise<GitRepoDocument[]>;
  /**
   * LIVE repos of a workplace (note #566): every repository whose bytes live
   * at one of the workplace's namespaces. These are the reads used by agents
   * and the screens, whichever room they stand in; host callbacks keep using
   * the single-namespace methods above because the URL already names where
   * the bytes live. A personal account passes its one namespace.
   */
  getLiveByNameIn(namespaceIds: readonly string[], name: string): Promise<GitRepoDocument | null>;
  listLiveIn(namespaceIds: readonly string[]): Promise<GitRepoDocument[]>;
  /** The trash: deleted, not yet purged, restorable. Newest first — the one
   *  somebody is looking for is almost always the one they just deleted. */
  listTrashedByUser(userId: string): Promise<GitRepoDocument[]>;
  listTrashedIn(namespaceIds: readonly string[]): Promise<GitRepoDocument[]>;
  /** A trashed repo by the name it had. Newest first, same reasoning. */
  getTrashedByName(userId: string, name: string): Promise<GitRepoDocument | null>;
  getTrashedByNameIn(namespaceIds: readonly string[], name: string): Promise<GitRepoDocument | null>;
  /**
   * Every namespace at which a workplace's repositories live — live ones and
   * trashed ones alike, so a restore still finds its bytes (note #566). A
   * repository belongs to the workplace and keeps its address for good, so it
   * can outlive the ROOM whose namespace that address was; this is how the
   * workplace still knows the address is its own once the room row is gone.
   */
  listNamespacesByOrg(orgId: string): Promise<string[]>;
  update(id: string, updates: Partial<GitRepoDocument>): Promise<boolean>;
  /**
   * The row itself, gone — only a deleted WORKPLACE does this (2026-09-22).
   * Every other delete is the tombstone above; this is for the day nothing
   * is left for a tombstone to answer to.
   */
  delete?(id: string): Promise<boolean>;
  /** Total bytes across a user's LIVE repos — the per-user quota's left-hand
   *  side. Trash does not count: a user who asked for a repo to be gone should
   *  not keep paying quota for it while the window runs out. */
  totalBytesForUser(userId: string): Promise<number>;
}

/** Newest first by deletion time, for both trash readers. */
export function byDeletedAtDesc(a: GitRepoDocument, b: GitRepoDocument): number {
  return (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '');
}

export class InMemoryGitRepoStorage implements GitRepoStorage {
  private docs = new Map<string, GitRepoDocument>();

  async delete(id: string): Promise<boolean> {
    return this.docs.delete(id);
  }

  async create(
    doc: Omit<GitRepoDocument, 'id' | 'createdAt'>,
    uniqueAcrossNamespaceIds: readonly string[] = [],
  ): Promise<GitRepoDocument> {
    if (await this.getLiveByNameIn([doc.userId, ...uniqueAcrossNamespaceIds], doc.name)) {
      throw new Error(`repo "${doc.name}" already exists on this account`);
    }
    const full: GitRepoDocument = {
      ...doc,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.docs.set(full.id, full);
    return full;
  }

  async get(id: string): Promise<GitRepoDocument | null> {
    return this.docs.get(id) ?? null;
  }

  async getPublicById(publicId: string): Promise<GitRepoDocument | null> {
    for (const doc of this.docs.values()) {
      if (isLiveRepo(doc) && doc.publicAccess?.id === publicId) return doc;
    }
    return null;
  }

  async listPublic(): Promise<GitRepoDocument[]> {
    return [...this.docs.values()]
      .filter((doc) => isLiveRepo(doc) && Boolean(doc.publicAccess))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getByName(userId: string, name: string): Promise<GitRepoDocument | null> {
    for (const doc of this.docs.values()) {
      if (doc.userId === userId && doc.name === name && isLiveRepo(doc)) return doc;
    }
    return null;
  }

  async listByUser(userId: string): Promise<GitRepoDocument[]> {
    return [...this.docs.values()]
      .filter((doc) => doc.userId === userId && isLiveRepo(doc))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getLiveByNameIn(namespaceIds: readonly string[], name: string): Promise<GitRepoDocument | null> {
    return (await this.listLiveIn(namespaceIds)).find((doc) => doc.name === name) ?? null;
  }

  async listLiveIn(namespaceIds: readonly string[]): Promise<GitRepoDocument[]> {
    return [...this.docs.values()]
      .filter((doc) => isLiveRepo(doc) && namespaceIds.includes(doc.userId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listTrashedIn(namespaceIds: readonly string[]): Promise<GitRepoDocument[]> {
    return [...this.docs.values()]
      .filter((doc) => !isLiveRepo(doc) && namespaceIds.includes(doc.userId))
      .sort(byDeletedAtDesc);
  }

  async getTrashedByNameIn(namespaceIds: readonly string[], name: string): Promise<GitRepoDocument | null> {
    return (await this.listTrashedIn(namespaceIds)).find((doc) => doc.name === name) ?? null;
  }

  async listTrashedByUser(userId: string): Promise<GitRepoDocument[]> {
    return [...this.docs.values()]
      .filter((doc) => doc.userId === userId && !isLiveRepo(doc))
      .sort(byDeletedAtDesc);
  }

  async getTrashedByName(userId: string, name: string): Promise<GitRepoDocument | null> {
    return (await this.listTrashedByUser(userId)).find((doc) => doc.name === name) ?? null;
  }

  async listNamespacesByOrg(orgId: string): Promise<string[]> {
    return [...new Set([...this.docs.values()].filter((doc) => doc.orgId === orgId).map((doc) => doc.userId))];
  }

  async update(id: string, updates: Partial<GitRepoDocument>): Promise<boolean> {
    const doc = this.docs.get(id);
    if (!doc) return false;
    this.docs.set(id, { ...doc, ...updates });
    return true;
  }

  async totalBytesForUser(userId: string): Promise<number> {
    const docs = await this.listByUser(userId);
    return docs.reduce((sum, doc) => sum + (doc.sizeBytes || 0), 0);
  }
}
