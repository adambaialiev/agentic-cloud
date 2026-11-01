import type { HarnessTurnAttachInfo, UserInputPayload } from '../types/agent.js';

/**
 * A Telegram turn that was in flight (or queued) when the backend shut down.
 *
 * Deploys restart the backend service; the graceful-shutdown handler aborts
 * every running agent loop, and before this storage existed the aborted turn's
 * user message lived only in process memory — so every deploy silently ate any
 * in-flight Telegram message (observed live: two dropped replies, each
 * immediately after a SIGTERM in the journal).
 *
 * One document per session, written during graceful shutdown and deleted the
 * moment the turn is resumed (or the user is notified) on the next boot. This
 * is transient operational state, not a transcript: for connected-harness
 * users the platform still persists no conversation history — a pending
 * payload exists only for the shutdown→resume window.
 */
export interface PendingTurnDocument {
  /**
   * The BackgroundRunner run key the turn was running under — the session id
   * itself for the setup agent, or `sessionId::agent:<agentId>` for a harness
   * turn. One checkpoint per run key, so two agents' concurrent turns
   * checkpoint (and resume) independently. Absent on documents written before
   * per-agent concurrency; treat those as keyed by sessionId.
   */
  runKey?: string;
  /** The Telegram assistant session the turn belongs to. */
  sessionId: string;
  userId: string;
  /** Chat to deliver the resumed turn (or the failure notice) to. */
  chatId: string;
  /** The agent the turn was pinned to; absent for setup-agent turns. */
  agentId?: string;
  /**
   * Direct conversation route, retained across a deploy so the completion's
   * durable notification keeps the same home-queue eligibility as the turn
   * that was interrupted. Absent for note/document/peer initiated work.
   */
  turnOrigin?: 'bot' | 'workspace';
  /** The interrupted message first, then any messages queued behind it. */
  payloads: UserInputPayload[];
  /**
   * Attach info for the still-running detached CLI turn, when the shutdown
   * caught one in flight: the next boot re-attaches to it (continuing the
   * stream where it left off) instead of re-running the payload. The payload
   * stays alongside as the fallback when the process turns out to be gone.
   */
  harnessAttach?: HarnessTurnAttachInfo;
  /**
   * An abandoned steering turn that must be killed before replay. Unlike
   * `harnessAttach`, this turn is never continued; the metadata exists only
   * to prove exit and recover a late first-turn continuity id.
   */
  harnessTermination?: HarnessTurnAttachInfo;
  /** Cleanup checkpoint for Manual Stop: terminate, then do not replay. */
  terminateOnly?: boolean;
  /**
   * Opaque CAS generation. Unlike savedAt, this is unique even when a boot
   * acknowledgement and a newer shutdown checkpoint land in the same ms.
   * Absent only on documents written by an older backend.
   */
  checkpointId?: string;
  /** ISO timestamp of the shutdown that persisted this. */
  savedAt: string;
}

/** Document id for a checkpoint (one per run key). */
export function pendingTurnDocId(doc: Pick<PendingTurnDocument, 'runKey' | 'sessionId'>): string {
  return doc.runKey ?? doc.sessionId;
}

export interface PendingTurnStorage {
  save(doc: PendingTurnDocument): Promise<void>;
  /** All pending turns, for the boot-time resume scan. */
  listAll(): Promise<PendingTurnDocument[]>;
  delete(docId: string): Promise<void>;
  /** Delete only the exact checkpoint generation that was read at boot. */
  deleteIfSavedAt(docId: string, savedAt: string, checkpointId?: string): Promise<boolean>;
}

const COLLECTION = 'pending_turn_resumes';


export class InMemoryPendingTurnStorage implements PendingTurnStorage {
  private docs = new Map<string, PendingTurnDocument>();

  async save(doc: PendingTurnDocument): Promise<void> {
    this.docs.set(pendingTurnDocId(doc), doc);
  }

  async listAll(): Promise<PendingTurnDocument[]> {
    return [...this.docs.values()];
  }

  async delete(docId: string): Promise<void> {
    this.docs.delete(docId);
  }

  async deleteIfSavedAt(docId: string, savedAt: string, checkpointId?: string): Promise<boolean> {
    const current = this.docs.get(docId);
    if (
      !current
      || (checkpointId
        ? current.checkpointId !== checkpointId
        : current.checkpointId !== undefined || current.savedAt !== savedAt)
    ) return false;
    this.docs.delete(docId);
    return true;
  }
}
