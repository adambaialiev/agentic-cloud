/**
 * The backend's client for the git host on `ia-media`
 * (docs/agent-git-phase1.md). The host owns bare repos on disk; the backend
 * owns the registry and every authorization decision. This is the only place
 * the two talk, and it talks over the private host-to-host secret — never an
 * agent token.
 *
 * Deliberately thin: create a repo directory, read its size, move it into the
 * trash or back out. All the protocol work (fetch, push, packs) happens
 * between the agent's `git` and the host directly, with no backend in the
 * data path.
 */

export interface GitHostConfig {
  /** Public base URL agents clone from, e.g. https://git.2-28-19-14.sslip.io */
  baseUrl: string;
  /** Where the backend reaches the host's control API (may be the same host). */
  controlUrl: string;
  /** Shared secret for the control API and the host's verify callback. */
  secret: string;
  fetchImpl?: typeof fetch;
}

export interface GitHostRepoStat {
  exists: boolean;
  sizeBytes: number;
  defaultBranch?: string;
  /** Read from the repo's own config — the single source of truth. */
  protectedBranches?: string[];
  /** Whether a push here notifies the CI dispatcher. */
  ci?: boolean;
}

export interface GitHostCompare {
  headSha: string;
  baseSha: string | null;
  baseExists: boolean;
  diffStat: { files: number; insertions: number; deletions: number };
  /** `at` is the commit's own author date, ISO 8601 — absent only from a host
   *  older than the field. */
  commits: Array<{ sha: string; subject: string; at?: string }>;
  patch: string;
  patchTruncated: boolean;
}

export interface GitHostTreeEntry {
  name: string;
  type: 'dir' | 'file' | 'symlink' | 'submodule';
  sizeBytes?: number;
}

/** `branch: null` means the repo has no commits yet — nothing to browse. */
export interface GitHostTree {
  branch: string | null;
  entries: GitHostTreeEntry[];
}

/**
 * Exactly one of `content`, `image`, `binary` or `tooLarge` describes the
 * body. `image.mime` comes from the host's own extension table, never from
 * anything read out of the file — the page renders it as a data URL.
 */
export interface GitHostFile {
  branch: string;
  sizeBytes: number;
  content?: string;
  image?: { mime: string; base64: string };
  binary?: boolean;
  tooLarge?: boolean;
}

export interface GitHostCommit {
  sha: string;
  authorName: string;
  /** The commit's own author date, ISO 8601. */
  at: string;
  subject: string;
}

/** What one commit changed, on top of the fields every commit listing has. */
export interface GitHostCommitDiff {
  /** The commit's own message body — everything after the subject line. */
  body: string;
  /** Empty on a root commit, more than one on a merge. */
  parents: string[];
  diffStat: { files: number; insertions: number; deletions: number };
  patch: string;
  patchTruncated: boolean;
}

/** `branch: null` means the repo has no commits yet — nothing to list. */
/** One author's totals as the host counts them, before any agent is known. */
export interface GitHostAuthorTotals {
  name: string;
  email: string;
  commits: number;
  insertions: number;
  deletions: number;
}

export interface GitHostContributors {
  branch: string | null;
  tipSha: string | null;
  /** The sha these totals are a DELTA from, or null when they are the whole. */
  from: string | null;
  authors: GitHostAuthorTotals[];
}

export interface GitHostLog {
  branch: string | null;
  commits: GitHostCommit[];
}

/** One page as the host lists it: enough to answer `knowledge list` without
 *  reading a single blob, and the sha a proposal pins against. */
export interface GitHostKnowledgeEntry {
  name: string;
  sha: string;
  sizeBytes: number;
}

export interface GitHostKnowledgeList {
  pages: GitHostKnowledgeEntry[];
  /** The derived `index.json` blob, or null before anything has landed. */
  index: string | null;
  /** The commit this listing describes — what a landing pins on (note
   *  #746). Absent from a host older than that, which then cannot refuse a
   *  commit built on a listing that has since moved. */
  head?: string | null;
}

export interface GitHostKnowledgePage {
  content: string;
  sha: string;
  sizeBytes: number;
}

export type GitHostKnowledgeCommit =
  | { status: 'committed'; commitSha: string; unchanged?: boolean }
  | { status: 'stale'; head: string | null }
  | { status: 'empty'; head: string | null };

export type GitHostMergeResult =
  | { status: 'merged'; fastForward: boolean; mergeCommitSha: string }
  | { status: 'stale'; headSha: string }
  | { status: 'conflict'; conflicts?: string[] }
  | { status: 'missing-head' };

