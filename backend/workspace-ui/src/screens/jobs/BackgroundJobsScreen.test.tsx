import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App.js';
import { agent, emptyState, scriptedApi, workspaceScript } from '../../test/fixtures.js';

const world = () => emptyState({
  org: { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] },
  agents: [agent({ id: 'felix', name: 'Felix', working: false })],
});

function open(
  jobs: Array<{ id: string; label: string; startedAt: string }>,
  recent?: Array<{ id: string; label: string; startedAt: string; finishedAt: string; status: string }>,
) {
  const scripted = scriptedApi({
    ...workspaceScript(world),
    'GET api/agents/felix/jobs': () => ({ jobs, ...(recent ? { recent } : {}) }),
  });
  render(
    <MemoryRouter initialEntries={['/agents/felix/jobs']}>
      <App api={scripted.api} />
    </MemoryRouter>,
  );
  return scripted;
}

describe('the background jobs screen', () => {
  it('shows every active job with its whole redacted command, exact start and id', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Deliberately beyond the module-level shared clock's real import time:
    // useNow floors its first snapshot at mount so a stale shared reading can
    // never make a fresh timestamp look like the future.
    vi.setSystemTime(new Date('2036-09-18T10:02:03.000Z'));
    open([
      {
        id: 'j_111111111111111111111111',
        label: 'bash -lc npm run build && deploy --token=[REDACTED]',
        startedAt: '2036-09-18T10:00:00.000Z',
      },
      {
        id: 'j_222222222222222222222222',
        label: 'node scripts/render.mjs --mobile',
        startedAt: '2036-09-18T10:01:00.000Z',
      },
    ]);

    await screen.findByRole('heading', { name: 'Background jobs' });
    await waitFor(() => expect(document.querySelectorAll('.jobdetail')).toHaveLength(2));
    expect([...document.querySelectorAll('.jobcommand')].map((row) => row.textContent)).toEqual([
      'bash -lc npm run build && deploy --token=[REDACTED]',
      'node scripts/render.mjs --mobile',
    ]);
    // Note #564: the state is the first fact on every card.
    expect([...document.querySelectorAll('#agentJobsList .jobmeta > div:first-child')].map((row) => row.textContent))
      .toEqual(['StatusRunning', 'StatusRunning']);
    expect(document.querySelectorAll('#agentJobsList .jobstatus.running')).toHaveLength(2);
    expect(document.getElementById('agentJobsRecent')).toBeNull();
    expect([...document.querySelectorAll('.jobelapsed')].map((row) => row.textContent)).toEqual(['2:03', '1:03']);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect([...document.querySelectorAll('.jobelapsed')].map((row) => row.textContent)).toEqual(['2:04', '1:04']);
    expect([...document.querySelectorAll('time')].map((row) => row.getAttribute('datetime'))).toEqual([
      '2036-09-18T10:00:00.000Z',
      '2036-09-18T10:01:00.000Z',
    ]);
    expect(document.getElementById('agentJobsList')!.textContent).toContain('j_111111111111111111111111');
  });

  it('states plainly when no background jobs are running', async () => {
    open([]);
    await screen.findByText('No background jobs are running');
    expect(document.getElementById('agentJobsEmpty')!.textContent)
      .toContain('A job that ends stays here for a day, with how it ended.');
    expect(document.getElementById('agentJobsList')).toBeNull();
  });

  it('keeps the newest outcomes under the live list, each saying how it ended (note #564)', async () => {
    open(
      [{ id: 'j_111111111111111111111111', label: 'npm run build', startedAt: '2036-09-18T10:00:00.000Z' }],
      [
        {
          id: 'j_222222222222222222222222', label: 'agentbuilt repo checks --wait', status: 'succeeded',
          startedAt: '2036-09-18T09:00:00.000Z', finishedAt: '2036-09-18T09:09:04.000Z',
        },
        {
          id: 'j_333333333333333333333333', label: 'node migrate.mjs', status: 'failed',
          startedAt: '2036-09-18T08:00:00.000Z', finishedAt: '2036-09-18T08:00:31.000Z',
        },
        {
          id: 'j_444444444444444444444444', label: 'node render.mjs', status: 'timed_out',
          startedAt: '2036-09-18T06:00:00.000Z', finishedAt: '2036-09-18T07:00:00.000Z',
        },
      ],
    );
    await screen.findByRole('heading', { name: 'Recently finished' });
    expect(document.querySelectorAll('#agentJobsList .jobdetail')).toHaveLength(1);
    const settled = [...document.querySelectorAll('#agentJobsRecent .jobdetail')];
    expect(settled.map((card) => card.querySelector('.jobstatus')!.textContent))
      .toEqual(['Finished', 'Failed', 'Timed out']);
    expect(settled.map((card) => card.querySelector('.jobstatus')!.className))
      .toEqual(['jobstatus succeeded', 'jobstatus failed', 'jobstatus timed_out']);
    // How long it RAN, fixed — an outcome has no stopwatch.
    expect(settled.map((card) => card.querySelector('.jobmeta > div:nth-child(2)')!.textContent))
      .toEqual(['Ran for9:04', 'Ran for0:31', 'Ran for1:00:00']);
    expect(document.querySelectorAll('#agentJobsRecent .jobelapsed')).toHaveLength(0);
  });

  it('shows outcomes alone when nothing is running any more', async () => {
    open([], [{
      id: 'j_222222222222222222222222', label: 'agentbuilt repo checks --wait', status: 'stopped',
      startedAt: '2036-09-18T09:00:00.000Z', finishedAt: '2036-09-18T09:09:04.000Z',
    }]);
    await screen.findByText('Stopped by the agent');
    expect(document.getElementById('agentJobsEmpty')!.textContent)
      .toContain('The most recent ones are below');
    expect(document.getElementById('agentJobsList')).toBeNull();
  });
});

afterEach(() => { vi.useRealTimers(); });
