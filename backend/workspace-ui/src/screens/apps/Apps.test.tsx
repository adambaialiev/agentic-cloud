import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../App.js';
import { WorkspaceApiError } from '../../api/client.js';
import { emptyState, scriptedApi, signedOut, workspaceScript, type Answer } from '../../test/fixtures.js';
import type { WorkspaceAppCatalogueAnswer } from '../../../../src/shared/workspace-api.js';

/**
 * The app catalogue (note #756): a public page of every site deployed
 * here, newest first — picture, name, one line, maker, link — read by a
 * stranger without an account, and inside the Workspace by someone signed in.
 */

const CATALOGUE: WorkspaceAppCatalogueAnswer = {
  apps: [
    {
      name: 'ember-coffee', url: 'https://ember-coffee.agentbuilt.app', line: 'Order your coffee before you reach the counter.',
      builder: { name: 'Adam Reyes', handle: 'adam', photoUrl: '/faces/adam.jpg' },
      pictureUrl: 'https://media.example/ember.png', publishedAt: '2026-10-15T10:00:00.000Z', createdAt: '2026-10-15T10:00:00.000Z',
    },
    {
      name: 'math-tutor', url: 'https://math-tutor.agentbuilt.app', line: 'Daily practice for the 5th grade, one problem at a time.',
      builder: { name: 'Dana' }, publishedAt: '2026-10-14T10:00:00.000Z', createdAt: '2026-10-14T10:00:00.000Z',
    },
  ],
};

function renderAt(path: string, script: Record<string, Answer>) {
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

afterEach(() => cleanup());

describe('the app catalogue at /apps', () => {
  it('shows a stranger every listed app, newest first, with its maker and link, and no sign-in gate', async () => {
    renderAt('/apps', { 'GET auth/session': signedOut, 'GET api/public/apps': () => CATALOGUE });
    expect(await screen.findByRole('heading', { name: 'Apps' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy());
    expect(document.getElementById('pageBack')).toBeNull();
    const cards = document.querySelectorAll('.appcard');
    expect([...cards].map((card) => card.getAttribute('data-app'))).toEqual(['ember-coffee', 'math-tutor']);
    expect(document.getElementById('appsSub')?.textContent).toContain('2 apps');
    // The newest: picture, name as a door to the site, line, maker as a door to their page.
    const ember = cards[0]!;
    expect(ember.querySelector('.appshot img')?.getAttribute('src')).toBe('https://media.example/ember.png');
    expect(ember.querySelector('h2 a')?.getAttribute('href')).toBe('https://ember-coffee.agentbuilt.app');
    expect(ember.querySelector('.appline')?.textContent).toBe('Order your coffee before you reach the counter.');
    expect(ember.querySelector('a.appbuilder')?.getAttribute('href')).toBe('/adam');
    expect(ember.querySelector('.appbuilder .appwho')?.textContent).toBe('Adam Reyes');
    expect(ember.querySelector('.applink')?.textContent).toContain('ember-coffee.agentbuilt.app');
    // No picture yet: the name stands in; a maker with no address is a name only.
    const tutor = cards[1]!;
    expect(tutor.querySelector('.appshot img')).toBeNull();
    expect(tutor.querySelector('.appnoshot')?.textContent).toBe('math-tutor');
    expect(tutor.querySelector('a.appbuilder')).toBeNull();
    expect(tutor.querySelector('span.appbuilder .appwho')?.textContent).toBe('Dana');
    expect(document.title).toBe('Apps — Agentic Cloud Computer');
  });

  it('says so when nothing is listed, and when the catalogue cannot be read', async () => {
    renderAt('/apps', { 'GET auth/session': signedOut, 'GET api/public/apps': () => ({ apps: [] }) });
    expect(await screen.findByText(/Nothing is listed yet/)).toBeTruthy();
    cleanup();
    renderAt('/apps', { 'GET auth/session': signedOut, 'GET api/public/apps': () => { throw new WorkspaceApiError('The app catalogue could not be read just now.', 503, {}); } });
    expect(await screen.findByText(/could not be read just now/)).toBeTruthy();
    expect(document.getElementById('appsError')).toBeTruthy();
  });

  it('is a Workspace screen with Back for someone signed in', async () => {
    renderAt('/apps', { ...workspaceScript(() => emptyState()), 'GET api/public/apps': () => CATALOGUE });
    expect(await screen.findByRole('heading', { name: 'Apps' })).toBeTruthy();
    await waitFor(() => expect(document.getElementById('pageBack')).toBeTruthy());
    expect(document.querySelector('.public-repo-head')).toBeNull();
    expect(screen.queryByRole('link', { name: /Open Workspace/ })).toBeNull();
    expect(document.querySelectorAll('.appcard').length).toBe(2);
  });
});
