import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserPresenceService } from '../../services/user-presence-service.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('UserPresenceService', () => {
  it('treats a user as active while at least one fresh active connection exists', () => {
    vi.useFakeTimers();
    const service = new UserPresenceService(60_000);

    service.updateConnection('user-1', 'socket-1', {
      active: true,
      visible: true,
      pathname: '/',
    });
    expect(service.isUserActive('user-1')).toBe(true);

    vi.advanceTimersByTime(61_000);
    expect(service.isUserActive('user-1')).toBe(false);
  });

  it('removes user activity when the last connection disconnects', () => {
    const service = new UserPresenceService(60_000);

    service.updateConnection('user-1', 'socket-1', {
      active: true,
      visible: true,
    });
    service.updateConnection('user-1', 'socket-2', {
      active: false,
      visible: false,
    });
    expect(service.isUserActive('user-1')).toBe(true);

    service.removeConnection('user-1', 'socket-1');
    expect(service.isUserActive('user-1')).toBe(false);
  });
});
