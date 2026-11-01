/**
 * An internal git repository: a bare repo on the media box's filesystem,
 * owned by a USER and writable by every agent that user owns
 * (docs/agent-git-phase1.md).
 *
 * The point of the feature is durability: an agent machine is one volume the
 * recycler destroys after FLY_RECYCLE_IDLE_DAYS idle days, so anything not
 * pushed dies with it. The repo outlives the machine, and the user's other
 * agents can read it — which is also the whole collaboration story.
 */

export interface GitRepoDocument {
  id: string;
  /**
   * The repo's NAMESPACE — the first segment of its clone URL and disk path.
   * Historically a userId, and on the central host it still is one; since the
   * org layer it is resolved through `OrgGitService`, so every member of a
   * stamped org reads and writes the same namespace (byo-git-design slice 1).
   * The field keeps its name because the sqlite column and the host's wire
   * shape (`/git/verify` answers, push reports) already carry it as `userId`.
   */
  userId: string;
  /**
   * The org whose members share this repo — stamped at creation from the
   * creating agent's membership, backfilled for repos that predate it. Absent
   * on a personal (org-less) namespace. Informational for now: authorization
   * flows through the namespace, this answers "whose is it" without a
   * membership walk.
   */
  orgId?: string;
  /** Unique per WORKPLACE among live repos (note #566) — per namespace on a
   *  personal account — not globally: one org's `api` never collides. */
  name: string;
  /** The agent that ran `agentbuilt repo create`. Informational only. */
  createdByAgentId: string;
  /**
   * Anonymous, read-only access to this repository.
   *
   * The id is deliberately unrelated to the repository's namespace or name:
   * public repositories are LINK-ONLY, not listed in a directory, and a
   * rename must not break a link somebody already shared. Withdrawing access
   * clears the whole object; publishing again mints a new id, so the old link
   * stays dead. The git host does not trust this copy locally — it asks the
   * backend on every anonymous fetch and is never allowed to push.
   */
  publicAccess?: {
    id: string;
    publishedAt: string;
    publishedByUserId: string;
  };
  /**
   * Recorded from the first push rather than assumed: `main` is our default
   * but the CLI a user's agent runs may init `master`, and the protected-branch
   * rule (phase 2) must protect the branch that actually exists.
   */
  defaultBranch?: string;
  /**
   * Refreshed by the host's post-receive hook. Drives `repo list` and the
   * per-user quota check, so a stale value is a slightly wrong quota, never a
   * wrong answer about who owns what.
   */
  sizeBytes: number;
  /**
   * Phase 2's approval gate: pushes that move {@link defaultBranch} are
   * refused, and only a user-approved merge may move it. Stored per repo so a
   * scratch repo can opt out (`repo create --unprotected`) without weakening
   * the default.
   */
  protectDefaultBranch: boolean;
  /**
   * Opt-in, one-way: an approval on this repo's proposals is honoured only
   * when the pinned sha's checks all pass (skipped counts as passing; none at
   * all does not). The default everywhere else stays "checks INFORM the
   * button, they never disable it" — this flag is the one repo-scoped
   * exception, for repos whose protected branch drives something real.
   */
  requireChecks?: boolean;
  /**
   * Names of the user's SHARED secrets handed to this repo's CI jobs — and
   * only to jobs on a protected branch, which carries nothing the owner has
   * not approved through the merge gate. Since note #739 an ADMIN's agent
   * writes this list at once (`repo ci-secrets`) and the owner is told, not
   * asked: the merge gate is the approval the secrets ride behind. Any agent
   * may REMOVE names — narrowing, like protection.
   */
  /**
   * Whether a push to this repo tells the CI dispatcher, so its committed
   * `.agentbuilt/ci.sh` runs on a throwaway machine. Off until asked for:
   * a CI run costs a VM, and until per-user budgets exist that is a cost
   * somebody should choose. The repo's git config on the host is the TRUTH
   * (same division as protection); this flag is the product's copy, so
   * `repo list` costs no host calls.
   */
  ci?: boolean;
  ciSecrets?: string[];
  /**
   * The namespace {@link ciSecrets} was granted from (note #566), recorded
   * when the grant was made (an old room's, before note #843). Secrets belong to the
   * workplace since note #783, so the secret store maps this to the
   * workplace's one set; it still says which room asked. Absent on grants
   * from before this field: those draw from the namespace the repo lives at.
   * Read it through {@link repoCiSecretsNamespaceId}.
   */
  ciSecretsNamespaceId?: string;
  /**
   * LEGACY (note #739): the ask that used to await the owner's tap on the
   * repository's screen. Nothing writes it any more; every path that finds
   * one clears it, and a grant made since covers it.
   */
  ciSecretsAsk?: {
    names: string[];
    byAgentId: string;
    byUserId?: string;
    /** The asking agent's room namespace: the store the names were checked
     *  against, and the one the grant will name. */
    namespaceId?: string;
    at: string;
  };
  /**
   * The site an approved change publishes to (`agentbuilt repo publish`).
   * With this set, a run of `.agentbuilt/ci.sh` on the protected branch that
   * passes is followed by the repository's `.agentbuilt/deploy.sh`, handed a
   * one-hour key for THIS site only — so approving a merge is publishing it,
   * with no agent awake to do it by hand.
   *
   * Written at once by an admin's agent (note #739), like {@link ciSecrets};
   * the owner is told that approving now publishes. Any agent may take it
   * off (narrowing).
   *
   * `siteId` is the deployment record, so a rename keeps the link; the name
   * is only what the owner was shown. The publish runs AS `byAgentId` — the
   * agent that asked — because a service reads its saved keys from whoever
   * deploys it, and a key with nobody behind it could not hand those on.
   */
  publishTo?: {
    siteId: string;
    site: string;
    byAgentId: string;
    byUserId: string;
    at: string;
  };
  /** LEGACY (note #739): the link that used to await the owner's answer.
   *  Nothing writes it any more; paths that find one clear it. */
  publishAsk?: {
    siteId: string;
    site: string;
    byAgentId: string;
    byUserId: string;
    at: string;
  };
  /**
   * Deleted, and waiting out the window (docs/agent-git-project-repos.md
   * slice 5). A tombstoned repo is INVISIBLE to every path that asks for a
   * repo by name — it is gone as far as pushes, proposals and quota are
   * concerned — and stays that way unless `repo restore` brings it back.
   * The bytes are in the host's trash for {@link GIT_TRASH_KEEP_DAYS} days;
   * after that the host purges them and this record is a fact about the past.
   */
  deletedAt?: string;
  deletedByAgentId?: string;
  /** The host's trash entry (`<name>.<stamp>.git`) — restore names it back,
   *  so two deletes of one name can never resolve to the wrong bytes. */
  trashedAs?: string;
  /**
   * A delete awaiting the owner's tap, on a repo whose branch is protected:
   * everything in it landed by their approval, so it leaves by their hand
   * too. One at a time, newest wins, cleared on decision — the same shape as
   * {@link ciSecretsAsk}, for the same reason (including `byUserId`).
   */
  deleteAsk?: { byAgentId: string; byUserId?: string; at: string };
  createdAt: string;
  lastPushAt?: string;
  /**
   * The tip of {@link defaultBranch} as of the last push report. Kept so the
   * next report can tell whether that branch MOVED — the host only says where
   * the tip is now, never which refs a push updated.
   */
  defaultBranchTipSha?: string;
  /**
   * When something last LANDED on {@link defaultBranch}: a push observed to
   * move its tip, a repo's very first push, or an approved merge. `lastPushAt`
   * stamps any push wherever it landed; this one lets a UI say "pushed 3d ago
   * to main" and be stating a fact (Owner's precision rule, 2026-08-10).
   * Absent until a landing is observed — never backfilled from a guess.
   */
  defaultBranchPushAt?: string;
  /**
   * Who has written this repository, kept on the record rather than asked for
   * on every read: counting them is a `git log --numstat` over the history,
   * which is seconds on a big repo and would be paid by every load of the
   * workspace home if it were not stored here.
   *
   * Refreshed on the push report, INCREMENTALLY — `sha` is what the totals
   * are counted to, and the host is asked only for what landed after it.
   */
  contributors?: RepoContributors;
}

