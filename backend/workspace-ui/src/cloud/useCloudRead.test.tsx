import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceOrgSpendAnswer } from '../../../src/shared/workspace-api.js';
import { cloudMachineList } from './cloud-cache.js';
import { CLOUD_READ_AGAIN_MS, useCloudRead } from './useCloudRead.js';

const { api } = vi.hoisted(() => ({ api: { api: vi.fn() } }));
vi.mock('../screens/org/useOrgApi.js', () => ({ useOrgApi: () => api, useOrgId: () => null }));

const bill = (orgSlug: string) => ({
  orgSlug, machines: [], disclaimer: 'd', namesRead: true, machinesElsewhere: 0,
  totals: { estimatedMonthlyUsd: 0, runningMonthlyUsd: 0, spentThisMonthUsd: 0, unmeasured: 0, running: 0, stopped: 0 },
}) as WorkspaceOrgSpendAnswer;

// The mock is a module-level `vi.fn()`, so its own tally outlives a test.
beforeEach(() => { api.api.mockReset(); });

/** The read is started off the effect's own tick (see `useCloudRead`), so the
 *  mock has not been reached by the time `renderHook` returns. */
const settle = () => act(async () => { await Promise.resolve(); });

const open = (orgId: string) => renderHook(
  ({ org }) => useCloudRead<WorkspaceOrgSpendAnswer>(org, 'api/org/spend', cloudMachineList),
  { initialProps: { org: orgId } },
);

/**
 * The hazard a cache keyed by workplace exists to prevent: one account's
 * bill drawn under another account's heading. The address carries the
 * workplace (`?org=`), so switching it changes `orgId` under a hook that
 * is NOT remounted — which is why the held copy is read during the render
 * rather than seeded into state.
 */
it('drops the old workplace’s bill at once, and refuses its late answer', async () => {
  let late: (answer: unknown) => void = () => {};
  api.api.mockImplementation(() => new Promise((resolve) => { late = resolve; }));
  const { result, rerender } = open('old');
  await settle();
  await act(async () => { late(bill('old-account')); });
  expect(result.current.answer?.orgSlug).toBe('old-account');

  api.api.mockImplementation(() => new Promise((resolve) => { late = resolve; }));
  rerender({ org: 'new' });
  // Nothing of the old account survives the switch, not even for a frame.
  expect(result.current.answer).toBeNull();
  await settle();
  await act(async () => { late(bill('new-account')); });
  expect(result.current.answer?.orgSlug).toBe('new-account');

  // …and the old account's copy is still held for the old account, so
  // switching BACK opens on it rather than waiting again.
  expect(cloudMachineList.held('old')?.answer.orgSlug).toBe('old-account');
  rerender({ org: 'old' });
  expect(result.current.answer?.orgSlug).toBe('old-account');
});

/**
 * The other direction, which is NOT a switch: a hand-typed address carries no
 * `?org=`, so the first read goes out before the shell knows where it is
 * standing — and the server answers for the reader's active workplace,
 * which is the one that then resolves. Taking that answer off the screen
 * would put a second wait in front of a reader who was already reading it.
 */
it('keeps the answer it read before the workplace was known', async () => {
  api.api.mockImplementation(() => Promise.resolve(bill('the-only-account')));
  const { result, rerender } = renderHook(
    ({ org }) => useCloudRead<WorkspaceOrgSpendAnswer>(org, 'api/org/spend', cloudMachineList),
    { initialProps: { org: null as string | null } },
  );
  await settle();
  expect(result.current.answer?.orgSlug).toBe('the-only-account');
  rerender({ org: 'o1' });
  expect(result.current.answer?.orgSlug).toBe('the-only-account');
});

/**
 * The pace. This read walks every app in the Fly account — measured from the
 * backend at about two seconds and sixty calls into Fly for thirty apps — so
 * the trip note #368 is about (out to an agent and straight back) must not
 * pay for it twice.
 */
it('will not re-read inside the floor, and does once the answer has aged past it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.api.mockImplementation(() => Promise.resolve(bill('one-account')));
  const first = open('o1');
  await waitFor(() => expect(first.result.current.answer).not.toBeNull());
  expect(api.api).toHaveBeenCalledTimes(1);
  first.unmount();

  // Straight back: the figures cannot have moved, and what is held goes up
  // with no read at all.
  const again = open('o1');
  expect(again.result.current.answer?.orgSlug).toBe('one-account');
  expect(api.api).toHaveBeenCalledTimes(1);
  again.unmount();

  await act(async () => { await vi.advanceTimersByTimeAsync(CLOUD_READ_AGAIN_MS); });
  const later = open('o1');
  // Still drawn from the copy on the very first render — the read is what
  // happens underneath it.
  expect(later.result.current.answer?.orgSlug).toBe('one-account');
  await waitFor(() => expect(api.api).toHaveBeenCalledTimes(2));
  vi.useRealTimers();
});
