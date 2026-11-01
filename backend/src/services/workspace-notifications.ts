import { randomUUID } from 'node:crypto';

export type WorkspaceNotificationKind = 'agent_completed' | 'approval_required';
export type WorkspaceNotificationSource = 'direct_agent_chat';

export interface WorkspaceNotificationDocument {
  notificationId: string;
  userId: string;
  kind: WorkspaceNotificationKind;
  title: string;
  body: string;
  /** Same-origin location only; service workers never receive bearer state. */
  url: string;
  /**
   * The user-facing flow that produced the event, when a surface needs that
   * distinction. Absent on historical rows and on out-of-band agent turns.
   */
  source?: WorkspaceNotificationSource;
  dedupeKey: string;
  createdAt: string;
  readAt?: string;
}

export interface WorkspaceNotificationStorage {
  createNotification(doc: WorkspaceNotificationDocument): Promise<{ doc: WorkspaceNotificationDocument; created: boolean }>;
  listNotifications(userId: string, limit: number): Promise<WorkspaceNotificationDocument[]>;
  markRead(userId: string, notificationIds: string[], readAt: string): Promise<number>;
  markAllRead(userId: string, readAt: string): Promise<number>;
}

export interface WorkspaceNotificationInput {
  userId: string;
  kind: WorkspaceNotificationKind;
  title: string;
  body: string;
  url: string;
  source?: WorkspaceNotificationSource;
  dedupeKey?: string;
}
import { canonicalWorkspacePath, parseWorkspaceRoute } from '../shared/workspace-routes.js';

function cleanText(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function validWorkspaceUrl(value: string): boolean {
  if (!value.startsWith('/')) return false;
  try {
    const parsed = new URL(value, 'https://workspace.invalid');
    // A Workspace address: Home, a registered destination, or either still
    // carrying the old /workspace prefix (public-addresses, 2026-09-26).
    return parsed.origin === 'https://workspace.invalid'
      && (canonicalWorkspacePath(parsed.pathname) === '/' || parseWorkspaceRoute(parsed.pathname, parsed.search) !== null);
  } catch {
    return false;
  }
}

/** Durable notification records, read by the Workspace itself: the unread
 * counts on Home and the receipts a conversation owes. There is no second
 * delivery channel. Browser (Web Push) notifications were retired in full by
 * note #477 — the Profile control had already gone (note #331), and a browser
 * that still held its subscription kept receiving alerts nobody could turn
 * off. The service worker the Workspace serves now retires itself (see
 * routes/workspace.ts) and the stored subscriptions are dropped on boot
 * (sqlite-db.ts). */
export class WorkspaceNotificationService {
  constructor(
    private readonly storage: WorkspaceNotificationStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async notify(input: WorkspaceNotificationInput): Promise<WorkspaceNotificationDocument> {
    if (!validWorkspaceUrl(input.url)) throw new Error('Workspace notification URL must stay under /workspace');
    const notificationId = randomUUID();
    const doc: WorkspaceNotificationDocument = {
      notificationId,
      userId: input.userId,
      kind: input.kind,
      title: cleanText(input.title, 120) || 'Workspace update',
      body: cleanText(input.body, 280),
      url: input.url,
      ...(input.source ? { source: input.source } : {}),
      dedupeKey: input.dedupeKey?.trim().slice(0, 200) || `event:${notificationId}`,
      createdAt: this.now().toISOString(),
    };
    const stored = await this.storage.createNotification(doc);
    return stored.doc;
  }

  async list(userId: string, limit = 100): Promise<{ notifications: WorkspaceNotificationDocument[]; unread: number }> {
    const notifications = await this.storage.listNotifications(userId, Math.min(100, Math.max(1, limit)));
    return { notifications, unread: notifications.filter((doc) => !doc.readAt).length };
  }

  markRead(userId: string, ids: string[]): Promise<number> {
    return this.storage.markRead(userId, [...new Set(ids)].slice(0, 100), this.now().toISOString());
  }

  markAllRead(userId: string): Promise<number> {
    return this.storage.markAllRead(userId, this.now().toISOString());
  }

}

export class InMemoryWorkspaceNotificationStorage implements WorkspaceNotificationStorage {
  private readonly notifications = new Map<string, WorkspaceNotificationDocument>();
  private readonly dedupe = new Map<string, string>();

  async createNotification(doc: WorkspaceNotificationDocument) {
    const key = `${doc.userId}/${doc.dedupeKey}`;
    const existingId = this.dedupe.get(key);
    const existing = existingId ? this.notifications.get(existingId) : undefined;
    if (existing) return { doc: structuredClone(existing), created: false };
    this.notifications.set(doc.notificationId, structuredClone(doc));
    this.dedupe.set(key, doc.notificationId);
    const own = [...this.notifications.values()]
      .filter((entry) => entry.userId === doc.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const stale of own.slice(200)) this.notifications.delete(stale.notificationId);
    return { doc: structuredClone(doc), created: true };
  }
  async listNotifications(userId: string, limit: number) {
    return [...this.notifications.values()].filter((doc) => doc.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((doc) => structuredClone(doc));
  }
  async markRead(userId: string, ids: string[], readAt: string) {
    let count = 0;
    for (const id of ids) {
      const doc = this.notifications.get(id);
      if (doc?.userId === userId && !doc.readAt) { doc.readAt = readAt; count += 1; }
    }
    return count;
  }
  async markAllRead(userId: string, readAt: string) {
    let count = 0;
    for (const doc of this.notifications.values()) {
      if (doc.userId === userId && !doc.readAt) { doc.readAt = readAt; count += 1; }
    }
    return count;
  }
}