/** One author's totals, as git counts them. Raw: an email, not an agent —
 *  resolving that is a display question, and an agent can be renamed. */
export interface RepoAuthorTotals {
  name: string;
  email: string;
  commits: number;
  insertions: number;
  deletions: number;
}

export interface RepoContributors {
  /** The default-branch tip these totals were counted to. */
  sha: string;
  countedAt: string;
  /** Most commits first — the order every surface shows them in. */
  authors: RepoAuthorTotals[];
}

/**
 * What to STORE after a count, or null when the answer is not worth writing.
 *
 * Both callers — the push report and the repository's own screen — ask the
 * host the same question and face the same two edge cases, so the decision
 * lives here rather than as a condition copied into each of them:
 *
 * - No tip at all: a branch with no commits, or one that has gone. There is
 *   nothing to count and nothing to say.
 * - A full recount that found NOBODY, over a list that already has people in
 *   it. Genuinely possible (rewrite a history down to merges alone) and far
 *   more likely to be the host having a bad day, so the last good list stands.
 *   The cost of being wrong here is a stale list; the cost the other way is
 *   the user watching their contributors vanish.
 */
export function nextContributors(
  stored: RepoContributors | undefined,
  counted: { tipSha: string | null; from: string | null; authors: RepoAuthorTotals[] },
  countedAt: string,
): RepoContributors | null {
  if (!counted.tipSha) return null;
  if (!counted.authors.length) {
    if (stored?.authors.length && !counted.from) return null;
    // Nothing new on a usable base: only the sha moves, so the next call can
    // start from here instead of walking the same commits again.
    if (stored && counted.tipSha === stored.sha) return null;
  }
  return {
    sha: counted.tipSha,
    countedAt,
    authors: mergeContributorTotals(stored?.authors, counted.authors, counted.from),
  };
}

