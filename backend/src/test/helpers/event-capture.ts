import { WSMessage, WSMessageType } from '../../types/agent.js';
import { AgentEventEmitter } from '../../agent/agent-event-emitter.js';

/**
 * Captures events from an AgentEventEmitter for testing assertions.
 */
export class EventCapture {
  private events: WSMessage[] = [];
  private unsubscribe: (() => void) | null = null;

  /**
   * Start capturing events for a session.
   */
  subscribe(emitter: AgentEventEmitter, sessionId: string): this {
    this.unsubscribe = emitter.subscribe(sessionId, (event) => {
      this.events.push(event);
    });
    return this;
  }

  /**
   * Stop capturing events.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Get all captured events.
   */
  getEvents(): WSMessage[] {
    return [...this.events];
  }

  /**
   * Get events of a specific type.
   */
  getEventsOfType(type: WSMessageType): WSMessage[] {
    return this.events.filter((e) => e.type === type);
  }

  /**
   * Get the types of all captured events in order.
   */
  getEventTypes(): WSMessageType[] {
    return this.events.map((e) => e.type);
  }

  /**
   * Get the last event captured.
   */
  getLastEvent(): WSMessage | undefined {
    return this.events[this.events.length - 1];
  }

  /**
   * Get the first event of a specific type.
   */
  getFirstEventOfType(type: WSMessageType): WSMessage | undefined {
    return this.events.find((e) => e.type === type);
  }

  /**
   * Check if an event type was emitted.
   */
  hasEventType(type: WSMessageType): boolean {
    return this.events.some((e) => e.type === type);
  }

  /**
   * Get the count of events of a specific type.
   */
  getEventCount(type: WSMessageType): number {
    return this.events.filter((e) => e.type === type).length;
  }

  /**
   * Clear all captured events.
   */
  clear(): void {
    this.events = [];
  }

  /**
   * Reset the capture (clear events and unsubscribe).
   */
  reset(): void {
    this.stop();
    this.clear();
  }
}

/**
 * Assert that event types appear in the exact specified order.
 */
export function assertEventOrder(
  events: WSMessage[],
  expectedTypes: WSMessageType[]
): void {
  const actualTypes = events.map((e) => e.type);

  if (actualTypes.length !== expectedTypes.length) {
    throw new Error(
      `Event count mismatch. Expected ${expectedTypes.length} events, got ${actualTypes.length}.\n` +
        `Expected: [${expectedTypes.join(', ')}]\n` +
        `Actual:   [${actualTypes.join(', ')}]`
    );
  }

  for (let i = 0; i < expectedTypes.length; i++) {
    if (actualTypes[i] !== expectedTypes[i]) {
      throw new Error(
        `Event type mismatch at index ${i}.\n` +
          `Expected: ${expectedTypes[i]}\n` +
          `Actual:   ${actualTypes[i]}\n` +
          `Full sequence: [${actualTypes.join(', ')}]`
      );
    }
  }
}

/**
 * Assert that a subsequence of event types appears in order (not necessarily contiguous).
 */
export function assertEventSubsequence(
  events: WSMessage[],
  expectedSubsequence: WSMessageType[]
): void {
  const actualTypes = events.map((e) => e.type);
  let subIndex = 0;

  for (const type of actualTypes) {
    if (type === expectedSubsequence[subIndex]) {
      subIndex++;
      if (subIndex === expectedSubsequence.length) {
        return; // Found complete subsequence
      }
    }
  }

  throw new Error(
    `Subsequence not found in events.\n` +
      `Expected subsequence: [${expectedSubsequence.join(', ')}]\n` +
      `Found up to index ${subIndex}: [${expectedSubsequence.slice(0, subIndex).join(', ')}]\n` +
      `Actual events: [${actualTypes.join(', ')}]`
  );
}

/**
 * Assert that an event has specific data properties.
 */
export function assertEventData<T extends Record<string, unknown>>(
  event: WSMessage,
  expectedData: Partial<T>
): void {
  const data = event.data as T;

  for (const [key, expectedValue] of Object.entries(expectedData)) {
    const actualValue = data[key];

    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
      throw new Error(
        `Event data mismatch for key "${key}".\n` +
          `Expected: ${JSON.stringify(expectedValue)}\n` +
          `Actual:   ${JSON.stringify(actualValue)}`
      );
    }
  }
}
