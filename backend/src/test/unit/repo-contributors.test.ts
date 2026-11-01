import { describe, expect, it } from 'vitest';
import {
  mergeContributorTotals,
  nextContributors,
  type RepoAuthorTotals,
} from '../../types/git-repo.js';

/**
 * The arithmetic behind the contributor lists (docs/agent-git-phase1.md).
 *
 * It ACCUMULATES, which is the whole reason it is a named function with tests:
 * the push report hands it a delta and the stored totals, and getting the
 * "was my base usable" flag backwards would double every number on the first
 * force-push and nobody would notice until the figures were obviously silly.
 */

const author = (over: Partial<RepoAuthorTotals> = {}): RepoAuthorTotals => ({
  name: 'Ruby', email: 'ruby@agentbuilt.app', commits: 1, insertions: 10, deletions: 2, ...over,
});

describe('mergeContributorTotals', () => {
  it('adds a delta to what was already counted', () => {
    const merged = mergeContributorTotals(
      [author({ commits: 10, insertions: 100, deletions: 20 })],
      [author({ commits: 2, insertions: 30, deletions: 5 })],
      'a'.repeat(40),
    );
    expect(merged).toEqual([
      author({ commits: 12, insertions: 130, deletions: 25 }),
    ]);
  });

  it('REPLACES what was counted when the base was not usable', () => {
    // `from: null` is the host saying the history was rewritten (or never
    // counted). Adding here would double a force-pushed repository's numbers.
    const merged = mergeContributorTotals(
      [author({ commits: 10, insertions: 100, deletions: 20 })],
      [author({ commits: 3, insertions: 33, deletions: 3 })],
      null,
    );
    expect(merged).toEqual([author({ commits: 3, insertions: 33, deletions: 3 })]);
  });

  it('counts one address as one contributor, whatever name it committed under', () => {
    const merged = mergeContributorTotals(
      [author({ name: 'Ruby', commits: 5 })],
      [author({ name: 'Ruby (agent)', email: 'RUBY@agentbuilt.app', commits: 1 })],
      'a'.repeat(40),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.commits).toBe(6);
    // The newest spelling wins: it is the one the reader will recognise.
    expect(merged[0]!.name).toBe('Ruby (agent)');
  });

  it('keeps two different addresses apart', () => {
    const merged = mergeContributorTotals(
      [],
      [author({ email: 'ruby@agentbuilt.app' }), author({ name: 'Leo', email: 'leo@agentbuilt.app' })],
      null,
    );
    expect(merged.map((a) => a.email)).toEqual(['leo@agentbuilt.app', 'ruby@agentbuilt.app']);
  });

  it('puts the most commits first, and breaks a tie the same way every time', () => {
    const merged = mergeContributorTotals([], [
      author({ name: 'C', email: 'c@x', commits: 5, insertions: 1, deletions: 1 }),
      author({ name: 'A', email: 'a@x', commits: 9, insertions: 1, deletions: 1 }),
      // Same commits as C, more lines moved: lines are the tiebreak.
      author({ name: 'B', email: 'b@x', commits: 5, insertions: 90, deletions: 10 }),
      // Identical to C in every number — the address decides, so the list
      // does not reshuffle itself between two reads of the same data.
      author({ name: 'D', email: 'd@x', commits: 5, insertions: 1, deletions: 1 }),
    ], null);
    expect(merged.map((a) => a.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('takes a first count with nothing stored at all', () => {
    expect(mergeContributorTotals(undefined, [author()], null)).toEqual([author()]);
    // And an empty delta on a usable base changes nothing — the "already up
    // to date" answer the host gives when no new commits landed.
    expect(mergeContributorTotals([author({ commits: 7 })], [], 'a'.repeat(40)))
      .toEqual([author({ commits: 7 })]);
  });

  it('does not let an empty delta on an unusable base erase the list', () => {
    // This is the shape that would blank a repository: a host answer with no
    // authors and no base. Merging alone WOULD erase it — which is why the
    // decision of whether to store at all is `nextContributors` below.
    expect(mergeContributorTotals([author({ commits: 7 })], [], null)).toEqual([]);
  });
});

/**
 * Whether an answer is worth storing. Two callers ask the host the same
 * question — the push report and the repository screen — and both would
 * otherwise carry a copy of these rules.
 */
describe('nextContributors', () => {
  const AT = '2026-08-16T18:00:00.000Z';
  const stored = { sha: 'a'.repeat(40), countedAt: AT, authors: [author({ commits: 7 })] };

  it('stores a first count', () => {
    const next = nextContributors(undefined, {
      tipSha: 'b'.repeat(40), from: null, authors: [author({ commits: 3 })],
    }, AT);
    expect(next).toEqual({ sha: 'b'.repeat(40), countedAt: AT, authors: [author({ commits: 3 })] });
  });

  it('stores a delta, moving the sha it counted to', () => {
    const next = nextContributors(stored, {
      tipSha: 'b'.repeat(40), from: 'a'.repeat(40), authors: [author({ commits: 2 })],
    }, AT);
    expect(next!.sha).toBe('b'.repeat(40));
    expect(next!.authors[0]!.commits).toBe(9);
  });

  it('writes nothing when there is no tip to count to', () => {
    // A branch with no commits, or one that has gone.
    expect(nextContributors(stored, { tipSha: null, from: null, authors: [] }, AT)).toBeNull();
  });

  it('writes nothing when nothing has landed since the last count', () => {
    expect(nextContributors(stored, { tipSha: stored.sha, from: stored.sha, authors: [] }, AT))
      .toBeNull();
  });

  it('refuses to blank a real list on an empty full recount', () => {
    // The cost of being wrong here is a stale list; the cost the other way is
    // the user watching their contributors disappear on one bad answer.
    expect(nextContributors(stored, { tipSha: 'b'.repeat(40), from: null, authors: [] }, AT))
      .toBeNull();
  });

  it('does store an empty first count, so an empty repo is not asked twice', () => {
    const next = nextContributors(undefined, { tipSha: 'b'.repeat(40), from: null, authors: [] }, AT);
    expect(next).toEqual({ sha: 'b'.repeat(40), countedAt: AT, authors: [] });
  });
});
