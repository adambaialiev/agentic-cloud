import type { UserInputPayload } from '../types/agent.js';

/**
 * Owner chat messages that Manual Stop caught before they reached the
 * harness. They stay here until the owner sends the agent another message,
 * when they are prepended to that one in their original order.
 */
export interface StoppedUserMessagesDocument {
  /** Per-agent BackgroundRunner key; one held bundle per conversation. */
  runKey: string;
  sessionId: string;
  userId: string;
  agentId: string;
  payloads: UserInputPayload[];
  /** Opaque generation so consuming an old bundle cannot erase a newer Stop. */
  generation: string;
  savedAt: string;
}

export interface StoppedUserMessageStorage {
  save(doc: StoppedUserMessagesDocument): Promise<void>;
  listAll(): Promise<StoppedUserMessagesDocument[]>;
  delete(runKey: string): Promise<void>;
  /** Delete only the exact bundle successfully admitted into a later turn. */
  deleteIfGeneration(runKey: string, generation: string): Promise<boolean>;
}

export class InMemoryStoppedUserMessageStorage implements StoppedUserMessageStorage {
  private readonly docs = new Map<string, StoppedUserMessagesDocument>();

  async save(doc: StoppedUserMessagesDocument): Promise<void> {
    this.docs.set(doc.runKey, doc);
  }

  async listAll(): Promise<StoppedUserMessagesDocument[]> {
    return [...this.docs.values()];
  }

  async delete(runKey: string): Promise<void> {
    this.docs.delete(runKey);
  }

  async deleteIfGeneration(runKey: string, generation: string): Promise<boolean> {
    const current = this.docs.get(runKey);
    if (!current || current.generation !== generation) return false;
    this.docs.delete(runKey);
    return true;
  }
}