export class GitHostClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GitHostConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** The clone URL an agent gets. The CLI never builds this itself. */
  cloneUrl(userId: string, name: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(userId)}/${encodeURIComponent(name)}.git`;
  }

  /**
   * Create the bare repo. Idempotent on the host side: a repeated call on an
   * existing directory succeeds without touching its contents, so a retried
   * `repo create` after a network blip can never wipe a repo that already has
   * commits in it.
   */
  async createRepo(
    userId: string,
    name: string,
    opts: { protectedBranches?: string[] } = {},
  ): Promise<void> {
    // The host writes these into the repo's own config, where its pre-receive
    // hook reads them — so protection survives a host restart, a move, or a
    // restore from backup, none of which this process would witness. The
    // singular field rides along for a host that predates multi-branch
    // protection: it protects the default branch, and `repo protect` can add
    // the rest once the host catches up.
    const branches = opts.protectedBranches ?? [];
    await this.call('POST', '/internal/repos', {
      userId,
      name,
      ...(branches.length ? { protectedBranch: branches[0], protectedBranches: branches } : {}),
    });
  }

  /**
   * ADD branches to a repo's protection — one-way by design, like the rest of
   * the approval gate: nothing an agent can call ever unprotects anything.
   * Answers the full protection list; refuses (409 → thrown) on a repo
   * created `--unprotected`, which is permanent.
   */
  async protect(userId: string, name: string, branches: string[]): Promise<{ branches: string[] }> {
    return await this.call('POST', '/internal/repos/protect', { userId, name, branches }) as { branches: string[] };
  }

  /**
   * Turn a repo's CI on or off. A BOOLEAN crosses this wire and nothing
   * else — the dispatcher URL lives in the host's own env, because a
   * caller-supplied one would make that host an SSRF proxy. Reversible in
   * both directions: unlike protection, CI grants no authority.
   */
  async setCi(userId: string, name: string, enabled: boolean): Promise<{ ci: boolean }> {
    return await this.call('POST', '/internal/repos/ci', { userId, name, enabled }) as { ci: boolean };
  }

  /**
   * Move a repo into the host's trash (docs/agent-git-project-repos.md slice
   * 5). The bytes are not destroyed: they sit under the retention window,
   * addressable by the `trashedAs` entry this returns, which is what
   * {@link restoreRepo} names back. `deleted: false` means the directory was
   * already gone — the state the caller asked for, so not an error.
   */
  async deleteRepo(userId: string, name: string): Promise<{ deleted: boolean; trashedAs?: string }> {
    return await this.call('POST', '/internal/repos/delete', { userId, name }) as { deleted: boolean; trashedAs?: string };
  }

  /** Move a trashed repo back under `name`. Throws (409) when the window has
   *  passed, or when a new repo took the name in the meantime. */
  async restoreRepo(userId: string, name: string, trashedAs: string): Promise<void> {
    await this.call('POST', '/internal/repos/restore', { userId, name, trashedAs });
  }

  /** Rename within the user's namespace. Protection, CI config and hooks live
   *  inside the directory, so they travel with it — the repo is the same repo
   *  at a new clone URL. Throws (409) if `newName` is taken. */
  async renameRepo(userId: string, name: string, newName: string): Promise<void> {
    await this.call('POST', '/internal/repos/rename', { userId, name, newName });
  }

  /**
   * Move a repo to another namespace, keeping its name (note #88) — how a
   * repository changes rooms, since a room IS a namespace. The clone URL
   * changes with it: `cloneUrl(toUserId, name)` is the new one, and every
   * clone anybody already has points at the old path until it is re-pointed.
   */
  async moveRepo(userId: string, name: string, toUserId: string): Promise<void> {
    await this.call('POST', '/internal/repos/move', { userId, name, toUserId });
  }

  /**
   * Run a backup on the host (byo-git slice 4): bundle-and-upload every
   * changed repo to the org's own bucket. The credentials ride this one call
   * and live on the host only for the run — the backend's sweep is the clock.
   */
  async runBackup(target: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }): Promise<{
    repos: number; uploaded: number; uploadedBytes: number; unchanged: number; pruned: number;
    failed: Array<{ repo: string; error: string }>;
  }> {
    const body = await this.call('POST', '/internal/backup/run', target) as {
      repos?: number; uploaded?: number; uploadedBytes?: number; unchanged?: number; pruned?: number;
      failed?: Array<{ repo: string; error: string }>;
    };
    return {
      repos: Number(body.repos ?? 0),
      uploaded: Number(body.uploaded ?? 0),
      uploadedBytes: Number(body.uploadedBytes ?? 0),
      unchanged: Number(body.unchanged ?? 0),
      pruned: Number(body.pruned ?? 0),
      failed: Array.isArray(body.failed) ? body.failed : [],
    };
  }

  async statRepo(userId: string, name: string): Promise<GitHostRepoStat> {
    const body = await this.call('POST', '/internal/repos/stat', { userId, name });
    const protectedBranches = (body as { protectedBranches?: unknown }).protectedBranches;
    return {
      exists: Boolean((body as { exists?: unknown }).exists),
      sizeBytes: Number((body as { sizeBytes?: unknown }).sizeBytes ?? 0),
      defaultBranch: (body as { defaultBranch?: string }).defaultBranch,
      ...(Array.isArray(protectedBranches) ? { protectedBranches: protectedBranches.map(String) } : {}),
      ...(typeof (body as { ci?: unknown }).ci === 'boolean' ? { ci: (body as { ci: boolean }).ci } : {}),
    };
  }

  /** One directory of the repo's default branch — the Mini App's explorer.
   *  `path` is '' for the root. Read-only, the host resolves the branch. */
  async tree(userId: string, name: string, path: string): Promise<GitHostTree> {
    return await this.call('POST', '/internal/repos/tree', { userId, name, path }) as GitHostTree;
  }

  /** One file of the default branch: text content, an image's bytes, or its
   *  facts when the blob is neither or is too large for a phone screen. */
  async file(userId: string, name: string, path: string): Promise<GitHostFile> {
    return await this.call('POST', '/internal/repos/file', { userId, name, path }) as GitHostFile;
  }

  /** Recent commits on the default branch — what HAPPENED in a repo, which
   *  the tree and the file view (what it CONTAINS) cannot say. */
  async log(userId: string, name: string, limit?: number): Promise<GitHostLog> {
    return await this.call('POST', '/internal/repos/log', {
      userId,
      name,
      ...(limit === undefined ? {} : { limit }),
    }) as GitHostLog;
  }

  /**
   * Who has written this repository, and how much (docs/agent-git-phase1.md).
   *
   * `since` is the sha the CALLER has already counted to, and it makes this
   * incremental: the host answers with only what landed after it, so the
   * routine refresh on a push costs a `git log` over a handful of commits
   * rather than a walk of the whole history. `from` in the answer says which
   * it did — the sha given back means "add these to what you had", and null
   * means the totals REPLACE it (a force-push, a rebase, or a first count).
   */
  async contributors(userId: string, name: string, since?: string): Promise<GitHostContributors> {
    return await this.call('POST', '/internal/repos/contributors', {
      userId,
      name,
      ...(since ? { since } : {}),
    }) as GitHostContributors;
  }

  /** What a proposal would change: merge-base..head, so the base's own new
   *  commits don't show up as part of the agent's work. */
  async compare(userId: string, name: string, base: string, head: string): Promise<GitHostCompare> {
    return await this.call('POST', '/internal/repos/compare', { userId, name, base, head }) as GitHostCompare;
  }

  /**
   * ONE commit and its diff — against its first parent, or the empty tree for
   * a root commit. `compare` cannot answer this: it takes branches, and a
   * commit's parent is `sha^`, which its validator refuses on purpose.
   */
  async commit(userId: string, name: string, sha: string): Promise<GitHostCommit & GitHostCommitDiff> {
    return await this.call('POST', '/internal/repos/commit', { userId, name, sha }) as
      GitHostCommit & GitHostCommitDiff;
  }

  /**
   * Merge an APPROVED proposal. `expectedHead` is the approval's anchor: the
   * host refuses if the branch moved after the user was asked, because they
   * approved a diff, not a branch name.
   */
  async merge(userId: string, name: string, args: {
    base: string;
    head: string;
    expectedHead: string;
    message: string;
    author?: { name: string; email: string };
    /** Land the branch as ONE commit (single parent, branch author kept). */
    squash?: boolean;
  }): Promise<GitHostMergeResult> {
    return await this.call('POST', '/internal/repos/merge', { userId, name, ...args }) as GitHostMergeResult;
  }

  // ── Knowledge pages (docs/agent-knowledge-pages.md) ──
  //
  // The base is a bare repo in the user's namespace under a name no git
  // request can reach, so it has no clone URL and no push path: these three
  // calls are the ONLY way content gets in or out of it, and every one of
  // them is behind the backend's own authorization.

  /** Every page in the user's knowledge base, with the blob sha a proposal
   *  pins against, plus the derived index blob if one has been written. */
  async knowledgeList(userId: string): Promise<GitHostKnowledgeList> {
    return await this.call('POST', '/internal/knowledge/list', { userId }) as GitHostKnowledgeList;
  }

  /** One page's source. Throws (409) when there is no such page. */
  async knowledgeRead(userId: string, page: string): Promise<GitHostKnowledgePage> {
    return await this.call('POST', '/internal/knowledge/read', { userId, page }) as GitHostKnowledgePage;
  }

  /** Permanently remove one room's complete knowledge base. This is not a
   *  page-edit verb and has no agent-facing route: it is used only after the
   *  person confirms deletion of the room itself. */
  async deleteKnowledge(userId: string): Promise<void> {
    await this.call('POST', '/internal/knowledge/delete', { userId });
  }

  /**
   * Land an approved proposal as one commit. `expectedHead` is the anchor: if
   * the base moved since the caller read it, the host answers `stale` rather
   * than committing on top of something nobody looked at.
   */
  async knowledgeCommit(userId: string, args: {
    writes?: Array<{ path: string; content: string }>;
    deletes?: string[];
    message: string;
    author?: { name: string; email: string };
    expectedHead?: string | null;
  }): Promise<GitHostKnowledgeCommit> {
    return await this.call('POST', '/internal/knowledge/commit', {
      userId,
      ...args,
      ...(args.expectedHead ? { expectedHead: args.expectedHead } : {}),
    }) as GitHostKnowledgeCommit;
  }

  private async call(method: string, path: string, payload: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.config.controlUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        // Not an agent token: this credential says "I am the backend", and it
        // is the only thing that may create or inspect a repo directory.
        'x-git-host-secret': this.config.secret,
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`git host ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`git host ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
}