/**
 * Fold a delta into the totals already counted, or replace them.
 *
 * `from` is the host's answer to "was your sha usable as a base": the sha
 * itself means these authors are only what landed since, and null means the
 * history was rewritten (or never counted) and the delta IS the whole truth.
 * Getting that backwards would double every number on a force-push, which is
 * the reason this is a named function with tests rather than four lines
 * inside a route.
 *
 * Authors merge by EMAIL, lowercased: one address is one contributor, whatever
 * name they were committing under that month. The most recent spelling of the
 * name wins, because that is the one the reader will recognise.
 */
export function mergeContributorTotals(
  existing: RepoAuthorTotals[] | undefined,
  delta: RepoAuthorTotals[],
  from: string | null,
): RepoAuthorTotals[] {
  const totals = new Map<string, RepoAuthorTotals>();
  if (from) {
    for (const author of existing ?? []) {
      totals.set(author.email.toLowerCase(), { ...author });
    }
  }
  for (const author of delta) {
    const key = author.email.toLowerCase();
    const seen = totals.get(key);
    if (!seen) {
      totals.set(key, { ...author });
      continue;
    }
    seen.name = author.name || seen.name;
    seen.commits += author.commits;
    seen.insertions += author.insertions;
    seen.deletions += author.deletions;
  }
  return [...totals.values()].sort((a, b) => (
    b.commits - a.commits
    || (b.insertions + b.deletions) - (a.insertions + a.deletions)
    // Two contributors with identical numbers still need ONE order, or the
    // list reshuffles itself between reads for no reason.
    || a.email.localeCompare(b.email)
  ));
}

