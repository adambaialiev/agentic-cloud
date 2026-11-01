import { WSMessage } from '../types/agent.js';

export type EventCallback = (event: WSMessage) => void;

/**
 * In-memory pub/sub for real-time delivery to connected WebSocket clients.
 * Events are not persisted - they're only delivered to currently subscribed clients.
 */
export class AgentEventEmitter {
  private listeners = new Map<string, Set<EventCallback>>();

  /**
   * Subscribe to events for a specific session.
   * Returns an unsubscribe function.
   */
  subscribe(sessionId: string, callback: EventCallback): () => void {
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Set());
    }
    this.listeners.get(sessionId)!.add(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get(sessionId);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.listeners.delete(sessionId);
        }
      }
    };
  }

  /**
   * Emit an event to all subscribers of a session.
   * If no subscribers, event is silently dropped (fire-and-forget).
   */
  emit(sessionId: string, event: WSMessage): void {
    const callbacks = this.listeners.get(sessionId);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(event);
        } catch (error) {
          console.error(`Error in event callback for session ${sessionId}:`, error);
        }
      }
    }
  }

  /**
   * Check if there are any active subscribers for a session.
   */
  hasSubscribers(sessionId: string): boolean {
    const callbacks = this.listeners.get(sessionId);
    return !!callbacks && callbacks.size > 0;
  }

  /**
   * Get the number of subscribers for a session.
   */
  getSubscriberCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }

  /**
   * Remove all subscribers for a session.
   */
  clearSession(sessionId: string): void {
    this.listeners.delete(sessionId);
  }

}

// Singleton instance for the application
export const globalEventEmitter = new AgentEventEmitter();
