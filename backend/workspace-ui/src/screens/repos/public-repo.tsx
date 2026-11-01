/**
 * What the public repository pages share that is not a component: the two
 * doors a repository opens by, the addresses and endpoints under them, one
 * read hook with the member door every public endpoint has, and the line a
 * commit's author and date make. Kept apart from the screens so each screen
 * file exports components only.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from '../../session/useSession.js';
import { toFor } from '../../routes.js';
import { errorMessage } from '../../ui/format.js';
import { relative } from '../../ui/time.js';
import { bytes } from '../../ui/file-kind.js';
import type { WorkspacePublicRepoAboutAnswer } from '../../../../src/shared/workspace-api.js';

export type PublicRepoDoor =
  | { kind: 'token'; id: string }
  | { kind: 'address'; handle: string; repo: string };

export function publicPath(door: PublicRepoDoor, path = '', file = false): string {
  const query = new URLSearchParams();
  if (path) query.set('path', path);
  if (file) query.set('file', '1');
  const suffix = query.toString();
  const base = door.kind === 'token'
    ? `/public/repositories/${encodeURIComponent(door.id)}`
    : toFor({ kind: 'workplaceRepo', handle: door.handle, repo: door.repo })!;
  return `${base}${suffix ? `?${suffix}` : ''}`;
}

export function publicEndpoint(door: PublicRepoDoor, what: 'tree' | 'file', path: string): string {
  const base = door.kind === 'token'
    ? `api/public/repos/${encodeURIComponent(door.id)}`
    : `api/public/workplaces/${encodeURIComponent(door.handle)}/repos/${encodeURIComponent(door.repo)}`;
  return `${base}/${what}${path ? `?path=${encodeURIComponent(path)}` : ''}`;
}

export type PublicRepoAddress = Extract<PublicRepoDoor, { kind: 'address' }>;

/** The pages a repository has at its ADDRESS only: the token door never grew them. */
export function publicPagePath(
  door: PublicRepoAddress,
  page: 'commits' | 'proposals' | 'contributors',
  which?: string,
): string {
  const { handle, repo } = door;
  if (page === 'contributors') return toFor({ kind: 'workplaceRepoContributors', handle, repo })!;
  if (page === 'commits') {
    return which
      ? toFor({ kind: 'workplaceRepoCommit', handle, repo, sha: which })!
      : toFor({ kind: 'workplaceRepoCommits', handle, repo })!;
  }
  return which
    ? toFor({ kind: 'workplaceRepoProposal', handle, repo, number: which })!
    : toFor({ kind: 'workplaceRepoProposals', handle, repo })!;
}

export function publicPageEndpoint(door: PublicRepoAddress, page: 'commits' | 'proposals' | 'about', which = ''): string {
  const base = `api/public/workplaces/${encodeURIComponent(door.handle)}/repos/${encodeURIComponent(door.repo)}/${page}`;
  return which ? `${base}/${encodeURIComponent(which)}` : base;
}

/** One public read, with the member door every public endpoint has. */
export function usePublicRead<T, M = { orgId: string }>(endpoint: string): {
  answer: T | null; member: M | null; error: { status: number; message: string } | null;
} {
  const { api } = useSession();
  const [answer, setAnswer] = useState<T | null>(null);
  const [member, setMember] = useState<M | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  useEffect(() => {
    let current = true;
    void api.api<T | { member: M }>(endpoint)
      .then((next) => {
        if (!current) return;
        if (next && typeof next === 'object' && 'member' in next) setMember((next as { member: M }).member); else setAnswer(next as T);
      })
      .catch((caught: unknown) => {
        if (!current) return;
        const status = typeof (caught as { status?: unknown })?.status === 'number' ? (caught as { status: number }).status : 0;
        setError({ status, message: errorMessage(caught) });
      });
    return () => { current = false; };
  }, [api, endpoint]);
  return { answer, member, error };
}

/** A commit's author and date, as every public row says them. */
export function commitLine(commit: { authorName: string; at: string }): ReactNode {
  return <>{commit.authorName || 'Unknown'}{commit.at ? <span className="cwhen"> · {relative(commit.at)}</span> : null}</>;
}

/** The About strip's facts, each count a door to its tab. */
export function aboutFacts(about: WorkspacePublicRepoAboutAnswer): Array<{ key: string; text: string; page?: 'commits' | 'proposals' }> {
  const facts: Array<{ key: string; text: string; page?: 'commits' | 'proposals' }> = [];
  if (about.license) facts.push({ key: 'license', text: about.license.name ? `${about.license.name} licence` : `See ${about.license.file}` });
  if (about.sizeBytes > 0) facts.push({ key: 'size', text: bytes(about.sizeBytes) });
  if (about.commits !== null) facts.push({ key: 'commits', text: about.commits === 1 ? '1 commit' : `${about.commits} commits`, page: 'commits' });
  facts.push({ key: 'proposals', text: about.proposals === 1 ? '1 proposal' : `${about.proposals} proposals`, page: 'proposals' });
  if (about.publishedAt) facts.push({ key: 'published', text: `published ${relative(about.publishedAt) || 'just now'}` });
  if (about.lastPushAt) facts.push({ key: 'pushed', text: `last push ${relative(about.lastPushAt) || 'just now'}` });
  return facts;
}

export function contributorsLine(names: readonly string[], shown = 3): string {
  const named = names.slice(0, shown).join(', ');
  return names.length > shown ? `${named} and ${names.length - shown} more` : named;
}

/** The destination, with the workplace in its address whatever its kind. */
export function addressedIn(to: string, orgId: string): string {
  if (new URLSearchParams(to.split('?')[1] ?? '').get('org') === orgId) return to;
  return `${to}${to.includes('?') ? '&' : '?'}org=${encodeURIComponent(orgId)}`;
}
