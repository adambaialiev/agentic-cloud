import { describe, expect, it } from 'vitest';
import { consumeSystemdListenFd } from '../../services/systemd-listen.js';

describe('systemd socket activation', () => {
  it('uses fd 3 for the one named listener systemd handed this process', () => {
    const env = {
      LISTEN_PID: '4242',
      LISTEN_FDS: '1',
      LISTEN_FDNAMES: 'backend-http',
    };

    expect(consumeSystemdListenFd(env, 4242)).toBe(3);
    expect(env).toEqual({});
  });

  it('accepts an unnamed listener — FileDescriptorName is helpful, not required', () => {
    const env = { LISTEN_PID: '4242', LISTEN_FDS: '1' };
    expect(consumeSystemdListenFd(env, 4242)).toBe(3);
    expect(env).toEqual({});
  });

  it('ignores stale activation variables belonging to another process', () => {
    const env = { LISTEN_PID: '1111', LISTEN_FDS: '1', LISTEN_FDNAMES: 'backend-http' };
    expect(consumeSystemdListenFd(env, 4242)).toBeUndefined();
    // Never lend our activation contract to a child, even when it was stale.
    expect(env).toEqual({});
  });

  it('keeps ordinary local and test launches on PORT', () => {
    expect(consumeSystemdListenFd({}, 4242)).toBeUndefined();
  });

  it('fails closed when systemd hands the backend an unexpected socket set', () => {
    expect(() => consumeSystemdListenFd({
      LISTEN_PID: '4242', LISTEN_FDS: '2', LISTEN_FDNAMES: 'backend-http:other',
    }, 4242)).toThrow(/expected one listener, received 2/);

    expect(() => consumeSystemdListenFd({
      LISTEN_PID: '4242', LISTEN_FDS: '1', LISTEN_FDNAMES: 'wrong-name',
    }, 4242)).toThrow(/expected backend-http, received wrong-name/);
  });
});
