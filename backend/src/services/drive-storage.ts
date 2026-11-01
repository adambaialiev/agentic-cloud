import type { DriveItem } from '../shared/drive.js';

export interface DriveEntry extends DriveItem {
  storagePath?: string;
  /** A folder and the live descendants trashed with it restore as one unit. */
  trashRootId?: string;
  addedByUserId: string;
  addedByAgentId?: string;
}
export type DriveEntries = Map<string, DriveEntry>;
export interface DriveStorage {
  read(orgId: string): Promise<DriveEntries>;
  /** The callback is synchronous and commits atomically, including tree checks. */
  change<T>(orgId: string, update: (entries: DriveEntries) => T): Promise<T>;
}

export class InMemoryDriveStorage implements DriveStorage {
  private readonly organizations = new Map<string, DriveEntries>();
  async read(orgId: string): Promise<DriveEntries> {
    return structuredClone(this.organizations.get(orgId) ?? new Map());
  }
  async change<T>(orgId: string, update: (entries: DriveEntries) => T): Promise<T> {
    const entries = structuredClone(this.organizations.get(orgId) ?? new Map());
    const answer = update(entries);
    this.organizations.set(orgId, structuredClone(entries));
    return answer;
  }
}