/**
 * Storage budget for the SHARED central box (`ia-media`): see
 * docs/agent-git-phase1.md for the original survey, and note #62 for both
 * revisions since.
 *
 * `GIT_USER_MAX_BYTES` is a FAIR SHARE of that one disk — the right shape
 * there and only there: an org with its own git host has its own volume, on
 * its own bill, and `gitUserMaxBytesForVolume` sizes that one.
 *
 * 5 GB since 2026-08-27 (Owner, note #62; was 1 GB). The 1 GB was a tenth of
 * a disk git shared with the platform's whole media store — sized for ~30
 * tenants who had not arrived, and kept small to protect MinIO beside it.
 * That day the media moved to Tigris and the box became git-only: 38 GB with
 * ~3 GB used, and the real guard is the host's own refusal to create repos
 * past 80% disk (`DISK_MAX_USED_PERCENT`), which stands whatever this says.
 * Seven namespaces at full quota still fit under that watermark; a shared
 * disk still deserves SOME per-tenant number, which is why this is 5 GB and
 * not gone.
 */
export const GIT_REPO_MAX_BYTES = 300 * 1024 * 1024;
export const GIT_USER_MAX_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * How much of an org's own volume its repos may fill. The same 80% the git
 * host itself refuses to create repos above (`DISK_MAX_USED_PERCENT` in
 * git-host.mjs) — deliberately ONE number, because two would mean a push the
 * quota allows and the disk guard refuses, which reads as a broken host
 * rather than as a full one.
 *
 * The remaining fifth is not slack: a push writes its packfile before the
 * hook that measures it runs, `gc` repacks into a second copy before dropping
 * the first, and deleted repos sit in the trash for
 * `GIT_TRASH_KEEP_DAYS` still holding their bytes.
 */
export const GIT_VOLUME_USABLE_PERCENT = 80;

/**
 * The push ceiling for a namespace on the org's OWN volume (note #62, Owner
 * 2026-08-27). It used to be `GIT_USER_MAX_BYTES` regardless of which disk
 * the repos were on, which had two consequences worth naming: an org was
 * capped at a tenth of a volume it pays for, and the admin's "grow the
 * volume" tap moved no ceiling at all — 100 GB of volume, still 1 GB of
 * repos.
 */
export function gitUserMaxBytesForVolume(volumeGb: number): number {
  return Math.floor(volumeGb * 1024 * 1024 * 1024 * (GIT_VOLUME_USABLE_PERCENT / 100));
}

/**
 * How long a deleted repo can be restored. The number that MATTERS lives on
 * the git host (`TRASH_KEEP_DAYS` in maintain-repos.sh, which is the only
 * thing that purges); this copy exists so the product can say the window out
 * loud, and the two are kept equal on purpose — promising a longer one here
 * would be promising something the disk does not do.
 */
export const GIT_TRASH_KEEP_DAYS = 14;

/** Live repos only. A tombstone is a fact about the past: it holds no bytes
 *  against the quota, occupies no name, and answers no lookup by name. */
export function isLiveRepo(doc: Pick<GitRepoDocument, 'deletedAt'>): boolean {
  return !doc.deletedAt;
}

/** Whose secret store a repo's CI grant draws from; see
 *  {@link GitRepoDocument.ciSecretsNamespaceId}. */
export function repoCiSecretsNamespaceId(
  doc: Pick<GitRepoDocument, 'userId' | 'ciSecretsNamespaceId'>,
): string {
  return doc.ciSecretsNamespaceId ?? doc.userId;
}

/** Same shape as deployment names, but the namespace is per user. */
export const GIT_REPO_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,60}[a-z0-9]$/;

export function validateGitRepoName(name: string): string | null {
  if (!GIT_REPO_NAME_PATTERN.test(name)) {
    return 'Repo names are 2–62 characters: lowercase letters, digits, dots, hyphens and underscores, starting and ending with a letter or digit.';
  }
  // `..` would escape the namespace directory the moment any path is built
  // from name + userId, and `.git` suffixes confuse the URL parser on the
  // host (`<name>.git` is how every repo path already ends).
  if (name.includes('..')) {
    return 'Repo names cannot contain "..".';
  }
  if (name.endsWith('.git')) {
    return 'Leave the ".git" off — it is added to the clone URL for you.';
  }
  return null;
}
