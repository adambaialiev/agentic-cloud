import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { WorkspaceApiError } from '../../api/client.js';
import type { WorkspaceRepoRow, WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { emptyState, homeShelf, repo, repoScreenScript, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

/**
 * Repositories, end to end against a scripted API — the same things the
 * legacy page's grab()-based tests hold them to (telegram-miniapp-page:
 * the explorer's tabs and crumb, the file list, the file renderer, the
 * history and its rows, the quota line and the repository rows on home),
 * driven the way a person drives them.
 */

function open(state: WorkspaceStateAnswer, extra: Record<string, Answer> = {}, path = '/') {
  const scripted = scriptedApi({ ...workspaceScript(() => state), ...extra });
  render(
    <MemoryRouter initialEntries={[path]}>
      <App api={scripted.api} />
    </MemoryRouter>,
  );
  return scripted;
}

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };
/** A workplace the reader stands in. (It was a room of one, and every
 *  address carried it, while there were rooms — note #843.) */
const inWorkplace = (overrides: Partial<WorkspaceStateAnswer> = {}) => emptyState({ org, ...overrides });

const scoped = '?org=o1';
const findHome = () => homeShelf('repositories');
const card = () => document.getElementById('repos')!;

describe('the repository rows on home', () => {
  it('a row says what happened lately, and names the branch only when it earned it', async () => {
    open(inWorkplace({
      repos: [
        repo({ name: 'infinite-agents', sizeBytes: 4096, branch: 'main', branchPushAt: '2026-09-01T10:00:00.000Z' }),
        repo({ name: 'scratch', lastPushAt: '2026-09-01T09:00:00.000Z' }),
        repo({ name: 'brand-new' }),
      ],
    }));
    await findHome();
    const rows = [...card().querySelectorAll('.crow')];
    // A branch is NAMED only for a landing the backend saw on it; any other
    // push says "pushed" and nothing about where, because it went elsewhere.
    expect(within(rows[0] as HTMLElement).getByText('main')).toBeTruthy();
    expect(rows[0]!.querySelector('.cwhen')!.textContent).toMatch(/^· pushed /);
    expect(rows[1]!.querySelector('.branch')).toBeNull();
    expect(rows[1]!.querySelector('.cwhen')!.textContent).toMatch(/^pushed /);
    // A repository nobody has pushed to yet says so: silence under a name
    // whose "0 B" then looks like a failure to load.
    expect(rows[2]!.querySelector('.cwhen')!.textContent).toBe('no pushes yet');
  });

  it('orders the list by what was touched last, not by what was made first', async () => {
    open(inWorkplace({
      repos: [
        repo({ name: 'old', createdAt: '2026-01-01T00:00:00.000Z', lastPushAt: '2026-01-02T00:00:00.000Z' }),
        repo({ name: 'busy', createdAt: '2026-08-01T00:00:00.000Z', lastPushAt: '2026-09-01T00:00:00.000Z' }),
      ],
    }));
    await findHome();
    expect([...card().querySelectorAll('.crow .name')].slice(0, 2).map((n) => n.textContent))
      .toEqual(['busy', 'old']);
  });

  it('wears the faces of the agents that wrote it, named once for the group', async () => {
    open(inWorkplace({
      repos: [repo({
        name: 'infinite-agents',
        contributors: [
          { name: 'Alex', agentAvatarUrl: '/faces/alex.png', commits: 40 },
          { name: 'Kai', agentAvatarUrl: '/faces/kai.png', commits: 9 },
        ],
      })],
    }));
    await findHome();
    const faces = card().querySelector('.faces')!;
    expect(faces.querySelectorAll('img.face')).toHaveLength(2);
    // One label for the group rather than one per picture: three faces read
    // out as three separate "written by" is noise.
    expect(faces.getAttribute('aria-label')).toBe('Written by Alex, Kai');
    expect([...faces.querySelectorAll('img')].every((img) => img.getAttribute('alt') === '')).toBe(true);
  });

  it('says what an agent has asked for, because nothing else will', async () => {
    open(inWorkplace({
      repos: [repo({
        name: 'infinite-agents',
        deleteAsk: { at: '2026-09-01T10:00:00.000Z', canDecide: true, byAgentName: 'Ben' },
        // A standing grant is not a request: no badge for it (note #739).
        ciSecrets: { names: ['FLY_TOKEN'] },
      })],
      prs: [{
        id: 'p1', number: 3, repoName: 'infinite-agents', title: 'x', body: null,
        from: 'a', to: 'main', status: 'open', createdAt: '2026-09-01T10:00:00.000Z',
        decidedAt: null, agentName: 'Ben', canDecide: true,
      }],
    }));
    await findHome();
    const row = card().querySelector('.crow')!;
    expect([...row.querySelectorAll('.badge')].map((b) => b.textContent))
      .toEqual(['delete asked', '1 PR']);
  });

  it('marks a public repository in the shared list', async () => {
    open(inWorkplace({
      repos: [repo({ name: 'open-kit', publicUrl: 'https://workspace.test/public/repositories/p1' })],
    }));
    await findHome();
    expect([...card().querySelectorAll('.badge')].map((badge) => badge.textContent)).toEqual(['public']);
  });

  it('closes the card with one footer strip: the storage, then the key beside it', async () => {
    open(inWorkplace({
      repos: [repo({ name: 'infinite-agents', cloneUrl: 'https://git.test/ns/infinite-agents.git' })],
      quota: { repoMaxBytes: 1024, userMaxBytes: 1024 * 1024 * 100, userUsedBytes: 1024 * 1024 },
    }));
    await findHome();
    const foot = document.querySelector('.repofoot')!;
    expect(foot.querySelector('#quota')!.textContent).toBe('Storage: 1.0 MB of 100.0 MB used');
    expect(foot.querySelector('.gitkeytap')!.textContent).toBe('Clone on your computer');
    // The compaction itself (note #360): the key is a line of the footer, not
    // a row of the list wearing a repository's icon column and second line.
    expect(card().querySelector('.gitkeytap')).toBeNull();
    expect([...card().querySelectorAll('.crow .name')].map((n) => n.textContent))
      .toEqual(['infinite-agents']);
  });

  it('opens the key panel from that line, and says so to a screen reader', async () => {
    open(
      inWorkplace({ repos: [repo({ name: 'infinite-agents', cloneUrl: 'https://git.test/ns/infinite-agents.git' })] }),
      { 'GET api/git-access': () => ({ createdAt: null }) },
    );
    await findHome();
    const tap = document.querySelector('.gitkeytap') as HTMLButtonElement;
    // One quiet line is not allowed to be a quieter affordance: the button
    // says whether the panel under it is open, which the old row never did.
    expect(tap.getAttribute('aria-expanded')).toBe('false');
    expect(tap.getAttribute('aria-controls')).toBe('gitKeyCard');
    expect((document.getElementById('gitKeyCard') as HTMLElement).hidden).toBe(true);
    fireEvent.click(tap);
    expect(tap.getAttribute('aria-expanded')).toBe('true');
    expect((document.getElementById('gitKeyCard') as HTMLElement).hidden).toBe(false);
    expect(screen.getByText('git clone https://git.test/ns/infinite-agents.git')).toBeTruthy();
    await screen.findByRole('button', { name: 'Create key & copy' });
  });

  it('offers no key when there is nothing to clone, and says who fills the shelf', async () => {
    open(inWorkplace({ repos: [] }));
    await findHome();
    expect(card().querySelector('.roomemptytitle')!.textContent).toBe('Give the work a durable home');
    // A key offered over an empty shelf answers a question nobody has.
    expect(screen.queryByText('Clone on your computer')).toBeNull();
    // …and the strip does not survive as an empty band under the empty state.
    expect(document.querySelector('.repofoot')).toBeNull();
  });

  it('says so rather than claiming an empty shelf when hosting is unavailable', async () => {
    open(inWorkplace({ repos: null }));
    await findHome();
    expect(card().querySelector('.empty')!.textContent).toBe('Repository hosting is not available right now.');
  });
});

describe('the explorer', () => {
  const tree = {
    branch: 'main',
    entries: [
      { name: 'README.md', type: 'file' as const, sizeBytes: 34 },
      { name: 'src', type: 'dir' as const },
      { name: 'vendor', type: 'submodule' as const },
      { name: 'latest', type: 'symlink' as const },
      { name: 'notes.txt', type: 'file' as const, sizeBytes: 2048 },
    ],
  };
  const withRepo = (extra: Record<string, Answer> = {}) => open(
    inWorkplace({ repos: [repo({ name: 'infinite-agents' })] }),
    { ...repoScreenScript('infinite-agents', () => tree), ...extra },
    `/repositories/infinite-agents${scoped}`,
  );

  it('separates the work around a repository from its content', async () => {
    withRepo();
    expect(await screen.findByRole('heading', { name: 'infinite-agents' })).toBeTruthy();
    // A repository opens on Overview; its code is deliberately one tap away,
    // so the two jobs no longer compete down one long screen.
    expect(document.getElementById('repoOverviewTab')!.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('repoOverview')!.hidden).toBe(false);
    expect(document.getElementById('repoContent')!.hidden).toBe(true);
  });

  it('lists folders first, then files, each alphabetical', async () => {
    withRepo();
    await screen.findByRole('heading', { name: 'infinite-agents' });
    fireEvent.click(document.getElementById('repoContentTab')!);
    await waitFor(() => expect(document.querySelectorAll('#repoTree .trow').length).toBeGreaterThan(0));
    expect([...document.querySelectorAll('#repoTree .tname')].map((n) => n.textContent))
      // `localeCompare` is case-insensitive, so README.md sorts after
      // notes.txt — the legacy page's comparator does exactly the same.
      .toEqual(['src/', 'vendor', 'latest', 'notes.txt', 'README.md']);
  });

  it('says what the right-hand column cannot show with a size', async () => {
    withRepo();
    await screen.findByRole('heading', { name: 'infinite-agents' });
    fireEvent.click(document.getElementById('repoContentTab')!);
    await waitFor(() => expect(document.querySelectorAll('#repoTree .trow').length).toBeGreaterThan(0));
    const sides = [...document.querySelectorAll('#repoTree .trow')].map((row) => row.querySelector('.tsize')?.textContent ?? '');
    expect(sides).toEqual(['', 'Submodule', 'Link', '2 KB', '34 B']);
  });

  it('a submodule is listed and is not a door — there is nothing on the other side', async () => {
    withRepo();
    await screen.findByRole('heading', { name: 'infinite-agents' });
    fireEvent.click(document.getElementById('repoContentTab')!);
    await waitFor(() => expect(document.querySelectorAll('#repoTree .trow').length).toBeGreaterThan(0));
    const rows = [...document.querySelectorAll('#repoTree .trow')];
    expect(rows.find((row) => row.textContent?.startsWith('vendor'))!.getAttribute('role')).toBeNull();
    expect(rows.find((row) => row.textContent?.startsWith('src'))!.getAttribute('role')).toBe('button');
  });

  it('a folder is the same place with a path, and the crumb walks back out of it', async () => {
    withRepo({
      'GET api/repos/infinite-agents/tree?path=src': () => ({ branch: 'main', entries: [{ name: 'index.ts', type: 'file', sizeBytes: 10 }] }),
    });
    await screen.findByRole('heading', { name: 'infinite-agents' });
    fireEvent.click(document.getElementById('repoContentTab')!);
    await waitFor(() => expect(document.querySelectorAll('#repoTree .trow').length).toBeGreaterThan(0));
    fireEvent.click([...document.querySelectorAll('#repoTree .trow')].find((row) => row.textContent?.startsWith('src'))!);
    await waitFor(() => expect(document.querySelector('#repoTree .tname')!.textContent).toBe('index.ts'));
    // A folder always restores Content: there is nothing else it could show.
    expect(document.getElementById('repoContent')!.hidden).toBe(false);
    // The crumb: the repository and every folder above are taps, and the
    // folder the reader is in stays plain text.
    const crumb = document.getElementById('repoCrumb')!;
    expect([...crumb.querySelectorAll('button.seg')].map((n) => n.textContent)).toEqual(['infinite-agents']);
    expect(crumb.querySelector('.here')!.textContent).toBe('src');
  });

  it('choosing Overview from inside a folder walks back to the root', async () => {
    withRepo({
      'GET api/repos/infinite-agents/tree?path=src': () => ({ branch: 'main', entries: [] }),
    });
    await screen.findByRole('heading', { name: 'infinite-agents' });
    fireEvent.click(document.getElementById('repoContentTab')!);
    await waitFor(() => expect(document.querySelectorAll('#repoTree .trow').length).toBeGreaterThan(0));
    fireEvent.click([...document.querySelectorAll('#repoTree .trow')].find((row) => row.textContent?.startsWith('src'))!);
    await waitFor(() => expect(document.getElementById('repoCrumb')!.querySelector('.here')!.textContent).toBe('src'));
    fireEvent.click(document.getElementById('repoOverviewTab')!);
    // Overview describes the REPOSITORY, never whichever folder the reader
    // happened to be inside — so it returns to the root, which is what brings
    // its root-only cards back.
    await waitFor(() => expect(document.getElementById('repoOverview')!.hidden).toBe(false));
    expect(document.getElementById('repoCrumb')!.querySelector('.here')!.textContent).toBe('infinite-agents');
  });

  it('says a repository with no commits has none, rather than showing an empty folder', async () => {
    withRepo({ 'GET api/repos/infinite-agents/tree': () => ({ branch: null, entries: [] }) });
    await screen.findByRole('heading', { name: 'infinite-agents' });
    fireEvent.click(document.getElementById('repoContentTab')!);
    await waitFor(() => expect(document.querySelector('#repoTree .empty')).toBeTruthy());
    expect(document.querySelector('#repoTree .empty')!.textContent)
      .toBe('This repository has no commits yet. Once an agent pushes, its files show up here.');
    // No branch, no toolbar: there is nothing for it to name.
    expect(document.getElementById('repoBar')!.hidden).toBe(true);
  });

  it('names the branch the files came from', async () => {
    withRepo();
    await screen.findByRole('heading', { name: 'infinite-agents' });
    fireEvent.click(document.getElementById('repoContentTab')!);
    await waitFor(() => expect(document.getElementById('repoBar')!.hidden).toBe(false));
    expect(document.getElementById('repoBranch')!.textContent).toBe('main');
  });
});

describe('a repository that is not this workplace’s (note #671)', () => {
  // What the server answers for another workplace's private repository —
  // exactly what it answers for one that never existed.
  const missing = () => {
    throw new WorkspaceApiError('No such repository here', 404, { error: 'No such repository here', code: 'no_such_repository' });
  };

  it('says so in words, where it used to draw two tabs over nothing', async () => {
    open(inWorkplace(), { 'GET api/repos/theirs/tree': missing }, `/repositories/theirs${scoped}`);
    const words = await waitFor(() => {
      const card = document.getElementById('repoMissing');
      expect(card).toBeTruthy();
      return card!.textContent!;
    });
    expect(screen.getByRole('heading', { name: 'theirs' })).toBeTruthy();
    expect(words).toContain('There is no repository called “theirs” in Nomad Trading.');
    expect(words).toContain('only for the people of its own workplace');
    expect(document.getElementById('repoTabs')).toBeNull();
  });

  it('a screen one tap deeper says the same', async () => {
    open(inWorkplace(), { 'GET api/repos/theirs/commits?limit=20': missing }, `/repositories/theirs/history${scoped}`);
    const list = await waitFor(() => {
      const text = document.getElementById('commitsList')!.textContent!;
      expect(text).toContain('There is no repository called “theirs” in Nomad Trading.');
      return text;
    });
    expect(list).not.toContain('No such repository here');
  });

  it('a missing FOLDER is not a missing repository: the tabs stay, and the listing says it', async () => {
    const noFolder = () => { throw new WorkspaceApiError('No such folder in this repository', 404, { error: 'No such folder in this repository' }); };
    open(
      inWorkplace({ repos: [repo({ name: 'infinite-agents' })] }),
      { 'GET api/repos/infinite-agents/tree?path=gone': noFolder },
      `/repositories/infinite-agents${scoped}&path=gone`,
    );
    await waitFor(() => expect(document.getElementById('repoTree')!.textContent).toBe('No such folder in this repository'));
    expect(document.getElementById('repoTabs')).toBeTruthy();
    expect(document.getElementById('repoMissing')).toBeNull();
  });
});

describe('one file', () => {
  const openFile = (answer: Record<string, unknown>, name = 'notes.txt') => open(
    inWorkplace({ repos: [repo({ name: 'infinite-agents' })] }),
    { [`GET api/repos/infinite-agents/file?path=${name}`]: () => answer },
    `/repositories/infinite-agents/file${scoped}&path=${name}`,
  );

  it('numbers the lines of a code file and offers to copy it', async () => {
    openFile({ branch: 'main', sizeBytes: 20, content: 'const x = 1;\nconst y = 2;\n' }, 'index.ts');
    expect(await screen.findByText('const x = 1;', { exact: false })).toBeTruthy();
    expect(document.querySelector('.code .gutter')!.textContent).toBe('1\n2');
    expect(document.querySelector('.filebar .kind')!.textContent).toBe('TS');
    expect(screen.getByRole('button', { name: /Copy/ })).toBeTruthy();
  });

  it('wraps prose instead of numbering it', async () => {
    openFile({ branch: 'main', sizeBytes: 9, content: 'one\ntwo\n' });
    await waitFor(() => expect(document.querySelector('.code')).toBeTruthy());
    // Its lines are sentences, and a number against each says nothing.
    expect(document.querySelector('.code')!.className).toContain('wrap');
    expect(document.querySelector('.code .gutter')).toBeNull();
  });

  it('renders a markdown file, and hands back its source on request', async () => {
    openFile({ branch: 'main', sizeBytes: 12, content: '# Title\n\nWords.\n' }, 'README.md');
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(document.querySelector('.filebar .kind')!.textContent).toBe('Markdown');
    fireEvent.click(screen.getByRole('button', { name: 'View raw' }));
    expect(document.querySelector('.filebar .kind')!.textContent).toBe('Markdown source');
    expect(document.querySelector('.code .lines')!.textContent).toContain('# Title');
  });

  it('says what it is rather than showing a wall of bytes', async () => {
    openFile({ branch: 'main', sizeBytes: 900000, tooLarge: true }, 'big.bin');
    expect(await screen.findByText(/too large to show here/)).toBeTruthy();
  });

  it('and the same for a binary and an empty file', async () => {
    openFile({ branch: 'main', sizeBytes: 40, binary: true }, 'logo.ico');
    expect(await screen.findByText(/nothing to show as text/)).toBeTruthy();
  });

  it('shows an image the host decoded, and its real size once the browser knows it', async () => {
    openFile(
      { branch: 'main', sizeBytes: 68, image: { mime: 'image/png', base64: 'iVBORw0KGgo=' } },
      'plan.png',
    );
    await waitFor(() => expect(document.querySelector('#fileBody img')).toBeTruthy());
    const img = document.querySelector('#fileBody img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    // The name, so a screen reader gets what a sighted reader gets from the
    // title — never the file's own bytes, which say nothing.
    expect(img.getAttribute('alt')).toBe('plan.png');
    expect(img.getAttribute('aria-label')).toBe('Open plan.png full screen');
  });

  it('carries the file size in the crumb, and every folder above it stays a tap', async () => {
    open(
      inWorkplace({ repos: [repo({ name: 'infinite-agents' })] }),
      { 'GET api/repos/infinite-agents/file?path=src%2Fdeep%2Findex.ts': () => ({ branch: 'main', sizeBytes: 34, content: 'x\n' }) },
      `/repositories/infinite-agents/file${scoped}&path=src/deep/index.ts`,
    );
    await waitFor(() => expect(document.getElementById('fileSub')!.textContent).toContain('34 B'));
    const crumb = document.getElementById('fileSub')!;
    expect([...crumb.querySelectorAll('button.seg')].map((n) => n.textContent))
      .toEqual(['infinite-agents', 'src', 'deep']);
    expect(crumb.querySelector('.here')!.textContent).toBe('index.ts');
  });
});

describe('the history and one commit', () => {
  const commits = {
    branch: 'main',
    commits: [
      { sha: 'a'.repeat(40), authorName: 'Alex', at: '2026-09-01T10:00:00.000Z', subject: 'Move the checkout to React' },
      { sha: 'b'.repeat(40), authorName: 'Kai', at: '2026-09-01T09:00:00.000Z', subject: '<b>not markup</b>' },
    ],
  };

  it('lists a commit as subject, who and when, and the short sha', async () => {
    open(
      inWorkplace({ repos: [repo({ name: 'infinite-agents' })] }),
      { 'GET api/repos/infinite-agents/commits?limit=20': () => commits },
      `/repositories/infinite-agents/history${scoped}`,
    );
    await waitFor(() => expect(document.querySelectorAll('#commitsList .crow').length).toBe(2));
    const first = document.querySelector('#commitsList .crow')!;
    expect(first.querySelector('.name')!.textContent).toBe('Move the checkout to React');
    expect(first.querySelector('.ctext')!.textContent).toBe('Alex');
    // Seven characters is what git shows and what a person compares against a
    // terminal; the full sha would take the row and say no more.
    expect(first.querySelector('.cside.sha')!.textContent).toBe('aaaaaaa');
  });

  it('a commit subject is text, never markup — even when it is written as markup', async () => {
    open(
      inWorkplace({ repos: [repo({ name: 'infinite-agents' })] }),
      { 'GET api/repos/infinite-agents/commits?limit=20': () => commits },
      `/repositories/infinite-agents/history${scoped}`,
    );
    await waitFor(() => expect(document.querySelectorAll('#commitsList .crow').length).toBe(2));
    const second = document.querySelectorAll('#commitsList .crow')[1]!;
    expect(second.querySelector('.name')!.textContent).toBe('<b>not markup</b>');
    expect(second.querySelector('b')).toBeNull();
  });

  it('says so plainly when there is no history to show', async () => {
    open(
      inWorkplace({ repos: [repo({ name: 'infinite-agents' })] }),
      { 'GET api/repos/infinite-agents/commits?limit=20': () => ({ branch: null, commits: [] }) },
      `/repositories/infinite-agents/history${scoped}`,
    );
    expect(await screen.findByText('No commits to show yet.')).toBeTruthy();
  });

  it('one commit shows what it changed, through the same diff renderer a proposal uses', async () => {
    const patch = [
      'diff --git a/src/checkout.ts b/src/checkout.ts',
      '@@ -1,2 +1,2 @@',
      '-  return legacyCheckout();',
      '+  return reactCheckout();',
    ].join('\n');
    open(
      inWorkplace({ repos: [repo({ name: 'infinite-agents' })] }),
      {
        [`GET api/repos/infinite-agents/commit/${'a'.repeat(40)}`]: () => ({
          sha: 'a'.repeat(40), authorName: 'Alex', at: '2026-09-01T10:00:00.000Z',
          subject: 'Move the checkout to React', body: 'The old page goes.',
          parents: ['c'.repeat(40)], diffStat: { files: 1, insertions: 1, deletions: 1 },
          patch, patchTruncated: false,
        }),
      },
      `/repositories/infinite-agents/commits/${'a'.repeat(40)}${scoped}`,
    );
    expect(await screen.findByRole('heading', { name: 'Move the checkout to React' })).toBeTruthy();
    expect(screen.getByText('The old page goes.')).toBeTruthy();
    expect(document.querySelector('.diffpath')!.textContent).toBe('src/checkout.ts');
    expect(document.querySelector('.difflines .del')!.textContent).toBe('-  return legacyCheckout();');
  });
});

describe('who wrote it', () => {
  const people = {
    contributors: [
      { name: 'Alex', email: 'alex@agents.test', commits: 1204, insertions: 9000, deletions: 400, agentAvatarUrl: '/faces/alex.png' },
      { name: 'Saddam', email: 'me@example.com', commits: 3, insertions: 12, deletions: 0 },
    ],
  };

  it('names everyone, with the address git knows them by and the two numbers', async () => {
    open(
      inWorkplace({ repos: [repo({ name: 'infinite-agents' })] }),
      { 'GET api/repos/infinite-agents/contributors': () => people },
      `/repositories/infinite-agents/contributors${scoped}`,
    );
    expect(await screen.findByRole('heading', { name: '2 contributors' })).toBeTruthy();
    const rows = [...document.querySelectorAll('#contributorsList .crow')];
    expect(rows[0]!.querySelector('.bname')!.textContent).toBe('alex@agents.test');
    expect(rows[0]!.querySelector('.cwhen')!.textContent).toBe('1,204 commits');
    expect(rows[0]!.querySelector('.plus')!.textContent).toBe('+9,000');
    // Zero is still printed: "+0 −0" is a real fact about someone whose
    // commits only moved files about, and a blank reads as missing.
    expect(rows[1]!.querySelector('.minus')!.textContent).toBe('−0');
    // An agent brings its face; everyone else gets the anonymous mark.
    expect(rows[0]!.querySelector('img.aface')).toBeTruthy();
    expect(rows[1]!.querySelector('img.aface')).toBeNull();
    expect(rows[1]!.querySelector('.icon')).toBeTruthy();
  });

  it('says "1 commit" rather than "1 commits"', async () => {
    open(
      inWorkplace({ repos: [repo({ name: 'infinite-agents' })] }),
      {
        'GET api/repos/infinite-agents/contributors': () => ({
          contributors: [{ name: 'Solo', email: 's@x.test', commits: 1, insertions: 1, deletions: 0 }],
        }),
      },
      `/repositories/infinite-agents/contributors${scoped}`,
    );
    expect(await screen.findByRole('heading', { name: '1 contributor' })).toBeTruthy();
    expect(document.querySelector('#contributorsList .cwhen')!.textContent).toBe('1 commit');
  });
});

describe('what a repository is deleted with', () => {
  const withAsk = (extra: Partial<WorkspaceRepoRow> = {}) => open(
    inWorkplace({ repos: [repo({ name: 'infinite-agents', ...extra })] }),
    repoScreenScript('infinite-agents', () => ({ branch: 'main', entries: [] })),
    `/repositories/infinite-agents${scoped}`,
  );

  it('asks for the repository’s own name to be typed before it will answer', async () => {
    withAsk();
    await screen.findByRole('heading', { name: 'infinite-agents' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete this repository' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete this repository' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    // A delete that leaves the screen clean has to be one nobody reaches by
    // accident: the button will not answer until the name is spelled out.
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'infinite-agents' } });
    expect((within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says who asked, and offers the other answer as plainly as this one', async () => {
    withAsk({ deleteAsk: { at: '2026-09-01T10:00:00.000Z', canDecide: true, byAgentName: 'Ben' } });
    await screen.findByRole('heading', { name: 'infinite-agents' });
    await waitFor(() => expect(document.querySelector('#repoDanger .asked')).toBeTruthy());
    expect(document.querySelector('#repoDanger .asked')!.textContent)
      .toContain('Ben asked you to delete this repository');
    // A request with only one button on it is not a decision.
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeTruthy();
  });

  it('leaves a request nobody here may answer with the reason, and no buttons', async () => {
    withAsk({ deleteAsk: { at: '2026-09-01T10:00:00.000Z', canDecide: false } });
    await screen.findByRole('heading', { name: 'infinite-agents' });
    await waitFor(() => expect(document.querySelector('#repoDanger .asked')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Delete this repository' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep it' })).toBeNull();
    expect(document.querySelector('#repoDanger .hintblock')!.textContent)
      .toContain('Only the owner of the agent that made this request can decide it');
  });

  it('shows a standing CI-secrets grant as a fact, with no decision on it (note #739)', async () => {
    withAsk({ ciSecrets: { names: ['FLY_TOKEN', 'NPM_TOKEN'] } });
    await screen.findByRole('heading', { name: 'infinite-agents' });
    await waitFor(() => expect(document.getElementById('repoCiSecrets')?.hidden).toBe(false));
    expect(document.getElementById('repoCiSecrets')!.textContent).toContain('Approved checks use FLY_TOKEN, NPM_TOKEN');
    expect(document.querySelector('#repoCiSecrets + .hintblock')!.textContent)
      .toContain('Only checks on the protected branch receive them');
    expect(document.querySelector('#repoCiSecrets + .hintblock')!.textContent).toContain('Ask any agent to take a name back');
    // Granted at once by an admin's agent: nothing here is asked, and the
    // danger zone carries no request for it.
    expect(screen.queryByRole('button', { name: 'Allow for approved CI' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep private' })).toBeNull();
    expect(document.querySelector('#repoDanger .asked')).toBeNull();
  });

  it('names the keys a grant uses, and says the whole workplace reaches the repository (note #566)', async () => {
    // The card named whose room's keys they were while secrets could be a
    // room's (note #843); the answer may still say, and the card does not.
    withAsk({ ciSecrets: { names: ['DEPLOY_TOKEN'] } });
    await screen.findByRole('heading', { name: 'infinite-agents' });
    await waitFor(() => expect(document.getElementById('repoCiSecrets')?.hidden).toBe(false));
    expect(document.getElementById('repoCiSecrets')!.textContent).toContain('Approved checks use DEPLOY_TOKEN');
    expect(document.getElementById('repoCiSecrets')!.textContent).not.toContain('Growth');
    // What used to be the room-sharing card is one sentence: there is
    // nothing to share with, and nothing on this screen offers to.
    expect(document.getElementById('repoRoomHint')!.textContent)
      .toBe('Everyone in the workplace, and every agent in it, can see, clone and push this repository.');
    expect(document.getElementById('repoRoom')).toBeNull();
    expect(screen.queryByText('tap to change access')).toBeNull();
  });

  it('a repository with no grant says nothing about keys', async () => {
    withAsk();
    await screen.findByRole('heading', { name: 'infinite-agents' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete this repository' })).toBeTruthy());
    expect(document.getElementById('repoCiSecrets')?.hidden).toBe(true);
    expect(document.getElementById('repoCiSecretsHead')).toBeNull();
  });
});

describe('publishing on approval (`agentbuilt repo publish`)', () => {
  const openRepo = (extra: Partial<WorkspaceRepoRow>, answers: Record<string, Answer> = {}) => open(
    inWorkplace({ repos: [repo({ name: 'ship-it', ...extra })] }),
    { ...repoScreenScript('ship-it', () => ({ branch: 'main', entries: [] })), ...answers },
    `/repositories/ship-it${scoped}`,
  );

  it('a standing link says where approved changes go, and how to take it back — and asks nothing (note #739)', async () => {
    openRepo({ publishesTo: 'startup-game' });
    await screen.findByRole('heading', { name: 'ship-it' });
    await waitFor(() => expect(document.getElementById('repoPublishing')?.hidden).toBe(false));
    expect(document.getElementById('repoPublishing')!.textContent).toContain('Publishes startup-game');
    expect(document.querySelector('#repoPublishing + .hintblock')!.textContent).toContain('Ask any agent to go back to publishing by hand');
    // Linked at once by an admin's agent: no request waits in the danger zone.
    expect(screen.queryByRole('button', { name: 'Publish on approval' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep publishing by hand' })).toBeNull();
    expect(document.querySelector('#repoDanger .asked')).toBeNull();
  });

  it('a repository published by hand says nothing about it', async () => {
    openRepo({});
    await screen.findByRole('heading', { name: 'ship-it' });
    await waitFor(() => expect(document.getElementById('repoDanger')).toBeTruthy());
    expect(document.getElementById('repoPublishingHead')).toBeNull();
  });
});

describe('public access: an admin opens a repository from its screen (back since note #936)', () => {
  it('offers an admin of a private repository Make public, with the licence rule beside it', async () => {
    open(
      inWorkplace({ repos: [repo({ name: 'infinite-agents' })] }),
      repoScreenScript('infinite-agents', () => ({ branch: 'main', entries: [] })),
      `/repositories/infinite-agents${scoped}`,
    );
    await screen.findByRole('heading', { name: 'infinite-agents' });
    expect(await screen.findByRole('heading', { name: 'Public access' })).toBeTruthy();
    expect(document.querySelector('#repoPublicAccess .name')?.textContent).toBe('Private');
    expect(screen.getByRole('button', { name: 'Make public' })).toBeTruthy();
    expect(screen.getByText(/non-empty LICENSE file at the repository root/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open public page' })).toBeNull();
  });

  it('leaves a member of the workplace the state and no control', async () => {
    open(
      inWorkplace({ org: { ...org, role: 'member' }, repos: [repo({ name: 'infinite-agents' })] }),
      repoScreenScript('infinite-agents', () => ({ branch: 'main', entries: [] })),
      `/repositories/infinite-agents${scoped}`,
    );
    await screen.findByRole('heading', { name: 'infinite-agents' });
    expect(await screen.findByRole('heading', { name: 'Public access' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make public' })).toBeNull();
    expect(screen.getByText('Only a workplace admin can change public access.')).toBeTruthy();
    expect(screen.queryByText(/non-empty LICENSE file/)).toBeNull();
  });

  it('confirms publishing, says what a stranger can clone, and shows the link after', async () => {
    const state = inWorkplace({ repos: [repo({ name: 'infinite-agents' })] });
    open(
      state,
      {
        ...repoScreenScript('infinite-agents', () => ({ branch: 'main', entries: [] })),
        'POST api/repos/infinite-agents/public-access': (call) => {
          expect(JSON.parse(String(call.init?.body))).toEqual({ public: true });
          state.repos![0]!.publicUrl = 'https://workspace.test/acme/infinite-agents';
          return { public: true, publicUrl: 'https://workspace.test/acme/infinite-agents', publishedAt: '2026-11-01T10:00:00.000Z' };
        },
      },
      `/repositories/infinite-agents${scoped}`,
    );
    await screen.findByRole('heading', { name: 'infinite-agents' });
    fireEvent.click(await screen.findByRole('button', { name: 'Make public' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('clone the full history, including every branch');
    expect(dialog.textContent).toContain('Copies people make cannot be recalled');
    expect(dialog.textContent).not.toContain('open-source page');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make public' }));
    expect(await screen.findByRole('link', { name: 'Open public page' })).toBeTruthy();
    expect(document.querySelector('#repoPublicAccess .name')?.textContent).toBe('Public');
    expect(screen.getByRole('button', { name: 'Make private' })).toBeTruthy();
  });

  it('shows public state to a member but leaves publication controls with admins', async () => {
    open(
      inWorkplace({
        org: { ...org, role: 'member' },
        repos: [repo({ name: 'infinite-agents', publicUrl: 'https://workspace.test/public/repositories/123' })],
      }),
      repoScreenScript('infinite-agents', () => ({ branch: 'main', entries: [] })),
      `/repositories/infinite-agents${scoped}`,
    );
    await screen.findByRole('heading', { name: 'infinite-agents' });
    expect(await screen.findByRole('link', { name: 'Open public page' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make private' })).toBeNull();
    expect(screen.getByText('Only a workplace admin can change public access.')).toBeTruthy();
  });

  it('confirms withdrawal, says copies already made remain, and offers Make public again', async () => {
    const state = inWorkplace({
      repos: [repo({ name: 'infinite-agents', publicUrl: 'https://workspace.test/public/repositories/123' })],
    });
    open(
      state,
      {
        ...repoScreenScript('infinite-agents', () => ({ branch: 'main', entries: [] })),
        'POST api/repos/infinite-agents/public-access': (call) => {
          expect(JSON.parse(String(call.init?.body))).toEqual({ public: false });
          delete state.repos![0]!.publicUrl;
          return { public: false };
        },
      },
      `/repositories/infinite-agents${scoped}`,
    );
    await screen.findByRole('heading', { name: 'infinite-agents' });
    fireEvent.click(await screen.findByRole('button', { name: 'Make private' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Copies already made remain');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make private' }));
    expect(await screen.findByRole('button', { name: 'Make public' })).toBeTruthy();
    expect(document.querySelector('#repoPublicAccess .name')?.textContent).toBe('Private');
  });
});

describe('the public repository page', () => {
  it('opens without signing in, lists source, and walks into a readable file', async () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const scripted = scriptedApi({
      'GET auth/session': () => ({ authenticated: false }),
      [`GET api/public/repos/${id}/tree`]: () => ({
        name: 'open-kit', cloneUrl: 'https://git.test/ns/open-kit.git', path: '', branch: 'main',
        entries: [
          { name: 'src', type: 'dir' as const },
          { name: 'README.md', type: 'file' as const, sizeBytes: 18 },
          { name: 'index.ts', type: 'file' as const, sizeBytes: 12 },
        ],
      }),
      [`GET api/public/repos/${id}/file?path=README.md`]: () => ({
        name: 'open-kit', cloneUrl: 'https://git.test/ns/open-kit.git', path: 'README.md', branch: 'main',
        sizeBytes: 18, content: '# Open kit\n\nHello.\n',
      }),
      [`GET api/public/repos/${id}/file?path=index.ts`]: () => ({
        name: 'open-kit', cloneUrl: 'https://git.test/ns/open-kit.git', path: 'index.ts', branch: 'main',
        sizeBytes: 12, content: 'export {};\n',
      }),
    });
    render(
      <MemoryRouter initialEntries={[`/public/repositories/${id}`]}>
        <App api={scripted.api} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: /open-kit/ })).toBeTruthy();
    // No sign-in gate — the header offers the doors, the page shows the source.
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
    // Since note #822 our platform offers no sign-up: the second door is the
    // site's Build yours, to the engineer's page.
    expect(screen.getByRole('link', { name: /Build yours/ }).getAttribute('href')).toBe('/own-cloud');
    expect(screen.queryByRole('link', { name: /Sign up/ })).toBeNull();
    expect(screen.getByText('Public')).toBeTruthy();
    expect(screen.getByText('https://git.test/ns/open-kit.git')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Open kit' })).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: /index\.ts/ }));
    expect(await screen.findByText('export {};', { exact: false })).toBeTruthy();
    expect(document.querySelector('.code .gutter')?.textContent).toBe('1');
  });
});
