import { describe, expect, it } from 'vitest';
import { InMemoryGitCommitStatusStorage } from '../../services/git-commit-status-storage.js';
import { InMemoryGitPullRequestStorage } from '../../services/git-pr-storage.js';
import { InMemoryQuickNoteStorage } from '../../services/quick-note-storage.js';
import { resolveQuickNoteWorkMap } from '../../services/quick-note-work.js';

describe('structured quick-note work state (note #99)', () => {
  async function world() {
    const notes = new InMemoryQuickNoteStorage();
    const prs = new InMemoryGitPullRequestStorage();
    const statuses = new InMemoryGitCommitStatusStorage();
    const note = await notes.create({
      userId: 'room-1', html: '<p>One request</p>',
      createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a',
    });
    const resolve = async () => (await resolveQuickNoteWorkMap({
      notes: [(await notes.get(note.id))!],
      pullRequests: prs,
      commitStatuses: statuses,
      now: new Date('2026-08-28T20:00:00.000Z'),
    })).get(note.id)!;
    return { notes, prs, statuses, note, resolve };
  }

  const proposal = (noteNumber: number) => ({
    repoId: 'repo-1', userId: 'room-1', title: 'Implement it',
    sourceBranch: 'note-work', targetBranch: 'main',
    headSha: 'a'.repeat(40), diffStat: { files: 1, insertions: 3, deletions: 0 },
    commitSubjects: ['Implement it'], quickNoteNumbers: [noteNumber],
    createdByAgentId: 'agent-a', status: 'open' as const,
  });

  it('advances from Unclaimed to Working to PR to Merged to Live', async () => {
    const { notes, prs, statuses, note, resolve } = await world();
    expect(await resolve()).toEqual({ state: 'unclaimed' });

    await notes.claim(note.id, {
      agentId: 'agent-a', userId: 'user-1', agentName: 'Ben',
    }, new Date('2026-08-28T19:00:00.000Z'));
    expect(await resolve()).toMatchObject({ state: 'working', claim: { agentName: 'Ben' } });

    const pr = await prs.create(proposal(note.number));
    expect(await resolve()).toMatchObject({ state: 'proposal', proposal: { number: pr.number } });

    await prs.update(pr.id, { status: 'merged', mergeCommitSha: 'b'.repeat(40) });
    expect(await resolve()).toMatchObject({ state: 'merged' });

    await statuses.upsert({
      userId: 'room-1', repoId: 'repo-1', sha: 'b'.repeat(40),
      context: 'deploy/prod', state: 'success', description: 'Live',
      startedAt: '2026-08-28T19:10:00.000Z', completedAt: '2026-08-28T19:12:00.000Z',
    });
    expect(await resolve()).toMatchObject({ state: 'live' });
  });

  it('lets a fresh claim supersede a conflicted proposal pointer', async () => {
    const { notes, prs, note, resolve } = await world();
    const pr = await prs.create(proposal(note.number));
    await prs.update(pr.id, { status: 'conflict' });
    expect(await resolve()).toMatchObject({
      state: 'proposal', proposal: { status: 'conflict' },
    });

    await notes.claim(note.id, {
      agentId: 'agent-b', userId: 'user-1', agentName: 'Ada',
    }, new Date('2026-08-28T19:00:00.000Z'));
    expect(await resolve()).toMatchObject({ state: 'working', claim: { agentName: 'Ada' } });
  });

  it('keeps proposal state linked after the note moves to another room', async () => {
    const { notes, prs, note, resolve } = await world();
    const pr = await prs.create(proposal(note.number));
    await notes.move(note.id, 'room-2');

    expect((await notes.get(note.id))?.previousLocations).toEqual([
      { userId: 'room-1', number: note.number },
    ]);
    expect(await resolve()).toMatchObject({
      state: 'proposal', proposal: { id: pr.id, userId: 'room-1' },
    });
  });

  it('keeps a moved note linked when the repository home is another room (note #108)', async () => {
    const { notes, prs, note, resolve } = await world();
    const pr = await prs.create({
      ...proposal(note.number),
      userId: 'repo-home-room',
      quickNoteNamespaceId: 'room-1',
    });
    await notes.move(note.id, 'room-2');

    expect(await resolve()).toMatchObject({
      state: 'proposal', proposal: { number: pr.number },
    });
  });

  it('does not call a mirror-only result Live or let a failed mirror hide a real release', async () => {
    const { prs, statuses, note, resolve } = await world();
    const pr = await prs.create(proposal(note.number));
    await prs.update(pr.id, { status: 'merged', mergeCommitSha: 'b'.repeat(40) });
    const status = (context: string, state: 'success' | 'failure') => statuses.upsert({
      userId: 'room-1', repoId: 'repo-1', sha: 'b'.repeat(40), context, state,
      description: state, startedAt: '2026-08-28T19:10:00.000Z',
      completedAt: '2026-08-28T19:12:00.000Z',
    });

    await status('deploy/mirror-github', 'success');
    expect(await resolve()).toMatchObject({ state: 'merged' });

    await status('deploy/prod', 'success');
    expect(await resolve()).toMatchObject({ state: 'live' });

    await status('deploy/mirror-github', 'failure');
    expect(await resolve()).toMatchObject({ state: 'live' });
  });

  it('calls a repository’s site published on approval Live — and only once it actually published', async () => {
    const { prs, statuses, note, resolve } = await world();
    const pr = await prs.create(proposal(note.number));
    await prs.update(pr.id, { status: 'merged', mergeCommitSha: 'c'.repeat(40) });
    const status = (context: string, state: 'success' | 'failure' | 'skipped') => statuses.upsert({
      userId: 'room-1', repoId: 'repo-1', sha: 'c'.repeat(40), context, state,
      description: state, startedAt: '2026-08-28T19:10:00.000Z',
      completedAt: '2026-08-28T19:12:00.000Z',
    });

    // A backup is not a release, whatever its name starts with.
    await status('deploy/db-backup', 'success');
    expect(await resolve()).toMatchObject({ state: 'merged' });

    // `agentbuilt repo publish` files deploy/<site>.
    await status('deploy/startup-game', 'failure');
    expect(await resolve()).toMatchObject({ state: 'merged' });
    await status('deploy/startup-game', 'skipped');
    expect(await resolve()).toMatchObject({ state: 'merged' });
    await status('deploy/startup-game', 'success');
    expect(await resolve()).toMatchObject({ state: 'live' });
  });
  /**
   * Handed (notes #234/#258): the user gave the note to an agent and nobody
   * has claimed it. It sits between Unclaimed and Working because that is
   * exactly what it is — more than nothing, less than a lease.
   */
  describe('handed to an agent, before anybody claims it', () => {
    const handedTo = (agentName: string, expiresAt: string) => ({
      agentId: 'agent-b', agentName, userId: 'user-1',
      handedAt: '2026-08-28T19:30:00.000Z', expiresAt,
    });

    it('says who it was handed to, until the window runs out', async () => {
      const { notes, note, resolve } = await world();
      expect(await resolve()).toEqual({ state: 'unclaimed' });

      await notes.update(note.id, { handoff: handedTo('Ivy', '2026-08-28T21:30:00.000Z') });
      expect(await resolve()).toMatchObject({ state: 'handed', handoff: { agentName: 'Ivy' } });

      // Past its window the note is available again on its own: a handoff
      // nobody answered must not sit on the board looking like work in hand.
      await notes.update(note.id, { handoff: handedTo('Ivy', '2026-08-28T19:59:59.000Z') });
      expect(await resolve()).toEqual({ state: 'unclaimed' });
    });

    it('is outranked by a claim — a lease is what an agent DID', async () => {
      const { notes, note, resolve } = await world();
      await notes.update(note.id, { handoff: handedTo('Ivy', '2026-08-28T21:30:00.000Z') });
      // …and claiming CLEARS it, so releasing the note goes back to Unclaimed
      // rather than resurfacing a handoff the agent has just declined.
      await notes.claim(note.id, {
        agentId: 'agent-a', userId: 'user-1', agentName: 'Ben',
      }, new Date('2026-08-28T19:45:00.000Z'));
      expect(await resolve()).toMatchObject({ state: 'working', claim: { agentName: 'Ben' } });
      expect((await notes.get(note.id))!.handoff).toBeUndefined();

      await notes.releaseClaim(note.id, 'agent-a', new Date('2026-08-28T19:50:00.000Z'));
      expect(await resolve()).toEqual({ state: 'unclaimed' });
    });

    it('outranks a conflicted proposal, which is the thing being asked for', async () => {
      const { notes, prs, note, resolve } = await world();
      const pr = await prs.create(proposal(note.number));
      await prs.update(pr.id, { status: 'conflict' });
      expect(await resolve()).toMatchObject({ state: 'proposal', proposal: { number: pr.number } });

      // The conflict pointer is useful "until somebody claims that correction"
      // — and being handed the note IS somebody being asked for it.
      await notes.update(note.id, { handoff: handedTo('Ivy', '2026-08-28T21:30:00.000Z') });
      expect(await resolve()).toMatchObject({ state: 'handed', handoff: { agentName: 'Ivy' } });
    });

    it('does not survive an open or merged proposal, which is real progress', async () => {
      const { notes, prs, note, resolve } = await world();
      await notes.update(note.id, { handoff: handedTo('Ivy', '2026-08-28T21:30:00.000Z') });
      const pr = await prs.create(proposal(note.number));
      expect(await resolve()).toMatchObject({ state: 'proposal', proposal: { number: pr.number } });

      await prs.update(pr.id, { status: 'merged', mergeCommitSha: 'b'.repeat(40) });
      expect(await resolve()).toMatchObject({ state: 'merged' });
    });
  });
});
