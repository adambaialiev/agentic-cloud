import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useCloud } from './useCloud.js';
const { api } = vi.hoisted(() => ({ api: { api: vi.fn() } }));
vi.mock('../session/useSession.js', () => ({ useSession: () => ({ api }) }));

it('drops old-org counts immediately and refuses a late answer after switching workplaces', async () => {
  let late: (data: unknown) => void = () => {};
  api.api.mockImplementation((_path, _init, scope) => scope.org === 'old'
    ? new Promise(resolve => { late = resolve; })
    : Promise.resolve({ orgId: 'new', role: 'member', fly: { connected: false }, machines: null }));
  const { result, rerender } = renderHook(({ orgId }) => useCloud(orgId), { initialProps: { orgId: 'old' } });
  rerender({ orgId: 'new' });
  expect(result.current.data).toBeNull();
  await waitFor(() => expect(result.current.data?.orgId).toBe('new'));
  await act(async () => late({ orgId: 'old', fly: { connected: true }, machines: { active: 999 } }));
  expect(result.current.data?.orgId).toBe('new');
  expect(result.current.data?.fly.connected).toBe(false);
});
