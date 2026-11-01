import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentEventEmitter } from '../../agent/agent-event-emitter.js';
import { WSMessage } from '../../types/agent.js';

describe('AgentEventEmitter', () => {
  let emitter: AgentEventEmitter;

  beforeEach(() => {
    emitter = new AgentEventEmitter();
  });

  describe('subscribe/emit', () => {
    it('should deliver events to subscribed callbacks', () => {
      const callback = vi.fn();
      const sessionId = 'test-session';

      emitter.subscribe(sessionId, callback);

      const event: WSMessage = {
        type: 'agent_start',
        sessionId,
        data: {},
        timestamp: new Date().toISOString(),
      };
      emitter.emit(sessionId, event);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(event);
    });

    it('should deliver events to multiple subscribers', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const sessionId = 'test-session';

      emitter.subscribe(sessionId, callback1);
      emitter.subscribe(sessionId, callback2);

      const event: WSMessage = {
        type: 'agent_start',
        sessionId,
        data: {},
        timestamp: new Date().toISOString(),
      };
      emitter.emit(sessionId, event);

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback1).toHaveBeenCalledWith(event);
      expect(callback2).toHaveBeenCalledWith(event);
    });

    it('should not deliver events to other sessions', () => {
      const callback = vi.fn();

      emitter.subscribe('session-1', callback);

      const event: WSMessage = {
        type: 'agent_start',
        sessionId: 'session-2',
        data: {},
        timestamp: new Date().toISOString(),
      };
      emitter.emit('session-2', event);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should silently drop events when no subscribers', () => {
      const event: WSMessage = {
        type: 'agent_start',
        sessionId: 'no-subscribers',
        data: {},
        timestamp: new Date().toISOString(),
      };

      // Should not throw
      expect(() => emitter.emit('no-subscribers', event)).not.toThrow();
    });
  });

  describe('unsubscribe', () => {
    it('should stop receiving events after unsubscribe', () => {
      const callback = vi.fn();
      const sessionId = 'test-session';

      const unsubscribe = emitter.subscribe(sessionId, callback);

      // First event should be received
      emitter.emit(sessionId, {
        type: 'agent_start',
        sessionId,
        data: {},
        timestamp: new Date().toISOString(),
      });

      expect(callback).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      // Second event should not be received
      emitter.emit(sessionId, {
        type: 'agent_complete',
        sessionId,
        data: {},
        timestamp: new Date().toISOString(),
      });

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should only unsubscribe the specific callback', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const sessionId = 'test-session';

      const unsubscribe1 = emitter.subscribe(sessionId, callback1);
      emitter.subscribe(sessionId, callback2);

      unsubscribe1();

      const event: WSMessage = {
        type: 'agent_start',
        sessionId,
        data: {},
        timestamp: new Date().toISOString(),
      };
      emitter.emit(sessionId, event);

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  describe('error isolation', () => {
    it('should continue delivering to other callbacks when one throws', () => {
      const errorCallback = vi.fn(() => {
        throw new Error('Callback error');
      });
      const normalCallback = vi.fn();
      const sessionId = 'test-session';

      emitter.subscribe(sessionId, errorCallback);
      emitter.subscribe(sessionId, normalCallback);

      const event: WSMessage = {
        type: 'agent_start',
        sessionId,
        data: {},
        timestamp: new Date().toISOString(),
      };

      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      emitter.emit(sessionId, event);

      expect(errorCallback).toHaveBeenCalledTimes(1);
      expect(normalCallback).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('hasSubscribers', () => {
    it('should return true when session has subscribers', () => {
      const sessionId = 'test-session';

      emitter.subscribe(sessionId, vi.fn());

      expect(emitter.hasSubscribers(sessionId)).toBe(true);
    });

    it('should return false when session has no subscribers', () => {
      expect(emitter.hasSubscribers('no-subscribers')).toBe(false);
    });

    it('should return false after all subscribers unsubscribe', () => {
      const sessionId = 'test-session';

      const unsub1 = emitter.subscribe(sessionId, vi.fn());
      const unsub2 = emitter.subscribe(sessionId, vi.fn());

      unsub1();
      unsub2();

      expect(emitter.hasSubscribers(sessionId)).toBe(false);
    });
  });

  describe('getSubscriberCount', () => {
    it('should return correct count', () => {
      const sessionId = 'test-session';

      expect(emitter.getSubscriberCount(sessionId)).toBe(0);

      emitter.subscribe(sessionId, vi.fn());
      expect(emitter.getSubscriberCount(sessionId)).toBe(1);

      emitter.subscribe(sessionId, vi.fn());
      expect(emitter.getSubscriberCount(sessionId)).toBe(2);
    });
  });

  describe('clearSession', () => {
    it('should remove all subscribers for a session', () => {
      const callback = vi.fn();
      const sessionId = 'test-session';

      emitter.subscribe(sessionId, callback);
      emitter.clearSession(sessionId);

      emitter.emit(sessionId, {
        type: 'agent_start',
        sessionId,
        data: {},
        timestamp: new Date().toISOString(),
      });

      expect(callback).not.toHaveBeenCalled();
      expect(emitter.hasSubscribers(sessionId)).toBe(false);
    });

    it('should not affect other sessions', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      emitter.subscribe('session-1', callback1);
      emitter.subscribe('session-2', callback2);

      emitter.clearSession('session-1');

      emitter.emit('session-2', {
        type: 'agent_start',
        sessionId: 'session-2',
        data: {},
        timestamp: new Date().toISOString(),
      });

      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });
});
