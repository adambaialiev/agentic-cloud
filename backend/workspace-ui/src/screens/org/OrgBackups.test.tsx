import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceOrgDetail } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { agent, emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

/**
 * The workplace screen's backups block (note #357).
 *
 * The case that prompted it is the LAST one here: an org still on the
 * platform's git host — which is most of them, and was the org the request came
 * from — used to be shown nothing whatsoever about backups, because the only
 * rows that existed sat inside the block for orgs hosting their own git. A
 * screen that says nothing is read as "there are none", so these check that
 * each kind of org is told who holds its copies and when that last worked.
 */

function renderAt(path: string, script: Record<string, Answer>) {
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] };
const state = () => emptyState({
  org, canCreateOrg: true,
  organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 1, agents: 1 }],
  agents: [agent({ id: 'a', name: 'Ada' })],
});
const orgDetail = (overrides: Partial<WorkspaceOrgDetail> = {}): WorkspaceOrgDetail => ({
  orgId: 'o1', name: 'Nomad Trading', role: 'admin', invites: [], joinRequests: [], fly: { connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 } },
  members: [{ userId: 'u1', name: 'Saddam', you: true, role: 'admin', joinedAt: '2026-08-01T00:00:00Z', agents: 1, workedMs: 0 }],
  ...overrides,
});
const ownHost = {
  repoCount: 2,
  totalSizeBytes: 5 * 1024 * 1024,
  host: {
    health: 'ok' as const, volumeSizeGb: 10, snapshotRetentionDays: 5, growByGb: 10, growMonthlyUsd: 1.5,
    repoMaxBytes: 1024 * 1024 * 1024, repoMaxBytesAfterGrow: 2 * 1024 * 1024 * 1024,
  },
};

async function open(detail: WorkspaceOrgDetail) {
  vi.useFakeTimers();
  renderAt('/workplace?org=o1', { ...workspaceScript(state), 'GET api/org': () => ({ org: detail }) });
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
}

afterEach(() => { vi.useRealTimers(); });

describe('what a workplace is told about its backups', () => {
  it('reads an own-host org its bundles, its vault and its snapshots', async () => {
    await open(orgDetail({
      git: { ...ownHost, backup: { bucket: 'nomad-backups', everyHours: 6, last: { at: hoursAgo(2), ok: true } } },
    }));
    expect(screen.getByText('Backed up 2h ago · every 6 hours')).toBeTruthy();
    expect(screen.getByText('nomad-backups · in your cloud')).toBeTruthy();
    expect(screen.getByText('Daily, kept 5 days')).toBeTruthy();
  });

  it('says a backup failed rather than reporting when it last ran', async () => {
    await open(orgDetail({
      git: { ...ownHost, backup: { bucket: 'nomad-backups', everyHours: 6, last: { at: hoursAgo(1), ok: false } } },
    }));
    expect(screen.getByText('Last backup failed 1h ago · every 6 hours')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
  });

  // The silence this block exists to break: a run that stopped happening looks
  // exactly like one that never needed to, unless the page says so.
  it('calls a long-quiet backup overdue instead of printing a stale time as if fine', async () => {
    await open(orgDetail({
      git: { ...ownHost, backup: { bucket: 'nomad-backups', everyHours: 6, last: { at: hoursAgo(40), ok: true } } },
    }));
    expect(screen.getByText('overdue')).toBeTruthy();
  });

  // A host whose vault has not been provisioned is NOT waiting for a first run.
  it('does not promise a first backup to a host with nowhere to put one', async () => {
    await open(orgDetail({ git: ownHost }));
    expect(screen.getByText('No backups yet — the first one sets up your vault')).toBeTruthy();
    expect(screen.queryByText('First backup runs within a few hours')).toBeNull();
  });

  it('tells an org on the platform’s host who backs up its code and its chats', async () => {
    await open(orgDetail({
      git: { repoCount: 3, totalSizeBytes: 1024 },
      platformBackup: { code: { at: hoursAgo(4), ok: true }, workspace: { at: hoursAgo(4), ok: true } },
    }));
    expect(screen.getByText('Your code')).toBeTruthy();
    expect(screen.getByText('Chats, notes and proposals')).toBeTruthy();
    expect(screen.getAllByText('Backed up 4h ago · nightly, by the platform')).toHaveLength(2);
  });

  // An org hosting its own git reads its code off its OWN vault. The platform's
  // nightly bundles touch none of its repos, so they must not answer for them.
  it('never credits the platform’s nightly with code it does not hold', async () => {
    await open(orgDetail({
      git: { ...ownHost, backup: { bucket: 'nomad-backups', everyHours: 6, last: { at: hoursAgo(2), ok: true } } },
      platformBackup: { workspace: { at: hoursAgo(4), ok: true } },
    }));
    expect(screen.getByText('Backed up 2h ago · every 6 hours')).toBeTruthy();
    expect(screen.queryByText('Backed up 4h ago · nightly, by the platform')).toBeTruthy();
    expect(screen.getAllByText(/nightly, by the platform/)).toHaveLength(1);
  });

  // Nothing known is nothing shown: a Backups heading over an empty card reads
  // as "you have none", which is a worse claim than saying nothing at all.
  it('draws no backups block on a backend that knows of no backups', async () => {
    await open(orgDetail({ git: { repoCount: 1, totalSizeBytes: 512 } }));
    expect(screen.queryByText('Backups')).toBeNull();
  });
});
